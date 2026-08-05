/**
 * Generates a small preview thumbnail for every example project (examples/*.json),
 * shown in the Simple-mode model picker. Solids/meshes → flat-shaded isometric
 * render; 2D sketches → the drawing outline. Rasterised to PNG (loaded lazily by
 * the gallery, so they never touch the JS bundle — scales to a big library).
 * Output: public/thumbs/<name>.png
 * Run:    npx tsx scripts/gen-example-thumbs.ts
 */
import { createRequire } from "module";
import { dirname } from "path";
import { writeFileSync, readdirSync, readFileSync, mkdirSync } from "fs";
import { setOC } from "replicad";
import { Resvg } from "@resvg/resvg-js";
import { evalGraph, type Graph, type GraphValue } from "../src/kernel/nodes";
import { setManifold } from "../src/kernel/manifold";

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

type V3 = [number, number, number];
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a: V3): V3 => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** Flat-shaded isometric SVG of a triangle mesh. */
function isoSVG(vertices: ArrayLike<number>, indices: ArrayLike<number>): string {
  const A = Math.PI / 6, ca = Math.cos(A), sa = Math.sin(A);
  const proj = (x: number, y: number, z: number): [number, number] => [(x - y) * ca, (x + y) * sa - z];
  const light = norm([-0.4, -0.55, 0.9]);
  type T = { p: [number, number][]; shade: number; depth: number };
  const tris: T[] = [];
  for (let i = 0; i < indices.length; i += 3) {
    const a = indices[i] * 3, b = indices[i + 1] * 3, c = indices[i + 2] * 3;
    const va: V3 = [vertices[a], vertices[a + 1], vertices[a + 2]];
    const vb: V3 = [vertices[b], vertices[b + 1], vertices[b + 2]];
    const vc: V3 = [vertices[c], vertices[c + 1], vertices[c + 2]];
    const n = norm(cross(sub(vb, va), sub(vc, va)));
    const shade = 0.35 + 0.65 * Math.max(0, dot(n, light));
    tris.push({
      p: [proj(...va), proj(...vb), proj(...vc)],
      shade,
      depth: (va[0] + va[1] + va[2] + vb[0] + vb[1] + vb[2] + vc[0] + vc[1] + vc[2]) / 3,
    });
  }
  tris.sort((t1, t2) => t1.depth - t2.depth);
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const t of tris) for (const [u, v] of t.p) { minX = Math.min(minX, u); minY = Math.min(minY, v); maxX = Math.max(maxX, u); maxY = Math.max(maxY, v); }
  const w = maxX - minX || 1, h = maxY - minY || 1, pad = Math.max(w, h) * 0.06;
  const scale = 100 / Math.max(w, h);
  const body = tris.map((t) => {
    const r = Math.round(70 * t.shade), g = Math.round(130 * t.shade), bl = Math.round(200 * t.shade);
    const pts = t.p.map(([u, v]) => `${Math.round((u - minX) * scale)},${Math.round((v - minY) * scale)}`).join(" ");
    return `<polygon points="${pts}" fill="rgb(${r},${g},${bl})"/>`;
  }).join("");
  const P = Math.round(pad * scale);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${-P} ${-P} ${Math.round(w * scale) + 2 * P} ${Math.round(h * scale) + 2 * P}" width="120" height="120">${body}</svg>`;
}

/** 2D sketch → its own SVG, translucent purple. */
function sketchSVG(v: Extract<GraphValue, { kind: "sketch2d" }>): string {
  return v.drawing.toSVG(1).replace(
    "<svg ",
    '<svg style="fill:rgba(198,120,221,0.30);stroke:#c678dd;stroke-width:0.8;vector-effect:non-scaling-stroke" width="120" height="120" ',
  );
}

function meshOf(v: GraphValue): { vertices: ArrayLike<number>; indices: ArrayLike<number> } | null {
  if (v.kind === "solid") {
    const raw = (v.solid as unknown as { mesh: (o: unknown) => { vertices: number[]; triangles: number[] } }).mesh({ tolerance: 3, angularTolerance: 0.9 });
    return { vertices: raw.vertices, indices: raw.triangles };
  }
  if (v.kind === "mesh") return { vertices: v.mesh.vertices, indices: v.mesh.indices };
  return null;
}

interface Edge { source: string; target: string; sourceHandle?: string | null; targetHandle?: string | null }
interface SceneNode { id: string; type?: string; data: { nodeType: string; params: Record<string, unknown> } }
interface SceneDoc { outputId: string; nodes: SceneNode[]; edges?: Edge[] }

/** SceneDoc (nodes + edges) → kernel Graph (inputs folded onto each node). */
function sceneToGraph(doc: SceneDoc): { graph: Graph; out: string } {
  const edges = doc.edges ?? [];
  const graph = doc.nodes
    .filter((n) => (n.type ?? "geo") !== "note")
    .map((n) => {
      const inputs: Record<string, string> = {};
      for (const e of edges) {
        if (e.target === n.id && e.targetHandle)
          inputs[e.targetHandle] = e.sourceHandle && e.sourceHandle !== "out" ? `${e.source}#${e.sourceHandle}` : e.source;
      }
      return { id: n.id, type: n.data.nodeType, params: n.data.params, inputs };
    });
  return { graph: graph as Graph, out: doc.outputId };
}

/** SVG string → transparent PNG buffer at 2× the tile size (retina-crisp). */
function toPNG(svg: string): Buffer {
  return new Resvg(svg, { fitTo: { mode: "width", value: 240 }, background: "rgba(0,0,0,0)" }).render().asPng();
}

const dir = "examples";
const outDir = "public/thumbs";
mkdirSync(outDir, { recursive: true });
let ok = 0, fail = 0, bytes = 0;
for (const f of readdirSync(dir).filter((x) => x.endsWith(".json")).sort()) {
  const name = f.replace(/\.json$/, "");
  try {
    const doc = JSON.parse(readFileSync(`${dir}/${f}`, "utf8")) as SceneDoc;
    const { graph, out: oid } = sceneToGraph(doc);
    const v = evalGraph(graph).outputs[oid];
    const svg = v.kind === "sketch2d" ? sketchSVG(v) : (() => { const m = meshOf(v); return m ? isoSVG(m.vertices, m.indices) : null; })();
    if (!svg) { fail++; process.stdout.write(`  ∅ ${name} (no geometry)\n`); continue; }
    const png = toPNG(svg);
    writeFileSync(`${outDir}/${name}.png`, png);
    ok++; bytes += png.length;
    process.stdout.write(`  ✓ ${name} (${(png.length / 1024).toFixed(1)} KB)\n`);
  } catch (e) {
    fail++; process.stdout.write(`  ✗ ${name}: ${e instanceof Error ? e.message : e}\n`);
  }
}
process.stdout.write(`\nwrote ${ok} PNGs to ${outDir}/ (${(bytes / 1024).toFixed(0)} KB total, ${fail} skipped)\n`);
