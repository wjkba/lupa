/// <reference types="@figma/plugin-typings" />

/**
 * SceneNode → RawNode.
 *
 * The walk is synchronous (fast: one pass over the plugin API), and everything
 * that needs an async lookup — main components, style names, variable names,
 * prototype destinations — is collected on the way and resolved afterwards in
 * parallel. The Figma API is injected so the same code runs against fake nodes
 * in tests.
 */

import type {
  RawComponentInfo,
  RawEffect,
  RawNode,
  RawPaint,
  RawReaction,
  RawSegment,
  RawSnapshot,
} from "../../src/shared/raw";
import type { SnapshotParams } from "../../src/shared/protocol";

/** The slice of the `figma` global the extractor uses. */
export interface FigmaApi {
  mixed: symbol;
  getNodeByIdAsync(id: string): Promise<BaseNode | null>;
  getStyleByIdAsync(id: string): Promise<BaseStyle | null>;
  variables: {
    getVariableByIdAsync(id: string): Promise<Variable | null>;
    getVariableCollectionByIdAsync(id: string): Promise<VariableCollection | null>;
  };
}

type AnyNode = SceneNode & Record<string, any>;

const PATHY = new Set(["VECTOR", "BOOLEAN_OPERATION", "STAR", "POLYGON"]);
const SHAPES = new Set([...PATHY, "LINE", "ELLIPSE", "RECTANGLE"]);
const GRAPHIC_CONTAINERS = new Set(["FRAME", "GROUP", "INSTANCE", "COMPONENT", "BOOLEAN_OPERATION"]);

export const r2 = (n: number): number => Math.round(n * 100) / 100;

function hex2(x: number): string {
  return Math.round(Math.min(1, Math.max(0, x)) * 255)
    .toString(16)
    .padStart(2, "0");
}

export function colorHex(c: { r: number; g: number; b: number; a?: number }, opacity = 1): string {
  const a = (c.a ?? 1) * opacity;
  return `#${hex2(c.r)}${hex2(c.g)}${hex2(c.b)}${a < 0.999 ? hex2(a) : ""}`;
}

/** Read a property; getters on broken nodes throw, and those are not worth losing a walk over. */
function get<T = any>(node: AnyNode, key: string): T | undefined {
  try {
    return node[key] as T;
  } catch {
    return undefined;
  }
}

interface Ctx {
  api: FigmaApi;
  opts: Required<Pick<SnapshotParams, "includeHidden" | "components" | "expandVectors">> & {
    depth?: number;
    maxNodes: number;
  };
  count: number;
  truncated: boolean;
  instances: { node: InstanceNode; raw: RawNode }[];
  styleIds: Set<string>;
  variableIds: Set<string>;
  nodeRefs: Set<string>;
  graphicMemo: Map<string, { pure: boolean; path: boolean }>;
}

/* ------------------------------------------------------------------ */
/* Vector graphics                                                     */
/* ------------------------------------------------------------------ */

function hasImagePaint(paints: unknown): boolean {
  return Array.isArray(paints) && paints.some((p) => p && p.visible !== false && (p.type === "IMAGE" || p.type === "VIDEO"));
}

function visiblePaints(paints: unknown): any[] {
  return Array.isArray(paints) ? paints.filter((p) => p && p.visible !== false && (p.opacity ?? 1) > 0) : [];
}

function hasOwnSurface(node: AnyNode): boolean {
  const effects = get<any[]>(node, "effects");
  return (
    visiblePaints(get(node, "fills")).length > 0 ||
    visiblePaints(get(node, "strokes")).length > 0 ||
    (Array.isArray(effects) && effects.some((e) => e.visible !== false))
  );
}

function isPartialArc(node: AnyNode): boolean {
  const arc = get<any>(node, "arcData");
  if (!arc) return false;
  const sweep = Math.abs(arc.endingAngle - arc.startingAngle);
  return arc.innerRadius > 0 || sweep < Math.PI * 2 - 0.001;
}

/**
 * Whether every visible descendant is a drawable shape (no text, no images),
 * and whether at least one is a real path. Memoized, so the whole tree costs
 * one pass even though every container asks.
 */
