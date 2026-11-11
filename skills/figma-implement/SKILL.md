---
name: figma-implement
description: Implement a Figma frame or component faithfully in code with the `lupa` CLI (design, screenshot, assets, compare). Use when the user shares a Figma link, mentions the selected frame in Figma, or asks to build or match UI from a Figma design.
---

# Implementing a Figma design with Lupa

`lupa` reads the live Figma file through the Lupa plugin, and it is read-only. If the first command fails:

- **"command not found":** ask the user to run `npm link` in the Lupa folder.
- **No file connected:** ask the user to open the file in Figma, run *Plugins → Development → Lupa*, and keep the plugin window open.

The target is a Figma URL (in quotes, because it contains `&`), node ids like `12:34`, or nothing for the current selection. When a session also has the Lupa MCP tools (`get_design`, …), they take the same options.

## 1. Read

1. From the project's root, run `lupa design [target] -d <the project's asset folder> --screenshot` and read the whole output before writing code. The format is described at the end of this file.
   - When the task names several frames or components (a screen and its component set, say), pass every link in this one call. Components and tokens they share are then printed once.
   - Lupa scans the project (CSS, SCSS and Less variables, SVG files, component files and classes) and marks what it already has. `→ var(--x)` after a colour token, a raw colour or a font is the project's variable for that value, and `→ .t-body` after a typography token is the project's text style class. `// project has: …` under a component says where the project defines it. A `src:` outside your asset folder is the project's own icon with the same drawing, so Lupa wrote no copy.
   - `-d` writes the other icons as SVG and the images as their original files. Each `svg` and `img` layer names its file in `src:`, so use that path where the layer is. You don't need to open the files. Add `--current-color` for monochrome icons that should inherit the text colour, and follow the project's icon conventions (sprite, components).
   - Open the `image:` file under `## screenshot` to see the intent: hierarchy, alignment, what is decorative.
   - `## components` holds the components used more than once. If the codebase already has one, use it and map its props. Otherwise build it once. `--components names` gives a smaller output when the codebase already has most of them.
2. Look up only what has no `→`: colours, fonts and text styles in the project's Tailwind config, theme object (styled-components, MUI, Chakra…) or tokens file, which Lupa doesn't read. See **Colours** below.
   - `… +N layers not shown → get_design #id` means part of the tree was cut. Run `lupa design <id> -d <same folder>` before building that part. Don't guess its contents.

## 2. Build

- **Layout:**
  - `row`/`col` → flex; `grid` → CSS grid.
  - `gap`, `p:t,r,b,l`, `justify` and `align` map to the flex properties of the same meaning.
  - `fill` → `flex: 1` or `align-self: stretch` on that axis; `hug` → auto size.
  - A size without `fill` or `hug` is fixed. On responsive containers, prefer the fill/hug behaviour over hard-coding the frame width.
- **Positioning:** `abs; at:x,y; pin:…` → `position: absolute` with `left`/`top`, or `right`/`bottom` when `pin` says so.
- **Colours:** for every colour in `bg:`, `border:`, `color:` and `shadow:`, whether a `$token` or a raw `#hex`/`rgba()`, use the project token Lupa printed after `→`, or else one with the same name or the same value (compare values case-insensitively and across hex/rgb notation; `@0.5` is that token at 50% opacity, e.g. `bg-primary/50`). Write a literal colour only when no token matches. Don't substitute a token whose value is merely close; list those near misses in your summary instead. If a Figma token's name matches a project token but the values differ, use the project token and mention the difference.
- **Values:** `bg:`, `shadow:`, `blur:` and `border:` are already CSS. Copy them as they are, with colours swapped for tokens as above.
- **Typography:** `font:` is a typography token. Use the project's matching text style (the class after `→`, if any) and keep its exact line-height and letter-spacing.
- **Text runs:** `~ "run"` lines under a text are inline spans (links, bold words) inside that text.
- **Notes:** `// note:` and `// on click → …` come from the designer (annotations, prototype interactions, dev status). Follow them.
- **Content:** use the real text from the design, not placeholders.

## 3. Verify

