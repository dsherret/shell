export {
  type BeforeCommandCallback,
  type BeforeCommandSyncCallback,
  CommandBuilder,
  CommandChild,
  CommandResult,
  escapeArg,
  KillController,
  KillSignal,
  type KillSignalListener,
  type NonRedirectTemplateExpr,
  RawArg,
  rawArg,
  ShellError,
  type StreamKind,
  type TemplateExpr,
} from "./src/command.ts";
export type { CommandContext, CommandHandler, CommandPipeReader, CommandPipeWriter } from "./src/commandHandler.ts";
export {
  type AwaitableReadable,
  type Closer,
  type ErrorTailOptions,
  type Reader,
  type ShellPipeReaderKind,
  type ShellPipeWriterKind,
  type TailDisplayOptions,
  type TailHeader,
  type TailHeaderContext,
  type TailMaxLines,
  type TailMaxLinesContext,
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
export { createExecutableCommand, type CreateExecutableCommandOptions } from "./src/commands/executable.ts";
export { type Stderr, stderr, type Stdin, stdin, type Stdout, stdout } from "./src/streams.ts";
export { $, type $Base, type $Type, build$, type Create$Options } from "./src/dollar.ts";

import { $ } from "./src/dollar.ts";
export default $;
export { create, FsFile, open, type OpenOptions, type WriteFileOptions } from "./src/fsFile.ts";
export type { Signal } from "./src/signal.ts";
export { type Delay, delayToMs } from "./src/common.ts";
export type { ConsoleSize } from "@david/console-static-text";
export { FsFileWrapper, Path } from "@david/path";
