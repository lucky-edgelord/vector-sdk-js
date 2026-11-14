/** Evaluates parsed BDScript and sends the result. */
import type { Context } from "./context";
import { type Call, type If, type Loop, type Node, ParseError, Parser, type Try, unescape } from "./parser";
import { BDScriptError, BreakLoop, ContinueLoop, FUNCTIONS, MAX_ITERATIONS, StopExecution, parserNames, type Impl, type LazyImpl } from "./registry";
import { check } from "./conditions";

let PARSER: Parser | null = null;
let PARSER_SIZE = 0;
const CACHE = new Map<string, Node[]>();

function loadFunctions(): void {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require("./functions");
}

export function parser(): Parser {
  if (PARSER === null) loadFunctions();
  if (PARSER === null || PARSER_SIZE !== FUNCTIONS.size) {
    PARSER = new Parser(parserNames());
    PARSER_SIZE = FUNCTIONS.size;
    CACHE.clear();
  }
  return PARSER;
}

export function compileCode(code: string): Node[] {
  let nodes = CACHE.get(code);
  if (!nodes) {
    nodes = parser().parse(code);
    if (CACHE.size > 2048) CACHE.clear();
    CACHE.set(code, nodes);
  }
  return nodes;
}

export class FunctionError extends Error {
  constructor(public readonly call: Call, message: string) {
    super(message);
  }
  render(): string {
    return `❌ Function \`$${this.call.raw}\` at ${this.call.line}:${this.call.col} returned an error: ${this.message}`;
  }
}

// -- evaluation ----------------------------------------------------------------------------------------------------

export async function evaluate(ctx: Context, nodes: Node[]): Promise<string> {
  const out: string[] = [];
  try {
    for (const node of nodes) {
      switch (node.t) {
        case "text":
          out.push(node.value);
          break;
        case "call":
          out.push(await callFn(ctx, node));
          break;
        case "if":
          out.push(await ifBlock(ctx, node));
          break;
        case "try":
          out.push(await tryBlock(ctx, node));
          break;
        case "loop":
          out.push(await loopBlock(ctx, node));
          break;
        case "async": {
          const name = (node.call.args ? await evaluate(ctx, node.call.args[0]) : "").trim();
          const body = node.body;
          const task = evaluate(ctx, body).catch((e) => {
            if (e instanceof StopExecution || e instanceof FunctionError) return "";
            throw e;
          });
          task.catch(() => undefined);
          ctx.asyncTasks.set(name, task);
          break;
        }
      }
    }
  } catch (e) {
    if (e instanceof StopExecution) e.partial = out.join("") + e.partial;
    throw e;
  }
  return out.join("");
}

export async function callFn(ctx: Context, node: Call): Promise<string> {
  const f = FUNCTIONS.get(node.name);
  if (!f) return node.text;
  if (f.brackets === "required" && node.args === null) throw new FunctionError(node, "missing brackets");
  let result: unknown;
  try {
    if (f.lazy) {
      result = await (f.impl as LazyImpl)(ctx, node, node.args ?? []);
    } else {
      let args: string[] = [];
      for (const a of node.args ?? []) args.push(await evaluate(ctx, a));
      if (node.args !== null && args.length < f.min) throw new BDScriptError(`expected at least ${f.min} argument(s), got ${args.length}`);
      if (f.max !== null && args.length > f.max) {
        if (args.slice(f.max).every((a) => a === "")) args = args.slice(0, f.max);
        else throw new BDScriptError(`too many arguments (at most ${f.max}, got ${args.length})`);
      }
      result = await (f.impl as Impl)(ctx, ...args);
    }
  } catch (e) {
    if (e instanceof BDScriptError) throw new FunctionError(node, e.message);
    if (e instanceof StopExecution || e instanceof FunctionError || e instanceof BreakLoop || e instanceof ContinueLoop) throw e;
    const err = e as Error;
    ctx.client.emit("debug", `BDScript function $${node.raw} failed: ${err?.stack ?? err}`);
    throw new FunctionError(node, err?.name && err.name !== "Error" ? `${err.name}: ${err.message}` : err?.message ?? String(e));
  }
  if (result === null || result === undefined) return "";
  if (typeof result === "boolean") return result ? "true" : "false";
  return String(result);
}

async function ifBlock(ctx: Context, node: If): Promise<string> {
  for (const [cond, body] of node.branches) {
    const text = cond.args ? await evaluate(ctx, cond.args[0]) : "";
    let ok: boolean;
    try {
      ok = check(text);
    } catch (e) {
      throw new FunctionError(cond, (e as Error).message);
    }
    if (ok) return evaluate(ctx, body);
  }
  return node.elseBody ? evaluate(ctx, node.elseBody) : "";
}

async function loopItems(ctx: Context, node: Loop): Promise<[string | null, (string | [string, string])[] | null]> {
  const args: string[] = [];
  for (const a of node.call.args ?? []) args.push(await evaluate(ctx, a));
  if (node.kind === "loop") {
    const n = args[0]?.trim() ? Math.trunc(Number(args[0])) : 0;
    if (Number.isNaN(n)) throw new FunctionError(node.call, `invalid number '${args[0]}'`);
    return [null, Array.from({ length: Math.max(0, n) }, (_, i) => String(i + 1))];
  }
  if (node.kind === "for") {
    if (!args.length) throw new FunctionError(node.call, "missing iterator name");
    const name = args[0].trim();
    let values = args.slice(1);
    if (values.length === 2 && values.every((v) => /^-?\d+$/.test(v.trim()))) {
      const a = parseInt(values[0], 10), b = parseInt(values[1], 10);
      const step = b >= a ? 1 : -1;
      values = [];
      for (let i = a; step > 0 ? i <= b : i >= b; i += step) {
        values.push(String(i));
        if (values.length > MAX_ITERATIONS) break;
      }
    } else if (values.length === 1 && values[0].includes(",")) values = values[0].split(",").map((v) => v.trim());
    return [name, values];
  }
  if (node.kind === "jsonforeach") {
    const { walk, dump } = await import("./functions/jsonhttp");
    const [v, ok] = walk(ctx.json ?? {}, args.filter((a) => a !== ""));
    if (!ok) return [null, []];
    if (Array.isArray(v)) return ["__json__", v.map((x, i) => [String(i), dump(x)] as [string, string])];
    if (v && typeof v === "object") return ["__json__", Object.entries(v).map(([k, x]) => [k, dump(x)] as [string, string])];
    return [null, []];
  }
  return [null, null]; // while
}