1. Start the page that shows your implementation (dev server, Storybook). A static page needs no server: pass its `file://` URL, and Lupa serves its folder over local HTTP so modules, `fetch()` and CSS masks load.
2. Run `lupa compare [target] --url <page url> --selector <css selector of the element>`. Lupa renders the page at the design's width and prints the mismatch % and the differing regions, each named by its Figma layer. It also writes a design | implementation | diff image. Open that image.
   - If the page can't be rendered here, take a PNG screenshot of the element and pass `--image <png>` instead.
3. Fix the named layers. Compare against that layer's line in `lupa design`, not by eye. Repeat until the remaining mismatch is font anti-aliasing or intended (dynamic data, a responsive width).
4. Search your changes for literal colours (`#`, `rgb(`, `hsl(`, arbitrary Tailwind values like `bg-[#…]`). Each one left must have no matching project token.
5. When the design itself is unclear, `lupa css <id>` shows Figma's own Dev Mode CSS as a cross-check.

## Other commands

- `lupa outline` lists the pages and top-level frames, for when the user names a screen but gives no link.
- `lupa find <text>` searches layer names; add `--text` to search text content.
- `lupa tokens --format css` dumps the file's variables and styles, to bootstrap a theme.
- `lupa screenshot [target]` and `lupa assets [target] -d DIR` do the screenshot and the export on their own. `lupa assets --as svg|png` exports the target layers themselves.
- `lupa status` lists the connected Figma files and their selections.
- `lupa help` lists every option.

## Output format

```
get_design format — one line per layer, children indented:
  <kind> ["name"] #id W×H props…   kinds: frame group section component set instance text svg img rect ellipse line
  Props are CSS-like, separated by "; ". A bare word is a flag.
  Size: W×H are px. w:/h: fill|hug (bare "fill"/"hug" = both axes); no w/h = fixed. Instances say w:fixed/h:fixed (or bare "fixed") where their component hugs. h:fixed(content N) = a fixed box its N px content overflows: set the size anyway; justify places the spill. minw/maxw/minh/maxh.
  Flow (auto layout): row|col|grid, gap, rowgap, wrap, p (CSS padding shorthand, commas), justify (center|end|between), align (center|end|baseline). Children of a flow parent are positioned by the flow.
  Free position: at:x,y = CSS left/top inside the parent; abs = absolutely positioned inside a flow parent; pin:right|bottom|center-x|left+right… = constraints (how it moves when the parent resizes); rotate:<deg> (CSS sign).
  Style: bg (CSS background, topmost layer first), border:<width> [dashed(…)] <color> [outside|center] (default inside → box-sizing: border-box; p and at: already count from inside it), radius (full = pill), smooth (corner smoothing), shadow/text-shadow (CSS), blur/backdrop (CSS blur() radius, already halved from Figma), opacity, blend, clip (overflow hidden), mask.
  img: src:<hash> cover|contain|crop|tile. svg: vector graphic; color: its fill. With an assets folder (assets_dir, CLI -d), src: is the file written for that layer; otherwise export_assets writes them.
  Text: font:<token>; color; text-align; valign; ellipsis; content last as a JSON string. "~" lines under text = styled runs that differ from the base style. In a typography token, "≈17" after a line height (normal≈17, 135%≈19) = what Figma renders it at, measured: write line-height 17px.
  $name = design token (Figma variable/style); see "## tokens". T1, E1 = repeated typography/effect values listed there. "$name=value" = token bound but resolved to another value here (mode/override).
  Components: "## components" prints each repeated component once. "instance Name{Variant=…} Prop=value" uses it; "~ path: changes" lines list only what that instance overrides (path = layer names, or #id for unnamed layers of the definition).
  "+N more like ↑" / "+N more alternating like the 2 above" = siblings with the same structure as the layer(s) just printed; the lines under it give each one's id and its own texts/images.
  "… +N layers not shown → get_design #id" = cut by the token budget; fetch that subtree when you need it.
  // lines = designer notes, prototype interactions, component props, exports.
  Codebase: "→ var(--x)" after a colour or font = the project's own variable for that value; "→ .class" after a typography token = its text style class. "// project has: …" = where the project defines that component. A src: outside the assets folder = the project's own icon with the same drawing.
Reproduce exact values (sizes, spacing, colours, type). Before writing any colour, $token or raw (#hex, rgba), look for the codebase's own token with that name or value (Tailwind theme, CSS variables, theme object) and use it; hardcode only when none matches.
```
