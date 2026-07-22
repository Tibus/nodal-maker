/**
 * Node metadata — the single source of truth the visual editor reads to render
 * ports, params and edge types. Deliberately DEPENDENCY-FREE (no replicad, no
 * Manifold): it must be importable on the UI/main thread without dragging the
 * heavy WASM kernels into that bundle. The runtime node implementations live in
 * `nodes.ts`; the socket-type strings here must stay in sync with
 * `GraphValue["kind"]` there.
 */

export type SocketType = "sketch2d" | "solid" | "mesh";

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
};

export const NODE_SPECS: Record<string, NodeSpec> = {
  svgInput: {
    type: "svgInput",
    label: "SVG input",
    inputs: [],
    output: "sketch2d",
    params: [{ name: "d", kind: "text", label: "path d", default: "" }],
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
  extrude: {
    type: "extrude",
    label: "Extrude",
    inputs: [{ name: "in", type: "sketch2d" }],
    output: "solid",
    params: [{ name: "height", kind: "number", default: 10, min: 1, max: 100, step: 1 }],
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
