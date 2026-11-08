/**
 * Save a raw Loupe snapshot of one Figma node to JSON, so scoring can run without Figma.
 *   npx tsx bench/snapshot.mts <node-id | figma url> <out.json>
 * Needs the Loupe plugin open on that file. Retries while the plugin reloads.
 */
import { writeFileSync } from "node:fs";
import { Bridge } from "../src/bridge/hub";

const [target, out] = process.argv.slice(2);
if (!target || !out) {
  console.error("usage: npx tsx bench/snapshot.mts <node-id | figma url> <out.json>");
  process.exit(2);
}
const id = /node-id=([\d]+[-:][\d]+)/.exec(target)?.[1]?.replace("-", ":") ?? target;

const bridge = new Bridge({ log: () => {} });
let lastError: unknown;
for (let attempt = 1; attempt <= 5; attempt++) {
  try {
    await bridge.start();
    if (!bridge.list().length) await bridge.waitForPlugin(8_000);
    const snap = await bridge.request("snapshot", { ids: [id], components: false, maxNodes: 30_000 });
    if (!snap.roots[0] || snap.roots[0].stub) throw new Error(`node ${id} not found or hidden`);
    writeFileSync(out, JSON.stringify(snap));
    console.log(`saved ${out}: "${snap.roots[0].name}" #${id}, ${snap.stats.nodes} nodes`);
    process.exit(0);
  } catch (e) {
    lastError = e;
    console.error(`attempt ${attempt}: ${(e as Error).message}`);
    await new Promise((r) => setTimeout(r, 3_000));
  }
}
console.error(`could not snapshot ${id}: ${(lastError as Error)?.message}`);
process.exit(1);
