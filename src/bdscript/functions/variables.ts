/** Persistent variables (BDFD scopes + D.js-BDscript's $setVar[name;value;id;type]), leaderboards, cooldowns. */
import { escape } from "../parser";
import { BDScriptError, StopExecution, fn, req } from "../registry";
import { fmtNum, humanDuration, seconds, stripMention, toInt, toNum, userId } from "../util";
import type { Context } from "../context";

function def(ctx: Context, name: string): string {
  const v = ctx.bot.variablesDef[name];
  if (v === undefined || v === null) {
    if (ctx.bot.autoVariables) return "";
    throw new BDScriptError(`variable '${name}' doesn't exist (declare it with bot.variables(...))`);
  }
  return String(v);
}
const read = (ctx: Context, scope: string, name: string, key: string) => ctx.bot.storage.get(scope, name, key) ?? def(ctx, name);
function write(ctx: Context, scope: string, name: string, key: string, value: string): void {
  def(ctx, name);
  const t = ctx.bot.variableTypes[name];
  if (["INTEGER", "NUMBER", "INT", "FLOAT"].includes(t) && value.trim() && Number.isNaN(Number(value))) throw new BDScriptError(`variable '${name}' holds numbers, got '${value}'`);
  ctx.bot.storage.set(scope, name, key, value);
}
export { read as readVar, write as writeVar };

const FORK_SCOPES: Record<string, string> = { user: "user_global", member: "user", server: "server", guild: "server", channel: "channel", global: "global" };
function forkKey(ctx: Context, scope: string, ident: string): string {
  if (scope === "user") return `${ctx.guildId}:${stripMention(ident) || ctx.authorId}`;
  if (scope === "user_global") return stripMention(ident) || ctx.authorId;
  if (scope === "server") return ident.trim() || ctx.guildId;
  if (scope === "channel") return stripMention(ident) || ctx.channelId;
  return "";
}

fn("setVar", (ctx, name, value, ident = "", kind = "") => {
  if (kind.trim()) {
    const scope = FORK_SCOPES[kind.trim().toLowerCase()];
    if (!scope) throw new BDScriptError(`invalid variable type '${kind}' (user/member/server/channel/global)`);
    write(ctx, scope, name, forkKey(ctx, scope, ident), value);
  } else if (ident.trim()) write(ctx, "user_global", name, stripMention(ident), value);
  else write(ctx, "global", name, "", value);
  return "";
}, req(2));
fn("getVar", (ctx, name, ident = "", kind = "") => {
  if (kind.trim()) {
    const scope = FORK_SCOPES[kind.trim().toLowerCase()];
    if (!scope) throw new BDScriptError(`invalid variable type '${kind}'`);
    return escape(read(ctx, scope, name, forkKey(ctx, scope, ident)));
  }
  if (ident.trim()) return escape(read(ctx, "user_global", name, stripMention(ident)));
  return escape(read(ctx, "global", name, ""));
}, req(1));
fn("setUserVar", (ctx, name, value, uid = "", gid = "") => (write(ctx, "user", name, `${gid.trim() || ctx.guildId}:${userId(ctx, uid)}`, value), ""), req(2));
fn("getUserVar", (ctx, name, uid = "", gid = "") => escape(read(ctx, "user", name, `${gid.trim() || ctx.guildId}:${userId(ctx, uid)}`)), req(1));
fn("setServerVar", (ctx, name, value, gid = "") => (write(ctx, "server", name, gid.trim() || ctx.guildId, value), ""), req(2));
fn("getServerVar", (ctx, name, gid = "") => escape(read(ctx, "server", name, gid.trim() || ctx.guildId)), req(1));
fn("setChannelVar", (ctx, name, value, cid = "") => (write(ctx, "channel", name, stripMention(cid) || ctx.channelId, value), ""), req(2));
fn("getChannelVar", (ctx, name, cid = "") => escape(read(ctx, "channel", name, stripMention(cid) || ctx.channelId)), req(1));
fn("resetUserVar", (ctx, name, uid = "") => {
  def(ctx, name);
  if (uid.trim()) ctx.bot.storage.delete("user", name, `${ctx.guildId}:${userId(ctx, uid)}`);
  else for (const [key] of ctx.bot.storage.rows("user", name, `${ctx.guildId}:`)) ctx.bot.storage.delete("user", name, key);
  return "";
}, req(1));
fn("resetServerVar", (ctx, name) => (def(ctx, name), ctx.bot.storage.delete("server", name), ""), req(1));
fn("resetChannelVar", (ctx, name) => (def(ctx, name), ctx.bot.storage.delete("channel", name), ""), req(1));
fn("varExists", (ctx, name) => name in ctx.bot.variablesDef, req(1));
fn("varExistError", (ctx, name, msg = "") => {
  if (!(name in ctx.bot.variablesDef)) throw new StopExecution(msg || "");
  return "";
}, req(1));
fn("listVar", (ctx, sep = ", ") => Object.keys(ctx.bot.variablesDef).sort().join(sep || ", "));
fn("variablesCount", (ctx, kind = "") => {
  const k = kind.trim().toLowerCase();
  const scope = ({ user: "user", server: "server", channel: "channel", global: "global" } as Record<string, string>)[k];
  return k ? String(ctx.bot.storage.count(scope)) : String(Object.keys(ctx.bot.variablesDef).length);
});

