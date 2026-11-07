import { describe, expect, it } from "vitest";
import { snapshot } from "../plugin/src/extract";
import { renderSnapshot } from "../src/model/render";
import { FakeFile, solid } from "./fake-figma";
import { productCard } from "./scenes";

async function render(mode: "auto" | "inline" | "names" = "auto", budget = 10000) {
  const { f, card } = productCard();
  const snap = await snapshot(f.api, [card], { ids: [card.id] }, { fileName: "Shop", pageName: "Home" });
  return { snap, out: renderSnapshot(snap, { components: mode, budget }) };
}

function line(text: string, start: string): string {
  const l = text.split("\n").find((x) => x.trimStart().startsWith(start));
  if (!l) throw new Error(`no line starting with ${start}\n${text}`);
  return l.trim();
}

describe("product card", () => {
  it("is much smaller than the raw snapshot", async () => {
    const { snap, out } = await render();
    expect(out.text.length).toBeLessThan(JSON.stringify(snap).length / 5);
    expect(out.stats.cut).toBe(false);
  });

  it("describes the root frame with tokens and CSS values", async () => {
    const { out } = await render();
    expect(line(out.text, 'frame "Product card"')).toBe(
      'frame "Product card" #13:1 360×640 h:hug; col; gap:16; p:24,24,24,$space/4; bg:$color/bg/surface; radius:16; shadow:$Elevation/2; clip',
    );
    expect(out.text).toContain("$color/bg/surface = #ffffff  var(--bg-surface)");
    expect(out.text).toContain("$space/4 = 24  var(--space-4)");
    expect(out.text).toContain("$Heading/H3 = Inter 600 20/28 ls:-0.005em  — Card titles");
    expect(out.text).toContain("$Elevation/2 = 0px 4px 16px 0 #00000014");
  });

  it("prints images, text and styled runs", async () => {
    const { out } = await render();
    expect(line(out.text, 'img "Hero"')).toBe('img "Hero" #14:1 312×180 w:fill; src:abc123def4 cover; radius:12');
    expect(line(out.text, 'text "Title"')).toContain('font:$Heading/H3; color:$color/text/primary; "Wireless headphones"');
    expect(line(out.text, '~ "Terms"')).toMatch(/^~ "Terms" font:T\d; color:#4f46e5; href:https:\/\/example.com\/terms$/);
  });

  it("folds repeated siblings and keeps their content", async () => {
    const { out } = await render();
    expect(out.text).toContain("+4 more like ↑: #35:1 #36:1 #37:1 #38:1");
    expect(out.text).toContain(`+3 more like ↑, content:\n      #22:1 "Weight" "250 g"\n      #25:1 "Bluetooth" "5.3"\n      #28:1 "Colour" "Black"`);
  });

  it("defines repeated components once and lists instance props", async () => {
    const { out } = await render();
    const defs = out.text.slice(out.text.indexOf("## components"), out.text.indexOf("## design"));
    expect(defs).toContain("Button{Variant=Primary} #7:1 120×40 hug; row; gap:8; justify:center; align:center; p:10,16; bg:$color/brand/500; radius:8");
    expect(defs).toContain('// props: Variant: Primary*|Secondary; Label: text="Button"; Has icon: bool=false');
    expect(defs).toContain('svg "Icon/Arrow right" #9:1 16×16 color:#ffffff; hidden');
    expect(line(out.text, "instance Button{Variant=Primary} #39:1")).toBe(
      'instance Button{Variant=Primary} #39:1 150×40 Label="Add to cart"; Has icon=true; w:fill; h:hug',
    );
    // Used once: printed in full rather than as a definition.
    expect(line(out.text, "instance Button{Variant=Secondary}")).toContain("border:1 #d0d5dd");
    expect(out.text).toContain('text "Label" #I40:1;11:1 56×20 hug; font:T4; color:#b42318; "Save"');
  });

  it("absolute children keep position and constraints; gradients are exact", async () => {
    const { out } = await render();
    expect(line(out.text, 'frame "Sale badge"')).toContain("abs; at:280,12; pin:right; row; p:4,8; bg:linear-gradient(90deg, #ff4d4d 0%, #e61a80 100%); radius:full");
  });

  it("names mode collapses instances to one line", async () => {
    const { out } = await render("names");
    expect(out.text).not.toContain("## components");
    expect(line(out.text, "instance Button{Variant=Primary} #39:1")).toContain("bg:$color/brand/500");
  });

  it("budget cuts breadth-first with expand hints", async () => {
    const { out } = await render("auto", 400);
    expect(out.stats.cut).toBe(true);
    expect(out.text).toContain('frame "Specs"');
    expect(out.text).toMatch(/… \+\d+ layers? not shown → get_design #\d+:\d+/);
  });
});

describe("instance overrides", () => {
  it("reports text, colour, visibility and swap overrides by layer path", async () => {
    const f = new FakeFile();
    const page = f.node({ type: "PAGE", name: "P" } as any);
    const dot = f.component({ name: "Dot", w: 8, h: 8, children: [{ type: "VECTOR", w: 8, h: 8, fills: [solid("#00ff00")] }] }, page);
    const cross = f.component({ name: "Cross", w: 8, h: 8, children: [{ type: "VECTOR", w: 8, h: 8, fills: [solid("#ff0000")] }] }, page);
    const row = f.component(
      {
        name: "Row",
        w: 200,
        h: 32,
        layoutMode: "HORIZONTAL",
        itemSpacing: 8,
        children: [
          { type: "TEXT", name: "Title", text: "Title", w: 100, h: 20, fills: [solid("#111111")] },
          { type: "TEXT", name: "Meta", text: "meta", w: 40, h: 20, fills: [solid("#666666")] },
        ],
      },
      page,
    );
    const status = f.instance(dot, row, { x: 180, y: 12 });
    status.name = "Status";
    const screen = f.node({ type: "FRAME", name: "List", w: 200, h: 120, layoutMode: "VERTICAL" });
    const [title, meta] = row.children;
    f.instance(row, screen, { y: 0 }, { [title.id]: { text: "Inbox" } });
    f.instance(row, screen, { y: 40 }, { [title.id]: { text: "Archive", fills: [solid("#999999")] }, [meta.id]: { visible: false } });
    const third = f.instance(row, screen, { y: 80 }, { [title.id]: { text: "Trash" } });
    // Swap the nested status icon in the third row.
    const nested = third.children.find((c: any) => c.name === "Status");
    nested.getMainComponentAsync = async () => cross;

    const snap = await snapshot(f.api, [screen], { ids: [screen.id] }, { fileName: "F", pageName: "P" });
    const out = renderSnapshot(snap).text;
    expect(out).toContain("## components");
    expect(out).toContain('~ Title: "Inbox"');
    expect(out).toMatch(/~ Title: "Archive"; color:#999999/);
    expect(out).toContain("~ Meta: hidden");
    expect(out).toContain("~ Status: swap→Cross");
  });

  it("states instance sizing against the component, and names unnamed layers by id", async () => {
    const f = new FakeFile();
    const set = f.componentSet("Tab", { State: { type: "VARIANT", defaultValue: "Default", variantOptions: ["Default"] } });
    const tab = f.component(
      {
        name: "State=Default",
        w: 60,
        h: 33,
        layoutMode: "HORIZONTAL",
        layoutSizingHorizontal: "HUG",
        // Fills its variant set's auto layout: meaningless where instances go.
        layoutSizingVertical: "FILL",
        children: [
          {
            type: "FRAME",
            name: "Frame 517",
            w: 40,
            h: 17,
            layoutMode: "HORIZONTAL",
            children: [{ type: "TEXT", name: "Count", text: "00", w: 20, h: 17, fills: [solid("#111111")] }],
          },
        ],
      },
      set,
      { State: "Default" },
    );
    const count = tab.children[0].children[0];
    const bar = f.node({ type: "FRAME", name: "Tabs", w: 300, h: 33, layoutMode: "HORIZONTAL" });
    const props = { State: { type: "VARIANT", value: "Default" } };
    f.instance(tab, bar, { w: 90, layoutSizingHorizontal: "FIXED" }, { [count.id]: { text: "7" } }, props);
    f.instance(tab, bar, { x: 100, layoutSizingHorizontal: "HUG" }, {}, props);

    const snap = await snapshot(f.api, [bar], { ids: [bar.id] }, { fileName: "F", pageName: "P" });
    const out = renderSnapshot(snap).text;
    expect(line(out, `Tab{State=Default} #${tab.id}`)).toBe(`Tab{State=Default} #${tab.id} 60×33 w:hug; row`);
    expect(out).toMatch(/instance Tab\{State=Default\} #\S+ 90×33 w:fixed; h:fill\n/);
    expect(out).toMatch(/instance Tab\{State=Default\} #\S+ 60×33 w:hug; h:fill$/m);
    expect(out).toContain(`~ #${tab.children[0].id}/Count: "7"`);
  });
});
