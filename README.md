# Loupe: read-only Figma → code for Claude

Loupe is a command-line tool (`loupe`) plus a small Figma plugin. Together they give a coding agent an **exact, compact description of a Figma design** to rebuild faithfully. It also covers the loop around that description: screenshots, asset export, and a pixel diff of your running page against the design. The same operations are available as an MCP server for clients without a shell.

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

## Why another Figma tool?

| | Loupe | Official Figma MCP | Framelink (Figma-Context-MCP) | plumb |
|---|---|---|---|---|
| Interface | CLI + Claude Code skill (MCP optional) | MCP | MCP | MCP |
| Source | Plugin API (live file) | Dev Mode MCP | REST API | Plugin API |
| Needs | Any seat that can run a dev plugin | Dev/Full seat; rate limits on lower tiers | Personal access token; REST rate limits | Plugin |
| Output | Indented CSS-vocabulary tree + token table | Generated React + Tailwind, plus XML metadata | Simplified YAML/JSON | JSON node map + token table |
| Components | Defined once, instances as overrides diffed by layer id | Code Connect mapping | Component ids | Component name only |
| Big frames | Breadth-first token budget with expand markers; repeat folding | Large outputs on big frames | Whole tree | Depth + node cap |
| Visual check | Screenshot tiles for vision + pixel diff of your page, mapped to layers | Screenshot | Image download | Screenshot |
| Writes to Figma | Never | No | No | Yes (has write tools) |

**Why a CLI first.** MCP tool definitions sit in the agent's context in every request, whether or not the session touches Figma. Loupe's nine tools and their legend cost about 3k tokens. As a CLI, Loupe costs nothing until it is used: the skill (with the format legend) loads only for Figma work. Output can also go to files and through `grep`, and a human can run the same commands. The MCP server stays available for clients without a shell, such as Claude Desktop.

Details and the review of plumb's pipeline: [docs/landscape.md](docs/landscape.md).

## Setup (once per machine)

Requirements: Node 20+, Figma desktop app (or Figma in the browser).

```bash
git clone <this repo> figma-loupe && cd figma-loupe
npm ci
npm run build
npm link            # puts `loupe` on your PATH
```

**1. Import the plugin in Figma.** Open any design file, then go to *Plugins → Development → Import plugin from manifest…* and pick `plugin/manifest.json`. You only do this once per Figma account and machine.

**2. Install the skill** so Claude knows the commands and the output format:

```bash
mkdir -p ~/.claude/skills && cp -r skills/figma-implement ~/.claude/skills/
```

**3. For `loupe compare --url`:** Loupe renders your page with Playwright. It uses your project's Playwright if it has one, otherwise its own. It finds a browser in this order: `LOUPE_BROWSER`, Playwright's downloaded browsers, then an installed Google Chrome. If you have none of them, run `npx playwright install chromium`.

**Optional: MCP**, for clients without a shell or if you prefer tools:

```bash
claude mcp add --scope user loupe -- loupe mcp
```

Or add it to a project's `.mcp.json`: `{ "mcpServers": { "loupe": { "command": "loupe", "args": ["mcp"] } } }`.

## Daily use

1. Open the design in Figma and run *Plugins → Development → Loupe*. Keep its small window open. It also works in Dev Mode's Plugins panel.
2. Select a frame, or copy a link to it (*Copy link to selection*).
3. Ask Claude something like:
   - "Implement the selected Figma frame in `src/components/ProductCard.tsx` with our Tailwind tokens."
   - "Build this screen: https://www.figma.com/design/…?node-id=12-34"

The first `loupe` command starts a small background hub that the plugin connects to, and the plugin window then shows "Connected to your agent". The hub exits after an hour without requests and starts again on the next command. Several Claude sessions can share the plugin, and several Figma files can be open at once. Each request goes to the file in its link, or else to the file you touched last.

## Commands

A target is a Figma URL (quote it), node ids like `12:34` (several allowed), or nothing for the current selection.

| CLI | MCP tool | What it does |
|---|---|---|
| `loupe design [target]` | `get_design` | The tree above: layout, exact sizes, CSS values, `$tokens`, component definitions plus instance overrides, notes and interactions. Breadth-first within a token budget (`--budget`, default 8000); cut subtrees name the id to fetch. Also `--components auto\|inline\|names`, `--depth`, `--hidden`, `--vectors`. |
| `loupe screenshot [target]` | `get_screenshot` | PNG render(s) at up to 2×, scaled to what vision reads (≤1568 px) and tiled when tall. The CLI prints the file paths (`-o` to choose; `--full` also saves the full-resolution PNG). |
| `loupe assets [target]` | `export_assets` | Writes every icon (SVG) and image (original bytes) inside the target to `-d` (default `figma-assets/`), deduplicated by component, identical SVG content and image hash, and maps files back to layers and `src:` hashes. Unnamed graphics (`Frame 810`) are named after their nearest named parent. `--as svg\|png` exports the target layers themselves; `--current-color` for monochrome icons. |
| `loupe compare [target] --url <page> --selector <css>` | `compare_screenshot` | Renders your page in headless Chromium at the design's width (2×) and diffs it against Figma. Prints the mismatch %, how much of it is inside text layers, the design fonts the page can't load, and the differing regions mapped to Figma layers (non-text first), and writes a design / implementation / diff image. `--image <png>` compares a screenshot you took instead. |
| `loupe tokens` | `get_tokens` | The file's variables (all modes) and styles: `--format list\|css\|json`, `--filter`. |
| `loupe outline`, `loupe find <query>` | `get_outline`, `find_nodes` | A cheap map of pages and frames, and search by layer name (`--text` for text content). |
| `loupe css <target>` | `get_css` | Figma's own Dev Mode CSS for specific layers, as a cross-check. |
| `loupe status` | `status` | Connected files, pages and selections. |
| `loupe format` | (server instructions) | The output legend. |
| `loupe serve`, `loupe mcp` | | Run the hub in the foreground; run as an MCP server over stdio. |

