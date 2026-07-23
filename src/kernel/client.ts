import { wrap } from "comlink";
import type { KernelAPI } from "./worker";

const worker = new Worker(new URL("./worker.ts", import.meta.url), {
  type: "module",
});

export const kernel = wrap<KernelAPI>(worker);
export type { Params, MeshImportParams } from "./model";
export type { MeshPayload, FaceTag, Graph, NodeDescriptor } from "./nodes";
// metadata comes from the dependency-free specs module (no WASM in the UI bundle)
export type { NodeSpec, ParamSpec, PortSpec, SocketType } from "./specs";
export { NODE_SPECS, SOCKET_COLORS, paramPortType, NODE_CATEGORIES } from "./specs";
export { expandDescriptors, expandOutputId } from "./components";
export type { ComponentDef, InstanceDescriptor } from "./components";
