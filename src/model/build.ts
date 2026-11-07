/**
 * RawNode → IR: every property already converted to the CSS-flavoured
 * `key:value` strings the renderer prints. Geometry is kept apart from
 * styling because component override diffs must ignore it (an instance that
 * was resized reflows, which is not an override).
 */

import type { RawNode, RawPaint, RawSegment, RawSnapshot } from "../shared/raw";
import {
  blendCss,
  conicGradient,
  decorationCss,
  effectsCss,
  hex,
  imagePaint,
  imageShort,
  letterSpacingCss,
  lineHeightCss,
  linearGradient,
  n,
  radialGradient,
  sides,
  textCaseCss,
  visible,
} from "./css";
import { Registry } from "./tokens";

export type Kind =
  | "frame"
  | "group"
  | "section"
  | "component"
  | "set"
  | "instance"
  | "text"
  | "rect"
  | "ellipse"
  | "line"
  | "svg"
  | "img"
  | string;

export interface Run {
  text: string;
  props: Record<string, string>;
}

export interface IRNode {
  id: string;
  name: string;
  type: string;
  kind: Kind;
  w: number;
  h: number;
  /** Size modes, position, constraints, rotation — ignored by override diffs. */
  geo: Record<string, string>;
  /** Auto layout container properties. */
  layout: Record<string, string>;
  /** Visual properties. */
  style: Record<string, string>;
  text?: string;
  runs?: Run[];
  hidden?: boolean;
  /** INSTANCE: main component id + display props. */
  inst?: { mainId?: string; variant: Record<string, string>; props: Record<string, string> };
  /** Field → property name for layers driven by component properties. */
  propRefs?: Record<string, string>;
  image?: string;
  /** Asset file stem for graphics and images. */
  asset?: string;
  notes: string[];
  children: IRNode[];
  /** Children that exist in Figma but were not loaded. */
  more?: number;
  raw: RawNode;
}

const DEFAULT_NAME =
  /^(frame|rectangle|ellipse|group|vector|line|polygon|star|union|subtract|intersect|exclude|image|text|component|instance|section|slot|boolean|arrow|auto layout)(\s+\d+)?$/i;

const STANDARD_WEIGHT =
  /^(thin|hairline|extra ?light|ultra ?light|light|normal|regular|book|medium|semi ?bold|demi ?bold|bold|extra ?bold|ultra ?bold|black|heavy)$/i;

export function isDefaultName(name: string): boolean {
  return DEFAULT_NAME.test(name.trim());
}

