import { describe, it, expect } from "vitest";
import { marchingCubes } from "../src/kernel/marchingCubes";
import { manifoldStats, meshMassProps } from "../src/massprops";

describe("marchingCubes", () => {
  it("extracts a closed sphere isosurface (watertight, volume ≈ 4/3πr³)", () => {
    const r = 8;
    // signed field: >0 inside the sphere (MC treats field<0 as solid, so negate)
    const field = (x: number, y: number, z: number) => Math.hypot(x, y, z) - r;
    const m = marchingCubes(field, [-12, -12, -12], [12, 12, 12], 40);
    expect(m.indices.length).toBeGreaterThan(0);
    const stats = manifoldStats(m.vertices, m.indices);
    expect(stats.boundaryEdges).toBe(0); // closed surface, no open edges
    const vol = meshMassProps(m.vertices, m.indices).volume;
    const exact = (4 / 3) * Math.PI * r ** 3;
    expect(vol).toBeGreaterThan(exact * 0.9);
    expect(vol).toBeLessThan(exact * 1.1);
  });

  it("returns empty geometry when the field never crosses zero", () => {
    const m = marchingCubes(() => 1, [0, 0, 0], [10, 10, 10], 8);
    expect(m.indices.length).toBe(0);
  });
});
