import { assert, assertEquals, assertMatch, assertRejects, assertStringIncludes, assertThrows } from "@std/assert";
import { Buffer } from "@std/io/buffer";
import { readAll } from "@std/io/read-all";
import { toWritableStream } from "@std/io/to-writable-stream";
import { readerFromStreamReader } from "@std/io/reader-from-stream-reader";
import * as path from "node:path";
import * as fs from "node:fs";
import { which } from "which";
import {
  CommandBuilder,
  type CommandContext,
  type CommandHandler,
  create,
  createExecutableCommand,
  KillController,
  KillSignal,
  ShellError,
  type Signal,
  whichRealEnv,
} from "./mod.ts";
import { $, ensurePromiseNotResolved, getStdErr, mk$, sleep, usingTempDir, withTempDir } from "./src/test/helpers.ts";

Deno.test("should get stdout when piped", async () => {
  const output = await $`echo 5`.stdout("piped");
  assertEquals(output.code, 0);
  assertEquals(output.stdout, "5\n");
});

Deno.test("should escape arguments", async () => {
  const text = await $`echo ${"testing 'this $TEST \`out"}`.text();
  assertEquals(text, "testing 'this $TEST `out");
});

Deno.test("should not get stdout when inherited (default)", async () => {
  const output = await $`echo "should output"`;
  assertEquals(output.code, 0);
  assertThrows(() => output.stdout, Error, `Stdout was not piped (was inherit).`);
});

Deno.test("should not get stdout when null", async () => {
  const output = await $`echo 5`.stdout("null");
  assertEquals(output.code, 0);
  assertThrows(() => output.stdout, Error, `Stdout was not piped (was null).`);
});

Deno.test("should capture stdout when piped", async () => {
  const output = await $`deno eval 'console.log(5);'`.stdout("piped");
  assertEquals(output.code, 0);
  assertEquals(output.stdout, "5\n");
});

Deno.test("should capture stdout when inherited and piped", async () => {
  const output = await $`deno eval 'console.log(5);'`.stdout("inheritPiped");
  assertEquals(output.code, 0);
  assertEquals(output.stdout, "5\n");
});

Deno.test("allows leading and trailing whitespace", async () => {
  const output = await $`
  echo 5
`.stdout("piped");
  assertEquals(output.code, 0);
  assertEquals(output.stdout, "5\n");
});

Deno.test("multi-line: lines run in order", async () => {
  const output = await $`
    echo one
    echo two
    echo three
  `.stdout("piped");
  assertEquals(output.code, 0);
  assertEquals(output.stdout, "one\ntwo\nthree\n");
});

Deno.test("multi-line: stops at the first failing line and surfaces its exit code", async () => {
  const output = await $`
    echo before
    exit 3
    echo after
  `.stdout("piped").noThrow();
  assertEquals(output.code, 3);
  assertEquals(output.stdout, "before\n");
});

Deno.test("multi-line: blank lines between commands are skipped", async () => {
  const output = await $`
    echo one


    echo two
  `.stdout("piped");
  assertEquals(output.stdout, "one\ntwo\n");
});

Deno.test("multi-line: tab-indented lines still run", async () => {
  const output = await $`
\techo one
\techo two
`.stdout("piped");
  assertEquals(output.stdout, "one\ntwo\n");
});

Deno.test("multi-line: CRLF line endings are supported", async () => {
  const output = await $`echo one\r\necho two`.stdout("piped");
  assertEquals(output.stdout, "one\ntwo\n");
});

Deno.test("multi-line: an env var set earlier is visible to a later line", async () => {
  const output = await $`
    export FOO=bar
    echo "$FOO"
  `.stdout("piped");
  assertEquals(output.stdout, "bar\n");
});

Deno.test("multi-line: a shell var assignment is visible to a later line", async () => {
  const output = await $`
    FOO=bar
    echo "$FOO"
  `.stdout("piped");
  assertEquals(output.stdout, "bar\n");
});

Deno.test("multi-line: a trailing `&&` continues onto the next line", async () => {
  const output = await $`
    echo one &&
      echo two
  `.stdout("piped");
  assertEquals(output.stdout, "one\ntwo\n");
});

Deno.test("multi-line: a trailing `||` continues onto the next line", async () => {
  // use a subshell so the failing command doesn't exit the whole script
  const output = await $`
    (exit 3) ||
      echo recovered
  `.stdout("piped");
  assertEquals(output.code, 0);
  assertEquals(output.stdout, "recovered\n");
});

Deno.test("multi-line: a trailing pipe continues onto the next line", async () => {
  const output = await $`
    echo hello |
      deno eval "for await (const _ of Deno.stdin.readable) {} console.log('piped')"
  `.stdout("piped");
  assertEquals(output.stdout, "piped\n");
});

Deno.test("multi-line: a newline inside double quotes is preserved", async () => {
  const output = await $`echo "hello
world"`.stdout("piped");
  assertEquals(output.stdout, "hello\nworld\n");
});

Deno.test("multi-line: a newline inside single quotes is preserved", async () => {
  const output = await $`echo 'hello
world'`.stdout("piped");
  assertEquals(output.stdout, "hello\nworld\n");
});

Deno.test("multi-line: errexit is on by default so a failing line aborts the rest", async () => {
  const output = await $`
    echo first
    (exit 3)
    echo unreachable
  `.stdout("piped").noThrow();
  assertEquals(output.code, 3);
  assertEquals(output.stdout, "first\n");
});

Deno.test("single-line: `a; b` does NOT fail-fast — b runs even if a fails", async () => {
  const output = await $`(exit 3); echo still-ran`.stdout("piped");
  assertEquals(output.code, 0);
  assertEquals(output.stdout, "still-ran\n");
});

Deno.test("multi-line: `set +e` in the script re-enables continue-on-failure", async () => {
  const output = await $`
    set +e
    (exit 3)
    echo still-ran
  `.stdout("piped");
  assertEquals(output.code, 0);
  assertEquals(output.stdout, "still-ran\n");
});

Deno.test("single-line: `set -e` in the script opts into fail-fast", async () => {
  const output = await $`set -e; (exit 3); echo unreachable`.stdout("piped").noThrow();
  assertEquals(output.code, 3);
  assertEquals(output.stdout, "");
});

Deno.test("errexit: failure inside `||` is tested, not aborted", async () => {
  const output = await $`
    (exit 3) || echo recovered
    echo after
  `.stdout("piped");
  assertEquals(output.code, 0);
  assertEquals(output.stdout, "recovered\nafter\n");
});

Deno.test("line continuation: backslash-newline between tokens is elided", async () => {
  const output = await $`echo hello \
world`.stdout("piped");
  assertEquals(output.stdout, "hello world\n");
});

Deno.test("line continuation: backslash-newline inside a word joins the halves", async () => {
  const output = await $`echo hel\
lo`.stdout("piped");
  assertEquals(output.stdout, "hello\n");
});

Deno.test("line continuation: backslash-newline inside double quotes joins the halves", async () => {
  const output = await $`echo "hel\
lo"`.stdout("piped");
  assertEquals(output.stdout, "hello\n");
});

Deno.test("should not get stdout when set to writer", async () => {
  const buffer = new Buffer();
  const output = await $`echo 5`.stdout(buffer);
  assertEquals(output.code, 0);
  assertEquals(new TextDecoder().decode(buffer.bytes()), "5\n");
  assertThrows(() => output.stdout, Error, `Stdout was streamed to another source and is no longer available.`);
});

Deno.test("should not get stderr when inherited only (default)", async () => {
  const output = await $`deno eval 'console.error("should output");'`;
  assertEquals(output.code, 0);
  assertThrows(
    () => output.stderr,
    Error,
    `Stderr was not piped (was inherit). Call .stderr("piped") or .stderr("inheritPiped") when building the command.`,
  );
});

Deno.test("should not get stderr when null", async () => {
  const output = await $`deno eval 'console.error(5);'`.stderr("null");
  assertEquals(output.code, 0);
  assertThrows(
    () => output.stderr,
    Error,
    `Stderr was not piped (was null). Call .stderr("piped") or .stderr("inheritPiped") when building the command.`,
  );
});

Deno.test("should capture stderr when piped", async () => {
  const output = await $`deno eval 'console.error(5);'`
    .env("NO_COLOR", "1") // deno uses colors when only stderr is piped
    .stderr("piped");
  assertEquals(output.code, 0);
  assertEquals(output.stderr, "5\n");
});

Deno.test("should capture stderr when inherited and piped", async () => {
  const output = await $`deno eval -q 'console.error(5);'`
    .env("NO_COLOR", "1")
    .stderr("inheritPiped");
  assertEquals(output.code, 0);
  assertEquals(output.stderr, "5\n");
});

Deno.test("should not get stderr when set to writer", async () => {
  const buffer = new Buffer();
  const output = await $`deno eval 'console.error(5); console.log(1);'`
    .env("NO_COLOR", "1")
    .stderr(buffer);
  assertEquals(output.code, 0);
  assertEquals(new TextDecoder().decode(buffer.bytes()), "5\n");
  assertThrows(
    () => output.stderr,
    Error,
    `Stderr was streamed to another source and is no longer available.`,
  );
});

Deno.test("should get combined stdout and stderr when specified", async () => {
  const output = await $`echo 1 ; sleep 0.5 ; deno eval -q 'console.error(2);'`.captureCombined();
  assertEquals(output.code, 0);
  assertEquals(output.combined, "1\n2\n");
});

Deno.test("should not get combined stdout and stderr when not calling combined output", async () => {
  const output = await $`deno eval -q 'console.error("should output");'`.stdout("piped").stderr("piped");
  assertEquals(output.code, 0);
  assertThrows(
    () => output.combined,
    Error,
    `Stdout and stderr were not combined. Call .captureCombined() when building the command.`,
  );
});

Deno.test("should error setting stdout after getting combined output", () => {
  for (const value of ["null", "inherit"] as const) {
    assertThrows(
      () => {
        $``.captureCombined(true).stdout(value);
      },
      Error,
      "Cannot set stdout's kind to anything but 'piped' or 'inheritPiped' when combined is true.",
    );
    assertThrows(
      () => {
        $``.captureCombined(true).stderr(value);
      },
      Error,
      "Cannot set stderr's kind to anything but 'piped' or 'inheritPiped' when combined is true.",
    );
  }
});

Deno.test("should get output as bytes", async () => {
  {
    const output = await $`echo 5 && deno eval 'console.error(1);'`.bytes();
    assertEquals(new TextDecoder().decode(output), "5\n");
  }
  {
    const output = await $`echo 5 && deno eval 'console.error(1);'`.bytes("combined");
    assertEquals(new TextDecoder().decode(output), "5\n1\n");
  }
  {
    const output = await $`echo 5 && deno eval 'console.error(1);'`.env("NOCOLOR", "1")
      .bytes("stderr");
    assertEquals(new TextDecoder().decode(output), "1\n");
  }
});

Deno.test("should throw when exit code is non-zero", async () => {
  await assertRejects(
    async () => {
      await $`deno eval 'Deno.exit(1);'`;
    },
    Error,
    "Exited with code: 1",
  );

  await assertRejects(
    async () => {
      await $`deno eval 'Deno.exit(2);'`;
    },
    Error,
    "Exited with code: 2",
  );

  await assertRejects(
    async () => {
      await $`exit 3 && echo 1 && echo 2`;
    },
    Error,
    "Exited with code: 3",
  );

  // regression test for previous bug
  await assertRejects(
    async () => {
      await $`echo 1 && echo 2 && exit 3`;
    },
    Error,
    "Exited with code: 3",
  );
});

Deno.test("should include caller frame in error stack for failed commands", async () => {
  // guards against the V8 async-stack-trace limitation where the awaiter's
  // frame is dropped when a Promise is rejected from within an async
  // executor. the library captures the caller's stack at .then/.spawn and
  // appends it to the thrown error.
  //
  // relies on V8 propagating async stack frames through thenable `.then`
  // calls — fixed in https://chromium-review.googlesource.com/c/v8/v8/+/6826001
  // (merged 2025-08-07). skip on engines whose V8 predates that fix.
  async function probeAsyncFrames(): Promise<boolean> {
    let captured = "";
    await {
      then(resolve: () => void) {
        const holder: { stack?: string } = {};
        // deno-lint-ignore no-explicit-any
        (Error as any).captureStackTrace?.(holder);
        captured = holder.stack ?? "";
        resolve();
      },
    };
    return captured.includes("probeAsyncFrames");
  }
  if (!(await probeAsyncFrames())) return;

  async function userFrameMarker() {
    await $`exit 7`;
  }
  let err: Error | undefined;
  try {
    await userFrameMarker();
  } catch (e) {
    err = e as Error;
  }
  assert(err != null, "expected command to reject");
  assertStringIncludes(err.stack ?? "", "userFrameMarker");
});

Deno.test("should error in the shell when the command can't be found", async () => {
  const output = await $`nonexistentcommanddaxtest`.noThrow().stderr("piped");
  assertEquals(output.code, 127);
  assertEquals(output.stderr, "dax: nonexistentcommanddaxtest: command not found\n");
});

Deno.test({
  name: "resolves a relative path command to its Windows PATHEXT extension",
  ignore: process.platform !== "win32",
  fn: async () => {
    await withTempDir(async (tempDir) => {
      const binaryCopy = tempDir.join("my-dax-test-binary.exe");
      fs.copyFileSync(process.execPath, binaryCopy.toString());
      // reference the binary by its relative path without the .exe extension
      const result = await $`./my-dax-test-binary --version`.stdout("piped");
      assertEquals(result.code, 0);
      assert(result.stdout.length > 0);
    });
  },
});

