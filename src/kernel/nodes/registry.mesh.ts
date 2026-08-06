/**
 * REGISTRY entries for the Mesh category (Manifold — the bridge from B-rep to
 * STL land) plus the criteria-based edge/face selector nodes.
 */
import type { EdgeFinder, FaceFinder } from "replicad";
import {
  booleanMesh,
  repairMesh,
  transformMesh,
  hullMesh,
  minkowskiMesh,
  simplifyMesh,
  refineMesh,
  type BooleanOp,
} from "../manifold";
import { parseBinarySTL } from "../stl";
import { expectSolid, expectMesh, meshToSolidSync } from "./helpers";
import { solidToMeshData } from "./payload";
import type { NodeImpl } from "./types";

export const meshNodes: Record<string, NodeImpl> = {
  /* --- criteria-based selectors (survive regeneration) --- */
  edgeSelect: (_inputs, params) => {
    const where = String(params.where ?? "all");
    const offset = Number(params.offset ?? 0);
    // Optional: a point lying exactly on ONE border loop. When present it narrows
    // the selection to the single loop passing through it — so a "pick border" on
    // an annular (donut) face grabs just the inner OR outer rim, not both.
    const nearRaw = params.near;
    const near =
      Array.isArray(nearRaw) && nearRaw.length === 3 && nearRaw.every((n) => Number.isFinite(Number(n)))
        ? ([Number(nearRaw[0]), Number(nearRaw[1]), Number(nearRaw[2])] as [number, number, number])
        : null;
    const apply = (e: EdgeFinder): EdgeFinder => {
      let f: EdgeFinder;
      switch (where) {
        case "vertical": f = e.inDirection([0, 0, 1]); break;
        case "horizontal-x": f = e.inDirection([1, 0, 0]); break;
        case "horizontal-y": f = e.inDirection([0, 1, 0]); break;
        case "atZ": f = e.inPlane("XY", offset); break;
        case "atX": f = e.inPlane("YZ", offset); break;
        case "atY": f = e.inPlane("XZ", offset); break;
        default: f = e;
      }
      // containsPoint(p) keeps edges passing through p (a full circular rim is a
      // single B-rep edge → the whole loop is kept, its concentric sibling isn't).
      return near ? f.containsPoint(near) : f;
    };
    // `nearest` lets a single-selection consumer track the picked edge as it
    // moves (re-binds to the closest edge each eval); `apply` stays as the static
    // criteria for the union (multi-selection) path.
    return { kind: "selection", target: "edge", apply: apply as (f: unknown) => unknown, nearest: near ?? undefined };
  },
  faceSelect: (_inputs, params) => {
    const where = String(params.where ?? "all");
    const offset = Number(params.offset ?? 0);
    // Optional AABB of a specific picked face — isolates ONE face among several
    // matching the criterion (e.g. a single bore among many cylindrical faces).
    const b = params.box;
    const box = Array.isArray(b) && b.length === 6 && b.every((n) => Number.isFinite(Number(n))) ? b.map(Number) : null;
    const apply = (f: FaceFinder): FaceFinder => {
      let ff: FaceFinder;
      switch (where) {
        case "top":
        case "bottom":
        case "atZ": ff = f.inPlane("XY", offset); break; // precise plane at Z = offset
        case "atX": ff = f.inPlane("YZ", offset); break; // precise plane at X = offset
        case "atY": ff = f.inPlane("XZ", offset); break; // precise plane at Y = offset
        case "horizontal": ff = f.parallelTo("XY"); break;
        case "vertical-x": ff = f.parallelTo("YZ"); break;
        case "vertical-y": ff = f.parallelTo("XZ"); break;
        case "planar": ff = f.ofSurfaceType("PLANE"); break;
        case "cylindrical": ff = f.ofSurfaceType("CYLINDRE"); break;
        default: ff = f;
      }
      return box ? ff.inBox([box[0], box[1], box[2]], [box[3], box[4], box[5]]) : ff;
    };
    return { kind: "selection", target: "face", apply: apply as (f: unknown) => unknown };
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
