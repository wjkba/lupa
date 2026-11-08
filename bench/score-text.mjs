/**
 * Structural, font-independent score: where each Figma text layer ended up in the page.
 *
 *   node bench/score-text.mjs --snapshot <figma.json> [--node <id|url>] [--refresh] <run-dir>...
 *
 * --snapshot is a raw Loupe snapshot of the frame (bench/snapshot.mts). It is fetched through
 * the Loupe plugin when the file is missing (or with --refresh) and --node is given; otherwise
 * the cached file is reused, so scoring doesn't need Figma.
 *
 * Each run's index.html is rendered in headless Chromium at the frame's size. Every visible
 * Figma text layer is matched to page text by normalised content (case, whitespace and
 * punctuation variants ignored): a whole text node, a run of consecutive text nodes (styled
 * spans), or a substring of a longer text node. Duplicates go to the nearest candidate.
 *
 * Position is compared at the alignment anchor: x at the left edge / centre / right edge of the
 * text for LEFT / CENTER / RIGHT layers, y at the centre of the first line (font-independent:
 * CSS and Figma both centre glyphs in the line box). Error = max(|dx|, |dy|) in CSS px.
 * Font size, weight, colour and line height are compared per styled run.
 *
 * Writes <run>/score-text.json and prints one JSON line per run, then a summary table.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const BENCH = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(BENCH, "..");

/* ---------------------------------------------------------------- args */
const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(name);
  if (i < 0) return undefined;
  const v = args[i + 1];
  args.splice(i, 2);
  return v;
};
const flag = (name) => {
  const i = args.indexOf(name);
  if (i >= 0) args.splice(i, 1);
  return i >= 0;
};
const snapshotFile = opt("--snapshot");
const node = opt("--node");
const refresh = flag("--refresh");
const runs = args;
if (!snapshotFile || !runs.length) {
  console.error("usage: node bench/score-text.mjs --snapshot <figma.json> [--node <id|url>] [--refresh] <run-dir>...");
  process.exit(2);
}

