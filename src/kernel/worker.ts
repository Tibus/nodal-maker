/**
 * Browser Web Worker hosting BOTH geometry kernels off the UI thread:
 *   - OCCT / replicad (B-rep CAD)
 *   - Manifold        (robust mesh booleans / repair)
 *
 * They live in the SAME worker on purpose: the node graph (`nodes.ts`) can
 * interleave B-rep and mesh nodes in a single evaluation (e.g. extrude a solid,
 * tessellate it, then boolean it against an imported STL), so both kernels must
 * be available wherever `evalGraph` runs. (The original plan floated a second
 * worker for Manifold; a unified graph engine makes co-locating them simpler.)
 */
import { expose } from "comlink";
import initOpenCascade from "replicad-opencascadejs/src/replicad_single.js";
import wasmUrl from "replicad-opencascadejs/src/replicad_single.wasm?url";
import initManifold from "manifold-3d";
import manifoldWasmUrl from "manifold-3d/manifold.wasm?url";
import { setOC } from "replicad";
import { setManifold } from "./manifold";
import {
  build,
  exportSTL,
  importMesh,
  exportMeshSTL,
  evalToPayload,
  exportGraphSTL,
  exportGraphSVG,
  exportGraphSTEP,
  type Params,
  type MeshImportParams,
} from "./model";
import { makeEvalCache, type Graph } from "./nodes";

// One persistent eval cache for the whole worker session — lets live graph
// edits reuse every untouched upstream node instead of recomputing the DAG.
const graphCache = makeEvalCache();

let ready: Promise<void> | null = null;
function ensureKernels(): Promise<void> {
  if (!ready) {
    ready = (async () => {
      const [OC, MF] = await Promise.all([
        initOpenCascade({ locateFile: () => wasmUrl }),
        initManifold({ locateFile: () => manifoldWasmUrl }),
      ]);
      setOC(OC as Parameters<typeof setOC>[0]);
      setManifold(MF);
    })();
  }
  return ready;
}

const api = {
  async build(p: Params) {
    await ensureKernels();
    return build(p);
  },
  async exportSTL(p: Params) {
    await ensureKernels();
    return exportSTL(p);
  },
  async importMesh(stl: ArrayBuffer, o: MeshImportParams) {
    await ensureKernels();
    return importMesh(stl, o);
  },
  async exportMeshSTL(stl: ArrayBuffer, o: MeshImportParams) {
    await ensureKernels();
    return exportMeshSTL(stl, o);
  },
  async evalGraph(graph: Graph, outputId: string) {
    await ensureKernels();
    return evalToPayload(graph, outputId, graphCache);
  },
  async exportGraphSTL(graph: Graph, outputId: string) {
    await ensureKernels();
    return exportGraphSTL(graph, outputId, graphCache);
  },
  async exportGraphSVG(graph: Graph, outputId: string) {
    await ensureKernels();
    return exportGraphSVG(graph, outputId);
  },
  async exportGraphSTEP(graph: Graph, outputId: string) {
    await ensureKernels();
    return exportGraphSTEP(graph, outputId);
  },
};

export type KernelAPI = typeof api;
expose(api);
