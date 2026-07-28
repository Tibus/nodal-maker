/**
 * Constraint solver for the 2D sketcher.
 *
 * Formulation: every constraint contributes one or more scalar RESIDUALS that
 * are zero when satisfied. The unknowns are the free point coordinates (x,y)
 * plus circle radii. We minimise ‖r(x)‖² with Levenberg–Marquardt using a
 * numerical Jacobian and a small dense linear solve — sketches are tiny
 * (a few hundred DOF at most) so this is plenty fast and very robust.
 *
 * A weak regularisation pulls every unknown toward its pre-solve value, which
 * (a) makes JᵀJ full-rank even when the sketch is under-constrained and
 * (b) keeps dragging stable — free DOF move as little as possible.
 *
 * Fixed points and `pin`ned (dragged) points are removed from the unknowns and
 * treated as constants, so the rest of the sketch solves around them.
 */

import type { SketchDoc, Id, Entity } from "./model";
import { isDim } from "./model";

export interface SolveOptions {
  /** dimension name → driving value (from the Sketch node's params) */
  overrides?: Record<string, number>;
  /** points held HARD at a fixed position for this solve */
  pin?: { id: Id; x: number; y: number }[];
  /**
   * points SOFTLY pulled toward a position (live drag): the real constraints
   * still win, so a fully-constrained sketch stays rigid while free DOF follow
   * the cursor.
   */
  pull?: { id: Id; x: number; y: number }[];
  maxIter?: number;
  tol?: number;
}

export interface SolveResult {
  ok: boolean;
  iterations: number;
  residual: number;
}

// weight that turns unitless angular residuals into ~mm-scale pulls
const ANG = 50;
const W_REG = 0.005;
// live-drag pull: below the hard-constraint weight (~1) so constraints win and
// a fully-constrained sketch stays put, but far above W_REG so free DOF follow
const W_PULL = 0.35;

