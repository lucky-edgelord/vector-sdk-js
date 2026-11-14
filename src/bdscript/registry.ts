/** Function registry: `fn("name", impl, options)` registers a BDScript function. */
import type { Brackets, Call, Node } from "./parser";
import type { Context } from "./context";

/** A function failed; reported like BDFD: "Function `$x` at 1:5 returned an error: …". */
export class BDScriptError extends Error {}

/** `$stop`, a failed `$onlyIf` and friends: end the command quietly (after sending `message`). */
export class StopExecution extends Error {
  partial = "";
  constructor(public readonly stopMessage: string | null = null) {
    super(stopMessage ?? "");
  }
}
export class BreakLoop extends Error {}
export class ContinueLoop extends Error {}

export const MAX_ITERATIONS = 10_000;

export type Impl = (ctx: Context, ...args: string[]) => unknown;
export type LazyImpl = (ctx: Context, node: Call, args: Node[][]) => unknown;

export interface FnOptions {
  brackets?: Brackets;
  /** Receives unevaluated argument node lists. */
  lazy?: boolean;
  min?: number;
  /** Maximum arguments (default: unlimited). */
  max?: number;
  /** "full" | "partial" | "noop" (Discord-only, harmless default) | "custom" */
  status?: string;
  note?: string;
}

export interface FunctionDef extends Required<Omit<FnOptions, "max">> {
  name: string;
  impl: Impl | LazyImpl;
  max: number | null;
}

export const FUNCTIONS = new Map<string, FunctionDef>();

/** Register `impl(ctx, ...args)` under every name (the first is canonical in errors). */
export function fn(names: string | string[], impl: Impl, o?: FnOptions): void;
export function fn(names: string | string[], impl: LazyImpl, o: FnOptions & { lazy: true }): void;
export function fn(names: string | string[], impl: Impl | LazyImpl, o: FnOptions = {}): void {
  for (const n of Array.isArray(names) ? names : [names]) {
    FUNCTIONS.set(n.toLowerCase(), {
      name: n, impl, brackets: o.brackets ?? "optional", lazy: o.lazy ?? false, min: o.min ?? 0, max: o.max ?? null,
      status: o.status ?? "full", note: o.note ?? "",
    });
  }
}
/** Shorthands. */
export const req = (min = 0, max?: number): FnOptions => ({ brackets: "required", min, max });
export const none: FnOptions = { brackets: "none" };

export function alias(name: string, existing: string): void {
  const f = FUNCTIONS.get(existing.toLowerCase());
  if (f) FUNCTIONS.set(name.toLowerCase(), { ...f, name });
}

export function parserNames(): Map<string, [string, Brackets]> {
  const m = new Map<string, [string, Brackets]>();
  for (const [k, f] of FUNCTIONS) m.set(k, [k, f.brackets]);
  return m;
}
