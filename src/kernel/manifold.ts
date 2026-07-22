/**
 * Mesh-domain kernel, powered by Manifold (Google, WASM).
 *
 * This is the counterpart of the replicad/OCCT B-rep side. Where OCCT gives us
 * parametric CAD (offset, extrude, fillet), Manifold gives us GUARANTEED-manifold
 * mesh booleans, welding/repair and triangle-region segmentation — the tools we
 * need to import an STL and modify it, or to combine CAD output with meshes.
 *
 * Like `nodes.ts` never calls `setOC`, this module never initialises the WASM
 * itself: the caller (browser worker or Node smoke test) injects an initialised
 * `ManifoldToplevel` via `setManifold`. That keeps this logic runnable in both
 * environments.
 *
 * The data that travels on the graph edges is `MeshData` — a plain, transferable
 * triangle soup (flat positions + indices). We convert to/from Manifold's own
 * `Mesh` only at the boundary of each operation. It costs an extra copy per op
 * but keeps edge values serialisable (worker-friendly) and decoupled from WASM
 * lifetime — good enough for the spike; batching ops on a live `Manifold` handle
 * is a later optimisation.
 */
import type { ManifoldToplevel } from "manifold-3d";

/* ------------------------------------------------------------------ */
/* Injected WASM instance                                              */
/* ------------------------------------------------------------------ */

let MF: ManifoldToplevel | null = null;

/** Inject an initialised Manifold module. Idempotent-ish: last one wins. */
export function setManifold(mf: ManifoldToplevel): void {
  mf.setup();
  MF = mf;
}

function mod(): ManifoldToplevel {
  if (!MF) throw new Error("Manifold not initialised — call setManifold() first");
  return MF;
}

/* ------------------------------------------------------------------ */
/* Transferable mesh payload (the graph's `mesh` value)                */
/* ------------------------------------------------------------------ */

export interface MeshData {
  /** flat XYZ positions: vertices[v*3 + {0,1,2}] */
  vertices: Float32Array;
  /** triangle corner indices, CCW seen from outside */
  indices: Uint32Array;
}

export type BooleanOp = "union" | "difference" | "intersection";

/* ------------------------------------------------------------------ */
/* Conversions MeshData <-> Manifold                                   */
/* ------------------------------------------------------------------ */

/**
 * Build a Manifold from a MeshData. Welds coincident vertices first (`merge`),
 * because triangle soups (e.g. straight from an STL) have unshared vertices and
 * would otherwise fail the 2-manifold check. Throws with the precise
 * `ErrorStatus` if the result is still not a valid oriented 2-manifold.
 */
export function meshDataToManifold(md: MeshData): InstanceType<ManifoldToplevel["Manifold"]> {
  const { Mesh, Manifold } = mod();
  const mesh = new Mesh({
    numProp: 3,
    vertProperties: md.vertices,
    triVerts: md.indices,
  });
  mesh.merge(); // weld open edges within tolerance — the "repair" primitive
  const man = Manifold.ofMesh(mesh);
  const status = man.status();
  if (status !== "NoError") {
    man.delete();
    throw new Error(`meshDataToManifold: not a valid 2-manifold (${status})`);
  }
  return man;
}

/** Extract a plain MeshData from a Manifold, keeping only XYZ positions. */
export function manifoldToMeshData(man: InstanceType<ManifoldToplevel["Manifold"]>): MeshData {
  const m = man.getMesh();
  const { numProp, vertProperties, triVerts } = m;
  if (numProp === 3) {
    return {
      vertices: new Float32Array(vertProperties),
      indices: new Uint32Array(triVerts),
    };
  }
  // De-interleave: positions are always the first three properties.
  const vertCount = vertProperties.length / numProp;
  const vertices = new Float32Array(vertCount * 3);
  for (let v = 0; v < vertCount; v++) {
    vertices[v * 3] = vertProperties[v * numProp];
    vertices[v * 3 + 1] = vertProperties[v * numProp + 1];
    vertices[v * 3 + 2] = vertProperties[v * numProp + 2];
  }
  return { vertices, indices: new Uint32Array(triVerts) };
}

/* ------------------------------------------------------------------ */
/* Operations                                                          */
/* ------------------------------------------------------------------ */

