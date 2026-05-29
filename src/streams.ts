import { writeSyncAll } from "./fsFile.ts";

/** Process-level stdin abstraction. */
export interface Stdin {
  /** Reads up to `p.length` bytes into `p`, returning the number of bytes
   * read or `null` on EOF. When `signal` is provided and aborts before a
   * read completes, the returned promise rejects with `signal.reason` and
   * any bytes that arrive afterwards stay buffered for the next `read`. */
  read(p: Uint8Array, options?: { signal?: AbortSignal }): Promise<number | null>;
  /** A `ReadableStream` view of stdin, backed by {@link read} so it shares
   * the same fd without locking it. Cached so repeated access shares the
   * same stream until it is cancelled. */
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

function getStdinReadable(): ReadableStream<Uint8Array> {
  if (cachedStdinReadable !== undefined) return cachedStdinReadable;
  // Build the stream on top of `read` rather than `Readable.toWeb`, which
  // would permanently lock the fd to a web-stream adapter. Each pull reads in
  // paused mode and detaches, so accessing `.readable` then reading stdin
  // directly later still works. Cached so repeated access shares one stream.
  const abortController = new AbortController();
  return cachedStdinReadable = new ReadableStream<Uint8Array>({
    async pull(controller) {
      const buf = new Uint8Array(16 * 1024);
      let bytesRead: number | null;
      try {
        bytesRead = await readStdin(buf, abortController.signal);
      } catch (err) {
        if (abortController.signal.aborted) return; // cancelled
        throw err;
      }
      if (bytesRead === null) controller.close();
      else controller.enqueue(buf.subarray(0, bytesRead));
    },
    cancel() {
      abortController.abort();
      cachedStdinReadable = undefined;
    },
  });
}

/** Default {@link Stdin} bound to the host process's stdin fd. */
export const stdin: Stdin = {
  read(p: Uint8Array, options?: { signal?: AbortSignal }): Promise<number | null> {
    const signal = options?.signal;
    signal?.throwIfAborted();
    return readStdin(p, signal);
  },
  // todo: remove this as it's unused
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

// reads directly from the `process.stdin` Node stream in paused mode rather
// than `Readable.toWeb`, which permanently locks the fd to a web-stream
// adapter and never releases it. Listening for a single `readable` event and
// detaching afterwards leaves stdin in a clean, handoff-able state — so a
// later reader (including one outside dax) still works — while remaining
// abortable: aborting just removes the listener, with no read syscall left
// outstanding to steal a byte.
function readStdin(p: Uint8Array, signal?: AbortSignal): Promise<number | null> {
  const stream = process.stdin;
  return new Promise<number | null>((resolve, reject) => {
    const onReadable = () => {
      const chunk = stream.read() as Uint8Array | null;
      if (chunk === null) return; // nothing buffered yet; wait for the next event
      cleanup();
      const len = Math.min(chunk.length, p.length);
      p.set(chunk.subarray(0, len));
      // put any bytes we didn't consume back into the stream rather than a
      // private buffer, so the next reader — including one outside dax —
      // still sees them.
      if (chunk.length > len) stream.unshift(chunk.subarray(len));
      resolve(len);
    };
    const onEnd = () => {
      cleanup();
      resolve(null);
    };
    const onError = (err: Error) => {
      cleanup();
      reject(err);
    };
    const onAbort = () => {
      cleanup();
      reject(signal!.reason);
    };
    const cleanup = () => {
      stream.off("readable", onReadable);
      stream.off("end", onEnd);
      stream.off("error", onError);
      signal?.removeEventListener("abort", onAbort);
    };

    stream.on("readable", onReadable);
    stream.on("end", onEnd);
    stream.on("error", onError);
    signal?.addEventListener("abort", onAbort, { once: true });
    // data may already be buffered, so attempt a read right away.
    onReadable();
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
