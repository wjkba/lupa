/// <reference types="@figma/plugin-typings" />

/**
 * Loupe plugin — main thread.
 *
 * Read-only: it never edits the document. It answers requests relayed by the
 * UI iframe (which owns the WebSocket to the local MCP hub) and streams the
 * current page and selection so the agent can say "implement what I selected".
 */

import { PROTOCOL_VERSION, type SelectionItem } from "../../src/shared/protocol";
import {
  handleCss,
  handleExport,
  handleFind,
  handleImageBytes,
  handleOutline,
  handleSnapshot,
  handleTokens,
} from "./handlers";

declare const PLUGIN_VERSION: string;

// Invisible instance sublayers are never rendered, and skipping them makes
// traversal of component-heavy files dramatically faster.
figma.skipInvisibleInstanceChildren = true;

figma.showUI(__html__, { width: 280, height: 148, themeColors: true, title: "Loupe" });

function selection(): SelectionItem[] {
  return figma.currentPage.selection.slice(0, 25).map((n) => ({
    id: n.id,
    name: n.name,
    type: n.type,
    w: Math.round("width" in n ? n.width : 0),
    h: Math.round("height" in n ? n.height : 0),
  }));
}

function fileKey(): string | undefined {
  try {
    return figma.fileKey ?? undefined;
  } catch {
    return undefined;
  }
}

function state() {
  return {
    fileName: figma.root.name,
    pageId: figma.currentPage.id,
    pageName: figma.currentPage.name,
    selection: selection(),
  };
}

function hello() {
  return {
    t: "hello",
    role: "plugin",
    protocol: PROTOCOL_VERSION,
    pluginVersion: PLUGIN_VERSION,
    fileKey: fileKey(),
    editorType: figma.editorType,
    ...state(),
  };
}

const handlers: Record<string, (params: any) => Promise<unknown>> = {
  ping: async () => ({ ok: true }),
  snapshot: handleSnapshot,
  outline: handleOutline,
  find: handleFind,
  export: handleExport,
  imageBytes: handleImageBytes,
  tokens: handleTokens,
  css: handleCss,
};

figma.ui.onmessage = async (msg: { type?: string; id?: string; method?: string; params?: unknown; height?: number }) => {
  if (!msg || typeof msg.type !== "string") return;
  if (msg.type === "ready") {
    figma.ui.postMessage({ type: "init", hello: hello() });
    return;
  }
  if (msg.type === "resize" && typeof msg.height === "number") {
    figma.ui.resize(280, Math.max(96, Math.min(400, Math.round(msg.height))));
    return;
  }
  if (msg.type === "req" && msg.id && msg.method) {
    const handler = handlers[msg.method];
    try {
      if (!handler) throw new Error(`Unknown method "${msg.method}" — update the Loupe plugin.`);
      const result = await handler(msg.params ?? {});
      figma.ui.postMessage({ type: "res", id: msg.id, ok: true, result });
    } catch (e) {
      figma.ui.postMessage({ type: "res", id: msg.id, ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  }
};

let timer: ReturnType<typeof setTimeout> | undefined;
function pushState() {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => figma.ui.postMessage({ type: "state", state: state() }), 150);
}
figma.on("selectionchange", pushState);
figma.on("currentpagechange", pushState);
