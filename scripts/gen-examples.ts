/**
 * Generate complex bundled examples: build each graph in code, EVALUATE it with
 * the real kernel to guarantee it produces valid geometry (no node errors), lay
 * it out in Sugiyama-style columns, then emit examples/<name>.json in the app's
 * SceneDoc format. Run with:  npx vite-node scripts/gen-examples.ts
 */
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { initKernel } from "../test/kernel";
import { evalToPayload } from "../src/kernel/model";
import { NODE_SPECS, SOCKET_COLORS } from "../src/kernel/specs";
import { evalExpr } from "../src/kernel/expr";
import type { Graph } from "../src/kernel/nodes";

type In = Record<string, string | string[]>;
interface N { id: string; type: string; params?: Record<string, unknown>; inputs?: In }
interface UP { name: string; expr: string }
interface Ex { name: string; title: string; outputId: string; nodes: N[]; userParams?: UP[] }

/** resolve named user parameters (later ones may reference earlier) to numbers */
function resolveVars(ups: UP[] = []): Record<string, number> {
  const vars: Record<string, number> = {};
  for (const p of ups) { try { vars[p.name] = evalExpr(p.expr || "0", vars); } catch { vars[p.name] = 0; } }
  return vars;
}

/* ------------------------------------------------------------------ */
/* Example definitions                                                 */
/* ------------------------------------------------------------------ */

const EXAMPLES: Ex[] = [];

// 1) Gearbox faceplate — a round flange with a raised hub, pilot bore + keyway,
//    6 counterbored bolt holes (polar), 4 gusset ribs, and rounded rims.
EXAMPLES.push({
  name: "gearbox-faceplate",
  title: "Gearbox faceplate — hub, keyed pilot bore, 6 counterbored bolts, 4 ribs",
  outputId: "final",
  nodes: [
    { id: "plate", type: "cylinder", params: { radius: 60, height: 10 } },
    { id: "rimTop", type: "edgeSelect", params: { where: "atZ", offset: 10 } },
    { id: "plateF", type: "fillet", params: { radius: 3 }, inputs: { in: "plate", sel: "rimTop" } },
    { id: "rimBot", type: "edgeSelect", params: { where: "atZ", offset: 0 } },
    { id: "plateB", type: "bevel", params: { distance: 1.5 }, inputs: { in: "plateF", sel: "rimBot" } },
    { id: "hub", type: "cylinder", params: { radius: 22, height: 24 } },
    { id: "withHub", type: "boolean3d", params: { op: "union" }, inputs: { base: "plateB", tool: "hub" } },
    { id: "pilot", type: "cylinder", params: { radius: 12, height: 60 } },
    { id: "pilotP", type: "transform", params: { tz: -10 }, inputs: { in: "pilot" } },
    { id: "bored", type: "boolean3d", params: { op: "difference" }, inputs: { base: "withHub", tool: "pilotP" } },
    { id: "key", type: "box", params: { x: 5, y: 8, z: 60 } },
    { id: "keyP", type: "transform", params: { ty: 13 }, inputs: { in: "key" } },
    { id: "keyed", type: "boolean3d", params: { op: "difference" }, inputs: { base: "bored", tool: "keyP" } },
    { id: "bolt", type: "cylinder", params: { radius: 3.5, height: 60 } },
    { id: "boltP", type: "transform", params: { tx: 46, tz: -10 }, inputs: { in: "bolt" } },
    { id: "boltA", type: "arrayRadial3d", params: { count: 6, angle: 360 }, inputs: { in: "boltP" } },
    { id: "d1", type: "boolean3d", params: { op: "difference" }, inputs: { base: "keyed", tool: "boltA" } },
    { id: "cbore", type: "cylinder", params: { radius: 7, height: 8 } },
    { id: "cboreP", type: "transform", params: { tx: 46, tz: 4 }, inputs: { in: "cbore" } },
    { id: "cboreA", type: "arrayRadial3d", params: { count: 6, angle: 360 }, inputs: { in: "cboreP" } },
    { id: "d2", type: "boolean3d", params: { op: "difference" }, inputs: { base: "d1", tool: "cboreA" } },
    { id: "rib", type: "box", params: { x: 4, y: 34, z: 16 } },
    { id: "ribP", type: "transform", params: { ty: 40, tz: 3 }, inputs: { in: "rib" } },
    { id: "ribA", type: "arrayRadial3d", params: { count: 4, angle: 360 }, inputs: { in: "ribP" } },
    { id: "final", type: "boolean3d", params: { op: "union" }, inputs: { base: "d2", tool: "ribA" } },
  ],
});

