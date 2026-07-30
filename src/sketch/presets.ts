/** Starter documents so a fresh Sketch node is immediately usable. */
import { emptyDoc, addPoint, nextId } from "./model";
import type { SketchDoc, Entity, Constraint } from "./model";

function line(d: SketchDoc, p1: string, p2: string): Entity {
  const e: Entity = { id: nextId(d, "e"), kind: "line", p1, p2 };
  d.entities.push(e);
  return e;
}
function con(d: SketchDoc, c: Record<string, unknown>): void {
  d.constraints.push({ id: nextId(d, "c"), ...c } as unknown as Constraint);
}

/**
 * A fully-constrained, origin-centred rectangle with driving `width`/`height`
 * dimensions — those two surface as editable params on the Sketch node.
 */
export function starterRect(w = 40, h = 30): SketchDoc {
  const d = emptyDoc("XY");
  const a = addPoint(d, -w / 2, -h / 2);
  const b = addPoint(d, w / 2, -h / 2);
  const c = addPoint(d, w / 2, h / 2);
  const e = addPoint(d, -w / 2, h / 2);
  a.fixed = true; // anchor so the sketch can't drift as a rigid body
  const l1 = line(d, a.id, b.id);
  const l2 = line(d, b.id, c.id);
  const l3 = line(d, c.id, e.id);
  const l4 = line(d, e.id, a.id);
  con(d, { kind: "horizontal", line: l1.id });
  con(d, { kind: "vertical", line: l2.id });
  con(d, { kind: "horizontal", line: l3.id });
  con(d, { kind: "vertical", line: l4.id });
  con(d, { kind: "distanceX", a: a.id, b: b.id, value: w, name: "width" });
  con(d, { kind: "distanceY", a: a.id, b: e.id, value: h, name: "height" });
  return d;
}

/**
 * A rectangular plate with a centred circular hole — a good demo profile
 * (extrude → washer plate). Exposes width / height / hole (radius) dimensions.
 */
export function plateWithHole(w = 60, h = 40, r = 10): SketchDoc {
  const d = starterRect(w, h);
  const c = addPoint(d, 0, 0);
  const circ: Entity = { id: nextId(d, "e"), kind: "circle", c: c.id, r };
  d.entities.push(circ);
  // centre the hole via distances from the fixed bottom-left corner + a radius
  const a = d.points[0]; // starterRect's fixed corner
  con(d, { kind: "distanceX", a: a.id, b: c.id, value: w / 2, name: "holeX" });
  con(d, { kind: "distanceY", a: a.id, b: c.id, value: h / 2, name: "holeY" });
  con(d, { kind: "radius", ent: circ.id, value: r, name: "hole" });
  return d;
}
