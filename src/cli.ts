/**
 * The `lupa` command line: the same read-only operations as the MCP server,
 * for agents that have a shell. Text goes to stdout; images are written to
 * files whose paths are printed, so the agent opens only what it needs.
 *
 * The Figma plugin needs a long-lived process to stay connected to, so the
 * first command starts a background hub (`lupa serve`) and every command
 * joins it as a peer. The hub exits after an idle period.
 */

import { spawn } from "node:child_process";
import { mkdirSync, openSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { Bridge, SERVER_VERSION } from "./bridge/hub";
import { FORMAT_LEGEND } from "./shared/legend";
import { DEFAULT_PORT } from "./shared/protocol";
import type { Visual } from "./tools/media";
import { Lupa, type ComponentsMode } from "./tools/ops";

export const USAGE = `lupa — read Figma designs for faithful implementation (read-only)

Usage: lupa <command> [target] [options]
target: a Figma URL (quote it), node ids like 12:34 (several allowed),
        or nothing = the current selection in Figma.

Read
  design [target]       Compact, exact description of the layers (start here)
      --budget N          approximate output tokens (default 8000)
      --components MODE   auto | inline | names (default auto)
      --depth N  --hidden  --vectors
      -d DIR              also write the icons and images there; layers name their file
      --current-color     with -d: monochrome icons use currentColor
      --screenshot        also render a PNG of the target and print its path
  screenshot [target]   Render to PNG(s) sized for vision; prints the file paths
      -o PATH  --scale N  --full PATH (also save the full-resolution PNG)
  assets [target]       Write the icons (SVG) and images to a folder
      -d DIR (default figma-assets)  --as auto|svg|png  --scale N  --current-color
  tokens                Variables and styles   --format list|css|json  --filter TEXT
  css <target>          Figma's own Dev Mode CSS for those layers
  outline               Pages and top-level frames   --page NAME|*  --depth N
  find <query>          Search layers   --text  --type TYPE (repeatable)  --page NAME  --within ID  --limit N
  status                Connected Figma files and their selections

Verify
  compare [target]      Pixel-diff your implementation against Figma; lists the differing
                        layers and writes a design | implementation | diff image
      --url URL [--selector CSS] [--wait-for CSS]   render your running page at the design's width
      --image PNG                                   or use a screenshot you took
      --threshold N (0–1, default 0.1)  -o PATH

Other
  format                Legend for the design output
  serve [--idle MIN]    Run the hub in the foreground (otherwise started automatically;
                        exits after MIN idle minutes, default 60, 0 = never)
  mcp                   Run as an MCP server over stdio

Global: --file NAME|KEY  pick the Figma file when several are open
        --port N         default ${DEFAULT_PORT} (or LUPA_PORT)`;

type OptionSpec = Record<string, { type: "string" | "boolean"; short?: string; multiple?: boolean }>;
type Values = Record<string, string | boolean | string[] | undefined>;

const GLOBAL: OptionSpec = { file: { type: "string" }, port: { type: "string" }, help: { type: "boolean", short: "h" } };

const SPECS: Record<string, OptionSpec> = {
  design: {
    budget: { type: "string" },
    components: { type: "string" },
    depth: { type: "string" },
    hidden: { type: "boolean" },
    vectors: { type: "boolean" },
    dir: { type: "string", short: "d" },
    "current-color": { type: "boolean" },
    screenshot: { type: "boolean" },
  },
  screenshot: { out: { type: "string", short: "o" }, scale: { type: "string" }, full: { type: "string" } },
  assets: { dir: { type: "string", short: "d" }, as: { type: "string" }, scale: { type: "string" }, "current-color": { type: "boolean" } },
  tokens: { format: { type: "string" }, filter: { type: "string" } },
  css: {},
  outline: { page: { type: "string" }, depth: { type: "string" } },
  find: { text: { type: "boolean" }, type: { type: "string", multiple: true }, page: { type: "string" }, within: { type: "string" }, limit: { type: "string" } },
  status: {},
  compare: {
    url: { type: "string" },
    selector: { type: "string" },
    "wait-for": { type: "string" },
    image: { type: "string" },
    threshold: { type: "string" },
    out: { type: "string", short: "o" },
  },
  format: {},
  serve: { idle: { type: "string" } },
  mcp: {},
};

export class UsageError extends Error {}

function num(v: Values, key: string, min: number, max: number): number | undefined {
  const raw = v[key];
  if (raw === undefined) return undefined;
  const x = Number(raw);
  if (!Number.isFinite(x) || x < min || x > max) throw new UsageError(`--${key} must be a number between ${min} and ${max}`);
  return x;
}

function oneOf<T extends string>(v: Values, key: string, allowed: readonly T[]): T | undefined {
  const raw = v[key];
  if (raw === undefined) return undefined;
  if (!allowed.includes(raw as T)) throw new UsageError(`--${key} must be one of: ${allowed.join(", ")}`);
  return raw as T;
}

const str = (v: Values, key: string) => v[key] as string | undefined;

/** Where images go when -o is not given. */
export function imageDir(): string {
  return path.join(os.tmpdir(), "lupa");
}

/** Write a visual result's images and append their paths to its text. */
function deliver(v: Visual, out: string | undefined, kind: string): string {
  if (!v.images.length) return v.text;
  const base = out ?? path.join(imageDir(), `${kind}-${Date.now().toString(36)}.png`);
  mkdirSync(path.dirname(path.resolve(base)), { recursive: true });
  const ext = path.extname(base) || ".png";
  const stem = base.slice(0, base.length - path.extname(base).length);
  const files = v.images.map((png, i) => {
    const f = path.resolve(i === 0 ? `${stem}${ext}` : `${stem}-${i + 1}${ext}`);
    writeFileSync(f, png);
    return f;
  });
  return [v.text, ...files.map((f) => `image: ${f}`)].join("\n");
}

async function run(cmd: string, v: Values, pos: string[], lupa: Lupa): Promise<string> {
  const target = pos.length ? pos.join(" ") : undefined;
  const file = str(v, "file");
  switch (cmd) {
    case "status":
      return lupa.status();
    case "design": {
      const text = await lupa.design({
        target,
        file,
        budget: num(v, "budget", 500, 100_000),
        components: oneOf<ComponentsMode>(v, "components", ["auto", "inline", "names"]),
        depth: num(v, "depth", 0, 1000),
        includeHidden: v.hidden === true,
        expandVectors: v.vectors === true,
        assetsDir: str(v, "dir"),
        currentColor: v["current-color"] === true,
      });
      if (v.screenshot !== true) return text;
      return `${text}\n\n## screenshot\n${deliver(await lupa.screenshot({ target, file }), undefined, "screenshot")}`;
    }
    case "screenshot":
      return deliver(await lupa.screenshot({ target, file, scale: num(v, "scale", 0.1, 4), saveTo: str(v, "full") }), str(v, "out"), "screenshot");
    case "assets":
      return lupa.assets({
        target,
        file,
        dir: str(v, "dir"),
        as: oneOf(v, "as", ["auto", "svg", "png"] as const),
        scale: num(v, "scale", 0.5, 4),
        currentColor: v["current-color"] === true,
      });
    case "tokens":
      return lupa.tokens({ file, format: oneOf(v, "format", ["list", "css", "json"] as const), filter: str(v, "filter") });
    case "css":
      if (!target) throw new UsageError("css needs a target (node id or URL)");
      return lupa.css({ target, file });
    case "outline":
      return lupa.outline({ file, page: str(v, "page"), depth: num(v, "depth", 1, 4) });
    case "find":
      if (!target) throw new UsageError("find needs a query");
      return lupa.find({
        query: target,
        file,
        text: v.text === true,
        types: (v.type as string[] | undefined)?.map((t) => t.toUpperCase()),
        page: str(v, "page"),
        within: str(v, "within"),
        limit: num(v, "limit", 1, 200),
      });
    case "compare": {
      if (!v.url === !v.image) throw new UsageError("compare needs --url (your running page) or --image (a PNG screenshot)");
      const res = await lupa.compare({
        target,
        file,
        url: str(v, "url"),
        selector: str(v, "selector"),
        waitFor: str(v, "wait-for"),
        image: str(v, "image"),
        threshold: num(v, "threshold", 0, 1),
      });
      return deliver(res, str(v, "out"), "compare");
    }
    default:
      throw new UsageError(`Unknown command "${cmd}". Run lupa help.`);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Start `lupa serve` detached; it outlives this command so the plugin stays connected. */
function spawnHub(port: number): string {
  const dir = imageDir();
  mkdirSync(dir, { recursive: true });
  const logFile = path.join(dir, "hub.log");
  const log = openSync(logFile, "a");
  const entry = fileURLToPath(import.meta.url);
  spawn(process.execPath, [...process.execArgv, entry, "serve", "--port", String(port)], {
    detached: true,
    stdio: ["ignore", log, log],
    windowsHide: true,
  }).unref();
  return logFile;
}

/** Join the running hub as a peer, starting one first if needed. */
async function joinHub(port: number, log: (m: string) => void): Promise<{ bridge: Bridge; fresh: boolean }> {
  const bridge = new Bridge({ port, role: "peer", log });
  try {
    await bridge.start();
    return { bridge, fresh: false };
  } catch {
    /* no hub yet */
  }
  const logFile = spawnHub(port);
  for (const until = Date.now() + 6_000; Date.now() < until; ) {
    await sleep(150);
    try {
      await bridge.start();
      return { bridge, fresh: true };
    } catch {
      /* still starting */
    }
  }
  throw new Error(`Could not start the Lupa hub on port ${port} (is another program using it? set LUPA_PORT). Log: ${logFile}`);
}

async function serve(port: number, idleMin: number, log: (m: string) => void): Promise<void> {
  const bridge = new Bridge({ port, role: "hub", log });
  try {
    await bridge.start();
  } catch (e) {
    log((e as Error).message);
    return;
  }
  const stop = (why: string) => {
    log(`stopping: ${why}`);
    bridge.close().finally(() => process.exit(0));
  };
  if (idleMin > 0) {
    setInterval(() => {
      if (bridge.idleMs > idleMin * 60_000) stop(`idle for ${idleMin} min`);
    }, Math.min(30_000, idleMin * 30_000));
  }
  process.on("SIGINT", () => stop("SIGINT"));
  process.on("SIGTERM", () => stop("SIGTERM"));
  await new Promise(() => {}); // until stopped
}

export interface CliIO {
  out: (text: string) => void;
  err: (text: string) => void;
  /** Use this bridge instead of joining or starting a hub (tests). */
  bridge?: Bridge;
}

/** Run one command. Returns the exit code. */
export async function runCli(argv: string[], io: CliIO = { out: (t) => process.stdout.write(`${t}\n`), err: (t) => process.stderr.write(`${t}\n`) }): Promise<number> {
  const [cmd = "help", ...rest] = argv;
  if (cmd === "help" || cmd === "--help" || cmd === "-h") {
    io.out(USAGE);
    return 0;
  }
  if (cmd === "--version" || cmd === "-v") {
    io.out(SERVER_VERSION);
    return 0;
  }
  const spec = SPECS[cmd];
  if (!spec) {
    io.err(`Unknown command "${cmd}".\n\n${USAGE}`);
    return 2;
  }
  let values: Values;
  let positionals: string[];
  try {
    ({ values, positionals } = parseArgs({ args: rest, options: { ...GLOBAL, ...spec }, allowPositionals: true, strict: true }) as {
      values: Values;
      positionals: string[];
    });
  } catch (e) {
    io.err(`${(e as Error).message}\nRun lupa help.`);
    return 2;
  }
  if (values.help) {
    io.out(USAGE);
    return 0;
  }
  if (cmd === "format") {
    io.out(FORMAT_LEGEND);
    return 0;
  }

  const debug = !!process.env.LUPA_DEBUG;
  let port: number;
  let idle: number;
  try {
    port = num(values, "port", 1, 65535) ?? Number(process.env.LUPA_PORT ?? DEFAULT_PORT);
    idle = num(values, "idle", 0, 7 * 24 * 60) ?? 60;
  } catch (e) {
    io.err((e as Error).message);
    return 2;
  }

  if (cmd === "serve") {
    await serve(port, idle, (m) => io.err(`[lupa ${new Date().toISOString()}] ${m}`));
    return 0;
  }
  if (cmd === "mcp") {
    process.env.LUPA_PORT = String(port);
    const { main } = await import("./server");
    await main();
    await new Promise(() => {}); // the MCP server exits the process itself
  }

  let bridge = io.bridge;
  let fresh = false;
  try {
    if (!bridge) ({ bridge, fresh } = await joinHub(port, (m) => debug && io.err(`[lupa] ${m}`)));
    const lupa = new Lupa(bridge);
    // A hub that just started has to wait for the plugin's reconnect backoff.
    if (fresh) lupa.pluginWaitMs = 8_000;
    io.out(await run(cmd, values, positionals, lupa));
    return 0;
  } catch (e) {
    io.err(`Error: ${(e as Error).message}`);
    return e instanceof UsageError ? 2 : 1;
  } finally {
    if (bridge && !io.bridge) await bridge.close();
  }
}
