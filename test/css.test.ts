import { describe, expect, it } from "vitest";
import { conicGradient, effectsCss, hex, letterSpacingCss, lineHeightCss, linearGradient, radialGradient, sides } from "../src/model/css";
import type { RawPaint } from "../src/shared/raw";

const stop = (s: { color: { r: number; g: number; b: number; a?: number } }) => hex(s.color);
const RED = { r: 1, g: 0, b: 0, a: 1 };
const BLUE = { r: 0, g: 0, b: 1, a: 1 };

function grad(transform: number[][], type = "GRADIENT_LINEAR"): RawPaint {
  return { type, gradientTransform: transform, gradientStops: [{ position: 0, color: RED }, { position: 1, color: BLUE }] };
}

/** Figma colour parameter at a pixel, straight from the transform's definition. */
function figmaT(t: number[][], w: number, h: number, x: number, y: number) {
  return t[0]![0]! * (x / w) + t[0]![1]! * (y / h) + t[0]![2]!;
}

/** CSS linear-gradient position (0..1 along the gradient line) at a pixel. */
function cssT(css: string, w: number, h: number, x: number, y: number) {
  const m = css.match(/linear-gradient\(([\d.]+)deg, #ff0000 (-?[\d.]+)%, #0000ff (-?[\d.]+)%\)/)!;
  const deg = (Number(m[1]) * Math.PI) / 180;
  const ux = Math.sin(deg);
  const uy = -Math.cos(deg);
  const L = Math.abs(w * ux) + Math.abs(h * uy);
  const s = ((x - (w / 2 - (ux * L) / 2)) * ux + (y - (h / 2 - (uy * L) / 2)) * uy) / L;
  const p0 = Number(m[2]) / 100;
  const p1 = Number(m[3]) / 100;
  return (s - p0) / (p1 - p0);
}

describe("linear gradients", () => {
  it("identity transform is a left-to-right gradient", () => {
    expect(linearGradient(grad([[1, 0, 0], [0, 1, 0]]), 200, 100, stop)).toBe("linear-gradient(90deg, #ff0000 0%, #0000ff 100%)");
  });

  it("top-to-bottom", () => {
    expect(linearGradient(grad([[0, 1, 0], [-1, 0, 1]]), 300, 120, stop)).toBe("linear-gradient(180deg, #ff0000 0%, #0000ff 100%)");
  });

  it("matches Figma's colour at every pixel for skewed transforms on non-square boxes", () => {
    const cases: [number[][], number, number][] = [
      [[[0.7, 0.7, -0.2], [-0.7, 0.7, 0.5]], 320, 80],
      [[[0.3, -0.9, 0.8], [0.9, 0.3, -0.1]], 100, 400],
      [[[-1, 0.2, 1.1], [0, 1, 0]], 50, 50],
    ];
    for (const [t, w, h] of cases) {
      const css = linearGradient(grad(t), w, h, stop);
      for (const [x, y] of [[0, 0], [w, 0], [w / 3, h / 2], [w, h], [w * 0.8, h * 0.1]] as [number, number][]) {
        expect(cssT(css, w, h, x, y)).toBeCloseTo(figmaT(t, w, h, x, y), 2);
      }
    }
  });
});

describe("other gradients", () => {
  it("radial centred ellipse", () => {
    // Identity: circle of radius .5 in unit space → ellipse w/2 × h/2.
    expect(radialGradient(grad([[1, 0, 0], [0, 1, 0]], "GRADIENT_RADIAL"), 200, 100, stop)).toBe(
      "radial-gradient(ellipse 100px 50px at 50% 50%, #ff0000 0%, #0000ff 100%)",
    );
  });

  it("conic starts at the handle direction", () => {
    expect(conicGradient(grad([[1, 0, 0], [0, 1, 0]], "GRADIENT_ANGULAR"), 100, 100, stop)).toBe(
      "conic-gradient(from 90deg at 50% 50%, #ff0000 0%, #0000ff 100%)",
    );
  });
});

describe("effects and text", () => {
  it("halves Figma blur radii for CSS", () => {
    const fx = effectsCss(
      [
        { type: "LAYER_BLUR", radius: 8 },
        { type: "BACKGROUND_BLUR", radius: 20 },
      ],
      false,
      () => "#000",
    );
    expect(fx.blur).toBe("blur(4px)");
    expect(fx.backdrop).toBe("blur(10px)");
  });

  it("shadows map 1:1 and text uses text-shadow", () => {
    const e = [{ type: "DROP_SHADOW", offset: { x: 0, y: 2 }, radius: 4, spread: 1, color: { r: 0, g: 0, b: 0, a: 0.25 } }];
    expect(effectsCss(e, false, () => "#00000040").shadow).toBe("0px 2px 4px 1px #00000040");
    expect(effectsCss(e, true, () => "#00000040").textShadow).toBe("0px 2px 4px 1px #00000040");
  });

  it("letter spacing percent → em, line height units", () => {
    expect(letterSpacingCss({ unit: "PERCENT", value: -2 })).toBe("-0.02em");
    expect(letterSpacingCss({ unit: "PIXELS", value: 0.5 })).toBe("0.5px");
    expect(letterSpacingCss({ unit: "PIXELS", value: 0 })).toBeUndefined();
    expect(lineHeightCss({ unit: "AUTO" })).toBe("normal");
    expect(lineHeightCss({ unit: "PERCENT", value: 150 })).toBe("150%");
    expect(lineHeightCss({ unit: "PIXELS", value: 24 })).toBe("24");
  });

  it("colours and padding shorthand", () => {
    expect(hex({ r: 1, g: 1, b: 1 })).toBe("#ffffff");
    expect(hex({ r: 0, g: 0, b: 0, a: 0.5 })).toBe("#00000080");
    expect(sides("8", "16", "8", "16")).toBe("8,16");
    expect(sides("4", "4", "4", "4")).toBe("4");
    expect(sides("1", "2", "3", "2")).toBe("1,2,3");
  });
});
