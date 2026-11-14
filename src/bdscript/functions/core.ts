/** Control flow, scripting features and response flags. */
import { exec } from "node:child_process";
import { check } from "../conditions";
import { escape, unescape } from "../parser";
import { BDScriptError, StopExecution, fn, req, none, type LazyImpl } from "../registry";
import { seconds, toInt, humanDuration } from "../util";
import { compileCode, evaluate } from "../interpreter";
import { EmbedBuilder } from "../../structures/Embed";
import { colourValue } from "./embeds";

const blank = () => "";
// block markers (handled by the parser; a stray one is a no-op)
fn("elseif", blank, { brackets: "required" });
for (const n of ["else", "endif", "try", "catch", "endtry", "endasync", "endloop", "endfor", "endwhile", "endjsonforeach"]) fn(n, blank, none);
fn("async", blank, { brackets: "required" });
fn(["for", "while", "jsonForEach"], blank, { brackets: "required" });
fn("c", (() => "") as LazyImpl, { brackets: "required", lazy: true });

fn("if", (async (ctx, _n, args) => {
  // inline form $if[cond;then;else] (the block form is handled by the parser)
  const cond = args.length ? await evaluate(ctx, args[0]) : "";
  if (check(cond)) return args.length > 1 ? evaluate(ctx, args[1]) : "";
  return args.length > 2 ? evaluate(ctx, args[2]) : "";
}) as LazyImpl, { lazy: true, brackets: "required" });

fn("await", async (ctx, name = "") => {
  const t = ctx.asyncTasks.get(name.trim());
  if (!t) throw new BDScriptError(`no async scope named '${name}'`);
  await t;
  return "";
}, req(1));

fn("stop", () => {
  throw new StopExecution();
}, none);

fn("eval", (async (ctx, _n, args) => {
  const code = args.length ? unescape(await evaluate(ctx, args[0]), false) : ctx.args.join(" ");
  if (++ctx.depth > 20) throw new BDScriptError("$eval nested too deeply");
  try {
    return await evaluate(ctx, compileCode(code));
  } finally {
    ctx.depth--;
  }
}) as LazyImpl, { lazy: true });

fn("optOff", (async (ctx, _n, args) => (args.length ? evaluate(ctx, args[0]) : "")) as LazyImpl, { lazy: true });

fn("var", (ctx, name, ...value) => {
  if (value.length) {
    ctx.vars[name] = value.join(";");
    return "";
  }
  if (!(name in ctx.vars)) throw new BDScriptError(`variable '${name}' not found`);
  return ctx.vars[name];
}, req(1));
fn("let", (ctx, name, ...value) => {
  ctx.keywords[name] = value.join(";");
  return "";
}, req(2));
fn("get", (ctx, name) => {
  if (!(name in ctx.keywords)) throw new BDScriptError(`keyword '${name}' not found`);
  return ctx.keywords[name];
}, req(1, 1));
fn("checkCondition", (_c, cond) => check(cond), req(1));
fn("and", (_c, ...conds) => conds.every((c) => check(c)), req(1));
fn("or", (_c, ...conds) => conds.some((c) => check(c)), req(1));

fn("onlyIf", (async (ctx, _n, args) => {
  if (!check(await evaluate(ctx, args[0] ?? []))) throw new StopExecution(args.length > 1 ? await evaluate(ctx, args[1]) : "");
  return "";
}) as LazyImpl, { min: 1, brackets: "required", lazy: true });

fn("argsCheck", (ctx, how, msg = "") => {
  how = how.trim().replace(/ /g, "");
  const n = ctx.args.length;
  let ok: boolean | null = null;
  const ops: [string, (a: number, b: number) => boolean][] = [[">=", (a, b) => a >= b], ["<=", (a, b) => a <= b], ["==", (a, b) => a === b], ["!=", (a, b) => a !== b], [">", (a, b) => a >= b], ["<", (a, b) => a <= b]];
  for (const [op, f] of ops) if (how.startsWith(op)) {
    ok = f(n, toInt(how.slice(op.length)));
    break;
  }
  if (ok === null) ok = n === toInt(how);
  if (!ok) throw new StopExecution(msg || "");
  return "";
}, req(1));

