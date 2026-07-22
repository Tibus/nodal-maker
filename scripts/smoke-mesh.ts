/**
 * Headless smoke test n°2 — proves the MESH BRIDGE (Manifold) works WITHOUT a
 * browser, and that it interoperates with the B-rep (replicad/OCCT) side:
 *
 *   1. init BOTH kernels in Node (OCCT + Manifold WASM)
 *   2. build a "printed part" in replicad, export it to binary STL bytes
 *      (our stand-in for an external STL file)
 *   3. importSTL         → a raw triangle SOUP (unshared vertices)
 *   4. repair            → weld into a clean manifold (STL repair)
 *   5. SVG → offset → extrude → tessellate  → a CAD-built cutter mesh
 *   6. boolean(difference)  → CAD × STL boolean in the mesh domain
 *   7. export the result back to binary STL
 *   8. segmentMesh       → recover flat regions from a cube (mesh face flagging)
 *
 * The whole 3..6 chain runs through the node graph in `nodes.ts`, proving the
 * new `mesh` socket type and the mesh nodes are wired correctly.
 *
 * Run: npm run smoke:mesh
 */
import { createRequire } from "module";
import { dirname } from "path";
import { setOC } from "replicad";
import type { ManifoldToplevel } from "manifold-3d";
import { evalGraph, meshAndTag, type Graph } from "../src/kernel/nodes";
import {
  manifoldToMeshData,
  meshDataToManifold,
  segmentMesh,
  setManifold,
  type MeshData,
} from "../src/kernel/manifold";
import { parseBinarySTL, writeBinarySTL } from "../src/kernel/stl";
import { solidOf, DEFAULT_PARAMS } from "../src/kernel/model";

const require = createRequire(import.meta.url);

/** Keep a handle so the smoke can build primitives (cube) directly for testing. */
let MF: ManifoldToplevel;

async function initOCCT() {
  // Same Node-ESM shim dance as scripts/smoke.ts (OCCT's emscripten Node branch
  // reads __dirname/require as free globals; the browser worker doesn't need it).
  const wasmPath = require.resolve("replicad-opencascadejs/src/replicad_single.wasm");
  const srcDir = dirname(wasmPath);
  (globalThis as Record<string, unknown>).require = require;
  (globalThis as Record<string, unknown>).__dirname = srcDir;
  (globalThis as Record<string, unknown>).__filename = `${srcDir}/replicad_single.js`;
  const { default: factory } = await import("replicad-opencascadejs/src/replicad_single.js");
  const OC = await factory({ locateFile: () => wasmPath });
  setOC(OC as Parameters<typeof setOC>[0]);
}

async function initManifold() {
  // Manifold's WASM needs NO shim under Node ESM (unlike OCCT) — the module
  // resolves fine on its own; we only hand it the .wasm location.
  // The package's "." export only defines the `import` condition, so CJS
  // require.resolve("manifold-3d") fails; resolve the .wasm subpath instead
  // (mapped for all conditions) and let the ESM import() handle the JS.
  const wasmPath = require.resolve("manifold-3d/manifold.wasm");
  const { default: Module } = await import("manifold-3d");
  MF = await Module({ locateFile: () => wasmPath });
  setManifold(MF);
}

function line(s = "") {
  process.stdout.write(s + "\n");
}

/** Manifold-computed volume of a MeshData (also validates it is manifold). */
function volumeOf(md: MeshData): number {
  const man = meshDataToManifold(md);
  try {
    return man.volume();
  } finally {
    man.delete();
  }
}

