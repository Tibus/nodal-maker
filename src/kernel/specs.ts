/**
 * Node metadata — the single source of truth the visual editor reads to render
 * ports, params and edge types. Deliberately DEPENDENCY-FREE (no replicad, no
 * Manifold): it must be importable on the UI/main thread without dragging the
 * heavy WASM kernels into that bundle. The runtime node implementations live in
 * `nodes.ts`; the socket-type strings here must stay in sync with
 * `GraphValue["kind"]` there.
 */

export type SocketType = "sketch2d" | "solid" | "mesh" | "number" | "text" | "selection";

export interface PortSpec {
  name: string;
  type: SocketType;
}

export interface ParamSpec {
  name: string;
  kind: "number" | "text" | "select" | "stl" | "font";
  label?: string;
  default?: unknown;
  min?: number;
  max?: number;
  step?: number;
  options?: string[];
}

export interface NodeSpec {
  type: string;
  label: string;
  inputs: PortSpec[];
  output: SocketType;
  params: ParamSpec[];
  /** named selection outputs the modifier exposes (cap/sides/edges…) */
  selectionOutputs?: { name: string; target: "face" | "edge" }[];
}

/** Colour per socket type — shared by the editor handles and edge styling. */
export const SOCKET_COLORS: Record<SocketType, string> = {
  sketch2d: "#c678dd", // purple — 2D profiles
  solid: "#ff8c42", // orange — B-rep solids
  mesh: "#56b6c2", // cyan   — triangle meshes
  number: "#98c379", // green  — scalar numbers
  text: "#e5c07b", // yellow — strings
  selection: "#d19a66", // amber — face/edge selections (criteria)
};

/**
 * The socket type a param exposes as an OPTIONAL input port, or null if the
 * param is inline-only (files, enums). Numbers and text can be driven by an
 * upstream value node instead of their inline default.
 */
export function paramPortType(p: ParamSpec): SocketType | null {
  if (p.kind === "number") return "number";
  if (p.kind === "text") return "text";
  return null;
}

/** Ordered palette categories (drives the grouped palette + search). */
export const NODE_CATEGORIES: { name: string; types: string[] }[] = [
  { name: "Value", types: ["numberValue", "textValue", "math", "mathUnary", "clamp", "remap", "random"] },
  { name: "2D Primitive", types: ["rect", "circle", "ellipse", "polygon", "star", "slot", "gear", "fingerBox", "svgInput", "textToSvg"] },
  { name: "2D Op", types: ["offset2d", "kerf", "fillet2d", "bevel2d", "boolean2d", "mirror2d", "transform2d", "arrayLinear2d", "arrayRadial2d", "group", "scoreCut"] },
  { name: "3D Primitive", types: ["box", "cylinder", "sphere", "cone", "torus"] },
  { name: "Sketch → Solid", types: ["extrude", "revolve", "loft", "loftSections", "sweep", "bossOnCap"] },
  { name: "3D Op", types: ["transform", "rotate3d", "scale3d", "mirror3d", "fillet", "bevel", "shell", "boolean3d", "arrayLinear3d", "arrayRadial3d"] },
  { name: "Selector", types: ["edgeSelect", "faceSelect"] },
  { name: "Mesh", types: ["tessellate", "importSTL", "repair", "boolean", "transformMesh", "convexHull", "minkowski", "decimate", "subdivide"] },
];