Deno.test("throws when providing an object that doesn't override toString", async () => {
  {
    const obj1 = {};
    assertThrows(
      () => $`echo ${obj1}`,
      Error,
      "Failed resolving expression in command. Provided object does not override `toString()`.",
    );
  }
  {
    const obj2 = {
      toString() {
        return "1";
      },
    };
    const result = await $`echo ${obj2}`.text();
    assertEquals(result, "1");
  }
  class Test {
    toString() {
      return "1";
    }
  }
  {
    const result = await $`echo ${new Test()}`.text();
    assertEquals(result, "1");
  }
});

Deno.test("should change the cwd, but only in the shell", async () => {
  const output = await $`cd src ; deno eval 'console.log(Deno.cwd());'`.stdout("piped");
  const standardizedOutput = output.stdout.trim().replace(/\\/g, "/");
  assertEquals(standardizedOutput.endsWith("src"), true, standardizedOutput);
});

Deno.test("cwd accepts a file URL", async () => {
  const srcUrl = new URL("./src/", import.meta.url);
  const output = (await $`pwd`.cwd(srcUrl).text()).replace(/\\/g, "/").replace(/\/$/, "");
  assert(output.endsWith("/src"), output);
});

Deno.test("allow setting env", async () => {
  const output = await $`echo $test`.env("test", "123").text();
  assertEquals(output, "123");
});

Deno.test("allow setting multiple env", async () => {
  const output = await $`echo $test$other`.env({
    test: "123",
    other: "456",
  }).text();
  assertEquals(output, "123456");
});

Deno.test("set var for command", async () => {
  const output = await $`test=123 echo $test ; echo $test`
    .env("test", "456")
    .text();
  assertEquals(output, "123\n456");
});

Deno.test("variable substitution", async () => {
  const output = await $`deno eval "console.log($TEST);"`.env("TEST", "123").text();
  assertEquals(output.trim(), "123");
});

Deno.test("quoted variable with spaces", async () => {
  const output = await $`echo "$test"`.env("test", "one two").text();
  assertEquals(output, "one two");
});

Deno.test("quoted multiple variables with spaces", async () => {
  const output = await $`echo "$test $other"`.env({
    test: "one two",
    other: "three four",
  }).text();
  assertEquals(output, "one two three four");
});

Deno.test("stdoutJson", async () => {
  const output = await $`deno eval "console.log(JSON.stringify({ test: 5 }));"`.stdout("piped");
  assertEquals(output.stdoutJson, { test: 5 });
  assertEquals(output.stdoutJson === output.stdoutJson, true); // should be memoized
});

Deno.test("CommandBuilder#json()", async () => {
  const output = await $`deno eval "console.log(JSON.stringify({ test: 5 }));"`.json();
  assertEquals(output, { test: 5 });
});

Deno.test("CommandBuilder#json('stderr')", async () => {
  const output = await $`deno eval "console.error(JSON.stringify({ test: 5 }));"`.json("stderr");
  assertEquals(output, { test: 5 });
});

Deno.test("stderrJson", async () => {
  const output = await $`deno eval "console.error(JSON.stringify({ test: 5 }));"`.stderr("piped");
  assertEquals(output.stderrJson, { test: 5 });
  assertEquals(output.stderrJson === output.stderrJson, true); // should be memoized
});

Deno.test("stderr text", async () => {
  const result = await $`deno eval "console.error(1)"`.env("NO_COLOR", "1").text("stderr");
  assertEquals(result, "1");
});

Deno.test("should handle interpolation", async () => {
  const output = await $`deno eval 'console.log(${5});'`.stdout("piped");
  assertEquals(output.code, 0);
  assertEquals(output.stdout, "5\n");
});

Deno.test("should handle interpolation beside args", async () => {
  const value = "a/b";
  const text = await $`echo ${value}/c`.text();
  assertEquals(text, "a/b/c");
});

Deno.test("should handle providing array of arguments", async () => {
  const args = [1, "2", "test   test"];
  const text = await $`deno eval 'console.log(Deno.args)' ${args}`.text();
  assertEquals(text, `[ "1", "2", "test   test" ]`);
});

Deno.test("raw should handle providing array of arguments", async () => {
  const args = [1, "2", "test   test"];
  const text = await $.raw`deno eval 'console.log(Deno.args)' ${args}`.text();
  assertEquals(text, `[ "1", "2", "test", "test" ]`);
});

Deno.test("raw should handle text provided", async () => {
  const text = await $.raw`deno eval 'console.log(Deno.args)' ${"testing this   out"}`.text();
  assertEquals(text, `[ "testing", "this", "out" ]`);
});

Deno.test("raw should handle command result", async () => {
  const result = await $`echo '1   2   3'`.stdout("piped");
  const text = await $.raw`deno eval 'console.log(Deno.args)' ${result}`.text();
  assertEquals(text, `[ "1", "2", "3" ]`);
});

Deno.test("rawArg should handle arguments", async () => {
  const text = await $`echo ${$.rawArg("1   2   3")}`.text();
  assertEquals(text, `1 2 3`);
});

Deno.test("should handle boolean list 'or'", async () => {
  {
    const output = await $`deno eval 'Deno.exit(1)' || deno eval 'console.log(5)'`.text();
    assertEquals(output, "5");
  }
  {
    const output = await $`deno eval 'Deno.exit(1)' || deno eval 'Deno.exit(2)' || deno eval 'Deno.exit(3)'`
      .noThrow()
      .stdout("piped");
    assertEquals(output.stdout, "");
    assertEquals(output.code, 3);
  }
});

Deno.test("should handle boolean list 'and'", async () => {
  {
    const output = await $`deno eval 'Deno.exit(5)' && echo 2`.noThrow().stdout("piped");
    assertEquals(output.code, 5);
    assertEquals(output.stdout, "");
  }
  {
    const output = await $`deno eval 'Deno.exit(0)' && echo 5 && echo 6`.stdout("piped");
    assertEquals(output.code, 0);
    assertEquals(output.stdout.trim(), "5\n6");
  }
});

Deno.test("should support custom command handlers", async () => {
  const builder = new CommandBuilder()
    .registerCommand("zardoz-speaks", async (context) => {
      if (context.args.length != 1) {
        return context.error("zardoz-speaks: expected 1 argument");
      }
      await context.stdout.writeLine(`zardoz speaks to ${context.args[0]}`);
      return {
        code: 0,
      };
    })
    .registerCommands({
      "true": () => Promise.resolve({ code: 0 }),
      "false": () => Promise.resolve({ code: 1 }),
    }).stderr("piped").stdout("piped");

  {
    const result = await builder.command("zardoz-speaks").noThrow();
    assertEquals(result.code, 1);
    assertEquals(result.stderr, "zardoz-speaks: expected 1 argument\n");
  }
  {
    const result = await builder.command("zardoz-speaks to you").noThrow();
    assertEquals(result.code, 1);
    assertEquals(result.stderr, "zardoz-speaks: expected 1 argument\n");
  }
  {
    const result = await builder.command("zardoz-speaks you").noThrow();
    assertEquals(result.code, 0);
    assertEquals(result.stdout, "zardoz speaks to you\n");
  }
  {
    const result = await builder.command("true && echo yup").noThrow();
    assertEquals(result.code, 0);
    assertEquals(result.stdout, "yup\n");
  }
  {
    const result = await builder.command("false && echo nope").noThrow();
    assertEquals(result.code, 1);
    assertEquals(result.stdout, "");
  }
});

Deno.test("should not allow invalid command names", () => {
  const builder = new CommandBuilder();
  const hax: CommandHandler = (context: CommandContext) => {
    context.stdout.writeLine("h4x!1!");
    return {
      code: 0,
    };
  };

  assertThrows(
    () => builder.registerCommand("/dev/null", hax),
    Error,
    "Invalid command name",
  );
  assertThrows(
    () => builder.registerCommand("*", hax),
    Error,
    "Invalid command name",
  );
});

Deno.test("should unregister commands", async () => {
  const builder = new CommandBuilder().unregisterCommand("export").noThrow();
  const output = await builder.command("export somewhere").stderr("piped");
  assertEquals(output.code, 127);
  assertEquals(output.stderr, "dax: export: command not found\n");
});

Deno.test("sleep command", async () => {
  const start = performance.now();
  const result = await $`sleep 0.2 && echo 1`.text();
  const end = performance.now();
  assertEquals(result, "1");
  assertEquals(end - start > 190, true);
});

Deno.test("test command", async (t) => {
  await fs.promises.writeFile("zero.dat", new Uint8Array());
  await fs.promises.writeFile("non-zero.dat", new Uint8Array([242]));
  if (process.platform !== "win32") {
    await fs.promises.symlink("zero.dat", "linked.dat");
  }

  await t.step("test -e", async () => {
    const result = await $`test -e zero.dat`.noThrow();
    assertEquals(result.code, 0);
  });
  await t.step("test -f", async () => {
    const result = await $`test -f zero.dat`.noThrow();
    assertEquals(result.code, 0, "should be a file");
  });
  await t.step("test -f on non-file", async () => {
    const result = await $`test -f ${process.cwd()}`.noThrow().stderr("piped");
    assertEquals(result.code, 1, "should not be a file");
    assertEquals(result.stderr, "");
  });
  await t.step("test -d", async () => {
    const result = await $`test -d ${process.cwd()}`.noThrow();
    assertEquals(result.code, 0, `${process.cwd()} should be a directory`);
  });
  await t.step("test -d on non-directory", async () => {
    const result = await $`test -d zero.dat`.noThrow().stderr("piped");
    assertEquals(result.code, 1, "should not be a directory");
    assertEquals(result.stderr, "");
  });
  await t.step("test -s", async () => {
    const result = await $`test -s non-zero.dat`.noThrow().stderr("piped");
    assertEquals(result.code, 0, "should be > 0");
    assertEquals(result.stderr, "");
  });
  await t.step("test -s on zero-length file", async () => {
    const result = await $`test -s zero.dat`.noThrow().stderr("piped");
    assertEquals(result.code, 1, "should fail as file is zero-sized");
    assertEquals(result.stderr, "");
  });
  if (process.platform !== "win32") {
    await t.step("test -L", async () => {
      const result = await $`test -L linked.dat`.noThrow();
      assertEquals(result.code, 0, "should be a symlink");
    });
  }
  await t.step("test -L on a non-symlink", async () => {
    const result = await $`test -L zero.dat`.noThrow().stderr("piped");
    assertEquals(result.code, 1, "should fail as not a symlink");
    assertEquals(result.stderr, "");
  });
  await t.step("should error on unsupported test type", async () => {
    const result = await $`test -z zero.dat`.noThrow().stderr("piped");
    assertEquals(result.code, 2, "should have exit code 2");
    assertEquals(result.stderr, "test: unsupported test type\n");
  });
  await t.step("should error with not enough arguments", async () => {
    const result = await $`test`.noThrow().stderr("piped");
    assertEquals(result.code, 2, "should have exit code 2");
    assertEquals(result.stderr, "test: expected 2 arguments\n");
  });
  await t.step("should error with too many arguments", async () => {
    const result = await $`test -f a b c`.noThrow().stderr("piped");
    assertEquals(result.code, 2, "should have exit code 2");
    assertEquals(result.stderr, "test: expected 2 arguments\n");
  });
  await t.step("should work with boolean: pass && ..", async () => {
    const result = await $`test -f zero.dat && echo yup`.noThrow().stdout("piped");
    assertEquals(result.code, 0);
    assertEquals(result.stdout, "yup\n");
  });
  await t.step("should work with boolean: fail && ..", async () => {
    const result = await $`test -f ${process.cwd()} && echo nope`.noThrow().stdout("piped");
    assertEquals(result.code, 1, "should have exit code 1");
    assertEquals(result.stdout, "");
  });
  await t.step("should work with boolean: pass || ..", async () => {
    const result = await $`test -f zero.dat || echo nope`.noThrow().stdout("piped");
    assertEquals(result.code, 0);
    assertEquals(result.stdout, "");
  });
  await t.step("should work with boolean: fail || ..", async () => {
    const result = await $`test -f ${process.cwd()} || echo yup`.noThrow().stdout("piped");
    assertEquals(result.code, 0);
    assertEquals(result.stdout, "yup\n");
  });

  if (process.platform !== "win32") {
    await fs.promises.rm("linked.dat");
  }
  await fs.promises.rm("zero.dat");
  await fs.promises.rm("non-zero.dat");
});

Deno.test("exit command", async () => {
  {
    const result = await $`exit`.noThrow();
    assertEquals(result.code, 1);
  }
  {
    const result = await $`exit 0`.noThrow();
    assertEquals(result.code, 0);
  }
  {
    const result = await $`exit 255`.noThrow();
    assertEquals(result.code, 255);
  }
  {
    const result = await $`exit 256`.noThrow();
    assertEquals(result.code, 0);
  }
  {
    const result = await $`exit 257`.noThrow();
    assertEquals(result.code, 1);
  }
  {
    const result = await $`exit -1`.noThrow();
    assertEquals(result.code, 255);
  }
  {
    const result = await $`exit zardoz`.noThrow().stderr("piped");
    assertEquals(result.code, 2);
    assertEquals(result.stderr, "exit: numeric argument required.\n");
  }
  {
    const result = await $`exit 1 1`.noThrow().stderr("piped");
    assertEquals(result.code, 2);
    assertEquals(result.stderr, "exit: too many arguments\n");
  }
  // test noThrow with exit code
  {
    const result = await $`exit 255`.noThrow(255);
    assertEquals(result.code, 255);
  }
  {
    const result = await $`exit 255`.noThrow(254, 255);
    assertEquals(result.code, 255);
  }
  {
    await assertRejects(() => $`exit 255`.noThrow(254));
  }
});

