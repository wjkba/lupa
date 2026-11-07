import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DEFAULT_PORT } from "../src/shared/protocol";
import { normalizeId, parseTarget } from "../src/tools/target";

describe("targets", () => {
  it("parses design, file, proto and branch URLs", () => {
    expect(parseTarget("https://www.figma.com/design/AbC123/My-File?node-id=12-34&t=x")).toEqual({ ids: ["12:34"], fileKey: "AbC123" });
    expect(parseTarget("https://figma.com/file/KEY/Name?node-id=1%3A2")).toEqual({ ids: ["1:2"], fileKey: "KEY" });
    expect(parseTarget("https://www.figma.com/design/KEY/branch/BRANCH/Name?node-id=5-6")).toEqual({ ids: ["5:6"], fileKey: "BRANCH" });
    expect(parseTarget("https://www.figma.com/proto/KEY/Name?node-id=7-8&starting-point-node-id=7%3A8")).toEqual({ ids: ["7:8"], fileKey: "KEY" });
    expect(parseTarget("https://www.figma.com/design/KEY/Name")).toEqual({ ids: [], fileKey: "KEY" });
  });

  it("parses ids and lists", () => {
    expect(parseTarget("12:34, 56-78 #9:1")).toEqual({ ids: ["12:34", "56:78", "9:1"] });
    expect(normalizeId("I12:34;56:78")).toBe("I12:34;56:78");
    expect(parseTarget(undefined)).toEqual({ ids: [] });
  });

  it("rejects junk", () => {
    expect(() => parseTarget("hello")).toThrow(/not a Figma node id/);
    expect(() => parseTarget("https://example.com/design/x")).toThrow(/Not a Figma URL/);
  });
});

describe("plugin wiring", () => {
  it("uses the same port in the server, the plugin UI and the manifest", () => {
    const ui = readFileSync(new URL("../plugin/src/ui.html", import.meta.url), "utf8");
    const manifest = JSON.parse(readFileSync(new URL("../plugin/manifest.json", import.meta.url), "utf8"));
    expect(ui).toContain(`var PORT = ${DEFAULT_PORT};`);
    expect(manifest.networkAccess.allowedDomains).toContain(`ws://localhost:${DEFAULT_PORT}`);
    expect(manifest.documentAccess).toBe("dynamic-page");
  });
});