if (refresh || !existsSync(snapshotFile)) {
  if (!node) {
    console.error(`${snapshotFile} does not exist; pass --node <id|url> to fetch it through the Loupe plugin`);
    process.exit(2);
  }
  const r = spawnSync("npx", ["tsx", path.join(BENCH, "snapshot.mts"), node, snapshotFile], { cwd: REPO, stdio: "inherit" });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

/* ---------------------------------------------------------- figma side */
const snap = JSON.parse(readFileSync(snapshotFile, "utf8"));
const root = snap.roots[0];
const [rootX, rootY] = root.bb ?? [0, 0];

/** First visible solid fill as [r, g, b, a] (0–255, a 0–1), or null when the text has no visible fill. */
function solid(fills) {
  for (const p of fills ?? []) {
    if (p.visible === false || p.type !== "SOLID") continue;
    const a = (p.opacity ?? 1) * (p.color.a ?? 1);
    if (a <= 0.001) continue;
    return [p.color.r * 255, p.color.g * 255, p.color.b * 255, a];
  }
  return null;
}

/** Figma line height in px, or null for AUTO (the font's own). */
function lineHeightPx(lh, fontSize) {
  if (!lh || lh.unit === "AUTO") return null;
  return lh.unit === "PIXELS" ? lh.value : (lh.value / 100) * fontSize;
}

const layers = [];
(function walk(n, hidden) {
  hidden = hidden || n.visible === false || n.stub || (n.opacity ?? 1) <= 0.001;
  if (n.type === "TEXT" && !hidden && n.characters?.trim() && !n.rotation) {
    const segs = (n.segments?.length ? n.segments : [{ start: 0, end: n.characters.length, fills: n.fills }]).map((s) => ({
      start: s.start,
      end: s.end,
      fontSize: s.fontSize,
      fontWeight: s.fontWeight,
      lineHeight: lineHeightPx(s.lineHeight, s.fontSize),
      color: solid(s.fills ?? n.fills),
    }));
    const [x, y, w, h] = n.bb;
    const box = { x: x - rootX, y: y - rootY, w, h };
    const inside = box.x < root.w && box.y < root.h && box.x + w > 0 && box.y + h > 0;
    if (inside && segs.some((s) => s.color)) {
      // First line's vertical centre. AUTO line height: the box hugs its lines, so estimate
      // the line count from the size; one line when the text has no breaks and fits.
      const fs = segs[0].fontSize ?? 14;
      const lines = Math.max(1, n.characters.split("\n").length, Math.round(h / (segs[0].lineHeight ?? fs * 1.2)));
      const L = segs[0].lineHeight ?? h / lines;
      const T = Math.min(h, L * lines);
      const va = n.textAlignVertical ?? "TOP";
      const top = va === "CENTER" ? box.y + (h - T) / 2 : va === "BOTTOM" ? box.y + h - T : box.y;
      const align = n.textAlignHorizontal ?? "LEFT";
      const ax = align === "CENTER" ? box.x + w / 2 : align === "RIGHT" ? box.x + w : box.x;
      layers.push({ id: n.id, name: n.name, text: n.characters, align, ax, ay: top + L / 2, box, segs });
    }
  }
  for (const c of n.children ?? []) walk(c, hidden);
})(root, false);

/* ------------------------------------------------------------ browser */
async function loadChromium() {
  const req = createRequire(path.join(REPO, "package.json"));
  const mod = req("playwright-core");
  const cache = process.env.PLAYWRIGHT_BROWSERS_PATH ?? path.join(os.homedir(), process.platform === "darwin" ? "Library/Caches/ms-playwright" : ".cache/ms-playwright");
  let exes = [];
  try {
    exes = readdirSync(cache)
      .filter((d) => /^chromium-\d+$/.test(d))
      .sort((a, b) => Number(b.split("-")[1]) - Number(a.split("-")[1]))
      .flatMap((d) => ["chrome-linux64/chrome", "chrome-linux/chrome", "chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"].map((p) => path.join(cache, d, p)))
      .filter(existsSync);
  } catch {}
  for (const executablePath of [process.env.LOUPE_BROWSER, undefined, ...exes].filter((x, i) => i === 1 || x)) {
    try {
      return await mod.chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
    } catch {}
  }
  throw new Error("no Chromium: run `npx playwright install chromium` or set LOUPE_BROWSER");
}

/** Runs in the page: match Figma text layers to page text and measure them. */
function measure({ layers }) {
  const norm = (s) =>
    s
      .normalize("NFKC")
      .toLowerCase()
      .replace(/[‘’‚′]/g, "'")
      .replace(/[“”„″]/g, '"')
      .replace(/[‐-―−]/g, "-")
      .replace(/…/g, "...");
  /** Key chars without whitespace, each with its index in the original string. */
  const keyed = (s) => {
    const chars = [];
    const idx = [];
    for (let i = 0; i < s.length; i++) {
      const c = norm(s[i]);
      if (/\s/.test(c)) continue;
      for (const ch of c) {
        chars.push(ch);
        idx.push(i);
      }
    }
    return { key: chars.join(""), idx };
  };

  const rootEl = document.querySelector("#root");
  if (!rootEl) return { error: "no #root element" };
  const R = rootEl.getBoundingClientRect();
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 1;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  const rgba = (css) => {
    ctx.clearRect(0, 0, 1, 1);
    ctx.fillStyle = "#000";
    ctx.fillStyle = css;
    ctx.fillRect(0, 0, 1, 1);
    const d = ctx.getImageData(0, 0, 1, 1).data;
    // Premultiplied readback loses precision at low alpha; good enough for exact-match checks.
    return [d[0], d[1], d[2], d[3] / 255];
  };

  // Visible text nodes in document order.
  const nodes = [];
  const walker = document.createTreeWalker(rootEl, NodeFilter.SHOW_TEXT);
  for (let t = walker.nextNode(); t; t = walker.nextNode()) {
    if (!t.data.trim()) continue;
    const el = t.parentElement;
    const cs = getComputedStyle(el);
    if (cs.visibility === "hidden" || cs.display === "none" || el.closest("script,style,template,title,noscript")) continue;
    let op = 1;
    for (let e = el; e && e !== rootEl.parentElement; e = e.parentElement) op *= Number(getComputedStyle(e).opacity);
    const range = document.createRange();
    range.selectNodeContents(t);
    if (!range.getClientRects().length || op <= 0.001) continue;
    const color = rgba(cs.color);
    color[3] *= op;
    if (color[3] <= 0.001) continue; // transparent text, e.g. a layer the design keeps invisible
    nodes.push({
      t,
      ...keyed(t.data),
      style: { fontSize: parseFloat(cs.fontSize), fontWeight: Number(cs.fontWeight), lineHeight: cs.lineHeight === "normal" ? null : parseFloat(cs.lineHeight), color },
      used: [],
    });
  }

  const rectsOf = (pieces) => {
    const rects = [];
    for (const p of pieces) {
      const r = document.createRange();
      r.setStart(p.node.t, p.from);
      r.setEnd(p.node.t, p.to);
      for (const q of r.getClientRects()) if (q.width > 0 || q.height > 0) rects.push(q);
    }
    return rects;
  };
  const anchorOf = (layer, rects) => {
    if (!rects.length) return null;
    const left = Math.min(...rects.map((q) => q.left)) - R.left;
    const right = Math.max(...rects.map((q) => q.right)) - R.left;
    const first = rects.reduce((a, q) => (q.top < a.top - 1 ? q : a));
    const firstLine = rects.filter((q) => Math.abs(q.top + q.height / 2 - (first.top + first.height / 2)) < first.height / 2);
    const top = Math.min(...firstLine.map((q) => q.top));
    const bottom = Math.max(...firstLine.map((q) => q.bottom));
    const x = layer.align === "CENTER" ? (left + right) / 2 : layer.align === "RIGHT" ? right : left;
    return { x, y: (top + bottom) / 2 - R.top, left, right };
  };

  // Candidates for each layer: runs of whole consecutive text nodes, then substrings.
  const cands = [];
  layers.forEach((layer, li) => {
    const { key } = keyed(layer.text);
    if (!key) return;
    let found = false;
    for (let i = 0; i < nodes.length; i++) {
      let acc = "";
      for (let j = i; j < nodes.length && acc.length < key.length && j - i < 12; j++) {
        acc += nodes[j].key;
        if (!key.startsWith(acc)) break;
        if (acc === key) {
          const pieces = nodes.slice(i, j + 1).map((n) => ({ node: n, from: 0, to: n.t.data.length, keyFrom: 0, keyTo: n.key.length }));
          cands.push({ li, pieces, whole: true });
          found = true;
        }
      }
    }
    if (!found && key.length >= 3) {
      for (const n of nodes) {
        for (let at = n.key.indexOf(key); at >= 0; at = n.key.indexOf(key, at + 1)) {
          const from = n.idx[at];
          const to = n.idx[at + key.length - 1] + 1;
          cands.push({ li, pieces: [{ node: n, from, to, keyFrom: at, keyTo: at + key.length }], whole: false });
        }
      }
    }
  });
  for (const c of cands) {
    const a = anchorOf(layers[c.li], rectsOf(c.pieces));
    c.anchor = a;
    c.dist = a ? Math.hypot(a.x - layers[c.li].ax, a.y - layers[c.li].ay) : Infinity;
  }
  cands.sort((a, b) => a.dist - b.dist || Number(b.whole) - Number(a.whole));

  const free = (p) => p.node.used.every(([f, t]) => p.to <= f || p.from >= t);
  const results = layers.map(() => null);
  for (const c of cands) {
    if (results[c.li] || !c.anchor || !c.pieces.every(free)) continue;
    for (const p of c.pieces) p.node.used.push([p.from, p.to]);
    const layer = layers[c.li];
    // Styled runs: each piece compared with the Figma segment its first character falls in.
    const lk = keyed(layer.text);
    let offset = 0;
    const parts = c.pieces.map((p) => {
      const pos = lk.idx[Math.min(offset, lk.idx.length - 1)];
      offset += p.keyTo - p.keyFrom;
      const seg = layer.segs.find((s) => pos >= s.start && pos < s.end) ?? layer.segs[0];
      return { dom: p.node.style, fig: { fontSize: seg.fontSize, fontWeight: seg.fontWeight, lineHeight: seg.lineHeight, color: seg.color } };
    });
    results[c.li] = { dx: c.anchor.x - layer.ax, dy: c.anchor.y - layer.ay, how: c.whole ? (c.pieces.length > 1 ? "spans" : "node") : "substring", parts };
  }
  const extra = nodes.filter((n) => !n.used.length).map((n) => n.t.data.trim().slice(0, 40));
  return { results, extra };
}

/* ------------------------------------------------------------- scoring */
const pct = (n, d) => (d ? Math.round((1000 * n) / d) / 10 : null);
const quantile = (xs, q) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const i = (s.length - 1) * q;
  return Math.round(10 * (s[Math.floor(i)] + (s[Math.ceil(i)] - s[Math.floor(i)]) * (i - Math.floor(i)))) / 10;
};
const sameColor = (a, b) => !!a && !!b && [0, 1, 2].every((i) => Math.abs(a[i] - b[i]) <= 2) && Math.abs(a[3] - b[3]) <= 0.03;