Deno.test("should provide result from one command to another", async () => {
  const result = await $`echo 1`.stdout("piped");
  const result2 = await $`echo ${result}`.stdout("piped");
  assertEquals(result2.stdout, "1\n");
});

Deno.test("should actually change the environment when using .exportEnv()", async () => {
  const originalDir = process.cwd();
  try {
    const srcDir = path.resolve("./src");
    await $`cd src && export SOME_VALUE=5 && OTHER_VALUE=6`.exportEnv();
    assertEquals(process.cwd(), srcDir);
    assertEquals(process.env.SOME_VALUE, "5");
    assertEquals(process.env.OTHER_VALUE, undefined);
  } finally {
    process.chdir(originalDir);
  }
});

Deno.test("exporting env should modify real environment when something changed via the api", async () => {
  const previousCwd = process.cwd();
  const envName = "SHELL_TEST_ENV_SET";
  try {
    await $`echo 2`
      .cwd("./src")
      .env(envName, "123")
      .exportEnv();
    assertEquals(process.env[envName], "123");
    assertEquals(process.cwd().slice(-3), "src");
  } finally {
    delete process.env[envName];
    process.chdir(previousCwd);
  }
});

Deno.test("env should be clean slate when clearEnv is set", async () => {
  {
    const text = await $`printenv`.clearEnv().text();
    assertEquals(text, "");
  }
  const denoPath = await which("deno", whichRealEnv);
  if (denoPath == null) throw new Error("deno binary not found on PATH");
  process.env.SHELL_TVAR = "123";
  try {
    const text = await $`deno eval --no-config 'console.log("SHELL_TVAR: " + Deno.env.get("SHELL_TVAR"))'`
      .clearEnv()
      .registerCommand("deno", createExecutableCommand(denoPath))
      .text();
    assertEquals(text, "SHELL_TVAR: undefined");
  } finally {
    delete process.env.SHELL_TVAR;
  }
});

Deno.test("clearEnv + exportEnv should not clear out real environment", async () => {
  const denoPath = await which("deno", whichRealEnv);
  if (denoPath == null) throw new Error("deno binary not found on PATH");
  process.env.SHELL_TVAR = "123";
  try {
    const text =
      await $`deno eval --no-config 'console.log("VAR: " + Deno.env.get("SHELL_TVAR") + " VAR2: " + Deno.env.get("SHELL_TVAR2"))'`
        .env("SHELL_TVAR2", "shake it shake")
        .clearEnv()
        .registerCommand("deno", createExecutableCommand(denoPath))
        .exportEnv()
        .text();
    assertEquals(text, "VAR: undefined VAR2: shake it shake");
    assertEquals(process.env.SHELL_TVAR2, "shake it shake");
  } finally {
    delete process.env.SHELL_TVAR;
    delete process.env.SHELL_TVAR2;
  }
});

Deno.test("setting an empty env var", async () => {
  const text = await $`VAR= deno eval 'console.log("VAR: " + Deno.env.get("VAR"))'`.text();
  assertEquals(text, "VAR: ");
});

Deno.test("unsetting env var", async () => {
  const text = await $`unset VAR && deno eval 'console.log("VAR: " + Deno.env.get("VAR"))'`
    .env("VAR", "1")
    .text();
  assertEquals(text, "VAR: undefined");
});

Deno.test("unsetting multiple env vars", async () => {
  const text =
    await $`unset VAR1 VAR2 && deno eval 'console.log("VAR: " + Deno.env.get("VAR1") + Deno.env.get("VAR2") + Deno.env.get("VAR3"))'`
      .env({
        "VAR1": "test",
        "VAR2": "test",
        "VAR3": "test",
      })
      .text();
  assertEquals(text, "VAR: undefinedundefinedtest");
});

Deno.test("unsetting multiple shell vars", async () => {
  const text = await $`VAR1=1 && VAR2=2 && VAR3=3 && VAR4=4 && unset VAR1 VAR4 && echo $VAR1 $VAR2 $VAR3 $VAR4`
    .text();
  assertEquals(text, "2 3");
});

Deno.test("unsetting shell var with -v", async () => {
  const text = await $`VAR1=1 && unset -v VAR1 && echo $VAR1 test`
    .text();
  assertEquals(text, "test");
});

Deno.test("unsetting with no args", async () => {
  const text = await $`unset && echo test`
    .text();
  assertEquals(text, "test");
});

Deno.test("unset with -f should error", async () => {
  const result = await $`unset -f VAR1 && echo $VAR1`
    .env({ "VAR1": "test" })
    .stdout("piped")
    .stderr("piped")
    .noThrow();
  assertEquals(result.code, 1);
  assertEquals(result.stderr, "unset: unsupported flag: -f\n");
  assertEquals(result.stdout, "");
});

Deno.test("cwd should be resolved based on cwd at time of method call and not execution", async () => {
  await withTempDir(async (tempDir) => {
    await tempDir.join("./src/sub_dir").ensureDir();
    const command = $`echo $PWD`.cwd("./src");
    process.chdir("./src/sub_dir");
    const result = await command.text();
    assertEquals(result.slice(-3), "src");
  });
});

Deno.test("should handle the PWD variable", async () => {
  const srcDir = path.resolve("./src");
  {
    const output = await $`cd src && echo $PWD `.text();
    assertEquals(output, srcDir);
  }
  {
    // changing PWD should affect this
    const output = await $`PWD=$PWD/src && echo $PWD `.text();
    assertEquals(output, srcDir);
  }
});

Deno.test("tilde expansion", async () => {
  const envVarName = process.platform === "win32" ? "USERPROFILE" : "HOME";
  {
    const text = await $`echo ~/home`.env(envVarName, "/var").text();
    assertEquals(text, `/var/home`);
  }
  {
    await assertRejects(
      async () => {
        await $`echo ~/home`.env(envVarName, undefined).text();
      },
      Error,
      `Failed resolving home directory for tilde expansion ('${envVarName}' env var not set).`,
    );
  }
});

Deno.test("timeout", async () => {
  const command = $`deno eval 'await new Promise(resolve => setTimeout(resolve, 10_000));'`
    .timeout(200);
  await assertRejects(async () => await command, Error, "Timed out with exit code: 124");

  const result = await command.noThrow();
  assertEquals(result.code, 124);
});

Deno.test("abort", async () => {
  const command = $`echo 1 && sleep 100 && echo 2`;
  await assertRejects(
    async () => {
      const child = command.spawn();
      child.kill();
      await child;
    },
    Error,
    "Aborted with exit code: 124",
  );

  const child = command.noThrow().spawn();
  child.kill();
  const result = await child;
  assertEquals(result.code, 124);
});

Deno.test("piping to stdin", async (t) => {
  await t.step("reader", async () => {
    const bytes = new TextEncoder().encode("test\n");
    const result =
      await $`deno eval "const b = new Uint8Array(4); await Deno.stdin.read(b); await Deno.stdout.write(b);"`
        .stdin(new Buffer(bytes))
        .text();
    assertEquals(result, "test");
  });

  await t.step("string", async () => {
    const command = $`deno eval "const b = new Uint8Array(4); await Deno.stdin.read(b); await Deno.stdout.write(b);"`
      .stdinText("test\n");
    // should support calling multiple times
    assertEquals(await command.text(), "test");
    assertEquals(await command.text(), "test");
  });

  await t.step("Uint8Array", async () => {
    const result =
      await $`deno eval "const b = new Uint8Array(4); await Deno.stdin.read(b); await Deno.stdout.write(b);"`
        .stdin(new TextEncoder().encode("test\n"))
        .text();
    assertEquals(result, "test");
  });

  await t.step("readable stream", async () => {
    const child = $`echo 1 && echo 2`.stdout("piped").spawn();
    const result = await $`deno eval 'await Deno.stdin.readable.pipeTo(Deno.stdout.writable);'`
      .stdin(child.stdout())
      .text();
    assertEquals(result, "1\n2");
  });

  await t.step("Path", async () => {
    await using tempDir = usingTempDir();
    const tempFile = tempDir.join("temp_file.txt");
    const fileText = "1 testing this out\n".repeat(1_000);
    tempFile.writeSync(fileText);
    const output = await $`cat`.stdin(tempFile).text();
    assertEquals(output, fileText.trim());
  });

  await t.step("command via stdin", async () => {
    const child = $`echo 1 && echo 2`;
    const result = await $`deno eval 'await Deno.stdin.readable.pipeTo(Deno.stdout.writable);'`
      .stdin(child)
      .text();
    assertEquals(result, "1\n2");
  });

  await t.step("command that exits via stdin", async () => {
    const child = $`echo 1 && echo 2 && exit 1`;
    const result = await $`deno eval 'await Deno.stdin.readable.pipeTo(Deno.stdout.writable);'`
      .stdin(child)
      .stderr("piped")
      .noThrow();
    assertEquals(result.code, 1);
    assertEquals(result.stderr, "stdin pipe broken. Exited with code: 1\n");
  });
});

Deno.test("pipe", async () => {
  {
    const result = await $`echo 1 && echo 2`
      .pipe($`deno eval 'await Deno.stdin.readable.pipeTo(Deno.stderr.writable);'`)
      .stderr("piped")
      .stdout("piped")
      .spawn();
    assertEquals(result.stdout, "");
    assertEquals(result.stderr, "1\n2\n");
  }
});

Deno.test("piping to a writable and the command fails", async () => {
  const chunks = [];
  let wasClosed = false;
  const writableStream = new WritableStream({
    write(chunk) {
      chunks.push(chunk);
    },
    close() {
      wasClosed = true;
    },
  });
  await $`echo 1 ; exit 1`.stdout(writableStream).noThrow();
  assertEquals(chunks.length, 1);
  assert(wasClosed);
});

Deno.test("piping to a writable and the command fails and throws", async () => {
  const chunks = [];
  let wasClosed = false;
  const writableStream = new WritableStream({
    write(chunk) {
      chunks.push(chunk);
    },
    close() {
      wasClosed = true;
    },
  });
  let didThrow = false;
  try {
    await $`echo 1 ; exit 1`.stdout(writableStream);
  } catch {
    didThrow = true;
  }
  assert(didThrow);
  assertEquals(chunks.length, 1);
  assert(wasClosed);
});

Deno.test("piping to a writable that throws", async () => {
  const writableStream = new WritableStream({
    write(_chunk) {
      throw new Error("failed");
    },
  });
  const result = await $`echo 1`.stdout(writableStream).stderr("piped").noThrow();
  assertEquals(result.code, 1);
  assertEquals(result.stderr, "echo: failed\n");
});

Deno.test("piping stdout/stderr to a file", async () => {
  await withTempDir(async (tempDir) => {
    const tempFile = tempDir.join("temp_file.txt");
    await $`echo 1`.stdout(tempFile);
    assertEquals(tempFile.readTextSync(), "1\n");
  });

  await withTempDir(async (tempDir) => {
    const tempFile = tempDir.join("temp_file.txt");
    await $`deno eval 'console.error(1);'`
      .env("NO_COLOR", "1")
      .stderr(tempFile);
    assertEquals(tempFile.readTextSync(), "1\n");
  });

  await withTempDir(async (tempDir) => {
    const tempFile = tempDir.join("temp_file.txt");
    const file = tempFile.openSync({ write: true, create: true, truncate: true });
    try {
      await $`deno eval "console.log('1234\\n'.repeat(1_000));"`.stdout(file.writable);
    } finally {
      file.close();
    }
    const text = tempFile.readTextSync();
    // last \n for the console.log itself
    assertEquals(text, "1234\n".repeat(1_000) + "\n");
  });
});

Deno.test("spawning a command twice that has stdin set to a Reader should error", async () => {
  const bytes = new TextEncoder().encode("test\n");
  const command = $`deno eval "const b = new Uint8Array(4); await Deno.stdin.read(b); await Deno.stdout.write(b);"`
    .stdin(new Buffer(bytes));
  const result = await command.text();
  assertEquals(result, "test");
  await assertRejects(
    () => command.text(),
    Error,
    "Cannot spawn command. Stdin was already consumed when a previous command using the same stdin "
      + "was spawned. You need to call `.stdin(...)` again with a new value before spawning.",
  );
});

Deno.test("streaming api not piped", async () => {
  const child = $`echo 1 && echo 2`.spawn();
  assertThrows(
    () => child.stdout(),
    Error,
    `No pipe available. Ensure stdout is "piped" (not "inheritPiped") and combinedOutput is not enabled.`,
  );
  assertThrows(
    () => child.stderr(),
    Error,
    `No pipe available. Ensure stderr is "piped" (not "inheritPiped") and combinedOutput is not enabled.`,
  );
  await child;
});

