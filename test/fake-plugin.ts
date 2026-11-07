/** A stand-in for the Figma plugin UI: connects to the hub like the real iframe does. */

import { PNG } from "pngjs";
import { WebSocket } from "ws";
import { snapshot } from "../plugin/src/extract";
import { PROTOCOL_VERSION } from "../src/shared/protocol";
import type { FakeFile } from "./fake-figma";

export interface FakePluginOptions {
  port: number;
  file: FakeFile;
  fileName: string;
  fileKey?: string;
  selection?: string[];
  origin?: string;
  /** Report Figma's window as hidden (exports are refused). */
  hidden?: boolean;
  /** Paint exported PNGs with this colour (to simulate a design render). */
  paint?: (x: number, y: number, w: number, h: number) => [number, number, number];
}

export function solidPng(w: number, h: number, paint: (x: number, y: number) => [number, number, number]): Buffer {
  const png = new PNG({ width: w, height: h });
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const [r, g, b] = paint(x, y);
      const i = (y * w + x) * 4;
      png.data[i] = r;
      png.data[i + 1] = g;
      png.data[i + 2] = b;
      png.data[i + 3] = 255;
    }
  }
  return PNG.sync.write(png);
}

function paintsOf(node: any): string[] {
  const own = [...(node.fills ?? []), ...(node.strokes ?? [])].map((p: any) => (p.color ? `${p.color.r},${p.color.g},${p.color.b}` : p.type));
  return [...own, ...(node.children ?? []).flatMap(paintsOf)];
}

export function connectFakePlugin(o: FakePluginOptions): Promise<WebSocket> {
  const ws = new WebSocket(`ws://127.0.0.1:${o.port}`, { origin: o.origin ?? "null" });
  const sel = (o.selection ?? []).map((id) => {
    const n = o.file.nodes.get(id);
    return { id, name: n.name, type: n.type, w: n.width, h: n.height };
  });
  return new Promise((resolve, reject) => {
    ws.on("open", () =>
      ws.send(
        JSON.stringify({
          t: "hello",
          role: "plugin",
          protocol: PROTOCOL_VERSION,
          pluginVersion: "test",
          fileName: o.fileName,
          fileKey: o.fileKey,
          pageId: "0:1",
          pageName: "Home",
          editorType: "figma",
          selection: sel,
          hidden: o.hidden,
        }),
      ),
    );
    ws.on("error", reject);
    ws.on("close", () => reject(new Error("closed")));
    ws.on("message", async (data) => {
      const msg = JSON.parse(String(data));
      if (msg.t === "welcome") resolve(ws);
      if (msg.t !== "req") return;
      try {
        const result = await handle(o, msg.method, msg.params);
        ws.send(JSON.stringify({ t: "res", id: msg.id, ok: true, result }));
      } catch (e) {
        ws.send(JSON.stringify({ t: "res", id: msg.id, ok: false, error: (e as Error).message }));
      }
    });
  });
}

async function handle(o: FakePluginOptions, method: string, params: any): Promise<unknown> {
  const f = o.file;
  switch (method) {
    case "ping":
      return { ok: true };
    case "snapshot": {
      const roots = params.ids.map((id: string) => f.nodes.get(id)).filter(Boolean);
      const snap = await snapshot(f.api, roots, params, { fileName: o.fileName, pageName: "Home" });
      snap.missing = params.ids.filter((id: string) => !f.nodes.has(id));
      return snap;
    }
    case "export": {
      const blobs = [];
      for (const id of params.ids) {
        const n = f.nodes.get(id);
        if (params.format === "SVG") {
          // Same paints and size → same SVG, like Figma's export of identical drawings.
          const svg = `<svg width="${n.width}" height="${n.height}"><path fill="#F5A524" d="M0 0h1v1z" data-paints="${paintsOf(n).join(" ")}"/></svg>`;
          blobs.push({ id, name: n.name, format: "SVG", data: svg, encoding: "utf8", w: n.width, h: n.height });
        } else {
          const scale = params.width ? params.width / n.width : params.scale ?? 2;
          const w = Math.round(n.width * scale);
          const h = Math.round(n.height * scale);
          const paint = o.paint ?? (() => [255, 255, 255]);
          const png = solidPng(w, h, (x, y) => paint(x / scale, y / scale, n.width, n.height));
          blobs.push({ id, name: n.name, format: "PNG", data: png.toString("base64"), encoding: "base64", w: n.width, h: n.height });
        }
      }
      return { blobs, errors: [] };
    }
    case "imageBytes":
      return {
        images: params.hashes.map((hash: string) => ({ hash, data: solidPng(4, 3, () => [10, 20, 30]).toString("base64"), w: 4, h: 3 })),
        errors: [],
      };
    case "outline":
      return { fileName: o.fileName, currentPageId: "0:1", pages: [{ id: "0:1", name: "Home", loaded: true, nodes: [] }] };
    default:
      throw new Error(`fake plugin: ${method} not implemented`);
  }
}
