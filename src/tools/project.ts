/**
 * What the codebase Lupa runs in already has: colour and font variables, SVG icons and components.
 * `lupa design` points the design at them, so an agent reuses them instead of adding copies.
 */
import { readdir, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ProjectHints } from "../model/render";

export interface ProjectIndex {
  /** #rrggbb or #rrggbbaa → how code refers to it: var(--x), $x, @x, hsl(var(--x)). */
  colors: Map<string, string[]>;
  /** Lower-case font family → references. */
  fonts: Map<string, string[]>;
  /** SVG files by drawing (see `shapeOf`), paths relative to the current directory. */
  icons: Map<string, { file: string; nums: number[] }[]>;
  /** Slug ("search-field") → where it is defined: ".search-field (components/search.css)", "src/SearchField.tsx". */
  components: Map<string, string[]>;
  /** Classes that only set text properties (.t-body { font: 400 14px/17px var(--font-text) }). */
  textStyles: TextStyle[];
}

interface TextStyle {
  ref: string;
  family?: string;
  weight: number;
  italic: boolean;
  size: number;
  /** px, or "normal"; undefined when the rule doesn't say. */
  lineHeight?: number | "normal";
  /** px */
  letterSpacing: number;
  transform: string;
}

/** Properties a text style class may set. */
const TEXT_PROPS = /^(font(-[\w-]+)?|line-height|letter-spacing|text-transform|text-decoration[\w-]*|color|-webkit-font-smoothing|-moz-osx-font-smoothing|text-rendering)$/;

const SKIP_DIRS = new Set([
  "node_modules", "bower_components", "dist", "build", "out", "coverage", "vendor", "target",
  "storybook-static", "__pycache__", "venv", "Pods", "DerivedData", "tmp", "temp",
]);
const STYLE = /\.(css|scss|sass|less|styl|pcss)$/i;
const COMPONENT_FILE = /\.(tsx|jsx|vue|svelte|astro)$/i;
const NOT_COMPONENT = /^(index|page|layout|main|app|route|\+page|\+layout)$|\.(test|spec|stories|story)$/i;
const MAX_ENTRIES = 30000;
const MAX_MS = 2000;

/**
 * Index the project under `root`, leaving out `exclude` (folders Lupa writes to).
 * Undefined for the home folder or the filesystem root, and when nothing usable is found.
 */