// 2) Radial impeller — showcases the new Axis node: the rotation axis is DERIVED
//    from the hub's cylindrical face, then feeds Array Radial to spin the blades.
EXAMPLES.push({
  name: "radial-impeller",
  title: "Radial impeller — 9 blades spun about an axis derived from the hub's cylindrical face",
  outputId: "final",
  nodes: [
    { id: "hub", type: "cylinder", params: { radius: 12, height: 34 } },
    { id: "blade", type: "box", params: { x: 3, y: 22, z: 26 } },
    { id: "bladeP", type: "transform", params: { tx: 18, tz: 5 }, inputs: { in: "blade" } },
    { id: "bladeT", type: "rotate3d", params: { axis: "Z", angle: 26 }, inputs: { in: "bladeP" } },
    { id: "hubFace", type: "faceSelect", params: { where: "cylindrical" } },
    { id: "spin", type: "axis", params: {}, inputs: { on: "hub", face: "hubFace" } },
    { id: "blades", type: "arrayRadial3d", params: { count: 9, angle: 360 }, inputs: { in: "bladeT", axis: "spin" } },
    { id: "wheel", type: "boolean3d", params: { op: "union" }, inputs: { base: "hub", tool: "blades" } },
    { id: "bore", type: "cylinder", params: { radius: 4, height: 50 } },
    { id: "boreP", type: "transform", params: { tz: -8 }, inputs: { in: "bore" } },
    { id: "bored", type: "boolean3d", params: { op: "difference" }, inputs: { base: "wheel", tool: "boreP" } },
    { id: "rim", type: "edgeSelect", params: { where: "atZ", offset: 34 } },
    { id: "final", type: "fillet", params: { radius: 1.5 }, inputs: { in: "bored", sel: "rim" } },
  ],
});

// 3) Vented lid — rounded plate, a linear array of ventilation slots, and four
//    corner screw holes (two crossed linear arrays).
EXAMPLES.push({
  name: "vented-lid",
  title: "Vented lid — rounded plate, 13 vent slots, 4 corner screw holes",
  outputId: "final",
  nodes: [
    { id: "lid", type: "box", params: { x: 80, y: 60, z: 6 } },
    { id: "vEdges", type: "edgeSelect", params: { where: "vertical" } },
    { id: "lidF", type: "fillet", params: { radius: 6 }, inputs: { in: "lid", sel: "vEdges" } },
    { id: "vent", type: "box", params: { x: 3, y: 36, z: 20 } },
    { id: "ventP", type: "transform", params: { tx: -30 }, inputs: { in: "vent" } },
    { id: "vents", type: "arrayLinear3d", params: { count: 13, dx: 5, dy: 0, dz: 0 }, inputs: { in: "ventP" } },
    { id: "vented", type: "boolean3d", params: { op: "difference" }, inputs: { base: "lidF", tool: "vents" } },
    { id: "hole", type: "cylinder", params: { radius: 2, height: 20 } },
    { id: "holeP", type: "transform", params: { tx: -34, ty: -24, tz: -10 }, inputs: { in: "hole" } },
    { id: "holeRow", type: "arrayLinear3d", params: { count: 2, dx: 68, dy: 0, dz: 0 }, inputs: { in: "holeP" } },
    { id: "holeGrid", type: "arrayLinear3d", params: { count: 2, dx: 0, dy: 48, dz: 0 }, inputs: { in: "holeRow" } },
    { id: "final", type: "boolean3d", params: { op: "difference" }, inputs: { base: "vented", tool: "holeGrid" } },
  ],
});

