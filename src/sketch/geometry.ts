/**
 * Framework-free geometry for the sketcher: sample entities into polylines
 * (for 2D editor rendering and 3D display) and trace closed loops (for the
 * B-rep build). No replicad / three dependency — pure math on the doc.
 */

import type { SketchDoc, Entity, Id, SPoint } from "./model";

export type Vec2 = [number, number];

const pmap = (d: SketchDoc) => new Map(d.points.map((p) => [p.id, p] as const));

export function arcInfo(d: SketchDoc, e: Extract<Entity, { kind: "arc" }>, pm = pmap(d)) {
  const c = pm.get(e.c)!, p1 = pm.get(e.p1)!, p2 = pm.get(e.p2)!;
  const r = Math.hypot(p1.x - c.x, p1.y - c.y);
  let a1 = Math.atan2(p1.y - c.y, p1.x - c.x);
  let a2 = Math.atan2(p2.y - c.y, p2.x - c.x);
  // normalise sweep to match ccw flag
  if (e.ccw) { while (a2 <= a1) a2 += 2 * Math.PI; }
  else { while (a2 >= a1) a2 -= 2 * Math.PI; }
  return { c: [c.x, c.y] as Vec2, r, a1, a2 };
}

/** Catmull-Rom through the control points → smooth open curve samples. */
function sampleSpline(pts: SPoint[], perSeg = 16): Vec2[] {
  if (pts.length < 2) return pts.map((p) => [p.x, p.y] as Vec2);
  if (pts.length === 2) return [[pts[0].x, pts[0].y], [pts[1].x, pts[1].y]];
  const out: Vec2[] = [];
  const P = (i: number) => pts[Math.max(0, Math.min(pts.length - 1, i))];
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = P(i - 1), p1 = P(i), p2 = P(i + 1), p3 = P(i + 2);
    for (let s = 0; s < perSeg; s++) {
      const t = s / perSeg, t2 = t * t, t3 = t2 * t;
      const x = 0.5 * ((2 * p1.x) + (-p0.x + p2.x) * t + (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2 + (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t3);
      const y = 0.5 * ((2 * p1.y) + (-p0.y + p2.y) * t + (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * t2 + (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * t3);
      out.push([x, y]);
    }
  }
  const last = pts[pts.length - 1];
  out.push([last.x, last.y]);
  return out;
}

/** Sample one entity into a polyline (circles/arcs faceted). */
export function sampleEntity(d: SketchDoc, e: Entity, pm = pmap(d)): Vec2[] {
  switch (e.kind) {
    case "line": {
      const a = pm.get(e.p1)!, b = pm.get(e.p2)!;
      return [[a.x, a.y], [b.x, b.y]];
    }
    case "circle": {
      const c = pm.get(e.c)!;
      const out: Vec2[] = [];
      const segs = 64;
      for (let i = 0; i <= segs; i++) {
        const a = (2 * Math.PI * i) / segs;
        out.push([c.x + e.r * Math.cos(a), c.y + e.r * Math.sin(a)]);
      }
      return out;
    }
    case "arc": {
      const { c, r, a1, a2 } = arcInfo(d, e, pm);
      const out: Vec2[] = [];
      const segs = Math.max(6, Math.ceil((Math.abs(a2 - a1) / (2 * Math.PI)) * 64));
      for (let i = 0; i <= segs; i++) {
        const a = a1 + ((a2 - a1) * i) / segs;
        out.push([c[0] + r * Math.cos(a), c[1] + r * Math.sin(a)]);
      }
      return out;
    }
    case "spline":
      return sampleSpline(e.pts.map((id) => pm.get(id)!));
  }
}

/** All entities as polylines — for rendering the whole sketch. */
export function tessellate(d: SketchDoc): { id: Id; kind: Entity["kind"]; construction: boolean; pts: Vec2[] }[] {
  const pm = pmap(d);
  return d.entities.map((e) => ({ id: e.id, kind: e.kind, construction: !!e.construction, pts: sampleEntity(d, e, pm) }));
}

/* -------------------------------------------------------------------------- */
/* Loop tracing (for the closed profile fed to Extrude)                       */
/* -------------------------------------------------------------------------- */

export interface Loop {
  /** ordered edges with the direction they are traversed */
  edges: { entity: Entity; from: Id; to: Id }[];
  /** signed area (CCW positive) */
  area: number;
  /** is it a single circle (special-cased on build) */
  circle?: Extract<Entity, { kind: "circle" }>;
}

/**
 * Trace closed loops from line/arc/spline edges by walking shared endpoints.
 * Standalone circles become their own loops. Open chains are ignored (they
 * cannot bound a face). Greedy walk — good enough for hand-drawn profiles.
 */
export function traceLoops(d: SketchDoc): Loop[] {
  const pm = pmap(d);
  const loops: Loop[] = [];

  // real (non-construction) circles are self-contained loops
  for (const e of d.entities) {
    if (e.kind === "circle" && !e.construction) {
      loops.push({ edges: [], area: Math.PI * e.r * e.r, circle: e });
    }
  }

  // edges that have two endpoints (line/arc/spline), construction excluded
  type Edge = { entity: Entity; a: Id; b: Id };
  const edges: Edge[] = [];
  for (const e of d.entities) {
    if (e.construction) continue;
    if (e.kind === "line") edges.push({ entity: e, a: e.p1, b: e.p2 });
    else if (e.kind === "arc") edges.push({ entity: e, a: e.p1, b: e.p2 });
    else if (e.kind === "spline" && e.pts.length >= 2) edges.push({ entity: e, a: e.pts[0], b: e.pts[e.pts.length - 1] });
  }

  const used = new Set<Edge>();
  const byPoint = new Map<Id, Edge[]>();
  for (const e of edges) {
    (byPoint.get(e.a) ?? byPoint.set(e.a, []).get(e.a)!).push(e);
    (byPoint.get(e.b) ?? byPoint.set(e.b, []).get(e.b)!).push(e);
  }

  for (const start of edges) {
    if (used.has(start)) continue;
    const chain: { entity: Entity; from: Id; to: Id }[] = [];
    let curEdge: Edge | undefined = start;
    let node = start.a;
    const first = start.a;
    const visited = new Set<Edge>();
    while (curEdge && !visited.has(curEdge)) {
      visited.add(curEdge);
      const to = curEdge.a === node ? curEdge.b : curEdge.a;
      chain.push({ entity: curEdge.entity, from: node, to });
      node = to;
      if (node === first) break; // closed
      const candidates = (byPoint.get(node) ?? []).filter((e) => e !== curEdge && !visited.has(e));
      curEdge = candidates[0];
    }
    if (node === first && chain.length >= 2) {
      for (const c of chain) used.add(edges.find((e) => e.entity === c.entity)!);
      loops.push({ edges: chain, area: loopArea(d, chain, pm) });
    }
  }
  return loops;
}

function loopArea(d: SketchDoc, chain: { entity: Entity; from: Id; to: Id }[], pm = pmap(d)): number {
  // approximate the loop by its sampled polyline and use the shoelace formula
  const poly: Vec2[] = [];
  for (const seg of chain) {
    let pts = sampleEntity(d, seg.entity, pm);
    const startsAtFrom = pts.length && pm.get(seg.from) &&
      Math.hypot(pts[0][0] - pm.get(seg.from)!.x, pts[0][1] - pm.get(seg.from)!.y) < 1e-6;
    if (!startsAtFrom) pts = [...pts].reverse();
    poly.push(...pts.slice(0, -1));
  }
  let a = 0;
  for (let i = 0; i < poly.length; i++) {
    const [x1, y1] = poly[i], [x2, y2] = poly[(i + 1) % poly.length];
    a += x1 * y2 - x2 * y1;
  }
  return a / 2;
}

/** Bounding box of everything in the sketch (for framing the editor). */
export function bbox(d: SketchDoc): { min: Vec2; max: Vec2 } {
  let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
  for (const poly of tessellate(d)) for (const [x, y] of poly.pts) {
    minx = Math.min(minx, x); miny = Math.min(miny, y);
    maxx = Math.max(maxx, x); maxy = Math.max(maxy, y);
  }
  if (!isFinite(minx)) return { min: [-50, -50], max: [50, 50] };
  return { min: [minx, miny], max: [maxx, maxy] };
}
