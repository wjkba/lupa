/**
 * Figma values → CSS values. Every function here returns something a
 * developer can paste into a stylesheet; the conversions that are easy to get
 * subtly wrong (gradient angles on non-square boxes, blur radii, letter
 * spacing in percent) are done exactly rather than approximated.
 */

import type { RawColor, RawEffect, RawLetterSpacing, RawLineHeight, RawPaint } from "../shared/raw";

/** Compact number: max 2 decimals, no trailing zeros, no "-0". */
export function n(v: number, places = 2): string {
  if (!Number.isFinite(v)) return "0";
  const f = 10 ** places;
  const r = Math.round(v * f) / f;
  return String(Object.is(r, -0) ? 0 : r);
}

function hex2(x: number): string {
  return Math.round(Math.min(1, Math.max(0, x)) * 255)
    .toString(16)
    .padStart(2, "0");
}

export function hex(c: RawColor, opacity = 1): string {
  const a = (c.a ?? 1) * opacity;
  return `#${hex2(c.r)}${hex2(c.g)}${hex2(c.b)}${a < 0.998 ? hex2(a) : ""}`;
}

export function visible<T extends { visible?: boolean; opacity?: number }>(list: T[] | undefined): T[] {
  return (list ?? []).filter((p) => p && p.visible !== false && (p.opacity ?? 1) > 0);
}

/* ------------------------------------------------------------------ */
/* Gradients                                                           */
/* ------------------------------------------------------------------ */

type Mat = number[][];

function invert(t: Mat): Mat | undefined {
  const [a, b, c] = t[0] ?? [];
  const [d, e, f] = t[1] ?? [];
  if ([a, b, c, d, e, f].some((x) => typeof x !== "number")) return undefined;
  const det = a! * e! - b! * d!;
  if (Math.abs(det) < 1e-12) return undefined;
  return [
    [e! / det, -b! / det, (b! * f! - e! * c!) / det],
    [-d! / det, a! / det, (d! * c! - a! * f!) / det],
  ];
}

function apply(m: Mat, x: number, y: number): [number, number] {
  return [m[0]![0]! * x + m[0]![1]! * y + m[0]![2]!, m[1]![0]! * x + m[1]![1]! * y + m[1]![2]!];
}

export interface StopColor {
  (stop: { position: number; color: RawColor; boundVariables?: { color?: { id: string } } }): string;
}

/**
 * Figma's gradientTransform maps the layer's unit square to gradient space,
 * where a linear gradient's colour depends only on x (0 → first stop, 1 →
 * last). So the colour at pixel p is t(p) = a·p.x/w + b·p.y/h + c, a linear
 * function of the pixel position — which a CSS linear-gradient expresses
 * exactly once the angle is taken from that function's gradient (not from the
 * handle positions, which are skewed on non-square boxes) and each stop is
 * re-projected onto the CSS gradient line, whose length depends on the box.
 */
export function linearGradient(p: RawPaint, w: number, h: number, stopColor: StopColor): string {
  const stops = p.gradientStops ?? [];
  const row = p.gradientTransform?.[0];
  const list = (pos: (t: number) => number) => stops.map((s) => `${stopColor(s)} ${n(pos(s.position) * 100, 1)}%`).join(", ");
  if (!row || row.length < 3 || w <= 0 || h <= 0) return `linear-gradient(${list((t) => t)})`;
  const [a, b, c] = row as [number, number, number];
  const nx = a / w;
  const ny = b / h;
  const len = Math.hypot(nx, ny);
  if (len < 1e-12) return `linear-gradient(${list((t) => t)})`;
  const ux = nx / len;
  const uy = ny / len;
  let deg = (Math.atan2(ux, -uy) * 180) / Math.PI;
  if (deg < 0) deg += 360;
  const L = Math.abs(w * ux) + Math.abs(h * uy);
  const sx = w / 2 - (ux * L) / 2;
  const sy = h / 2 - (uy * L) / 2;
  const t0 = nx * sx + ny * sy + c;
  return `linear-gradient(${n(deg, 1)}deg, ${list((t) => (t - t0) / (L * len))})`;
}

/**
 * Radial: the unit circle of gradient space (centre .5,.5, radius .5) mapped
 * back into the box. Axis-aligned ellipses are exact; CSS cannot rotate a
 * radial gradient, so a rotated one is flagged.
 */
