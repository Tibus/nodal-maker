/**
 * Node metadata — the single source of truth the visual editor reads to render
 * ports, params and edge types. Deliberately DEPENDENCY-FREE (no replicad, no
 * Manifold): it must be importable on the UI/main thread without dragging the
 * heavy WASM kernels into that bundle. The runtime node implementations live in
 * `nodes.ts`; the socket-type strings here must stay in sync with
 * `GraphValue["kind"]` there.
 */

export type SocketType = "sketch2d" | "solid" | "mesh" | "number" | "text";

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
}

/** Colour per socket type — shared by the editor handles and edge styling. */
export const SOCKET_COLORS: Record<SocketType, string> = {
  sketch2d: "#c678dd", // purple — 2D profiles
  solid: "#ff8c42", // orange — B-rep solids
  mesh: "#56b6c2", // cyan   — triangle meshes
  number: "#98c379", // green  — scalar numbers
  text: "#e5c07b", // yellow — strings
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
  },
  sphere: {
    type: "sphere",
    label: "Sphere 3D",
    inputs: [],
    output: "solid",
    params: [{ name: "radius", kind: "number", default: 20, min: 0.5, max: 200, step: 0.5 }],
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
  },
  fillet: {
    type: "fillet",
    label: "Fillet",
    inputs: [{ name: "in", type: "solid" }],
    output: "solid",
    params: [{ name: "radius", kind: "number", default: 2, min: 0, max: 50, step: 0.5 }],
  },
  bevel: {
    type: "bevel",
    label: "Bevel",
    inputs: [{ name: "in", type: "solid" }],
    output: "solid",
    params: [{ name: "distance", kind: "number", default: 2, min: 0, max: 50, step: 0.5 }],
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
    inputs: [
      { name: "a", type: "mesh" },
      { name: "b", type: "mesh" },
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
};
