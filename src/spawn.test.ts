import { assertEquals } from "@std/assert";
import { escapeCmdArg } from "./spawn.ts";

Deno.test("escapeCmdArg leaves plain arguments untouched", () => {
  assertEquals(escapeCmdArg("hello"), "hello");
  assertEquals(escapeCmdArg("npx"), "npx");
  assertEquals(escapeCmdArg("--version"), "--version");
});

Deno.test("escapeCmdArg quotes arguments containing spaces", () => {
  assertEquals(
    escapeCmdArg("C:\\Program Files\\nodejs\\npx.cmd"),
    `"C:\\Program Files\\nodejs\\npx.cmd"`,
  );
});

Deno.test("escapeCmdArg quotes an empty argument", () => {
  assertEquals(escapeCmdArg(""), `""`);
});

Deno.test("escapeCmdArg doubles embedded quotes", () => {
  assertEquals(escapeCmdArg('a "b" c'), `"a \\"b\\" c"`);
});

Deno.test("escapeCmdArg escapes a trailing backslash run before the closing quote", () => {
  // a lone trailing backslash must be doubled, otherwise it would escape the
  // closing quote instead of terminating the argument
  assertEquals(escapeCmdArg("C:\\some dir\\"), `"C:\\some dir\\\\"`);
});

Deno.test("escapeCmdArg does not double interior backslashes that don't precede a quote", () => {
  assertEquals(
    escapeCmdArg("C:\\Program Files\\nodejs\\npx.cmd"),
    `"C:\\Program Files\\nodejs\\npx.cmd"`,
  );
});
