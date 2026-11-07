/** Plain-text formatting for the small tools (status, outline, search, tokens). */

import { n } from "../model/css";
import type { FindMatch, OutlineNode, OutlineResult, PluginInfo, TokensResult } from "../shared/protocol";

export function formatStatus(plugins: PluginInfo[], role: string, port: number): string {
  if (!plugins.length) {
    return [
      `Loupe ${role} on port ${port}. No Figma file connected.`,
      "In Figma: open the file → Plugins → Development → Loupe (import plugin/manifest.json once). Keep the plugin window open.",
    ].join("\n");
  }
  const lines = [`Loupe ${role} on port ${port}. Connected files (most recently active first):`];
  for (const p of plugins) {
    lines.push(`- "${p.fileName}"${p.fileKey ? ` (key ${p.fileKey})` : ""} · page "${p.pageName}" · ${p.editorType} · plugin ${p.pluginVersion}`);
    if (p.hidden) lines.push("    Figma is in the background: screenshots and image exports wait until its window/tab is visible");
    if (p.selection.length) {
      for (const s of p.selection.slice(0, 8)) lines.push(`    selected: ${s.type.toLowerCase()} "${s.name}" #${s.id} ${s.w}×${s.h}`);
      if (p.selection.length > 8) lines.push(`    … +${p.selection.length - 8} more selected`);
    } else lines.push("    nothing selected");
  }
  return lines.join("\n");
}

function outlineLines(nodes: OutlineNode[], depth: number, out: string[]): void {
  for (const node of nodes) {
    const more = node.childCount ? ` (+${node.childCount})` : "";
    out.push(`${"  ".repeat(depth)}${node.type.toLowerCase()} "${node.name}" #${node.id} ${node.w}×${node.h}${more}`);
    if (node.children) outlineLines(node.children, depth + 1, out);
  }
}

export function formatOutline(o: OutlineResult): string {
  const out = [`"${o.fileName}" — pages:`];
  for (const p of o.pages) {
    const current = p.id === o.currentPageId ? " (current)" : "";
    if (!p.nodes) {
      out.push(`page "${p.name}" #${p.id}${current}`);
      continue;
    }
    out.push(`page "${p.name}" #${p.id}${current} — ${p.nodes.length} top-level layers`);
    outlineLines(p.nodes, 1, out);
  }
  return out.join("\n");
}

export function formatMatches(r: { matches: FindMatch[]; truncated: boolean }): string {
  if (!r.matches.length) return "No matches.";
  const out = r.matches.map((m) => {
    const path = [m.page, ...m.path].filter(Boolean).join(" › ");
    const text = m.text !== undefined ? ` ${JSON.stringify(m.text)}` : "";
    return `${m.type.toLowerCase()} "${m.name}" #${m.id} ${m.w}×${m.h}${text} — ${path}`;
  });
  if (r.truncated) out.push("… more matches; narrow the query, page or type.");
  return out.join("\n");
}

/* ------------------------------------------------------------------ */
/* Tokens                                                              */
/* ------------------------------------------------------------------ */

function tokenValue(v: unknown, type: string): string {
  if (v && typeof v === "object" && "alias" in (v as Record<string, unknown>)) {
    const a = v as { alias: string; aliasWeb?: string };
    return `{${a.alias}}`;
  }
  if (typeof v === "number") return type === "FLOAT" ? n(v) : String(v);
  return typeof v === "string" ? (v.startsWith("#") ? v : JSON.stringify(v)) : JSON.stringify(v);
}

export function cssVarName(name: string, web?: string): string {
  const m = web?.match(/var\((--[^)]+)\)/);
  if (m) return m[1]!;
  return `--${name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")}`;
}

function matches(filter: string | undefined, name: string): boolean {
  return !filter || name.toLowerCase().includes(filter.toLowerCase());
}

