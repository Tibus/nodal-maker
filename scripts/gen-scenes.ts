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
  {
    name: "rounded-box",
    title: "Rounded box (3D print) — box with all edges filleted",
    outputId: "r",
    expect: "solid",
    nodes: [
      { id: "b", type: "box", params: { x: 50, y: 35, z: 20 } },
      { id: "r", type: "fillet", inputs: { in: "b" }, params: { radius: 4 } },
    ],
  },
  {
    name: "spur-gear",
    title: "Spur gear (laser/print) — 18-tooth gear extruded",
    outputId: "g3d",
    expect: "solid",
    nodes: [
      { id: "g", type: "gear", params: { teeth: 18, radius: 34, depth: 7 } },
      { id: "bore", type: "circle", params: { radius: 6 } },
      { id: "toothed", type: "boolean2d", inputs: { base: "g", tool: "bore" }, params: { op: "difference" } },
      { id: "g3d", type: "extrude", inputs: { in: "toothed" }, params: { height: 8 } },
    ],
  },
  {
    name: "vase",
    title: "Vase (3D print) — lofted from a square base to a round rim",
    outputId: "l",
    expect: "solid",
    nodes: [
      { id: "base", type: "rect", params: { width: 44, height: 44, radius: 8 } },
      { id: "rim", type: "circle", params: { radius: 26 } },
      { id: "l", type: "loft", inputs: { bottom: "base", top: "rim" }, params: { height: 70 } },
    ],
  },
  {
    name: "cup",
    title: "Cup (3D print) — cylinder hollowed open at the top",
    outputId: "cup",
    expect: "solid",
    nodes: [
      { id: "body", type: "cylinder", params: { radius: 26, height: 60 } },
      { id: "cup", type: "shell", inputs: { in: "body", faces: "body#cap" }, params: { thickness: 2.5 } },
    ],
  },
  {
    name: "washer",
    title: "Washer (laser/CNC) — annulus (disc minus centre hole)",
    outputId: "w",
    expect: "sketch2d",
    nodes: [
      { id: "outer", type: "circle", params: { radius: 24 } },
      { id: "inner", type: "circle", params: { radius: 10 } },
      { id: "w", type: "boolean2d", inputs: { base: "outer", tool: "inner" }, params: { op: "difference" } },
    ],
  },
  {
    name: "pipe",
    title: "Pipe (3D print) — tube from two concentric cylinders",
    outputId: "pipe",
    expect: "solid",
    nodes: [
      { id: "outer", type: "cylinder", params: { radius: 20, height: 60 } },
      { id: "inner", type: "cylinder", params: { radius: 16, height: 80 } },
      { id: "innerDown", type: "transform", inputs: { in: "inner" }, params: { tx: 0, ty: 0, tz: -10 } },
      { id: "pipe", type: "boolean3d", inputs: { base: "outer", tool: "innerDown" }, params: { op: "difference" } },
    ],
  },
  {
    name: "hex-standoff",
    title: "Hex standoff (3D print/CNC) — hex prism with a bore",
    outputId: "so",
    expect: "solid",
    nodes: [
      { id: "hex", type: "polygon", params: { radius: 12, sides: 6 } },
      { id: "prism", type: "extrude", inputs: { in: "hex" }, params: { height: 25 } },
      { id: "bore", type: "cylinder", params: { radius: 4, height: 40 } },
      { id: "boreDown", type: "transform", inputs: { in: "bore" }, params: { tx: 0, ty: 0, tz: -8 } },
      { id: "so", type: "boolean3d", inputs: { base: "prism", tool: "boreDown" }, params: { op: "difference" } },
    ],
  },
  {
    name: "star-badge",
    title: "Star badge (3D print) — star extruded, top rim rounded via exposed selection",
    outputId: "r",
    expect: "solid",
    nodes: [
      { id: "s", type: "star", params: { outer: 34, inner: 15, points: 5 } },
      { id: "e", type: "extrude", inputs: { in: "s" }, params: { height: 8 } },
      { id: "r", type: "fillet", inputs: { in: "e", sel: "e#capEdges" }, params: { radius: 1.5 } },
    ],
  },
  {
    name: "mandala",
    title: "Mandala (laser) — two radial rings of holes in a disc",
    outputId: "m",
    expect: "sketch2d",
    nodes: [
      { id: "disc", type: "circle", params: { radius: 55 } },
      { id: "hOut", type: "circle", params: { radius: 6 } },
      { id: "hOutP", type: "transform2d", inputs: { in: "hOut" }, params: { tx: 42, ty: 0, rotate: 0, scale: 1 } },
      { id: "ringOut", type: "arrayRadial2d", inputs: { in: "hOutP" }, params: { count: 12, radius: 0, angle: 360 } },
      { id: "hIn", type: "circle", params: { radius: 4 } },
      { id: "hInP", type: "transform2d", inputs: { in: "hIn" }, params: { tx: 24, ty: 0, rotate: 0, scale: 1 } },
      { id: "ringIn", type: "arrayRadial2d", inputs: { in: "hInP" }, params: { count: 8, radius: 0, angle: 360 } },
      { id: "rings", type: "boolean2d", inputs: { base: "ringOut", tool: "ringIn" }, params: { op: "union" } },
      { id: "m", type: "boolean2d", inputs: { base: "disc", tool: "rings" }, params: { op: "difference" } },
    ],
  },
  {
    name: "ring-torus",
    title: "Ring (3D print) — a simple torus",
    outputId: "t",
    expect: "solid",
    nodes: [{ id: "t", type: "torus", params: { radius: 22, tube: 6 } }],
  },
  {
    name: "peg-board",
    title: "Peg board (laser/CNC) — rounded plate with a grid of holes",
    outputId: "board",
    expect: "sketch2d",
    nodes: [
      { id: "plate", type: "rect", params: { width: 120, height: 80, radius: 6 } },
      { id: "hole", type: "circle", params: { radius: 4 } },
      { id: "holeP", type: "transform2d", inputs: { in: "hole" }, params: { tx: -48, ty: -28, rotate: 0, scale: 1 } },
      { id: "row", type: "arrayLinear2d", inputs: { in: "holeP" }, params: { count: 9, dx: 12, dy: 0 } },
      { id: "grid", type: "arrayLinear2d", inputs: { in: "row" }, params: { count: 5, dx: 0, dy: 14 } },
      { id: "board", type: "boolean2d", inputs: { base: "plate", tool: "grid" }, params: { op: "difference" } },
    ],
  },
  {
    name: "finger-box",
    title: "Finger-joint box (laser) — press-fit flat pattern, export DXF/SVG",
    outputId: "cut",
    expect: "sketch2d",
    nodes: [
      { id: "box", type: "fingerBox", params: { width: 90, depth: 60, height: 40, thickness: 3, finger: 12, lid: "open" } },
      { id: "cut", type: "scoreCut", inputs: { cut: "box" } },
    ],
  },
  {
    name: "closed-box",
    title: "Closed finger-joint box (laser) — all 6 panels with a lid",
    outputId: "box",
    expect: "sketch2d",
    nodes: [
      { id: "box", type: "fingerBox", params: { width: 70, depth: 70, height: 50, thickness: 4, finger: 14, lid: "closed" } },
    ],
  },
  {
    name: "revolved-bowl",
    title: "Revolved bowl (3D print) — revolve → hollow via the revolve's own 'top' port",
    outputId: "bowl",
    expect: "solid",
    nodes: [
      { id: "prof", type: "rect", params: { width: 44, height: 30, radius: 0 } },
      { id: "pos", type: "transform2d", inputs: { in: "prof" }, params: { tx: 22, ty: 15, rotate: 0, scale: 1 } },
      { id: "rev", type: "revolve", inputs: { in: "pos" }, params: { angle: 360 } },
      { id: "bowl", type: "shell", inputs: { in: "rev", faces: "rev#top" }, params: { thickness: 3 } },
    ],
  },
  {
    name: "boss-knob",
    title: "Boss knob (3D print) — boss on cap, fillet its rim via boss#topEdges",
    outputId: "knob",
    expect: "solid",
    nodes: [
      { id: "disc", type: "circle", params: { radius: 24 } },
      { id: "base", type: "extrude", inputs: { in: "disc" }, params: { height: 8 } },
      { id: "boss", type: "bossOnCap", inputs: { in: "base", profile: "disc" }, params: { height: 14, shrink: 8 } },
      { id: "knob", type: "fillet", inputs: { in: "boss", sel: "boss#topEdges" }, params: { radius: 3 } },
    ],
  },

  /* ---- complex compositions ---- */
  {
    name: "hex-grid-panel",
    title: "Hex-grid panel (laser/CNC) — plate perforated by a field of hexagons",
    outputId: "panel",
    expect: "sketch2d",
    nodes: [
      { id: "plate", type: "rect", params: { width: 120, height: 84, radius: 6 } },
      { id: "hex", type: "polygon", params: { radius: 7, sides: 6 } },
      { id: "hexP", type: "transform2d", inputs: { in: "hex" }, params: { tx: -48, ty: -30, rotate: 0, scale: 1 } },
      { id: "row", type: "arrayLinear2d", inputs: { in: "hexP" }, params: { count: 8, dx: 13.5, dy: 0 } },
      { id: "grid", type: "arrayLinear2d", inputs: { in: "row" }, params: { count: 5, dx: 0, dy: 15 } },
      { id: "panel", type: "boolean2d", inputs: { base: "plate", tool: "grid" }, params: { op: "difference" } },
    ],
  },
  {
    name: "sprocket",
    title: "Sprocket (laser/CNC) — gear with a bore and a ring of lightening holes",
    outputId: "sprocket",
    expect: "sketch2d",
    nodes: [
      { id: "gear", type: "gear", params: { teeth: 24, radius: 45, depth: 8 } },
      { id: "bore", type: "circle", params: { radius: 10 } },
      { id: "g1", type: "boolean2d", inputs: { base: "gear", tool: "bore" }, params: { op: "difference" } },
      { id: "hole", type: "circle", params: { radius: 5 } },
      { id: "holes", type: "arrayRadial2d", inputs: { in: "hole" }, params: { count: 6, radius: 28, angle: 360 } },
      { id: "sprocket", type: "boolean2d", inputs: { base: "g1", tool: "holes" }, params: { op: "difference" } },
    ],
  },
  {
    name: "star-pendant",
    title: "Star pendant (laser) — star, hanging hole, engraved inset outline",
    outputId: "sc",
    expect: "sketch2d",
    nodes: [
      { id: "outer", type: "star", params: { outer: 40, inner: 18, points: 6 } },
      { id: "hole", type: "circle", params: { radius: 3.5 } },
      { id: "holeP", type: "transform2d", inputs: { in: "hole" }, params: { tx: 0, ty: 33, rotate: 0, scale: 1 } },
      { id: "body", type: "boolean2d", inputs: { base: "outer", tool: "holeP" }, params: { op: "difference" } },
      { id: "inset", type: "offset2d", inputs: { in: "outer" }, params: { distance: -4 } },
      { id: "sc", type: "scoreCut", inputs: { cut: "body", score: "inset" } },
    ],
  },
  {
    name: "snowflake",
    title: "Snowflake (laser) — crossing bars + tips unioned into one profile",
    outputId: "flake",
    expect: "sketch2d",
    nodes: [
      // rectangle bars are centred on the origin, so a radial array makes them
      // cross the middle — a strongly-overlapping (robust) fuse, unlike rounded
      // slots whose end-arcs coincide exactly at (0,0) and break the boolean.
      { id: "arm", type: "rect", params: { width: 48, height: 4, radius: 0 } },
      { id: "arms", type: "arrayRadial2d", inputs: { in: "arm" }, params: { count: 6, radius: 0, angle: 360 } },
      { id: "tip", type: "circle", params: { radius: 5 } },
      { id: "tipP", type: "transform2d", inputs: { in: "tip" }, params: { tx: 24, ty: 0, rotate: 0, scale: 1 } },
      { id: "tips", type: "arrayRadial2d", inputs: { in: "tipP" }, params: { count: 6, radius: 0, angle: 360 } },
      { id: "flake", type: "group", inputs: { a: "arms", b: "tips" } },
    ],
  },
  {
    name: "rosette",
    title: "Rosette (laser) — 12 elliptical petals around a hub",
    outputId: "rose",
    expect: "sketch2d",
    nodes: [
      { id: "petal", type: "ellipse", params: { rx: 8, ry: 22 } },
      { id: "petalP", type: "transform2d", inputs: { in: "petal" }, params: { tx: 0, ty: 22, rotate: 0, scale: 1 } },
      { id: "petals", type: "arrayRadial2d", inputs: { in: "petalP" }, params: { count: 12, radius: 0, angle: 360 } },
      { id: "hub", type: "circle", params: { radius: 12 } },
      { id: "rose", type: "group", inputs: { a: "petals", b: "hub" } },
    ],
  },
  {
    name: "rounded-dice",
    title: "Rounded die (3D print) — filleted cube with dimpled pips",
    outputId: "die",
    expect: "solid",
    nodes: [
      { id: "body", type: "box", params: { x: 30, y: 30, z: 30 } },
      { id: "allE", type: "edgeSelect", params: { where: "all", offset: 0 } },
      { id: "rounded", type: "fillet", inputs: { in: "body", sel: "allE" }, params: { radius: 3 } },
      { id: "pip", type: "sphere", params: { radius: 3 } },
      { id: "pipP", type: "transform", inputs: { in: "pip" }, params: { tx: -8, ty: 0, tz: 30 } },
      { id: "pips", type: "arrayLinear3d", inputs: { in: "pipP" }, params: { count: 3, dx: 8, dy: 0, dz: 0 } },
      { id: "die", type: "boolean3d", inputs: { base: "rounded", tool: "pips" }, params: { op: "difference" } },
    ],
  },
  {
    name: "vent-grille",
    title: "Vent grille (3D print) — plate cut by a rank of slots",
    outputId: "grille",
    expect: "solid",
    nodes: [
      { id: "plate", type: "box", params: { x: 80, y: 50, z: 6 } },
      { id: "slot", type: "box", params: { x: 4, y: 40, z: 16 } },
      { id: "slotP", type: "transform", inputs: { in: "slot" }, params: { tx: -32, ty: 0, tz: -5 } },
      { id: "slots", type: "arrayLinear3d", inputs: { in: "slotP" }, params: { count: 9, dx: 8, dy: 0, dz: 0 } },
      { id: "grille", type: "boolean3d", inputs: { base: "plate", tool: "slots" }, params: { op: "difference" } },
    ],
  },
  {
    name: "twisted-vase",
    title: "Twisted vase (3D print) — loft from a square to a 45°-rotated square",
    outputId: "vase",
    expect: "solid",
    nodes: [
      { id: "base", type: "rect", params: { width: 44, height: 44, radius: 6 } },
      { id: "topSq", type: "rect", params: { width: 44, height: 44, radius: 6 } },
      { id: "topR", type: "transform2d", inputs: { in: "topSq" }, params: { tx: 0, ty: 0, rotate: 45, scale: 1 } },
      { id: "vase", type: "loft", inputs: { bottom: "base", top: "topR" }, params: { height: 70 } },
    ],
  },
  {
    name: "hex-tray",
    title: "Hex tray (3D print) — hexagon extruded, hollowed via the extrude's cap",
    outputId: "tray",
    expect: "solid",
    nodes: [
      { id: "hexP", type: "polygon", params: { radius: 40, sides: 6 } },
      { id: "body", type: "extrude", inputs: { in: "hexP" }, params: { height: 22 } },
      { id: "tray", type: "shell", inputs: { in: "body", faces: "body#cap" }, params: { thickness: 3 } },
    ],
  },
  {
    name: "l-bracket",
    title: "L-bracket (3D / CNC) — two plates unioned with a pair of bolt holes",
    outputId: "bracket",
    expect: "solid",
    nodes: [
      { id: "vert", type: "box", params: { x: 60, y: 8, z: 40 } },
      { id: "horiz", type: "box", params: { x: 60, y: 40, z: 8 } },
      { id: "horizP", type: "transform", inputs: { in: "horiz" }, params: { tx: 0, ty: 16, tz: 0 } },
      { id: "lshape", type: "boolean3d", inputs: { base: "vert", tool: "horizP" }, params: { op: "union" } },
      { id: "bolt", type: "cylinder", params: { radius: 4, height: 20 } },
      { id: "boltP", type: "transform", inputs: { in: "bolt" }, params: { tx: -18, ty: 24, tz: -6 } },
      { id: "bolts", type: "arrayLinear3d", inputs: { in: "boltP" }, params: { count: 2, dx: 36, dy: 0, dz: 0 } },
      { id: "bracket", type: "boolean3d", inputs: { base: "lshape", tool: "bolts" }, params: { op: "difference" } },
    ],
  },
  {
    name: "lamp-shade",
    title: "Lamp shade (3D print) — thin tube slotted by a radial array of cutters",
    outputId: "shade",
    expect: "solid",
    nodes: [
      { id: "outer", type: "cylinder", params: { radius: 40, height: 60 } },
      { id: "inner", type: "cylinder", params: { radius: 36, height: 64 } },
      { id: "innerP", type: "transform", inputs: { in: "inner" }, params: { tx: 0, ty: 0, tz: -2 } },
      { id: "tube", type: "boolean3d", inputs: { base: "outer", tool: "innerP" }, params: { op: "difference" } },
      { id: "cutter", type: "box", params: { x: 8, y: 6, z: 44 } },
      { id: "cutterP", type: "transform", inputs: { in: "cutter" }, params: { tx: 38, ty: 0, tz: 8 } },
      { id: "cutters", type: "arrayRadial3d", inputs: { in: "cutterP" }, params: { count: 12, angle: 360 } },
      { id: "shade", type: "boolean3d", inputs: { base: "tube", tool: "cutters" }, params: { op: "difference" } },
    ],
  },
  {
    name: "pen-holder",
    title: "Pen holder (3D print) — hollow cylinder with radial drainage holes",
    outputId: "holder",
    expect: "solid",
    nodes: [
      { id: "body", type: "cylinder", params: { radius: 35, height: 80 } },
      { id: "caddy", type: "shell", inputs: { in: "body", faces: "body#cap" }, params: { thickness: 3 } },
      { id: "hole", type: "cylinder", params: { radius: 4, height: 20 } },
      { id: "holeP", type: "transform", inputs: { in: "hole" }, params: { tx: 16, ty: 0, tz: -8 } },
      { id: "holes", type: "arrayRadial3d", inputs: { in: "holeP" }, params: { count: 6, angle: 360 } },
      { id: "holder", type: "boolean3d", inputs: { base: "caddy", tool: "holes" }, params: { op: "difference" } },
    ],
  },

  /* ---- mechanical parts ---- */
  {
    name: "spur-gear-hub",
    title: "Spur gear w/ hub (3D print) — gear disc + raised hub + through bore",
    outputId: "part",
    expect: "solid",
    nodes: [
      { id: "teeth", type: "gear", params: { teeth: 20, radius: 40, depth: 8 } },
      { id: "disc", type: "extrude", inputs: { in: "teeth" }, params: { height: 10 } },
      { id: "hub", type: "cylinder", params: { radius: 12, height: 16 } },
      { id: "withHub", type: "boolean3d", inputs: { base: "disc", tool: "hub" }, params: { op: "union" } },
      { id: "bore", type: "cylinder", params: { radius: 5, height: 30 } },
      { id: "boreP", type: "transform", inputs: { in: "bore" }, params: { tx: 0, ty: 0, tz: -5 } },
      { id: "part", type: "boolean3d", inputs: { base: "withHub", tool: "boreP" }, params: { op: "difference" } },
    ],
  },
  {
    name: "nema17-mount",
    title: "NEMA 17 mount (3D / CNC) — rounded plate, pilot bore, 31 mm bolt square",
    outputId: "mount",
    expect: "solid",
    nodes: [
      { id: "plate", type: "box", params: { x: 50, y: 50, z: 6 } },
      { id: "vE", type: "edgeSelect", params: { where: "vertical", offset: 0 } },
      { id: "rounded", type: "fillet", inputs: { in: "plate", sel: "vE" }, params: { radius: 5 } },
      { id: "center", type: "cylinder", params: { radius: 11, height: 20 } },
      { id: "centerP", type: "transform", inputs: { in: "center" }, params: { tx: 0, ty: 0, tz: -6 } },
      { id: "bored", type: "boolean3d", inputs: { base: "rounded", tool: "centerP" }, params: { op: "difference" } },
      { id: "hole", type: "cylinder", params: { radius: 1.6, height: 20 } },
      { id: "holeP", type: "transform", inputs: { in: "hole" }, params: { tx: 15.5, ty: 15.5, tz: -6 } },
      { id: "holes", type: "arrayRadial3d", inputs: { in: "holeP" }, params: { count: 4, angle: 360 } },
      { id: "mount", type: "boolean3d", inputs: { base: "bored", tool: "holes" }, params: { op: "difference" } },
    ],
  },
  {
    name: "pulley",
    title: "Pulley (3D print) — two flanges over a hub with a keyed bore",
    outputId: "pulley",
    expect: "solid",
    nodes: [
      { id: "flangeA", type: "cylinder", params: { radius: 18, height: 3 } },
      { id: "hub", type: "cylinder", params: { radius: 12, height: 14 } },
      { id: "hubP", type: "transform", inputs: { in: "hub" }, params: { tx: 0, ty: 0, tz: 3 } },
      { id: "b1", type: "boolean3d", inputs: { base: "flangeA", tool: "hubP" }, params: { op: "union" } },
      { id: "flangeB", type: "cylinder", params: { radius: 18, height: 3 } },
      { id: "flangeBP", type: "transform", inputs: { in: "flangeB" }, params: { tx: 0, ty: 0, tz: 17 } },
      { id: "b2", type: "boolean3d", inputs: { base: "b1", tool: "flangeBP" }, params: { op: "union" } },
      { id: "bore", type: "cylinder", params: { radius: 5, height: 30 } },
      { id: "boreP", type: "transform", inputs: { in: "bore" }, params: { tx: 0, ty: 0, tz: -5 } },
      { id: "pulley", type: "boolean3d", inputs: { base: "b2", tool: "boreP" }, params: { op: "difference" } },
    ],
  },
  {
    name: "shaft-coupler",
    title: "Shaft coupler (3D print) — twin end bores + cross set-screw holes",
    outputId: "coupler",
    expect: "solid",
    nodes: [
      { id: "body", type: "cylinder", params: { radius: 10, height: 40 } },
      { id: "boreT", type: "cylinder", params: { radius: 3.2, height: 22 } },
      { id: "boreTP", type: "transform", inputs: { in: "boreT" }, params: { tx: 0, ty: 0, tz: 22 } },
      { id: "c1", type: "boolean3d", inputs: { base: "body", tool: "boreTP" }, params: { op: "difference" } },
      { id: "boreB", type: "cylinder", params: { radius: 3.2, height: 22 } },
      { id: "boreBP", type: "transform", inputs: { in: "boreB" }, params: { tx: 0, ty: 0, tz: -4 } },
      { id: "c2", type: "boolean3d", inputs: { base: "c1", tool: "boreBP" }, params: { op: "difference" } },
      { id: "ss", type: "cylinder", params: { radius: 1.6, height: 24 } },
      { id: "ssR", type: "rotate3d", inputs: { in: "ss" }, params: { angle: 90, axis: "Y" } },
      { id: "ssTop", type: "transform", inputs: { in: "ssR" }, params: { tx: -12, ty: 0, tz: 32 } },
      { id: "c3", type: "boolean3d", inputs: { base: "c2", tool: "ssTop" }, params: { op: "difference" } },
      { id: "ssBot", type: "transform", inputs: { in: "ssR" }, params: { tx: -12, ty: 0, tz: 8 } },
      { id: "coupler", type: "boolean3d", inputs: { base: "c3", tool: "ssBot" }, params: { op: "difference" } },
    ],
  },
  {
    name: "hex-nut",
    title: "Hex nut (3D print) — hexagonal body with a through bore",
    outputId: "nut",
    expect: "solid",
    nodes: [
      { id: "hex", type: "polygon", params: { radius: 9, sides: 6 } },
      { id: "body", type: "extrude", inputs: { in: "hex" }, params: { height: 8 } },
      { id: "bore", type: "cylinder", params: { radius: 4.5, height: 20 } },
      { id: "boreP", type: "transform", inputs: { in: "bore" }, params: { tx: 0, ty: 0, tz: -6 } },
      { id: "nut", type: "boolean3d", inputs: { base: "body", tool: "boreP" }, params: { op: "difference" } },
    ],
  },
  {
    name: "hex-bolt",
    title: "Hex bolt (3D print) — hexagonal head with a cylindrical shank",
    outputId: "bolt",
    expect: "solid",
    nodes: [
      { id: "hex", type: "polygon", params: { radius: 8, sides: 6 } },
      { id: "head", type: "extrude", inputs: { in: "hex" }, params: { height: 6 } },
      { id: "shank", type: "cylinder", params: { radius: 4, height: 30 } },
      { id: "shankP", type: "transform", inputs: { in: "shank" }, params: { tx: 0, ty: 0, tz: 6 } },
      { id: "bolt", type: "boolean3d", inputs: { base: "head", tool: "shankP" }, params: { op: "union" } },
    ],
  },
  {
    name: "gear-rack",
    title: "Gear rack (3D print) — bar with a linear array of diamond teeth",
    outputId: "rack",
    expect: "solid",
    nodes: [
      { id: "bar", type: "box", params: { x: 100, y: 12, z: 8 } },
      { id: "tooth", type: "box", params: { x: 6, y: 12, z: 6 } },
      { id: "toothR", type: "rotate3d", inputs: { in: "tooth" }, params: { angle: 45, axis: "Y" } },
      { id: "toothP", type: "transform", inputs: { in: "toothR" }, params: { tx: -40, ty: 0, tz: 8 } },
      { id: "teeth", type: "arrayLinear3d", inputs: { in: "toothP" }, params: { count: 11, dx: 8, dy: 0, dz: 0 } },
      { id: "rack", type: "boolean3d", inputs: { base: "bar", tool: "teeth" }, params: { op: "union" } },
    ],
  },
  {
    name: "cam",
    title: "Eccentric cam (3D print) — two blended lobes with an off-centre bore",
    outputId: "cam",
    expect: "solid",
    nodes: [
      { id: "main", type: "cylinder", params: { radius: 20, height: 8 } },
      { id: "lobe", type: "cylinder", params: { radius: 12, height: 8 } },
      { id: "lobeP", type: "transform", inputs: { in: "lobe" }, params: { tx: 16, ty: 0, tz: 0 } },
      { id: "blob", type: "boolean3d", inputs: { base: "main", tool: "lobeP" }, params: { op: "union" } },
      { id: "bore", type: "cylinder", params: { radius: 4, height: 20 } },
      { id: "boreP", type: "transform", inputs: { in: "bore" }, params: { tx: 0, ty: 0, tz: -6 } },
      { id: "cam", type: "boolean3d", inputs: { base: "blob", tool: "boreP" }, params: { op: "difference" } },
    ],
  },
  {
    name: "flanged-pipe",
    title: "Flanged pipe (3D / CNC) — tube with a bolt-circle mounting flange",
    outputId: "pipe",
    expect: "solid",
    nodes: [
      { id: "outer", type: "cylinder", params: { radius: 12, height: 50 } },
      { id: "innerC", type: "cylinder", params: { radius: 9, height: 56 } },
      { id: "innerP", type: "transform", inputs: { in: "innerC" }, params: { tx: 0, ty: 0, tz: -3 } },
      { id: "tube", type: "boolean3d", inputs: { base: "outer", tool: "innerP" }, params: { op: "difference" } },
      { id: "flange", type: "cylinder", params: { radius: 26, height: 6 } },
      { id: "withFlange", type: "boolean3d", inputs: { base: "tube", tool: "flange" }, params: { op: "union" } },
      { id: "boltH", type: "cylinder", params: { radius: 2.5, height: 12 } },
      { id: "boltHP", type: "transform", inputs: { in: "boltH" }, params: { tx: 19, ty: 0, tz: -3 } },
      { id: "boltHoles", type: "arrayRadial3d", inputs: { in: "boltHP" }, params: { count: 4, angle: 360 } },
      { id: "pipe", type: "boolean3d", inputs: { base: "withFlange", tool: "boltHoles" }, params: { op: "difference" } },
    ],
  },
  {
    name: "bearing-housing",
    title: "Bearing housing (3D / CNC) — rounded block, counterbored seat, 4 bolts",
    outputId: "housing",
    expect: "solid",
    nodes: [
      { id: "block", type: "box", params: { x: 44, y: 44, z: 18 } },
      { id: "vE", type: "edgeSelect", params: { where: "vertical", offset: 0 } },
      { id: "rb", type: "fillet", inputs: { in: "block", sel: "vE" }, params: { radius: 6 } },
      { id: "seat", type: "cylinder", params: { radius: 13, height: 12 } },
      { id: "seatP", type: "transform", inputs: { in: "seat" }, params: { tx: 0, ty: 0, tz: 8 } },
      { id: "s1", type: "boolean3d", inputs: { base: "rb", tool: "seatP" }, params: { op: "difference" } },
      { id: "thru", type: "cylinder", params: { radius: 8, height: 30 } },
      { id: "thruP", type: "transform", inputs: { in: "thru" }, params: { tx: 0, ty: 0, tz: -6 } },
      { id: "s2", type: "boolean3d", inputs: { base: "s1", tool: "thruP" }, params: { op: "difference" } },
      { id: "bolt", type: "cylinder", params: { radius: 2.2, height: 30 } },
      { id: "boltP", type: "transform", inputs: { in: "bolt" }, params: { tx: 16, ty: 16, tz: -6 } },
      { id: "bolts", type: "arrayRadial3d", inputs: { in: "boltP" }, params: { count: 4, angle: 360 } },
      { id: "housing", type: "boolean3d", inputs: { base: "s2", tool: "bolts" }, params: { op: "difference" } },
    ],
  },

  /* ---- sweep / multi-section loft / kerf ---- */
  {
    name: "swept-handle",
    title: "Swept handle (3D print) — round profile swept along a rounded-rect path",
    outputId: "handle",
    expect: "solid",
    nodes: [
      { id: "path", type: "rect", params: { width: 90, height: 50, radius: 20 } },
      { id: "prof", type: "circle", params: { radius: 5 } },
      { id: "handle", type: "sweep", inputs: { profile: "prof", path: "path" } },
    ],
  },
  {
    name: "loft-vase",
    title: "Section-lofted vase (3D print) — circle → square → circle → circle",
    outputId: "vase",
    expect: "solid",
    nodes: [
      { id: "c0", type: "circle", params: { radius: 22 } },
      { id: "s1", type: "rect", params: { width: 40, height: 40, radius: 6 } },
      { id: "c2", type: "circle", params: { radius: 14 } },
      { id: "c3", type: "circle", params: { radius: 20 } },
      { id: "vase", type: "loftSections", inputs: { s0: "c0", s1: "s1", s2: "c2", s3: "c3" }, params: { height: 90 } },
    ],
  },
  {
    name: "kerf-gasket",
    title: "Kerf-compensated gasket (laser) — outer grows, hole shrinks by ½ kerf",
    outputId: "sc",
    expect: "sketch2d",
    nodes: [
      { id: "outer", type: "circle", params: { radius: 40 } },
      { id: "outerK", type: "kerf", inputs: { in: "outer" }, params: { kerf: 0.2, mode: "outer" } },
      { id: "inner", type: "circle", params: { radius: 25 } },
      { id: "innerK", type: "kerf", inputs: { in: "inner" }, params: { kerf: 0.2, mode: "inner" } },
      { id: "gasket", type: "boolean2d", inputs: { base: "outerK", tool: "innerK" }, params: { op: "difference" } },
      { id: "sc", type: "scoreCut", inputs: { cut: "gasket" } },
    ],
  },
  {
    name: "raised-pad",
    title: "Selection follows transform — a lifted block filleted via move#topEdges",
    outputId: "round",
    expect: "solid",
    nodes: [
      { id: "block", type: "box", params: { x: 44, y: 44, z: 12 } },
      { id: "move", type: "transform", inputs: { in: "block" }, params: { tx: 0, ty: 0, tz: 24 } },
      // the pick tracks the moved geometry: move#topEdges = block#topEdges + tz
      { id: "round", type: "fillet", inputs: { in: "move", sel: "move#topEdges" }, params: { radius: 4 } },
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
    const ins = Object.values(n.inputs ?? {}).map((s) => s.split("#")[0]);
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
    for (const [port, ref] of Object.entries(n.inputs ?? {})) {
      const hi = ref.indexOf("#");
      const src = hi < 0 ? ref : ref.slice(0, hi);
      const handle = hi < 0 ? "out" : ref.slice(hi + 1);
      const srcType =
        handle === "out" ? NODE_SPECS[scene.nodes.find((x) => x.id === src)!.type].output : "selection";
      edges.push({
        id: `e${e++}`,
        source: src,
        sourceHandle: handle,
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
