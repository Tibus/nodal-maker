/**
 * Tiny typed node-graph engine + geometry nodes.
 *
 * This is the architectural spike: it shows how a nodal parametric generator
 * would be structured *without* pulling in React Flow yet.
 *
 *  - Values flowing on the wires are TYPED (`sketch2d` | `solid`).
 *  - Nodes are pure functions registered in a table, keyed by `type`.
 *  - A graph is a DAG of node descriptors; we topo-sort and evaluate.
 *
 * The geometry itself runs on replicad (OpenCascade / OCCT B-rep kernel).
 * This module never calls `setOC` — the caller (browser worker or Node smoke
 * test) is responsible for initialising OCCT first. That keeps the graph
 * logic runnable in both environments.
 */
import {
  Drawing,
  Blueprints,
  type Shape3D,
  type EdgeFinder,
  type FaceFinder,
  draw,
  drawRectangle,
  drawCircle,
  drawEllipse,
  drawPolysides,
  makeBaseBox,
  makeCylinder,
  makeSphere,
  makeHelix,
  makeLine,
  assembleWire,
  makeCompound,
  getOC,
  cast,
  Plane as RPlane,
} from "replicad";
import * as opentype from "opentype.js";
import { svgPathToDrawing } from "./svgPath";
import { importDXF } from "./dxfImport";
import {
  booleanMesh,
  repairMesh,
  segmentMesh,
  transformMesh,
  hullMesh,
  minkowskiMesh,
  simplifyMesh,
  refineMesh,
  type BooleanOp,
  type MeshData,
} from "./manifold";
import { parseBinarySTL, writeBinarySTL } from "./stl";
import { cloneDoc, dimensions, type SketchDoc } from "../sketch/model";
import { toNumber } from "./expr";
import { solve as solveSketch } from "../sketch/solver";
import { buildDrawing } from "../sketch/build";

/* ------------------------------------------------------------------ */
/* Typed values that travel along the graph edges                      */
/* ------------------------------------------------------------------ */

export type GraphValue =
  // `plane`/`planeOffset` (optional) record which base plane (and offset along
  // its normal) a Sketch was drawn on, so the 3D preview and Extrude/Revolve
  // place it there instead of always on XY z=0.
  | { kind: "sketch2d"; drawing: Drawing; plane?: "XY" | "XZ" | "YZ"; planeOffset?: number; frame?: SketchFrame }
  | { kind: "solid"; solid: Shape3D }
  | { kind: "mesh"; mesh: MeshData }
  | { kind: "number"; value: number }
  | { kind: "text"; value: string }
  // a criteria-based face/edge selection — resolved against whatever geometry
  // the fillet/bevel/shell receives, so it survives regeneration.
  | { kind: "selection"; target: "edge" | "face"; apply: (finder: unknown) => unknown };

/* ------------------------------------------------------------------ */
/* Graph description                                                   */
/* ------------------------------------------------------------------ */

export interface NodeDescriptor {
  id: string;
  type: string;
  /** map of input-port-name -> id of the node feeding it */
  inputs?: Record<string, string>;
  params?: Record<string, unknown>;
}

export type Graph = NodeDescriptor[];

type NodeImpl = (
  inputs: Record<string, GraphValue>,
  params: Record<string, unknown>,
) => GraphValue;

// Node metadata (ports, params, socket colours) lives dependency-free in
// `specs.ts` so the editor can import it without pulling in the WASM kernels.
import { NODE_SPECS, paramPortType, type SocketType } from "./specs";
export type { SocketType, PortSpec, ParamSpec, NodeSpec } from "./specs";
export { NODE_SPECS, SOCKET_COLORS } from "./specs";

/**
 * Split a node's evaluated inputs into structural inputs (sketch/solid/mesh
 * ports) and scalar param overrides (number/text ports). A param whose port is
 * wired takes the upstream value; otherwise the node keeps its inline default.
 */
function resolveInputs(
  nodeType: string,
  rawInputs: Record<string, GraphValue>,
  params: Record<string, unknown>,
  vars: Record<string, number> = {},
): { inputs: Record<string, GraphValue>; params: Record<string, unknown> } {
  const spec = NODE_SPECS[nodeType];
  if (!spec) return { inputs: rawInputs, params };
  const paramPorts = new Map<string, SocketType | null>(
    spec.params.map((p) => [p.name, paramPortType(p)] as const).filter(([, t]) => t !== null),
  );
  const numberParams = new Set(spec.params.filter((p) => p.kind === "number").map((p) => p.name));
  // a Sketch node's driving dimensions are dynamic number param ports
  if (nodeType === "sketch") {
    const raw = params.doc;
    const doc = raw && typeof raw === "object" ? (raw as SketchDoc) : typeof raw === "string" && raw ? (JSON.parse(raw) as SketchDoc) : null;
    if (doc?.constraints) for (const dim of dimensions(doc)) { paramPorts.set(dim.name, "number"); numberParams.add(dim.name); }
  }
  const inputs: Record<string, GraphValue> = {};
  const merged: Record<string, unknown> = { ...params };
  for (const [port, v] of Object.entries(rawInputs)) {
    if (paramPorts.has(port)) {
      if (v.kind === "number" || v.kind === "text") merged[port] = v.value;
      else throw new Error(`[${nodeType}] param port "${port}" expects a ${paramPorts.get(port)}, got ${v.kind}`);
    } else {
      inputs[port] = v;
    }
  }
  // evaluate number params that are expressions ("width/2 + 5") using the user
  // parameters. Wired ports already hold numbers, so this only touches inline
  // string values.
  for (const name of numberParams) {
    if (typeof merged[name] === "string") merged[name] = toNumber(merged[name], vars, NaN);
  }
  return { inputs, params: merged };
}

/* ------------------------------------------------------------------ */
/* Exposed selection outputs (modifiers name the geometry they create) */
/*                                                                     */
/* An edge input ref is "srcId" (main output) or "srcId#handle". When  */
/* the handle names a selection port, we build a precise criteria-based */
/* selection from the SOURCE node's type + params — the node that made  */
/* the geometry knows exactly where its cap / sides / edges are. Much   */
/* more precise than a standalone Face/Edge Select.                     */
/* ------------------------------------------------------------------ */

export function parseRef(ref: string): { node: string; handle: string } {
  const i = ref.indexOf("#");
  return i < 0 ? { node: ref, handle: "out" } : { node: ref.slice(0, i), handle: ref.slice(i + 1) };
}

/**
 * A selection expressed as DATA (not an opaque finder closure) so it can be
 * carried through geometry transforms — a face/edge picked on an upstream node
 * still resolves after the geometry is moved / scaled / mirrored downstream.
 */
type Vec3 = [number, number, number];
type Crit =
  | { target: "face"; t: "planeXY"; z: number }
  | { target: "face"; t: "planeYZ"; x: number }
  | { target: "face"; t: "planeXZ"; y: number }
  | { target: "face"; t: "cyl" }
  | { target: "face"; t: "planar" }
  | { target: "face"; t: "parallel"; plane: "XY" | "YZ" | "XZ" }
  | { target: "face"; t: "all" }
  | { target: "edge"; t: "dir"; d: Vec3 }
  | { target: "edge"; t: "planeXY"; z: number }
  | { target: "edge"; t: "planeXZ"; y: number }
  | { target: "edge"; t: "planeYZ"; x: number }
  | { target: "edge"; t: "all" };

// where an extrude's cap / bottom sit along the extrusion axis, per direction
const extrudeCapZ = (p: Record<string, unknown>): number => {
  const h = Number(p.height ?? 1), m = String(p.mode ?? "up");
  return m === "down" ? 0 : m === "symmetric" ? h / 2 : h;
};
const extrudeBottomZ = (p: Record<string, unknown>): number => {
  const h = Number(p.height ?? 1), m = String(p.mode ?? "up");
  return m === "down" ? -h : m === "symmetric" ? -h / 2 : 0;
};
const faceXY = (z: number): Crit => ({ target: "face", t: "planeXY", z });
const faceYZ = (x: number): Crit => ({ target: "face", t: "planeYZ", x });
const faceXZ = (y: number): Crit => ({ target: "face", t: "planeXZ", y });
const faceCyl = (): Crit => ({ target: "face", t: "cyl" });
const edgeDir = (d: Vec3): Crit => ({ target: "edge", t: "dir", d });
const edgeXY = (z: number): Crit => ({ target: "edge", t: "planeXY", z });

// plane-aware helpers: which face/edge crit for an extrude on a given base plane
type Plane = "XY" | "XZ" | "YZ";
const faceOnPlane = (plane: Plane, off: number): Crit =>
  plane === "XZ" ? faceXZ(off) : plane === "YZ" ? faceYZ(off) : faceXY(off);
const edgeOnPlane = (plane: Plane, off: number): Crit =>
  plane === "XZ" ? { target: "edge", t: "planeXZ", y: off } : plane === "YZ" ? { target: "edge", t: "planeYZ", x: off } : edgeXY(off);
const axisDir = (plane: Plane): Vec3 => (plane === "XZ" ? [0, 1, 0] : plane === "YZ" ? [1, 0, 0] : [0, 0, 1]);

/** Compile a crit into the finder-mutating closure that fillet/bevel/shell call. */
function critApply(c: Crit): (finder: unknown) => unknown {
  if (c.target === "face") {
    return (f) => {
      const ff = f as FaceFinder;
      switch (c.t) {
        case "planeXY": return ff.inPlane("XY", c.z);
        case "planeYZ": return ff.inPlane("YZ", c.x);
        case "planeXZ": return ff.inPlane("XZ", c.y);
        case "cyl": return ff.ofSurfaceType("CYLINDRE");
        case "planar": return ff.ofSurfaceType("PLANE");
        case "parallel": return ff.parallelTo(c.plane);
        case "all": return ff;
      }
    };
  }
  return (e) => {
    const ee = e as EdgeFinder;
    switch (c.t) {
      case "dir": return ee.inDirection(c.d);
      case "planeXY": return ee.inPlane("XY", c.z);
      case "planeXZ": return ee.inPlane("XZ", c.y);
      case "planeYZ": return ee.inPlane("YZ", c.x);
      case "all": return ee;
    }
  };
}
const critToSelection = (c: Crit): GraphValue => ({ kind: "selection", target: c.target, apply: critApply(c) });

/** min / max Z of a solid's bounding box — lets ports on nodes whose face
 * heights depend on upstream geometry (revolve, boss) locate their caps. */
function zBounds(solid: Shape3D): { min: number; max: number } {
  const [lo, hi] = solid.boundingBox.bounds;
  return { min: lo[2], max: hi[2] };
}

/**
 * "Leaf" selection ports: handle → crit(params, solid?). `solid` is the evaluated
 * source shape when available, so ports can read its actual bounds instead of
 * guessing from params (needed for revolve / boss, whose caps come from upstream).
 */
type CritBuilder = (p: Record<string, unknown>, solid?: Shape3D, plane?: Plane, offset?: number) => Crit;
const LEAF_PORTS: Record<string, Record<string, CritBuilder>> = {
  extrude: {
    cap: (p, _s, pl = "XY", o = 0) => faceOnPlane(pl, extrudeCapZ(p) + o),
    bottom: (p, _s, pl = "XY", o = 0) => faceOnPlane(pl, extrudeBottomZ(p) + o),
    sideEdges: (_p, _s, pl = "XY") => edgeDir(axisDir(pl)),
    capEdges: (p, _s, pl = "XY", o = 0) => edgeOnPlane(pl, extrudeCapZ(p) + o),
    bottomEdges: (p, _s, pl = "XY", o = 0) => edgeOnPlane(pl, extrudeBottomZ(p) + o),
  },
  box: {
    top: (p) => faceXY(Number(p.z ?? 30)),
    bottom: () => faceXY(0),
    right: (p) => faceYZ(Number(p.x ?? 30) / 2),
    left: (p) => faceYZ(-Number(p.x ?? 30) / 2),
    front: (p) => faceXZ(-Number(p.y ?? 30) / 2),
    back: (p) => faceXZ(Number(p.y ?? 30) / 2),
    verticalEdges: () => edgeDir([0, 0, 1]),
    topEdges: (p) => edgeXY(Number(p.z ?? 30)),
  },
  cylinder: {
    cap: (p) => faceXY(Number(p.height ?? 30)),
    bottom: () => faceXY(0),
    side: () => faceCyl(),
    capEdges: (p) => edgeXY(Number(p.height ?? 30)),
  },
  revolve: {
    top: (_p, s) => faceXY(s ? zBounds(s).max : 0),
    bottom: (_p, s) => faceXY(s ? zBounds(s).min : 0),
    side: () => faceCyl(),
  },
  bossOnCap: {
    top: (_p, s) => faceXY(s ? zBounds(s).max : 0),
    bottom: (_p, s) => faceXY(s ? zBounds(s).min : 0),
    bossSide: () => faceCyl(),
    topEdges: (_p, s) => edgeXY(s ? zBounds(s).max : 0),
  },
};

/** Transform-family nodes a selection can be carried through. Their geometry
 * input is on the `in` port, and each has a closed-form effect on a crit. */
const FORWARD_TYPES = new Set(["transform", "scale3d", "mirror3d", "rotate3d"]);

