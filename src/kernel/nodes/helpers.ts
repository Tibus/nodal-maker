/**
 * Shared node-implementation helpers: input coercion, sketch placement, 2D
 * drawing utilities, finger-joint panels, analytic thread B-reps, and the
 * synchronous STEP/STL bridges.
 */
import {
  Drawing,
  Blueprints,
  type Shape3D,
  draw,
  makeCylinder,
  makeHelix,
  makeLine,
  assembleWire,
  makeCompound,
  getOC,
  cast,
  Plane as RPlane,
  type Face,
} from "replicad";
import * as opentype from "opentype.js";
import { svgPathToDrawing } from "../svgPath";
import { writeBinarySTL } from "../stl";
import type { MeshData } from "../manifold";
import { solidToMeshData } from "./payload";
import type { EdgeSpec, GraphValue, RPt, SketchFrame, Vec2 } from "./types";

export function expectSketch(v: GraphValue | undefined, node: string): Drawing {
  if (!v || v.kind !== "sketch2d")
    throw new Error(`[${node}] expected a sketch2d input, got ${v?.kind ?? "nothing"}`);
  return v.drawing;
}

/** The base plane a sketch2d input was drawn on (defaults to `def`, XY). */
export function sketchPlane(v: GraphValue | undefined, def: "XY" | "XZ" | "YZ" = "XY"): "XY" | "XZ" | "YZ" {
  return v && v.kind === "sketch2d" && v.plane ? v.plane : def;
}
/** Offset of that plane along its normal (for a sketch placed on a face). */
export function sketchOffset(v: GraphValue | undefined): number {
  return v && v.kind === "sketch2d" && v.planeOffset ? v.planeOffset : 0;
}
/** Arbitrary (non-axis-aligned) placement frame, if the sketch carries one. */
export function sketchFrame(v: GraphValue | undefined): SketchFrame | undefined {
  return v && v.kind === "sketch2d" ? v.frame : undefined;
}

/**
 * Lay a 2D drawing onto its target plane and return a Sketch ready to extrude.
 * When `frame` is present we build a replicad Plane from it (tilted faces);
 * otherwise we use the axis-aligned base plane + offset.
 */
export function placeSketch(dr: Drawing, plane: "XY" | "XZ" | "YZ", offset: number, frame?: SketchFrame) {
  if (frame) {
    const pl = new RPlane(frame.origin, frame.xDir, frame.normal);
    return dr.sketchOnPlane(pl);
  }
  return dr.sketchOnPlane(plane, offset);
}

/** Lay a sketch2d GraphValue on its plane/frame — shared by preview + export. */
export function placeSketchValue(v: Extract<GraphValue, { kind: "sketch2d" }>) {
  return placeSketch(v.drawing, v.plane ?? "XY", v.planeOffset ?? 0, v.frame);
}

export function expectSolid(v: GraphValue | undefined, node: string): Shape3D {
  if (!v || v.kind !== "solid")
    throw new Error(`[${node}] expected a solid input, got ${v?.kind ?? "nothing"}`);
  return v.solid;
}

/**
 * Split a drawing into its disjoint regions (a `Blueprints`), so 2D booleans can
 * be applied one region at a time — replicad's cut/fuse misbehaves with a
 * multi-region tool. A single region (Blueprint) or a region-with-holes
 * (CompoundBlueprint) is returned as-is (one drawing).
 */
export function drawingRegions(d: Drawing): Drawing[] {
  const inner = (d as unknown as { innerShape?: unknown }).innerShape;
  if (inner instanceof Blueprints) {
    return inner.blueprints.map((bp) => new Drawing(bp));
  }
  return [d];
}

/**
 * Merge several disjoint drawings into ONE compound Drawing WITHOUT a boolean.
 * replicad's `fuse` of disjoint regions is slow and occasionally wrong; here we
 * just collect every underlying Blueprint and wrap them in a single Blueprints
 * compound — exactly the inverse of `drawingRegions`.
 */
export function combineDrawings(drawings: Drawing[]): Drawing {
  const bps = drawings.flatMap((d) => {
    const inner = (d as unknown as { innerShape?: unknown }).innerShape;
    if (inner instanceof Blueprints) return inner.blueprints;
    return inner ? [inner as never] : [];
  });
  if (bps.length === 1) return new Drawing(bps[0]);
  return new Drawing(new Blueprints(bps) as never);
}

/** Build a closed drawing from a point loop, dropping coincident points so no
 * zero-length edge reaches OCCT (which aborts on them). `close()` re-adds the
 * segment back to the first point, so a trailing duplicate of the start is
 * removed too. */
