import * as cp from "node:child_process";
import { Readable, Writable } from "node:stream";
import { getSignalAbortCode } from "./command.ts";
import { isWindows } from "./common.ts";
import type { Signal } from "./signal.ts";

export interface SpawnCommandOptions {
  args: string[];
  cwd: string;
  /** The complete environment for the child — Node's `cp.spawn` does not
   * merge with `process.env` when this is passed. */
  env: Record<string, string>;
  stdin: "inherit" | "null" | "piped";
  stdout: "inherit" | "null" | "piped";
  stderr: "inherit" | "null" | "piped";
}

export interface SpawnedChildProcess {
  stdin(): WritableStream;
  stdout(): ReadableStream;
  stderr(): ReadableStream;
  kill(signo?: Signal): void;
  waitExitCode(): Promise<number>;
}

export function spawnCommand(path: string, options: SpawnCommandOptions): SpawnedChildProcess {
  let receivedSignal: Signal | undefined;
  // launching bat or cmd files in Node.js will error, so launch
  // via cmd.exe instead https://nodejs.org/en/blog/vulnerability/april-2024-security-releases-2
  const isWindowsBatch = isWindows && /\.(cmd|bat)$/i.test(path);
  const child = cp.spawn(
    isWindowsBatch ? "cmd.exe" : path,
    isWindowsBatch ? getWindowsBatchArgs(path, options.args) : options.args,
    {
      cwd: options.cwd,
      env: options.env,
      // cmd.exe parses its command line differently than the
      // `CommandLineToArgvW` convention that Node's default escaping assumes, so
      // escape the arguments ourselves (see `getWindowsBatchArgs`) and tell Node
      // to pass them through verbatim. Without this, a `.cmd`/`.bat` path or
      // argument containing a space is split by cmd.exe.
      windowsVerbatimArguments: isWindowsBatch,
      stdio: [
        toNodeStdio(options.stdin),
        toNodeStdio(options.stdout),
        toNodeStdio(options.stderr),
      ],
    },
  );
  const exitResolvers = Promise.withResolvers<number>();
  child.on("exit", (code) => {
    if (code == null && receivedSignal != null) {
      exitResolvers.resolve(getSignalAbortCode(receivedSignal) ?? 1);
    } else {
      exitResolvers.resolve(code ?? 0);
    }
  });
  child.on("error", (err) => {
    exitResolvers.reject(err);
  });
  return {
    stdin() {
      return Writable.toWeb(child.stdin!);
    },
    kill(signo?: Signal) {
      receivedSignal = signo;
      child.kill(signo as any);
    },
    waitExitCode() {
      return exitResolvers.promise;
    },
    stdout() {
      return Readable.toWeb(child.stdout!) as ReadableStream;
    },
    stderr() {
      return Readable.toWeb(child.stderr!) as ReadableStream;
    },
  };
}

// Builds the `cmd.exe` arguments for launching a Windows batch (.cmd/.bat)
// file, escaping the file path and arguments for cmd.exe's parser. This mirrors
// the approach used by https://github.com/moxystudio/node-cross-spawn to work
// around https://github.com/nodejs/node/issues/7367 — most notably a path or
// argument that contains a space.
function getWindowsBatchArgs(path: string, args: string[]): string[] {
  // a cmd-shim (ex. `node_modules/.bin/*.cmd`) proxies through Node.js, which
  // re-interprets the arguments, so its meta characters need escaping twice
  const doubleEscapeMetaChars = /node_modules[\\/]\.bin[\\/][^\\/]+\.cmd$/i.test(path);
  const command = [
    escapeCmdCommand(path),
    ...args.map((arg) => escapeCmdArgument(arg, doubleEscapeMetaChars)),
  ].join(" ");
  // `/s` forces cmd.exe to strip the outer quotes around the whole command
  return ["/d", "/s", "/c", `"${command}"`];
}

// see http://www.robvanderwoude.com/escapechars.php
const cmdMetaCharsRegex = /([()\][%!^"`<>&|;, *?])/g;

function escapeCmdCommand(arg: string): string {
  return arg.replace(cmdMetaCharsRegex, "^$1");
}

function escapeCmdArgument(arg: string, doubleEscapeMetaChars: boolean): string {
  // algorithm based on https://qntm.org/cmd

  // a run of backslashes followed by a double quote: double up the backslashes
  // and escape the quote
  arg = arg.replace(/(?=(\\+?)?)\1"/g, '$1$1\\"');
  // a run of backslashes at the end of the string: double them up because they
  // will precede the closing quote added below
  arg = arg.replace(/(?=(\\+?)?)\1$/, "$1$1");
  // quote the whole argument
  arg = `"${arg}"`;
  // escape meta chars
  arg = arg.replace(cmdMetaCharsRegex, "^$1");
  if (doubleEscapeMetaChars) {
    arg = arg.replace(cmdMetaCharsRegex, "^$1");
  }
  return arg;
}

function toNodeStdio(stdio: "inherit" | "null" | "piped") {
  switch (stdio) {
    case "inherit":
      return "inherit";
    case "null":
      return "ignore";
    case "piped":
      return "pipe";
  }
}
