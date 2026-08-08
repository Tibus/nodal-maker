/**
 * App-level model: wires the default node graph from user parameters and
 * produces the payloads the UI / smoke test consume. Kept separate from the
 * generic graph engine in `nodes.ts`.
 */
import {
  evalGraph,
  evalGraphCached,
  meshAndTag,
  meshToPayload,
  resolveTopCap,
  placeSketchValue,
  humanizeError,
  type EvalCache,
  type Graph,
  type GraphValue,
  type MeshPayload,
} from "./nodes";
import { writeBinarySTL } from "./stl";
import { resolveCrit, critApply, resolvePort } from "./nodes/selection";
import { rebindEdge, rebindFace } from "./nodes/helpers";
import { FaceFinder, EdgeFinder, type Shape3D, type Drawing, type Face, type Edge } from "replicad";
import type { SelRef } from "./nodes/types";

/** A single-geometry port carries one ref; take it (ignoring the multi form). */
const oneRef = (r?: string | string[]): string | undefined => (Array.isArray(r) ? r[0] : r);

export interface Params {
  /** SVG path `d` attribute — the "SVG input" node */
  svgPath: string;
  /** 2D offset distance (mm). negative = inset */
  offset: number;
  /** extrude height (mm) */
  height: number;
  /** add a boss extruded on the top cap (the persistence spike) */
  boss: boolean;
  bossHeight: number;
  bossShrink: number;
}

// A chunky 5-point star, expressed as an SVG path — proves the SVG pipeline.
export const DEFAULT_SVG =
  "M 50 5 L 61 39 L 98 39 L 68 61 L 79 95 L 50 74 L 21 95 L 32 61 L 2 39 L 39 39 Z";

export const DEFAULT_PARAMS: Params = {
  svgPath: DEFAULT_SVG,
  offset: 4,
  height: 12,
  boss: true,
  bossHeight: 8,
  bossShrink: 10,
};

export function buildGraph(p: Params): { graph: Graph; finalId: string } {
  const graph: Graph = [
    { id: "svg", type: "svgInput", params: { d: p.svgPath } },
    { id: "off", type: "offset2d", inputs: { in: "svg" }, params: { distance: p.offset } },
    { id: "ext", type: "extrude", inputs: { in: "off" }, params: { height: p.height } },
  ];
  let finalId = "ext";
  if (p.boss) {
    graph.push({
      id: "boss",
      type: "bossOnCap",
      inputs: { in: "ext", profile: "off" },
      params: { height: p.bossHeight, shrink: p.bossShrink },
    });
    finalId = "boss";
  }
  return { graph, finalId };
}

export function solidOf(p: Params): Shape3D {
  const { graph, finalId } = buildGraph(p);
  const { outputs } = evalGraph(graph);
  const v: GraphValue = outputs[finalId];
  if (v.kind !== "solid") throw new Error("final node did not produce a solid");
  return v.solid;
}

export interface BuildResult {
  mesh: MeshPayload;
  /** informational: which raw B-rep face id resolved as the top cap this build */
  topCapFaceId: number | null;
  topCapZ: number;
  /** what the displayed node actually produced (drives export UI) */
  outputKind?: "solid" | "mesh" | "sketch2d";
  /** display strings for number/text node outputs (inline value preview) */
  values?: Record<string, string>;
  /**
   * Additional bodies to show alongside the main one (pinned-visible nodes),
   * so several B-reps can be seen together for assembly. Non-pickable.
   */
  extras?: { id: string; mesh: MeshPayload }[];
  /** every node that failed to build this run (id → message), so the editor can
   *  flag ALL broken nodes, not just the one being viewed. */
  nodeErrors?: Record<string, string>;
}

export function build(p: Params): BuildResult {
  const solid = solidOf(p);
  const cap = resolveTopCap(solid);
  const mesh = meshAndTag(solid);
  return { mesh, topCapFaceId: cap.faceId, topCapZ: cap.z };
}

export async function exportSTL(p: Params): Promise<Uint8Array> {
  const solid = solidOf(p);
  const blob = solid.blobSTL() as Blob;
  return new Uint8Array(await blob.arrayBuffer());
}