export function polyDrawing(pts: Vec2[]): Drawing {
  const eps = 1e-6;
  const clean: Vec2[] = [];
  for (const p of pts) {
    const last = clean[clean.length - 1];
    if (!last || Math.hypot(p[0] - last[0], p[1] - last[1]) > eps) clean.push(p);
  }
  if (clean.length > 1) {
    const a = clean[0];
    const b = clean[clean.length - 1];
    if (Math.hypot(a[0] - b[0], a[1] - b[1]) <= eps) clean.pop();
  }
  let pen = draw(clean[0]);
  for (let i = 1; i < clean.length; i++) pen = pen.lineTo(clean[i]);
  return pen.close();
}

/**
 * Walk one straight box-joint edge and return its points (the start corner is
 * assumed already emitted). Tabs bulge OUTWARD (along `nrm`) by the material
 * thickness; slots stay on the nominal line. An ODD finger count makes two
 * mating edges (one `tabFirst`, one not) interlock automatically, because they
 * are traversed from opposite corners.
 */
export function fingerEdge(
  p0: Vec2,
  u: Vec2,
  nrm: Vec2,
  length: number,
  finger: number,
  thickness: number,
  tabFirst: boolean,
): Vec2[] {
  const n = Math.max(3, 2 * Math.floor(length / (2 * Math.max(0.5, finger))) + 1);
  const f = length / n;
  const at = (d: number, out: number): Vec2 => [
    p0[0] + u[0] * d + nrm[0] * out,
    p0[1] + u[1] * d + nrm[1] * out,
  ];
  const pts: Vec2[] = [];
  let cur = 0;
  for (let k = 0; k < n; k++) {
    const isTab = (k % 2 === 0) === tabFirst;
    const target = isTab ? thickness : 0;
    if (target !== cur) {
      pts.push(at(k * f, target)); // vertical riser to the new line
      cur = target;
    }
    pts.push(at((k + 1) * f, cur)); // run along this segment
  }
  if (cur !== 0) pts.push(at(length, 0)); // drop back to nominal at the end corner
  return pts;
}

/**
 * A rectangular panel (w × d) whose four edges are each flat or fingered.
 * Edges are given bottom, right, top, left (CCW from the bottom-left corner).
 * A fingered edge with `tabFirst:true` starts with a protruding tab.
 */
export function fingerPanel(
  w: number,
  d: number,
  thickness: number,
  finger: number,
  edges: [EdgeSpec, EdgeSpec, EdgeSpec, EdgeSpec],
): Drawing {
  const c: Vec2[] = [[0, 0], [w, 0], [w, d], [0, d]]; // bottom-left → CCW
  const dirs: Vec2[] = [[1, 0], [0, 1], [-1, 0], [0, -1]];
  const nrms: Vec2[] = [[0, -1], [1, 0], [0, 1], [-1, 0]]; // outward = right of direction
  const lens = [w, d, w, d];
  const pts: Vec2[] = [c[0]];
  for (let e = 0; e < 4; e++) {
    const spec = edges[e];
    if (spec.finger) pts.push(...fingerEdge(c[e], dirs[e], nrms[e], lens[e], finger, thickness, spec.tabFirst));
    else pts.push(c[(e + 1) % 4]);
  }
  return polyDrawing(pts);
}

/** ISO metric coarse pitches (mm) keyed by nominal diameter designation. */
export const THREAD_STANDARDS: Record<string, { diameter: number; pitch: number }> = {
  M2: { diameter: 2, pitch: 0.4 },
  "M2.5": { diameter: 2.5, pitch: 0.45 },
  M3: { diameter: 3, pitch: 0.5 },
  M4: { diameter: 4, pitch: 0.7 },
  M5: { diameter: 5, pitch: 0.8 },
  M6: { diameter: 6, pitch: 1.0 },
  M8: { diameter: 8, pitch: 1.25 },
  M10: { diameter: 10, pitch: 1.5 },
  M12: { diameter: 12, pitch: 1.75 },
  M14: { diameter: 14, pitch: 2.0 },
  M16: { diameter: 16, pitch: 2.0 },
  M20: { diameter: 20, pitch: 2.5 },
  M24: { diameter: 24, pitch: 3.0 },
};

/**
 * Sweep a truncated-V thread ridge as an analytic B-rep solid, along a helix at
 * `spineRadius`. `profile` is a closed loop of (radius, dz-from-turn-centre)
 * points; its edge that sits on `spineRadius` must be present or the OCCT pipe
 * (Frenet frame → radial principal normal → CONSTANT radius) drifts. Handedness
 * via `lefthand`. `zBase` places the ridge's start; it spans [zBase, zBase+L].
 */