// 4) Junction manifold block — a rounded block cross-drilled on all three axes
//    (a 3-way port), a top counterbore, four corner mounting holes, and two side
//    bosses around the Y port. Deep boolean chain — lots of nodes.
EXAMPLES.push({
  name: "manifold-block",
  title: "Junction manifold — 3-axis cross bores, counterbore, 4 mounts, 2 side bosses",
  outputId: "final",
  nodes: [
    { id: "block", type: "box", params: { x: 80, y: 50, z: 40 } },
    { id: "vE", type: "edgeSelect", params: { where: "vertical" } },
    { id: "blockF", type: "fillet", params: { radius: 8 }, inputs: { in: "block", sel: "vE" } },
    // Z through bore (block spans z 0..40, centre at z=20)
    { id: "zc", type: "cylinder", params: { radius: 7, height: 60 } },
    { id: "zcP", type: "transform", params: { tz: -10 }, inputs: { in: "zc" } },
    { id: "b1", type: "boolean3d", params: { op: "difference" }, inputs: { base: "blockF", tool: "zcP" } },
    // X cross bore: centre the cylinder, lay it along X, raise it to mid-height
    { id: "xc", type: "cylinder", params: { radius: 5, height: 100 } },
    { id: "xcC", type: "transform", params: { tz: -50 }, inputs: { in: "xc" } },
    { id: "xcR", type: "rotate3d", params: { axis: "Y", angle: 90 }, inputs: { in: "xcC" } },
    { id: "xcP", type: "transform", params: { tz: 20 }, inputs: { in: "xcR" } },
    { id: "b2", type: "boolean3d", params: { op: "difference" }, inputs: { base: "b1", tool: "xcP" } },
    // Y cross bore
    { id: "yc", type: "cylinder", params: { radius: 5, height: 100 } },
    { id: "ycC", type: "transform", params: { tz: -50 }, inputs: { in: "yc" } },
    { id: "ycR", type: "rotate3d", params: { axis: "X", angle: 90 }, inputs: { in: "ycC" } },
    { id: "ycP", type: "transform", params: { tz: 20 }, inputs: { in: "ycR" } },
    { id: "b3", type: "boolean3d", params: { op: "difference" }, inputs: { base: "b2", tool: "ycP" } },
    // top counterbore for the Z port (opens the top face at z=40)
    { id: "cb", type: "cylinder", params: { radius: 11, height: 12 } },
    { id: "cbP", type: "transform", params: { tz: 30 }, inputs: { in: "cb" } },
    { id: "b4", type: "boolean3d", params: { op: "difference" }, inputs: { base: "b3", tool: "cbP" } },
    // 4 corner mounting holes (two crossed linear arrays)
    { id: "mh", type: "cylinder", params: { radius: 3, height: 60 } },
    { id: "mhP", type: "transform", params: { tx: -34, ty: -19, tz: -10 }, inputs: { in: "mh" } },
    { id: "mhRow", type: "arrayLinear3d", params: { count: 2, dx: 68, dy: 0, dz: 0 }, inputs: { in: "mhP" } },
    { id: "mhGrid", type: "arrayLinear3d", params: { count: 2, dx: 0, dy: 38, dz: 0 }, inputs: { in: "mhRow" } },
    { id: "b5", type: "boolean3d", params: { op: "difference" }, inputs: { base: "b4", tool: "mhGrid" } },
    // two bosses around the Y port (one per Y face) at mid-height, then re-open it
    { id: "boss", type: "cylinder", params: { radius: 9, height: 6 } },
    { id: "bossC", type: "transform", params: { tz: -3 }, inputs: { in: "boss" } },
    { id: "bossR", type: "rotate3d", params: { axis: "X", angle: 90 }, inputs: { in: "bossC" } },
    { id: "bossP", type: "transform", params: { ty: 25, tz: 20 }, inputs: { in: "bossR" } },
    { id: "bosses", type: "arrayLinear3d", params: { count: 2, dx: 0, dy: -50, dz: 0 }, inputs: { in: "bossP" } },
    { id: "b6", type: "boolean3d", params: { op: "union" }, inputs: { base: "b5", tool: "bosses" } },
    { id: "final", type: "boolean3d", params: { op: "difference" }, inputs: { base: "b6", tool: "ycP" } },
  ],
});

