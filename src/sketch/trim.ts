/**
 * Trim: remove the portion of an entity between its intersections with other
 * entities, on the side the user clicked. Supports lines (→ shorter line(s))
 * and circles/arcs (→ arc(s)). Pure geometry on the doc.
 */
import type { SketchDoc, Entity, Id } from "./model";
import { addPoint, nextId } from "./model";
import { arcInfo, type Vec2 } from "./geometry";

const EPS = 1e-4;

/* ---- primitive intersections --------------------------------------------- */

/** intersection of segment a1-a2 with segment b1-b2 → param t on A (or null). */
function segSeg(a1: Vec2, a2: Vec2, b1: Vec2, b2: Vec2): number | null {
  const rx = a2[0] - a1[0], ry = a2[1] - a1[1];
  const sx = b2[0] - b1[0], sy = b2[1] - b1[1];
  const denom = rx * sy - ry * sx;
  if (Math.abs(denom) < 1e-12) return null;
  const t = ((b1[0] - a1[0]) * sy - (b1[1] - a1[1]) * sx) / denom;
  const u = ((b1[0] - a1[0]) * ry - (b1[1] - a1[1]) * rx) / denom;
  if (t < -EPS || t > 1 + EPS || u < -EPS || u > 1 + EPS) return null;
  return t;
}

/** intersections of segment a1-a2 with circle (c,r) → params t on A. */
function segCircle(a1: Vec2, a2: Vec2, c: Vec2, r: number): number[] {
  const dx = a2[0] - a1[0], dy = a2[1] - a1[1];
  const fx = a1[0] - c[0], fy = a1[1] - c[1];
  const A = dx * dx + dy * dy;
  const B = 2 * (fx * dx + fy * dy);
  const C = fx * fx + fy * fy - r * r;
  const disc = B * B - 4 * A * C;
  if (disc < 0 || A < 1e-12) return [];
  const sq = Math.sqrt(disc);
  return [(-B - sq) / (2 * A), (-B + sq) / (2 * A)].filter((t) => t > -EPS && t < 1 + EPS);
}

/** does angle a fall within an arc's sweep [a1..a2] (respecting ccw)? */
function angleInArc(d: SketchDoc, e: Extract<Entity, { kind: "arc" }>, ang: number): boolean {
  const { a1, a2 } = arcInfo(d, e);
  const lo = Math.min(a1, a2), hi = Math.max(a1, a2);
  let a = ang;
  while (a < lo) a += 2 * Math.PI;
  while (a > hi) a -= 2 * Math.PI;
  return a >= lo - 1e-6 && a <= hi + 1e-6;
}

const pmap = (d: SketchDoc) => new Map(d.points.map((p) => [p.id, p] as const));

/* ---- trimming ------------------------------------------------------------ */

/** points where entity E is crossed by any other entity, as world coords. */
function crossingsOf(d: SketchDoc, E: Entity): Vec2[] {
  const pm = pmap(d);
  const pts: Vec2[] = [];
  const addByT = (a: Vec2, b: Vec2, ts: number[]) => {
    for (const t of ts) if (t > EPS && t < 1 - EPS) pts.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
  };
  const asCircle = (e: Entity): { c: Vec2; r: number; arc?: Extract<Entity, { kind: "arc" }> } | null => {
    if (e.kind === "circle") { const c = pm.get(e.c)!; return { c: [c.x, c.y], r: e.r }; }
    if (e.kind === "arc") { const c = pm.get(e.c)!, p1 = pm.get(e.p1)!; return { c: [c.x, c.y], r: Math.hypot(p1.x - c.x, p1.y - c.y), arc: e }; }
    return null;
  };
  const Eline = E.kind === "line" ? ([pm.get(E.p1)!, pm.get(E.p2)!] as const) : null;
  const Ecirc = asCircle(E);

  for (const other of d.entities) {
    if (other.id === E.id) continue;
    if (Eline) {
      const a: Vec2 = [Eline[0].x, Eline[0].y], b: Vec2 = [Eline[1].x, Eline[1].y];
      if (other.kind === "line") { const o1 = pm.get(other.p1)!, o2 = pm.get(other.p2)!; const t = segSeg(a, b, [o1.x, o1.y], [o2.x, o2.y]); if (t !== null) addByT(a, b, [t]); }
      else { const oc = asCircle(other); if (oc) { const ts = segCircle(a, b, oc.c, oc.r).filter((t) => !oc.arc || angleInArc(d, oc.arc, Math.atan2(a[1] + (b[1] - a[1]) * t - oc.c[1], a[0] + (b[0] - a[0]) * t - oc.c[0]))); addByT(a, b, ts); } }
    } else if (Ecirc) {
      // circle E crossed by a line or another circle → collect the world points
      if (other.kind === "line") { const o1 = pm.get(other.p1)!, o2 = pm.get(other.p2)!; const ts = segCircle([o1.x, o1.y], [o2.x, o2.y], Ecirc.c, Ecirc.r); for (const t of ts) pts.push([o1.x + (o2.x - o1.x) * t, o1.y + (o2.y - o1.y) * t]); }
      else { const oc = asCircle(other); if (oc) pts.push(...circleCircle(Ecirc.c, Ecirc.r, oc.c, oc.r)); }
    }
  }
  return pts;
}

