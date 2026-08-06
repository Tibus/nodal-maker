import { describe, it, expect } from "vitest";
import { evalExpr, toNumber } from "../src/kernel/expr";

describe("expression evaluator", () => {
  it("does arithmetic with correct precedence", () => {
    expect(evalExpr("1 + 2 * 3")).toBe(7);
    expect(evalExpr("(1 + 2) * 3")).toBe(9);
    expect(evalExpr("10 / 4")).toBe(2.5);
    expect(evalExpr("2 ^ 3 ^ 2")).toBe(512); // right-associative power
  });

  it("binds unary minus looser than power (so -2^2 = -4)", () => {
    expect(evalExpr("-2^2")).toBe(-4);
    expect(evalExpr("-(2^2)")).toBe(-4);
    expect(evalExpr("(-2)^2")).toBe(4);
  });

  it("resolves variables", () => {
    expect(evalExpr("width / 2 + 4", { width: 20 })).toBe(14);
    expect(evalExpr("a * b", { a: 3, b: 5 })).toBe(15);
  });

  it("supports functions and constants", () => {
    expect(evalExpr("sqrt(16)")).toBe(4);
    expect(evalExpr("max(3, 7, 2)")).toBe(7);
    expect(evalExpr("min(3, 7, 2)")).toBe(2);
    expect(evalExpr("hypot(3, 4)")).toBe(5);
    expect(evalExpr("pi")).toBeCloseTo(Math.PI, 10);
    expect(evalExpr("sind(30)")).toBeCloseTo(0.5, 10);
  });

  it("handles modulo, constants and nested calls", () => {
    expect(evalExpr("17 % 5")).toBe(2);
    expect(evalExpr("tau")).toBeCloseTo(2 * Math.PI, 10);
    expect(evalExpr("e")).toBeCloseTo(Math.E, 10);
    expect(evalExpr("atan2(1, 1)")).toBeCloseTo(Math.PI / 4, 10);
    expect(evalExpr("sqrt(max(9, 4))")).toBe(3);
    expect(evalExpr("cosd(60)")).toBeCloseTo(0.5, 10);
  });

  it("ignores surrounding whitespace and respects nested parens", () => {
    expect(evalExpr("  (2 + 3) * (4 - 1)  ")).toBe(15);
    expect(evalExpr("2 * -(3 + 1)")).toBe(-8);
  });

  it("throws on malformed input", () => {
    expect(() => evalExpr("1 +")).toThrow();
    expect(() => evalExpr("(1 + 2")).toThrow();
  });

  it("toNumber falls back for non-numeric / bad expressions", () => {
    expect(toNumber(42, {})).toBe(42);
    expect(toNumber("width * 2", { width: 5 })).toBe(10);
    expect(toNumber("nonsense!!", {}, -1)).toBe(-1);
    expect(toNumber(undefined, {}, 7)).toBe(7);
  });
});
