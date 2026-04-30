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
  using writer = new InheritTailWriter(buffer, { maxLines: 3, isTty: true, renderer });
  writer.writeSync(encoder.encode("line1\nline2\nline3\nline4\nline5\n"));
  assertEquals(writer.tailLines, ["line3", "line4", "line5"]);
  // scope owns the output; inner buffer should remain empty in TTY mode
  assertEquals(decoder.decode(buffer.bytes()), "");
});

Deno.test("inherit tail writer handles partial writes split across chunks", () => {
  const buffer = new Buffer();
  using renderer = createNoopRenderer();
  using writer = new InheritTailWriter(buffer, { maxLines: 5, isTty: true, renderer });
  writer.writeSync(encoder.encode("hel"));
  writer.writeSync(encoder.encode("lo\nwor"));
  assertEquals(writer.tailLines, ["hello"]);
  writer.writeSync(encoder.encode("ld\n"));
  assertEquals(writer.tailLines, ["hello", "world"]);
});

Deno.test("inherit tail writer strips trailing \\r from \\r\\n line endings", () => {
  const buffer = new Buffer();
  using renderer = createNoopRenderer();
  using writer = new InheritTailWriter(buffer, { maxLines: 5, isTty: true, renderer });
  writer.writeSync(encoder.encode("a\r\nb\r\n"));
  assertEquals(writer.tailLines, ["a", "b"]);
});

Deno.test("inherit tail writer falls back to direct inherit when not a TTY", () => {
  const buffer = new Buffer();
  using renderer = createNoopRenderer();
  using writer = new InheritTailWriter(buffer, { maxLines: 3, isTty: false, renderer });
  writer.writeSync(encoder.encode("line1\nline2\n"));
  assertEquals(decoder.decode(buffer.bytes()), "line1\nline2\n");
  assertEquals(writer.tailLines, []);
});

Deno.test("inherit tail writer stops accepting writes after finalize", () => {
  const buffer = new Buffer();
  using renderer = createNoopRenderer();
  using writer = new InheritTailWriter(buffer, { maxLines: 3, isTty: true, renderer });
  writer.writeSync(encoder.encode("before\n"));
  writer.finalize();
  // writes after finalize are no-ops
  writer.writeSync(encoder.encode("after\n"));
  assertEquals(writer.tailLines, ["before"]);
});

Deno.test("inherit tail writer keeps a larger error buffer than the live tail", () => {
  const buffer = new Buffer();
  using renderer = createNoopRenderer();
  using writer = new InheritTailWriter(buffer, { maxLines: 3, isTty: true, renderer });
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
  using writer = new InheritTailWriter(buffer, { maxLines: 3, isTty: true, renderer });
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
  using writer = new InheritTailWriter(buffer, { maxLines: 3, isTty: true, renderer });
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
  using stdout = new InheritTailWriter(stdoutBuf, { maxLines: 4, isTty: true, renderer });
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
  using stdout = new InheritTailWriter(stdoutBuf, { maxLines: 10, isTty: true, renderer });
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
  const stdout = new InheritTailWriter(stdoutBuf, { maxLines: 4, isTty: true, renderer });
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
  using writer = new InheritTailWriter(new Buffer(), { maxLines: 5, isTty: true, renderer: fixture.renderer });
  writer.setHeader("echo hello");
  writer.writeSync(encoder.encode("hello\nworld\n"));

  const out = fixture.flushPlain();
  assertStringIncludes(out, "Running echo hello");
  assertStringIncludes(out, "  hello");
  assertStringIncludes(out, "  world");
});

Deno.test("tail rendering: success without printCommand clears silently", () => {
  using fixture = createTailFixture({ rows: 20, columns: 60 });
  using writer = new InheritTailWriter(new Buffer(), { maxLines: 5, isTty: true, renderer: fixture.renderer });
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
  using writer = new InheritTailWriter(new Buffer(), { maxLines: 5, isTty: true, renderer: fixture.renderer });
  writer.setHeader("echo hello");
  writer.setPromoteHeaderOnSuccess(true);
  writer.writeSync(encoder.encode("hello\n"));
  fixture.flushPlain();

  writer.finalize();
  assertStringIncludes(fixture.flushPlain(), "Ran echo hello");
});

Deno.test("tail rendering: error path emits > header and retained tail above pinned region", () => {
  using fixture = createTailFixture({ rows: 40, columns: 60 });
  using writer = new InheritTailWriter(new Buffer(), { maxLines: 3, isTty: true, renderer: fixture.renderer });
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
  using writer = new InheritTailWriter(new Buffer(), { maxLines: 3, isTty: true, renderer: fixture.renderer });
  writer.setHeader("./big.sh");
  // 100 lines written, 80 retained → 20 dropped → "...20 lines omitted..."
  for (let i = 1; i <= 100; i++) writer.writeSync(encoder.encode(`l${i}\n`));
  fixture.flushPlain();

  writer.finalizeForError();
  assertStringIncludes(fixture.flushPlain(), "...20 lines omitted...");
});