async function main() {
  line("→ initialising OCCT + Manifold WASM in Node…");
  await Promise.all([initOCCT(), initManifold()]);
  line("  both kernels ready.\n");

  // ---- 2: build a "printed part" in replicad and serialise it to STL -------
  line("Build a part in replicad → export binary STL (stand-in for a file):");
  const partSolid = solidOf({ ...DEFAULT_PARAMS, boss: false, height: 20 });
  const partMesh = meshAndTag(partSolid);
  const stlBytes = writeBinarySTL({ vertices: partMesh.vertices, indices: partMesh.indices });
  line(`  STL bytes            : ${stlBytes.length}`);
  assert(stlBytes.length > 100, "STL export produced content");

  // ---- 3..6: the mesh pipeline, run THROUGH the node graph -----------------
  line("\nMesh pipeline via the node graph: importSTL → repair → boolean(diff)");
  const cutterHeight = 60; // taller than the part → a clean through-cut
  const graph: Graph = [
    { id: "stl", type: "importSTL", params: { stl: stlBytes } },
    { id: "fix", type: "repair", inputs: { in: "stl" } },
    { id: "svg", type: "svgInput", params: { d: DEFAULT_PARAMS.svgPath } },
    { id: "off", type: "offset2d", inputs: { in: "svg" }, params: { distance: -8 } },
    { id: "ext", type: "extrude", inputs: { in: "off" }, params: { height: cutterHeight } },
    { id: "tess", type: "tessellate", inputs: { in: "ext" } },
    { id: "cut", type: "boolean", inputs: { a: "fix", b: "tess" }, params: { op: "difference" } },
  ];
  const { outputs } = evalGraph(graph);

  const soup = outputs.stl;
  const fixed = outputs.fix;
  const cut = outputs.cut;
  if (soup.kind !== "mesh" || fixed.kind !== "mesh" || cut.kind !== "mesh")
    throw new Error("graph did not produce mesh values");

  const soupVerts = soup.mesh.vertices.length / 3;
  const soupTris = soup.mesh.indices.length / 3;
  line(`  imported STL soup    : ${soupTris} tris, ${soupVerts} verts (unshared)`);
  assert(soupVerts === soupTris * 3, "raw STL is an unshared triangle soup (3 verts/tri)");

  const fixedVerts = fixed.mesh.vertices.length / 3;
  line(`  after repair (weld)  : ${fixedVerts} verts (was ${soupVerts})`);
  assert(fixedVerts < soupVerts, "repair welded coincident vertices");

  const volPart = volumeOf(fixed.mesh);
  const volCut = volumeOf(cut.mesh);
  line(`  part volume          : ${volPart.toFixed(1)} mm³`);
  line(`  after difference     : ${volCut.toFixed(1)} mm³`);
  assert(volPart > 0, "repaired part has positive volume (valid manifold)");
  assert(volCut > 0 && volCut < volPart, "difference removed material but left a solid");

  // ---- 7: export the boolean result back to STL ----------------------------
  const outStl = writeBinarySTL(cut.mesh);
  line(`\nExport result → STL   : ${outStl.length} bytes`);
  assert(outStl.length > 100, "result STL has content");
  // round-trip sanity: re-import + repair must still be a manifold of same volume
  const reimported = parseBinarySTL(
    outStl.buffer.slice(outStl.byteOffset, outStl.byteOffset + outStl.byteLength) as ArrayBuffer,
  );
  const volReimport = volumeOf(reimported);
  assert(
    Math.abs(volReimport - volCut) < 1e-3 * volCut + 1,
    "STL round-trip preserved the volume",
  );

  // ---- 8: coplanar segmentation (mesh-domain face flagging) ----------------
  line("\nSegment a cube mesh into flat regions (mesh face flagging):");
  const cube = manifoldToMeshData(MF.Manifold.cube([10, 10, 10], true));
  const regions = segmentMesh(cube);
  line(`  cube regions found   : ${regions.length} (expected 6 faces)`);
  assert(regions.length === 6, "a cube segments into exactly 6 planar regions");
  const areaTotal = regions.reduce((s, r) => s + r.area, 0);
  assert(Math.abs(areaTotal - 600) < 1e-3, "total region area equals cube surface (6×10×10)");

  line("\n✅ spike n°2 passed — Manifold mesh bridge: import → repair → CAD×STL boolean → export.");
}

let failures = 0;
function assert(cond: boolean, msg: string) {
  if (cond) {
    line(`    ✓ ${msg}`);
  } else {
    failures++;
    line(`    ✗ FAIL: ${msg}`);
  }
}

main()
  .then(() => process.exit(failures ? 1 : 0))
  .catch((e) => {
    console.error("\n💥 smoke-mesh crashed:\n", e);
    process.exit(1);
  });