function translateCrit(c: Crit, dx: number, dy: number, dz: number): Crit {
  if (c.t === "planeXY") return { ...c, z: c.z + dz };
  if (c.target === "face" && c.t === "planeYZ") return { ...c, x: c.x + dx };
  if (c.target === "face" && c.t === "planeXZ") return { ...c, y: c.y + dy };
  return c; // parallel / cyl / planar / dir / all are translation-invariant
}
function scaleCrit(c: Crit, f: number): Crit {
  if (c.t === "planeXY") return { ...c, z: c.z * f };
  if (c.target === "face" && c.t === "planeYZ") return { ...c, x: c.x * f };
  if (c.target === "face" && c.t === "planeXZ") return { ...c, y: c.y * f };
  return c;
}
function mirrorCrit(c: Crit, plane: "XY" | "XZ" | "YZ"): Crit {
  if (c.t === "planeXY") return plane === "XY" ? { ...c, z: -c.z } : c;
  if (c.target === "face" && c.t === "planeYZ") return plane === "YZ" ? { ...c, x: -c.x } : c;
  if (c.target === "face" && c.t === "planeXZ") return plane === "XZ" ? { ...c, y: -c.y } : c;
  if (c.target === "edge" && c.t === "dir") {
    const d: Vec3 = plane === "YZ" ? [-c.d[0], c.d[1], c.d[2]]
      : plane === "XZ" ? [c.d[0], -c.d[1], c.d[2]]
      : [c.d[0], c.d[1], -c.d[2]];
    return { ...c, d };
  }
  return c;
}
/** Z-axis rotation. Returns null for crits that become non-axis-aligned (a
 * tilted plane can't be expressed by `inPlane`), so those ports aren't forwarded. */
function rotateZCrit(c: Crit, angleDeg: number): Crit | null {
  if (c.t === "planeXY" || c.t === "cyl" || c.t === "planar" || c.t === "all") return c;
  if (c.target === "face" && c.t === "parallel" && c.plane === "XY") return c;
  if (c.target === "edge" && c.t === "dir") {
    if (c.d[0] === 0 && c.d[1] === 0) return c; // a Z-aligned edge is invariant
    const a = (angleDeg * Math.PI) / 180;
    const [x, y, z] = c.d;
    return { ...c, d: [x * Math.cos(a) - y * Math.sin(a), x * Math.sin(a) + y * Math.cos(a), z] };
  }
  return null; // planeYZ / planeXZ / parallel-YZ|XZ tilt out of axis alignment
}
function forwardCrit(c: Crit, nodeType: string, p: Record<string, unknown>): Crit | null {
  const n = (k: string, d: number) => Number(p[k] ?? d);
  switch (nodeType) {
    case "transform": return translateCrit(c, n("tx", 0), n("ty", 0), n("tz", 0));
    case "scale3d": return scaleCrit(c, n("factor", 1));
    case "mirror3d": return mirrorCrit(c, String(p.plane ?? "YZ") as "XY" | "XZ" | "YZ");
    case "rotate3d": return String(p.axis ?? "Z") === "Z" ? rotateZCrit(c, n("angle", 0)) : null;
    default: return null;
  }
}

/** Resolve a `node#handle` selection ref to a crit, following it back through
 * any transform-family nodes so the pick tracks the geometry it was taken on. */
function resolveCrit(
  ref: string,
  byId: Map<string, NodeDescriptor>,
  evalNode: (id: string) => GraphValue,
): Crit {
  const { node, handle } = parseRef(ref);
  const src = byId.get(node);
  if (!src) throw new Error(`unknown node "${node}"`);
  const leaf = LEAF_PORTS[src.type]?.[handle];
  if (leaf) {
    const v = evalNode(node);
    // for an extrude, the cap/bottom live on the input sketch's base plane+offset
    let plane: Plane | undefined;
    let offset = 0;
    if (src.type === "extrude" && src.inputs?.in) {
      const inV = evalNode(parseRef(src.inputs.in).node);
      if (inV.kind === "sketch2d") { if (inV.plane) plane = inV.plane; offset = inV.planeOffset ?? 0; }
    }
    return leaf(src.params ?? {}, v.kind === "solid" ? v.solid : undefined, plane, offset);
  }
  if (FORWARD_TYPES.has(src.type)) {
    const inputRef = src.inputs?.in;
    if (!inputRef) throw new Error(`[${src.type}] nothing to forward selection "${handle}" from`);
    const up = resolveCrit(`${parseRef(inputRef).node}#${handle}`, byId, evalNode);
    const out = forwardCrit(up, src.type, src.params ?? {});
    if (!out) throw new Error(`selection "${handle}" can't follow a ${src.type}`);
    return out;
  }
  throw new Error(`no selection port "${handle}" on ${src.type}`);
}

/** Resolve an input ref to its GraphValue, given an evaluator for main outputs. */
function resolveRef(
  ref: string,
  byId: Map<string, NodeDescriptor>,
  evalNode: (id: string) => GraphValue,
): GraphValue {
  const { node, handle } = parseRef(ref);
  if (handle === "out") return evalNode(node);
  return critToSelection(resolveCrit(ref, byId, evalNode));
}

/* ------------------------------------------------------------------ */
/* Node registry                                                       */
/* ------------------------------------------------------------------ */

function expectSketch(v: GraphValue | undefined, node: string): Drawing {
  if (!v || v.kind !== "sketch2d")
    throw new Error(`[${node}] expected a sketch2d input, got ${v?.kind ?? "nothing"}`);
  return v.drawing;
}

/** The base plane a sketch2d input was drawn on (defaults to `def`, XY). */
function sketchPlane(v: GraphValue | undefined, def: "XY" | "XZ" | "YZ" = "XY"): "XY" | "XZ" | "YZ" {
  return v && v.kind === "sketch2d" && v.plane ? v.plane : def;
}
/** Offset of that plane along its normal (for a sketch placed on a face). */
function sketchOffset(v: GraphValue | undefined): number {
  return v && v.kind === "sketch2d" && v.planeOffset ? v.planeOffset : 0;
}
/** Arbitrary (non-axis-aligned) placement frame, if the sketch carries one. */
function sketchFrame(v: GraphValue | undefined): SketchFrame | undefined {
  return v && v.kind === "sketch2d" ? v.frame : undefined;
}

/** Non-axis-aligned placement: origin + normal (extrusion dir) + local +X. */
type SketchFrame = { origin: [number, number, number]; normal: [number, number, number]; xDir: [number, number, number] };

/**
 * Lay a 2D drawing onto its target plane and return a Sketch ready to extrude.
 * When `frame` is present we build a replicad Plane from it (tilted faces);
 * otherwise we use the axis-aligned base plane + offset.
 */
function placeSketch(dr: Drawing, plane: "XY" | "XZ" | "YZ", offset: number, frame?: SketchFrame) {
  if (frame) {
    const pl = new RPlane(frame.origin, frame.xDir, frame.normal);
    return dr.sketchOnPlane(pl);
  }
  return dr.sketchOnPlane(plane, offset);
}

/** Lay a sketch2d GraphValue on its plane/frame — shared by preview + export. */
export function placeSketchValue(v: Extract<GraphValue, { kind: "sketch2d" }>) {
  return placeSketch(v.drawing, v.plane ?? "XY", v.planeOffset ?? 0, v.frame);
}

function expectSolid(v: GraphValue | undefined, node: string): Shape3D {
  if (!v || v.kind !== "solid")
    throw new Error(`[${node}] expected a solid input, got ${v?.kind ?? "nothing"}`);
  return v.solid;
}

/**
 * Split a drawing into its disjoint regions (a `Blueprints`), so 2D booleans can
 * be applied one region at a time — replicad's cut/fuse misbehaves with a
 * multi-region tool. A single region (Blueprint) or a region-with-holes
 * (CompoundBlueprint) is returned as-is (one drawing).
 */
function drawingRegions(d: Drawing): Drawing[] {
  const inner = (d as unknown as { innerShape?: unknown }).innerShape;
  if (inner instanceof Blueprints) {
    return inner.blueprints.map((bp) => new Drawing(bp));
  }
  return [d];
}

/**
 * Merge several disjoint drawings into ONE compound Drawing WITHOUT a boolean.
 * replicad's `fuse` of disjoint regions is slow and occasionally wrong; here we
 * just collect every underlying Blueprint and wrap them in a single Blueprints
 * compound — exactly the inverse of `drawingRegions`.
 */
function combineDrawings(drawings: Drawing[]): Drawing {
  const bps = drawings.flatMap((d) => {
    const inner = (d as unknown as { innerShape?: unknown }).innerShape;
    if (inner instanceof Blueprints) return inner.blueprints;
    return inner ? [inner as never] : [];
  });
  if (bps.length === 1) return new Drawing(bps[0]);
  return new Drawing(new Blueprints(bps) as never);
}

type Vec2 = [number, number];

/** Build a closed drawing from a point loop, dropping coincident points so no
 * zero-length edge reaches OCCT (which aborts on them). `close()` re-adds the
 * segment back to the first point, so a trailing duplicate of the start is
 * removed too. */
function polyDrawing(pts: Vec2[]): Drawing {
  const eps = 1e-6;
  const clean: Vec2[] = [];
  for (const p of pts) {
    const last = clean[clean.length - 1];
    if (!last || Math.hypot(p[0] - last[0], p[1] - last[1]) > eps) clean.push(p);
  }
  if (clean.length > 1) {
    const a = clean[0];
    const b = clean[clean.length - 1];
    if (Math.hypot(a[0] - b[0], a[1] - b[1]) <= eps) clean.pop();
  }
  let pen = draw(clean[0]);
  for (let i = 1; i < clean.length; i++) pen = pen.lineTo(clean[i]);
  return pen.close();
}

/**
 * Walk one straight box-joint edge and return its points (the start corner is
 * assumed already emitted). Tabs bulge OUTWARD (along `nrm`) by the material
 * thickness; slots stay on the nominal line. An ODD finger count makes two
 * mating edges (one `tabFirst`, one not) interlock automatically, because they
 * are traversed from opposite corners.
 */
function fingerEdge(
  p0: Vec2,
  u: Vec2,
  nrm: Vec2,
  length: number,
  finger: number,
  thickness: number,
  tabFirst: boolean,
): Vec2[] {
  const n = Math.max(3, 2 * Math.floor(length / (2 * Math.max(0.5, finger))) + 1);
  const f = length / n;
  const at = (d: number, out: number): Vec2 => [
    p0[0] + u[0] * d + nrm[0] * out,
    p0[1] + u[1] * d + nrm[1] * out,
  ];
  const pts: Vec2[] = [];
  let cur = 0;
  for (let k = 0; k < n; k++) {
    const isTab = (k % 2 === 0) === tabFirst;
    const target = isTab ? thickness : 0;
    if (target !== cur) {
      pts.push(at(k * f, target)); // vertical riser to the new line
      cur = target;
    }
    pts.push(at((k + 1) * f, cur)); // run along this segment
  }
  if (cur !== 0) pts.push(at(length, 0)); // drop back to nominal at the end corner
  return pts;
}

/**
 * A rectangular panel (w × d) whose four edges are each flat or fingered.
 * Edges are given bottom, right, top, left (CCW from the bottom-left corner).
 * A fingered edge with `tabFirst:true` starts with a protruding tab.
 */
type EdgeSpec = { finger: boolean; tabFirst: boolean };
function fingerPanel(
  w: number,
  d: number,
  thickness: number,
  finger: number,
  edges: [EdgeSpec, EdgeSpec, EdgeSpec, EdgeSpec],
): Drawing {
  const c: Vec2[] = [[0, 0], [w, 0], [w, d], [0, d]]; // bottom-left → CCW
  const dirs: Vec2[] = [[1, 0], [0, 1], [-1, 0], [0, -1]];
  const nrms: Vec2[] = [[0, -1], [1, 0], [0, 1], [-1, 0]]; // outward = right of direction
  const lens = [w, d, w, d];
  const pts: Vec2[] = [c[0]];
  for (let e = 0; e < 4; e++) {
    const spec = edges[e];
    if (spec.finger) pts.push(...fingerEdge(c[e], dirs[e], nrms[e], lens[e], finger, thickness, spec.tabFirst));
    else pts.push(c[(e + 1) % 4]);
  }
  return polyDrawing(pts);
}

/** ISO metric coarse pitches (mm) keyed by nominal diameter designation. */
export const THREAD_STANDARDS: Record<string, { diameter: number; pitch: number }> = {
  M2: { diameter: 2, pitch: 0.4 },
  "M2.5": { diameter: 2.5, pitch: 0.45 },
  M3: { diameter: 3, pitch: 0.5 },
  M4: { diameter: 4, pitch: 0.7 },
  M5: { diameter: 5, pitch: 0.8 },
  M6: { diameter: 6, pitch: 1.0 },
  M8: { diameter: 8, pitch: 1.25 },
  M10: { diameter: 10, pitch: 1.5 },
  M12: { diameter: 12, pitch: 1.75 },
  M14: { diameter: 14, pitch: 2.0 },
  M16: { diameter: 16, pitch: 2.0 },
  M20: { diameter: 20, pitch: 2.5 },
  M24: { diameter: 24, pitch: 3.0 },
};

