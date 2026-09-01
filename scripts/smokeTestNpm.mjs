// smoke test for the bundled esm output. `smokeTestNpm.ts` copies this file into
// the npm folder and runs it with node so that the imports below resolve through
// the package's own exports rather than the source.
import assert from "node:assert/strict";
import { test } from "node:test";
import $, { CommandBuilder, escapeArg, which, whichSync } from "@dsherret/shell";
import * as mod from "@dsherret/shell";
import * as internal from "@dsherret/shell/internal";
import { setCommandTextStateSymbol, template } from "@dsherret/shell/internal";

test("runs a command", async () => {
  assert.equal(await $`echo hello && echo world`.text(), "hello\nworld");
});

test("parses shell syntax", async () => {
  // this only works if the inlined wasm parser survived bundling
  assert.equal(await $`echo {1..3} $(echo sub) "quoted text"`.text(), "1 2 3 sub quoted text");
});

test("spawns a process", async () => {
  assert.equal(await $`node -e ${"console.log('from node')"}`.text(), "from node");
});

test("captures stderr and the exit code", async () => {
  const result = await $`node -e ${"console.error('to stderr'); process.exit(2)"}`
    .stderr("piped")
    .noThrow();
  assert.equal(result.code, 2);
  assert.equal(result.stderr, "to stderr\n");
});

test("resolves executables with which", async () => {
  // exercises the vendored @david/which code path under node
  assert.ok(await which("node"));
  assert.ok(whichSync("node"));
});

test("shares module instances between the entry points", async () => {
  // the internal entry point's symbols are unique symbols, so this fails unless
  // both entry points resolve to the same bundled module
  const builder = new CommandBuilder()[setCommandTextStateSymbol](
    tag`echo ${"escaped value"}`,
  );
  assert.equal(await builder.text(), "escaped value");
});

test("exports the public api", () => {
  assertHasExports(mod, [
    "$",
    "build$",
    "CommandBuilder",
    "CommandChild",
    "CommandResult",
    "create",
    "createExecutableCommand",
    "delayToMs",
    "escapeArg",
    "FsFile",
    "FsFileWrapper",
    "KillController",
    "KillSignal",
    "open",
    "Path",
    "ProcessTracker",
    "rawArg",
    "RawArg",
    "ShellError",
    "stderr",
    "stdin",
    "stdout",
    "which",
    "whichRealEnv",
    "WhichEnv",
    "whichSync",
  ]);
  assert.equal(mod.default, mod.$);
  assertHasExports(internal, [
    "Box",
    "getRegisteredCommandNamesSymbol",
    "LoggerTreeBox",
    "setCommandTextStateSymbol",
    "symbols",
    "template",
    "templateRaw",
    "TreeBox",
  ]);
});

function assertHasExports(namespace, names) {
  assert.deepEqual(names.filter((name) => namespace[name] == null), []);
}

function tag(strings, ...exprs) {
  return template(strings, exprs);
}
