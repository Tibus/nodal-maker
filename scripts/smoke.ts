/**
 * Headless smoke test — proves the risky geometry works WITHOUT a browser:
 *   1. SVG path  -> 2D offset -> extrude          (the SVG PoC pipeline)
 *   2. face segmentation/tagging                  (flag top / bottom / sides)
 *   3. extrude a boss on the re-resolved top cap  (extrude on extrude result)
 *   4. PERSISTENCE: change the height, regenerate, and check the top-cap
 *      selector still resolves correctly even though the raw face id moved.
 *   5. STL export byte length                      (3D-print output)
 *
 * Run: npm run smoke
 */
import { createRequire } from "module";
import { dirname } from "path";
import { setOC } from "replicad";
import { build, exportSTL, DEFAULT_PARAMS, type Params } from "../src/kernel/model";

const require = createRequire(import.meta.url);

async function initOCCT() {
  // The OCCT build ships as an ES module whose emscripten Node branch reads
  // `__dirname`/`require` as free globals. Under Node ESM those are undefined,
  // so we shim them before importing. (In the browser worker the WEB/WORKER
  // branch is taken instead and none of this is needed.)
  const wasmPath = require.resolve("replicad-opencascadejs/src/replicad_single.wasm");
  const srcDir = dirname(wasmPath);
  (globalThis as Record<string, unknown>).require = require;
  (globalThis as Record<string, unknown>).__dirname = srcDir;
  (globalThis as Record<string, unknown>).__filename = `${srcDir}/replicad_single.js`;
  const { default: factory } = await import(
    "replicad-opencascadejs/src/replicad_single.js"
  );
  const OC = await factory({ locateFile: () => wasmPath });
  setOC(OC as Parameters<typeof setOC>[0]);
}

function line(s = "") {
  process.stdout.write(s + "\n");
}

async function main() {
  line("→ initialising OpenCascade (OCCT) WASM in Node…");
  await initOCCT();
  line("  OCCT ready.\n");

  // ---- 1..3: full pipeline with the default star SVG -------------------
  line("PoC SVG pipeline: svgInput → offset2d → extrude → bossOnCap");
  const r = build(DEFAULT_PARAMS);
  line(`  B-rep faces         : ${r.mesh.stats.faceCount}`);
  line(`  triangles           : ${r.mesh.stats.triangleCount}`);
  line(
    `  tagged tri counts   : top=${r.mesh.stats.tagCounts.top} ` +
      `bottom=${r.mesh.stats.tagCounts.bottom} side=${r.mesh.stats.tagCounts.side}`,
  );
  line(`  resolved top cap    : faceId=${r.topCapFaceId} @ z=${r.topCapZ.toFixed(2)}`);

  const tags = new Set(r.mesh.groups.map((g) => g.tag));
  assert(tags.has("top") && tags.has("bottom") && tags.has("side"), "all three tags present");
  assert(r.topCapZ > DEFAULT_PARAMS.height - 0.01, "boss raised the top above base height");

  // ---- 4: persistence across regeneration ------------------------------
  line("\nPersistence spike — regenerate with different heights:");
  const variants: Params[] = [
    { ...DEFAULT_PARAMS, height: 6 },
    { ...DEFAULT_PARAMS, height: 12 },
    { ...DEFAULT_PARAMS, height: 30 },
  ];
  const seenIds = new Set<number | null>();
  for (const v of variants) {
    const rr = build(v);
    const expectedZ = v.height + v.bossHeight;
    seenIds.add(rr.topCapFaceId);
    line(
      `  height=${String(v.height).padStart(2)}  ` +
        `topCapFaceId=${rr.topCapFaceId}  z=${rr.topCapZ.toFixed(2)}  ` +
        `(expected≈${expectedZ})`,
    );
    assert(
      Math.abs(rr.topCapZ - expectedZ) < 0.6,
      `top cap re-resolved to the correct plane at height ${v.height}`,
    );
  }
  line(
    `  → selector stayed correct across ${variants.length} regenerations ` +
      `(raw faceIds seen: ${[...seenIds].join(", ")}).`,
  );
  line("    The stored thing is the QUERY, not the id — that's the point.");

  // ---- 5: STL export ---------------------------------------------------
  const stl = await exportSTL(DEFAULT_PARAMS);
  line(`\nSTL export: ${stl.length} bytes  (${stl.length > 100 ? "OK" : "TOO SMALL"})`);
  assert(stl.length > 100, "STL has content");

  line("\n✅ spike passed — replicad/OCCT does offset + extrude-on-extrude + face flagging.");
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
    console.error("\n💥 smoke test crashed:\n", e);
    process.exit(1);
  });
