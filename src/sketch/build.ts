/**
 * Turn a solved sketch document into a replicad `Drawing` (a closed 2D profile
 * ready for Extrude/Revolve). This is the only sketch module that touches
 * replicad, so it is imported by the kernel only — never by the editor.
 */

import { draw, drawCircle } from "replicad";
import type { Drawing } from "replicad";
import type { SketchDoc, Id } from "./model";
import { traceLoops, arcInfo, sampleEntity, type Loop, type Vec2 } from "./geometry";

const pmap = (d: SketchDoc) => new Map(d.points.map((p) => [p.id, p] as const));

/** Build a single closed loop into a Drawing. */
function drawLoop(d: SketchDoc, loop: Loop): Drawing {
  const pm = pmap(d);
  if (loop.circle) {
    const c = pm.get(loop.circle.c)!;
    return drawCircle(loop.circle.r).translate(c.x, c.y);
  }
  const first = loop.edges[0];
  const startP = pm.get(first.from)!;
  let pen = draw([startP.x, startP.y]);
  for (const seg of loop.edges) {
    const to = pm.get(seg.to)!;
    const e = seg.entity;
    if (e.kind === "line") {
      pen = pen.lineTo([to.x, to.y]);
    } else if (e.kind === "arc") {
      const { c, r, a1, a2 } = arcInfo(d, e, pm);
      const mid = a1 + (a2 - a1) / 2;
      pen = pen.threePointsArcTo([to.x, to.y], [c[0] + r * Math.cos(mid), c[1] + r * Math.sin(mid)]);
    } else if (e.kind === "spline") {
      // walk the control points in the traversed direction, smoothing through
      const ids: Id[] = seg.from === e.pts[0] ? e.pts : [...e.pts].reverse();
      for (let i = 1; i < ids.length; i++) {
        const p = pm.get(ids[i])!;
        pen = pen.smoothSplineTo([p.x, p.y]);
      }
    }
  }
  return pen.close();
}

function loopPolyline(d: SketchDoc, loop: Loop): Vec2[] {
  const pm = pmap(d);
  if (loop.circle) return sampleEntity(d, loop.circle, pm);
  const poly: Vec2[] = [];
  for (const seg of loop.edges) {
    let pts = sampleEntity(d, seg.entity, pm);
    const fp = pm.get(seg.from)!;
    if (pts.length && Math.hypot(pts[0][0] - fp.x, pts[0][1] - fp.y) > 1e-6) pts = [...pts].reverse();
    poly.push(...pts.slice(0, -1));
  }
  return poly;
}

function pointInPoly(pt: Vec2, poly: Vec2[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > pt[1]) !== (yj > pt[1]) && pt[0] < ((xj - xi) * (pt[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/**
 * Compose the sketch's closed loops into one Drawing: the largest loop is the
 * outer boundary; loops inside it become holes (cut), disjoint loops are fused.
 * Throws if the sketch has no closed loop.
 */
export function buildDrawing(d: SketchDoc): Drawing {
  const loops = traceLoops(d).filter((l) => l.circle || l.edges.length >= 2);
  if (!loops.length) throw new Error("sketch has no closed profile — close the contour first");

  const withPoly = loops.map((l) => ({ loop: l, poly: loopPolyline(d, l), drawing: drawLoop(d, l), area: Math.abs(l.area) }));
  withPoly.sort((a, b) => b.area - a.area);

  let result = withPoly[0].drawing;
  const outerPoly = withPoly[0].poly;
  for (let i = 1; i < withPoly.length; i++) {
    const w = withPoly[i];
    const sample = w.poly[0] ?? [0, 0];
    try {
      if (pointInPoly(sample, outerPoly)) result = result.cut(w.drawing);
      else result = result.fuse(w.drawing);
    } catch {
      // boolean can fail on degenerate loops — keep the outer profile
    }
  }
  return result;
}