function graphicScan(node: AnyNode, ctx: Ctx): { pure: boolean; path: boolean } {
  const memo = ctx.graphicMemo.get(node.id);
  if (memo) return memo;
  let res: { pure: boolean; path: boolean };
  const type = node.type;
  if (type === "TEXT" || hasImagePaint(get(node, "fills"))) {
    res = { pure: false, path: false };
  } else if (PATHY.has(type)) {
    res = { pure: true, path: true };
  } else if (type === "ELLIPSE") {
    res = { pure: true, path: isPartialArc(node) };
  } else if (SHAPES.has(type)) {
    res = { pure: true, path: false };
  } else if (GRAPHIC_CONTAINERS.has(type)) {
    const kids = (get<readonly SceneNode[]>(node, "children") ?? []).filter((k) => get(k as AnyNode, "visible") !== false);
    res = { pure: kids.length > 0, path: false };
    for (const kid of kids) {
      const r = graphicScan(kid as AnyNode, ctx);
      if (!r.pure) {
        res = { pure: false, path: false };
        break;
      }
      if (r.path) res.path = true;
    }
  } else {
    res = { pure: false, path: false };
  }
  ctx.graphicMemo.set(node.id, res);
  return res;
}

/** Should this node be emitted as a single vector graphic (icon / illustration)? */
export function isGraphic(node: AnyNode, ctx: Ctx): boolean {
  if (ctx.opts.expandVectors) return false;
  const type = node.type;
  if (PATHY.has(type)) return true;
  if (type === "ELLIPSE") return isPartialArc(node);
  if (!GRAPHIC_CONTAINERS.has(type)) return false;
  const scan = graphicScan(node, ctx);
  if (!scan.pure || !scan.path) return false;
  if (type === "FRAME" || type === "GROUP") {
    // A styled box (badge, icon button) stays a box: its fill and radius are CSS.
    if (type === "FRAME" && hasOwnSurface(node)) return false;
    const kids = (get<readonly SceneNode[]>(node, "children") ?? []).filter((k) => get(k as AnyNode, "visible") !== false);
    // A row of icons keeps its layout; each icon collapses on its own.
    if (get(node, "layoutMode") && get(node, "layoutMode") !== "NONE" && kids.length > 1) return false;
  }
  return true;
}

function graphicColors(node: AnyNode, ctx: Ctx): NonNullable<RawNode["graphic"]> {
  const colors: string[] = [];
  const vars: string[] = [];
  let allBound = true;
  let nodes = 0;
  const visit = (n: AnyNode) => {
    // The root may be hidden (a toggled-off icon in a component); its colours still matter.
    if (n !== node && get(n, "visible") === false) return;
    nodes++;
    for (const key of ["fills", "strokes"]) {
      for (const p of visiblePaints(get(n, key))) {
        let c: string;
        if (p.type === "SOLID") c = colorHex(p.color, p.opacity ?? 1);
        else if (String(p.type).startsWith("GRADIENT")) c = "gradient";
        else continue;
        if (!colors.includes(c) && colors.length < 6) {
          colors.push(c);
          const v = p.boundVariables?.color?.id;
          if (v) {
            vars.push(v);
            ctx.variableIds.add(v);
          } else allBound = false;
        }
      }
    }
    for (const k of get<readonly SceneNode[]>(n, "children") ?? []) visit(k as AnyNode);
  };
  visit(node);
  const out: NonNullable<RawNode["graphic"]> = { colors, nodes };
  if (allBound && vars.length === colors.length && vars.length > 0) out.colorVars = vars;
  return out;
}

/* ------------------------------------------------------------------ */
/* Paints & effects                                                    */
/* ------------------------------------------------------------------ */

function cloneColor(c: any): { r: number; g: number; b: number; a?: number } {
  const out: { r: number; g: number; b: number; a?: number } = { r: c.r, g: c.g, b: c.b };
  if (typeof c.a === "number" && c.a < 1) out.a = c.a;
  return out;
}

function alias(a: any, ctx: Ctx): { id: string } | undefined {
  if (a && typeof a.id === "string") {
    ctx.variableIds.add(a.id);
    return { id: a.id };
  }
  return undefined;
}

export function clonePaints(paints: unknown, ctx: Ctx): RawPaint[] | undefined {
  if (!Array.isArray(paints) || paints.length === 0) return undefined;
  const out: RawPaint[] = [];
  for (const p of paints) {
    if (!p || typeof p !== "object") continue;
    const c: RawPaint = { type: p.type };
    if (p.visible === false) c.visible = false;
    if (typeof p.opacity === "number" && p.opacity < 1) c.opacity = p.opacity;
    if (p.blendMode && p.blendMode !== "NORMAL" && p.blendMode !== "PASS_THROUGH") c.blendMode = p.blendMode;
    if (p.color) c.color = cloneColor(p.color);
    const bv = alias(p.boundVariables?.color, ctx);
    if (bv) c.boundVariables = { color: bv };
    if (Array.isArray(p.gradientTransform)) c.gradientTransform = p.gradientTransform.map((row: number[]) => [...row]);
    if (Array.isArray(p.gradientStops)) {
      c.gradientStops = p.gradientStops.map((s: any) => {
        const stop: NonNullable<RawPaint["gradientStops"]>[number] = { position: s.position, color: cloneColor(s.color) };
        const sv = alias(s.boundVariables?.color, ctx);
        if (sv) stop.boundVariables = { color: sv };
        return stop;
      });
    }
    if (p.type === "IMAGE" || p.type === "VIDEO") {
      c.imageHash = p.imageHash ?? p.videoHash ?? null;
      c.scaleMode = p.scaleMode;
      if (Array.isArray(p.imageTransform)) c.imageTransform = p.imageTransform.map((row: number[]) => [...row]);
      if (typeof p.scalingFactor === "number") c.scalingFactor = p.scalingFactor;
      if (typeof p.rotation === "number" && p.rotation) c.rotation = p.rotation;
      if (p.filters) {
        const f: Record<string, number> = {};
        for (const [k, v] of Object.entries(p.filters)) if (typeof v === "number" && v !== 0) f[k] = v;
        if (Object.keys(f).length) c.filters = f;
      }
    }
    out.push(c);
  }
  return out.length ? out : undefined;
}

