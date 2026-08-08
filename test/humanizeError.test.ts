import { describe, it, expect } from "vitest";
import { humanizeError } from "../src/kernel/nodes";

describe("humanizeError", () => {
  it("passes our own [node] messages through unchanged", () => {
    const msg = "[shell] connect a Face Select (which face(s) to open)";
    expect(humanizeError("shell", msg)).toBe(msg);
  });

  it("maps cryptic kernel aborts to a plain-language hint", () => {
    expect(humanizeError("fillet", "StdFail_NotDone")).toMatch(/radius is too large/i);
    expect(humanizeError("boolean3d", "BRep_API: command not done")).toMatch(/boolean failed|could not complete/i);
    expect(humanizeError("hollow", "BRepOffset error")).toMatch(/wall thickness/i);
  });

  it("prefixes the node type", () => {
    expect(humanizeError("extrude", "Standard_ConstructionError")).toMatch(/^\[extrude\]/);
  });

  it("surfaces the raw message when nothing matches", () => {
    expect(humanizeError("box", "something weird 12345")).toBe("[box] something weird 12345");
  });

  it("turns a bare OCCT abort pointer (a number, no text) into an actionable hint", () => {
    // emscripten aborts throw a raw heap pointer with no message text
    const msg = humanizeError("hole", "10522088");
    expect(msg).toMatch(/^\[hole\]/);
    expect(msg).not.toMatch(/10522088/);
    expect(msg).toMatch(/degenerate or self-intersecting|could not complete/i);
  });
});