export async function scanProject(root: string, exclude: string[] = []): Promise<ProjectIndex | undefined> {
  root = path.resolve(root);
  if (root === path.parse(root).root || root === os.homedir()) return undefined;
  const skip = new Set(exclude.map((e) => path.resolve(e)));
  const styles: string[] = [];
  const svgs: string[] = [];
  const comps: string[] = [];
  const started = Date.now();
  let entries = 0;
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > 10 || entries > MAX_ENTRIES || Date.now() - started > MAX_MS) return;
    let list;
    try {
      list = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries += list.length;
    list.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const e of list) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!e.name.startsWith(".") && !SKIP_DIRS.has(e.name) && !skip.has(p)) await walk(p, depth + 1);
      } else if (e.isFile()) {
        if (STYLE.test(e.name)) styles.push(p);
        else if (/\.svg$/i.test(e.name)) svgs.push(p);
        else if (COMPONENT_FILE.test(e.name)) comps.push(p);
      }
    }
  };
  await walk(root, 0);

  const idx: ProjectIndex = { colors: new Map(), fonts: new Map(), icons: new Map(), components: new Map(), textStyles: [] };
  const rules: { cls: string; decls: string; file: string }[] = [];
  const shown = (p: string) => path.relative(process.cwd(), p).split(path.sep).join("/");
  const add = (m: Map<string, string[]>, key: string, ref: string) => {
    const list = m.get(key) ?? [];
    if (!list.includes(ref)) list.push(ref);
    m.set(key, list);
  };

  // Variables: name → raw value, in file order; aliases (var(--a) → --b) resolved after.
  const vars = new Map<string, string>();
  const classes = new Map<string, string>();
  for (const f of styles.slice(0, 600)) {
    const css = await readText(f, 1_000_000);
    if (!css) continue;
    const text = css.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    // The first definition of a name wins.
    const define = (re: RegExp) => {
      for (const m of text.matchAll(re)) if (!vars.has(m[1]!)) vars.set(m[1]!, m[2]!.trim());
    };
    // Declarations only: `.btn--primary:hover {` is a selector, not a variable.
    define(/(?<=(?:^|[{;])\s*)(--[\w-]+)\s*:\s*([^;{}]+)/g);
    if (/\.(scss|sass)$/i.test(f)) define(/^\s*(\$[\w-]+)\s*:\s*([^;\n]+)/gm);
    if (/\.less$/i.test(f)) define(/^\s*(@[\w-]+)\s*:\s*([^;\n]+)/gm);
    // Class roots ("btn" for .btn--primary, .btn__icon) from selectors only.
    const stem = slug(path.basename(f).replace(/\.[^.]+$/, ""));
    for (const m of text.matchAll(/(?<=^|[{};])\s*\.(-?[_a-zA-Z][\w-]*)\s*\{([^{}]*)\}/g)) {
      if (!/__|--/.test(m[1]!)) rules.push({ cls: m[1]!, decls: m[2]!, file: shown(f) });
    }
    for (const m of text.replace(/url\([^)]*\)/g, "").matchAll(/([^{};]+)\{/g)) {
      for (const c of m[1]!.matchAll(/\.(-?[_a-zA-Z][\w-]*)/g)) {
        const rootClass = c[1]!.split(/__|--/)[0]!;
        if (!classes.has(rootClass) || stem === rootClass) classes.set(rootClass, shown(f));
      }
    }
  }
  const ref = (name: string, wrap?: string) => {
    const r = name.startsWith("--") ? `var(${name})` : name;
    return wrap ? `${wrap}(${r})` : r;
  };
  // Aliases first (--color-bg: var(--white) is the name to use), then plain definitions.
  const resolved: [string, string, boolean][] = [];
  for (const [name, value] of vars) {
    let v = value;
    let alias = false;
    for (let hops = 0; hops < 5; hops++) {
      const a = /^var\(\s*(--[\w-]+)\s*\)$/.exec(v) ?? /^([$@][\w-]+)$/.exec(v);
      const next = a ? vars.get(a[1]!) : undefined;
      if (next === undefined) break;
      v = next;
      alias = true;
    }
    resolved.push([name, v, alias]);
  }
  for (const pass of [true, false]) {
    for (const [name, v, alias] of resolved) {
      if (alias !== pass) continue;
      const c = parseColor(v);
      if (c) add(idx.colors, c.hex, ref(name, c.wrap));
      else if (/font|family|typeface/i.test(name)) {
        const fam = firstFamily(v);
        if (fam && !/^\d|^var\(/.test(fam)) add(idx.fonts, fam, ref(name));
      }
    }
  }

  const family = (v: string | undefined): string | undefined => {
    let x = v?.trim();
    for (let hops = 0; x && hops < 5; hops++) {
      const a = /^var\(\s*(--[\w-]+)\s*(?:,[^)]*)?\)$/.exec(x) ?? /^([$@][\w-]+)$/.exec(x);
      if (!a) break;
      x = vars.get(a[1]!);
    }
    return x ? firstFamily(x) || undefined : undefined;
  };
  for (const r of rules) {
    const t = textStyle(r.decls, family);
    if (t) idx.textStyles.push({ ...t, ref: `.${r.cls} (${r.file})` });
  }

  for (const f of svgs.slice(0, 3000)) {
    const svg = await readText(f, 64_000);
    const s = svg && shapeOf(svg);
    if (!s) continue;
    const list = idx.icons.get(s.key) ?? [];
    list.push({ file: shown(f), nums: s.nums });
    idx.icons.set(s.key, list);
  }

  for (const f of comps) {
    let stem = path.basename(f).replace(/\.[^.]+$/, "");
    if (/^index$/i.test(stem)) stem = path.basename(path.dirname(f));
    if (NOT_COMPONENT.test(stem)) continue;
    add(idx.components, slug(stem), shown(f));
  }
  for (const [c, f] of classes) add(idx.components, c.toLowerCase(), `.${c} (${f})`);

  const empty = !idx.colors.size && !idx.fonts.size && !idx.icons.size && !idx.components.size && !idx.textStyles.length;
  return empty ? undefined : idx;
}