/** Robust mesh boolean (union / difference / intersection). */
export function booleanMesh(a: MeshData, b: MeshData, op: BooleanOp): MeshData {
  const { Manifold } = mod();
  const ma = meshDataToManifold(a);
  const mb = meshDataToManifold(b);
  const res =
    op === "union"
      ? Manifold.union(ma, mb)
      : op === "difference"
        ? Manifold.difference(ma, mb)
        : Manifold.intersection(ma, mb);
  try {
    const status = res.status();
    if (status !== "NoError") throw new Error(`boolean(${op}) failed: ${status}`);
    return manifoldToMeshData(res);
  } finally {
    ma.delete();
    mb.delete();
    res.delete();
  }
}

export interface RepairResult {
  mesh: MeshData;
  /** true if welding actually changed the mesh (i.e. it wasn't manifold as-is) */
  merged: boolean;
  /** vertex/triangle counts before and after, for reporting */
  before: { vertices: number; triangles: number };
  after: { vertices: number; triangles: number };
}

/**
 * Weld an unstructured triangle soup into a clean manifold mesh. This is what
 * makes an imported STL usable: STL stores each triangle independently, so its
 * vertices are all duplicated and its "solid" has no topological connectivity
 * until we merge coincident vertices.
 */
export function repairMesh(md: MeshData): RepairResult {
  const { Mesh, Manifold } = mod();
  const mesh = new Mesh({
    numProp: 3,
    vertProperties: md.vertices,
    triVerts: md.indices,
  });
  const merged = mesh.merge();
  const man = Manifold.ofMesh(mesh);
  try {
    const status = man.status();
    if (status !== "NoError") throw new Error(`repair failed: not manifold (${status})`);
    const out = manifoldToMeshData(man);
    return {
      mesh: out,
      merged,
      before: { vertices: md.vertices.length / 3, triangles: md.indices.length / 3 },
      after: { vertices: out.vertices.length / 3, triangles: out.indices.length / 3 },
    };
  } finally {
    man.delete();
  }
}

/* ------------------------------------------------------------------ */
/* Extra mesh operations (all via Manifold)                            */
/* ------------------------------------------------------------------ */

export interface MeshTransform {
  tx?: number; ty?: number; tz?: number;
  rx?: number; ry?: number; rz?: number; // degrees
  scale?: number;
}

/** Translate / rotate (deg, per axis) / uniform-scale a mesh. */
export function transformMesh(md: MeshData, t: MeshTransform): MeshData {
  const man = meshDataToManifold(md);
  const handles = [man];
  let cur = man;
  const s = t.scale ?? 1;
  if (s !== 1) { cur = cur.scale(s); handles.push(cur); }
  if ((t.rx ?? 0) || (t.ry ?? 0) || (t.rz ?? 0)) { cur = cur.rotate([t.rx ?? 0, t.ry ?? 0, t.rz ?? 0]); handles.push(cur); }
  if ((t.tx ?? 0) || (t.ty ?? 0) || (t.tz ?? 0)) { cur = cur.translate([t.tx ?? 0, t.ty ?? 0, t.tz ?? 0]); handles.push(cur); }
  try {
    return manifoldToMeshData(cur);
  } finally {
    handles.forEach((h) => h.delete());
  }
}

/** Convex hull of a mesh. */
export function hullMesh(md: MeshData): MeshData {
  const man = meshDataToManifold(md);
  const res = man.hull();
  try {
    return manifoldToMeshData(res);
  } finally {
    man.delete();
    res.delete();
  }
}

/** Minkowski sum a ⊕ b — e.g. round `a` by a small sphere `b`. */
export function minkowskiMesh(a: MeshData, b: MeshData): MeshData {
  const ma = meshDataToManifold(a);
  const mb = meshDataToManifold(b);
  const res = ma.minkowskiSum(mb);
  try {
    return manifoldToMeshData(res);
  } finally {
    ma.delete();
    mb.delete();
    res.delete();
  }
}

/** Decimate/simplify a mesh within a geometric tolerance. */
export function simplifyMesh(md: MeshData, tolerance: number): MeshData {
  const man = meshDataToManifold(md);
  const res = man.simplify(tolerance);
  try {
    return manifoldToMeshData(res);
  } finally {
    man.delete();
    res.delete();
  }
}

/** Subdivide each triangle `n` extra times (refine). */
export function refineMesh(md: MeshData, n: number): MeshData {
  const man = meshDataToManifold(md);
  const res = man.refine(Math.max(1, Math.round(n)));
  try {
    return manifoldToMeshData(res);
  } finally {
    man.delete();
    res.delete();
  }
}

