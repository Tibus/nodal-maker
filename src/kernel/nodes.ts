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
import { type Drawing, type Shape3D } from "replicad";
import { svgPathToDrawing } from "./svgPath";

/* ------------------------------------------------------------------ */
/* Typed values that travel along the graph edges                      */
/* ------------------------------------------------------------------ */

export type GraphValue =
  | { kind: "sketch2d"; drawing: Drawing }
  | { kind: "solid"; solid: Shape3D };

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

const REGISTRY: Record<string, NodeImpl> = {
  /** SVG input: parse an SVG path `d` string into a 2D drawing. */
  svgInput: (_inputs, params) => {
    const d = String(params.d ?? "");
    if (!d.trim()) throw new Error("[svgInput] empty SVG path");
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

    const inputs: Record<string, GraphValue> = {};
    for (const [port, srcId] of Object.entries(node.inputs ?? {})) {
      inputs[port] = evalNode(srcId);
    }
    const impl = REGISTRY[node.type];
    if (!impl) throw new Error(`no implementation for node type "${node.type}"`);
    const out = impl(inputs, node.params ?? {});

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
