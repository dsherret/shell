import type { CommandContext } from "../commandHandler.ts";
import type { EnvChange, ExecuteResult, ShellOption } from "../result.ts";

const NAMED_OPTIONS = [
  ["errexit", "errexit"],
  ["pipefail", "pipefail"],
] as const satisfies ReadonlyArray<readonly [string, ShellOption]>;

const SHORT_FLAGS: Record<string, ShellOption> = {
  e: "errexit",
};

function findNamedOption(name: string): ShellOption | undefined {
  return NAMED_OPTIONS.find(([n]) => n === name)?.[1];
}

function findShortFlag(arg: string): ShellOption | undefined {
  if (arg.length !== 2) return undefined;
  const sign = arg[0];
  if (sign !== "-" && sign !== "+") return undefined;
  return SHORT_FLAGS[arg[1]];
}

export function setCommand(context: CommandContext): ExecuteResult | Promise<ExecuteResult> {
  const args = context.args;
  if (args.length === 0) {
    return { code: 0 };
  }

  // set -o (list options in human-readable format)
  if (args.length === 1 && args[0] === "-o") {
    const opts = context.shellOptions;
    for (const [name, flag] of NAMED_OPTIONS) {
      context.stdout.writeLine(`${name}\t${opts[flag] ? "on" : "off"}`);
    }
    return { code: 0 };
  }

  // set +o (output commands to recreate current settings)
  if (args.length === 1 && args[0] === "+o") {
    const opts = context.shellOptions;
    for (const [name, flag] of NAMED_OPTIONS) {
      context.stdout.writeLine(`set ${opts[flag] ? "-o" : "+o"} ${name}`);
    }
    return { code: 0 };
  }

  // parse option changes: `set -o name`, `set +o name`, `set -e`, `set +e`, ...
  const changes: EnvChange[] = [];
  let i = 0;
  while (i < args.length) {
    const arg = args[i];
    if ((arg === "-o" || arg === "+o") && i + 1 < args.length) {
      const enable = arg === "-o";
      const optionName = args[i + 1];
      const option = findNamedOption(optionName);
      if (option == null) {
        return context.error(`set: unknown option: ${optionName}`);
      }
      changes.push({ kind: "setoption", option, value: enable });
      i += 2;
    } else {
      const option = findShortFlag(arg);
      if (option == null) {
        return context.error(`set: invalid option: ${arg}`);
      }
      changes.push({ kind: "setoption", option, value: arg.startsWith("-") });
      i += 1;
    }
  }

  return { code: 0, changes };
}
