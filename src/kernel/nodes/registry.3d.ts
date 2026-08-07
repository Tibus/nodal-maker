/**
 * REGISTRY entries for all 3D nodes (3D Primitive + Sketch→Solid + 3D Op).
 */
import {
  type Shape3D,
  type EdgeFinder,
  FaceFinder,
  type Face,
  type Drawing,
  draw,
  drawCircle,
  makeBaseBox,
  makeCylinder,
  makeSphere,
  makeCompound,
} from "replicad";
import { marchingCubes } from "../marchingCubes";
import { booleanMesh } from "../manifold";
import {
  expectSketch,
  expectSolid,
  sketchPlane,
  sketchOffset,
  sketchFrame,
  placeSketch,
  buildTextDrawing,
  drawingPolylines,
  asMeshData,
  THREAD_STANDARDS,
  buildThreadBRep,
  buildNutBRep,
  cylinderFromFace,
  rebindEdge,
  rebindFace,
  importSTEPSync,
} from "./helpers";
import { solidToMeshData, meshAndTag, resolveTopCap } from "./payload";
import type { GraphValue, NodeImpl, Vec3 } from "./types";

/**
 * Build the edge-finder callback a fillet/bevel hands to replicad. When the
 * selection carries a pick reference (`nearest`), re-bind to the edge closest to
 * it on the CURRENT geometry — so the pick tracks that edge as parameters move
 * it, instead of matching a frozen coordinate. Otherwise use its static criteria.
 */
function edgeFinderFor(
  solid: Shape3D,
  sel: Extract<GraphValue, { kind: "selection" }>,
): (e: EdgeFinder) => EdgeFinder {
  if (sel.ref?.kind === "edge") {
    const edge = rebindEdge(solid, sel.ref);
    if (edge) return (e) => e.inList([edge]) as EdgeFinder;
  }
  return (e) => sel.apply(e) as EdgeFinder;
}