export const NODE_SPECS: Record<string, NodeSpec> = {
  numberValue: {
    type: "numberValue",
    label: "Number",
    inputs: [],
    output: "number",
    params: [{ name: "value", kind: "number", label: "value", default: 10, min: -1000, max: 1000, step: 0.5 }],
  },
  textValue: {
    type: "textValue",
    label: "Text",
    inputs: [],
    output: "text",
    params: [{ name: "value", kind: "text", label: "value", default: "" }],
  },
  math: {
    type: "math",
    label: "Math",
    inputs: [],
    output: "number",
    params: [
      { name: "a", kind: "number", default: 0, min: -1000, max: 1000, step: 0.5 },
      { name: "b", kind: "number", default: 0, min: -1000, max: 1000, step: 0.5 },
      { name: "op", kind: "select", default: "add", options: ["add", "subtract", "multiply", "divide", "power", "modulo", "min", "max"] },
    ],
  },
  mathUnary: {
    type: "mathUnary",
    label: "Math (unary)",
    inputs: [],
    output: "number",
    params: [
      { name: "x", kind: "number", default: 0, min: -1000, max: 1000, step: 0.5 },
      { name: "op", kind: "select", default: "abs", options: ["negate", "abs", "sqrt", "sin", "cos", "tan", "round", "floor", "ceil"] },
    ],
  },
  clamp: {
    type: "clamp",
    label: "Clamp",
    inputs: [],
    output: "number",
    params: [
      { name: "value", kind: "number", default: 0, min: -1000, max: 1000, step: 0.5 },
      { name: "min", kind: "number", default: 0, min: -1000, max: 1000, step: 0.5 },
      { name: "max", kind: "number", default: 1, min: -1000, max: 1000, step: 0.5 },
    ],
  },
  remap: {
    type: "remap",
    label: "Remap",
    inputs: [],
    output: "number",
    params: [
      { name: "value", kind: "number", default: 0, min: -1000, max: 1000, step: 0.1 },
      { name: "inMin", kind: "number", default: 0, min: -1000, max: 1000, step: 0.1 },
      { name: "inMax", kind: "number", default: 1, min: -1000, max: 1000, step: 0.1 },
      { name: "outMin", kind: "number", default: 0, min: -1000, max: 1000, step: 0.1 },
      { name: "outMax", kind: "number", default: 10, min: -1000, max: 1000, step: 0.1 },
    ],
  },
  random: {
    type: "random",
    label: "Random",
    inputs: [],
    output: "number",
    params: [
      { name: "seed", kind: "number", default: 1, min: 0, max: 99999, step: 1 },
      { name: "min", kind: "number", default: 0, min: -1000, max: 1000, step: 0.5 },
      { name: "max", kind: "number", default: 1, min: -1000, max: 1000, step: 0.5 },
    ],
  },
  svgInput: {
    type: "svgInput",
    label: "SVG input",
    inputs: [],
    output: "sketch2d",
    params: [{ name: "d", kind: "text", label: "path d", default: "" }],
  },
  rect: {
    type: "rect",
    label: "Rectangle 2D",
    inputs: [],
    output: "sketch2d",
    params: [
      { name: "width", kind: "number", default: 40, min: 1, max: 300, step: 1 },
      { name: "height", kind: "number", default: 30, min: 1, max: 300, step: 1 },
      { name: "radius", kind: "number", label: "corner r", default: 0, min: 0, max: 100, step: 0.5 },
    ],
  },
  circle: {
    type: "circle",
    label: "Circle 2D",
    inputs: [],
    output: "sketch2d",
    params: [{ name: "radius", kind: "number", default: 20, min: 0.5, max: 300, step: 0.5 }],
  },
  polygon: {
    type: "polygon",
    label: "Polygon 2D",
    inputs: [],
    output: "sketch2d",
    params: [
      { name: "radius", kind: "number", default: 20, min: 0.5, max: 300, step: 0.5 },
      { name: "sides", kind: "number", default: 6, min: 3, max: 24, step: 1 },
    ],
  },
  gear: {
    type: "gear",
    label: "Gear 2D",
    inputs: [],
    output: "sketch2d",
    params: [
      { name: "teeth", kind: "number", default: 12, min: 3, max: 120, step: 1 },
      { name: "radius", kind: "number", label: "pitch r", default: 30, min: 2, max: 300, step: 0.5 },
      { name: "depth", kind: "number", label: "tooth", default: 6, min: 0.5, max: 60, step: 0.5 },
    ],
  },
  ellipse: {
    type: "ellipse",
    label: "Ellipse 2D",
    inputs: [],
    output: "sketch2d",
    params: [
      { name: "rx", kind: "number", default: 30, min: 0.5, max: 300, step: 0.5 },
      { name: "ry", kind: "number", default: 18, min: 0.5, max: 300, step: 0.5 },
    ],
  },
  star: {
    type: "star",
    label: "Star 2D",
    inputs: [],
    output: "sketch2d",
    params: [
      { name: "outer", kind: "number", default: 30, min: 1, max: 300, step: 0.5 },
      { name: "inner", kind: "number", default: 14, min: 0.5, max: 300, step: 0.5 },
      { name: "points", kind: "number", default: 5, min: 3, max: 24, step: 1 },
    ],
  },
  slot: {
    type: "slot",
    label: "Slot 2D",
    inputs: [],
    output: "sketch2d",
    params: [
      { name: "length", kind: "number", default: 40, min: 1, max: 300, step: 1 },
      { name: "width", kind: "number", default: 12, min: 1, max: 300, step: 0.5 },
    ],
  },
  fingerBox: {
    type: "fingerBox",
    label: "Finger-joint Box",
    // flat pattern (5 or 6 panels) for a press-fit laser-cut box
    inputs: [],
    output: "sketch2d",
    params: [
      { name: "width", kind: "number", default: 80, min: 10, max: 400, step: 1 },
      { name: "depth", kind: "number", default: 60, min: 10, max: 400, step: 1 },
      { name: "height", kind: "number", default: 40, min: 10, max: 400, step: 1 },
      { name: "thickness", kind: "number", label: "material", default: 3, min: 0.5, max: 12, step: 0.5 },
      { name: "finger", kind: "number", label: "finger", default: 12, min: 3, max: 60, step: 1 },
      { name: "lid", kind: "select", default: "open", options: ["open", "closed"] },
    ],
  },
  boolean2d: {
    type: "boolean2d",
    label: "Boolean 2D",
    // difference = base − tool
    inputs: [
      { name: "base", type: "sketch2d" },
      { name: "tool", type: "sketch2d" },
    ],
    output: "sketch2d",
    params: [{ name: "op", kind: "select", default: "union", options: ["union", "difference", "intersection"] }],
  },
  mirror2d: {
    type: "mirror2d",
    label: "Mirror 2D",
    inputs: [{ name: "in", type: "sketch2d" }],
    output: "sketch2d",
    params: [{ name: "axis", kind: "select", default: "X", options: ["X", "Y"] }],
  },
  transform2d: {
    type: "transform2d",
    label: "Transform 2D",
    inputs: [{ name: "in", type: "sketch2d" }],
    output: "sketch2d",
    params: [
      { name: "tx", kind: "number", default: 0, min: -300, max: 300, step: 0.5 },
      { name: "ty", kind: "number", default: 0, min: -300, max: 300, step: 0.5 },
      { name: "rotate", kind: "number", label: "rotate°", default: 0, min: -360, max: 360, step: 1 },
      { name: "scale", kind: "number", default: 1, min: 0.05, max: 20, step: 0.05 },
    ],
  },
  arrayLinear2d: {
    type: "arrayLinear2d",
    label: "Array Linear 2D",
    inputs: [{ name: "in", type: "sketch2d" }],
    output: "sketch2d",
    params: [
      { name: "count", kind: "number", default: 3, min: 1, max: 200, step: 1 },
      { name: "dx", kind: "number", default: 25, min: -300, max: 300, step: 0.5 },
      { name: "dy", kind: "number", default: 0, min: -300, max: 300, step: 0.5 },
    ],
  },
  arrayRadial2d: {
    type: "arrayRadial2d",
    label: "Array Radial 2D",
    inputs: [{ name: "in", type: "sketch2d" }],
    output: "sketch2d",
    params: [
      { name: "count", kind: "number", default: 6, min: 1, max: 200, step: 1 },
      { name: "radius", kind: "number", default: 40, min: 0, max: 300, step: 1 },
      { name: "angle", kind: "number", label: "total°", default: 360, min: -360, max: 360, step: 1 },
    ],
  },
  box: {
    type: "box",
    label: "Box 3D",
    inputs: [],
    output: "solid",
    params: [
      { name: "x", kind: "number", default: 30, min: 1, max: 300, step: 1 },
      { name: "y", kind: "number", default: 30, min: 1, max: 300, step: 1 },
      { name: "z", kind: "number", default: 30, min: 1, max: 300, step: 1 },
    ],
    selectionOutputs: [
      { name: "top", target: "face" },
      { name: "bottom", target: "face" },
      { name: "left", target: "face" },
      { name: "right", target: "face" },
      { name: "front", target: "face" },
      { name: "back", target: "face" },
      { name: "verticalEdges", target: "edge" },
      { name: "topEdges", target: "edge" },
    ],
  },
  cylinder: {
    type: "cylinder",
    label: "Cylinder 3D",
    inputs: [],
    output: "solid",
    params: [
      { name: "radius", kind: "number", default: 15, min: 0.5, max: 200, step: 0.5 },
      { name: "height", kind: "number", default: 30, min: 1, max: 300, step: 1 },
    ],
    selectionOutputs: [
      { name: "cap", target: "face" },
      { name: "bottom", target: "face" },
      { name: "side", target: "face" },
      { name: "capEdges", target: "edge" },
    ],
  },
  sphere: {
    type: "sphere",
    label: "Sphere 3D",
    inputs: [],
    output: "solid",
    params: [{ name: "radius", kind: "number", default: 20, min: 0.5, max: 200, step: 0.5 }],
  },
  cone: {
    type: "cone",
    label: "Cone 3D",
    inputs: [],
    output: "solid",
    params: [
      { name: "radius", kind: "number", default: 15, min: 0.5, max: 200, step: 0.5 },
      { name: "height", kind: "number", default: 30, min: 1, max: 300, step: 1 },
    ],
  },
  torus: {
    type: "torus",
    label: "Torus 3D",
    inputs: [],
    output: "solid",
    params: [
      { name: "radius", kind: "number", label: "major", default: 25, min: 1, max: 200, step: 0.5 },
      { name: "tube", kind: "number", label: "minor", default: 7, min: 0.5, max: 100, step: 0.5 },
    ],
  },
  revolve: {
    type: "revolve",
    label: "Revolve",
    inputs: [{ name: "in", type: "sketch2d" }],
    output: "solid",
    params: [{ name: "angle", kind: "number", label: "angle°", default: 360, min: 1, max: 360, step: 1 }],
    selectionOutputs: [
      { name: "top", target: "face" },
      { name: "bottom", target: "face" },
      { name: "side", target: "face" },
    ],
  },
  loft: {
    type: "loft",
    label: "Loft",
    inputs: [
      { name: "bottom", type: "sketch2d" },
      { name: "top", type: "sketch2d" },
    ],
    output: "solid",
    params: [{ name: "height", kind: "number", default: 30, min: 1, max: 300, step: 1 }],
  },
  loftSections: {
    type: "loftSections",
    label: "Loft sections",
    // 2–4 stacked profiles (s0 = bottom … up), evenly spaced over `height`
    inputs: [
      { name: "s0", type: "sketch2d" },
      { name: "s1", type: "sketch2d" },
      { name: "s2", type: "sketch2d" },
      { name: "s3", type: "sketch2d" },
    ],
    output: "solid",
    params: [{ name: "height", kind: "number", default: 60, min: 1, max: 400, step: 1 }],
  },
  sweep: {
    type: "sweep",
    label: "Sweep",
    // sweep a cross-section `profile` along a `path` spine (path rises in Z)
    inputs: [
      { name: "profile", type: "sketch2d" },
      { name: "path", type: "sketch2d" },
    ],
    output: "solid",
    params: [],
  },
  boolean3d: {
    type: "boolean3d",
    label: "Boolean 3D",
    // difference = base − tool
    inputs: [
      { name: "base", type: "solid" },
      { name: "tool", type: "solid" },
    ],
    output: "solid",
    params: [{ name: "op", kind: "select", default: "union", options: ["union", "difference", "intersection"] }],
  },
  mirror3d: {
    type: "mirror3d",
    label: "Mirror 3D",
    inputs: [{ name: "in", type: "solid" }],
    output: "solid",
    params: [{ name: "plane", kind: "select", default: "YZ", options: ["XY", "XZ", "YZ"] }],
  },
  rotate3d: {
    type: "rotate3d",
    label: "Rotate 3D",
    inputs: [{ name: "in", type: "solid" }],
    output: "solid",
    params: [
      { name: "angle", kind: "number", label: "angle°", default: 45, min: -360, max: 360, step: 1 },
      { name: "axis", kind: "select", default: "Z", options: ["X", "Y", "Z"] },
    ],
  },
  scale3d: {
    type: "scale3d",
    label: "Scale 3D",
    inputs: [{ name: "in", type: "solid" }],
    output: "solid",
    params: [{ name: "factor", kind: "number", default: 1.5, min: 0.05, max: 20, step: 0.05 }],
  },
  arrayLinear3d: {
    type: "arrayLinear3d",
    label: "Array Linear 3D",
    inputs: [{ name: "in", type: "solid" }],
    output: "solid",
    params: [
      { name: "count", kind: "number", default: 3, min: 1, max: 100, step: 1 },
      { name: "dx", kind: "number", default: 40, min: -300, max: 300, step: 1 },
      { name: "dy", kind: "number", default: 0, min: -300, max: 300, step: 1 },
      { name: "dz", kind: "number", default: 0, min: -300, max: 300, step: 1 },
    ],
  },
  arrayRadial3d: {
    type: "arrayRadial3d",
    label: "Array Radial 3D",
    inputs: [{ name: "in", type: "solid" }],
    output: "solid",
    params: [
      { name: "count", kind: "number", default: 6, min: 1, max: 100, step: 1 },
      { name: "angle", kind: "number", label: "total°", default: 360, min: -360, max: 360, step: 1 },
    ],
  },
  textToSvg: {
    type: "textToSvg",
    label: "Text → SVG",
    inputs: [],
    output: "sketch2d",
    params: [
      { name: "text", kind: "text", label: "text", default: "AB" },
      { name: "size", kind: "number", label: "size", default: 72, min: 4, max: 400, step: 1 },
      { name: "font", kind: "font", label: "font (.ttf/.otf)" },
    ],
  },
  offset2d: {
    type: "offset2d",
    label: "Offset 2D",
    inputs: [{ name: "in", type: "sketch2d" }],
    output: "sketch2d",
    params: [{ name: "distance", kind: "number", default: 0, min: -20, max: 20, step: 0.5 }],
  },
  kerf: {
    type: "kerf",
    label: "Kerf comp",
    inputs: [{ name: "in", type: "sketch2d" }],
    output: "sketch2d",
    params: [
      { name: "kerf", kind: "number", label: "kerf (mm)", default: 0.15, min: 0, max: 3, step: 0.01 },
      { name: "mode", kind: "select", default: "outer", options: ["outer", "inner"] },
    ],
  },
  scoreCut: {
    type: "scoreCut",
    label: "Score / Cut",
    // cut = through-cut outline (red); score = fold/engrave lines (blue).
    inputs: [
      { name: "cut", type: "sketch2d" },
      { name: "score", type: "sketch2d" },
    ],
    output: "sketch2d",
    params: [],
  },
  group: {
    type: "group",
    label: "Group 2D",
    // up to four profiles unioned into one — connect as many as you need,
    // then Offset the group so overlaps are resolved as a single outline.
    inputs: [
      { name: "a", type: "sketch2d" },
      { name: "b", type: "sketch2d" },
      { name: "c", type: "sketch2d" },
      { name: "d", type: "sketch2d" },
    ],
    output: "sketch2d",
    params: [],
  },
  extrude: {
    type: "extrude",
    label: "Extrude",
    inputs: [{ name: "in", type: "sketch2d" }],
    output: "solid",
    params: [{ name: "height", kind: "number", default: 10, min: 1, max: 100, step: 1 }],
    selectionOutputs: [
      { name: "cap", target: "face" },
      { name: "bottom", target: "face" },
      { name: "sideEdges", target: "edge" },
      { name: "capEdges", target: "edge" },
      { name: "bottomEdges", target: "edge" },
    ],
  },
  edgeSelect: {
    type: "edgeSelect",
    label: "Edge Select",
    inputs: [],
    output: "selection",
    params: [
      { name: "where", kind: "select", default: "vertical", options: ["all", "vertical", "horizontal-x", "horizontal-y", "atZ"] },
      { name: "offset", kind: "number", label: "atZ offset", default: 0, min: -300, max: 300, step: 0.5 },
    ],
  },
  faceSelect: {
    type: "faceSelect",
    label: "Face Select",
    inputs: [],
    output: "selection",
    params: [
      { name: "where", kind: "select", default: "top", options: ["all", "top", "bottom", "horizontal", "vertical-x", "vertical-y", "planar", "cylindrical"] },
      { name: "offset", kind: "number", label: "top/bottom Z", default: 0, min: -300, max: 300, step: 0.5 },
    ],
  },
  fillet: {
    type: "fillet",
    label: "Fillet",
    inputs: [
      { name: "in", type: "solid" },
      { name: "sel", type: "selection" },
    ],
    output: "solid",
    params: [{ name: "radius", kind: "number", default: 2, min: 0, max: 50, step: 0.5 }],
  },
  bevel: {
    type: "bevel",
    label: "Bevel",
    inputs: [
      { name: "in", type: "solid" },
      { name: "sel", type: "selection" },
    ],
    output: "solid",
    params: [{ name: "distance", kind: "number", default: 2, min: 0, max: 50, step: 0.5 }],
  },
  shell: {
    type: "shell",
    label: "Shell / Hollow",
    inputs: [
      { name: "in", type: "solid" },
      { name: "faces", type: "selection" },
    ],
    output: "solid",
    params: [{ name: "thickness", kind: "number", default: 2, min: 0.2, max: 50, step: 0.2 }],
  },
  fillet2d: {
    type: "fillet2d",
    label: "Fillet 2D",
    inputs: [{ name: "in", type: "sketch2d" }],
    output: "sketch2d",
    params: [{ name: "radius", kind: "number", default: 3, min: 0, max: 100, step: 0.5 }],
  },
  bevel2d: {
    type: "bevel2d",
    label: "Bevel 2D",
    inputs: [{ name: "in", type: "sketch2d" }],
    output: "sketch2d",
    params: [{ name: "distance", kind: "number", default: 3, min: 0, max: 100, step: 0.5 }],
  },
  transform: {
    type: "transform",
    label: "Transform",
    inputs: [{ name: "in", type: "solid" }],
    output: "solid",
    params: [
      { name: "tx", kind: "number", label: "move X", default: 0, min: -100, max: 100, step: 0.5 },
      { name: "ty", kind: "number", label: "move Y", default: 0, min: -100, max: 100, step: 0.5 },
      { name: "tz", kind: "number", label: "move Z", default: 0, min: -100, max: 100, step: 0.5 },
    ],
  },
  bossOnCap: {
    type: "bossOnCap",
    label: "Boss on cap",
    inputs: [
      { name: "in", type: "solid" },
      { name: "profile", type: "sketch2d" },
    ],
    output: "solid",
    params: [
      { name: "height", kind: "number", default: 8, min: 1, max: 40, step: 1 },
      { name: "shrink", kind: "number", default: 10, min: 1, max: 30, step: 0.5 },
    ],
    selectionOutputs: [
      { name: "top", target: "face" },
      { name: "bottom", target: "face" },
      { name: "bossSide", target: "face" },
      { name: "topEdges", target: "edge" },
    ],
  },
  tessellate: {
    type: "tessellate",
    label: "Tessellate",
    inputs: [{ name: "in", type: "solid" }],
    output: "mesh",
    params: [],
  },
  importSTL: {
    type: "importSTL",
    label: "Import STL",
    inputs: [],
    output: "mesh",
    params: [{ name: "stl", kind: "stl", label: "file" }],
  },
  repair: {
    type: "repair",
    label: "Repair",
    inputs: [{ name: "in", type: "mesh" }],
    output: "mesh",
    params: [],
  },
  boolean: {
    type: "boolean",
    label: "Boolean",
    // difference = base − tool
    inputs: [
      { name: "base", type: "mesh" },
      { name: "tool", type: "mesh" },
    ],
    output: "mesh",
    params: [
      {
        name: "op",
        kind: "select",
        default: "difference",
        options: ["union", "difference", "intersection"],
      },
    ],
  },
  transformMesh: {
    type: "transformMesh",
    label: "Transform Mesh",
    inputs: [{ name: "in", type: "mesh" }],
    output: "mesh",
    params: [
      { name: "tx", kind: "number", default: 0, min: -300, max: 300, step: 0.5 },
      { name: "ty", kind: "number", default: 0, min: -300, max: 300, step: 0.5 },
      { name: "tz", kind: "number", default: 0, min: -300, max: 300, step: 0.5 },
      { name: "rx", kind: "number", label: "rot X°", default: 0, min: -360, max: 360, step: 1 },
      { name: "ry", kind: "number", label: "rot Y°", default: 0, min: -360, max: 360, step: 1 },
      { name: "rz", kind: "number", label: "rot Z°", default: 0, min: -360, max: 360, step: 1 },
      { name: "scale", kind: "number", default: 1, min: 0.05, max: 20, step: 0.05 },
    ],
  },
  convexHull: {
    type: "convexHull",
    label: "Convex Hull",
    inputs: [{ name: "in", type: "mesh" }],
    output: "mesh",
    params: [],
  },
  minkowski: {
    type: "minkowski",
    label: "Minkowski (round)",
    inputs: [
      { name: "a", type: "mesh" },
      { name: "b", type: "mesh" },
    ],
    output: "mesh",
    params: [],
  },
  decimate: {
    type: "decimate",
    label: "Decimate",
    inputs: [{ name: "in", type: "mesh" }],
    output: "mesh",
    params: [{ name: "tolerance", kind: "number", default: 0.1, min: 0.001, max: 10, step: 0.01 }],
  },
  subdivide: {
    type: "subdivide",
    label: "Subdivide",
    inputs: [{ name: "in", type: "mesh" }],
    output: "mesh",
    params: [{ name: "n", kind: "number", default: 2, min: 1, max: 6, step: 1 }],
  },
};
