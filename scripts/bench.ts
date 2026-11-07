// Synthetic large screen: a data table + cards, to check speed and budget behaviour.
import { snapshot } from "../plugin/src/extract";
import { renderSnapshot } from "../src/model/render";
import { FakeFile, solid } from "../test/fake-figma";

const f = new FakeFile();
const page = f.node({ type: "PAGE", name: "C" } as any);
const cell = f.component({ name: "Cell", w: 160, h: 40, layoutMode: "HORIZONTAL", paddingLeft: 12, paddingRight: 12, counterAxisAlignItems: "CENTER",
  strokes: [solid("#eaecf0")], strokeWeight: 1, strokeBottomWeight: 1, strokeTopWeight: 0, strokeLeftWeight: 0, strokeRightWeight: 0,
  children: [{ type: "TEXT", name: "Value", text: "Value", w: 100, h: 20, fills: [solid("#475467")] }] }, page);
const rows: any[] = [];
const screen = f.node({ type: "FRAME", name: "Dashboard", w: 1440, h: 4200, layoutMode: "VERTICAL", itemSpacing: 0, fills: [solid("#f9fafb")] });
for (let r = 0; r < Number(process.argv[2] ?? 100); r++) {
  const row = f.node({ type: "FRAME", name: "Row", w: 960, h: 40, layoutMode: "HORIZONTAL", layoutSizingHorizontal: "FILL", fills: [solid(r % 2 ? "#ffffff" : "#f9fafb")] }, screen);
  screen.children.push(row);
  for (let c = 0; c < 6; c++) f.instance(cell, row, { x: c * 160 }, { [cell.children[0].id]: { text: `R${r}C${c} ${"x".repeat(r % 7)}` } });
  rows.push(row);
}
let t = Date.now();
const snap = await snapshot(f.api, [screen], { ids: [screen.id] }, { fileName: "F", pageName: "P" });
const tSnap = Date.now() - t;
t = Date.now();
const out = renderSnapshot(snap, { budget: 8000 });
const tRender = Date.now() - t;
console.log(out.text.split("\n").slice(0, 40).join("\n"));
console.log("...\n", { nodes: snap.stats.nodes, rawChars: JSON.stringify(snap).length, outChars: out.text.length, estTokens: out.stats.tokens, cut: out.stats.cut, tSnap, tRender });