// 5) Electronics enclosure — a rounded shell box (open top), four bored corner
//    bosses, a connector cut-out on one wall, and a row of vent slots on another.
EXAMPLES.push({
  name: "enclosure",
  title: "Electronics enclosure — shelled box, 4 bored bosses, connector cut-out, vents",
  outputId: "final",
  nodes: [
    { id: "box", type: "box", params: { x: 100, y: 70, z: 36 } },
    { id: "vE", type: "edgeSelect", params: { where: "vertical" } },
    { id: "boxF", type: "fillet", params: { radius: 5 }, inputs: { in: "box", sel: "vE" } },
    { id: "topSel", type: "faceSelect", params: { where: "top" } },
    { id: "shell", type: "shell", params: { thickness: 2.5 }, inputs: { in: "boxF", faces: "topSel" } },
    { id: "boss", type: "cylinder", params: { radius: 4.5, height: 31 } },
    { id: "bossP", type: "transform", params: { tx: -40, ty: -25, tz: 2 }, inputs: { in: "boss" } },
    { id: "bossRow", type: "arrayLinear3d", params: { count: 2, dx: 80, dy: 0, dz: 0 }, inputs: { in: "bossP" } },
    { id: "bossGrid", type: "arrayLinear3d", params: { count: 2, dx: 0, dy: 50, dz: 0 }, inputs: { in: "bossRow" } },
    { id: "withBosses", type: "boolean3d", params: { op: "union" }, inputs: { base: "shell", tool: "bossGrid" } },
    { id: "bore", type: "cylinder", params: { radius: 1.6, height: 42 } },
    { id: "boreP", type: "transform", params: { tx: -40, ty: -25, tz: -2 }, inputs: { in: "bore" } },
    { id: "boreRow", type: "arrayLinear3d", params: { count: 2, dx: 80, dy: 0, dz: 0 }, inputs: { in: "boreP" } },
    { id: "boreGrid", type: "arrayLinear3d", params: { count: 2, dx: 0, dy: 50, dz: 0 }, inputs: { in: "boreRow" } },
    { id: "bored", type: "boolean3d", params: { op: "difference" }, inputs: { base: "withBosses", tool: "boreGrid" } },
    { id: "usb", type: "box", params: { x: 18, y: 22, z: 9 } },
    { id: "usbP", type: "transform", params: { tx: 50, tz: 14 }, inputs: { in: "usb" } },
    { id: "usbCut", type: "boolean3d", params: { op: "difference" }, inputs: { base: "bored", tool: "usbP" } },
    { id: "vent", type: "box", params: { x: 8, y: 3, z: 14 } },
    { id: "ventP", type: "transform", params: { tx: -50, ty: -20, tz: 9 }, inputs: { in: "vent" } },
    { id: "vents", type: "arrayLinear3d", params: { count: 5, dx: 0, dy: 10, dz: 0 }, inputs: { in: "ventP" } },
    { id: "final", type: "boolean3d", params: { op: "difference" }, inputs: { base: "usbCut", tool: "vents" } },
  ],
});

// 6) Planet carrier — a sun gear on a round carrier ringed by 3 posted planet
//    gears (each a real involute gear extruded), with a central bore.
EXAMPLES.push({
  name: "planet-carrier",
  title: "Planet carrier — sun gear + 3 posted planet gears on a round carrier",
  outputId: "final",
  nodes: [
    { id: "carrier", type: "cylinder", params: { radius: 40, height: 6 } },
    { id: "sunG", type: "gear", params: { teeth: 18, radius: 15, depth: 5 } },
    { id: "sun", type: "extrude", params: { height: 18 }, inputs: { in: "sunG" } },
    { id: "withSun", type: "boolean3d", params: { op: "union" }, inputs: { base: "carrier", tool: "sun" } },
    { id: "post", type: "cylinder", params: { radius: 3, height: 8 } },
    { id: "postP", type: "transform", params: { tx: 25, tz: 4 }, inputs: { in: "post" } },
    { id: "posts", type: "arrayRadial3d", params: { count: 3, angle: 360 }, inputs: { in: "postP" } },
    { id: "withPosts", type: "boolean3d", params: { op: "union" }, inputs: { base: "withSun", tool: "posts" } },
    { id: "planetG", type: "gear", params: { teeth: 10, radius: 8, depth: 4 } },
    { id: "planet", type: "extrude", params: { height: 9 }, inputs: { in: "planetG" } },
    { id: "planetP", type: "transform", params: { tx: 25, tz: 8 }, inputs: { in: "planet" } },
    { id: "planets", type: "arrayRadial3d", params: { count: 3, angle: 360 }, inputs: { in: "planetP" } },
    { id: "asm", type: "boolean3d", params: { op: "union" }, inputs: { base: "withPosts", tool: "planets" } },
    { id: "coreBore", type: "cylinder", params: { radius: 5, height: 40 } },
    { id: "coreP", type: "transform", params: { tz: -6 }, inputs: { in: "coreBore" } },
    { id: "final", type: "boolean3d", params: { op: "difference" }, inputs: { base: "asm", tool: "coreP" } },
  ],
});

