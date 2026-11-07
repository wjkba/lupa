/**
 * Wire protocol shared by the Figma plugin, the hub and peer MCP processes.
 *
 * Everything here is JSON. Binary payloads (PNG, image bytes) travel as base64
 * strings: the plugin and the hub share a machine, so the 33% overhead is
 * irrelevant next to the simplicity of one channel.
 */

import type { RawSnapshot } from "./raw";

export const PROTOCOL_VERSION = 1;
export const DEFAULT_PORT = 38451;

/** What a connected plugin tells the hub about itself. */
export interface PluginInfo {
  /** Hub-assigned connection id. */
  conn: string;
  fileName: string;
  /** Only available when Figma exposes it to the plugin (private/dev plugins). */
  fileKey?: string;
  pageId: string;
  pageName: string;
  editorType: string;
  user?: string;
  pluginVersion: string;
  protocol: number;
  selection: SelectionItem[];
  /** ms epoch of the last selection/page change, used to pick the "active" file. */
  activeAt: number;
}

export interface SelectionItem {
  id: string;
  name: string;
  type: string;
  w: number;
  h: number;
}

/* ------------------------------------------------------------------ */
/* Request methods (hub → plugin)                                      */
/* ------------------------------------------------------------------ */

export interface SnapshotParams {
  ids: string[];
  /** Levels below each root to serialize. Undefined = unlimited. */
  depth?: number;
  /** Stop serializing after this many nodes (the rest become `childCount` stubs). */
  maxNodes?: number;
  includeHidden?: boolean;
  /** Serialize the main component of every instance found (for definitions + override diffs). */
  components?: boolean;
  /** Keep the inner vectors of icons/illustrations instead of collapsing them. */
  expandVectors?: boolean;
}

export interface OutlineParams {
  /** Page id or name; "*" = every page. Default: current page. */
  page?: string;
  /** Levels under each page to list (1 = top-level frames). */
  depth?: number;
}

export interface OutlineNode {
  id: string;
  name: string;
  type: string;
  w: number;
  h: number;
  children?: OutlineNode[];
  childCount?: number;
}

export interface OutlineResult {
  fileName: string;
  currentPageId: string;
  pages: { id: string; name: string; loaded: boolean; nodes?: OutlineNode[] }[];
}

export interface FindParams {
  query?: string;
  /** Match text content of TEXT nodes instead of layer names. */
  text?: boolean;
  types?: string[];
  page?: string;
  within?: string;
  limit?: number;
}

export interface FindMatch {
  id: string;
  name: string;
  type: string;
  w: number;
  h: number;
  page: string;
  path: string[];
  text?: string;
}

export interface ExportParams {
  /** Explicit nodes to render. */
  ids?: string[];
  format: "PNG" | "SVG" | "JPG" | "PDF";
  scale?: number;
  /** Fit the render to this width (overrides scale). */
  width?: number;
  svgOutlineText?: boolean;
  /** Render exactly the layer's bounds (no shadow overflow, no trimming), so pixels map 1:1 to layout. */
  exactBounds?: boolean;
}

export interface ExportedBlob {
  id: string;
  name: string;
  format: string;
  /** base64 for binary formats, raw text for SVG. */
  data: string;
  encoding: "base64" | "utf8";
  w: number;
  h: number;
}

export interface ImageBytesParams {
  hashes: string[];
}

export interface ImageBytes {
  hash: string;
  data: string; // base64
  w?: number;
  h?: number;
}

export interface TokensResult {
  collections: {
    id: string;
    name: string;
    remote: boolean;
    modes: { id: string; name: string }[];
    defaultModeId: string;
    variables: {
      id: string;
      name: string;
      type: string;
      description?: string;
      web?: string;
      scopes?: string[];
      /** modeId → value. Aliases come as { alias: "<variable name>", aliasWeb?: string }. */
      values: Record<string, unknown>;
    }[];
  }[];
  styles: {
    paint: { id: string; name: string; description?: string; paints: unknown[] }[];
    text: { id: string; name: string; description?: string; style: Record<string, unknown> }[];
    effect: { id: string; name: string; description?: string; effects: unknown[] }[];
    grid: { id: string; name: string; description?: string; grids: unknown[] }[];
  };
}

export interface MethodMap {
  ping: { params: Record<string, never>; result: { ok: true } };
  snapshot: { params: SnapshotParams; result: RawSnapshot };
  outline: { params: OutlineParams; result: OutlineResult };
  find: { params: FindParams; result: { matches: FindMatch[]; truncated: boolean } };
  export: { params: ExportParams; result: { blobs: ExportedBlob[]; errors: { id: string; error: string }[] } };
  imageBytes: { params: ImageBytesParams; result: { images: ImageBytes[]; errors: { hash: string; error: string }[] } };
  tokens: { params: Record<string, never>; result: TokensResult };
  css: { params: { ids: string[] }; result: { nodes: { id: string; name: string; type: string; css: Record<string, string> }[] } };
}

export type Method = keyof MethodMap;

/* ------------------------------------------------------------------ */
/* Envelopes                                                           */
/* ------------------------------------------------------------------ */

export interface HelloPlugin {
  t: "hello";
  role: "plugin";
  protocol: number;
  pluginVersion: string;
  fileName: string;
  fileKey?: string;
  pageId: string;
  pageName: string;
  editorType: string;
  user?: string;
  selection: SelectionItem[];
}

export interface HelloPeer {
  t: "hello";
  role: "peer";
  protocol: number;
}

export interface StateUpdate {
  t: "state";
  pageId: string;
  pageName: string;
  fileName: string;
  selection: SelectionItem[];
}

export interface RequestMsg {
  t: "req";
  id: string;
  method: Method;
  params: unknown;
  /** Peer requests: which file to route to (name, key or connection id). */
  target?: string;
}

export interface ResponseMsg {
  t: "res";
  id: string;
  ok: boolean;
  result?: unknown;
  error?: string;
}

export interface PluginsMsg {
  t: "plugins";
  plugins: PluginInfo[];
}

export interface WelcomeMsg {
  t: "welcome";
  role: "plugin" | "peer";
  conn: string;
  serverVersion: string;
}

export type AnyMsg =
  | HelloPlugin
  | HelloPeer
  | StateUpdate
  | RequestMsg
  | ResponseMsg
  | PluginsMsg
  | WelcomeMsg
  | { t: "list" };
