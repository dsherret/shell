import type { FsFileWrapper, Path } from "@david/path";
import {
  type ConsoleSize,
  type RenderInterval,
  renderInterval,
  staticText,
  type StaticTextContainer,
  type StaticTextScope,
  stripAnsiCodes,
  type TextItem,
} from "@david/console-static-text";
import * as colors from "@std/fmt/colors";
import { Buffer } from "@std/io/buffer";
import { writeAll, writeAllSync } from "@std/io/write-all";
import type { CommandBuilder, KillSignal } from "./command.ts";
import { abortSignalToPromise } from "./common.ts";
import { LineRingBuffer } from "./lineRingBuffer.ts";
import type { Closer, Reader, ReaderSync, Writer, WriterSync } from "@std/io/types";
import type { CommandPipeWriter } from "./commandHandler.ts";
export type { Closer, Reader, ReaderSync, Writer, WriterSync };

/** 2-space indent for tail output, mirrors Docker's nested step output. */
const TAIL_INDENT = "  ";

/** Wraps a raw output line so it renders indented under the status header.
 * Uses `hangingIndent` so soft-wrapped continuations align with the first
 * column of indented content rather than snapping back to column 0. */
function indentTailLine(line: string): TextItem {
  return { text: TAIL_INDENT + line, hangingIndent: TAIL_INDENT.length };
}

/**
 * Owns the static text scope and the list of active tail segments. A single
 * shared instance handles all `InheritTailWriter`s in the process so parallel
 * commands interleave into the same pinned region. Tests can construct
 * their own with a stand-in `StaticTextContainer` to assert on the emitted
 * ANSI bytes; pass `interval: null` to skip the periodic refresh and drive
 * `container.refresh()` manually.
 */
export class TailRenderer implements Disposable {
  readonly container: StaticTextContainer;
  readonly #scope: StaticTextScope;
  readonly #intervalScope: Disposable | undefined;
  readonly #segments: InheritTailState[] = [];
  // single deferred installed on the scope while at least one segment is
  // active. `setText` is called only on the empty↔non-empty transition, so
  // appendLines/setHeader become pure field writes — items get rebuilt at
  // draw time (≈16 Hz via renderInterval) instead of per write.
  readonly #deferredItems: TextItem[];

  constructor(options: {
    container?: StaticTextContainer;
    interval?: RenderInterval | null;
  } = {}) {
    this.container = options.container ?? staticText;
    this.#scope = this.container.createScope();
    const interval = options.interval === null ? undefined : (options.interval ?? renderInterval);
    this.#intervalScope = interval?.start();
    this.#deferredItems = [(size) => this.#buildItems(size)];
  }

  [Symbol.dispose](): void {
    this.#intervalScope?.[Symbol.dispose]();
    this.#scope[Symbol.dispose]();
  }

  /** @internal */
  register(seg: InheritTailState): void {
    const wasEmpty = this.#segments.length === 0;
    this.#segments.push(seg);
    // flip the scope on only when transitioning from no segments → some,
    // so `hasText()` toggles and the renderInterval can park itself when
    // nothing is being tailed.
    if (wasEmpty) this.#scope.setText(this.#deferredItems);
  }

  /** @internal */
  unregister(seg: InheritTailState): void {
    const idx = this.#segments.indexOf(seg);
    if (idx !== -1) this.#segments.splice(idx, 1);
    if (this.#segments.length === 0) this.#scope.setText([]);
  }

  /** @internal */
  logAbove(items: TextItem[]): void {
    this.#scope.logAbove(items);
  }

  #buildItems(size: ConsoleSize | undefined): TextItem[] {
    const items: TextItem[] = [];
    const ctx = { size };
    for (const seg of this.#segments) {
      // headers used to be emitted as `(size) => formatTailHeader(...)`
      // closures so they could re-fit on console-size changes — but the
      // deferred item we register on the scope already runs per draw, so
      // we resolve the header string inline here and skip a closure per
      // segment per tick.
      if (seg.headerFn != null) {
        const text = seg.headerFn(ctx);
        items.push(seg.headerVerbatim ? truncateHeaderToWidth(text, size) : formatTailHeader(text, size));
      }
      for (const line of seg.lines.takeLast(seg.visibleLineCount(ctx))) items.push(indentTailLine(line));
    }
    return items;
  }
}