/**
 * Sweep a truncated-V thread ridge as an analytic B-rep solid, along a helix at
 * `spineRadius`. `profile` is a closed loop of (radius, dz-from-turn-centre)
 * points; its edge that sits on `spineRadius` must be present or the OCCT pipe
 * (Frenet frame → radial principal normal → CONSTANT radius) drifts. Handedness
 * via `lefthand`. `zBase` places the ridge's start; it spans [zBase, zBase+L].
 */
type RPt = [number, number];
function sweepHelicalRidge(
  spineRadius: number, profile: RPt[], pitch: number, length: number, lefthand: boolean, zBase = 0,
): Shape3D {
  const p = Math.max(0.2, pitch);
  const L = Math.max(p, length);
  const oc = getOC() as unknown as {
    BRepOffsetAPI_MakePipeShell: new (spine: unknown) => {
      SetMode_1: (frenet: boolean) => void;
      Add_1: (profile: unknown, contact: boolean, correction: boolean) => void;
      Build: (r: unknown) => void;
      MakeSolid: () => boolean;
      Shape: () => unknown;
    };
    Message_ProgressRange_1: new () => unknown;
  };
  // sweep [z0, z0+hH] with the profile centred on the start → ridge spans exactly
  // [zBase, zBase+L] (no ±½-pitch axial overshoot). helix & profile share z0.
  const z0 = zBase + (L > 2 * p ? p / 2 : 0);
  const hH = L > 2 * p ? L - p : L;
  const helix = (makeHelix(p, hH, spineRadius, [0, 0, z0], [0, 0, 1], lefthand) as unknown as { wrapped: unknown }).wrapped;
  const at = (i: number) => [profile[i][0], 0, z0 + profile[i][1]] as [number, number, number];
  const edges = profile.map((_, i) => makeLine(at(i), at((i + 1) % profile.length)));
  const wire = (assembleWire(edges as never) as unknown as { wrapped: unknown }).wrapped;
  const pipe = new oc.BRepOffsetAPI_MakePipeShell(helix);
  pipe.SetMode_1(true); // Frenet
  pipe.Add_1(wire, false, false);
  pipe.Build(new oc.Message_ProgressRange_1());
  pipe.MakeSolid();
  return cast(pipe.Shape() as Parameters<typeof cast>[0]) as Shape3D;
}

/**
 * Analytic B-rep threaded ROD (external ISO V-thread). A helical ridge sweep
 * fused with a core cylinder as a COMPOUND — no boolean, because OCCT boolean
 * ops on helical faces hang in this WASM build. Genuine non-faceted B-rep:
 * renders cleanly and exports to STEP.
 */
function buildThreadBRep(diameter: number, pitch: number, length: number, lefthand: boolean): Shape3D {
  const p = Math.max(0.2, pitch);
  const depth = p * 0.613; // ISO truncated thread height ≈ 0.6134·p
  const rMaj = Math.max(0.3, diameter / 2);
  const rMin = Math.max(0.15, rMaj - depth);
  const flat = p / 8;
  const profile: RPt[] = [[rMin, -p / 2], [rMaj, -flat], [rMaj, flat], [rMin, p / 2]];
  const ridge = sweepHelicalRidge(rMin, profile, p, length, lefthand);
  const core = makeCylinder(rMin + 0.15, Math.max(p, length)) as Shape3D; // hides root overlap
  return makeCompound([core, ridge]) as Shape3D;
}

/**
 * Analytic B-rep NUT (internal thread) cut into a solid body. A plain cylindrical
 * bore is removed with a SIMPLE (non-helical → fast) boolean, then inward-pointing
 * helical ridges are added as a COMPOUND — so no helical boolean is ever needed.
 * Genuine B-rep, STEP-exportable. `zBase`/`H` come from the body's bounds.
 */
function buildNutBRep(body: Shape3D, diameter: number, pitch: number, clearance: number, lefthand: boolean): Shape3D {
  const p = Math.max(0.2, pitch);
  const depth = p * 0.613;
  const rBore = Math.max(0.5, diameter / 2); // internal root = nominal major radius
  const rCrest = Math.max(0.3, rBore - depth + clearance); // teeth tips, toward the axis
  const rOuter = rBore + 0.15; // ridge root overlaps the surrounding material
  const flat = p / 8;
  const [lo, hi] = body.boundingBox.bounds;
  const H = hi[2] - lo[2];

  const bore = (makeCylinder(rBore, H + 4) as Shape3D).clone().translate(0, 0, lo[2] - 2) as Shape3D;
  const bodyWithHole = body.cut(bore) as Shape3D; // simple boolean — no helix, fast
  const profile: RPt[] = [[rOuter, -p / 2], [rCrest, -flat], [rCrest, flat], [rOuter, p / 2]];
  const ridge = sweepHelicalRidge(rOuter, profile, p, H, lefthand, lo[2]);
  return makeCompound([bodyWithHole, ridge]) as Shape3D;
}

let stepCounter = 0;
/** Synchronous STEP import from an ArrayBuffer (the async part of replicad's
 * `importSTEP` is only reading the Blob, which we already have as a buffer). */
function importSTEPSync(buf: ArrayBuffer): Shape3D {
  const oc = getOC() as unknown as {
    FS: { writeFile: (p: string, d: Uint8Array) => void; unlink: (p: string) => void };
    STEPControl_Reader_1: new () => {
      ReadFile: (name: string) => boolean;
      TransferRoots: (r: unknown) => void;
      OneShape: () => unknown;
    };
    Message_ProgressRange_1: new () => unknown;
  };
  const fileName = `import_${stepCounter++}.step`;
  oc.FS.writeFile(`/${fileName}`, new Uint8Array(buf));
  const reader = new oc.STEPControl_Reader_1();
  try {
    if (!reader.ReadFile(fileName)) throw new Error("[importSTEP] failed to read STEP file");
    reader.TransferRoots(new oc.Message_ProgressRange_1());
    return cast(reader.OneShape() as Parameters<typeof cast>[0]) as Shape3D;
  } finally {
    try { oc.FS.unlink(`/${fileName}`); } catch { /* already gone */ }
  }
}

function expectMesh(v: GraphValue | undefined, node: string): MeshData {
  if (!v || v.kind !== "mesh")
    throw new Error(`[${node}] expected a mesh input, got ${v?.kind ?? "nothing"}`);
  return v.mesh;
}

/** Coerce a solid OR mesh input to MeshData (solids are tessellated). */
function asMeshData(v: GraphValue | undefined, node: string): MeshData {
  if (v?.kind === "mesh") return v.mesh;
  if (v?.kind === "solid") return solidToMeshData(v.solid);
  throw new Error(`[${node}] expected a solid or mesh, got ${v?.kind ?? "nothing"}`);
}

/** Sample a Drawing's outline(s) into flat closed polylines (lines kept exact,
 * curves discretised). Duck-typed to avoid importing the concrete curve classes. */
function drawingPolylines(d: Drawing): Vec2[][] {
  const out: Vec2[][] = [];
  const flatten = (bp: { curves: { firstParameter: number; lastParameter: number; geomType: string; value: (t: number) => Vec2 }[] }): Vec2[] => {
    const pts: Vec2[] = [];
    for (const c of bp.curves) {
      const t0 = c.firstParameter, t1 = c.lastParameter;
      const steps = c.geomType === "LINE" ? 1 : 24;
      for (let i = 0; i < steps; i++) pts.push(c.value(t0 + (t1 - t0) * (i / steps)));
    }
    return pts;
  };
  const visit = (shape: unknown): void => {
    if (!shape || typeof shape !== "object") return;
    const s = shape as { curves?: unknown; blueprints?: unknown[] };
    if (Array.isArray(s.curves)) out.push(flatten(s as never));
    else if (Array.isArray(s.blueprints)) for (const b of s.blueprints) visit(b);
  };
  visit((d as unknown as { innerShape?: unknown }).innerShape);
  return out;
}

let stlCounter = 0;
/** Sew a triangle mesh into a B-rep solid (via OCCT's STL reader, like replicad's
 * importSTL). The result is a FACETED solid — one face per triangle after merging
 * coplanar ones — so it's heavy for downstream CAD ops; use deliberately (e.g. to
 * STEP-export a mesh, or feed a mesh into a solid Boolean). */
function meshToSolidSync(md: MeshData): Shape3D {
  const oc = getOC() as unknown as {
    FS: { writeFile: (p: string, d: Uint8Array) => void; unlink: (p: string) => void };
    StlAPI_Reader: new () => { Read: (shell: unknown, name: string) => boolean };
    TopoDS_Shell: new () => unknown;
    ShapeUpgrade_UnifySameDomain_2: new (s: unknown, a: boolean, b: boolean, c: boolean) => { Build: () => void; Shape: () => unknown };
    BRepBuilderAPI_MakeSolid_1: new () => { Add: (s: unknown) => void; Solid: () => unknown };
    TopoDS: { Shell_1: (s: unknown) => unknown };
  };
  const name = `mesh_${stlCounter++}.stl`;
  oc.FS.writeFile(`/${name}`, writeBinarySTL(md));
  try {
    const reader = new oc.StlAPI_Reader();
    const shell = new oc.TopoDS_Shell();
    if (!reader.Read(shell, name)) throw new Error("[meshToSolid] STL read failed");
    const up = new oc.ShapeUpgrade_UnifySameDomain_2(shell, true, true, false);
    up.Build();
    const mk = new oc.BRepBuilderAPI_MakeSolid_1();
    mk.Add(oc.TopoDS.Shell_1(up.Shape()));
    return cast(mk.Solid() as Parameters<typeof cast>[0]) as Shape3D;
  } finally {
    try { oc.FS.unlink(`/${name}`); } catch { /* already gone */ }
  }
}

/** B-rep → mesh: tessellate a solid into a plain triangle payload. */
function solidToMeshData(solid: Shape3D): MeshData {
  const m = meshAndTag(solid);
  return { vertices: m.vertices, indices: m.indices };
}

