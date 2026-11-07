/**
 * Minimal raster helpers for screenshots: decode/encode PNG, resample, crop,
 * split tall images into tiles the model can read, and diff two renders.
 */

import pixelmatch from "pixelmatch";
import { PNG } from "pngjs";

export interface Raster {
  width: number;
  height: number;
  data: Buffer;
}

/** Long edge above which Claude's vision input is downscaled anyway. */
export const VISION_MAX_EDGE = 1568;

export function decodePng(buf: Buffer): Raster {
  const png = PNG.sync.read(buf);
  return { width: png.width, height: png.height, data: png.data };
}

export function encodePng(r: Raster): Buffer {
  const png = new PNG({ width: r.width, height: r.height });
  r.data.copy(png.data);
  return PNG.sync.write(png, { colorType: 6 });
}

export function isPng(buf: Buffer): boolean {
  return buf.length > 8 && buf.readUInt32BE(0) === 0x89504e47;
}

/** Area-average resample (good quality when shrinking, bilinear-ish when growing). */
export function resize(src: Raster, width: number, height: number): Raster {
  width = Math.max(1, Math.round(width));
  height = Math.max(1, Math.round(height));
  if (width === src.width && height === src.height) return src;
  const out = Buffer.alloc(width * height * 4);
  const sx = src.width / width;
  const sy = src.height / height;
  for (let y = 0; y < height; y++) {
    const y0 = y * sy;
    const y1 = Math.min(src.height, y0 + Math.max(sy, 1));
    for (let x = 0; x < width; x++) {
      const x0 = x * sx;
      const x1 = Math.min(src.width, x0 + Math.max(sx, 1));
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      let wsum = 0;
      for (let yy = Math.floor(y0); yy < Math.ceil(y1); yy++) {
        const wy = Math.min(yy + 1, y1) - Math.max(yy, y0);
        if (wy <= 0) continue;
        for (let xx = Math.floor(x0); xx < Math.ceil(x1); xx++) {
          const wx = Math.min(xx + 1, x1) - Math.max(xx, x0);
          if (wx <= 0) continue;
          const w = wx * wy;
          const i = (yy * src.width + xx) * 4;
          const al = src.data[i + 3]! / 255;
          // Premultiply so transparent pixels do not darken edges.
          r += src.data[i]! * al * w;
          g += src.data[i + 1]! * al * w;
          b += src.data[i + 2]! * al * w;
          a += al * w;
          wsum += w;
        }
      }
      const o = (y * width + x) * 4;
      if (a > 0) {
        out[o] = Math.round(r / a);
        out[o + 1] = Math.round(g / a);
        out[o + 2] = Math.round(b / a);
      }
      out[o + 3] = wsum > 0 ? Math.round((a / wsum) * 255) : 0;
    }
  }
  return { width, height, data: out };
}

export function crop(src: Raster, x: number, y: number, w: number, h: number): Raster {
  x = Math.max(0, Math.floor(x));
  y = Math.max(0, Math.floor(y));
  w = Math.max(1, Math.min(src.width - x, Math.floor(w)));
  h = Math.max(1, Math.min(src.height - y, Math.floor(h)));
  const out = Buffer.alloc(w * h * 4);
  for (let row = 0; row < h; row++) {
    src.data.copy(out, row * w * 4, ((y + row) * src.width + x) * 4, ((y + row) * src.width + x + w) * 4);
  }
  return { width: w, height: h, data: out };
}

/** Composite onto an opaque background (diffs and vision both want opaque pixels). */
export function flatten(src: Raster, bg: [number, number, number] = [255, 255, 255]): Raster {
  const out = Buffer.alloc(src.data.length);
  for (let i = 0; i < src.data.length; i += 4) {
    const a = src.data[i + 3]! / 255;
    out[i] = Math.round(src.data[i]! * a + bg[0] * (1 - a));
    out[i + 1] = Math.round(src.data[i + 1]! * a + bg[1] * (1 - a));
    out[i + 2] = Math.round(src.data[i + 2]! * a + bg[2] * (1 - a));
    out[i + 3] = 255;
  }
  return { width: src.width, height: src.height, data: out };
}

/**
 * Split a render into tiles no larger than `maxEdge` on either side, scaling
 * down only as much as the width requires. Tall pages stay legible instead of
 * being squashed into one tiny image.
 */
