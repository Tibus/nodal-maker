/**
 * Minimal DXF reader → replicad Drawing. Handles the entities a laser/CNC job
 * actually uses: LINE, LWPOLYLINE, POLYLINE, CIRCLE, ARC. Open LINE/ARC segments
 * are chained by shared endpoints into closed loops so they extrude/preview.
 *
 * Not a full DXF implementation — no blocks, splines, or text — but enough to
 * round-trip the DXFs we (and most CAM tools) emit.
 */
import { draw, drawCircle, Drawing, Blueprints } from "replicad";

type Pt = [number, number];

/** Parse the raw (code, value) pair stream. */
function pairs(src: string): { code: number; value: string }[] {
  const lines = src.split(/\r\n|\r|\n/);
  const out: { code: number; value: string }[] = [];
  for (let i = 0; i + 1 < lines.length; i += 2) {
    const code = parseInt(lines[i].trim(), 10);
    if (Number.isNaN(code)) { i -= 1; continue; } // resync on stray line
    out.push({ code, value: lines[i + 1].trim() });
  }
  return out;
}

interface Loop { pts: Pt[]; closed: boolean; }
interface CircleE { c: Pt; r: number; }
interface ArcE { c: Pt; r: number; a0: number; a1: number; }

function sampleArc(a: ArcE, segPerRad = 12): Pt[] {
  let sweep = ((a.a1 - a.a0) % 360 + 360) % 360;
  if (sweep === 0) sweep = 360;
  const n = Math.max(2, Math.ceil((sweep * Math.PI / 180) * segPerRad / Math.PI));
  const pts: Pt[] = [];
  for (let i = 0; i <= n; i++) {
    const ang = ((a.a0 + (sweep * i) / n) * Math.PI) / 180;
    pts.push([a.c[0] + a.r * Math.cos(ang), a.c[1] + a.r * Math.sin(ang)]);
  }
  return pts;
}

/** Split into entities and collect loops, circles and free segments. */
function parseEntities(src: string) {
  const ps = pairs(src);
  const loops: Loop[] = [];
  const circles: CircleE[] = [];
  const segments: [Pt, Pt][] = []; // open LINEs + sampled ARCs
  let i = 0;
  // jump to ENTITIES section
  while (i < ps.length && !(ps[i].code === 2 && ps[i].value === "ENTITIES")) i++;
  for (; i < ps.length; i++) {
    if (ps[i].code === 0 && ps[i].value === "ENDSEC") break;
    if (ps[i].code !== 0) continue;
    const type = ps[i].value;
    // gather this entity's pairs until the next code-0
    const e: { code: number; value: string }[] = [];
    let j = i + 1;
    for (; j < ps.length && ps[j].code !== 0; j++) e.push(ps[j]);
    i = j - 1;
    const num = (code: number, def = 0): number => { const p = e.find((x) => x.code === code); return p ? parseFloat(p.value) : def; };
    if (type === "LINE") {
      segments.push([[num(10), num(20)], [num(11), num(21)]]);
    } else if (type === "CIRCLE") {
      circles.push({ c: [num(10), num(20)], r: num(40) });
    } else if (type === "ARC") {
      const pts = sampleArc({ c: [num(10), num(20)], r: num(40), a0: num(50), a1: num(51) });
      for (let k = 0; k + 1 < pts.length; k++) segments.push([pts[k], pts[k + 1]]);
    } else if (type === "LWPOLYLINE" || type === "POLYLINE") {
      const xs = e.filter((x) => x.code === 10).map((x) => parseFloat(x.value));
      const ys = e.filter((x) => x.code === 20).map((x) => parseFloat(x.value));
      const flag = num(70, 0);
      const pts: Pt[] = xs.map((x, k) => [x, ys[k] ?? 0]);
      if (pts.length >= 2) loops.push({ pts, closed: (flag & 1) === 1 });
    }
  }
  return { loops, circles, segments };
}

/** Greedily chain free segments into polylines by shared endpoints. */
function chain(segments: [Pt, Pt][]): Loop[] {
  const eps = 1e-4;
  const near = (a: Pt, b: Pt) => Math.hypot(a[0] - b[0], a[1] - b[1]) < eps;
  const used = new Array(segments.length).fill(false);
  const loops: Loop[] = [];
  for (let s = 0; s < segments.length; s++) {
    if (used[s]) continue;
    used[s] = true;
    const pts: Pt[] = [segments[s][0], segments[s][1]];
    let extended = true;
    while (extended) {
      extended = false;
      const tail = pts[pts.length - 1];
      for (let k = 0; k < segments.length; k++) {
        if (used[k]) continue;
        if (near(segments[k][0], tail)) { pts.push(segments[k][1]); used[k] = true; extended = true; break; }
        if (near(segments[k][1], tail)) { pts.push(segments[k][0]); used[k] = true; extended = true; break; }
      }
    }
    const closed = near(pts[0], pts[pts.length - 1]);
    if (closed) pts.pop();
    loops.push({ pts, closed });
  }
  return loops;
}

function loopToDrawing(loop: Loop): Drawing | null {
  const p = loop.pts;
  if (p.length < 2) return null;
  let pen = draw(p[0]);
  for (let k = 1; k < p.length; k++) pen = pen.lineTo(p[k]);
  return loop.closed ? pen.close() : pen.lineTo(p[0]).close();
}

function combine(drawings: Drawing[]): Drawing {
  const bps = drawings.flatMap((d) => {
    const inner = (d as unknown as { innerShape?: unknown }).innerShape;
    if (inner instanceof Blueprints) return inner.blueprints;
    return inner ? [inner as never] : [];
  });
  if (!bps.length) throw new Error("[importDXF] no drawable geometry found");
  if (bps.length === 1) return new Drawing(bps[0]);
  return new Drawing(new Blueprints(bps) as never);
}

/** Parse a DXF document into a single (possibly multi-region) Drawing. */
export function importDXF(src: string): Drawing {
  const { loops, circles, segments } = parseEntities(src);
  const all = [...loops, ...chain(segments)];
  const drawings: Drawing[] = [];
  for (const l of all) { const d = loopToDrawing(l); if (d) drawings.push(d); }
  for (const c of circles) drawings.push(drawCircle(c.r).translate(c.c[0], c.c[1]));
  return combine(drawings);
}
