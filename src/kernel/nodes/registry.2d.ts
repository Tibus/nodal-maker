/**
 * REGISTRY entries for all 2D nodes (2D Primitive + 2D Op categories).
 */
import {
  type Drawing,
  draw,
  drawRectangle,
  drawCircle,
  drawEllipse,
  drawPolysides,
} from "replicad";
import { svgPathToDrawing } from "../svgPath";
import { importDXF } from "../dxfImport";
import { cloneDoc, dimensions, type SketchDoc } from "../../sketch/model";
import { solve as solveSketch } from "../../sketch/solver";
import { buildDrawing } from "../../sketch/build";
import {
  expectSketch,
  combineDrawings,
  drawingRegions,
  drawingPolylines,
  buildTextDrawing,
  fingerPanel,
} from "./helpers";
import type { GraphValue, NodeImpl, Vec2 } from "./types";

export const nodes2d: Record<string, NodeImpl> = {
  /* --- primitives 2D (sources) — for laser / Cricut and profiles --- */
  sketch: (_inputs, params) => {
    // the constraint sketch, with driving dimensions overridden by the node's
    // params (so editing a dimension value re-solves and updates the 3D live)
    const raw = params.doc;
    const doc: SketchDoc | null =
      raw && typeof raw === "object" ? (raw as SketchDoc) : typeof raw === "string" && raw ? (JSON.parse(raw) as SketchDoc) : null;
    if (!doc || !doc.entities?.length) throw new Error("[sketch] empty — open the sketch editor and draw a closed profile");
    const overrides: Record<string, number> = {};
    for (const dim of dimensions(doc)) {
      const v = params[dim.name];
      if (v !== undefined && v !== null && v !== "") overrides[dim.name] = Number(v);
    }
    const solved = cloneDoc(doc);
    if (params.plane && solved.plane !== params.plane) solved.plane = params.plane as SketchDoc["plane"];
    solveSketch(solved, { overrides });
    return { kind: "sketch2d", drawing: buildDrawing(solved), plane: solved.plane, planeOffset: solved.planeOffset, frame: solved.frame };
  },
  rect: (_inputs, params) => ({
    kind: "sketch2d",
    drawing: drawRectangle(Number(params.width ?? 40), Number(params.height ?? 30), Number(params.radius ?? 0)),
  }),
  circle: (_inputs, params) => ({
    kind: "sketch2d",
    drawing: drawCircle(Number(params.radius ?? 20)),
  }),
  polygon: (_inputs, params) => ({
    kind: "sketch2d",
    drawing: drawPolysides(Number(params.radius ?? 20), Math.max(3, Math.round(Number(params.sides ?? 6)))),
  }),
  ellipse: (_inputs, params) => ({
    kind: "sketch2d",
    drawing: drawEllipse(Number(params.rx ?? 30), Number(params.ry ?? 18)),
  }),
  gear: (_inputs, params) => {
    // simplified spur-gear silhouette (trapezoidal teeth) — great for laser/print
    const n = Math.max(3, Math.round(Number(params.teeth ?? 12)));
    const pitch = Number(params.radius ?? 30);
    const depth = Number(params.depth ?? 6);
    const ro = pitch + depth / 2;
    const ri = Math.max(0.5, pitch - depth / 2);
    const step = (2 * Math.PI) / n;
    const P = (r: number, a: number): [number, number] => [r * Math.cos(a), r * Math.sin(a)];
    const pts: [number, number][] = [];
    for (let i = 0; i < n; i++) {
      const a = i * step;
      pts.push(P(ri, a));
      pts.push(P(ri, a + step * 0.3));
      pts.push(P(ro, a + step * 0.42));
      pts.push(P(ro, a + step * 0.58));
      pts.push(P(ri, a + step * 0.7));
    }
    let pen = draw(pts[0]);
    for (let i = 1; i < pts.length; i++) pen = pen.lineTo(pts[i]);
    return { kind: "sketch2d", drawing: pen.close() };
  },
  star: (_inputs, params) => {
    const outer = Number(params.outer ?? 30);
    const inner = Number(params.inner ?? 14);
    const n = Math.max(3, Math.round(Number(params.points ?? 5)));
    const pts: [number, number][] = [];
    for (let i = 0; i < n * 2; i++) {
      const r = i % 2 === 0 ? outer : inner;
      const a = (Math.PI * i) / n - Math.PI / 2;
      pts.push([r * Math.cos(a), r * Math.sin(a)]);
    }
    let pen = draw(pts[0]);
    for (let i = 1; i < pts.length; i++) pen = pen.lineTo(pts[i]);
    return { kind: "sketch2d", drawing: pen.close() };
  },
  slot: (_inputs, params) => {
    const len = Number(params.length ?? 40);
    const w = Number(params.width ?? 12);
    return { kind: "sketch2d", drawing: drawRectangle(len, w, w / 2) };
  },
  /**
   * Nest several 2D profiles onto a sheet (shelf/row packing by bounding box)
   * to minimise offcut. Connect up to 6 profiles (s0…s5); `copies` repeats each.
   * Rows wrap at `sheetWidth`; `gap` keeps a kerf-safe margin between parts.
   */
  nest: (inputs, params) => {
    const items = ["s0", "s1", "s2", "s3", "s4", "s5"]
      .map((k) => inputs[k])
      .filter((v): v is Extract<GraphValue, { kind: "sketch2d" }> => !!v && v.kind === "sketch2d")
      .map((v) => v.drawing);
    if (!items.length) throw new Error("[nest] connect at least one 2D profile (s0…)");
    const sheetW = Math.max(1, Number(params.sheetWidth ?? 200));
    const gap = Math.max(0, Number(params.gap ?? 3));
    const copies = Math.max(1, Math.round(Number(params.copies ?? 1)));
    const all: Drawing[] = [];
    for (const d of items) for (let i = 0; i < copies; i++) all.push(d);
    const boxed = all.map((d) => {
      const [lo, hi] = d.boundingBox.bounds;
      return { d, lo, w: hi[0] - lo[0], h: hi[1] - lo[1] };
    });
    boxed.sort((a, b) => b.h - a.h); // tallest first → tighter shelves
    let cx = 0, cy = 0, shelfH = 0;
    const placed: Drawing[] = [];
    for (const it of boxed) {
      if (cx > 0 && cx + it.w > sheetW) { cy += shelfH + gap; cx = 0; shelfH = 0; }
      placed.push(it.d.translate(cx - it.lo[0], cy - it.lo[1]));
      cx += it.w + gap;
      shelfH = Math.max(shelfH, it.h);
    }
    return { kind: "sketch2d", drawing: combineDrawings(placed) };
  },
  /**
   * Living (lattice) hinge: a rectangular board cut with staggered vertical
   * slots so it flexes about the Y axis. Columns of slots along X, offset by
   * half a period on alternate columns; top/bottom margins keep the board in
   * one piece. Feed to a laser DXF/SVG export. Bends across the width (X).
   */
  livingHinge: (_inputs, params) => {
    const W = Number(params.width ?? 80);
    const H = Number(params.height ?? 40);
    const spacing = Math.max(1, Number(params.spacing ?? 5)); // column pitch (X)
    const slotLen = Math.max(2, Number(params.slotLen ?? 24));
    const bridge = Math.max(0.5, Number(params.bridge ?? 4)); // gap between slot ends & to edges
    const kerf = Math.max(0.1, Number(params.kerf ?? 0.7)); // slot width
    let board = drawRectangle(W, H);
    const yLo = -H / 2 + bridge, yHi = H / 2 - bridge;
    const period = slotLen + bridge;
    const nCols = Math.max(1, Math.floor((W - spacing) / spacing));
    const x0 = -W / 2 + (W - (nCols - 1) * spacing) / 2; // centre the columns
    for (let i = 0; i < nCols; i++) {
      const x = x0 + i * spacing;
      const off = i % 2 === 1 ? period / 2 : 0;
      for (let sy = yLo - off; sy < yHi; sy += period) {
        const a = Math.max(sy, yLo), b = Math.min(sy + slotLen, yHi);
        const len = b - a;
        if (len < 1) continue;
        board = board.cut(drawRectangle(kerf, len).translate(x, (a + b) / 2));
      }
    }
    return { kind: "sketch2d", drawing: board };
  },
  fingerBox: (_inputs, params) => {
    // Flat pattern for a press-fit, finger-jointed box (laser cutting). Emits
    // the 5 (or 6) panels laid out side by side; feed the result into a
    // Score/Cut node as the "cut" layer, then export SVG.
    const W = Number(params.width ?? 80);
    const D = Number(params.depth ?? 60);
    const H = Number(params.height ?? 40);
    const T = Number(params.thickness ?? 3);
    const F = Number(params.finger ?? 10);
    const closed = String(params.lid ?? "open") === "closed";

    const flat = { finger: false, tabFirst: false };
    const tab = { finger: true, tabFirst: true }; // protruding fingers
    const slot = { finger: true, tabFirst: false }; // complementary recesses
    const top = closed ? slot : flat;

    // edges are [bottom, right, top, left] (CCW). bottom-panel & lid: tabs on
    // all four; walls: slots into the bottom/lid, tabs↔slots on the verticals.
    const parts: { panel: ReturnType<typeof fingerPanel>; w: number }[] = [
      { panel: fingerPanel(W, D, T, F, [tab, tab, tab, tab]), w: W }, // bottom
      { panel: fingerPanel(W, H, T, F, [slot, tab, top, tab]), w: W }, // front
      { panel: fingerPanel(W, H, T, F, [slot, tab, top, tab]), w: W }, // back
      { panel: fingerPanel(D, H, T, F, [slot, slot, top, slot]), w: D }, // left
      { panel: fingerPanel(D, H, T, F, [slot, slot, top, slot]), w: D }, // right
    ];
    if (closed) parts.push({ panel: fingerPanel(W, D, T, F, [tab, tab, tab, tab]), w: W }); // lid

    const gap = Math.max(6, T * 2);
    let x = 0;
    const placed = parts.map(({ panel, w }) => {
      const out = panel.translate(x + T, T);
      x += w + 2 * T + gap;
      return out;
    });
    return { kind: "sketch2d", drawing: combineDrawings(placed) };
  },
  boolean2d: (inputs, params) => {
    const a = expectSketch(inputs.base, "boolean2d");
    const b = expectSketch(inputs.tool, "boolean2d");
    const op = String(params.op ?? "union");
    // replicad's 2D boolean is unreliable when the TOOL has several disjoint
    // regions (e.g. a ring of holes from an array) — it mixes up windings and
    // returns garbage. Applying the op region-by-region uses only the robust
    // single-region path. (A CompoundBlueprint — one region with holes — stays
    // whole, so its holes aren't split off.)
    const tools = drawingRegions(b);
    let out: Drawing;
    if (op === "difference") {
      out = tools.reduce((acc, t) => acc.cut(t), a);
    } else if (op === "intersection") {
      out = tools.map((t) => a.intersect(t)).reduce((p, c) => p.fuse(c));
    } else {
      out = tools.reduce((acc, t) => acc.fuse(t), a);
    }
    return { kind: "sketch2d", drawing: out };
  },
  mirror2d: (inputs, params) => {
    const dr = expectSketch(inputs.in, "mirror2d");
    // axis "X" → flip across the X axis (direction [0,1]); "Y" → across Y ([1,0])
    const dir: [number, number] = String(params.axis ?? "X") === "X" ? [0, 1] : [1, 0];
    return { kind: "sketch2d", drawing: dr.mirror(dir, [0, 0], "plane") };
  },
  transform2d: (inputs, params) => {
    const dr = expectSketch(inputs.in, "transform2d");
    let out = dr;
    const sc = Number(params.scale ?? 1);
    if (sc !== 1) out = out.scale(sc);
    const rot = Number(params.rotate ?? 0);
    if (rot !== 0) out = out.rotate(rot);
    const tx = Number(params.tx ?? 0);
    const ty = Number(params.ty ?? 0);
    if (tx !== 0 || ty !== 0) out = out.translate(tx, ty);
    return { kind: "sketch2d", drawing: out };
  },
  arrayLinear2d: (inputs, params) => {
    const dr = expectSketch(inputs.in, "arrayLinear2d");
    const count = Math.max(1, Math.round(Number(params.count ?? 3)));
    const dx = Number(params.dx ?? 25);
    const dy = Number(params.dy ?? 0);
    let out = dr;
    for (let i = 1; i < count; i++) out = out.fuse(dr.translate(dx * i, dy * i));
    return { kind: "sketch2d", drawing: out };
  },
  arrayRadial2d: (inputs, params) => {
    const dr = expectSketch(inputs.in, "arrayRadial2d");
    const count = Math.max(1, Math.round(Number(params.count ?? 6)));
    const radius = Number(params.radius ?? 40);
    const total = Number(params.angle ?? 360);
    const base = radius !== 0 ? dr.translate(radius, 0) : dr;
    const full = Math.abs(total) >= 360;
    const denom = full ? count : Math.max(1, count - 1);
    let out = base;
    for (let i = 1; i < count; i++) out = out.fuse(base.rotate((total / denom) * i));
    return { kind: "sketch2d", drawing: out };
  },

  /**
   * Score/Cut for laser: `cut` is the through-cut outline, `score` the fold /
   * engrave lines. The preview shows both fused; `exportGraphSVG` emits them on
   * separate red (cut) / blue (score) layers.
   */
  /**
   * CNC job: bundle a contour, a pocket region and a drills profile with their
   * depths. Previews as the combined outline; **exportGraphDXF** emits one
   * layer per operation (depths in the layer name) + drill POINT entities, ready
   * for a CAM tool to assign toolpaths. Feeds an external CAM (Fusion, Carbide…).
   */
  cncJob: (inputs) => {
    const drs = ["contour", "pocket", "drills"]
      .map((k) => inputs[k])
      .filter((v): v is Extract<GraphValue, { kind: "sketch2d" }> => !!v && v.kind === "sketch2d")
      .map((v) => v.drawing);
    if (!drs.length) throw new Error("[cncJob] connect at least a contour, pocket or drills profile");
    let out = drs[0];
    for (let i = 1; i < drs.length; i++) { try { out = out.fuse(drs[i]); } catch { /* keep previewing what fused */ } }
    return { kind: "sketch2d", drawing: out };
  },
  scoreCut: (inputs) => {
    const cut = expectSketch(inputs.cut, "scoreCut");
    const score = inputs.score;
    if (!score || score.kind !== "sketch2d") return { kind: "sketch2d", drawing: cut };
    let drawing: Drawing;
    try {
      drawing = cut.fuse(score.drawing);
    } catch {
      drawing = cut; // open score paths may not fuse — preview the cut alone
    }
    return { kind: "sketch2d", drawing };
  },

  /** Union several 2D profiles into one (overlaps resolved). */
  group: (inputs) => {
    const drs = ["a", "b", "c", "d"]
      .map((k) => inputs[k])
      .filter((v): v is Extract<GraphValue, { kind: "sketch2d" }> => !!v && v.kind === "sketch2d")
      .map((v) => v.drawing);
    if (!drs.length) throw new Error("[group] connect at least one 2D profile");
    return { kind: "sketch2d", drawing: drs.reduce((acc, d) => acc.fuse(d)) };
  },

  /**
   * Hold-in-sheet micro-joints: place a part inside a surrounding frame and cut
   * a thin ring around it, EXCEPT at N tab bridges — so the laser-cut part stays
   * attached to the stock until you pop it out. Output is one connected profile.
   */
  tabs: (inputs, params) => {
    const part = expectSketch(inputs.in, "tabs");
    const margin = Math.max(1, Number(params.margin ?? 8));
    const kerf = Math.max(0.1, Number(params.kerf ?? 0.6));
    const tabCount = Math.max(1, Math.round(Number(params.tabs ?? 4)));
    const tabLen = Math.max(0.3, Number(params.tabLen ?? 3));
    const [lo, hi] = part.boundingBox.bounds;
    const frame = drawRectangle(hi[0] - lo[0] + 2 * margin, hi[1] - lo[1] + 2 * margin).translate((lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2);
    let ring = part.offset(kerf).cut(part); // thin annulus = the laser kerf path
    // punch a disc out of the ring at evenly-spaced outline points → tab bridges
    let poly: Vec2[] = [];
    for (const p of drawingPolylines(part)) if (p.length > poly.length) poly = p;
    if (poly.length >= 2) {
      const cum = [0];
      for (let i = 1; i < poly.length; i++) cum.push(cum[i - 1] + Math.hypot(poly[i][0] - poly[i - 1][0], poly[i][1] - poly[i - 1][1]));
      const total = cum[cum.length - 1] || 1;
      const r = kerf + tabLen / 2;
      for (let k = 0; k < tabCount; k++) {
        const s = (total * k) / tabCount;
        let i = 1; while (i < cum.length && cum[i] < s) i++;
        const a = poly[i - 1], b = poly[Math.min(poly.length - 1, i)];
        const seg = cum[i] - cum[i - 1] || 1, f = (s - cum[i - 1]) / seg;
        ring = ring.cut(drawCircle(r).translate(a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f));
      }
    }
    return { kind: "sketch2d", drawing: frame.cut(ring) };
  },
  /** SVG input: parse an SVG path `d` string into a 2D drawing. */
  svgInput: (_inputs, params) => {
    const d = String(params.d ?? "");
    if (!d.trim()) throw new Error("[svgInput] empty SVG path");
    return { kind: "sketch2d", drawing: svgPathToDrawing(d) };
  },

  /** Import a DXF file (LINE/ARC/CIRCLE/LWPOLYLINE) as a 2D profile. */
  importDXF: (_inputs, params) => {
    const src = params.dxf;
    if (typeof src !== "string" || !src.trim()) throw new Error("[importDXF] choose a .dxf file");
    return { kind: "sketch2d", drawing: importDXF(src) };
  },

  /**
   * Text → SVG → 2D profile. Converts a string to glyph outlines via
   * opentype.js, emits an SVG path `d`, then reuses the SVG parser (whose
   * multi-subpath/hole handling is exactly what letter counters need).
   * `params.font` is a .ttf/.otf ArrayBuffer.
   */
  textToSvg: (_inputs, params) => {
    return { kind: "sketch2d", drawing: buildTextDrawing(params, "textToSvg", 72) };
  },

  /** 2D offset (inflate / deflate a profile). OCCT BRepOffsetAPI under the hood. */
  offset2d: (inputs, params) => {
    const dr = expectSketch(inputs.in, "offset2d");
    const r = Number(params.distance ?? 0);
    return { kind: "sketch2d", drawing: r === 0 ? dr : dr.offset(r) };
  },
  /**
   * Relieve the inside corners of a pocket profile so a round router bit can
   * reach them (CNC). At every convex corner of the region, fuse a bit-radius
   * circle: "dogbone" places it on the diagonal, "tbone" along the longer wall.
   */
  dogbone: (inputs, params) => {
    const dr = expectSketch(inputs.in, "dogbone");
    const bitR = Math.max(0.1, Number(params.bitDia ?? 3) / 2);
    const tbone = String(params.style ?? "dogbone") === "tbone";
    const norm = (v: Vec2): Vec2 => { const l = Math.hypot(v[0], v[1]) || 1; return [v[0] / l, v[1] / l]; };
    let out = dr;
    for (const poly of drawingPolylines(dr)) {
      const n = poly.length;
      if (n < 3) continue;
      let area = 0;
      for (let i = 0; i < n; i++) { const a = poly[i], b = poly[(i + 1) % n]; area += a[0] * b[1] - b[0] * a[1]; }
      const ccw = area > 0;
      for (let i = 0; i < n; i++) {
        const a = poly[(i - 1 + n) % n], b = poly[i], c = poly[(i + 1) % n];
        const e1: Vec2 = [b[0] - a[0], b[1] - a[1]];
        const e2: Vec2 = [c[0] - b[0], c[1] - b[1]];
        const cross = e1[0] * e2[1] - e1[1] * e2[0];
        const convex = ccw ? cross > 0 : cross < 0; // corner where the bit leaves material
        if (!convex || Math.abs(cross) < 1e-6) continue;
        // outward direction = away from the region interior (opposite the bisector)
        const ba = norm([a[0] - b[0], a[1] - b[1]]), bc = norm([c[0] - b[0], c[1] - b[1]]);
        const outward = norm([-(ba[0] + bc[0]), -(ba[1] + bc[1])]);
        let cx: number, cy: number;
        if (tbone) {
          // extend along the longer adjacent wall (outward normal of that edge)
          const long = Math.hypot(e1[0], e1[1]) >= Math.hypot(e2[0], e2[1]) ? ba : bc;
          const dir = long[0] * outward[0] + long[1] * outward[1] >= 0 ? long : [-long[0], -long[1]] as Vec2;
          cx = b[0] + dir[0] * bitR; cy = b[1] + dir[1] * bitR;
        } else {
          cx = b[0] + outward[0] * bitR; cy = b[1] + outward[1] * bitR;
        }
        out = out.fuse(drawCircle(bitR).translate(cx, cy));
      }
    }
    return { kind: "sketch2d", drawing: out };
  },
  kerf: (inputs, params) => {
    // Laser kerf compensation: the beam removes ~kerf width of material, so an
    // outline must GROW by half the kerf, and a hole/pocket must SHRINK by it,
    // for the cut part to end up at nominal size.
    const dr = expectSketch(inputs.in, "kerf");
    const kerf = Number(params.kerf ?? 0.15);
    const outer = String(params.mode ?? "outer") === "outer";
    const d = (outer ? 1 : -1) * (kerf / 2);
    return { kind: "sketch2d", drawing: d === 0 ? dr : dr.offset(d) };
  },
  /** Round the corners of a 2D profile (great for laser-cut parts). */
  fillet2d: (inputs, params) => {
    const dr = expectSketch(inputs.in, "fillet2d");
    const r = Number(params.radius ?? 0);
    return { kind: "sketch2d", drawing: r > 0 ? dr.fillet(r) : dr };
  },
  /** Chamfer the corners of a 2D profile. */
  bevel2d: (inputs, params) => {
    const dr = expectSketch(inputs.in, "bevel2d");
    const d = Number(params.distance ?? 0);
    return { kind: "sketch2d", drawing: d > 0 ? dr.chamfer(d) : dr };
  },
};