/* ------------------------------------------------------------------ */
/* Mesh-domain pipeline: import an STL, repair it, optionally cut it    */
/* with the current SVG-extruded shape (Manifold boolean).              */
/* ------------------------------------------------------------------ */

export interface MeshImportParams {
  /** cut the imported part with the SVG-extruded profile (mesh difference) */
  cut: boolean;
  svgPath: string;
  /** offset applied to the cutter profile before extruding (mm) */
  cutOffset: number;
  /** cutter extrude height (mm) — make it taller than the part for a clean cut */
  cutHeight: number;
}

export const DEFAULT_MESH_PARAMS: MeshImportParams = {
  cut: false,
  svgPath: DEFAULT_SVG,
  cutOffset: -8,
  cutHeight: 80,
};

function meshImportGraph(stl: ArrayBuffer, o: MeshImportParams): { graph: Graph; finalId: string } {
  const graph: Graph = [
    { id: "stl", type: "importSTL", params: { stl } },
    { id: "fix", type: "repair", inputs: { in: "stl" } },
  ];
  let finalId = "fix";
  if (o.cut) {
    graph.push(
      { id: "svg", type: "svgInput", params: { d: o.svgPath } },
      { id: "off", type: "offset2d", inputs: { in: "svg" }, params: { distance: o.cutOffset } },
      { id: "ext", type: "extrude", inputs: { in: "off" }, params: { height: o.cutHeight } },
      { id: "tess", type: "tessellate", inputs: { in: "ext" } },
      { id: "cut", type: "boolean", inputs: { base: "fix", tool: "tess" }, params: { op: "difference" } },
    );
    finalId = "cut";
  }
  return { graph, finalId };
}

function meshDataOf(stl: ArrayBuffer, o: MeshImportParams) {
  const { graph, finalId } = meshImportGraph(stl, o);
  const v: GraphValue = evalGraph(graph).outputs[finalId];
  if (v.kind !== "mesh") throw new Error("mesh pipeline did not produce a mesh");
  return v.mesh;
}

/** Import + repair (+ optional cut) an STL and return a renderable payload. */
export function importMesh(stl: ArrayBuffer, o: MeshImportParams): BuildResult {
  const mesh = meshToPayload(meshDataOf(stl, o));
  return { mesh, topCapFaceId: null, topCapZ: 0 };
}

/** Same pipeline, exported to binary STL bytes. */
export function exportMeshSTL(stl: ArrayBuffer, o: MeshImportParams): Uint8Array {
  return writeBinarySTL(meshDataOf(stl, o));
}

/* ------------------------------------------------------------------ */
/* Generic graph evaluation — the entry point for the node editor.      */
/* Takes a serialisable graph + which node to display, and returns a    */
/* renderable payload whatever the output socket type is.               */
/* ------------------------------------------------------------------ */

/** A 2D profile as a FLAT face (its filled region, zero thickness). Handles
 * both a single Sketch (`.face()`) and a multi-region Sketches (`.faces()`,
 * e.g. a profile with holes or several disjoint pieces). */
function sketchToFace(v: Extract<GraphValue, { kind: "sketch2d" }>): Shape3D {
  const s = placeSketchValue(v) as unknown as { face?: () => Shape3D; faces?: () => Shape3D };
  return (s.faces ? s.faces() : s.face!()) as Shape3D;
}

/** Turn any renderable graph value into a mesh payload (null for scalars/selections). */
function payloadForValue(v: GraphValue): MeshPayload | null {
  if (v.kind === "solid") return meshAndTag(v.solid);
  if (v.kind === "mesh") return meshToPayload(v.mesh);
  if (v.kind === "sketch2d") {
    // a 2D profile has no thickness — preview it as a flat filled face, not an
    // extruded plate (whose top+bottom edges look like thickness).
    return { ...meshAndTag(sketchToFace(v)), isSketch: true };
  }
  return null;
}

