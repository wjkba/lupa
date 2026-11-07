/** Screenshots, asset export and design-vs-implementation comparison. */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Bridge } from "../bridge/hub";
import { isDefaultName, slug } from "../model/build";
import { n } from "../model/css";
import type { RawNode, RawSnapshot } from "../shared/raw";
import { crop, decodePng, diff, encodePng, flatten, isDiffPixel, resize, sideBySide, tiles, VISION_MAX_EDGE, type Raster } from "../image/png";

/** Text for the agent plus PNG images (vision-sized). */
export interface Visual {
  text: string;
  images: Buffer[];
}

/* ------------------------------------------------------------------ */
/* Screenshot                                                          */
/* ------------------------------------------------------------------ */

export async function screenshot(
  bridge: Bridge,
  ids: string[],
  file: string | undefined,
  opts: { scale?: number; saveTo?: string },
): Promise<Visual> {
  const head = await bridge.request("snapshot", { ids, depth: 0, components: false }, file);
  const lines: string[] = [];
  const images: Buffer[] = [];
  for (const root of head.roots) {
    // Retina by default, but never wider than the model can see without downscaling.
    const scale = opts.scale ?? Math.max(0.1, Math.min(2, VISION_MAX_EDGE / Math.max(root.w, 1)));
    const res = await bridge.request("export", { ids: [root.id], format: "PNG", scale, exactBounds: true }, file);
    if (res.errors.length) {
      lines.push(`#${root.id}: ${res.errors[0]!.error}`);
      continue;
    }
    const buf = Buffer.from(res.blobs[0]!.data, "base64");
    const raster = decodePng(buf);
    if (opts.saveTo) {
      const target = ids.length > 1 || head.roots.length > 1 ? withSuffix(opts.saveTo, slug(root.name) || root.id) : opts.saveTo;
      await mkdir(path.dirname(path.resolve(target)), { recursive: true });
      await writeFile(target, buf);
      lines.push(`saved ${path.resolve(target)} (${raster.width}×${raster.height}px)`);
    }
    const parts = tiles(raster);
    const visionScale = scale * parts[0]!.scale;
    lines.push(
      `"${root.name}" #${root.id} ${n(root.w)}×${n(root.h)} → ${parts.length} image${parts.length > 1 ? "s" : ""}, 1 design px = ${n(visionScale)} image px` +
        (parts.length > 1 ? ` (tiles top to bottom, starting at y=${parts.map((p) => n(p.y)).join(", ")})` : ""),
    );
    for (const p of parts) images.push(encodePng(p.tile));
  }
  if (head.missing.length) lines.push(`not found: ${head.missing.join(", ")}`);
  return { text: lines.join("\n"), images };
}

function withSuffix(file: string, suffix: string): string {
  const ext = path.extname(file) || ".png";
  return `${file.slice(0, file.length - path.extname(file).length)}-${suffix}${ext}`;
}

/* ------------------------------------------------------------------ */
/* Assets                                                              */
/* ------------------------------------------------------------------ */

interface GraphicAsset {
  nodeId: string;
  name: string;
  /** File name stem: the layer's own name, or its nearest meaningfully named ancestor's. */
  base: string;
  uses: number;
}

interface ImageAsset {
  hash: string;
  name: string;
  base: string;
  nodeId: string;
  uses: number;
}

/** Names that make poor file names: Figma's defaults and generic wrappers. */
const VAGUE_NAME = /^(container|wrapper|content|inner|box|div|layer)(\s+\d+)?$/i;
const meaningful = (name: string) => !!name.trim() && !isDefaultName(name) && !VAGUE_NAME.test(name.trim());

