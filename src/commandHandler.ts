import type { KillSignal } from "./command.ts";
import type { Reader, ShellPipeWriterKind } from "./pipes.ts";
import type { ExecuteResult } from "./result.ts";
import type { ShellOptionsState } from "./shell.ts";

/** Used to read from stdin. */
export type CommandPipeReader = "inherit" | "null" | Reader;

/** Used to write to stdout or stderr. */
export interface CommandPipeWriter {
  /** The configured shell pipe writer kind backing this writer. */
  kind: ShellPipeWriterKind;
  /** Writes a chunk of bytes, returning the number of bytes written. */
  write(p: Uint8Array): Promise<number> | number;
  /** Writes all of the provided bytes to the underlying pipe. */
  writeAll(p: Uint8Array): Promise<void> | void;
  /** Encodes the provided text as UTF-8 and writes it to the underlying pipe. */
  writeText(text: string): Promise<void> | void;
  /** Encodes the provided text as UTF-8 and writes it followed by `\n`. */
  writeLine(text: string): Promise<void> | void;
}

/** Context of the currently executing command. */
export interface CommandContext {
  /** Arguments passed to the command (excluding the command name). */
  get args(): string[];
  /** Current working directory for the command. */
  get cwd(): string;
  /** Environment variables visible to the command. */
  get env(): Record<string, string>;
  /** The command's stdin reader. */
  get stdin(): CommandPipeReader;
  /** The command's stdout writer. */
  get stdout(): CommandPipeWriter;
  /** The command's stderr writer. */
  get stderr(): CommandPipeWriter;
  /** Kill signal that aborts when the command is cancelled. */
  get signal(): KillSignal;
  /** Current shell options (nullglob, failglob, pipefail, globstar). */
  get shellOptions(): ShellOptionsState;
  /** Helper function for writing a line to stderr and returning a 1 exit code. */
  error(message: string): Promise<ExecuteResult> | ExecuteResult;
  /** Helper function for writing a line to stderr and returning the provided exit code. */
  error(code: number, message: string): Promise<ExecuteResult> | ExecuteResult;
}

/** Handler for executing a command. */
export type CommandHandler = (context: CommandContext) => Promise<ExecuteResult> | ExecuteResult;
