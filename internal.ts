/**
 * Internal plumbing used to build `$`-style wrappers on top of `CommandBuilder`
 * (see `@david/dax`). Not part of the stable public API — types and behavior
 * may change without a semver major.
 */

export {
  type CommandBuilderStateCommand,
  getRegisteredCommandNamesSymbol,
  setCommandTextStateSymbol,
  template,
  templateRaw,
} from "./src/command.ts";
export { Box, LoggerTreeBox, symbols, TreeBox } from "./src/common.ts";
