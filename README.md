# shell

[![JSR](https://jsr.io/badges/@david/shell)](https://jsr.io/@david/shell)

Command execution and shell parser used by [`dax`](https://github.com/dsherret/dax).

Most users should reach for `dax` — it builds on this package and adds progress bars, logging, `request`, `which`, and other conveniences. Use `@david/shell` directly when you want just the shell layer.

Works on Deno and Node.js.

## Install

```sh
# Deno
deno add jsr:@david/shell

# Node
npx jsr add @david/shell
```

## Usage

```ts
import $ from "@david/shell";

// run a command (stdout inherits by default)
await $`echo 1 && echo 2`;

// capture output
const text = await $`echo hello`.text();
console.log(text); // "hello"

// interpolated args are escaped by default
const name = "some name with spaces";
await $`echo ${name}`;

// $.raw disables argument escaping
await $.raw`echo one two three`;

// $.rawArg opts a single value out of escaping
await $`echo ${$.rawArg("1   2   3")}`;
```

### `build$`

`build$` creates a `$` bound to a specific `CommandBuilder` and/or with extra properties attached.

```ts
import { build$, CommandBuilder } from "@david/shell";

const $ = build$({
  commandBuilder: new CommandBuilder().env("MY_VAR", "123"),
  extras: {
    add(a: number, b: number) {
      return a + b;
    },
  },
});

await $`echo $MY_VAR`; // uses the configured env
console.log($.add(1, 2)); // 3
```

Call `$.build$(...)` to derive a child `$` that inherits the parent's command builder state and merges any new extras on top.

## Custom commands

Register a handler to implement a built-in command:

```ts
import { CommandBuilder } from "@david/shell";

const result = await new CommandBuilder()
  .registerCommand("greet", async (ctx) => {
    await ctx.stdout.writeLine(`hello ${ctx.args[0] ?? "world"}`);
    return { code: 0 };
  })
  .command("greet friend")
  .stdout("piped");

console.log(result.stdout); // "hello friend\n"
```

See [`mod.ts`](./mod.ts) for the full public API: `$`/`build$`, `CommandBuilder`, `CommandChild`, `CommandResult`, `KillController`/`KillSignal`, `escapeArg`, `createExecutableCommand`, file helpers (`create`, `open`, `FsFile`), and types for command handlers, pipes, and shell results.