export function tiles(src: Raster, maxEdge = VISION_MAX_EDGE, maxTiles = 6): { tile: Raster; y: number; scale: number }[] {
  let img = src;
  let scale = 1;
  if (img.width > maxEdge) {
    scale = maxEdge / img.width;
    img = resize(img, maxEdge, img.height * scale);
  }
  let count = Math.ceil(img.height / maxEdge);
  if (count > maxTiles) {
    // Too tall even for several tiles: shrink further so it fits in maxTiles.
    const s2 = (maxEdge * maxTiles) / img.height;
    img = resize(img, img.width * s2, img.height * s2);
    scale *= s2;
    count = Math.ceil(img.height / maxEdge);
  }
  const out: { tile: Raster; y: number; scale: number }[] = [];
  for (let i = 0; i < count; i++) {
    const y = i * maxEdge;
    out.push({ tile: crop(img, 0, y, img.width, Math.min(maxEdge, img.height - y)), y: y / scale, scale });
  }
  return out;
}

export interface DiffRegion {
  x: number;
  y: number;
  w: number;
  h: number;
  pixels: number;
}

export interface DiffResult {
  mismatched: number;
  total: number;
  ratio: number;
  diff: Raster;
  regions: DiffRegion[];
}

/** Pixel diff of two same-size rasters, with mismatches grouped into rectangles. */
export function diff(a: Raster, b: Raster, threshold = 0.1): DiffResult {
  const out = Buffer.alloc(a.width * a.height * 4);
  const mismatched = pixelmatch(a.data, b.data, out, a.width, a.height, { threshold, includeAA: false, alpha: 0.3, diffColor: [255, 0, 80] });
  const total = a.width * a.height;
  return { mismatched, total, ratio: mismatched / total, diff: { width: a.width, height: a.height, data: out }, regions: regionsOf(out, a.width, a.height) };
}

/** True when pixel offset `i` of a diff() raster is a mismatch (pixelmatch paints them in diffColor). */
export function isDiffPixel(data: Buffer, i: number): boolean {
  return data[i] === 255 && data[i + 1] === 0 && data[i + 2] === 80;
}

/** Group diff pixels into boxes on a coarse grid, then merge touching boxes. */
function regionsOf(diffData: Buffer, width: number, height: number, cell = 8): DiffRegion[] {
  const cols = Math.ceil(width / cell);
  const rows = Math.ceil(height / cell);
  const hits = new Uint32Array(cols * rows);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      if (isDiffPixel(diffData, i)) hits[Math.floor(y / cell) * cols + Math.floor(x / cell)]!++;
    }
  }
  const seen = new Uint8Array(cols * rows);
  const regions: DiffRegion[] = [];
  for (let c = 0; c < hits.length; c++) {
    if (!hits[c] || seen[c]) continue;
    let minX = cols;
    let minY = rows;
    let maxX = 0;
    let maxY = 0;
    let pixels = 0;
    const stack = [c];
    seen[c] = 1;
    while (stack.length) {
      const k = stack.pop()!;
      const cx = k % cols;
      const cy = Math.floor(k / cols);
      minX = Math.min(minX, cx);
      maxX = Math.max(maxX, cx);
      minY = Math.min(minY, cy);
      maxY = Math.max(maxY, cy);
      pixels += hits[k]!;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = cx + dx;
          const ny = cy + dy;
          if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue;
          const nk = ny * cols + nx;
          if (hits[nk] && !seen[nk]) {
            seen[nk] = 1;
            stack.push(nk);
          }
        }
      }
    }
    if (pixels < 4) continue; // isolated anti-aliasing specks
    regions.push({
      x: minX * cell,
      y: minY * cell,
      w: Math.min(width, (maxX + 1) * cell) - minX * cell,
      h: Math.min(height, (maxY + 1) * cell) - minY * cell,
      pixels,
    });
  }
  return regions.sort((p, q) => q.pixels - p.pixels);
}

/** Side-by-side strip: design | implementation | diff, each labelled by position. */
export function sideBySide(images: Raster[], gap = 12): Raster {
  const height = Math.max(...images.map((i) => i.height));
  const width = images.reduce((a, i) => a + i.width, 0) + gap * (images.length - 1);
  const data = Buffer.alloc(width * height * 4, 255);
  let x0 = 0;
  for (const img of images) {
    for (let y = 0; y < img.height; y++) img.data.copy(data, (y * width + x0) * 4, y * img.width * 4, (y + 1) * img.width * 4);
    x0 += img.width + gap;
  }
  return { width, height, data };
}