fn(["error", "handleError"], (ctx, kind) => {
  if (!["command", "message", "source", "row", "column", "function", "error"].includes(kind)) throw new BDScriptError(`invalid error type '${kind}'`);
  return ctx.error[kind] ?? "";
}, req(1));
fn(["suppressErrors", "suppressErrorsComplex"], (ctx, ...msg) => {
  ctx.suppressErrors = msg.join(";");
  return "";
});
fn("embedSuppressErrors", (ctx, title = "", description = "", color = "", footer = "", image = "") => {
  const e = new EmbedBuilder();
  if (title) e.setTitle(title);
  if (description) e.setDescription(description);
  if (color) e.setColor(colourValue(color));
  if (footer) e.setFooter({ text: footer });
  if (image) e.setImage(image);
  ctx.suppressErrors = "";
  ctx.embedSuppressErrors = e;
  return "";
}, { min: 1 });
fn("suppressErrorLogging", (ctx) => ((ctx.extras.no_error_log = true), ""), none);
fn("nomention", (ctx) => ((ctx.response.mentionAuthor = false), ""), none);
fn("disableInnerSpaceRemoval", (ctx) => ((ctx.innerSpaceRemoval = false), ""), none);
fn("disableSpecialEscaping", (ctx) => ((ctx.specialEscaping = false), ""), none);
fn("alternativeParsing", blank, none);
fn("unescape", (_c, ...t) => unescape(t.join(";")));
fn("scriptLanguage", () => "BDScript 2", none);
fn("executionTime", (ctx) => String(Math.round((performance.now() - ctx.started) * 100) / 100), none);
fn("ping", (ctx) => String(ctx.client.ws.ping || 0), none);
fn("uptime", (ctx, unit = "") => {
  const secs = (Date.now() - ctx.bot.startedAt) / 1000;
  if (["s", "seconds"].includes(unit.toLowerCase())) return String(Math.floor(secs));
  if (["ms", "milliseconds"].includes(unit.toLowerCase())) return String(Math.floor(secs * 1000));
  return humanDuration(secs);
});
fn("botNode", () => "vector-sdk-js", none);
fn("nodeVersion", () => `Node ${process.version}`, none);
fn("nodeVersionComplex", () => `Node ${process.version}`);
fn("wait", async (_c, d) => {
  await new Promise((r) => setTimeout(r, Math.min(seconds(d), 3600) * 1000));
  return "";
}, req(1));
fn("log", (ctx, ...t) => {
  ctx.client.emit("debug", `[bdscript] ${t.join(";")}`);
  ctx.bot.logLines.push(t.join(";"));
  if (ctx.bot.logLines.length > 1000) ctx.bot.logLines.shift();
  return "";
}, { brackets: "required" });
fn("logQuota", () => "unlimited", none);

fn("forEach", (async (ctx, _n, args) => {
  if (args.length < 2) throw new BDScriptError("usage: $forEach[items;code;(separator)]");
  const items = await evaluate(ctx, args[0]);
  const sep = args.length > 2 ? await evaluate(ctx, args[2]) : ",";
  const out: string[] = [];
  const list = items ? items.split(sep) : [];
  for (let i = 0; i < list.length; i++) {
    ctx.keywords.value = list[i].trim();
    ctx.keywords.index = String(i + 1);
    out.push(await evaluate(ctx, args[1]));
  }
  return out.join("");
}) as LazyImpl, { min: 2, brackets: "required", lazy: true });

fn("loop", (async (ctx, _n, args) => {
  if (args.length < 2) throw new BDScriptError("usage: $loop[times;code]");
  const n = Math.min(toInt(await evaluate(ctx, args[0])), 1000);
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    ctx.keywords.index = String(i + 1);
    out.push(await evaluate(ctx, args[1]));
  }
  return out.join("");
}) as LazyImpl, { min: 2, brackets: "required", lazy: true });

fn("tts", (ctx) => ((ctx.response.tts = true), ""), none);
fn("ephemeral", (ctx) => ((ctx.response.ephemeral = true), ""), none);
fn("defer", async (ctx) => {
  ctx.response.defer = true;
  if (ctx.interaction?.deferReply && !ctx.interaction.deferred && !ctx.interaction.replied) await ctx.interaction.deferReply().catch(() => undefined);
  return "";
});
fn("allowMention", (ctx) => ((ctx.response.allowedUsers = null), (ctx.response.allowedRoles = null), ""), none);
fn("allowUserMentions", (ctx, ...ids) => ((ctx.response.allowedUsers = ids.filter(Boolean)), ""));
fn("allowRoleMentions", (ctx, ...ids) => ((ctx.response.allowedRoles = ids.filter(Boolean)), ""));
fn("enableDecimals", (ctx) => ((ctx.extras.decimals = true), ""), none);

fn("exec", (ctx, ...cmd) => {
  if (!ctx.bot.allowExec) throw new BDScriptError("$exec is disabled (new BDBot({ allowExec: true }) to enable)");
  return new Promise<string>((resolve) => {
    exec(cmd.join(";"), { timeout: 60_000, maxBuffer: 1 << 20 }, (_e, stdout, stderr) => resolve(escape((stdout + stderr).slice(0, 4000))));
  });
}, { brackets: "required", status: "partial", note: "disabled unless BDBot({ allowExec: true })" });

fn("data", (ctx, key, ...value) => {
  if (value.length) {
    (ctx.extras.data ??= {})[key] = value.join(";");
    return "";
  }
  const d = ctx.extras.data ?? {};
  if (!(key in d)) throw new BDScriptError(`no data '${key}'`);
  return String(d[key]);
}, req(1));
