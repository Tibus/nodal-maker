import { describe, it, expect, beforeAll } from "vitest";
import { initKernel } from "./kernel";
import { evalToPayload, exportGraphDXF, exportGraphSVG } from "../src/kernel/model";
import { meshMassProps } from "../src/massprops";
import type { Graph } from "../src/kernel/nodes";

const payload = (g: Graph, out: string) => evalToPayload(g, out).mesh;
const tris = (g: Graph, out: string) => payload(g, out).indices.length / 3;
const volume = (g: Graph, out: string) => { const m = payload(g, out); return meshMassProps(m.vertices, m.indices).volume; };
const bbox = (g: Graph, out: string) => {
  const v = payload(g, out).vertices;
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < v.length; i += 3) for (let a = 0; a < 3; a++) { lo[a] = Math.min(lo[a], v[i + a]); hi[a] = Math.max(hi[a], v[i + a]); }
  return { lo, hi, size: [hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]] };
};
const box = (id: string, x = 20, y = 20, z = 20): Graph[number] => ({ id, type: "box", params: { x, y, z }, inputs: {} });

describe("primitives & transforms", () => {
  beforeAll(async () => { await initKernel(); });

  it("cylinder volume ≈ πr²h (faceted mesh ~within 2%)", () => {
    const g: Graph = [{ id: "c", type: "cylinder", params: { radius: 10, height: 20 }, inputs: {} }];
    const exact = Math.PI * 100 * 20;
    expect(volume(g, "c")).toBeGreaterThan(exact * 0.97);
    expect(volume(g, "c")).toBeLessThan(exact * 1.01);
  });

  it("sphere volume ≈ 4/3πr³", () => {
    const g: Graph = [{ id: "s", type: "sphere", params: { radius: 10 }, inputs: {} }];
    expect(volume(g, "s")).toBeGreaterThan((4 / 3) * Math.PI * 1000 * 0.95);
  });

  it("transform shifts the bounding box", () => {
    const g: Graph = [box("b"), { id: "t", type: "transform", params: { tx: 10, ty: 0, tz: 0 }, inputs: { in: "b" } }];
    expect(bbox(g, "t").lo[0]).toBeCloseTo(0, 1); // box spans -10..10, shifted +10 → 0..20
    expect(bbox(g, "t").hi[0]).toBeCloseTo(20, 1);
  });

  it("scale3d grows volume by the cube of the factor", () => {
    const base: Graph = [box("b", 10, 10, 10)];
    const scaled: Graph = [box("b", 10, 10, 10), { id: "s", type: "scale3d", params: { factor: 2 }, inputs: { in: "b" } }];
    expect(volume(scaled, "s")).toBeCloseTo(volume(base, "b") * 8, -2);
  });
});

describe("cuts & holes", () => {
  beforeAll(async () => { await initKernel(); });

  it("a through hole removes material", () => {
    const g: Graph = [box("b", 30, 30, 20), { id: "h", type: "hole", params: { plane: "XY", offset: 20, diameter: 8, mode: "through" }, inputs: { in: "b" } }];
    expect(volume(g, "h")).toBeLessThan(volume([box("b", 30, 30, 20)], "b"));
  });

  it("mirror3d with keep doubles the part across a plane", () => {
    const off: Graph = [{ id: "b", type: "box", params: { x: 10, y: 10, z: 10 }, inputs: {} }, { id: "t", type: "transform", params: { tx: 20 }, inputs: { in: "b" } }, { id: "m", type: "mirror3d", params: { plane: "YZ", keep: "yes" }, inputs: { in: "t" } }];
    // original at x≈15..25 plus its mirror at x≈-25..-15 → spans ~50 wide
    expect(bbox(off, "m").size[0]).toBeGreaterThan(45);
  });
});