Deno.test("streaming api then non-streaming should error", async () => {
  const child = $`echo 1 && echo 2`.stdout("piped").stderr("piped").spawn();
  const stdout = readerFromStreamReader(child.stdout().getReader());
  const stderr = readerFromStreamReader(child.stderr().getReader());
  const result = await child;
  // ensure these are all read to prevent issues with sanitizers
  await readAll(stdout);
  await readAll(stderr);

  assertThrows(
    () => {
      result.stdout;
    },
    Error,
    "Stdout was streamed to another source and is no longer available.",
  );
  assertThrows(
    () => {
      result.stderr;
    },
    Error,
    "Stderr was streamed to another source and is no longer available.",
  );
});

Deno.test("streaming api", async () => {
  // stdout
  {
    const child = $`echo 1 && echo 2`.stdout("piped").spawn();
    const text = await $`deno eval 'await Deno.stdin.readable.pipeTo(Deno.stdout.writable);'`
      .stdin(child.stdout())
      .text();
    assertEquals(text, "1\n2");
  }

  // stderr
  {
    const child = $`deno eval -q 'console.error(1); console.error(2)'`
      .env("NO_COLOR", "1")
      .stderr("piped")
      .spawn();
    const text = await $`deno eval 'await Deno.stdin.readable.pipeTo(Deno.stdout.writable);'`
      .stdin(child.stderr())
      .text();
    assertEquals(text, "1\n2");
  }

  // both
  {
    const child = $`deno eval -q 'console.log(1); setTimeout(() => console.error(2), 10)'`
      .stdout("piped")
      .stderr("piped")
      .spawn();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        let hasClosed = false;
        read(child.stdout().getReader());
        read(child.stderr().getReader());

        async function read(reader: ReadableStreamDefaultReader<Uint8Array>) {
          while (true) {
            const v = await reader.read();
            if (v.value != null) {
              controller.enqueue(v.value);
            } else if (v.done) {
              if (!hasClosed) {
                controller.close();
                hasClosed = true;
              }
              return;
            }
          }
        }
      },
    });
    const text = await $`deno eval -q 'await Deno.stdin.readable.pipeTo(Deno.stdout.writable);'`
      .stdin(stream)
      .text();
    assertEquals(text, "1\n2");
  }
});

Deno.test("streaming api errors while streaming", async () => {
  {
    const child = $`echo 1 && echo 2 && exit 1`.stdout("piped").spawn();
    const stdout = child.stdout();

    await assertRejects(
      async () => {
        await $`deno eval 'await Deno.stdin.readable.pipeTo(Deno.stdout.writable);'`
          .stdin(stdout)
          .text();
      },
      Error,
      "Exited with code: 1",
    );
  }

  {
    const child = $`echo 1 && echo 2 && sleep 0.6 && exit 1`.stdout("piped").spawn();
    const stdout = child.stdout();

    const result = await $`deno eval 'await Deno.stdin.readable.pipeTo(Deno.stdout.writable);'`
      .stdin(stdout)
      .noThrow()
      .stdout("piped")
      .stderr("piped")
      .spawn();
    assertEquals(result.stderr, "stdin pipe broken. Exited with code: 1\n");
    assertEquals(result.stdout, "1\n2\n");
  }
});

Deno.test("streaming api stdin not used in provided command", async () => {
  const child = $`echo 1 && sleep 90 && exit 1`.stdout("piped").spawn();
  const stdout = child.stdout();

  const text = await $`deno eval 'console.log(1)'`
    .stdin(stdout)
    .text();
  assertEquals(text, "1");
  child.kill();
  await assertRejects(
    async () => {
      await child;
    },
    Error,
    "Aborted with exit code: 124",
  );
});

Deno.test("streaming api no buffers overwrite", async () => {
  const child = $`echo 1 && sleep 0.1 && echo 2 && echo 3`.stdout("piped").spawn();
  const stdout = child.stdout();
  // wait for the child to finish so the stream fills up
  await child;

  // now start reading it. The data should not be corrupted
  let text = "";
  for await (const chunk of stdout.pipeThrough(new TextDecoderStream())) {
    text += chunk;
  }
  assertEquals(text, "1\n2\n3\n");
});

Deno.test("command args", async () => {
  const input = "testing   'this   out";
  const result = await new CommandBuilder()
    .command(["echo", input])
    .stdout("piped");
  assertEquals(result.stdout.trim(), input);
  // should be properly escaped here too
  assertEquals(await $`echo ${result}`.text(), input);
});

Deno.test("command .lines()", async () => {
  const result = await $`echo 1 && echo 2`.lines();
  assertEquals(result, ["1", "2"]);
});

Deno.test("command .lines('stderr')", async () => {
  const result = await $`deno eval "console.error(1); console.error(2)"`.env("NO_COLOR", "1").lines("stderr");
  assertEquals(result, ["1", "2"]);
});

Deno.test("command .lines('combined')", async () => {
  const result = await $`deno eval "console.log(1); console.error(2)"`.lines("combined");
  assertEquals(result.sort(), ["1", "2"]);
});

Deno.test("command .linesIter() - basic", async () => {
  const lines: string[] = [];
  for await (const line of $`echo 1 && echo 2`.linesIter()) {
    lines.push(line);
  }
  assertEquals(lines, ["1", "2"]);
});

Deno.test("command .linesIter() - drops only trailing blank line from final newline", async () => {
  const cases: { input: string; expected: string[] }[] = [
    // trailing newline is not a blank line
    { input: "a\nb\n", expected: ["a", "b"] },
    // no trailing newline
    { input: "a\nb", expected: ["a", "b"] },
    // \r\n line endings
    { input: "a\r\nb\r\n", expected: ["a", "b"] },
    // embedded blank lines are preserved
    { input: "a\n\nb", expected: ["a", "", "b"] },
    // double trailing newline drops only the final blank
    { input: "a\n\n", expected: ["a", ""] },
    // standalone \r is part of the line
    { input: "a\rb\n", expected: ["a\rb"] },
    // empty output
    { input: "", expected: [] },
    // single newline
    { input: "\n", expected: [""] },
    // \r\n only
    { input: "\r\n", expected: [""] },
    // mixed endings
    { input: "a\nb\r\nc\n", expected: ["a", "b", "c"] },
  ];
  for (const { input, expected } of cases) {
    const lines: string[] = [];
    const cmd = $`deno eval ${`await Deno.stdout.write(new TextEncoder().encode(${JSON.stringify(input)}));`}`;
    for await (const line of cmd.linesIter()) {
      lines.push(line);
    }
    assertEquals(lines, expected, `input ${JSON.stringify(input)}`);
  }
});

Deno.test("command .linesIter('stderr')", async () => {
  const lines: string[] = [];
  const cmd = $`deno eval "console.error('a'); console.error('b')"`.env("NO_COLOR", "1");
  for await (const line of cmd.linesIter("stderr")) {
    lines.push(line);
  }
  assertEquals(lines, ["a", "b"]);
});

Deno.test("command .linesIter() - streams across read-buffer boundaries", async () => {
  // build ~200KB across ~2000 lines with mixed \n and \r\n, larger than
  // typical pipe read-buffer sizes, to exercise line-crossing behavior.
  const expected: string[] = [];
  const parts: string[] = [];
  for (let i = 0; i < 2000; i++) {
    const line = `line-${i}-` + "x".repeat((i % 97) + 5);
    expected.push(line);
    parts.push(line);
    parts.push(i % 2 === 0 ? "\n" : "\r\n");
  }
  const payload = parts.join("");
  // write payload via stdin and cat it back — avoids command-line size limits.
  const lines: string[] = [];
  for await (const line of $`cat`.stdinText(payload).linesIter()) {
    lines.push(line);
  }
  assertEquals(lines, expected);
});

Deno.test("command .linesIter() - handles multi-byte UTF-8 split across chunk boundaries", async () => {
  // enough characters to cross pipe-buffer boundaries where a single
  // code point can straddle two reads.
  const expected: string[] = [];
  const parts: string[] = [];
  for (let i = 0; i < 5000; i++) {
    const line = `これはテスト-${i}`;
    expected.push(line);
    parts.push(line);
    parts.push("\n");
  }
  const payload = parts.join("");
  const lines: string[] = [];
  for await (const line of $`cat`.stdinText(payload).linesIter()) {
    lines.push(line);
  }
  assertEquals(lines, expected);
});

Deno.test("command .linesIter() - streams lazily (yields before process exits)", async () => {
  // emit a line, sleep, emit another — ensure we get the first line
  // before the process finishes.
  const script = `
    const enc = new TextEncoder();
    await Deno.stdout.write(enc.encode("first\\n"));
    await new Promise((r) => setTimeout(r, 200));
    await Deno.stdout.write(enc.encode("second\\n"));
  `;
  const timestamps: number[] = [];
  const lines: string[] = [];
  const start = Date.now();
  for await (const line of $`deno eval ${script}`.linesIter()) {
    timestamps.push(Date.now() - start);
    lines.push(line);
  }
  assertEquals(lines, ["first", "second"]);
  // first line should arrive meaningfully before the second; allow slack for
  // process startup and CI jitter but enforce there's a gap.
  assert(
    timestamps[1] - timestamps[0] >= 100,
    `expected a gap between lines, got ${timestamps[0]}ms and ${timestamps[1]}ms`,
  );
});

Deno.test("command .linesIter() - early break kills child and doesn't throw", async () => {
  // a long-running command that would otherwise never finish on its own.
  const script = `
    const enc = new TextEncoder();
    while (true) {
      await Deno.stdout.write(enc.encode("tick\\n"));
      await new Promise((r) => setTimeout(r, 20));
    }
  `;
  let count = 0;
  for await (const line of $`deno eval ${script}`.linesIter()) {
    assertEquals(line, "tick");
    if (++count >= 3) break;
  }
  assertEquals(count, 3);
});

Deno.test("command .linesIter() - throws on non-zero exit when fully consumed", async () => {
  await assertRejects(
    async () => {
      for await (const _line of $`deno eval "console.log('x'); Deno.exit(1)"`.linesIter()) {
        // consume all
      }
    },
    Error,
  );
});

Deno.test("command .linesIter() - noThrow suppresses non-zero exit error", async () => {
  const lines: string[] = [];
  for await (const line of $`deno eval "console.log('x'); Deno.exit(1)"`.noThrow().linesIter()) {
    lines.push(line);
  }
  assertEquals(lines, ["x"]);
});

Deno.test("command .linesIter() - works when stdout already set to piped", async () => {
  const lines: string[] = [];
  for await (const line of $`echo hi`.stdout("piped").linesIter()) {
    lines.push(line);
  }
  assertEquals(lines, ["hi"]);
});

Deno.test("command .linesIter() - no output yields nothing", async () => {
  const lines: string[] = [];
  for await (const line of $`deno eval ""`.linesIter()) {
    lines.push(line);
  }
  assertEquals(lines, []);
});

Deno.test("piping in command", async () => {
  await withTempDir(async (tempDir) => {
    const result = await $`echo 1 | cat - > output.txt`.cwd(tempDir).text();
    assertEquals(result, "");
    assertEquals(tempDir.join("output.txt").readTextSync(), "1\n");
  });
  {
    const result = await $`echo 1 | cat -`.text();
    assertEquals(result, "1");
  }
  {
    const result = await $`echo 1 && echo 2 | cat -`.text();
    assertEquals(result, "1\n2");
  }
  {
    const result = await $`echo 1 || echo 2 | cat -`.text();
    assertEquals(result, "1");
  }
});

Deno.test("subshells", async () => {
  {
    const result = await $`(echo 1 && echo 2) | cat -`.text();
    assertEquals(result, "1\n2");
  }
  {
    const result = await $`(echo 1 && echo 2) && echo 3`.text();
    assertEquals(result, "1\n2\n3");
  }
  {
    const result = await $`(echo 1 && echo 2) || echo 3`.text();
    assertEquals(result, "1\n2");
  }
  {
    const result = await $`echo 1 && (echo 2 || echo 3)`.text();
    assertEquals(result, "1\n2");
  }
  {
    const result = await $`echo 1 && (echo 2 && echo 3) || echo 4`.text();
    assertEquals(result, "1\n2\n3");
  }
  {
    const result = await $`echo 1 && (echo 2 || echo 3) && echo 4`.text();
    assertEquals(result, "1\n2\n4");
  }
  // exiting shouldn't exit the parent
  {
    const result = await $`echo 1 && (echo 2 && exit 0 && echo 3) && echo 4`.text();
    assertEquals(result, "1\n2\n4");
  }
  {
    const result = await $`echo 1 && (echo 2 && exit 1 && echo 3) || echo 4`.text();
    assertEquals(result, "1\n2\n4");
  }
  // shouldn't change the environment either
  {
    assertEquals(await $`export VAR=5 && echo $VAR`.text(), "5"); // for reference
    const result = await $`(export VAR=5) && echo $VAR`.text();
    assertEquals(result, "");
  }
  {
    const result = await $`echo 1 && (echo 2 && export VAR=5 && echo $VAR) && echo $VAR`.text();
    assertEquals(result, "1\n2\n5\n");
  }
  await withTempDir(async (tempDir) => {
    const subDir = tempDir.join("subDir");
    subDir.mkdirSync();
    const result = await $`(cd subDir && pwd) && pwd`.cwd(tempDir).text();
    assertEquals(result, `${subDir}\n${tempDir}`);
  });
});