function cloneEffects(effects: unknown, ctx: Ctx): RawEffect[] | undefined {
  if (!Array.isArray(effects) || effects.length === 0) return undefined;
  const out: RawEffect[] = [];
  for (const e of effects) {
    if (!e || e.visible === false) continue;
    const c: RawEffect = { type: e.type };
    if (e.color) c.color = cloneColor(e.color);
    if (e.offset) c.offset = { x: r2(e.offset.x), y: r2(e.offset.y) };
    if (typeof e.radius === "number") c.radius = r2(e.radius);
    if (typeof e.spread === "number" && e.spread) c.spread = r2(e.spread);
    if (e.blendMode && e.blendMode !== "NORMAL") c.blendMode = e.blendMode;
    if (e.showShadowBehindNode) c.showShadowBehindNode = true;
    if (e.blurType && e.blurType !== "NORMAL") {
      c.blurType = e.blurType;
      if (typeof e.startRadius === "number") c.startRadius = e.startRadius;
    }
    if (e.boundVariables) {
      const bv: Record<string, { id: string }> = {};
      for (const [k, v] of Object.entries(e.boundVariables)) {
        const a = alias(v, ctx);
        if (a) bv[k] = a;
      }
      if (Object.keys(bv).length) c.boundVariables = bv;
    }
    out.push(c);
  }
  return out.length ? out : undefined;
}

/* ------------------------------------------------------------------ */
/* Text                                                                */
/* ------------------------------------------------------------------ */

const SEGMENT_FIELDS_FULL = [
  "fontName",
  "fontWeight",
  "fontSize",
  "lineHeight",
  "letterSpacing",
  "fills",
  "textDecoration",
  "textCase",
  "textStyleId",
  "fillStyleId",
  "hyperlink",
  "listOptions",
  "indentation",
  "paragraphSpacing",
  "paragraphIndent",
  "openTypeFeatures",
  "boundVariables",
] as const;

const SEGMENT_FIELDS_BASE = [
  "fontName",
  "fontSize",
  "lineHeight",
  "letterSpacing",
  "fills",
  "textDecoration",
  "textCase",
  "textStyleId",
  "hyperlink",
] as const;

const WEIGHTS: Record<string, number> = {
  thin: 100, hairline: 100, extralight: 200, ultralight: 200, light: 300, normal: 400, regular: 400,
  book: 400, medium: 500, semibold: 600, demibold: 600, bold: 700, extrabold: 800, ultrabold: 800,
  black: 900, heavy: 900,
};

export function weightFromStyle(style: string): number {
  return WEIGHTS[style.toLowerCase().replace(/\s+|-|italic|oblique/g, "")] ?? 400;
}

