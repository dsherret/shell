import {
  CommandBuilder,
  escapeArg,
  type RawArg,
  rawArg,
  setCommandTextStateSymbol,
  template,
  type TemplateExpr,
  templateRaw,
} from "./command.ts";
import { TreeBox } from "./common.ts";

/** @internal */
export type ExtrasObject = Record<string, (...args: any[]) => unknown>;

/** Options for creating a custom `$`. */
export interface Create$Options<TExtras extends ExtrasObject> {
  /** Uses this command builder (or the result of the function applied to
   * the parent's builder) as the starting point. */
  commandBuilder?: CommandBuilder | ((builder: CommandBuilder) => CommandBuilder);
  /** Extra properties to attach to the resulting `$`. */
  extras?: TExtras;
}

/** Callable/helper surface of a `$` produced by `build$`. */
export interface $Base<TExtras extends ExtrasObject> {
  (strings: TemplateStringsArray, ...exprs: TemplateExpr[]): CommandBuilder;
  /** Same as the main tag, but arguments are not escaped. */
  raw(strings: TemplateStringsArray, ...exprs: TemplateExpr[]): CommandBuilder;
  /** Wraps a value so it passes through template interpolation unescaped. */
  rawArg<T>(arg: T): RawArg<T>;
  /** Escapes a string so it can be safely interpolated as a command arg. */
  escapeArg(arg: string): string;
  /** Creates a new `$` derived from this one's state. */
  build$<TNewExtras extends ExtrasObject = {}>(
    opts?: Create$Options<TNewExtras>,
  ): $Type<TExtras & TNewExtras>;
}

/** A `$` produced by `build$`, combining the helper surface with any extras. */
export type $Type<TExtras extends ExtrasObject = {}> = $Base<TExtras> & TExtras;

interface $State<TExtras extends ExtrasObject> {
  commandBuilder: TreeBox<CommandBuilder>;
  extras: TExtras | undefined;
}

function build$FromState<TExtras extends ExtrasObject>(
  state: $State<TExtras>,
): $Type<TExtras> {
  const tag = (strings: TemplateStringsArray, ...exprs: TemplateExpr[]): CommandBuilder =>
    state.commandBuilder.getValue()[setCommandTextStateSymbol](template(strings, exprs));
  const result = Object.assign(
    tag,
    {
      escapeArg,
      rawArg,
      raw(strings: TemplateStringsArray, ...exprs: TemplateExpr[]): CommandBuilder {
        return state.commandBuilder.getValue()[setCommandTextStateSymbol](
          templateRaw(strings, exprs),
        );
      },
      build$<TNewExtras extends ExtrasObject = {}>(
        opts: Create$Options<TNewExtras> = {},
      ): $Type<TExtras & TNewExtras> {
        return build$FromState({
          commandBuilder: resolveCommandBuilder(opts.commandBuilder, state.commandBuilder),
          extras: { ...state.extras, ...opts.extras } as TExtras & TNewExtras,
        });
      },
    },
    state.extras ?? {},
  );
  return result as unknown as $Type<TExtras>;
}

function resolveCommandBuilder(
  value: CommandBuilder | ((builder: CommandBuilder) => CommandBuilder) | undefined,
  parent: TreeBox<CommandBuilder> | undefined,
): TreeBox<CommandBuilder> {
  if (value instanceof CommandBuilder) {
    return new TreeBox(value);
  } else if (typeof value === "function") {
    const base = parent != null ? parent.getValue() : new CommandBuilder();
    return new TreeBox(value(base));
  } else {
    return parent != null ? parent.createChild() : new TreeBox(new CommandBuilder());
  }
}

/** Creates a new `$` tagged template. */
export function build$<TExtras extends ExtrasObject = {}>(
  opts: Create$Options<TExtras> = {},
): $Type<TExtras> {
  return build$FromState({
    commandBuilder: resolveCommandBuilder(opts.commandBuilder, undefined),
    extras: opts.extras,
  });
}

/** Default `$` instance. */
export const $: $Type = build$();