// 7) Knurled knob — a rounded knob fluted all round (polar array cut), a dished
//    top (sphere subtraction), and a counterbored centre bore via the Hole node.
EXAMPLES.push({
  name: "knurled-knob",
  title: "Knurled knob — 24 grip flutes, dished top, counterbored bore",
  outputId: "final",
  nodes: [
    { id: "knob", type: "cylinder", params: { radius: 20, height: 18 } },
    { id: "topRim", type: "edgeSelect", params: { where: "atZ", offset: 18 } },
    { id: "knobF", type: "fillet", params: { radius: 4 }, inputs: { in: "knob", sel: "topRim" } },
    { id: "flute", type: "cylinder", params: { radius: 2.2, height: 26 } },
    { id: "fluteP", type: "transform", params: { tx: 20, tz: -3 }, inputs: { in: "flute" } },
    { id: "flutes", type: "arrayRadial3d", params: { count: 24, angle: 360 }, inputs: { in: "fluteP" } },
    { id: "knurled", type: "boolean3d", params: { op: "difference" }, inputs: { base: "knobF", tool: "flutes" } },
    { id: "dish", type: "sphere", params: { radius: 40 } },
    { id: "dishP", type: "transform", params: { tz: 54 }, inputs: { in: "dish" } },
    { id: "dished", type: "boolean3d", params: { op: "difference" }, inputs: { base: "knurled", tool: "dishP" } },
    { id: "bore", type: "cylinder", params: { radius: 3, height: 34 } },
    { id: "boreP", type: "transform", params: { tz: -6 }, inputs: { in: "bore" } },
    { id: "bored", type: "boolean3d", params: { op: "difference" }, inputs: { base: "dished", tool: "boreP" } },
    { id: "cbore", type: "cylinder", params: { radius: 6, height: 8 } },
    { id: "cboreP", type: "transform", params: { tz: 12 }, inputs: { in: "cbore" } },
    { id: "final", type: "boolean3d", params: { op: "difference" }, inputs: { base: "bored", tool: "cboreP" } },
  ],
});

// 8) Parametric project box — EVERY dimension is driven by a named variable in
//    the ƒ Parameters panel. Edit W/D/H/wall… and the whole box + its bosses and
//    screw holes update together. Number fields hold expressions, not constants.
EXAMPLES.push({
  name: "parametric-box",
  title: "Parametric project box — driven by ƒ Parameters variables (W, D, H, wall…)",
  outputId: "final",
  userParams: [
    { name: "W", expr: "90" },      // outer width
    { name: "D", expr: "60" },      // outer depth
    { name: "H", expr: "30" },      // outer height
    { name: "wall", expr: "2.5" },  // wall / floor thickness
    { name: "rad", expr: "6" },     // corner fillet
    { name: "inset", expr: "9" },   // boss inset from the corners
    { name: "bossR", expr: "4" },   // screw-boss radius
    { name: "screwR", expr: "1.6" },// screw clearance radius
  ],
  nodes: [
    { id: "box", type: "box", params: { x: "W", y: "D", z: "H" } },
    { id: "vE", type: "edgeSelect", params: { where: "vertical" } },
    { id: "boxF", type: "fillet", params: { radius: "rad" }, inputs: { in: "box", sel: "vE" } },
    { id: "topSel", type: "faceSelect", params: { where: "top" } },
    { id: "shell", type: "shell", params: { thickness: "wall" }, inputs: { in: "boxF", faces: "topSel" } },
    { id: "boss", type: "cylinder", params: { radius: "bossR", height: "H-wall" } },
    { id: "bossP", type: "transform", params: { tx: "-(W/2-inset)", ty: "-(D/2-inset)" }, inputs: { in: "boss" } },
    { id: "bossRow", type: "arrayLinear3d", params: { count: 2, dx: "W-2*inset", dy: 0, dz: 0 }, inputs: { in: "bossP" } },
    { id: "bossGrid", type: "arrayLinear3d", params: { count: 2, dx: 0, dy: "D-2*inset", dz: 0 }, inputs: { in: "bossRow" } },
    { id: "withBosses", type: "boolean3d", params: { op: "union" }, inputs: { base: "shell", tool: "bossGrid" } },
    { id: "screw", type: "cylinder", params: { radius: "screwR", height: "H+4" } },
    { id: "screwP", type: "transform", params: { tx: "-(W/2-inset)", ty: "-(D/2-inset)", tz: -2 }, inputs: { in: "screw" } },
    { id: "screwRow", type: "arrayLinear3d", params: { count: 2, dx: "W-2*inset", dy: 0, dz: 0 }, inputs: { in: "screwP" } },
    { id: "screwGrid", type: "arrayLinear3d", params: { count: 2, dx: 0, dy: "D-2*inset", dz: 0 }, inputs: { in: "screwRow" } },
    { id: "final", type: "boolean3d", params: { op: "difference" }, inputs: { base: "withBosses", tool: "screwGrid" } },
  ],
});

