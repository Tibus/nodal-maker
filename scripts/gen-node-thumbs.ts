/**
 * Generates small preview thumbnails (one per geometry node) shown in the
 * palette hover tooltip. Solids/meshes → a flat-shaded isometric SVG (painter's
 * algorithm, pure JS — no WebGL); 2D sketches → the drawing's own SVG.
 * Output: src/kernel/nodeThumbs.generated.ts  ·  run: npx tsx scripts/gen-node-thumbs.ts
 */
import { createRequire } from "module";
import { dirname } from "path";
import { writeFileSync } from "fs";
import { setOC } from "replicad";
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
// Manifold — for the mesh-domain nodes (convexHull / decimate / subdivide)
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
  tris.sort((t1, t2) => t1.depth - t2.depth); // painter: far first
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const t of tris) for (const [u, v] of t.p) { minX = Math.min(minX, u); minY = Math.min(minY, v); maxX = Math.max(maxX, u); maxY = Math.max(maxY, v); }
  const w = maxX - minX || 1, h = maxY - minY || 1, pad = Math.max(w, h) * 0.06;
  // scale to a ~100-unit canvas + integer coords → compact SVG
  const scale = 100 / Math.max(w, h);
  const body = tris.map((t) => {
    const r = Math.round(70 * t.shade), g = Math.round(130 * t.shade), bl = Math.round(200 * t.shade);
    const pts = t.p.map(([u, v]) => `${Math.round((u - minX) * scale)},${Math.round((v - minY) * scale)}`).join(" ");
    return `<polygon points="${pts}" fill="rgb(${r},${g},${bl})"/>`;
  }).join("");
  const P = Math.round(pad * scale);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${-P} ${-P} ${Math.round(w * scale) + 2 * P} ${Math.round(h * scale) + 2 * P}" width="120" height="120">${body}</svg>`;
}

/** 2D sketch → its own SVG, styled with a translucent purple fill + stroke. */
function sketchSVG(v: Extract<GraphValue, { kind: "sketch2d" }>): string {
  const raw = v.drawing.toSVG(1);
  return raw.replace(
    "<svg ",
    '<svg style="fill:rgba(198,120,221,0.30);stroke:#c678dd;stroke-width:0.8;vector-effect:non-scaling-stroke" width="120" height="120" ',
  );
}

/** Representative mini-graphs. `S`=a 2D profile, `B`=a box, `M`=a box mesh. */
const S = (id: string): Graph[number] => ({ id, type: "rect", params: { width: 40, height: 28, radius: 4 } });
const SC = (id: string): Graph[number] => ({ id, type: "circle", params: { radius: 20 } });
const B = (id: string): Graph[number] => ({ id, type: "box", params: { x: 30, y: 22, z: 16 } });
const MESH = (id: string, src: string): Graph[number] => ({ id, type: "tessellate", inputs: { in: src } });

