/**
 * A tiny, safe arithmetic expression evaluator for parameter fields.
 * Supports + - * / % ^, parentheses, unary minus, named variables (user
 * parameters), constants (pi, e, tau) and common functions (sqrt, sin, cos,
 * tan, abs, min, max, floor, ceil, round, hypot, atan2, …). No `eval`/`Function`
 * — a hand-written recursive-descent parser, so untrusted-ish input is safe.
 */

const FUNCS: Record<string, (...a: number[]) => number> = {
  sqrt: Math.sqrt, abs: Math.abs, sin: Math.sin, cos: Math.cos, tan: Math.tan,
  asin: Math.asin, acos: Math.acos, atan: Math.atan, atan2: Math.atan2,
  floor: Math.floor, ceil: Math.ceil, round: Math.round, sign: Math.sign,
  exp: Math.exp, log: Math.log, pow: Math.pow, hypot: Math.hypot,
  min: Math.min, max: Math.max,
  // trig helpers in degrees (handy for CAD)
  sind: (d: number) => Math.sin((d * Math.PI) / 180),
  cosd: (d: number) => Math.cos((d * Math.PI) / 180),
  tand: (d: number) => Math.tan((d * Math.PI) / 180),
};
const CONSTS: Record<string, number> = { pi: Math.PI, e: Math.E, tau: 2 * Math.PI };

type Tok = { t: "num"; v: number } | { t: "id"; v: string } | { t: "op"; v: string };

function tokenize(s: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === " " || c === "\t") { i++; continue; }
    if (/[0-9.]/.test(c)) {
      let j = i + 1;
      while (j < s.length && /[0-9.eE+\-]/.test(s[j])) {
        // allow exponent sign only right after e/E
        if ((s[j] === "+" || s[j] === "-") && !/[eE]/.test(s[j - 1])) break;
        j++;
      }
      out.push({ t: "num", v: parseFloat(s.slice(i, j)) });
      i = j;
    } else if (/[a-zA-Z_]/.test(c)) {
      let j = i + 1;
      while (j < s.length && /[a-zA-Z0-9_]/.test(s[j])) j++;
      out.push({ t: "id", v: s.slice(i, j) });
      i = j;
    } else if ("+-*/%^(),".includes(c)) {
      out.push({ t: "op", v: c });
      i++;
    } else {
      throw new Error(`unexpected character "${c}"`);
    }
  }
  return out;
}

/** Evaluate `src` with the given variables. Throws on malformed input. */
export function evalExpr(src: string, vars: Record<string, number> = {}): number {
  const toks = tokenize(src);
  let p = 0;
  const peek = () => toks[p];
  const eat = (v?: string) => {
    const tk = toks[p];
    if (!tk || (v !== undefined && !(tk.t === "op" && tk.v === v))) throw new Error(`expected "${v ?? "token"}"`);
    p++;
    return tk;
  };

  // expr := term (('+'|'-') term)*
  const parseExpr = (): number => {
    let a = parseTerm();
    while (peek()?.t === "op" && (peek() as { v: string }).v === "+" || (peek()?.t === "op" && (peek() as { v: string }).v === "-")) {
      const op = (eat() as { v: string }).v;
      const b = parseTerm();
      a = op === "+" ? a + b : a - b;
    }
    return a;
  };
  // term := unary (('*'|'/'|'%') unary)*
  const parseTerm = (): number => {
    let a = parseUnary();
    while (peek()?.t === "op" && ["*", "/", "%"].includes((peek() as { v: string }).v)) {
      const op = (eat() as { v: string }).v;
      const b = parseUnary();
      a = op === "*" ? a * b : op === "/" ? a / b : a % b;
    }
    return a;
  };
  // unary := ('-'|'+') unary | power   (unary binds looser than ^, so -2^2 = -4)
  const parseUnary = (): number => {
    if (peek()?.t === "op" && (peek() as { v: string }).v === "-") { eat("-"); return -parseUnary(); }
    if (peek()?.t === "op" && (peek() as { v: string }).v === "+") { eat("+"); return parseUnary(); }
    return parsePower();
  };
  // power := primary ('^' unary)?   (right-assoc)
  const parsePower = (): number => {
    const a = parsePrimary();
    if (peek()?.t === "op" && (peek() as { v: string }).v === "^") { eat("^"); return Math.pow(a, parseUnary()); }
    return a;
  };
  const parsePrimary = (): number => {
    const tk = peek();
    if (!tk) throw new Error("unexpected end of expression");
    if (tk.t === "num") { p++; return tk.v; }
    if (tk.t === "op" && tk.v === "(") { eat("("); const v = parseExpr(); eat(")"); return v; }
    if (tk.t === "id") {
      p++;
      const name = tk.v;
      if (peek()?.t === "op" && (peek() as { v: string }).v === "(") {
        eat("(");
        const args: number[] = [];
        if (!(peek()?.t === "op" && (peek() as { v: string }).v === ")")) {
          args.push(parseExpr());
          while (peek()?.t === "op" && (peek() as { v: string }).v === ",") { eat(","); args.push(parseExpr()); }
        }
        eat(")");
        const fn = FUNCS[name];
        if (!fn) throw new Error(`unknown function "${name}"`);
        return fn(...args);
      }
      if (name in vars) return vars[name];
      if (name.toLowerCase() in CONSTS) return CONSTS[name.toLowerCase()];
      throw new Error(`unknown name "${name}"`);
    }
    throw new Error(`unexpected token "${tk.t === "op" ? tk.v : ""}"`);
  };

  const result = parseExpr();
  if (p !== toks.length) throw new Error("unexpected trailing input");
  if (!isFinite(result)) throw new Error("result is not finite");
  return result;
}

/**
 * Coerce a param value to a number: numbers pass through; strings that are
 * plain numbers parse directly; other strings are treated as expressions and
 * evaluated with `vars`. Returns `fallback` on failure.
 */
export function toNumber(value: unknown, vars: Record<string, number>, fallback = 0): number {
  if (typeof value === "number") return value;
  if (typeof value !== "string" || value.trim() === "") return fallback;
  const direct = Number(value);
  if (!Number.isNaN(direct)) return direct;
  try {
    return evalExpr(value, vars);
  } catch {
    return fallback;
  }
}
