/**
 * Loupe MCP server (stdio). Read-only: every tool reads the open Figma file
 * through the Loupe plugin; nothing is ever written to Figma.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { Bridge, SERVER_VERSION } from "./bridge/hub";
import { renderSnapshot } from "./model/render";
import { formatMatches, formatOutline, formatStatus, formatTokens } from "./tools/format";
import { compare, exportAssets, screenshot } from "./tools/media";
import { parseTarget, type Target } from "./tools/target";

export const INSTRUCTIONS = `Loupe reads Figma designs (read-only) for faithful implementation.

Workflow: get_design (structure + exact styles) → get_screenshot (look at it) → export_assets (icons/images) → build → compare_screenshot with a screenshot of your build, fix the listed regions, repeat.
Targets: a Figma URL, node ids ("12:34", comma-separated), or nothing = the user's current selection in Figma.

get_design format — one line per layer, children indented:
  <kind> ["name"] #id W×H props…   kinds: frame group section component set instance text svg img rect ellipse line
  Props are CSS-like, separated by "; ". A bare word is a flag.
  Size: W×H are px. w:/h: fill|hug (bare "fill"/"hug" = both axes); no w/h = fixed. minw/maxw/minh/maxh.
  Flow (auto layout): row|col|grid, gap, rowgap, wrap, p (CSS padding shorthand, commas), justify (center|end|between), align (center|end|baseline). Children of a flow parent are positioned by the flow.
  Free position: at:x,y = CSS left/top inside the parent; abs = absolutely positioned inside a flow parent; pin:right|bottom|center-x|left+right… = constraints (how it moves when the parent resizes); rotate:<deg> (CSS sign).
  Style: bg (CSS background, topmost layer first), border:<width> [dashed(…)] <color> [outside|center] (default inside → box-sizing: border-box), radius (full = pill), smooth (corner smoothing), shadow/text-shadow (CSS), blur/backdrop (CSS blur() radius, already halved from Figma), opacity, blend, clip (overflow hidden), mask.
  img: src:<hash> cover|contain|crop|tile → file from export_assets. svg: vector graphic → export_assets; color: its fill.
  Text: font:<token>; color; text-align; valign; ellipsis; content last as a JSON string. "~" lines under text = styled runs that differ from the base style.
  $name = design token (Figma variable/style); see "## tokens". T1, E1 = repeated typography/effect values listed there. "$name=value" = token bound but resolved to another value here (mode/override).
  Components: "## components" prints each repeated component once. "instance Name{Variant=…} Prop=value" uses it; "~ path: changes" lines list only what that instance overrides.
  "+N more like ↑" / "+N more alternating like the 2 above" = siblings with the same structure as the layer(s) just printed; the lines under it give each one's id and its own texts/images.
  "… +N layers not shown → get_design #id" = cut by the token budget; fetch that subtree when you need it.
  // lines = designer notes, prototype interactions, component props, exports.
Reproduce exact values (sizes, spacing, colours, type). Map $tokens to the codebase's existing tokens/variables when they exist.`;

const fileParam = z.string().optional().describe("Which open Figma file (name or key) when several are connected. Default: the most recently active.");
const targetParam = z
  .string()
  .optional()
  .describe('Figma URL, node id(s) like "12:34" (comma-separated), or omit for the current selection in Figma.');

function text(t: string) {
  return { content: [{ type: "text" as const, text: t }] };
}

function fail(e: unknown) {
  return { content: [{ type: "text" as const, text: `Error: ${e instanceof Error ? e.message : String(e)}` }], isError: true };
}

export function createServer(bridge: Bridge): McpServer {
  const server = new McpServer({ name: "loupe", version: SERVER_VERSION }, { instructions: INSTRUCTIONS });

  /** Resolve a target to node ids and the file to ask. */
  async function resolve(target: string | undefined, file: string | undefined): Promise<{ ids: string[]; file?: string }> {
    const t: Target = parseTarget(target);
    await bridge.start();
    if (!bridge.list().length) await bridge.waitForPlugin(4_000);
    let fileRef = file;
    if (!fileRef && t.fileKey) {
      const byKey = bridge.list().find((p) => p.fileKey === t.fileKey);
      if (byKey) fileRef = byKey.conn;
      else if (bridge.list().some((p) => p.fileKey)) {
        throw new Error(`The URL points at file ${t.fileKey}, which is not open with the Loupe plugin. Open that file in Figma and run the plugin there.`);
      }
    }
    if (t.ids.length) return { ids: t.ids, file: fileRef };
    const plugin = bridge.pick(fileRef);
    if (!plugin.selection.length) {
      throw new Error(
        `Nothing is selected in "${plugin.fileName}" (page "${plugin.pageName}"). Ask the user to select a frame, pass a Figma link / node id, or call get_outline to see the page.`,
      );
    }
    return { ids: plugin.selection.map((s) => s.id), file: plugin.conn };
  }

  server.registerTool(
    "status",
    {
      title: "Connection status",
      description: "Which Figma files are connected through the Loupe plugin, their current page and selection.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => {
      try {
        await bridge.start();
        if (!bridge.list().length) await bridge.waitForPlugin(1_500);
        return text(formatStatus(bridge.list(), bridge.mode, bridge.port));
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "get_outline",
    {
      title: "Page outline",
      description: "Lists pages and their top-level frames (ids, sizes) — a cheap map of the file for finding what to implement.",
      inputSchema: {
        page: z.string().optional().describe('Page name or id; "*" lists every page\'s frames. Default: current page.'),
        depth: z.number().int().min(1).max(4).optional().describe("Levels below the page (default 1)."),
        file: fileParam,
      },
      annotations: { readOnlyHint: true },
    },
    async ({ page, depth, file }) => {
      try {
        await bridge.start();
        if (!bridge.list().length) await bridge.waitForPlugin(4_000);
        return text(formatOutline(await bridge.request("outline", { page, depth }, file)));
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "find_nodes",
    {
      title: "Find layers",
      description: "Search layers by name (or text content with text:true) across the file, a page, or inside a node.",
      inputSchema: {
        query: z.string().describe("Case-insensitive substring."),
        text: z.boolean().optional().describe("Match text content of text layers instead of layer names."),
        types: z.array(z.string()).optional().describe('Layer types, e.g. ["FRAME","COMPONENT","INSTANCE","TEXT"].'),
        page: z.string().optional().describe('Page name or id; "*" or omitted = all pages.'),
        within: z.string().optional().describe("Only search inside this node id."),
        limit: z.number().int().min(1).max(200).optional(),
        file: fileParam,
      },
      annotations: { readOnlyHint: true },
    },
    async ({ query, text: byText, types, page, within, limit, file }) => {
      try {
        await bridge.start();
        if (!bridge.list().length) await bridge.waitForPlugin(4_000);
        const withinId = within ? parseTarget(within).ids[0] : undefined;
        return text(formatMatches(await bridge.request("find", { query, text: byText, types, page, within: withinId, limit }, file)));
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "get_design",
    {
      title: "Read a design",
      description:
        "The main tool: a compact, exact description of a frame/component (layout, sizes, colours, typography, tokens, components, overrides) for reproducing it in code. Output is breadth-first within a token budget; cut subtrees say how to fetch them.",
      inputSchema: {
        target: targetParam,
        budget: z.number().int().min(500).max(100_000).optional().describe("Approximate output size in tokens (default 8000)."),
        components: z
          .enum(["auto", "inline", "names"])
          .optional()
          .describe("auto (default): repeated components printed once + per-instance overrides. inline: every instance expanded. names: instances as one line (when the codebase already has them)."),
        depth: z.number().int().min(0).optional().describe("Max levels to read below the target (default: all)."),
        include_hidden: z.boolean().optional().describe("Include hidden layers (default false)."),
        expand_vectors: z.boolean().optional().describe("Describe the shapes inside icons/illustrations instead of one svg line (default false)."),
        file: fileParam,
      },
      annotations: { readOnlyHint: true },
    },
    async ({ target, budget, components, depth, include_hidden, expand_vectors, file }) => {
      try {
        const r = await resolve(target, file);
        const snap = await bridge.request(
          "snapshot",
          { ids: r.ids, depth, includeHidden: include_hidden, expandVectors: expand_vectors, components: components !== "names", maxNodes: 30000 },
          r.file,
        );
        if (!snap.roots.length) throw new Error(`Nothing found for ${r.ids.join(", ")}${snap.missing.length ? " (not in this file, or deleted)" : ""}`);
        const out = renderSnapshot(snap, { budget: budget ?? 8000, components: components ?? "auto" });
        return text(out.text);
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "get_screenshot",
    {
      title: "Screenshot",
      description:
        "Renders the target as PNG image(s) you can look at. Wide renders are scaled to what vision can read; tall ones are split into tiles. Optionally saves the full-resolution PNG.",
      inputSchema: {
        target: targetParam,
        scale: z.number().min(0.1).max(4).optional().describe("Render scale (default: 2, reduced to fit 1568px wide)."),
        save_to: z.string().optional().describe("Also write the PNG to this path (e.g. for visual tests)."),
        file: fileParam,
      },
      annotations: { readOnlyHint: true },
    },
    async ({ target, scale, save_to, file }) => {
      try {
        const r = await resolve(target, file);
        const shot = await screenshot(bridge, r.ids, r.file, { scale, saveTo: save_to });
        return { content: [{ type: "text" as const, text: shot.text }, ...shot.images] };
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "export_assets",
    {
      title: "Export assets",
      description:
        'Writes the icons (SVG) and images (original files) used inside the target to a folder, deduplicated, and lists which file belongs to which layer / src hash. as:"svg"|"png" exports the target layers themselves instead.',
      inputSchema: {
        target: targetParam,
        dir: z.string().optional().describe('Output folder (default "figma-assets" in the working directory).'),
        as: z.enum(["auto", "svg", "png"]).optional().describe("auto (default): every svg graphic + image fill inside the target."),
        scale: z.number().min(0.5).max(4).optional().describe('PNG scale for as:"png" (default 2).'),
        current_color: z.boolean().optional().describe("Replace the single colour of monochrome SVG icons with currentColor (default false)."),
        file: fileParam,
      },
      annotations: { readOnlyHint: true },
    },
    async ({ target, dir, as, scale, current_color, file }) => {
      try {
        const r = await resolve(target, file);
        return text(await exportAssets(bridge, r.ids, r.file, { dir: dir ?? "figma-assets", as: as ?? "auto", scale, currentColor: current_color }));
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "get_tokens",
    {
      title: "Design tokens",
      description: "The file's local variables (all modes) and styles — as a readable list, CSS custom properties, or JSON.",
      inputSchema: {
        format: z.enum(["list", "css", "json"]).optional().describe("Default list."),
        filter: z.string().optional().describe("Only tokens whose name contains this."),
        file: fileParam,
      },
      annotations: { readOnlyHint: true },
    },
    async ({ format, filter, file }) => {
      try {
        await bridge.start();
        if (!bridge.list().length) await bridge.waitForPlugin(4_000);
        return text(formatTokens(await bridge.request("tokens", {}, file), format ?? "list", filter));
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "get_css",
    {
      title: "Figma's CSS",
      description: "Figma's own generated CSS (as in Dev Mode) for specific layers — a cross-check, not a layout description.",
      inputSchema: { target: targetParam, file: fileParam },
      annotations: { readOnlyHint: true },
    },
    async ({ target, file }) => {
      try {
        const r = await resolve(target, file);
        const res = await bridge.request("css", { ids: r.ids.slice(0, 20) }, r.file);
        return text(
          res.nodes
            .map((x) => `/* ${x.type.toLowerCase()} "${x.name}" #${x.id} */\n${Object.entries(x.css).map(([k, v]) => `${k}: ${v};`).join("\n")}`)
            .join("\n\n"),
        );
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "compare_screenshot",
    {
      title: "Compare with implementation",
      description:
        "Pixel-diffs a PNG screenshot of your implementation against the Figma render of the target (rendered at the screenshot's width). Returns the mismatch %, the differing regions mapped to Figma layers, and a design | implementation | diff image.",
      inputSchema: {
        target: targetParam,
        image: z.string().describe("Path to a PNG screenshot of the implementation, cropped to the same element."),
        threshold: z.number().min(0).max(1).optional().describe("Per-pixel colour tolerance 0–1 (default 0.1)."),
        save_diff: z.string().optional().describe("Also write the comparison image to this path."),
        file: fileParam,
      },
      annotations: { readOnlyHint: true },
    },
    async ({ target, image, threshold, save_diff, file }) => {
      try {
        const r = await resolve(target, file);
        const res = await compare(bridge, r.ids[0]!, r.file, { image, threshold, saveDiff: save_diff });
        return { content: [{ type: "text" as const, text: res.text }, ...res.images] };
      } catch (e) {
        return fail(e);
      }
    },
  );

  return server;
}

export async function main(): Promise<void> {
  const debug = !!process.env.LOUPE_DEBUG;
  const bridge = new Bridge({ log: (m) => debug && process.stderr.write(`[loupe] ${m}\n`) });
  bridge.start().catch((e) => process.stderr.write(`[loupe] ${e.message}\n`));
  const server = createServer(bridge);
  await server.connect(new StdioServerTransport());
  const shutdown = () => {
    bridge.close().finally(() => process.exit(0));
  };
  process.stdin.on("close", shutdown);
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
