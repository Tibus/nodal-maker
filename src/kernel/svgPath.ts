/**
 * SVG `<path d="…">` parser → replicad Drawing.
 *
 * replicad 0.23 has no `drawSVG`, so we parse the path ourselves and feed the
 * pen. This is exactly what the real "SVG input" node needs, and it's the seam
 * where a future "text → SVG" node (via opentype.js glyph paths) plugs in — it
 * also emits path `d` strings, which is why full glyph support matters here.
 *
 * Supported: M/m L/l H/h V/v C/c S/s Q/q T/t A/a Z/z (absolute + relative,
 * implicit repeats, smooth-curve reflection; elliptical arcs are converted to
 * cubic béziers). MULTIPLE SUBPATHS are supported and turned into holes: each
 * closed subpath becomes its own contour; a contour whose centroid falls inside
 * a larger one is CUT from it (donut / letter counters), otherwise it is FUSED
 * as a separate island.
 */
import { draw, type Drawing } from "replicad";

type Pt = [number, number];

const NUM = /-?\d*\.?\d+(?:[eE][-+]?\d+)?/g;

interface Seg {
  cmd: string;
  args: number[];
}

function tokenize(d: string): Seg[] {
  const segs: Seg[] = [];
  const re = /([MmLlHhVvCcSsQqTtAaZz])([^MmLlHhVvCcSsQqTtAaZz]*)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(d))) {
    const nums = m[2].match(NUM)?.map(Number) ?? [];
    segs.push({ cmd: m[1], args: nums });
  }
  return segs;
}

/** Split a flat command list into subpaths, each beginning at an M/m. */
function splitSubpaths(segs: Seg[]): Seg[][] {
  const subs: Seg[][] = [];
  let cur: Seg[] | null = null;
  for (const s of segs) {
    if (s.cmd === "M" || s.cmd === "m") {
      cur = [s];
      subs.push(cur);
    } else if (cur) {
      cur.push(s);
    }
  }
  return subs;
}

interface Cubic {
  c1: Pt;
  c2: Pt;
  end: Pt;
}

/**
 * Convert an SVG elliptical arc to a sequence of cubic béziers (endpoint →
 * centre parametrisation, then ≤90° segments). Follows the W3C SVG
 * implementation notes. All coordinates are absolute SVG-space.
 */
function arcToCubics(
  x1: number,
  y1: number,
  rx: number,
  ry: number,
  phi: number,
  fA: number,
  fS: number,
  x2: number,
  y2: number,
): Cubic[] {
  if (rx === 0 || ry === 0) return [{ c1: [x1, y1], c2: [x2, y2], end: [x2, y2] }];
  rx = Math.abs(rx);
  ry = Math.abs(ry);
  const sinφ = Math.sin(phi);
  const cosφ = Math.cos(phi);

  const dx = (x1 - x2) / 2;
  const dy = (y1 - y2) / 2;
  const x1p = cosφ * dx + sinφ * dy;
  const y1p = -sinφ * dx + cosφ * dy;

  let rxs = rx * rx;
  let rys = ry * ry;
  const x1ps = x1p * x1p;
  const y1ps = y1p * y1p;
  const lambda = x1ps / rxs + y1ps / rys;
  if (lambda > 1) {
    const s = Math.sqrt(lambda);
    rx *= s;
    ry *= s;
    rxs = rx * rx;
    rys = ry * ry;
  }

  const sign = fA === fS ? -1 : 1;
  const num = Math.max(0, rxs * rys - rxs * y1ps - rys * x1ps);
  const co = sign * Math.sqrt(num / (rxs * y1ps + rys * x1ps));
  const cxp = (co * (rx * y1p)) / ry;
  const cyp = (co * (-ry * x1p)) / rx;
  const cx = cosφ * cxp - sinφ * cyp + (x1 + x2) / 2;
  const cy = sinφ * cxp + cosφ * cyp + (y1 + y2) / 2;

  const ang = (ux: number, uy: number, vx: number, vy: number) => {
    const dot = ux * vx + uy * vy;
    const len = Math.hypot(ux, uy) * Math.hypot(vx, vy);
    let a = Math.acos(Math.min(1, Math.max(-1, dot / len)));
    if (ux * vy - uy * vx < 0) a = -a;
    return a;
  };
  const ux = (x1p - cxp) / rx;
  const uy = (y1p - cyp) / ry;
  const theta1 = ang(1, 0, ux, uy);
  let dtheta = ang(ux, uy, (-x1p - cxp) / rx, (-y1p - cyp) / ry);
  if (!fS && dtheta > 0) dtheta -= 2 * Math.PI;
  if (fS && dtheta < 0) dtheta += 2 * Math.PI;

  const segsN = Math.max(1, Math.ceil(Math.abs(dtheta) / (Math.PI / 2)));
  const delta = dtheta / segsN;
  const t = (4 / 3) * Math.tan(delta / 4);

  const out: Cubic[] = [];
  let th = theta1;
  let px = cosφ * rx * Math.cos(th) - sinφ * ry * Math.sin(th) + cx;
  let py = sinφ * rx * Math.cos(th) + cosφ * ry * Math.sin(th) + cy;
  for (let i = 0; i < segsN; i++) {
    const th2 = th + delta;
    const cth = Math.cos(th), sth = Math.sin(th), cth2 = Math.cos(th2), sth2 = Math.sin(th2);
    const ex = cosφ * rx * cth2 - sinφ * ry * sth2 + cx;
    const ey = sinφ * rx * cth2 + cosφ * ry * sth2 + cy;
    const d1x = cosφ * -rx * sth - sinφ * ry * cth;
    const d1y = sinφ * -rx * sth + cosφ * ry * cth;
    const d2x = cosφ * -rx * sth2 - sinφ * ry * cth2;
    const d2y = sinφ * -rx * sth2 + cosφ * ry * cth2;
    out.push({
      c1: [px + t * d1x, py + t * d1y],
      c2: [ex - t * d2x, ey - t * d2y],
      end: [ex, ey],
    });
    th = th2;
    px = ex;
    py = ey;
  }
  return out;
}

