import { describe, it, expect } from "vitest";
import { meshMassProps, manifoldStats } from "../src/massprops";

const f32 = (a: number[]) => new Float32Array(a);
const u32 = (a: number[]) => new Uint32Array(a);

describe("meshMassProps", () => {
  it("computes area and bbox of a 3-4-5 right triangle", () => {
    const verts = f32([0, 0, 0, 3, 0, 0, 0, 4, 0]);
    const idx = u32([0, 1, 2]);
    const p = meshMassProps(verts, idx);
    expect(p.area).toBeCloseTo(6, 6); // ½·3·4
    expect(p.triangles).toBe(1);
    expect(p.bbox.size).toEqual([3, 4, 0]);
  });

  it("computes the volume of a unit tetrahedron (outward-wound)", () => {
    // corners (0,0,0),(1,0,0),(0,1,0),(0,0,1) → volume 1/6
    const v = f32([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1]);
    const t = u32([0, 2, 1, 0, 1, 3, 0, 3, 2, 1, 2, 3]);
    expect(meshMassProps(v, t).volume).toBeCloseTo(1 / 6, 6);
  });
});

describe("manifoldStats", () => {
  it("flags an open single triangle as not watertight", () => {
    const s = manifoldStats(f32([0, 0, 0, 1, 0, 0, 0, 1, 0]), u32([0, 1, 2]));
    expect(s.watertight).toBe(false);
    expect(s.boundaryEdges).toBe(3);
  });

  it("reports a closed tetrahedron as watertight", () => {
    const v = f32([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1]);
    const t = u32([0, 2, 1, 0, 1, 3, 0, 3, 2, 1, 2, 3]);
    const s = manifoldStats(v, t);
    expect(s.watertight).toBe(true);
    expect(s.boundaryEdges).toBe(0);
    expect(s.nonManifold).toBe(0);
  });

  it("welds coincident (split) vertices by position", () => {
    // same tetra but each triangle uses its own duplicated corners
    const raw: number[] = [];
    const tris = [[[0, 0, 0], [0, 1, 0], [1, 0, 0]], [[0, 0, 0], [1, 0, 0], [0, 0, 1]], [[0, 0, 0], [0, 0, 1], [0, 1, 0]], [[1, 0, 0], [0, 1, 0], [0, 0, 1]]];
    const idx: number[] = [];
    for (const tri of tris) for (const p of tri) { idx.push(raw.length / 3); raw.push(...p); }
    const s = manifoldStats(f32(raw), u32(idx));
    expect(s.watertight).toBe(true); // welding recovers the shared edges
  });
});
