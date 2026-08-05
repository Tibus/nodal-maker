/**
 * Shared kernel bootstrap for tests that evaluate real geometry. Boots the
 * OCCT (replicad) + Manifold WASM modules once per test file — call
 * `await initKernel()` in a `beforeAll`. Pure-logic tests (expr, massprops,
 * marching cubes) don't need this.
 */
import { createRequire } from "module";
import { dirname } from "path";
import { setOC } from "replicad";
import { setManifold } from "../src/kernel/manifold";

let booted: Promise<void> | null = null;

export function initKernel(): Promise<void> {
  if (booted) return booted;
  booted = (async () => {
    const require = createRequire(import.meta.url);
    const wasmPath = require.resolve("replicad-opencascadejs/src/replicad_single.wasm");
    const srcDir = dirname(wasmPath);
    (globalThis as Record<string, unknown>).require = require;
    (globalThis as Record<string, unknown>).__dirname = srcDir;
    (globalThis as Record<string, unknown>).__filename = `${srcDir}/replicad_single.js`;
    const { default: factory } = await import("replicad-opencascadejs/src/replicad_single.js");
    setOC((await factory({ locateFile: () => wasmPath })) as Parameters<typeof setOC>[0]);
    const mfWasm = require.resolve("manifold-3d/manifold.wasm");
    const { default: MFModule } = await import("manifold-3d");
    setManifold(await MFModule({ locateFile: () => mfWasm }));
  })();
  return booted;
}
