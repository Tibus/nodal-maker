import { wrap } from "comlink";
import type { KernelAPI } from "./worker";

const worker = new Worker(new URL("./worker.ts", import.meta.url), {
  type: "module",
});

export const kernel = wrap<KernelAPI>(worker);
export type { Params } from "./model";
export type { MeshPayload, FaceTag } from "./nodes";
