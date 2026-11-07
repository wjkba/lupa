/**
 * A tiny in-memory stand-in for the Figma plugin API: enough of SceneNode,
 * styles, variables and instances for the extractor to run in Node.
 *
 * Instances are built the way Figma builds them: sublayers are clones of the
 * main component's layers with ids `I<instance>;<layer id in main>`, then
 * overrides are applied by that id path.
 */

import type { FigmaApi } from "../plugin/src/extract";

export type Spec = Record<string, any> & {
  type: string;
  name?: string;
  x?: number;
  y?: number;
  w?: number;
  h?: number;
  children?: Spec[];
};

export const MIXED = Symbol("mixed");

const BASE: Record<string, unknown> = {
  visible: true,
  opacity: 1,
  blendMode: "PASS_THROUGH",
  rotation: 0,
  effects: [],
  strokes: [],
  fills: [],
  layoutMode: "NONE",
  constraints: { horizontal: "MIN", vertical: "MIN" },
};

export function solid(hex: string, extra: Record<string, unknown> = {}) {
  const v = hex.replace("#", "");
  return {
    type: "SOLID",
    visible: true,
    opacity: 1,
    blendMode: "NORMAL",
    color: { r: parseInt(v.slice(0, 2), 16) / 255, g: parseInt(v.slice(2, 4), 16) / 255, b: parseInt(v.slice(4, 6), 16) / 255 },
    ...extra,
  };
}

export class FakeFile {
  readonly nodes = new Map<string, any>();
  readonly styles = new Map<string, { id: string; name: string; type: string; description?: string }>();
  readonly variables = new Map<string, any>();
  readonly collections = new Map<string, { id: string; name: string }>();
  private seq = 1;

  readonly api: FigmaApi = {
    mixed: MIXED,
    getNodeByIdAsync: async (id: string) => this.nodes.get(id) ?? null,
    getStyleByIdAsync: async (id: string) => (this.styles.get(id) as any) ?? null,
    variables: {
      getVariableByIdAsync: async (id: string) => this.variables.get(id) ?? null,
      getVariableCollectionByIdAsync: async (id: string) => (this.collections.get(id) as any) ?? null,
    },
  };

  style(name: string, type = "PAINT", description?: string): string {
    const id = `S:${name}`;
    this.styles.set(id, { id, name, type, ...(description ? { description } : {}) });
    return id;
  }

  variable(name: string, collection = "Tokens", web?: string, type = "COLOR"): string {
    const cid = `VC:${collection}`;
    this.collections.set(cid, { id: cid, name: collection });
    const id = `V:${name}`;
    this.variables.set(id, { id, name, resolvedType: type, variableCollectionId: cid, codeSyntax: web ? { WEB: web } : {} });
    return id;
  }

  /** Create a node (and its subtree) from a spec. Absolute positions accumulate from parents. */
  node(spec: Spec, parent?: any, idOverride?: string): any {
    const id = idOverride ?? spec.id ?? `${this.seq++}:1`;
    const { children, x = 0, y = 0, w = 0, h = 0, text, segments, ...rest } = spec;
    const px = parent?.absoluteBoundingBox?.x ?? 0;
    const py = parent?.absoluteBoundingBox?.y ?? 0;
    const node: any = {
      ...BASE,
      ...rest,
      id,
      name: spec.name ?? spec.type.charAt(0) + spec.type.slice(1).toLowerCase(),
      width: w,
      height: h,
      absoluteBoundingBox: { x: px + x, y: py + y, width: w, height: h },
      parent: parent ?? null,
    };
    if (spec.type === "TEXT") {
      node.characters = text ?? "";
      const segs: any[] = segments ?? [{}];
      let start = 0;
      const resolved = segs.map((s, i) => {
        const chars = s.characters ?? (i === segs.length - 1 ? node.characters.slice(start) : "");
        const seg = {
          characters: chars,
          start,
          end: start + chars.length,
          fontName: { family: "Inter", style: "Regular" },
          fontWeight: 400,
          fontSize: 14,
          lineHeight: { unit: "PIXELS", value: 20 },
          letterSpacing: { unit: "PIXELS", value: 0 },
          fills: node.fills,
          textDecoration: "NONE",
          textCase: "ORIGINAL",
          textStyleId: "",
          fillStyleId: "",
          hyperlink: null,
          listOptions: { type: "NONE" },
          indentation: 0,
          paragraphSpacing: 0,
          paragraphIndent: 0,
          openTypeFeatures: {},
          boundVariables: {},
          ...spec.font,
          ...s,
        };
        start += chars.length;
        return seg;
      });
      node.getStyledTextSegments = () => resolved;
      node.textAutoResize ??= "WIDTH_AND_HEIGHT";
      node.textAlignHorizontal ??= "LEFT";
      node.textAlignVertical ??= "TOP";
    }
    if (spec.type === "FRAME" || spec.type === "COMPONENT" || spec.type === "INSTANCE") node.clipsContent ??= false;
    this.nodes.set(id, node);
    node.children = (children ?? []).map((c: Spec) => this.node(c, node));
    if (!children && !["FRAME", "GROUP", "COMPONENT", "INSTANCE", "COMPONENT_SET", "SECTION", "BOOLEAN_OPERATION", "PAGE"].includes(spec.type)) {
      delete node.children;
    }
    return node;
  }