Deno.test("maxLines as percentage resolves against terminal rows", () => {
  // 50% of 20 rows = 10 lines; ring keeps the last 10 written
  using fixture = createTailFixture({ rows: 20, columns: 60 });
  using writer = new InheritTailWriter(new Buffer(), {
    maxLines: "50%",
    isTty: true,
    renderer: fixture.renderer,
  });
  for (let i = 1; i <= 15; i++) writer.writeSync(encoder.encode(`l${i}\n`));
  assertEquals(writer.tailLines.length, 10);
  assertEquals(writer.tailLines[0], "l6");
  assertEquals(writer.tailLines[9], "l15");
});

Deno.test("verbatim header skips the Running prefix and is rendered as-is", () => {
  using fixture = createTailFixture({ rows: 20, columns: 60 });
  using writer = new InheritTailWriter(new Buffer(), { maxLines: 3, isTty: true, renderer: fixture.renderer });
  writer.setHeader("building cargo…", { verbatim: true });
  writer.writeSync(encoder.encode("step 1\n"));

  const out = fixture.flushPlain();
  // verbatim → user's exact text appears, no `Running ` prefix injected
  assertStringIncludes(out, "building cargo…");
  assertEquals(out.includes("Running building cargo"), false);
});

Deno.test("verbatim header truncates to terminal width with an ellipsis", () => {
  using fixture = createTailFixture({ rows: 20, columns: 12 });
  using writer = new InheritTailWriter(new Buffer(), { maxLines: 3, isTty: true, renderer: fixture.renderer });
  writer.setHeader("a".repeat(50), { verbatim: true });
  writer.writeSync(encoder.encode("x\n"));

  const out = fixture.flushPlain();
  // 12 cols → 11 a's + ellipsis fits exactly
  assertStringIncludes(out, "a".repeat(11) + "…");
});

Deno.test("error path uses errorHeader when the live header is hidden", () => {
  using fixture = createTailFixture({ rows: 40, columns: 60 });
  using writer = new InheritTailWriter(new Buffer(), { maxLines: 3, isTty: true, renderer: fixture.renderer });
  // user opted into `header: false` (no live label) — but errorHeader still
  // surfaces the raw command on the error scrollback path so logs aren't
  // ambiguous about which command failed.
  writer.setHeader(undefined);
  writer.setErrorHeader("npm run build");
  writer.writeSync(encoder.encode("oh no\n"));
  fixture.flushPlain();

  writer.finalizeForError();
  assertStringIncludes(fixture.flushPlain(), "> npm run build");
});

Deno.test("maxLines rejects non-finite numbers up front", () => {
  // NaN/Infinity would propagate into the ring buffer's `new Array(NaN)`
  // and silently break the live tail otherwise — fail loudly instead.
  let threw = false;
  try {
    new InheritTailWriter(new Buffer(), { maxLines: NaN, isTty: true });
  } catch (e) {
    threw = e instanceof TypeError;
  }
  assertEquals(threw, true);

  threw = false;
  try {
    new InheritTailWriter(new Buffer(), { maxLines: Infinity, isTty: true });
  } catch (e) {
    threw = e instanceof TypeError;
  }
  assertEquals(threw, true);
});

Deno.test("maxLines callback receives the current console size", () => {
  using fixture = createTailFixture({ rows: 30, columns: 60 });
  using writer = new InheritTailWriter(new Buffer(), {
    maxLines: ({ size }) => Math.min(4, (size?.rows ?? 24) - 2),
    isTty: true,
    renderer: fixture.renderer,
  });
  for (let i = 1; i <= 10; i++) writer.writeSync(encoder.encode(`l${i}\n`));
  // 30 rows - 2 = 28, capped at 4 → last 4 visible
  assertEquals(writer.tailLines, ["l7", "l8", "l9", "l10"]);
});

Deno.test("header callback receives the command text and is called per draw", () => {
  using fixture = createTailFixture({ rows: 20, columns: 60 });
  using writer = new InheritTailWriter(new Buffer(), { maxLines: 3, isTty: true, renderer: fixture.renderer });
  let calls = 0;
  // command.ts pre-binds the command text into the resolved fn, so from
  // setHeader's perspective it just gets `(ctx: { size })` — this mirrors
  // how `.tailDisplay({ header: (ctx) => ... })` reaches the writer.
  writer.setHeader(({ size }) => {
    calls++;
    return `cargo build [${size?.columns ?? "?"}]`;
  }, { verbatim: true });
  writer.writeSync(encoder.encode("compiling…\n"));

  const out = fixture.flushPlain();
  assertStringIncludes(out, "cargo build [60]");
  // resolved at least once during the flush; static-text may call it again
  // on subsequent refreshes, so we just assert it ran.
  assertEquals(calls > 0, true);
});