const REGISTRY: Record<string, NodeImpl> = {
  /** Scalar source nodes — feed the optional param ports of other nodes. */
  numberValue: (_inputs, params) => ({ kind: "number", value: Number(params.value ?? 0) }),
  textValue: (_inputs, params) => ({ kind: "text", value: String(params.value ?? "") }),

  /* --- math / logic (all number → number, chainable via param ports) --- */
  math: (_inputs, params) => {
    const a = Number(params.a ?? 0);
    const b = Number(params.b ?? 0);
    const op = String(params.op ?? "add");
    const r =
      op === "add" ? a + b
      : op === "subtract" ? a - b
      : op === "multiply" ? a * b
      : op === "divide" ? (b !== 0 ? a / b : 0)
      : op === "power" ? a ** b
      : op === "modulo" ? (b !== 0 ? a % b : 0)
      : op === "min" ? Math.min(a, b)
      : op === "max" ? Math.max(a, b)
      : a + b;
    return { kind: "number", value: r };
  },
  mathUnary: (_inputs, params) => {
    const x = Number(params.x ?? 0);
    const op = String(params.op ?? "abs");
    const r =
      op === "negate" ? -x
      : op === "abs" ? Math.abs(x)
      : op === "sqrt" ? Math.sqrt(Math.max(0, x))
      : op === "sin" ? Math.sin(x)
      : op === "cos" ? Math.cos(x)
      : op === "tan" ? Math.tan(x)
      : op === "round" ? Math.round(x)
      : op === "floor" ? Math.floor(x)
      : op === "ceil" ? Math.ceil(x)
      : x;
    return { kind: "number", value: r };
  },
  clamp: (_inputs, params) => {
    const v = Number(params.value ?? 0);
    const lo = Number(params.min ?? 0);
    const hi = Number(params.max ?? 1);
    return { kind: "number", value: Math.min(Math.max(v, Math.min(lo, hi)), Math.max(lo, hi)) };
  },
  remap: (_inputs, params) => {
    const v = Number(params.value ?? 0);
    const a0 = Number(params.inMin ?? 0);
    const a1 = Number(params.inMax ?? 1);
    const b0 = Number(params.outMin ?? 0);
    const b1 = Number(params.outMax ?? 1);
    const t = a1 === a0 ? 0 : (v - a0) / (a1 - a0);
    return { kind: "number", value: b0 + t * (b1 - b0) };
  },
  random: (_inputs, params) => {
    // deterministic (seeded) — mulberry32
    let s = (Number(params.seed ?? 1) >>> 0) + 0x6d2b79f5;
    s = Math.imul(s ^ (s >>> 15), s | 1);
    s ^= s + Math.imul(s ^ (s >>> 7), s | 61);
    const u = ((s ^ (s >>> 14)) >>> 0) / 4294967296;
    const lo = Number(params.min ?? 0);
    const hi = Number(params.max ?? 1);
    return { kind: "number", value: lo + u * (hi - lo) };
  },

  /* --- primitives 2D (sources) — for laser / Cricut and profiles --- */
  sketch: (_inputs, params) => {
    // the constraint sketch, with driving dimensions overridden by the node's
    // params (so editing a dimension value re-solves and updates the 3D live)
    const raw = params.doc;
    const doc: SketchDoc | null =
      raw && typeof raw === "object" ? (raw as SketchDoc) : typeof raw === "string" && raw ? (JSON.parse(raw) as SketchDoc) : null;
    if (!doc || !doc.entities?.length) throw new Error("[sketch] empty — open the sketch editor and draw a closed profile");
    const overrides: Record<string, number> = {};
    for (const dim of dimensions(doc)) {
      const v = params[dim.name];
      if (v !== undefined && v !== null && v !== "") overrides[dim.name] = Number(v);
    }
    const solved = cloneDoc(doc);
    if (params.plane && solved.plane !== params.plane) solved.plane = params.plane as SketchDoc["plane"];
    solveSketch(solved, { overrides });
    return { kind: "sketch2d", drawing: buildDrawing(solved), plane: solved.plane, planeOffset: solved.planeOffset, frame: solved.frame };
  },
  rect: (_inputs, params) => ({
    kind: "sketch2d",
    drawing: drawRectangle(Number(params.width ?? 40), Number(params.height ?? 30), Number(params.radius ?? 0)),
  }),
  circle: (_inputs, params) => ({
    kind: "sketch2d",
    drawing: drawCircle(Number(params.radius ?? 20)),
  }),
  polygon: (_inputs, params) => ({
    kind: "sketch2d",
    drawing: drawPolysides(Number(params.radius ?? 20), Math.max(3, Math.round(Number(params.sides ?? 6)))),
  }),
  ellipse: (_inputs, params) => ({
    kind: "sketch2d",
    drawing: drawEllipse(Number(params.rx ?? 30), Number(params.ry ?? 18)),
  }),
  gear: (_inputs, params) => {
    // simplified spur-gear silhouette (trapezoidal teeth) — great for laser/print
    const n = Math.max(3, Math.round(Number(params.teeth ?? 12)));
    const pitch = Number(params.radius ?? 30);
    const depth = Number(params.depth ?? 6);
    const ro = pitch + depth / 2;
    const ri = Math.max(0.5, pitch - depth / 2);
    const step = (2 * Math.PI) / n;
    const P = (r: number, a: number): [number, number] => [r * Math.cos(a), r * Math.sin(a)];
    const pts: [number, number][] = [];
    for (let i = 0; i < n; i++) {
      const a = i * step;
      pts.push(P(ri, a));
      pts.push(P(ri, a + step * 0.3));
      pts.push(P(ro, a + step * 0.42));
      pts.push(P(ro, a + step * 0.58));
      pts.push(P(ri, a + step * 0.7));
    }
    let pen = draw(pts[0]);
    for (let i = 1; i < pts.length; i++) pen = pen.lineTo(pts[i]);
    return { kind: "sketch2d", drawing: pen.close() };
  },
  star: (_inputs, params) => {
    const outer = Number(params.outer ?? 30);
    const inner = Number(params.inner ?? 14);
    const n = Math.max(3, Math.round(Number(params.points ?? 5)));
    const pts: [number, number][] = [];
    for (let i = 0; i < n * 2; i++) {
      const r = i % 2 === 0 ? outer : inner;
      const a = (Math.PI * i) / n - Math.PI / 2;
      pts.push([r * Math.cos(a), r * Math.sin(a)]);
    }
    let pen = draw(pts[0]);
    for (let i = 1; i < pts.length; i++) pen = pen.lineTo(pts[i]);
    return { kind: "sketch2d", drawing: pen.close() };
  },
  slot: (_inputs, params) => {
    const len = Number(params.length ?? 40);
    const w = Number(params.width ?? 12);
    return { kind: "sketch2d", drawing: drawRectangle(len, w, w / 2) };
  },
  /**
   * Nest several 2D profiles onto a sheet (shelf/row packing by bounding box)
   * to minimise offcut. Connect up to 6 profiles (s0…s5); `copies` repeats each.
   * Rows wrap at `sheetWidth`; `gap` keeps a kerf-safe margin between parts.
   */
  nest: (inputs, params) => {
    const items = ["s0", "s1", "s2", "s3", "s4", "s5"]
      .map((k) => inputs[k])
      .filter((v): v is Extract<GraphValue, { kind: "sketch2d" }> => !!v && v.kind === "sketch2d")
      .map((v) => v.drawing);
    if (!items.length) throw new Error("[nest] connect at least one 2D profile (s0…)");
    const sheetW = Math.max(1, Number(params.sheetWidth ?? 200));
    const gap = Math.max(0, Number(params.gap ?? 3));
    const copies = Math.max(1, Math.round(Number(params.copies ?? 1)));
    const all: Drawing[] = [];
    for (const d of items) for (let i = 0; i < copies; i++) all.push(d);
    const boxed = all.map((d) => {
      const [lo, hi] = d.boundingBox.bounds;
      return { d, lo, w: hi[0] - lo[0], h: hi[1] - lo[1] };
    });
    boxed.sort((a, b) => b.h - a.h); // tallest first → tighter shelves
    let cx = 0, cy = 0, shelfH = 0;
    const placed: Drawing[] = [];
    for (const it of boxed) {
      if (cx > 0 && cx + it.w > sheetW) { cy += shelfH + gap; cx = 0; shelfH = 0; }
      placed.push(it.d.translate(cx - it.lo[0], cy - it.lo[1]));
      cx += it.w + gap;
      shelfH = Math.max(shelfH, it.h);
    }
    return { kind: "sketch2d", drawing: combineDrawings(placed) };
  },
  /**
   * Living (lattice) hinge: a rectangular board cut with staggered vertical
   * slots so it flexes about the Y axis. Columns of slots along X, offset by
   * half a period on alternate columns; top/bottom margins keep the board in
   * one piece. Feed to a laser DXF/SVG export. Bends across the width (X).
   */
  livingHinge: (_inputs, params) => {
    const W = Number(params.width ?? 80);
    const H = Number(params.height ?? 40);
    const spacing = Math.max(1, Number(params.spacing ?? 5)); // column pitch (X)
    const slotLen = Math.max(2, Number(params.slotLen ?? 24));
    const bridge = Math.max(0.5, Number(params.bridge ?? 4)); // gap between slot ends & to edges
    const kerf = Math.max(0.1, Number(params.kerf ?? 0.7)); // slot width
    let board = drawRectangle(W, H);
    const yLo = -H / 2 + bridge, yHi = H / 2 - bridge;
    const period = slotLen + bridge;
    const nCols = Math.max(1, Math.floor((W - spacing) / spacing));
    const x0 = -W / 2 + (W - (nCols - 1) * spacing) / 2; // centre the columns
    for (let i = 0; i < nCols; i++) {
      const x = x0 + i * spacing;
      const off = i % 2 === 1 ? period / 2 : 0;
      for (let sy = yLo - off; sy < yHi; sy += period) {
        const a = Math.max(sy, yLo), b = Math.min(sy + slotLen, yHi);
        const len = b - a;
        if (len < 1) continue;
        board = board.cut(drawRectangle(kerf, len).translate(x, (a + b) / 2));
      }
    }
    return { kind: "sketch2d", drawing: board };
  },
  fingerBox: (_inputs, params) => {
    // Flat pattern for a press-fit, finger-jointed box (laser cutting). Emits
    // the 5 (or 6) panels laid out side by side; feed the result into a
    // Score/Cut node as the "cut" layer, then export SVG.
    const W = Number(params.width ?? 80);
    const D = Number(params.depth ?? 60);
    const H = Number(params.height ?? 40);
    const T = Number(params.thickness ?? 3);
    const F = Number(params.finger ?? 10);
    const closed = String(params.lid ?? "open") === "closed";

    const flat = { finger: false, tabFirst: false };
    const tab = { finger: true, tabFirst: true }; // protruding fingers
    const slot = { finger: true, tabFirst: false }; // complementary recesses
    const top = closed ? slot : flat;

    // edges are [bottom, right, top, left] (CCW). bottom-panel & lid: tabs on
    // all four; walls: slots into the bottom/lid, tabs↔slots on the verticals.
    const parts: { panel: ReturnType<typeof fingerPanel>; w: number }[] = [
      { panel: fingerPanel(W, D, T, F, [tab, tab, tab, tab]), w: W }, // bottom
      { panel: fingerPanel(W, H, T, F, [slot, tab, top, tab]), w: W }, // front
      { panel: fingerPanel(W, H, T, F, [slot, tab, top, tab]), w: W }, // back
      { panel: fingerPanel(D, H, T, F, [slot, slot, top, slot]), w: D }, // left
      { panel: fingerPanel(D, H, T, F, [slot, slot, top, slot]), w: D }, // right
    ];
    if (closed) parts.push({ panel: fingerPanel(W, D, T, F, [tab, tab, tab, tab]), w: W }); // lid

    const gap = Math.max(6, T * 2);
    let x = 0;
    const placed = parts.map(({ panel, w }) => {
      const out = panel.translate(x + T, T);
      x += w + 2 * T + gap;
      return out;
    });
    return { kind: "sketch2d", drawing: combineDrawings(placed) };
  },
  boolean2d: (inputs, params) => {
    const a = expectSketch(inputs.base, "boolean2d");
    const b = expectSketch(inputs.tool, "boolean2d");
    const op = String(params.op ?? "union");
    // replicad's 2D boolean is unreliable when the TOOL has several disjoint
    // regions (e.g. a ring of holes from an array) — it mixes up windings and
    // returns garbage. Applying the op region-by-region uses only the robust
    // single-region path. (A CompoundBlueprint — one region with holes — stays
    // whole, so its holes aren't split off.)
    const tools = drawingRegions(b);
    let out: Drawing;
    if (op === "difference") {
      out = tools.reduce((acc, t) => acc.cut(t), a);
    } else if (op === "intersection") {
      out = tools.map((t) => a.intersect(t)).reduce((p, c) => p.fuse(c));
    } else {
      out = tools.reduce((acc, t) => acc.fuse(t), a);
    }
    return { kind: "sketch2d", drawing: out };
  },
  mirror2d: (inputs, params) => {
    const dr = expectSketch(inputs.in, "mirror2d");
    // axis "X" → flip across the X axis (direction [0,1]); "Y" → across Y ([1,0])
    const dir: [number, number] = String(params.axis ?? "X") === "X" ? [0, 1] : [1, 0];
    return { kind: "sketch2d", drawing: dr.mirror(dir, [0, 0], "plane") };
  },
  transform2d: (inputs, params) => {
    const dr = expectSketch(inputs.in, "transform2d");
    let out = dr;
    const sc = Number(params.scale ?? 1);
    if (sc !== 1) out = out.scale(sc);
    const rot = Number(params.rotate ?? 0);
    if (rot !== 0) out = out.rotate(rot);
    const tx = Number(params.tx ?? 0);
    const ty = Number(params.ty ?? 0);
    if (tx !== 0 || ty !== 0) out = out.translate(tx, ty);
    return { kind: "sketch2d", drawing: out };
  },
  arrayLinear2d: (inputs, params) => {
    const dr = expectSketch(inputs.in, "arrayLinear2d");
    const count = Math.max(1, Math.round(Number(params.count ?? 3)));
    const dx = Number(params.dx ?? 25);
    const dy = Number(params.dy ?? 0);
    let out = dr;
    for (let i = 1; i < count; i++) out = out.fuse(dr.translate(dx * i, dy * i));
    return { kind: "sketch2d", drawing: out };
  },
  arrayRadial2d: (inputs, params) => {
    const dr = expectSketch(inputs.in, "arrayRadial2d");
    const count = Math.max(1, Math.round(Number(params.count ?? 6)));
    const radius = Number(params.radius ?? 40);
    const total = Number(params.angle ?? 360);
    const base = radius !== 0 ? dr.translate(radius, 0) : dr;
    const full = Math.abs(total) >= 360;
    const denom = full ? count : Math.max(1, count - 1);
    let out = base;
    for (let i = 1; i < count; i++) out = out.fuse(base.rotate((total / denom) * i));
    return { kind: "sketch2d", drawing: out };
  },

  /* --- primitives 3D (sources) --- */
  box: (_inputs, params) => ({
    kind: "solid",
    solid: makeBaseBox(Number(params.x ?? 30), Number(params.y ?? 30), Number(params.z ?? 30)) as Shape3D,
  }),
  cylinder: (_inputs, params) => ({
    kind: "solid",
    solid: makeCylinder(Number(params.radius ?? 15), Number(params.height ?? 30)) as Shape3D,
  }),
  sphere: (_inputs, params) => ({
    kind: "solid",
    solid: makeSphere(Number(params.radius ?? 20)) as Shape3D,
  }),
  // Thread MODIFIER (Fusion-style): thread a cylinder. With an input solid/mesh,
  // the major diameter and length are read from its bounding box; a `standard`
  // preset (M3…M24) fills the pitch. Output is an analytic B-rep (STEP-exportable).
  thread: (inputs, params) => {
    const std = String(params.standard ?? "custom");
    const preset = THREAD_STANDARDS[std];
    let diameter = Number(params.diameter ?? 20);
    let length = Number(params.length ?? 30);
    const pitch = preset ? preset.pitch : Number(params.pitch ?? 2.5);

    // modifier mode: size from the incoming cylinder's bounds
    const src = inputs.in;
    if (src) {
      let lo: number[], hi: number[];
      if (src.kind === "solid") {
        [lo, hi] = src.solid.boundingBox.bounds;
      } else if (src.kind === "mesh") {
        lo = [Infinity, Infinity, Infinity]; hi = [-Infinity, -Infinity, -Infinity];
        const vs = src.mesh.vertices;
        for (let i = 0; i < vs.length; i += 3) for (let a = 0; a < 3; a++) {
          lo[a] = Math.min(lo[a], vs[i + a]); hi[a] = Math.max(hi[a], vs[i + a]);
        }
      } else {
        throw new Error("[thread] input must be a cylinder solid or mesh");
      }
      diameter = Math.max(hi[0] - lo[0], hi[1] - lo[1]);
      length = hi[2] - lo[2];
    } else if (preset) {
      diameter = preset.diameter; // standalone + preset → nominal Ø
    }

    const solid = buildThreadBRep(diameter, pitch, length, String(params.hand ?? "right") === "left");
    return { kind: "solid", solid };
  },
  // Internal thread / NUT: a central bore (SIMPLE, fast boolean) with inward
  // helical ridges added as a compound — analytic B-rep, no helical boolean.
  internalThread: (inputs, params) => {
    const body = expectSolid(inputs.in, "internalThread");
    const std = String(params.standard ?? "custom");
    const preset = THREAD_STANDARDS[std];
    const diameter = preset ? preset.diameter : Number(params.diameter ?? 16);
    const pitch = preset ? preset.pitch : Number(params.pitch ?? 2);
    const clearance = Number(params.clearance ?? 0.4);
    const lefthand = String(params.hand ?? "right") === "left";
    return { kind: "solid", solid: buildNutBRep(body, diameter, pitch, clearance, lefthand) };
  },
  cone: (_inputs, params) => {
    const r = Number(params.radius ?? 15);
    const h = Number(params.height ?? 30);
    const profile = draw([0, 0]).lineTo([r, 0]).lineTo([0, h]).close();
    return { kind: "solid", solid: profile.sketchOnPlane("XZ").revolve() as Shape3D };
  },
  torus: (_inputs, params) => {
    const major = Number(params.radius ?? 25);
    const tube = Number(params.tube ?? 7);
    const profile = drawCircle(tube).translate(major, 0);
    return { kind: "solid", solid: profile.sketchOnPlane("XZ").revolve() as Shape3D };
  },
  revolve: (inputs, params) => {
    const dr = expectSketch(inputs.in, "revolve");
    const angle = Number(params.angle ?? 360);
    // revolve around Z; profile lives on XZ by default (a Sketch node can pick
    // another plane containing the axis)
    const plane = sketchPlane(inputs.in, "XZ");
    const solid = dr.sketchOnPlane(plane).revolve([0, 0, 1], { angle }) as Shape3D;
    return { kind: "solid", solid };
  },
  loft: (inputs, params) => {
    const bottom = expectSketch(inputs.bottom, "loft");
    const top = expectSketch(inputs.top, "loft");
    const h = Number(params.height ?? 30);
    const bs = bottom.sketchOnPlane("XY", 0) as unknown as {
      loftWith: (o: unknown) => Shape3D;
    };
    const solid = bs.loftWith(top.sketchOnPlane("XY", h)) as Shape3D;
    return { kind: "solid", solid };
  },
  loftSections: (inputs, params) => {
    // stack 2–4 profiles at evenly-spaced Z and loft through all of them
    const secs = ["s0", "s1", "s2", "s3"]
      .map((k) => inputs[k])
      .filter((v): v is Extract<GraphValue, { kind: "sketch2d" }> => !!v && v.kind === "sketch2d")
      .map((v) => v.drawing);
    if (secs.length < 2) throw new Error("[loftSections] connect at least two profiles (s0, s1, …)");
    const h = Number(params.height ?? 60);
    const n = secs.length;
    const base = secs[0].sketchOnPlane("XY", 0) as unknown as {
      loftWith: (o: unknown[]) => Shape3D;
    };
    const others = secs.slice(1).map((d, i) => d.sketchOnPlane("XY", (h * (i + 1)) / (n - 1)));
    const solid = base.loftWith(others) as Shape3D;
    return { kind: "solid", solid };
  },
  sweep: (inputs) => {
    // sweep a cross-section `profile` along a `path` spine (laid in the XZ plane
    // so the path rises in Z). replicad frames the profile perpendicular to the
    // spine at each step.
    const profile = expectSketch(inputs.profile, "sweep");
    const path = expectSketch(inputs.path, "sweep");
    const spine = path.sketchOnPlane("XZ") as unknown as {
      sweepSketch: (cb: (plane: unknown, origin: unknown) => unknown) => Shape3D;
    };
    const prof = profile as unknown as { sketchOnPlane: (p: unknown, o: unknown) => unknown };
    // call sketchOnPlane as a method so `this` stays bound to the profile
    const solid = spine.sweepSketch((plane, origin) => prof.sketchOnPlane(plane, origin)) as Shape3D;
    return { kind: "solid", solid };
  },

  /* --- ops 3D --- */
  boolean3d: (inputs, params) => {
    const a = expectSolid(inputs.base, "boolean3d");
    const b = expectSolid(inputs.tool, "boolean3d");
    const op = String(params.op ?? "union");
    const out = op === "difference" ? a.cut(b) : op === "intersection" ? a.intersect(b) : a.fuse(b);
    return { kind: "solid", solid: out as Shape3D };
  },
  /**
   * Interference check between two bodies: outputs the OVERLAP region (via a
   * robust Manifold intersection). Empty = no collision; otherwise its volume
   * (read it in the Props panel) tells you how much the parts clash.
   */
  collision: (inputs) => {
    const a = asMeshData(inputs.a, "collision");
    const b = asMeshData(inputs.b, "collision");
    return { kind: "mesh", mesh: booleanMesh(a, b, "intersection") };
  },
  /**
   * Repeat a solid along a 2D path (XY): copies are dropped at even arc-length
   * intervals and, unless orient="no", rotated about Z to follow the tangent.
   * Great for chain links, fence posts along a curve, teeth along a spline.
   */
  arrayPath: (inputs, params) => {
    const solid = expectSolid(inputs.in, "arrayPath");
    const path = expectSketch(inputs.path, "arrayPath");
    const count = Math.max(1, Math.round(Number(params.count ?? 5)));
    const orient = params.orient !== "no";
    // pick the longest sampled outline as the path spine
    const polys = drawingPolylines(path);
    if (!polys.length) throw new Error("[arrayPath] the path has no geometry");
    let pts = polys[0];
    for (const p of polys) if (p.length > pts.length) pts = p;
    const cum = [0];
    for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
    const total = cum[cum.length - 1] || 1;
    const at = (s: number): { x: number; y: number; ang: number } => {
      let i = 1;
      while (i < cum.length && cum[i] < s) i++;
      const a = pts[Math.max(0, i - 1)], b = pts[Math.min(pts.length - 1, i)];
      const seg = cum[i] - cum[i - 1] || 1;
      const f = (s - cum[i - 1]) / seg;
      return { x: a[0] + (b[0] - a[0]) * f, y: a[1] + (b[1] - a[1]) * f, ang: (Math.atan2(b[1] - a[1], b[0] - a[0]) * 180) / Math.PI };
    };
    const copies: Shape3D[] = [];
    for (let k = 0; k < count; k++) {
      const s = count === 1 ? 0 : (total * k) / (count - 1);
      const { x, y, ang } = at(s);
      let c = solid.clone() as Shape3D;
      if (orient) c = c.rotate(ang, [0, 0, 0], [0, 0, 1]) as Shape3D;
      copies.push(c.translate([x, y, 0]) as Shape3D);
    }
    const merge = params.merge !== "no";
    let out: Shape3D = copies[0];
    if (merge) for (let i = 1; i < copies.length; i++) out = out.fuse(copies[i]) as Shape3D;
    else out = makeCompound(copies) as unknown as Shape3D;
    return { kind: "solid", solid: out };
  },
  /** Assemble up to four solids into one COMPOUND — no boolean, so it works with
   * bodies that OCCT booleans choke on (e.g. a Thread). Great for a bolt = head +
   * thread. The bodies keep their own faces (B-rep) and STEP-export as one part. */
  assemble: (inputs) => {
    const parts = ["a", "b", "c", "d"]
      .map((k) => inputs[k])
      .filter((v): v is Extract<GraphValue, { kind: "solid" }> => !!v && v.kind === "solid")
      .map((v) => v.solid);
    if (parts.length === 0) throw new Error("[assemble] connect at least one solid");
    if (parts.length === 1) return { kind: "solid", solid: parts[0] };
    return { kind: "solid", solid: makeCompound(parts) as Shape3D };
  },
  mirror3d: (inputs, params) => {
    const solid = expectSolid(inputs.in, "mirror3d");
    const plane = String(params.plane ?? "YZ") as "XY" | "XZ" | "YZ";
    const mirrored = solid.clone().mirror(plane) as Shape3D;
    // "keep original" → a symmetric body (original ∪ its mirror)
    const out = params.keep === "yes" ? (solid.clone().fuse(mirrored) as Shape3D) : mirrored;
    return { kind: "solid", solid: out };
  },
  rotate3d: (inputs, params) => {
    const solid = expectSolid(inputs.in, "rotate3d");
    const angle = Number(params.angle ?? 0);
    const axis = String(params.axis ?? "Z");
    const dir: [number, number, number] = axis === "X" ? [1, 0, 0] : axis === "Y" ? [0, 1, 0] : [0, 0, 1];
    return { kind: "solid", solid: solid.clone().rotate(angle, [0, 0, 0], dir) as Shape3D };
  },
  scale3d: (inputs, params) => {
    const solid = expectSolid(inputs.in, "scale3d");
    const f = Number(params.factor ?? 1);
    return { kind: "solid", solid: solid.clone().scale(f) as Shape3D };
  },
  arrayLinear3d: (inputs, params) => {
    const solid = expectSolid(inputs.in, "arrayLinear3d");
    const count = Math.max(1, Math.round(Number(params.count ?? 3)));
    const dx = Number(params.dx ?? 40);
    const dy = Number(params.dy ?? 0);
    const dz = Number(params.dz ?? 0);
    let out: Shape3D = solid;
    for (let i = 1; i < count; i++) {
      out = out.fuse(solid.clone().translate(dx * i, dy * i, dz * i) as Shape3D) as Shape3D;
    }
    return { kind: "solid", solid: out };
  },
  arrayRadial3d: (inputs, params) => {
    const solid = expectSolid(inputs.in, "arrayRadial3d");
    const count = Math.max(1, Math.round(Number(params.count ?? 6)));
    const total = Number(params.angle ?? 360);
    const ax = String(params.axis ?? "Z");
    const dir: Vec3 = ax === "X" ? [1, 0, 0] : ax === "Y" ? [0, 1, 0] : [0, 0, 1];
    const denom = Math.abs(total) >= 360 ? count : Math.max(1, count - 1);
    const copies: Shape3D[] = [solid];
    for (let i = 1; i < count; i++) {
      copies.push(solid.clone().rotate((total / denom) * i, [0, 0, 0], dir) as Shape3D);
    }
    // fuse into one body, or keep the copies as a (cheaper) compound
    const merge = params.merge !== "no";
    let out: Shape3D = copies[0];
    if (merge) for (let i = 1; i < copies.length; i++) out = out.fuse(copies[i]) as Shape3D;
    else out = makeCompound(copies) as unknown as Shape3D;
    return { kind: "solid", solid: out };
  },

  /**
   * Score/Cut for laser: `cut` is the through-cut outline, `score` the fold /
   * engrave lines. The preview shows both fused; `exportGraphSVG` emits them on
   * separate red (cut) / blue (score) layers.
   */
  scoreCut: (inputs) => {
    const cut = expectSketch(inputs.cut, "scoreCut");
    const score = inputs.score;
    if (!score || score.kind !== "sketch2d") return { kind: "sketch2d", drawing: cut };
    let drawing: Drawing;
    try {
      drawing = cut.fuse(score.drawing);
    } catch {
      drawing = cut; // open score paths may not fuse — preview the cut alone
    }
    return { kind: "sketch2d", drawing };
  },

  /** Union several 2D profiles into one (overlaps resolved). */
  group: (inputs) => {
    const drs = ["a", "b", "c", "d"]
      .map((k) => inputs[k])
      .filter((v): v is Extract<GraphValue, { kind: "sketch2d" }> => !!v && v.kind === "sketch2d")
      .map((v) => v.drawing);
    if (!drs.length) throw new Error("[group] connect at least one 2D profile");
    return { kind: "sketch2d", drawing: drs.reduce((acc, d) => acc.fuse(d)) };
  },

  /** SVG input: parse an SVG path `d` string into a 2D drawing. */
  svgInput: (_inputs, params) => {
    const d = String(params.d ?? "");
    if (!d.trim()) throw new Error("[svgInput] empty SVG path");
    return { kind: "sketch2d", drawing: svgPathToDrawing(d) };
  },

  /** Import a DXF file (LINE/ARC/CIRCLE/LWPOLYLINE) as a 2D profile. */
  importDXF: (_inputs, params) => {
    const src = params.dxf;
    if (typeof src !== "string" || !src.trim()) throw new Error("[importDXF] choose a .dxf file");
    return { kind: "sketch2d", drawing: importDXF(src) };
  },

  /**
   * Text → SVG → 2D profile. Converts a string to glyph outlines via
   * opentype.js, emits an SVG path `d`, then reuses the SVG parser (whose
   * multi-subpath/hole handling is exactly what letter counters need).
   * `params.font` is a .ttf/.otf ArrayBuffer.
   */
  textToSvg: (_inputs, params) => {
    const text = String(params.text ?? "");
    const size = Number(params.size ?? 72);
    const fontBuf = params.font;
    if (!(fontBuf instanceof ArrayBuffer))
      throw new Error("[textToSvg] a font file (.ttf/.otf) is required");
    if (!text) throw new Error("[textToSvg] empty text");
    const font = opentype.parse(fontBuf);
    // baseline at y=0; opentype uses y-down, svgPathToDrawing flips to y-up.
    const path = font.getPath(text, 0, 0, size);
    const d = path.toPathData(3);
    if (!d.trim()) throw new Error("[textToSvg] font produced no outlines for this text");
    return { kind: "sketch2d", drawing: svgPathToDrawing(d) };
  },

  /** 2D offset (inflate / deflate a profile). OCCT BRepOffsetAPI under the hood. */
  offset2d: (inputs, params) => {
    const dr = expectSketch(inputs.in, "offset2d");
    const r = Number(params.distance ?? 0);
    return { kind: "sketch2d", drawing: r === 0 ? dr : dr.offset(r) };
  },
  /**
   * Relieve the inside corners of a pocket profile so a round router bit can
   * reach them (CNC). At every convex corner of the region, fuse a bit-radius
   * circle: "dogbone" places it on the diagonal, "tbone" along the longer wall.
   */
  dogbone: (inputs, params) => {
    const dr = expectSketch(inputs.in, "dogbone");
    const bitR = Math.max(0.1, Number(params.bitDia ?? 3) / 2);
    const tbone = String(params.style ?? "dogbone") === "tbone";
    const norm = (v: Vec2): Vec2 => { const l = Math.hypot(v[0], v[1]) || 1; return [v[0] / l, v[1] / l]; };
    let out = dr;
    for (const poly of drawingPolylines(dr)) {
      const n = poly.length;
      if (n < 3) continue;
      let area = 0;
      for (let i = 0; i < n; i++) { const a = poly[i], b = poly[(i + 1) % n]; area += a[0] * b[1] - b[0] * a[1]; }
      const ccw = area > 0;
      for (let i = 0; i < n; i++) {
        const a = poly[(i - 1 + n) % n], b = poly[i], c = poly[(i + 1) % n];
        const e1: Vec2 = [b[0] - a[0], b[1] - a[1]];
        const e2: Vec2 = [c[0] - b[0], c[1] - b[1]];
        const cross = e1[0] * e2[1] - e1[1] * e2[0];
        const convex = ccw ? cross > 0 : cross < 0; // corner where the bit leaves material
        if (!convex || Math.abs(cross) < 1e-6) continue;
        // outward direction = away from the region interior (opposite the bisector)
        const ba = norm([a[0] - b[0], a[1] - b[1]]), bc = norm([c[0] - b[0], c[1] - b[1]]);
        const outward = norm([-(ba[0] + bc[0]), -(ba[1] + bc[1])]);
        let cx: number, cy: number;
        if (tbone) {
          // extend along the longer adjacent wall (outward normal of that edge)
          const long = Math.hypot(e1[0], e1[1]) >= Math.hypot(e2[0], e2[1]) ? ba : bc;
          const dir = long[0] * outward[0] + long[1] * outward[1] >= 0 ? long : [-long[0], -long[1]] as Vec2;
          cx = b[0] + dir[0] * bitR; cy = b[1] + dir[1] * bitR;
        } else {
          cx = b[0] + outward[0] * bitR; cy = b[1] + outward[1] * bitR;
        }
        out = out.fuse(drawCircle(bitR).translate(cx, cy));
      }
    }
    return { kind: "sketch2d", drawing: out };
  },
  kerf: (inputs, params) => {
    // Laser kerf compensation: the beam removes ~kerf width of material, so an
    // outline must GROW by half the kerf, and a hole/pocket must SHRINK by it,
    // for the cut part to end up at nominal size.
    const dr = expectSketch(inputs.in, "kerf");
    const kerf = Number(params.kerf ?? 0.15);
    const outer = String(params.mode ?? "outer") === "outer";
    const d = (outer ? 1 : -1) * (kerf / 2);
    return { kind: "sketch2d", drawing: d === 0 ? dr : dr.offset(d) };
  },

  /** Extrude a 2D profile into a solid. */
  extrude: (inputs, params) => {
    const dr = expectSketch(inputs.in, "extrude");
    const h = Number(params.height ?? 1);
    const plane = sketchPlane(inputs.in);
    const off = sketchOffset(inputs.in);
    const mode = String(params.mode ?? "up");
    // up: [0,h]  ·  down: [-h,0]  ·  symmetric: [-h/2, h/2]  (+ plane offset)
    const base = (mode === "down" ? -h : mode === "symmetric" ? -h / 2 : 0) + off;
    // taper (endFactor: top scaled vs bottom — a draft) + twist
    const taper = Number(params.taper ?? 1);
    const twist = Number(params.twist ?? 0);
    const opts: { extrusionProfile?: { profile: "linear"; endFactor: number }; twistAngle?: number } = {};
    if (taper !== 1 && taper > 0) opts.extrusionProfile = { profile: "linear", endFactor: taper };
    if (twist !== 0) opts.twistAngle = twist;
    const frame = sketchFrame(inputs.in);
    const sk = placeSketch(dr, plane, base, frame) as unknown as { extrude: (d: number, o?: unknown) => Shape3D };
    const solid = sk.extrude(h, Object.keys(opts).length ? opts : undefined) as Shape3D;
    return { kind: "solid", solid };
  },

  /** Cut a pocket / hole into a solid by extruding a profile and subtracting it.
   * The perfect partner to "sketch on face": draw on a face → carve it out. */
  pocket: (inputs, params) => {
    const target = expectSolid(inputs.in, "pocket");
    const dr = expectSketch(inputs.profile, "pocket");
    const plane = sketchPlane(inputs.profile);
    const off = sketchOffset(inputs.profile);
    const depth = Math.max(0.01, Number(params.depth ?? 10));
    const through = String(params.mode ?? "blind") === "through";
    const dir = String(params.direction ?? "down");
    // span of the cutting tool along the plane normal, relative to `off`
    const d = through ? 1e4 : depth;
    const lo = dir === "up" ? off : off - d;   // "down"/"both" extend below the face
    const hi = dir === "down" ? off : off + d; // "up"/"both" extend above the face
    const tool = dr.sketchOnPlane(plane, lo).extrude(hi - lo) as Shape3D;
    const solid = target.cut(tool) as Shape3D;
    return { kind: "solid", solid };
  },

  /** Parametric hole (simple / counterbore / countersink), placed by (x,y) on a
   * base plane, cutting into a solid along the plane normal. */
  hole: (inputs, params) => {
    const target = expectSolid(inputs.in, "hole");
    const plane = String(params.plane ?? "XY") as "XY" | "XZ" | "YZ";
    const off = Number(params.offset ?? 0);
    const x = Number(params.x ?? 0), y = Number(params.y ?? 0);
    const dia = Math.max(0.1, Number(params.diameter ?? 6));
    const depth = Math.max(0.1, Number(params.depth ?? 20));
    const through = String(params.mode ?? "through") === "through";
    const type = String(params.type ?? "simple");
    const D = through ? 1e4 : depth;
    // main bore: circle extruded from the face (off) downward
    const at = (dr: Drawing) => dr.translate(x, y);
    let tool = at(drawCircle(dia / 2)).sketchOnPlane(plane, off - D).extrude(D) as Shape3D;
    if (type === "counterbore") {
      const cd = Math.max(dia, Number(params.headDia ?? dia * 2));
      const cdep = Math.max(0.1, Number(params.headDepth ?? 4));
      const cb = at(drawCircle(cd / 2)).sketchOnPlane(plane, off - cdep).extrude(cdep) as Shape3D;
      tool = tool.fuse(cb) as Shape3D;
    } else if (type === "countersink") {
      const cd = Math.max(dia, Number(params.headDia ?? dia * 2));
      const ang = Math.max(30, Math.min(179, Number(params.headAngle ?? 90)));
      const csDepth = ((cd - dia) / 2) / Math.tan((ang / 2) * (Math.PI / 180));
      // frustum: small circle (dia) at the countersink bottom → big circle (cd) at the face
      const bottom = at(drawCircle(dia / 2)).sketchOnPlane(plane, off - csDepth) as unknown as { loftWith: (o: unknown) => Shape3D };
      const topSk = at(drawCircle(cd / 2)).sketchOnPlane(plane, off);
      tool = tool.fuse(bottom.loftWith(topSk) as Shape3D) as Shape3D;
    }
    return { kind: "solid", solid: target.cut(tool) as Shape3D };
  },

  /* --- criteria-based selectors (survive regeneration) --- */
  edgeSelect: (_inputs, params) => {
    const where = String(params.where ?? "all");
    const offset = Number(params.offset ?? 0);
    const apply = (e: EdgeFinder): EdgeFinder => {
      switch (where) {
        case "vertical": return e.inDirection([0, 0, 1]);
        case "horizontal-x": return e.inDirection([1, 0, 0]);
        case "horizontal-y": return e.inDirection([0, 1, 0]);
        case "atZ": return e.inPlane("XY", offset);
        case "atX": return e.inPlane("YZ", offset);
        case "atY": return e.inPlane("XZ", offset);
        default: return e;
      }
    };
    return { kind: "selection", target: "edge", apply: apply as (f: unknown) => unknown };
  },
  faceSelect: (_inputs, params) => {
    const where = String(params.where ?? "all");
    const offset = Number(params.offset ?? 0);
    const apply = (f: FaceFinder): FaceFinder => {
      switch (where) {
        case "top":
        case "bottom":
        case "atZ": return f.inPlane("XY", offset); // precise plane at Z = offset
        case "atX": return f.inPlane("YZ", offset); // precise plane at X = offset
        case "atY": return f.inPlane("XZ", offset); // precise plane at Y = offset
        case "horizontal": return f.parallelTo("XY");
        case "vertical-x": return f.parallelTo("YZ");
        case "vertical-y": return f.parallelTo("XZ");
        case "planar": return f.ofSurfaceType("PLANE");
        case "cylindrical": return f.ofSurfaceType("CYLINDRE");
        default: return f;
      }
    };
    return { kind: "selection", target: "face", apply: apply as (f: unknown) => unknown };
  },

  /** Round edges of a solid (congé). Optional `sel` targets specific edges. */
  fillet: (inputs, params) => {
    const solid = expectSolid(inputs.in, "fillet");
    const r = Number(params.radius ?? 0);
    if (r <= 0) return { kind: "solid", solid };
    // radius2 > 0 → variable-radius fillet: r at the edge start, radius2 at its
    // end (replicad accepts a [start, end] tuple as the radius).
    const r2 = Number(params.radius2 ?? 0);
    const rad: number | [number, number] = r2 > 0 && r2 !== r ? [r, r2] : r;
    const sel = inputs.sel;
    if (sel && sel.kind === "selection" && sel.target === "edge") {
      return { kind: "solid", solid: solid.fillet(rad, (e) => sel.apply(e) as EdgeFinder) as Shape3D };
    }
    return { kind: "solid", solid: solid.fillet(rad) as Shape3D };
  },
  /** Chamfer (bevel) edges of a solid. Optional `sel` targets specific edges. */
  bevel: (inputs, params) => {
    const solid = expectSolid(inputs.in, "bevel");
    const d = Number(params.distance ?? 0);
    if (d <= 0) return { kind: "solid", solid };
    const sel = inputs.sel;
    if (sel && sel.kind === "selection" && sel.target === "edge") {
      return { kind: "solid", solid: solid.chamfer(d, (e) => sel.apply(e) as EdgeFinder) as Shape3D };
    }
    return { kind: "solid", solid: solid.chamfer(d) as Shape3D };
  },
  /** Hollow a solid, opening the selected face(s). Requires a Face Select. */
  shell: (inputs, params) => {
    const solid = expectSolid(inputs.in, "shell");
    const t = Number(params.thickness ?? 2);
    const sel = inputs.faces;
    if (!sel || sel.kind !== "selection" || sel.target !== "face")
      throw new Error("[shell] connect a Face Select (which face(s) to open)");
    return { kind: "solid", solid: solid.shell(t, (f) => sel.apply(f) as FaceFinder) as Shape3D };
  },
  /**
   * Resin hollowing: turn a solid into a CLOSED thin-walled shell (empty face
   * finder → no opening) and drill N vertical drain holes up through the bottom
   * wall so uncured resin can escape (avoids the suction/blowout of a sealed
   * cavity). Wall + drain diameter are the two knobs that matter for resin.
   */
  hollow: (inputs, params) => {
    const solid = expectSolid(inputs.in, "hollow");
    const wall = Math.abs(Number(params.wall ?? 2));
    const drainDia = Number(params.drainDia ?? 3);
    const drainCount = Math.max(0, Math.round(Number(params.drainCount ?? 2)));
    // closed hollow: shell inward, opening no face (finder matches nothing)
    let out = solid.clone().shell(-wall, (f) => f.inPlane("XY", 1e9)) as Shape3D;
    if (drainDia > 0 && drainCount > 0) {
      const [lo, hi] = solid.boundingBox.bounds;
      const cx = (lo[0] + hi[0]) / 2, cy = (lo[1] + hi[1]) / 2, zmin = lo[2];
      const spread = Math.min(hi[0] - lo[0], hi[1] - lo[1]) * 0.25;
      for (let i = 0; i < drainCount; i++) {
        const ang = (2 * Math.PI * i) / drainCount;
        const px = drainCount === 1 ? cx : cx + Math.cos(ang) * spread;
        const py = drainCount === 1 ? cy : cy + Math.sin(ang) * spread;
        // pierce from just below the bottom, up through the wall into the cavity
        const cyl = makeCylinder(drainDia / 2, wall * 3, [px, py, zmin - wall], [0, 0, 1]) as Shape3D;
        out = out.cut(cyl) as Shape3D;
      }
    }
    return { kind: "solid", solid: out };
  },
  /**
   * Auto-generate print supports: mesh the solid, find down-facing overhang
   * triangles steeper than `angle` (and above the plate), snap their centroids
   * to a `spacing` grid and drop a thin pillar from each to z=0. Output the
   * model + pillars, or the pillars alone. A pragmatic first-pass support forest.
   */
  supports: (inputs, params) => {
    const solid = expectSolid(inputs.in, "supports");
    const angle = Number(params.angle ?? 45);
    const spacing = Math.max(0.5, Number(params.spacing ?? 5));
    const dia = Math.max(0.2, Number(params.pillarDia ?? 1.2));
    const cosT = Math.cos((angle * Math.PI) / 180);
    const m = meshAndTag(solid);
    const V = m.vertices, T = m.indices;
    const z0 = 0; // resin build plate — pillars always anchor to z=0
    const eps = 0.2;
    // grid cell → lowest overhang point in that cell (one pillar per cell)
    const cells = new Map<string, [number, number, number]>();
    for (let i = 0; i < T.length; i += 3) {
      const a = T[i] * 3, b = T[i + 1] * 3, c = T[i + 2] * 3;
      const ux = V[b] - V[a], uy = V[b + 1] - V[a + 1], uz = V[b + 2] - V[a + 2];
      const vx = V[c] - V[a], vy = V[c + 1] - V[a + 1], vz = V[c + 2] - V[a + 2];
      let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      const nl = Math.hypot(nx, ny, nz) || 1; nx /= nl; ny /= nl; nz /= nl;
      if (-nz <= cosT) continue; // not a down-facing overhang
      const cx = (V[a] + V[b] + V[c]) / 3, cy = (V[a + 1] + V[b + 1] + V[c + 1]) / 3, cz = (V[a + 2] + V[b + 2] + V[c + 2]) / 3;
      if (cz <= z0 + eps) continue; // already on the plate
      const key = `${Math.round(cx / spacing)},${Math.round(cy / spacing)}`;
      const prev = cells.get(key);
      if (!prev || cz < prev[2]) cells.set(key, [cx, cy, cz]);
    }
    const pillars: Shape3D[] = [];
    for (const [px, py, pz] of cells.values()) {
      if (pillars.length >= 2000) break; // runaway guard
      const h = pz - z0;
      if (h <= eps) continue;
      pillars.push(makeCylinder(dia / 2, h, [px, py, z0], [0, 0, 1]) as Shape3D);
    }
    const only = params.output === "supports";
    const parts = only ? pillars : [solid, ...pillars];
    if (!parts.length) return { kind: "solid", solid };
    return { kind: "solid", solid: makeCompound(parts) as unknown as Shape3D };
  },
  /**
   * Fill a solid with a lightweight internal grid lattice + a closed outer
   * shell (resin/FDM strength without the weight). Walls run in X and Y on a
   * `cell` pitch, clipped to the shape; combined with a `wall`-thick shell.
   */
  infill: (inputs, params) => {
    const solid = expectSolid(inputs.in, "infill");
    const wall = Math.max(0.3, Number(params.wall ?? 1.5));
    const cell = Math.max(2, Number(params.cell ?? 10));
    const [lo, hi] = solid.boundingBox.bounds;
    const sx = hi[0] - lo[0], sy = hi[1] - lo[1], sz = hi[2] - lo[2];
    const cxm = (lo[0] + hi[0]) / 2, cym = (lo[1] + hi[1]) / 2, z0 = lo[2];
    const walls: Shape3D[] = [];
    const CAP = 60; // guard against a runaway wall count
    for (let x = lo[0] + cell; x < hi[0] && walls.length < CAP; x += cell)
      walls.push((makeBaseBox(wall, sy, sz) as Shape3D).translate([x, cym, z0]) as Shape3D);
    for (let y = lo[1] + cell; y < hi[1] && walls.length < CAP; y += cell)
      walls.push((makeBaseBox(sx, wall, sz) as Shape3D).translate([cxm, y, z0]) as Shape3D);
    // closed thin shell (walls only, no opening)
    const shell = solid.clone().shell(-wall, (f) => f.inPlane("XY", 1e9)) as Shape3D;
    if (!walls.length) return { kind: "solid", solid: shell };
    let lattice = walls[0];
    for (let i = 1; i < walls.length; i++) lattice = lattice.fuse(walls[i]) as Shape3D;
    const inner = solid.clone().intersect(lattice) as Shape3D; // clip lattice to the shape
    return { kind: "solid", solid: shell.fuse(inner) as Shape3D };
  },
  /**
   * Split a solid by an axis-aligned plane (for parts too big for the build
   * plate). Keep the positive/negative side, or both halves as a compound
   * pushed apart by `gap` so the cut is visible.
   */
  split: (inputs, params) => {
    const solid = expectSolid(inputs.in, "split");
    const axis = String(params.axis ?? "Z");
    const off = Number(params.offset ?? 0);
    const keep = String(params.keep ?? "positive");
    const gap = Number(params.gap ?? 0);
    const [lo, hi] = solid.boundingBox.bounds;
    const ai = axis === "X" ? 0 : axis === "Y" ? 1 : 2;
    const dir: Vec3 = ai === 0 ? [1, 0, 0] : ai === 1 ? [0, 1, 0] : [0, 0, 1];
    const half = (positive: boolean): Shape3D => {
      const pad = 10;
      const r: [number, number][] = [[lo[0] - pad, hi[0] + pad], [lo[1] - pad, hi[1] + pad], [lo[2] - pad, hi[2] + pad]];
      if (positive) r[ai][0] = off; else r[ai][1] = off;
      const w = r[0][1] - r[0][0], d = r[1][1] - r[1][0], h = r[2][1] - r[2][0];
      const cutter = (makeBaseBox(w, d, h) as Shape3D).translate([(r[0][0] + r[0][1]) / 2, (r[1][0] + r[1][1]) / 2, r[2][0]]) as Shape3D;
      return solid.clone().intersect(cutter) as Shape3D;
    };
    if (keep === "both") {
      const pos = gap ? (half(true).translate(dir.map((c) => c * gap) as Vec3) as Shape3D) : half(true);
      const neg = half(false);
      return { kind: "solid", solid: makeCompound([pos, neg]) as unknown as Shape3D };
    }
    return { kind: "solid", solid: half(keep === "positive") };
  },
  /** Round the corners of a 2D profile (great for laser-cut parts). */
  fillet2d: (inputs, params) => {
    const dr = expectSketch(inputs.in, "fillet2d");
    const r = Number(params.radius ?? 0);
    return { kind: "sketch2d", drawing: r > 0 ? dr.fillet(r) : dr };
  },
  /** Chamfer the corners of a 2D profile. */
  bevel2d: (inputs, params) => {
    const dr = expectSketch(inputs.in, "bevel2d");
    const d = Number(params.distance ?? 0);
    return { kind: "sketch2d", drawing: d > 0 ? dr.chamfer(d) : dr };
  },

  /** Translate a solid. tx/ty/tz are editable in 3D via the viewport gizmo. */
  transform: (inputs, params) => {
    const solid = expectSolid(inputs.in, "transform");
    const tx = Number(params.tx ?? 0);
    const ty = Number(params.ty ?? 0);
    const tz = Number(params.tz ?? 0);
    if (tx === 0 && ty === 0 && tz === 0) return { kind: "solid", solid };
    // clone first: replicad's translate mutates/consumes the shape, and this
    // node's output may feed several consumers (the eval cache shares one object)
    return { kind: "solid", solid: solid.clone().translate(tx, ty, tz) as Shape3D };
  },

  /**
   * THE SPIKE — "extrude on the result of an extrude, taking the cap".
   *
   * We do NOT reference the top face by a stored index. We store a *query*
   * ("the top planar cap") and re-resolve it against whatever geometry the
   * upstream nodes produced this time. That is the answer to the topological
   * naming problem: identifiers are unstable, criteria-based selectors survive
   * regeneration.
   */
  bossOnCap: (inputs, params) => {
    const base = expectSolid(inputs.in, "bossOnCap");
    const bossHeight = Number(params.height ?? 2);
    const shrink = Number(params.shrink ?? 3); // inward offset for the boss profile

    const cap = resolveTopCap(base); // <-- the re-resolved selector, not a stored id

    // Build the boss profile by insetting the base outline, placed on the cap.
    const baseSketch = expectSketch(inputs.profile, "bossOnCap");
    const bossDrawing = baseSketch.offset(-Math.abs(shrink));
    const solid = base.fuse(
      bossDrawing.sketchOnPlane("XY", cap.z).extrude(bossHeight) as Shape3D,
    ) as Shape3D;
    return { kind: "solid", solid };
  },

  /* --- mesh domain (Manifold) — the bridge from B-rep to STL land --- */

  /** B-rep → mesh. Auto-inserted when a solid is fed into a mesh-only node. */
  tessellate: (inputs) => {
    const solid = expectSolid(inputs.in, "tessellate");
    return { kind: "mesh", mesh: solidToMeshData(solid) };
  },

  /** Import a binary STL (`params.stl`: ArrayBuffer | Uint8Array) as a mesh. */
  importSTL: (_inputs, params) => {
    const raw = params.stl;
    let buf: ArrayBuffer;
    if (raw instanceof ArrayBuffer) buf = raw;
    else if (raw instanceof Uint8Array)
      buf = raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength) as ArrayBuffer;
    else throw new Error("[importSTL] params.stl must be an ArrayBuffer or Uint8Array");
    return { kind: "mesh", mesh: parseBinarySTL(buf) };
  },
  /** Import a STEP file (also what Fusion 360 / SolidWorks export) as a B-rep
   * solid — editable, unlike an STL mesh. */
  importSTEP: (_inputs, params) => {
    const raw = params.step;
    let buf: ArrayBuffer;
    if (raw instanceof ArrayBuffer) buf = raw;
    else if (raw instanceof Uint8Array)
      buf = raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength) as ArrayBuffer;
    else throw new Error("[importSTEP] params.step must be an ArrayBuffer (choose a .step/.stp file)");
    return { kind: "solid", solid: importSTEPSync(buf) };
  },

  /** Weld a triangle soup into a clean manifold mesh (STL repair). */
  repair: (inputs) => {
    const mesh = expectMesh(inputs.in, "repair");
    return { kind: "mesh", mesh: repairMesh(mesh).mesh };
  },
  /** Sew a mesh into a B-rep solid — deliberate, faceted, and heavy. Use to feed
   * a mesh (e.g. a Thread) into the solid pipeline or to STEP-export it. */
  meshToSolid: (inputs) => {
    const mesh = expectMesh(inputs.in, "meshToSolid");
    return { kind: "solid", solid: meshToSolidSync(mesh) };
  },

  /**
   * Robust mesh boolean. Inputs `a` and `b` must both be meshes; if a solid is
   * wired in, tessellate it upstream first. `params.op`: union|difference|intersection.
   */
  boolean: (inputs, params) => {
    const a = expectMesh(inputs.base, "boolean");
    const b = expectMesh(inputs.tool, "boolean");
    const op = (params.op ?? "union") as BooleanOp;
    return { kind: "mesh", mesh: booleanMesh(a, b, op) };
  },
  transformMesh: (inputs, params) => {
    const mesh = expectMesh(inputs.in, "transformMesh");
    return {
      kind: "mesh",
      mesh: transformMesh(mesh, {
        tx: Number(params.tx ?? 0), ty: Number(params.ty ?? 0), tz: Number(params.tz ?? 0),
        rx: Number(params.rx ?? 0), ry: Number(params.ry ?? 0), rz: Number(params.rz ?? 0),
        scale: Number(params.scale ?? 1),
      }),
    };
  },
  convexHull: (inputs) => ({ kind: "mesh", mesh: hullMesh(expectMesh(inputs.in, "convexHull")) }),
  minkowski: (inputs) => ({
    kind: "mesh",
    mesh: minkowskiMesh(expectMesh(inputs.a, "minkowski"), expectMesh(inputs.b, "minkowski")),
  }),
  decimate: (inputs, params) => ({
    kind: "mesh",
    mesh: simplifyMesh(expectMesh(inputs.in, "decimate"), Number(params.tolerance ?? 0.1)),
  }),
  subdivide: (inputs, params) => ({
    kind: "mesh",
    mesh: refineMesh(expectMesh(inputs.in, "subdivide"), Number(params.n ?? 2)),
  }),
};

