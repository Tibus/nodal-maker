import { describe, it, expect, beforeAll } from "vitest";
import { initKernel } from "./kernel";
import { evalToPayload } from "../src/kernel/model";
import { meshMassProps } from "../src/massprops";
import { evalGraphCached, makeEvalCache, meshAndTag, type Graph } from "../src/kernel/nodes";

const volumeOf = (g: Graph, out: string) => {
  const r = evalToPayload(g, out);
  return meshMassProps(r.mesh.vertices, r.mesh.indices).volume;
};

describe("graph evaluation (real geometry)", () => {
  beforeAll(async () => { await initKernel(); });

  it("a box has the expected volume", () => {
    const g: Graph = [{ id: "b", type: "box", params: { x: 30, y: 20, z: 10 }, inputs: {} }];
    expect(volumeOf(g, "b")).toBeCloseTo(6000, 0);
  });

  it("extrudes a rectangle profile into a solid", () => {
    const g: Graph = [
      { id: "r", type: "rect", params: { width: 40, height: 30 }, inputs: {} },
      { id: "e", type: "extrude", params: { height: 10 }, inputs: { in: "r" } },
    ];
    expect(volumeOf(g, "e")).toBeCloseTo(12000, 0);
  });

  it("boolean difference removes material", () => {
    const g: Graph = [
      { id: "a", type: "box", params: { x: 20, y: 20, z: 20 }, inputs: {} },
      { id: "c", type: "cylinder", params: { radius: 5, height: 40 }, inputs: {} },
      { id: "cc", type: "transform", params: { tz: -10 }, inputs: { in: "c" } },
      { id: "d", type: "boolean3d", params: { op: "difference" }, inputs: { base: "a", tool: "cc" } },
    ];
    const vol = volumeOf(g, "d");
    expect(vol).toBeGreaterThan(6000); // 8000 minus a Ø10 bore (~1570 mm³)
    expect(vol).toBeLessThan(7000);
  });

  it("collision outputs the overlap volume of two boxes", () => {
    const g: Graph = [
      { id: "a", type: "box", params: { x: 20, y: 20, z: 20 }, inputs: {} },
      { id: "b0", type: "box", params: { x: 20, y: 20, z: 20 }, inputs: {} },
      { id: "b", type: "transform", params: { tx: 10 }, inputs: { in: "b0" } },
      { id: "col", type: "collision", params: {}, inputs: { a: "a", b: "b" } },
    ];
    expect(volumeOf(g, "col")).toBeCloseTo(4000, 0); // 10×20×20 overlap
  });

  it("hollow turns a solid into a thin-walled shell", () => {
    const hollow: Graph = [
      { id: "b", type: "box", params: { x: 30, y: 30, z: 30 }, inputs: {} },
      { id: "h", type: "hollow", params: { wall: 2, drainDia: 0, drainCount: 0 }, inputs: { in: "b" } },
    ];
    // a closed shell has inner + outer walls → far more triangles than the 12
    // of a plain box (meshMassProps volume is unreliable on non-solid shells).
    expect(evalToPayload(hollow, "h").mesh.indices.length / 3).toBeGreaterThan(50);
  });

  it("previews a 2D profile as a flat sketch (zero thickness)", () => {
    const g: Graph = [{ id: "r", type: "rect", params: { width: 40, height: 30 }, inputs: {} }];
    const res = evalToPayload(g, "r");
    expect(res.outputKind).toBe("sketch2d");
    expect(res.mesh.isSketch).toBe(true);
    const v = res.mesh.vertices;
    let minz = Infinity, maxz = -Infinity;
    for (let i = 0; i < v.length; i += 3) { minz = Math.min(minz, v[i + 2]); maxz = Math.max(maxz, v[i + 2]); }
    expect(maxz - minz).toBeCloseTo(0, 6); // flat, no extruded thickness
  });

  it("surfaces a clear error for a node that cannot build", () => {
    const g: Graph = [{ id: "e", type: "extrude", params: { height: 10 }, inputs: {} }];
    expect(() => evalToPayload(g, "e")).toThrow(/\[extrude\]/);
  });

  it("a fillet accepts several selection nodes (union of edges)", () => {
    // box 20³; select the top 4 edges and the bottom 4 edges as TWO edgeSelect
    // nodes wired into one fillet. Filleting rounds convex edges → removes volume,
    // so filleting 8 edges must remove strictly more than filleting only 4.
    const base: Graph = [
      { id: "b", type: "box", params: { x: 20, y: 20, z: 20 }, inputs: {} },
      { id: "st", type: "edgeSelect", params: { where: "atZ", offset: 20 }, inputs: {} },
      { id: "sb", type: "edgeSelect", params: { where: "atZ", offset: 0 }, inputs: {} },
    ];
    const topOnly: Graph = [...base, { id: "f", type: "fillet", params: { radius: 2 }, inputs: { in: "b", sel: "st" } }];
    const both: Graph = [...base, { id: "f", type: "fillet", params: { radius: 2 }, inputs: { in: "b", sel: ["st", "sb"] } }];
    const vTop = volumeOf(topOnly, "f");
    const vBoth = volumeOf(both, "f");
    expect(vBoth).toBeLessThan(vTop); // more edges rounded → more material removed
    expect(vTop).toBeLessThan(8000); // and both remove some vs the raw 8000 box
  });

  it("a broken node does not blank the rest of the history", () => {
    // repro: a fillet whose edge selection was deleted rounds EVERY edge with a
    // radius too large for the geometry → it fails. Viewing the fillet must show
    // that error, but the upstream box (and any sibling) must stay viewable.
    const g: Graph = [
      { id: "b", type: "box", params: { x: 20, y: 20, z: 20 }, inputs: {} },
      { id: "f", type: "fillet", params: { radius: 50 }, inputs: { in: "b" } },
    ];
    expect(() => evalToPayload(g, "f")).toThrow(); // the broken node still errors
    expect(volumeOf(g, "b")).toBeCloseTo(8000, 0); // …but the box is unaffected
  });

  it("does not free a solid still shared by another node after a downstream node is deleted", () => {
    // repro of the "extrude object was deleted" crash: a pass-through node
    // (color) shares its input's OCCT solid; deleting it must not dispose the
    // shared object while the upstream node still holds it.
    const cache = makeEvalCache();
    const withColor: Graph = [
      { id: "b", type: "box", params: { x: 20, y: 20, z: 20 }, inputs: {} },
      { id: "c", type: "color", params: { color: "#f00" }, inputs: { in: "b" } },
    ];
    const noColor: Graph = [{ id: "b", type: "box", params: { x: 20, y: 20, z: 20 }, inputs: {} }];
    const box = () => { const v = evalGraphCached(noColor, cache).outputs["b"]; if (v.kind !== "solid") throw new Error("not a solid"); return meshAndTag(v.solid).indices.length / 3; };
    evalGraphCached(withColor, cache); // run 1: color shares the box solid
    // several runs without color → its cache entry ages out and gets evicted
    expect(box()).toBe(12); // run 2
    expect(box()).toBe(12); // run 3 — eviction of color's shared solid happens here
    expect(box()).toBe(12); // run 4 — box solid must still be alive
  });
});