/** Solve `doc` in place. Returns convergence info. */
export function solve(doc: SketchDoc, opts: SolveOptions = {}): SolveResult {
  const maxIter = opts.maxIter ?? 80;
  const tol = opts.tol ?? 1e-9;

  // ---- apply pins (treated as fixed at the given position) ----------------
  const pinned = new Map<Id, { x: number; y: number }>();
  for (const p of opts.pin ?? []) pinned.set(p.id, { x: p.x, y: p.y });
  for (const p of doc.points) {
    const pin = pinned.get(p.id);
    if (pin) { p.x = pin.x; p.y = pin.y; }
  }
  const isFixed = (id: Id) => pinned.has(id) || !!doc.points.find((q) => q.id === id)?.fixed;

  // ---- build the unknown vector -------------------------------------------
  // layout: [ point.x, point.y ... ] then [ circle.r ... ]
  const px = new Map<Id, number>(); // point id → base index in x
  const rIx = new Map<Id, number>(); // circle id → index in x
  const x: number[] = [];
  for (const p of doc.points) {
    if (isFixed(p.id)) continue;
    px.set(p.id, x.length);
    x.push(p.x, p.y);
  }
  for (const e of doc.entities) {
    if (e.kind === "circle") { rIx.set(e.id, x.length); x.push(e.r); }
  }
  const N = x.length;
  const x0 = x.slice(); // regularisation anchor

  if (N === 0) return { ok: true, iterations: 0, residual: 0 };

  // ---- geometry accessors from a candidate vector -------------------------
  const pointById = new Map(doc.points.map((p) => [p.id, p] as const));
  const entById = new Map(doc.entities.map((e) => [e.id, e] as const));

  const P = (v: number[], id: Id): [number, number] => {
    const b = px.get(id);
    if (b === undefined) { const p = pointById.get(id)!; return [p.x, p.y]; }
    return [v[b], v[b + 1]];
  };
  const R = (v: number[], id: Id): number => {
    const i = rIx.get(id);
    return i === undefined ? (entById.get(id) as Extract<Entity, { kind: "circle" }>).r : v[i];
  };
  const dimValue = (name: string, fallback: number) =>
    opts.overrides && name in opts.overrides ? opts.overrides[name] : fallback;

  const lineDir = (v: number[], e: Entity): [number, number] => {
    if (e.kind !== "line") return [1, 0];
    const [a, b] = [P(v, e.p1), P(v, e.p2)];
    return [b[0] - a[0], b[1] - a[1]];
  };
  const norm = (dx: number, dy: number) => Math.hypot(dx, dy) || 1e-9;
  // radius (circle/arc) or length (line) — used by `equal` and `radius`
  const measureRL = (v: number[], e: Entity): number => {
    if (e.kind === "line") { const [a, b] = [P(v, e.p1), P(v, e.p2)]; return Math.hypot(a[0] - b[0], a[1] - b[1]); }
    if (e.kind === "circle") return R(v, e.id);
    if (e.kind === "arc") { const cc = P(v, e.c), p1 = P(v, e.p1); return Math.hypot(p1[0] - cc[0], p1[1] - cc[1]); }
    return 0;
  };

  // ---- residual vector ----------------------------------------------------
  const residuals = (v: number[]): number[] => {
    const r: number[] = [];
    for (const c of doc.constraints) {
      switch (c.kind) {
        case "coincident": {
          const [a, b] = [P(v, c.a), P(v, c.b)];
          r.push(a[0] - b[0], a[1] - b[1]);
          break;
        }
        case "horizontal": {
          const e = entById.get(c.line)!;
          if (e.kind === "line") { const [a, b] = [P(v, e.p1), P(v, e.p2)]; r.push(a[1] - b[1]); }
          break;
        }
        case "vertical": {
          const e = entById.get(c.line)!;
          if (e.kind === "line") { const [a, b] = [P(v, e.p1), P(v, e.p2)]; r.push(a[0] - b[0]); }
          break;
        }
        case "parallel": {
          const [d1, d2] = [lineDir(v, entById.get(c.a)!), lineDir(v, entById.get(c.b)!)];
          const cross = d1[0] * d2[1] - d1[1] * d2[0];
          r.push((cross / (norm(...d1) * norm(...d2))) * ANG);
          break;
        }
        case "perpendicular": {
          const [d1, d2] = [lineDir(v, entById.get(c.a)!), lineDir(v, entById.get(c.b)!)];
          const dot = d1[0] * d2[0] + d1[1] * d2[1];
          r.push((dot / (norm(...d1) * norm(...d2))) * ANG);
          break;
        }
        case "equal": {
          const ea = entById.get(c.a)!, eb = entById.get(c.b)!;
          r.push(measureRL(v, ea) - measureRL(v, eb));
          break;
        }
        case "pointOn": {
          const e = entById.get(c.ent)!;
          const p = P(v, c.p);
          if (e.kind === "line") {
            const [a, b] = [P(v, e.p1), P(v, e.p2)];
            const dx = b[0] - a[0], dy = b[1] - a[1];
            const L = norm(dx, dy);
            r.push(((p[0] - a[0]) * dy - (p[1] - a[1]) * dx) / L);
          } else if (e.kind === "circle") {
            const cc = P(v, e.c);
            r.push(norm(p[0] - cc[0], p[1] - cc[1]) - R(v, e.id));
          } else if (e.kind === "arc") {
            const cc = P(v, e.c), rr = norm(...sub(P(v, e.p1), cc));
            r.push(norm(p[0] - cc[0], p[1] - cc[1]) - rr);
          }
          break;
        }
        case "tangent": {
          const ea = entById.get(c.a)!, eb = entById.get(c.b)!;
          r.push(tangentResidual(v, ea, eb, P, R));
          break;
        }
        case "symmetric": {
          const [a, b] = [P(v, c.a), P(v, c.b)];
          const e = entById.get(c.line)!;
          if (e.kind === "line") {
            const [la, lb] = [P(v, e.p1), P(v, e.p2)];
            const dx = lb[0] - la[0], dy = lb[1] - la[1];
            const L = norm(dx, dy);
            const mid: [number, number] = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
            // midpoint on the line …
            r.push(((mid[0] - la[0]) * dy - (mid[1] - la[1]) * dx) / L);
            // … and the chord perpendicular to the line
            const cdx = b[0] - a[0], cdy = b[1] - a[1];
            r.push(((dx * cdx + dy * cdy) / (L * norm(cdx, cdy))) * ANG);
          }
          break;
        }
        case "fixed":
          break; // enforced by exclusion from the unknowns
        case "distance": {
          const [a, b] = [P(v, c.a), P(v, c.b)];
          r.push(norm(a[0] - b[0], a[1] - b[1]) - dimValue(c.name, c.value));
          break;
        }
        case "distanceX": {
          const [a, b] = [P(v, c.a), P(v, c.b)];
          r.push(b[0] - a[0] - dimValue(c.name, c.value));
          break;
        }
        case "distanceY": {
          const [a, b] = [P(v, c.a), P(v, c.b)];
          r.push(b[1] - a[1] - dimValue(c.name, c.value));
          break;
        }
        case "radius": {
          const e = entById.get(c.ent)!;
          r.push(measureRL(v, e) - dimValue(c.name, c.value));
          break;
        }
        case "angle": {
          const [d1, d2] = [lineDir(v, entById.get(c.a)!), lineDir(v, entById.get(c.b)!)];
          const ang = Math.atan2(d1[0] * d2[1] - d1[1] * d2[0], d1[0] * d2[0] + d1[1] * d2[1]);
          let target = (dimValue(c.name, c.value) * Math.PI) / 180;
          // wrap the difference into (-π, π] so the residual is smooth
          let diff = ang - target;
          while (diff > Math.PI) diff -= 2 * Math.PI;
          while (diff < -Math.PI) diff += 2 * Math.PI;
          r.push(diff * ANG);
          break;
        }
      }
    }
    // arc radius consistency (both endpoints equidistant from centre)
    for (const e of doc.entities) {
      if (e.kind === "arc") {
        const cc = P(v, e.c);
        r.push(norm(...sub(P(v, e.p1), cc)) - norm(...sub(P(v, e.p2), cc)));
      }
    }
    // live-drag soft pull toward the cursor (constraints still dominate)
    for (const pl of opts.pull ?? []) {
      const p = P(v, pl.id);
      r.push((p[0] - pl.x) * W_PULL, (p[1] - pl.y) * W_PULL);
    }
    // weak regularisation toward the pre-solve state
    for (let i = 0; i < N; i++) r.push((v[i] - x0[i]) * W_REG);
    return r;
  };

  // ---- Levenberg–Marquardt -------------------------------------------------
  let lambda = 1e-3;
  let r = residuals(x);
  let cost = dot(r, r);
  let iter = 0;
  for (; iter < maxIter; iter++) {
    if (cost < tol) break;
    const J = jacobian(residuals, x, r);
    const M = r.length;
    // normal equations: A = JᵀJ (+ λ diag), g = Jᵀr
    const A: number[][] = Array.from({ length: N }, () => new Array(N).fill(0));
    const g = new Array(N).fill(0);
    for (let k = 0; k < M; k++) {
      const Jk = J[k];
      for (let i = 0; i < N; i++) {
        if (Jk[i] === 0) continue;
        g[i] += Jk[i] * r[k];
        for (let j = i; j < N; j++) A[i][j] += Jk[i] * Jk[j];
      }
    }
    for (let i = 0; i < N; i++) for (let j = i + 1; j < N; j++) A[j][i] = A[i][j];

    let improved = false;
    for (let attempt = 0; attempt < 8; attempt++) {
      const Alm = A.map((row, i) => row.map((val, j) => (i === j ? val * (1 + lambda) : val)));
      const dx = solveLinear(Alm, g.map((v) => -v));
      if (!dx) { lambda *= 4; continue; }
      const xn = x.map((v, i) => v + dx[i]);
      const rn = residuals(xn);
      const cn = dot(rn, rn);
      if (cn < cost) {
        for (let i = 0; i < N; i++) x[i] = xn[i];
        r = rn; const prev = cost; cost = cn;
        lambda = Math.max(lambda * 0.4, 1e-9);
        improved = true;
        if (prev - cn < 1e-7 * (1 + prev)) iter = maxIter; // relative convergence
        break;
      }
      lambda *= 4;
    }
    if (!improved) break;
  }

  // ---- write the solution back into the document --------------------------
  for (const p of doc.points) {
    const b = px.get(p.id);
    if (b !== undefined) { p.x = x[b]; p.y = x[b + 1]; }
  }
  for (const e of doc.entities) {
    if (e.kind === "circle") { const i = rIx.get(e.id); if (i !== undefined) e.r = x[i]; }
  }
  // apply solved dimension values back so the stored `value` mirrors overrides
  if (opts.overrides) {
    for (const c of doc.constraints) {
      if (isDim(c) && c.name in opts.overrides) c.value = opts.overrides[c.name];
    }
  }

  // report satisfaction of the *hard* constraints only — the trailing N
  // regularisation rows are intentionally soft and shouldn't count as error
  const rFinal = residuals(x);
  const softRows = N + 2 * (opts.pull?.length ?? 0); // trailing pull + reg rows
  let hard = 0;
  for (let i = 0; i < rFinal.length - softRows; i++) hard += rFinal[i] * rFinal[i];
  const hardRes = Math.sqrt(hard);
  return { ok: hardRes < 5e-3, iterations: iter, residual: hardRes };
}