export function evalToPayload(
  graph: Graph,
  outputId: string,
  cache?: EvalCache,
  extraIds?: string[],
  vars?: Record<string, number>,
): BuildResult {
  const { outputs, errors } = cache ? evalGraphCached(graph, cache, vars) : evalGraph(graph, vars);

  // collect inline value previews for scalar nodes
  const values: Record<string, string> = {};
  for (const [id, gv] of Object.entries(outputs)) {
    if (gv.kind === "number") values[id] = Number.isInteger(gv.value) ? String(gv.value) : gv.value.toFixed(3);
    else if (gv.kind === "text") values[id] = gv.value.length > 24 ? gv.value.slice(0, 24) + "…" : gv.value;
    else if (gv.kind === "selection") values[id] = `${gv.target} selection`;
    else if (gv.kind === "axis") values[id] = "axis";
  }
  // every node that failed this run → the editor flags them all, not just the viewed one
  const nodeErrors: Record<string, string> = {};
  for (const [id, e] of Object.entries(errors)) nodeErrors[id] = e.message;

  // extra pinned bodies to show alongside the main output (skip the main id)
  let extras: { id: string; mesh: MeshPayload }[] | undefined;
  if (extraIds?.length) {
    extras = [];
    for (const id of extraIds) {
      if (id === outputId) continue;
      const ev = outputs[id];
      if (!ev) continue;
      try {
        const m = payloadForValue(ev);
        if (m) extras.push({ id, mesh: m });
      } catch {
        /* a pinned node may have failed to build — just skip it */
      }
    }
    if (!extras.length) extras = undefined;
  }

  const v: GraphValue | undefined = outputs[outputId];
  if (!v) {
    // The viewed node itself failed to build — surface its (humanized) error so
    // the editor can flag it. Unrelated nodes were still evaluated and remain
    // viewable; only selecting the broken one shows this.
    if (errors[outputId]) throw errors[outputId];
    throw new Error(`unknown output node "${outputId}"`);
  }
  // Meshing the viewed solid can itself abort deep in OCCT (a valid-looking
  // B-rep that won't triangulate throws a bare pointer number). That happens
  // OUTSIDE the per-node eval try/catch, so humanize it here and tag the viewed
  // node — otherwise the user just sees a cryptic number and no red node.
  try {
    if (v.kind === "solid") {
      let topCapFaceId: number | null = null;
      let topCapZ = 0;
      try {
        const cap = resolveTopCap(v.solid);
        topCapFaceId = cap.faceId;
        topCapZ = cap.z;
      } catch {
        /* not every solid has a resolvable top cap — fine */
      }
      return { mesh: { ...meshAndTag(v.solid), tint: v.color }, topCapFaceId, topCapZ, outputKind: "solid", values, extras, nodeErrors };
    }
    if (v.kind === "mesh") {
      return { mesh: meshToPayload(v.mesh), topCapFaceId: null, topCapZ: 0, outputKind: "mesh", values, extras, nodeErrors };
    }
    if (v.kind === "sketch2d") {
      // preview a 2D profile as a FLAT filled face (zero thickness) on its base
      // plane — no extruded-plate thickness. Real geometry → exportSVG.
      return { mesh: { ...meshAndTag(sketchToFace(v)), isSketch: true }, topCapFaceId: null, topCapZ: 0, outputKind: "sketch2d", values, extras, nodeErrors };
    }
  } catch (e) {
    const raw = e instanceof Error ? e.message : String(e);
    const nodeType = graph.find((n) => n.id === outputId)?.type ?? outputId;
    throw Object.assign(new Error(humanizeError(nodeType, raw)), { nodeId: outputId, raw });
  }
  throw new Error(`output node "${outputId}" is a ${v.kind}; connect it to geometry to preview`);
}

const EMPTY_HL = () => ({ tris: new Float32Array(0), segs: new Float32Array(0) });

/** Tessellate faces → flat triangle positions (the solid must be meshed first). */
function facesToTris(faces: Face[]): Float32Array {
  const tris: number[] = [];
  for (const f of faces) {
    const t = f.triangulation();
    if (!t) continue;
    for (const idx of t.trianglesIndexes) tris.push(t.vertices[idx * 3], t.vertices[idx * 3 + 1], t.vertices[idx * 3 + 2]);
  }
  return new Float32Array(tris);
}

