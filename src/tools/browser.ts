/**
 * Screenshots of the implementation for compare: renders a URL in headless
 * Chromium through Playwright. Prefers the Playwright installed in the
 * project being worked on (its browsers are usually installed), then Lupa's
 * own playwright-core, and finds a browser even when the versions don't match.
 */

import { existsSync, readdirSync } from "node:fs";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export interface RenderOptions {
  url: string;
  /** CSS px; the design's width. */
  width: number;
  /** Device pixel ratio (default 2). */
  scale?: number;
  /** Element to capture; default the full page. */
  selector?: string;
  /** Wait for this selector before capturing (default: the capture selector). */
  waitFor?: string;
  /** Viewport height before full-page capture (default 900). */
  height?: number;
  /** Font families to check: the result lists those the page can't use. */
  fonts?: string[];
}

export interface Rendered {
  png: Buffer;
  /** Families from `fonts` the browser renders with a fallback instead. */
  missingFonts: string[];
}

// Minimal surface of Playwright used here, so it needs no type dependency.
interface PwLocator {
  first(): PwLocator;
  waitFor(o: { state: "visible"; timeout: number }): Promise<void>;
  screenshot(o: { animations: "disabled" }): Promise<Buffer>;
}
interface PwPage {
  goto(url: string, o: { waitUntil: "load"; timeout: number }): Promise<unknown>;
  waitForLoadState(state: "networkidle", o: { timeout: number }): Promise<void>;
  evaluate<A>(fn: (arg: A) => unknown, arg?: A): Promise<unknown>;
  locator(sel: string): PwLocator;
  screenshot(o: {
    fullPage?: boolean;
    clip?: { x: number; y: number; width: number; height: number };
    omitBackground?: boolean;
    animations: "disabled";
  }): Promise<Buffer>;
}
interface PwBrowser {
  newPage(o: { viewport: { width: number; height: number }; deviceScaleFactor: number }): Promise<PwPage>;
  close(): Promise<void>;
}
interface PwChromium {
  launch(o: { executablePath?: string; channel?: string; headless: true }): Promise<PwBrowser>;
}

const INSTALL_HINT =
  "Install a browser with `npx playwright install chromium` (or install Google Chrome), or set LUPA_BROWSER to a Chrome/Chromium executable. You can also pass a screenshot with --image.";

async function loadChromium(): Promise<PwChromium> {
  const fromProject = createRequire(path.join(process.cwd(), "package.json"));
  for (const name of ["playwright", "@playwright/test", "playwright-core"]) {
    try {
      const mod = await import(pathToFileURL(fromProject.resolve(name)).href);
      const chromium = mod.chromium ?? mod.default?.chromium;
      if (chromium) return chromium;
    } catch {
      /* not installed in this project */
    }
  }
  try {
    const mod = (await import("playwright-core")) as unknown as { chromium?: PwChromium; default?: { chromium: PwChromium } };
    return (mod.chromium ?? mod.default?.chromium)!;
  } catch {
    throw new Error(`Rendering a URL needs Playwright: run \`npm install\` in the Lupa folder, or add playwright to your project. ${INSTALL_HINT}`);
  }
}

/** Where Playwright downloads its browsers. */
function playwrightCache(): string {
  if (process.env.PLAYWRIGHT_BROWSERS_PATH) return process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (process.platform === "darwin") return path.join(os.homedir(), "Library", "Caches", "ms-playwright");
  if (process.platform === "win32") return path.join(process.env.LOCALAPPDATA ?? os.homedir(), "ms-playwright");
  return path.join(os.homedir(), ".cache", "ms-playwright");
}

/** Chromium builds Playwright has downloaded, newest first. */
export function cachedChromiums(): string[] {
  const root = playwrightCache();
  let dirs: string[];
  try {
    dirs = readdirSync(root).filter((d) => /^chromium-\d+$/.test(d));
  } catch {
    return [];
  }
  dirs.sort((a, b) => Number(b.split("-")[1]) - Number(a.split("-")[1]));
  const inside = [
    "chrome-linux64/chrome",
    "chrome-linux/chrome",
    "chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
    "chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
    "chrome-mac/Chromium.app/Contents/MacOS/Chromium",
    "chrome-win64/chrome.exe",
    "chrome-win/chrome.exe",
  ];
  return dirs.flatMap((d) => inside.map((p) => path.join(root, d, p))).filter((p) => existsSync(p));
}

async function launch(chromium: PwChromium): Promise<PwBrowser> {
  const attempts: { executablePath?: string; channel?: string }[] = [];
  if (process.env.LUPA_BROWSER) attempts.push({ executablePath: process.env.LUPA_BROWSER });
  attempts.push({}, ...cachedChromiums().map((p) => ({ executablePath: p })), { channel: "chrome" });
  const errors: string[] = [];
  for (const a of attempts) {
    try {
      return await chromium.launch({ ...a, headless: true });
    } catch (e) {
      errors.push(`${a.executablePath ?? a.channel ?? "bundled"}: ${String((e as Error).message).split("\n")[0]}`);
    }
  }
  throw new Error(`Could not start Chromium. ${INSTALL_HINT}\n${errors.map((e) => `  ${e}`).join("\n")}`);
}

interface Canvas2D {
  font: string;
  measureText(text: string): { width: number };
}