// -- leaderboards ----------------------------------------------------------------------------------------------
function ranked(ctx: Context, scope: string, name: string, prefix = ""): [string, number][] {
  def(ctx, name);
  const out: [string, number][] = [];
  for (const [key, value] of ctx.bot.storage.rows(scope, name, prefix)) {
    const n = Number(value);
    if (value.trim() !== "" && !Number.isNaN(n)) out.push([key.slice(prefix.length), n]);
  }
  return out;
}
const sorted = (rows: [string, number][], sort: string) => [...rows].sort((a, b) => ((sort.trim().toLowerCase() || "desc") !== "asc" ? b[1] - a[1] : a[1] - b[1]));
function who(ctx: Context, ident: string, scope: string): string {
  if (scope === "server") {
    const g = ctx.client.guilds.cache.get(ident);
    return g ? escape(g.name) : ident;
  }
  const m: any = ctx.guild?.members.cache.get(ident);
  const u: any = m?.user ?? ctx.client.users.resolve(ident);
  return escape(m?.displayName ?? u?.displayName ?? u?.username ?? ident);
}
function board(ctx: Context, rows: [string, number][], scope: string, fmt: string | null, perPage = 10, page = 1): string {
  const start = (page - 1) * perPage;
  return rows.slice(start, start + perPage).map(([ident, value], i) =>
    (fmt ?? "{position}. {username} - {value}").replace(/\{position\}/g, String(start + i + 1)).replace(/\{username\}/g, who(ctx, ident, scope)).replace(/\{value\}/g, fmtNum(value)).replace(/\{id\}/g, ident)).join("\n");
}
fn("userLeaderboard", (ctx, name, sort = "desc", page = "1", perPage = "10", f = "") => board(ctx, sorted(ranked(ctx, "user", name, `${ctx.guildId}:`), sort), "user", f || null, toInt(perPage || "10"), toInt(page || "1")), req(1));
fn("globalUserLeaderboard", (ctx, name, sort = "desc", page = "1", perPage = "10", f = "") => board(ctx, sorted(ranked(ctx, "user_global", name), sort), "user_global", f || null, toInt(perPage || "10"), toInt(page || "1")), req(1));
fn("serverLeaderboard", (ctx, name, sort = "desc", page = "1", perPage = "10", f = "") => board(ctx, sorted(ranked(ctx, "server", name), sort), "server", f || null, toInt(perPage || "10"), toInt(page || "1")), req(1));

function boardRows(ctx: Context, kind: string, name: string, sort: string): [[string, number][], string] {
  const k = kind.trim().toLowerCase();
  if (k === "user") return [sorted(ranked(ctx, "user", name, `${ctx.guildId}:`), sort), "user"];
  if (k === "globaluser" || k === "global") return [sorted(ranked(ctx, "user_global", name), sort), "user_global"];
  if (k === "server") return [sorted(ranked(ctx, "server", name), sort), "server"];
  throw new BDScriptError(`invalid variable type '${kind}' (user/globalUser/server)`);
}
fn("getLeaderboardPosition", (ctx, kind, name, sort, ident = "") => {
  const [rows, scope] = boardRows(ctx, kind, name, sort);
  const target = stripMention(ident) || (scope === "server" ? ctx.guildId : ctx.authorId);
  return String(rows.findIndex(([k]) => k === target) + 1);
}, req(3));
fn("getLeaderboardValue", (ctx, kind, name, sort, position, ret = "value") => {
  const [rows, scope] = boardRows(ctx, kind, name, sort);
  const i = toInt(position);
  if (!(i > 0 && i <= rows.length)) return "";
  const [ident, value] = rows[i - 1];
  const r = ret.trim().toLowerCase() || "value";
  if (r === "value") return fmtNum(value);
  if (["id", "userid", "serverid"].includes(r)) return ident;
  if (["username", "name", "servername"].includes(r)) return who(ctx, ident, scope);
  throw new BDScriptError(`invalid return type '${ret}' (value/id/username)`);
}, req(4));

// -- cooldowns -------------------------------------------------------------------------------------------------
function cooldown(ctx: Context, kind: string, key: string, duration: string, msg: string): string {
  const cmd = ctx.command?.name || "?";
  const left = ctx.bot.storage.cooldownLeft(kind, cmd, key);
  if (left > 0) throw new StopExecution(msg.replace(/%time%/g, humanDuration(left)).replace(/%time-s%/g, String(Math.floor(left))) || `Please wait ${humanDuration(left)}.`);
  ctx.bot.storage.setCooldown(kind, cmd, key, seconds(duration));
  return "";
}
fn("cooldown", (ctx, d, msg = "") => cooldown(ctx, "user", `${ctx.guildId}:${ctx.authorId}`, d, msg), req(1));
fn("serverCooldown", (ctx, d, msg = "") => cooldown(ctx, "server", ctx.guildId, d, msg), req(1));
fn("globalCooldown", (ctx, d, msg = "") => cooldown(ctx, "global", ctx.authorId, d, msg), req(1));
fn("getCooldown", (ctx, kind, cmd = "") => {
  const k = kind.trim().toLowerCase();
  const key = ({ user: `${ctx.guildId}:${ctx.authorId}`, server: ctx.guildId, global: ctx.authorId } as Record<string, string>)[k];
  if (key === undefined) throw new BDScriptError(`invalid cooldown type '${kind}' (user/server/global)`);
  return String(Math.floor(ctx.bot.storage.cooldownLeft(k, cmd || ctx.command?.name || "", key)));
}, req(1));
fn("changeCooldownTime", (ctx, days = "0", hours = "0", minutes = "0", secs = "0") => {
  const total = toNum(days || 0) * 86400 + toNum(hours || 0) * 3600 + toNum(minutes || 0) * 60 + toNum(secs || 0);
  const cmd = ctx.command?.name || "?";
  for (const [kind, key] of [["user", `${ctx.guildId}:${ctx.authorId}`], ["server", ctx.guildId], ["global", ctx.authorId]]) {
    if (ctx.bot.storage.cooldownLeft(kind, cmd, key) > 0) ctx.bot.storage.setCooldown(kind, cmd, key, total);
  }
  return "";
}, req(1));