/** Sample edges into polyline segments (pairs of endpoints). */
function edgesToSegs(edges: Edge[]): Float32Array {
  const segs: number[] = [];
  for (const e of edges) {
    let prev: { x: number; y: number; z: number } | null = null;
    for (let i = 0; i <= 24; i++) {
      const p = e.pointAt(i / 24);
      if (prev) segs.push(prev.x, prev.y, prev.z, p.x, p.y, p.z);
      prev = p;
    }
  }
  return new Float32Array(segs);
}

const meshSolid = (s: Shape3D) =>
  (s as unknown as { mesh: (o: { tolerance: number; angularTolerance: number }) => unknown }).mesh({ tolerance: 0.1, angularTolerance: 20 });

/**
 * Geometry to highlight when hovering a node's selection OUTPUT port (extrude
 * cap, box top, cylinder side…): resolve that port's criteria and apply it to
 * the currently DISPLAYED solid, returning the matched faces' triangles and/or
 * the matched edges' polylines so the viewport can flash them.
 */
export function describePortGeometry(
  graph: Graph,
  outputId: string,
  sourceNodeId: string,
  port: string,
  cache?: EvalCache,
  vars?: Record<string, number>,
): { tris: Float32Array; segs: Float32Array } {
  const { outputs } = cache ? evalGraphCached(graph, cache, vars) : evalGraph(graph, vars);
  const v = outputs[outputId];
  if (!v || v.kind !== "solid") return EMPTY_HL();
  const byId = new Map(graph.map((n) => [n.id, n]));
  const evalNode = (id: string): GraphValue => {
    const o = outputs[id];
    if (!o) throw new Error(`unknown node ${id}`);
    return o;
  };
  let crit;
  try {
    crit = resolveCrit(`${sourceNodeId}#${port}`, byId, evalNode);
  } catch {
    return EMPTY_HL(); // port not resolvable against this geometry
  }
  const apply = critApply(crit);
  if (crit.target === "face") {
    meshSolid(v.solid); // triangulation() only returns data once meshed
    const faces = (apply(new FaceFinder()) as FaceFinder).find(v.solid as Parameters<FaceFinder["find"]>[0]) as Face[];
    return { tris: facesToTris(faces), segs: new Float32Array(0) };
  }
  const edges = (apply(new EdgeFinder()) as EdgeFinder).find(v.solid as Parameters<EdgeFinder["find"]>[0]) as Edge[];
  return { tris: new Float32Array(0), segs: edgesToSegs(edges) };
}

/** Which input port + kind a modifier's targeted feature comes from. */
const FEATURE_SEL: Record<string, { port: string; kind: "edge" | "face" }> = {
  fillet: { port: "sel", kind: "edge" },
  bevel: { port: "sel", kind: "edge" },
  shell: { port: "faces", kind: "face" },
  internalThread: { port: "face", kind: "face" },
};

/**
 * Geometry a modifier node ACTS ON, to flash when the node is selected: resolve
 * its selection input against its INPUT solid (the sharp edges a fillet rounds,
 * the faces a shell opens, the bore an internal thread cuts). A fillet/bevel with
 * no selection targets every edge.
 */
/** Resolve a selection against a solid → its edges' polylines or faces' triangles.
 *  Uses the parametric re-bind when the selection carries a pick signature. */
function selToGeometry(solid: Shape3D, sel: Extract<GraphValue, { kind: "selection" }>): { tris: Float32Array; segs: Float32Array } {
  if (sel.target === "edge") {
    let edges: Edge[];
    if (sel.ref?.kind === "edge") { const e = rebindEdge(solid, sel.ref as Extract<SelRef, { kind: "edge" }>); edges = e ? [e] : []; }
    else edges = (sel.apply(new EdgeFinder()) as EdgeFinder).find(solid as Parameters<EdgeFinder["find"]>[0]) as Edge[];
    return { tris: new Float32Array(0), segs: edgesToSegs(edges) };
  }
  meshSolid(solid);
  let faces: Face[];
  if (sel.ref?.kind === "face") { const f = rebindFace(solid, sel.ref as Extract<SelRef, { kind: "face" }>); faces = f ? [f] : []; }
  else faces = (sel.apply(new FaceFinder()) as FaceFinder).find(solid as Parameters<FaceFinder["find"]>[0]) as Face[];
  return { tris: facesToTris(faces), segs: new Float32Array(0) };
}