/* -------------------------------------------------------------------------- */
/* residual helpers                                                           */
/* -------------------------------------------------------------------------- */

const sub = (a: [number, number], b: [number, number]): [number, number] => [a[0] - b[0], a[1] - b[1]];

function tangentResidual(
  v: number[],
  ea: Entity,
  eb: Entity,
  P: (v: number[], id: Id) => [number, number],
  R: (v: number[], id: Id) => number,
): number {
  const radiusOf = (e: Entity): { c: [number, number]; r: number } | null => {
    if (e.kind === "circle") return { c: P(v, e.c), r: R(v, e.id) };
    if (e.kind === "arc") { const c = P(v, e.c); return { c, r: Math.hypot(...sub(P(v, e.p1), c)) }; }
    return null;
  };
  const line = ea.kind === "line" ? ea : eb.kind === "line" ? eb : null;
  const circ = radiusOf(ea) ?? radiusOf(eb);
  if (line && circ) {
    const [a, b] = [P(v, line.p1), P(v, line.p2)];
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const L = Math.hypot(dx, dy) || 1e-9;
    const distToCentre = Math.abs((circ.c[0] - a[0]) * dy - (circ.c[1] - a[1]) * dx) / L;
    return distToCentre - circ.r;
  }
  const ca = radiusOf(ea), cb = radiusOf(eb);
  if (ca && cb) {
    const d = Math.hypot(ca.c[0] - cb.c[0], ca.c[1] - cb.c[1]);
    // external tangency (touching outside); |d - (r1+r2)| would be internal too
    return d - (ca.r + cb.r);
  }
  return 0;
}