/**
 * Runs in the page: the families it can't render by name. A family is missing
 * when text set in it measures exactly like each generic fallback.
 */
function missingFamilies(families: string[]): string[] {
  const doc = (globalThis as unknown as { document: { createElement(tag: "canvas"): { getContext(kind: "2d"): Canvas2D } } }).document;
  const ctx = doc.createElement("canvas").getContext("2d");
  const width = (font: string) => {
    ctx.font = font;
    return ctx.measureText("mmmmmmmmmmlli10WQ@#").width;
  };
  return families.filter((f) => ["monospace", "serif", "sans-serif"].every((g) => width(`72px "${f}", ${g}`) === width(`72px ${g}`)));
}

const TYPES: Record<string, string> = {
  ".html": "text/html", ".htm": "text/html", ".css": "text/css", ".js": "text/javascript", ".mjs": "text/javascript",
  ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".gif": "image/gif", ".webp": "image/webp", ".avif": "image/avif", ".ico": "image/x-icon", ".woff": "font/woff",
  ".woff2": "font/woff2", ".ttf": "font/ttf", ".otf": "font/otf", ".mp4": "video/mp4", ".webm": "video/webm",
};

/**
 * Serve a file:// page over local HTTP, as the app would be: Chromium refuses CSS masks,
 * ES modules and fetch() from file://. The root is the current folder when the page is in it
 * (so "/styles/a.css" resolves like on a dev server), else the page's own folder.
 */
async function serveFile(url: string): Promise<{ url: string; close(): void }> {
  const u = new URL(url);
  const file = fileURLToPath(u);
  if (!existsSync(file)) throw new Error(`${file} does not exist`);
  const inCwd = !path.relative(process.cwd(), file).startsWith("..");
  const root = inCwd ? process.cwd() : path.dirname(file);
  const server = createServer(async (req, res) => {
    let p = path.join(root, decodeURIComponent(new URL(req.url ?? "/", "http://x").pathname));
    try {
      if (path.relative(root, p).startsWith("..")) throw new Error("outside");
      if ((await stat(p)).isDirectory()) p = path.join(p, "index.html");
      const body = await readFile(p);
      res.writeHead(200, { "content-type": TYPES[path.extname(p).toLowerCase()] ?? "application/octet-stream" });
      res.end(body);
    } catch {
      res.writeHead(404).end();
    }
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  const port = (server.address() as AddressInfo).port;
  const rel = path.relative(root, file).split(path.sep).map(encodeURIComponent).join("/");
  return { url: `http://127.0.0.1:${port}/${rel}${u.search}${u.hash}`, close: () => server.close() };
}

/** Render a page (or one element of it) to PNG. */
export async function renderUrl(opts: RenderOptions): Promise<Rendered> {
  const served = opts.url.startsWith("file:") ? await serveFile(opts.url) : undefined;
  try {
    const browser = await launch(await loadChromium());
    try {
      const page = await browser.newPage({
        viewport: { width: Math.round(opts.width), height: opts.height ?? 900 },
        deviceScaleFactor: opts.scale ?? 2,
      });
      await page.goto(served?.url ?? opts.url, { waitUntil: "load", timeout: 30_000 });
      // Dev servers keep sockets open; settle briefly but don't hang on them.
      await page.waitForLoadState("networkidle", { timeout: 5_000 }).catch(() => {});
      const waitFor = opts.waitFor ?? opts.selector;
      if (waitFor) {
        await page
          .locator(waitFor)
          .first()
          .waitFor({ state: "visible", timeout: 15_000 })
          .catch(() => {
            throw new Error(`"${waitFor}" did not appear on ${opts.url} within 15s`);
          });
      }
      await page.evaluate(() => (globalThis as unknown as { document: { fonts: { ready: Promise<unknown> } } }).document.fonts.ready);
      const missingFonts = (await page.evaluate(missingFamilies, opts.fonts ?? [])) as string[];
      const png = opts.selector
        ? await page.locator(opts.selector).first().screenshot({ animations: "disabled" })
        : await page.screenshot({ fullPage: true, animations: "disabled" });
      return { png, missingFonts };
    } finally {
      await browser.close();
    }
  } finally {
    served?.close();
  }
}

/**
 * Rasterize an SVG of `width`×`height` design px at `scale` device px per design px.
 * Figma exports SVG without its renderer, so this stands in for its PNG export
 * while Figma isn't rendering.
 */
export async function renderSvg(svg: string, o: { width: number; height: number; scale: number }): Promise<Buffer> {
  const dir = path.join(os.tmpdir(), "lupa");
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, `render-${process.pid}-${Date.now()}.svg`);
  await writeFile(file, svg);
  try {
    const browser = await launch(await loadChromium());
    try {
      const page = await browser.newPage({
        viewport: { width: Math.ceil(o.width), height: Math.ceil(o.height) },
        deviceScaleFactor: o.scale,
      });
      await page.goto(pathToFileURL(file).href, { waitUntil: "load", timeout: 30_000 });
      // Transparent where the design is, like Figma's PNG export.
      return await page.screenshot({ clip: { x: 0, y: 0, width: o.width, height: o.height }, omitBackground: true, animations: "disabled" });
    } finally {
      await browser.close();
    }
  } finally {
    await rm(file, { force: true });
  }
}