export interface SvgToDrawingOptions {
  /** flip the Y axis (SVG is y-down, CAD is y-up). default true */
  flipY?: boolean;
}

interface SubResult {
  drawing: Drawing;
  pts: Pt[]; // anchor points in SVG coords, for area + containment tests
}

/** Build one closed Drawing from a single subpath's commands. */
function buildSubpath(segs: Seg[], fy: (y: number) => number): SubResult | null {
  let pen: ReturnType<typeof draw> | null = null;
  let cur: Pt = [0, 0];
  let startPt: Pt = [0, 0];
  const pts: Pt[] = [];
  let prevCmd = "";
  let prevC2: Pt | null = null; // last cubic 2nd control (for S)
  let prevQc: Pt | null = null; // last quadratic control (for T)

  for (const { cmd, args } of segs) {
    const rel = cmd === cmd.toLowerCase();
    const abs = (x: number, y: number): Pt => (rel ? [cur[0] + x, cur[1] + y] : [x, y]);
    const up = cmd.toUpperCase();

    switch (up) {
      case "M": {
        const p = abs(args[0], args[1]);
        pen = draw([p[0], fy(p[1])]);
        cur = p;
        startPt = p;
        pts.push(p);
        for (let i = 2; i + 1 < args.length; i += 2) {
          const q = abs(args[i], args[i + 1]);
          pen.lineTo([q[0], fy(q[1])]);
          cur = q;
          pts.push(q);
        }
        break;
      }
      case "L":
        for (let i = 0; i + 1 < args.length; i += 2) {
          const p = abs(args[i], args[i + 1]);
          pen!.lineTo([p[0], fy(p[1])]);
          cur = p;
          pts.push(p);
        }
        break;
      case "H":
        for (const x of args) {
          const p: Pt = rel ? [cur[0] + x, cur[1]] : [x, cur[1]];
          pen!.lineTo([p[0], fy(p[1])]);
          cur = p;
          pts.push(p);
        }
        break;
      case "V":
        for (const y of args) {
          const p: Pt = rel ? [cur[0], cur[1] + y] : [cur[0], y];
          pen!.lineTo([p[0], fy(p[1])]);
          cur = p;
          pts.push(p);
        }
        break;
      case "C":
        for (let i = 0; i + 5 < args.length; i += 6) {
          const c1 = abs(args[i], args[i + 1]);
          const c2 = abs(args[i + 2], args[i + 3]);
          const end = abs(args[i + 4], args[i + 5]);
          pen!.cubicBezierCurveTo([end[0], fy(end[1])], [c1[0], fy(c1[1])], [c2[0], fy(c2[1])]);
          cur = end;
          prevC2 = c2;
          pts.push(end);
        }
        break;
      case "S":
        for (let i = 0; i + 3 < args.length; i += 4) {
          const smooth = prevCmd === "C" || prevCmd === "S";
          const c1: Pt = smooth && prevC2 ? [2 * cur[0] - prevC2[0], 2 * cur[1] - prevC2[1]] : cur;
          const c2 = abs(args[i], args[i + 1]);
          const end = abs(args[i + 2], args[i + 3]);
          pen!.cubicBezierCurveTo([end[0], fy(end[1])], [c1[0], fy(c1[1])], [c2[0], fy(c2[1])]);
          cur = end;
          prevC2 = c2;
          prevCmd = "S"; // keep chain alive across implicit repeats
          pts.push(end);
        }
        break;
      case "Q":
        for (let i = 0; i + 3 < args.length; i += 4) {
          const c = abs(args[i], args[i + 1]);
          const end = abs(args[i + 2], args[i + 3]);
          pen!.quadraticBezierCurveTo([end[0], fy(end[1])], [c[0], fy(c[1])]);
          cur = end;
          prevQc = c;
          pts.push(end);
        }
        break;
      case "T":
        for (let i = 0; i + 1 < args.length; i += 2) {
          const smooth = prevCmd === "Q" || prevCmd === "T";
          const c: Pt = smooth && prevQc ? [2 * cur[0] - prevQc[0], 2 * cur[1] - prevQc[1]] : cur;
          const end = abs(args[i], args[i + 1]);
          pen!.quadraticBezierCurveTo([end[0], fy(end[1])], [c[0], fy(c[1])]);
          cur = end;
          prevQc = c;
          prevCmd = "T";
          pts.push(end);
        }
        break;
      case "A":
        for (let i = 0; i + 6 < args.length; i += 7) {
          const rx = args[i];
          const ry = args[i + 1];
          const rot = (args[i + 2] * Math.PI) / 180;
          const fA = args[i + 3] ? 1 : 0;
          const fS = args[i + 4] ? 1 : 0;
          const end = abs(args[i + 5], args[i + 6]);
          const cubics = arcToCubics(cur[0], cur[1], rx, ry, rot, fA, fS, end[0], end[1]);
          for (const cb of cubics) {
            pen!.cubicBezierCurveTo(
              [cb.end[0], fy(cb.end[1])],
              [cb.c1[0], fy(cb.c1[1])],
              [cb.c2[0], fy(cb.c2[1])],
            );
          }
          cur = end;
          pts.push(end);
        }
        break;
      case "Z":
        cur = startPt;
        break;
    }
    if (up !== "S" && up !== "T") prevCmd = up;
  }

  if (!pen) return null;
  return { drawing: pen.close(), pts };
}

