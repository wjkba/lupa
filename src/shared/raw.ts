/**
 * The raw snapshot the plugin sends for a subtree.
 *
 * It is a near-lossless, JSON-safe copy of the plugin API properties that
 * matter for rebuilding a design, with default values left out. The server
 * turns it into the compact text an agent reads; keeping the interpretation
 * server-side means the plugin rarely needs updating and the whole pipeline
 * can be unit-tested in Node.
 */

export interface RawColor {
  r: number;
  g: number;
  b: number;
  a?: number;
}

export interface RawAlias {
  type?: string;
  id: string;
}

/** Plugin `Paint`, passed through. Only the fields the server reads are typed. */
export interface RawPaint {
  type: string;
  visible?: boolean;
  opacity?: number;
  blendMode?: string;
  color?: RawColor;
  gradientTransform?: number[][];
  gradientStops?: { position: number; color: RawColor; boundVariables?: { color?: RawAlias } }[];
  imageHash?: string | null;
  scaleMode?: string;
  imageTransform?: number[][];
  scalingFactor?: number;
  rotation?: number;
  filters?: Record<string, number>;
  boundVariables?: { color?: RawAlias };
}

export interface RawEffect {
  type: string;
  visible?: boolean;
  color?: RawColor;
  offset?: { x: number; y: number };
  radius?: number;
  spread?: number;
  blendMode?: string;
  showShadowBehindNode?: boolean;
  blurType?: string;
  startRadius?: number;
  boundVariables?: Record<string, RawAlias>;
}

export interface RawLineHeight {
  unit: "PIXELS" | "PERCENT" | "AUTO";
  value?: number;
}

export interface RawLetterSpacing {
  unit: "PIXELS" | "PERCENT";
  value: number;
}

/** One styled run of a text node (`getStyledTextSegments`). */
export interface RawSegment {
  characters: string;
  start: number;
  end: number;
  fontFamily: string;
  fontStyle: string;
  fontWeight: number;
  fontSize: number;
  lineHeight: RawLineHeight;
  letterSpacing: RawLetterSpacing;
  fills: RawPaint[];
  textDecoration?: string;
  textCase?: string;
  textStyleId?: string;
  fillStyleId?: string;
  hyperlink?: { type: string; value: string } | null;
  listType?: "ORDERED" | "UNORDERED" | "NONE";
  indentation?: number;
  paragraphSpacing?: number;
  paragraphIndent?: number;
  openTypeFeatures?: Record<string, boolean>;
  boundVariables?: Record<string, RawAlias>;
}

export interface RawReaction {
  trigger: string;
  timeout?: number;
  delay?: number;
  action: string;
  /** NODE action navigation: NAVIGATE / SWAP / OVERLAY / SCROLL_TO / CHANGE_TO */
  navigation?: string;
  destinationId?: string;
  url?: string;
  transition?: string;
  duration?: number;
}

export interface RawComponentProp {
  type: string;
  value: string | boolean;
}

export interface RawNode {
  id: string;
  name: string;
  type: string;
  /** Present only when false. */
  visible?: false;
  /** Hidden layer emitted as a stub (no styling, no children). */
  stub?: true;

  /* geometry ---------------------------------------------------------- */
  /** Unrotated size (`width` / `height`). */
  w: number;
  h: number;
  /** `absoluteBoundingBox` — x, y, w, h (rotated AABB). */
  bb?: [number, number, number, number];
  /** Degrees, Figma convention (counter-clockwise positive). */
  rotation?: number;

  /* auto layout (container) ------------------------------------------- */
  layoutMode?: "HORIZONTAL" | "VERTICAL" | "GRID";
  layoutWrap?: "WRAP";
  itemSpacing?: number;
  counterAxisSpacing?: number | null;
  paddingTop?: number;
  paddingRight?: number;
  paddingBottom?: number;
  paddingLeft?: number;
  primaryAxisAlignItems?: string;
  counterAxisAlignItems?: string;
  counterAxisAlignContent?: string;
  itemReverseZIndex?: true;
  strokesIncludedInLayout?: true;
  gridRowCount?: number;
  gridColumnCount?: number;
  gridRowGap?: number;
  gridColumnGap?: number;
  gridRowSizes?: { type: string; value?: number }[];
  gridColumnSizes?: { type: string; value?: number }[];

