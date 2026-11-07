---
name: figma-implement
description: Implement a Figma frame or component faithfully in code using the Loupe MCP tools (get_design, get_screenshot, export_assets, compare_screenshot). Use when the user shares a Figma link, mentions "the selected frame" in Figma, or asks to build or match UI from a Figma design.
---

# Implementing a Figma design with Loupe

Loupe reads the live Figma file through a plugin, and it is read-only. If a tool says no file is connected, ask the user to run *Plugins → Development → Loupe* in that file and keep the plugin window open.

## 1. Read

1. `get_design` with the Figma URL, or with no target to use the current selection. Read the whole output before writing code.
   - `## tokens` lists the design tokens. Map every `$name` onto the codebase's existing tokens (Tailwind theme, CSS variables, theme object). Search the codebase for the value or the `var(--…)` name. Use raw values only when nothing matches.
   - `## components` contains components used more than once. If the codebase already has the component (Button, Input, …), use it and map its props. Otherwise build it once.
   - A `… +N layers not shown → get_design #id` line means part of the tree was cut. Call `get_design` on that id before you build that part. Don't guess its contents.
   - If the codebase already has most components, `components: "names"` gives a smaller output.
2. `get_screenshot` on the same target to see the intent: hierarchy, alignment, what is decorative.
3. `export_assets` writes the icons (SVG) and images into a folder. Move them to the project's asset location and follow its icon conventions (sprite, React components, `currentColor`). Pass `current_color: true` for monochrome icons that should inherit colour.

## 2. Build

- Translate the props literally:
  - `row`/`col` → flex, `grid` → CSS grid.
  - `gap`, `p:t,r,b,l`, `justify`, `align` → the matching flex properties.
  - `fill` → `flex: 1` or `align-self: stretch` along that axis.
  - `hug` → auto size.
  - A size without `fill`/`hug` is fixed. On responsive containers, prefer the hug/fill semantics over hard-coding the frame width.
- `abs; at:x,y; pin:…` → `position: absolute` with `left`/`top` (or `right`/`bottom`, following `pin`).
- Values such as `bg:linear-gradient(…)`, `shadow:`, `blur:` and `border:` are already CSS. Copy them as they are.
- `font:` is a typography token. Use the matching text style when the project has one, and keep the exact line-height and letter-spacing.
- Text `~ "run"` lines are inline spans (links, bold words) inside that text.
- Notes (`// note:`, `// on click → …`) come from the designer: annotations, prototype interactions, dev status. Honour them.
- Use the real text from the design, not placeholders.

## 3. Verify

1. Render your implementation at the frame's width (Playwright, Storybook, or a dev-server screenshot) and save a PNG.
2. `compare_screenshot` with `image: <path>` and the same target. It returns the mismatch % and the regions that differ, named by Figma layer.
3. Fix the named layers. Check that row's props in `get_design` rather than eyeballing. Repeat until the remaining mismatch is just font anti-aliasing or intentional (dynamic data, a responsive width).
4. When the design itself is unclear, use `get_css` on a layer to see Figma's own CSS, as a cross-check.

## Other tools

- `get_outline` lists the pages and top-level frames when the user names a screen but gives no link. `find_nodes` searches by layer name or text.
- `get_tokens` dumps the file's variables and styles (`format: "css"` or `"json"`) to bootstrap a theme.
- `status` shows connected files and the current selection.
