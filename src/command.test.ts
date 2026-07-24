import { assertEquals } from "@std/assert";
import {
  CommandBuilder,
  createRedirectScanner,
  escapeArg,
  getAbortedSignal,
  getCommandBuilderState,
  KillController,
  linkInterpolatedCommandSignals,
} from "./command.ts";

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

Deno.test("linkInterpolatedCommandSignals replays an already-aborted outer signal with its original signal", () => {
  // the outer command was aborted with SIGINT before the interpolated command
  // started, so the catch-up must replay SIGINT (exit code 130) rather than
  // defaulting to SIGTERM (143) and losing the specific abort exit code
  const outer = new KillController();
  outer.kill("SIGINT");
  const linked = linkInterpolatedCommandSignals(new CommandBuilder(), outer.signal);
  const signal = getCommandBuilderState(linked.builder).signal!;
  assertEquals(getAbortedSignal(signal), "SIGINT");
  assertEquals(signal.abortedExitCode, 130);
  linked.unsubscribe();
});

Deno.test("linkInterpolatedCommandSignals replays an already-aborted own signal with its original signal", () => {
  const own = new KillController();
  own.kill("SIGQUIT");
  const linked = linkInterpolatedCommandSignals(new CommandBuilder().signal(own.signal), undefined);
  const signal = getCommandBuilderState(linked.builder).signal!;
  assertEquals(getAbortedSignal(signal), "SIGQUIT");
  assertEquals(signal.abortedExitCode, 131);
  linked.unsubscribe();
});

Deno.test("linkInterpolatedCommandSignals lets the outer signal win when both are already aborted", () => {
  const outer = new KillController();
  outer.kill("SIGINT");
  const own = new KillController();
  own.kill("SIGQUIT");
  const linked = linkInterpolatedCommandSignals(new CommandBuilder().signal(own.signal), outer.signal);
  const signal = getCommandBuilderState(linked.builder).signal!;
  assertEquals(getAbortedSignal(signal), "SIGINT");
  linked.unsubscribe();
});

Deno.test("linkInterpolatedCommandSignals leaves a non-aborted signal alone", () => {
  const linked = linkInterpolatedCommandSignals(new CommandBuilder(), undefined);
  const signal = getCommandBuilderState(linked.builder).signal!;
  assertEquals(signal.aborted, false);
  assertEquals(getAbortedSignal(signal), undefined);
  linked.unsubscribe();
});