describe("patterns", () => {
  beforeAll(async () => { await initKernel(); });

  it("array linear 3d repeats along X", () => {
    const g: Graph = [box("b", 5, 5, 5), { id: "a", type: "arrayLinear3d", params: { count: 4, dx: 10, dy: 0, dz: 0 }, inputs: { in: "b" } }];
    expect(bbox(g, "a").size[0]).toBeCloseTo(35, 0); // 4 boxes, pitch 10, width 5 → -2.5..32.5
    expect(tris(g, "a")).toBe(4 * 12);
  });

  it("array radial 3d compound keeps every copy", () => {
    const g: Graph = [box("b", 4, 4, 20), { id: "a", type: "arrayRadial3d", params: { count: 6, angle: 360, axis: "Z", merge: "no" }, inputs: { in: "b" } }];
    expect(tris(g, "a")).toBe(6 * 12);
  });

  it("array on a circular path drops N copies around it", () => {
    const g: Graph = [box("u", 3, 3, 8), { id: "p", type: "circle", params: { radius: 25 }, inputs: {} }, { id: "ap", type: "arrayPath", params: { count: 12, orient: "yes", merge: "no" }, inputs: { in: "u", path: "p" } }];
    expect(tris(g, "ap")).toBe(12 * 12);
    expect(bbox(g, "ap").size[0]).toBeGreaterThan(45); // spread around a Ø50 circle
  });
});

describe("resin/print ops", () => {
  beforeAll(async () => { await initKernel(); });

  it("split keeps only one half", () => {
    const whole: Graph = [box("b", 20, 20, 40)];
    const pos: Graph = [box("b", 20, 20, 40), { id: "s", type: "split", params: { axis: "Z", offset: 20, keep: "positive" }, inputs: { in: "b" } }];
    expect(bbox(pos, "s").size[2]).toBeCloseTo(20, 0); // top half only
    expect(volume(pos, "s")).toBeLessThan(volume(whole, "b"));
  });

  it("auto-orient lays a tall box flat", () => {
    const g: Graph = [{ id: "b", type: "box", params: { x: 10, y: 10, z: 60 }, inputs: {} }, { id: "o", type: "autoOrient", params: { heightWeight: 2 }, inputs: { in: "b" } }];
    expect(bbox(g, "o").size[2]).toBeCloseTo(10, 0); // laid down → height 10
    expect(bbox(g, "o").lo[2]).toBeCloseTo(0, 1); // rests on the plate
  });

  it("supports anchor pillars to the plate (z=0)", () => {
    const g: Graph = [{ id: "s", type: "sphere", params: { radius: 15 }, inputs: {} }, { id: "t", type: "transform", params: { tz: 25 }, inputs: { in: "s" } }, { id: "sup", type: "supports", params: { angle: 45, spacing: 6, pillarDia: 1.2, output: "supports" }, inputs: { in: "t" } }];
    expect(bbox(g, "sup").lo[2]).toBeCloseTo(0, 1);
  });

  it("infill produces an internal lattice (many triangles)", () => {
    const g: Graph = [box("b", 40, 40, 40), { id: "inf", type: "infill", params: { wall: 1.5, cell: 10 }, inputs: { in: "b" } }];
    expect(tris(g, "inf")).toBeGreaterThan(100);
  });
});

describe("solids from profiles", () => {
  beforeAll(async () => { await initKernel(); });

  it("revolve builds a solid of revolution", () => {
    const g: Graph = [{ id: "r", type: "rect", params: { width: 8, height: 20 }, inputs: {} }, { id: "p", type: "transform2d", params: { tx: 12, ty: 10, rotate: 0, scale: 1 }, inputs: { in: "r" } }, { id: "rev", type: "revolve", params: { angle: 360 }, inputs: { in: "p" } }];
    expect(volume(g, "rev")).toBeGreaterThan(0);
  });

  it("loft between two profiles has volume", () => {
    const g: Graph = [{ id: "a", type: "rect", params: { width: 30, height: 30 }, inputs: {} }, { id: "b", type: "circle", params: { radius: 8 }, inputs: {} }, { id: "l", type: "loft", params: { height: 30 }, inputs: { bottom: "a", top: "b" } }];
    expect(volume(g, "l")).toBeGreaterThan(0);
  });

  it("variable-radius fillet builds without error", () => {
    const g: Graph = [box("b", 30, 30, 30), { id: "f", type: "fillet", params: { radius: 2, radius2: 8 }, inputs: { in: "b" } }];
    expect(tris(g, "f")).toBeGreaterThan(12);
  });
});