Deno.test("output redirects", async () => {
  await withTempDir(async (tempDir) => {
    // absolute
    const tempFile = tempDir.join("temp_file.txt");
    await $`echo 1 > ${tempFile}`;
    assertEquals(tempFile.readTextSync(), "1\n");
    tempFile.removeSync();

    // relative
    await $`echo 2 > ./temp_file.txt`;
    assertEquals(tempFile.readTextSync(), "2\n");

    // changing directories then relative
    await $`mkdir sub_dir && cd sub_dir && echo 3 > ./temp_file.txt`;
    assertEquals(tempDir.join("sub_dir/temp_file.txt").readTextSync(), "3\n");

    // stderr
    await $`deno eval 'console.log(2); console.error(5);' 2> ./temp_file.txt`.env("NO_COLOR", "1");
    assertEquals(tempFile.readTextSync(), "5\n");

    // append
    await $`deno eval 'console.error(1);' 2> ./temp_file.txt && echo 2 >> ./temp_file.txt && echo 3 >> ./temp_file.txt`
      .env("NO_COLOR", "1");
    assertEquals(tempFile.readTextSync(), "1\n2\n3\n");

    // /dev/null
    assertEquals(await $`echo 1 > /dev/null`.text(), "");
    assertEquals(await $`deno eval 'console.error(1); console.log(2)' 2> /dev/null`.env("NO_COLOR", "1").text(), "2");

    // not supported fd
    {
      const result = await $`echo 1 3> file.txt`.noThrow().stderr("piped");
      assertEquals(result.code, 1);
      assertEquals(result.stderr, "only redirecting to stdout (1) and stderr (2) is supported\n");
    }

    // multiple words
    {
      const result = await $`echo 1 > $var`.env("var", "testing this").noThrow().stderr("piped");
      assertEquals(result.code, 1);
      assertEquals(
        result.stderr,
        'redirect path must be 1 argument, but found 2 (testing this). Did you mean to quote it (ex. "testing this")?\n',
      );
    }

    // piping to a directory
    {
      const dir = tempDir.join("dir");
      dir.mkdirSync();
      const result = await $`echo 1 > ${dir}`.noThrow().stderr("piped");
      assertEquals(result.code, 1);
      assert(result.stderr.startsWith("failed opening file for redirect"));
    }

    {
      assertThrows(
        () => $`echo 1 > ${new TextEncoder()}`,
        Error,
        "Failed resolving expression in command. Unsupported object provided to output redirect.",
      );
    }
  });
});

Deno.test("output redirects with & (both stdout and stderr)", async () => {
  await withTempDir(async (tempDir) => {
    // Test that both streams really go to the same file
    const tempFile = tempDir.join("combined.txt");
    await $`deno eval 'console.log(1); console.error(2); console.log(3);' &> ./combined.txt`
      .cwd(tempDir)
      .env("NO_COLOR", "1");
    const content4 = tempFile.readTextSync();
    assertStringIncludes(content4, "1");
    assertStringIncludes(content4, "2");
    assertStringIncludes(content4, "3");

    // Test with /dev/null
    const result = await $`deno eval 'console.log("visible"); console.error("invisible");' &> /dev/null`
      .env("NO_COLOR", "1")
      .text();
    assertEquals(result, "");
  });
});

Deno.test("input redirects", async () => {
  await withTempDir(async (tempDir) => {
    tempDir.join("test.txt").writeSync("Hi!");
    const text = await $`cat - < test.txt`.text();
    assertEquals(text, "Hi!");
  });
});

Deno.test("input redirects with provided object", async () => {
  {
    assertThrows(
      () => $`cat - < ${new TextEncoder()} && echo ${"test"}`,
      Error,
      "Failed resolving expression 1/2 in command. Unsupported object provided to input redirect.",
    );
  }
  // stream
  {
    const text = "testing".repeat(1000);
    const bytes = new TextEncoder().encode(text);
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    });
    const output = await $`cat - < ${stream}`.text();
    assertEquals(output, text);
  }
  // string
  {
    const text = "testing".repeat(1000);
    const output = await $`cat - < ${text}`.text();
    assertEquals(output, text);
  }
  // bytes
  {
    const text = "testing".repeat(1000);
    const bytes = new TextEncoder().encode(text);
    const output = await $`cat - < ${bytes}`.text();
    assertEquals(output, text);
  }
  // response
  {
    const text = "testing".repeat(1000);
    const response = new Response(text);
    const output = await $`cat - < ${response}`.text();
    assertEquals(output, text);
  }
  // file
  await withTempDir(async (tempDir) => {
    const text = "testing".repeat(1000);
    const filePath = tempDir.join("file.txt");
    filePath.writeSync(text);
    const file = filePath.openSync({ read: true });
    const output = await $`cat - < ${file}`.text();
    assertEquals(output, text);
  });
  // function
  {
    const text = "testing".repeat(1000);
    const response = new Response(text);
    const output = await $`cat - < ${() => response.body!}`.text();
    assertEquals(output, text);
  }
});

Deno.test("output redirect with provided object", async () => {
  await withTempDir(async (tempDir) => {
    const buffer = new Buffer();
    const pipedText = "testing\nthis\nout".repeat(1_000);
    tempDir.join("data.txt").writeSync(pipedText);
    await $`cat data.txt > ${toWritableStream(buffer)}`.cwd(tempDir);
    assertEquals(new TextDecoder().decode(buffer.bytes()), pipedText);
  });
  {
    const chunks = [];
    let wasClosed = false;
    const writableStream = new WritableStream({
      write(chunk) {
        chunks.push(chunk);
      },
      close() {
        wasClosed = true;
      },
    });
    let didThrow = false;
    try {
      await $`echo 1 > ${writableStream} ; exit 1`;
    } catch {
      didThrow = true;
    }
    assert(didThrow);
    assertEquals(chunks.length, 1);
    assert(wasClosed);
  }
  {
    const bytes = new Uint8Array(2);
    await $`echo 1 > ${bytes}`;
    assertEquals(new TextDecoder().decode(bytes), "1\n");
  }
  // overflow
  {
    const bytes = new Uint8Array(1);
    const result = await $`echo 1 > ${bytes}`.noThrow().stderr("piped");
    assertEquals(result.stderr, "echo: Overflow writing 2 bytes to Uint8Array (length: 1).\n");
    assertEquals(result.code, 1);
    assertEquals(bytes[0], 49);
  }
  // file
  await withTempDir(async (tempDir) => {
    const filePath = tempDir.join("file.txt");
    const file = filePath.openSync({ write: true, create: true, truncate: true });
    await $`echo testing > ${file}`;
    assertEquals(filePath.readTextSync(), "testing\n");
  });
  // function
  {
    const chunks: Uint8Array[] = [];
    const writableStream = new WritableStream({
      write(chunk) {
        chunks.push(chunk);
      },
    });
    await $`echo 1 > ${() => writableStream}`;
    assertEquals(chunks, [new Uint8Array([49, 10])]);
  }
  {
    assertThrows(
      () => $`echo 1 > ${"test.txt"}`,
      Error,
      "Failed resolving expression in command. Cannot provide strings to output "
        + "redirects. Did you mean to provide a path instead via the `$.path(...)` API?",
    );
  }
});

Deno.test("shebang support", async (t) => {
  await withTempDir(async (dir) => {
    const steps: Promise<boolean>[] = [];
    const step = (name: string, fn: () => Promise<void>) => {
      steps.push(t.step({
        name,
        fn,
        sanitizeExit: false,
        sanitizeOps: false,
        sanitizeResources: false,
      }));
    };

    step("with -S", async () => {
      dir.join("file.ts").writeSync(
        [
          "#!/usr/bin/env -S deno run",
          "console.log(5);",
        ].join("\n"),
      );
      const output = await $`./file.ts`
        .cwd(dir)
        .text();
      assertEquals(output, "5");
    });

    step("without -S and invalid", async () => {
      dir.join("file2.ts").writeSync(
        [
          "#!/usr/bin/env deno run",
          "console.log(5);",
        ].join("\n"),
      );
      await assertRejects(
        async () => {
          await $`./file2.ts`
            .cwd(dir)
            .text();
        },
        Error,
        "Exited with code: 127",
      );
    });

    step("without -S, but valid", async () => {
      dir.join("echo_stdin.ts").writeSync(
        [
          "#!/usr/bin/env -S deno run --allow-run",
          "await new Deno.Command('deno', { args: ['run', ...Deno.args] }).spawn();",
        ].join("\n"),
      );
      dir.join("file3.ts").writeSync(
        [
          "#!/usr/bin/env ./echo_stdin.ts",
          "console.log('Hello')",
        ].join("\n"),
      );
      const output = await $`./file3.ts`
        .cwd(dir)
        .text();
      assertEquals(output, "Hello");
    });

    step("relative sub dir", async () => {
      dir.join("echo_stdin2.ts").writeSync(
        [
          "#!/usr/bin/env -S deno run --allow-run",
          "await new Deno.Command('deno', { args: ['run', ...Deno.args] }).spawn();",
        ].join("\n"),
      );
      dir.join("sub/sub.ts").writeSync(
        [
          "#!/usr/bin/env ../echo_stdin2.ts",
          "console.log('Hello')",
        ].join("\n"),
      );
      const output = await $`./sub/sub.ts`
        .cwd(dir)
        .text();
      assertEquals(output, "Hello");
    });

    await Promise.all(steps);
  });
});

Deno.test("environment should be evaluated at command execution", async () => {
  const envName = "SHELL_TEST_ENV_SET";
  process.env[envName] = "1";
  try {
    const result = await $.raw`echo $${envName}`.text();
    assertEquals(result, "1");
  } finally {
    delete process.env[envName];
  }
  const result = await $.raw`echo $${envName}`.text();
  assertEquals(result, "");

  // check cwd
  const previousCwd = process.cwd();
  try {
    process.chdir("./src");
    const result = await $`echo $PWD`.text();
    assertEquals(result.slice(-3), "src");
  } finally {
    process.chdir(previousCwd);
  }
});

Deno.test("test remove", async () => {
  await withTempDir(async (dir) => {
    const emptyDir = dir.join("hello");
    const someFile = dir.join("a.txt");
    const notExists = dir.join("notexists");

    emptyDir.mkdirSync();
    someFile.writeSync("");

    // Remove empty directory or file
    await $`rm ${emptyDir}`;
    await $`rm ${someFile}`;
    assertEquals(emptyDir.existsSync(), false);
    assertEquals(someFile.existsSync(), false);

    // Remove a non-empty directory
    const nonEmptyDir = dir.join("a");
    nonEmptyDir.join("b").mkdirSync({ recursive: true });
    {
      const error = await $`rm ${nonEmptyDir}`.noThrow().stderr("piped").spawn()
        .then((r) => r.stderr);
      const expectedText = "rm: directory not empty, rmdir";
      assertEquals(error.substring(0, expectedText.length), expectedText);
    }
    {
      await $`rm -r ${nonEmptyDir}`;
      assertEquals(nonEmptyDir.existsSync(), false);
    }

    // Remove a directory that does not exist
    {
      const [error, code] = await $`rm ${notExists}`.noThrow().stderr("piped").spawn()
        .then((r) => [r.stderr, r.code] as const);
      const expectedText = "rm: no such file or directory, lstat";
      assertEquals(error.substring(0, expectedText.length), expectedText);
      assertEquals(code, 1);
    }
    {
      const [error, code] = await $`rm -Rf ${notExists}`.noThrow().stderr("piped").spawn()
        .then((r) => [r.stderr, r.code] as const);
      assertEquals(error, "");
      assertEquals(code, 0);
    }
  });
});

Deno.test("test mkdir", async () => {
  await withTempDir(async (dir) => {
    await $`mkdir ${dir}/a`;
    assert(dir.join("a").existsSync());

    {
      const error = await $`mkdir ${dir}/a`.noThrow().stderr("piped").spawn()
        .then(
          (r) => r.stderr,
        );
      const expecteError = "mkdir: cannot create directory";
      assertEquals(error.slice(0, expecteError.length), expecteError);
    }

    {
      const error = await $`mkdir ${dir}/b/c`.noThrow().stderr("piped").spawn()
        .then(
          (r) => r.stderr,
        );
      const expectedError = "mkdir: no such file or directory, mkdir";
      assertEquals(error.slice(0, expectedError.length), expectedError);
    }

    await $`mkdir -p ${dir}/b/c`;
    assert(await dir.join("b/c").exists());
  });
});

Deno.test("copy test", async () => {
  await withTempDir(async (dir) => {
    const file1 = dir.join("file1.txt");
    const file2 = dir.join("file2.txt");
    file1.writeSync("test");
    await $`cp ${file1} ${file2}`;

    assert(file1.existsSync());
    assert(file2.existsSync());

    const destDir = dir.join("dest");
    destDir.mkdirSync();
    await $`cp ${file1} ${file2} ${destDir}`;

    assert(file1.existsSync());
    assert(file2.existsSync());
    assert(destDir.join("file1.txt").existsSync());
    assert(destDir.join("file2.txt").existsSync());

    const newFile = dir.join("new.txt");
    newFile.writeSync("test");
    await $`cp ${newFile} ${destDir}`;

    assert(destDir.isDirSync());
    assert(newFile.existsSync());
    assert(destDir.join("new.txt").existsSync());

    assertEquals(
      await getStdErr($`cp ${file1} ${file2} non-existent`),
      "cp: target 'non-existent' is not a directory\n",
    );

    assertEquals(await getStdErr($`cp`), "cp: missing file operand\n");
    assertStringIncludes(await getStdErr($`cp ${file1}`), "cp: missing destination file operand after");

    assertEquals(await getStdErr($`cp`), "cp: missing file operand\n");
    assertStringIncludes(await getStdErr($`cp ${file1}`), "cp: missing destination file operand after");

    // recursive test
    destDir.join("sub_dir").mkdirSync();
    destDir.join("sub_dir", "sub.txt").writeSync("test");
    const destDir2 = dir.join("dest2");

    assertEquals(await getStdErr($`cp ${destDir} ${destDir2}`), "cp: source was a directory; maybe specify -r\n");
    assert(!destDir2.existsSync());

    await $`cp -r ${destDir} ${destDir2}`;
    assert(destDir2.existsSync());
    assert(destDir2.join("file1.txt").existsSync());
    assert(destDir2.join("file2.txt").existsSync());
    assert(destDir2.join("sub_dir", "sub.txt").existsSync());

    // copy again
    await $`cp -r ${destDir} ${destDir2}`;

    // try copying to a file
    assertStringIncludes(await getStdErr($`cp -r ${destDir} ${destDir2}/file1.txt`), "destination was a file");
  });
});