/** `"Inter", system-ui, sans-serif` → "inter". */
function firstFamily(stack: string): string {
  return stack.split(",")[0]!.trim().replace(/^["']|["']$/g, "").toLowerCase();
}

async function readText(file: string, max: number): Promise<string | undefined> {
  try {
    const buf = await readFile(file);
    return buf.length > max ? undefined : buf.toString("utf8");
  } catch {
    return undefined;
  }
}

/** "SearchField", "search_field", "Search field" → "search-field". */
export function slug(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

/* ------------------------------------------------------------------ */
/* Lookups                                                             */
/* ------------------------------------------------------------------ */

/** The project's references for a design colour (#rrggbb or #rrggbbaa); converted values may be 1 off per channel. */
export function colorRefs(idx: ProjectIndex, hex: string): string[] {
  const key = normHex(hex);
  if (!key) return [];
  const exact = idx.colors.get(key);
  if (exact) return exact;
  const want = channels(key);
  for (const [k, refs] of idx.colors) {
    const have = channels(k);
    if (have.length === want.length && have.every((v, i) => Math.abs(v - want[i]!) <= 1)) return refs;
  }
  return [];
}

export function fontRefs(idx: ProjectIndex, family: string): string[] {
  return idx.fonts.get(family.toLowerCase()) ?? [];
}

/** A project SVG that draws the same thing (any colour, stroke width or scale), if there is one. */
export function iconFile(idx: ProjectIndex, svg: string): string | undefined {
  const s = shapeOf(svg);
  if (!s) return undefined;
  return idx.icons.get(s.key)?.find((c) => c.nums.length === s.nums.length && c.nums.every((v, i) => Math.abs(v - s.nums[i]!) <= 0.01))?.file;
}

/** Where the project defines a component named like this Figma one ("Forms/Search field", "Auditor avatar"). */
export function componentRefs(idx: ProjectIndex, figmaName: string): string[] {
  const parts = figmaName.split("/").map((p) => p.trim()).filter(Boolean).reverse();
  const tries = [slug(figmaName), ...parts.map(slug)];
  const last = parts[0]?.split(/\s+/).pop();
  if (last) tries.push(slug(last));
  for (const t of tries) {
    const hit = t && idx.components.get(t);
    if (hit) return hit.slice(0, 3);
  }
  return [];
}

export function projectHints(idx: ProjectIndex): ProjectHints {
  return {
    color: (hex) => colorRefs(idx, hex),
    font: (f) => fontRefs(idx, f),
    component: (name) => componentRefs(idx, name),
    text: (spec) => textRefs(idx, spec),
  };
}

/* ------------------------------------------------------------------ */
/* Text styles                                                         */
/* ------------------------------------------------------------------ */

const WEIGHTS: Record<string, number> = { normal: 400, bold: 700, lighter: 300, bolder: 700 };

/** px of a CSS length; `em` and unitless are relative to `size`, rem to 16px. */
function px(v: string, size: number): number | undefined {
  const m = /^(-?[\d.]+)(px|rem|em|%)?$/.exec(v.trim());
  if (!m) return undefined;
  const x = parseFloat(m[1]!);
  return m[2] === "px" ? x : m[2] === "rem" ? x * 16 : m[2] === "%" ? (x * size) / 100 : x * size;
}

/** A rule that only sets text properties, as a text style; undefined for anything else or without a size. */
function textStyle(decls: string, family: (v: string | undefined) => string | undefined): Omit<TextStyle, "ref"> | undefined {
  const d: Record<string, string> = {};
  for (const part of decls.split(";")) {
    const i = part.indexOf(":");
    if (i < 0) continue;
    const k = part.slice(0, i).trim().toLowerCase();
    if (!k) continue;
    if (!TEXT_PROPS.test(k)) return undefined;
    d[k] = part.slice(i + 1).replace(/!important/i, "").trim();
  }
  let fam = d["font-family"];
  let weight = d["font-weight"];
  let style = d["font-style"];
  let size = d["font-size"];
  let lh = d["line-height"];
  if (d.font) {
    const m = /^(?:(italic|oblique|normal)\s+)?(?:(normal|bold|bolder|lighter|\d{3})\s+)?([\d.]+(?:px|rem|em))(?:\s*\/\s*([\d.]+(?:px|rem|em|%)?|normal))?\s+(.+)$/.exec(d.font);
    if (!m) return undefined;
    [style, weight, size, lh, fam] = [m[1] ?? style, m[2] ?? weight, m[3], m[4] ?? lh, m[5]];
  }
  const fontSize = size ? px(size, 16) : undefined;
  if (!fontSize) return undefined;
  const w = weight ? (WEIGHTS[weight] ?? parseInt(weight, 10)) : 400;
  const ls = d["letter-spacing"] && d["letter-spacing"] !== "normal" ? px(d["letter-spacing"], fontSize) : 0;
  return {
    family: family(fam),
    weight: w,
    italic: /italic|oblique/.test(style ?? ""),
    size: fontSize,
    lineHeight: lh === undefined ? undefined : lh === "normal" ? "normal" : px(lh, fontSize),
    letterSpacing: ls ?? 0,
    transform: d["text-transform"] ?? "none",
  };
}

/**
 * Classes matching a typography spec as Lupa prints it:
 * `Family 500 [italic] ["Style"] 14/normal≈17 [ls:0.6px|0.05em] [uppercase]`.
 */
export function textRefs(idx: ProjectIndex, spec: string): string[] {
  const m = /^(?<family>.+?) (?<weight>\d+)(?<italic> italic)?(?: "[^"]*")? (?<size>[\d.]+)\/(?<lh>normal|[\d.]+%?)(?:≈(?<measured>[\d.]+))?(?<rest>.*)$/.exec(spec);
  if (!m?.groups) return [];
  const g = m.groups as { family: string; weight: string; italic?: string; size: string; lh: string; measured?: string; rest: string };
  const size = parseFloat(g.size);
  // Line height in px: Figma's measured one first; an unmeasured "normal" stays unknown.
  let lh: number | undefined;
  if (g.measured) lh = parseFloat(g.measured);
  else if (g.lh.endsWith("%")) lh = (parseFloat(g.lh) * size) / 100;
  else if (g.lh !== "normal") lh = parseFloat(g.lh);
  const lsm = /\bls:(-?[\d.]+)(px|em)/.exec(g.rest);
  const ls = lsm ? (lsm[2] === "em" ? parseFloat(lsm[1]!) * size : parseFloat(lsm[1]!)) : 0;
  const transform = /\b(uppercase|lowercase|capitalize)\b/.exec(g.rest)?.[1] ?? "none";
  const fam = g.family.toLowerCase();
  return idx.textStyles
    .filter((t) => {
      if (t.size !== size && Math.abs(t.size - size) > 0.01) return false;
      if (t.weight !== Number(g.weight) || t.italic !== !!g.italic || t.transform !== transform) return false;
      if (Math.abs(t.letterSpacing - ls) > 0.05) return false;
      // A rule without a family inherits one: only an exact line height makes it this style.
      if (t.family ? t.family !== fam : typeof t.lineHeight !== "number") return false;
      if (t.lineHeight === "normal") return g.lh === "normal";
      // An unmeasured "normal" can't be checked against a rule's line height.
      if (lh === undefined) return true;
      return typeof t.lineHeight === "number" && Math.abs(t.lineHeight - lh) <= 0.5;
    })
    .map((t) => t.ref)
    .slice(0, 3);
}

/* ------------------------------------------------------------------ */
/* Colours                                                             */
/* ------------------------------------------------------------------ */

const hex2 = (v: number) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, "0");

function normHex(h: string): string | undefined {
  const m = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(h.trim());
  if (!m) return undefined;
  let s = m[1]!.toLowerCase();
  if (s.length <= 4) s = [...s].map((c) => c + c).join("");
  return s.length === 8 && s.endsWith("ff") ? `#${s.slice(0, 6)}` : `#${s}`;
}

function channels(hex: string): number[] {
  const s = hex.slice(1);
  const out: number[] = [];
  for (let i = 0; i < s.length; i += 2) out.push(parseInt(s.slice(i, i + 2), 16));
  return out;
}

function toHex(r: number, g: number, b: number, a = 1): string {
  return `#${hex2(r)}${hex2(g)}${hex2(b)}${a < 0.999 ? hex2(a * 255) : ""}`;
}

const pct = (s: string, full: number) => (s.endsWith("%") ? (parseFloat(s) / 100) * full : parseFloat(s));

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const k = (n: number) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return [f(0) * 255, f(8) * 255, f(4) * 255];
}

function oklchToRgb(l: number, c: number, h: number): [number, number, number] {
  const hr = (h * Math.PI) / 180;
  const a = c * Math.cos(hr);
  const b = c * Math.sin(hr);
  const l_ = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m_ = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s_ = (l - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const lin = [
    4.0767416621 * l_ - 3.3077115913 * m_ + 0.2309699292 * s_,
    -1.2684380046 * l_ + 2.6097574011 * m_ - 0.3413193965 * s_,
    -0.0041960863 * l_ - 0.7034186147 * m_ + 1.707614701 * s_,
  ];
  const gamma = (x: number) => (x <= 0.0031308 ? 12.92 * x : 1.055 * x ** (1 / 2.4) - 0.055) * 255;
  return [gamma(lin[0]!), gamma(lin[1]!), gamma(lin[2]!)];
}

/** A CSS colour value as hex, and the function code wraps a bare-channel variable in (shadcn's `--x: 0 0% 100%`). */
export function parseColor(value: string): { hex: string; wrap?: string } | undefined {
  const v = value.replace(/!important/i, "").trim().toLowerCase();
  const hex = normHex(v);
  if (hex) return { hex };
  if (v === "white") return { hex: "#ffffff" };
  if (v === "black") return { hex: "#000000" };
  const fn = /^(rgba?|hsla?|oklch)\(\s*([^)]*)\)$/.exec(v);
  const bare = /^(-?[\d.]+)(?:deg)?\s+([\d.]+%)\s+([\d.]+%)$/.exec(v);
  const args = fn ? fn[2]!.split(/[\s,/]+/).filter(Boolean) : bare ? [bare[1]!, bare[2]!, bare[3]!] : undefined;
  if (!args || args.length < 3 || args.some((a) => !/^-?[\d.]+(%|deg)?$/.test(a))) return undefined;
  const alpha = args[3] !== undefined ? pct(args[3], 1) : 1;
  const kind = fn ? fn[1]!.replace(/a$/, "") : "hsl";
  let rgb: [number, number, number];
  if (kind === "rgb") rgb = [pct(args[0]!, 255), pct(args[1]!, 255), pct(args[2]!, 255)];
  else if (kind === "hsl") rgb = hslToRgb(parseFloat(args[0]!), pct(args[1]!, 1), pct(args[2]!, 1));
  else rgb = oklchToRgb(pct(args[0]!, 1), pct(args[1]!, 0.4), parseFloat(args[2]!));
  return { hex: toHex(...rgb, alpha), ...(bare ? { wrap: "hsl" } : {}) };
}

/* ------------------------------------------------------------------ */
/* Icon drawings                                                       */
/* ------------------------------------------------------------------ */

/**
 * An SVG's drawing, independent of colour, stroke width and size: the visible shapes' commands
 * (`key`) and their coordinates as fractions of the viewBox (`nums`). Paths are made absolute,
 * so "l5 5" and "L10 12" from different exporters compare equal. Masks and clip paths don't count.
 */
export function shapeOf(svg: string): { key: string; nums: number[] } | undefined {
  const rootTag = /<svg\b[^>]*>/i.exec(svg)?.[0];
  if (!rootTag) return undefined;
  const root = attrs(rootTag);
  const vb = (root.viewBox ?? `0 0 ${parseFloat(root.width ?? "")} ${parseFloat(root.height ?? "")}`).split(/[\s,]+/).map(Number);
  const [vx, vy, vw, vh] = vb as [number, number, number, number];
  if (vb.length !== 4 || !(vw > 0) || !(vh > 0)) return undefined;
  const body = svg.replace(/<(mask|clipPath|defs|title|desc)\b[\s\S]*?<\/\1>/gi, "");
  // Coordinates as fractions of the viewBox; sizes as fractions of its width; flags and angles as they are.
  const scaled: Record<Val[1], (v: number) => number> = { x: (v) => (v - vx) / vw, y: (v) => (v - vy) / vh, s: (v) => v / vw, r: (v) => v };
  const keys: string[] = [];
  const nums: number[] = [];
  for (const m of body.matchAll(/<(path|rect|circle|ellipse|line|polyline|polygon)\b([^>]*)>/gi)) {
    const a = attrs(m[2]!);
    const fill = a.fill ?? root.fill ?? "black";
    const stroke = a.stroke ?? root.stroke ?? "none";
    if ((fill === "none" || fill === "transparent") && (stroke === "none" || stroke === "transparent")) continue;
    if (a.opacity === "0" || a.visibility === "hidden" || a.display === "none") continue;
    const g = geometry(m[1]!.toLowerCase(), a);
    if (!g) return undefined;
    keys.push(g.key);
    for (const [v, axis] of g.vals) nums.push(scaled[axis](v));
  }
  return keys.length ? { key: keys.join("|"), nums } : undefined;
}

function attrs(tag: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of tag.matchAll(/([\w:-]+)\s*=\s*("([^"]*)"|'([^']*)')/g)) out[m[1]!] = m[3] ?? m[4] ?? "";
  // style="fill:none;stroke:#000" counts like the attributes.
  for (const d of (out.style ?? "").split(";")) {
    const [k, v] = d.split(":").map((s) => s?.trim());
    if (k && v) out[k] = v;
  }
  return out;
}

type Val = [number, "x" | "y" | "s" | "r"];

function geometry(tag: string, a: Record<string, string>): { key: string; vals: Val[] } | undefined {
  const f = (k: string) => parseFloat(a[k] ?? "0") || 0;
  switch (tag) {
    case "path":
      return a.d ? absolutePath(a.d) : undefined;
    case "rect":
      return { key: "R", vals: [[f("x"), "x"], [f("y"), "y"], [f("width"), "s"], [f("height"), "s"], [f("rx") || f("ry"), "s"]] };
    case "circle":
      return { key: "O", vals: [[f("cx"), "x"], [f("cy"), "y"], [f("r"), "s"]] };
    case "ellipse":
      return { key: "E", vals: [[f("cx"), "x"], [f("cy"), "y"], [f("rx"), "s"], [f("ry"), "s"]] };
    case "line":
      return { key: "ML", vals: [[f("x1"), "x"], [f("y1"), "y"], [f("x2"), "x"], [f("y2"), "y"]] };
    default: {
      const pts = (a.points ?? "").trim().split(/[\s,]+/).map(Number);
      if (pts.length < 4 || pts.some(Number.isNaN)) return undefined;
      const vals: Val[] = pts.map((v, i) => [v, i % 2 ? "y" : "x"]);
      return { key: "M" + "L".repeat(pts.length / 2 - 1) + (tag === "polygon" ? "Z" : ""), vals };
    }
  }
}

const ARGS: Record<string, number> = { M: 2, L: 2, H: 1, V: 1, C: 6, S: 4, Q: 4, T: 2, A: 7, Z: 0 };

/** Path data with every command absolute; H and V become L. */
function absolutePath(d: string): { key: string; vals: Val[] } | undefined {
  const NUM = /[\s,]*(-?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?)/y;
  const FLAG = /[\s,]*([01])/y;
  const CMD = /[\s,]*([MmLlHhVvCcSsQqTtAaZz])/y;
  let i = 0;
  const read = (re: RegExp): string | undefined => {
    re.lastIndex = i;
    const m = re.exec(d);
    if (!m) return undefined;
    i = re.lastIndex;
    return m[1];
  };
  const atEnd = () => /^[\s,]*$/.test(d.slice(i));
  let key = "";
  const vals: Val[] = [];
  let x = 0, y = 0, sx = 0, sy = 0;
  let cmd = "";
  while (i < d.length) {
    const c = read(CMD);
    if (c) cmd = c;
    else if (!cmd || /[Zz]/.test(cmd)) {
      if (atEnd()) break;
      return undefined;
    } else if (cmd === "M") cmd = "L";
    else if (cmd === "m") cmd = "l";
    const up = cmd.toUpperCase();
    const rel = cmd !== up;
    if (up === "Z") {
      key += "Z";
      x = sx;
      y = sy;
      continue;
    }
    const n: number[] = [];
    for (let k = 0; k < ARGS[up]!; k++) {
      const s = up === "A" && (k === 3 || k === 4) ? read(FLAG) : read(NUM);
      // Only separators after the last repeated command end the path; anything else is malformed.
      if (s === undefined) return k === 0 && !c && atEnd() ? { key, vals } : undefined;
      n.push(Number(s));
    }
    const ox = rel ? x : 0;
    const oy = rel ? y : 0;
    if (up === "H") {
      x = n[0]! + ox;
      key += "L";
      vals.push([x, "x"], [y, "y"]);
    } else if (up === "V") {
      y = n[0]! + oy;
      key += "L";
      vals.push([x, "x"], [y, "y"]);
    } else if (up === "A") {
      x = n[5]! + ox;
      y = n[6]! + oy;
      key += "A";
      vals.push([n[0]!, "s"], [n[1]!, "s"], [n[2]!, "r"], [n[3]!, "r"], [n[4]!, "r"], [x, "x"], [y, "y"]);
    } else {
      for (let k = 0; k < n.length; k += 2) vals.push([n[k]! + ox, "x"], [n[k + 1]! + oy, "y"]);
      x = n[n.length - 2]! + ox;
      y = n[n.length - 1]! + oy;
      key += up;
      if (up === "M") {
        sx = x;
        sy = y;
      }
    }
  }
  return { key, vals };
}
