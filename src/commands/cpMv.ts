import * as fs from "node:fs";
import * as path from "node:path";
import type { CommandContext } from "../commandHandler.ts";
import { errorToString, resolvePath, safeLstat } from "../common.ts";
import type { ExecuteResult } from "../result.ts";
import { bailUnsupported, parseArgKinds } from "./args.ts";

export async function cpCommand(
  context: CommandContext,
): Promise<ExecuteResult> {
  try {
    await executeCp(context.cwd, context.args);
    return { code: 0 };
  } catch (err) {
    return context.error(`cp: ${errorToString(err)}`);
  }
}

interface PathWithSpecified {
  path: string;
  specified: string;
}

interface CopyFlags {
  recursive: boolean;
  operations: { from: PathWithSpecified; to: PathWithSpecified }[];
}

async function executeCp(cwd: string, args: string[]) {
  const flags = await parseCpArgs(cwd, args);
  for (const { from, to } of flags.operations) {
    await doCopyOperation(flags, from, to);
  }
}

export async function parseCpArgs(cwd: string, args: string[]): Promise<CopyFlags> {
  const paths = [];
  let recursive = false;
  for (const arg of parseArgKinds(args)) {
    if (arg.kind === "Arg") paths.push(arg.arg);
    else if (
      (arg.arg === "recursive" && arg.kind === "LongFlag")
      || (arg.arg === "r" && arg.kind == "ShortFlag")
      || (arg.arg === "R" && arg.kind === "ShortFlag")
    ) {
      recursive = true;
    } else bailUnsupported(arg);
  }
  if (paths.length === 0) throw Error("missing file operand");
  else if (paths.length === 1) throw Error(`missing destination file operand after '${paths[0]}'`);

  for (const from of paths.slice(0, -1)) {
    const basename = path.basename(from);
    // a trailing `..` would resolve the target to the destination's
    // parent directory, so refuse it like the guard in mv
    if (basename === "..") {
      throw Error(`cannot copy '${from}': refusing to copy '..'`);
    } else if (basename === "") {
      // an empty final component means the source is the root (ex. `/`),
      // which has no name to place inside the destination
      throw Error(`cannot copy '${from}': the source has no final path component`);
    }
  }
  return { recursive, operations: await getCopyAndMoveOperations(cwd, paths) };
}

async function doCopyOperation(
  flags: CopyFlags,
  from: PathWithSpecified,
  to: PathWithSpecified,
) {
  if (from.path === to.path) {
    // copying to the same path truncates the source's files
    throw Error(`'${from.specified}' and '${to.specified}' are the same file`);
  }
  // These are racy with the file system, but that's ok.
  // They only exists to give better error messages.
  const fromInfo = await safeLstat(from.path);
  if (fromInfo?.isDirectory()) {
    if (flags.recursive) {
      const toInfo = await safeLstat(to.path);
      if (toInfo?.isFile()) {
        throw Error("destination was a file");
      } else if (toInfo?.isSymbolicLink()) {
        throw Error("no support for copying to symlinks");
      } else if (fromInfo.isSymbolicLink()) {
        throw Error("no support for copying from symlinks");
      } else {
        // verbatimSymlinks matches GNU cp -r, which preserves a symlink's
        // target as written instead of resolving relative targets to
        // absolute paths pointing back into the source directory
        await fs.promises.cp(from.path, to.path, { recursive: true, verbatimSymlinks: true });
      }
    } else {
      throw Error("source was a directory; maybe specify -r");
    }
  } else {
    await fs.promises.copyFile(from.path, to.path);
  }
}

export async function mvCommand(
  context: CommandContext,
): Promise<ExecuteResult> {
  try {
    await executeMove(context.cwd, context.args);
    return { code: 0 };
  } catch (err) {
    return context.error(`mv: ${errorToString(err)}`);
  }
}

interface MoveFlags {
  operations: { from: PathWithSpecified; to: PathWithSpecified }[];
}

async function executeMove(cwd: string, args: string[]) {
  const flags = await parseMvArgs(cwd, args);
  for (const { from, to } of flags.operations) {
    await fs.promises.rename(from.path, to.path);
  }
}

export async function parseMvArgs(cwd: string, args: string[]): Promise<MoveFlags> {
  const paths = [];

  for (const arg of parseArgKinds(args)) {
    if (arg.kind === "Arg") paths.push(arg.arg);
    else bailUnsupported(arg);
  }

  if (paths.length === 0) throw Error("missing operand");
  else if (paths.length === 1) throw Error(`missing destination file operand after '${paths[0]}'`);

  for (const from of paths.slice(0, -1)) {
    const basename = path.basename(from);
    // matches GNU mv, which errors renaming these (ex. `mv public/. dist`)
    if (basename === "." || basename === "..") {
      throw Error(`cannot move '${from}': refusing to move '.' or '..'`);
    } else if (basename === "") {
      // an empty final component means the source is the root (ex. `/`),
      // which has no name to place inside the destination
      throw Error(`cannot move '${from}': the source has no final path component`);
    }
  }
  return { operations: await getCopyAndMoveOperations(cwd, paths) };
}

async function getCopyAndMoveOperations(
  cwd: string,
  paths: string[],
) {
  // copy and move share the same logic
  const specified_destination = paths.splice(paths.length - 1, 1)[0];
  const destination = resolvePath(cwd, specified_destination);
  const fromArgs = paths;
  const operations = [];
  if (fromArgs.length > 1) {
    if (!await safeLstat(destination).then((p) => p?.isDirectory())) {
      throw Error(`target '${specified_destination}' is not a directory`);
    }
    for (const from of fromArgs) {
      const fromPath = resolvePath(cwd, from);
      const toPath = calculateDestinationPath(destination, from);
      operations.push(
        {
          from: {
            specified: from,
            path: fromPath,
          },
          to: {
            specified: specified_destination,
            path: toPath,
          },
        },
      );
    }
  } else {
    const fromPath = resolvePath(cwd, fromArgs[0]);

    const toPath = await safeLstat(destination).then((p) => p?.isDirectory())
      ? calculateDestinationPath(destination, fromArgs[0])
      : destination;

    operations.push({
      from: {
        specified: fromArgs[0],
        path: fromPath,
      },
      to: {
        specified: specified_destination,
        path: toPath,
      },
    });
  }
  return operations;
}

/**  Calculates destination path
 * destination should be a directory and from should be
 * the path as specified on the command line
 * example:
 *          destination: /dir/a
 *          from       : /path/file
 *          returns    : /dir/a/file
 *
 * The basename is taken from the path as specified rather than
 * the resolved path so that a trailing `.` resolves to the
 * destination itself like GNU cp (ex. `cp -r public/. dist`
 * copies the contents of `public` into `dist`).
 *
 * Sources with no final path component (a trailing `..` or the
 * root) are refused by both cp and mv before getting here, so
 * the basename is never empty.
 */
function calculateDestinationPath(destination: string, from: string) {
  return path.join(destination, path.basename(from));
}