const REPS: Record<string, { graph: Graph; out: string }> = {
  // 2D primitives
  rect: { graph: [{ id: "n", type: "rect", params: { width: 40, height: 28, radius: 4 } }], out: "n" },
  circle: { graph: [SC("n")], out: "n" },
  ellipse: { graph: [{ id: "n", type: "ellipse", params: { rx: 26, ry: 16 } }], out: "n" },
  polygon: { graph: [{ id: "n", type: "polygon", params: { radius: 22, sides: 6 } }], out: "n" },
  star: { graph: [{ id: "n", type: "star", params: { outer: 24, inner: 11, points: 5 } }], out: "n" },
  slot: { graph: [{ id: "n", type: "slot", params: { length: 40, width: 14 } }], out: "n" },
  gear: { graph: [{ id: "n", type: "gear", params: { teeth: 12, radius: 22, depth: 5 } }], out: "n" },
  fingerBox: { graph: [{ id: "n", type: "fingerBox", params: { width: 40, depth: 30, height: 20, thickness: 3, finger: 8, lid: "open" } }], out: "n" },
  // 2D ops
  offset2d: { graph: [S("s"), { id: "n", type: "offset2d", inputs: { in: "s" }, params: { distance: 4 } }], out: "n" },
  kerf: { graph: [SC("s"), { id: "n", type: "kerf", inputs: { in: "s" }, params: { kerf: 2, mode: "outer" } }], out: "n" },
  fillet2d: { graph: [{ id: "s", type: "rect", params: { width: 40, height: 28, radius: 0 } }, { id: "n", type: "fillet2d", inputs: { in: "s" }, params: { radius: 8 } }], out: "n" },
  bevel2d: { graph: [{ id: "s", type: "rect", params: { width: 40, height: 28, radius: 0 } }, { id: "n", type: "bevel2d", inputs: { in: "s" }, params: { distance: 8 } }], out: "n" },
  boolean2d: { graph: [SC("a"), { id: "b", type: "circle", params: { radius: 12 } }, { id: "n", type: "boolean2d", inputs: { base: "a", tool: "b" }, params: { op: "difference" } }], out: "n" },
  mirror2d: { graph: [{ id: "s", type: "star", params: { outer: 20, inner: 9, points: 5 } }, { id: "n", type: "mirror2d", inputs: { in: "s" }, params: { axis: "X" } }], out: "n" },
  transform2d: { graph: [S("s"), { id: "n", type: "transform2d", inputs: { in: "s" }, params: { tx: 6, ty: 4, rotate: 20, scale: 1 } }], out: "n" },
  arrayLinear2d: { graph: [SC("s"), { id: "n", type: "arrayLinear2d", inputs: { in: "s" }, params: { count: 3, dx: 26, dy: 0 } }], out: "n" },
  arrayRadial2d: { graph: [{ id: "s", type: "circle", params: { radius: 6 } }, { id: "p", type: "transform2d", inputs: { in: "s" }, params: { tx: 22, ty: 0, rotate: 0, scale: 1 } }, { id: "n", type: "arrayRadial2d", inputs: { in: "p" }, params: { count: 6, radius: 0, angle: 360 } }], out: "n" },
  group: { graph: [SC("a"), { id: "b", type: "rect", params: { width: 40, height: 14, radius: 0 } }, { id: "n", type: "group", inputs: { a: "a", b: "b" } }], out: "n" },
  scoreCut: { graph: [S("c"), { id: "sc", type: "rect", params: { width: 28, height: 18, radius: 2 } }, { id: "n", type: "scoreCut", inputs: { cut: "c", score: "sc" } }], out: "n" },
  // 3D primitives
  box: { graph: [B("n")], out: "n" },
  cylinder: { graph: [{ id: "n", type: "cylinder", params: { radius: 16, height: 26 } }], out: "n" },
  sphere: { graph: [{ id: "n", type: "sphere", params: { radius: 18 } }], out: "n" },
  cone: { graph: [{ id: "n", type: "cone", params: { radius: 16, height: 28 } }], out: "n" },
  torus: { graph: [{ id: "n", type: "torus", params: { radius: 20, tube: 7 } }], out: "n" },
  thread: { graph: [{ id: "n", type: "thread", params: { diameter: 20, pitch: 3, length: 26, hand: "right" } }], out: "n" },
  // sketch → solid
  extrude: { graph: [S("s"), { id: "n", type: "extrude", inputs: { in: "s" }, params: { height: 16 } }], out: "n" },
  revolve: { graph: [{ id: "s", type: "rect", params: { width: 12, height: 26, radius: 0 } }, { id: "p", type: "transform2d", inputs: { in: "s" }, params: { tx: 14, ty: 13, rotate: 0, scale: 1 } }, { id: "n", type: "revolve", inputs: { in: "p" }, params: { angle: 300 } }], out: "n" },
  loft: { graph: [{ id: "a", type: "rect", params: { width: 34, height: 34, radius: 4 } }, { id: "b", type: "circle", params: { radius: 10 } }, { id: "n", type: "loft", inputs: { bottom: "a", top: "b" }, params: { height: 30 } }], out: "n" },
  loftSections: { graph: [{ id: "a", type: "circle", params: { radius: 18 } }, { id: "b", type: "rect", params: { width: 30, height: 30, radius: 3 } }, { id: "c", type: "circle", params: { radius: 12 } }, { id: "n", type: "loftSections", inputs: { s0: "a", s1: "b", s2: "c" }, params: { height: 34 } }], out: "n" },
  sweep: { graph: [{ id: "path", type: "rect", params: { width: 34, height: 22, radius: 10 } }, { id: "prof", type: "circle", params: { radius: 4 } }, { id: "n", type: "sweep", inputs: { profile: "prof", path: "path" } }], out: "n" },
  bossOnCap: { graph: [S("s"), { id: "e", type: "extrude", inputs: { in: "s" }, params: { height: 10 } }, { id: "n", type: "bossOnCap", inputs: { in: "e", profile: "s" }, params: { height: 8, shrink: 8 } }], out: "n" },
  // 3D ops
  transform: { graph: [B("b"), { id: "n", type: "transform", inputs: { in: "b" }, params: { tx: 6, ty: 0, tz: 6 } }], out: "n" },
  rotate3d: { graph: [B("b"), { id: "n", type: "rotate3d", inputs: { in: "b" }, params: { angle: 30, axis: "Z" } }], out: "n" },
  scale3d: { graph: [B("b"), { id: "n", type: "scale3d", inputs: { in: "b" }, params: { factor: 1.3 } }], out: "n" },
  mirror3d: { graph: [B("b"), { id: "n", type: "mirror3d", inputs: { in: "b" }, params: { plane: "YZ" } }], out: "n" },
  fillet: { graph: [B("b"), { id: "e", type: "edgeSelect", params: { where: "all" } }, { id: "n", type: "fillet", inputs: { in: "b", sel: "e" }, params: { radius: 4 } }], out: "n" },
  bevel: { graph: [B("b"), { id: "e", type: "edgeSelect", params: { where: "all" } }, { id: "n", type: "bevel", inputs: { in: "b", sel: "e" }, params: { distance: 4 } }], out: "n" },
  shell: { graph: [B("b"), { id: "f", type: "faceSelect", params: { where: "top", offset: 16 } }, { id: "n", type: "shell", inputs: { in: "b", faces: "f" }, params: { thickness: 2.5 } }], out: "n" },
  boolean3d: { graph: [B("a"), { id: "c", type: "cylinder", params: { radius: 8, height: 30 } }, { id: "cp", type: "transform", inputs: { in: "c" }, params: { tx: 0, ty: 0, tz: -6 } }, { id: "n", type: "boolean3d", inputs: { base: "a", tool: "cp" }, params: { op: "difference" } }], out: "n" },
  arrayLinear3d: { graph: [{ id: "c", type: "cylinder", params: { radius: 7, height: 20 } }, { id: "n", type: "arrayLinear3d", inputs: { in: "c" }, params: { count: 3, dx: 20, dy: 0, dz: 0 } }], out: "n" },
  arrayRadial3d: { graph: [{ id: "c", type: "box", params: { x: 6, y: 6, z: 24 } }, { id: "cp", type: "transform", inputs: { in: "c" }, params: { tx: 18, ty: 0, tz: 0 } }, { id: "n", type: "arrayRadial3d", inputs: { in: "cp" }, params: { count: 6, angle: 360 } }], out: "n" },
  // mesh
  tessellate: { graph: [B("b"), MESH("n", "b")], out: "n" },
  convexHull: { graph: [{ id: "s", type: "sphere", params: { radius: 16 } }, MESH("m", "s"), { id: "n", type: "convexHull", inputs: { in: "m" } }], out: "n" },
  decimate: { graph: [{ id: "s", type: "sphere", params: { radius: 18 } }, MESH("m", "s"), { id: "n", type: "decimate", inputs: { in: "m" }, params: { tolerance: 2 } }], out: "n" },
  subdivide: { graph: [B("b"), MESH("m", "b"), { id: "n", type: "subdivide", inputs: { in: "m" }, params: { n: 2 } }], out: "n" },
};

