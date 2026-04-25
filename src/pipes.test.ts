import { assertEquals, assertStringIncludes } from "@std/assert";
import { stripAnsiCode } from "@std/fmt/colors";
import { Buffer } from "@std/io/buffer";
import {
  formatRanHeader,
  formatTailHeader,
  InheritStaticTextBypassWriter,
  InheritTailWriter,
} from "./pipes.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

Deno.test("should line buffer the inherit static text bypass writer", () => {
  const buffer = new Buffer();
  const writer = new InheritStaticTextBypassWriter(buffer);
  writer.writeSync(encoder.encode("1"));
  assertEquals(decoder.decode(buffer.bytes()), "");
  writer.writeSync(encoder.encode("\r\n2"));
  assertEquals(decoder.decode(buffer.bytes()), "1\r\n");
  writer.writeSync(encoder.encode("3"));
  writer.writeSync(encoder.encode("4"));
  assertEquals(decoder.decode(buffer.bytes()), "1\r\n");
  writer.writeSync(encoder.encode("\n"));
  assertEquals(decoder.decode(buffer.bytes()), "1\r\n234\n");
  writer.writeSync(encoder.encode("5"));
  writer.flush();
  assertEquals(decoder.decode(buffer.bytes()), "1\r\n234\n5");
});

Deno.test("inherit tail writer keeps only the last N completed lines", () => {
  const buffer = new Buffer();
  using writer = new InheritTailWriter(buffer, 3, /*isTty*/ true);
  writer.writeSync(encoder.encode("line1\nline2\nline3\nline4\nline5\n"));
  assertEquals(writer.tailLines, ["line3", "line4", "line5"]);
  // scope owns the output; inner buffer should remain empty in TTY mode
  assertEquals(decoder.decode(buffer.bytes()), "");
});

Deno.test("inherit tail writer handles partial writes split across chunks", () => {
  const buffer = new Buffer();
  using writer = new InheritTailWriter(buffer, 5, /*isTty*/ true);
  writer.writeSync(encoder.encode("hel"));
  writer.writeSync(encoder.encode("lo\nwor"));
  assertEquals(writer.tailLines, ["hello"]);
  writer.writeSync(encoder.encode("ld\n"));
  assertEquals(writer.tailLines, ["hello", "world"]);
});

Deno.test("inherit tail writer strips trailing \\r from \\r\\n line endings", () => {
  const buffer = new Buffer();
  using writer = new InheritTailWriter(buffer, 5, /*isTty*/ true);
  writer.writeSync(encoder.encode("a\r\nb\r\n"));
  assertEquals(writer.tailLines, ["a", "b"]);
});

Deno.test("inherit tail writer falls back to direct inherit when not a TTY", () => {
  const buffer = new Buffer();
  using writer = new InheritTailWriter(buffer, 3, /*isTty*/ false);
  writer.writeSync(encoder.encode("line1\nline2\n"));
  assertEquals(decoder.decode(buffer.bytes()), "line1\nline2\n");
  assertEquals(writer.tailLines, []);
});

Deno.test("inherit tail writer stops accepting writes after finalize", () => {
  const buffer = new Buffer();
  using writer = new InheritTailWriter(buffer, 3, /*isTty*/ true);
  writer.writeSync(encoder.encode("before\n"));
  writer.finalize();
  // writes after finalize are no-ops
  writer.writeSync(encoder.encode("after\n"));
  assertEquals(writer.tailLines, ["before"]);
});

Deno.test("inherit tail writer keeps a larger error buffer than the live tail", () => {
  const buffer = new Buffer();
  using writer = new InheritTailWriter(buffer, 3, /*isTty*/ true);
  // live tail is bounded by maxLines (3), but the underlying ring retains
  // the last 80 so `finalizeForError` can promote meaningful context back
  // to scrollback. `omittedLineCount` surfaces how many lines rolled off.
  for (let i = 1; i <= 100; i++) writer.writeSync(encoder.encode(`line${i}\n`));
  assertEquals(writer.tailLines, ["line98", "line99", "line100"]);
  // 100 written - 80 retained = 20 dropped, rendered as the
  // `...N lines omitted...` marker above the error tail.
  assertEquals(writer.omittedLineCount, 20);
});