async function loopBlock(ctx: Context, node: Loop): Promise<string> {
  const out: string[] = [];
  const [name, items] = await loopItems(ctx, node);
  const saved = { ...ctx.loop };
  let i = 0;
  try {
    for (;;) {
      let value: string | [string, string];
      if (items === null) {
        const cond = node.call.args ? await evaluate(ctx, node.call.args[0]) : "false";
        let ok: boolean;
        try {
          ok = check(cond);
        } catch (e) {
          throw new FunctionError(node.call, (e as Error).message);
        }
        if (!ok) break;
        value = String(i + 1);
      } else {
        if (i >= items.length) break;
        value = items[i];
      }
      if (i >= MAX_ITERATIONS) throw new FunctionError(node.call, `more than ${MAX_ITERATIONS} iterations`);
      if (name === "__json__") {
        const [k, v] = value as [string, string];
        ctx.loop = { index: i, count: items!.length, value: v, key: k };
      } else {
        ctx.loop = { index: i, count: items ? items.length : 0, value: value as string, key: String(i) };
        if (name) ctx.vars[name] = value as string;
      }
      try {
        out.push(await evaluate(ctx, node.body));
      } catch (e) {
        if (e instanceof BreakLoop) break;
        if (!(e instanceof ContinueLoop)) throw e;
      }
      i++;
    }
  } finally {
    ctx.loop = saved;
  }
  return out.join("");
}

async function tryBlock(ctx: Context, node: Try): Promise<string> {
  try {
    return await evaluate(ctx, node.body);
  } catch (e) {
    if (!(e instanceof FunctionError)) throw e;
    ctx.error = { command: `$${e.call.raw}`, message: e.message, source: e.call.source, row: String(e.call.line), column: String(e.call.col) };
    return evaluate(ctx, node.catch);
  }
}

// -- running a command -------------------------------------------------------------------------------------------

export function cleanOutput(text: string, ctx: Context): string {
  if (ctx.innerSpaceRemoval) {
    text = text.split("\n").map((l) => l.trim()).join("\n").replace(/\n{3,}/g, "\n\n");
  }
  return unescape(text.trim(), ctx.specialEscaping);
}

/** Run `code`; returns the final text. With `send` the response (text, embeds, buttons…) is sent. */
export async function run(ctx: Context, code: string, opts: { send?: boolean } = {}): Promise<string> {
  const send = opts.send ?? true;
  const { sendResponse } = await import("./output");
  let nodes: Node[];
  try {
    nodes = compileCode(code);
  } catch (e) {
    if (!(e instanceof ParseError)) throw e;
    const text = `❌ Syntax error at ${e.line}:${e.col}: ${e.message}`;
    ctx.failure = text;
    if (send && ctx.channel) await ctx.channel.send(text).catch(() => undefined);
    return text;
  }
  let text: string;
  try {
    text = await evaluate(ctx, nodes);
  } catch (e) {
    if (e instanceof StopExecution) {
      if (e.stopMessage === null) {
        text = e.partial; // $stop: send what was queued so far
      } else {
        // failed $onlyIf/$argsCheck…: send only the error message
        ctx.response.clearExtras();
        ctx.response.reactions = [];
        text = e.stopMessage;
        ctx.failure = text || "stopped";
        if (!text) ctx.response.suppress = true;
      }
    } else if (e instanceof FunctionError) {
      if (ctx.suppressErrors !== null) {
        text = ctx.suppressErrors;
        ctx.response.clearExtras();
        if (ctx.embedSuppressErrors) ctx.response.embeds.set(1, ctx.embedSuppressErrors);
        ctx.failure = e.render();
      } else if (ctx.bot.functionErrorCode && !ctx.inErrorHandler) {
        // aoi.js functionErrorCommand: a custom handler renders the error
        ctx.inErrorHandler = true;
        ctx.error = { function: `$${e.call.raw}`, command: ctx.command?.name ?? "", error: e.message, message: e.message, row: String(e.call.line), column: String(e.call.col) };
        ctx.response.clearExtras();
        try {
          text = await evaluate(ctx, compileCode(ctx.bot.functionErrorCode));
        } catch {
          text = e.render();
        }
        ctx.failure = e.render();
      } else {
        text = e.render();
        ctx.failure = text;
        ctx.response.clearExtras();
        ctx.response.mentionAuthor = false;
      }
      ctx.client.emit("debug", `BDScript error in ${ctx.command?.name ?? "?"}: ${e.render()}`);
    } else throw e;
  }
  // wait for unawaited async scopes so their side effects finish before we reply
  for (const t of ctx.asyncTasks.values()) await t.catch(() => "");
  const final = cleanOutput(text, ctx);
  if (send) await sendResponse(ctx, final);
  return final;
}