export const nodes3d: Record<string, NodeImpl> = {
  /* --- primitives 3D (sources) --- */
  box: (_inputs, params) => ({
    kind: "solid",
    solid: makeBaseBox(Number(params.x ?? 30), Number(params.y ?? 30), Number(params.z ?? 30)) as Shape3D,
  }),
  cylinder: (_inputs, params) => ({
    kind: "solid",
    solid: makeCylinder(Number(params.radius ?? 15), Number(params.height ?? 30)) as Shape3D,
  }),
  sphere: (_inputs, params) => ({
    kind: "solid",
    solid: makeSphere(Number(params.radius ?? 20)) as Shape3D,
  }),
  // Thread MODIFIER (Fusion-style): thread a cylinder. With an input solid/mesh,
  // the major diameter and length are read from its bounding box; a `standard`
  // preset (M3…M24) fills the pitch. Output is an analytic B-rep (STEP-exportable).
  thread: (inputs, params) => {
    const std = String(params.standard ?? "custom");
    const preset = THREAD_STANDARDS[std];
    let diameter = Number(params.diameter ?? 20);
    let length = Number(params.length ?? 30);
    const pitch = preset ? preset.pitch : Number(params.pitch ?? 2.5);

    // modifier mode: size from the incoming cylinder's bounds
    const src = inputs.in;
    if (src) {
      let lo: number[], hi: number[];
      if (src.kind === "solid") {
        [lo, hi] = src.solid.boundingBox.bounds;
      } else if (src.kind === "mesh") {
        lo = [Infinity, Infinity, Infinity]; hi = [-Infinity, -Infinity, -Infinity];
        const vs = src.mesh.vertices;
        for (let i = 0; i < vs.length; i += 3) for (let a = 0; a < 3; a++) {
          lo[a] = Math.min(lo[a], vs[i + a]); hi[a] = Math.max(hi[a], vs[i + a]);
        }
      } else {
        throw new Error("[thread] input must be a cylinder solid or mesh");
      }
      diameter = Math.max(hi[0] - lo[0], hi[1] - lo[1]);
      length = hi[2] - lo[2];
    } else if (preset) {
      diameter = preset.diameter; // standalone + preset → nominal Ø
    }

    const solid = buildThreadBRep(diameter, pitch, length, String(params.hand ?? "right") === "left");
    return { kind: "solid", solid };
  },
  // Internal thread / NUT: a central bore (SIMPLE, fast boolean) with inward
  // helical ridges added as a compound — analytic B-rep, no helical boolean.
  internalThread: (inputs, params) => {
    const body = expectSolid(inputs.in, "internalThread");
    const std = String(params.standard ?? "custom");
    const preset = THREAD_STANDARDS[std];
    const pitch = preset ? preset.pitch : Number(params.pitch ?? 2);
    const clearance = Number(params.clearance ?? 0.4);
    const lefthand = String(params.hand ?? "right") === "left";

    // Wire a cylindrical FACE SELECTION into `face` to thread that exact bore:
    // its axis, radius and length come from the picked B-rep face (its Ø
    // overrides the nominal). Multiple matching bores are all threaded.
    const sel = inputs.face;
    if (sel && sel.kind === "selection" && sel.target === "face") {
      // prefer the parametric re-bind (tracks the bore as the part changes);
      // fall back to the static finder criteria
      const faces: Face[] = [];
      if (sel.ref?.kind === "face") {
        const f = rebindFace(body, sel.ref);
        if (f) faces.push(f);
      } else {
        const ff = sel.apply(new FaceFinder()) as FaceFinder;
        faces.push(...(ff.find(body as Parameters<FaceFinder["find"]>[0]) as Face[]));
      }
      const bores = faces.map(cylinderFromFace).filter((c): c is NonNullable<typeof c> => c != null);
      if (!bores.length) throw new Error("[internalThread] the selected face is not a cylindrical bore");
      // Use the STANDARD (or custom) Ø, only borrowing the face's location/axis:
      // plug the existing hole and re-cut it at the nominal diameter there.
      const diameter = preset ? preset.diameter : Number(params.diameter ?? 16);
      let out = body;
      for (const b of bores) {
        out = buildNutBRep(out, diameter, pitch, clearance, lefthand, { center: b.center, axis: b.axis, length: b.length, fillRadius: b.radius + 0.15 });
      }
      return { kind: "solid", solid: out };
    }

    // No face wired → the original behaviour: a central bore on the world Z axis.
    const diameter = preset ? preset.diameter : Number(params.diameter ?? 16);
    return { kind: "solid", solid: buildNutBRep(body, diameter, pitch, clearance, lefthand) };
  },

  /**
   * A rotation/reference axis. Wire a body into `on` and a cylindrical Face
   * Select into `face` to derive the axis (origin + direction) from that bore/
   * boss; otherwise fall back to a world X/Y/Z through the `ox/oy/oz` origin.
   * Feeds Array Radial's `axis` input so a polar pattern can spin about an
   * arbitrary line.
   */
  axis: (inputs, params) => {
    const ax = String(params.dir ?? "Z");
    let dir: Vec3 = ax === "X" ? [1, 0, 0] : ax === "Y" ? [0, 1, 0] : [0, 0, 1];
    let origin: Vec3 = [Number(params.ox ?? 0), Number(params.oy ?? 0), Number(params.oz ?? 0)];

    const sel = inputs.face;
    const bodyV = inputs.on;
    if (sel && sel.kind === "selection" && sel.target === "face" && bodyV && bodyV.kind === "solid") {
      const body = bodyV.solid;
      const faces: Face[] = [];
      if (sel.ref?.kind === "face") {
        const f = rebindFace(body, sel.ref);
        if (f) faces.push(f);
      } else {
        const ff = sel.apply(new FaceFinder()) as FaceFinder;
        faces.push(...(ff.find(body as Parameters<FaceFinder["find"]>[0]) as Face[]));
      }
      const cyl = faces.map(cylinderFromFace).find((c): c is NonNullable<typeof c> => c != null);
      if (!cyl) throw new Error("[axis] the selected face is not cylindrical — pick a bore or a round boss");
      origin = cyl.center;
      dir = cyl.axis;
    }
    return { kind: "axis", origin, dir };
  },
  cone: (_inputs, params) => {
    const r = Number(params.radius ?? 15);
    const h = Number(params.height ?? 30);
    const profile = draw([0, 0]).lineTo([r, 0]).lineTo([0, h]).close();
    return { kind: "solid", solid: profile.sketchOnPlane("XZ").revolve() as Shape3D };
  },
  torus: (_inputs, params) => {
    const major = Number(params.radius ?? 25);
    const tube = Number(params.tube ?? 7);
    const profile = drawCircle(tube).translate(major, 0);
    return { kind: "solid", solid: profile.sketchOnPlane("XZ").revolve() as Shape3D };
  },
  revolve: (inputs, params) => {
    const dr = expectSketch(inputs.in, "revolve");
    const angle = Number(params.angle ?? 360);
    // revolve around Z; profile lives on XZ by default (a Sketch node can pick
    // another plane containing the axis)
    const plane = sketchPlane(inputs.in, "XZ");
    const solid = dr.sketchOnPlane(plane).revolve([0, 0, 1], { angle }) as Shape3D;
    return { kind: "solid", solid };
  },
  loft: (inputs, params) => {
    const bottom = expectSketch(inputs.bottom, "loft");
    const top = expectSketch(inputs.top, "loft");
    const h = Number(params.height ?? 30);
    const bs = bottom.sketchOnPlane("XY", 0) as unknown as {
      loftWith: (o: unknown) => Shape3D;
    };
    const solid = bs.loftWith(top.sketchOnPlane("XY", h)) as Shape3D;
    return { kind: "solid", solid };
  },
  loftSections: (inputs, params) => {
    // stack 2–4 profiles at evenly-spaced Z and loft through all of them
    const secs = ["s0", "s1", "s2", "s3"]
      .map((k) => inputs[k])
      .filter((v): v is Extract<GraphValue, { kind: "sketch2d" }> => !!v && v.kind === "sketch2d")
      .map((v) => v.drawing);
    if (secs.length < 2) throw new Error("[loftSections] connect at least two profiles (s0, s1, …)");
    const h = Number(params.height ?? 60);
    const n = secs.length;
    const base = secs[0].sketchOnPlane("XY", 0) as unknown as {
      loftWith: (o: unknown[]) => Shape3D;
    };
    const others = secs.slice(1).map((d, i) => d.sketchOnPlane("XY", (h * (i + 1)) / (n - 1)));
    const solid = base.loftWith(others) as Shape3D;
    return { kind: "solid", solid };
  },
  sweep: (inputs) => {
    // sweep a cross-section `profile` along a `path` spine (laid in the XZ plane
    // so the path rises in Z). replicad frames the profile perpendicular to the
    // spine at each step.
    const profile = expectSketch(inputs.profile, "sweep");
    const path = expectSketch(inputs.path, "sweep");
    const spine = path.sketchOnPlane("XZ") as unknown as {
      sweepSketch: (cb: (plane: unknown, origin: unknown) => unknown) => Shape3D;
    };
    const prof = profile as unknown as { sketchOnPlane: (p: unknown, o: unknown) => unknown };
    // call sketchOnPlane as a method so `this` stays bound to the profile
    const solid = spine.sweepSketch((plane, origin) => prof.sketchOnPlane(plane, origin)) as Shape3D;
    return { kind: "solid", solid };
  },

  /* --- ops 3D --- */
  boolean3d: (inputs, params) => {
    const a = expectSolid(inputs.base, "boolean3d");
    const b = expectSolid(inputs.tool, "boolean3d");
    const op = String(params.op ?? "union");
    const out = op === "difference" ? a.cut(b) : op === "intersection" ? a.intersect(b) : a.fuse(b);
    return { kind: "solid", solid: out as Shape3D };
  },
  /**
   * Arrange several solids on the build plate (FDM/resin) — shelf-pack them on
   * XY, wrapping rows at `bedWidth`, each dropped to rest on z=0. Output is one
   * compound you can export as a full plate. `copies` repeats each body.
   */
  arrange3d: (inputs, params) => {
    const items = ["s0", "s1", "s2", "s3", "s4", "s5"]
      .map((k) => inputs[k])
      .filter((v): v is Extract<GraphValue, { kind: "solid" }> => !!v && v.kind === "solid")
      .map((v) => v.solid);
    if (!items.length) throw new Error("[arrange3d] connect at least one solid (s0…)");
    const bedW = Math.max(10, Number(params.bedWidth ?? 200));
    const gap = Math.max(0, Number(params.gap ?? 4));
    const copies = Math.max(1, Math.round(Number(params.copies ?? 1)));
    const all: Shape3D[] = [];
    for (const s of items) for (let i = 0; i < copies; i++) all.push(s);
    const boxed = all.map((s) => { const [lo, hi] = s.boundingBox.bounds; return { s, lo, w: hi[0] - lo[0], d: hi[1] - lo[1] }; });
    boxed.sort((a, b) => b.d - a.d); // deepest first → tighter rows
    let cx = 0, cy = 0, rowD = 0;
    const placed: Shape3D[] = [];
    for (const it of boxed) {
      if (cx > 0 && cx + it.w > bedW) { cy += rowD + gap; cx = 0; rowD = 0; }
      placed.push(it.s.clone().translate([cx - it.lo[0], cy - it.lo[1], -it.lo[2]]) as Shape3D);
      cx += it.w + gap;
      rowD = Math.max(rowD, it.d);
    }
    return { kind: "solid", solid: makeCompound(placed) as unknown as Shape3D };
  },
  /** Tint a solid for display (distinguish bodies in an assembly). Pass-through geometry. */
  color: (inputs, params) => {
    const solid = expectSolid(inputs.in, "color");
    return { kind: "solid", solid, color: String(params.color ?? "#e0834a") };
  },
  /**
   * Interference check between two bodies: outputs the OVERLAP region (via a
   * robust Manifold intersection). Empty = no collision; otherwise its volume
   * (read it in the Props panel) tells you how much the parts clash.
   */
  collision: (inputs) => {
    const a = asMeshData(inputs.a, "collision");
    const b = asMeshData(inputs.b, "collision");
    return { kind: "mesh", mesh: booleanMesh(a, b, "intersection") };
  },
  /**
   * Repeat a solid along a 2D path (XY): copies are dropped at even arc-length
   * intervals and, unless orient="no", rotated about Z to follow the tangent.
   * Great for chain links, fence posts along a curve, teeth along a spline.
   */
  arrayPath: (inputs, params) => {
    const solid = expectSolid(inputs.in, "arrayPath");
    const path = expectSketch(inputs.path, "arrayPath");
    const count = Math.max(1, Math.round(Number(params.count ?? 5)));
    const orient = params.orient !== "no";
    // pick the longest sampled outline as the path spine
    const polys = drawingPolylines(path);
    if (!polys.length) throw new Error("[arrayPath] the path has no geometry");
    let pts = polys[0];
    for (const p of polys) if (p.length > pts.length) pts = p;
    const cum = [0];
    for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
    const total = cum[cum.length - 1] || 1;
    const at = (s: number): { x: number; y: number; ang: number } => {
      let i = 1;
      while (i < cum.length && cum[i] < s) i++;
      const a = pts[Math.max(0, i - 1)], b = pts[Math.min(pts.length - 1, i)];
      const seg = cum[i] - cum[i - 1] || 1;
      const f = (s - cum[i - 1]) / seg;
      return { x: a[0] + (b[0] - a[0]) * f, y: a[1] + (b[1] - a[1]) * f, ang: (Math.atan2(b[1] - a[1], b[0] - a[0]) * 180) / Math.PI };
    };
    const copies: Shape3D[] = [];
    for (let k = 0; k < count; k++) {
      const s = count === 1 ? 0 : (total * k) / (count - 1);
      const { x, y, ang } = at(s);
      let c = solid.clone() as Shape3D;
      if (orient) c = c.rotate(ang, [0, 0, 0], [0, 0, 1]) as Shape3D;
      copies.push(c.translate([x, y, 0]) as Shape3D);
    }
    const merge = params.merge !== "no";
    let out: Shape3D = copies[0];
    if (merge) for (let i = 1; i < copies.length; i++) out = out.fuse(copies[i]) as Shape3D;
    else out = makeCompound(copies) as unknown as Shape3D;
    return { kind: "solid", solid: out };
  },
  /** Assemble up to four solids into one COMPOUND — no boolean, so it works with
   * bodies that OCCT booleans choke on (e.g. a Thread). Great for a bolt = head +
   * thread. The bodies keep their own faces (B-rep) and STEP-export as one part. */
  assemble: (inputs) => {
    const parts = ["a", "b", "c", "d"]
      .map((k) => inputs[k])
      .filter((v): v is Extract<GraphValue, { kind: "solid" }> => !!v && v.kind === "solid")
      .map((v) => v.solid);
    if (parts.length === 0) throw new Error("[assemble] connect at least one solid");
    if (parts.length === 1) return { kind: "solid", solid: parts[0] };
    return { kind: "solid", solid: makeCompound(parts) as Shape3D };
  },
  mirror3d: (inputs, params) => {
    const solid = expectSolid(inputs.in, "mirror3d");
    const plane = String(params.plane ?? "YZ") as "XY" | "XZ" | "YZ";
    const mirrored = solid.clone().mirror(plane) as Shape3D;
    // "keep original" → a symmetric body (original ∪ its mirror)
    const out = params.keep === "yes" ? (solid.clone().fuse(mirrored) as Shape3D) : mirrored;
    return { kind: "solid", solid: out };
  },
  rotate3d: (inputs, params) => {
    const solid = expectSolid(inputs.in, "rotate3d");
    const angle = Number(params.angle ?? 0);
    const axis = String(params.axis ?? "Z");
    const dir: [number, number, number] = axis === "X" ? [1, 0, 0] : axis === "Y" ? [0, 1, 0] : [0, 0, 1];
    return { kind: "solid", solid: solid.clone().rotate(angle, [0, 0, 0], dir) as Shape3D };
  },
  scale3d: (inputs, params) => {
    const solid = expectSolid(inputs.in, "scale3d");
    const f = Number(params.factor ?? 1);
    return { kind: "solid", solid: solid.clone().scale(f) as Shape3D };
  },
  arrayLinear3d: (inputs, params) => {
    const solid = expectSolid(inputs.in, "arrayLinear3d");
    const count = Math.max(1, Math.round(Number(params.count ?? 3)));
    const dx = Number(params.dx ?? 40);
    const dy = Number(params.dy ?? 0);
    const dz = Number(params.dz ?? 0);
    let out: Shape3D = solid;
    for (let i = 1; i < count; i++) {
      out = out.fuse(solid.clone().translate(dx * i, dy * i, dz * i) as Shape3D) as Shape3D;
    }
    return { kind: "solid", solid: out };
  },
  arrayRadial3d: (inputs, params) => {
    const solid = expectSolid(inputs.in, "arrayRadial3d");
    const count = Math.max(1, Math.round(Number(params.count ?? 6)));
    const total = Number(params.angle ?? 360);
    // an Axis node wins over the X/Y/Z param: spin about its arbitrary line
    let origin: Vec3 = [0, 0, 0];
    let dir: Vec3;
    const axV = inputs.axis;
    if (axV && axV.kind === "axis") {
      origin = axV.origin;
      dir = axV.dir;
    } else {
      const ax = String(params.axis ?? "Z");
      dir = ax === "X" ? [1, 0, 0] : ax === "Y" ? [0, 1, 0] : [0, 0, 1];
    }
    const denom = Math.abs(total) >= 360 ? count : Math.max(1, count - 1);
    const copies: Shape3D[] = [solid];
    for (let i = 1; i < count; i++) {
      copies.push(solid.clone().rotate((total / denom) * i, origin, dir) as Shape3D);
    }
    // fuse into one body, or keep the copies as a (cheaper) compound
    const merge = params.merge !== "no";
    let out: Shape3D = copies[0];
    if (merge) for (let i = 1; i < copies.length; i++) out = out.fuse(copies[i]) as Shape3D;
    else out = makeCompound(copies) as unknown as Shape3D;
    return { kind: "solid", solid: out };
  },

  /**
   * Engrave or emboss text on a solid's face. The text is placed on a base
   * plane at an offset (x/y position it), extruded by `depth`, then cut into
   * (engrave) or fused onto (emboss) the body. `params.font` is a .ttf/.otf.
   */
  textOnFace: (inputs, params) => {
    const solid = expectSolid(inputs.in, "textOnFace");
    const depth = Math.max(0.1, Number(params.depth ?? 1));
    const plane = String(params.plane ?? "XY") as "XY" | "XZ" | "YZ";
    const off = Number(params.offset ?? 0);
    const x = Number(params.x ?? 0), y = Number(params.y ?? 0);
    const emboss = String(params.mode ?? "engrave") === "emboss";
    const dr = buildTextDrawing(params, "textOnFace", 10).translate(x, y);
    // engrave: stamp sits just below the surface (off-depth … off) then cut;
    // emboss: stamp rises from the surface (off … off+depth) then fuse.
    const base = emboss ? off : off - depth;
    const stamp = dr.sketchOnPlane(plane, base).extrude(depth) as Shape3D;
    return { kind: "solid", solid: (emboss ? solid.fuse(stamp) : solid.cut(stamp)) as Shape3D };
  },

  /** Extrude a 2D profile into a solid. */
  extrude: (inputs, params) => {
    const dr = expectSketch(inputs.in, "extrude");
    const h = Number(params.height ?? 1);
    const plane = sketchPlane(inputs.in);
    const off = sketchOffset(inputs.in);
    const mode = String(params.mode ?? "up");
    // up: [0,h]  ·  down: [-h,0]  ·  symmetric: [-h/2, h/2]  (+ plane offset)
    const base = (mode === "down" ? -h : mode === "symmetric" ? -h / 2 : 0) + off;
    // taper (endFactor: top scaled vs bottom — a draft) + twist
    const taper = Number(params.taper ?? 1);
    const twist = Number(params.twist ?? 0);
    const opts: { extrusionProfile?: { profile: "linear"; endFactor: number }; twistAngle?: number } = {};
    if (taper !== 1 && taper > 0) opts.extrusionProfile = { profile: "linear", endFactor: taper };
    if (twist !== 0) opts.twistAngle = twist;
    const frame = sketchFrame(inputs.in);
    const sk = placeSketch(dr, plane, base, frame) as unknown as { extrude: (d: number, o?: unknown) => Shape3D };
    const solid = sk.extrude(h, Object.keys(opts).length ? opts : undefined) as Shape3D;
    return { kind: "solid", solid };
  },

  /** Cut a pocket / hole into a solid by extruding a profile and subtracting it.
   * The perfect partner to "sketch on face": draw on a face → carve it out. */
  pocket: (inputs, params) => {
    const target = expectSolid(inputs.in, "pocket");
    const dr = expectSketch(inputs.profile, "pocket");
    const plane = sketchPlane(inputs.profile);
    const off = sketchOffset(inputs.profile);
    const depth = Math.max(0.01, Number(params.depth ?? 10));
    const through = String(params.mode ?? "blind") === "through";
    const dir = String(params.direction ?? "down");
    // span of the cutting tool along the plane normal, relative to `off`
    const d = through ? 1e4 : depth;
    const lo = dir === "up" ? off : off - d;   // "down"/"both" extend below the face
    const hi = dir === "down" ? off : off + d; // "up"/"both" extend above the face
    const tool = dr.sketchOnPlane(plane, lo).extrude(hi - lo) as Shape3D;
    const solid = target.cut(tool) as Shape3D;
    return { kind: "solid", solid };
  },

  /** Parametric hole (simple / counterbore / countersink), placed by (x,y) on a
   * base plane, cutting into a solid along the plane normal. */
  hole: (inputs, params) => {
    const target = expectSolid(inputs.in, "hole");
    const plane = String(params.plane ?? "XY") as "XY" | "XZ" | "YZ";
    const off = Number(params.offset ?? 0);
    const x = Number(params.x ?? 0), y = Number(params.y ?? 0);
    const dia = Math.max(0.1, Number(params.diameter ?? 6));
    const depth = Math.max(0.1, Number(params.depth ?? 20));
    const through = String(params.mode ?? "through") === "through";
    const type = String(params.type ?? "simple");
    const D = through ? 1e4 : depth;
    // main bore: circle extruded from the face (off) downward
    const at = (dr: Drawing) => dr.translate(x, y);
    let tool = at(drawCircle(dia / 2)).sketchOnPlane(plane, off - D).extrude(D) as Shape3D;
    if (type === "counterbore") {
      const cd = Math.max(dia, Number(params.headDia ?? dia * 2));
      const cdep = Math.max(0.1, Number(params.headDepth ?? 4));
      const cb = at(drawCircle(cd / 2)).sketchOnPlane(plane, off - cdep).extrude(cdep) as Shape3D;
      tool = tool.fuse(cb) as Shape3D;
    } else if (type === "countersink") {
      const cd = Math.max(dia, Number(params.headDia ?? dia * 2));
      const ang = Math.max(30, Math.min(179, Number(params.headAngle ?? 90)));
      const csDepth = ((cd - dia) / 2) / Math.tan((ang / 2) * (Math.PI / 180));
      // frustum: small circle (dia) at the countersink bottom → big circle (cd) at the face
      const bottom = at(drawCircle(dia / 2)).sketchOnPlane(plane, off - csDepth) as unknown as { loftWith: (o: unknown) => Shape3D };
      const topSk = at(drawCircle(cd / 2)).sketchOnPlane(plane, off);
      tool = tool.fuse(bottom.loftWith(topSk) as Shape3D) as Shape3D;
    }
    return { kind: "solid", solid: target.cut(tool) as Shape3D };
  },

  /** Round edges of a solid (congé). Optional `sel` targets specific edges. */
  fillet: (inputs, params) => {
    const solid = expectSolid(inputs.in, "fillet");
    const r = Number(params.radius ?? 0);
    if (r <= 0) return { kind: "solid", solid };
    // radius2 > 0 → variable-radius fillet: r at the edge start, radius2 at its
    // end (replicad accepts a [start, end] tuple as the radius).
    const r2 = Number(params.radius2 ?? 0);
    const rad: number | [number, number] = r2 > 0 && r2 !== r ? [r, r2] : r;
    const sel = inputs.sel;
    if (sel && sel.kind === "selection" && sel.target === "edge") {
      return { kind: "solid", solid: solid.fillet(rad, edgeFinderFor(solid, sel)) as Shape3D };
    }
    return { kind: "solid", solid: solid.fillet(rad) as Shape3D };
  },
  /** Chamfer (bevel) edges of a solid. Optional `sel` targets specific edges. */
  bevel: (inputs, params) => {
    const solid = expectSolid(inputs.in, "bevel");
    const d = Number(params.distance ?? 0);
    if (d <= 0) return { kind: "solid", solid };
    const sel = inputs.sel;
    if (sel && sel.kind === "selection" && sel.target === "edge") {
      return { kind: "solid", solid: solid.chamfer(d, edgeFinderFor(solid, sel)) as Shape3D };
    }
    return { kind: "solid", solid: solid.chamfer(d) as Shape3D };
  },
  /** Hollow a solid, opening the selected face(s). Requires a Face Select. */
  shell: (inputs, params) => {
    const solid = expectSolid(inputs.in, "shell");
    const t = Number(params.thickness ?? 2);
    const sel = inputs.faces;
    if (!sel || sel.kind !== "selection" || sel.target !== "face")
      throw new Error("[shell] connect a Face Select (which face(s) to open)");
    // parametric re-bind when the pick carries a signature, else static criteria
    const faceFn: (f: FaceFinder) => FaceFinder = sel.ref?.kind === "face"
      ? (() => { const bound = rebindFace(solid, sel.ref); return bound ? (f) => f.inList([bound]) as FaceFinder : (f) => sel.apply(f) as FaceFinder; })()
      : (f) => sel.apply(f) as FaceFinder;
    return { kind: "solid", solid: solid.shell(t, faceFn) as Shape3D };
  },
  /**
   * Resin hollowing: turn a solid into a CLOSED thin-walled shell (empty face
   * finder → no opening) and drill N vertical drain holes up through the bottom
   * wall so uncured resin can escape (avoids the suction/blowout of a sealed
   * cavity). Wall + drain diameter are the two knobs that matter for resin.
   */
  hollow: (inputs, params) => {
    const solid = expectSolid(inputs.in, "hollow");
    const wall = Math.abs(Number(params.wall ?? 2));
    const drainDia = Number(params.drainDia ?? 3);
    const drainCount = Math.max(0, Math.round(Number(params.drainCount ?? 2)));
    // closed hollow: shell inward, opening no face (finder matches nothing)
    let out = solid.clone().shell(-wall, (f) => f.inPlane("XY", 1e9)) as Shape3D;
    if (drainDia > 0 && drainCount > 0) {
      const [lo, hi] = solid.boundingBox.bounds;
      const cx = (lo[0] + hi[0]) / 2, cy = (lo[1] + hi[1]) / 2, zmin = lo[2];
      const spread = Math.min(hi[0] - lo[0], hi[1] - lo[1]) * 0.25;
      for (let i = 0; i < drainCount; i++) {
        const ang = (2 * Math.PI * i) / drainCount;
        const px = drainCount === 1 ? cx : cx + Math.cos(ang) * spread;
        const py = drainCount === 1 ? cy : cy + Math.sin(ang) * spread;
        // pierce from just below the bottom, up through the wall into the cavity
        const cyl = makeCylinder(drainDia / 2, wall * 3, [px, py, zmin - wall], [0, 0, 1]) as Shape3D;
        out = out.cut(cyl) as Shape3D;
      }
    }
    return { kind: "solid", solid: out };
  },
  /**
   * Fill a solid with a lightweight internal grid lattice + a closed outer
   * shell (resin/FDM strength without the weight). Walls run in X and Y on a
   * `cell` pitch, clipped to the shape; combined with a `wall`-thick shell.
   */
  infill: (inputs, params) => {
    const solid = expectSolid(inputs.in, "infill");
    const wall = Math.max(0.3, Number(params.wall ?? 1.5));
    const cell = Math.max(2, Number(params.cell ?? 10));
    const [lo, hi] = solid.boundingBox.bounds;
    const sx = hi[0] - lo[0], sy = hi[1] - lo[1], sz = hi[2] - lo[2];
    const cxm = (lo[0] + hi[0]) / 2, cym = (lo[1] + hi[1]) / 2, z0 = lo[2];
    const walls: Shape3D[] = [];
    const CAP = 60; // guard against a runaway wall count
    for (let x = lo[0] + cell; x < hi[0] && walls.length < CAP; x += cell)
      walls.push((makeBaseBox(wall, sy, sz) as Shape3D).translate([x, cym, z0]) as Shape3D);
    for (let y = lo[1] + cell; y < hi[1] && walls.length < CAP; y += cell)
      walls.push((makeBaseBox(sx, wall, sz) as Shape3D).translate([cxm, y, z0]) as Shape3D);
    // closed thin shell (walls only, no opening)
    const shell = solid.clone().shell(-wall, (f) => f.inPlane("XY", 1e9)) as Shape3D;
    if (!walls.length) return { kind: "solid", solid: shell };
    let lattice = walls[0];
    for (let i = 1; i < walls.length; i++) lattice = lattice.fuse(walls[i]) as Shape3D;
    const inner = solid.clone().intersect(lattice) as Shape3D; // clip lattice to the shape
    return { kind: "solid", solid: shell.fuse(inner) as Shape3D };
  },
  /**
   * Gyroid infill (a triply-periodic minimal surface). Marches the closed
   * region { |gyroid| < iso } ∩ bbox and intersects it with the shape. Outputs
   * the clipped gyroid walls (a clean, watertight mesh) — union your own shell
   * around it via a mesh Boolean if you want an outer skin.
   */
  gyroid: (inputs, params) => {
    const solid = expectSolid(inputs.in, "gyroid");
    const period = Math.max(3, Number(params.period ?? 12));
    const wall = Math.max(0.3, Number(params.wall ?? 1.2));
    const res = Math.max(16, Math.min(96, Math.round(Number(params.res ?? 56))));
    const [lo, hi] = solid.boundingBox.bounds;
    const f = (2 * Math.PI) / period;
    const iso = Math.min(1.4, wall * f * 0.5); // period→wall-thickness mapping
    const bd = (x: number, y: number, z: number) => Math.min(x - lo[0], hi[0] - x, y - lo[1], hi[1] - y, z - lo[2], hi[2] - z);
    // walls = { |gyroid| < iso } ∩ bbox. MC treats field<0 as the solid interior,
    // so negate: solid where |g|<iso AND inside the box.
    const field = (x: number, y: number, z: number) => {
      const g = Math.sin(f * x) * Math.cos(f * y) + Math.sin(f * y) * Math.cos(f * z) + Math.sin(f * z) * Math.cos(f * x);
      return -Math.min(iso - Math.abs(g), bd(x, y, z));
    };
    const m = 1.0; // sample a touch beyond the bbox so the box faces close cleanly
    const gy = marchingCubes(field, [lo[0] - m, lo[1] - m, lo[2] - m], [hi[0] + m, hi[1] + m, hi[2] + m], res);
    // clip the gyroid walls to the shape. Union a closed shell around them with
    // a mesh Boolean node if you want an outer skin (Gyroid → Boolean(union)).
    return { kind: "mesh", mesh: booleanMesh(gy, solidToMeshData(solid), "intersection") };
  },
  /**
   * Split a solid by an axis-aligned plane (for parts too big for the build
   * plate). Keep the positive/negative side, or both halves as a compound
   * pushed apart by `gap` so the cut is visible.
   */
  split: (inputs, params) => {
    const solid = expectSolid(inputs.in, "split");
    const axis = String(params.axis ?? "Z");
    const off = Number(params.offset ?? 0);
    const keep = String(params.keep ?? "positive");
    const gap = Number(params.gap ?? 0);
    const [lo, hi] = solid.boundingBox.bounds;
    const ai = axis === "X" ? 0 : axis === "Y" ? 1 : 2;
    const dir: Vec3 = ai === 0 ? [1, 0, 0] : ai === 1 ? [0, 1, 0] : [0, 0, 1];
    const half = (positive: boolean): Shape3D => {
      const pad = 10;
      const r: [number, number][] = [[lo[0] - pad, hi[0] + pad], [lo[1] - pad, hi[1] + pad], [lo[2] - pad, hi[2] + pad]];
      if (positive) r[ai][0] = off; else r[ai][1] = off;
      const w = r[0][1] - r[0][0], d = r[1][1] - r[1][0], h = r[2][1] - r[2][0];
      const cutter = (makeBaseBox(w, d, h) as Shape3D).translate([(r[0][0] + r[0][1]) / 2, (r[1][0] + r[1][1]) / 2, r[2][0]]) as Shape3D;
      return solid.clone().intersect(cutter) as Shape3D;
    };
    if (keep === "both") {
      const pos = gap ? (half(true).translate(dir.map((c) => c * gap) as Vec3) as Shape3D) : half(true);
      const neg = half(false);
      return { kind: "solid", solid: makeCompound([pos, neg]) as unknown as Shape3D };
    }
    return { kind: "solid", solid: half(keep === "positive") };
  },

  /** Translate a solid. tx/ty/tz are editable in 3D via the viewport gizmo. */
  transform: (inputs, params) => {
    const solid = expectSolid(inputs.in, "transform");
    const tx = Number(params.tx ?? 0);
    const ty = Number(params.ty ?? 0);
    const tz = Number(params.tz ?? 0);
    if (tx === 0 && ty === 0 && tz === 0) return { kind: "solid", solid };
    // clone first: replicad's translate mutates/consumes the shape, and this
    // node's output may feed several consumers (the eval cache shares one object)
    return { kind: "solid", solid: solid.clone().translate(tx, ty, tz) as Shape3D };
  },

  /**
   * THE SPIKE — "extrude on the result of an extrude, taking the cap".
   *
   * We do NOT reference the top face by a stored index. We store a *query*
   * ("the top planar cap") and re-resolve it against whatever geometry the
   * upstream nodes produced this time. That is the answer to the topological
   * naming problem: identifiers are unstable, criteria-based selectors survive
   * regeneration.
   */
  bossOnCap: (inputs, params) => {
    const base = expectSolid(inputs.in, "bossOnCap");
    const bossHeight = Number(params.height ?? 2);
    const shrink = Number(params.shrink ?? 3); // inward offset for the boss profile

    const cap = resolveTopCap(base); // <-- the re-resolved selector, not a stored id

    // Build the boss profile by insetting the base outline, placed on the cap.
    const baseSketch = expectSketch(inputs.profile, "bossOnCap");
    const bossDrawing = baseSketch.offset(-Math.abs(shrink));
    const solid = base.fuse(
      bossDrawing.sketchOnPlane("XY", cap.z).extrude(bossHeight) as Shape3D,
    ) as Shape3D;
    return { kind: "solid", solid };
  },

  /**
   * Auto-orient for printing: consider the six axis-aligned "face-down" directions
   * PLUS the outward normals of the model's largest FLAT faces (so a tilted part
   * can rest on its real flat face, not just an axis). Score each candidate by
   * (overhang area + heightWeight·height) and keep the lowest — fewer supports,
   * shorter print. The winner is dropped onto the plate (z=0).
   */
  autoOrient: (inputs, params) => {
    const solid = expectSolid(inputs.in, "autoOrient");
    const hw = Number(params.heightWeight ?? 1);
    const cosT = Math.cos((45 * Math.PI) / 180);

    // candidate "down" directions = the outward normal that should face the plate
    const cand: Vec3[] = [[0, 0, 1], [0, 0, -1], [1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0]];
    // add the biggest flat faces' normals (accumulate triangle area per normal)
    {
      const m = meshAndTag(solid), V = m.vertices, T = m.indices;
      const acc = new Map<string, { n: Vec3; area: number }>();
      for (let i = 0; i < T.length; i += 3) {
        const a = T[i] * 3, b = T[i + 1] * 3, c = T[i + 2] * 3;
        const ux = V[b] - V[a], uy = V[b + 1] - V[a + 1], uz = V[b + 2] - V[a + 2];
        const vx = V[c] - V[a], vy = V[c + 1] - V[a + 1], vz = V[c + 2] - V[a + 2];
        let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
        const twice = Math.hypot(nx, ny, nz); if (twice < 1e-9) continue;
        nx /= twice; ny /= twice; nz /= twice;
        const key = `${Math.round(nx * 12)}_${Math.round(ny * 12)}_${Math.round(nz * 12)}`; // ~5° bins
        const e = acc.get(key); if (e) e.area += twice / 2; else acc.set(key, { n: [nx, ny, nz], area: twice / 2 });
      }
      for (const { n } of [...acc.values()].sort((p, q) => q.area - p.area).slice(0, 8)) {
        if (!cand.some((d) => d[0] * n[0] + d[1] * n[1] + d[2] * n[2] > 0.996)) cand.push(n);
      }
    }

    let best: { s: Shape3D; score: number } | null = null;
    for (const d of cand) {
      // rotate so `d` points to -Z (that face rests on the plate)
      let s = solid.clone() as Shape3D;
      const dot = Math.max(-1, Math.min(1, -d[2]));
      if (dot < 0.9999) {
        if (dot < -0.9999) s = s.rotate(180, [0, 0, 0], [1, 0, 0]) as Shape3D;
        else { const al = Math.hypot(d[1], d[0]) || 1; s = s.rotate((Math.acos(dot) * 180) / Math.PI, [0, 0, 0], [-d[1] / al, d[0] / al, 0]) as Shape3D; }
      }
      const [lo, hi] = s.boundingBox.bounds;
      s = s.translate([0, 0, -lo[2]]) as Shape3D; // rest on the plate
      const m = meshAndTag(s), V = m.vertices, T = m.indices;
      let area = 0;
      for (let i = 0; i < T.length; i += 3) {
        const a = T[i] * 3, b = T[i + 1] * 3, c = T[i + 2] * 3;
        const ux = V[b] - V[a], uy = V[b + 1] - V[a + 1], uz = V[b + 2] - V[a + 2];
        const vx = V[c] - V[a], vy = V[c + 1] - V[a + 1], vz = V[c + 2] - V[a + 2];
        const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
        const twice = Math.hypot(nx, ny, nz) || 1;
        if (-nz / twice > cosT && (V[a + 2] + V[b + 2] + V[c + 2]) / 3 > 0.2) area += twice / 2;
      }
      const score = area + hw * (hi[2] - lo[2]);
      if (!best || score < best.score) best = { s, score };
    }
    return { kind: "solid", solid: best!.s };
  },
  /**
   * Auto-generate print supports: mesh the solid, find down-facing overhang
   * triangles steeper than `angle` (and above the plate), snap their centroids
   * to a `spacing` grid and drop a thin pillar from each to z=0. Output the
   * model + pillars, or the pillars alone. A pragmatic first-pass support forest.
   */
  supports: (inputs, params) => {
    const solid = expectSolid(inputs.in, "supports");
    const angle = Number(params.angle ?? 45);
    const spacing = Math.max(0.5, Number(params.spacing ?? 5));
    const dia = Math.max(0.2, Number(params.pillarDia ?? 1.2));
    const cosT = Math.cos((angle * Math.PI) / 180);
    const m = meshAndTag(solid);
    const V = m.vertices, T = m.indices;
    const z0 = 0; // resin build plate — pillars always anchor to z=0
    const eps = 0.2;
    // grid cell → lowest overhang point in that cell (one pillar per cell)
    const cells = new Map<string, [number, number, number]>();
    for (let i = 0; i < T.length; i += 3) {
      const a = T[i] * 3, b = T[i + 1] * 3, c = T[i + 2] * 3;
      const ux = V[b] - V[a], uy = V[b + 1] - V[a + 1], uz = V[b + 2] - V[a + 2];
      const vx = V[c] - V[a], vy = V[c + 1] - V[a + 1], vz = V[c + 2] - V[a + 2];
      let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      const nl = Math.hypot(nx, ny, nz) || 1; nx /= nl; ny /= nl; nz /= nl;
      if (-nz <= cosT) continue; // not a down-facing overhang
      const cx = (V[a] + V[b] + V[c]) / 3, cy = (V[a + 1] + V[b + 1] + V[c + 1]) / 3, cz = (V[a + 2] + V[b + 2] + V[c + 2]) / 3;
      if (cz <= z0 + eps) continue; // already on the plate
      const key = `${Math.round(cx / spacing)},${Math.round(cy / spacing)}`;
      const prev = cells.get(key);
      if (!prev || cz < prev[2]) cells.set(key, [cx, cy, cz]);
    }
    const pillars: Shape3D[] = [];
    for (const [px, py, pz] of cells.values()) {
      if (pillars.length >= 2000) break; // runaway guard
      const h = pz - z0;
      if (h <= eps) continue;
      pillars.push(makeCylinder(dia / 2, h, [px, py, z0], [0, 0, 1]) as Shape3D);
    }
    const only = params.output === "supports";
    const parts = only ? pillars : [solid, ...pillars];
    if (!parts.length) return { kind: "solid", solid };
    return { kind: "solid", solid: makeCompound(parts) as unknown as Shape3D };
  },

  /** Import a STEP file (also what Fusion 360 / SolidWorks export) as a B-rep
   * solid — editable, unlike an STL mesh. */
  importSTEP: (_inputs, params) => {
    const raw = params.step;
    let buf: ArrayBuffer;
    if (raw instanceof ArrayBuffer) buf = raw;
    else if (raw instanceof Uint8Array)
      buf = raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength) as ArrayBuffer;
    else throw new Error("[importSTEP] params.step must be an ArrayBuffer (choose a .step/.stp file)");
    return { kind: "solid", solid: importSTEPSync(buf) };
  },
};