## What makes the output faithful

- **Exact conversions.** Linear gradients are converted analytically: the angle comes from the gradient's transform and each stop is re-projected onto the CSS gradient line, so the colours match Figma at every pixel, even on non-square boxes. Radial and conic gradients are converted too. Figma blur radii are halved for CSS `blur()`. Percent letter-spacing becomes `em`. `AUTO` line-height becomes `normal`. Each side's stroke weight, stroke alignment and corner smoothing are kept. Image fills keep their crop, tile and filter values.
- **Real layout semantics.** Auto layout maps to row, col or grid with gap, padding, alignment, wrap, and fill/hug sizing. Free-positioned layers get CSS `left/top` computed from the unrotated box, plus their constraints and rotation.
- **Tokens are names.** Variables and styles appear as `$name`, with their value and code syntax (`var(--…)`) in the table, so the agent can map them onto your codebase's tokens.
- **Components like code.** A component used twice or more is printed once, with its property API. Each instance then lists only its props and true overrides. Overrides are matched by Figma's instance layer ids rather than names, so they stay correct when layers share a name. Hidden layers that a boolean property toggles stay in the definition.
- **Less noise, nothing lost.** Default layer names are dropped, icons collapse to one `svg` line, and identical or alternating siblings fold into one pattern plus their content. Large frames are spent breadth-first, so the agent always sees the whole structure first.

The full format reference is in [docs/FORMAT.md](docs/FORMAT.md). The agent gets the short legend once: from the skill, from `loupe format`, or as MCP server instructions. That keeps each output small.

## How it works

```
Figma (plugin sandbox)          plugin UI iframe        Loupe processes
 extract.ts: SceneNode → raw ─▶ WebSocket ─────────▶ hub (`loupe serve`, or the first MCP server; 127.0.0.1:38451)
 handlers: export, images,                              ▲   └─ each `loupe` command / other MCP server joins as a peer
 tokens, search, css                                    │
                                     raw snapshot ──▶ build (IR) ─▶ components ─▶ render (text, budget)
```

- The plugin sends a near-lossless raw snapshot. All interpretation happens in the Loupe process, which is plain, unit-tested TypeScript, so improving the output rarely needs a plugin update. The CLI and the MCP server share one implementation (`src/tools/ops.ts`).
- **Hub and peers.** The plugin needs a long-lived process to stay connected to. A `loupe` command joins the running hub, or starts `loupe serve` in the background first. An MCP server becomes the hub itself when none is running. If the hub exits, a peer MCP server takes over and the plugin reconnects.
- **Security.** The socket listens on loopback only. Connections that send an `Origin` must come from Figma (`null` or `*.figma.com`) and may only act as the plugin. Origin-less (Node) connections may only act as peers. A web page you visit cannot drive it. The protocol has no write operations.

## Troubleshooting

- **"No Figma file is connected"**: run the plugin in the file (*Plugins → Development → Loupe*) and keep its window open.
- **Screenshots, assets or compare say Figma is in the background, or hang**: Figma does not render images while its window is minimized or its browser tab is hidden. Reading the design still works. Bring Figma to the front and retry. Since Loupe 0.2.0 the plugin reports this, so you get an immediate message instead of a wait. After updating Loupe, re-run the plugin in Figma so it loads the new code.
- **Hub log**: `loupe serve` writes to `$TMPDIR/loupe/hub.log` (`/tmp/loupe/hub.log` on Linux). It records every request with its duration.
- **`compare --url` cannot start a browser**: see setup step 3, or set `LOUPE_BROWSER=/path/to/chrome`.
- **Port in use**: set `LOUPE_PORT` (or pass `--port`). Then change `PORT` in `plugin/src/ui.html` and the port in `plugin/manifest.json` (`allowedDomains`), and rebuild.
- **Plugin import fails on an older Figma version**: remove `"dev"` from `editorType` and the `capabilities` line in `plugin/manifest.json`.
- **Debug logs**: `LOUPE_DEBUG=1` prints bridge events to stderr.

## Development

```bash
npm run check     # typecheck (server + plugin) → tests → build
npm run demo      # print design output for the fake product card
npm run dev       # rebuild on change (re-run the plugin in Figma to reload it)
```

The build writes the plugin's files only when they change. Figma reloads a development plugin whenever its files are written, and a reload drops any request in flight.

The tests run the real plugin extractor against an in-memory fake of the Figma Plugin API (`test/fake-figma.ts`). They also cover:
- the renderer and the exact gradient math;
- hub/peer failover and origin checks;
- every CLI command through a fake plugin connection, including `compare --url` in headless Chromium when a browser is available;
- end-to-end MCP calls.