function meshOf(v: GraphValue): { vertices: ArrayLike<number>; indices: ArrayLike<number> } | null {
  if (v.kind === "solid") {
    const raw = (v.solid as unknown as { mesh: (o: unknown) => { vertices: number[]; triangles: number[] } }).mesh({ tolerance: 3, angularTolerance: 0.9 });
    return { vertices: raw.vertices, indices: raw.triangles };
  }
  if (v.kind === "mesh") return { vertices: v.mesh.vertices, indices: v.mesh.indices };
  return null;
}

const out: Record<string, string> = {};
for (const [type, rep] of Object.entries(REPS)) {
  try {
    const v = evalGraph(rep.graph).outputs[rep.out];
    if (v.kind === "sketch2d") out[type] = sketchSVG(v);
    else {
      const m = meshOf(v);
      if (m) out[type] = isoSVG(m.vertices, m.indices);
    }
    process.stdout.write(`  ✓ ${type} (${out[type]?.length ?? 0} chars)\n`);
  } catch (e) {
    process.stdout.write(`  ✗ ${type}: ${e instanceof Error ? e.message : e}\n`);
  }
}

const file =
  "// AUTO-GENERATED by scripts/gen-node-thumbs.ts — do not edit by hand.\n" +
  "// Small preview SVGs shown in the palette hover tooltip.\n" +
  `export const NODE_THUMBS: Record<string, string> = ${JSON.stringify(out, null, 0)};\n`;
writeFileSync("src/kernel/nodeThumbs.generated.ts", file);
process.stdout.write(`\nwrote src/kernel/nodeThumbs.generated.ts (${Object.keys(out).length} thumbs, ${file.length} bytes)\n`);
