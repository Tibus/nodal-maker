import { describe, it, expect } from "vitest";
import { writeBinarySTL, parseBinarySTL } from "../src/kernel/stl";
import { build3MF } from "../src/export3mf";

// a minimal two-triangle quad mesh
const mesh = {
  vertices: new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0]),
  indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
};

describe("binary STL", () => {
  it("writes the correct byte layout (80 header + 4 count + 50/tri)", () => {
    const stl = writeBinarySTL(mesh);
    expect(stl.byteLength).toBe(84 + 2 * 50);
    const count = new DataView(stl.buffer, stl.byteOffset).getUint32(80, true);
    expect(count).toBe(2);
  });

  it("round-trips through parse without losing triangles", () => {
    const stl = writeBinarySTL(mesh);
    const md = parseBinarySTL(stl.slice().buffer as ArrayBuffer);
    expect(md.indices.length / 3).toBe(2);
    expect(md.vertices.length / 3).toBe(6); // parse emits per-triangle verts
  });
});

describe("3MF package", () => {
  it("is a ZIP (PK signature) carrying a 3D model part", () => {
    const pkg = build3MF(mesh.vertices, mesh.indices);
    expect(pkg[0]).toBe(0x50); // 'P'
    expect(pkg[1]).toBe(0x4b); // 'K'
    const text = new TextDecoder("latin1").decode(pkg);
    expect(text).toContain("3D/3dmodel.model");
    expect(text).toContain("[Content_Types].xml");
    expect(text).toContain("<vertex"); // store-only zip → XML is verbatim
  });

  it("emits one <triangle> per face", () => {
    const text = new TextDecoder("latin1").decode(build3MF(mesh.vertices, mesh.indices));
    expect((text.match(/<triangle /g) ?? []).length).toBe(2);
    expect((text.match(/<vertex /g) ?? []).length).toBe(4);
  });
});
