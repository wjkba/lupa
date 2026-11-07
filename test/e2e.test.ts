import { mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { WebSocket } from "ws";
import { Bridge } from "../src/bridge/hub";
import { createServer } from "../src/server";
import { connectFakePlugin, solidPng } from "./fake-plugin";
import { productCard } from "./scenes";

const PORT = 43000 + Math.floor(Math.random() * 2000);
let bridge: Bridge;
let client: Client;
let plugin: WebSocket;
let scene: ReturnType<typeof productCard>;
let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "loupe-"));
  bridge = new Bridge({ port: PORT });
  await bridge.start();
  scene = productCard();
  // "Design" render: white card with a dark title bar where the Title text is.
  plugin = await connectFakePlugin({
    port: PORT,
    file: scene.f,
    fileName: "Shop",
    selection: [scene.card.id],
    paint: (x, y) => (y >= 220 && y < 248 && x >= 24 && x < 336 ? [16, 24, 40] : [255, 255, 255]),
  });
  const server = createServer(bridge);
  const [a, b] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: "test", version: "0" });
  await Promise.all([server.connect(a), client.connect(b)]);
});

afterAll(async () => {
  await client.close();
  plugin.close();
  await bridge.close();
});

function textOf(res: any): string {
  return res.content.filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n");
}

describe("MCP end to end", () => {
  it("exposes read-only tools with the format legend in the instructions", async () => {
    const tools = await client.listTools();
    expect(tools.tools.map((t) => t.name).sort()).toEqual(
      ["compare_screenshot", "export_assets", "find_nodes", "get_css", "get_design", "get_outline", "get_screenshot", "get_tokens", "status"].sort(),
    );
    expect(tools.tools.every((t) => t.annotations?.readOnlyHint)).toBe(true);
    expect(client.getInstructions()).toContain("get_design format");
  });

  it("status shows the connected file and selection", async () => {
    const out = textOf(await client.callTool({ name: "status", arguments: {} }));
    expect(out).toContain('"Shop"');
    expect(out).toContain(`selected: frame "Product card" #${scene.card.id}`);
  });

  it("get_design reads the current selection", async () => {
    const res = await client.callTool({ name: "get_design", arguments: {} });
    const out = textOf(res);
    expect(res.isError).toBeFalsy();
    expect(out).toContain('frame "Product card"');
    expect(out).toContain("## tokens");
  });

  it("get_design accepts a Figma URL", async () => {
    const url = `https://www.figma.com/design/ABC/Shop?node-id=${scene.card.id.replace(":", "-")}`;
    const out = textOf(await client.callTool({ name: "get_design", arguments: { target: url, components: "names" } }));
    expect(out).toContain('frame "Product card"');
    expect(out).not.toContain("## components");
  });

  it("get_screenshot returns images with the scale", async () => {
    const res: any = await client.callTool({ name: "get_screenshot", arguments: {} });
    expect(textOf(res)).toMatch(/1 design px = 2 image px/);
    expect(res.content.some((c: any) => c.type === "image" && c.mimeType === "image/png")).toBe(true);
  });

  it("export_assets writes deduplicated icons and images", async () => {
    const out = textOf(await client.callTool({ name: "export_assets", arguments: { dir } }));
    expect(out).toContain("icon-star.svg");
    expect(out).toContain("(used 5×)");
    expect(out).toMatch(/hero\.png ← src:abc123def4/);
    const files = await readdir(dir);
    expect(files).toEqual(expect.arrayContaining(["icon-star.svg", "icon-arrow-right.svg", "hero.png"]));
    expect(await readFile(path.join(dir, "icon-star.svg"), "utf8")).toContain("<svg");
  });

  it("compare_screenshot finds the differing region and names the layer", async () => {
    // Implementation forgot the title colour: all white.
    const impl = path.join(dir, "impl.png");
    await writeFile(impl, solidPng(360, 640, () => [255, 255, 255]));
    const res: any = await client.callTool({ name: "compare_screenshot", arguments: { image: impl } });
    const out = textOf(res);
    expect(out).toMatch(/mismatch: \d/);
    expect(out).toMatch(/region 24,216 .*text "Title"/);
    expect(res.content.some((c: any) => c.type === "image")).toBe(true);

    const same = path.join(dir, "same.png");
    await writeFile(same, solidPng(360, 640, (x, y) => (y >= 220 && y < 248 && x >= 24 && x < 336 ? [16, 24, 40] : [255, 255, 255])));
    expect(textOf(await client.callTool({ name: "compare_screenshot", arguments: { image: same } }))).toContain("mismatch: 0% ");
  });

  it("reports a helpful error for unknown ids", async () => {
    const res: any = await client.callTool({ name: "get_design", arguments: { target: "999:999" } });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain("999:999");
  });
});
