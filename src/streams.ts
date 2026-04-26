import * as fs from "node:fs";
import { Readable } from "node:stream";
import { writeSyncAll } from "./fsFile.ts";

/** Process-level stdin abstraction. */
export interface Stdin {
  /** Reads up to `p.length` bytes into `p`, returning the number of bytes
   * read or `null` on EOF. */
  read(p: Uint8Array): Promise<number | null>;
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

/** Default {@link Stdin} bound to the host process's stdin fd. */
export const stdin: Stdin = {
  read(p: Uint8Array): Promise<number | null> {
    return new Promise((resolve, reject) => {
      fs.read(0, p, 0, p.length, null, (err, bytesRead) => {
        if (err) reject(err);
        else resolve(bytesRead === 0 ? null : bytesRead);
      });
    });
  },
  get readable(): ReadableStream<Uint8Array> {
    // wrapping process.stdin locks it to one consumer; cache so repeated
    // access shares the same stream rather than fighting over the same fd.
    return cachedStdinReadable ??= Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>;
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

/** Default {@link Stderr} bound to the host process's stderr fd. */
export const stderr: Stderr = {
  writeSync(p: Uint8Array): number {
    return writeSyncAll(2, p);
  },
  isTerminal(): boolean {
    return process.stderr.isTTY ?? false;
  },
};
