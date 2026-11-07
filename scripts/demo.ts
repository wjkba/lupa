// Prints the rendered output for the fake product card (dev aid).
import { snapshot } from "../plugin/src/extract";
import { renderSnapshot } from "../src/model/render";
import { productCard } from "../test/scenes";

const { f, card } = productCard();
const snap = await snapshot(f.api, [card], { ids: [card.id] }, { fileName: "Shop", pageName: "Home" });
const raw = JSON.stringify(snap);
const mode = (process.argv[2] ?? "auto") as "auto" | "inline" | "names";
const budget = Number(process.argv[3] ?? 10000);
const out = renderSnapshot(snap, { components: mode, budget });
console.log(out.text);
console.log("\n---", { rawChars: raw.length, outChars: out.text.length, ...out.stats });