function textSegments(node: TextNode, ctx: Ctx): RawSegment[] | undefined {
  let segs: any[] | undefined;
  try {
    segs = node.getStyledTextSegments(SEGMENT_FIELDS_FULL as unknown as any);
  } catch {
    try {
      segs = node.getStyledTextSegments(SEGMENT_FIELDS_BASE as unknown as any);
    } catch {
      return undefined;
    }
  }
  return segs.map((s) => {
    const seg: RawSegment = {
      characters: s.characters,
      start: s.start,
      end: s.end,
      fontFamily: s.fontName?.family ?? "",
      fontStyle: s.fontName?.style ?? "Regular",
      fontWeight: typeof s.fontWeight === "number" ? s.fontWeight : weightFromStyle(s.fontName?.style ?? ""),
      fontSize: r2(s.fontSize),
      lineHeight: s.lineHeight?.unit === "AUTO" ? { unit: "AUTO" } : { unit: s.lineHeight.unit, value: r2(s.lineHeight.value) },
      letterSpacing: { unit: s.letterSpacing?.unit ?? "PIXELS", value: r2(s.letterSpacing?.value ?? 0) },
      fills: clonePaints(s.fills, ctx) ?? [],
    };
    if (s.textDecoration && s.textDecoration !== "NONE") seg.textDecoration = s.textDecoration;
    if (s.textCase && s.textCase !== "ORIGINAL") seg.textCase = s.textCase;
    if (s.textStyleId) {
      seg.textStyleId = s.textStyleId;
      ctx.styleIds.add(s.textStyleId);
    }
    if (s.fillStyleId) {
      seg.fillStyleId = s.fillStyleId;
      ctx.styleIds.add(s.fillStyleId);
    }
    if (s.hyperlink) {
      seg.hyperlink = { type: s.hyperlink.type, value: s.hyperlink.value };
      if (s.hyperlink.type === "NODE") ctx.nodeRefs.add(s.hyperlink.value);
    }
    if (s.listOptions && s.listOptions.type !== "NONE") seg.listType = s.listOptions.type;
    if (s.indentation) seg.indentation = s.indentation;
    if (s.paragraphSpacing) seg.paragraphSpacing = r2(s.paragraphSpacing);
    if (s.paragraphIndent) seg.paragraphIndent = r2(s.paragraphIndent);
    if (s.openTypeFeatures) {
      const on: Record<string, boolean> = {};
      for (const [k, v] of Object.entries(s.openTypeFeatures)) if (typeof v === "boolean") on[k] = v;
      if (Object.keys(on).length) seg.openTypeFeatures = on;
    }
    if (s.boundVariables) {
      const bv: Record<string, { id: string }> = {};
      for (const [k, v] of Object.entries(s.boundVariables)) {
        const a = alias(v, ctx);
        if (a) bv[k] = a;
      }
      if (Object.keys(bv).length) seg.boundVariables = bv;
    }
    return seg;
  });
}

/* ------------------------------------------------------------------ */
/* Prototype reactions                                                 */
/* ------------------------------------------------------------------ */

function reactionsOf(node: AnyNode, ctx: Ctx): RawReaction[] | undefined {
  const reactions = get<readonly Reaction[]>(node, "reactions");
  if (!Array.isArray(reactions) || reactions.length === 0) return undefined;
  const out: RawReaction[] = [];
  for (const r of reactions as any[]) {
    const trigger = r.trigger;
    if (!trigger) continue;
    const actions: any[] = Array.isArray(r.actions) && r.actions.length ? r.actions : r.action ? [r.action] : [];
    for (const a of actions) {
      if (!a) continue;
      const rr: RawReaction = { trigger: trigger.type, action: a.type };
      if (typeof trigger.timeout === "number") rr.timeout = trigger.timeout;
      if (typeof trigger.delay === "number" && trigger.delay) rr.delay = trigger.delay;
      if (a.type === "NODE") {
        rr.navigation = a.navigation;
        if (a.destinationId) {
          rr.destinationId = a.destinationId;
          ctx.nodeRefs.add(a.destinationId);
        }
        if (a.transition) {
          rr.transition = a.transition.type;
          if (typeof a.transition.duration === "number") rr.duration = a.transition.duration;
        }
      } else if (a.type === "URL") {
        rr.url = a.url;
      }
      out.push(rr);
    }
  }
  return out.length ? out : undefined;
}

/* ------------------------------------------------------------------ */
/* Node                                                                */
/* ------------------------------------------------------------------ */

const LAYOUT_KEYS = [
  "itemSpacing",
  "paddingTop",
  "paddingRight",
  "paddingBottom",
  "paddingLeft",
] as const;

function num(node: AnyNode, key: string): number | undefined {
  const v = get(node, key);
  return typeof v === "number" && Number.isFinite(v) ? r2(v) : undefined;
}

