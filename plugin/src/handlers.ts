/// <reference types="@figma/plugin-typings" />

/**
 * Request handlers: one per protocol method. Each returns a JSON-safe result
 * or throws; `code.ts` wraps them into response envelopes.
 */

import type {
  ExportParams,
  ExportedBlob,
  FindMatch,
  FindParams,
  ImageBytes,
  OutlineNode,
  OutlineParams,
  OutlineResult,
  SnapshotParams,
  TokensResult,
} from "../../src/shared/protocol";
import type { RawSnapshot } from "../../src/shared/raw";
import { clonePaints, colorHex, r2, snapshot } from "./extract";

function isScene(n: BaseNode | null): n is SceneNode {
  return !!n && n.type !== "DOCUMENT" && n.type !== "PAGE";
}

async function resolvePage(ref: string | undefined): Promise<PageNode> {
  if (!ref) return figma.currentPage;
  const byId = figma.root.children.find((p) => p.id === ref);
  if (byId) return byId;
  const lower = ref.toLowerCase();
  const byName =
    figma.root.children.find((p) => p.name === ref) ??
    figma.root.children.find((p) => p.name.toLowerCase() === lower) ??
    figma.root.children.find((p) => p.name.toLowerCase().includes(lower));
  if (!byName) throw new Error(`No page "${ref}". Pages: ${figma.root.children.map((p) => p.name).join(", ")}`);
  return byName;
}

/* ------------------------------------------------------------------ */

export async function handleSnapshot(params: SnapshotParams): Promise<RawSnapshot> {
  const roots: SceneNode[] = [];
  const missing: string[] = [];
  for (const id of params.ids) {
    const node = await figma.getNodeByIdAsync(id);
    if (node && node.type === "PAGE") {
      await node.loadAsync();
      roots.push(...node.children);
    } else if (isScene(node)) {
      roots.push(node);
    } else {
      missing.push(id);
    }
  }
  const page = roots[0] ? pageOf(roots[0]) : figma.currentPage;
  const snap = await snapshot(figma as any, roots, params, { fileName: figma.root.name, pageName: page?.name ?? "" });
  snap.missing = missing;
  return snap;
}

function pageOf(node: BaseNode): PageNode | null {
  let p: BaseNode | null = node;
  while (p && p.type !== "PAGE") p = p.parent;
  return p as PageNode | null;
}

/* ------------------------------------------------------------------ */

function outlineNode(node: SceneNode, depthLeft: number): OutlineNode {
  const o: OutlineNode = {
    id: node.id,
    name: node.name,
    type: node.type,
    w: Math.round("width" in node ? node.width : 0),
    h: Math.round("height" in node ? node.height : 0),
  };
  if ("children" in node && node.type !== "INSTANCE" && node.children.length) {
    const kids = node.children.filter((c) => c.visible !== false);
    if (depthLeft > 1) o.children = kids.map((c) => outlineNode(c, depthLeft - 1));
    else o.childCount = kids.length;
  }
  return o;
}

export async function handleOutline(params: OutlineParams): Promise<OutlineResult> {
  const depth = Math.min(Math.max(params.depth ?? 1, 1), 4);
  const want = params.page === "*" ? null : await resolvePage(params.page);
  const pages: OutlineResult["pages"] = [];
  for (const page of figma.root.children) {
    const include = want === null || page === want;
    if (include) {
      await page.loadAsync();
      pages.push({
        id: page.id,
        name: page.name,
        loaded: true,
        nodes: page.children.filter((c) => c.visible !== false).map((c) => outlineNode(c, depth)),
      });
    } else {
      pages.push({ id: page.id, name: page.name, loaded: false });
    }
  }
  return { fileName: figma.root.name, currentPageId: figma.currentPage.id, pages };
}

/* ------------------------------------------------------------------ */

function pathOf(node: BaseNode): string[] {
  const names: string[] = [];
  let p = node.parent;
  while (p && p.type !== "PAGE" && p.type !== "DOCUMENT") {
    names.unshift(p.name);
    p = p.parent;
  }
  return names;
}