/** Strip Figma's `#123:4` suffix from component property keys. */
export function propName(key: string): string {
  return key.replace(/#[^#]*$/, "");
}

export function slug(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

const KIND: Record<string, Kind> = {
  FRAME: "frame",
  GROUP: "group",
  SECTION: "section",
  COMPONENT: "component",
  COMPONENT_SET: "set",
  INSTANCE: "instance",
  TEXT: "text",
  RECTANGLE: "rect",
  ELLIPSE: "ellipse",
  LINE: "line",
};

export class Builder {
  readonly reg: Registry;
  private readonly defCache = new Map<string, IRNode | null>();

  constructor(readonly snap: RawSnapshot) {
    this.reg = new Registry(snap);
  }

  /** IR for a main component's own tree (built once). */
  def(mainId: string): IRNode | undefined {
    if (!this.defCache.has(mainId)) {
      const tree = this.snap.components[mainId]?.tree;
      this.defCache.set(mainId, tree ? this.node(tree, undefined) : null);
    }
    return this.defCache.get(mainId) ?? undefined;
  }

  componentLabel(mainId: string | undefined): string {
    const c = mainId ? this.snap.components[mainId] : undefined;
    if (!c) return "?";
    return c.setName ?? c.name;
  }

  node(raw: RawNode, parent: RawNode | undefined): IRNode {
    const kind: Kind = raw.graphic ? "svg" : KIND[raw.type] ?? raw.type.toLowerCase();
    const ir: IRNode = {
      id: raw.id,
      name: raw.name,
      type: raw.type,
      kind,
      w: raw.w,
      h: raw.h,
      geo: {},
      layout: {},
      style: {},
      notes: [],
      children: [],
      raw,
    };
    if (raw.visible === false) ir.hidden = true;
    if (raw.stub) return ir;

    this.geometry(ir, raw, parent);
    this.layout(ir, raw);
    this.appearance(ir, raw);
    if (raw.type === "TEXT") this.text(ir, raw);
    if (raw.type === "INSTANCE") this.instance(ir, raw);
    if (raw.componentPropertyReferences) {
      ir.propRefs = {};
      for (const [field, key] of Object.entries(raw.componentPropertyReferences)) ir.propRefs[field] = propName(key);
    }
    this.handoff(ir, raw);

    if (raw.graphic) {
      const c = this.snap.components[raw.mainComponentId ?? ""];
      ir.asset = slug(c ? (c.setName ? `${c.setName}-${Object.values(c.variant ?? {}).join("-")}` : c.name) : raw.name) || "graphic";
    }
    for (const kid of raw.children ?? []) ir.children.push(this.node(kid, raw));
    if (raw.childCount) ir.more = raw.childCount;
    return ir;
  }

  /* ---------------------------------------------------------------- */

  private geometry(ir: IRNode, raw: RawNode, parent: RawNode | undefined): void {
    const g = ir.geo;
    const sh = raw.layoutSizingHorizontal;
    const sv = raw.layoutSizingVertical;
    if (raw.type === "TEXT" && !sh && raw.textAutoResize) {
      if (raw.textAutoResize === "WIDTH_AND_HEIGHT") g.w = "hug";
      if (raw.textAutoResize === "WIDTH_AND_HEIGHT" || raw.textAutoResize === "HEIGHT") g.h = "hug";
    } else {
      if (sh === "FILL" || sh === "HUG") g.w = sh.toLowerCase();
      if (sv === "FILL" || sv === "HUG") g.h = sv.toLowerCase();
    }
    const bv = raw.boundVariables ?? {};
    for (const [k, key] of [
      ["minw", "minWidth"],
      ["maxw", "maxWidth"],
      ["minh", "minHeight"],
      ["maxh", "maxHeight"],
    ] as const) {
      const v = raw[key];
      if (typeof v === "number") g[k] = this.reg.number(v, bv[key]?.id);
    }
    if (bv.width) g.w = g.w ? `${g.w}(${this.reg.number(raw.w, bv.width.id)})` : this.reg.number(raw.w, bv.width.id);
    if (bv.height) g.h = g.h ? `${g.h}(${this.reg.number(raw.h, bv.height.id)})` : this.reg.number(raw.h, bv.height.id);

    const parentFlow = !!parent?.layoutMode;
    const absolute = raw.layoutPositioning === "ABSOLUTE";
    if (absolute) g.abs = "";
    if (parent && (!parentFlow || absolute) && raw.bb && parent.bb) {
      // CSS left/top of the unrotated box: the rotated AABB shares its centre.
      const cx = raw.bb[0] + raw.bb[2] / 2 - parent.bb[0];
      const cy = raw.bb[1] + raw.bb[3] / 2 - parent.bb[1];
      g.at = `${n(cx - raw.w / 2)},${n(cy - raw.h / 2)}`;
    }
    if (raw.constraints && parent && (!parentFlow || absolute)) {
      const h = { MIN: "", MAX: "right", CENTER: "center-x", STRETCH: "left+right", SCALE: "scale-x" }[raw.constraints.horizontal] ?? "";
      const v = { MIN: "", MAX: "bottom", CENTER: "center-y", STRETCH: "top+bottom", SCALE: "scale-y" }[raw.constraints.vertical] ?? "";
      const pin = [h, v].filter(Boolean).join(",");
      if (pin) g.pin = pin;
    }
    if (raw.rotation) g.rotate = `${n(-raw.rotation)}deg`;
    if (raw.gridColumnAnchorIndex !== undefined && raw.gridRowAnchorIndex !== undefined) {
      g.cell = `${raw.gridColumnAnchorIndex + 1},${raw.gridRowAnchorIndex + 1}`;
      if (raw.gridColumnSpan || raw.gridRowSpan) g.span = `${raw.gridColumnSpan ?? 1}x${raw.gridRowSpan ?? 1}`;
    }
  }

  private layout(ir: IRNode, raw: RawNode): void {
    if (!raw.layoutMode) return;
    const L = ir.layout;
    const bv = raw.boundVariables ?? {};
    const num = (key: keyof RawNode & string): string => this.reg.number((raw[key] as number | undefined) ?? 0, bv[key]?.id);
    if (raw.layoutMode === "GRID") {
      const tracks = (t: RawNode["gridColumnSizes"], count: number | undefined) =>
        (t?.length ? t : Array.from({ length: count ?? 0 }, () => ({ type: "FLEX", value: 1 })))
          .map((s) => (s.type === "FIXED" ? n(s.value ?? 0) : s.type === "HUG" ? "auto" : `${n(s.value ?? 1)}fr`))
          .join(",");
      L.grid = "";
      L.cols = tracks(raw.gridColumnSizes, raw.gridColumnCount);
      L.rows = tracks(raw.gridRowSizes, raw.gridRowCount);
      if (raw.gridColumnGap) L.gap = num("gridColumnGap");
      if (raw.gridRowGap) L.rowgap = num("gridRowGap");
    } else {
      L[raw.layoutMode === "VERTICAL" ? "col" : "row"] = "";
      if (raw.primaryAxisAlignItems === "SPACE_BETWEEN") L.justify = "between";
      else if (raw.itemSpacing) L.gap = num("itemSpacing");
      if (raw.layoutWrap) {
        L.wrap = "";
        if (raw.counterAxisSpacing) L.rowgap = this.reg.number(raw.counterAxisSpacing, bv.counterAxisSpacing?.id);
        if (raw.counterAxisAlignContent === "SPACE_BETWEEN") L["align-content"] = "between";
      }
      if (raw.primaryAxisAlignItems === "CENTER") L.justify = "center";
      if (raw.primaryAxisAlignItems === "MAX") L.justify = "end";
      if (raw.counterAxisAlignItems === "CENTER") L.align = "center";
      if (raw.counterAxisAlignItems === "MAX") L.align = "end";
      if (raw.counterAxisAlignItems === "BASELINE") L.align = "baseline";
    }
    const p = sides(num("paddingTop"), num("paddingRight"), num("paddingBottom"), num("paddingLeft"));
    if (p !== "0") L.p = p;
    if (raw.itemReverseZIndex) L["z-reverse"] = "";
    if (raw.strokesIncludedInLayout) L["border-in-layout"] = "";
  }

  /** CSS for one paint, with variable / style references for solids. */
  private paint(p: RawPaint, w: number, h: number): string | undefined {
    const stopColor = (s: { color: { r: number; g: number; b: number; a?: number }; boundVariables?: { color?: { id: string } } }) =>
      this.reg.color(hex(s.color, p.opacity ?? 1), { varId: s.boundVariables?.color?.id, alpha: p.opacity });
    if (p.type === "SOLID" && p.color) {
      return this.reg.color(hex(p.color, p.opacity ?? 1), { varId: p.boundVariables?.color?.id, alpha: p.opacity });
    }
    if (p.type === "GRADIENT_LINEAR") return linearGradient(p, w, h, stopColor);
    if (p.type === "GRADIENT_RADIAL" || p.type === "GRADIENT_DIAMOND") return radialGradient(p, w, h, stopColor);
    if (p.type === "GRADIENT_ANGULAR") return conicGradient(p, w, h, stopColor);
    if (p.type === "IMAGE") return imagePaint(p);
    if (p.type === "VIDEO") return `video(${imageShort(p.imageHash)})`;
    return p.type.toLowerCase();
  }

  /** Visible paints in CSS order (topmost first). */
  private paints(list: RawPaint[] | undefined, w: number, h: number): string[] {
    return visible(list)
      .slice()
      .reverse()
      .map((p) => this.paint(p, w, h))
      .filter((s): s is string => !!s);
  }

  private appearance(ir: IRNode, raw: RawNode): void {
    const S = ir.style;
    const isText = raw.type === "TEXT";
    const bv = raw.boundVariables ?? {};

    if (raw.graphic) {
      const cols = raw.graphic.colors.map((c, i) => {
        const v = raw.graphic!.colorVars?.[i];
        return c === "gradient" ? c : this.reg.color(c, { varId: v });
      });
      if (cols.length === 1) S.color = cols[0]!;
      else if (cols.length) S.colors = cols.join(",");
    } else if (!isText) {
      const fills = visible(raw.fills);
      const onlyImage = fills.length === 1 && fills[0]!.type === "IMAGE";
      if (onlyImage && (raw.type === "RECTANGLE" || raw.type === "ELLIPSE") && !raw.children?.length) {
        ir.kind = "img";
        ir.image = fills[0]!.imageHash ?? undefined;
        S.src = this.paint(fills[0]!, raw.w, raw.h)!.replace(/^img\((.*)\)$/, "$1");
        if (raw.type === "ELLIPSE") S.radius = "full";
      } else if (fills.length) {
        const css = this.paints(raw.fills, raw.w, raw.h);
        const img = fills.find((f) => f.type === "IMAGE");
        if (img?.imageHash) ir.image = img.imageHash;
        const single = fills.length === 1 && fills[0]!.type === "SOLID";
        let value = css.join(", ");
        if (raw.fillStyleId && !value.startsWith("$")) {
          value = single ? this.reg.color(value, { styleId: raw.fillStyleId }) : this.reg.paintStyle(raw.fillStyleId, value) ?? value;
        }
        if (value) S[raw.type === "LINE" ? "stroke" : "bg"] = value;
      }
    }

    // Strokes.
    const strokes = visible(raw.strokes);
    if (strokes.length) {
      const top = strokes[strokes.length - 1]!;
      let color = this.paint(top, raw.w, raw.h) ?? "";
      if (raw.strokeStyleId && top.type === "SOLID" && !color.startsWith("$")) color = this.reg.color(color, { styleId: raw.strokeStyleId });
      const uniform = raw.strokeWeight ?? 1;
      const sideW = [raw.strokeTopWeight, raw.strokeRightWeight, raw.strokeBottomWeight, raw.strokeLeftWeight];
      const weight = sideW.some((x) => x !== undefined)
        ? sides(...(sideW.map((x) => n(x ?? uniform)) as [string, string, string, string]))
        : this.reg.number(uniform, bv.strokeWeight?.id);
      const parts = [weight];
      if (raw.dashPattern?.length) parts.push(`dashed(${raw.dashPattern.map((d) => n(d)).join(",")})`);
      parts.push(color);
      if (raw.strokeAlign === "OUTSIDE" && raw.type !== "LINE") parts.push("outside");
      if (raw.strokeAlign === "CENTER" && raw.type !== "LINE") parts.push("center");
      if (strokes.length > 1) parts.push(`+${strokes.length - 1} more`);
      const key = raw.type === "LINE" ? "stroke" : isText ? "text-stroke" : raw.graphic ? "stroke" : "border";
      if (!raw.graphic) S[key] = parts.join(" ");
    }

    // Corners.
    if (ir.kind !== "img" || raw.type !== "ELLIPSE") {
      if (raw.cornerRadius) {
        const full = raw.cornerRadius >= Math.min(raw.w, raw.h) / 2 - 0.01 && Math.min(raw.w, raw.h) > 0;
        S.radius = bv.cornerRadius ? this.reg.number(raw.cornerRadius, bv.cornerRadius.id) : full ? "full" : n(raw.cornerRadius);
      } else if (raw.radii) {
        const keys = ["topLeftRadius", "topRightRadius", "bottomRightRadius", "bottomLeftRadius"];
        S.radius = raw.radii.map((r, i) => this.reg.number(r, bv[keys[i]!]?.id)).join(",");
      }
      if (raw.cornerSmoothing && S.radius) S.smooth = `${n(raw.cornerSmoothing * 100, 0)}%`;
    }
    if (raw.type === "ELLIPSE" && ir.kind === "ellipse") S.radius = "full";

    // Effects.
    if (!raw.graphic || raw.effects) {
      const fx = effectsCss(raw.effects, isText, (e) => this.reg.color(hex(e.color ?? { r: 0, g: 0, b: 0, a: 0.25 }), { varId: e.boundVariables?.color?.id }));
      const shadow = fx.shadow ?? fx.textShadow;
      if (shadow) S[fx.textShadow ? "text-shadow" : "shadow"] = this.reg.effect(shadow, raw.effectStyleId);
      if (fx.blur) S.blur = fx.blur;
      if (fx.backdrop) S.backdrop = fx.backdrop;
      if (fx.other) S.effect = fx.other.join(",");
    }
    if (raw.opacity !== undefined) S.opacity = this.reg.number(raw.opacity, bv.opacity?.id);
    const blend = blendCss(raw.blendMode);
    if (blend) S.blend = blend;
    if (raw.clipsContent) S.clip = "";
    if (raw.isMask) S.mask = (raw.maskType ?? "ALPHA").toLowerCase();
    if (raw.arcData && !raw.graphic) S.arc = `${n((raw.arcData.startingAngle * 180) / Math.PI)}..${n((raw.arcData.endingAngle * 180) / Math.PI)}deg inner:${n(raw.arcData.innerRadius)}`;
  }

  /* ---------------------------------------------------------------- */

  private typeSpec(seg: RawSegment): string {
    const parts = [`${seg.fontFamily} ${seg.fontWeight}`];
    if (/italic|oblique/i.test(seg.fontStyle)) parts[0] += " italic";
    // Styles that a weight number cannot express ("Condensed Bold", "Display") are kept verbatim.
    const styleWeightless = seg.fontStyle.replace(/italic|oblique/gi, "").trim();
    if (styleWeightless && !STANDARD_WEIGHT.test(styleWeightless)) parts[0] += ` "${seg.fontStyle}"`;
    parts.push(`${n(seg.fontSize)}/${lineHeightCss(seg.lineHeight)}`);
    const ls = letterSpacingCss(seg.letterSpacing);
    if (ls) parts.push(`ls:${ls}`);
    const tc = textCaseCss(seg.textCase);
    if (tc) parts.push(tc);
    const dec = decorationCss(seg.textDecoration);
    if (dec) parts.push(dec);
    if (seg.paragraphSpacing) parts.push(`para:${n(seg.paragraphSpacing)}`);
    if (seg.paragraphIndent) parts.push(`indent:${n(seg.paragraphIndent)}`);
    const feats = Object.entries(seg.openTypeFeatures ?? {}).map(([k, v]) => `${k.toLowerCase()}${v ? "" : "=off"}`);
    if (feats.length) parts.push(`features:${feats.join(",")}`);
    return parts.join(" ");
  }

  private segmentProps(seg: RawSegment, w: number, h: number): Record<string, string> {
    const p: Record<string, string> = {};
    const bv = seg.boundVariables ?? {};
    const varNote = Object.entries(bv)
      .map(([k, a]) => {
        const v = this.snap.variables[a.id];
        return v ? `${k}=$${v.name.replace(/\s*\/\s*/g, "/").replace(/\s+/g, "-")}` : "";
      })
      .filter(Boolean)
      .join(" ");
    p.font = this.reg.type(this.typeSpec(seg), seg.textStyleId, varNote || undefined);
    const fills = visible(seg.fills);
    if (fills.length) {
      const css = this.paints(seg.fills, w, h);
      if (fills.length === 1 && fills[0]!.type === "SOLID" && seg.fillStyleId && !css[0]!.startsWith("$")) {
        p.color = this.reg.color(css[0]!, { styleId: seg.fillStyleId });
      } else p.color = css.join(", ");
    }
    if (seg.hyperlink) p.href = seg.hyperlink.type === "URL" ? seg.hyperlink.value : `#${this.snap.nodeNames[seg.hyperlink.value] ?? seg.hyperlink.value}`;
    if (seg.listType && seg.listType !== "NONE") p.list = seg.listType === "ORDERED" ? "ol" : "ul";
    if (seg.indentation) p.level = String(seg.indentation);
    return p;
  }

  private text(ir: IRNode, raw: RawNode): void {
    ir.text = raw.characters ?? "";
    const segs = raw.segments ?? [];
    const S = ir.style;
    if (segs.length) {
      const dominant = segs.reduce((a, b) => (b.end - b.start > a.end - a.start ? b : a));
      const dom = this.segmentProps(dominant, raw.w, raw.h);
      Object.assign(S, dom);
      if (segs.length > 1) {
        ir.runs = segs.map((s) => {
          const props = this.segmentProps(s, raw.w, raw.h);
          const diff: Record<string, string> = {};
          for (const [k, v] of Object.entries(props)) if (dom[k] !== v) diff[k] = v;
          for (const k of Object.keys(dom)) if (!(k in props) && (k === "href" || k === "list")) diff[k] = "none";
          return { text: s.characters, props: diff };
        });
        // Runs that differ only by list level/type and nothing visual collapse into one.
        if (ir.runs.every((r) => Object.keys(r.props).length === 0)) delete ir.runs;
      }
    }
    if (raw.textAlignHorizontal) S["text-align"] = raw.textAlignHorizontal === "JUSTIFIED" ? "justify" : raw.textAlignHorizontal.toLowerCase();
    // Vertical alignment only matters when the box is taller than its text, not when it hugs.
    const hugsHeight = raw.textAutoResize === "HEIGHT" || raw.textAutoResize === "WIDTH_AND_HEIGHT";
    if (raw.textAlignVertical && raw.textAlignVertical !== "TOP" && !hugsHeight) S.valign =raw.textAlignVertical === "CENTER" ? "middle" : raw.textAlignVertical.toLowerCase();
    if (raw.textTruncation) S.ellipsis = raw.maxLines ? `${raw.maxLines}lines` : "";
    if (raw.leadingTrim) S.trim = raw.leadingTrim === "CAP_HEIGHT" ? "cap" : raw.leadingTrim.toLowerCase();
  }

  private instance(ir: IRNode, raw: RawNode): void {
    const info = raw.mainComponentId ? this.snap.components[raw.mainComponentId] : undefined;
    const variant: Record<string, string> = { ...(info?.variant ?? {}) };
    const props: Record<string, string> = {};
    const defs = info?.propertyDefinitions ?? {};
    for (const [key, p] of Object.entries(raw.componentProperties ?? {})) {
      const name = propName(key);
      if (p.type === "VARIANT") {
        variant[name] = String(p.value);
        continue;
      }
      const def = defs[key];
      if (p.type === "TEXT") props[name] = JSON.stringify(String(p.value));
      else if (p.type === "BOOLEAN") {
        if (!def || def.defaultValue !== p.value) props[name] = String(p.value);
      } else if (p.type === "INSTANCE_SWAP") {
        if (!def || def.defaultValue !== p.value) props[name] = this.snap.nodeNames[String(p.value)] ?? this.snap.components[String(p.value)]?.name ?? String(p.value);
      }
    }
    ir.inst = { mainId: raw.mainComponentId, variant, props };
  }

  private handoff(ir: IRNode, raw: RawNode): void {
    for (const a of raw.annotations ?? []) {
      const label = a.label.replace(/\s+/g, " ").trim();
      ir.notes.push(`note: ${label}${a.properties?.length ? ` [${a.properties.join(",")}]` : ""}`);
    }
    if (raw.devStatus) ir.notes.push(`status: ${raw.devStatus.toLowerCase().replace(/_/g, "-")}`);
    for (const r of raw.reactions ?? []) {
      const trig = r.trigger.replace(/^ON_/, "").replace(/_/g, "-").toLowerCase() + (r.timeout ? `(${n(r.timeout)}s)` : r.delay ? `(+${n(r.delay)}s)` : "");
      let act: string;
      if (r.action === "NODE") {
        const dest = r.destinationId ? this.snap.nodeNames[r.destinationId] ?? r.destinationId : "?";
        const nav = (r.navigation ?? "NAVIGATE").toLowerCase().replace(/_/g, "-");
        act = `${nav} "${dest}"${r.transition ? ` ${r.transition.toLowerCase().replace(/_/g, "-")}${r.duration ? ` ${n(r.duration)}s` : ""}` : ""}`;
      } else if (r.action === "URL") act = `open ${r.url}`;
      else act = r.action.toLowerCase().replace(/_/g, "-");
      ir.notes.push(`on ${trig} → ${act}`);
    }
    if (raw.exportSettings?.length) {
      ir.notes.push(
        `export: ${raw.exportSettings
          .map((s) => `${s.format.toLowerCase()}${s.constraint && s.constraint.type === "SCALE" && s.constraint.value !== 1 ? `@${s.constraint.value}x` : ""}${s.suffix ? ` ${s.suffix}` : ""}`)
          .join(", ")}`,
      );
    }
    for (const g of raw.layoutGrids ?? []) {
      const pattern = String(g.pattern).toLowerCase();
      const parts = [`${g.count ?? "?"} ${pattern}`];
      if (g.gutterSize !== undefined) parts.push(`gutter ${g.gutterSize}`);
      if (g.offset !== undefined && g.alignment !== "CENTER") parts.push(`margin ${g.offset}`);
      if (g.alignment === "CENTER" && g.sectionSize !== undefined) parts.push(`centered ${g.sectionSize}`);
      else if (g.alignment && g.alignment !== "STRETCH") parts.push(String(g.alignment).toLowerCase());
      if (pattern === "grid") ir.notes.push(`guides: ${g.sectionSize}px grid`);
      else ir.notes.push(`guides: ${parts.join(" ")}`);
    }
  }
}
