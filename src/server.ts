/**
 * Loupe MCP server (stdio). Read-only: every tool reads the open Figma file
 * through the Loupe plugin; nothing is ever written to Figma.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { Bridge, SERVER_VERSION } from "./bridge/hub";
import { FORMAT_LEGEND } from "./shared/legend";
import { Loupe } from "./tools/ops";

export const INSTRUCTIONS = `Loupe reads Figma designs (read-only) for faithful implementation.

Workflow: get_design (structure + exact styles) → get_screenshot (look at it) → export_assets (icons/images) → build → compare_screenshot with your running page (url) or a screenshot of it, fix the listed regions, repeat.
Targets: a Figma URL, node ids ("12:34", comma-separated), or nothing = the user's current selection in Figma.

${FORMAT_LEGEND}`;

const fileParam = z.string().optional().describe("Which open Figma file (name or key) when several are connected. Default: the most recently active.");
const targetParam = z
  .string()
  .optional()
  .describe('Figma URL, node id(s) like "12:34" (comma-separated), or omit for the current selection in Figma.');

function text(t: string) {
  return { content: [{ type: "text" as const, text: t }] };
}

function visual(v: { text: string; images: Buffer[] }) {
  return {
    content: [
      { type: "text" as const, text: v.text },
      ...v.images.map((b) => ({ type: "image" as const, data: b.toString("base64"), mimeType: "image/png" })),
    ],
  };
}

function fail(e: unknown) {
  return { content: [{ type: "text" as const, text: `Error: ${e instanceof Error ? e.message : String(e)}` }], isError: true };
}

export function createServer(bridge: Bridge): McpServer {
  const server = new McpServer({ name: "loupe", version: SERVER_VERSION }, { instructions: INSTRUCTIONS });

  const loupe = new Loupe(bridge);

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
        return text(await loupe.status());
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
        return text(await loupe.outline({ page, depth, file }));
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
        return text(await loupe.find({ query, text: byText, types, page, within, limit, file }));
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
        return text(await loupe.design({ target, budget, components, depth, includeHidden: include_hidden, expandVectors: expand_vectors, file }));
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
        return visual(await loupe.screenshot({ target, scale, saveTo: save_to, file }));
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
        return text(await loupe.assets({ target, dir, as, scale, currentColor: current_color, file }));
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
        return text(await loupe.tokens({ format, filter, file }));
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
        return text(await loupe.css({ target, file }));
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
        "Pixel-diffs your implementation against the Figma render of the target. Pass url (+ selector) to have Loupe render your running page at the design's width, or image = a PNG screenshot. Returns the mismatch %, the differing regions mapped to Figma layers, and a design | implementation | diff image.",
      inputSchema: {
        target: targetParam,
        url: z.string().optional().describe("Page with your implementation, e.g. http://localhost:5173/sheet. Rendered in headless Chromium at the design's width, 2x."),
        selector: z.string().optional().describe("CSS selector of the element to capture on that page (default: the full page)."),
        wait_for: z.string().optional().describe("Selector to wait for before capturing (default: selector)."),
        image: z.string().optional().describe("Instead of url: path to a PNG screenshot of the implementation, cropped to the same element."),
        threshold: z.number().min(0).max(1).optional().describe("Per-pixel colour tolerance 0–1 (default 0.1)."),
        save_diff: z.string().optional().describe("Also write the comparison image to this path."),
        file: fileParam,
      },
      annotations: { readOnlyHint: true },
    },
    async ({ target, url, selector, wait_for, image, threshold, save_diff, file }) => {
      try {
        return visual(await loupe.compare({ target, url, selector, waitFor: wait_for, image, threshold, saveDiff: save_diff, file }));
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
