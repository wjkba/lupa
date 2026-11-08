import { existsSync } from "node:fs";
import { mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { WebSocket } from "ws";
import { Bridge, HIDDEN_ERROR } from "../src/bridge/hub";
import { runCli } from "../src/cli";
import { FORMAT_LEGEND } from "../src/shared/legend";
import { cachedChromiums, renderUrl } from "../src/tools/browser";
import { FakeFile, solid } from "./fake-figma";
import { connectFakePlugin, solidPng } from "./fake-plugin";
import { productCard } from "./scenes";

const band = (x: number, y: number): [number, number, number] => (y >= 220 && y < 248 && x >= 24 && x < 336 ? [16, 24, 40] : [255, 255, 255]);
/** The same drawing as `band`, as Figma's SVG export would give it. */
const bandSvg = (w: number, h: number) => `<rect width="${w}" height="${h}" fill="#fff"/><rect x="24" y="220" width="312" height="28" fill="rgb(16,24,40)"/>`;
const hasChromium = Boolean(process.env.LOUPE_BROWSER || cachedChromiums().length);

async function cli(args: string[], bridge?: Bridge) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runCli(args, { out: (t) => out.push(t), err: (t) => err.push(t), bridge });
  return { code, out: out.join("\n"), err: err.join("\n") };
}

describe("cli without Figma", () => {
  it("prints usage and the format legend", async () => {
    expect((await cli(["help"])).out).toContain("loupe <command> [target] [options]");
    expect((await cli(["format"])).out).toBe(FORMAT_LEGEND);
  });

  it("rejects unknown commands and options with exit code 2", async () => {
    const a = await cli(["paint"]);
    expect(a.code).toBe(2);
    expect(a.err).toContain('Unknown command "paint"');
    const b = await cli(["design", "--colour", "red"]);
    expect(b.code).toBe(2);
    expect(b.err).toMatch(/Unknown option '--colour'/);
  });

  it("keeps the skill's legend in sync with the server's", async () => {
    const skill = await readFile(path.join(__dirname, "../skills/figma-implement/SKILL.md"), "utf8");
    const block = skill.slice(skill.indexOf("## Output format"));
    expect(block).toBe(`## Output format\n\n\`\`\`\n${FORMAT_LEGEND}\n\`\`\`\n`);
  });
});