async function scoreRun(browser, dir) {
  const file = path.resolve(dir, "index.html");
  if (!existsSync(file)) return { run: path.basename(dir), error: "no index.html" };
  const page = await browser.newPage({ viewport: { width: Math.round(root.w), height: Math.round(root.h) }, deviceScaleFactor: 1 });
  try {
    await page.goto("file://" + file, { waitUntil: "load", timeout: 30_000 });
    await page.waitForLoadState("networkidle", { timeout: 5_000 }).catch(() => {});
    await page.evaluate(() => document.fonts.ready);
    const m = await page.evaluate(measure, { layers });
    if (m.error) return { run: path.basename(dir), error: m.error };
    const matched = m.results.map((r, i) => r && { ...r, layer: layers[i], err: Math.max(Math.abs(r.dx), Math.abs(r.dy)) }).filter(Boolean);
    const errs = matched.map((r) => r.err);
    const ys = matched.map((r) => Math.abs(r.dy));
    const all = (r, ok) => r.parts.every(ok);
    const lineOk = (p) => (p.fig.lineHeight == null ? true : p.dom.lineHeight != null && Math.abs(p.dom.lineHeight - p.fig.lineHeight) <= 0.5);
    const out = {
      run: path.basename(path.resolve(dir)),
      layers: layers.length,
      matched_pct: pct(matched.length, layers.length),
      pos_median_px: quantile(errs, 0.5),
      pos_p90_px: quantile(errs, 0.9),
      within_1px_pct: pct(errs.filter((e) => e <= 1).length, layers.length),
      within_4px_pct: pct(errs.filter((e) => e <= 4).length, layers.length),
      // Vertical alone: in single-line rows it doesn't depend on how wide the fallback font is.
      y_p90_px: quantile(ys, 0.9),
      y_within_1px_pct: pct(ys.filter((e) => e <= 1).length, layers.length),
      font_size_pct: pct(matched.filter((r) => all(r, (p) => Math.abs(p.dom.fontSize - p.fig.fontSize) <= 0.05)).length, matched.length),
      weight_pct: pct(matched.filter((r) => all(r, (p) => p.dom.fontWeight === p.fig.fontWeight)).length, matched.length),
      color_pct: pct(matched.filter((r) => all(r, (p) => sameColor(p.dom.color, p.fig.color))).length, matched.length),
      line_height_pct: pct(matched.filter((r) => all(r, lineOk)).length, matched.length),
      unmatched: m.results.map((r, i) => (r ? null : layers[i].text.slice(0, 40))).filter(Boolean),
      extra_texts: m.extra.length,
      extra: m.extra.slice(0, 8),
      worst: matched
        .sort((a, b) => b.err - a.err)
        .slice(0, 5)
        .map((r) => `${r.layer.name} "${r.layer.text.slice(0, 24)}" dx=${r.dx.toFixed(1)} dy=${r.dy.toFixed(1)}`),
    };
    writeFileSync(path.join(dir, "score-text.json"), JSON.stringify({ ...out, layers_detail: matched.map((r) => ({ id: r.layer.id, name: r.layer.name, text: r.layer.text, how: r.how, dx: +r.dx.toFixed(2), dy: +r.dy.toFixed(2), parts: r.parts })) }, null, 1));
    return out;
  } finally {
    await page.close();
  }
}

const browser = await loadChromium();
const results = [];
try {
  for (const d of runs) {
    const r = await scoreRun(browser, d);
    results.push(r);
    console.log(JSON.stringify(r));
  }
} finally {
  await browser.close();
}

console.log(`\n${layers.length} visible text layers in "${root.name}"\n`);
console.log("| run | matched | pos median | pos p90 | ≤1px | ≤4px | y p90 | y ≤1px | size | weight | colour | line-h | extra |");
console.log("|---|---|---|---|---|---|---|---|---|---|---|---|---|");
for (const r of results) {
  if (r.error) console.log(`| ${r.run} | ${r.error} |`);
  else
    console.log(
      `| ${r.run} | ${r.matched_pct}% | ${r.pos_median_px} px | ${r.pos_p90_px} px | ${r.within_1px_pct}% | ${r.within_4px_pct}% | ${r.y_p90_px} px | ${r.y_within_1px_pct}% | ${r.font_size_pct}% | ${r.weight_pct}% | ${r.color_pct}% | ${r.line_height_pct}% | ${r.extra_texts} |`,
    );
}
