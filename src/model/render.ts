/**
 * IR → the compact text an agent reads.
 *
 *   frame "Card" #1:23 360×480 col; gap:16; p:24; bg:#fff; radius:12; shadow:E1
 *     text #1:25 312×24 w:fill; font:T1; color:$text/primary; "Wireless headphones"
 *
 * One line per layer, children indented, CSS vocabulary, exact values.
 * Context is spent breadth-first: if the budget runs out, deeper layers are
 * replaced by a marker that says how to fetch them, so the agent always sees
 * the whole structure before any detail.
 */

import type { RawNode, RawSnapshot } from "../shared/raw";
import { Builder, isDefaultName, type AssetFiles, type IRNode } from "./build";
import { Components, type ComponentMode, type Override } from "./components";
import { n } from "./css";

export interface RenderOptions {
  /** Approximate output budget in tokens. */
  budget?: number;
  components?: ComponentMode;
  /** Max characters of text content printed per text layer. */
  maxText?: number;
  /** Asset files already written: graphics and images then print `src:<file>`. */
  files?: AssetFiles & { dir: string; failures: string[] };
}

export interface RenderResult {
  text: string;
  stats: {
    layers: number;
    shown: number;
    defs: number;
    tokens: number;
    cut: boolean;
  };
}

/** Characters per token for this format (symbol-heavy, so lower than prose). */
export const CHARS_PER_TOKEN = 3.2;
/** Room kept for a "… +N layers not shown" line under a partly shown container. */
const MARKER_RESERVE = 60;

interface Item {
  line: string;
  /** Lines attached to this one (notes, runs, overrides) — printed one level deeper. */
  sub: string[];
  kids: Item[];
  node?: IRNode;
  /** How many layers this item stands for (repeat summaries stand for several). */
  weight: number;
  defRefs: string[];
  cost: number;
  /** Excluded by the budget. */
  out?: boolean;
}

const INDENT = "  ";

function prop(k: string, v: string): string {
  return v === "" ? k : `${k}:${v}`;
}