function sweepHelicalRidge(
  spineRadius: number, profile: RPt[], pitch: number, length: number, lefthand: boolean, zBase = 0,
): Shape3D {
  const p = Math.max(0.2, pitch);
  const L = Math.max(p, length);
  const oc = getOC() as unknown as {
    BRepOffsetAPI_MakePipeShell: new (spine: unknown) => {
      SetMode_1: (frenet: boolean) => void;
      Add_1: (profile: unknown, contact: boolean, correction: boolean) => void;
      Build: (r: unknown) => void;
      MakeSolid: () => boolean;
      Shape: () => unknown;
    };
    Message_ProgressRange_1: new () => unknown;
  };
  // sweep [z0, z0+hH] with the profile centred on the start → ridge spans exactly
  // [zBase, zBase+L] (no ±½-pitch axial overshoot). helix & profile share z0.
  const z0 = zBase + (L > 2 * p ? p / 2 : 0);
  const hH = L > 2 * p ? L - p : L;
  const helix = (makeHelix(p, hH, spineRadius, [0, 0, z0], [0, 0, 1], lefthand) as unknown as { wrapped: unknown }).wrapped;
  const at = (i: number) => [profile[i][0], 0, z0 + profile[i][1]] as [number, number, number];
  const edges = profile.map((_, i) => makeLine(at(i), at((i + 1) % profile.length)));
  const wire = (assembleWire(edges as never) as unknown as { wrapped: unknown }).wrapped;
  const pipe = new oc.BRepOffsetAPI_MakePipeShell(helix);
  pipe.SetMode_1(true); // Frenet
  pipe.Add_1(wire, false, false);
  pipe.Build(new oc.Message_ProgressRange_1());
  pipe.MakeSolid();
  return cast(pipe.Shape() as Parameters<typeof cast>[0]) as Shape3D;
}

/**
 * Analytic B-rep threaded ROD (external ISO V-thread). A helical ridge sweep
 * fused with a core cylinder as a COMPOUND — no boolean, because OCCT boolean
 * ops on helical faces hang in this WASM build. Genuine non-faceted B-rep:
 * renders cleanly and exports to STEP.
 */
export function buildThreadBRep(diameter: number, pitch: number, length: number, lefthand: boolean): Shape3D {
  const p = Math.max(0.2, pitch);
  const depth = p * 0.613; // ISO truncated thread height ≈ 0.6134·p
  const rMaj = Math.max(0.3, diameter / 2);
  const rMin = Math.max(0.15, rMaj - depth);
  const flat = p / 8;
  const profile: RPt[] = [[rMin, -p / 2], [rMaj, -flat], [rMaj, flat], [rMin, p / 2]];
  const ridge = sweepHelicalRidge(rMin, profile, p, length, lefthand);
  const core = makeCylinder(rMin + 0.15, Math.max(p, length)) as Shape3D; // hides root overlap
  return makeCompound([core, ridge]) as Shape3D;
}

/**
 * Analytic B-rep NUT (internal thread) cut into a solid body. A plain cylindrical
 * bore is removed with a SIMPLE (non-helical → fast) boolean, then inward-pointing
 * helical ridges are added as a COMPOUND — so no helical boolean is ever needed.
 * Genuine B-rep, STEP-exportable. `zBase`/`H` come from the body's bounds.
 */
