import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { allowedOrigin, Bridge } from "../src/bridge/hub";
import { connectFakePlugin } from "./fake-plugin";
import { productCard } from "./scenes";

const open: { close(): unknown }[] = [];
afterEach(async () => {
  for (const x of open.splice(0)) await x.close();
});

function port(): number {
  return 41000 + Math.floor(Math.random() * 2000);
}

function bridge(p: number): Bridge {
  const b = new Bridge({ port: p });
  open.push(b);
  return b;
}

describe("origin policy", () => {
  it("lets Figma origins in as plugins, Node clients as peers, and nothing else", () => {
    expect(allowedOrigin("null")).toBe("plugin");
    expect(allowedOrigin("https://www.figma.com")).toBe("plugin");
    expect(allowedOrigin(undefined)).toBe("peer");
    expect(allowedOrigin("https://evil.example")).toBe(false);
    expect(allowedOrigin("https://figma.com.evil.example")).toBe(false);
    expect(allowedOrigin("http://www.figma.com")).toBe(false);
  });

  it("closes a browser page connection from another origin", async () => {
    const p = port();
    await bridge(p).start();
    const ws = new WebSocket(`ws://127.0.0.1:${p}`, { origin: "https://evil.example" });
    const code = await new Promise<number>((r) => ws.on("close", (c) => r(c)));
    expect(code).toBe(1008);
  });
});

describe("hub and peers", () => {
  it("first process is the hub, the second a peer; both reach the plugin", async () => {
    const p = port();
    const hub = bridge(p);
    const peer = bridge(p);
    await hub.start();
    await peer.start();
    expect(hub.mode).toBe("hub");
    expect(peer.mode).toBe("peer");

    const { f, card } = productCard();
    const plugin = await connectFakePlugin({ port: p, file: f, fileName: "Shop", selection: [card.id] });
    open.push({ close: () => plugin.close() });
    expect(await peer.waitForPlugin(2000)).toBe(true);
    expect(peer.list()[0]!.fileName).toBe("Shop");

    const viaHub = await hub.request("snapshot", { ids: [card.id], depth: 0 });
    const viaPeer = await peer.request("snapshot", { ids: [card.id], depth: 0 });
    expect(viaHub.roots[0]!.name).toBe("Product card");
    expect(viaPeer.roots[0]!.name).toBe("Product card");
  });

  it("a peer takes over when the hub exits, and the plugin can reconnect to it", async () => {
    const p = port();
    const hub = new Bridge({ port: p });
    const peer = bridge(p);
    await hub.start();
    await peer.start();
    await hub.close();
    // The peer notices the closed socket and re-elects itself.
    for (let i = 0; i < 50 && peer.mode !== "hub"; i++) await new Promise((r) => setTimeout(r, 50));
    expect(peer.mode).toBe("hub");
    const { f, card } = productCard();
    const plugin = await connectFakePlugin({ port: p, file: f, fileName: "Shop", selection: [card.id] });
    open.push({ close: () => plugin.close() });
    const snap = await peer.request("snapshot", { ids: [card.id], depth: 0 });
    expect(snap.roots[0]!.id).toBe(card.id);
  });

  it("routes by file name when several files are open", async () => {
    const p = port();
    const hub = bridge(p);
    await hub.start();
    const a = productCard();
    const b = productCard();
    const pa = await connectFakePlugin({ port: p, file: a.f, fileName: "App", fileKey: "KEY_A" });
    const pb = await connectFakePlugin({ port: p, file: b.f, fileName: "Marketing site", fileKey: "KEY_B" });
    open.push({ close: () => pa.close() }, { close: () => pb.close() });
    expect(hub.pick("marketing").fileName).toBe("Marketing site");
    expect(hub.pick("KEY_A").fileName).toBe("App");
    expect(() => hub.pick("nope")).toThrow(/No connected Figma file matches/);
  });

  it("explains how to connect when no plugin is running", async () => {
    const p = port();
    const hub = bridge(p);
    await hub.start();
    await expect(hub.request("ping", {})).rejects.toThrow(/Plugins → Development → Lupa/);
  });
});

describe("start()", () => {
  it("is idempotent: a hub never connects to itself as a peer", async () => {
    const p = port();
    const hub = bridge(p);
    await hub.start();
    await hub.start();
    await Promise.all([hub.start(), hub.start()]);
    expect(hub.mode).toBe("hub");
    const peer = bridge(p);
    await peer.start();
    await peer.start();
    expect(peer.mode).toBe("peer");
  });
});