describe("2D laser ops", () => {
  beforeAll(async () => { await initKernel(); });

  it("dogbone adds corner reliefs to a pocket", () => {
    const plain = [{ id: "r", type: "rect", params: { width: 40, height: 30 }, inputs: {} }] as Graph;
    const db: Graph = [{ id: "r", type: "rect", params: { width: 40, height: 30 }, inputs: {} }, { id: "d", type: "dogbone", params: { bitDia: 4, style: "dogbone" }, inputs: { in: "r" } }];
    expect(tris(db, "d")).toBeGreaterThan(tris(plain, "r"));
  });

  it("living hinge yields a slotted board", () => {
    const g: Graph = [{ id: "lh", type: "livingHinge", params: { width: 80, height: 40, spacing: 5, slotLen: 24, bridge: 4, kerf: 0.7 }, inputs: {} }];
    expect(evalToPayload(g, "lh").outputKind).toBe("sketch2d");
    expect(tris(g, "lh")).toBeGreaterThan(50);
  });

  it("nest packs several profiles within the sheet width", () => {
    const g: Graph = [{ id: "a", type: "rect", params: { width: 40, height: 20 }, inputs: {} }, { id: "b", type: "circle", params: { radius: 15 }, inputs: {} }, { id: "n", type: "nest", params: { sheetWidth: 120, gap: 3, copies: 2 }, inputs: { s0: "a", s1: "b" } }];
    expect(bbox(g, "n").hi[0]).toBeLessThanOrEqual(120);
  });
});

describe("mesh domain & exports", () => {
  beforeAll(async () => { await initKernel(); });

  it("mesh boolean union merges two boxes into one volume", () => {
    const g: Graph = [box("a", 20, 20, 20), { id: "b0", type: "box", params: { x: 20, y: 20, z: 20 }, inputs: {} }, { id: "b", type: "transform", params: { tx: 10 }, inputs: { in: "b0" } }, { id: "ta", type: "tessellate", inputs: { in: "a" }, params: {} }, { id: "tb", type: "tessellate", inputs: { in: "b" }, params: {} }, { id: "u", type: "boolean", params: { op: "union" }, inputs: { base: "ta", tool: "tb" } }];
    // two 20³ overlapping by 10 in x → union volume = 8000 + 8000 − 4000 = 12000
    expect(volume(g, "u")).toBeCloseTo(12000, -2);
  });

  it("colour node tags the payload tint and passes geometry through", () => {
    const g: Graph = [box("b", 10, 10, 10), { id: "c", type: "color", params: { color: "#ff0000" }, inputs: { in: "b" } }];
    const p = evalToPayload(g, "c").mesh;
    expect(p.tint).toBe("#ff0000");
    expect(p.indices.length / 3).toBe(12);
  });

  it("DXF round-trips: export a profile, re-import, extrude to a solid", () => {
    const src: Graph = [{ id: "r", type: "rect", params: { width: 50, height: 30 }, inputs: {} }, { id: "c", type: "circle", params: { radius: 8 }, inputs: {} }, { id: "b", type: "boolean2d", params: { op: "difference" }, inputs: { base: "r", tool: "c" } }];
    const dxf = exportGraphDXF(src, "b");
    expect(dxf).toContain("SECTION");
    const g: Graph = [{ id: "imp", type: "importDXF", params: { dxf }, inputs: {} }, { id: "ex", type: "extrude", params: { height: 5 }, inputs: { in: "imp" } }];
    expect(volume(g, "ex")).toBeGreaterThan(0);
  });

  it("exports a 2D profile to SVG", () => {
    const g: Graph = [{ id: "r", type: "rect", params: { width: 40, height: 30 }, inputs: {} }];
    const svg = exportGraphSVG(g, "r");
    expect(svg).toContain("<svg");
    expect(svg).toContain("path");
  });
});
