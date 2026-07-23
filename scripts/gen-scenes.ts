/**
 * Generates example "scene" files (the same JSON the editor's 💾 Save / 📂 Load
 * uses) and VERIFIES each one evaluates headless before writing it. Run:
 *   npx tsx scripts/gen-scenes.ts
 * Output: examples/*.json — load them in the app via 📂 Load.
 */
import { createRequire } from "module";
import { dirname } from "path";
import { mkdirSync, writeFileSync } from "fs";
import { setOC } from "replicad";
import { evalToPayload, type BuildResult } from "../src/kernel/model";
import { NODE_SPECS, SOCKET_COLORS, type Graph, type NodeDescriptor } from "../src/kernel/nodes";

const require = createRequire(import.meta.url);
const wasmPath = require.resolve("replicad-opencascadejs/src/replicad_single.wasm");
const srcDir = dirname(wasmPath);
(globalThis as Record<string, unknown>).require = require;
(globalThis as Record<string, unknown>).__dirname = srcDir;
(globalThis as Record<string, unknown>).__filename = `${srcDir}/replicad_single.js`;
const { default: factory } = await import("replicad-opencascadejs/src/replicad_single.js");
setOC((await factory({ locateFile: () => wasmPath })) as Parameters<typeof setOC>[0]);

interface Scene {
  name: string;
  title: string;
  outputId: string;
  expect: "solid" | "sketch2d" | "mesh";
  nodes: NodeDescriptor[];
}

const scenes: Scene[] = [
  {
    name: "hollow-tray",
    title: "Hollow tray (3D print) — box, shell open-top, rounded corners",
    outputId: "round",
    expect: "solid",
    nodes: [
      { id: "body", type: "box", params: { x: 70, y: 45, z: 22 } },
      { id: "topFace", type: "faceSelect", params: { where: "top", offset: 22 } },
      { id: "hollow", type: "shell", inputs: { in: "body", faces: "topFace" }, params: { thickness: 2.5 } },
      { id: "vEdges", type: "edgeSelect", params: { where: "vertical" } },
      { id: "round", type: "fillet", inputs: { in: "hollow", sel: "vEdges" }, params: { radius: 6 } },
    ],
  },
  {
    name: "name-plate",
    title: "Name plate (laser) — Score/Cut. Swap the inner shape for a Text → SVG.",
    outputId: "sc",
    expect: "sketch2d",
    nodes: [
      { id: "plate", type: "rect", params: { width: 90, height: 40, radius: 6 } },
      { id: "border", type: "rect", params: { width: 80, height: 30, radius: 4 } },
      { id: "sc", type: "scoreCut", inputs: { cut: "plate", score: "border" } },
    ],
  },
  {
    name: "living-hinge",
    title: "Living hinge panel (laser) — a field of thin slits lets flat stock bend",
    outputId: "panel",
    expect: "sketch2d",
    nodes: [
      { id: "sheet", type: "rect", params: { width: 90, height: 50, radius: 2 } },
      { id: "slit", type: "slot", params: { length: 38, width: 1.2 } },
      { id: "slitV", type: "transform2d", inputs: { in: "slit" }, params: { tx: -36, ty: 0, rotate: 90, scale: 1 } },
      { id: "slits", type: "arrayLinear2d", inputs: { in: "slitV" }, params: { count: 13, dx: 6, dy: 0 } },
      { id: "panel", type: "boolean2d", inputs: { base: "sheet", tool: "slits" }, params: { op: "difference" } },
    ],
  },
  {
    name: "bolt-flange",
    title: "Bolt flange (3D / CNC) — cylinder minus centre bore and a radial bolt circle",
    outputId: "flange",
    expect: "solid",
    nodes: [
      { id: "disc", type: "cylinder", params: { radius: 34, height: 6 } },
      { id: "bore", type: "cylinder", params: { radius: 9, height: 20 } },
      { id: "boreDown", type: "transform", inputs: { in: "bore" }, params: { tx: 0, ty: 0, tz: -5 } },
      { id: "drilled", type: "boolean3d", inputs: { base: "disc", tool: "boreDown" }, params: { op: "difference" } },
      { id: "bolt", type: "cylinder", params: { radius: 3, height: 20 } },
      { id: "boltPos", type: "transform", inputs: { in: "bolt" }, params: { tx: 24, ty: 0, tz: -5 } },
      { id: "bolts", type: "arrayRadial3d", inputs: { in: "boltPos" }, params: { count: 6, angle: 360 } },
      { id: "flange", type: "boolean3d", inputs: { base: "drilled", tool: "bolts" }, params: { op: "difference" } },
    ],
  },
  {
    name: "coaster",
    title: "Coaster (laser) — disc with a radial ring of holes",
    outputId: "coaster",
    expect: "sketch2d",
    nodes: [
      { id: "disc", type: "circle", params: { radius: 50 } },
      { id: "hole", type: "circle", params: { radius: 5 } },
      { id: "holeOut", type: "transform2d", inputs: { in: "hole" }, params: { tx: 34, ty: 0, rotate: 0, scale: 1 } },
      { id: "ring", type: "arrayRadial2d", inputs: { in: "holeOut" }, params: { count: 10, radius: 0, angle: 360 } },
      { id: "coaster", type: "boolean2d", inputs: { base: "disc", tool: "ring" }, params: { op: "difference" } },
    ],
  },
];

