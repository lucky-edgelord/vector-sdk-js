/** Sending, editing, deleting, reactions, DMs, emoji, tickets, threads, webhooks. */
import { escape } from "../parser";
import { BDScriptError, StopExecution, fn, req, none, type LazyImpl } from "../registry";
import { getChannel, getUser, seconds, stripMention, toInt, truthy } from "../util";
import { cleanOutput, evaluate } from "../interpreter";
import { EmbedBuilder } from "../../structures/Embed";
import { ChannelType } from "../../util/Constants";
import { colourValue } from "./embeds";
import type { Context } from "../context";

const out = (ctx: Context, text: string) => cleanOutput(text, ctx);
const fetchMsg = async (ctx: Context, cid: string, mid: string): Promise<any> => {
  const m = await getChannel(ctx, cid).messages.fetch(mid.trim());
  if (!m) throw new BDScriptError(`message ${mid} not found`);
  return m;
};
async function targetMsg(ctx: Context, cid: string, mid: string): Promise<any> {
  if (mid.trim()) return fetchMsg(ctx, cid, mid);
  if (!ctx.message) throw new BDScriptError("no message here; give a channel and message ID");
  return ctx.message;
}

fn("sendMessage", (async (ctx, _n, args) => {
  const text = args.length ? await evaluate(ctx, args[0]) : "";
  const ret = args.length > 1 ? await evaluate(ctx, args[1]) : "no";
  const msg = await ctx.channel!.send(out(ctx, text) || "​");
  ctx.sentIds.push(msg.id);
  return truthy(ret) ? msg.id : "";
}) as LazyImpl, { brackets: "required", lazy: true });
fn("channelSendMessage", async (ctx, cid, ...text) => {
  await getChannel(ctx, cid).send(out(ctx, text.join(";")) || "​");
  return "";
}, req(2));
fn(["reply", "replyComplex"], (ctx, cidOrMention = "", mid = "") => {
  const r = ctx.response;
  if (mid.trim()) {
    r.channelId = getChannel(ctx, cidOrMention).id;
    r.replyTo = mid.trim();
  } else {
    if (["yes", "no", "true", "false"].includes(cidOrMention.trim().toLowerCase())) r.replyMention = truthy(cidOrMention);
    r.replyTo = ctx.message?.id ?? null;
  }
  r.mentionAuthor = false;
  return "";
});
fn("replyIn", async (_c, d) => (await new Promise((r) => setTimeout(r, Math.min(seconds(d), 3600) * 1000)), ""), req(1));
fn("editMessage", async (ctx, cid, mid, content, title = "", description = "", color = "", footer = "") => {
  const msg = await fetchMsg(ctx, cid, mid);
  const o: any = { content: out(ctx, content) || null };
  if (title || description || color || footer) {
    const em = new EmbedBuilder();
    if (title) em.setTitle(title);
    if (description) em.setDescription(description);
    if (color) em.setColor(colourValue(color));
    if (footer) em.setFooter({ text: footer });
    o.embeds = [em];
  }
  await msg.edit(o);
  return "";
}, req(3));
fn("editIn", (ctx, d, ...text) => {
  const delay = seconds(d) * 1000;
  const next = out(ctx, text.join(";"));
  setTimeout(async () => {
    for (const id of ctx.sentIds.slice(0, 1)) {
      const m: any = await (ctx.channel as any)?.messages.fetch(id).catch(() => null);
      await m?.edit(next).catch(() => undefined);
    }
  }, delay);
  return "";
}, req(2));
fn("deleteMessage", async (ctx, cid, mid) => (await (await fetchMsg(ctx, cid, mid)).delete(), ""), req(2));
fn("deleteIn", (ctx, d) => ((ctx.response.deleteAfter = seconds(d)), ""), req(1));
fn("deletecommand", (ctx, d = "") => ((ctx.response.deleteCommandAfter = d.trim() ? seconds(d) : 0), ""));
fn(["dm", "dmComplex"], (ctx, ...uids) => {
  const t = uids.filter((u) => u.trim());
  ctx.extras.dm_targets = t.length ? t.map(stripMention) : [ctx.authorId];
  return "";
});
fn("sendDM", async (ctx, uid, ...text) => (await getUser(ctx, uid).send(out(ctx, text.join(";")) || "​"), ""), req(2));
fn("getMessage", async (ctx, cid, mid, prop = "content") => {
  const msg = await fetchMsg(ctx, cid, mid);
  const p = prop.trim().toLowerCase() || "content";
  const table: Record<string, () => string> = {
    content: () => msg.content, authorid: () => msg.author.id, username: () => msg.author.username,
    avatar: () => msg.author.displayAvatarURL?.() ?? msg.author.avatar ?? "", timestamp: () => String(Math.floor(msg.createdTimestamp / 1000)),
  };
  if (!table[p]) throw new BDScriptError(`invalid property '${prop}' (content/authorID/username/avatar/timestamp)`);
  return escape(table[p]() ?? "");
}, req(2));
fn(["pinMessage", "pinMessageComplex"], async (ctx, cid = "", mid = "") => (await (await targetMsg(ctx, cid, mid)).pin(), ""));
fn("unpinMessage", async (ctx, cid = "", mid = "") => (await (await targetMsg(ctx, cid, mid)).unpin(), ""));
fn("publishMessage", () => "", { status: "noop", note: "no announcement channels on Vector" });
fn("addReactions", (ctx, ...emojis) => (ctx.response.reactions.push(...emojis.map((e) => e.trim()).filter(Boolean)), ""), req(1));
fn("addCmdReactions", (ctx, ...emojis) => (ctx.response.cmdReactions.push(...emojis.map((e) => e.trim()).filter(Boolean)), ""), req(1));
fn("addMessageReactions", async (ctx, cid, mid, ...emojis) => {
  const msg = await fetchMsg(ctx, cid, mid);
  for (const e of emojis) if (e.trim()) await msg.react(e.trim());
  return "";
}, req(3));
fn("clearReactions", async (ctx, cid, mid, emoji = "") => {
  const msg = await fetchMsg(ctx, cid, mid);
  for (const r of [...msg.reactions.cache.values()]) {
    if (!emoji.trim() || r.emojiName === emoji.trim()) await r.users.remove(ctx.client.user!.id).catch(() => undefined);
  }
  return "";
}, req(2));
fn("getReactions", async (ctx, cid, mid, sep = ", ", emoji = "", option = "ids") => {
  const msg = await fetchMsg(ctx, cid, mid);
  const res: string[] = [];
  for (const r of msg.reactions.cache.values()) {
    if (emoji.trim() && r.emojiName !== emoji.trim()) continue;
    if (emoji.trim()) for (const u of r.users.cache.values()) res.push(option !== "names" ? u.id : u.username);
    else res.push(`${r.emojiName} ${r.count}`);
  }
  return res.join(sep || ", ");
}, req(2));
fn("userReacted", async (ctx, cid, mid, uid, emoji) => {
  const msg = await fetchMsg(ctx, cid, mid);
  const r = msg.reactions.cache.get(emoji.trim());
  return Boolean(r?.users.cache.has(stripMention(uid)));
}, req(4));
fn("messageID", (ctx) => ctx.message?.id ?? "", none);
fn("lastMessageID", (ctx, cid = "") => getChannel(ctx, cid)?.lastMessageId ?? ctx.sentIds[ctx.sentIds.length - 1] ?? "");
fn(["repliedMessageID", "repliedMessageIDComplex"], async (ctx, cid = "", mid = "") => (await targetMsg(ctx, cid, mid)).reference?.messageId ?? "");
fn("isMessageEdited", async (ctx, cid, mid) => Boolean((await fetchMsg(ctx, cid, mid)).editedTimestamp), req(2));
fn("messageEditedTimestamp", async (ctx, cid, mid) => {
  const e = (await fetchMsg(ctx, cid, mid)).editedTimestamp;
  return e ? String(Math.floor(e / 1000)) : "";
}, req(2));
fn("getAttachments", (ctx, index = "") => {
  const atts: any[] = [...((ctx.message as any)?.attachments?.values?.() ?? [])];
  if (!index.trim()) return atts.map((a) => a.url).join(", ");
  const i = toInt(index);
  return i > 0 && i <= atts.length ? atts[i - 1].url : "";
});
fn("botTyping", async (ctx) => (await (ctx.channel as any)?.sendTyping?.().catch(() => undefined), ""), none);