export function formatTokens(t: TokensResult, format: "list" | "css" | "json", filter?: string): string {
  if (format === "json") {
    const out = {
      collections: t.collections.map((c) => ({ ...c, variables: c.variables.filter((v) => matches(filter, v.name)) })),
      styles: Object.fromEntries(Object.entries(t.styles).map(([k, list]) => [k, list.filter((s) => matches(filter, s.name))])),
    };
    return JSON.stringify(out, null, 1);
  }
  const lines: string[] = [];
  if (format === "css") {
    for (const c of t.collections) {
      const vars = c.variables.filter((v) => matches(filter, v.name) && (v.type === "COLOR" || v.type === "FLOAT" || v.type === "STRING"));
      if (!vars.length) continue;
      const byName = new Map(c.variables.map((v) => [v.name, v]));
      c.modes.forEach((mode, i) => {
        const sel = i === 0 ? ":root" : `[data-theme="${mode.name.toLowerCase().replace(/\s+/g, "-")}"]`;
        lines.push(`/* ${c.name} — ${mode.name} */`, `${sel} {`);
        for (const v of vars) {
          const raw = v.values[mode.id];
          let value: string;
          if (raw && typeof raw === "object" && "alias" in (raw as Record<string, unknown>)) {
            const a = raw as { alias: string; aliasWeb?: string };
            value = `var(${cssVarName(a.alias, a.aliasWeb ?? byName.get(a.alias)?.web)})`;
          } else if (typeof raw === "number") {
            const px = v.scopes?.some((s) => /OPACITY|FONT_WEIGHT|LINE_HEIGHT/.test(s)) ? "" : "px";
            value = `${n(raw)}${px}`;
          } else value = typeof raw === "string" && !raw.startsWith("#") ? JSON.stringify(raw) : String(raw);
          lines.push(`  ${cssVarName(v.name, v.web)}: ${value};`);
        }
        lines.push("}");
      });
    }
  } else {
    for (const c of t.collections) {
      const vars = c.variables.filter((v) => matches(filter, v.name));
      if (!vars.length) continue;
      lines.push(`${c.name}${c.remote ? " (library)" : ""} — modes: ${c.modes.map((m) => m.name).join(" | ")}`);
      for (const v of vars) {
        const values = c.modes.map((m) => tokenValue(v.values[m.id], v.type));
        const uniq = new Set(values);
        lines.push(`  ${v.name} = ${uniq.size === 1 ? values[0] : values.join(" | ")}${v.web ? `  ${v.web}` : ""}${v.description ? `  — ${v.description.slice(0, 80)}` : ""}`);
      }
    }
  }
  const styleLines: string[] = [];
  for (const s of t.styles.text.filter((x) => matches(filter, x.name))) {
    const st = s.style as Record<string, any>;
    const lh = st.lineHeight?.unit === "AUTO" ? "normal" : st.lineHeight?.unit === "PERCENT" ? `${n(st.lineHeight.value)}%` : n(st.lineHeight?.value ?? 0);
    const ls = st.letterSpacing?.value ? (st.letterSpacing.unit === "PERCENT" ? ` ls:${n(st.letterSpacing.value / 100, 4)}em` : ` ls:${n(st.letterSpacing.value)}px`) : "";
    styleLines.push(`  text ${s.name} = ${st.fontFamily} "${st.fontStyle}" ${n(st.fontSize)}/${lh}${ls}`);
  }
  for (const s of t.styles.paint.filter((x) => matches(filter, x.name))) {
    const paints = s.paints as { type: string; color?: { r: number; g: number; b: number; a?: number }; opacity?: number }[];
    const desc = paints
      .map((p) => {
        if (p.type === "SOLID" && p.color) {
          const h = (x: number) => Math.round(x * 255).toString(16).padStart(2, "0");
          const a = (p.color.a ?? 1) * (p.opacity ?? 1);
          return `#${h(p.color.r)}${h(p.color.g)}${h(p.color.b)}${a < 0.999 ? h(a) : ""}`;
        }
        return p.type.toLowerCase();
      })
      .join(", ");
    styleLines.push(`  paint ${s.name} = ${desc}`);
  }
  for (const s of t.styles.effect.filter((x) => matches(filter, x.name))) {
    styleLines.push(`  effect ${s.name} = ${(s.effects as { type: string }[]).map((e) => e.type.toLowerCase()).join(", ")} (see get_design for CSS)`);
  }
  if (styleLines.length) lines.push(format === "css" ? "/* styles */" : "styles:", ...styleLines.map((l) => (format === "css" ? `/*${l} */` : l)));
  if (!lines.length) return filter ? `No local variables or styles match "${filter}".` : "This file has no local variables or styles (library tokens show up in get_design output).";
  return lines.join("\n");
}
