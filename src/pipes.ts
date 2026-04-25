import type { FsFileWrapper, Path } from "@david/path";
import {
  type ConsoleSize,
  type RenderInterval,
  renderInterval,
  staticText,
  type StaticTextContainer,
  type StaticTextScope,
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
    for (const seg of this.#segments) {
      // headers used to be emitted as `(size) => formatTailHeader(...)`
      // closures so they could re-fit on console-size changes — but the
      // deferred item we register on the scope already runs per draw, so
      // we compute the header string inline here and skip a closure per
      // segment per tick.
      if (seg.header != null) items.push(formatTailHeader(seg.header, size));
      for (const line of seg.lines.takeLast(seg.maxLines)) items.push(indentTailLine(line));
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

class InheritTailState {
  readonly maxLines: number;
  readonly lines: LineRingBuffer;
  readonly enabled: boolean;
  header: string | undefined;
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
    maxLines: number,
    isTty: boolean,
    maxErrorLines: number = DEFAULT_INHERIT_TAIL_ERROR_LINES,
  ) {
    this.renderer = renderer;
    this.maxLines = Math.max(1, maxLines);
    // one ring sized to the larger error budget; the live tail is just the
    // last `maxLines` slice of it, so no separate small buffer needed.
    this.lines = new LineRingBuffer(Math.max(this.maxLines, maxErrorLines));
    this.enabled = isTty;
  }

  get omittedLineCount(): number {
    return Math.max(0, this.#totalLinesSeen - this.lines.size);
  }

  addRef(): void {
    this.#refCount++;
    if (this.enabled && !this.#registered && !this.#disposed) {
      this.renderer.register(this);
      this.#registered = true;
    }
  }

  setHeader(text: string | undefined): void {
    const trimmed = text == null ? undefined : text.replace(/\s+/g, " ").trim();
    this.header = trimmed && trimmed.length > 0 ? trimmed : undefined;
    // no explicit redraw — the renderer's deferred items pick up the new
    // header on the next tick.
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
      // emit the command header unconditionally on error so the scrollback
      // always records which command failed (even if `.printCommand()` was
      // off), in the same `> <cmd>` format the default printCommand logger
      // uses so both renderings look uniform.
      if (this.header != null) {
        preserved.push(`${colors.white(">")} ${colors.blue(this.header)}`);
      }
      const omitted = this.omittedLineCount;
      if (omitted > 0) {
        const noun = omitted === 1 ? "line" : "lines";
        preserved.push(indentTailLine(colors.dim(`...${omitted} ${noun} omitted...`)));
      }
      for (const line of this.lines) preserved.push(indentTailLine(line));
      for (const line of this.#trailingLines) preserved.push(indentTailLine(line));
    } else if (this.promoteHeaderOnSuccess && this.header != null) {
      // `Ran <cmd>` on success mirrors what `.printCommand()` would print
      // upfront, so only promote it when the caller asked for the command
      // to be visible in the host's scrollback. Without that opt-in, the
      // live tail clears silently.
      const header = this.header;
      preserved.push((size) => formatRanHeader(header, size));
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

  constructor(innerWriter: WriterSync, maxLines?: number, isTty?: boolean, renderer?: TailRenderer);
  constructor(innerWriter: WriterSync, sibling: InheritTailWriter);
  constructor(
    innerWriter: WriterSync,
    maxLinesOrSibling: number | InheritTailWriter = DEFAULT_INHERIT_TAIL_LINES,
    isTty: boolean = isStderrTty(),
    renderer: TailRenderer = defaultTailRenderer,
  ) {
    this.#innerWriter = innerWriter;
    if (typeof maxLinesOrSibling === "number") {
      this.#state = new InheritTailState(renderer, maxLinesOrSibling, isTty);
    } else {
      this.#state = maxLinesOrSibling.#state;
    }
    this.#state.addRef();
  }

  /** Snapshot of the live tail (last `maxLines` retained lines, oldest
   * first). */
  get tailLines(): readonly string[] {
    return Array.from(this.#state.lines.takeLast(this.#state.maxLines));
  }

  /** Number of completed lines that were dropped from the retained ring
   * buffer because its capacity is bounded. Rendered as
   * `...N lines omitted...` above the retained tail when the command fails. */
  get omittedLineCount(): number {
    return this.#state.omittedLineCount;
  }

  /**
   * Sets a label rendered above the tail lines that identifies what this
   * scrolling region is showing. Typically the command text. Empty/undefined
   * removes the header. Long text is truncated to the terminal width.
   */
  setHeader(text: string | undefined): void {
    this.#state.setHeader(text);
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
   */
  finalize(): void {
    if (this.#finalized) return;
    this.#finalized = true;
    this.#state.release(false, []);
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
