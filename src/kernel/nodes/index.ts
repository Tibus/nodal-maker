/**
 * Barrel for the node-graph engine.
 *
 * Re-exports every public symbol the old monolithic `nodes.ts` exposed, so
 * external imports (`import { … } from "../kernel/nodes"`) keep working
 * unchanged. Internally the engine is split across:
 *   types ← (payload, selection, helpers) ← registry.* ← eval ← index
 *
 * Values flowing on the wires are TYPED (`sketch2d` | `solid` | `mesh` | …).
 * Nodes are pure functions registered in a table, keyed by `type`; a graph is
 * a DAG of node descriptors that we topo-sort and evaluate. The geometry runs
 * on replicad (OpenCascade / OCCT B-rep kernel) and Manifold (meshes) — this
 * module never calls `setOC`; the caller initialises the kernels first.
 */

// All shared type definitions.
export * from "./types";

// Node metadata (ports, params, socket colours) lives dependency-free in
// `specs.ts` so the editor can import it without pulling in the WASM kernels.
export type { SocketType, PortSpec, ParamSpec, NodeSpec } from "../specs";
export { NODE_SPECS, SOCKET_COLORS } from "../specs";

// Selection system (criteria-based face/edge picks + input resolution).
export { parseRef } from "./selection";

// Node-implementation helpers used by external callers.
export { placeSketchValue, THREAD_STANDARDS } from "./helpers";

// Mesh ↔ payload conversion + face tagging.
export { meshAndTag, meshToPayload, solidToMeshData, resolveTopCap } from "./payload";

// Evaluation engine + assembled registry.
export { humanizeError, evalGraph, evalGraphCached, makeEvalCache, REGISTRY } from "./eval";