export function buildNutBRep(
  body: Shape3D, diameter: number, pitch: number, clearance: number, lefthand: boolean,
  /** Optional placement from a picked cylindrical face: a base point on the bore
   *  axis (its low end), the axis direction, and the threaded length. Without it
   *  the bore sits on the world Z axis at the origin, spanning the body's height. */
  place?: { center: [number, number, number]; axis: [number, number, number]; length: number },
): Shape3D {
  const p = Math.max(0.2, pitch);
  const depth = p * 0.613;
  const rBore = Math.max(0.5, diameter / 2); // internal root = nominal major radius
  const rCrest = Math.max(0.3, rBore - depth + clearance); // teeth tips, toward the axis
  const rOuter = rBore + 0.15; // ridge root overlaps the surrounding material
  const flat = p / 8;
  const profile: RPt[] = [[rOuter, -p / 2], [rCrest, -flat], [rCrest, flat], [rOuter, p / 2]];
  const [lo, hi] = body.boundingBox.bounds;

  if (!place) {
    // world Z axis, origin, full body height (original behaviour)
    const H = hi[2] - lo[2];
    const bore = (makeCylinder(rBore, H + 4) as Shape3D).clone().translate(0, 0, lo[2] - 2) as Shape3D;
    const bodyWithHole = body.cut(bore) as Shape3D; // simple boolean — no helix, fast
    const ridge = sweepHelicalRidge(rOuter, profile, p, H, lefthand, lo[2]);
    return makeCompound([bodyWithHole, ridge]) as Shape3D;
  }

  // placed bore: build the bore + ridge in a local Z frame, then rotate the Z
  // axis onto the picked axis and translate its base to the picked point.
  const L = Math.max(p, place.length);
  const a = place.axis;
  const al = Math.hypot(a[0], a[1], a[2]) || 1;
  const A: [number, number, number] = [a[0] / al, a[1] / al, a[2] / al];
  const orient = (s: Shape3D): Shape3D => {
    const dot = Math.max(-1, Math.min(1, A[2])); // Z·A
    let r = s;
    if (dot < 0.9999) {
      if (dot < -0.9999) r = s.rotate(180, [0, 0, 0], [1, 0, 0]) as Shape3D; // A = -Z
      else {
        const axL = Math.hypot(A[1], A[0]) || 1; // Z×A = (-Ay, Ax, 0)
        r = s.rotate((Math.acos(dot) * 180) / Math.PI, [0, 0, 0], [-A[1] / axL, A[0] / axL, 0]) as Shape3D;
      }
    }
    return r.translate(place.center) as Shape3D;
  };
  const boreLocal = (makeCylinder(rBore, L + 4) as Shape3D).clone().translate(0, 0, -2) as Shape3D;
  const bodyWithHole = body.cut(orient(boreLocal)) as Shape3D;
  const ridge = orient(sweepHelicalRidge(rOuter, profile, p, L, lefthand, 0));
  return makeCompound([bodyWithHole, ridge]) as Shape3D;
}

/**
 * Read a cylindrical B-rep face's geometry (so an Internal Thread can be placed
 * on it): the axis base point at its LOW end, the axis direction, the radius and
 * the axial length. Derived purely from the public surface API — sample two
 * diametrically-opposite points at each V-bound; their midpoints lie on the axis.
 * Returns null if the face isn't a (full) cylinder.
 */
export function cylinderFromFace(
  face: Face,
): { center: [number, number, number]; axis: [number, number, number]; radius: number; length: number } | null {
  if (face.geomType !== "CYLINDRE") return null;
  // NB: replicad's pointOnSurface takes NORMALISED (u,v) in [0,1]. On a full bore
  // u=0 and u=0.5 are diametrically opposite; v=0/v=1 are the two ends.
  const P = (u: number, v: number): [number, number, number] => { const p = face.pointOnSurface(u, v); return [p.x, p.y, p.z]; };
  const mid = (a: number[], b: number[]): [number, number, number] => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];
  const loC = mid(P(0, 0), P(0.5, 0)); // axis point at the low end
  const hiC = mid(P(0, 1), P(0.5, 1)); // axis point at the high end
  const d = [hiC[0] - loC[0], hiC[1] - loC[1], hiC[2] - loC[2]];
  const length = Math.hypot(d[0], d[1], d[2]);
  if (length < 1e-6) return null;
  const a = P(0, 0), b = P(0.5, 0);
  const radius = Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) / 2;
  return { center: loC, axis: [d[0] / length, d[1] / length, d[2] / length], radius, length };
}

let stepCounter = 0;
/** Synchronous STEP import from an ArrayBuffer (the async part of replicad's
 * `importSTEP` is only reading the Blob, which we already have as a buffer). */
export function importSTEPSync(buf: ArrayBuffer): Shape3D {
  const oc = getOC() as unknown as {
    FS: { writeFile: (p: string, d: Uint8Array) => void; unlink: (p: string) => void };
    STEPControl_Reader_1: new () => {
      ReadFile: (name: string) => boolean;
      TransferRoots: (r: unknown) => void;
      OneShape: () => unknown;
    };
    Message_ProgressRange_1: new () => unknown;
  };
  const fileName = `import_${stepCounter++}.step`;
  oc.FS.writeFile(`/${fileName}`, new Uint8Array(buf));
  const reader = new oc.STEPControl_Reader_1();
  try {
    if (!reader.ReadFile(fileName)) throw new Error("[importSTEP] failed to read STEP file");
    reader.TransferRoots(new oc.Message_ProgressRange_1());
    return cast(reader.OneShape() as Parameters<typeof cast>[0]) as Shape3D;
  } finally {
    try { oc.FS.unlink(`/${fileName}`); } catch { /* already gone */ }
  }
}