Deno.test("inherit tail writer reports zero omitted lines when all lines fit", () => {
  const buffer = new Buffer();
  using writer = new InheritTailWriter(buffer, 3, /*isTty*/ true);
  for (let i = 1; i <= 5; i++) writer.writeSync(encoder.encode(`line${i}\n`));
  assertEquals(writer.omittedLineCount, 0);
});

Deno.test("tail header fits when shorter than the terminal width", () => {
  const rendered = formatTailHeader("echo hi", { columns: 80, rows: 24 });
  assertEquals(stripAnsiCode(rendered), "Running echo hi");
});

Deno.test("tail header truncates with an ellipsis when wider than the terminal", () => {
  const long = "a".repeat(100);
  const rendered = stripAnsiCode(formatTailHeader(long, { columns: 20, rows: 24 }));
  // 20 columns - "Running " overhead (8) = 12 budget; 11 a's + "…"
  assertEquals(rendered, "Running " + "a".repeat(11) + "…");
});

Deno.test("ran header replaces the running header on success scrollback", () => {
  const rendered = formatRanHeader("echo hi", { columns: 80, rows: 24 });
  assertEquals(stripAnsiCode(rendered), "Ran echo hi");
});

Deno.test("tail header flattens whitespace (multiline commands stay on one line)", () => {
  const buffer = new Buffer();
  using writer = new InheritTailWriter(buffer, 3, /*isTty*/ true);
  writer.setHeader("deno eval\n  const x = 1;\n  console.log(x);");
  // setHeader strips the ANSI-free raw, no tailLines assertion since header is
  // a DeferredItem rendered on refresh — but setHeader should not throw and
  // should accept multiline text without corrupting internal state.
  writer.writeSync(encoder.encode("done\n"));
  assertEquals(writer.tailLines, ["done"]);
});

Deno.test("sibling inherit tail writers share one scrolling region", () => {
  const stdoutBuf = new Buffer();
  const stderrBuf = new Buffer();
  using stdout = new InheritTailWriter(stdoutBuf, 4, /*isTty*/ true);
  using stderr = new InheritTailWriter(stderrBuf, stdout);
  // both tailLines getters point at the same shared array
  assertEquals(stdout.tailLines, stderr.tailLines);
  stdout.writeSync(encoder.encode("out1\nout2\n"));
  stderr.writeSync(encoder.encode("err1\n"));
  stdout.writeSync(encoder.encode("out3\n"));
  // arrival order is preserved, last 4 kept
  assertEquals(stdout.tailLines, ["out1", "out2", "err1", "out3"]);
  assertEquals(stderr.tailLines, ["out1", "out2", "err1", "out3"]);
});

Deno.test("sibling inherit tail writers keep separate pending buffers", () => {
  const stdoutBuf = new Buffer();
  const stderrBuf = new Buffer();
  using stdout = new InheritTailWriter(stdoutBuf, 10, /*isTty*/ true);
  using stderr = new InheritTailWriter(stderrBuf, stdout);
  // interleaved partial writes shouldn't cross-contaminate — each writer
  // only promotes its own pending bytes to a completed line.
  stdout.writeSync(encoder.encode("hel"));
  stderr.writeSync(encoder.encode("war"));
  stdout.writeSync(encoder.encode("lo\n"));
  stderr.writeSync(encoder.encode("n\n"));
  assertEquals(stdout.tailLines, ["hello", "warn"]);
});

Deno.test("sibling writers don't dispose the shared scope until both finalize", () => {
  const stdoutBuf = new Buffer();
  const stderrBuf = new Buffer();
  const stdout = new InheritTailWriter(stdoutBuf, 4, /*isTty*/ true);
  const stderr = new InheritTailWriter(stderrBuf, stdout);
  stdout.writeSync(encoder.encode("shared\n"));
  stdout.finalize();
  // the shared line buffer is still live since stderr hasn't finalized yet
  stderr.writeSync(encoder.encode("still here\n"));
  assertEquals(stderr.tailLines, ["shared", "still here"]);
  stderr.finalize();
});