  /* auto layout (child) ------------------------------------------------ */
  layoutPositioning?: "ABSOLUTE";
  layoutSizingHorizontal?: "FIXED" | "HUG" | "FILL";
  layoutSizingVertical?: "FIXED" | "HUG" | "FILL";
  layoutGrow?: number;
  layoutAlign?: string;
  gridRowAnchorIndex?: number;
  gridColumnAnchorIndex?: number;
  gridRowSpan?: number;
  gridColumnSpan?: number;
  constraints?: { horizontal: string; vertical: string };
  minWidth?: number;
  maxWidth?: number;
  minHeight?: number;
  maxHeight?: number;

  /* appearance --------------------------------------------------------- */
  fills?: RawPaint[];
  strokes?: RawPaint[];
  strokeWeight?: number;
  strokeTopWeight?: number;
  strokeRightWeight?: number;
  strokeBottomWeight?: number;
  strokeLeftWeight?: number;
  strokeAlign?: string;
  dashPattern?: number[];
  cornerRadius?: number;
  /** [tl, tr, br, bl] when corners differ. */
  radii?: [number, number, number, number];
  cornerSmoothing?: number;
  effects?: RawEffect[];
  opacity?: number;
  blendMode?: string;
  clipsContent?: true;
  isMask?: true;
  maskType?: string;
  fillStyleId?: string;
  strokeStyleId?: string;
  effectStyleId?: string;
  textStyleId?: string;
  /** Node-level variable bindings (padding, gap, radius, size, …). Arrays are flattened to their first alias. */
  boundVariables?: Record<string, RawAlias>;
  layoutGrids?: Record<string, unknown>[];
  /** ELLIPSE arcs (partial ellipse / donut). */
  arcData?: { startingAngle: number; endingAngle: number; innerRadius: number };

  /* text ---------------------------------------------------------------- */
  characters?: string;
  segments?: RawSegment[];
  textAutoResize?: string;
  textAlignHorizontal?: string;
  textAlignVertical?: string;
  textTruncation?: "ENDING";
  maxLines?: number;
  leadingTrim?: string;

  /* components ----------------------------------------------------------- */
  /** INSTANCE: id of the main component (resolved with getMainComponentAsync). */
  mainComponentId?: string;
  componentProperties?: Record<string, RawComponentProp>;
  /** Nodes inside components: which property drives which field. */
  componentPropertyReferences?: Record<string, string>;
  /** COMPONENT / COMPONENT_SET. */
  componentKey?: string;
  description?: string;
  propertyDefinitions?: Record<string, { type: string; defaultValue: string | boolean; variantOptions?: string[] }>;

  /* hand-off --------------------------------------------------------------- */
  annotations?: { label: string; properties?: string[] }[];
  devStatus?: string;
  exportSettings?: { format: string; suffix?: string; constraint?: { type: string; value: number } }[];
  reactions?: RawReaction[];

  /* vector graphics ------------------------------------------------------- */
  /** Set when an icon / illustration subtree was collapsed into one graphic. */
  graphic?: {
    /** Distinct visible colours (hex, CSS order) found in the subtree, max 6. */
    colors: string[];
    /** Variable ids bound to those colours, when every colour is bound. */
    colorVars?: string[];
    nodes: number;
  };

  children?: RawNode[];
  /** Children that exist but were not serialized (depth / node limit). */
  childCount?: number;
}

export interface RawComponentInfo {
  id: string;
  name: string;
  key?: string;
  remote?: boolean;
  description?: string;
  /** Component set this variant belongs to. */
  setId?: string;
  setName?: string;
  /** Variant values for this component (`Size=md`). */
  variant?: Record<string, string>;
  /** Property definitions (from the set, or the component itself when it has no set). */
  propertyDefinitions?: Record<string, { type: string; defaultValue: string | boolean; variantOptions?: string[] }>;
  /** Full main-component subtree; present when the snapshot asked for components. */
  tree?: RawNode;
  /** True when the whole component is a vector graphic (icon). */
  isGraphic?: boolean;
}

export interface RawVariableInfo {
  id: string;
  name: string;
  collection?: string;
  type?: string;
  /** `codeSyntax.WEB`, e.g. `var(--color-bg)`. */
  web?: string;
}

export interface RawStyleInfo {
  id: string;
  name: string;
  type: string;
  description?: string;
}

export interface RawSnapshot {
  fileName: string;
  pageName: string;
  roots: RawNode[];
  /** Breadcrumb of ancestor names for each root (page excluded). */
  ancestry: Record<string, string[]>;
  components: Record<string, RawComponentInfo>;
  variables: Record<string, RawVariableInfo>;
  styles: Record<string, RawStyleInfo>;
  /** Names of nodes referenced by reactions (destinations). */
  nodeNames: Record<string, string>;
  /** Number of nodes serialized and whether the node limit cut the walk short. */
  stats: { nodes: number; truncated: boolean; ms: number };
  missing: string[];
}
