/**
 * Component handling: decide which components are printed once as
 * definitions, and describe each instance as "definition + what differs".
 *
 * Instance sublayer ids are `I<instance>;<path in main>`, so a sublayer is
 * matched to its definition layer by that path, not by name or position. That
 * keeps diffs exact even when designers rename or reorder nothing at all —
 * and stays correct when two siblings share a name.
 */

import type { Builder, IRNode, Run } from "./build";
import { n } from "./css";

export type ComponentMode = "auto" | "inline" | "names";

export interface Def {
  mainId: string;
  label: string;
  ir: IRNode;
  uses: number;
}

/** A change inside an instance, relative to its definition. */
export interface Override {
  path: string;
  changes: string[];
  /** Layers with no counterpart in the definition (shown layers, swapped-in content). */
  sub?: IRNode;
  runs?: Run[];
}

function variantText(v: Record<string, string>): string {
  const entries = Object.entries(v);
  return entries.length ? `{${entries.map(([k, x]) => `${k}=${x}`).join(", ")}}` : "";
}

export class Components {
  readonly defs = new Map<string, Def>();
  private readonly labels = new Map<string, string>();
  private readonly usedLabels = new Map<string, string>();

  constructor(
    private readonly b: Builder,
    readonly mode: ComponentMode,
  ) {}

  /** Human label: `Set{Prop=value, …}` for variants, the component name otherwise. */
  label(mainId: string | undefined, variant?: Record<string, string>): string {
    if (!mainId) return "?";
    const cached = this.labels.get(mainId);
    if (cached) return cached;
    const c = this.b.snap.components[mainId];
    let label = c ? (c.setName ? `${c.setName}${variantText(variant ?? c.variant ?? {})}` : c.name) : `component ${mainId}`;
    const owner = this.usedLabels.get(label);
    if (owner && owner !== mainId) label = `${label}#${mainId}`;
    this.usedLabels.set(label, mainId);
    this.labels.set(mainId, label);
    return label;
  }

  /** Count instance uses across the trees and create definitions for repeated components. */
  plan(roots: IRNode[]): void {
    if (this.mode !== "auto") return;
    const uses = new Map<string, number>();
    const walk = (node: IRNode) => {
      if (node.type === "INSTANCE" && node.kind !== "svg" && node.inst?.mainId) {
        uses.set(node.inst.mainId, (uses.get(node.inst.mainId) ?? 0) + 1);
      }
      for (const c of node.children) walk(c);
    };
    roots.forEach(walk);
    // Definitions can contain further instances; walk each new one once.
    const queue = [...uses.entries()].filter(([, u]) => u >= 2).map(([id]) => id);
    const seen = new Set<string>();
    while (queue.length) {
      const id = queue.shift()!;
      if (seen.has(id)) continue;
      seen.add(id);
      const ir = this.b.def(id);
      if (!ir) continue;
      this.defs.set(id, { mainId: id, label: this.label(id), ir, uses: uses.get(id) ?? 0 });
      ir.children.forEach(walk);
      for (const [k, v] of uses) if (v >= 2 && !seen.has(k) && !queue.includes(k)) queue.push(k);
    }
  }

  def(node: IRNode): Def | undefined {
    return node.inst?.mainId ? this.defs.get(node.inst.mainId) : undefined;
  }

