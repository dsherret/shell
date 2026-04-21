import type { Path } from "@david/path";
import { createTempDirSync } from "@david/temp";
import {
  CommandBuilder,
  rawArg,
  setCommandTextStateSymbol,
  template,
  type TemplateExpr,
  templateRaw,
} from "../command.ts";

export interface Test$ {
  (strings: TemplateStringsArray, ...exprs: TemplateExpr[]): CommandBuilder;
  raw(strings: TemplateStringsArray, ...exprs: TemplateExpr[]): CommandBuilder;
  rawArg: typeof rawArg;
}

/**
 * Builds a `$`-style template tag backed by the given `CommandBuilder`.
 * Test-only helper — mirrors what `@david/dax`'s `$` does, minus all the
 * logging/progress/extras plumbing.
 */
export function mk$(commandBuilder: CommandBuilder = new CommandBuilder()): Test$ {
  const fn = ((strings: TemplateStringsArray, ...exprs: TemplateExpr[]) => {
    return commandBuilder[setCommandTextStateSymbol](template(strings, exprs));
  }) as Test$;
  fn.raw = (strings, ...exprs) => {
    return commandBuilder[setCommandTextStateSymbol](templateRaw(strings, exprs));
  };
  fn.rawArg = rawArg;
  return fn;
}

export const $: Test$ = mk$();

/**
 * Creates a temporary directory, chdirs into it, runs the action, then
 * restores cwd and deletes the directory.
 */
export async function withTempDir(action: (path: Path) => Promise<void> | void): Promise<void> {
  await using tempDir = usingTempDir();
  await action(tempDir);
}

/**
 * Creates a temporary directory, chdirs into it, and returns an
 * `AsyncDisposable` that restores cwd and removes the directory when
 * disposed.
 */
export function usingTempDir(): Path & AsyncDisposable {
  const originalCwd = process.cwd();
  const handle = createTempDirSync();
  process.chdir(handle.path.toString());
  const pathRef = handle.path;
  (pathRef as Path & AsyncDisposable)[Symbol.asyncDispose] = async () => {
    // restore cwd first — on Windows, rm-ing the current cwd fails with EBUSY/EPERM
    process.chdir(originalCwd);
    await handle[Symbol.asyncDispose]();
  };
  return pathRef as Path & AsyncDisposable;
}

export async function getStdErr(cmd: CommandBuilder): Promise<string> {
  const result = await cmd.noThrow().stderr("piped");
  return result.stderr;
}

export function ensurePromiseNotResolved(promise: Promise<unknown>): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    promise.then(() => reject(new Error("Promise was resolved")));
    setTimeout(resolve, 1);
  });
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
