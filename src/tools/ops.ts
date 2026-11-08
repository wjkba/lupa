/**
 * Every Loupe operation, shared by the CLI and the MCP server. Each returns
 * text for the agent (plus PNG images for the visual ones); the front ends
 * only parse arguments and deliver the result.
 */

import type { Bridge } from "../bridge/hub";
import { printedDefs, renderSnapshot } from "../model/render";
import { renderUrl } from "./browser";
import { formatMatches, formatOutline, formatStatus, formatTokens } from "./format";
import { compare, exportAssets, fontFamilies, screenshot, writeAssets, type Visual } from "./media";
import { parseTarget } from "./target";

export type ComponentsMode = "auto" | "inline" | "names";

export interface DesignOptions {
  target?: string;
  budget?: number;
  components?: ComponentsMode;
  depth?: number;
  includeHidden?: boolean;
  expandVectors?: boolean;
  /** Also write the icons and images to this folder; each layer then names its file in `src:`. */
  assetsDir?: string;
  /** With assetsDir: monochrome SVG icons use currentColor. */
  currentColor?: boolean;
  file?: string;
}

export interface CompareOptions {
  target?: string;
  /** PNG of the implementation (path or bytes)… */
  image?: string | Buffer;
  /** …or a page to render at the design's width. */
  url?: string;
  selector?: string;
  waitFor?: string;
  threshold?: number;
  saveDiff?: string;
  file?: string;
}

export class Loupe {
  /** How long to wait for the plugin to (re)connect before failing. */
  pluginWaitMs = 4_000;

  constructor(readonly bridge: Bridge) {}

  /** Join the bridge and give the plugin a moment to connect. */
  async connect(waitMs = this.pluginWaitMs): Promise<void> {
    await this.bridge.start();
    if (!this.bridge.list().length) await this.bridge.waitForPlugin(waitMs);
  }

  /** A target (URL, ids, or nothing = selection) → node ids and the file to ask. */
  async resolve(target: string | undefined, file: string | undefined): Promise<{ ids: string[]; file?: string }> {
    const t = parseTarget(target);
    await this.connect();
    const list = this.bridge.list();
    let fileRef = file;
    if (!fileRef && t.fileKey) {
      const byKey = list.find((p) => p.fileKey === t.fileKey);
      if (byKey) fileRef = byKey.conn;
      else if (list.some((p) => p.fileKey)) {
        throw new Error(`The URL points at file ${t.fileKey}, which is not open with the Loupe plugin. Open that file in Figma and run the plugin there.`);
      }
    }
    if (t.ids.length) return { ids: t.ids, file: fileRef };
    const plugin = this.bridge.pick(fileRef);
    if (!plugin.selection.length) {
      throw new Error(
        `Nothing is selected in "${plugin.fileName}" (page "${plugin.pageName}"). Select a frame in Figma, pass a Figma link or node id, or list the page with outline.`,
      );
    }
    return { ids: plugin.selection.map((s) => s.id), file: plugin.conn };
  }

  async status(): Promise<string> {
    await this.connect(1_500);
    return formatStatus(this.bridge.list(), this.bridge.mode, this.bridge.port);
  }

  async outline(o: { page?: string; depth?: number; file?: string }): Promise<string> {
    await this.connect();
    return formatOutline(await this.bridge.request("outline", { page: o.page, depth: o.depth }, o.file));
  }

  async find(o: { query: string; text?: boolean; types?: string[]; page?: string; within?: string; limit?: number; file?: string }): Promise<string> {
    await this.connect();
    const within = o.within ? parseTarget(o.within).ids[0] : undefined;
    return formatMatches(await this.bridge.request("find", { query: o.query, text: o.text, types: o.types, page: o.page, within, limit: o.limit }, o.file));
  }

  async design(o: DesignOptions): Promise<string> {
    const r = await this.resolve(o.target, o.file);
    const snap = await this.bridge.request(
      "snapshot",
      { ids: r.ids, depth: o.depth, includeHidden: o.includeHidden, expandVectors: o.expandVectors, components: o.components !== "names", maxNodes: 30000 },
      r.file,
    );
    if (!snap.roots.length) throw new Error(`Nothing found for ${r.ids.join(", ")}${snap.missing.length ? " (not in this file, or deleted)" : ""}`);
    const opts = { budget: o.budget ?? 8000, components: o.components ?? "auto" };
    if (!o.assetsDir) return renderSnapshot(snap, opts).text;
    // Only the component definitions the output prints need their graphics written.
    const defs = printedDefs(snap, opts.components);
    const written = await writeAssets(this.bridge, snap, r.file, { dir: o.assetsDir, currentColor: o.currentColor, defs });
    const text = renderSnapshot(snap, { ...opts, files: { ...written, dir: o.assetsDir } }).text;
    return written.failures.length ? `${text}\n\n## asset export failures\n${written.failures.join("\n")}` : text;
  }

  async screenshot(o: { target?: string; scale?: number; saveTo?: string; file?: string }): Promise<Visual> {
    const r = await this.resolve(o.target, o.file);
    return screenshot(this.bridge, r.ids, r.file, { scale: o.scale, saveTo: o.saveTo });
  }

  async assets(o: { target?: string; dir?: string; as?: "auto" | "svg" | "png"; scale?: number; currentColor?: boolean; file?: string }): Promise<string> {
    const r = await this.resolve(o.target, o.file);
    return exportAssets(this.bridge, r.ids, r.file, { dir: o.dir ?? "figma-assets", as: o.as ?? "auto", scale: o.scale, currentColor: o.currentColor });
  }

  async tokens(o: { format?: "list" | "css" | "json"; filter?: string; file?: string }): Promise<string> {
    await this.connect();
    return formatTokens(await this.bridge.request("tokens", {}, o.file), o.format ?? "list", o.filter);
  }

  async css(o: { target?: string; file?: string }): Promise<string> {
    const r = await this.resolve(o.target, o.file);
    const res = await this.bridge.request("css", { ids: r.ids.slice(0, 20) }, r.file);
    return res.nodes
      .map((x) => `/* ${x.type.toLowerCase()} "${x.name}" #${x.id} */\n${Object.entries(x.css).map(([k, v]) => `${k}: ${v};`).join("\n")}`)
      .join("\n\n");
  }

  async compare(o: CompareOptions): Promise<Visual> {
    if (!o.image === !o.url) throw new Error("Pass either an image (screenshot of your implementation) or a url to render.");
    const r = await this.resolve(o.target, o.file);
    const id = r.ids[0]!;
    const snap = await this.bridge.request("snapshot", { ids: [id], components: false, maxNodes: 8000 }, r.file);
    const root = snap.roots[0];
    if (!root || root.stub) throw new Error(`Node ${id} not found or hidden`);
    let image = o.image;
    let note: string | undefined;
    if (o.url) {
      const fonts = fontFamilies(root);
      const page = await renderUrl({ url: o.url, width: root.w, selector: o.selector, waitFor: o.waitFor, fonts });
      image = page.png;
      if (page.missingFonts.length) {
        note =
          `fonts not available to the page: ${page.missingFonts.map((f) => `"${f}"`).join(", ")}. ` +
          "The browser uses fallbacks, so text and the hug boxes around it differ in width. Load the fonts (@font-face or local install) for an exact comparison.";
      }
    }
    return compare(this.bridge, root, r.file, { image: image!, threshold: o.threshold, saveDiff: o.saveDiff, note });
  }
}