function clip(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}…(+${s.length - max} chars)` : s;
}

/* ------------------------------------------------------------------ */

export class Renderer {
  private readonly b: Builder;
  private readonly comps: Components;
  private readonly budgetChars: number;
  private readonly maxText: number;
  private readonly sigs = new WeakMap<IRNode, string>();

  constructor(
    private readonly snap: RawSnapshot,
    private readonly opts: RenderOptions = {},
  ) {
    this.b = new Builder(snap, opts.files);
    this.comps = new Components(this.b, opts.components ?? "auto");
    this.budgetChars = Math.max(1500, (opts.budget ?? 10000) * CHARS_PER_TOKEN);
    this.maxText = opts.maxText ?? 2000;
  }

  render(): RenderResult {
    const roots = this.snap.roots.filter((r) => !r.stub).map((r) => this.b.node(r, undefined));
    this.comps.plan(roots);

    // Definitions get a share of the budget each; the tree gets the rest.
    const defItems = new Map<string, Item>();
    for (const [id, def] of this.comps.defs) {
      const item = this.item(def.ir, true);
      this.cut([item], this.budgetChars * 0.3);
      defItems.set(id, item);
    }
    const rootItems = roots.map((r) => this.item(r));
    const total = countLayers(roots);

    const charged = new Set<string>();
    const defCost = (refs: string[]): number => {
      let c = 0;
      const stack = [...refs];
      const local = new Set<string>();
      while (stack.length) {
        const id = stack.pop()!;
        if (charged.has(id) || local.has(id)) continue;
        local.add(id);
        const di = defItems.get(id);
        if (!di) continue;
        c += includedCost(di);
        stack.push(...includedRefs(di));
      }
      return c;
    };
    const charge = (refs: string[]) => {
      const stack = [...refs];
      while (stack.length) {
        const id = stack.pop()!;
        if (charged.has(id)) continue;
        charged.add(id);
        const di = defItems.get(id);
        if (di) stack.push(...includedRefs(di));
      }
    };

    // Breadth-first inclusion: stop at the first layer that does not fit.
    // A container reserves room for its "not shown" marker until all of its
    // children are in, so markers never push the output over budget.
    const parentOf = new Map<Item, Item>();
    const pendingKids = new Map<Item, number>();
    let used = 0;
    let cut = false;
    let any = false;
    let level: Item[] = rootItems;
    while (level.length) {
      const next: Item[] = [];
      for (const it of level) {
        const reserve = it.kids.length ? MARKER_RESERVE : 0;
        const extra = cut ? 0 : it.cost + reserve + defCost(it.defRefs);
        if (cut || (used + extra > this.budgetChars && any)) {
          cut = true;
          markOut(it);
          continue;
        }
        any = true;
        used += extra;
        charge(it.defRefs);
        const parent = parentOf.get(it);
        if (parent) {
          const left = pendingKids.get(parent)! - 1;
          pendingKids.set(parent, left);
          if (left === 0) used -= MARKER_RESERVE;
        }
        if (it.kids.length) pendingKids.set(it, it.kids.length);
        for (const k of it.kids) parentOf.set(k, it);
        next.push(...it.kids);
      }
      level = next;
    }

    // Emit.
    const used$ = new Set<string>();
    const body: string[] = [];
    let shown = 0;
    const emit = (it: Item, depth: number, out: string[], isDef = false) => {
      const pad = INDENT.repeat(depth);
      out.push(pad + this.b.reg.resolve(it.line, used$));
      shown += it.weight;
      for (const s of it.sub) out.push(pad + INDENT + this.b.reg.resolve(s, used$));
      for (const k of it.kids) if (!k.out) emit(k, depth + 1, out, isDef);
      const missing = it.kids.filter((k) => k.out).reduce((a, k) => a + k.weight, 0);
      if (missing && it.node) {
        // Fetching the root again would hit the same cut: suggest a bigger budget instead.
        const how = depth === 0 && !isDef ? `raise get_design budget, or get_design a child id` : `get_design #${it.node.id}`;
        out.push(`${pad}${INDENT}… +${missing} layer${missing > 1 ? "s" : ""} not shown → ${how}`);
      }
      if (it.node?.more) {
        out.push(`${pad}${INDENT}… +${it.node.more} layer${it.node.more > 1 ? "s" : ""} not loaded → get_design #${it.node.id}`);
      }
    };
    for (const r of rootItems) if (!r.out) emit(r, 0, body);

    const defLines: string[] = [];
    for (const [id, di] of defItems) {
      if (!charged.has(id)) continue;
      emit(di, 1, defLines, true);
    }

    // Header.
    const head: string[] = [];
    const first = this.snap.roots[0];
    const crumbs = [this.snap.fileName, this.snap.pageName, ...(first ? this.snap.ancestry[first.id] ?? [] : [])].filter(Boolean);
    head.push(crumbs.join(" › "));
    const fonts = this.fonts([...roots, ...[...this.comps.defs.values()].filter((d) => charged.has(d.mainId)).map((d) => d.ir)]);
    if (fonts) head.push(`fonts: ${fonts}`);
    const assets = this.assets(roots);
    const files = this.opts.files;
    if (files) {
      const count = new Set([...files.byNode.values(), ...files.byImage.values()]).size;
      head.push(`assets: ${count} file${count === 1 ? "" : "s"} in ${files.dir}/, named by src: on each layer${files.failures.length ? ` (${files.failures.length} failed → export_assets)` : ""}`);
    } else if (assets) head.push(`assets: ${assets} → export_assets`);
    if (cut) head.push(`budget: tree cut breadth-first at ~${Math.round(this.budgetChars / CHARS_PER_TOKEN)} tokens — "not shown" markers say how to expand`);
    if (this.snap.stats.truncated) head.push(`warning: snapshot hit the node limit; some layers were not loaded`);
    if (this.snap.missing.length) head.push(`warning: not found: ${this.snap.missing.join(", ")}`);

    const table = this.b.reg.table(used$);
    const out = [...head];
    if (table.length) out.push("", "## tokens", ...table);
    if (defLines.length) out.push("", "## components (instances below list only what differs)", ...defLines);
    out.push("", "## design", ...body);
    const text = out.join("\n");
    return {
      text,
      stats: { layers: total, shown, defs: defLines.length ? [...charged].filter((id) => defItems.has(id)).length : 0, tokens: Math.round(text.length / CHARS_PER_TOKEN), cut },
    };
  }

  /** Apply a per-tree budget (for definitions) by marking excluded items. */
  private cut(items: Item[], budget: number): void {
    let used = 0;
    let level = items;
    let stop = false;
    while (level.length) {
      const next: Item[] = [];
      for (const it of level) {
        if (stop || (used + it.cost > budget && used > 0)) {
          stop = true;
          markOut(it);
          continue;
        }
        used += it.cost;
        next.push(...it.kids);
      }
      level = next;
    }
  }

  /* ---------------------------------------------------------------- */

  private item(node: IRNode, asDef = false): Item {
    const def = asDef ? undefined : this.comps.mode === "auto" ? this.comps.def(node) : undefined;
    const head: string[] = [];
    const props: string[] = [];
    const sub: string[] = [];
    const defRefs: string[] = [];
    const isInstance = node.type === "INSTANCE" && node.kind !== "svg";

    let label: string | undefined;
    if (asDef) {
      head.push(this.comps.label(node.id));
    } else if (isInstance) {
      label = this.comps.label(node.inst?.mainId, node.inst?.variant);
      head.push(`instance ${label}`);
    } else head.push(String(node.kind));

    const showName =
      !asDef &&
      !isDefaultName(node.name) &&
      !(node.kind === "text" && node.text !== undefined && sameText(node.name, node.text)) &&
      !(isInstance && label && (label.startsWith(node.name) || this.isComponentName(node))) &&
      !(node.kind === "svg" && node.type === "INSTANCE" && this.isComponentName(node));
    const svgInstance = node.kind === "svg" && node.type === "INSTANCE";
    if (showName) head.push(JSON.stringify(node.name));
    else if (svgInstance) head.push(JSON.stringify(this.componentName(node) ?? node.name));
    head.push(`#${node.id}`, `${n(node.w)}×${n(node.h)}`);

    if (isInstance && node.inst) for (const [k, v] of Object.entries(node.inst.props)) props.push(`${k}=${v}`);
    // An icon instance renamed by the designer: keep which icon it is.
    if (svgInstance && showName) props.push(`icon:${this.comps.label(node.inst?.mainId, node.inst?.variant)}`);
    // Instance sizes are always the instance's own; say "fixed" where the component would hug.
    const geo: Record<string, string> = {};
    for (const axis of ["w", "h"] as const) {
      const v = node.geo[axis] ?? (def && /^(hug|fill)/.test(def.ir.geo[axis] ?? "") ? "fixed" : undefined);
      if (v) geo[axis] = v;
    }
    Object.assign(geo, node.geo);
    if (geo.w && geo.w === geo.h && (geo.w === "hug" || geo.w === "fill" || geo.w === "fixed")) {
      // Both axes share a mode: one flag instead of two.
      const mode = geo.w;
      delete geo.w;
      delete geo.h;
      props.push(mode);
    }
    for (const [k, v] of Object.entries(geo)) props.push(prop(k, v));
    if (def) {
      props.push(...this.comps.rootChanges(node, def.ir));
      defRefs.push(def.mainId);
    } else {
      for (const [k, v] of Object.entries(node.layout)) props.push(prop(k, v));
      for (const [k, v] of Object.entries(node.style)) props.push(prop(k, v));
    }
    if (node.hidden) props.push("hidden");
    if (node.text !== undefined && !def) props.push(JSON.stringify(clip(node.text, this.maxText)));

    // Attached lines.
    if (asDef || node.type === "COMPONENT" || node.type === "COMPONENT_SET") {
      const id = node.id;
      const pl = this.comps.propsLine(id) ?? this.rawPropsLine(node.raw);
      if (pl) sub.push(`// ${pl}`);
      const desc = this.snap.components[id]?.description ?? node.raw.description;
      if (desc) sub.push(`// ${clip(desc.replace(/\s+/g, " ").trim(), 200)}`);
    }
    if (node.propRefs && Object.keys(node.propRefs).length) {
      sub.push(`// bound: ${Object.entries(node.propRefs).map(([f, p]) => `${f === "characters" ? "text" : f === "mainComponent" ? "swap" : f}←${p}`).join(", ")}`);
    }
    for (const note of node.notes) sub.push(`// ${note}`);
    if (node.runs && !def) sub.push(...this.runLines(node));

    let kids: Item[] = [];
    if (def) {
      for (const o of this.comps.overrides(node, def.ir)) sub.push(...this.overrideLines(o, defRefs));
    } else if (!(isInstance && this.comps.mode === "names")) {
      kids = this.children(node);
    }
    if (isInstance && this.comps.mode === "names") {
      const nested = countLayers(node.children);
      if (nested) sub.push(`// ${nested} layers inside → get_design #${node.id} components:"inline"`);
    }

    const line = props.length ? `${head.join(" ")} ${props.join("; ")}` : head.join(" ");
    const cost = line.length + sub.reduce((a, s) => a + s.length + 1, 0) + 8;
    return { line, sub, kids, node, weight: 1, defRefs, cost };
  }

  /** Instance layer still carries its component's (or variant's) default name. */
  private isComponentName(node: IRNode): boolean {
    const c = node.inst?.mainId ? this.snap.components[node.inst.mainId] : undefined;
    return !!c && (node.name === c.name || node.name === c.setName);
  }

  private componentName(node: IRNode): string | undefined {
    const c = node.inst?.mainId ? this.snap.components[node.inst.mainId] : undefined;
    return c ? c.setName ?? c.name : undefined;
  }

  private rawPropsLine(raw: RawNode): string | undefined {
    if (!raw.propertyDefinitions) return undefined;
    const parts = Object.entries(raw.propertyDefinitions).map(([k, d]) => {
      const name = k.replace(/#[^#]*$/, "");
      if (d.type === "VARIANT") return `${name}: ${(d.variantOptions ?? []).map((o) => (o === d.defaultValue ? `${o}*` : o)).join("|")}`;
      if (d.type === "TEXT") return `${name}: text=${JSON.stringify(d.defaultValue)}`;
      if (d.type === "BOOLEAN") return `${name}: bool=${d.defaultValue}`;
      return `${name}: ${d.type.toLowerCase()}`;
    });
    return parts.length ? `props: ${parts.join("; ")}` : undefined;
  }

  private runLines(node: IRNode): string[] {
    const out: string[] = [];
    const full = node.text ?? "";
    let offset = 0;
    for (const r of node.runs ?? []) {
      const start = offset;
      offset += r.text.length;
      const entries = Object.entries(r.props);
      if (!entries.length) continue;
      const unique = full.indexOf(r.text) === full.lastIndexOf(r.text);
      const where = unique ? "" : `@${start} `;
      out.push(`~ ${where}${JSON.stringify(clip(r.text, 120))} ${entries.map(([k, v]) => prop(k, v)).join("; ")}`);
    }
    return out;
  }

  private overrideLines(o: Override, defRefs: string[]): string[] {
    const lines = [`~ ${o.path}: ${o.changes.join("; ")}`];
    if (o.runs) {
      const fake = { text: o.runs.map((r) => r.text).join(""), runs: o.runs } as IRNode;
      for (const l of this.runLines(fake)) lines.push(INDENT + l);
    }
    if (o.sub) {
      const it = this.item(o.sub);
      const flat: string[] = [];
      const walk = (x: Item, d: number) => {
        flat.push(INDENT.repeat(d) + x.line);
        for (const s of x.sub) flat.push(INDENT.repeat(d + 1) + s);
        defRefs.push(...x.defRefs);
        for (const k of x.kids) walk(k, d + 1);
      };
      walk(it, 1);
      lines.push(...flat);
    }
    return lines;
  }

  /**
   * Child items, with repeated siblings folded: runs of 3+ identical
   * structures, or 3+ alternating pairs (zebra rows), print the pattern once
   * and then one line listing each remaining sibling's content.
   */
  private children(node: IRNode): Item[] {
    const kids = node.children.filter((c) => !c.raw.stub);
    const items: Item[] = [];
    const flow = Object.keys(node.layout).length > 0;
    const sig = (k: number) => this.sig(kids[k]!);
    let i = 0;
    while (i < kids.length) {
      if (flow) {
        let j = i + 1;
        while (j < kids.length && sig(j) === sig(i)) j++;
        if (j - i >= 3) {
          items.push(this.item(kids[i]!), this.summary(kids.slice(i + 1, j), [kids[i]!], "like ↑"));
          i = j;
          continue;
        }
        if (i + 1 < kids.length && sig(i + 1) !== sig(i)) {
          j = i + 2;
          while (j < kids.length && sig(j) === sig(j - 2)) j++;
          if (j - i >= 6) {
            const pattern = [kids[i]!, kids[i + 1]!];
            items.push(this.item(pattern[0]!), this.item(pattern[1]!), this.summary(kids.slice(i + 2, j), pattern, "alternating like the 2 above"));
            i = j;
            continue;
          }
        }
      }
      items.push(this.item(kids[i]!));
      i++;
    }
    return items;
  }

  private summary(rest: IRNode[], pattern: IRNode[], how: string): Item {
    const patternVals = pattern.map((p) => this.vals(p).join(" "));
    // Listing grows with the budget, so "use a larger budget" really shows more.
    const cap = Math.max(20, Math.floor(this.budgetChars / 600));
    const listed = rest.slice(0, cap).map((x, k) => {
      const v = this.vals(x).join(" ");
      return v && v !== patternVals[k % pattern.length] ? `#${x.id} ${v}` : `#${x.id}`;
    });
    const withContent = listed.some((l) => l.includes(" "));
    const more = rest.length > cap ? `… +${rest.length - cap} more (larger budget lists them)` : "";
    const defRefs = rest.flatMap((x) => (x.inst?.mainId && this.comps.defs.has(x.inst.mainId) ? [x.inst.mainId] : []));
    const weight = rest.reduce((a, x) => a + 1 + countLayers(x.children), 0);
    if (!withContent) {
      // Identical siblings (icons, dividers): one line of ids.
      const line = `+${rest.length} more ${how}: ${listed.join(" ")}${more ? ` ${more}` : ""}`;
      return { line, sub: [], kids: [], weight, defRefs, cost: line.length + 8 };
    }
    const line = `+${rest.length} more ${how}, content:`;
    const sub = more ? [...listed, more] : listed;
    return { line, sub, kids: [], weight, defRefs, cost: line.length + sub.reduce((a, l) => a + l.length + 6, 8) };
  }

  /** Structure + styling, with content (text, images, names, ids) left out. */
  private sig(node: IRNode): string {
    const hit = this.sigs.get(node);
    if (hit !== undefined) return hit;
    const strip = (o: Record<string, string>) =>
      Object.entries(o)
        .filter(([k]) => k !== "src" && k !== "at")
        .map(([k, v]) => `${k}:${v.replace(/img\([^\s)]+/g, "img(")}`)
        .join(";");
    const instProps = node.inst ? Object.entries(node.inst.props).filter(([, v]) => !v.startsWith('"')) : [];
    const s = JSON.stringify([
      node.kind,
      node.inst?.mainId,
      instProps,
      strip(node.geo),
      strip(node.layout),
      strip(node.style),
      node.geo.w ? 0 : Math.round(node.w),
      node.geo.h ? 0 : Math.round(node.h),
      node.hidden,
      node.children.filter((c) => !c.raw.stub).map((c) => this.sig(c)),
    ]);
    this.sigs.set(node, s);
    return s;
  }

  /** Content that differs between repeated siblings: texts, text props, images. */
  private vals(node: IRNode): string[] {
    const out: string[] = [];
    const walk = (x: IRNode) => {
      if (x.raw.stub) return;
      if (x.text !== undefined) out.push(JSON.stringify(clip(x.text, 60)));
      if (x.inst) for (const [k, v] of Object.entries(x.inst.props)) if (v.startsWith('"')) out.push(`${k}=${clip(v, 60)}`);
      if (x.image) out.push(`img:${this.b.files?.byImage.get(x.image) ?? x.image.slice(0, 10)}`);
      if (x.kind === "svg" && x.style.src) out.push(`src:${x.style.src}`);
      x.children.forEach(walk);
    };
    walk(node);
    return out;
  }

  private fonts(roots: IRNode[]): string {
    const fams = new Map<string, Set<string>>();
    const walk = (x: IRNode) => {
      for (const s of x.raw.segments ?? []) {
        const set = fams.get(s.fontFamily) ?? new Set<string>();
        set.add(`${s.fontWeight}${/italic|oblique/i.test(s.fontStyle) ? "i" : ""}`);
        fams.set(s.fontFamily, set);
      }
      x.children.forEach(walk);
    };
    roots.forEach(walk);
    return [...fams]
      .map(([f, w]) => `${f} ${[...w].sort().join("/")}`)
      .join(" · ");
  }

  private assets(roots: IRNode[]): string {
    let svg = 0;
    const imgs = new Set<string>();
    const walk = (x: IRNode) => {
      if (x.raw.stub) return;
      if (x.kind === "svg") svg++;
      if (x.image) imgs.add(x.image);
      x.children.forEach(walk);
    };
    roots.forEach(walk);
    const parts: string[] = [];
    if (svg) parts.push(`${svg} svg`);
    if (imgs.size) parts.push(`${imgs.size} image${imgs.size > 1 ? "s" : ""}`);
    return parts.join(", ");
  }
}