/** left-to-right layout: x by dependency depth, y stacked within a depth. */
function layout(nodes: NodeDescriptor[]): Record<string, { x: number; y: number }> {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const depth = new Map<string, number>();
  const compute = (id: string, seen: Set<string>): number => {
    if (depth.has(id)) return depth.get(id)!;
    if (seen.has(id)) return 0;
    seen.add(id);
    const n = byId.get(id)!;
    const ins = Object.values(n.inputs ?? {});
    const d = ins.length ? 1 + Math.max(...ins.map((s) => compute(s, seen))) : 0;
    depth.set(id, d);
    return d;
  };
  nodes.forEach((n) => compute(n.id, new Set()));
  const rowByDepth: Record<number, number> = {};
  const pos: Record<string, { x: number; y: number }> = {};
  for (const n of nodes) {
    const d = depth.get(n.id)!;
    const row = rowByDepth[d] ?? 0;
    rowByDepth[d] = row + 1;
    pos[n.id] = { x: d * 240, y: row * 150 };
  }
  return pos;
}

function toSaveDoc(scene: Scene) {
  const pos = layout(scene.nodes);
  const edges: unknown[] = [];
  let e = 0;
  for (const n of scene.nodes) {
    for (const [port, src] of Object.entries(n.inputs ?? {})) {
      const srcType = NODE_SPECS[scene.nodes.find((x) => x.id === src)!.type].output;
      edges.push({
        id: `e${e++}`,
        source: src,
        sourceHandle: "out",
        target: n.id,
        targetHandle: port,
        style: { stroke: SOCKET_COLORS[srcType] },
      });
    }
  }
  return {
    version: 1,
    title: scene.title,
    outputId: scene.outputId,
    nodes: scene.nodes.map((n) => ({
      id: n.id,
      position: pos[n.id],
      data: { nodeType: n.type, params: n.params ?? {} },
    })),
    edges,
  };
}

mkdirSync("examples", { recursive: true });
let fail = 0;
for (const scene of scenes) {
  try {
    const graph: Graph = scene.nodes;
    const res: BuildResult = evalToPayload(graph, scene.outputId);
    const kindOk = res.outputKind === scene.expect;
    const nonEmpty = res.mesh.stats.triangleCount > 0;
    const doc = toSaveDoc(scene);
    writeFileSync(`examples/${scene.name}.json`, JSON.stringify(doc, null, 2));
    console.log(
      `  ${kindOk && nonEmpty ? "✓" : "✗"} ${scene.name} — ${res.outputKind}, ${res.mesh.stats.triangleCount} tris → examples/${scene.name}.json`,
    );
    if (!kindOk || !nonEmpty) fail++;
  } catch (err) {
    fail++;
    console.log(`  ✗ ${scene.name} — threw: ${err instanceof Error ? err.message : err}`);
  }
}
console.log(fail ? `\n${fail} scene(s) failed` : "\nall scenes verified & written");
process.exit(fail ? 1 : 0);