Deno.test("cp test2", async () => {
  await withTempDir(async (dir) => {
    await $`mkdir -p a/d1`;
    await $`mkdir -p a/d2`;
    await create("a/d1/f").then((f) => f.close());
    await $`cp a/d1/f a/d2`;
    assert(dir.join("a/d2/f").existsSync());
  });
});

Deno.test("move test", async () => {
  await withTempDir(async (dir) => {
    const file1 = dir.join("file1.txt");
    const file2 = dir.join("file2.txt");
    file1.writeSync("test");

    await $`mv ${file1} ${file2}`;
    assert(!file1.existsSync());
    assert(file2.existsSync());

    const destDir = dir.join("dest");
    file1.writeSync("test"); // recreate
    destDir.mkdirSync();
    await $`mv ${file1} ${file2} ${destDir}`;
    assert(!file1.existsSync());
    assert(!file2.existsSync());
    assert(destDir.join("file1.txt").existsSync());
    assert(destDir.join("file2.txt").existsSync());

    const newFile = dir.join("new.txt");
    newFile.writeSync("test");
    await $`mv ${newFile} ${destDir}`;
    assert(destDir.isDirSync());
    assert(!newFile.existsSync());
    assert(destDir.join("new.txt").existsSync());

    assertEquals(
      await getStdErr($`mv ${file1} ${file2} non-existent`),
      "mv: target 'non-existent' is not a directory\n",
    );

    assertEquals(await getStdErr($`mv`), "mv: missing operand\n");
    assertStringIncludes(await getStdErr($`mv ${file1}`), "mv: missing destination file operand after");
  });
});

Deno.test("pwd: pwd", async () => {
  assertEquals(await $`pwd`.text(), process.cwd());
});

Deno.test("touch test", async () => {
  await withTempDir(async (dir) => {
    await $`touch a`;
    assert(dir.join("a").existsSync());
    await $`touch a`;
    assert(dir.join("a").existsSync());

    await $`touch b c`;
    assert(dir.join("b").existsSync());
    assert(dir.join("c").existsSync());

    await $`mkdir subdir && cd subdir && touch a`;
    assert(dir.join("subdir/a").existsSync());

    assertEquals(await getStdErr($`touch`), "touch: missing file operand\n");

    assertEquals(await getStdErr($`touch --test hello`), "touch: unsupported flag: --test\n");
  });
});

Deno.test("cat", async () => {
  await withTempDir(async (tempDir) => {
    await fs.promises.writeFile("hello", "hello world");
    assertEquals(
      await $`cat hello`.text(),
      "hello world",
    );
    assertEquals(
      // absolute path
      await $`cat ${tempDir.join("hello")}`.text(),
      "hello world",
    );
    await fs.promises.writeFile("hello2", "hello world2");
    assertEquals(
      await $`cat hello hello2`.text(),
      "hello worldhello world2",
    );
    assertEquals(
      await $`cat`.stdinText("helloz").text(),
      "helloz",
    );
    assertEquals(
      await $`cat -`.stdinText("helloz").text(),
      "helloz",
    );
    assertEquals(
      await $`cat hello - hello2`.stdinText("helloz").text(),
      "hello worldhellozhello world2",
    );
    {
      const result = await $`cat -`.stderr("piped").noThrow();
      assertEquals(result.code, 1);
      assertEquals(result.stderr, "cat: not supported. stdin was 'inherit'\n");
    }
    {
      const result = await $`cat -`.stdin("null").stderr("piped").noThrow();
      assertEquals(result.code, 1);
      assertEquals(result.stderr, "cat: not supported. stdin was 'null'\n");
    }
  });
});

Deno.test("printenv", async () => {
  {
    const result = await $`printenv`.env("hello", "world").env("ab", "cd").text();
    if (process.platform === "win32") {
      assertMatch(result, /HELLO=world/);
      assertMatch(result, /AB=cd/);
    } else {
      assertMatch(result, /hello=world/);
      assertMatch(result, /ab=cd/);
    }
  }
  {
    const result = await $`printenv hello ab`.env("hello", "world").env("ab", "cd").stdout("piped");
    assertEquals(result.code, 0);
    assertEquals(result.stdout, "world\ncd\n");
  }
  if (process.platform === "win32") {
    // windows is case insensitive
    const result = await $`printenv HeLlO aB`.env("hello", "world").env("ab", "cd").stdout("piped");
    assertEquals(result.code, 0);
    assertEquals(result.stdout, "world\ncd\n");
  }
  {
    const result = await $`printenv hello doesntExist`.env("hello", "world").env("ab", "cd").noThrow().stdout("piped");
    assertEquals(result.code, 1);
    assertEquals(result.stdout, "world\n");
  }
});

Deno.test("should give nice error message when cwd directory does not exist", async () => {
  await assertRejects(
    async () => {
      await $`deno eval 'console.log(5)'`.cwd("./non_existent/directory");
    },
    Error,
    "Failed to launch command because the cwd does not exist",
  );
});

Deno.test("should error creating a command signal", () => {
  assertThrows(
    () => {
      new (KillSignal as any)();
    },
    Error,
    "Constructing instances of KillSignal is not permitted.",
  );
});

Deno.test("should receive signal when listening", { ignore: process.platform !== "linux" }, async () => {
  const p =
    $`deno eval 'Deno.addSignalListener("SIGINT", () => console.log("RECEIVED SIGINT")); console.log("started"); setTimeout(() => {}, 10_000)'`
      .noThrow()
      .stdout("piped")
      .spawn();
  await sleep(100);
  p.kill("SIGINT");
  await sleep(30);
  // now terminate it
  p.kill("SIGKILL");
  assertEquals((await p).stdout, "started\nRECEIVED SIGINT\n");
});

Deno.test("signal listening in registered commands", async () => {
  const commandBuilder = new CommandBuilder().noThrow().registerCommand("listen", (handler) => {
    return new Promise((resolve) => {
      function listener(signal: Signal) {
        if (signal === "SIGKILL") {
          resolve({
            code: 135,
          });
          handler.signal.removeListener(listener);
        } else {
          handler.stderr.writeLine(signal);
        }
      }

      handler.signal.addListener(listener);
    });
  });
  const $local = mk$(commandBuilder);

  {
    const child = $local`listen`.stderr("piped").spawn();
    await sleep(5); // let the command start up
    child.kill("SIGINT");
    child.kill("SIGBREAK");
    child.kill("SIGKILL");

    const result = await child;
    assertEquals(result.code, 135);
    assertEquals(result.stderr, "SIGINT\nSIGBREAK\n");
  }

  {
    // now try killing while running and having a command launch afterwards on failure
    const child = $local`listen || echo 1`.stderr("piped").spawn();
    await sleep(5); // let the command start up
    child.kill("SIGINT");
    child.kill("SIGBREAK");
    child.kill("SIGKILL");

    const result = await child;
    // exit code should be the abort code in this case because it tried
    // to launch `echo 1` after the command was killed
    assertEquals(result.code, 124);
    assertEquals(result.stderr, "SIGINT\nSIGBREAK\n");
  }
});

Deno.test("should support setting a command signal", async () => {
  const controller = new KillController();
  const commandBuilder = new CommandBuilder().signal(controller.signal).noThrow();
  const $local = mk$(commandBuilder);
  const startTime = new Date().getTime();

  const processes = [
    $local`sleep 100s`.spawn(),
    $local`sleep 100s`.spawn(),
    $local`sleep 100s`.spawn(),
    // this will be triggered as well because this signal
    // will be linked to the parent signal
    $local`sleep 100s`.signal(new KillController().signal),
  ];

  const subController = new KillController();
  const p = $local`sleep 100s`.signal(subController.signal).spawn();

  await sleep(5);

  subController.kill();

  await p;

  const restPromise = Promise.all(processes);
  await ensurePromiseNotResolved(restPromise);

  controller.kill();

  await restPromise;
  const endTime = new Date().getTime();
  assert(endTime - startTime < 1000);
});

Deno.test("ensure KillController readme example works", async () => {
  const controller = new KillController();
  const signal = controller.signal;
  const startTime = new Date().getTime();

  const promise = Promise.all([
    $`sleep 1000s`.signal(signal),
    $`sleep 2000s`.signal(signal),
    $`sleep 3000s`.signal(signal),
  ]);

  sleep(5).then(() => controller.kill("SIGKILL"));

  await assertRejects(() => promise, Error, "Aborted with exit code: 124");
  const endTime = new Date().getTime();
  assert(endTime - startTime < 1000);
});

Deno.test("should support AbortSignal in command signal", async () => {
  const controller = new AbortController();
  const startTime = Date.now();

  const promise = $`sleep 100s`.signal(controller.signal).noThrow();

  sleep(5).then(() => controller.abort());

  const result = await promise;
  assertEquals(result.code, 124);
  assert(Date.now() - startTime < 1000);
});

Deno.test("should support already-aborted AbortSignal in command signal", async () => {
  const controller = new AbortController();
  controller.abort();

  const result = await $`sleep 100s`.signal(controller.signal).noThrow();
  assertEquals(result.code, 124);
});

Deno.test("should support already-killed KillSignal in command signal", async () => {
  const controller = new KillController();
  controller.kill();

  const result = await $`sleep 100s`.signal(controller.signal).noThrow();
  assertEquals(result.code, 124);
});

Deno.test("should support AbortSignal chained with KillSignal", async () => {
  const abortController = new AbortController();
  const commandBuilder = new CommandBuilder().signal(abortController.signal).noThrow();
  const $local = mk$(commandBuilder);
  const startTime = Date.now();

  const processes = [
    $local`sleep 100s`.spawn(),
    $local`sleep 100s`.spawn(),
  ];

  sleep(5).then(() => abortController.abort());

  await Promise.all(processes);
  assert(Date.now() - startTime < 1000);
});

Deno.test("glob", async () => {
  await withTempDir(async (tempDir) => {
    tempDir.join("test.txt").writeSync("test\n");
    tempDir.join("test2.txt").writeSync("test2\n");
    const out = (await $`cat *.txt`.captureCombined(true)).combined;
    assertEquals(out, "test\ntest2\n");
  });

  await withTempDir(async (tempDir) => {
    tempDir.join("test.txt").writeSync("test\n");
    tempDir.join("test2.txt").writeSync("test2\n");
    const out = (await $`cat test?.txt`.questionGlob().captureCombined(true)).combined;
    assertEquals(out, "test2\n");
  });

  await withTempDir(async (tempDir) => {
    tempDir.join("test.txt").writeSync("test\n");
    tempDir.join("testa.txt").writeSync("testa\n");
    tempDir.join("test2.txt").writeSync("test2\n");
    const out = (await $`cat test[0-9].txt`.captureCombined(true)).combined;
    assertEquals(out, "test2\n");
  });

  await withTempDir(async (tempDir) => {
    tempDir.join("test.txt").writeSync("test\n");
    tempDir.join("testa.txt").writeSync("testa\n");
    tempDir.join("test2.txt").writeSync("test2\n");
    const out = (await $`cat test[!a-z].txt`.captureCombined(true)).combined;
    assertEquals(out, "test2\n");
  });

  await withTempDir(async (tempDir) => {
    tempDir.join("test.txt").writeSync("test\n");
    tempDir.join("testa.txt").writeSync("testa\n");
    tempDir.join("test2.txt").writeSync("test2\n");
    const out = (await $`cat test[a-z].txt`.captureCombined(true)).combined;
    assertEquals(out, "testa\n");
  });

  await withTempDir(async (tempDir) => {
    tempDir.join("sub_dir/sub").mkdirSync({ recursive: true });
    tempDir.join("sub_dir/sub/1.txt").writeSync("1\n");
    tempDir.join("sub_dir/2.txt").writeSync("2\n");
    tempDir.join("sub_dir/other.ts").writeSync("other\n");
    tempDir.join("3.txt").writeSync("3\n");
    const out = (await $`cat */*.txt`.captureCombined(true)).combined;
    assertEquals(out, "2\n");
  });

  await withTempDir(async (tempDir) => {
    tempDir.join("sub_dir/sub").mkdirSync({ recursive: true });
    tempDir.join("sub_dir/sub/1.txt").writeSync("1\n");
    tempDir.join("sub_dir/2.txt").writeSync("2\n");
    tempDir.join("sub_dir/other.ts").writeSync("other\n");
    tempDir.join("3.txt").writeSync("3\n");
    const out = (await $`cat **/*.txt`.captureCombined(true)).combined;
    assertEquals(out, "3\n2\n1\n");
  });

  await withTempDir(async (tempDir) => {
    tempDir.join("sub_dir/sub").mkdirSync({ recursive: true });
    tempDir.join("sub_dir/sub/1.txt").writeSync("1\n");
    tempDir.join("sub_dir/2.txt").writeSync("2\n");
    tempDir.join("sub_dir/other.ts").writeSync("other\n");
    tempDir.join("3.txt").writeSync("3\n");
    const out = (await $`cat $PWD/**/*.txt`.captureCombined(true)).combined;
    assertEquals(out, "3\n2\n1\n");
  });

  await withTempDir(async (tempDir) => {
    tempDir.join("dir").mkdirSync();
    tempDir.join("dir/1.txt").writeSync("1\n");
    tempDir.join("dir_1.txt").writeSync("2\n");
    const out = (await $`cat dir*1.txt`.captureCombined(true)).combined;
    assertEquals(out, "2\n");
  });

  await withTempDir(async (tempDir) => {
    tempDir.join("test.txt").writeSync("test\n");
    tempDir.join("test2.txt").writeSync("test2\n");
    const combined = (await $`cat *.ts`.failglob().noThrow().captureCombined(true)).combined;
    assert(
      combined.match(/glob: no matches found '[^\']+\*\.ts'/) != null,
      combined,
    );
  });

  await withTempDir(async (tempDir) => {
    tempDir.join("test.txt").writeSync("test\n");
    tempDir.join("test2.txt").writeSync("test2\n");

    const combined = (await $`cat [].ts`.failglob().noThrow().captureCombined(true)).combined;
    assert(
      combined.match(/glob: no matches found '[^\']+\.ts'/) != null,
      combined,
    );
  });

  await withTempDir(async (tempDir) => {
    tempDir.join("test.txt").writeSync("test\n");
    tempDir.join("test2.txt").writeSync("test2\n");
    const combined = (await $`cat *.ts || echo 2`.failglob().noThrow().captureCombined(true)).combined;
    assert(
      combined.match(/glob: no matches found '[^\']+\*\.ts'[\s\S]*2\n/) != null,
      combined,
    );
  });

  await withTempDir(async (tempDir) => {
    tempDir.join("test.txt").writeSync("test\n");
    tempDir.join("test2.txt").writeSync("test2\n");
    const combined = (await $`cat *.ts 2> /dev/null || echo 2`.noThrow().captureCombined(true)).combined;
    assertEquals(combined, "2\n");
  });
});

