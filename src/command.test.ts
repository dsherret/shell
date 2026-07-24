import { assertEquals } from "@std/assert";
import { createRedirectScanner, escapeArg } from "./command.ts";

Deno.test("escapes arg", () => {
  assertEquals(escapeArg("hello"), "hello");
  assertEquals(escapeArg(""), "''");
  assertEquals(escapeArg("'abc'"), `''"'"'abc'"'"''`);
});

Deno.test("redirect scanner only scans the newly appended text", () => {
  const scanner = createRedirectScanner();
  assertEquals(scanner.scan("cat <"), "<");
  // changing what was already scanned has no effect, which is what keeps
  // building a command with many expressions linear (rescanning from the
  // start would return `>` here)
  assertEquals(scanner.scan("echo> "), "<");
});

Deno.test("redirect scanner only lets whitespace separate the operator from its target", () => {
  // non-ascii whitespace separates them, but any other non-ascii character
  // is an ordinary argument that leaves no redirect pending
  assertEquals(createRedirectScanner().scan("cat <\u00a0"), "<");
  assertEquals(createRedirectScanner().scan("cat < é"), undefined);
});

Deno.test("redirect scanner tracks quoting across scans", () => {
  const scanner = createRedirectScanner();
  assertEquals(scanner.scan("echo '"), undefined);
  assertEquals(scanner.scan("echo '> "), undefined); // still quoted
  assertEquals(scanner.scan("echo '> ' > "), ">");
});

Deno.test("redirect scanner tracks an escape across scans", () => {
  const scanner = createRedirectScanner();
  assertEquals(scanner.scan("echo \\"), undefined);
  // the backslash escapes the operator that only arrives in the next scan
  assertEquals(scanner.scan("echo \\< "), undefined);
});

Deno.test("redirect scanner resyncs when the redirect target is replaced", () => {
  const scanner = createRedirectScanner();
  assertEquals(scanner.scan("cat < "), "<");
  // what happens once the expression's stream is given an fd—the text is
  // shortened by the trailing whitespace before the fd is appended
  const text = "cat < ".trimEnd() + "&3";
  scanner.resyncAfterRedirect(text);
  assertEquals(scanner.scan(text + " "), undefined);
});