/** Default renderer wired to the host's stderr-backed `staticText` global
 * and the shared `renderInterval` so the pinned region keeps painting. */
const defaultTailRenderer: TailRenderer = new TailRenderer();

const encoder = new TextEncoder();

export type PipeReader = Reader | ReaderSync;

export type PipeWriter = Writer | WriterSync;

/** An awaitable that resolves to an object exposing a `readable` stream —
 * e.g. a `RequestBuilder` that resolves to a response with `.readable`. */
export interface AwaitableReadable {
  /** Resolves to an object that exposes a `ReadableStream<Uint8Array>` via
   * its `readable` property. */
  then<TResult1 = { readable: ReadableStream<Uint8Array> }, TResult2 = never>(
    onfulfilled?:
      | ((value: { readable: ReadableStream<Uint8Array> }) => TResult1 | PromiseLike<TResult1>)
      | undefined
      | null,
    onrejected?: ((reason: any) => TResult2 | PromiseLike<TResult2>) | undefined | null,
  ): PromiseLike<TResult1 | TResult2>;
}

/** Behaviour to use for stdin.
 * @value "inherit" - Sends the stdin of the process to the shell (default).
 * @value "null" - Does not pipe or redirect the pipe.
 */
export type ShellPipeReaderKind =
  | "inherit"
  | "null"
  | Reader
  | ReadableStream<Uint8Array>
  | Uint8Array
  | CommandBuilder
  | FsFileWrapper
  | Path
  | AwaitableReadable;

/**
 * The behaviour to use for a shell pipe.
 * @value "inherit" - Sends the output directly to the current process' corresponding pipe (default).
 * @value "null" - Does not pipe or redirect the pipe.
 * @value "piped" - Captures the pipe without outputting.
 * @value "inheritPiped" - Captures the pipe with outputting.
 */
export type ShellPipeWriterKind =
  | "inherit"
  | "null"
  | "piped"
  | "inheritPiped"
  | WriterSync
  | WritableStream<Uint8Array>
  | FsFileWrapper
  | Path;

export class NullPipeReader implements Reader {
  read(_p: Uint8Array): Promise<number | null> {
    return Promise.resolve(null);
  }
}

export class NullPipeWriter implements WriterSync {
  writeSync(p: Uint8Array): number {
    return p.length;
  }
}

export class ShellPipeWriter {
  #kind: ShellPipeWriterKind;
  #inner: PipeWriter;

  constructor(kind: ShellPipeWriterKind, inner: PipeWriter) {
    this.#kind = kind;
    this.#inner = inner;
  }

  get kind() {
    return this.#kind;
  }

  get inner() {
    return this.#inner;
  }

  write(p: Uint8Array) {
    if ("write" in this.#inner) {
      return this.#inner.write(p);
    } else {
      return this.#inner.writeSync(p);
    }
  }

