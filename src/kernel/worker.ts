/**
 * Browser Web Worker hosting the OCCT/replicad kernel. The heavy WASM stays
 * off the UI thread; the main thread talks to it through comlink.
 */
import { expose } from "comlink";
import initOpenCascade from "replicad-opencascadejs/src/replicad_single.js";
import wasmUrl from "replicad-opencascadejs/src/replicad_single.wasm?url";
import { setOC } from "replicad";
import { build, exportSTL, type Params } from "./model";

let ready: Promise<void> | null = null;
function ensureOCCT(): Promise<void> {
  if (!ready) {
    ready = (async () => {
      const OC = await initOpenCascade({ locateFile: () => wasmUrl });
      setOC(OC as Parameters<typeof setOC>[0]);
    })();
  }
  return ready;
}

const api = {
  async build(p: Params) {
    await ensureOCCT();
    return build(p);
  },
  async exportSTL(p: Params) {
    await ensureOCCT();
    return exportSTL(p);
  },
};

export type KernelAPI = typeof api;
expose(api);
