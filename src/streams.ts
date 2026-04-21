import * as fs from "node:fs";
import { Readable } from "node:stream";
import { writeSyncAll } from "./fs_file.ts";

export interface Stdin {
  read(p: Uint8Array): Promise<number | null>;
  readonly readable: ReadableStream<Uint8Array>;
  setRaw(mode: boolean): void;
  isTerminal(): boolean;
}

export interface Stdout {
  writeSync(p: Uint8Array): number;
  isTerminal(): boolean;
}

export type Stderr = Stdout;

let cachedStdinReadable: ReadableStream<Uint8Array> | undefined;

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

export const stdout: Stdout = {
  writeSync(p: Uint8Array): number {
    return writeSyncAll(1, p);
  },
  isTerminal(): boolean {
    return process.stdout.isTTY ?? false;
  },
};

export const stderr: Stderr = {
  writeSync(p: Uint8Array): number {
    return writeSyncAll(2, p);
  },
  isTerminal(): boolean {
    return process.stderr.isTTY ?? false;
  },
};
