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

describe("inside borders", () => {
  it("print padding and positions that land the content where Figma draws it under CSS border-box", async () => {
    const f = new FakeFile();
    const label = { type: "TEXT", name: "Title", text: "Title", w: 100, h: 17, fills: [solid("#000000")] };
    const border = { strokes: [solid("#000000")], strokeWeight: 1 };
    const pads = { paddingTop: 18, paddingRight: 16, paddingBottom: 24, paddingLeft: 16 };
    const root = f.node({
      type: "FRAME",
      name: "Cards",
      w: 400,
      h: 400,
      children: [
        { type: "FRAME", name: "Card", w: 200, h: 59, layoutMode: "VERTICAL", ...pads, ...border, children: [{ ...label }] },
        { type: "FRAME", name: "Counted", y: 100, w: 200, h: 61, layoutMode: "VERTICAL", ...pads, ...border, strokesIncludedInLayout: true, children: [{ ...label }] },
        { type: "FRAME", name: "Free", y: 200, w: 200, h: 100, ...border, children: [{ ...label, x: 10, y: 10 }] },
      ],
    });
    const snap = await snapshot(f.api, [root], { ids: [root.id] }, { fileName: "Cards", pageName: "Home" });
    const { text } = renderSnapshot(snap, { components: "auto", budget: 10000 });
    expect(line(text, 'frame "Card"')).toContain("p:17,15,23");
    expect(line(text, 'frame "Counted"')).toContain("p:18,16,24");
    expect(text).toMatch(/frame "Free"[^\n]*\n\s+text[^\n]*at:9,9/);
  });
});

describe("fixed sizes", () => {
  it("say when auto-layout content runs past a fixed size, which CSS would grow to fit", async () => {
    const f = new FakeFile();
    const label = (h: number) => ({ type: "TEXT", name: "Label", text: "Label", w: 100, h, textAutoResize: "HEIGHT", fills: [solid("#000000")] });
    const root = f.node({
      type: "FRAME",
      name: "Sections",
      w: 400,
      h: 400,
      layoutMode: "VERTICAL",
      children: [
        { type: "FRAME", name: "Tight", w: 200, h: 38, layoutMode: "VERTICAL", itemSpacing: 4, primaryAxisAlignItems: "CENTER", children: [label(17), label(19)] },
        { type: "FRAME", name: "Roomy", w: 200, h: 48, layoutMode: "VERTICAL", itemSpacing: 4, children: [label(17), label(19)] },
        { type: "FRAME", name: "Short row", w: 200, h: 16, layoutMode: "HORIZONTAL", paddingTop: 2, children: [label(17)] },
      ],
    });
    const snap = await snapshot(f.api, [root], { ids: [root.id] }, { fileName: "Sections", pageName: "Home" });
    const { text } = renderSnapshot(snap, { components: "auto", budget: 10000 });
    expect(line(text, 'frame "Tight"')).toContain("h:fixed(content 40)");
    expect(line(text, 'frame "Roomy"')).not.toContain("fixed");
    expect(line(text, 'frame "Short row"')).toContain("h:fixed(content 19)");
    expect(line(text, 'frame "Sections"')).not.toContain("fixed");
  });
});

describe("line heights", () => {
  it("adds what Figma renders auto and rounded percent line heights at", async () => {
    const f = new FakeFile();
    const body = (text: string, h: number, auto: "HEIGHT" | "WIDTH_AND_HEIGHT", lineHeight: object) => ({
      type: "TEXT",
      text,
      w: 300,
      h,
      textAutoResize: auto,
      fills: [solid("#000000")],
      font: { fontSize: 14, lineHeight },
    });
    const root = f.node({
      type: "FRAME",
      name: "Notes",
      w: 320,
      h: 200,
      children: [
        body("One line", 17, "WIDTH_AND_HEIGHT", { unit: "AUTO" }),
        // 14px × 135% = 18.9, but Figma rounds each line: four lines are 76 tall, not 75.6.
        { ...body("A paragraph that wraps onto four lines", 76, "HEIGHT", { unit: "PERCENT", value: 135 }), font: { fontSize: 14, fontWeight: 500, fontName: { family: "Inter", style: "Medium" }, lineHeight: { unit: "PERCENT", value: 135 } } },
        // 16px × 150% = 24 exactly: nothing to add.
        { ...body("Exact", 24, "WIDTH_AND_HEIGHT", { unit: "PERCENT", value: 150 }), font: { fontSize: 16, lineHeight: { unit: "PERCENT", value: 150 } } },
      ],
    });
    const snap = await snapshot(f.api, [root], { ids: [root.id] }, { fileName: "Notes", pageName: "Home" });
    const { text } = renderSnapshot(snap, { components: "auto", budget: 10000 });
    expect(text).toMatch(/Inter 400 14\/normal≈17\n/);
    expect(text).toMatch(/Inter 500 14\/135%≈19\n/);
    expect(text).toMatch(/Inter 400 16\/150%\n/);
  });
});