export async function handleFind(params: FindParams): Promise<{ matches: FindMatch[]; truncated: boolean }> {
  const limit = Math.min(params.limit ?? 30, 200);
  const q = (params.query ?? "").trim().toLowerCase();
  const types = params.types?.map((t) => t.toUpperCase());
  let scopes: (PageNode | SceneNode)[];
  if (params.within) {
    const n = await figma.getNodeByIdAsync(params.within);
    if (!n || n.type === "DOCUMENT") throw new Error(`Node ${params.within} not found`);
    if (n.type === "PAGE") await n.loadAsync();
    scopes = [n as PageNode | SceneNode];
  } else if (params.page && params.page !== "*") {
    const page = await resolvePage(params.page);
    await page.loadAsync();
    scopes = [page];
  } else {
    await figma.loadAllPagesAsync();
    scopes = [...figma.root.children];
  }

  const matches: (FindMatch & { score: number })[] = [];
  let truncated = false;
  for (const scope of scopes) {
    if (!("findAll" in scope)) continue;
    const pageName = scope.type === "PAGE" ? scope.name : pageOf(scope)?.name ?? "";
    let found: SceneNode[];
    if (params.text) {
      found = (scope as ChildrenMixin).findAllWithCriteria({ types: ["TEXT"] }) as SceneNode[];
    } else if (types?.length) {
      found = (scope as ChildrenMixin).findAllWithCriteria({ types: types as NodeType[] } as any) as SceneNode[];
    } else {
      found = (scope as ChildrenMixin).findAll(() => true);
    }
    for (const n of found) {
      if (n.visible === false) continue;
      // Instance sublayers flood name searches (every button has a "Label"); text search keeps them.
      if (!params.text && n.id.startsWith("I")) continue;
      if (types?.length && !types.includes(n.type)) continue;
      let score = 0;
      let text: string | undefined;
      if (params.text) {
        text = (n as TextNode).characters;
        const lower = text.toLowerCase();
        if (q && !lower.includes(q)) continue;
        score = lower === q ? 3 : lower.startsWith(q) ? 2 : 1;
      } else if (q) {
        const name = n.name.toLowerCase();
        if (!name.includes(q)) continue;
        score = name === q ? 3 : name.startsWith(q) ? 2 : 1;
      }
      if (matches.length >= limit * 4) {
        truncated = true;
        break;
      }
      const m: FindMatch & { score: number } = {
        id: n.id,
        name: n.name,
        type: n.type,
        w: Math.round("width" in n ? n.width : 0),
        h: Math.round("height" in n ? n.height : 0),
        page: pageName,
        path: pathOf(n),
        score,
      };
      if (text !== undefined) m.text = text.length > 120 ? text.slice(0, 117) + "…" : text;
      matches.push(m);
    }
  }
  matches.sort((a, b) => b.score - a.score || a.path.length - b.path.length);
  if (matches.length > limit) truncated = true;
  return { matches: matches.slice(0, limit).map(({ score: _s, ...m }) => m), truncated };
}

/* ------------------------------------------------------------------ */

