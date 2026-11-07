/** Realistic fake documents shared by the tests. */

import { FakeFile, solid } from "./fake-figma";

export function productCard() {
  const f = new FakeFile();
  const surface = f.variable("color/bg/surface", "Theme", "var(--bg-surface)");
  const textPrimary = f.variable("color/text/primary", "Theme", "var(--text-primary)");
  const brand = f.variable("color/brand/500", "Theme", "var(--brand-500)");
  const space4 = f.variable("space/4", "Spacing", "var(--space-4)", "FLOAT");
  const h3 = f.style("Heading/H3", "TEXT", "Card titles");
  const elev = f.style("Elevation/2", "EFFECT");
  const shadow = { type: "DROP_SHADOW", visible: true, color: { r: 0, g: 0, b: 0, a: 0.08 }, offset: { x: 0, y: 4 }, radius: 16, spread: 0, blendMode: "NORMAL" };

  // Components -------------------------------------------------------
  const page = f.node({ type: "PAGE", name: "Components" } as any);
  const star = f.component(
    {
      name: "Icon/Star",
      w: 16,
      h: 16,
      children: [{ type: "VECTOR", name: "Vector", w: 14, h: 13, x: 1, y: 1, fills: [solid("#f5a524")] }],
    },
    page,
  );
  const arrow = f.component(
    {
      name: "Icon/Arrow right",
      w: 16,
      h: 16,
      children: [{ type: "VECTOR", name: "Vector", w: 12, h: 10, x: 2, y: 3, strokes: [solid("#ffffff")], strokeWeight: 1.5 }],
    },
    page,
  );
  const set = f.componentSet("Button", {
    "Variant": { type: "VARIANT", defaultValue: "Primary", variantOptions: ["Primary", "Secondary"] },
    "Label#1:0": { type: "TEXT", defaultValue: "Button" },
    "Has icon#2:0": { type: "BOOLEAN", defaultValue: false },
  });
  const makeButton = (variant: string, bg: string, fg: string) => {
    const btn = f.component(
      {
        name: `Variant=${variant}`,
        w: 120,
        h: 40,
        layoutMode: "HORIZONTAL",
        itemSpacing: 8,
        paddingTop: 10,
        paddingBottom: 10,
        paddingLeft: 16,
        paddingRight: 16,
        primaryAxisAlignItems: "CENTER",
        counterAxisAlignItems: "CENTER",
        layoutSizingHorizontal: "HUG",
        layoutSizingVertical: "HUG",
        cornerRadius: 8,
        fills: [solid(bg, variant === "Primary" ? { boundVariables: { color: { type: "VARIABLE_ALIAS", id: brand } } } : {})],
        strokes: variant === "Secondary" ? [solid("#d0d5dd")] : [],
        strokeWeight: 1,
        strokeAlign: "INSIDE",
        children: [
          {
            type: "TEXT",
            name: "Label",
            text: "Button",
            w: 56,
            h: 20,
            x: 16,
            y: 10,
            fills: [solid(fg)],
            font: { fontName: { family: "Inter", style: "Semi Bold" }, fontWeight: 600, fontSize: 14, lineHeight: { unit: "PIXELS", value: 20 } },
            componentPropertyReferences: { characters: "Label#1:0" },
          },
        ],
      },
      set,
      { Variant: variant },
    );
    const icon = f.instance(arrow, btn, { x: 88, y: 12, visible: false, componentPropertyReferences: { visible: "Has icon#2:0" } });
    icon.componentPropertyReferences = { visible: "Has icon#2:0" };
    return btn;
  };
  const primary = makeButton("Primary", "#4f46e5", "#ffffff");
  const secondary = makeButton("Secondary", "#ffffff", "#344054");

  // Screen -------------------------------------------------------------
  const card = f.node({
    type: "FRAME",
    name: "Product card",
    w: 360,
    h: 640,
    x: 100,
    y: 200,
    layoutMode: "VERTICAL",
    itemSpacing: 16,
    paddingTop: 24,
    paddingBottom: 24,
    paddingLeft: 24,
    paddingRight: 24,
    layoutSizingHorizontal: "FIXED",
    layoutSizingVertical: "HUG",
    fills: [solid("#ffffff", { boundVariables: { color: { type: "VARIABLE_ALIAS", id: surface } } })],
    boundVariables: { paddingLeft: { type: "VARIABLE_ALIAS", id: space4 } },
    cornerRadius: 16,
    effects: [shadow],
    effectStyleId: elev,
    clipsContent: true,
    children: [
      {
        type: "RECTANGLE",
        name: "Hero",
        w: 312,
        h: 180,
        x: 24,
        y: 24,
        layoutSizingHorizontal: "FILL",
        layoutSizingVertical: "FIXED",
        cornerRadius: 12,
        fills: [{ type: "IMAGE", visible: true, opacity: 1, imageHash: "abc123def4567890aa", scaleMode: "FILL", blendMode: "NORMAL" }],
      },
      {
        type: "TEXT",
        name: "Title",
        text: "Wireless headphones",
        w: 312,
        h: 28,
        x: 24,
        y: 220,
        layoutSizingHorizontal: "FILL",
        layoutSizingVertical: "HUG",
        textAutoResize: "HEIGHT",
        fills: [solid("#101828", { boundVariables: { color: { type: "VARIABLE_ALIAS", id: textPrimary } } })],
        font: {
          fontName: { family: "Inter", style: "Semi Bold" },
          fontWeight: 600,
          fontSize: 20,
          lineHeight: { unit: "PIXELS", value: 28 },
          letterSpacing: { unit: "PERCENT", value: -0.5 },
          textStyleId: h3,
        },
      },
      {
        type: "TEXT",
        name: "Legal",
        text: "By buying you agree to our Terms.",
        w: 312,
        h: 20,
        x: 24,
        y: 260,
        layoutSizingHorizontal: "FILL",
        textAutoResize: "HEIGHT",
        fills: [solid("#667085")],
        segments: [
          { characters: "By buying you agree to our " },
          { characters: "Terms", textDecoration: "UNDERLINE", fills: [solid("#4f46e5")], hyperlink: { type: "URL", value: "https://example.com/terms" } },
          { characters: "." },
        ],
      },
      {
        type: "FRAME",
        name: "Rating",
        w: 96,
        h: 16,
        x: 24,
        y: 290,
        layoutMode: "HORIZONTAL",
        itemSpacing: 4,
        layoutSizingHorizontal: "HUG",
        layoutSizingVertical: "HUG",
      },
      {
        type: "FRAME",
        name: "Specs",
        w: 312,
        h: 120,
        x: 24,
        y: 320,
        layoutMode: "VERTICAL",
        itemSpacing: 8,
        layoutSizingHorizontal: "FILL",
        layoutSizingVertical: "HUG",
        children: ["Battery|30 h", "Weight|250 g", "Bluetooth|5.3", "Colour|Black"].map((pair, i) => {
          const [k, v] = pair.split("|");
          return {
            type: "FRAME",
            name: "Row",
            w: 312,
            h: 20,
            y: i * 28,
            layoutMode: "HORIZONTAL",
            primaryAxisAlignItems: "SPACE_BETWEEN",
            layoutSizingHorizontal: "FILL",
            layoutSizingVertical: "HUG",
            children: [
              { type: "TEXT", name: k, text: k, w: 60, h: 20, fills: [solid("#667085")] },
              { type: "TEXT", name: v, text: v, w: 40, h: 20, x: 272, fills: [solid("#101828")], font: { fontName: { family: "Inter", style: "Medium" }, fontWeight: 500 } },
            ],
          };
        }),
      },
      {
        type: "FRAME",
        name: "Actions",
        w: 312,
        h: 40,
        x: 24,
        y: 460,
        layoutMode: "HORIZONTAL",
        itemSpacing: 12,
        layoutSizingHorizontal: "FILL",
        layoutSizingVertical: "HUG",
      },
      {
        type: "FRAME",
        name: "Sale badge",
        w: 56,
        h: 24,
        x: 280,
        y: 12,
        layoutPositioning: "ABSOLUTE",
        constraints: { horizontal: "MAX", vertical: "MIN" },
        layoutMode: "HORIZONTAL",
        paddingLeft: 8,
        paddingRight: 8,
        paddingTop: 4,
        paddingBottom: 4,
        cornerRadius: 999,
        fills: [
          {
            type: "GRADIENT_LINEAR",
            visible: true,
            opacity: 1,
            blendMode: "NORMAL",
            gradientTransform: [
              [1, 0, 0],
              [0, 1, 0],
            ],
            gradientStops: [
              { position: 0, color: { r: 1, g: 0.3, b: 0.3, a: 1 } },
              { position: 1, color: { r: 0.9, g: 0.1, b: 0.5, a: 1 } },
            ],
          },
        ],
        effects: [shadow],
        children: [{ type: "TEXT", name: "-20%", text: "-20%", w: 40, h: 16, x: 8, y: 4, fills: [solid("#ffffff")], font: { fontSize: 12, lineHeight: { unit: "PIXELS", value: 16 }, fontWeight: 700, fontName: { family: "Inter", style: "Bold" } } }],
      },
    ],
  });
  const rating = card.children[3];
  for (let i = 0; i < 5; i++) f.instance(star, rating, { x: i * 20, y: 0 });
  const actions = card.children[5];
  f.instance(primary, actions, { x: 0, y: 0, w: 150, layoutSizingHorizontal: "FILL" }, { "1:0": {} }, {
    "Variant": { type: "VARIANT", value: "Primary" },
    "Label#1:0": { type: "TEXT", value: "Add to cart" },
    "Has icon#2:0": { type: "BOOLEAN", value: true },
  });
  // Text override not driven by the property (designer typed into the layer).
  const labelId = primary.children[0].id;
  const iconId = primary.children[1].id;
  f.instance(secondary, actions, { x: 162, y: 0 }, { [secondary.children[0].id]: { text: "Save", fills: [solid("#b42318")] } }, {
    "Variant": { type: "VARIANT", value: "Secondary" },
    "Label#1:0": { type: "TEXT", value: "Save" },
    "Has icon#2:0": { type: "BOOLEAN", value: false },
  });
  // Third instance (so Button/Primary is used twice and gets a definition).
  const footer = f.node({ type: "FRAME", name: "Footer", w: 312, h: 40, x: 24, y: 520, layoutMode: "HORIZONTAL", layoutSizingHorizontal: "FILL", layoutSizingVertical: "HUG" }, card);
  card.children.push(footer);
  f.instance(primary, footer, { x: 0, y: 0 }, { [iconId]: { visible: true } }, {
    "Variant": { type: "VARIANT", value: "Primary" },
    "Label#1:0": { type: "TEXT", value: "Buy now" },
    "Has icon#2:0": { type: "BOOLEAN", value: true },
  });
  void labelId;
  return { f, card, primary, secondary, star };
}