/* -------------------------------------------------------------------------- */
/* numerical linear algebra                                                   */
/* -------------------------------------------------------------------------- */

function jacobian(f: (v: number[]) => number[], x: number[], r0: number[]): number[][] {
  const N = x.length, M = r0.length;
  const J: number[][] = Array.from({ length: M }, () => new Array(N).fill(0));
  for (let j = 0; j < N; j++) {
    const h = 1e-6 * Math.max(1, Math.abs(x[j]));
    const xj = x[j];
    x[j] = xj + h;
    const rp = f(x);
    x[j] = xj;
    const inv = 1 / h;
    for (let k = 0; k < M; k++) J[k][j] = (rp[k] - r0[k]) * inv;
  }
  return J;
}

function dot(a: number[], b: number[]): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

/** Solve A·x = b (A square, dense) via Gaussian elimination w/ partial pivot. */
function solveLinear(A: number[][], b: number[]): number[] | null {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(M[r][col]) > Math.abs(M[piv][col])) piv = r;
    if (Math.abs(M[piv][col]) < 1e-12) return null;
    [M[col], M[piv]] = [M[piv], M[col]];
    const d = M[col][col];
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = M[r][col] / d;
      if (f === 0) continue;
      for (let c = col; c <= n; c++) M[r][c] -= f * M[col][c];
    }
  }
  return M.map((row, i) => row[n] / M[i][i]);
}