export function serializeNode(node: AnyNode, depthLeft: number | undefined, ctx: Ctx, parent?: AnyNode): RawNode {
  const raw: RawNode = {
    id: node.id,
    name: node.name,
    type: node.type,
    w: r2(get<number>(node, "width") ?? 0),
    h: r2(get<number>(node, "height") ?? 0),
  };
  ctx.count++;

  const visible = get(node, "visible") !== false;
  if (!visible) {
    raw.visible = false;
    // Layers a boolean component property toggles are part of the component's
    // design even while hidden, so definitions keep them in full.
    const toggled = !!get<Record<string, string> | null>(node, "componentPropertyReferences")?.visible;
    if (!ctx.opts.includeHidden && !toggled) {
      raw.stub = true;
      return raw;
    }
  }

  const bb = get<Rect>(node, "absoluteBoundingBox");
  if (bb) raw.bb = [r2(bb.x), r2(bb.y), r2(bb.width), r2(bb.height)];
  const rotation = get<number>(node, "rotation");
  if (typeof rotation === "number" && Math.abs(rotation) > 0.01) raw.rotation = r2(rotation);

  const mixed = ctx.api.mixed;

  // Auto layout container.
  const layoutMode = get<string>(node, "layoutMode");
  if (layoutMode && layoutMode !== "NONE") {
    raw.layoutMode = layoutMode as RawNode["layoutMode"];
    for (const k of LAYOUT_KEYS) {
      const v = num(node, k);
      if (v) raw[k] = v;
    }
    if (get(node, "layoutWrap") === "WRAP") raw.layoutWrap = "WRAP";
    const cas = get(node, "counterAxisSpacing");
    if (typeof cas === "number" && cas) raw.counterAxisSpacing = r2(cas);
    const pa = get<string>(node, "primaryAxisAlignItems");
    if (pa && pa !== "MIN") raw.primaryAxisAlignItems = pa;
    const ca = get<string>(node, "counterAxisAlignItems");
    if (ca && ca !== "MIN") raw.counterAxisAlignItems = ca;
    const cac = get<string>(node, "counterAxisAlignContent");
    if (cac && cac !== "AUTO") raw.counterAxisAlignContent = cac;
    if (get(node, "itemReverseZIndex") === true) raw.itemReverseZIndex = true;
    if (get(node, "strokesIncludedInLayout") === true) raw.strokesIncludedInLayout = true;
    if (layoutMode === "GRID") {
      raw.gridRowCount = get(node, "gridRowCount");
      raw.gridColumnCount = get(node, "gridColumnCount");
      const rg = num(node, "gridRowGap");
      const cg = num(node, "gridColumnGap");
      if (rg) raw.gridRowGap = rg;
      if (cg) raw.gridColumnGap = cg;
      const tracks = (v: unknown) =>
        Array.isArray(v) ? v.map((t: any) => (typeof t.value === "number" ? { type: t.type, value: r2(t.value) } : { type: t.type })) : undefined;
      raw.gridRowSizes = tracks(get(node, "gridRowSizes"));
      raw.gridColumnSizes = tracks(get(node, "gridColumnSizes"));
    }
  }

  // As a child of an auto layout parent, or an auto layout frame itself.
  const parentLayout = parent ? get<string>(parent, "layoutMode") : undefined;
  const inFlow = !!parentLayout && parentLayout !== "NONE";
  if (get(node, "layoutPositioning") === "ABSOLUTE") raw.layoutPositioning = "ABSOLUTE";
  if (inFlow || raw.layoutMode || node.type === "TEXT") {
    const sh = get<string>(node, "layoutSizingHorizontal");
    const sv = get<string>(node, "layoutSizingVertical");
    if (sh) raw.layoutSizingHorizontal = sh as RawNode["layoutSizingHorizontal"];
    if (sv) raw.layoutSizingVertical = sv as RawNode["layoutSizingVertical"];
  }
  if (inFlow) {
    const grow = get<number>(node, "layoutGrow");
    if (grow) raw.layoutGrow = grow;
    const align = get<string>(node, "layoutAlign");
    if (align && align !== "INHERIT") raw.layoutAlign = align;
    if (parentLayout === "GRID" && raw.layoutPositioning !== "ABSOLUTE") {
      raw.gridRowAnchorIndex = get(node, "gridRowAnchorIndex");
      raw.gridColumnAnchorIndex = get(node, "gridColumnAnchorIndex");
      const rs = get<number>(node, "gridRowSpan");
      const cs = get<number>(node, "gridColumnSpan");
      if (rs && rs > 1) raw.gridRowSpan = rs;
      if (cs && cs > 1) raw.gridColumnSpan = cs;
    }
  }
  const cons = get<Constraints>(node, "constraints");
  if (cons && (!inFlow || raw.layoutPositioning === "ABSOLUTE") && (cons.horizontal !== "MIN" || cons.vertical !== "MIN")) {
    raw.constraints = { horizontal: cons.horizontal, vertical: cons.vertical };
  }
  for (const k of ["minWidth", "maxWidth", "minHeight", "maxHeight"] as const) {
    const v = get(node, k);
    if (typeof v === "number") raw[k] = r2(v);
  }

  // Appearance.
  const fills = get(node, "fills");
  if (fills !== mixed) raw.fills = clonePaints(fills, ctx);
  const strokes = clonePaints(get(node, "strokes"), ctx);
  if (strokes && strokes.some((s) => s.visible !== false)) {
    raw.strokes = strokes;
    const sw = get(node, "strokeWeight");
    if (typeof sw === "number") raw.strokeWeight = r2(sw);
    for (const k of ["strokeTopWeight", "strokeRightWeight", "strokeBottomWeight", "strokeLeftWeight"] as const) {
      const v = get(node, k);
      if (typeof v === "number" && (sw === mixed || v !== sw)) raw[k] = r2(v);
    }
    const sa = get<string>(node, "strokeAlign");
    if (sa) raw.strokeAlign = sa;
    const dash = get<number[]>(node, "dashPattern");
    if (Array.isArray(dash) && dash.length) raw.dashPattern = dash.map(r2);
  }
  const cr = get(node, "cornerRadius");
  if (typeof cr === "number") {
    if (cr) raw.cornerRadius = r2(cr);
  } else if (cr === mixed) {
    const c = ["topLeftRadius", "topRightRadius", "bottomRightRadius", "bottomLeftRadius"].map((k) => r2(get<number>(node, k) ?? 0));
    raw.radii = c as [number, number, number, number];
  }
  const smooth = get<number>(node, "cornerSmoothing");
  if (smooth) raw.cornerSmoothing = r2(smooth);
  raw.effects = cloneEffects(get(node, "effects"), ctx);
  const opacity = get<number>(node, "opacity");
  if (typeof opacity === "number" && opacity < 1) raw.opacity = r2(opacity);
  const blend = get<string>(node, "blendMode");
  if (blend && blend !== "PASS_THROUGH" && blend !== "NORMAL") raw.blendMode = blend;
  if (get(node, "clipsContent") === true) raw.clipsContent = true;
  if (get(node, "isMask") === true) {
    raw.isMask = true;
    raw.maskType = get(node, "maskType");
  }
  const arc = get<any>(node, "arcData");
  if (arc && isPartialArc(node)) raw.arcData = { startingAngle: arc.startingAngle, endingAngle: arc.endingAngle, innerRadius: arc.innerRadius };

  for (const k of ["fillStyleId", "strokeStyleId", "effectStyleId", "textStyleId"] as const) {
    const v = get(node, k);
    if (typeof v === "string" && v) {
      raw[k] = v;
      ctx.styleIds.add(v);
    }
  }
  const bvs = get<Record<string, unknown>>(node, "boundVariables");
  if (bvs) {
    const out: Record<string, { id: string }> = {};
    for (const [k, v] of Object.entries(bvs)) {
      if (Array.isArray(v) || k === "componentProperties") continue;
      const a = alias(v, ctx);
      if (a) out[k] = a;
    }
    if (Object.keys(out).length) raw.boundVariables = out;
  }
  const grids = get<readonly LayoutGrid[]>(node, "layoutGrids");
  if (Array.isArray(grids) && grids.some((g) => g.visible !== false)) {
    raw.layoutGrids = grids
      .filter((g) => g.visible !== false)
      .map((g: any) => {
        const o: Record<string, unknown> = { pattern: g.pattern };
        for (const k of ["sectionSize", "gutterSize", "alignment", "count", "offset"]) if (g[k] !== undefined) o[k] = g[k];
        return o;
      });
  }

  // Text.
  if (node.type === "TEXT") {
    const t = node as TextNode;
    raw.characters = t.characters;
    raw.segments = textSegments(t, ctx);
    const ar = get<string>(node, "textAutoResize");
    if (ar && ar !== "NONE") raw.textAutoResize = ar;
    const ah = get<string>(node, "textAlignHorizontal");
    if (ah && ah !== "LEFT") raw.textAlignHorizontal = ah;
    const av = get<string>(node, "textAlignVertical");
    if (av && av !== "TOP") raw.textAlignVertical = av;
    if (get(node, "textTruncation") === "ENDING") {
      raw.textTruncation = "ENDING";
      const ml = get<number | null>(node, "maxLines");
      if (typeof ml === "number") raw.maxLines = ml;
    }
    const lt = get(node, "leadingTrim");
    if (typeof lt === "string" && lt !== "NONE") raw.leadingTrim = lt;
  }

  // Components.
  if (node.type === "INSTANCE") {
    ctx.instances.push({ node: node as InstanceNode, raw });
    const props = get<Record<string, any>>(node, "componentProperties");
    if (props && Object.keys(props).length) {
      raw.componentProperties = {};
      for (const [k, p] of Object.entries(props)) {
        raw.componentProperties[k] = { type: p.type, value: p.value };
        if (p.type === "INSTANCE_SWAP" && typeof p.value === "string") ctx.nodeRefs.add(p.value);
      }
    }
  }
  const refs = get<Record<string, string> | null>(node, "componentPropertyReferences");
  if (refs && Object.keys(refs).length) raw.componentPropertyReferences = { ...refs };
  if (node.type === "COMPONENT" || node.type === "COMPONENT_SET") {
    const key = get<string>(node, "key");
    if (key) raw.componentKey = key;
    const desc = get<string>(node, "description");
    if (desc) raw.description = desc;
    const defs = get<Record<string, any>>(node, "componentPropertyDefinitions");
    if (defs && Object.keys(defs).length) raw.propertyDefinitions = cloneDefs(defs);
  }

  // Hand-off.
  const anns = get<readonly Annotation[]>(node, "annotations");
  if (Array.isArray(anns) && anns.length) {
    raw.annotations = anns
      .map((a) => ({ label: a.labelMarkdown || a.label || "", properties: (a.properties ?? []).map((p: { type: string }) => p.type) }))
      .filter((a) => a.label || a.properties.length);
    if (!raw.annotations.length) delete raw.annotations;
  }
  const dev = get<{ type: string } | null>(node, "devStatus");
  if (dev && dev.type) raw.devStatus = dev.type;
  const ex = get<readonly ExportSettings[]>(node, "exportSettings");
  if (Array.isArray(ex) && ex.length) {
    raw.exportSettings = ex.map((s: any) => ({ format: s.format, suffix: s.suffix || undefined, constraint: s.constraint }));
  }
  raw.reactions = reactionsOf(node, ctx);

  // Children (or a collapsed graphic).
  if (isGraphic(node, ctx)) {
    raw.graphic = graphicColors(node, ctx);
    return clean(raw);
  }
  const kids = get<readonly SceneNode[]>(node, "children");
  if (kids && kids.length) {
    if (depthLeft === 0 || ctx.count >= ctx.opts.maxNodes) {
      raw.childCount = kids.length;
      if (depthLeft !== 0) ctx.truncated = true;
    } else {
      const next = depthLeft === undefined ? undefined : depthLeft - 1;
      raw.children = [];
      for (const kid of kids) {
        if (ctx.count >= ctx.opts.maxNodes) {
          ctx.truncated = true;
          raw.childCount = kids.length - raw.children.length;
          break;
        }
        try {
          raw.children.push(serializeNode(kid as AnyNode, next, ctx, node));
        } catch (e) {
          raw.children.push({ id: kid.id, name: kid.name, type: kid.type, w: 0, h: 0, stub: true });
        }
      }
    }
  }
  return clean(raw);
}

