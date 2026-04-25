import { assertEquals, assertStringIncludes } from "@std/assert";
import { stripAnsiCode } from "@std/fmt/colors";
import { Buffer } from "@std/io/buffer";
import { StaticTextContainer } from "@david/console-static-text";
import {
  formatRanHeader,
  formatTailHeader,
  InheritStaticTextBypassWriter,
  InheritTailWriter,
  TailRenderer,
} from "./pipes.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * Spins up a `TailRenderer` backed by a captured-writes `StaticTextContainer`
 * with a fixed console size so tests can assert on the exact ANSI bytes
 * `InheritTailWriter` ends up emitting. The interval is disabled — tests
 * call `flush()` to force `container.refresh()` whenever they want to
 * snapshot the written output.
 */
interface TailFixture extends Disposable {
  readonly renderer: TailRenderer;
  /** Refresh, then return captured output with ANSI color codes stripped. */
  flushPlain(): string;
}

function createTailFixture(opts: { rows: number; columns: number }): TailFixture {
  let written = "";
  const container = new StaticTextContainer(
    (text) => {
      written += text;
    },
    () => ({ rows: opts.rows, columns: opts.columns }),
  );
  const renderer = new TailRenderer({ container, interval: null });
  return {
    renderer,
    flushPlain() {
      container.refresh();
      const out = stripAnsiCode(written);
      written = "";
      return out;
    },
    [Symbol.dispose]() {
      renderer[Symbol.dispose]();
    },
  };
}

/** Renderer that drops every byte. Used by tests that don't care about
 * rendered output but still need an isolated renderer so `InheritTailWriter`
 * doesn't leak ANSI escapes to the real terminal via the global default. */
function createNoopRenderer(): TailRenderer {
  const container = new StaticTextContainer(() => {}, () => ({ rows: 24, columns: 80 }));
  return new TailRenderer({ container, interval: null });
}

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
  using renderer = createNoopRenderer();
  using writer = new InheritTailWriter(buffer, 3, /*isTty*/ true, renderer);
  writer.writeSync(encoder.encode("line1\nline2\nline3\nline4\nline5\n"));
  assertEquals(writer.tailLines, ["line3", "line4", "line5"]);
  // scope owns the output; inner buffer should remain empty in TTY mode
  assertEquals(decoder.decode(buffer.bytes()), "");
});

Deno.test("inherit tail writer handles partial writes split across chunks", () => {
  const buffer = new Buffer();
  using renderer = createNoopRenderer();
  using writer = new InheritTailWriter(buffer, 5, /*isTty*/ true, renderer);
  writer.writeSync(encoder.encode("hel"));
  writer.writeSync(encoder.encode("lo\nwor"));
  assertEquals(writer.tailLines, ["hello"]);
  writer.writeSync(encoder.encode("ld\n"));
  assertEquals(writer.tailLines, ["hello", "world"]);
});

Deno.test("inherit tail writer strips trailing \\r from \\r\\n line endings", () => {
  const buffer = new Buffer();
  using renderer = createNoopRenderer();
  using writer = new InheritTailWriter(buffer, 5, /*isTty*/ true, renderer);
  writer.writeSync(encoder.encode("a\r\nb\r\n"));
  assertEquals(writer.tailLines, ["a", "b"]);
});

Deno.test("inherit tail writer falls back to direct inherit when not a TTY", () => {
  const buffer = new Buffer();
  using renderer = createNoopRenderer();
  using writer = new InheritTailWriter(buffer, 3, /*isTty*/ false, renderer);
  writer.writeSync(encoder.encode("line1\nline2\n"));
  assertEquals(decoder.decode(buffer.bytes()), "line1\nline2\n");
  assertEquals(writer.tailLines, []);
});

Deno.test("inherit tail writer stops accepting writes after finalize", () => {
  const buffer = new Buffer();
  using renderer = createNoopRenderer();
  using writer = new InheritTailWriter(buffer, 3, /*isTty*/ true, renderer);
  writer.writeSync(encoder.encode("before\n"));
  writer.finalize();
  // writes after finalize are no-ops
  writer.writeSync(encoder.encode("after\n"));
  assertEquals(writer.tailLines, ["before"]);
});

