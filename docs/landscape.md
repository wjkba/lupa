# Landscape and design notes

Researched in November 2026. This covers what exists for reading Figma designs into a coding agent, what plumb (the starting point of this repo) does well and badly, and why Lupa is built the way it is.

## At a glance

| | Lupa | Official Figma MCP | Framelink (Figma-Context-MCP) | plumb |
|---|---|---|---|---|
| Interface | CLI + Claude Code skill (MCP optional) | MCP | MCP | MCP |
| Source | Plugin API (live file) | Dev Mode MCP | REST API | Plugin API |
| Needs | Any seat that can run a dev plugin | Dev/Full seat; rate limits on lower tiers | Personal access token; REST rate limits | Plugin |
| Output | Indented CSS-vocabulary tree + token table | Generated React + Tailwind, plus XML metadata | Simplified YAML/JSON | JSON node map + token table |
| Components | Defined once, instances as overrides diffed by layer id | Code Connect mapping | Component ids | Component name only |
| Big frames | Breadth-first token budget with expand markers; repeat folding | Large outputs on big frames | Whole tree | Depth + node cap |
| Visual check | Screenshot tiles for vision + pixel diff of your page, mapped to layers | Screenshot | Image download | Screenshot |
| Writes to Figma | Never | No | No | Yes (has write tools) |

## Existing tools

| Tool | How it reads | What the agent gets | Notes |
|---|---|---|---|
| [Figma MCP server (official)](https://developers.figma.com/docs/figma-mcp-server) | Dev Mode MCP, desktop or remote | Generated React + Tailwind code (`get_code`), XML metadata, screenshots, variables, Code Connect | Best when Code Connect is set up. The generated code is a starting point full of absolute values. Large frames produce very large outputs, and the docs suggest using `get_metadata` first. Needs a Dev or Full seat; lower plans are rate-limited. |
| [Framelink / Figma-Context-MCP](https://github.com/GLips/Figma-Context-MCP) | REST API with a personal access token | Simplified YAML/JSON of layout and styles, plus image download | The most popular community server. REST data lacks some plugin-only information (resolved instance overrides, variable code syntax, styled text segments as the plugin sees them). Subject to REST rate limits. |
| [cursor-talk-to-figma-mcp](https://github.com/grab/cursor-talk-to-figma-mcp) | Plugin + WebSocket relay | Raw node JSON from read tools; most tools write | Built for editing Figma from an agent. Reading returns verbose JSON. |
| [figma-console-mcp](https://github.com/southleft/figma-console-mcp) | Plugin bridge / console | Variables, components, styles, console logs, screenshots | Aimed at design-system work and plugin debugging, not at faithful screen reproduction. |
| plumb | Plugin + local server | JSON with a token table and a flat node map | Reviewed below. |

## plumb review

plumb's pipeline is: the plugin serializes nodes, the server normalizes them into a token table plus a flat map of nodes, and the agent reads that JSON. The core idea is right: pull repeated values into tokens, drop default and empty properties, and send structure instead of raw API dumps. On its own fixture (21 nodes) the raw REST JSON is 15,364 characters (10,372 minified), and plumb's output is 5,465 characters.

Problems found while reading the code and running the fixture:

- **Hard-to-read structure.** Nodes are emitted post-order in a flat map with a redundant `path` on each entry. The agent has to rebuild the tree before it can write markup.
- **Lost component identity.** The plugin calls the synchronous `mainComponent` even though the manifest uses `documentAccess: dynamic-page`. That access mode requires `getMainComponentAsync`, so instances lose their component and variant.
- **Heuristic labels that can be wrong.** Pattern detection labelled the dialog header `pattern: "nav"`. A wrong semantic hint is worse than none.
- **Wrong values:**
  - PERCENT letter-spacing and AUTO line-height are dropped.
  - Layer blur is passed through without halving. Figma's blur radius is about twice CSS `blur()`; see the [Figma forum thread](https://forum.figma.com/ask-the-community-7/background-blur-is-different-in-dev-mode-22642) and [Bjango's comparison](https://bjango.com/articles/blurradiuscomparison/).
  - Gradient angles ignore the box's aspect ratio and the stop projection.
  - The compact fill picks the bottom paint, not the visible top one.
  - Sizes come from the axis-aligned bounding box, which is wrong for rotated layers.
- **No component deduplication.** Every instance repeats its whole subtree.
- **Weak socket security.** The WebSocket server does not check `Origin`, so any web page open in a browser on the same machine could connect.
- **It writes.** It ships creation and editing tools, which this team does not want near production files.

Verdict: the direction (plugin data → server-side normalization → compact text) is sound and is what Lupa keeps. The serialization format and the value conversions need to be redone, which is why Lupa is a rewrite rather than a fork.

## Lupa's choices

1. **Plugin API, not REST.** The plugin sees resolved instance overrides, bound variables with their code syntax, styled text segments, `getCSSAsync`, and exact exports. It needs no token, and Figma's REST rate limits do not apply.
2. **Thin plugin, smart server.** The plugin sends a near-lossless snapshot. Every interpretation step (CSS conversion, tokens, components, folding, budget) is server-side TypeScript tested against a fake Plugin API. Fixing output does not require re-importing the plugin.
3. **Text, not JSON.** An indented tree with CSS vocabulary (`row; gap:8; p:10,16; radius:8`) is what the agent turns into markup, and it costs about three times fewer tokens than equivalent JSON. The legend is sent once as MCP server instructions.
4. **Components as code.** A repeated component is defined once with its property API, and instances print only props and overrides. Overrides are diffed by Figma's own instance layer ids (`I<instance>;<layer>`), so layers with duplicate names don't confuse it.
5. **A budget, spent breadth-first.** The agent sees the whole structure first. Cut subtrees are marked with the id to fetch next. Repeated siblings, including alternating zebra rows, fold into one pattern plus their content.
6. **Exact values.** Gradients are converted analytically from the transform (verified pixel by pixel in tests). Blur is halved, letter-spacing converted, and per-side borders, stroke alignment, corner smoothing, image crop and filters are kept.
7. **Close the loop visually.** Screenshots are sized for vision models and tiled. `compare_screenshot` renders Figma at the implementation's width, diffs the two, and names the Figma layers under each differing region.
8. **CLI first, MCP optional.** Agents with a shell use the `lupa` command and a skill. Nothing sits in the context until Figma work starts, output can go to files, and humans can run the same commands. The MCP server shares the same implementation for clients without a shell.
9. **Read-only by construction.** The protocol has no write methods. The socket is loopback-only, with an origin policy: browser origins other than Figma are rejected, and only Figma origins can act as the plugin.

## Measurements

| Input | Raw | Lupa `get_design` |
|---|---|---|
| plumb's fixture dialog (21 nodes) | 15,364 chars REST JSON; plumb output 5,465 chars | 1,789 chars (≈560 tokens) as a readable tree |
| Product card test scene | 19.4k chars plugin JSON | ≈870 tokens |
| Synthetic 300-row table (3,903 nodes) | 1.83M chars plugin JSON | 1,261 tokens in 60 ms (zebra rows folded, each row's content listed) |
| Real desktop screen (header, tabs, 8-row table, 6 components) | — | 10.6k chars (≈3.3k tokens) in one call, no cuts |

How agents do with Lupa against the other tools, end to end: [bench/README.md](../bench/README.md).
