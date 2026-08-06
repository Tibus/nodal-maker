import { describe, it, expect } from "vitest";
import { solve, degreesOfFreedom } from "../src/sketch/solver";
import { starterRect, plateWithHole, circleDoc } from "../src/sketch/presets";
import { getPoint, dimensions } from "../src/sketch/model";

describe("sketch constraint solver", () => {
  it("solves the starter rectangle to a small residual", () => {
    const doc = starterRect(40, 30);
    const r = solve(doc);
    expect(r.ok).toBe(true);
    expect(r.residual).toBeLessThan(1e-6);
  });

  it("solves a plate-with-hole preset", () => {
    const r = solve(plateWithHole(60, 40, 10));
    expect(r.ok).toBe(true);
    expect(r.residual).toBeLessThan(1e-6);
  });

  it("honours a driving dimension override", () => {
    const doc = starterRect(40, 30);
    const dims = dimensions(doc);
    expect(dims.length).toBeGreaterThan(0);
    const target = dims[0];
    const overrides: Record<string, number> = { [target.name]: 55 };
    solve(doc, { overrides });
    // the re-solved geometry should reflect the new dimension value
    const solved = dimensions(doc).find((d) => d.name === target.name)!;
    expect(solved.value).toBeCloseTo(55, 6);
  });

  it("pins a point to a fixed location", () => {
    const doc = starterRect(40, 30);
    const pid = doc.points[0].id;
    solve(doc, { pin: [{ id: pid, x: 7, y: -3 }] });
    const p = getPoint(doc, pid);
    expect(p.x).toBeCloseTo(7, 6);
    expect(p.y).toBeCloseTo(-3, 6);
  });

  it("reports degrees of freedom as a finite number", () => {
    const dof = degreesOfFreedom(circleDoc(8));
    expect(Number.isFinite(dof)).toBe(true);
    expect(dof).toBeGreaterThanOrEqual(0);
  });
});
