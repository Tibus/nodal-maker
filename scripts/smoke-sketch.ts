/**
 * Headless test of the constraint solver — no replicad/three needed.
 * Builds a rectangle from 4 loose points + geometric constraints + two driving
 * dimensions, solves, and checks the result matches the dimensions.
 */
import { emptyDoc, addPoint, nextId } from "../src/sketch/model.ts";
import type { SketchDoc, Constraint, Entity } from "../src/sketch/model.ts";
import { solve } from "../src/sketch/solver.ts";
import { traceLoops } from "../src/sketch/geometry.ts";

function line(d: SketchDoc, p1: string, p2: string): Entity {
  const e: Entity = { id: nextId(d, "e"), kind: "line", p1, p2 };
  d.entities.push(e);
  return e;
}
function con(d: SketchDoc, c: Record<string, unknown>): Constraint {
  const full = { id: nextId(d, "c"), ...c } as unknown as Constraint;
  d.constraints.push(full);
  return full;
}

const d = emptyDoc("XY");
// four corners, deliberately skewed so the solver has work to do
const a = addPoint(d, 2, 1);
const b = addPoint(d, 43, -3);
const c = addPoint(d, 46, 28);
const e = addPoint(d, -1, 31);
a.fixed = true; // anchor bottom-left

const l1 = line(d, a.id, b.id);
const l2 = line(d, b.id, c.id);
const l3 = line(d, c.id, e.id);
const l4 = line(d, e.id, a.id);

con(d, { kind: "horizontal", line: l1.id });
con(d, { kind: "vertical", line: l2.id });
con(d, { kind: "horizontal", line: l3.id });
con(d, { kind: "vertical", line: l4.id });
con(d, { kind: "distanceX", a: a.id, b: b.id, value: 60, name: "width" });
con(d, { kind: "distanceY", a: a.id, b: e.id, value: 40, name: "height" });

const res = solve(d);
console.log("solve:", res);

const pt = (id: string) => d.points.find((p) => p.id === id)!;
const w = pt(b.id).x - pt(a.id).x;
const h = pt(e.id).y - pt(a.id).y;
console.log(`width = ${w.toFixed(4)} (want 60)`);
console.log(`height = ${h.toFixed(4)} (want 40)`);
console.log("corners:", [a, b, c, e].map((p) => `(${pt(p.id).x.toFixed(2)},${pt(p.id).y.toFixed(2)})`).join(" "));
console.log("loops:", traceLoops(d).map((l) => `${l.edges.length} edges, area=${l.area.toFixed(1)}`));

// override the width dimension (as the node param would) and re-solve
const res2 = solve(d, { overrides: { width: 100 } });
console.log("\nafter width→100:", res2);
console.log(`width = ${(pt(b.id).x - pt(a.id).x).toFixed(4)} (want 100)`);

const okW = Math.abs(w - 60) < 1e-2;
const okH = Math.abs(h - 40) < 1e-2;
const okRect = Math.abs(pt(c.id).x - pt(b.id).x) < 1e-2 && Math.abs(pt(c.id).y - pt(e.id).y) < 1e-2;
const okOverride = Math.abs(pt(b.id).x - pt(a.id).x - 100) < 1e-2;
console.log("\nPASS:", okW && okH && okRect && okOverride, { okW, okH, okRect, okOverride });
process.exit(okW && okH && okRect && okOverride ? 0 : 1);