  /** `name: type default` list for a definition's property line. */
  propsLine(mainId: string): string | undefined {
    const c = this.b.snap.components[mainId];
    const defs = c?.propertyDefinitions;
    if (!defs) return undefined;
    const parts: string[] = [];
    for (const [key, d] of Object.entries(defs)) {
      const name = key.replace(/#[^#]*$/, "");
      if (d.type === "VARIANT") {
        const opts = d.variantOptions ?? [];
        parts.push(`${name}: ${opts.map((o) => (o === d.defaultValue ? `${o}*` : o)).join("|")}`);
      } else if (d.type === "TEXT") parts.push(`${name}: text=${JSON.stringify(d.defaultValue)}`);
      else if (d.type === "BOOLEAN") parts.push(`${name}: bool=${d.defaultValue}`);
      else if (d.type === "INSTANCE_SWAP") {
        const target = this.b.snap.nodeNames[String(d.defaultValue)] ?? String(d.defaultValue);
        parts.push(`${name}: swap=${target}`);
      } else parts.push(`${name}: ${d.type.toLowerCase()}`);
    }
    return parts.length ? `props: ${parts.join("; ")}` : undefined;
  }

  /* ---------------------------------------------------------------- */
  /* Override diffs                                                   */
  /* ---------------------------------------------------------------- */

  /** Root-level differences (style / layout) between an instance and its definition. */
  rootChanges(inst: IRNode, def: IRNode): string[] {
    return [...mapDiff(inst.layout, def.layout), ...mapDiff(inst.style, def.style)];
  }

  /** Sublayer differences, depth-first in layer order. */
  overrides(inst: IRNode, def: IRNode): Override[] {
    const out: Override[] = [];
    const prefix = `${inst.id.startsWith("I") ? inst.id : `I${inst.id}`};`;
    const resized = Math.abs(inst.w - def.w) > 0.5 || Math.abs(inst.h - def.h) > 0.5;
    const keyOf = (node: IRNode, isDef: boolean) =>
      isDef ? node.id.replace(/^I/, "") : node.id.startsWith(prefix) ? node.id.slice(prefix.length) : node.id;
    this.diffChildren(inst, def, "", out, keyOf, resized);
    return out;
  }

  private diffChildren(
    a: IRNode,
    d: IRNode,
    path: string,
    out: Override[],
    keyOf: (node: IRNode, isDef: boolean) => string,
    resized: boolean,
  ): void {
    const defByKey = new Map(d.children.map((c) => [keyOf(c, true), c]));
    const matched = new Set<IRNode>();
    const names = pathNames(d.children);
    for (const child of a.children) {
      let dc = defByKey.get(keyOf(child, false));
      if (!dc) {
        // Positional fallback (detached ids, re-created layers).
        const idx = a.children.indexOf(child);
        const cand = d.children[idx];
        if (cand && !matched.has(cand) && cand.name === child.name && cand.type === child.type) dc = cand;
      }
      const p = joinPath(path, dc ? names.get(dc) ?? dc.name : child.name);
      if (!dc) {
        out.push({ path: p, changes: ["added"], sub: child });
        continue;
      }
      matched.add(dc);
      this.diffNode(child, dc, p, out, keyOf, resized);
    }
    for (const dc of d.children) {
      if (matched.has(dc) || dc.hidden) continue;
      // Invisible instance sublayers are not returned by the API, so absence = hidden.
      if (dc.propRefs?.visible) continue;
      out.push({ path: joinPath(path, names.get(dc) ?? dc.name), changes: ["hidden"] });
    }
  }

  private diffNode(
    a: IRNode,
    d: IRNode,
    path: string,
    out: Override[],
    keyOf: (node: IRNode, isDef: boolean) => string,
    resized: boolean,
  ): void {
    if (a.hidden && !d.hidden) {
      if (!d.propRefs?.visible) out.push({ path, changes: ["hidden"] });
      return;
    }
    if (!a.hidden && d.hidden) {
      // Toggled on by a boolean prop: the definition prints the layer, nothing to add.
      if (d.propRefs?.visible) {
        const changes = this.nodeChanges(a, d, resized);
        if (changes.length) out.push({ path, changes });
        this.diffChildren(a, d, path, out, keyOf, resized);
      } else out.push({ path, changes: ["shown"], sub: a });
      return;
    }
    if (a.hidden) return;

    // Nested instance swapped to another component.
    if (a.type === "INSTANCE" && d.type === "INSTANCE" && a.inst?.mainId !== d.inst?.mainId) {
      const viaProp = !!d.propRefs?.mainComponent;
      const label = this.label(a.inst?.mainId, a.inst?.variant);
      const changes = viaProp ? [] : [`swap→${label}`];
      const props = mapDiff(a.inst?.props ?? {}, {}, "=");
      changes.push(...props);
      const def = this.def(a);
      if (a.kind === "svg" || !a.children.length) {
        if (a.kind === "svg" && a.style.color !== d.style.color && a.style.color) changes.push(`color:${a.style.color}`);
        if (changes.length) out.push({ path, changes });
      } else if (def) {
        // Swapped to a component that has its own definition: describe against that one.
        changes.push(...this.rootChanges(a, def.ir));
        if (changes.length) out.push({ path, changes });
        const nested = this.overrides(a, def.ir);
        for (const o of nested) out.push({ ...o, path: joinPath(path, o.path) });
      } else {
        out.push({ path, changes: changes.length ? changes : [`swap→${label}`], sub: a });
      }
      return;
    }

    const changes = this.nodeChanges(a, d, resized);
    const o: Override = { path, changes };
    if (a.runs && JSON.stringify(a.runs) !== JSON.stringify(d.runs)) o.runs = a.runs;
    if (changes.length || o.runs) out.push(o);
    if (a.kind !== "svg") this.diffChildren(a, d, path, out, keyOf, resized);
  }

  private nodeChanges(a: IRNode, d: IRNode, resized: boolean): string[] {
    const changes: string[] = [];
    if (a.inst && d.inst) {
      const v = mapDiff(a.inst.variant, d.inst.variant, "=");
      if (v.length) changes.push(`{${v.join(", ")}}`);
      changes.push(...mapDiff(a.inst.props, d.inst.props, "="));
    }
    if (a.text !== undefined && a.text !== d.text && !d.propRefs?.characters) changes.push(JSON.stringify(a.text));
    changes.push(...mapDiff(a.layout, d.layout), ...mapDiff(a.style, d.style));
    if (!resized) {
      // A resized instance reflows; only fixed-size sublayers report their own size change.
      const wFixed = !a.geo.w && !d.geo.w && !/left\+right|scale-x/.test(a.geo.pin ?? "");
      const hFixed = !a.geo.h && !d.geo.h && !/top\+bottom|scale-y/.test(a.geo.pin ?? "");
      if ((wFixed && Math.abs(a.w - d.w) > 0.5) || (hFixed && Math.abs(a.h - d.h) > 0.5)) changes.push(`size:${n(a.w)}×${n(a.h)}`);
    }
    if (a.geo.w !== d.geo.w && a.geo.w) changes.push(`w:${a.geo.w}`);
    if (a.geo.h !== d.geo.h && a.geo.h) changes.push(`h:${a.geo.h}`);
    return changes;
  }
}

/** `key:value` for every key whose value differs; removed keys become `key:none`. */
export function mapDiff(a: Record<string, string>, b: Record<string, string>, sep = ":"): string[] {
  const out: string[] = [];
  for (const [k, v] of Object.entries(a)) {
    if (b[k] === v) continue;
    out.push(v === "" ? k : `${k}${sep}${v}`);
  }
  for (const k of Object.keys(b)) if (!(k in a)) out.push(`${k}${sep}none`);
  return out;
}

/** Display names for siblings, disambiguated with `[n]` when names repeat. */
function pathNames(nodes: IRNode[]): Map<IRNode, string> {
  const counts = new Map<string, number>();
  for (const c of nodes) counts.set(c.name, (counts.get(c.name) ?? 0) + 1);
  const seen = new Map<string, number>();
  const out = new Map<IRNode, string>();
  for (const c of nodes) {
    if ((counts.get(c.name) ?? 0) > 1) {
      const i = (seen.get(c.name) ?? 0) + 1;
      seen.set(c.name, i);
      out.set(c, `${c.name}[${i}]`);
    } else out.set(c, c.name);
  }
  return out;
}

function joinPath(a: string, b: string): string {
  return a ? `${a}/${b}` : b;
}
