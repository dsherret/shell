import { Readable } from "node:stream";
import { writeSyncAll } from "./fsFile.ts";

/** Process-level stdin abstraction. */
export interface Stdin {
  /** Reads up to `p.length` bytes into `p`, returning the number of bytes
   * read or `null` on EOF. When `signal` is provided and aborts before a
   * read completes, the returned promise rejects with `signal.reason` and
   * any bytes that arrive afterwards stay buffered for the next `read`. */
  read(p: Uint8Array, options?: { signal?: AbortSignal }): Promise<number | null>;
  /** A `ReadableStream` view of stdin. Cached so repeated access shares
   * the same stream rather than competing for the underlying fd. */
  readonly readable: ReadableStream<Uint8Array>;
  /** Toggles raw mode on stdin when it is attached to a TTY. */
  setRaw(mode: boolean): void;
  /** Returns whether stdin is attached to a TTY. */
  isTerminal(): boolean;
}

/** Process-level stdout/stderr abstraction. */
export interface Stdout {
  /** Synchronously writes the provided bytes, returning how many were written. */
  writeSync(p: Uint8Array): number;
  /** Returns whether the stream is attached to a TTY. */
  isTerminal(): boolean;
}

/** Process-level stderr abstraction. Same shape as {@link Stdout}. */
export type Stderr = Stdout;

let cachedStdinReadable: ReadableStream<Uint8Array> | undefined;
let cachedStdinReader: ReadableStreamDefaultReader<Uint8Array> | undefined;
let pendingStdinRead: Promise<ReadableStreamReadResult<Uint8Array>> | undefined;
let stdinLeftover: Uint8Array | undefined;

function getStdinReadable(): ReadableStream<Uint8Array> {
  // wrapping process.stdin locks it to one consumer; cache so repeated
  // access shares the same stream rather than fighting over the same fd.
  return cachedStdinReadable ??= Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>;
}

/** Default {@link Stdin} bound to the host process's stdin fd. */
export const stdin: Stdin = {
  async read(p: Uint8Array, options?: { signal?: AbortSignal }): Promise<number | null> {
    const signal = options?.signal;
    signal?.throwIfAborted();

    if (stdinLeftover === undefined) {
      cachedStdinReader ??= getStdinReadable().getReader();
      // share a single in-flight read across callers so an aborted read
      // doesn't drop bytes — the next call awaits the same promise.
      pendingStdinRead ??= cachedStdinReader.read();
      const result = await (signal ? raceAbort(pendingStdinRead, signal) : pendingStdinRead);
      pendingStdinRead = undefined;
      if (result.done) return null;
      stdinLeftover = result.value;
    }

    const len = Math.min(stdinLeftover.length, p.length);
    p.set(stdinLeftover.subarray(0, len));
    stdinLeftover = stdinLeftover.length > len ? stdinLeftover.subarray(len) : undefined;
    return len;
  },
  get readable(): ReadableStream<Uint8Array> {
    return getStdinReadable();
  },
  setRaw(mode: boolean): void {
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(mode);
    }
  },
  isTerminal(): boolean {
    return process.stdin.isTTY ?? false;
  },
};

/** Default {@link Stdout} bound to the host process's stdout fd. */
export const stdout: Stdout = {
  writeSync(p: Uint8Array): number {
    return writeSyncAll(1, p);
  },
  isTerminal(): boolean {
    return process.stdout.isTTY ?? false;
  },
};

function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (v) => {
        signal.removeEventListener("abort", onAbort);
        resolve(v);
      },
      (e) => {
        signal.removeEventListener("abort", onAbort);
        reject(e);
      },
    );
  });
}

/** Default {@link Stderr} bound to the host process's stderr fd. */
export const stderr: Stderr = {
  writeSync(p: Uint8Array): number {
    return writeSyncAll(2, p);
  },
  isTerminal(): boolean {
    return process.stderr.isTTY ?? false;
  },
};