export function radialGradient(p: RawPaint, w: number, h: number, stopColor: StopColor): string {
  const stops = (p.gradientStops ?? []).map((s) => `${stopColor(s)} ${n(s.position * 100, 1)}%`).join(", ");
  const inv = p.gradientTransform ? invert(p.gradientTransform) : undefined;
  if (!inv) return `radial-gradient(${stops})`;
  const c = apply(inv, 0.5, 0.5);
  const a = apply(inv, 1, 0.5);
  const b = apply(inv, 0.5, 1);
  const ax = (a[0] - c[0]) * w;
  const ay = (a[1] - c[1]) * h;
  const bx = (b[0] - c[0]) * w;
  const by = (b[1] - c[1]) * h;
  const horizontalFirst = Math.abs(ax) >= Math.abs(ay);
  const rx = horizontalFirst ? Math.hypot(ax, ay) : Math.hypot(bx, by);
  const ry = horizontalFirst ? Math.hypot(bx, by) : Math.hypot(ax, ay);
  let tilt = (Math.atan2(ay, ax) * 180) / Math.PI;
  tilt = ((tilt % 90) + 90) % 90;
  const rotated = tilt > 1 && tilt < 89 ? ` /*rotated ${n(tilt, 0)}deg*/` : "";
  const kind = p.type === "GRADIENT_DIAMOND" ? "/*diamond≈*/ ellipse" : "ellipse";
  return `radial-gradient(${kind} ${n(rx, 1)}px ${n(ry, 1)}px at ${n(c[0] * 100, 1)}% ${n(c[1] * 100, 1)}%, ${stops})${rotated}`;
}

export function conicGradient(p: RawPaint, w: number, h: number, stopColor: StopColor): string {
  const stops = (p.gradientStops ?? []).map((s) => `${stopColor(s)} ${n(s.position * 100, 1)}%`).join(", ");
  const inv = p.gradientTransform ? invert(p.gradientTransform) : undefined;
  if (!inv) return `conic-gradient(${stops})`;
  const c = apply(inv, 0.5, 0.5);
  const a = apply(inv, 1, 0.5);
  let deg = (Math.atan2((a[0] - c[0]) * w, -(a[1] - c[1]) * h) * 180) / Math.PI;
  if (deg < 0) deg += 360;
  return `conic-gradient(from ${n(deg, 1)}deg at ${n(c[0] * 100, 1)}% ${n(c[1] * 100, 1)}%, ${stops})`;
}

/* ------------------------------------------------------------------ */
/* Images                                                              */
/* ------------------------------------------------------------------ */

export function imageShort(hash: string | null | undefined): string {
  return hash ? hash.slice(0, 10) : "missing";
}

/** Image paint → `img(<hash> cover)` plus crop/tile/filter details when present. */
export function imagePaint(p: RawPaint): string {
  const parts = [imageShort(p.imageHash)];
  switch (p.scaleMode) {
    case "FIT":
      parts.push("contain");
      break;
    case "TILE":
      parts.push(`tile${p.scalingFactor && p.scalingFactor !== 1 ? `×${n(p.scalingFactor)}` : ""}`);
      break;
    case "CROP": {
      const t = p.imageTransform;
      const sx = t?.[0]?.[0];
      const sy = t?.[1]?.[1];
      const tx = t?.[0]?.[2] ?? 0;
      const ty = t?.[1]?.[2] ?? 0;
      if (typeof sx === "number" && typeof sy === "number" && sx > 0 && sy > 0) {
        const posX = sx < 1 ? (tx / (1 - sx)) * 100 : 0;
        const posY = sy < 1 ? (ty / (1 - sy)) * 100 : 0;
        parts.push(`crop size:${n(100 / sx, 1)}%,${n(100 / sy, 1)}% pos:${n(posX, 1)}%,${n(posY, 1)}%`);
      } else parts.push("crop");
      break;
    }
    default:
      parts.push("cover");
  }
  if (p.rotation) parts.push(`rotate:${n(p.rotation)}`);
  if (p.filters) {
    const f = p.filters;
    const css: string[] = [];
    if (f.exposure) css.push(`brightness(${n(1 + f.exposure)})`);
    if (f.contrast) css.push(`contrast(${n(1 + f.contrast)})`);
    if (f.saturation) css.push(`saturate(${n(1 + f.saturation)})`);
    if (css.length) parts.push(`filter:${css.join("")}`);
    const other = Object.keys(f).filter((k) => !["exposure", "contrast", "saturation"].includes(k));
    if (other.length) parts.push(`adjust:${other.map((k) => `${k}=${n(f[k]!)}`).join(",")}`);
  }
  if (p.opacity !== undefined && p.opacity < 1) parts.push(`opacity:${n(p.opacity)}`);
  return `img(${parts.join(" ")})`;
}