Deno.test("maxLines is the total budget — header consumes one row of it", () => {
  // budget = 4 with a header → 3 visible output lines, oldest first
  using fixture = createTailFixture({ rows: 20, columns: 60 });
  using writer = new InheritTailWriter(new Buffer(), {
    maxLines: 4,
    isTty: true,
    renderer: fixture.renderer,
    header: "build",
    headerVerbatim: true,
  });
  for (let i = 1; i <= 8; i++) writer.writeSync(encoder.encode(`l${i}\n`));
  assertEquals(writer.tailLines, ["l6", "l7", "l8"]);

  // without a header, the same budget shows 4 rows of output
  using bare = new InheritTailWriter(new Buffer(), { maxLines: 4, isTty: true, renderer: fixture.renderer });
  for (let i = 1; i <= 8; i++) bare.writeSync(encoder.encode(`b${i}\n`));
  assertEquals(bare.tailLines, ["b5", "b6", "b7", "b8"]);
});

Deno.test("maxLines floors to 1 visible line when a header is present", () => {
  // user passes maxLines:1 with a header — visible would be 0 without the
  // floor. forced minimum keeps the segment at least 2 rows total.
  using fixture = createTailFixture({ rows: 20, columns: 60 });
  using writer = new InheritTailWriter(new Buffer(), {
    maxLines: 1,
    isTty: true,
    renderer: fixture.renderer,
    header: "step",
    headerVerbatim: true,
  });
  writer.writeSync(encoder.encode("a\nb\nc\n"));
  assertEquals(writer.tailLines, ["c"]);
});

Deno.test("verbatim header truncation strips ANSI when measuring width", () => {
  using fixture = createTailFixture({ rows: 20, columns: 10 });
  using writer = new InheritTailWriter(new Buffer(), { maxLines: 3, isTty: true, renderer: fixture.renderer });
  // 11 visible chars wrapped in red ANSI escapes — without ANSI-aware
  // measurement, the byte length would be much higher and either skip
  // truncation entirely or cut mid-escape.
  const styled = "\x1b[31m" + "x".repeat(11) + "\x1b[39m";
  writer.setHeader(styled, { verbatim: true });
  writer.writeSync(encoder.encode("hi\n"));

  const out = fixture.flushPlain();
  // 10 cols → 9 x's + ellipsis; styling drops on overflow but no escape
  // bytes leak into the rendered tail.
  assertStringIncludes(out, "x".repeat(9) + "…");
  assertEquals(out.includes("\x1b[31m"), false);
});

Deno.test("constructor-time header avoids the register/setHeader render gap", () => {
  // segments installed via the constructor's options bag are fully labeled
  // before they hit the renderer's #segments list — the very first paint
  // already shows the header (no one-tick blank window).
  using fixture = createTailFixture({ rows: 20, columns: 60 });
  using writer = new InheritTailWriter(new Buffer(), {
    maxLines: 3,
    isTty: true,
    renderer: fixture.renderer,
    header: "first paint header",
    headerVerbatim: true,
  });
  // forces the segment to actually be drawn — the renderer paints whatever
  // it currently knows about, and the first paint must include our header.
  void writer;
  const out = fixture.flushPlain();
  assertStringIncludes(out, "first paint header");
});

Deno.test("success-side pending bytes survive into a sibling's error scrollback", () => {
  using fixture = createTailFixture({ rows: 40, columns: 60 });
  using stdout = new InheritTailWriter(new Buffer(), {
    maxLines: 3,
    isTty: true,
    renderer: fixture.renderer,
    errorHeader: "build",
  });
  using stderr = new InheritTailWriter(new Buffer(), stdout);

  // stdout writes a full line and then a partial one with no newline
  stdout.writeSync(encoder.encode("compiling\nlinking-in-progres"));
  // stderr writes a full line and then a partial one
  stderr.writeSync(encoder.encode("warning\nlinker:"));
  fixture.flushPlain();

  // mixed termination: stdout reports success but stderr errors. stdout's
  // partial "linking-in-progres" should still be in the error scrollback —
  // before the fix, finalize() discarded it.
  stdout.finalize();
  stderr.finalizeForError();
  const out = fixture.flushPlain();
  assertStringIncludes(out, "linking-in-progres");
  assertStringIncludes(out, "linker:");
});

Deno.test("success scrollback with verbatim header shows the user's text, not 'Ran ...'", () => {
  using fixture = createTailFixture({ rows: 20, columns: 60 });
  using writer = new InheritTailWriter(new Buffer(), { maxLines: 3, isTty: true, renderer: fixture.renderer });
  writer.setHeader("custom-step", { verbatim: true });
  writer.setPromoteHeaderOnSuccess(true);
  writer.writeSync(encoder.encode("done\n"));
  fixture.flushPlain();

  writer.finalize();
  const out = fixture.flushPlain();
  // verbatim wins on success scrollback too — no `Ran ` framing
  assertStringIncludes(out, "custom-step");
  assertEquals(out.includes("Ran custom-step"), false);
});