function collect(snap: RawSnapshot): { graphics: Map<string, GraphicAsset>; images: Map<string, ImageAsset> } {
  const graphics = new Map<string, GraphicAsset>();
  const images = new Map<string, ImageAsset>();
  const walk = (node: RawNode, context: string | undefined) => {
    if (node.stub) return;
    const base = (name: string) => (meaningful(name) ? name : (context ?? name));
    if (node.graphic) {
      const c = node.mainComponentId ? snap.components[node.mainComponentId] : undefined;
      const key = c ? `c:${c.id}` : `n:${node.id}`;
      const name = c ? (c.setName ? `${c.setName} ${Object.values(c.variant ?? {}).join(" ")}` : c.name) : node.name;
      const g = graphics.get(key);
      if (g) g.uses++;
      else graphics.set(key, { nodeId: node.id, name, base: base(name), uses: 1 });
      return;
    }
    for (const p of node.fills ?? []) {
      if (p.type !== "IMAGE" || p.visible === false || !p.imageHash) continue;
      const img = images.get(p.imageHash);
      if (img) img.uses++;
      else images.set(p.imageHash, { hash: p.imageHash, name: node.name, base: base(node.name), nodeId: node.id, uses: 1 });
    }
    const inner = meaningful(node.name) ? node.name : context;
    node.children?.forEach((c) => walk(c, inner));
  };
  snap.roots.forEach((r) => walk(r, undefined));
  return { graphics, images };
}

