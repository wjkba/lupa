// Bundles the MCP server (Node ESM) and the Figma plugin (sandbox IIFE + UI).
import { build, context } from "esbuild";
import { copyFile, mkdir, readFile } from "node:fs/promises";

const watch = process.argv.includes("--watch");
const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));

const server = {
  entryPoints: ["src/index.ts"],
  outfile: "dist/server.js",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  sourcemap: true,
  // ws optionally loads native addons; let it fall back to its JS implementation.
  external: ["bufferutil", "utf-8-validate"],
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
  logLevel: "info",
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
  logLevel: "info",
};

async function copyUi() {
  await mkdir("plugin/dist", { recursive: true });
  await copyFile("plugin/src/ui.html", "plugin/dist/ui.html");
}

if (watch) {
  const [a, b] = await Promise.all([context(server), context(plugin)]);
  await copyUi();
  await Promise.all([a.watch(), b.watch()]);
  console.log("watching…");
} else {
  await Promise.all([build(server), build(plugin), copyUi()]);
}
