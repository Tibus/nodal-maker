/**
 * REGISTRY entries for the "Value" category — scalar source + math nodes that
 * feed the optional param ports of other nodes.
 */
import type { NodeImpl } from "./types";

export const valueNodes: Record<string, NodeImpl> = {
  /** Scalar source nodes — feed the optional param ports of other nodes. */
  numberValue: (_inputs, params) => ({ kind: "number", value: Number(params.value ?? 0) }),
  textValue: (_inputs, params) => ({ kind: "text", value: String(params.value ?? "") }),

  /* --- math / logic (all number → number, chainable via param ports) --- */
  math: (_inputs, params) => {
    const a = Number(params.a ?? 0);
    const b = Number(params.b ?? 0);
    const op = String(params.op ?? "add");
    const r =
      op === "add" ? a + b
      : op === "subtract" ? a - b
      : op === "multiply" ? a * b
      : op === "divide" ? (b !== 0 ? a / b : 0)
      : op === "power" ? a ** b
      : op === "modulo" ? (b !== 0 ? a % b : 0)
      : op === "min" ? Math.min(a, b)
      : op === "max" ? Math.max(a, b)
      : a + b;
    return { kind: "number", value: r };
  },
  mathUnary: (_inputs, params) => {
    const x = Number(params.x ?? 0);
    const op = String(params.op ?? "abs");
    const r =
      op === "negate" ? -x
      : op === "abs" ? Math.abs(x)
      : op === "sqrt" ? Math.sqrt(Math.max(0, x))
      : op === "sin" ? Math.sin(x)
      : op === "cos" ? Math.cos(x)
      : op === "tan" ? Math.tan(x)
      : op === "round" ? Math.round(x)
      : op === "floor" ? Math.floor(x)
      : op === "ceil" ? Math.ceil(x)
      : x;
    return { kind: "number", value: r };
  },
  clamp: (_inputs, params) => {
    const v = Number(params.value ?? 0);
    const lo = Number(params.min ?? 0);
    const hi = Number(params.max ?? 1);
    return { kind: "number", value: Math.min(Math.max(v, Math.min(lo, hi)), Math.max(lo, hi)) };
  },
  remap: (_inputs, params) => {
    const v = Number(params.value ?? 0);
    const a0 = Number(params.inMin ?? 0);
    const a1 = Number(params.inMax ?? 1);
    const b0 = Number(params.outMin ?? 0);
    const b1 = Number(params.outMax ?? 1);
    const t = a1 === a0 ? 0 : (v - a0) / (a1 - a0);
    return { kind: "number", value: b0 + t * (b1 - b0) };
  },
  random: (_inputs, params) => {
    // deterministic (seeded) — mulberry32
    let s = (Number(params.seed ?? 1) >>> 0) + 0x6d2b79f5;
    s = Math.imul(s ^ (s >>> 15), s | 1);
    s ^= s + Math.imul(s ^ (s >>> 7), s | 61);
    const u = ((s ^ (s >>> 14)) >>> 0) / 4294967296;
    const lo = Number(params.min ?? 0);
    const hi = Number(params.max ?? 1);
    return { kind: "number", value: lo + u * (hi - lo) };
  },
};
