# Internals

## What makes the output faithful

- **Exact conversions.**
  - Linear gradients are converted analytically: the angle comes from the gradient's transform, and each stop is re-projected onto the CSS gradient line. The colours match Figma at every pixel, even on non-square boxes. Radial and conic gradients are converted too.
  - Figma blur radii are halved for CSS `blur()`.
  - Percent letter-spacing becomes `em`, and `AUTO` line-height becomes `normal`.
  - Per-side stroke weights, stroke alignment and corner smoothing are kept, and so are image crop, tile and filter values.
- **Real layout semantics.** Auto layout maps to row, col or grid with gap, padding, alignment, wrap and fill/hug sizing. Free-positioned layers get CSS `left/top` computed from the unrotated box, plus their constraints and rotation.
- **Tokens are names.** Variables and styles appear as `$name`, with their value and code syntax (`var(--…)`) in the table, so the agent can map them onto the codebase's tokens.
- **Components like code.**
  - A component used twice or more is printed once, with its property API.
  - Each instance lists only its props and true overrides. Overrides are matched by Figma's instance layer ids, so layers that share a name don't confuse them.
  - Hidden layers that a boolean property toggles stay in the definition.
- **Less noise, nothing lost.**
  - Default layer names are dropped, and icons collapse to one `svg` line.
  - Identical or alternating siblings fold into one pattern plus their content.
  - Large frames are spent breadth-first, so the agent sees the whole structure first.

The agent gets the short format legend once: from the skill, from `lupa format`, or as MCP server instructions. That keeps each output small.

## Why a CLI first

MCP tool definitions sit in the agent's context in every request, whether or not the session touches Figma. Lupa's tools and their legend would cost about 3k tokens there. As a CLI with a skill, Lupa costs nothing until Figma work starts. Its output can go to files and through `grep`, and a person can run the same commands. The MCP server shares the implementation (`src/tools/ops.ts`) for clients without a shell.

## Architecture

```
Figma (plugin sandbox)          plugin UI iframe        Lupa processes
 extract.ts: SceneNode → raw ─▶ WebSocket ─────────▶ hub (`lupa serve`, or the first MCP server; 127.0.0.1:38451)
 handlers: export, images,                              ▲   └─ each `lupa` command / other MCP server joins as a peer
 tokens, search, css                                    │
                                     raw snapshot ──▶ build (IR) ─▶ components ─▶ render (text, budget)
```

- **Thin plugin.** The plugin sends a near-lossless raw snapshot. All interpretation happens in plain, unit-tested TypeScript in the Lupa process, so improving the output rarely needs a plugin update.
- **Hub and peers.** The plugin needs a long-lived process to stay connected to.
  - A `lupa` command joins the running hub, or starts `lupa serve` in the background first.
  - An MCP server becomes the hub itself when none is running.
  - If the hub exits, a peer MCP server takes over and the plugin reconnects.
- **Security.**
  - The socket listens on loopback only.
  - Connections that send an `Origin` must come from Figma (`null` or `*.figma.com`) and may only act as the plugin. Connections without one (Node) may only act as peers. A web page you visit cannot drive Lupa.
  - The protocol has no write operations.
- **Screenshots when Figma is hidden.** Figma stops PNG exports while its window isn't rendered, but snapshots and SVG exports keep working. If a PNG doesn't arrive within 10 s (`LUPA_RASTER_WAIT_MS`), `screenshot` and `compare` render the SVG export in Chromium and say so.

## Development

```bash
npm run check     # typecheck (server + plugin) → tests → build
npm run demo      # design output for the fake product card
npm run dev       # rebuild on change (re-run the plugin in Figma to reload it)
```

The build writes the plugin's files only when they change. Figma reloads a development plugin whenever its files are written, and that reload drops any request in flight.

The tests run the real plugin extractor against an in-memory fake of the Figma Plugin API (`test/fake-figma.ts`). They also cover:
- the renderer and the gradient math;
- hub/peer failover and origin checks;
- every CLI command through a fake plugin connection, including `compare --url` in headless Chromium when a browser is available;
- end-to-end MCP calls.

If the plugin import fails on an older Figma version, remove `"dev"` from `editorType` and the `capabilities` line in `plugin/manifest.json`.