function imageExt(buf: Buffer): string {
  if (buf.readUInt32BE(0) === 0x89504e47) return "png";
  if (buf[0] === 0xff && buf[1] === 0xd8) return "jpg";
  if (buf.toString("ascii", 0, 3) === "GIF") return "gif";
  if (buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP") return "webp";
  return "bin";
}

/** Replace the only colour of a monochrome SVG with currentColor. */
export function toCurrentColor(svg: string): string {
  const colors = new Set([...svg.matchAll(/(?:fill|stroke)="(#[0-9a-fA-F]{3,8}|black|white)"/g)].map((m) => m[1]!.toLowerCase()));
  if (colors.size !== 1) return svg;
  const [c] = [...colors];
  return svg.replace(new RegExp(`(fill|stroke)="${c!.replace("#", "\\#")}"`, "gi"), '$1="currentColor"');
}

export async function exportAssets(
  bridge: Bridge,
  ids: string[],
  file: string | undefined,
  opts: { dir: string; as: "auto" | "svg" | "png"; scale?: number; currentColor?: boolean },
): Promise<string> {
  const dir = path.resolve(opts.dir);
  await mkdir(dir, { recursive: true });
  const taken = new Set<string>();
  const fileName = (base: string, ext: string) => {
    const stem = slug(base) || "asset";
    let name = `${stem}.${ext}`;
    for (let i = 2; taken.has(name); i++) name = `${stem}-${i}.${ext}`;
    taken.add(name);
    return name;
  };
  const lines: string[] = [];

  if (opts.as !== "auto") {
    // Export the given layers themselves.
    const fmt = opts.as === "svg" ? "SVG" : "PNG";
    const res = await bridge.request("export", { ids, format: fmt, scale: opts.scale ?? 2 }, file);
    for (const b of res.blobs) {
      const name = fileName(b.name, opts.as);
      const data = b.encoding === "utf8" ? (opts.currentColor ? toCurrentColor(b.data) : b.data) : Buffer.from(b.data, "base64");
      await writeFile(path.join(dir, name), data);
      lines.push(`${name} ← "${b.name}" #${b.id} ${n(b.w)}×${n(b.h)}${opts.as === "png" ? ` @${opts.scale ?? 2}x` : ""}`);
    }
    for (const e of res.errors) lines.push(`failed #${e.id}: ${e.error}`);
    return [`Wrote ${res.blobs.length} file(s) to ${dir}`, ...lines].join("\n");
  }

  const snap = await bridge.request("snapshot", { ids, components: false, maxNodes: 50000 }, file);
  const { graphics, images } = collect(snap);
  if (!graphics.size && !images.size) {
    return `No vector graphics or image fills under ${ids.join(", ")}. To export the layers themselves, call again with as:"png" or as:"svg".`;
  }

  // Different layers often draw the same icon: write each distinct SVG once.
  const written = new Map<string, { line: number; uses: number; also: string[] }>();
  const gl = [...graphics.values()];
  for (let i = 0; i < gl.length; i += 40) {
    const batch = gl.slice(i, i + 40);
    const res = await bridge.request("export", { ids: batch.map((g) => g.nodeId), format: "SVG" }, file);
    const byId = new Map(res.blobs.map((b) => [b.id, b]));
    for (const g of batch) {
      const b = byId.get(g.nodeId);
      if (!b) {
        lines.push(`failed svg "${g.name}" #${g.nodeId}: ${res.errors.find((e) => e.id === g.nodeId)?.error ?? "no data"}`);
        continue;
      }
      const svg = opts.currentColor ? toCurrentColor(b.data) : b.data;
      const same = written.get(svg);
      if (same) {
        same.uses += g.uses;
        same.also.push(`#${g.nodeId}`);
        continue;
      }
      const name = fileName(g.base, "svg");
      await writeFile(path.join(dir, name), svg);
      written.set(svg, { line: lines.length, uses: g.uses, also: [] });
      lines.push(`${name} ← svg "${g.name}" #${g.nodeId} ${n(b.w)}×${n(b.h)}`);
    }
  }
  for (const w of written.values()) {
    if (w.uses < 2) continue;
    const also = w.also.length > 12 ? [...w.also.slice(0, 12), `+${w.also.length - 12}`] : w.also;
    lines[w.line] += ` (used ${w.uses}×${also.length ? `; also for ${also.join(" ")}` : ""})`;
  }

  const il = [...images.values()];
  for (let i = 0; i < il.length; i += 8) {
    const batch = il.slice(i, i + 8);
    const res = await bridge.request("imageBytes", { hashes: batch.map((x) => x.hash) }, file);
    const byHash = new Map(res.images.map((x) => [x.hash, x]));
    for (const img of batch) {
      const got = byHash.get(img.hash);
      if (!got) {
        lines.push(`failed image ${img.hash.slice(0, 10)} ("${img.name}"): ${res.errors.find((e) => e.hash === img.hash)?.error ?? "no data"}`);
        continue;
      }
      const buf = Buffer.from(got.data, "base64");
      const name = fileName(img.base, imageExt(buf));
      await writeFile(path.join(dir, name), buf);
      lines.push(`${name} ← src:${img.hash.slice(0, 10)} "${img.name}" #${img.nodeId}${got.w ? ` ${got.w}×${got.h}px original` : ""}${img.uses > 1 ? ` (used ${img.uses}×)` : ""}`);
    }
  }
  return [`Wrote ${lines.filter((l) => !l.startsWith("failed")).length} file(s) to ${dir}`, ...lines].join("\n");
}

/* ------------------------------------------------------------------ */
/* Compare                                                             */
/* ------------------------------------------------------------------ */

interface Box {
  node: RawNode;
  x: number;
  y: number;
  w: number;
  h: number;
  depth: number;
}

function boxes(root: RawNode): Box[] {
  const out: Box[] = [];
  const [ox, oy] = root.bb ?? [0, 0];
  const walk = (node: RawNode, depth: number) => {
    if (node.stub || !node.bb) return;
    out.push({ node, x: node.bb[0] - ox, y: node.bb[1] - oy, w: node.bb[2], h: node.bb[3], depth });
    node.children?.forEach((c) => walk(c, depth + 1));
  };
  walk(root, 0);
  return out;
}

/** The most specific layer under a point (smallest box, deepest on ties). */
function layerAt(list: Box[], x: number, y: number): Box | undefined {
  let best: Box | undefined;
  for (const b of list) {
    if (x < b.x || y < b.y || x > b.x + b.w || y > b.y + b.h) continue;
    if (!best || b.w * b.h < best.w * best.h || (b.w * b.h === best.w * best.h && b.depth > best.depth)) best = b;
  }
  return best;
}

/** Differing pixels inside text layers (padded by 2 design px for glyph overhang). */
function textMismatch(diffImg: Raster, list: Box[], scale: number): number {
  const { width, height, data } = diffImg;
  const mask = new Uint8Array(width * height);
  const pad = 2;
  for (const b of list) {
    if (b.node.type !== "TEXT") continue;
    const x0 = Math.max(0, Math.floor((b.x - pad) * scale));
    const x1 = Math.min(width, Math.ceil((b.x + b.w + pad) * scale));
    const y0 = Math.max(0, Math.floor((b.y - pad) * scale));
    const y1 = Math.min(height, Math.ceil((b.y + b.h + pad) * scale));
    for (let y = y0; y < y1; y++) mask.fill(1, y * width + x0, y * width + Math.max(x0, x1));
  }
  let count = 0;
  for (let p = 0; p < mask.length; p++) if (mask[p] && isDiffPixel(data, p * 4)) count++;
  return count;
}

/** Font families used by the text layers under `root`. */
export function fontFamilies(root: RawNode): string[] {
  const out = new Set<string>();
  const walk = (node: RawNode) => {
    node.segments?.forEach((s) => out.add(s.fontFamily));
    node.children?.forEach(walk);
  };
  walk(root);
  return [...out];
}

/** Diff an implementation PNG against `root` (a snapshot without components) exported at the same width. */
export async function compare(
  bridge: Bridge,
  root: RawNode,
  file: string | undefined,
  opts: { image: string | Buffer; threshold?: number; saveDiff?: string; note?: string },
): Promise<Visual> {
  const actualBuf = typeof opts.image === "string" ? await readFile(opts.image) : opts.image;
  const actual = flatten(decodePng(actualBuf));
  const res = await bridge.request("export", { ids: [root.id], format: "PNG", width: actual.width, exactBounds: true }, file);
  if (!res.blobs.length) throw new Error(res.errors[0]?.error ?? "export failed");
  let design = flatten(decodePng(Buffer.from(res.blobs[0]!.data, "base64")));
  if (design.width !== actual.width) design = resize(design, actual.width, (design.height * actual.width) / design.width);

  const scale = actual.width / root.w;
  const lines: string[] = [];
  lines.push(`design "${root.name}" #${root.id} ${n(root.w)}×${n(root.h)} at ${n(scale)}x = ${design.width}×${design.height}px; implementation ${actual.width}×${actual.height}px`);
  const h = Math.min(design.height, actual.height);
  if (Math.abs(design.height - actual.height) > 1) {
    const dh = (actual.height - design.height) / scale;
    lines.push(
      `height differs by ${n(dh)} design px (${dh > 0 ? "implementation taller" : "implementation shorter"}) — compared the top ${n(h / scale)} px. Usually spacing, line-height or a wrapped line.`,
    );
  }
  const a = crop(design, 0, 0, design.width, h);
  const b = crop(actual, 0, 0, actual.width, h);
  const d = diff(a, b, opts.threshold ?? 0.1);
  lines.push(`mismatch: ${n(d.ratio * 100)}% of pixels (${d.mismatched}/${d.total})${d.ratio < 0.005 ? " — visually matching" : ""}`);

  const list = boxes(root);
  if (d.mismatched) {
    const inText = textMismatch(d.diff, list, scale);
    const other = d.mismatched - inText;
    lines.push(
      `  ${inText} px inside text layers (glyph rendering, a fallback font or different text); ${other} px elsewhere` +
        (other / d.total < 0.001 ? " — layout and non-text layers match" : ""),
    );
  }
  if (opts.note) lines.push(`  ${opts.note}`);
  // Non-text regions first: they are layout or styling problems, while text regions are often only font rendering.
  const located = d.regions.map((r) => ({ r, hit: layerAt(list, (r.x + r.w / 2) / scale, (r.y + r.h / 2) / scale) }));
  located.sort((p, q) => Number(p.hit?.node.type === "TEXT") - Number(q.hit?.node.type === "TEXT"));
  for (const { r, hit } of located.slice(0, 10)) {
    const name = hit && hit.node.name.length > 40 ? `${hit.node.name.slice(0, 39)}…` : hit?.node.name;
    const where = hit ? ` ~ ${hit.node.type.toLowerCase()} "${name}" #${hit.node.id}` : "";
    lines.push(`  region ${n(r.x / scale)},${n(r.y / scale)} ${n(r.w / scale)}×${n(r.h / scale)} (design px), ${r.pixels} px differ${where}`);
  }
  if (d.regions.length > 10) lines.push(`  … +${d.regions.length - 10} smaller regions`);

  let strip: Raster = sideBySide([a, b, d.diff]);
  if (opts.saveDiff) {
    await mkdir(path.dirname(path.resolve(opts.saveDiff)), { recursive: true });
    await writeFile(opts.saveDiff, encodePng(strip));
    lines.push(`saved ${path.resolve(opts.saveDiff)}`);
  }
  if (strip.width > VISION_MAX_EDGE || strip.height > VISION_MAX_EDGE) {
    const s = Math.min(VISION_MAX_EDGE / strip.width, VISION_MAX_EDGE / strip.height);
    strip = resize(strip, strip.width * s, strip.height * s);
  }
  lines.push("image: design | implementation | diff (red = different)");
  return { text: lines.join("\n"), images: [encodePng(strip)] };
}
