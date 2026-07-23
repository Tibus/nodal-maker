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
  type EvalCache,
  type Graph,
  type GraphValue,
  type MeshPayload,
} from "./nodes";
import { writeBinarySTL } from "./stl";
import type { Shape3D, Drawing } from "replicad";

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
      { id: "cut", type: "boolean", inputs: { a: "fix", b: "tess" }, params: { op: "difference" } },
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

export function evalToPayload(graph: Graph, outputId: string, cache?: EvalCache): BuildResult {
  const outputs = cache ? evalGraphCached(graph, cache).outputs : evalGraph(graph).outputs;

  // collect inline value previews for scalar nodes
  const values: Record<string, string> = {};
  for (const [id, gv] of Object.entries(outputs)) {
    if (gv.kind === "number") values[id] = Number.isInteger(gv.value) ? String(gv.value) : gv.value.toFixed(3);
    else if (gv.kind === "text") values[id] = gv.value.length > 24 ? gv.value.slice(0, 24) + "…" : gv.value;
    else if (gv.kind === "selection") values[id] = `${gv.target} selection`;
  }

  const v: GraphValue | undefined = outputs[outputId];
  if (!v) throw new Error(`unknown output node "${outputId}"`);
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
    return { mesh: meshAndTag(v.solid), topCapFaceId, topCapZ, outputKind: "solid", values };
  }
  if (v.kind === "mesh") {
    return { mesh: meshToPayload(v.mesh), topCapFaceId: null, topCapZ: 0, outputKind: "mesh", values };
  }
  if (v.kind === "sketch2d") {
    // preview a 2D profile as a thin plate so it's visible in the viewport;
    // the true (non-faceted) geometry is what `exportGraphSVG` emits.
    const plate = v.drawing.sketchOnPlane("XY").extrude(0.5) as Shape3D;
    return { mesh: meshAndTag(plate), topCapFaceId: null, topCapZ: 0, outputKind: "sketch2d", values };
  }
  throw new Error(`output node "${outputId}" is a ${v.kind}; connect it to geometry to preview`);
}

/** Export the displayed node as SVG (2D profiles only). Curves are preserved. */
export function exportGraphSVG(graph: Graph, outputId: string): string {
  const outputs = evalGraph(graph).outputs;
  const node = graph.find((n) => n.id === outputId);

  // Score/Cut node → layered SVG: red = cut (through), blue = score (fold/engrave)
  if (node?.type === "scoreCut") {
    const cutV = node.inputs?.cut ? outputs[node.inputs.cut] : undefined;
    const scoreV = node.inputs?.score ? outputs[node.inputs.score] : undefined;
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