  writeAll(data: Uint8Array) {
    if ("write" in this.#inner) {
      return writeAll(this.#inner, data);
    } else {
      return writeAllSync(this.#inner, data);
    }
  }

  writeText(text: string) {
    return this.writeAll(encoder.encode(text));
  }

  writeLine(text: string) {
    return this.writeText(text + "\n");
  }
}

export class CapturingBufferWriter implements Writer {
  #buffer: Buffer;
  #innerWriter: Writer;

  constructor(innerWriter: Writer, buffer: Buffer) {
    this.#innerWriter = innerWriter;
    this.#buffer = buffer;
  }

  getBuffer() {
    return this.#buffer;
  }

  async write(p: Uint8Array) {
    const nWritten = await this.#innerWriter.write(p);
    this.#buffer.writeSync(p.slice(0, nWritten));
    return nWritten;
  }
}

export class CapturingBufferWriterSync implements WriterSync {
  #buffer: Buffer;
  #innerWriter: WriterSync;

  constructor(innerWriter: WriterSync, buffer: Buffer) {
    this.#innerWriter = innerWriter;
    this.#buffer = buffer;
  }

  getBuffer() {
    return this.#buffer;
  }

  writeSync(p: Uint8Array) {
    const nWritten = this.#innerWriter.writeSync(p);
    this.#buffer.writeSync(p.slice(0, nWritten));
    return nWritten;
  }
}

const lineFeedCharCode = "\n".charCodeAt(0);

export class InheritStaticTextBypassWriter implements WriterSync {
  #buffer: Buffer;
  #innerWriter: WriterSync;

  constructor(innerWriter: WriterSync) {
    this.#innerWriter = innerWriter;
    this.#buffer = new Buffer();
  }

  writeSync(p: Uint8Array): number {
    // line buffer the output so that we don't conflict with the progress bars
    const index = p.findLastIndex((v) => v === lineFeedCharCode);
    if (index === -1) {
      this.#buffer.writeSync(p);
    } else {
      // todo: seems inefficient
      this.#buffer.writeSync(p.slice(0, index + 1));
      this.flush();
      this.#buffer.writeSync(p.slice(index + 1));
    }
    return p.byteLength;
  }

  flush() {
    const bytes = this.#buffer.bytes({ copy: false });
    staticText.withTempClear(() => {
      writeAllSync(this.#innerWriter, bytes);
    });
    this.#buffer.reset();
  }
}

/**
 * Default number of lines to show in `.tailDisplay()` mode. Docker Compose
 * shows a comparable-sized window; small enough not to dominate the terminal,
 * large enough to convey progress.
 */
export const DEFAULT_INHERIT_TAIL_LINES = 5;

/**
 * Default number of lines to retain for error-time flushback. On error the
 * live tail (5 lines) rarely shows what actually broke, so we keep a larger
 * buffer and promote it to scrollback when the command fails.
 */
export const DEFAULT_INHERIT_TAIL_ERROR_LINES = 80;

/** Context passed to a `TailMaxLines` callback at draw time. */
export interface TailMaxLinesContext {
  /** Current terminal size, or `undefined` if the host isn't a TTY. */
  size: ConsoleSize | undefined;
}

/** Total number of rows the tail occupies — header included — so two
 * commands tailing at `"50%"` each compose into a full screen instead of
 * spilling. When a header is shown the visible output count is `maxLines - 1`,
 * clamped to at least 1 row of output (so a headered tail is always at
 * least 2 rows total). Accepts:
 * - A literal `number`, taken as-is.
 * - A string like `"50%"`, resolved against the terminal's row count at draw
 *   time so the tail re-fits if the user resizes mid-run.
 * - A function called per draw — for cases neither form covers, e.g.
 *   `(ctx) => Math.min(10, (ctx.size?.rows ?? 24) - 5)` to leave headroom. */
export type TailMaxLines = number | `${number}%` | ((ctx: TailMaxLinesContext) => number);

/** Context passed to a `TailHeader` callback at draw time. */
export interface TailHeaderContext {
  /** The raw command text being run. */
  command: string;
  /** Current terminal size, or `undefined` if the host isn't a TTY. */
  size: ConsoleSize | undefined;
}

/** Header rendered above the live tail.
 * - `undefined` (default): `Running <command>` while running, `Ran <command>` in scrollback (when `printCommand()` is set).
 * - `false`: no header.
 * - `string`: rendered verbatim — you supply any styling.
 * - function: called per draw with `{ command, size }`; the result is rendered verbatim.
 *
 * Regardless of this setting, the error path still emits `> <command>` to
 * scrollback so failed commands stay unambiguous in logs. */
export type TailHeader = string | false | ((ctx: TailHeaderContext) => string);

/**
 * Construction-time options for `InheritTailWriter`. The user-facing
 * `.tailDisplay()` API maps onto this plus a few post-construction setters
 * for header/promote behavior.
 */
export interface InheritTailWriterOptions {
  /** Number of visible tail lines. See {@link TailMaxLines}.
   * @default 5
   */
  maxLines?: TailMaxLines;
  /** Treat the inner writer as TTY-attached. Defaults to `process.stderr.isTTY`.
   * When false, writes pass through to the inner writer untouched (no pinned
   * region) — used when the host process isn't a terminal. */
  isTty?: boolean;
  /** Renderer hosting the pinned scrolling region. Defaults to the global
   * one tied to `staticText` + `renderInterval`. Tests pass a custom
   * renderer to capture the emitted ANSI bytes in isolation. */
  renderer?: TailRenderer;
  /** Header text or per-draw callback (already pre-bound — accepts only
   * `{ size }`). Set in the constructor so the segment is fully labeled
   * before it gets registered with the renderer; otherwise the live area
   * could paint a header-less segment for one tick. */
  header?: string | ((ctx: { size: ConsoleSize | undefined }) => string);
  /** When true, render `header` as-is (no `Running` / `Ran` framing). */
  headerVerbatim?: boolean;
  /** Always-shown command label on the error scrollback path, even when
   * `header` is hidden or customized. */
  errorContext?: string;
  /** When true, promote the header to scrollback as `Ran <cmd>` (or the
   * verbatim header) on success — typically wired to `.printCommand()`. */
  promoteHeaderOnSuccess?: boolean;
}

/**
 * Configuration for `.tailDisplay()`. Pass `true` to enable with defaults,
 * or an options object to customize.
 */
export interface TailDisplayOptions {
  /** Number of visible tail lines. See {@link TailMaxLines}.
   * @default 5
   */
  maxLines?: TailMaxLines;
  /** Header rendered above the live tail. See {@link TailHeader}. */
  header?: TailHeader;
}

/** Internal: a maxLines value normalized into a uniform per-draw callback,
 * so the renderer doesn't dispatch on type each tick. */
type ResolvedMaxLinesFn = (ctx: TailMaxLinesContext) => number;

/** Internal: a header value normalized into a uniform per-draw callback.
 * The user-facing `(ctx: TailHeaderContext) => string` is pre-bound with
 * the command text by command.ts before reaching state, so the renderer
 * (which only knows about `size`) can call it uniformly. */
type ResolvedHeaderFn = (ctx: { size: ConsoleSize | undefined }) => string;

/** Normalize a user-provided `TailMaxLines` (number / percentage / callback)
 * into a single function the renderer can call without dispatching on type. */
function makeMaxLinesResolver(value: TailMaxLines): ResolvedMaxLinesFn {
  if (typeof value === "function") return value;
  if (typeof value === "number") {
    // reject NaN/Infinity early — they propagate into the ring-buffer
    // capacity (`new Array(NaN)` throws RangeError) and into takeLast,
    // which would silently render an empty live tail.
    if (!Number.isFinite(value)) {
      throw new TypeError(`Invalid tailDisplay maxLines: ${value}`);
    }
    const n = Math.max(1, Math.floor(value));
    return () => n;
  }
  // "N%" — relative to terminal rows. Captured into a closure so percentages
  // and explicit functions follow the same code path inside the renderer.
  const match = /^(\d+(?:\.\d+)?)%$/.exec(value);
  if (!match) throw new TypeError(`Invalid tailDisplay maxLines: ${JSON.stringify(value)}`);
  const fraction = parseFloat(match[1]) / 100;
  return ({ size }) => {
    // No rows to compute against (piped to a file, etc.) — fall back to the
    // baseline so percentage callers don't have to handle `undefined`.
    if (size?.rows == null) return DEFAULT_INHERIT_TAIL_LINES;
    return Math.max(1, Math.floor(size.rows * fraction));
  };
}

/** Collapse whitespace and trim, returning `undefined` for empty input.
 * Shared by header and errorContext so both have the same single-line shape. */
function normalizeHeaderText(text: string | undefined): string | undefined {
  if (text == null) return undefined;
  const trimmed = text.replace(/\s+/g, " ").trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/** Truncate a verbatim header to fit the terminal width with an ellipsis.
 * Visible width is measured against the ANSI-stripped string so headers
 * styled with color escapes (`colors.red(...)`) don't get cut mid-escape on
 * narrow terminals. The styled original is returned when it fits; on
 * overflow the styling is dropped along with the truncated tail (the only
 * way to keep the result fitting without parsing every CSI sequence). */
function truncateHeaderToWidth(text: string, size: ConsoleSize | undefined): string {
  const cols = size?.columns ?? 80;
  const visible = stripAnsiCodes(text);
  if (visible.length <= cols) return text;
  return visible.slice(0, Math.max(1, cols - 1)) + "…";
}

class InheritTailState {
  readonly resolveMaxLines: ResolvedMaxLinesFn;
  readonly lines: LineRingBuffer;
  readonly enabled: boolean;
  /** Per-draw callback that produces the header text. `undefined` means
   * "no header" (live tail renders no label). Percentages, raw strings and
   * user callbacks are all normalized into this single shape upstream. */
  headerFn: ResolvedHeaderFn | undefined;
  /** When true, the header is rendered verbatim instead of being framed
   * with the built-in `Running <text>` / `Ran <text>` styling. Set when
   * the user supplies a custom header string or function. */
  headerVerbatim = false;
  /** Always-present fallback shown on the error path, even if the live
   * header is hidden or customized — so error scrollback is unambiguous
   * about which command failed. */
  errorContext: string | undefined;
  promoteHeaderOnSuccess = false;
  #refCount = 0;
  #disposed = false;
  #errored = false;
  #trailingLines: string[] = [];
  #registered = false;
  #totalLinesSeen = 0;

  readonly renderer: TailRenderer;

  constructor(
    renderer: TailRenderer,
    maxLines: TailMaxLines,
    isTty: boolean,
    maxErrorLines: number = DEFAULT_INHERIT_TAIL_ERROR_LINES,
  ) {
    this.renderer = renderer;
    this.resolveMaxLines = makeMaxLinesResolver(maxLines);
    // size the ring against the construction-time resolution so the buffer
    // can fit the worst-case live tail. if the terminal grows mid-run the
    // ring caps the visible window at this size — typical use stays bounded.
    const initial = this.resolveMaxLines({ size: renderer.container.getConsoleSize() });
    this.lines = new LineRingBuffer(Math.max(initial, maxErrorLines));
    this.enabled = isTty;
  }

  get omittedLineCount(): number {
    return Math.max(0, this.#totalLinesSeen - this.lines.size);
  }

  /** Visible output rows after subtracting the header (if any) from the
   * total `maxLines` budget. Floors to 1 so a headered segment always shows
   * at least one line. */
  visibleLineCount(ctx: TailMaxLinesContext): number {
    const total = this.resolveMaxLines(ctx);
    return Math.max(1, this.headerFn != null ? total - 1 : total);
  }

  addRef(): void {
    this.#refCount++;
    if (this.enabled && !this.#registered && !this.#disposed) {
      this.renderer.register(this);
      this.#registered = true;
    }
  }

  setHeader(
    header: string | ResolvedHeaderFn | undefined,
    options?: { verbatim?: boolean },
  ): void {
    if (header == null) {
      this.headerFn = undefined;
    } else if (typeof header === "string") {
      const trimmed = normalizeHeaderText(header);
      this.headerFn = trimmed != null ? () => trimmed : undefined;
    } else {
      this.headerFn = header;
    }
    this.headerVerbatim = options?.verbatim ?? false;
    // no explicit redraw — the renderer's deferred items pick up the change
    // on the next tick.
  }

  appendLines(newLines: string[]): void {
    if (this.#disposed) return;
    this.#totalLinesSeen += newLines.length;
    for (const line of newLines) this.lines.push(line);
    // ditto: drawing is driven by the renderInterval, not per-write.
  }

  release(errored: boolean, trailing: string[]): void {
    if (this.#disposed) return;
    if (errored) this.#errored = true;
    if (trailing.length > 0) this.#trailingLines.push(...trailing);
    this.#refCount--;
    if (this.#refCount > 0) return;
    this.#disposed = true;
    if (!this.enabled) return;
    // unregister before flushAbove so this segment is gone from the live
    // tail by the time logAbove's internal refresh redraws — otherwise the
    // just-finalized command would briefly re-appear under the preserved
    // scrollback content.
    this.renderer.unregister(this);
    this.#flushAbove();
  }

  #flushAbove(): void {
    const preserved: TextItem[] = [];
    if (this.#errored) {
      // emit the raw command on error so scrollback always records which
      // command failed — in the same `> <cmd>` format the default
      // printCommand logger uses, so both renderings look uniform. prefer
      // `errorContext` (the raw command) over the live header so a custom
      // or hidden header doesn't leave error logs ambiguous; if neither is
      // set, fall back to the live header text.
      if (this.errorContext != null) {
        preserved.push(`${colors.white(">")} ${colors.blue(this.errorContext)}`);
      } else if (this.headerFn != null) {
        const headerFn = this.headerFn;
        preserved.push((size) => `${colors.white(">")} ${colors.blue(headerFn({ size }))}`);
      }
      const omitted = this.omittedLineCount;
      if (omitted > 0) {
        const noun = omitted === 1 ? "line" : "lines";
        preserved.push(indentTailLine(colors.dim(`...${omitted} ${noun} omitted...`)));
      }
      for (const line of this.lines) preserved.push(indentTailLine(line));
      for (const line of this.#trailingLines) preserved.push(indentTailLine(line));
    } else if (this.promoteHeaderOnSuccess && this.headerFn != null) {
      // success scrollback mirrors the live header style: built-in
      // `Ran <cmd>` for the default header, the user's verbatim text
      // otherwise. only promoted when the caller opted in via
      // `.printCommand()` — without that, live tail clears silently.
      const headerFn = this.headerFn;
      const verbatim = this.headerVerbatim;
      preserved.push((size) => {
        const text = headerFn({ size });
        return verbatim ? truncateHeaderToWidth(text, size) : formatRanHeader(text, size);
      });
    }
    if (preserved.length > 0) this.renderer.logAbove(preserved);
  }
}

/**
 * Docker-style partial scrolling writer.
 *
 * Instead of streaming command output straight to the terminal, this buffers
 * output line-by-line and shows only the most recent `maxLines` lines inside
 * a static text scope pinned to the bottom of the terminal. When the command
 * finishes successfully, the scope is cleared (the header is promoted to
 * scrollback); on error the retained tail is flushed above so the user can
 * see what happened.
 *
 * Falls back to writing directly to `innerWriter` when the host process is
 * not attached to a TTY, since there's nowhere to anchor a scrolling region.
 *
 * Pass an existing writer as the second argument to share its scrolling
 * region — used internally when both stdout and stderr are tailed, so the
 * two streams interleave into one scroll area with a single header.
 */
export class InheritTailWriter implements WriterSync, Disposable {
  readonly #innerWriter: WriterSync;
  readonly #state: InheritTailState;
  readonly #decoder = new TextDecoder();
  #pending = "";
  #finalized = false;

  constructor(innerWriter: WriterSync, options?: InheritTailWriterOptions);
  constructor(innerWriter: WriterSync, sibling: InheritTailWriter);
  constructor(
    innerWriter: WriterSync,
    optionsOrSibling: InheritTailWriterOptions | InheritTailWriter = {},
  ) {
    this.#innerWriter = innerWriter;
    if (optionsOrSibling instanceof InheritTailWriter) {
      this.#state = optionsOrSibling.#state;
    } else {
      const opts = optionsOrSibling;
      const renderer = opts.renderer ?? defaultTailRenderer;
      const maxLines = opts.maxLines ?? DEFAULT_INHERIT_TAIL_LINES;
      const isTty = opts.isTty ?? isStderrTty();
      const state = new InheritTailState(renderer, maxLines, isTty);
      // apply config BEFORE addRef so the segment is fully labeled by the
      // time the renderer paints — otherwise the first tick after register
      // shows a header-less segment.
      if (opts.header !== undefined) {
        state.setHeader(opts.header, { verbatim: opts.headerVerbatim });
      }
      if (opts.errorContext !== undefined) {
        state.errorContext = normalizeHeaderText(opts.errorContext);
      }
      if (opts.promoteHeaderOnSuccess !== undefined) {
        state.promoteHeaderOnSuccess = opts.promoteHeaderOnSuccess;
      }
      this.#state = state;
    }
    this.#state.addRef();
  }

  /** Snapshot of the live tail (last visible-window retained lines, oldest
   * first). The visible-window size is `maxLines - 1` when a header is shown
   * (recomputed from the current console size for percentage / callback
   * `maxLines`). */
  get tailLines(): readonly string[] {
    const size = this.#state.renderer.container.getConsoleSize();
    return Array.from(this.#state.lines.takeLast(this.#state.visibleLineCount({ size })));
  }

  /** Number of completed lines that were dropped from the retained ring
   * buffer because its capacity is bounded. Rendered as
   * `...N lines omitted...` above the retained tail when the command fails. */
  get omittedLineCount(): number {
    return this.#state.omittedLineCount;
  }

  /**
   * Sets a label rendered above the tail lines that identifies what this
   * scrolling region is showing. Accepts a literal string (collapsed to
   * a single line) or a per-draw callback that receives the current
   * `{ size }`. `undefined` removes the header. Long text is truncated to
   * the terminal width.
   *
   * When `options.verbatim` is true, the text is rendered as-is (no
   * built-in `Running` / `Ran` framing). Used by `.tailDisplay({ header })`
   * so the caller has full control over styling.
   */
  setHeader(
    header: string | ((ctx: { size: ConsoleSize | undefined }) => string) | undefined,
    options?: { verbatim?: boolean },
  ): void {
    this.#state.setHeader(header, options);
  }

  /**
   * Sets the command label preserved on the error scrollback path even
   * when the live header is hidden or customized — so `> <command>` is
   * always shown when a tailed command fails, regardless of `.tailDisplay`
   * header config.
   */
  setErrorContext(text: string | undefined): void {
    this.#state.errorContext = normalizeHeaderText(text);
  }

  /**
   * Controls whether the `Ran <command>` header is promoted to scrollback
   * on successful finalize. Defaults to `false` — on success the live tail
   * clears silently unless the caller opts in (command.ts enables it when
   * `.printCommand()` was set, so the command stays visible in scrollback).
   * The error-path header (`> <command>` + retained tail) is always emitted
   * regardless of this flag since it's diagnostic.
   */
  setPromoteHeaderOnSuccess(value: boolean): void {
    this.#state.promoteHeaderOnSuccess = value;
  }

  writeSync(p: Uint8Array): number {
    if (this.#finalized) {
      return p.length;
    }
    if (!this.#state.enabled) {
      // no TTY to anchor a scrolling region — behave like plain inherit
      return this.#innerWriter.writeSync(p);
    }
    this.#pending += this.#decoder.decode(p, { stream: true });
    const lastNewline = this.#pending.lastIndexOf("\n");
    if (lastNewline !== -1) {
      const complete = this.#pending.slice(0, lastNewline);
      this.#pending = this.#pending.slice(lastNewline + 1);
      this.#state.appendLines(complete.split("\n").map(stripTrailingCR));
    }
    return p.length;
  }

  /**
   * Clears the scrolling region. Called on successful command completion.
   *
   * If a header was set it's promoted to scrollback via `logAbove` before
   * the scope is disposed, so "which commands ran" remains visible after
   * the transient tail clears. When multiple writers share a scope the
   * scope is only disposed once all of them have finalized.
   *
   * Any partial pending line is still passed to `release` so that — if a
   * sibling writer subsequently errors — the success side's last partial
   * line is preserved in the error scrollback. The success path itself
   * never renders trailing lines, so there's no visual cost when no
   * sibling errors.
   */
  finalize(): void {
    if (this.#finalized) return;
    this.#finalized = true;
    const trailing: string[] = [];
    if (this.#pending.length > 0) {
      trailing.push(stripTrailingCR(this.#pending));
      this.#pending = "";
    }
    this.#state.release(false, trailing);
  }

  [Symbol.dispose](): void {
    this.finalize();
  }

  /**
   * Promotes the header + retained tail above the static region before
   * clearing it. Called when the command errored so the user has visible
   * context. When multiple writers share a scope, any writer finalizing
   * for error causes the shared region to use the error path once all
   * writers have finalized.
   */
  finalizeForError(): void {
    if (this.#finalized) return;
    this.#finalized = true;
    const trailing: string[] = [];
    if (this.#pending.length > 0) {
      trailing.push(stripTrailingCR(this.#pending));
      this.#pending = "";
    }
    this.#state.release(true, trailing);
  }
}

function stripTrailingCR(line: string): string {
  return line.endsWith("\r") ? line.slice(0, -1) : line;
}

function isStderrTty(): boolean {
  return Boolean((process.stderr as { isTTY?: boolean }).isTTY);
}

/**
 * Header rendered above the live tail while the command is in flight:
 * `Running <command>` in bold cyan.
 */
export function formatTailHeader(text: string, size: ConsoleSize | undefined): string {
  return renderTailHeader(text, size, "Running", colors.cyan);
}

/**
 * Past-tense header promoted to scrollback when a tailed command completes
 * successfully: `Ran <command>` in bold green.
 */
export function formatRanHeader(text: string, size: ConsoleSize | undefined): string {
  return renderTailHeader(text, size, "Ran", colors.green);
}

function renderTailHeader(
  text: string,
  size: ConsoleSize | undefined,
  status: string,
  statusColor: (s: string) => string,
): string {
  const maxColumns = size?.columns ?? 80;
  // <status> <text> — overhead is status + separating space
  const overhead = status.length + 1;
  const budget = Math.max(10, maxColumns - overhead);
  const display = text.length > budget ? text.slice(0, budget - 1) + "…" : text;
  return `${colors.bold(statusColor(status))} ${display}`;
}

export interface PipedBufferListener extends WriterSync, Closer {
  setError(err: Error): void;
}

export class PipedBuffer implements WriterSync {
  #inner: Buffer | PipedBufferListener;
  #hasSet = false;

  constructor() {
    this.#inner = new Buffer();
  }

  getBuffer(): Buffer | undefined {
    if (this.#inner instanceof Buffer) {
      return this.#inner;
    } else {
      return undefined;
    }
  }

  setError(err: Error) {
    if ("setError" in this.#inner) {
      this.#inner.setError(err);
    }
  }

  close() {
    if ("close" in this.#inner) {
      this.#inner.close();
    }
  }

  writeSync(p: Uint8Array): number {
    return this.#inner.writeSync(p);
  }

  setListener(listener: PipedBufferListener) {
    if (this.#hasSet) {
      throw new Error("Piping to multiple outputs is currently not supported.");
    }

    if (this.#inner instanceof Buffer) {
      writeAllSync(listener, this.#inner.bytes({ copy: false }));
    }

    this.#inner = listener;
    this.#hasSet = true;
  }
}

// todo: this should provide some back pressure instead of
// filling the buffer too much and the buffer size should probably
// be configurable
export class PipeSequencePipe implements Reader, WriterSync {
  #inner = new Buffer();
  #readListener: (() => void) | undefined;
  #closed = false;

  close() {
    this.#readListener?.();
    this.#closed = true;
  }

  writeSync(p: Uint8Array): number {
    const value = this.#inner.writeSync(p);
    if (this.#readListener !== undefined) {
      const listener = this.#readListener;
      this.#readListener = undefined;
      listener();
    }
    return value;
  }

  read(p: Uint8Array): Promise<number | null> {
    if (this.#readListener !== undefined) {
      // doesn't support multiple read listeners at the moment
      throw new Error("Misuse of PipeSequencePipe");
    }

    if (this.#inner.length === 0) {
      if (this.#closed) {
        return Promise.resolve(null);
      } else {
        return new Promise((resolve) => {
          this.#readListener = () => {
            resolve(this.#inner.readSync(p));
          };
        });
      }
    } else {
      return Promise.resolve(this.#inner.readSync(p));
    }
  }
}

export async function pipeReaderToWritable(
  reader: Reader,
  writable: WritableStream<Uint8Array>,
  signal: AbortSignal,
) {
  using abortedPromise = abortSignalToPromise(signal);
  const writer = writable.getWriter();
  try {
    while (!signal.aborted) {
      const buffer = new Uint8Array(1024);
      const length = await Promise.race([abortedPromise.promise, reader.read(buffer)]);
      if (length === 0 || length == null) {
        break;
      }
      await writer.write(buffer.subarray(0, length));
    }
  } finally {
    await writer.close();
  }
}

export async function pipeReadableToWriterSync(
  readable: ReadableStream<Uint8Array>,
  writer: ShellPipeWriter | CommandPipeWriter,
  signal: AbortSignal | KillSignal,
) {
  const reader = readable.getReader();
  while (!signal.aborted) {
    const result = await reader.read();
    if (result.done) {
      break;
    }
    const maybePromise = writer.writeAll(result.value);
    if (maybePromise) {
      await maybePromise;
    }
  }
}
