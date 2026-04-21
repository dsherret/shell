import { assertEquals } from "@std/assert";
import { $, build$, CommandBuilder } from "../mod.ts";

Deno.test("$ runs a command", async () => {
  const result = await $`echo hello`.text();
  assertEquals(result, "hello");
});

Deno.test("$.raw does not escape interpolated values", async () => {
  const args = "1   2   3";
  const result = await $.raw`echo ${args}`.text();
  assertEquals(result, "1 2 3");
});

Deno.test("$.rawArg wraps a value to skip escaping", async () => {
  const result = await $`echo ${$.rawArg("1   2   3")}`.text();
  assertEquals(result, "1 2 3");
});

Deno.test("$.escapeArg escapes shell-sensitive characters", () => {
  assertEquals($.escapeArg("hello"), "hello");
  assertEquals($.escapeArg("'abc'"), `''"'"'abc'"'"''`);
});

Deno.test("build$ creates a $ backed by a provided command builder", async () => {
  const commandBuilder = new CommandBuilder().env("TEST_VAR", "123");
  const local$ = build$({ commandBuilder });
  const result = await local$`echo $TEST_VAR`.text();
  assertEquals(result, "123");
});

Deno.test("build$ accepts a function to customize the command builder", async () => {
  const local$ = build$({ commandBuilder: (b) => b.env("TEST_VAR", "abc") });
  const result = await local$`echo $TEST_VAR`.text();
  assertEquals(result, "abc");
});

Deno.test("build$ attaches extras to the returned $", () => {
  const local$ = build$({
    extras: {
      add(a: number, b: number) {
        return a + b;
      },
    },
  });
  assertEquals(local$.add(2, 3), 5);
});

Deno.test("$.build$ creates a child that merges extras", () => {
  const parent$ = build$({
    extras: {
      add(a: number, b: number) {
        return a + b;
      },
    },
  });
  const child$ = parent$.build$({
    extras: {
      sub(a: number, b: number) {
        return a - b;
      },
    },
  });
  assertEquals(child$.add(4, 5), 9);
  assertEquals(child$.sub(10, 3), 7);
});

Deno.test("$.build$ child inherits the parent's command builder state", async () => {
  const parent$ = build$({ commandBuilder: (b) => b.env("INHERITED", "yes") });
  const child$ = parent$.build$();
  const result = await child$`echo $INHERITED`.text();
  assertEquals(result, "yes");
});