/* ------------------------------------------------------------------ */
/* Build → validate → layout → emit                                    */
/* ------------------------------------------------------------------ */

const toGraph = (nodes: N[]): Graph =>
  nodes.map((n) => ({ id: n.id, type: n.type, params: n.params ?? {}, inputs: (n.inputs ?? {}) as Graph[number]["inputs"] }));

// longest-path layered layout so the emitted example opens tidy
function layout(nodes: N[]): Map<string, { x: number; y: number }> {
  const ids = new Set(nodes.map((n) => n.id));
  const preds = new Map<string, string[]>(nodes.map((n) => [n.id, []]));
  const succ = new Map<string, string[]>(nodes.map((n) => [n.id, []]));
  for (const n of nodes)
    for (const v of Object.values(n.inputs ?? {}))
      for (const s of Array.isArray(v) ? v : [v]) if (ids.has(s)) { preds.get(n.id)!.push(s); succ.get(s)!.push(n.id); }
  const indeg = new Map(nodes.map((n) => [n.id, preds.get(n.id)!.length]));
  const layer = new Map(nodes.map((n) => [n.id, 0]));
  const q = nodes.filter((n) => indeg.get(n.id) === 0).map((n) => n.id);
  while (q.length) {
    const id = q.shift()!;
    for (const t of succ.get(id)!) {
      layer.set(t, Math.max(layer.get(t)!, layer.get(id)! + 1));
      indeg.set(t, indeg.get(t)! - 1);
      if (indeg.get(t) === 0) q.push(t);
    }
  }
  const cols = new Map<number, string[]>();
  for (const n of nodes) { const l = layer.get(n.id)!; (cols.get(l) ?? cols.set(l, []).get(l)!).push(n.id); }
  const pos = new Map<string, { x: number; y: number }>();
  for (const [l, col] of cols) col.forEach((id, i) => pos.set(id, { x: l * 260, y: i * 150 }));
  return pos;
}

function toDoc(ex: Ex) {
  const pos = layout(ex.nodes);
  const nodes = ex.nodes.map((n) => ({ id: n.id, position: pos.get(n.id)!, data: { nodeType: n.type, params: n.params ?? {} } }));
  const edges: unknown[] = [];
  let e = 0;
  for (const n of ex.nodes)
    for (const [port, v] of Object.entries(n.inputs ?? {}))
      for (const src of Array.isArray(v) ? v : [v]) {
        const srcType = ex.nodes.find((x) => x.id === src)!.type;
        const stroke = SOCKET_COLORS[NODE_SPECS[srcType].output];
        edges.push({ id: `e${e++}`, source: src, sourceHandle: "out", target: n.id, targetHandle: port, style: { stroke } });
      }
  const userParams = (ex.userParams ?? []).map((p, i) => ({ id: `up${i}`, name: p.name, expr: p.expr }));
  const doc: Record<string, unknown> = { version: 1, title: ex.title, outputId: ex.outputId, nodes, edges };
  if (userParams.length) doc.userParams = userParams;
  return doc;
}

async function main() {
  await initKernel();
  const outDir = join(dirname(fileURLToPath(import.meta.url)), "..", "examples");
  for (const ex of EXAMPLES) {
    const res = evalToPayload(toGraph(ex.nodes), ex.outputId, undefined, undefined, resolveVars(ex.userParams));
    const errs = res.nodeErrors ?? {};
    const nErr = Object.keys(errs).length;
    const tris = res.mesh ? res.mesh.indices.length / 3 : 0;
    if (nErr > 0) { console.error(`❌ ${ex.name}: ${nErr} node error(s):`, errs); process.exitCode = 1; continue; }
    if (tris < 12) { console.error(`❌ ${ex.name}: suspiciously empty (${tris} tris)`); process.exitCode = 1; continue; }
    writeFileSync(join(outDir, `${ex.name}.json`), JSON.stringify(toDoc(ex), null, 2) + "\n");
    console.log(`✅ ${ex.name}: ${ex.nodes.length} nodes, ${tris} tris → examples/${ex.name}.json`);
  }
}

main();