export function expectMesh(v: GraphValue | undefined, node: string): MeshData {
  if (!v || v.kind !== "mesh")
    throw new Error(`[${node}] expected a mesh input, got ${v?.kind ?? "nothing"}`);
  return v.mesh;
}

/** Coerce a solid OR mesh input to MeshData (solids are tessellated). */
export function asMeshData(v: GraphValue | undefined, node: string): MeshData {
  if (v?.kind === "mesh") return v.mesh;
  if (v?.kind === "solid") return solidToMeshData(v.solid);
  throw new Error(`[${node}] expected a solid or mesh, got ${v?.kind ?? "nothing"}`);
}

/** Build a 2D Drawing of `params.text` in `params.font` (.ttf/.otf ArrayBuffer). */
export function buildTextDrawing(params: Record<string, unknown>, node: string, defSize: number): Drawing {
  const text = String(params.text ?? "");
  const size = Number(params.size ?? defSize);
  const fontBuf = params.font;
  if (!(fontBuf instanceof ArrayBuffer)) throw new Error(`[${node}] a font file (.ttf/.otf) is required`);
  if (!text) throw new Error(`[${node}] empty text`);
  const font = opentype.parse(fontBuf);
  const path = font.getPath(text, 0, 0, size); // baseline y=0; parser flips y-up
  const d = path.toPathData(3);
  if (!d.trim()) throw new Error(`[${node}] font produced no outlines for this text`);
  return svgPathToDrawing(d);
}

/** Sample a Drawing's outline(s) into flat closed polylines (lines kept exact,
 * curves discretised). Duck-typed to avoid importing the concrete curve classes. */
export function drawingPolylines(d: Drawing): Vec2[][] {
  const out: Vec2[][] = [];
  const flatten = (bp: { curves: { firstParameter: number; lastParameter: number; geomType: string; value: (t: number) => Vec2 }[] }): Vec2[] => {
    const pts: Vec2[] = [];
    for (const c of bp.curves) {
      const t0 = c.firstParameter, t1 = c.lastParameter;
      const steps = c.geomType === "LINE" ? 1 : 24;
      for (let i = 0; i < steps; i++) pts.push(c.value(t0 + (t1 - t0) * (i / steps)));
    }
    return pts;
  };
  const visit = (shape: unknown): void => {
    if (!shape || typeof shape !== "object") return;
    const s = shape as { curves?: unknown; blueprints?: unknown[] };
    if (Array.isArray(s.curves)) out.push(flatten(s as never));
    else if (Array.isArray(s.blueprints)) for (const b of s.blueprints) visit(b);
  };
  visit((d as unknown as { innerShape?: unknown }).innerShape);
  return out;
}

let stlCounter = 0;
/** Sew a triangle mesh into a B-rep solid (via OCCT's STL reader, like replicad's
 * importSTL). The result is a FACETED solid — one face per triangle after merging
 * coplanar ones — so it's heavy for downstream CAD ops; use deliberately (e.g. to
 * STEP-export a mesh, or feed a mesh into a solid Boolean). */
export function meshToSolidSync(md: MeshData): Shape3D {
  const oc = getOC() as unknown as {
    FS: { writeFile: (p: string, d: Uint8Array) => void; unlink: (p: string) => void };
    StlAPI_Reader: new () => { Read: (shell: unknown, name: string) => boolean };
    TopoDS_Shell: new () => unknown;
    ShapeUpgrade_UnifySameDomain_2: new (s: unknown, a: boolean, b: boolean, c: boolean) => { Build: () => void; Shape: () => unknown };
    BRepBuilderAPI_MakeSolid_1: new () => { Add: (s: unknown) => void; Solid: () => unknown };
    TopoDS: { Shell_1: (s: unknown) => unknown };
  };
  const name = `mesh_${stlCounter++}.stl`;
  oc.FS.writeFile(`/${name}`, writeBinarySTL(md));
  try {
    const reader = new oc.StlAPI_Reader();
    const shell = new oc.TopoDS_Shell();
    if (!reader.Read(shell, name)) throw new Error("[meshToSolid] STL read failed");
    const up = new oc.ShapeUpgrade_UnifySameDomain_2(shell, true, true, false);
    up.Build();
    const mk = new oc.BRepBuilderAPI_MakeSolid_1();
    mk.Add(oc.TopoDS.Shell_1(up.Shape()));
    return cast(mk.Solid() as Parameters<typeof cast>[0]) as Shape3D;
  } finally {
    try { oc.FS.unlink(`/${name}`); } catch { /* already gone */ }
  }
}
