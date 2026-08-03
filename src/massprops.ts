/**
 * Mass / geometric properties from a triangle mesh (no OCCT needed).
 * Volume via the signed-tetrahedra (divergence) method, area by triangle sum,
 * centroid volume-weighted. Accurate for closed manifold meshes; faceted curves
 * make it a very close approximation.
 */
export interface MassProps {
  volume: number;   // mm³
  area: number;     // mm²
  bbox: { min: [number, number, number]; max: [number, number, number]; size: [number, number, number] };
  center: [number, number, number]; // centre of mass
  triangles: number;
}

export function meshMassProps(vertices: Float32Array, indices: Uint32Array): MassProps {
  let vol = 0, area = 0;
  let cx = 0, cy = 0, cz = 0;
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < vertices.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      const c = vertices[i + k];
      if (c < min[k]) min[k] = c;
      if (c > max[k]) max[k] = c;
    }
  }
  for (let t = 0; t + 2 < indices.length; t += 3) {
    const a = indices[t] * 3, b = indices[t + 1] * 3, c = indices[t + 2] * 3;
    const ax = vertices[a], ay = vertices[a + 1], az = vertices[a + 2];
    const bx = vertices[b], by = vertices[b + 1], bz = vertices[b + 2];
    const cxv = vertices[c], cyv = vertices[c + 1], czv = vertices[c + 2];
    // signed volume of the tetra (origin, a, b, c)
    const v = (ax * (by * czv - bz * cyv) - ay * (bx * czv - bz * cxv) + az * (bx * cyv - by * cxv)) / 6;
    vol += v;
    cx += v * (ax + bx + cxv) / 4;
    cy += v * (ay + by + cyv) / 4;
    cz += v * (az + bz + czv) / 4;
    // triangle area = ½|(b-a)×(c-a)|
    const ux = bx - ax, uy = by - ay, uz = bz - az;
    const wx = cxv - ax, wy = cyv - ay, wz = czv - az;
    const nx = uy * wz - uz * wy, ny = uz * wx - ux * wz, nz = ux * wy - uy * wx;
    area += Math.hypot(nx, ny, nz) / 2;
  }
  const center: [number, number, number] = vol !== 0 ? [cx / vol, cy / vol, cz / vol] : [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2];
  return {
    volume: Math.abs(vol),
    area,
    bbox: { min, max, size: [max[0] - min[0], max[1] - min[1], max[2] - min[2]] },
    center,
    triangles: indices.length / 3,
  };
}