/* ------------------------------------------------------------------ */
/* Effects                                                             */
/* ------------------------------------------------------------------ */

export interface EffectCss {
  shadow?: string;
  textShadow?: string;
  blur?: string;
  backdrop?: string;
  other?: string[];
}

/**
 * Shadows map 1:1 to CSS. Figma's blur radii are twice the CSS `blur()` value
 * (confirmed by Figma engineering; Dev Mode halves them too).
 */
export function effectsCss(effects: RawEffect[] | undefined, isText: boolean, color: (e: RawEffect) => string): EffectCss {
  const out: EffectCss = {};
  const shadows: string[] = [];
  for (const e of visible(effects)) {
    if (e.type === "DROP_SHADOW" || e.type === "INNER_SHADOW") {
      const inset = e.type === "INNER_SHADOW" ? "inset " : "";
      const x = n(e.offset?.x ?? 0);
      const y = n(e.offset?.y ?? 0);
      const blur = n(e.radius ?? 0);
      const spread = e.spread ? ` ${n(e.spread)}px` : isText ? "" : " 0";
      shadows.push(`${inset}${x}px ${y}px ${blur}px${spread} ${color(e)}`);
    } else if (e.type === "LAYER_BLUR") {
      out.blur = `blur(${n((e.radius ?? 0) / 2)}px)${e.blurType === "PROGRESSIVE" ? " /*progressive*/" : ""}`;
    } else if (e.type === "BACKGROUND_BLUR") {
      out.backdrop = `blur(${n((e.radius ?? 0) / 2)}px)${e.blurType === "PROGRESSIVE" ? " /*progressive*/" : ""}`;
    } else {
      (out.other ??= []).push(e.type.toLowerCase());
    }
  }
  if (shadows.length) {
    if (isText && shadows.every((s) => !s.startsWith("inset"))) out.textShadow = shadows.join(", ");
    else out.shadow = shadows.join(", ");
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Text                                                                */
/* ------------------------------------------------------------------ */

export function lineHeightCss(lh: RawLineHeight | undefined): string {
  if (!lh || lh.unit === "AUTO") return "normal";
  if (lh.unit === "PERCENT") return `${n(lh.value ?? 100)}%`;
  return n(lh.value ?? 0);
}

export function letterSpacingCss(ls: RawLetterSpacing | undefined): string | undefined {
  if (!ls || !ls.value) return undefined;
  return ls.unit === "PERCENT" ? `${n(ls.value / 100, 4)}em` : `${n(ls.value)}px`;
}

const CASE: Record<string, string> = {
  UPPER: "uppercase",
  LOWER: "lowercase",
  TITLE: "capitalize",
  SMALL_CAPS: "small-caps",
  SMALL_CAPS_FORCED: "all-small-caps",
};

export function textCaseCss(c: string | undefined): string | undefined {
  return c ? CASE[c] : undefined;
}

export function decorationCss(d: string | undefined): string | undefined {
  if (d === "UNDERLINE") return "underline";
  if (d === "STRIKETHROUGH") return "line-through";
  return undefined;
}

const BLEND: Record<string, string> = {
  DARKEN: "darken",
  MULTIPLY: "multiply",
  LINEAR_BURN: "plus-darker",
  COLOR_BURN: "color-burn",
  LIGHTEN: "lighten",
  SCREEN: "screen",
  LINEAR_DODGE: "plus-lighter",
  COLOR_DODGE: "color-dodge",
  OVERLAY: "overlay",
  SOFT_LIGHT: "soft-light",
  HARD_LIGHT: "hard-light",
  DIFFERENCE: "difference",
  EXCLUSION: "exclusion",
  HUE: "hue",
  SATURATION: "saturation",
  COLOR: "color",
  LUMINOSITY: "luminosity",
};

export function blendCss(mode: string | undefined): string | undefined {
  return mode ? BLEND[mode] ?? mode.toLowerCase() : undefined;
}

/** CSS shorthand for four sides (t, r, b, l), collapsing equal values. */
export function sides(t: string, r: string, b: string, l: string): string {
  if (t === r && r === b && b === l) return t;
  if (t === b && r === l) return `${t},${r}`;
  if (r === l) return `${t},${r},${b}`;
  return `${t},${r},${b},${l}`;
}