export function describeFeatureGeometry(
  graph: Graph,
  viewedId: string,
  nodeId: string,
  cache?: EvalCache,
  vars?: Record<string, number>,
): { tris: Float32Array; segs: Float32Array } {
  const node = graph.find((n) => n.id === nodeId);
  if (!node) return EMPTY_HL();
  const isSelectNode = node.type === "edgeSelect" || node.type === "faceSelect";
  const feat = FEATURE_SEL[node.type];
  if (!isSelectNode && !feat) return EMPTY_HL();
  const { outputs } = cache ? evalGraphCached(graph, cache, vars) : evalGraph(graph, vars);
  const byId = new Map(graph.map((n) => [n.id, n]));
  const evalNode = (id: string): GraphValue => {
    const o = outputs[id];
    if (!o) throw new Error(`unknown node ${id}`);
    return o;
  };
  try {
    // (a) an Edge/Face Select node → show its OWN selection. Apply it to the
    // viewed solid if that IS one, else to the input solid of whatever consumes
    // this selection (so it works even when the select node itself is "viewed").
    if (isSelectNode) {
      const sv = outputs[nodeId];
      if (!sv || sv.kind !== "selection") return EMPTY_HL();
      let solid: Shape3D | null = null;
      const viewed = outputs[viewedId];
      if (viewed?.kind === "solid") solid = viewed.solid;
      else {
        for (const n of graph) {
          const consumes = Object.values(n.inputs ?? {}).some((ref) =>
            (Array.isArray(ref) ? ref : [ref]).some((r) => r.split("#")[0] === nodeId));
          if (!consumes || !n.inputs?.in) continue;
          const inId = (Array.isArray(n.inputs.in) ? n.inputs.in[0] : n.inputs.in).split("#")[0];
          const s = outputs[inId];
          if (s?.kind === "solid") { solid = s.solid; break; }
        }
      }
      return solid ? selToGeometry(solid, sv) : EMPTY_HL();
    }
    // (b) a modifier → resolve its selection input against its INPUT solid
    const inRef = node.inputs?.in;
    if (!inRef) return EMPTY_HL();
    const inV = resolvePort(inRef, byId, evalNode);
    if (inV.kind !== "solid") return EMPTY_HL();
    const inSolid = inV.solid;
    const selRef = node.inputs?.[feat!.port];
    let sel: Extract<GraphValue, { kind: "selection" }> | null = null;
    if (selRef != null) { const sv = resolvePort(selRef, byId, evalNode); if (sv.kind === "selection") sel = sv; }
    if (feat!.kind === "edge" && !sel) {
      return { tris: new Float32Array(0), segs: edgesToSegs((inSolid as unknown as { edges: Edge[] }).edges) }; // fillet-all
    }
    return sel ? selToGeometry(inSolid, sel) : EMPTY_HL();
  } catch { return EMPTY_HL(); }
}

/** Export the displayed node as SVG (2D profiles only). Curves are preserved. */
export function exportGraphSVG(graph: Graph, outputId: string): string {
  const outputs = evalGraph(graph).outputs;
  const node = graph.find((n) => n.id === outputId);

  // Score/Cut node → layered SVG: red = cut (through), blue = score (fold/engrave)
  if (node?.type === "scoreCut") {
    const cutRef = oneRef(node.inputs?.cut), scoreRef = oneRef(node.inputs?.score);
    const cutV = cutRef ? outputs[cutRef] : undefined;
    const scoreV = scoreRef ? outputs[scoreRef] : undefined;
    if (!cutV || cutV.kind !== "sketch2d") throw new Error("Score/Cut needs a cut profile");
    const score = scoreV && scoreV.kind === "sketch2d" ? scoreV.drawing : undefined;
    return scoreCutSVG(cutV.drawing, score);
  }

  const v: GraphValue | undefined = outputs[outputId];
  if (!v) throw new Error(`unknown output node "${outputId}"`);
  if (v.kind !== "sketch2d")
    throw new Error(`node "${outputId}" is a ${v.kind}; only 2D profiles export to SVG`);
  return v.drawing.toSVG(1);
}

