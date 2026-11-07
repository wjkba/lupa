# `get_design` output format

The output has up to three sections. **## tokens** resolves the `$name`, `T<n>` and `E<n>` references used below it. **## components** holds each repeated component's definition. **## design** is the tree itself. A short header comes first: breadcrumb, fonts, asset counts and warnings.

## Layer lines

```
<kind> ["layer name"] #<id> <W>×<H> <prop>; <prop>; …; ["text content"]
```

- **kind** is one of `frame group section component set instance text svg img rect ellipse line`. Instances read `instance Card{Size=lg}` (component and variant).
- **Layer name** is omitted when it is a Figma default (`Frame 12`), when it equals the text content, or when it equals the component name.
- **#id** is the Figma node id. Pass it to any tool as `target`.
- **W×H** is the size in px (unrotated).
- Children are indented two spaces. Lines starting with `//` are notes that belong to the layer above.

## Props

| Prop | Meaning (CSS equivalent) |
|---|---|
| `w:fill` `h:hug` `fill` `hug` | Sizing on that axis. `fill` = stretch (`flex: 1` / `align-self: stretch`), `hug` = fit content. A bare `fill`/`hug` means both axes. No prop means fixed `W×H`. An instance prints `w:fixed`/`h:fixed` (bare `fixed` for both) where its component would hug. |
| `minw` `maxw` `minh` `maxh` | min/max width/height. |
| `row` `col` `grid` | Auto layout: `display:flex` row/column, or CSS grid. |
| `gap` `rowgap` `wrap` | `gap` / `row-gap` / `flex-wrap: wrap`. |
| `p:t,r,b,l` | Padding, CSS shorthand order with commas (`p:8,16` = 8px 16px). |
| `justify:center\|end\|between` `align:center\|end\|baseline` | `justify-content` / `align-items` (start is the default and is omitted). |
| `cols:` `rows:` `cell:c,r` `span:CxR` | Grid tracks (`1fr`, px, `auto`) and child placement. |
| `abs` | `position: absolute` inside an auto layout parent. |
| `at:x,y` | `left`/`top` inside the parent, for layers not positioned by auto layout. Computed from the unrotated box. |
| `pin:right,bottom` `left+right` `center-x` `scale-x` | Figma constraints: how the layer follows when its parent resizes. |
| `rotate:-15deg` | CSS rotation (sign already converted). |
| `bg:` | `background`, CSS order (topmost first). Solid colours, exact `linear-/radial-/conic-gradient()`, `img(<hash> cover\|contain\|tile\|crop …)`. |
| `color:` | Text colour; for `svg`, the icon's fill colour(s) (`colors:` when several). |
| `border:1 #e4e7ec` | Width (per side `0,0,1,0` when they differ), optional `dashed(4,2)`, colour, and `outside`/`center` when not the default inside alignment. |
| `radius:8` `radius:8,8,0,0` `radius:full` `smooth:60%` | `border-radius` (tl,tr,br,bl). `full` = pill/circle. `smooth` = Figma corner smoothing. |
| `shadow:` `text-shadow:` | `box-shadow` / `text-shadow`, 1:1. |
| `blur:` `backdrop:` | `filter: blur()` / `backdrop-filter: blur()`, already halved from Figma's radius. |
| `opacity` `blend` `clip` `mask:alpha` | `opacity`, `mix-blend-mode`, `overflow: hidden`, mask layer. |
| `src:<hash> cover` | `img` layer (an image-filled rectangle/ellipse). The file comes from `export_assets`. |
| `hidden` | The layer is hidden (only shown with `include_hidden`, or toggled by a component property). |

## Text

```
text #15:1 312×28 w:fill; h:hug; font:$Heading/H3; color:$text/primary; text-align:center; "Wireless headphones"
  ~ "Terms" font:T2; color:#4f46e5; href:https://example.com/terms
```

- `font:` is always a token. Typography values read `Family weight [italic] size/line-height [ls:…em|px] [uppercase…] [underline…] [para:N]`. `line-height` is px, `%` or `normal`.
- `~ "run" …` lines list styled runs that differ from the layer's base style. `@<offset>` is added when the same run text appears more than once.
- `ellipsis` / `ellipsis:2lines` means truncation. `valign`: vertical alignment inside a fixed-height box. `trim:cap` means leading-trim.

## Tokens

- `$color/brand/500` is a Figma variable or style name. Its value and `var(--…)` code syntax are in `## tokens`. Map it onto the codebase's existing tokens where one exists.
- `$name@0.5` means the token at 50% opacity (paint opacity). `$name@Collection` qualifies a name that exists in several variable collections.
- `$name=#123456` means the layer is bound to the token, but the value here differs (another mode or a local override).
- `T<n>` and `E<n>` are repeated typography and effect values, listed once in the table.

## Components

```
## components
  Button{Variant=Primary} #7:1 120×40 hug; row; gap:8; p:10,16; bg:$brand; radius:8
    // props: Variant: Primary*|Secondary; Label: text="Button"; Has icon: bool=false
    text "Label" #8:1 56×20 hug; font:T4; color:#fff; "Button"
      // bound: text←Label

## design
  instance Button{Variant=Primary} #39:1 150×40 Label="Add to cart"; Has icon=true; w:fill
    ~ Icon: color:#000000
```

- A component used two or more times is printed once in `## components` with its property API (`*` marks the default variant). Instances list their props, their own sizing and position, and `~ path: change` lines for real overrides: text, style, `hidden`/`shown`, or `swap→Other`. Layer paths are relative to the instance; `[2]` disambiguates siblings that share a name, and layers with Figma's default names (`Frame 517`), which definition lines hide, appear as their definition id (`#6:958/00`). A definition does not print `fill` on its root: that refers to the variant set's own layout, not to where instances go. Changes that a component property drives are not repeated.
- A component used once is expanded in place.
- `components:"names"` prints instances as single lines (useful when the codebase already has the components). `components:"inline"` expands every instance.

## Folding and budget

- `+N more like ↑` means the next N siblings have the same structure as the layer just printed. `+N more alternating like the 2 above` is the same for a two-layer pattern, such as zebra rows. The lines under it give each sibling's id and its own texts and images.
- `… +N layers not shown → get_design #id` means that subtree was cut by the token budget, which is spent breadth-first. Fetch the subtree, or raise `budget`.
- `… +N layers not loaded` means the subtree was beyond `depth`.