// -- emoji (custom emoji come from the bot's equipped packs) ------------------------------------------------------
const emojiOf = (ctx: Context, id: string) => ctx.client.emojis.resolve(id);
fn("addEmoji", () => {
  throw new BDScriptError("adding emoji isn't supported yet; equip a pack with client.emojis.subscribe(naddr)");
}, { ...req(2), status: "partial" });
fn("removeEmoji", () => {
  throw new BDScriptError("removing emoji isn't supported yet; client.emojis.unsubscribe(naddr) drops a whole pack");
}, { ...req(1), status: "partial" });
fn("emojiExists", (ctx, id) => emojiOf(ctx, id) !== null, req(1));
fn("emojiName", (ctx, id) => emojiOf(ctx, id)?.name ?? "", req(1));
fn("customEmoji", (ctx, name) => {
  const e = emojiOf(ctx, name);
  if (!e) throw new BDScriptError(`emoji '${name}' not found; equip its pack with client.emojis.subscribe(naddr)`);
  return e.toString();
}, req(1));
fn("isEmojiAnimated", () => false, req(1));

// -- tickets -----------------------------------------------------------------------------------------------------
fn("newTicket", async (ctx, category, noQuestion = "", inTicket = "", toUser = "", error = "", number = "", returnId = "no") => {
  const g = ctx.guild;
  if (!g) throw new BDScriptError("tickets only work in a community");
  const want = category.trim();
  const cat = g.channels.cache.find((c: any) => c.type === ChannelType.GuildCategory && (c.id === want || c.name.toLowerCase() === want.toLowerCase()));
  if (!cat) throw new StopExecution(error || `category '${category}' not found`);
  const question = ctx.args.join(" ");
  if (!question && noQuestion) throw new StopExecution(noQuestion);
  const name = `ticket-${number || ctx.author?.username || "user"}`.toLowerCase().replace(/ /g, "-").slice(0, 90);
  const ch: any = await g.channels.create({ name, parent: cat.id, private: true } as any);
  if (ctx.author) await ch.grantAccess(ctx.author.id).catch(() => undefined);
  ctx.bot.tickets.add(ch.id);
  ctx.bot.saveTickets();
  const msg = await ch.send(out(ctx, (inTicket || "").replace(/\$question/g, question)) || `Ticket by ${ctx.author?.toString()}: ${question}`);
  if (toUser) {
    ctx.response.mentionAuthor = false;
    await ctx.channel!.send(out(ctx, toUser));
  }
  return truthy(returnId) ? msg.id : "";
}, req(1));
fn("closeTicket", async (ctx, error = "") => {
  if (!ctx.bot.tickets.has(ctx.channelId)) throw new StopExecution(error || "This channel isn't a ticket.");
  ctx.bot.tickets.delete(ctx.channelId);
  ctx.bot.saveTickets();
  ctx.response.suppress = true;
  await (ctx.channel as any).delete();
  return "";
});
fn("isTicket", (ctx, cid = "") => ctx.bot.tickets.has(getChannel(ctx, cid).id));

