# Lupa

Lupa lets a coding agent read a Figma design and rebuild it faithfully. It is a CLI (`lupa`) plus a small Figma plugin, with an optional MCP server. It is **read-only**: the plugin never edits the file.

One command gives the agent what it needs for a frame:

```bash
lupa design "<figma link>" -d src/assets --screenshot
```

- **A compact tree of the frame.** It holds the layout as flex/grid, exact sizes and CSS values, design tokens by name, and each repeated component once, with per-instance overrides.
- **The frame's icons and images**, written to `src/assets`, with each file named on its layer.
- **A screenshot** for the agent to look at.

After building, `lupa compare` renders the page, diffs it against Figma and names the Figma layers where they differ.

## How good is it

In the benchmark an agent (Claude Opus 5.5) builds a Figma screen as HTML/CSS, reading the design with one tool. Mean of 3 runs per tool on a card-grid screen:

| | **Lupa** | Official Figma MCP | Framelink | figwright |
|---|---|---|---|---|
| Pixel mismatch vs Figma | **0.40%** | 0.42% | 2.12% (0.41–3.86%) | 0.41% |
| Text layers within 1 px vertically | **100%** | 100% | 66% (15–100%) | 100% |
| Design data read from Figma | **28k chars** | 80k | 29k | 110k |
| Context added | **28k tokens** | 63k | 30k | 82k |
| Agent turns | **10** | 25 | 10 | 24 |

- **Against the official Figma MCP:** the same quality with less than half the context and turns.
- **Against Framelink:** just as lean, without its layout drift. In 2 of 3 Framelink runs the grid rows ended up several pixels off.
- **Consistency:** all 6 runs of the current Lupa version rendered pixel-identically.

A second screen (a table page) gave the same picture. For the method, both screens and how to re-run it, see [bench/README.md](bench/README.md).

## What the agent reads

`npm run demo`, shortened: a product card whose raw plugin JSON is 19.4k characters becomes about 870 tokens.

```
## tokens
colors:
  $color/bg/surface = #ffffff  var(--bg-surface)
  $color/text/primary = #101828  var(--text-primary)
  $color/brand/500 = #4f46e5  var(--brand-500)
typography (family weight size/line-height letter-spacing …):
  $Heading/H3 = Inter 600 20/28 ls:-0.005em  — Card titles
  T1 = Inter 400 14/20
  …

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
```

The full format is in [docs/FORMAT.md](docs/FORMAT.md).

## Setup (once per machine)

Requirements: Node 20+ and Figma (desktop app or browser).

```bash
git clone <this repo> figma-lupa && cd figma-lupa
npm ci && npm run build
npm link                                                   # puts `lupa` on your PATH
mkdir -p ~/.claude/skills && cp -r skills/figma-implement ~/.claude/skills/
```

1. **Import the plugin.** In any Figma file, go to *Plugins → Development → Import plugin from manifest…* and pick `plugin/manifest.json`.
2. **The skill** you just copied teaches Claude the commands and the output format. It loads only for Figma work, so Lupa costs no context in other sessions.
3. **Browser for `compare --url`:** Lupa uses Playwright. It looks for `LUPA_BROWSER`, then Playwright's browsers, then Google Chrome. If you have none, run `npx playwright install chromium`.

**Optional MCP server**, for clients without a shell: `claude mcp add --scope user lupa -- lupa mcp`.

## Daily use

1. Open the design in Figma, run *Plugins → Development → Lupa*, and keep its small window open.
2. Select a frame or copy its link.
3. Ask Claude, for example: "Implement the selected Figma frame in `src/components/ProductCard.tsx` with our Tailwind tokens."

The first `lupa` command starts a background hub for the plugin to connect to. It exits after an hour without requests. Several Claude sessions and several open Figma files can share it.

## Commands

A target is a Figma URL (in quotes), node ids like `12:34`, or nothing for the current selection. Each command has an MCP tool of the same purpose. Run `lupa help` for every option.

| Command | What it does |
|---|---|
| `lupa design [target]` | The tree above, within a token budget (`--budget`, default 8000). Cut subtrees name the id to fetch next. `-d DIR` also writes the assets and puts their paths on the layers. `--screenshot` adds a PNG. |
| `lupa screenshot [target]` | PNG at up to 2×, sized for vision models and tiled when tall. |
| `lupa assets [target] -d DIR` | Icons as SVG and images as their original files, deduplicated. Use `--current-color` for monochrome icons. |
| `lupa compare [target] --url <page> --selector <css>` | Renders your page at the design's width and diffs it against Figma. Prints the mismatch and the differing regions by Figma layer, and writes a design / page / diff image. `--image <png>` compares a screenshot instead. |
| `lupa tokens` | Variables (all modes) and styles, as a list, CSS or JSON. |
| `lupa outline`, `lupa find <query>` | Pages and frames, and search by layer name (add `--text` to search text content). |
| `lupa css <target>` | Figma's own Dev Mode CSS, as a cross-check. |
| `lupa status` | Connected files and selections. |

## Troubleshooting

- **"No Figma file is connected":** run the plugin in the file and keep its window open. After updating Lupa, run the plugin again.
- **"used Figma's SVG export":** Figma stops rendering PNGs while its window is hidden or covered, so Lupa rendered the SVG export in Chromium instead. Layout and text match; blur, some newer effects and occasionally a stroke can be missing. For an exact render, bring Figma to the front and run the command again.
- **Port in use:** set `LUPA_PORT`, change the port in `plugin/src/ui.html` and `plugin/manifest.json`, and rebuild.
- **Logs:** the hub logs every request to `$TMPDIR/lupa/hub.log`. Set `LUPA_DEBUG=1` for bridge events.

## More

- [docs/internals.md](docs/internals.md): how the output stays faithful, the architecture, security, development.
- [docs/landscape.md](docs/landscape.md): other Figma tools and why Lupa is built this way.
- [bench/README.md](bench/README.md): the benchmark.
