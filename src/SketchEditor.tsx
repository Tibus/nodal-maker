/**
 * Full-screen 2D constraint sketch editor (Fusion-style).
 *
 * Draw lines / rectangles / circles / arcs / splines, weld endpoints by
 * snapping, add geometric constraints and driving dimensions — the whole thing
 * re-solves live after every edit (drag included). On "Finish" the document is
 * committed back onto the Sketch node, where each driving dimension becomes an
 * editable parameter.
 *
 * Interaction uses a synchronous `docRef` + `applyDoc()` (mutate → solve →
 * setState) so tool handlers can read back the ids they just created — much
 * cleaner than threading new-point ids through async setState.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  cloneDoc,
  addPoint,
  mergePoints,
  deleteEntity as docDeleteEntity,
  nextId,
  dimensions,
  freshDimName,
  isDim,
  type SketchDoc,
  type Entity,
  type Constraint,
  type DimConstraint,
  type Id,
} from "./sketch/model";
import { solve } from "./sketch/solver";
import { tessellate, bbox, type Vec2 } from "./sketch/geometry";

type Tool = "select" | "line" | "rect" | "circle" | "arc" | "spline" | "polygon" | "slot";
interface View { ox: number; oy: number; scale: number }
interface Props { initialDoc: SketchDoc; onCommit: (doc: SketchDoc) => void; onCancel: () => void }

const POINT_SNAP_PX = 11;
const AXIS_SNAP_DEG = 3;

export default function SketchEditor({ initialDoc, onCommit, onCancel }: Props) {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const [size, setSize] = useState({ w: 800, h: 600 });
  const [doc, setDocState] = useState<SketchDoc>(() => { const d = cloneDoc(initialDoc); solve(d); return d; });
  const docRef = useRef(doc);
  const [view, setView] = useState<View>({ ox: 400, oy: 300, scale: 4 });
  const [tool, setToolState] = useState<Tool>("select");
  const [gridSnap, setGridSnap] = useState(true);
  const [polySides, setPolySides] = useState(6);
  // inline dimension editor (double-click a dim label on the canvas)
  const [editDim, setEditDim] = useState<{ id: Id; sx: number; sy: number; value: number } | null>(null);
  const [sel, setSel] = useState<{ points: Set<Id>; entities: Set<Id> }>({ points: new Set(), entities: new Set() });
  const [cursor, setCursor] = useState<Vec2 | null>(null);
  const [snapPt, setSnapPt] = useState<Id | null>(null);
  const [status, setStatus] = useState("");
  const [, forceRender] = useState(0);

  // active-tool scratch (chain of placed points, arc/rect anchors) — refs so
  // rapid clicks don't fight React batching
  const chain = useRef<Id[]>([]);
  const dragRef = useRef<Id | null>(null);
  const dragSnap = useRef<SketchDoc | null>(null);
  const dragMoved = useRef(false);

  // ---- doc mutation (synchronous, returns whatever `mutate` returns) -------
  const applyDoc = useCallback(<T,>(mutate: (d: SketchDoc) => T, opts?: { pin?: { id: Id; x: number; y: number }[]; pull?: { id: Id; x: number; y: number }[] }): T => {
    const d = cloneDoc(docRef.current);
    const ret = mutate(d);
    solve(d, { pin: opts?.pin, pull: opts?.pull });
    docRef.current = d;
    setDocState(d);
    return ret;
  }, []);

  // undo / redo: snapshots of the doc taken before each discrete edit
  const histPast = useRef<SketchDoc[]>([]);
  const histFuture = useRef<SketchDoc[]>([]);
  const snapshot = useCallback(() => {
    histPast.current.push(cloneDoc(docRef.current));
    if (histPast.current.length > 100) histPast.current.shift();
    histFuture.current = [];
  }, []);
  const undo = useCallback(() => {
    const prev = histPast.current.pop();
    if (!prev) return;
    histFuture.current.push(cloneDoc(docRef.current));
    docRef.current = prev;
    setDocState(prev);
  }, []);
  const redo = useCallback(() => {
    const next = histFuture.current.pop();
    if (!next) return;
    histPast.current.push(cloneDoc(docRef.current));
    docRef.current = next;
    setDocState(next);
  }, []);

  // ---- transforms ---------------------------------------------------------
  const toS = useCallback((w: Vec2): Vec2 => [view.ox + w[0] * view.scale, view.oy - w[1] * view.scale], [view]);
  const toW = useCallback((s: Vec2): Vec2 => [(s[0] - view.ox) / view.scale, (view.oy - s[1]) / view.scale], [view]);

  const fittedRef = useRef(false);
  const fit = useCallback((w: number, h: number) => {
    const bb = bbox(docRef.current);
    const pad = 60;
    const dw = Math.max(bb.max[0] - bb.min[0], 10), dh = Math.max(bb.max[1] - bb.min[1], 10);
    const scale = Math.min((w - 2 * pad) / dw, (h - 2 * pad) / dh, 30);
    const cx = (bb.min[0] + bb.max[0]) / 2, cy = (bb.min[1] + bb.max[1]) / 2;
    setView({ ox: w / 2 - cx * scale, oy: h / 2 + cy * scale, scale });
  }, []);

  useEffect(() => {
    const el = svgRef.current?.parentElement;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      const r = el.getBoundingClientRect();
      setSize({ w: r.width, h: r.height });
      if (!fittedRef.current && r.width > 0) { fit(r.width, r.height); fittedRef.current = true; }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [fit]);

  // wheel zoom around cursor (native, non-passive)
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = svg.getBoundingClientRect();
      const sx = e.clientX - rect.left, sy = e.clientY - rect.top;
      setView((v) => {
        const ns = Math.max(0.3, Math.min(400, v.scale * Math.exp(-e.deltaY * 0.0015)));
        const wx = (sx - v.ox) / v.scale, wy = (v.oy - sy) / v.scale;
        return { ox: sx - wx * ns, oy: sy + wy * ns, scale: ns };
      });
    };
    svg.addEventListener("wheel", onWheel, { passive: false });
    return () => svg.removeEventListener("wheel", onWheel);
  }, []);

  // middle / right / space-drag pan
  const panRef = useRef<{ x: number; y: number; ox: number; oy: number } | null>(null);

  // ---- snapping / hit testing ---------------------------------------------
  const svgPoint = (e: { clientX: number; clientY: number }): Vec2 => {
    const r = svgRef.current!.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  };
  const nearestPoint = useCallback((sp: Vec2, exclude?: Set<Id>): Id | null => {
    let best: Id | null = null, bestD = POINT_SNAP_PX;
    for (const p of docRef.current.points) {
      if (exclude?.has(p.id)) continue;
      const s = toS([p.x, p.y]);
      const d = Math.hypot(s[0] - sp[0], s[1] - sp[1]);
      if (d < bestD) { bestD = d; best = p.id; }
    }
    return best;
  }, [toS]);
  const snapWorld = useCallback((sp: Vec2, exclude?: Set<Id>): { w: Vec2; onPoint: Id | null } => {
    const hit = nearestPoint(sp, exclude);
    if (hit) { const p = docRef.current.points.find((q) => q.id === hit)!; return { w: [p.x, p.y], onPoint: hit }; }
    let w = toW(sp);
    if (gridSnap) { const step = gridStep(view.scale); w = [Math.round(w[0] / step) * step, Math.round(w[1] / step) * step]; }
    return { w, onPoint: null };
  }, [nearestPoint, toW, gridSnap, view.scale]);
  const entityAt = useCallback((sp: Vec2): Id | null => {
    let best: Id | null = null, bestD = 10;
    for (const t of tessellate(docRef.current)) for (let i = 0; i < t.pts.length - 1; i++) {
      const d = distToSeg(sp, toS(t.pts[i]), toS(t.pts[i + 1]));
      if (d < bestD) { bestD = d; best = t.id; }
    }
    return best;
  }, [toS]);

  // ---- tools --------------------------------------------------------------
  const setTool = (t: Tool) => { setToolState(t); chain.current = []; setStatus(""); setSel({ points: new Set(), entities: new Set() }); };
  const finishChain = () => { setToolState("select"); chain.current = []; setStatus(""); };

  const addLineSeg = (d: SketchDoc, p1: Id, p2: Id): void => {
    const e: Entity = { id: nextId(d, "e"), kind: "line", p1, p2 };
    d.entities.push(e);
    const a = d.points.find((q) => q.id === p1)!, b = d.points.find((q) => q.id === p2)!;
    const ang = (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI;
    const near = (t: number) => Math.abs(((ang - t + 540) % 360) - 180) < AXIS_SNAP_DEG;
    if (near(0) || near(180)) d.constraints.push({ id: nextId(d, "c"), kind: "horizontal", line: e.id } as Constraint);
    else if (near(90) || near(-90)) d.constraints.push({ id: nextId(d, "c"), kind: "vertical", line: e.id } as Constraint);
  };
  const ensurePoint = (d: SketchDoc, w: Vec2, onPoint: Id | null): Id => onPoint ?? addPoint(d, w[0], w[1]).id;

  const onCanvasClick = (e: React.MouseEvent) => {
    if (e.button !== 0 || panRef.current) return;
    const sp = svgPoint(e);

    if (tool === "select") {
      const pid = nearestPoint(sp);
      const ent = pid ? null : entityAt(sp);
      if (pid) setSel((s) => toggle(s, "points", pid, e.shiftKey));
      else if (ent) setSel((s) => toggle(s, "entities", ent, e.shiftKey));
      else if (!e.shiftKey) setSel({ points: new Set(), entities: new Set() });
      return;
    }

    const { w, onPoint } = snapWorld(sp);
    // snapshot once per primitive (on its first click) so a single undo removes
    // the whole thing — never leaving an orphan centre/endpoint behind
    if (chain.current.length === 0) snapshot();
    if (tool === "line") {
      const closing = onPoint && chain.current.length > 0 && onPoint === chain.current[0];
      const id = applyDoc((d) => {
        const pid = closing ? chain.current[0] : ensurePoint(d, w, onPoint);
        const prev = chain.current[chain.current.length - 1];
        if (prev) addLineSeg(d, prev, pid);
        return pid;
      });
      if (closing) finishChain(); else { chain.current.push(id); setStatus(`${chain.current.length} point(s) — click start or Esc to finish`); }
      return;
    }
    if (tool === "rect") {
      if (chain.current.length === 0) {
        const id = applyDoc((d) => ensurePoint(d, w, onPoint));
        chain.current = [id]; setStatus("rectangle: click the opposite corner");
      } else {
        applyDoc((d) => {
          const a = d.points.find((q) => q.id === chain.current[0])!;
          const cId = ensurePoint(d, w, onPoint);
          const c = d.points.find((q) => q.id === cId)!;
          const bId = addPoint(d, c.x, a.y).id;
          const dId = addPoint(d, a.x, c.y).id;
          addLineSeg(d, a.id, bId); addLineSeg(d, bId, cId); addLineSeg(d, cId, dId); addLineSeg(d, dId, a.id);
        });
        finishChain();
      }
      return;
    }
    if (tool === "circle") {
      if (chain.current.length === 0) {
        const id = applyDoc((d) => ensurePoint(d, w, onPoint));
        chain.current = [id]; setStatus("circle: click to set the radius");
      } else {
        applyDoc((d) => {
          const c = d.points.find((q) => q.id === chain.current[0])!;
          const r = Math.hypot(w[0] - c.x, w[1] - c.y) || 5;
          d.entities.push({ id: nextId(d, "e"), kind: "circle", c: c.id, r });
        });
        finishChain();
      }
      return;
    }
    if (tool === "arc") {
      if (chain.current.length < 2) {
        const id = applyDoc((d) => ensurePoint(d, w, onPoint));
        chain.current.push(id);
        setStatus(chain.current.length === 1 ? "arc: click the end point" : "arc: click a point on the arc");
      } else {
        applyDoc((d) => {
          const ps = d.points.find((q) => q.id === chain.current[0])!;
          const pe = d.points.find((q) => q.id === chain.current[1])!;
          const cc = circumcenter([ps.x, ps.y], w, [pe.x, pe.y]);
          if (cc) {
            const cId = addPoint(d, cc[0], cc[1]).id;
            const ccw = signedArea([ps.x, ps.y], w, [pe.x, pe.y]) > 0;
            d.entities.push({ id: nextId(d, "e"), kind: "arc", c: cId, p1: ps.id, p2: pe.id, ccw });
          }
        });
        finishChain();
      }
      return;
    }
    if (tool === "spline") {
      const id = applyDoc((d) => ensurePoint(d, w, onPoint));
      chain.current.push(id);
      setStatus(`spline: ${chain.current.length} point(s) — Enter / double-click to finish`);
      return;
    }
    if (tool === "polygon") {
      if (chain.current.length === 0) {
        const id = applyDoc((d) => ensurePoint(d, w, onPoint));
        chain.current = [id]; setStatus(`polygon (${polySides} sides): click a vertex`);
      } else {
        const n = polySides;
        applyDoc((d) => {
          const c = d.points.find((q) => q.id === chain.current[0])!;
          const r = Math.hypot(w[0] - c.x, w[1] - c.y) || 5;
          const a0 = Math.atan2(w[1] - c.y, w[0] - c.x);
          const verts: string[] = [];
          for (let i = 0; i < n; i++) {
            const a = a0 + (2 * Math.PI * i) / n;
            verts.push(addPoint(d, c.x + r * Math.cos(a), c.y + r * Math.sin(a)).id);
          }
          const edges: string[] = [];
          for (let i = 0; i < n; i++) {
            const e: Entity = { id: nextId(d, "e"), kind: "line", p1: verts[i], p2: verts[(i + 1) % n] };
            d.entities.push(e); edges.push(e.id);
          }
          // keep it regular: all edges equal + all vertices on a construction circle
          for (let i = 1; i < n; i++) d.constraints.push({ id: nextId(d, "c"), kind: "equal", a: edges[0], b: edges[i] } as Constraint);
          const circ: Entity = { id: nextId(d, "e"), kind: "circle", c: c.id, r, construction: true };
          d.entities.push(circ);
          for (const v of verts) d.constraints.push({ id: nextId(d, "c"), kind: "pointOn", p: v, ent: circ.id } as Constraint);
        });
        finishChain();
      }
      return;
    }
    if (tool === "slot") {
      if (chain.current.length < 2) {
        const id = applyDoc((d) => ensurePoint(d, w, onPoint));
        chain.current.push(id);
        setStatus(chain.current.length === 1 ? "slot: click the 2nd centre" : "slot: click to set the width");
      } else {
        applyDoc((d) => {
          const A = d.points.find((q) => q.id === chain.current[0])!;
          const B = d.points.find((q) => q.id === chain.current[1])!;
          const dx = B.x - A.x, dy = B.y - A.y, L = Math.hypot(dx, dy) || 1;
          const ux = dx / L, uy = dy / L;      // along A→B
          const nx = -uy, ny = ux;             // perpendicular
          // radius = perpendicular distance from the width-click to line AB
          const r = Math.max(0.5, Math.abs((w[0] - A.x) * nx + (w[1] - A.y) * ny));
          const P = (x: number, y: number) => addPoint(d, x, y).id;
          const p1 = P(A.x + nx * r, A.y + ny * r); // A side, +n
          const p2 = P(B.x + nx * r, B.y + ny * r); // B side, +n
          const p3 = P(B.x - nx * r, B.y - ny * r); // B side, -n
          const p4 = P(A.x - nx * r, A.y - ny * r); // A side, -n
          const line = (a: string, b: string) => d.entities.push({ id: nextId(d, "e"), kind: "line", p1: a, p2: b } as Entity);
          const arc = (c: string, a: string, b: string, ccw: boolean) => d.entities.push({ id: nextId(d, "e"), kind: "arc", c, p1: a, p2: b, ccw } as Entity);
          line(p1, p2);                         // +n side
          arc(B.id, p2, p3, false);             // round cap at B (bulges away from A)
          line(p3, p4);                         // -n side
          arc(A.id, p4, p1, false);             // round cap at A (bulges away from B)
        });
        finishChain();
      }
      return;
    }
  };

  const finishTool = useCallback(() => {
    if (tool === "spline" && chain.current.length >= 2) {
      const pts = [...chain.current];
      applyDoc((d) => { d.entities.push({ id: nextId(d, "e"), kind: "spline", pts }); });
    }
    finishChain();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tool, applyDoc]);

  // ---- pointer (drag points / pan) ----------------------------------------
  const onMouseDown = (e: React.MouseEvent) => {
    if (e.button === 1 || e.button === 2 || (e.button === 0 && e.altKey)) {
      panRef.current = { x: e.clientX, y: e.clientY, ox: view.ox, oy: view.oy };
      return;
    }
    if (tool === "select" && e.button === 0) {
      const pid = nearestPoint(svgPoint(e));
      if (pid) {
        dragRef.current = pid;
        dragSnap.current = cloneDoc(docRef.current); // committed to history on first move
        dragMoved.current = false;
        setSel({ points: new Set([pid]), entities: new Set() });
      }
    }
  };
  const onMouseMove = (e: React.MouseEvent) => {
    if (panRef.current) {
      setView((v) => ({ ...v, ox: panRef.current!.ox + (e.clientX - panRef.current!.x), oy: panRef.current!.oy + (e.clientY - panRef.current!.y) }));
      return;
    }
    const sp = svgPoint(e);
    setCursor(toW(sp));
    if (dragRef.current) {
      const id = dragRef.current;
      // commit the pre-drag snapshot to history once, on the first move
      if (!dragMoved.current && dragSnap.current) {
        histPast.current.push(dragSnap.current);
        if (histPast.current.length > 100) histPast.current.shift();
        histFuture.current = [];
        dragMoved.current = true;
      }
      const snap = snapWorld(sp, new Set([id]));
      // soft pull only: constraints stay satisfied, only free DOF follow the
      // cursor (don't set the position directly — that would defeat the pull)
      applyDoc(() => {}, { pull: [{ id, x: snap.w[0], y: snap.w[1] }] });
      setSnapPt(snap.onPoint);
    } else if (tool !== "select") {
      setSnapPt(nearestPoint(sp));
    }
  };
  const onMouseUp = (e: React.MouseEvent) => {
    if (panRef.current) { const moved = Math.hypot(e.clientX - panRef.current.x, e.clientY - panRef.current.y); panRef.current = null; if (moved > 3) { /* was a pan, swallow click */ } return; }
    if (dragRef.current) {
      const id = dragRef.current;
      const target = nearestPoint(svgPoint(e), new Set([id]));
      if (target) applyDoc((d) => mergePoints(d, target, id));
      dragRef.current = null; setSnapPt(null);
    }
  };

  // ---- constraints & dimensions -------------------------------------------
  const selArr = useMemo(() => ({ pts: [...sel.points], ents: [...sel.entities] }), [sel]);

  const addConstraint = (kind: string) => {
    const { pts, ents } = selArr;
    snapshot();
    applyDoc((d) => {
      const push = (c: Record<string, unknown>) => d.constraints.push({ id: nextId(d, "c"), kind, ...c } as unknown as Constraint);
      const isLine = (id: Id) => d.entities.find((x) => x.id === id)?.kind === "line";
      switch (kind) {
        case "coincident": if (pts.length === 2) mergePoints(d, pts[0], pts[1]); break;
        case "horizontal": case "vertical": for (const e of ents) if (isLine(e)) push({ line: e }); break;
        case "parallel": case "perpendicular": case "equal": case "tangent": if (ents.length === 2) push({ a: ents[0], b: ents[1] }); break;
        case "fixed": for (const p of pts) { const pp = d.points.find((q) => q.id === p); if (pp) pp.fixed = !pp.fixed; } break;
        case "symmetric": if (pts.length === 2 && ents.length === 1) push({ a: pts[0], b: pts[1], line: ents[0] }); break;
        case "pointOn": if (pts.length === 1 && ents.length === 1) push({ p: pts[0], ent: ents[0] }); break;
        case "midpoint": if (pts.length === 1 && ents.length === 1) push({ p: pts[0], line: ents[0] }); break;
        case "concentric": {
          // merge the centres of two circles/arcs (their coincidence IS the constraint)
          if (ents.length === 2) {
            const centre = (id: Id) => { const e = d.entities.find((x) => x.id === id); return e && (e.kind === "circle" || e.kind === "arc") ? e.c : null; };
            const ca = centre(ents[0]), cb = centre(ents[1]);
            if (ca && cb) mergePoints(d, ca, cb);
          }
          break;
        }
      }
    });
    setSel({ points: new Set(), entities: new Set() });
  };

  const addDimension = () => {
    const { pts, ents } = selArr;
    snapshot();
    applyDoc((d) => {
      const P = (id: Id) => d.points.find((q) => q.id === id)!;
      const mk = (kind: DimConstraint["kind"], extra: Record<string, unknown>, value: number) =>
        d.constraints.push({ id: nextId(d, "c"), kind, name: freshDimName(d, kind), value, ...extra } as unknown as Constraint);
      if (pts.length === 2) { const a = P(pts[0]), b = P(pts[1]); mk("distance", { a: pts[0], b: pts[1] }, Math.hypot(a.x - b.x, a.y - b.y)); }
      else if (ents.length === 1) {
        const e = d.entities.find((x) => x.id === ents[0]);
        if (e?.kind === "line") { const a = P(e.p1), b = P(e.p2); mk("distance", { a: e.p1, b: e.p2 }, Math.hypot(a.x - b.x, a.y - b.y)); }
        else if (e?.kind === "circle") mk("radius", { ent: e.id }, e.r);
        else if (e?.kind === "arc") { const c = P(e.c), p1 = P(e.p1); mk("radius", { ent: e.id }, Math.hypot(c.x - p1.x, c.y - p1.y)); }
      } else if (ents.length === 2) {
        const l1 = d.entities.find((x) => x.id === ents[0]), l2 = d.entities.find((x) => x.id === ents[1]);
        if (l1?.kind === "line" && l2?.kind === "line") {
          const d1 = [P(l1.p2).x - P(l1.p1).x, P(l1.p2).y - P(l1.p1).y], d2 = [P(l2.p2).x - P(l2.p1).x, P(l2.p2).y - P(l2.p1).y];
          const ang = Math.abs((Math.atan2(d1[0] * d2[1] - d1[1] * d2[0], d1[0] * d2[0] + d1[1] * d2[1]) * 180) / Math.PI);
          mk("angle", { a: ents[0], b: ents[1] }, Math.round(ang));
        }
      }
    });
    setSel({ points: new Set(), entities: new Set() });
  };

  const setDimValue = (id: Id, value: number) => applyDoc((d) => { const c = d.constraints.find((x) => x.id === id); if (c && isDim(c)) c.value = value; });
  const setDimName = (id: Id, name: string) => applyDoc((d) => { const c = d.constraints.find((x) => x.id === id); if (c && isDim(c)) c.name = name; });
  const removeConstraint = (id: Id) => { snapshot(); applyDoc((d) => { d.constraints = d.constraints.filter((c) => c.id !== id); }); };

  /** flip construction (reference) flag on the selected entities */
  const toggleConstruction = () => {
    if (!sel.entities.size) return;
    snapshot();
    applyDoc((d) => {
      for (const e of d.entities) if (sel.entities.has(e.id)) e.construction = !e.construction;
    });
  };

  const deleteSelection = useCallback(() => {
    snapshot();
    applyDoc((d) => {
      for (const e of [...sel.entities]) docDeleteEntity(d, e);
      for (const p of [...sel.points]) if (!d.entities.some((e) => entityRefs(e).includes(p))) d.points = d.points.filter((q) => q.id !== p);
    });
    setSel({ points: new Set(), entities: new Set() });
  }, [sel, applyDoc]);

  // ---- keyboard -----------------------------------------------------------
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) return;
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z") { e.preventDefault(); if (e.shiftKey) redo(); else undo(); return; }
      if (e.key === "Escape") { if (chain.current.length || tool !== "select") { finishChain(); } else onCancel(); }
      else if (e.key === "Enter") { if (tool === "spline") finishTool(); else onCommit(commitDoc(docRef.current)); }
      else if (e.key === "Delete" || e.key === "Backspace") deleteSelection();
      else if (e.key === "l") setTool("line");
      else if (e.key === "r") setTool("rect");
      else if (e.key === "c") setTool("circle");
      else if (e.key === "a") setTool("arc");
      else if (e.key === "s") setTool("spline");
      else if (e.key === "v") setTool("select");
      else if (e.key === "x") toggleConstruction();
      else if (e.key === "f") fit(size.w, size.h);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tool, deleteSelection, finishTool, onCancel, onCommit, fit, size, undo, redo]);

  // ---- render -------------------------------------------------------------
  const dims = dimensions(doc);
  const tess = tessellate(doc);
  const gs = gridStep(view.scale);
  const chainStart = chain.current[0] ? doc.points.find((p) => p.id === chain.current[0]) : null;
  const chainTail = chain.current.length ? doc.points.find((p) => p.id === chain.current[chain.current.length - 1]) : null;
  void forceRender;

  return (
    <div className="ske" onContextMenu={(e) => e.preventDefault()}>
      <div className="ske__bar">
        <div className="ske__tools">
          {(["select", "line", "rect", "circle", "arc", "spline", "polygon", "slot"] as Tool[]).map((t) => (
            <button key={t} className={`ske__tool${tool === t ? " on" : ""}`} onClick={() => setTool(t)} title={TOOL_HINT[t]}>{TOOL_ICON[t]}</button>
          ))}
          {tool === "polygon" && (
            <input className="ske__sides" type="number" min={3} max={24} value={polySides}
              title="Polygon sides" onChange={(e) => setPolySides(Math.max(3, Math.min(24, Math.round(Number(e.target.value)) || 3)))} />
          )}
        </div>
        <div className="ske__cons">
          <button className="ske__con" onClick={undo} title="Undo (⌘Z)">↶</button>
          <button className="ske__con" onClick={redo} title="Redo (⇧⌘Z)">↷</button>
          <button className="ske__con" onClick={toggleConstruction} title="Toggle construction / reference geometry on the selection (X)">⋯</button>
        </div>
        <div className="ske__cons">
          {CONSTRAINTS.map((c) => (
            <button key={c.k} className="ske__con" onClick={() => addConstraint(c.k)} title={c.t}>{c.g}</button>
          ))}
          <button className="ske__con ske__con--dim" onClick={addDimension} title="Dimension (distance / radius / angle) from the selection">⟺</button>
        </div>
        <div className="ske__spacer" />
        <label className="ske__plane">plane
          <select value={doc.plane} onChange={(e) => { snapshot(); applyDoc((d) => { d.plane = e.target.value as SketchDoc["plane"]; }); }}>
            <option>XY</option><option>XZ</option><option>YZ</option>
          </select>
        </label>
        <button className={`ske__toggle${gridSnap ? " on" : ""}`} onClick={() => setGridSnap((v) => !v)} title="Snap to grid">grid</button>
        <button className="ske__btn" onClick={() => fit(size.w, size.h)}>fit</button>
        <button className="ske__btn ske__btn--cancel" onClick={onCancel}>Cancel</button>
        <button className="ske__btn ske__btn--ok" onClick={() => onCommit(commitDoc(docRef.current))}>✓ Finish</button>
      </div>

      <div className="ske__stage">
        <svg ref={svgRef} width={size.w} height={size.h} className={`ske__svg ske__svg--${tool}`}
          onClick={onCanvasClick} onMouseDown={onMouseDown} onMouseMove={onMouseMove} onMouseUp={onMouseUp}
          onMouseLeave={() => { setCursor(null); }} onDoubleClick={() => finishTool()}>
          <Grid size={size} view={view} step={gs} toS={toS} />
          <line x1={toS([0, 0])[0]} y1={0} x2={toS([0, 0])[0]} y2={size.h} className="ske__axis" />
          <line x1={0} y1={toS([0, 0])[1]} x2={size.w} y2={toS([0, 0])[1]} className="ske__axis" />

          {tess.map((t) => {
            const d = t.pts.map(toS).map((p, i) => `${i ? "L" : "M"}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(" ");
            return <path key={t.id} d={d} className={`ske__ent${t.construction ? " constr" : ""}${sel.entities.has(t.id) ? " sel" : ""}`} fill="none" />;
          })}

          {cursor && chainTail && (
            <PreviewSeg tool={tool} from={[chainTail.x, chainTail.y]} cursor={cursor} toS={toS} />
          )}

          {dims.map((dm) => <DimLabel key={dm.id} dim={dm} doc={doc} toS={toS} onEdit={(id, sx, sy) => setEditDim({ id, sx, sy, value: dm.value })} />)}
          <ConstraintGlyphs doc={doc} toS={toS} onRemove={removeConstraint} />

          {doc.points.map((p) => {
            const s = toS([p.x, p.y]);
            return <rect key={p.id} x={s[0] - 3.5} y={s[1] - 3.5} width={7} height={7}
              className={`ske__pt${p.fixed ? " fixed" : ""}${sel.points.has(p.id) ? " sel" : ""}${snapPt === p.id ? " snap" : ""}${chainStart?.id === p.id ? " start" : ""}`} />;
          })}
          {snapPt && (() => { const p = doc.points.find((q) => q.id === snapPt)!; const s = toS([p.x, p.y]); return <circle cx={s[0]} cy={s[1]} r={9} className="ske__snapring" />; })()}
        </svg>

        {editDim && (
          <input
            className="ske__diminput"
            style={{ left: editDim.sx - 28, top: editDim.sy - 10 }}
            type="number"
            step={0.5}
            autoFocus
            defaultValue={round(editDim.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") { setDimValue(editDim.id, Number((e.target as HTMLInputElement).value)); setEditDim(null); }
              else if (e.key === "Escape") setEditDim(null);
            }}
            onBlur={(e) => { setDimValue(editDim.id, Number(e.target.value)); setEditDim(null); }}
          />
        )}

        <div className="ske__panel">
          <div className="ske__phd">Dimensions <span>{dims.length}</span></div>
          {dims.length === 0 && <div className="ske__empty">Select geometry, then click <b>⟺</b> to add a driving dimension. Each becomes an editable node parameter.</div>}
          {dims.map((dm) => (
            <div className="ske__dim" key={dm.id}>
              <input className="ske__dimname" value={dm.name} onChange={(e) => setDimName(dm.id, e.target.value)} spellCheck={false} />
              <input className="ske__dimval" type="number" step={0.5} value={round(dm.value)} onChange={(e) => setDimValue(dm.id, Number(e.target.value))} />
              <span className="ske__dimu">{dm.kind === "angle" ? "°" : "mm"}</span>
              <button className="ske__dimx" onClick={() => removeConstraint(dm.id)} title="delete dimension">×</button>
            </div>
          ))}
          <div className="ske__phd">Selection</div>
          <div className="ske__selinfo">{selArr.pts.length} point(s) · {selArr.ents.length} entit(y/ies)</div>
          <button className="ske__del" onClick={deleteSelection} disabled={!selArr.pts.length && !selArr.ents.length}>Delete selection ⌫</button>
          <div className="ske__hintbox">
            <div><b>Constraints</b> act on the current selection. E.g. select 2 lines → ∥ ⊥ =. Select a point + line → ⌖.</div>
            <div>Auto H/V is applied to near-axis lines while drawing.</div>
          </div>
        </div>
      </div>

      <div className="ske__status">
        <b>{TOOL_HINT[tool]}</b>{status && ` — ${status}`}
        <span className="ske__coord">{cursor ? `x ${cursor[0].toFixed(1)}  y ${cursor[1].toFixed(1)}  ·  ${dims.length} dims` : ""}</span>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* sub-components                                                             */
/* -------------------------------------------------------------------------- */

function Grid({ size, view, step, toS }: { size: { w: number; h: number }; view: View; step: number; toS: (w: Vec2) => Vec2 }) {
  const lines: React.ReactNode[] = [];
  const w0 = -view.ox / view.scale, w1 = (size.w - view.ox) / view.scale;
  const h1 = view.oy / view.scale, h0 = (view.oy - size.h) / view.scale;
  const x0 = Math.floor(w0 / step) * step, x1 = Math.ceil(w1 / step) * step;
  const y0 = Math.floor(h0 / step) * step, y1 = Math.ceil(h1 / step) * step;
  if ((x1 - x0) / step < 500) for (let x = x0; x <= x1 + 1e-6; x += step) {
    const s = toS([x, 0])[0];
    lines.push(<line key={`x${x.toFixed(2)}`} x1={s} y1={0} x2={s} y2={size.h} className={Math.abs(x) < step / 2 ? "ske__grid0" : "ske__grid"} />);
  }
  if ((y1 - y0) / step < 500) for (let y = y0; y <= y1 + 1e-6; y += step) {
    const s = toS([0, y])[1];
    lines.push(<line key={`y${y.toFixed(2)}`} x1={0} y1={s} x2={size.w} y2={s} className={Math.abs(y) < step / 2 ? "ske__grid0" : "ske__grid"} />);
  }
  return <g>{lines}</g>;
}

function PreviewSeg({ tool, from, cursor, toS }: { tool: Tool; from: Vec2; cursor: Vec2; toS: (w: Vec2) => Vec2 }) {
  const a = toS(from), b = toS(cursor);
  if (tool === "circle") return <circle cx={a[0]} cy={a[1]} r={Math.hypot(b[0] - a[0], b[1] - a[1])} className="ske__preview" fill="none" />;
  if (tool === "rect") return <rect x={Math.min(a[0], b[0])} y={Math.min(a[1], b[1])} width={Math.abs(b[0] - a[0])} height={Math.abs(b[1] - a[1])} className="ske__preview" fill="none" />;
  return <line x1={a[0]} y1={a[1]} x2={b[0]} y2={b[1]} className="ske__preview" />;
}

const DIM_OFFSET = 26; // px the dimension line sits off the measured geometry

function labelBox(s: Vec2, text: string, onDbl?: (e: React.MouseEvent) => void) {
  return (
    <g className="ske__dimlabel" onDoubleClick={onDbl} style={onDbl ? { cursor: "text" } : undefined}>
      <rect x={s[0] - text.length * 3.2 - 3} y={s[1] - 8} width={text.length * 6.4 + 6} height={15} rx={2} />
      <text x={s[0]} y={s[1] + 2.5} textAnchor="middle">{text}</text>
    </g>
  );
}
function arrow(at: Vec2, dir: Vec2) {
  // small arrowhead pointing along `dir` (unit) at screen point `at`
  const n: Vec2 = [-dir[1], dir[0]];
  const L = 7, W = 2.6;
  const p1: Vec2 = [at[0] - dir[0] * L + n[0] * W, at[1] - dir[1] * L + n[1] * W];
  const p2: Vec2 = [at[0] - dir[0] * L - n[0] * W, at[1] - dir[1] * L - n[1] * W];
  return <path d={`M${at[0]},${at[1]} L${p1[0]},${p1[1]} L${p2[0]},${p2[1]} Z`} className="ske__dimarrow" />;
}

function DimLabel({ dim, doc, toS, onEdit }: { dim: DimConstraint; doc: SketchDoc; toS: (w: Vec2) => Vec2; onEdit: (id: Id, sx: number, sy: number) => void }) {
  const P = (id: Id) => doc.points.find((q) => q.id === id);
  const edit = (s: Vec2) => (e: React.MouseEvent) => { e.stopPropagation(); onEdit(dim.id, s[0], s[1]); };

  // linear dimensions: witness lines + offset dimension line + arrows + label
  if (dim.kind === "distance" || dim.kind === "distanceX" || dim.kind === "distanceY") {
    const a = P(dim.a), b = P(dim.b);
    if (!a || !b) return null;
    const sa = toS([a.x, a.y]), sb = toS([b.x, b.y]);
    const dx = sb[0] - sa[0], dy = sb[1] - sa[1];
    const len = Math.hypot(dx, dy) || 1;
    const d: Vec2 = [dx / len, dy / len];
    const n: Vec2 = [-d[1], d[0]]; // perpendicular offset direction
    const da: Vec2 = [sa[0] + n[0] * DIM_OFFSET, sa[1] + n[1] * DIM_OFFSET];
    const db: Vec2 = [sb[0] + n[0] * DIM_OFFSET, sb[1] + n[1] * DIM_OFFSET];
    const mid: Vec2 = [(da[0] + db[0]) / 2, (da[1] + db[1]) / 2];
    const text = `${dim.name} ${round(dim.value)}`;
    return (
      <g>
        <line x1={sa[0]} y1={sa[1]} x2={da[0]} y2={da[1]} className="ske__witness" />
        <line x1={sb[0]} y1={sb[1]} x2={db[0]} y2={db[1]} className="ske__witness" />
        <line x1={da[0]} y1={da[1]} x2={db[0]} y2={db[1]} className="ske__dimline" />
        {arrow(da, [-d[0], -d[1]])}
        {arrow(db, d)}
        {labelBox(mid, text, edit(mid))}
      </g>
    );
  }

  // radius: leader from centre outward
  if (dim.kind === "radius") {
    const e = doc.entities.find((x) => x.id === dim.ent);
    let c: Vec2 | null = null, r = 0;
    if (e?.kind === "circle") { const cp = P(e.c)!; c = [cp.x, cp.y]; r = e.r; }
    else if (e?.kind === "arc") { const cp = P(e.c)!, p1 = P(e.p1)!; c = [cp.x, cp.y]; r = Math.hypot(cp.x - p1.x, cp.y - p1.y); }
    if (!c) return null;
    const sc = toS(c);
    const dir: Vec2 = [0.7071, -0.7071];
    const edge = toS([c[0] + dir[0] * r, c[1] + dir[1] * r]);
    return (
      <g>
        <line x1={sc[0]} y1={sc[1]} x2={edge[0]} y2={edge[1]} className="ske__dimline" />
        {labelBox([edge[0] + 22, edge[1] - 8], `${dim.name} R${round(dim.value)}`, edit([edge[0] + 22, edge[1] - 8]))}
      </g>
    );
  }

  // angle: label near the first line's midpoint
  if (dim.kind === "angle") {
    const a = doc.entities.find((x) => x.id === dim.a);
    if (a?.kind !== "line") return null;
    const p = P(a.p1)!, q = P(a.p2)!;
    const s = toS([(p.x + q.x) / 2, (p.y + q.y) / 2]);
    return labelBox(s, `${dim.name} ${round(dim.value)}°`, edit(s));
  }
  return null;
}

function ConstraintGlyphs({ doc, toS, onRemove }: { doc: SketchDoc; toS: (w: Vec2) => Vec2; onRemove: (id: Id) => void }) {
  const P = (id: Id) => doc.points.find((q) => q.id === id);
  const out: React.ReactNode[] = [];
  for (const c of doc.constraints) {
    if (isDim(c)) continue;
    let pos: Vec2 | null = null, g = "";
    if (c.kind === "horizontal" || c.kind === "vertical") {
      const e = doc.entities.find((x) => x.id === c.line);
      if (e?.kind === "line") { const a = P(e.p1)!, b = P(e.p2)!; pos = [(a.x + b.x) / 2, (a.y + b.y) / 2]; g = c.kind === "horizontal" ? "H" : "V"; }
    } else if (c.kind === "parallel" || c.kind === "perpendicular" || c.kind === "equal" || c.kind === "tangent") {
      const e = doc.entities.find((x) => x.id === c.a);
      if (e?.kind === "line") { const a = P(e.p1)!, b = P(e.p2)!; pos = [(a.x + b.x) / 2, (a.y + b.y) / 2]; }
      g = c.kind === "parallel" ? "∥" : c.kind === "perpendicular" ? "⊥" : c.kind === "equal" ? "=" : "◜";
    } else if (c.kind === "fixed") { const p = P(c.p); if (p) { pos = [p.x, p.y]; g = "▪"; } }
    if (pos) { const s = toS(pos); out.push(<text key={c.id} x={s[0] + 6} y={s[1] - 6} className="ske__glyph" onClick={(e) => { e.stopPropagation(); onRemove(c.id); }}>{g}</text>); }
  }
  return <g>{out}</g>;
}

/* -------------------------------------------------------------------------- */
/* helpers                                                                    */
/* -------------------------------------------------------------------------- */

const TOOL_ICON: Record<Tool, string> = { select: "▲", line: "╱", rect: "▭", circle: "◯", arc: "◜", spline: "∿", polygon: "⬡", slot: "⬭" };
const TOOL_HINT: Record<Tool, string> = {
  select: "Select / drag (V)", line: "Line — click points; click start or Esc to finish (L)",
  rect: "Rectangle — two corners (R)", circle: "Circle — centre then radius (C)",
  arc: "Arc — start, end, then a point on the arc (A)", spline: "Spline — click points, Enter to finish (S)",
  polygon: "Polygon — centre then a vertex (P)", slot: "Slot — two centres then the width",
};
const CONSTRAINTS = [
  { k: "coincident", g: "•", t: "Coincident — weld 2 points" },
  { k: "horizontal", g: "H", t: "Horizontal (line)" },
  { k: "vertical", g: "V", t: "Vertical (line)" },
  { k: "parallel", g: "∥", t: "Parallel (2 lines)" },
  { k: "perpendicular", g: "⊥", t: "Perpendicular (2 lines)" },
  { k: "equal", g: "=", t: "Equal length / radius (2 entities)" },
  { k: "tangent", g: "◜", t: "Tangent (line+circle or 2 circles)" },
  { k: "concentric", g: "◎", t: "Concentric (2 circles/arcs share a centre)" },
  { k: "pointOn", g: "⌖", t: "Point on entity (1 point + 1 entity)" },
  { k: "midpoint", g: "⊢", t: "Midpoint (point at the middle of a line)" },
  { k: "symmetric", g: "⋈", t: "Symmetric (2 points about a line)" },
  { k: "fixed", g: "▪", t: "Fix / unfix point" },
];

function commitDoc(doc: SketchDoc): SketchDoc { const d = cloneDoc(doc); solve(d); return d; }
function round(v: number): number { return Math.round(v * 100) / 100; }
function gridStep(scale: number): number {
  const target = 28 / scale;
  const pow = Math.pow(10, Math.floor(Math.log10(target)));
  const m = target / pow;
  return (m < 1.5 ? 1 : m < 3.5 ? 2 : m < 7.5 ? 5 : 10) * pow;
}
function toggle(s: { points: Set<Id>; entities: Set<Id> }, key: "points" | "entities", id: Id, add: boolean) {
  const points = new Set(add ? s.points : key === "points" ? [] : s.points);
  const entities = new Set(add ? s.entities : key === "entities" ? [] : s.entities);
  const set = key === "points" ? points : entities;
  set.has(id) ? set.delete(id) : set.add(id);
  return { points, entities };
}
function entityRefs(e: Entity): Id[] {
  if (e.kind === "line") return [e.p1, e.p2];
  if (e.kind === "circle") return [e.c];
  if (e.kind === "arc") return [e.c, e.p1, e.p2];
  return e.pts;
}
function distToSeg(p: Vec2, a: Vec2, b: Vec2): number {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const L2 = dx * dx + dy * dy || 1e-9;
  const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L2));
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}
function circumcenter(a: Vec2, b: Vec2, c: Vec2): Vec2 | null {
  const d = 2 * (a[0] * (b[1] - c[1]) + b[0] * (c[1] - a[1]) + c[0] * (a[1] - b[1]));
  if (Math.abs(d) < 1e-9) return null;
  const a2 = a[0] * a[0] + a[1] * a[1], b2 = b[0] * b[0] + b[1] * b[1], c2 = c[0] * c[0] + c[1] * c[1];
  return [
    (a2 * (b[1] - c[1]) + b2 * (c[1] - a[1]) + c2 * (a[1] - b[1])) / d,
    (a2 * (c[0] - b[0]) + b2 * (a[0] - c[0]) + c2 * (b[0] - a[0])) / d,
  ];
}
function signedArea(a: Vec2, b: Vec2, c: Vec2): number {
  return (b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1]);
}