// -- threads (Vector has no threads: a thread becomes a channel in the same category) ------------------------------
fn("startThread", async (ctx, name, cid = "", _mid = "", _archive = "", returnId = "no") => {
  const parent = getChannel(ctx, cid);
  const g = parent?.guild ?? ctx.guild;
  if (!g) throw new BDScriptError("threads need a community");
  const ch: any = await g.channels.create({ name, parent: parent.parentId ?? undefined } as any);
  ctx.bot.threads.set(ch.id, { parent: parent.id, members: new Set() });
  return truthy(returnId) ? ch.id : "";
}, { ...req(1), status: "partial", note: "creates a channel next to the parent" });
fn("editThread", async (ctx, tid, name = "", _archived = "", _archive = "", locked = "") => {
  const ch = getChannel(ctx, tid);
  const o: any = {};
  if (name) o.name = name;
  if (locked.trim()) o.readOnly = truthy(locked);
  if (Object.keys(o).length) await ch.edit(o);
  return "";
}, { ...req(1), status: "partial" });
const thread = (ctx: Context, id: string) => {
  const k = stripMention(id);
  if (!ctx.bot.threads.has(k)) ctx.bot.threads.set(k, { members: new Set() });
  return ctx.bot.threads.get(k)!;
};
fn("threadAddMember", (ctx, tid, uid) => (thread(ctx, tid).members.add(stripMention(uid)), ""), { ...req(2), status: "partial" });
fn("threadRemoveMember", (ctx, tid, uid) => (thread(ctx, tid).members.delete(stripMention(uid)), ""), { ...req(2), status: "partial" });
fn("threadMessageCount", (ctx, tid = "") => String(ctx.bot.messageCounts.get(getChannel(ctx, tid).id) ?? 0), { status: "partial" });
fn("threadUserCount", (ctx, tid = "") => String(ctx.bot.threads.get(getChannel(ctx, tid).id)?.members.size ?? 0), { status: "partial" });