describe("cli with Figma", () => {
  const port = 45000 + Math.floor(Math.random() * 2000);
  let bridge: Bridge;
  let plugin: WebSocket;
  let scene: ReturnType<typeof productCard>;
  let dir: string;

  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "loupe-cli-"));
    bridge = new Bridge({ port });
    await bridge.start();
    scene = productCard();
    plugin = await connectFakePlugin({ port, file: scene.f, fileName: "Shop", selection: [scene.card.id], paint: band });
  });

  afterAll(async () => {
    plugin.close();
    await bridge.close();
  });

  it("design reads the selection", async () => {
    const r = await cli(["design", "--components", "names"], bridge);
    expect(r.code).toBe(0);
    expect(r.out).toContain('frame "Product card" #13:1');
    expect(r.out).not.toContain("## components");
  });

  it("design validates option values", async () => {
    const r = await cli(["design", "--budget", "lots"], bridge);
    expect(r.code).toBe(2);
    expect(r.err).toContain("--budget must be a number");
  });

  it("screenshot writes the image and prints its path", async () => {
    const out = path.join(dir, "shot.png");
    const r = await cli(["screenshot", "-o", out], bridge);
    expect(r.code).toBe(0);
    expect(r.out).toContain(`image: ${out}`);
    expect(existsSync(out)).toBe(true);
  });

  it("assets writes files into the folder", async () => {
    const r = await cli(["assets", "13:1", "-d", path.join(dir, "assets")], bridge);
    expect(r.code).toBe(0);
    expect(existsSync(path.join(dir, "assets", "icon-star.svg"))).toBe(true);
  });

  it("design -d writes the assets and names them on their layers", async () => {
    const out = path.join(dir, "design-assets");
    const r = await cli(["design", "13:1", "-d", out], bridge);
    expect(r.code).toBe(0);
    expect((await readdir(out)).sort()).toEqual(["hero.png", "icon-arrow-right.svg", "icon-star.svg"]);
    expect(r.out).toContain(`img "Hero" #14:1 312×180 w:fill; src:${out}/hero.png cover;`);
    expect(r.out).toContain(`svg "Icon/Star" #34:1 16×16 src:${out}/icon-star.svg;`);
    // Hidden by default, but the definition still names its file.
    expect(r.out).toContain(`svg "Icon/Arrow right" #9:1 16×16 src:${out}/icon-arrow-right.svg;`);
  });

  it("compare needs exactly one of --url and --image", async () => {
    expect((await cli(["compare"], bridge)).code).toBe(2);
    expect((await cli(["compare", "--url", "http://x", "--image", "y.png"], bridge)).code).toBe(2);
  });

  it("compare --image reports the mismatch and writes the diff image", async () => {
    const impl = path.join(dir, "impl.png");
    await writeFile(impl, solidPng(360, 640, () => [255, 255, 255]));
    const out = path.join(dir, "diff.png");
    const r = await cli(["compare", "--image", impl, "-o", out], bridge);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/region 24,216 .*text "Title"/);
    expect(r.out).toMatch(/ \d+ px inside text layers .*; 0 px elsewhere — layout and non-text layers match/);
    expect(r.out).toContain(`image: ${out}`);
  });

  it("compare lists non-text regions first and counts them outside text", async () => {
    // Title matches, but a dark square sits on the Hero image area.
    const impl = path.join(dir, "impl-box.png");
    await writeFile(impl, solidPng(360, 640, (x, y) => (x >= 60 && x < 100 && y >= 60 && y < 100 ? [0, 0, 0] : band(x, y))));
    const r = await cli(["compare", "--image", impl], bridge);
    expect(r.out).toMatch(/0 px inside text layers .*; [1-9]\d* px elsewhere\n/);
    expect(r.out.split("\n").find((l) => l.startsWith("  region"))).toMatch(/rectangle "Hero"/);
  });

  it.skipIf(!hasChromium)("renderUrl reports design fonts the page can't use", async () => {
    const page = path.join(dir, "fonts.html");
    await writeFile(page, `<!doctype html><body style="margin:0"><p id="t" style="font-family:sans-serif">Hello</p></body>`);
    const r = await renderUrl({ url: pathToFileURL(page).href, width: 200, selector: "#t", fonts: ["Loupe No Such Font"] });
    expect(r.png.subarray(1, 4).toString()).toBe("PNG");
    expect(r.missingFonts).toEqual(["Loupe No Such Font"]);
  }, 60_000);

  it.skipIf(!hasChromium)("compare --url renders the page at the design's width", async () => {
    const page = path.join(dir, "page.html");
    await writeFile(
      page,
      `<!doctype html><body style="margin:0"><div id="card" style="position:relative;width:360px;height:640px;background:#fff">
        <div style="position:absolute;left:24px;top:220px;width:312px;height:28px;background:rgb(16,24,40)"></div></div></body>`,
    );
    const r = await cli(["compare", "--url", pathToFileURL(page).href, "--selector", "#card", "-o", path.join(dir, "url-diff.png")], bridge);
    expect(r.err).toBe("");
    expect(r.out).toContain("implementation 720×1280px");
    expect(r.out).toContain("visually matching");
  }, 60_000);
});