function scoreCutSVG(cut: Drawing, score?: Drawing): string {
  let combined = cut;
  if (score) {
    try {
      combined = cut.fuse(score);
    } catch {
      /* keep cut bounds if score can't fuse */
    }
  }
  const pathD = (dr: Drawing) => (dr.toSVGPaths() as (string | string[])[]).flat().join(" ");
  const viewBox = combined.toSVGViewBox(2);
  const parts = [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}" fill="none">`,
    `<path d="${pathD(cut)}" stroke="#ff0000" stroke-width="0.3"/>`,
  ];
  if (score) parts.push(`<path d="${pathD(score)}" stroke="#0000ff" stroke-width="0.3"/>`);
  parts.push(`</svg>`);
  return parts.join("\n");
}

/* ------------------------------------------------------------------ */
/* DXF export — flat 2D profiles for laser cutters (LightBurn, etc.).   */
/* Curves are flattened to polylines; Score/Cut maps to CUT (red) and   */
/* SCORE (blue) layers so the cutter can assign power per layer.        */
/* ------------------------------------------------------------------ */

type Pt2 = [number, number];

/** Sample one blueprint's chained curves into a closed polyline. Lines keep
 * their endpoints; arcs/splines are discretised. */
function flattenBlueprint(bp: { curves: { firstParameter: number; lastParameter: number; geomType: string; value: (t: number) => Pt2 }[] }): Pt2[] {
  const pts: Pt2[] = [];
  for (const c of bp.curves) {
    const t0 = c.firstParameter;
    const t1 = c.lastParameter;
    const steps = c.geomType === "LINE" ? 1 : 24;
    for (let i = 0; i < steps; i++) pts.push(c.value(t0 + (t1 - t0) * (i / steps)));
  }
  return pts;
}

/** Recurse a Drawing's inner shape (Blueprint | Blueprints | CompoundBlueprint)
 * into a flat list of closed polylines. Duck-typed to avoid importing the
 * concrete classes into this thin model layer. */
function drawingToPolylines(d: Drawing): Pt2[][] {
  const out: Pt2[][] = [];
  const visit = (shape: unknown): void => {
    if (!shape || typeof shape !== "object") return;
    const s = shape as { curves?: unknown; blueprints?: unknown[] };
    if (Array.isArray(s.curves)) out.push(flattenBlueprint(s as never));
    else if (Array.isArray(s.blueprints)) for (const b of s.blueprints) visit(b);
  };
  visit((d as unknown as { innerShape?: unknown }).innerShape);
  return out;
}

interface DxfLayer {
  name: string;
  color: number; // AutoCAD color index (1=red, 5=blue, 7=white/black)
  polylines: Pt2[][];
  points?: Pt2[]; // DXF POINT entities (drill centres for CAM)
}

/** Centroid of each closed loop in a drawing — used to derive drill points. */
function loopCentroids(d: Drawing): Pt2[] {
  return drawingToPolylines(d).map((poly) => {
    let x = 0, y = 0;
    for (const [px, py] of poly) { x += px; y += py; }
    return [x / poly.length, y / poly.length] as Pt2;
  });
}

function buildDXF(layers: DxfLayer[]): string {
  const L: (string | number)[] = [];
  const p = (code: number, val: string | number) => L.push(code, val);

  p(0, "SECTION"); p(2, "HEADER");
  p(9, "$ACADVER"); p(1, "AC1015"); // R2000 — supports LWPOLYLINE + layers
  p(9, "$INSUNITS"); p(70, 4); // 4 = millimetres
  p(0, "ENDSEC");

  p(0, "SECTION"); p(2, "TABLES");
  p(0, "TABLE"); p(2, "LAYER"); p(70, layers.length);
  for (const layer of layers) {
    p(0, "LAYER"); p(2, layer.name); p(70, 0); p(62, layer.color); p(6, "CONTINUOUS");
  }
  p(0, "ENDTAB"); p(0, "ENDSEC");

  p(0, "SECTION"); p(2, "ENTITIES");
  for (const layer of layers) {
    for (const poly of layer.polylines) {
      if (poly.length < 2) continue;
      p(0, "LWPOLYLINE"); p(8, layer.name);
      p(90, poly.length); p(70, 1); p(43, 0); // closed, zero constant width
      for (const [x, y] of poly) { p(10, x); p(20, y); }
    }
    for (const [x, y] of layer.points ?? []) { p(0, "POINT"); p(8, layer.name); p(10, x); p(20, y); p(30, 0); }
  }
  p(0, "ENDSEC");
  p(0, "EOF");

  // DXF is a strict pair-per-line format: code then value, each on its own line.
  return L.join("\n") + "\n";
}

