// Demo of Docker-style partial scrolling via the `.tailDisplay()` builder method.
//
// Run with:
//   deno run -A examples/inherit_tail.ts
//
// Two deno subprocesses print random numbers every 250ms in parallel. Each
// one's output is pinned to a scrolling 5-line region at the bottom of the
// terminal instead of flooding the scrollback. When both workers finish the
// regions are cleared and only the "both workers done" line remains.

import $ from "../mod.ts";

await Promise.all([
  $`deno run ./output.js alpha`.cwd(import.meta.dirname!).tailDisplay(),
  $`deno run ./output.js beta`.cwd(import.meta.dirname!).tailDisplay(),
]);

// deno-lint-ignore no-console
console.log("both workers done");
