import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { colorRefs, componentRefs, fontRefs, iconFile, parseColor, scanProject, shapeOf, textRefs } from "../src/tools/project";
import { toCurrentColor } from "../src/tools/media";

async function project(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "lupa-project-"));
  for (const [f, text] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, f)), { recursive: true });
    await writeFile(path.join(root, f), text);
  }
  return root;
}

const chevron = (d: string, size = 20, paint = 'stroke="currentColor" stroke-width="1.5"') =>
  `<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="${d}" ${paint}/></svg>`;

describe("project index", () => {
  it("maps colours and fonts to the project's variables, semantic aliases first", async () => {
    const root = await project({
      "styles/tokens.css": `:root {
        --white: #fff; --green-500: rgb(39 200 99);
        --color-bg: var(--white); /* the name to use */
        --font-ui: "Inter", system-ui, sans-serif; --font-size-sm: 14px;
        --primary: 142 67% 47%;
      }`,
      "styles/legacy.scss": "$brand: #27C863;\n",
      // Read first, and its selector must not pass for a --primary variable.
      "components/button.css": ".btn--primary:hover { color: red; }",
      "node_modules/lib/x.css": ":root { --vendor: #ffffff; }",
    });
    const idx = (await scanProject(root))!;
    expect(colorRefs(idx, "#ffffff")).toEqual(["var(--color-bg)", "var(--white)"]);
    expect(colorRefs(idx, "#27c863")).toEqual(["$brand", "var(--green-500)"]);
    expect(colorRefs(idx, "#28c862")).toEqual(["hsl(var(--primary))"]);
    expect(colorRefs(idx, "#123456")).toEqual([]);
    expect(fontRefs(idx, "Inter")).toEqual(["var(--font-ui)"]);
  });

  it("maps typography to classes that only set text properties", async () => {
    const root = await project({
      "base.css": `:root { --font-text: "Brand Text", sans-serif; }
        .t-body { font: 400 14px/17px var(--font-text); }
        .t-label { font-family: var(--font-text); font-weight: 500; font-size: 0.875rem; line-height: 1.25; }
        .t-meta { font: 400 11px/13px var(--font-text); letter-spacing: 0.05em; text-transform: uppercase; color: gray; }
        .card__title { font: 400 14px/17px var(--font-text); }
        .badge { font: 400 14px/17px var(--font-text); padding: 4px; }`,
    });
    const idx = (await scanProject(root))!;
    const ref = (c: string) => `.${c} (${path.relative(process.cwd(), path.join(root, "base.css"))})`;
    expect(textRefs(idx, 'Brand Text 400 "Book" 14/normal≈17')).toEqual([ref("t-body")]);
    expect(textRefs(idx, "Brand Text 500 14/125%")).toEqual([ref("t-label")]);
    expect(textRefs(idx, "Brand Text 400 11/normal ls:0.55px uppercase")).toEqual([ref("t-meta")]);
    expect(textRefs(idx, "Brand Text 400 14/20")).toEqual([]);
    expect(textRefs(idx, "Inter 400 14/normal≈17")).toEqual([]);
  });

  it("finds components by class or file name", async () => {
    const root = await project({
      "components/search-field.css": ".search-field { } .search-field__icon { background: url(a.png); }",
      "src/Badge.tsx": "export {}",
      "src/avatar/index.vue": "",
      "src/Badge.test.tsx": "",
    });
    const idx = (await scanProject(root))!;
    expect(componentRefs(idx, "Forms/Search field")).toEqual([".search-field (" + path.relative(process.cwd(), path.join(root, "components/search-field.css")) + ")"]);
    expect(componentRefs(idx, "Badge")).toEqual([path.relative(process.cwd(), path.join(root, "src/Badge.tsx"))]);
    expect(componentRefs(idx, "Auditor avatar")).toHaveLength(1);
    expect(componentRefs(idx, "png")).toEqual([]);
  });

  it("matches icons by drawing, whatever their colour, stroke width, size or path syntax", async () => {
    const root = await project({
      "icons/chevron-down.svg": chevron("M6 8.4l6 6 6-6", 24, 'stroke="currentColor" stroke-width="2"'),
      "icons/chevron-up.svg": chevron("M5 12L10 7L15 12"),
      "assets/old-export.svg": chevron("M5 7L10 12L15 7"),
    });
    const idx = (await scanProject(root, [path.join(root, "assets")]))!;
    const figma = chevron("M5 7L10 12L15 7", 20, 'stroke="#727372" stroke-width="1.5" stroke-linecap="square"');
    expect(iconFile(idx, figma)).toBe(path.relative(process.cwd(), path.join(root, "icons/chevron-down.svg")));
    expect(iconFile(idx, chevron("M5 8L10 13L15 8"))).toBeUndefined();
  });

  it("reads shapes, arcs with packed flags and ignores masks", () => {
    const a = shapeOf('<svg viewBox="0 0 10 10"><mask id="m"><rect width="10" height="10" fill="white"/></mask><circle cx="5" cy="5" r="4" stroke="#000" mask="url(#m)"/></svg>');
    expect(a).toEqual({ key: "O", nums: [0.5, 0.5, 0.4] });
    const arc = shapeOf('<svg viewBox="0 0 10 10"><path d="M1 1a2 2 0 012 2" fill="#000"/></svg>');
    expect(arc).toEqual({ key: "MA", nums: [0.1, 0.1, 0.2, 0.2, 0, 0, 1, 0.3, 0.3] });
    expect(shapeOf('<svg viewBox="0 0 24 24"><path d="M0 0h24v24H0z" fill="none"/></svg>')).toBeUndefined();
  });

  it("parses CSS colour syntaxes", () => {
    expect(parseColor("#FFF")?.hex).toBe("#ffffff");
    expect(parseColor("#00000080")?.hex).toBe("#00000080");
    expect(parseColor("rgba(0, 0, 0, .5)")?.hex).toBe("#00000080");
    expect(parseColor("hsl(0 0% 100%)")?.hex).toBe("#ffffff");
    expect(parseColor("oklch(0.985 0 0)")?.hex).toBe("#fafafa");
    expect(parseColor("0 0% 100%")).toEqual({ hex: "#ffffff", wrap: "hsl" });
    expect(parseColor("var(--x)")).toBeUndefined();
    expect(parseColor("14px")).toBeUndefined();
  });
});

describe("currentColor", () => {
  it("swaps a monochrome icon's colour but leaves its mask's white alone", () => {
    const svg = '<svg><mask id="m" fill="white"><path d="M0 0"/></mask><path d="M1 1" stroke="#727372" mask="url(#m)"/><path d="M2 2" stroke="#727372"/></svg>';
    expect(toCurrentColor(svg)).toBe('<svg><mask id="m" fill="white"><path d="M0 0"/></mask><path d="M1 1" stroke="currentColor" mask="url(#m)"/><path d="M2 2" stroke="currentColor"/></svg>');
    expect(toCurrentColor('<svg><path fill="#000"/><path fill="#fff"/></svg>')).toBe('<svg><path fill="#000"/><path fill="#fff"/></svg>');
  });
});