/* ------------------------------------------------------------------ */
/* Graph evaluation (topological)                                      */
/* ------------------------------------------------------------------ */

export function evalGraph(graph: Graph, vars: Record<string, number> = {}): { outputs: Record<string, GraphValue>; order: string[] } {
  const byId = new Map(graph.map((n) => [n.id, n]));
  const cache = new Map<string, GraphValue>();
  const visiting = new Set<string>();
  const order: string[] = [];

  const evalNode = (id: string): GraphValue => {
    const cached = cache.get(id);
    if (cached) return cached;
    if (visiting.has(id)) throw new Error(`cycle detected at node ${id}`);
    const node = byId.get(id);
    if (!node) throw new Error(`unknown node ${id}`);
    visiting.add(id);

    const rawInputs: Record<string, GraphValue> = {};
    for (const [port, ref] of Object.entries(node.inputs ?? {})) {
      rawInputs[port] = resolveRef(ref, byId, evalNode);
    }
    const impl = REGISTRY[node.type];
    if (!impl) throw new Error(`no implementation for node type "${node.type}"`);
    const { inputs, params } = resolveInputs(node.type, rawInputs, node.params ?? {}, vars);
    const out = impl(inputs, params);

    visiting.delete(id);
    cache.set(id, out);
    order.push(id);
    return out;
  };

  const outputs: Record<string, GraphValue> = {};
  for (const n of graph) outputs[n.id] = evalNode(n.id);
  return { outputs, order };
}

