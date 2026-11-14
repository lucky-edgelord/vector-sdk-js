/** JSON and HTTP functions (BDScript 2). */
import { escape, unescape } from "../parser";
import { BDScriptError, fn, req, none } from "../registry";
import { toInt } from "../util";
import type { Context } from "../context";

function parseValue(v: string): unknown {
  const s = v.trim();
  if (s === "true" || s === "false") return s === "true";
  if (s === "null") return null;
  if (/^-?\d+$/.test(s)) return Number(s);
  if (/^-?\d*\.\d+$|^-?\d+\.\d*$/.test(s)) return Number(s);
  return v;
}
const keyOf = (k: string): string | number => (/^-?\d+$/.test(k.trim()) ? parseInt(k, 10) : k);

/** Walk `keys` into `root`; returns [value, found]. */
export function walk(root: any, keys: string[], create = false): [any, boolean] {
  let cur = root;
  for (const k of keys) {
    const kk = keyOf(k);
    if (Array.isArray(cur) && typeof kk === "number") {
      if (!(kk >= -cur.length && kk < cur.length)) {
        if (create) throw new BDScriptError(`index ${kk} out of range`);
        return [null, false];
      }
      cur = cur[kk < 0 ? cur.length + kk : kk];
    } else if (cur && typeof cur === "object" && !Array.isArray(cur)) {
      if (!(k in cur)) {
        if (!create) return [null, false];
        cur[k] = {};
      }
      cur = cur[k];
    } else return [null, false];
  }
  return [cur, true];
}

export function dump(v: unknown): string {
  if (typeof v === "string") return v;
  if (v === null || v === undefined) return "null";
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "number") return String(v);
  return JSON.stringify(v);
}
const root = (ctx: Context) => (ctx.json ??= {});
function set(ctx: Context, keys: string[], value: unknown): void {
  if (!keys.length) throw new BDScriptError("no key");
  const [parent] = walk(root(ctx), keys.slice(0, -1), true);
  const last = keyOf(keys[keys.length - 1]);
  if (Array.isArray(parent) && typeof last === "number") parent[last < 0 ? parent.length + last : last] = value;
  else if (parent && typeof parent === "object") parent[keys[keys.length - 1]] = value;
  else throw new BDScriptError("can't set a key on a non-object");
}
function array(ctx: Context, keys: string[], create = false): any[] {
  if (!keys.length && Array.isArray(ctx.json)) return ctx.json;
  let [v, ok] = walk(root(ctx), keys);
  if (!ok && create) {
    set(ctx, keys, []);
    [v] = walk(root(ctx), keys);
  }
  if (!Array.isArray(v)) throw new BDScriptError(`'${keys.join(".")}' isn't an array`);
  return v;
}
const last = (a: string[]): [string[], string] => [a.slice(0, -1), a[a.length - 1]];

fn("jsonParse", (ctx, ...text) => {
  try {
    ctx.json = JSON.parse(unescape(text.join(";"), false));
  } catch (e) {
    throw new BDScriptError(`invalid JSON: ${(e as Error).message}`);
  }
  return "";
}, req(1));
fn("json", (ctx, ...keys) => {
  const [v, ok] = walk(root(ctx), keys.filter((k) => k !== ""));
  return ok ? escape(dump(v)) : "";
}, req());
fn("jsonExists", (ctx, ...keys) => walk(root(ctx), keys)[1], req(1));
fn("jsonSet", (ctx, ...a) => {
  const [keys, v] = last(a);
  set(ctx, keys, parseValue(v));
  return "";
}, req(2));
fn("jsonSetString", (ctx, ...a) => {
  const [keys, v] = last(a);
  set(ctx, keys, v);
  return "";
}, req(2));
fn("jsonUnset", (ctx, ...keys) => {
  const [parent, ok] = walk(root(ctx), keys.slice(0, -1));
  if (ok) {
    const lk = keyOf(keys[keys.length - 1]);
    if (Array.isArray(parent) && typeof lk === "number" && lk >= -parent.length && lk < parent.length) parent.splice(lk < 0 ? parent.length + lk : lk, 1);
    else if (parent && typeof parent === "object") delete parent[keys[keys.length - 1]];
  }
  return "";
}, req(1));
fn("jsonClear", (ctx) => ((ctx.json = {}), ""), none);
fn("jsonStringify", (ctx) => escape(JSON.stringify(root(ctx))), none);
fn("jsonPretty", (ctx, indent = "2") => escape(JSON.stringify(root(ctx), null, toInt(indent || "2"))));
fn("jsonArray", (ctx, ...keys) => (set(ctx, keys, []), ""), req(1));
fn("jsonArrayCount", (ctx, ...keys) => {
  const [v, ok] = walk(root(ctx), keys);
  return ok && Array.isArray(v) ? String(v.length) : "0";
}, req(1));
fn("jsonArrayIndex", (ctx, ...a) => {
  const [keys, value] = last(a);
  const target = parseValue(value);
  return String(array(ctx, keys).findIndex((x) => x === target || dump(x) === value));
}, req(2));
fn("jsonArrayAppend", (ctx, ...a) => {
  const [keys, v] = last(a);
  array(ctx, keys, true).push(parseValue(v));
  return "";
}, req(2));
fn("jsonArrayUnshift", (ctx, ...a) => {
  const [keys, v] = last(a);
  array(ctx, keys, true).unshift(parseValue(v));
  return "";
}, req(2));
fn("jsonArrayPop", (ctx, ...keys) => {
  const arr = array(ctx, keys);
  return arr.length ? escape(dump(arr.pop())) : "";
}, req(1));
fn("jsonArrayShift", (ctx, ...keys) => {
  const arr = array(ctx, keys);
  return arr.length ? escape(dump(arr.shift())) : "";
}, req(1));
fn("jsonArraySort", (ctx, ...keys) => {
  const arr = array(ctx, keys);
  arr.sort((a, b) => (typeof a === "number" && typeof b === "number" ? a - b : dump(a).localeCompare(dump(b))));
  return "";
}, req(1));
fn("jsonArrayReverse", (ctx, ...keys) => (array(ctx, keys).reverse(), ""), req(1));
fn("jsonJoinArray", (ctx, ...a) => {
  const [keys, sep] = last(a);
  return escape(array(ctx, keys).map(dump).join(sep));
}, req(2));