Deno.test("glob case insensitive", async () => {
  await withTempDir(async (tempDir) => {
    tempDir.join("TEST.txt").writeSync("test\n");
    tempDir.join("testa.txt").writeSync("testa\n");
    tempDir.join("test2.txt").writeSync("test2\n");
    const out = (await $`cat tes*.txt`.captureCombined(true)).combined;
    assertEquals(out, "test\ntest2\ntesta\n");
  });
});

Deno.test("glob escapes", async () => {
  // no escape
  await withTempDir(async (tempDir) => {
    tempDir.join("[test].txt").writeSync("test\n");
    tempDir.join("t.txt").writeSync("t\n");
    const out = (await $`cat [test].txt`.captureCombined(true)).combined;
    assertEquals(out, "t\n");
  });

  // escape
  await withTempDir(async (tempDir) => {
    tempDir.join("[test].txt").writeSync("test\n");
    tempDir.join("t.txt").writeSync("t\n");
    const out = (await $`cat [[]test[]].txt`.captureCombined(true)).combined;
    assertEquals(out, "test\n");
  });

  // single quotes
  await withTempDir(async (tempDir) => {
    tempDir.join("[test].txt").writeSync("test\n");
    tempDir.join("t.txt").writeSync("t\n");
    const out = (await $`cat '[test].txt'`.captureCombined(true)).combined;
    assertEquals(out, "test\n");
  });

  // double quotes
  await withTempDir(async (tempDir) => {
    tempDir.join("[test].txt").writeSync("test\n");
    tempDir.join("t.txt").writeSync("t\n");
    const out = (await $`cat "[test].txt"`.captureCombined(true)).combined;
    assertEquals(out, "test\n");
  });

  // mix
  await withTempDir(async (tempDir) => {
    tempDir.join("[test].txt").writeSync("test\n");
    tempDir.join("t.txt").writeSync("t\n");
    const out = (await $`cat "["test"]".txt`.captureCombined(true)).combined;
    assertEquals(out, "test\n");
  });
});

Deno.test("should support empty quoted string", async () => {
  const output = await $`echo '' test ''`.text();
  assertEquals(output, " test ");
});

Deno.test("nice error message when not awaiting a CommandBuilder", async () => {
  await assertRejects(
    async () => {
      const cmd = $`echo 1`;
      return await $`echo ${cmd}`;
    },
    Error,
    "Providing a command builder is not yet supported (https://github.com/dsherret/dax/issues/239). "
      + "Await the command builder's text before using it in an expression (ex. await $`cmd`.text()).",
  );
});

Deno.test("type error null", async () => {
  await assertRejects(
    async () => {
      // @ts-expect-error promise is not supported here
      return await $`echo ${null}`;
    },
    Error,
    "Failed resolving expression in command. Expression was null or undefined.",
  );
});

Deno.test("type error Promise", async () => {
  await assertRejects(
    async () => {
      const promise = Promise.resolve("");
      // @ts-expect-error promise is not supported here
      return await $`echo ${promise}`;
    },
    Error,
    "Failed resolving expression in command. Provided object was a Promise. Please await it before providing it.",
  );
});

Deno.test("which matches the shell which command", async () => {
  {
    const whichFnOutput = await which("deno", whichRealEnv);
    const whichShellOutput = await $`which deno`.text();
    if (process.platform === "win32") {
      // windows is case insensitive
      assertEquals(whichFnOutput?.toLowerCase(), whichShellOutput.toLowerCase());
    } else {
      assertEquals(whichFnOutput, whichShellOutput);
    }
  }
  // arg not found
  {
    const whichShellOutput = await $`which non-existent-command-that-not-exists`
      .noThrow()
      .stderr("piped")
      .stdout("piped");
    assertEquals(whichShellOutput.stderr, "");
    assertEquals(whichShellOutput.stdout, "");
    assertEquals(whichShellOutput.code, 1);
  }
  // invalid args
  {
    const whichShellOutput = await $`which deno test`
      .noThrow()
      .stderr("piped")
      .stdout("piped");
    assertEquals(whichShellOutput.stderr, "which: unsupported too many arguments\n");
    assertEquals(whichShellOutput.stdout, "");
    assertEquals(whichShellOutput.code, 2);
  }
  // invalid arg kind
  {
    const whichShellOutput = await $`which -h`
      .noThrow()
      .stderr("piped")
      .stdout("piped");
    assertEquals(whichShellOutput.stderr, "which: unsupported flag: -h\n");
    assertEquals(whichShellOutput.stdout, "");
    assertEquals(whichShellOutput.code, 2);
  }
});

Deno.test("expect error undefined", async () => {
  await assertRejects(async () => {
    // @ts-expect-error undefined not assignable
    await $`echo ${undefined}`;
  });
  await assertRejects(async () => {
    // @ts-expect-error null not assignable
    await $`echo ${null}`;
  });
});

Deno.test("resolve command by path", async () => {
  const denoPath = await which("deno", whichRealEnv);
  if (denoPath == null) throw new Error("deno binary not found on PATH");
  const version = await $`${denoPath} --version`.text();
  assert(typeof version === "string");
});

Deno.test("windows cmd file", { ignore: process.platform !== "win32" }, async () => {
  await withTempDir(async (tempDir) => {
    tempDir.join("script.cmd").writeSync("@echo off\ndeno %*\n");
    const result = await $`./script.cmd eval "console.log(1); console.log(2)"`.lines("combined");
    assertEquals(result, ["1", "2"]);
  });
});

Deno.test("negation chaining", async () => {
  await assertEquals(await $`! false && echo 1`.text(), "1");
  await assertRejects(
    () => $`! echo hello && ! echo 1`.text(),
    Error,
    "Exited with code: 1",
  );
});

Deno.test("gets exit code", async () => {
  assertEquals(await $`exit 0`.code(), 0);
  assertEquals(await $`exit 1`.code(), 1);
  assertEquals(await $`exit 123`.code(), 123);
});

// shell options tests
Deno.test("shopt command", async () => {
  // query all options
  const result = await $`shopt`.noThrow().captureCombined(true);
  assertEquals(result.code, 0);
  assert(result.combined.includes("failglob\toff"));
  assert(result.combined.includes("globstar\ton"));
  assert(result.combined.includes("nullglob\toff"));

  // set nullglob
  const result2 = await $`shopt -s nullglob && shopt nullglob`.noThrow().captureCombined(true);
  assertEquals(result2.code, 0);
  assertEquals(result2.combined.trim(), "nullglob\ton");

  // set failglob
  const result3 = await $`shopt -s failglob && shopt failglob`.noThrow().captureCombined(true);
  assertEquals(result3.code, 0);
  assertEquals(result3.combined.trim(), "failglob\ton");

  // can set and unset different options with separate commands
  const result4 = await $`shopt -s failglob && shopt -s nullglob && shopt nullglob && shopt failglob`.noThrow()
    .captureCombined(true);
  assertEquals(result4.code, 0);
  assert(result4.combined.includes("nullglob\ton"));
  assert(result4.combined.includes("failglob\ton"));

  // error: invalid option name
  const result5 = await $`shopt -s invalid`.noThrow().captureCombined(true);
  assert(result5.combined.includes("invalid shell option name"));
  assertEquals(result5.code, 1);
});

Deno.test("set command", async () => {
  // enable pipefail
  const result = await $`set -o pipefail && false | echo test`.noThrow().captureCombined(true);
  assertEquals(result.combined, "test\n");
  assertEquals(result.code, 1); // false's exit code

  // disable pipefail (default)
  const result2 = await $`false | echo test`.noThrow().captureCombined(true);
  assertEquals(result2.code, 0); // echo's exit code
  assertEquals(result2.combined, "test\n");

  // disable pipefail with +o
  const result3 = await $`set -o pipefail && set +o pipefail && false | echo test`.noThrow().captureCombined(true);
  assertEquals(result3.code, 0); // echo's exit code (pipefail disabled)
  assertEquals(result3.combined, "test\n");

  // set -o (no option) - lists options
  const result4 = await $`set -o`.captureCombined(true);
  assertEquals(result4.code, 0);
  assertEquals(result4.combined.trim(), "errexit\toff\npipefail\toff");

  // set -o after enabling pipefail shows on
  const result5 = await $`set -o pipefail && set -o`.captureCombined(true);
  assertEquals(result5.code, 0);
  assertEquals(result5.combined.trim(), "errexit\toff\npipefail\ton");

  // set +o (no option) - outputs commands to recreate settings
  const result6 = await $`set +o`.captureCombined(true);
  assertEquals(result6.code, 0);
  assertEquals(result6.combined.trim(), "set +o errexit\nset +o pipefail");

  // set +o after enabling pipefail
  const result7 = await $`set -o pipefail && set +o`.captureCombined(true);
  assertEquals(result7.code, 0);
  assertEquals(result7.combined.trim(), "set +o errexit\nset -o pipefail");

  // error: unknown option
  const result8 = await $`set -o invalid`.noThrow().captureCombined(true);
  assertEquals(result8.code, 1);
  assert(result8.combined.includes("unknown option"));

  // error: invalid argument
  const result9 = await $`set --invalid`.noThrow().captureCombined(true);
  assertEquals(result9.code, 1);
  assert(result9.combined.includes("invalid option"));

  // multiple options in sequence
  const result10 = await $`set -o pipefail -o pipefail && false | echo test`.noThrow().captureCombined(true);
  assertEquals(result10.code, 1);
});

Deno.test("pipefail option via CommandBuilder", async () => {
  // with pipefail: returns first non-zero exit code
  const code1 = await $`false | echo test`.pipefail().noThrow().code();
  assertEquals(code1, 1);

  // without pipefail: returns last command's exit code
  const code2 = await $`false | echo test`.noThrow().code();
  assertEquals(code2, 0);
});

Deno.test("nullglob option", async () => {
  await withTempDir(async (tempDir) => {
    tempDir.join("test.txt").writeSync("test\n");

    // with nullglob: non-matching glob expands to nothing
    const output = await $`shopt -s nullglob && echo *.nonexistent`.text();
    assertEquals(output, "");

    // CommandBuilder API
    const output2 = await $`echo *.nonexistent`.nullglob().text();
    assertEquals(output2, "");
  });
});

Deno.test("failglob option", async () => {
  await withTempDir(async (tempDir) => {
    tempDir.join("test.txt").writeSync("test\n");

    // without failglob (default): non-matching glob passes through literally
    const output = await $`echo *.nonexistent`.text();
    assertEquals(output, "*.nonexistent");

    // with failglob: non-matching glob causes error
    const result = await $`shopt -s failglob && echo *.nonexistent`.noThrow().captureCombined(true);
    assertEquals(result.code, 1);
    assert(result.combined.includes("glob: no matches found"));

    // CommandBuilder API
    const result2 = await $`echo *.nonexistent`.failglob().noThrow().captureCombined(true);
    assertEquals(result2.code, 1);
    assert(result2.combined.includes("glob: no matches found"));
  });
});