function cloneDefs(defs: Record<string, any>): NonNullable<RawNode["propertyDefinitions"]> {
  const out: NonNullable<RawNode["propertyDefinitions"]> = {};
  for (const [k, d] of Object.entries(defs)) {
    out[k] = { type: d.type, defaultValue: d.defaultValue };
    if (Array.isArray(d.variantOptions)) out[k]!.variantOptions = [...d.variantOptions];
  }
  return out;
}

/** Drop undefined keys so the JSON stays small. */
function clean<T extends object>(o: T): T {
  for (const k of Object.keys(o) as (keyof T)[]) if (o[k] === undefined) delete o[k];
  return o;
}

/* ------------------------------------------------------------------ */
/* Snapshot                                                            */
/* ------------------------------------------------------------------ */

async function componentInfo(main: ComponentNode, ctx: Ctx): Promise<RawComponentInfo> {
  const info: RawComponentInfo = { id: main.id, name: main.name };
  const m = main as unknown as AnyNode;
  const key = get<string>(m, "key");
  if (key) info.key = key;
  if (get(m, "remote") === true) info.remote = true;
  const desc = get<string>(m, "description");
  if (desc) info.description = desc;
  const parent = get<BaseNode | null>(m, "parent");
  if (parent && parent.type === "COMPONENT_SET") {
    info.setId = parent.id;
    info.setName = parent.name;
    const vp = get<Record<string, string> | null>(m, "variantProperties");
    if (vp) info.variant = { ...vp };
    const defs = get<Record<string, any>>(parent as unknown as AnyNode, "componentPropertyDefinitions");
    if (defs) info.propertyDefinitions = cloneDefs(defs);
    const setDesc = get<string>(parent as unknown as AnyNode, "description");
    if (!info.description && setDesc) info.description = setDesc;
  } else {
    const defs = get<Record<string, any>>(m, "componentPropertyDefinitions");
    if (defs && Object.keys(defs).length) info.propertyDefinitions = cloneDefs(defs);
  }
  info.isGraphic = !ctx.opts.expandVectors && isGraphic(m, ctx);
  return info;
}