// -- webhooks -------------------------------------------------------------------------------------------------------
async function hook(ctx: Context, url: string) {
  const { Webhook } = await import("../../structures/Webhook");
  return Webhook.fromURL(url.trim(), ctx.client);
}
const pending = (ctx: Context, url: string): { content: string; embed: Record<string, string>; username: string | null } => {
  const all = (ctx.extras.webhooks ??= {});
  return (all[url.trim()] ??= { content: "", embed: {}, username: null });
};
fn("webhookCreate", async (ctx, cid, username) => (await getChannel(ctx, cid).createWebhook({ name: username })).url, req(2));
fn("webhookSend", async (ctx, url, content = "", title = "", titleUrl = "", description = "", color = "", author = "", authorIcon = "", footer = "", footerIcon = "", thumbnail = "", image = "", addTs = "no") => {
  const p = pending(ctx, url);
  content ||= p.content;
  title ||= p.embed.title ?? "";
  description ||= p.embed.description ?? "";
  color ||= p.embed.color ?? "";
  footer ||= p.embed.footer ?? "";
  let em: EmbedBuilder | null = null;
  if (title || description || footer || image || thumbnail || author) {
    em = new EmbedBuilder();
    if (title) em.setTitle(title);
    if (titleUrl) em.setURL(titleUrl);
    if (description) em.setDescription(description);
    if (color) em.setColor(colourValue(color));
    if (author) em.setAuthor({ name: author, iconURL: authorIcon || undefined });
    if (footer) em.setFooter({ text: footer, iconURL: footerIcon || undefined });
    if (thumbnail) em.setThumbnail(thumbnail);
    if (image) em.setImage(image);
    if (truthy(addTs)) em.setTimestamp();
  }
  await (await hook(ctx, url)).send({ content: content || null, embeds: em ? [em] : [], username: p.username ?? undefined });
  delete ctx.extras.webhooks?.[url.trim()];
  return "";
}, req(1));
fn("webhookDelete", async (ctx, url) => (await (await hook(ctx, url)).delete(), ""), req(1));
fn("webhookContent", (ctx, url, ...t) => ((pending(ctx, url).content = t.join(";")), ""), req(2));
for (const [name, key] of [["webhookTitle", "title"], ["webhookDescription", "description"], ["webhookColor", "color"], ["webhookFooter", "footer"]]) {
  fn(name, (ctx, url, ...t) => ((pending(ctx, url).embed[key] = t.join(";")), ""), req(2));
}
fn("webhookUsername", (ctx, url, name) => ((pending(ctx, url).username = name), ""), req(2));
fn("webhookAvatarURL", () => "", { ...req(2), status: "noop", note: "Vector messages always use the bot's avatar" });
