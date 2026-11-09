// Bundles the CLI and the MCP server (Node ESM) and the Figma plugin (sandbox IIFE + UI).
import { build, context } from "esbuild";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const watch = process.argv.includes("--watch");
const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));

const node = {
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  sourcemap: true,
  // ws optionally loads native addons; let it fall back to its JS implementation.
  // playwright-core is loaded from node_modules only when compare renders a URL.
  external: ["bufferutil", "utf-8-validate", "playwright-core"],
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
  logLevel: "info",
};

const cli = { ...node, entryPoints: ["src/cli-main.ts"], outfile: "dist/cli.js" };
// Kept for MCP configs that point at dist/server.js; same as `lupa mcp`.
const server = { ...node, entryPoints: ["src/index.ts"], outfile: "dist/server.js" };

// Figma reloads a development plugin whenever its files are written, which drops
// any request in flight. Write the plugin's files only when their bytes change.
async function writeIfChanged(file, contents) {
  const old = await readFile(file).catch(() => null);
  if (old && old.equals(Buffer.from(contents))) return;
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, contents);
}

const onlyChanged = {
  name: "write-if-changed",
  setup(b) {
    b.onEnd(async (result) => {
      for (const f of result.outputFiles ?? []) await writeIfChanged(f.path, f.contents);
    });
  },
};

const plugin = {
  entryPoints: ["plugin/src/code.ts"],
  outfile: "plugin/dist/code.js",
  bundle: true,
  platform: "neutral",
  format: "iife",
  // The plugin sandbox is an older JS engine: no optional chaining or ?? at runtime.
  target: "es2017",
  define: { PLUGIN_VERSION: JSON.stringify(pkg.version) },
  write: false,
  plugins: [onlyChanged],
  logLevel: "info",
};

async function copyUi() {
  await writeIfChanged("plugin/dist/ui.html", await readFile("plugin/src/ui.html"));
}

if (watch) {
  const contexts = await Promise.all([context(cli), context(server), context(plugin)]);
  await copyUi();
  await Promise.all(contexts.map((c) => c.watch()));
  console.log("watching…");
} else {
  await Promise.all([build(cli), build(server), build(plugin), copyUi()]);
}
