/**
 * Headless coverage of the less-obvious constraints (angle, perpendicular,
 * parallel, equal, tangent, midpoint) — catches solver regressions that the
 * rectangle test wouldn't.
 */
import { emptyDoc, addPoint, nextId } from "../src/sketch/model.ts";
import type { SketchDoc, Constraint, Entity } from "../src/sketch/model.ts";
import { solve } from "../src/sketch/solver.ts";

const L = (d: SketchDoc, p1: string, p2: string): Entity => {
  const e: Entity = { id: nextId(d, "e"), kind: "line", p1, p2 };
  d.entities.push(e);
  return e;
};
const C = (d: SketchDoc, o: Record<string, unknown>) => d.constraints.push({ id: nextId(d, "c"), ...o } as unknown as Constraint);
const dir = (d: SketchDoc, e: Entity & { kind: "line" }) => {
  const a = d.points.find((q) => q.id === e.p1)!, b = d.points.find((q) => q.id === e.p2)!;
  return [b.x - a.x, b.y - a.y];
};
const angleBetween = (d: SketchDoc, e1: Entity & { kind: "line" }, e2: Entity & { kind: "line" }) => {
  const [a, b] = [dir(d, e1), dir(d, e2)];
  return Math.abs((Math.atan2(a[0] * b[1] - a[1] * b[0], a[0] * b[0] + a[1] * b[1]) * 180) / Math.PI);
};
const len = (d: SketchDoc, e: Entity & { kind: "line" }) => { const v = dir(d, e); return Math.hypot(v[0], v[1]); };

const results: [string, boolean, string][] = [];
const check = (name: string, cond: boolean, detail: string) => results.push([name, cond, detail]);

// --- angle: two lines from a shared point, constrained to 55° ---
{
  const d = emptyDoc();
  const o = addPoint(d, 0, 0); o.fixed = true;
  const a = addPoint(d, 30, 3), b = addPoint(d, 20, 25);
  const l1 = L(d, o.id, a.id) as Entity & { kind: "line" };
  const l2 = L(d, o.id, b.id) as Entity & { kind: "line" };
  C(d, { kind: "angle", a: l1.id, b: l2.id, value: 55, name: "a1" });
  C(d, { kind: "horizontal", line: l1.id });
  solve(d);
  const ang = angleBetween(d, l1, l2);
  check("angle 55°", Math.abs(ang - 55) < 0.2, `got ${ang.toFixed(2)}`);
}

// --- perpendicular ---
{
  const d = emptyDoc();
  const o = addPoint(d, 0, 0); o.fixed = true;
  const a = addPoint(d, 40, 2), b = addPoint(d, 5, 30);
  const l1 = L(d, o.id, a.id) as Entity & { kind: "line" };
  const l2 = L(d, o.id, b.id) as Entity & { kind: "line" };
  C(d, { kind: "horizontal", line: l1.id });
  C(d, { kind: "perpendicular", a: l1.id, b: l2.id });
  solve(d);
  check("perpendicular", Math.abs(angleBetween(d, l1, l2) - 90) < 0.2, `got ${angleBetween(d, l1, l2).toFixed(2)}`);
}

// --- parallel ---
{
  const d = emptyDoc();
  const a = addPoint(d, 0, 0), b = addPoint(d, 40, 0); a.fixed = true; b.fixed = true;
  const c = addPoint(d, 2, 20), e = addPoint(d, 38, 27);
  const l1 = L(d, a.id, b.id) as Entity & { kind: "line" };
  const l2 = L(d, c.id, e.id) as Entity & { kind: "line" };
  C(d, { kind: "parallel", a: l1.id, b: l2.id });
  solve(d);
  check("parallel", angleBetween(d, l1, l2) < 0.2, `got ${angleBetween(d, l1, l2).toFixed(2)}`);
}

// --- equal length ---
{
  const d = emptyDoc();
  const a = addPoint(d, 0, 0), b = addPoint(d, 50, 0); a.fixed = true; b.fixed = true;
  const c = addPoint(d, 0, 20), e = addPoint(d, 30, 20); c.fixed = true;
  const l1 = L(d, a.id, b.id) as Entity & { kind: "line" };
  const l2 = L(d, c.id, e.id) as Entity & { kind: "line" };
  C(d, { kind: "equal", a: l1.id, b: l2.id });
  solve(d);
  check("equal length", Math.abs(len(d, l1) - len(d, l2)) < 0.05, `${len(d, l1).toFixed(2)} vs ${len(d, l2).toFixed(2)}`);
}

// --- tangent: line tangent to a circle of radius 12 ---
{
  const d = emptyDoc();
  const cc = addPoint(d, 0, 0); cc.fixed = true;
  const circle: Entity = { id: nextId(d, "e"), kind: "circle", c: cc.id, r: 12 };
  d.entities.push(circle);
  const a = addPoint(d, -40, 20), b = addPoint(d, 40, 18);
  const line = L(d, a.id, b.id) as Entity & { kind: "line" };
  C(d, { kind: "horizontal", line: line.id });
  C(d, { kind: "tangent", a: line.id, b: circle.id });
  C(d, { kind: "radius", ent: circle.id, value: 12, name: "r1" });
  solve(d);
  const pa = d.points.find((q) => q.id === a.id)!, pb = d.points.find((q) => q.id === b.id)!;
  const distToLine = Math.abs((0 - pa.x) * (pb.y - pa.y) - (0 - pa.y) * (pb.x - pa.x)) / Math.hypot(pb.x - pa.x, pb.y - pa.y);
  check("tangent line-circle", Math.abs(distToLine - 12) < 0.05, `dist ${distToLine.toFixed(3)} vs r 12`);
}

// --- midpoint: point m at the middle of a line ---
{
  const d = emptyDoc();
  const a = addPoint(d, 0, 0), b = addPoint(d, 40, 20); a.fixed = true; b.fixed = true;
  const line = L(d, a.id, b.id) as Entity & { kind: "line" };
  const m = addPoint(d, 5, 5);
  C(d, { kind: "midpoint", p: m.id, line: line.id });
  solve(d);
  const pm = d.points.find((q) => q.id === m.id)!;
  check("midpoint", Math.abs(pm.x - 20) < 0.05 && Math.abs(pm.y - 10) < 0.05, `(${pm.x.toFixed(2)},${pm.y.toFixed(2)})`);
}

let ok = true;
for (const [name, pass, detail] of results) {
  console.log(`${pass ? "✓" : "✗"} ${name.padEnd(22)} ${detail}`);
  if (!pass) ok = false;
}
console.log(ok ? "\nALL PASS" : "\nFAILURES");
process.exit(ok ? 0 : 1);
