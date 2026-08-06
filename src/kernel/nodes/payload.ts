/**
 * Mesh ↔ MeshPayload conversion + face segmentation/tagging.
 *
 * Bridges the B-rep (replicad/OCCT) and mesh (Manifold) worlds into the single
 * renderable `MeshPayload` the viewport consumes.
 */
import type { Shape3D } from "replicad";
import { segmentMesh, type MeshData } from "../manifold";
import type { CapInfo, FaceTag, MeshPayload } from "./types";

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

/** B-rep → mesh: tessellate a solid into a plain triangle payload. */
export function solidToMeshData(solid: Shape3D): MeshData {
  const m = meshAndTag(solid);
  return { vertices: m.vertices, indices: m.indices };
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