/** Export the displayed node (or a Score/Cut node) to a DXF for laser cutting. */
export function exportGraphDXF(graph: Graph, outputId: string): string {
  const outputs = evalGraph(graph).outputs;
  const node = graph.find((n) => n.id === outputId);

  if (node?.type === "scoreCut") {
    const cutRef = oneRef(node.inputs?.cut), scoreRef = oneRef(node.inputs?.score);
    const cutV = cutRef ? outputs[cutRef] : undefined;
    const scoreV = scoreRef ? outputs[scoreRef] : undefined;
    if (!cutV || cutV.kind !== "sketch2d") throw new Error("Score/Cut needs a cut profile");
    const layers: DxfLayer[] = [{ name: "CUT", color: 1, polylines: drawingToPolylines(cutV.drawing) }];
    if (scoreV && scoreV.kind === "sketch2d")
      layers.push({ name: "SCORE", color: 5, polylines: drawingToPolylines(scoreV.drawing) });
    return buildDXF(layers);
  }

  // CNC job → one DXF layer per operation, depths encoded in the layer name and
  // drills as POINT entities, so a CAM tool can assign toolpaths per layer.
  if (node?.type === "cncJob") {
    const g = (port: string) => { const r = oneRef(node.inputs?.[port]); const v = r ? outputs[r] : undefined; return v && v.kind === "sketch2d" ? v.drawing : undefined; };
    const depth = (k: string, d: number) => Number(node.params?.[k] ?? d);
    const layers: DxfLayer[] = [];
    const contour = g("contour");
    if (contour) layers.push({ name: `CONTOUR_${depth("contourDepth", 3).toFixed(1)}`, color: 1, polylines: drawingToPolylines(contour) });
    const pocket = g("pocket");
    if (pocket) layers.push({ name: `POCKET_${depth("pocketDepth", 2).toFixed(1)}`, color: 3, polylines: drawingToPolylines(pocket) });
    const drills = g("drills");
    if (drills) layers.push({ name: "DRILL", color: 5, polylines: drawingToPolylines(drills), points: loopCentroids(drills) });
    if (!layers.length) throw new Error("CNC job: connect at least a contour, pocket or drills profile");
    return buildDXF(layers);
  }

  const v: GraphValue | undefined = outputs[outputId];
  if (!v) throw new Error(`unknown output node "${outputId}"`);
  if (v.kind !== "sketch2d")
    throw new Error(`node "${outputId}" is a ${v.kind}; only 2D profiles export to DXF`);
  return buildDXF([{ name: "CUT", color: 1, polylines: drawingToPolylines(v.drawing) }]);
}

/** Export the displayed solid as STEP (CAD interchange). */
export async function exportGraphSTEP(graph: Graph, outputId: string): Promise<Uint8Array> {
  const v: GraphValue | undefined = evalGraph(graph).outputs[outputId];
  if (!v) throw new Error(`unknown output node "${outputId}"`);
  if (v.kind !== "solid") throw new Error(`node "${outputId}" is a ${v.kind}; STEP export needs a solid`);
  const blob = v.solid.blobSTEP() as Blob;
  return new Uint8Array(await blob.arrayBuffer());
}

export async function exportGraphSTL(
  graph: Graph,
  outputId: string,
  cache?: EvalCache,
): Promise<Uint8Array> {
  const outputs = cache ? evalGraphCached(graph, cache).outputs : evalGraph(graph).outputs;
  const v: GraphValue | undefined = outputs[outputId];
  if (!v) throw new Error(`unknown output node "${outputId}"`);
  if (v.kind === "solid") {
    const blob = v.solid.blobSTL() as Blob;
    return new Uint8Array(await blob.arrayBuffer());
  }
  if (v.kind === "mesh") return writeBinarySTL(v.mesh);
  throw new Error(`output node "${outputId}" is a ${v.kind}; cannot export`);
}