function circleCircle(c0: Vec2, r0: number, c1: Vec2, r1: number): Vec2[] {
  const d = Math.hypot(c1[0] - c0[0], c1[1] - c0[1]);
  if (d < 1e-9 || d > r0 + r1 + EPS || d < Math.abs(r0 - r1) - EPS) return [];
  const a = (r0 * r0 - r1 * r1 + d * d) / (2 * d);
  const h2 = r0 * r0 - a * a;
  const h = Math.sqrt(Math.max(0, h2));
  const xm = c0[0] + (a * (c1[0] - c0[0])) / d, ym = c0[1] + (a * (c1[1] - c0[1])) / d;
  const rx = -(c1[1] - c0[1]) * (h / d), ry = (c1[0] - c0[0]) * (h / d);
  return h < 1e-9 ? [[xm, ym]] : [[xm + rx, ym + ry], [xm - rx, ym - ry]];
}

/**
 * Trim `entId` at `click` (world). Mutates the doc: keeps the parts of the
 * entity NOT under the click. Returns true if it did something.
 */
export function trimAt(d: SketchDoc, entId: Id, click: Vec2): boolean {
  const E = d.entities.find((e) => e.id === entId);
  if (!E) return false;
  const pm = pmap(d);
  const crossings = crossingsOf(d, E);

  if (E.kind === "line") {
    const a = pm.get(E.p1)!, b = pm.get(E.p2)!;
    const A: Vec2 = [a.x, a.y], B: Vec2 = [b.x, b.y];
    const L2 = (B[0] - A[0]) ** 2 + (B[1] - A[1]) ** 2 || 1;
    const tOf = (p: Vec2) => ((p[0] - A[0]) * (B[0] - A[0]) + (p[1] - A[1]) * (B[1] - A[1])) / L2;
    const cuts = crossings.map(tOf).filter((t) => t > EPS && t < 1 - EPS).sort((x, y) => x - y);
    if (cuts.length === 0) { d.entities = d.entities.filter((e) => e.id !== entId); return true; } // nothing crosses → whole line
    const bounds = [0, ...cuts, 1];
    const tClick = Math.max(0, Math.min(1, tOf(click)));
    // find and drop the interval containing the click; rebuild the kept pieces
    d.entities = d.entities.filter((e) => e.id !== entId);
    const ptAt = (t: number): Id => {
      if (t <= EPS) return E.p1;
      if (t >= 1 - EPS) return E.p2;
      return addPoint(d, A[0] + (B[0] - A[0]) * t, A[1] + (B[1] - A[1]) * t).id;
    };
    for (let i = 0; i < bounds.length - 1; i++) {
      const lo = bounds[i], hi = bounds[i + 1];
      if (tClick > lo && tClick < hi) continue; // the removed piece
      d.entities.push({ id: nextId(d, "e"), kind: "line", p1: ptAt(lo), p2: ptAt(hi), ...(E.construction ? { construction: true } : {}) });
    }
    return true;
  }

  if (E.kind === "circle" || E.kind === "arc") {
    const centreId = E.c;
    const cc = pm.get(centreId)!;
    const C: Vec2 = [cc.x, cc.y];
    const r = E.kind === "circle" ? E.r : Math.hypot(pm.get(E.p1)!.x - cc.x, pm.get(E.p1)!.y - cc.y);
    let angs = crossings.map((p) => Math.atan2(p[1] - C[1], p[0] - C[0]));
    if (E.kind === "arc") { const { a1, a2 } = arcInfo(d, E); angs = angs.concat([a1, a2]); }
    angs = angs.map((a) => ((a % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI)).sort((x, y) => x - y);
    if (angs.length < 2) { d.entities = d.entities.filter((e) => e.id !== entId); return true; }
    const clickAng = ((Math.atan2(click[1] - C[1], click[0] - C[0]) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
    // wrap the boundary list around the circle
    const segs: [number, number][] = [];
    for (let i = 0; i < angs.length; i++) segs.push([angs[i], angs[(i + 1) % angs.length] + (i + 1 === angs.length ? 2 * Math.PI : 0)]);
    d.entities = d.entities.filter((e) => e.id !== entId);
    const ptAtAng = (ang: number): Id => addPoint(d, C[0] + r * Math.cos(ang), C[1] + r * Math.sin(ang)).id;
    for (const [lo, hi] of segs) {
      let ca = clickAng;
      while (ca < lo) ca += 2 * Math.PI;
      if (ca > lo && ca < hi) continue; // clicked arc → removed
      const p1 = ptAtAng(lo), p2 = ptAtAng(hi);
      d.entities.push({ id: nextId(d, "e"), kind: "arc", c: centreId, p1, p2, ccw: true, ...(E.construction ? { construction: true } : {}) });
    }
    return true;
  }

  return false;
}