function ancestry(node: BaseNode): string[] {
  const names: string[] = [];
  let p = node.parent;
  while (p && p.type !== "PAGE" && p.type !== "DOCUMENT") {
    names.unshift(p.name);
    p = p.parent;
  }
  return names;
}

/** Display name for a component referenced by id (instance-swap values, swap targets). */
async function componentDisplayName(api: FigmaApi, id: string): Promise<string | undefined> {
  const n = await api.getNodeByIdAsync(id);
  if (!n) return undefined;
  if (n.type === "COMPONENT" && n.parent && n.parent.type === "COMPONENT_SET") {
    return `${n.parent.name}{${n.name.replace(/\s*,\s*/g, ", ")}}`;
  }
  return n.name;
}

export async function snapshot(
  api: FigmaApi,
  roots: SceneNode[],
  params: SnapshotParams,
  meta: { fileName: string; pageName: string },
): Promise<RawSnapshot> {
  const started = Date.now();
  const ctx: Ctx = {
    api,
    opts: {
      depth: params.depth,
      maxNodes: params.maxNodes ?? 30000,
      includeHidden: params.includeHidden ?? false,
      components: params.components ?? true,
      expandVectors: params.expandVectors ?? false,
    },
    count: 0,
    truncated: false,
    instances: [],
    styleIds: new Set(),
    variableIds: new Set(),
    nodeRefs: new Set(),
    graphicMemo: new Map(),
  };

  const out: RawSnapshot = {
    fileName: meta.fileName,
    pageName: meta.pageName,
    roots: [],
    ancestry: {},
    components: {},
    variables: {},
    styles: {},
    nodeNames: {},
    stats: { nodes: 0, truncated: false, ms: 0 },
    missing: [],
  };

  for (const root of roots) {
    const parent = root.parent && root.parent.type !== "PAGE" ? (root.parent as unknown as AnyNode) : undefined;
    out.roots.push(serializeNode(root as AnyNode, params.depth, ctx, parent));
    out.ancestry[root.id] = ancestry(root);
  }

  // Resolve main components; serializing a definition can reveal more instances.
  let cursor = 0;
  while (cursor < ctx.instances.length) {
    const batch = ctx.instances.slice(cursor);
    cursor = ctx.instances.length;
    const mains = await Promise.all(
      batch.map(async ({ node }) => {
        try {
          return await node.getMainComponentAsync();
        } catch {
          return null;
        }
      }),
    );
    for (let i = 0; i < batch.length; i++) {
      const main = mains[i];
      const entry = batch[i]!;
      if (!main) continue;
      entry.raw.mainComponentId = main.id;
      if (out.components[main.id]) continue;
      const info = await componentInfo(main, ctx);
      out.components[main.id] = info;
      if (ctx.opts.components && !info.isGraphic && ctx.count < ctx.opts.maxNodes) {
        info.tree = serializeNode(main as unknown as AnyNode, undefined, ctx);
      }
    }
  }

  await Promise.all([
    ...[...ctx.styleIds].map(async (id) => {
      try {
        const s = await api.getStyleByIdAsync(id);
        if (s) out.styles[id] = { id, name: s.name, type: s.type, ...(s.description ? { description: s.description } : {}) };
      } catch {
        /* deleted or inaccessible library style */
      }
    }),
    (async () => {
      const collections = new Map<string, string | undefined>();
      await Promise.all(
        [...ctx.variableIds].map(async (id) => {
          try {
            const v = await api.variables.getVariableByIdAsync(id);
            if (!v) return;
            const web = v.codeSyntax?.WEB;
            out.variables[id] = { id, name: v.name, type: v.resolvedType, ...(web ? { web } : {}) };
            if (!collections.has(v.variableCollectionId)) {
              collections.set(v.variableCollectionId, undefined);
              try {
                const c = await api.variables.getVariableCollectionByIdAsync(v.variableCollectionId);
                collections.set(v.variableCollectionId, c?.name);
              } catch {
                /* remote collection */
              }
            }
            const cname = collections.get(v.variableCollectionId);
            if (cname) out.variables[id]!.collection = cname;
          } catch {
            /* unresolvable alias */
          }
        }),
      );
      // Second pass: collection names that resolved after their variables did.
      for (const v of Object.values(out.variables)) {
        if (!v.collection) {
          const raw = await api.variables.getVariableByIdAsync(v.id).catch(() => null);
          const cname = raw ? collections.get(raw.variableCollectionId) : undefined;
          if (cname) v.collection = cname;
        }
      }
    })(),
    ...[...ctx.nodeRefs].map(async (id) => {
      try {
        const name = await componentDisplayName(api, id);
        if (name) out.nodeNames[id] = name;
      } catch {
        /* missing destination */
      }
    }),
  ]);

  out.stats = { nodes: ctx.count, truncated: ctx.truncated, ms: Date.now() - started };
  return out;
}
