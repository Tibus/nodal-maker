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
} from "replicad";
import * as opentype from "opentype.js";
import { svgPathToDrawing } from "./svgPath";
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
import { parseBinarySTL } from "./stl";

/* ------------------------------------------------------------------ */
/* Typed values that travel along the graph edges                      */
/* ------------------------------------------------------------------ */

export type GraphValue =
  | { kind: "sketch2d"; drawing: Drawing }
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
import { NODE_SPECS, paramPortType } from "./specs";
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
): { inputs: Record<string, GraphValue>; params: Record<string, unknown> } {
  const spec = NODE_SPECS[nodeType];
  if (!spec) return { inputs: rawInputs, params };
  const paramPorts = new Map(
    spec.params.map((p) => [p.name, paramPortType(p)] as const).filter(([, t]) => t !== null),
  );
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

const faceXY = (z: number): GraphValue => ({
  kind: "selection",
  target: "face",
  apply: (f) => (f as FaceFinder).inPlane("XY", z),
});
const faceYZ = (x: number): GraphValue => ({
  kind: "selection",
  target: "face",
  apply: (f) => (f as FaceFinder).inPlane("YZ", x),
});
const faceXZ = (y: number): GraphValue => ({
  kind: "selection",
  target: "face",
  apply: (f) => (f as FaceFinder).inPlane("XZ", y),
});
const faceCyl = (): GraphValue => ({
  kind: "selection",
  target: "face",
  apply: (f) => (f as FaceFinder).ofSurfaceType("CYLINDRE"),
});
const edgeDir = (d: [number, number, number]): GraphValue => ({
  kind: "selection",
  target: "edge",
  apply: (e) => (e as EdgeFinder).inDirection(d),
});
const edgeXY = (z: number): GraphValue => ({
  kind: "selection",
  target: "edge",
  apply: (e) => (e as EdgeFinder).inPlane("XY", z),
});

/** min / max Z of a solid's bounding box — lets ports on nodes whose face
 * heights depend on upstream geometry (revolve, boss) locate their caps. */
function zBounds(solid: Shape3D): { min: number; max: number } {
  const [lo, hi] = solid.boundingBox.bounds;
  return { min: lo[2], max: hi[2] };
}

/**
 * Selection ports exposed by each modifier: handle → build(params, solid?) →
 * selection. `solid` is the evaluated source shape when available, so ports can
 * read its actual bounds instead of guessing from params (needed for revolve /
 * boss, whose cap heights come from upstream geometry).
 */
type PortBuilder = (p: Record<string, unknown>, solid?: Shape3D) => GraphValue;
const SELECTION_PORTS: Record<string, Record<string, PortBuilder>> = {
  extrude: {
    cap: (p) => faceXY(Number(p.height ?? 1)),
    bottom: () => faceXY(0),
    sideEdges: () => edgeDir([0, 0, 1]),
    capEdges: (p) => edgeXY(Number(p.height ?? 1)),
    bottomEdges: () => edgeXY(0),
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
  // revolve caps sit at the profile's own Z extents → read them from the solid
  revolve: {
    top: (_p, s) => faceXY(s ? zBounds(s).max : 0),
    bottom: (_p, s) => faceXY(s ? zBounds(s).min : 0),
    side: () => faceCyl(),
  },
  // boss cap is the new topmost face; base bottom stays at the original floor
  bossOnCap: {
    top: (_p, s) => faceXY(s ? zBounds(s).max : 0),
    bottom: (_p, s) => faceXY(s ? zBounds(s).min : 0),
    bossSide: () => faceCyl(),
    topEdges: (_p, s) => edgeXY(s ? zBounds(s).max : 0),
  },
};

/** Resolve an input ref to its GraphValue, given an evaluator for main outputs. */
function resolveRef(
  ref: string,
  byId: Map<string, NodeDescriptor>,
  evalNode: (id: string) => GraphValue,
): GraphValue {
  const { node, handle } = parseRef(ref);
  if (handle === "out") return evalNode(node);
  const src = byId.get(node);
  const build = src ? SELECTION_PORTS[src.type]?.[handle] : undefined;
  if (!build) throw new Error(`no selection port "${handle}" on ${src?.type ?? node}`);
  // geometry-aware ports (revolve/boss) need the evaluated source solid
  const v = evalNode(node);
  const solid = v.kind === "solid" ? v.solid : undefined;
  return build(src!.params ?? {}, solid);
}

/* ------------------------------------------------------------------ */
/* Node registry                                                       */
/* ------------------------------------------------------------------ */

function expectSketch(v: GraphValue | undefined, node: string): Drawing {
  if (!v || v.kind !== "sketch2d")
    throw new Error(`[${node}] expected a sketch2d input, got ${v?.kind ?? "nothing"}`);
  return v.drawing;
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

function expectMesh(v: GraphValue | undefined, node: string): MeshData {
  if (!v || v.kind !== "mesh")
    throw new Error(`[${node}] expected a mesh input, got ${v?.kind ?? "nothing"}`);
  return v.mesh;
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
    const solid = dr.sketchOnPlane("XZ").revolve([0, 0, 1], { angle }) as Shape3D;
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

  /* --- ops 3D --- */
  boolean3d: (inputs, params) => {
    const a = expectSolid(inputs.base, "boolean3d");
    const b = expectSolid(inputs.tool, "boolean3d");
    const op = String(params.op ?? "union");
    const out = op === "difference" ? a.cut(b) : op === "intersection" ? a.intersect(b) : a.fuse(b);
    return { kind: "solid", solid: out as Shape3D };
  },
  mirror3d: (inputs, params) => {
    const solid = expectSolid(inputs.in, "mirror3d");
    const plane = String(params.plane ?? "YZ") as "XY" | "XZ" | "YZ";
    return { kind: "solid", solid: solid.clone().mirror(plane) as Shape3D };
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
    const denom = Math.abs(total) >= 360 ? count : Math.max(1, count - 1);
    let out: Shape3D = solid;
    for (let i = 1; i < count; i++) {
      out = out.fuse(solid.clone().rotate((total / denom) * i, [0, 0, 0], [0, 0, 1]) as Shape3D) as Shape3D;
    }
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

  /** Extrude a 2D profile into a solid. */
  extrude: (inputs, params) => {
    const dr = expectSketch(inputs.in, "extrude");
    const h = Number(params.height ?? 1);
    const solid = dr.sketchOnPlane("XY").extrude(h) as Shape3D;
    return { kind: "solid", solid };
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
        case "bottom": return f.inPlane("XY", offset);
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
    const sel = inputs.sel;
    if (sel && sel.kind === "selection" && sel.target === "edge") {
      return { kind: "solid", solid: solid.fillet(r, (e) => sel.apply(e) as EdgeFinder) as Shape3D };
    }
    return { kind: "solid", solid: solid.fillet(r) as Shape3D };
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
    return { kind: "solid", solid: solid.translate(tx, ty, tz) as Shape3D };
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

  /** Weld a triangle soup into a clean manifold mesh (STL repair). */
  repair: (inputs) => {
    const mesh = expectMesh(inputs.in, "repair");
    return { kind: "mesh", mesh: repairMesh(mesh).mesh };
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

export function evalGraph(graph: Graph): { outputs: Record<string, GraphValue>; order: string[] } {
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
    const { inputs, params } = resolveInputs(node.type, rawInputs, node.params ?? {});
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
): { outputs: Record<string, GraphValue>; hits: number; misses: number } {
  cache.run++;
  const byId = new Map(graph.map((n) => [n.id, n]));
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
      `${node.type}(${hashParams(node.params ?? {})})[${childParts.sort().join(",")}]`,
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
      const { inputs, params } = resolveInputs(node.type, rawInputs, node.params ?? {});
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
