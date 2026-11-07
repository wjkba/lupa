/**
 * Design tokens seen while building a screen.
 *
 * Values bound to Figma variables or named styles are emitted as `$name`
 * references (the name is what maps to the codebase's tokens), and the table
 * at the top of the output resolves them. Unnamed values are only hoisted
 * when that pays off: typography always (it is long and reused), effects when
 * used twice or more; colours stay inline because a hex is shorter than a
 * reference plus its table row.
 */

import type { RawSnapshot } from "../shared/raw";
import { n } from "./css";

export type TokenKind = "color" | "number" | "type" | "effect" | "paint";

interface NamedToken {
  kind: TokenKind;
  name: string;
  value: string;
  web?: string;
  note?: string;
}

const MARK = "\u0001";

export function tokenName(name: string): string {
  return name.trim().replace(/\s*\/\s*/g, "/").replace(/\s+/g, "-");
}

export class Registry {
  private readonly named = new Map<string, NamedToken>();
  private readonly varNames = new Map<string, string>();
  private readonly typo = new Map<string, { id: string; spec: string }>();
  private readonly effects = new Map<string, { idx: number; css: string; uses: number; id?: string }>();
  private typoSeq = 0;
  private finalized = false;

  constructor(private readonly snap: RawSnapshot) {}

  /** `$name` for a variable id, registering its value. */
  private varToken(id: string, kind: TokenKind, value: string): string | undefined {
    const v = this.snap.variables[id];
    if (!v) return undefined;
    let name = tokenName(v.name);
    const owner = this.varNames.get(name);
    if (owner && owner !== id) name = `${name}@${tokenName(v.collection ?? id)}`;
    this.varNames.set(name, id);
    const key = `$${name}`;
    const existing = this.named.get(key);
    if (existing && existing.value !== value) return `${key}=${value}`; // another mode / override
    if (!existing) this.named.set(key, { kind, name, value, ...(v.web ? { web: v.web } : {}) });
    return key;
  }

  private styleToken(id: string, kind: TokenKind, value: string): string | undefined {
    const s = this.snap.styles[id];
    if (!s) return undefined;
    const key = `$${tokenName(s.name)}`;
    const existing = this.named.get(key);
    if (existing && existing.value !== value) return `${key}=${value}`;
    if (!existing) this.named.set(key, { kind, name: s.name, value, ...(s.description ? { note: s.description } : {}) });
    return key;
  }

  /** A solid colour: variable name, else style name, else the hex. Alpha from paint opacity rides along. */
  color(hexValue: string, opts: { varId?: string; styleId?: string; alpha?: number } = {}): string {
    const alpha = opts.alpha !== undefined && opts.alpha < 0.999 ? `@${n(opts.alpha)}` : "";
    if (opts.varId) {
      const base = alpha ? hexValue.slice(0, 7) : hexValue;
      const ref = this.varToken(opts.varId, "color", base);
      if (ref) return ref + alpha;
    }
    if (opts.styleId) {
      const ref = this.styleToken(opts.styleId, "color", hexValue);
      if (ref) return ref;
    }
    return hexValue;
  }

  /** A whole paint stack bound to a fill style (gradients, layered fills). */
  paintStyle(styleId: string, css: string): string | undefined {
    return this.styleToken(styleId, "paint", css);
  }

  number(value: number, varId?: string): string {
    if (varId) {
      const ref = this.varToken(varId, "number", n(value));
      if (ref) return ref;
    }
    return n(value);
  }

  /** Typography: named text style, else an auto `T<n>` id. Always a reference. */
  type(spec: string, styleId?: string, varNote?: string): string {
    if (styleId) {
      const ref = this.styleToken(styleId, "type", spec);
      if (ref) {
        if (varNote) this.named.get(ref.split("=")[0]!)!.note ??= varNote;
        return ref;
      }
    }
    const hit = this.typo.get(spec);
    if (hit) return hit.id;
    const id = `T${++this.typoSeq}`;
    this.typo.set(spec, { id, spec: varNote ? `${spec}  (${varNote})` : spec });
    return id;
  }

  /** Effects: named style, else a placeholder resolved after counting uses. */
  effect(css: string, styleId?: string): string {
    if (styleId) {
      const ref = this.styleToken(styleId, "effect", css);
      if (ref) return ref;
    }
    let e = this.effects.get(css);
    if (!e) {
      e = { idx: this.effects.size, css, uses: 0 };
      this.effects.set(css, e);
    }
    e.uses++;
    return `${MARK}e${e.idx}${MARK}`;
  }

  finalize(): void {
    if (this.finalized) return;
    this.finalized = true;
    let seq = 0;
    for (const e of this.effects.values()) if (e.uses >= 2) e.id = `E${++seq}`;
  }

  /** Substitute effect placeholders and record every token a line uses. */
  resolve(line: string, used: Set<string>): string {
    this.finalize();
    const byIdx = [...this.effects.values()];
    const out = line.replace(new RegExp(`${MARK}e(\\d+)${MARK}`, "g"), (_m, i: string) => {
      const e = byIdx[Number(i)]!;
      if (e.id) {
        used.add(e.id);
        return e.id;
      }
      return e.css;
    });
    for (const m of out.matchAll(/\$[^\s,;()=@]+|\b[TE]\d+\b/g)) used.add(m[0]);
    return out;
  }

  /** The token table for the references that made it into the output. */
  table(used: Set<string>): string[] {
    this.finalize();
    const lines: string[] = [];
    const groups: Record<string, string[]> = { color: [], paint: [], number: [], type: [], effect: [] };
    for (const [key, t] of this.named) {
      if (!used.has(key)) continue;
      const extra = [t.web, t.note ? `— ${t.note.replace(/\s+/g, " ").slice(0, 80)}` : ""].filter(Boolean).join(" ");
      groups[t.kind]!.push(`  ${key} = ${t.value}${extra ? `  ${extra}` : ""}`);
    }
    for (const t of this.typo.values()) if (used.has(t.id)) groups.type!.push(`  ${t.id} = ${t.spec}`);
    for (const e of this.effects.values()) if (e.id && used.has(e.id)) groups.effect!.push(`  ${e.id} = ${e.css}`);
    const titles: Record<string, string> = {
      color: "colors",
      paint: "fills",
      number: "numbers",
      type: "typography (family weight size/line-height letter-spacing …)",
      effect: "effects",
    };
    for (const k of ["color", "paint", "number", "type", "effect"]) {
      if (groups[k]!.length) lines.push(`${titles[k]}:`, ...groups[k]!);
    }
    return lines;
  }
}
