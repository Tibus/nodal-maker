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
  kind: "number" | "text" | "select" | "stl" | "step" | "font" | "sketch";
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

/** Human name + one-line meaning per socket type — for the port hover tooltip. */
export const SOCKET_LABELS: Record<SocketType, { name: string; desc: string }> = {
  sketch2d: { name: "2D profile", desc: "A flat outline (purple). Feeds Extrude, Revolve, Offset, Boolean 2D, SVG/DXF export…" },
  solid: { name: "Solid (B-rep)", desc: "A CAD solid (orange). Fillet, Shell, Boolean 3D, exposed selections, STEP/STL export." },
  mesh: { name: "Mesh", desc: "A triangle mesh (cyan). Manifold booleans, repair, hull, STL export." },
  number: { name: "Number", desc: "A scalar value (green). Drives a parameter port." },
  text: { name: "Text", desc: "A text string (yellow). E.g. for Text → SVG." },
  selection: { name: "Selection", desc: "A set of faces or edges (amber). Feeds Fillet, Bevel or Shell." },
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

/** One-line explanation per node, shown in the palette hover tooltip. */
export const NODE_DESCRIPTIONS: Record<string, string> = {
  numberValue: "A constant number. Wire it into any numeric parameter port.",
  textValue: "A constant text string (e.g. for Text → SVG).",
  math: "Combine two numbers: add, subtract, multiply, divide, power, modulo, min, max.",
  mathUnary: "One-input math: negate, abs, sqrt, sin/cos/tan, round, floor, ceil.",
  clamp: "Constrain a number between a min and a max.",
  remap: "Rescale a number from an input range to an output range.",
  random: "A deterministic pseudo-random number from a seed, within a range.",
  sketch: "A constraint-based 2D sketch (Fusion-style). Draw lines/arcs/circles/splines, add geometric constraints and driving dimensions — the dimensions become editable node parameters. Feeds Extrude/Revolve.",
  rect: "A rectangle profile, with optional rounded corners.",
  circle: "A circle profile of the given radius.",
  ellipse: "An ellipse profile from its two radii.",
  polygon: "A regular polygon (hexagon, pentagon…) from radius + side count.",
  star: "A star profile from outer/inner radii and point count.",
  slot: "A rounded slot (stadium) profile.",
  gear: "A spur-gear silhouette (trapezoidal teeth) — for laser or as an extrude profile.",
  fingerBox: "Flat pattern for a press-fit finger-joint box (5 or 6 panels) — laser cutting.",
  svgInput: "Import a 2D profile from an SVG path 'd' string.",
  textToSvg: "Convert text to a 2D profile using a chosen font.",
  offset2d: "Grow (or shrink, if negative) a profile outline by a distance.",
  kerf: "Laser kerf compensation — grow an outline or shrink a hole by half the beam width.",
  fillet2d: "Round the corners of a 2D profile.",
  bevel2d: "Chamfer (flatten) the corners of a 2D profile.",
  boolean2d: "Combine two profiles: union, difference (base − tool) or intersection.",
  mirror2d: "Mirror a profile across the X or Y axis.",
  transform2d: "Move, rotate and scale a 2D profile.",
  arrayLinear2d: "Repeat a profile in a line (count + step).",
  arrayRadial2d: "Repeat a profile around a circle.",
  group: "Union up to four profiles into one outline.",
  scoreCut: "Layer a cut outline (red) and score/fold lines (blue) for laser export.",
  box: "A rectangular box. Exposes its 6 faces + edges as selection ports.",
  cylinder: "A cylinder. Exposes cap / bottom / side + cap edges.",
  sphere: "A sphere of the given radius.",
  cone: "A cone from base radius + height.",
  torus: "A torus (donut) from major + minor radii.",
  thread: "Thread a cylinder (Fusion-style modifier). Pick a standard (M3…M24) or set a custom Ø/pitch; wire a cylinder to inherit its size. Analytic B-rep — STEP-exportable.",
  internalThread: "Cut a mating internal thread (nut) into a solid body's bore. Feed a block/hex prism; pick a standard + clearance. Analytic B-rep — STEP-exportable.",
  importSTEP: "Import a STEP file (what Fusion 360 / SolidWorks export) as an editable B-rep solid.",
  extrude: "Extrude a 2D profile into a solid. Exposes cap / bottom / side edges.",
  pocket: "Cut a pocket / hole into a solid by extruding a profile and subtracting it. The partner to \"Sketch on face\": draw on a face, then carve it out. Blind (depth) or through-all.",
  hole: "Parametric hole placed by (x,y) on a base plane: simple, counterbore or countersink, through or blind. Pattern it with Array Linear/Radial 3D for multiple holes.",
  revolve: "Revolve a profile around the Z axis into a solid.",
  loft: "Loft between a bottom and a top profile.",
  loftSections: "Loft through 2–4 stacked profiles for variable cross-sections.",
  sweep: "Sweep a cross-section profile along a path.",
  bossOnCap: "Add a raised boss on a solid's top cap from a shrunk profile.",
  transform: "Move a solid in X/Y/Z. Editable with the 3D gizmo.",
  rotate3d: "Rotate a solid about an axis. Editable with the gizmo.",
  scale3d: "Uniformly scale a solid. Editable with the gizmo.",
  mirror3d: "Mirror a solid across the XY, XZ or YZ plane.",
  fillet: "Round edges of a solid. Feed a selection to target specific edges.",
  bevel: "Chamfer edges of a solid. Feed a selection to target specific edges.",
  shell: "Hollow a solid, opening the selected face(s).",
  hollow: "Resin hollowing: closed thin-walled shell + vertical drain holes through the bottom so uncured resin escapes (no sealed cavity).",
  split: "Cut a solid by an axis-aligned plane (for parts bigger than the build plate). Keep one side or both halves (pushed apart by a gap).",
  boolean3d: "Combine two solids: union, difference (base − tool) or intersection.",
  assemble: "Assemble up to 4 solids into one compound (no Boolean). Use for a bolt (head + thread) where a real union would hang on the thread.",
  arrayLinear3d: "Repeat a solid in a line.",
  arrayRadial3d: "Repeat a solid around the X, Y or Z axis (polar pattern); fuse into one body or keep as a compound.",
  edgeSelect: "Select edges by criteria (vertical, horizontal, or in a plane) for fillet/bevel.",
  faceSelect: "Select faces by criteria (top, planar, cylindrical, in a plane) for shell/fillet.",
  tessellate: "Convert a B-rep solid to a triangle mesh (auto-inserted when needed).",
  importSTL: "Import a binary STL file as a mesh.",
  repair: "Weld a triangle soup into a clean manifold mesh.",
  meshToSolid: "Sew a mesh into a B-rep solid (faceted, heavy). Use to STEP-export a Thread or feed it into a solid Boolean.",
  boolean: "Robust mesh boolean (union / difference / intersection) via Manifold.",
  transformMesh: "Move, rotate and scale a mesh.",
  convexHull: "The convex hull that wraps a mesh.",
  minkowski: "Minkowski sum of two meshes — rounds/inflates shape A by shape B.",
  decimate: "Simplify a mesh, reducing triangle count within a tolerance.",
  subdivide: "Refine a mesh, adding triangles for smoother curvature.",
};

/** Ordered palette categories (drives the grouped palette + search). */
export const NODE_CATEGORIES: { name: string; types: string[] }[] = [
  { name: "Value", types: ["numberValue", "textValue", "math", "mathUnary", "clamp", "remap", "random"] },
  { name: "2D Primitive", types: ["sketch", "rect", "circle", "ellipse", "polygon", "star", "slot", "gear", "fingerBox", "svgInput", "textToSvg"] },
  { name: "2D Op", types: ["offset2d", "kerf", "fillet2d", "bevel2d", "boolean2d", "mirror2d", "transform2d", "arrayLinear2d", "arrayRadial2d", "group", "scoreCut"] },
  { name: "3D Primitive", types: ["box", "cylinder", "sphere", "cone", "torus", "thread", "internalThread", "importSTEP"] },
  { name: "Sketch → Solid", types: ["extrude", "pocket", "hole", "revolve", "loft", "loftSections", "sweep", "bossOnCap"] },
  { name: "3D Op", types: ["transform", "rotate3d", "scale3d", "mirror3d", "fillet", "bevel", "shell", "hollow", "split", "boolean3d", "assemble", "arrayLinear3d", "arrayRadial3d"] },
  { name: "Selector", types: ["edgeSelect", "faceSelect"] },
  { name: "Mesh", types: ["tessellate", "meshToSolid", "importSTL", "repair", "boolean", "transformMesh", "convexHull", "minkowski", "decimate", "subdivide"] },
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
  sketch: {
    type: "sketch",
    label: "Sketch",
    inputs: [],
    output: "sketch2d",
    // `doc` holds the whole constraint sketch (edited via the 2D editor).
    // `plane` places it in 3D. Driving dimensions surface as extra params
    // dynamically (rendered by the editor from the doc).
    params: [
      { name: "plane", kind: "select", label: "plane", default: "XY", options: ["XY", "XZ", "YZ"] },
      { name: "doc", kind: "sketch", label: "sketch", default: null },
    ],
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
  thread: {
    type: "thread",
    label: "Thread",
    // Fusion-style thread modifier. Wire a cylinder into `in` to thread it (Ø +
    // length read from the cylinder); a `standard` preset (M3…M24) fills the
    // pitch. Standalone (no input) makes a threaded rod. Output is an analytic
    // B-rep (STEP-exportable). For a nut, tessellate it then mesh-Boolean it from
    // a block (OCCT booleans on helical faces hang, so use the mesh path).
    inputs: [{ name: "in", type: "solid" }],
    output: "solid",
    params: [
      { name: "standard", kind: "select", default: "M20", options: ["custom", "M2", "M2.5", "M3", "M4", "M5", "M6", "M8", "M10", "M12", "M14", "M16", "M20", "M24"] },
      { name: "diameter", kind: "number", label: "Ø major (custom)", default: 20, min: 2, max: 120, step: 0.5 },
      { name: "pitch", kind: "number", label: "pitch (custom)", default: 2.5, min: 0.3, max: 10, step: 0.05 },
      { name: "length", kind: "number", default: 30, min: 3, max: 300, step: 1 },
      { name: "hand", kind: "select", default: "right", options: ["right", "left"] },
    ],
  },
  internalThread: {
    type: "internalThread",
    label: "Internal thread (nut)",
    // cut a mating internal thread into a solid body (its central bore, along Z).
    // Bore = simple boolean; inward helical ridges added as a compound → analytic
    // B-rep, no helical boolean. Feed a hex prism / block centred on the axis.
    inputs: [{ name: "in", type: "solid" }],
    output: "solid",
    params: [
      { name: "standard", kind: "select", default: "M16", options: ["custom", "M2", "M2.5", "M3", "M4", "M5", "M6", "M8", "M10", "M12", "M14", "M16", "M20", "M24"] },
      { name: "diameter", kind: "number", label: "Ø nominal (custom)", default: 16, min: 2, max: 120, step: 0.5 },
      { name: "pitch", kind: "number", label: "pitch (custom)", default: 2, min: 0.3, max: 10, step: 0.05 },
      { name: "clearance", kind: "number", label: "clearance", default: 0.4, min: 0, max: 2, step: 0.05 },
      { name: "hand", kind: "select", default: "right", options: ["right", "left"] },
    ],
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
  assemble: {
    type: "assemble",
    label: "Assemble",
    // combine up to 4 solids into one compound (no boolean) — e.g. bolt = head +
    // thread, where a real Boolean would hang on the helical faces.
    inputs: [
      { name: "a", type: "solid" },
      { name: "b", type: "solid" },
      { name: "c", type: "solid" },
      { name: "d", type: "solid" },
    ],
    output: "solid",
    params: [],
  },
  mirror3d: {
    type: "mirror3d",
    label: "Mirror 3D",
    inputs: [{ name: "in", type: "solid" }],
    output: "solid",
    params: [
      { name: "plane", kind: "select", default: "YZ", options: ["XY", "XZ", "YZ"] },
      { name: "keep", kind: "select", label: "keep original", default: "no", options: ["no", "yes"] },
    ],
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
      { name: "axis", kind: "select", default: "Z", options: ["X", "Y", "Z"] },
      { name: "merge", kind: "select", label: "fuse", default: "yes", options: ["yes", "no"] },
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
    params: [
      { name: "height", kind: "number", default: 10, min: 1, max: 100, step: 1 },
      { name: "mode", kind: "select", label: "direction", default: "up", options: ["up", "down", "symmetric"] },
      { name: "taper", kind: "number", label: "taper (top scale)", default: 1, min: 0.1, max: 3, step: 0.05 },
      { name: "twist", kind: "number", label: "twist (°)", default: 0, min: -360, max: 360, step: 5 },
    ],
    selectionOutputs: [
      { name: "cap", target: "face" },
      { name: "bottom", target: "face" },
      { name: "sideEdges", target: "edge" },
      { name: "capEdges", target: "edge" },
      { name: "bottomEdges", target: "edge" },
    ],
  },
  pocket: {
    type: "pocket",
    label: "Pocket / Cut",
    inputs: [{ name: "in", type: "solid" }, { name: "profile", type: "sketch2d" }],
    output: "solid",
    params: [
      { name: "depth", kind: "number", default: 10, min: 0.1, max: 300, step: 1 },
      { name: "mode", kind: "select", default: "blind", options: ["blind", "through"] },
      { name: "direction", kind: "select", default: "down", options: ["down", "up", "both"] },
    ],
  },
  hole: {
    type: "hole",
    label: "Hole",
    inputs: [{ name: "in", type: "solid" }],
    output: "solid",
    params: [
      { name: "plane", kind: "select", default: "XY", options: ["XY", "XZ", "YZ"] },
      { name: "offset", kind: "number", label: "face offset", default: 0, min: -300, max: 300, step: 1 },
      { name: "x", kind: "number", default: 0, min: -300, max: 300, step: 1 },
      { name: "y", kind: "number", default: 0, min: -300, max: 300, step: 1 },
      { name: "diameter", kind: "number", default: 6, min: 0.5, max: 200, step: 0.5 },
      { name: "depth", kind: "number", default: 20, min: 0.5, max: 300, step: 1 },
      { name: "mode", kind: "select", default: "through", options: ["through", "blind"] },
      { name: "type", kind: "select", default: "simple", options: ["simple", "counterbore", "countersink"] },
      { name: "headDia", kind: "number", label: "head Ø", default: 12, min: 0.5, max: 200, step: 0.5 },
      { name: "headDepth", kind: "number", label: "cbore depth", default: 4, min: 0.1, max: 100, step: 0.5 },
      { name: "headAngle", kind: "number", label: "csink °", default: 90, min: 30, max: 179, step: 1 },
    ],
  },
  edgeSelect: {
    type: "edgeSelect",
    label: "Edge Select",
    inputs: [],
    output: "selection",
    params: [
      { name: "where", kind: "select", default: "vertical", options: ["all", "vertical", "horizontal-x", "horizontal-y", "atZ", "atX", "atY"] },
      { name: "offset", kind: "number", label: "plane offset", default: 0, min: -300, max: 300, step: 0.5 },
    ],
  },
  faceSelect: {
    type: "faceSelect",
    label: "Face Select",
    inputs: [],
    output: "selection",
    params: [
      { name: "where", kind: "select", default: "top", options: ["all", "top", "bottom", "atZ", "atX", "atY", "horizontal", "vertical-x", "vertical-y", "planar", "cylindrical"] },
      { name: "offset", kind: "number", label: "plane offset", default: 0, min: -300, max: 300, step: 0.5 },
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
  split: {
    type: "split",
    label: "Split by plane",
    inputs: [{ name: "in", type: "solid" }],
    output: "solid",
    params: [
      { name: "axis", kind: "select", default: "Z", options: ["X", "Y", "Z"] },
      { name: "offset", kind: "number", label: "plane at", default: 0, min: -300, max: 300, step: 1 },
      { name: "keep", kind: "select", default: "positive", options: ["positive", "negative", "both"] },
      { name: "gap", kind: "number", label: "gap (both)", default: 0, min: 0, max: 200, step: 1 },
    ],
  },
  hollow: {
    type: "hollow",
    label: "Hollow (resin)",
    inputs: [{ name: "in", type: "solid" }],
    output: "solid",
    params: [
      { name: "wall", kind: "number", label: "wall thickness", default: 2, min: 0.4, max: 20, step: 0.1 },
      { name: "drainDia", kind: "number", label: "drain Ø", default: 3, min: 0, max: 30, step: 0.5 },
      { name: "drainCount", kind: "number", label: "drain holes", default: 2, min: 0, max: 8, step: 1 },
    ],
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
  importSTEP: {
    type: "importSTEP",
    label: "Import STEP / Fusion",
    // STEP is the neutral CAD format Fusion 360, SolidWorks, etc. export.
    inputs: [],
    output: "solid",
    params: [{ name: "step", kind: "step", label: "file (.step/.stp)" }],
  },
  repair: {
    type: "repair",
    label: "Repair",
    inputs: [{ name: "in", type: "mesh" }],
    output: "mesh",
    params: [],
  },
  meshToSolid: {
    type: "meshToSolid",
    label: "Mesh → Solid",
    // sew a mesh into a B-rep solid (faceted, heavy) — e.g. to STEP-export a
    // Thread or feed it into a solid Boolean.
    inputs: [{ name: "in", type: "mesh" }],
    output: "solid",
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