export async function handleExport(params: ExportParams): Promise<{ blobs: ExportedBlob[]; errors: { id: string; error: string }[] }> {
  const blobs: ExportedBlob[] = [];
  const errors: { id: string; error: string }[] = [];
  for (const id of params.ids ?? []) {
    try {
      const node = await figma.getNodeByIdAsync(id);
      if (!isScene(node)) throw new Error("node not found");
      const w = "width" in node ? node.width : 0;
      const h = "height" in node ? node.height : 0;
      if (params.format === "SVG") {
        const svg = await node.exportAsync({
          format: "SVG_STRING",
          svgOutlineText: params.svgOutlineText ?? true,
          svgIdAttribute: false,
          svgSimplifyStroke: true,
        });
        blobs.push({ id, name: node.name, format: "SVG", data: svg, encoding: "utf8", w: r2(w), h: r2(h) });
      } else {
        const settings: ExportSettings =
          params.format === "PDF"
            ? { format: "PDF" }
            : {
                format: params.format,
                constraint: params.width ? { type: "WIDTH", value: params.width } : { type: "SCALE", value: params.scale ?? 2 },
                ...(params.exactBounds ? { useAbsoluteBounds: true } : {}),
              };
        const bytes = await node.exportAsync(settings);
        blobs.push({ id, name: node.name, format: params.format, data: figma.base64Encode(bytes), encoding: "base64", w: r2(w), h: r2(h) });
      }
    } catch (e) {
      errors.push({ id, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return { blobs, errors };
}

export async function handleImageBytes(params: { hashes: string[] }): Promise<{ images: ImageBytes[]; errors: { hash: string; error: string }[] }> {
  const images: ImageBytes[] = [];
  const errors: { hash: string; error: string }[] = [];
  for (const hash of params.hashes) {
    try {
      const img = figma.getImageByHash(hash);
      if (!img) throw new Error("image not found");
      const bytes = await img.getBytesAsync();
      let size: { width: number; height: number } | undefined;
      try {
        size = await img.getSizeAsync();
      } catch {
        size = undefined;
      }
      images.push({ hash, data: figma.base64Encode(bytes), w: size?.width, h: size?.height });
    } catch (e) {
      errors.push({ hash, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return { images, errors };
}

/* ------------------------------------------------------------------ */

function variableValue(v: VariableValue, names: Map<string, Variable>): unknown {
  if (v && typeof v === "object" && "type" in v && (v as VariableAlias).type === "VARIABLE_ALIAS") {
    const target = names.get((v as VariableAlias).id);
    return target ? { alias: target.name, ...(target.codeSyntax?.WEB ? { aliasWeb: target.codeSyntax.WEB } : {}) } : { alias: (v as VariableAlias).id };
  }
  if (v && typeof v === "object" && "r" in v) return colorHex(v as RGBA);
  return v;
}

export async function handleTokens(): Promise<TokensResult> {
  const collections = await figma.variables.getLocalVariableCollectionsAsync();
  const all = await figma.variables.getLocalVariablesAsync();
  const byId = new Map(all.map((v) => [v.id, v]));
  // Aliases may point at library variables; resolve those names too.
  for (const v of all) {
    for (const val of Object.values(v.valuesByMode)) {
      if (val && typeof val === "object" && "type" in val && (val as VariableAlias).type === "VARIABLE_ALIAS") {
        const id = (val as VariableAlias).id;
        if (!byId.has(id)) {
          const target = await figma.variables.getVariableByIdAsync(id).catch(() => null);
          if (target) byId.set(id, target);
        }
      }
    }
  }
  const result: TokensResult = {
    collections: collections.map((c) => ({
      id: c.id,
      name: c.name,
      remote: c.remote,
      modes: c.modes.map((m) => ({ id: m.modeId, name: m.name })),
      defaultModeId: c.defaultModeId,
      variables: c.variableIds
        .map((id) => byId.get(id))
        .filter((v): v is Variable => !!v)
        .map((v) => {
          const values: Record<string, unknown> = {};
          for (const [mode, val] of Object.entries(v.valuesByMode)) values[mode] = variableValue(val, byId);
          return {
            id: v.id,
            name: v.name,
            type: v.resolvedType,
            ...(v.description ? { description: v.description } : {}),
            ...(v.codeSyntax?.WEB ? { web: v.codeSyntax.WEB } : {}),
            ...(v.scopes?.length && !v.scopes.includes("ALL_SCOPES") ? { scopes: [...v.scopes] } : {}),
            values,
          };
        }),
    })),
    styles: { paint: [], text: [], effect: [], grid: [] },
  };
  const ctxLike = { variableIds: new Set<string>() } as any;
  for (const s of await figma.getLocalPaintStylesAsync()) {
    result.styles.paint.push({ id: s.id, name: s.name, ...(s.description ? { description: s.description } : {}), paints: clonePaints(s.paints, ctxLike) ?? [] });
  }
  for (const s of await figma.getLocalTextStylesAsync()) {
    result.styles.text.push({
      id: s.id,
      name: s.name,
      ...(s.description ? { description: s.description } : {}),
      style: {
        fontFamily: s.fontName.family,
        fontStyle: s.fontName.style,
        fontSize: s.fontSize,
        lineHeight: s.lineHeight,
        letterSpacing: s.letterSpacing,
        textCase: s.textCase,
        textDecoration: s.textDecoration,
        paragraphSpacing: s.paragraphSpacing,
      },
    });
  }
  for (const s of await figma.getLocalEffectStylesAsync()) {
    result.styles.effect.push({ id: s.id, name: s.name, ...(s.description ? { description: s.description } : {}), effects: JSON.parse(JSON.stringify(s.effects)) });
  }
  for (const s of await figma.getLocalGridStylesAsync()) {
    result.styles.grid.push({ id: s.id, name: s.name, ...(s.description ? { description: s.description } : {}), grids: JSON.parse(JSON.stringify(s.layoutGrids)) });
  }
  return result;
}

export async function handleCss(params: { ids: string[] }) {
  const nodes: { id: string; name: string; type: string; css: Record<string, string> }[] = [];
  for (const id of params.ids) {
    const node = await figma.getNodeByIdAsync(id);
    if (!isScene(node)) throw new Error(`Node ${id} not found`);
    nodes.push({ id, name: node.name, type: node.type, css: await node.getCSSAsync() });
  }
  return { nodes };
}
