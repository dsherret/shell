import { assert, assertEquals } from "@std/assert";

if (import.meta.main) {
  Deno.chdir(new URL("../", import.meta.url));
  await smokeTestNpmOutput();
}

/** Runs `smokeTestNpm.mjs` with node against the built npm folder to verify the
 * bundled esm output still works once it's resolved as a published package.
 *
 * Requires `deno task dnt` to have been run first.
 */
export async function smokeTestNpmOutput() {
  await assertOnlyBundledJsFiles();

  // copied into the package so node resolves `@dsherret/shell` to it (and its
  // dependencies to npm/node_modules), then removed so it isn't published
  await Deno.copyFile("scripts/smokeTestNpm.mjs", "npm/smokeTestNpm.mjs");
  try {
    const output = await new Deno.Command("node", {
      args: ["smokeTestNpm.mjs"],
      cwd: "npm",
      stdout: "inherit",
      stderr: "inherit",
    }).output();
    if (!output.success) {
      throw new Error(`npm smoke test failed with exit code ${output.code}.`);
    }
  } finally {
    await Deno.remove("npm/smokeTestNpm.mjs");
  }
}

async function assertOnlyBundledJsFiles() {
  const jsFiles = await collectJsFiles("npm/esm");
  assertEquals(
    jsFiles.sort(),
    ["npm/esm/internal.js", "npm/esm/mod.js"],
    "the esm output should only contain the bundle and its re-export",
  );
  const bundle = await Deno.readTextFile("npm/esm/mod.js");
  assert(
    !/^\s*(?:import|export)\b[^;]*["']\.{1,2}\//m.test(bundle),
    "the bundle should not have any relative imports",
  );
}

async function collectJsFiles(dir: string): Promise<string[]> {
  const files: string[] = [];
  for await (const entry of Deno.readDir(dir)) {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory) {
      files.push(...await collectJsFiles(path));
    } else if (entry.name.endsWith(".js")) {
      files.push(path);
    }
  }
  return files;
}