  component(spec: Omit<Spec, "type"> & { type?: string }, parent?: any, variant?: Record<string, string>): any {
    const main = this.node({ ...spec, type: "COMPONENT" }, parent);
    main.key = `key-${main.id}`;
    main.description = spec.description ?? "";
    parent?.children?.push(main);
    if (parent?.type === "COMPONENT_SET") {
      main.variantProperties = variant ?? {};
      Object.defineProperty(main, "componentPropertyDefinitions", {
        get() {
          throw new Error("Can only get component property definitions of a component set or non-variant component");
        },
      });
    } else main.componentPropertyDefinitions = spec.props ?? {};
    return main;
  }

  componentSet(name: string, props: Record<string, any>): any {
    const set = this.node({ type: "COMPONENT_SET", name, w: 0, h: 0 });
    set.componentPropertyDefinitions = props;
    return set;
  }

  /**
   * Instantiate `main` under `parent` at (x, y). `overrides` maps a layer id
   * in the main component to properties to replace on the clone.
   */
  instance(main: any, parent: any, at: Partial<Spec> = {}, overrides: Record<string, Record<string, any>> = {}, props: Record<string, any> = {}): any {
    const id = at.id ?? `${this.seq++}:1`;
    const inst = this.cloneInto(main, parent, id, id, overrides, at);
    inst.type = "INSTANCE";
    inst.name = at.name ?? main.name;
    inst.getMainComponentAsync = async () => main;
    inst.componentProperties = props;
    delete inst.componentPropertyDefinitions;
    delete inst.key;
    parent?.children?.push(inst);
    return inst;
  }

  private cloneInto(src: any, parent: any, id: string, instId: string, overrides: Record<string, Record<string, any>>, at: Partial<Spec>): any {
    const px = parent?.absoluteBoundingBox?.x ?? 0;
    const py = parent?.absoluteBoundingBox?.y ?? 0;
    const srcParentBB = src.parent?.absoluteBoundingBox ?? { x: 0, y: 0 };
    const isRoot = id === instId;
    const relX = isRoot ? at.x ?? 0 : src.absoluteBoundingBox.x - srcParentBB.x;
    const relY = isRoot ? at.y ?? 0 : src.absoluteBoundingBox.y - srcParentBB.y;
    const key = isRoot ? "" : id.slice(`I${instId};`.length);
    const ov = overrides[key] ?? {};
    const copy: any = { ...src, ...ov, id, parent: parent ?? null };
    copy.width = ov.w ?? (isRoot ? at.w ?? src.width : src.width);
    copy.height = ov.h ?? (isRoot ? at.h ?? src.height : src.height);
    copy.absoluteBoundingBox = { x: px + relX, y: py + relY, width: copy.width, height: copy.height };
    if (isRoot) Object.assign(copy, Object.fromEntries(Object.entries(at).filter(([k]) => !["x", "y", "w", "h", "id", "name"].includes(k))));
    if (src.type === "TEXT") {
      const text = ov.text ?? src.characters;
      copy.characters = text;
      const segs = src.getStyledTextSegments().map((s: any) => ({ ...s, ...(ov.font ?? {}) }));
      if (ov.text !== undefined) {
        segs.splice(1);
        segs[0] = { ...segs[0], characters: text, start: 0, end: text.length };
      }
      if (ov.fills) for (const s of segs) s.fills = ov.fills;
      copy.getStyledTextSegments = () => segs;
    }
    this.nodes.set(id, copy);
    if (src.children) {
      // A layer's id in the main already encodes its full path (`I<nested>;<id>`).
      const keyOf = (c: any) => String(c.id).replace(/^I/, "");
      copy.children = src.children
        .filter((c: any) => (overrides[keyOf(c)]?.visible ?? c.visible) !== false) // skipInvisibleInstanceChildren
        .map((c: any) => this.cloneInto(c, copy, `I${instId};${keyOf(c)}`, instId, overrides, {}));
    }
    if (src.type === "INSTANCE" && !isRoot) copy.getMainComponentAsync = src.getMainComponentAsync;
    return copy;
  }
}
