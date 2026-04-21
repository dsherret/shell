export {
  CommandBuilder,
  CommandChild,
  CommandResult,
  escapeArg,
  KillController,
  KillSignal,
  type KillSignalListener,
  RawArg,
  rawArg,
  type TemplateExpr,
} from "./src/command.ts";
export type { CommandContext, CommandHandler, CommandPipeReader, CommandPipeWriter } from "./src/command_handler.ts";
export {
  type AwaitableReadable,
  type Closer,
  type Reader,
  type ShellPipeReaderKind,
  type ShellPipeWriterKind,
  type WriterSync,
} from "./src/pipes.ts";
export {
  type CdChange,
  type ContinueExecuteResult,
  type EnvChange,
  type ExecuteResult,
  type ExitExecuteResult,
  type SetEnvVarChange,
  type SetOptionChange,
  type SetShellVarChange,
  type ShellOption,
  type UnsetVarChange,
} from "./src/result.ts";
export { type ShellOptionsState, WhichEnv, whichRealEnv } from "./src/shell.ts";
export { createExecutableCommand } from "./src/commands/executable.ts";
export { type Stderr, stderr, type Stdin, stdin, type Stdout, stdout } from "./src/streams.ts";
export { $, type $Base, type $Type, build$, type Create$Options } from "./src/dollar.ts";

import { $ } from "./src/dollar.ts";
export default $;
export { create, FsFile, open, type OpenOptions, type WriteFileOptions } from "./src/fs_file.ts";
export type { Signal } from "./src/signal.ts";
export { type Delay, delayToMs } from "./src/common.ts";
