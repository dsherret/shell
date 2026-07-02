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
  const child = isWindowsBatch
    ? cp.spawn(
      "cmd.exe",
      // cmd.exe's own argument parsing does not follow the usual
      // CommandLineToArgvW convention that Node's default (non-verbatim)
      // escaping assumes, so passing `path`/`args` as separate argv
      // elements (relying on Node to quote them) corrupts any element
      // containing a space - e.g. the default Node.js install path,
      // "C:\Program Files\nodejs\npx.cmd". Node's own `{ shell: true }`
      // handling for cmd.exe works around this the same way: join into a
      // single command string, quote each piece, wrap the whole thing in
      // one more pair of quotes, and mark it `windowsVerbatimArguments` so
      // Node passes that string through untouched.
      ["/d", "/s", "/c", `"${[path, ...options.args].map(escapeCmdArg).join(" ")}"`],
      {
        cwd: options.cwd,
        env: options.env,
        windowsVerbatimArguments: true,
        stdio: [
          toNodeStdio(options.stdin),
          toNodeStdio(options.stdout),
          toNodeStdio(options.stderr),
        ],
      },
    )
    : cp.spawn(
      path,
      options.args,
      {
        cwd: options.cwd,
        env: options.env,
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

/**
 * Quotes a single argument for inclusion in a `cmd.exe /c "..."` command
 * line, following the `CommandLineToArgvW` convention that Windows programs
 * (including `cmd.exe`'s own re-parsing of its `/c` argument once the outer
 * quotes are stripped) expect: wrap in `"`, double any embedded `"`, and
 * escape a run of `\` only when it immediately precedes a `"` (an unescaped
 * trailing `\` right before the closing quote would otherwise escape that
 * quote instead of terminating the argument).
 */
export function escapeCmdArg(arg: string): string {
  if (arg.length > 0 && !/[\s"]/.test(arg)) {
    return arg;
  }
  const escaped = arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, "$1$1");
  return `"${escaped}"`;
}