/** Shoelace area (sign encodes winding; we only use magnitude). */
function polyArea(pts: Pt[]): number {
  let a = 0;
  for (let i = 0, n = pts.length; i < n; i++) {
    const [x0, y0] = pts[i];
    const [x1, y1] = pts[(i + 1) % n];
    a += x0 * y1 - x1 * y0;
  }
  return Math.abs(a) / 2;
}

function centroid(pts: Pt[]): Pt {
  let x = 0, y = 0;
  for (const p of pts) {
    x += p[0];
    y += p[1];
  }
  return [x / pts.length, y / pts.length];
}

/** Ray-casting point-in-polygon. */
function inside(p: Pt, poly: Pt[]): boolean {
  let hit = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) {
      hit = !hit;
    }
  }
  return hit;
}

export function svgPathToDrawing(d: string, opts: SvgToDrawingOptions = {}): Drawing {
  const flipY = opts.flipY ?? true;
  const fy = (y: number) => (flipY ? -y : y);

  const segs = tokenize(d);
  if (!segs.length) throw new Error("empty SVG path");

  const subs = splitSubpaths(segs)
    .map((s) => buildSubpath(s, fy))
    .filter((s): s is SubResult => s !== null && s.pts.length >= 3);

  if (!subs.length) throw new Error("SVG path produced no geometry");
  if (subs.length === 1) return subs[0].drawing;

  // Combine subpaths: largest first; a contour whose centroid sits inside an
  // already-placed island is a hole (cut), otherwise it's a new island (fuse).
  const sorted = subs
    .map((s) => ({ ...s, area: polyArea(s.pts), c: centroid(s.pts) }))
    .sort((a, b) => b.area - a.area);

  let result: Drawing = sorted[0].drawing;
  const islands: Pt[][] = [sorted[0].pts];
  for (let i = 1; i < sorted.length; i++) {
    const s = sorted[i];
    const isHole = islands.some((poly) => inside(s.c, poly));
    if (isHole) {
      result = result.cut(s.drawing);
    } else {
      result = result.fuse(s.drawing);
      islands.push(s.pts);
    }
  }
  return result;
}
