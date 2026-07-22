/**
 * App-level model: wires the default node graph from user parameters and
 * produces the payloads the UI / smoke test consume. Kept separate from the
 * generic graph engine in `nodes.ts`.
 */
import {
  evalGraph,
  meshAndTag,
  resolveTopCap,
  type Graph,
  type GraphValue,
  type MeshPayload,
} from "./nodes";
import type { Shape3D } from "replicad";

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
