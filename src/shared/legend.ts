/**
 * The get_design output legend. Agents get it once: as MCP server
 * instructions, from `loupe format`, and inside the figma-implement skill
 * (a test keeps the skill in sync).
 */
export const FORMAT_LEGEND = `get_design format — one line per layer, children indented:
  <kind> ["name"] #id W×H props…   kinds: frame group section component set instance text svg img rect ellipse line
  Props are CSS-like, separated by "; ". A bare word is a flag.
  Size: W×H are px. w:/h: fill|hug (bare "fill"/"hug" = both axes); no w/h = fixed. Instances say w:fixed/h:fixed (or bare "fixed") where their component hugs. minw/maxw/minh/maxh.
  Flow (auto layout): row|col|grid, gap, rowgap, wrap, p (CSS padding shorthand, commas), justify (center|end|between), align (center|end|baseline). Children of a flow parent are positioned by the flow.
  Free position: at:x,y = CSS left/top inside the parent; abs = absolutely positioned inside a flow parent; pin:right|bottom|center-x|left+right… = constraints (how it moves when the parent resizes); rotate:<deg> (CSS sign).
  Style: bg (CSS background, topmost layer first), border:<width> [dashed(…)] <color> [outside|center] (default inside → box-sizing: border-box), radius (full = pill), smooth (corner smoothing), shadow/text-shadow (CSS), blur/backdrop (CSS blur() radius, already halved from Figma), opacity, blend, clip (overflow hidden), mask.
  img: src:<hash> cover|contain|crop|tile → file from export_assets. svg: vector graphic → export_assets; color: its fill.
  Text: font:<token>; color; text-align; valign; ellipsis; content last as a JSON string. "~" lines under text = styled runs that differ from the base style.
  $name = design token (Figma variable/style); see "## tokens". T1, E1 = repeated typography/effect values listed there. "$name=value" = token bound but resolved to another value here (mode/override).
  Components: "## components" prints each repeated component once. "instance Name{Variant=…} Prop=value" uses it; "~ path: changes" lines list only what that instance overrides (path = layer names, or #id for unnamed layers of the definition).
  "+N more like ↑" / "+N more alternating like the 2 above" = siblings with the same structure as the layer(s) just printed; the lines under it give each one's id and its own texts/images.
  "… +N layers not shown → get_design #id" = cut by the token budget; fetch that subtree when you need it.
  // lines = designer notes, prototype interactions, component props, exports.
Reproduce exact values (sizes, spacing, colours, type). Map $tokens to the codebase's existing tokens/variables when they exist.`;