/* ------------------------------------------------------------------ */
/* Coplanar segmentation (mesh-domain face flagging)                   */
/* ------------------------------------------------------------------ */

export interface MeshRegion {
  /** indices into the triangle list (not the vertex list) */
  triangles: number[];
  /** averaged unit normal of the region */
  normal: [number, number, number];
  area: number;
}

/**
 * Segment a mesh into flat regions: flood-fill across edge-adjacent triangles
 * whose normals stay within `angularToleranceDeg`. This is the mesh-domain
 * equivalent of B-rep face flagging — it recovers reusable "faces" (a cube's
 * six sides, an extrusion's cap and contour) from an otherwise flat triangle
 * soup, so downstream nodes can select regions by criteria.
 */
export function segmentMesh(md: MeshData, angularToleranceDeg = 5): MeshRegion[] {
  const triCount = md.indices.length / 3;
  const normals = new Float32Array(triCount * 3);
  const areas = new Float32Array(triCount);

  for (let t = 0; t < triCount; t++) {
    const ia = md.indices[t * 3];
    const ib = md.indices[t * 3 + 1];
    const ic = md.indices[t * 3 + 2];
    const ax = md.vertices[ia * 3], ay = md.vertices[ia * 3 + 1], az = md.vertices[ia * 3 + 2];
    const bx = md.vertices[ib * 3], by = md.vertices[ib * 3 + 1], bz = md.vertices[ib * 3 + 2];
    const cx = md.vertices[ic * 3], cy = md.vertices[ic * 3 + 1], cz = md.vertices[ic * 3 + 2];
    // cross((b-a),(c-a))
    const ux = bx - ax, uy = by - ay, uz = bz - az;
    const vx = cx - ax, vy = cy - ay, vz = cz - az;
    const nx = uy * vz - uz * vy;
    const ny = uz * vx - ux * vz;
    const nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz) || 1;
    normals[t * 3] = nx / len;
    normals[t * 3 + 1] = ny / len;
    normals[t * 3 + 2] = nz / len;
    areas[t] = len / 2;
  }

  // adjacency: undirected edge (minVert,maxVert) -> triangles sharing it
  const edgeMap = new Map<string, number[]>();
  const edgeKey = (a: number, b: number) => (a < b ? `${a}_${b}` : `${b}_${a}`);
  for (let t = 0; t < triCount; t++) {
    const i0 = md.indices[t * 3], i1 = md.indices[t * 3 + 1], i2 = md.indices[t * 3 + 2];
    for (const [a, b] of [[i0, i1], [i1, i2], [i2, i0]] as const) {
      const k = edgeKey(a, b);
      const arr = edgeMap.get(k);
      if (arr) arr.push(t);
      else edgeMap.set(k, [t]);
    }
  }

  const cosTol = Math.cos((angularToleranceDeg * Math.PI) / 180);
  const region = new Int32Array(triCount).fill(-1);
  const regions: MeshRegion[] = [];

  for (let seed = 0; seed < triCount; seed++) {
    if (region[seed] !== -1) continue;
    const rid = regions.length;
    const tris: number[] = [];
    let anx = 0, any = 0, anz = 0, area = 0;
    const stack = [seed];
    region[seed] = rid;
    while (stack.length) {
      const t = stack.pop()!;
      tris.push(t);
      anx += normals[t * 3] * areas[t];
      any += normals[t * 3 + 1] * areas[t];
      anz += normals[t * 3 + 2] * areas[t];
      area += areas[t];
      const i0 = md.indices[t * 3], i1 = md.indices[t * 3 + 1], i2 = md.indices[t * 3 + 2];
      for (const [a, b] of [[i0, i1], [i1, i2], [i2, i0]] as const) {
        for (const nb of edgeMap.get(edgeKey(a, b)) ?? []) {
          if (region[nb] !== -1) continue;
          const dot =
            normals[t * 3] * normals[nb * 3] +
            normals[t * 3 + 1] * normals[nb * 3 + 1] +
            normals[t * 3 + 2] * normals[nb * 3 + 2];
          if (dot >= cosTol) {
            region[nb] = rid;
            stack.push(nb);
          }
        }
      }
    }
    const nlen = Math.hypot(anx, any, anz) || 1;
    regions.push({
      triangles: tris,
      normal: [anx / nlen, any / nlen, anz / nlen],
      area,
    });
  }

  return regions;
}
