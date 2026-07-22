/// <reference types="vite/client" />

// The OCCT build ships an ESM default export (an emscripten factory). Its
// bundled .d.ts is unwieldy, so we give it a narrow ambient type here.
declare module "replicad-opencascadejs/src/replicad_single.js" {
  const initOpenCascade: (opts?: {
    locateFile?: (path: string) => string;
  }) => Promise<unknown>;
  export default initOpenCascade;
}