/* ------------------------------------------------------------------ */
/* Incremental (content-addressed) evaluation                          */
/*                                                                     */
/* A persistent cache keyed by a content hash of each node             */
/* (type + params + the hashes of its inputs). When a param changes,   */
/* only that node's hash — and its descendants' — change; every        */
/* untouched upstream node is served straight from cache. This is what */
/* makes live editing cheap: change the boss height and OCCT does NOT  */
/* re-extrude the base profile.                                        */
/* ------------------------------------------------------------------ */

export interface EvalCache {
  entries: Map<string, { value: GraphValue; run: number }>;
  run: number;
}

export function makeEvalCache(): EvalCache {
  return { entries: new Map(), run: 0 };
}

function fnv1a(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h.toString(16);
}

function hashParams(params: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const k of Object.keys(params).sort()) {
    const v = params[k];
    if (v instanceof ArrayBuffer) {
      const b = new Uint8Array(v);
      // cheap content signature — length + a few sampled bytes
      parts.push(`${k}:ab${b.byteLength}:${b[0] ?? 0}:${b[b.length >> 1] ?? 0}:${b[b.length - 1] ?? 0}`);
    } else {
      parts.push(`${k}:${JSON.stringify(v)}`);
    }
  }
  return parts.join("|");
}

/** Free the WASM object behind a cached B-rep value (mesh values are plain JS). */
function disposeValue(v: GraphValue): void {
  try {
    if (v.kind === "solid") (v.solid as unknown as { delete?: () => void }).delete?.();
    else if (v.kind === "sketch2d") (v.drawing as unknown as { delete?: () => void }).delete?.();
  } catch {
    /* best-effort — never let cleanup crash an eval */
  }
}