Deno.test("questionGlob option", async () => {
  await withTempDir(async (tempDir) => {
    tempDir.join("abc").writeSync("abc\n");
    tempDir.join("axc").writeSync("axc\n");

    // without questionGlob (default): ? is literal
    const output = await $`echo a?c`.text();
    assertEquals(output, "a?c");

    // with questionGlob: ? matches any single character
    const output2 = await $`echo a?c`.questionGlob().text();
    assert(output2.includes("abc"));
    assert(output2.includes("axc"));

    // ? should still be literal in quoted strings even with questionGlob
    const output3 = await $`echo "a?c"`.questionGlob().text();
    assertEquals(output3, "a?c");

    // ? works alongside * globs when questionGlob is off (? is escaped)
    const output4 = await $`echo *?c`.text();
    assertEquals(output4, "*?c");

    // ? works alongside * globs when questionGlob is on
    const output5 = await $`echo *?c`.questionGlob().text();
    assert(output5.includes("abc"));
    assert(output5.includes("axc"));

    // not available via shopt
    const result = await $`shopt -s questionGlob`.noThrow().captureCombined(true);
    assertEquals(result.code, 1);
    assert(result.combined.includes("invalid shell option name"));
  });
});

Deno.test("globstar option", async () => {
  await withTempDir(async (tempDir) => {
    tempDir.join("sub/deep").mkdirSync({ recursive: true });
    tempDir.join("sub/deep/file.txt").writeSync("deep\n");
    tempDir.join("sub/file.txt").writeSync("sub\n");
    tempDir.join("file.txt").writeSync("root\n");

    // with globstar (default): ** matches recursively
    const output = await $`cat **/*.txt`.captureCombined(true);
    // order depends on filesystem, so check for all entries
    assert(output.combined.includes("root"));
    assert(output.combined.includes("sub"));
    assert(output.combined.includes("deep"));

    // without globstar: ** is treated as * (only matches one level)
    const output2 = await $`shopt -u globstar && cat **/*.txt`.captureCombined(true);
    assertEquals(output2.combined, "sub\n");

    // CommandBuilder API
    const output3 = await $`cat **/*.txt`.globstar(false).captureCombined(true);
    assertEquals(output3.combined, "sub\n");
  });
});

Deno.test("beforeCommand: async return survives thenable unwrapping", async () => {
  // returning the builder from an async callback should NOT spawn it via
  // thenable-unwrapping; both env vars should reach the spawned command
  const result = await $`echo $AUTH_TOKEN-$EXTRA`
    .beforeCommand(async (builder) => {
      await new Promise((r) => setTimeout(r, 0));
      return builder.env("AUTH_TOKEN", "Bearer-xyz");
    })
    .beforeCommand((builder) => builder.env("EXTRA", "second"))
    .text();
  assertEquals(result, "Bearer-xyz-second");
});

Deno.test("beforeCommand: chained method calls survive the proxy", async () => {
  // `.env(...).env(...).env(...)` — every intermediate builder must remain
  // non-thenable so the final return doesn't get unwrapped
  const result = await $`echo $A-$B-$C`
    .beforeCommand(async (builder) => {
      await new Promise((r) => setTimeout(r, 0));
      return builder.env("A", "1").env("B", "2").env("C", "3");
    })
    .text();
  assertEquals(result, "1-2-3");
});

Deno.test("beforeCommand: no-op when nothing returned", async () => {
  const result = await $`echo hello`
    .stdout("piped")
    .beforeCommand(() => {});
  assertEquals(result.stdout, "hello\n");
});

Deno.test("beforeCommand: .spawn() throws when hooks are registered", () => {
  const builder = $`echo hi`.beforeCommand(() => {});
  assertThrows(
    () => builder.spawn(),
    Error,
    "beforeCommand",
  );
});

Deno.test("beforeCommandSync: works with .spawn()", async () => {
  const child = $`echo $A-$B`
    .stdout("piped")
    .beforeCommandSync((builder) => builder.env("A", "1"))
    .beforeCommandSync((builder) => builder.env("B", "2"))
    .spawn();
  const result = await child;
  assertEquals(result.stdout, "1-2\n");
});

Deno.test("beforeCommandSync: works on the await path too", async () => {
  const result = await $`echo $X`
    .beforeCommandSync((builder) => builder.env("X", "sync-value"))
    .text();
  assertEquals(result, "sync-value");
});

Deno.test("beforeCommandSync: runs before async hooks on the await path", async () => {
  // sync hook sets BASE; async hook reads/extends it via env composition
  const result = await $`echo $TAG`
    .beforeCommandSync((builder) => builder.env("TAG", "sync"))
    .beforeCommand(async (builder) => {
      await new Promise((r) => setTimeout(r, 0));
      return builder.env("TAG", "sync-then-async");
    })
    .text();
  assertEquals(result, "sync-then-async");
});

Deno.test("beforeCommandSync: a hook that returns nothing is a no-op", async () => {
  const result = await $`echo hello`.beforeCommandSync(() => {}).text();
  assertEquals(result, "hello");
});

Deno.test("errorTail: surfaces captured stderr in the thrown error", async () => {
  // stderr goes to "null" so the test output stays clean; the errorTail
  // tap captures the bytes regardless of where the stream is sent.
  await assertRejects(
    async () => {
      await $`deno eval 'console.error("boom: missing config"); Deno.exit(1);'`
        .stderr("null")
        .errorTail();
    },
    ShellError,
    "boom: missing config",
  );
});

Deno.test("errorTail: ShellError exposes structured properties", async () => {
  const err = await assertRejects(
    async () => {
      await $`deno eval 'console.log("stdout-data"); console.error("stderr-data"); Deno.exit(42);'`
        .stdout("null")
        .stderr("null")
        .errorTail();
    },
    ShellError,
  );
  assertEquals(err.exitCode, 42);
  assertEquals(err.timedOut, false);
  assertEquals(err.aborted, false);
  assertStringIncludes(err.stderr, "stderr-data");
  assertStringIncludes(err.stdout, "stdout-data");
  assert(err instanceof ShellError);
  assert(err instanceof Error);
});

Deno.test("errorTail: includes both stdout and stderr when both have output", async () => {
  const err = await assertRejects(
    async () => {
      await $`deno eval 'console.log("stdout-line"); console.error("stderr-line"); Deno.exit(1);'`
        .stdout("null")
        .stderr("null")
        .errorTail();
    },
    ShellError,
  );
  assertStringIncludes(err.message, "stderr:\nstderr-line");
  assertStringIncludes(err.message, "stdout:\nstdout-line");
});

Deno.test("errorTail: omits stream labels when only one stream produced output", async () => {
  const err = await assertRejects(
    async () => {
      await $`deno eval 'console.error("only stderr"); Deno.exit(1);'`
        .stderr("null")
        .errorTail();
    },
    ShellError,
  );
  // single stream → no "stderr:" label, just the bytes after the message
  assert(!err.message.includes("stderr:"));
  assertStringIncludes(err.message, "only stderr");
});

Deno.test("errorTail: { stdout: false } disables stdout capture", async () => {
  const err = await assertRejects(
    async () => {
      await $`deno eval 'console.log("stdout-line"); console.error("stderr-line"); Deno.exit(1);'`
        .stdout("null")
        .stderr("null")
        .errorTail({ stdout: false });
    },
    ShellError,
  );
  assertStringIncludes(err.message, "stderr-line");
  assert(!err.message.includes("stdout-line"));
});

Deno.test("errorTail: caps captured output to maxBytes (oldest dropped)", async () => {
  // produce ~300 bytes on stderr, then cap to 32 — only the trailing bytes
  // should make it into the error message
  const err = await assertRejects(
    async () => {
      await $`deno eval 'for (let i = 0; i < 30; i++) console.error("line-" + i.toString().padStart(2, "0")); Deno.exit(1);'`
        .stderr("null")
        .errorTail({ maxBytes: 32 });
    },
    ShellError,
  );
  // last lines should be present
  assertStringIncludes(err.message, "line-29");
  // earliest lines should be dropped
  assert(!err.message.includes("line-00"));
});

Deno.test("errorTail: does not modify the error on success", async () => {
  // success path discards the captured buffer entirely — the result resolves
  // normally and `.errorTail()` is a no-op for non-failing commands.
  const result = await $`deno eval 'console.error("noisy but ok");'`
    .stderr("null")
    .errorTail()
    .noThrow();
  assertEquals(result.code, 0);
});

Deno.test("errorTail: noThrow swallows the failure, no error is thrown", async () => {
  // when noThrow is set, we never enter the error path, so the captured
  // bytes are simply dropped — no error means nowhere to surface them.
  const result = await $`deno eval 'console.error("ignored"); Deno.exit(2);'`
    .stderr("null")
    .errorTail()
    .noThrow();
  assertEquals(result.code, 2);
});

Deno.test("errorTail: captures bytes flowing through a piped (CommandBuilder-as-stdin) producer", async () => {
  // models the issue #172 scenario at the producer level: when a command's
  // stdout feeds another command, errorTail on the producer must still
  // tap the bytes flowing through the pipe. drain the readable inside the
  // assertRejects body so the producer's rejection is the one observed
  // (cat's promise would reflect cat's exit, not the producer's).
  await assertRejects(
    async () => {
      const child = $`deno eval 'console.log("piped-payload"); Deno.exit(1);'`
        .errorTail()
        .stdout("piped")
        .spawn();
      const reader = child.stdout().getReader();
      // deno-lint-ignore no-empty
      while (!(await reader.read()).done) {}
      await child;
    },
    ShellError,
    "piped-payload",
  );
});

Deno.test("errorTail: works when stdout is sent to a WritableStream", async () => {
  const sink = new Buffer();
  await assertRejects(
    async () => {
      await $`deno eval 'console.log("captured-line"); Deno.exit(1);'`
        .stdout(toWritableStream(sink))
        .stderr("null")
        .errorTail();
    },
    ShellError,
    "captured-line",
  );
  // sanity: the bytes still reach the WritableStream — the tap is a mirror,
  // not a redirect.
  assertEquals(new TextDecoder().decode(sink.bytes()), "captured-line\n");
});

Deno.test("errorTail: skips capture for inherit streams (user already saw the bytes)", async () => {
  // when the failing command's output went to the terminal, the bytes are
  // already in the user's scrollback — duplicating them in the error
  // message would just be noise, so errorTail is a no-op for inherit
  // streams. stderr is "inherit" here so its bytes must NOT show up in
  // the error message; stdout is "null" so it's captured normally.
  // (the inherit-stderr-line below will appear in test output as a
  // side effect — that's the inherit behavior we're verifying.)
  const err = await assertRejects(
    async () => {
      await $`deno eval 'console.log("stdout-line"); console.error("inherit-stderr-line"); Deno.exit(1);'`
        .stdout("null")
        .stderr("inherit")
        .errorTail();
    },
    ShellError,
  );
  assertStringIncludes(err.message, "stdout-line");
  assert(!err.message.includes("inherit-stderr-line"));
});

Deno.test("errorTail: explicit false disables a previously enabled capture", async () => {
  // builder is immutable: each call returns a new builder, so chaining
  // .errorTail().errorTail(false) should leave capture off.
  const err = await assertRejects(
    async () => {
      await $`deno eval 'console.error("should-not-appear"); Deno.exit(1);'`
        .stderr("null")
        .errorTail()
        .errorTail(false);
    },
    ShellError,
  );
  assert(!err.message.includes("should-not-appear"));
});

Deno.test("errorTail: with stdout piped, surfaces the bytes in the error exactly once", async () => {
  // when stdout is "piped" (captured into the result buffer), errorTail
  // also captures it. callers of .text() etc. don't use errorTail so this
  // is fine — but verify the bytes show up for users who go
  // .stderr("piped") + .errorTail() to grab both in one shot, and that
  // they appear exactly once (no double-inclusion from overlapping taps).
  const err = await assertRejects(
    async () => {
      await $`deno eval 'console.log("stdout-bytes"); Deno.exit(1);'`
        .stdout("piped")
        .errorTail({ stdout: true, stderr: false });
    },
    ShellError,
    "stdout-bytes",
  );
  assertStringIncludes(err.message, "Exited with code: 1");
  assertEquals(err.message.match(/stdout-bytes/g)?.length, 1);
});

Deno.test("errorTail: combined interleaves stdout and stderr into a single buffer", async () => {
  const err = await assertRejects(
    async () => {
      await $`deno eval 'console.log("out1"); console.error("err1"); console.log("out2"); Deno.exit(1);'`
        .stdout("null")
        .stderr("null")
        .errorTail({ combined: true });
    },
    ShellError,
  );
  // combined mode: no stream labels, just interleaved output
  assert(!err.message.includes("stdout:"));
  assert(!err.message.includes("stderr:"));
  assertStringIncludes(err.message, "out1");
  assertStringIncludes(err.message, "err1");
  assertStringIncludes(err.message, "out2");
});

Deno.test("errorTail: combined with only one stream enabled captures just that stream", async () => {
  const err = await assertRejects(
    async () => {
      await $`deno eval 'console.log("out-only"); console.error("err-only"); Deno.exit(1);'`
        .stdout("null")
        .stderr("null")
        .errorTail({ combined: true, stdout: false });
    },
    ShellError,
  );
  assertStringIncludes(err.message, "err-only");
  assert(!err.message.includes("out-only"));
});