Deno.test("inherit tail writer keeps a larger error buffer than the live tail", () => {
  const buffer = new Buffer();
  using renderer = createNoopRenderer();
  using writer = new InheritTailWriter(buffer, 3, /*isTty*/ true, renderer);
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
  using renderer = createNoopRenderer();
  using writer = new InheritTailWriter(buffer, 3, /*isTty*/ true, renderer);
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
  using renderer = createNoopRenderer();
  using writer = new InheritTailWriter(buffer, 3, /*isTty*/ true, renderer);
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
  using renderer = createNoopRenderer();
  using stdout = new InheritTailWriter(stdoutBuf, 4, /*isTty*/ true, renderer);
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
  using renderer = createNoopRenderer();
  using stdout = new InheritTailWriter(stdoutBuf, 10, /*isTty*/ true, renderer);
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
  using renderer = createNoopRenderer();
  const stdout = new InheritTailWriter(stdoutBuf, 4, /*isTty*/ true, renderer);
  const stderr = new InheritTailWriter(stderrBuf, stdout);
  stdout.writeSync(encoder.encode("shared\n"));
  stdout.finalize();
  // the shared line buffer is still live since stderr hasn't finalized yet
  stderr.writeSync(encoder.encode("still here\n"));
  assertEquals(stderr.tailLines, ["shared", "still here"]);
  stderr.finalize();
});

Deno.test("tail rendering: live pinned region shows Running header above indented output", () => {
  using fixture = createTailFixture({ rows: 20, columns: 60 });
  using writer = new InheritTailWriter(new Buffer(), 5, /*isTty*/ true, fixture.renderer);
  writer.setHeader("echo hello");
  writer.writeSync(encoder.encode("hello\nworld\n"));

  const out = fixture.flushPlain();
  assertStringIncludes(out, "Running echo hello");
  assertStringIncludes(out, "  hello");
  assertStringIncludes(out, "  world");
});

Deno.test("tail rendering: success without printCommand clears silently", () => {
  using fixture = createTailFixture({ rows: 20, columns: 60 });
  using writer = new InheritTailWriter(new Buffer(), 5, /*isTty*/ true, fixture.renderer);
  writer.setHeader("echo hello");
  writer.writeSync(encoder.encode("hello\n"));
  fixture.flushPlain(); // discard live-tail draw

  writer.finalize();
  // promoteHeaderOnSuccess defaults to false → nothing scrollback-promoted,
  // pinned region is just cleared. content is empty after stripping ANSI.
  assertEquals(fixture.flushPlain().trim(), "");
});

Deno.test("tail rendering: success with promoteHeaderOnSuccess writes Ran header to scrollback", () => {
  using fixture = createTailFixture({ rows: 20, columns: 60 });
  using writer = new InheritTailWriter(new Buffer(), 5, /*isTty*/ true, fixture.renderer);
  writer.setHeader("echo hello");
  writer.setPromoteHeaderOnSuccess(true);
  writer.writeSync(encoder.encode("hello\n"));
  fixture.flushPlain();

  writer.finalize();
  assertStringIncludes(fixture.flushPlain(), "Ran echo hello");
});

Deno.test("tail rendering: error path emits > header and retained tail above pinned region", () => {
  using fixture = createTailFixture({ rows: 40, columns: 60 });
  using writer = new InheritTailWriter(new Buffer(), 3, /*isTty*/ true, fixture.renderer);
  writer.setHeader("./build.sh");
  writer.writeSync(encoder.encode("compiling…\nlinking…\nboom\n"));
  fixture.flushPlain();

  writer.finalizeForError();
  const out = fixture.flushPlain();
  // command header (the `> <cmd>` form, regardless of printCommand)
  assertStringIncludes(out, "> ./build.sh");
  // retained tail under it, indented
  assertStringIncludes(out, "  compiling…");
  assertStringIncludes(out, "  linking…");
  assertStringIncludes(out, "  boom");
});

Deno.test("tail rendering: error path includes omitted-lines marker when ring overflows", () => {
  using fixture = createTailFixture({ rows: 200, columns: 60 });
  using writer = new InheritTailWriter(new Buffer(), 3, /*isTty*/ true, fixture.renderer);
  writer.setHeader("./big.sh");
  // 100 lines written, 80 retained → 20 dropped → "...20 lines omitted..."
  for (let i = 1; i <= 100; i++) writer.writeSync(encoder.encode(`l${i}\n`));
  fixture.flushPlain();

  writer.finalizeForError();
  assertStringIncludes(fixture.flushPlain(), "...20 lines omitted...");
});