// -- HTTP ------------------------------------------------------------------------------------------------------
fn("httpAddHeader", (ctx, name, value) => ((ctx.http.headers[name] = value), ""), req(2));

async function request(ctx: Context, method: string, url: string, body: string | null = null): Promise<string> {
  if (!ctx.bot.allowHttp) throw new BDScriptError("HTTP functions are disabled for this bot");
  const n = (ctx.extras.http_count ?? 0) + 1;
  if (n > ctx.bot.httpLimit) throw new BDScriptError(`at most ${ctx.bot.httpLimit} HTTP requests per command`);
  ctx.extras.http_count = n;
  const headers: Record<string, string> = { "User-Agent": "vector-sdk-js BDScript", ...ctx.http.headers };
  let data: string | undefined;
  if (body !== null) {
    data = unescape(body, false);
    if (!Object.keys(headers).some((h) => h.toLowerCase() === "content-type")) headers["Content-Type"] = "{[".includes(body.trim().slice(0, 1) || "x") ? "application/json" : "text/plain";
  }
  let r: Response;
  try {
    r = await fetch(url.trim(), { method, headers, body: data, signal: AbortSignal.timeout(35_000) });
  } catch (e) {
    throw new BDScriptError(`request failed: ${(e as Error).message}`);
  }
  const buf = Buffer.from(await r.arrayBuffer());
  const text = buf.subarray(0, 5 * 1024 * 1024).toString("utf8");
  ctx.http.status = r.status;
  ctx.http.result = text;
  (ctx.http as any).responseHeaders = Object.fromEntries([...r.headers.entries()].map(([k, v]) => [k.toLowerCase(), v]));
  try {
    (ctx.http as any).json = JSON.parse(text);
  } catch {
    (ctx.http as any).json = null;
  }
  return "";
}
fn("httpGet", (ctx, url) => request(ctx, "GET", url), req(1));
fn("httpPost", (ctx, url, ...b) => request(ctx, "POST", url, b.join(";")), req(1));
fn("httpPut", (ctx, url, ...b) => request(ctx, "PUT", url, b.join(";")), req(1));
fn("httpPatch", (ctx, url, ...b) => request(ctx, "PATCH", url, b.join(";")), req(1));
fn("httpDelete", (ctx, url, ...b) => request(ctx, "DELETE", url, b.length ? b.join(";") : null), req(1));
fn("httpResult", (ctx, ...keys) => {
  const ks = keys.filter((k) => k !== "");
  if (!ks.length) return escape(ctx.http.result);
  const data = (ctx.http as any).json;
  if (data === null || data === undefined) return "";
  const [v, ok] = walk(data, ks);
  return ok ? escape(dump(v)) : "";
});
fn("httpStatus", (ctx) => String(ctx.http.status), none);
fn("httpRemoveHeader", (ctx, name) => {
  for (const k of Object.keys(ctx.http.headers)) if (k.toLowerCase() === name.trim().toLowerCase()) delete ctx.http.headers[k];
  return "";
}, req(1));
fn("httpGetHeader", (ctx, name) => escape((ctx.http as any).responseHeaders?.[name.trim().toLowerCase()] ?? ""), req(1));
