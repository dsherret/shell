import { build, emptyDir } from "@deno/dnt";
import * as esbuild from "esbuild";
import { smokeTestNpmOutput } from "./smokeTestNpm.ts";

Deno.chdir(new URL("../", import.meta.url));

await emptyDir("./npm");

await build({
  entryPoints: ["./mod.ts", {
    name: "./internal",
    path: "./internal.ts",
  }],
  outDir: "./npm",
  // esm only because the npm console-static-text dependency is esm only
  scriptModule: false,
  // the source is already written against node apis, so only the types that
  // @types/node doesn't provide as types need shimming
  shims: {
    deno: "dev",
    custom: [{
      package: {
        name: "node:util",
      },
      globalNames: [
        // @types/node declares this as a value instead of a type
        "TextDecoder",
      ],
    }, {
      package: {
        name: "node:stream/web",
      },
      globalNames: [{
        name: "StreamPipeOptions",
        typeOnly: true,
      }],
    }],
  },
  mappings: {
    "jsr:@david/console-static-text": {
      name: "console-static-text",
    },
    "jsr:@david/path": {
      name: "@dsherret/path",
    },
  },
  compilerOptions: {
    stripInternal: false,
    skipLibCheck: false,
    lib: ["ESNext"],
    target: "ES2022",
  },
  package: {
    name: "@dsherret/shell",
    // only used for publishing, so a placeholder is fine for local builds
    version: Deno.args[0] ?? "0.0.0",
    description: "Command execution and shell parser used by dax.",
    license: "MIT",
    repository: {
      type: "git",
      url: "git+https://github.com/dsherret/shell.git",
    },
    keywords: [
      "shell",
      "scripting",
      "spawn",
      "process",
    ],
    bugs: {
      url: "https://github.com/dsherret/shell/issues",
    },
    devDependencies: {
      "@types/node": "^24.0.0",
    },
  },
  async postBuild() {
    Deno.copyFileSync("LICENSE", "npm/LICENSE");
    // the package has a different name on npm
    const readme = await Deno.readTextFile("README.md");
    await Deno.writeTextFile(
      "npm/README.md",
      readme.replaceAll('"@david/shell"', '"@dsherret/shell"'),
    );
  },
});

await bundleEsmOutput();
await smokeTestNpmOutput();

/** Bundles the esm output into a mod.js so the published package doesn't ship
 * the deps as many small files.
 *
 * The internal entry point re-exports from the bundle rather than being bundled
 * on its own because the two entry points share modules (ex. the symbols in
 * command.ts) and must resolve to the same instances.
 */
async function bundleEsmOutput() {
  // dnt builds a merge proxy over globalThis for the shimmed globals, but the
  // only shim is node's TextDecoder, which is already the global one
  await Deno.writeTextFile(
    "npm/esm/_dnt.shims.js",
    [
      'export { TextDecoder } from "node:util";',
      "export const dntGlobalThis = globalThis;",
    ].join("\n") + "\n",
  );
  const bundle = await esbuild.build({
    stdin: {
      contents: [
        'export * from "./mod.js";',
        'export { default } from "./mod.js";',
        'export * from "./internal.js";',
      ].join("\n"),
      resolveDir: "npm/esm",
      loader: "js",
    },
    bundle: true,
    format: "esm",
    platform: "neutral",
    // the npm dependencies stay as dependencies
    packages: "external",
    external: ["node:*"],
    write: false,
  });
  await esbuild.stop();

  await removeJsFiles("npm/esm");
  await Deno.writeTextFile("npm/esm/mod.js", bundle.outputFiles[0].text);
  await Deno.writeTextFile("npm/esm/internal.js", 'export * from "./mod.js";\n');
}

async function removeJsFiles(dir: string) {
  for await (const entry of Deno.readDir(dir)) {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory) {
      await removeJsFiles(path);
    } else if (entry.name.endsWith(".js")) {
      await Deno.remove(path);
    }
  }
}
