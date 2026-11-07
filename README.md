# Loupe: read-only Figma → code for Claude

Loupe is an MCP server plus a small Figma plugin. Together they give a coding agent (Claude Code, or any MCP client) an **exact, compact description of a Figma design** to rebuild faithfully. It also covers the loop around that description: screenshots, asset export, and a pixel diff against your implementation.

It is **read-only**. The plugin never edits the document; it only answers read requests from the agent running on your machine.

```
## tokens
colors:
  $color/bg/surface = #ffffff  var(--bg-surface)
  $color/text/primary = #101828  var(--text-primary)
  $color/brand/500 = #4f46e5  var(--brand-500)
numbers:
  $space/4 = 24  var(--space-4)
typography (family weight size/line-height letter-spacing …):
  $Heading/H3 = Inter 600 20/28 ls:-0.005em  — Card titles
  T1 = Inter 400 14/20
  T2 = Inter 400 14/20 underline
  …
effects:
  $Elevation/2 = 0px 4px 16px 0 #00000014

## components (instances below list only what differs)
  Button{Variant=Primary} #7:1 120×40 hug; row; gap:8; justify:center; align:center; p:10,16; bg:$color/brand/500; radius:8
    // props: Variant: Primary*|Secondary; Label: text="Button"; Has icon: bool=false
    text "Label" #8:1 56×20 hug; font:T4; color:#ffffff; "Button"
      // bound: text←Label
    svg "Icon/Arrow right" #9:1 16×16 color:#ffffff; hidden
      // bound: visible←Has icon

## design
frame "Product card" #13:1 360×640 h:hug; col; gap:16; p:24,24,24,$space/4; bg:$color/bg/surface; radius:16; shadow:$Elevation/2; clip
  img "Hero" #14:1 312×180 w:fill; src:abc123def4 cover; radius:12
  text "Title" #15:1 312×28 w:fill; h:hug; font:$Heading/H3; color:$color/text/primary; "Wireless headphones"
  text "Legal" #16:1 312×20 w:fill; font:T1; color:#667085; "By buying you agree to our Terms."
    ~ "Terms" font:T2; color:#4f46e5; href:https://example.com/terms
  frame "Rating" #17:1 96×16 hug; row; gap:4
    svg "Icon/Star" #34:1 16×16 color:#f5a524
    +4 more like ↑: #35:1 #36:1 #37:1 #38:1
  frame "Specs" #18:1 312×120 w:fill; h:hug; col; gap:8
    frame "Row" #19:1 312×20 w:fill; h:hug; row; justify:between
      text #20:1 60×20 hug; font:T1; color:#667085; "Battery"
      text #21:1 40×20 hug; font:T3; color:#101828; "30 h"
    +3 more like ↑, content:
      #22:1 "Weight" "250 g"
      #25:1 "Bluetooth" "5.3"
      #28:1 "Colour" "Black"
  frame "Actions" #31:1 312×40 w:fill; h:hug; row; gap:12
    instance Button{Variant=Primary} #39:1 150×40 Label="Add to cart"; Has icon=true; w:fill; h:hug
  frame "Sale badge" #32:1 56×24 abs; at:280,12; pin:right; row; p:4,8; bg:linear-gradient(90deg, #ff4d4d 0%, #e61a80 100%); radius:full; shadow:0px 4px 16px 0 #00000014
    text #33:1 40×16 hug; font:T5; color:#ffffff; "-20%"
```

That is `npm run demo`, slightly shortened: a product card whose raw plugin JSON is 19.4k characters becomes about 870 tokens.

## Why another Figma MCP?

| | Loupe | Official Figma MCP | Framelink (Figma-Context-MCP) | plumb |
|---|---|---|---|---|
| Source | Plugin API (live file) | Dev Mode MCP | REST API | Plugin API |
| Needs | Any seat that can run a dev plugin | Dev/Full seat; rate limits on lower tiers | Personal access token; REST rate limits | Plugin |
| Output | Indented CSS-vocabulary tree + token table | Generated React + Tailwind, plus XML metadata | Simplified YAML/JSON | JSON node map + token table |
| Components | Defined once, instances as overrides diffed by layer id | Code Connect mapping | Component ids | Component name only |
| Big frames | Breadth-first token budget with expand markers; repeat folding | Large outputs on big frames | Whole tree | Depth + node cap |
| Visual check | Screenshot tiles for vision + pixel diff mapped to layers | Screenshot | Image download | Screenshot |
| Writes to Figma | Never | No | No | Yes (has write tools) |

Details and the review of plumb's pipeline: [docs/landscape.md](docs/landscape.md).

## Setup (once per machine)

Requirements: Node 20+, Figma desktop app (or Figma in the browser).

```bash
git clone <this repo> figma-loupe && cd figma-loupe
npm ci
npm run build
```

**1. Register the MCP server** with Claude Code (user scope, so every project can use it):

```bash
claude mcp add --scope user loupe -- node /absolute/path/to/figma-loupe/dist/server.js
```

Or add it to a project's `.mcp.json`:

```json
{ "mcpServers": { "loupe": { "command": "node", "args": ["/absolute/path/to/figma-loupe/dist/server.js"] } } }
```

**2. Import the plugin in Figma.** Open any design file, then go to *Plugins → Development → Import plugin from manifest…* and pick `plugin/manifest.json`. You only do this once per Figma account and machine.

**3. Optional: install the workflow skill.** Copy it so Claude follows the read → build → compare loop:

```bash
mkdir -p ~/.claude/skills && cp -r skills/figma-implement ~/.claude/skills/
```

## Daily use

1. Open the design in Figma and run *Plugins → Development → Loupe*. A small window shows "Connected to your agent". Keep it open. It also works in Dev Mode's Plugins panel.
2. Select a frame, or copy a link to it (*Copy link to selection*).
3. Ask Claude something like:
   - "Implement the selected frame in `src/components/ProductCard.tsx` with our Tailwind tokens."
   - "Build this screen: https://www.figma.com/design/…?node-id=12-34"

Several Claude sessions can share one plugin, and several Figma files can be open at once. Loupe routes each request by the file in the link, or else to the file you touched last.

## Tools

| Tool | What it returns |
|---|---|
| `get_design` | The tree above: layout, exact sizes, CSS values, `$tokens`, component definitions plus instance overrides, notes and interactions. Breadth-first within a token budget (default 8k); cut subtrees name the id to fetch. Options: `components: auto/inline/names`, `depth`, `include_hidden`, `expand_vectors`. |
| `get_screenshot` | PNG render(s) at up to 2×, scaled to what vision reads (≤1568 px) and tiled when tall. Optional `save_to`. |
| `export_assets` | Writes every icon (SVG) and image (original bytes) inside the target to `figma-assets/`, deduplicated by component and image hash, and maps files back to layers and `src:` hashes. `as: "svg"/"png"` exports the target layers themselves. |
| `compare_screenshot` | Pixel diff of your implementation's screenshot against Figma rendered at the same width. Returns the mismatch %, the regions mapped to Figma layers, and a design / implementation / diff image. |
| `get_tokens` | The file's variables (all modes) and styles as a list, CSS custom properties, or JSON. |
| `get_outline`, `find_nodes` | A cheap map of pages and frames, and search by layer name or text. |
| `get_css` | Figma's own Dev Mode CSS for specific layers, as a cross-check. |
| `status` | Connected files, pages and selections. |

## What makes the output faithful

- **Exact conversions.** Linear gradients are converted analytically: the angle comes from the gradient's transform and each stop is re-projected onto the CSS gradient line, so the colours match Figma at every pixel, even on non-square boxes. Radial and conic gradients are converted too. Figma blur radii are halved for CSS `blur()`. Percent letter-spacing becomes `em`. `AUTO` line-height becomes `normal`. Each side's stroke weight, stroke alignment and corner smoothing are kept. Image fills keep their crop, tile and filter values.
- **Real layout semantics.** Auto layout maps to row, col or grid with gap, padding, alignment, wrap, and fill/hug sizing. Free-positioned layers get CSS `left/top` computed from the unrotated box, plus their constraints and rotation.
- **Tokens are names.** Variables and styles appear as `$name`, with their value and code syntax (`var(--…)`) in the table, so the agent can map them onto your codebase's tokens.
- **Components like code.** A component used twice or more is printed once, with its property API. Each instance then lists only its props and true overrides. Overrides are matched by Figma's instance layer ids rather than names, so they stay correct when layers share a name. Hidden layers that a boolean property toggles stay in the definition.
- **Less noise, nothing lost.** Default layer names are dropped, icons collapse to one `svg` line, and identical or alternating siblings fold into one pattern plus their content. Large frames are spent breadth-first, so the agent always sees the whole structure first.

The full format reference is in [docs/FORMAT.md](docs/FORMAT.md). The same legend is sent to the agent once per session as MCP server instructions, so tool outputs stay small.

## How it works

```
Figma (plugin sandbox)          plugin UI iframe        MCP processes (one per Claude session)
 extract.ts: SceneNode → raw ─▶ WebSocket ─────────▶ hub (first process, 127.0.0.1:38451)
 handlers: export, images,                              ▲   └─ peers forward requests through the hub
 tokens, search, css                                    │
                                     raw snapshot ──▶ build (IR) ─▶ components ─▶ render (text, budget)
```

- The plugin sends a near-lossless raw snapshot. All interpretation happens in the server, which is plain, unit-tested TypeScript, so improving the output rarely needs a plugin update.
- **Hub and peers.** The first MCP process binds the port and becomes the hub. Later processes connect to it as peers. If the hub exits, a peer takes over and the plugin reconnects.
- **Security.** The socket listens on loopback only. Connections that send an `Origin` must come from Figma (`null` or `*.figma.com`) and may only act as the plugin. Origin-less (Node) connections may only act as peers. A web page you visit cannot drive it. The protocol has no write operations.

## Troubleshooting

- **"No Figma file is connected"**: run the plugin in the file (*Plugins → Development → Loupe*) and keep its window open.
- **Port in use**: set `LOUPE_PORT` for the server. Then change `PORT` in `plugin/src/ui.html` and the port in `plugin/manifest.json` (`allowedDomains`), and rebuild.
- **Plugin import fails on an older Figma version**: remove `"dev"` from `editorType` and the `capabilities` line in `plugin/manifest.json`.
- **Debug logs**: `LOUPE_DEBUG=1` prints bridge events to stderr.

## Development

```bash
npm run check     # typecheck (server + plugin) → tests → build
npm run demo      # print get_design output for the fake product card
npm run dev       # rebuild on change (re-run the plugin in Figma to reload it)
```

The tests run the real plugin extractor against an in-memory fake of the Figma Plugin API (`test/fake-figma.ts`). On top of that they cover the renderer, exact gradient math, hub/peer failover and origin checks, and end-to-end MCP calls through a fake plugin connection.