export function evalGraphCached(
  graph: Graph,
  cache: EvalCache,
  vars: Record<string, number> = {},
): { outputs: Record<string, GraphValue>; hits: number; misses: number } {
  cache.run++;
  const byId = new Map(graph.map((n) => [n.id, n]));
  // user params affect any expression param, so fold them into every cache key
  const varsKey = Object.keys(vars).sort().map((k) => `${k}=${vars[k]}`).join(";");
  const keyMemo = new Map<string, string>();
  const valMemo = new Map<string, GraphValue>();
  const visiting = new Set<string>();
  let hits = 0;
  let misses = 0;

  const keyOf = (id: string): string => {
    const memo = keyMemo.get(id);
    if (memo) return memo;
    const node = byId.get(id);
    if (!node) throw new Error(`unknown node ${id}`);
    const childParts: string[] = [];
    for (const [port, ref] of Object.entries(node.inputs ?? {})) {
      const { node: srcId, handle } = parseRef(ref);
      childParts.push(`${port}=${keyOf(srcId)}#${handle}`);
    }
    const key = fnv1a(
      `${node.type}(${hashParams(node.params ?? {})})[${childParts.sort().join(",")}]{${varsKey}}`,
    );
    keyMemo.set(id, key);
    return key;
  };

  const evalNode = (id: string): GraphValue => {
    const done = valMemo.get(id);
    if (done) return done;
    if (visiting.has(id)) throw new Error(`cycle detected at node ${id}`);
    const node = byId.get(id)!;
    visiting.add(id);

    const key = keyOf(id);
    const hit = cache.entries.get(key);
    let value: GraphValue;
    if (hit) {
      hit.run = cache.run; // refresh so it stays inside the retention window
      value = hit.value;
      hits++;
    } else {
      const rawInputs: Record<string, GraphValue> = {};
      for (const [port, ref] of Object.entries(node.inputs ?? {})) {
        rawInputs[port] = resolveRef(ref, byId, evalNode);
      }
      const impl = REGISTRY[node.type];
      if (!impl) throw new Error(`no implementation for node type "${node.type}"`);
      const { inputs, params } = resolveInputs(node.type, rawInputs, node.params ?? {}, vars);
      try {
        value = impl(inputs, params);
      } catch (e) {
        // tag the failing node so the editor can highlight it
        throw Object.assign(e instanceof Error ? e : new Error(String(e)), { nodeId: id });
      }
      cache.entries.set(key, { value, run: cache.run });
      misses++;
    }

    visiting.delete(id);
    valMemo.set(id, value);
    return value;
  };

  const outputs: Record<string, GraphValue> = {};
  for (const n of graph) outputs[n.id] = evalNode(n.id);

  // evict entries untouched for more than one run (frees stale OCCT shapes)
  for (const [k, e] of cache.entries) {
    if (cache.run - e.run > 1) {
      disposeValue(e.value);
      cache.entries.delete(k);
    }
  }
  // hard LRU bound as a backstop against pathological graphs: if we're still
  // over budget, drop the oldest entries (smallest run) first.
  if (cache.entries.size > CACHE_MAX_ENTRIES) {
    const byAge = [...cache.entries.entries()].sort((a, b) => a[1].run - b[1].run);
    for (let i = 0; i < byAge.length && cache.entries.size > CACHE_MAX_ENTRIES; i++) {
      disposeValue(byAge[i][1].value);
      cache.entries.delete(byAge[i][0]);
    }
  }

  return { outputs, hits, misses };
}