describe("assets", () => {
  it("writes identical drawings once and names unnamed graphics after their parent", async () => {
    const port = 47000 + Math.floor(Math.random() * 2000);
    const hub = new Bridge({ port });
    await hub.start();
    const f = new FakeFile();
    const label = (text: string) => ({ type: "TEXT", name: text, text, w: 80, h: 16, x: 24, fills: [solid("#000000")] });
    const icon = (name: string) => ({ type: "FRAME", name, w: 16, h: 16, children: [{ type: "VECTOR", w: 12, h: 12, x: 2, y: 2, fills: [solid("#aeb0af")] }] });
    const screen = f.node({
      type: "FRAME",
      name: "Screen",
      w: 300,
      h: 100,
      children: [
        { type: "FRAME", name: "Contact Info", w: 120, h: 16, children: [icon("Frame"), label("Phone")] },
        { type: "FRAME", name: "Row", w: 120, h: 16, y: 40, children: [icon("Frame 810"), label("Emma")] },
        { type: "FRAME", name: "Row", w: 120, h: 16, y: 70, children: [icon("Frame 811"), label("Marcus")] },
      ],
    });
    const ws = await connectFakePlugin({ port, file: f, fileName: "Icons", selection: [screen.id] });
    try {
      await hub.waitForPlugin(2000);
      const dir = await mkdtemp(path.join(tmpdir(), "loupe-assets-"));
      const r = await cli(["assets", "-d", dir], hub);
      expect(r.out).toMatch(/^Wrote 1 file\(s\)/);
      expect(r.out).toMatch(/contact-info\.svg ← svg "Frame" #\S+ 16×16 \(used 3×; also for #\S+ #\S+\)/);
      expect(await readdir(dir)).toEqual(["contact-info.svg"]);
    } finally {
      ws.close();
      await hub.close();
    }
  });

  it("writes instances of one component separately when they draw different things", async () => {
    const port = 47000 + Math.floor(Math.random() * 2000);
    const hub = new Bridge({ port });
    await hub.start();
    const f = new FakeFile();
    const button = f.component({ name: "Icon button", w: 32, h: 32, children: [{ type: "VECTOR", name: "Glyph", w: 20, h: 20, x: 6, y: 6, fills: [solid("#000000")] }] });
    const screen = f.node({ type: "FRAME", name: "Toolbar", w: 200, h: 32, children: [{ type: "TEXT", name: "Title", text: "Edit", w: 60, h: 16, x: 120, fills: [solid("#000000")] }] });
    f.instance(button, screen, { x: 0 });
    f.instance(button, screen, { x: 40 });
    // Same component, another drawing inside (like a swapped nested icon).
    const odd = f.instance(button, screen, { x: 80 }, { [button.children[0].id]: { fills: [solid("#b42318")] } });
    const ws = await connectFakePlugin({ port, file: f, fileName: "Icons", selection: [screen.id] });
    try {
      await hub.waitForPlugin(2000);
      const dir = await mkdtemp(path.join(tmpdir(), "loupe-assets-"));
      const r = await cli(["assets", "-d", dir], hub);
      expect(r.out).toMatch(/^Wrote 2 file\(s\)/);
      // Identical instances of one component: counted, not listed by id.
      expect(r.out).toMatch(/icon-button\.svg ← svg "Icon button" #\S+ 32×32 \(used 2×\)\n/);
      expect(r.out).toContain(`icon-button-2.svg ← svg "Icon button" #${odd.id} 32×32`);
      expect((await readdir(dir)).sort()).toEqual(["icon-button-2.svg", "icon-button.svg"]);
    } finally {
      ws.close();
      await hub.close();
    }
  });
});

describe("design with an assets folder", () => {
  it("writes the files and names each one on its layer, in the tree and the component definitions", async () => {
    const port = 47000 + Math.floor(Math.random() * 2000);
    const hub = new Bridge({ port });
    await hub.start();
    const f = new FakeFile();
    const button = f.component({
      name: "Icon button",
      w: 64,
      h: 32,
      children: [
        { type: "VECTOR", name: "Glyph", w: 20, h: 20, x: 6, y: 6, fills: [solid("#000000")] },
        { type: "TEXT", name: "Label", text: "Go", w: 24, h: 16, x: 32, y: 8, fills: [solid("#000000")] },
      ],
    });
    const screen = f.node({ type: "FRAME", name: "Toolbar", w: 240, h: 32, layoutMode: "HORIZONTAL", itemSpacing: 8, children: [] });
    f.instance(button, screen);
    f.instance(button, screen);
    // Same component, another drawing inside (like a swapped nested icon).
    const odd = f.instance(button, screen, {}, { [button.children[0].id]: { fills: [solid("#b42318")] } });
    const ws = await connectFakePlugin({ port, file: f, fileName: "Icons", selection: [screen.id] });
    try {
      await hub.waitForPlugin(2000);
      const dir = path.join(await mkdtemp(path.join(tmpdir(), "loupe-design-")), "icons");
      const r = await cli(["design", "-d", dir], hub);
      expect(r.code).toBe(0);
      expect((await readdir(dir)).sort()).toEqual(["glyph-2.svg", "glyph.svg"]);
      expect(r.out).toContain(`assets: 2 files in ${dir}/, named by src: on each layer`);
      expect(r.out).not.toContain("export_assets");
      const [defs, tree] = r.out.split("## design");
      // The definition names the shared file; only the instance that draws something else names its own.
      expect(defs).toMatch(/svg "Glyph" .*src:\S+\/glyph\.svg/);
      expect(tree).not.toContain("glyph.svg");
      expect(tree).toContain(`#${odd.id} 64×32\n    ~ Glyph: src:${dir}/glyph-2.svg; color:#b42318`);
    } finally {
      ws.close();
      await hub.close();
    }
  });
});

describe("hidden Figma window", () => {
  it("fails renders at once with a clear message, and recovers when shown", async () => {
    const port = 47000 + Math.floor(Math.random() * 2000);
    const hub = new Bridge({ port });
    await hub.start();
    const peer = new Bridge({ port, role: "peer" });
    await peer.start();
    const { f, card } = productCard();
    const ws = await connectFakePlugin({ port, file: f, fileName: "Shop", selection: [card.id], hidden: true });
    try {
      await peer.waitForPlugin(2000);
      expect((await cli(["status"], peer)).out).toContain("Figma is in the background");
      await expect(hub.request("export", { ids: [card.id], format: "PNG" })).rejects.toThrow(HIDDEN_ERROR);
      // Screenshots fall back to the SVG export, which needs Chromium.
      const r = await cli(["screenshot", "-o", path.join(tmpdir(), "loupe-hidden.png")], peer);
      if (hasChromium) {
        expect(r.code).toBe(0);
        expect(r.out).toContain("SVG export rendered in Chromium");
      } else {
        expect(r.code).toBe(1);
        expect(r.err).toContain("in the background");
      }
      // Snapshots don't render, so they still work.
      expect((await cli(["design", "--depth", "0"], peer)).code).toBe(0);

      ws.send(JSON.stringify({ t: "visibility", hidden: false }));
      for (let i = 0; i < 40 && peer.list()[0]?.hidden; i++) await new Promise((r) => setTimeout(r, 25));
      expect((await hub.request("export", { ids: [card.id], format: "PNG" })).blobs).toHaveLength(1);
    } finally {
      ws.close();
      await peer.close();
      await hub.close();
    }
  });
});

describe.skipIf(!hasChromium)("Figma not rendering", () => {
  const port = 49000 + Math.floor(Math.random() * 2000);
  let bridge: Bridge;
  let plugin: WebSocket;
  let dir: string;

  beforeAll(async () => {
    process.env.LOUPE_RASTER_WAIT_MS = "300";
    dir = await mkdtemp(path.join(tmpdir(), "loupe-stall-"));
    bridge = new Bridge({ port });
    await bridge.start();
    const { f, card } = productCard();
    plugin = await connectFakePlugin({ port, file: f, fileName: "Shop", selection: [card.id], stallRaster: true, svg: bandSvg });
  });

  afterAll(async () => {
    delete process.env.LOUPE_RASTER_WAIT_MS;
    plugin.close();
    await bridge.close();
  });

  it("screenshot renders Figma's SVG export instead and says so", async () => {
    const out = path.join(dir, "shot.png");
    const r = await cli(["screenshot", "-o", out], bridge);
    expect(r.code).toBe(0);
    expect(r.out).toContain("SVG export rendered in Chromium");
    expect((await readFile(out)).subarray(1, 4).toString()).toBe("PNG");
  }, 60_000);

  it("compare diffs against the SVG render", async () => {
    const page = path.join(dir, "page.html");
    await writeFile(
      page,
      `<!doctype html><body style="margin:0"><div id="card" style="position:relative;width:360px;height:640px;background:#fff">
        <div style="position:absolute;left:24px;top:220px;width:312px;height:28px;background:rgb(16,24,40)"></div></div></body>`,
    );
    const r = await cli(["compare", "--url", pathToFileURL(page).href, "--selector", "#card"], bridge);
    expect(r.err).toBe("");
    expect(r.out).toContain("SVG export rendered in Chromium");
    expect(r.out).toContain("design \"Product card\" #13:1 360×640 at 2x = 720×1280px");
    expect(r.out).toContain("visually matching");
  }, 60_000);
});

describe("bridge roles", () => {
  it("hub-only fails when the port is taken; peer-only fails without a hub", async () => {
    const port = 49000 + Math.floor(Math.random() * 1000);
    await expect(new Bridge({ port, role: "peer" }).start()).rejects.toThrow(/No Loupe hub/);
    const hub = new Bridge({ port, role: "hub" });
    await hub.start();
    try {
      await expect(new Bridge({ port, role: "hub" }).start()).rejects.toThrow(/in use/);
    } finally {
      await hub.close();
    }
  });
});
