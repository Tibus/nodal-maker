/**
 * Minimal binary-STL reader/writer, working directly on `MeshData`.
 *
 * STL is the lingua franca of resin printing but topologically dumb: it stores
 * every triangle as three independent vertices with a per-facet normal and no
 * shared connectivity. So `parseBinarySTL` produces a triangle *soup* (3 verts
 * per triangle, all unshared) — which is exactly the input `repairMesh` is
 * meant to weld back into a real manifold.
 *
 * ASCII STL is intentionally not supported: real-world print files are binary,
 * and the spike only needs the binary round-trip.
 */
import type { MeshData } from "./manifold";

const HEADER_BYTES = 80;
const COUNT_BYTES = 4;
const TRI_BYTES = 50; // 12 floats (normal + 3 verts) + 2-byte attribute count

/** Parse a binary STL into a MeshData triangle soup (unshared vertices). */
export function parseBinarySTL(buffer: ArrayBuffer): MeshData {
  const view = new DataView(buffer);
  if (buffer.byteLength < HEADER_BYTES + COUNT_BYTES) {
    throw new Error("parseBinarySTL: buffer too small to be a binary STL");
  }
  const triCount = view.getUint32(HEADER_BYTES, true);
  const expected = HEADER_BYTES + COUNT_BYTES + triCount * TRI_BYTES;
  if (buffer.byteLength < expected) {
    throw new Error(
      `parseBinarySTL: truncated — expected ${expected} bytes for ${triCount} triangles, got ${buffer.byteLength}`,
    );
  }

  const vertices = new Float32Array(triCount * 9);
  const indices = new Uint32Array(triCount * 3);

  let off = HEADER_BYTES + COUNT_BYTES;
  for (let t = 0; t < triCount; t++) {
    off += 12; // skip the (often unreliable) facet normal
    for (let c = 0; c < 3; c++) {
      const base = t * 9 + c * 3;
      vertices[base] = view.getFloat32(off, true);
      vertices[base + 1] = view.getFloat32(off + 4, true);
      vertices[base + 2] = view.getFloat32(off + 8, true);
      off += 12;
      indices[t * 3 + c] = t * 3 + c;
    }
    off += 2; // attribute byte count
  }

  return { vertices, indices };
}

/** Serialise a MeshData to binary STL, recomputing per-facet normals. */
export function writeBinarySTL(md: MeshData): Uint8Array {
  const triCount = md.indices.length / 3;
  const buffer = new ArrayBuffer(HEADER_BYTES + COUNT_BYTES + triCount * TRI_BYTES);
  const view = new DataView(buffer);
  view.setUint32(HEADER_BYTES, triCount, true);

  let off = HEADER_BYTES + COUNT_BYTES;
  for (let t = 0; t < triCount; t++) {
    const ia = md.indices[t * 3], ib = md.indices[t * 3 + 1], ic = md.indices[t * 3 + 2];
    const ax = md.vertices[ia * 3], ay = md.vertices[ia * 3 + 1], az = md.vertices[ia * 3 + 2];
    const bx = md.vertices[ib * 3], by = md.vertices[ib * 3 + 1], bz = md.vertices[ib * 3 + 2];
    const cx = md.vertices[ic * 3], cy = md.vertices[ic * 3 + 1], cz = md.vertices[ic * 3 + 2];

    const ux = bx - ax, uy = by - ay, uz = bz - az;
    const vx = cx - ax, vy = cy - ay, vz = cz - az;
    let nx = uy * vz - uz * vy;
    let ny = uz * vx - ux * vz;
    let nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz) || 1;
    nx /= len; ny /= len; nz /= len;

    view.setFloat32(off, nx, true);
    view.setFloat32(off + 4, ny, true);
    view.setFloat32(off + 8, nz, true);
    off += 12;
    for (const [x, y, z] of [[ax, ay, az], [bx, by, bz], [cx, cy, cz]] as const) {
      view.setFloat32(off, x, true);
      view.setFloat32(off + 4, y, true);
      view.setFloat32(off + 8, z, true);
      off += 12;
    }
    view.setUint16(off, 0, true);
    off += 2;
  }

  return new Uint8Array(buffer);
}
