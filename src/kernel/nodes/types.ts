/**
 * Shared type definitions for the node-graph engine.
 *
 * Types only — no runtime code. Every other `nodes/*` module imports from here,
 * which keeps the dependency graph acyclic (types ← everything else).
 */
import type { Drawing, Shape3D } from "replicad";
import type { MeshData } from "../manifold";

/* ------------------------------------------------------------------ */
/* Typed values that travel along the graph edges                      */
/* ------------------------------------------------------------------ */

export type GraphValue =
  // `plane`/`planeOffset` (optional) record which base plane (and offset along
  // its normal) a Sketch was drawn on, so the 3D preview and Extrude/Revolve
  // place it there instead of always on XY z=0.
  | { kind: "sketch2d"; drawing: Drawing; plane?: "XY" | "XZ" | "YZ"; planeOffset?: number; frame?: SketchFrame }
  | { kind: "solid"; solid: Shape3D; color?: string }
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

export type NodeImpl = (
  inputs: Record<string, GraphValue>,
  params: Record<string, unknown>,
) => GraphValue;

/* ------------------------------------------------------------------ */
/* Selection criteria (data, not opaque closures)                      */
/* ------------------------------------------------------------------ */

export type Vec2 = [number, number];
export type Vec3 = [number, number, number];

/**
 * A selection expressed as DATA (not an opaque finder closure) so it can be
 * carried through geometry transforms — a face/edge picked on an upstream node
 * still resolves after the geometry is moved / scaled / mirrored downstream.
 */
export type Crit =
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

// plane-aware helpers: which face/edge crit for an extrude on a given base plane
export type Plane = "XY" | "XZ" | "YZ";

/**
 * "Leaf" selection ports: handle → crit(params, solid?). `solid` is the evaluated
 * source shape when available, so ports can read its actual bounds instead of
 * guessing from params (needed for revolve / boss, whose caps come from upstream).
 */
export type CritBuilder = (p: Record<string, unknown>, solid?: Shape3D, plane?: Plane, offset?: number) => Crit;

/* ------------------------------------------------------------------ */
/* Sketch placement + geometry helper shapes                           */
/* ------------------------------------------------------------------ */

/** Non-axis-aligned placement: origin + normal (extrusion dir) + local +X. */
export type SketchFrame = { origin: [number, number, number]; normal: [number, number, number]; xDir: [number, number, number] };

/** A rectangular panel edge spec (flat vs. fingered) for finger-jointed boxes. */
export type EdgeSpec = { finger: boolean; tabFirst: boolean };

/** A (radius, dz-from-turn-centre) point of a swept helical thread profile. */
export type RPt = [number, number];

/* ------------------------------------------------------------------ */
/* Incremental (content-addressed) evaluation cache                    */
/* ------------------------------------------------------------------ */

export interface EvalCache {
  entries: Map<string, { value: GraphValue; run: number }>;
  run: number;
}

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
  /** optional whole-body tint (hex) set by a Color node — overrides tag shading */
  tint?: string;
  stats: {
    faceCount: number;
    triangleCount: number;
    tagCounts: Record<FaceTag, number>;
  };
}

/* ------------------------------------------------------------------ */
/* Criteria-based face selector (the topological-naming strategy)      */
/* ------------------------------------------------------------------ */

export interface CapInfo {
  z: number;
  faceId: number | null;
  center: [number, number, number];
}
