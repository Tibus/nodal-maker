/**
 * The face/edge criteria system + input resolution.
 *
 * A selection is expressed as DATA (a `Crit`) and re-resolved against whatever
 * geometry a fillet/bevel/shell receives, so a pick survives regeneration and
 * even follows the geometry through transform-family nodes.
 */
import type { EdgeFinder, FaceFinder, Shape3D } from "replicad";
import { NODE_SPECS, paramPortType, type SocketType } from "../specs";
import { dimensions, type SketchDoc } from "../../sketch/model";
import { toNumber } from "../expr";
import type { Crit, CritBuilder, GraphValue, NodeDescriptor, Plane, Vec3 } from "./types";

/**
 * Split a node's evaluated inputs into structural inputs (sketch/solid/mesh
 * ports) and scalar param overrides (number/text ports). A param whose port is
 * wired takes the upstream value; otherwise the node keeps its inline default.
 */
export function resolveInputs(
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
const faceOnPlane = (plane: Plane, off: number): Crit =>
  plane === "XZ" ? faceXZ(off) : plane === "YZ" ? faceYZ(off) : faceXY(off);
const edgeOnPlane = (plane: Plane, off: number): Crit =>
  plane === "XZ" ? { target: "edge", t: "planeXZ", y: off } : plane === "YZ" ? { target: "edge", t: "planeYZ", x: off } : edgeXY(off);
const axisDir = (plane: Plane): Vec3 => (plane === "XZ" ? [0, 1, 0] : plane === "YZ" ? [1, 0, 0] : [0, 0, 1]);

/** Compile a crit into the finder-mutating closure that fillet/bevel/shell call. */
export function critApply(c: Crit): (finder: unknown) => unknown {
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
export const critToSelection = (c: Crit): GraphValue => ({ kind: "selection", target: c.target, apply: critApply(c) });

/** min / max Z of a solid's bounding box — lets ports on nodes whose face
 * heights depend on upstream geometry (revolve, boss) locate their caps. */
export function zBounds(solid: Shape3D): { min: number; max: number } {
  const [lo, hi] = solid.boundingBox.bounds;
  return { min: lo[2], max: hi[2] };
}

/**
 * "Leaf" selection ports: handle → crit(params, solid?). `solid` is the evaluated
 * source shape when available, so ports can read its actual bounds instead of
 * guessing from params (needed for revolve / boss, whose caps come from upstream).
 */
export const LEAF_PORTS: Record<string, Record<string, CritBuilder>> = {
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

export function translateCrit(c: Crit, dx: number, dy: number, dz: number): Crit {
  if (c.t === "planeXY") return { ...c, z: c.z + dz };
  if (c.target === "face" && c.t === "planeYZ") return { ...c, x: c.x + dx };
  if (c.target === "face" && c.t === "planeXZ") return { ...c, y: c.y + dy };
  return c; // parallel / cyl / planar / dir / all are translation-invariant
}
export function scaleCrit(c: Crit, f: number): Crit {
  if (c.t === "planeXY") return { ...c, z: c.z * f };
  if (c.target === "face" && c.t === "planeYZ") return { ...c, x: c.x * f };
  if (c.target === "face" && c.t === "planeXZ") return { ...c, y: c.y * f };
  return c;
}
export function mirrorCrit(c: Crit, plane: "XY" | "XZ" | "YZ"): Crit {
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
export function rotateZCrit(c: Crit, angleDeg: number): Crit | null {
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
export function forwardCrit(c: Crit, nodeType: string, p: Record<string, unknown>): Crit | null {
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
export function resolveCrit(
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
export function resolveRef(
  ref: string,
  byId: Map<string, NodeDescriptor>,
  evalNode: (id: string) => GraphValue,
): GraphValue {
  const { node, handle } = parseRef(ref);
  if (handle === "out") return evalNode(node);
  return critToSelection(resolveCrit(ref, byId, evalNode));
}
