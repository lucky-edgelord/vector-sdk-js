/** Command restrictions, bot info, awaited commands, callbacks and premium functions (AI, notifications). */
import { escape } from "../parser";
import { BDScriptError, StopExecution, fn, req, none } from "../registry";
import { getChannel, getMember, permName, stripMention, toInt, truthy } from "../util";
import type { Context } from "../context";

const splitLast = (a: string[]): [string[], string] => (a.length <= 1 ? [a, ""] : [a.slice(0, -1), a[a.length - 1]]);
const deny = (msg: string): never => {
  throw new StopExecution(msg || "");
};
const memberOrNull = (ctx: Context) => (ctx.guild ? getMember(ctx, "", undefined, false) : null);
const isAdmin = (m: any) => Boolean(m && (m.isOwner || m.permissions.has("Administrator")));
const can = (m: any, p: string) => {
  const flag = permName(p);
  return flag === "Administrator" ? isAdmin(m) : isAdmin(m) || m.permissions.has(flag);
};

fn("onlyAdmin", (ctx, msg = "") => (isAdmin(memberOrNull(ctx)) ? "" : deny(msg)));
fn("onlyPerms", (ctx, ...a) => {
  const [perms, msg] = splitLast(a);
  const m = memberOrNull(ctx);
  return m && perms.filter((p) => p.trim()).every((p) => can(m, p)) ? "" : deny(msg);
}, req(1));
fn("onlyBotPerms", (ctx, ...a) => {
  const [perms, msg] = splitLast(a);
  const me = ctx.guild?.members.me;
  return me && perms.filter((p) => p.trim()).every((p) => can(me, p)) ? "" : deny(msg);
}, req(1));
fn("onlyBotChannelPerms", (ctx, cid, ...a) => {
  const [perms, msg] = splitLast(a);
  const me = ctx.guild?.members.me;
  const p = me ? getChannel(ctx, cid)?.permissionsFor?.(me) : null;
  return p && perms.filter((x) => x.trim()).every((x) => p.has(permName(x))) ? "" : deny(msg);
}, req(2));
fn("onlyForIDs", (ctx, ...a) => {
  const [ids, msg] = splitLast(a);
  return ids.map(stripMention).includes(ctx.authorId) || ctx.bot.isOwner(ctx.authorId) ? "" : deny(msg);
}, req(1));
fn("onlyForUsers", (ctx, ...a) => {
  const [names, msg] = splitLast(a);
  return names.map((n) => n.trim()).includes(ctx.author?.username ?? "") ? "" : deny(msg);
}, req(1));
fn("onlyForChannels", (ctx, ...a) => {
  const [ids, msg] = splitLast(a);
  return ids.map(stripMention).includes(ctx.channelId) ? "" : deny(msg);
}, req(1));
fn("onlyForCategories", (ctx, ...a) => {
  const [ids, msg] = splitLast(a);
  return ids.map((i) => i.trim()).includes((ctx.channel as any)?.parentId ?? "") ? "" : deny(msg);
}, req(1));
fn("onlyForServers", (ctx, ...a) => {
  const [ids, msg] = splitLast(a);
  return ids.map((i) => i.trim()).includes(ctx.guildId) ? "" : deny(msg);
}, req(1));
function roleHit(ctx: Context, items: string[], byName: boolean): boolean {
  const m = memberOrNull(ctx);
  if (!m) return false;
  const keys = new Set([...m.roles.cache.values()].map((r: any) => (byName ? r.name.toLowerCase() : r.id)));
  return items.filter((i) => i.trim()).some((i) => keys.has(byName ? i.trim().toLowerCase() : stripMention(i)));
}
fn("onlyForRoles", (ctx, ...a) => {
  const [names, msg] = splitLast(a);
  return roleHit(ctx, names, true) ? "" : deny(msg);
}, req(1));
fn("onlyForRoleIDs", (ctx, ...a) => {
  const [ids, msg] = splitLast(a);
  return roleHit(ctx, ids, false) ? "" : deny(msg);
}, req(1));
fn("onlyIfMessageContains", (_c, text, ...a) => {
  const [words, msg] = splitLast(a);
  return words.some((w) => w && text.includes(w)) ? "" : deny(msg);
}, req(2));
fn("onlyNSFW", (_c, msg = "") => deny(msg));
fn("blackListIDs", (ctx, ...a) => {
  const [ids, msg] = splitLast(a);
  return ids.map(stripMention).includes(ctx.authorId) ? deny(msg) : "";
}, req(1));
fn("blackListUsers", (ctx, ...a) => {
  const [names, msg] = splitLast(a);
  return names.map((n) => n.trim()).includes(ctx.author?.username ?? "") ? deny(msg) : "";
}, req(1));
fn("blackListServers", (ctx, ...a) => {
  const [ids, msg] = splitLast(a);
  return ids.map((i) => i.trim()).includes(ctx.guildId) ? deny(msg) : "";
}, req(1));
fn("blackListRoles", (ctx, ...a) => {
  const [names, msg] = splitLast(a);
  return roleHit(ctx, names, true) ? deny(msg) : "";
}, req(1));
fn("blackListRolesIDs", (ctx, ...a) => {
  const [ids, msg] = splitLast(a);
  return roleHit(ctx, ids, false) ? deny(msg) : "";
}, req(1));
fn("ignoreChannels", (ctx, ...a) => {
  const [ids, msg] = splitLast(a);
  return ids.map(stripMention).includes(ctx.channelId) ? deny(msg) : "";
}, req(1));
fn("ignoreLinks", (ctx) => (/https?:\/\//.test(ctx.args.join(" ")) ? deny("") : ""), none);
fn("enabled", (_c, v, msg = "") => (truthy(v, true) ? "" : deny(msg)), req(1));

// -- bot & command info --------------------------------------------------------------------------------------------
fn("botID", (ctx) => ctx.client.user?.id ?? "", none);
fn("botOwnerID", (ctx, sep = ", ") => ctx.bot.owners.join(sep || ", "));
fn("commandName", (ctx) => ctx.command?.name ?? "", none);
fn("commandTrigger", (ctx) => ctx.command?.trigger || ctx.command?.name || "", none);
fn("commandFolder", (ctx) => ctx.command?.folder ?? "", none);
fn("commandsCount", (ctx) => String(ctx.bot.commands.length), none);
fn("botCommands", (ctx, sep = ", ") => ctx.bot.commands.filter((c) => c.kind === "message").map((c) => c.trigger || c.name).join(sep || ", "));
fn("commandInfo", (ctx, name, p = "code") => {
  const c = ctx.bot.getCommand(name);
  if (!c) throw new BDScriptError(`no command '${name}'`);
  const v = ({ code: c.code, name: c.name, trigger: c.trigger, aliases: c.aliases.join(", "), type: c.type, description: c.description, folder: c.folder } as Record<string, string>)[p.trim()];
  if (v === undefined) throw new BDScriptError(`invalid command property '${p}'`);
  return escape(v);
}, req(1));
fn("updateCommands", (ctx) => (ctx.bot.reload(), ""), none);
fn(["shardID", "shardIDComplex"], () => "0");
fn(["premiumExpireTime", "hostingExpireTime", "hostingExpireTimeComplex"], () => "never", { status: "noop", note: "no premium tier: everything is enabled" });
fn("botListDescription", () => "", { status: "noop" });
fn("botListHide", () => "", { brackets: "none", status: "noop" });

// -- awaited commands & callbacks ---------------------------------------------------------------------------------
fn("awaitFunc", (ctx, name, uid = "", cid = "") => (ctx.bot.awaitCommand(name.trim(), stripMention(uid) || ctx.authorId, stripMention(cid) || ctx.channelId), ""), req(1));
fn("awaitReactions", (ctx, ...pairs) => {
  const list = pairs.filter((p) => p !== "");
  const mapping: Record<string, string> = {};
  for (let i = 0; i < list.length; i += 2) {
    if (i + 1 >= list.length) throw new BDScriptError("each awaited command needs an emoji");
    mapping[list[i + 1].trim()] = list[i].trim();
  }
  ctx.extras.await_reactions = mapping;
  for (const e of Object.keys(mapping)) if (!ctx.response.reactions.includes(e)) ctx.response.reactions.push(e);
  return "";
}, req(1));
for (const n of ["onJoined", "onLeave", "onInteraction", "onInteractionComplex", "awaitedCommand", "awaitedCommandError", "onBanAdd", "onBanRemove", "onMessageDelete", "alwaysReply", "ignoreTriggerCase", "messageContains", "reaction"]) fn(n, () => "");
fn("usedEmoji", (ctx) => ctx.extras.emoji ?? "", none);

// -- AI (premium in BDFD; here: bring your own model) ---------------------------------------------------------------
async function ai(ctx: Context, prompt: string, system = "", maxTokens = "", history: { role: string; content: string }[] = []): Promise<string> {
  if (!ctx.bot.ai) throw new BDScriptError("no AI provider: pass new BDBot({ ai }) or set ANTHROPIC_API_KEY");
  const n = String(maxTokens).trim() ? toInt(maxTokens) : 512;
  return escape(String(await ctx.bot.ai({ prompt, system: system || null, maxTokens: n, history })));
}
async function history(ctx: Context, limit = 20): Promise<{ role: string; content: string }[]> {
  try {
    const msgs = [...(await (ctx.channel as any).messages.fetch({ limit })).values()] as any[];
    return msgs.sort((a, b) => a.createdTimestamp - b.createdTimestamp).map((m) => {
      const role = m.author?.id === ctx.client.user?.id ? "assistant" : "user";
      return { role, content: role === "user" ? `${m.author?.username}: ${m.content}` : m.content };
    });
  } catch {
    return [];
  }
}
fn("ai", (ctx, prompt, system = "", max = "") => ai(ctx, prompt, system, max), req(1));
fn("aiWithCtx", async (ctx, prompt, system = "", max = "") => ai(ctx, prompt, system, max, await history(ctx)), req(1));
fn("aiAgent", (ctx, prompt, system = "", functions = "", max = "") => ai(ctx, prompt, (system ? system + "\n" : "") + (functions ? `You may mention these bot functions: ${functions}` : ""), max), { ...req(1), status: "partial", note: "functions list is passed to the model as text" });
async function decide(ctx: Context, question: string, content = "", hist: { role: string; content: string }[] = []) {
  const a = await ai(ctx, (content ? `Content:\n${content}\n\n` : "") + `Question: ${question}\nAnswer only yes or no.`, "Answer with exactly one word: yes or no.", "5", hist);
  return a.trim().toLowerCase().startsWith("y") ? "true" : "false";
}
fn("aiDecide", (ctx, content, question) => decide(ctx, question, content), req(2));
fn("aiDecideWithCtx", async (ctx, question) => decide(ctx, question, "", await history(ctx)), req(1));
fn("aiQuota", () => "unlimited", none);
fn("customImage", (ctx, tag) => {
  const url = ctx.bot.customImages[tag.trim()];
  if (url === undefined) throw new BDScriptError(`no custom image '${tag}' (new BDBot({ customImages: {...} }))`);
  return url;
}, req(1));
fn("sendNotification", async (ctx, message, image = "") => {
  for (const owner of ctx.bot.owners) await ctx.client._state.user(owner).send(message + (image ? `\n${image}` : "")).catch(() => undefined);
  return "";
}, req(1));