/* ------------------------------------------------------------------ */

function sameText(name: string, text: string): boolean {
  const a = name.replace(/\s+/g, " ").trim();
  const b = text.replace(/\s+/g, " ").trim();
  return a === b || (a.length >= 8 && b.startsWith(a.replace(/…$/, "")));
}

function countLayers(nodes: IRNode[]): number {
  let c = 0;
  const walk = (x: IRNode) => {
    if (x.raw.stub) return;
    c++;
    x.children.forEach(walk);
  };
  nodes.forEach(walk);
  return c;
}

function markOut(it: Item): void {
  it.out = true;
  it.kids.forEach(markOut);
}

function includedCost(it: Item): number {
  return it.out ? 0 : it.cost + it.kids.reduce((a, k) => a + includedCost(k), 0);
}

function includedRefs(it: Item): string[] {
  return it.out ? [] : [...it.defRefs, ...it.kids.flatMap(includedRefs)];
}

/** Ids of the components that rendering prints once under "## components". */
export function printedDefs(snap: RawSnapshot, components: ComponentMode = "auto"): string[] {
  const b = new Builder(snap);
  const comps = new Components(b, components);
  comps.plan(snap.roots.filter((r) => !r.stub).map((r) => b.node(r, undefined)));
  return [...comps.defs.keys()];
}

export function renderSnapshot(snap: RawSnapshot, opts: RenderOptions = {}): RenderResult {
  return new Renderer(snap, opts).render();
}
