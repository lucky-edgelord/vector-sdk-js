/** Math functions (and D.js-BDscript's $math). */
import { randomInt } from "node:crypto";
import { BDScriptError, fn, req } from "../registry";
import { fmtNum, toInt, toNum } from "../util";

const LIMIT = 2 ** 128;
const chk = (x: number) => {
  if (!Number.isFinite(x) || Math.abs(x) > LIMIT) throw new BDScriptError(Number.isNaN(x) ? "invalid result" : "number too large");
  return x;
};
const nums = (n: string[]) => n.map((x) => toNum(x));

fn("sum", (_c, ...n) => fmtNum(chk(nums(n).reduce((a, b) => a + b, 0))), req(1));
fn("sub", (_c, ...n) => fmtNum(chk(nums(n).reduce((a, b) => a - b))), req(1));
fn("multi", (_c, ...n) => fmtNum(chk(nums(n).reduce((a, b) => a * b, 1))), req(1));
fn(["divide", "div"], (_c, ...n) => fmtNum(chk(nums(n).reduce((a, b) => {
  if (b === 0) throw new BDScriptError("division by zero");
  return a / b;
}))), req(1));
fn("modulo", (_c, ...n) => fmtNum(nums(n).reduce((a, b) => {
  if (b === 0) throw new BDScriptError("division by zero");
  return a % b;
})), req(2));

// -- safe expression evaluator: numbers, + - * / % ** // ^ (power), parentheses, functions, pi/e ---------------------
const FUNCS: Record<string, (...a: number[]) => number> = {
  sqrt: Math.sqrt, abs: Math.abs, round: Math.round, floor: Math.floor, ceil: Math.ceil, sin: Math.sin, cos: Math.cos,
  tan: Math.tan, log: Math.log, log10: Math.log10, min: Math.min, max: Math.max, pow: Math.pow, exp: Math.exp,
};
const CONST: Record<string, number> = { pi: Math.PI, e: Math.E };

export function safeEval(expr: string): number {
  const src = expr.replace(/\^/g, "**").replace(/×/g, "*").replace(/÷/g, "/").replace(/,(?=\d{3}\b)/g, "");
  const toks = src.match(/\d+\.?\d*(?:e[+-]?\d+)?|\.\d+|\*\*|\/\/|<<|>>|[A-Za-z_]\w*|[-+*/%()&|,]/g) ?? [];
  if (toks.join("") !== src.replace(/\s+/g, "")) throw new BDScriptError(`invalid expression '${expr}'`);
  let i = 0;
  const peek = () => toks[i];
  const eat = (t?: string) => {
    const x = toks[i++];
    if (t !== undefined && x !== t) throw new BDScriptError(`invalid expression '${expr}'`);
    return x;
  };
  const binary = (next: () => number, ops: Record<string, (a: number, b: number) => number>) => () => {
    let v = next();
    while (peek() !== undefined && peek() in ops) {
      const op = eat();
      v = ops[op](v, next());
    }
    return v;
  };
  const atom = (): number => {
    const t = eat();
    if (t === undefined) throw new BDScriptError(`invalid expression '${expr}'`);
    if (t === "(") {
      const v = orExpr();
      eat(")");
      return v;
    }
    if (t === "-") return -unary();
    if (t === "+") return unary();
    if (/^[\d.]/.test(t)) return parseFloat(t);
    if (t in CONST) return CONST[t];
    if (t in FUNCS) {
      eat("(");
      const args: number[] = [];
      if (peek() !== ")") {
        args.push(orExpr());
        while (peek() === ",") (eat(), args.push(orExpr()));
      }
      eat(")");
      return FUNCS[t](...args);
    }
    throw new BDScriptError(`invalid expression '${expr}'`);
  };
  const unary = (): number => {
    const base = atom();
    if (peek() === "**") {
      eat();
      const exp = unary();
      if (Math.abs(exp) > 512) throw new BDScriptError("exponent too large");
      return base ** exp;
    }
    return base;
  };
  const mul = binary(unary, {
    "*": (a, b) => a * b,
    "/": (a, b) => {
      if (b === 0) throw new BDScriptError("division by zero");
      return a / b;
    },
    "//": (a, b) => {
      if (b === 0) throw new BDScriptError("division by zero");
      return Math.floor(a / b);
    },
    "%": (a, b) => {
      if (b === 0) throw new BDScriptError("division by zero");
      return ((a % b) + b) % b;
    },
  });
  const add = binary(mul, { "+": (a, b) => a + b, "-": (a, b) => a - b });
  const shift = binary(add, { "<<": (a, b) => a << b, ">>": (a, b) => a >> b });
  const andExpr = binary(shift, { "&": (a, b) => a & b });
  const orExpr = binary(andExpr, { "|": (a, b) => a | b });
  const v = orExpr();
  if (i !== toks.length) throw new BDScriptError(`invalid expression '${expr}'`);
  return chk(v);
}

fn(["calculate", "math"], (_c, ...expr) => fmtNum(safeEval(expr.join(";"))), req(1));
fn("round", (_c, n, places = "0") => {
  const p = toInt(places || "0");
  const f = 10 ** p;
  return fmtNum(Math.round(toNum(n) * f) / f);
}, req(1));
fn("ceil", (_c, n) => String(Math.ceil(toNum(n))), req(1));
fn("floor", (_c, n) => String(Math.floor(toNum(n))), req(1));
fn("sqrt", (_c, n) => {
  const x = toNum(n);
  if (x < 0) throw new BDScriptError("square root of a negative number");
  return fmtNum(Math.sqrt(x));
}, req(1));
fn("max", (_c, ...n) => fmtNum(Math.max(...nums(n))), req(1));
fn("min", (_c, ...n) => fmtNum(Math.min(...nums(n))), req(1));
fn("abs", (_c, n) => fmtNum(Math.abs(toNum(n))), req(1));

function randomValue(a: string, b: string): string {
  if (a === "" && b === "") return String(randomInt(0, 2 ** 31));
  if (b === "") [a, b] = ["0", a];
  let lo = toNum(a), hi = toNum(b);
  if (lo > hi) [lo, hi] = [hi, lo];
  if (Number.isInteger(lo) && Number.isInteger(hi) && !(a + b).includes(".")) return String(hi > lo ? randomInt(lo, hi) : lo); // max exclusive (BDFD)
  return fmtNum(lo + Math.random() * (hi - lo));
}
fn(["random", "randomComplex"], (ctx, a = "", b = "") => {
  // BDScript 2: identical $random[...] calls in one run give the same value
  const key = `random|${a}|${b}`;
  if (!ctx.extras.no_cache && ctx.randomCache.has(key)) return ctx.randomCache.get(key)!;
  const v = randomValue(a, b);
  if (!ctx.extras.no_cache) ctx.randomCache.set(key, v);
  return v;
});
export { randomValue };