const CACHE_MAX_ENTRIES = 256;

/* ------------------------------------------------------------------ */
/* Meshing + face segmentation/tagging                                 */
/* ------------------------------------------------------------------ */

export type FaceTag = "top" | "bottom" | "side";

export interface MeshPayload {
  vertices: Float32Array;
  indices: Uint32Array;
  normals: Float32Array;
  /** contiguous triangle-index ranges grouped by B-rep face + our semantic tag */
  groups: { start: number; count: number; faceId: number; tag: FaceTag }[];
  /** the real B-rep construction edges as line segments (for a Fusion-style
   * wireframe) — absent for mesh-domain payloads (which have no B-rep edges). */
  edges?: Float32Array;
  /** this payload is a 2D sketch preview → render as line-work on its plane */
  isSketch?: boolean;
  stats: {
    faceCount: number;
    triangleCount: number;
    tagCounts: Record<FaceTag, number>;
  };
}

/**
 * Mesh a solid and assign a semantic tag to every B-rep face group by looking
 * at its averaged normal. This is the mesh-domain equivalent of "flagging
 * faces": top cap / bottom cap / contour sides become reusable regions.
 */
export function meshAndTag(solid: Shape3D): MeshPayload {
  const raw = solid.mesh({ tolerance: 0.05, angularTolerance: 0.3 }) as {
    vertices: number[];
    triangles: number[];
    normals: number[];
    faceGroups?: { start: number; count: number; faceId: number }[];
  };

  const vertices = new Float32Array(raw.vertices);
  const indices = new Uint32Array(raw.triangles);
  const normals = new Float32Array(raw.normals);

  // the real B-rep edges (line segments) for a Fusion-style wireframe
  let edges: Float32Array | undefined;
  try {
    const me = (solid as unknown as { meshEdges: (o: unknown) => { lines: number[] } })
      .meshEdges({ tolerance: 0.05, angularTolerance: 0.3 });
    if (me?.lines?.length) edges = new Float32Array(me.lines);
  } catch { /* some shapes (compounds) may not expose edges — skip */ }

  const faceGroups =
    raw.faceGroups ?? [{ start: 0, count: raw.triangles.length, faceId: 0 }];

  const tagCounts: Record<FaceTag, number> = { top: 0, bottom: 0, side: 0 };
  const groups = faceGroups.map((g) => {
    const tag = classifyGroup(g, indices, normals);
    tagCounts[tag] += g.count / 3;
    return { ...g, tag };
  });

  return {
    vertices,
    indices,
    normals,
    groups,
    edges,
    stats: {
      faceCount: faceGroups.length,
      triangleCount: indices.length / 3,
      tagCounts,
    },
  };
}

/**
 * Turn a raw mesh (from Manifold) into a renderable MeshPayload, reusing the
 * exact same structure the B-rep path produces so the viewport needs no changes.
 *
 * We segment the mesh into flat regions (the mesh-domain "faces"), then emit a
 * flat-shaded, region-grouped geometry: vertices are expanded per-triangle so
 * each region gets crisp edges and its own draw group, tagged top/side/bottom
 * by its normal — mirroring `meshAndTag` for solids.
 */
export function meshToPayload(md: MeshData): MeshPayload {
  const regions = segmentMesh(md);
  const triTotal = md.indices.length / 3;
  const vertices = new Float32Array(triTotal * 9);
  const normals = new Float32Array(triTotal * 9);
  const indices = new Uint32Array(triTotal * 3);
  const groups: MeshPayload["groups"] = [];
  const tagCounts: Record<FaceTag, number> = { top: 0, bottom: 0, side: 0 };

  let tri = 0; // running triangle write cursor (expanded buffer)
  regions.forEach((r, ri) => {
    const start = tri * 3;
    const [nx, ny, nz] = r.normal;
    for (const t of r.triangles) {
      for (let c = 0; c < 3; c++) {
        const vi = md.indices[t * 3 + c];
        const o = tri * 9 + c * 3;
        vertices[o] = md.vertices[vi * 3];
        vertices[o + 1] = md.vertices[vi * 3 + 1];
        vertices[o + 2] = md.vertices[vi * 3 + 2];
        normals[o] = nx;
        normals[o + 1] = ny;
        normals[o + 2] = nz;
        indices[tri * 3 + c] = tri * 3 + c;
      }
      tri++;
    }
    const tag: FaceTag = nz > 0.7 ? "top" : nz < -0.7 ? "bottom" : "side";
    tagCounts[tag] += r.triangles.length;
    groups.push({ start, count: r.triangles.length * 3, faceId: ri, tag });
  });

  return {
    vertices,
    indices,
    normals,
    groups,
    stats: { faceCount: regions.length, triangleCount: triTotal, tagCounts },
  };
}

function classifyGroup(
  g: { start: number; count: number },
  indices: Uint32Array,
  normals: Float32Array,
): FaceTag {
  let nz = 0;
  let n = 0;
  for (let i = g.start; i < g.start + g.count; i++) {
    const vi = indices[i];
    nz += normals[vi * 3 + 2];
    n++;
  }
  const avg = n ? nz / n : 0;
  if (avg > 0.7) return "top";
  if (avg < -0.7) return "bottom";
  return "side";
}

/* ------------------------------------------------------------------ */
/* Criteria-based face selector (the topological-naming strategy)      */
/* ------------------------------------------------------------------ */

export interface CapInfo {
  z: number;
  faceId: number | null;
  center: [number, number, number];
}

/**
 * Resolve "the top cap" of a solid by geometric criteria rather than by a
 * stored id. We compute it from the mesh: the region whose normal points up
 * and whose centroid is highest. The returned `faceId` is only informational —
 * it is EXPECTED to change between regenerations; the selector is what's stable.
 */
export function resolveTopCap(solid: Shape3D): CapInfo {
  const m = meshAndTag(solid);
  let best: CapInfo = { z: -Infinity, faceId: null, center: [0, 0, 0] };
  for (const g of m.groups) {
    if (g.tag !== "top") continue;
    // centroid of the group
    let cx = 0,
      cy = 0,
      cz = 0,
      n = 0;
    for (let i = g.start; i < g.start + g.count; i++) {
      const vi = m.indices[i];
      cx += m.vertices[vi * 3];
      cy += m.vertices[vi * 3 + 1];
      cz += m.vertices[vi * 3 + 2];
      n++;
    }
    if (!n) continue;
    const info: CapInfo = { z: cz / n, faceId: g.faceId, center: [cx / n, cy / n, cz / n] };
    if (info.z > best.z) best = info;
  }
  if (best.faceId === null) throw new Error("no top cap found");
  return best;
}
