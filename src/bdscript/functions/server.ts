/** Servers (Vector communities), channels, roles, moderation. */
import { randomInt } from "node:crypto";
import { escape } from "../parser";
import { BDScriptError, fn, req, none } from "../registry";
import { getChannel, getGuild, getMember, getRole, getUser, permName, permNames, seconds, stripMention, toInt, truthy } from "../util";
import { colourValue } from "./embeds";
import { ChannelType } from "../../util/Constants";
import { PermissionsBitField } from "../../util/PermissionsBitField";
import type { Context } from "../context";

const g = (ctx: Context, gid = ""): any => getGuild(ctx, gid);
const chans = (guild: any): any[] => [...guild.channels.cache.values()];
const cats = (guild: any) => chans(guild).filter((c) => c.type === ChannelType.GuildCategory);
const nonCats = (guild: any) => chans(guild).filter((c) => c.type !== ChannelType.GuildCategory);
const roles = (guild: any): any[] => [...guild.roles.cache.values()].filter((r: any) => !r.isEveryone());
const guilds = (ctx: Context): any[] => [...ctx.client.guilds.cache.values()];
const pick = <T>(a: T[]): T | undefined => (a.length ? a[randomInt(0, a.length)] : undefined);
const byName = <T extends { name: string; id: string }>(list: T[], q: string) => list.find((x) => x.id === q.trim() || x.name === q.trim() || x.name.toLowerCase() === q.trim().toLowerCase());

// -- servers -----------------------------------------------------------------------------------------------------
fn("serverName", (ctx, gid = "") => escape(g(ctx, gid).name ?? ""));
fn(["guildID", "guildIDComplex"], (ctx, name = "") => (name.trim() ? byName(guilds(ctx), name)?.id ?? "" : ctx.guildId));
fn(["serverIcon", "serverIconComplex"], (ctx, gid = "") => g(ctx, gid).iconURL() ?? "");
fn(["serverOwner", "serverOwnerComplex"], (ctx, gid = "") => g(ctx, gid).ownerId ?? "");
fn(["membersCount", "membersCountComplex", "allMembersCount"], (ctx, gidOrPresence = "") => {
  let guild: any = ctx.guild;
  if (gidOrPresence && !["online", "idle", "dnd", "offline", "invisible"].includes(gidOrPresence.toLowerCase())) guild = g(ctx, gidOrPresence);
  return String(guild ? guild.memberCount : guilds(ctx).reduce((n, x) => n + x.memberCount, 0));
});
fn("roleCount", (ctx, gid = "") => String(roles(g(ctx, gid)).length));
fn("channelCount", (ctx, gid = "") => String(nonCats(g(ctx, gid)).length));
fn(["categoryCount", "categoryCountComplex"], (ctx, gid = "") => String(cats(g(ctx, gid)).length));
fn("serverInfo", (ctx, msg = "") => {
  const guild = g(ctx);
  const e = ctx.response.embed(1).setTitle(guild.name);
  e.addFields(
    { name: "Owner", value: guild.ownerId ? `nostr:${guild.ownerId}` : "?", inline: true },
    { name: "Members", value: String(guild.memberCount), inline: true },
    { name: "Channels", value: String(nonCats(guild).length), inline: true },
    { name: "Roles", value: String(roles(guild).length), inline: true },
  );
  if (msg) e.setDescription(msg);
  return "";
});
fn(["serverDescription", "serverDescriptionComplex"], (ctx, gid = "") => escape(g(ctx, gid).description ?? ""));
fn("serverRegion", () => "nostr", { status: "noop", note: "Vector has relays instead of regions" });
fn("serverVerificationLvl", () => "none", { status: "noop" });
fn(["boostCount", "boostCountComplex", "boostLevel"], () => "0", { status: "noop", note: "no boosts on Vector" });
fn("guildBanner", (ctx, gid = "") => g(ctx, gid).bannerURL?.() ?? "");
fn(["afkChannelID", "afkTimeout", "rulesChannelID"], () => "", { status: "noop" });
fn("systemChannelID", (ctx, gid = "") => g(ctx, gid).systemChannelId ?? "");
fn("serverEmojis", (ctx, _gid = "", sep = ", ") => [...ctx.client.emojis.cache.values()].map(String).join(sep || ", "));
fn("emoteCount", (ctx) => String(ctx.client.emojis.cache.size));
fn(["serverChannelExists", "channelExists"], (ctx, cid) => getChannel(ctx, cid, false) !== null, req(1));
fn("guildExists", (ctx, gid) => ctx.client.guilds.cache.has(gid.trim()), req(1));
fn("serverCount", (ctx) => String(ctx.client.guilds.cache.size), none);
fn(["serverNames", "serverNamesComplex"], (ctx, amount = "", sep = ", ") => {
  const names = guilds(ctx).map((x) => x.name);
  return names.slice(0, amount.trim() ? toInt(amount) : names.length).join(sep || ", ");
});
fn("randomGuildID", (ctx) => pick(guilds(ctx))?.id ?? "", none);
fn(["botLeave", "botLeaveComplex"], async (ctx, gid = "") => (await g(ctx, gid).leave(), ""));
fn(["getServerInvite", "getServerInviteComplex"], async (ctx, gid = "") => String((await g(ctx, gid).invites.create()).url));
fn("getInviteInfo", async (ctx, code, p) => {
  const prev: any = await ctx.client._native().call("preview_link", { invite_url: code }, null).then((r) => r.value).catch(() => null);
  if (!prev) throw new BDScriptError(`invalid invite '${code}'`);
  const table: Record<string, () => string> = {
    guildid: () => prev.community_id ?? "", guildname: () => prev.name ?? "", code: () => code, url: () => code,
    inviterid: () => prev.inviter ?? "", uses: () => "0", maxuses: () => "0",
  };
  const k = p.trim().toLowerCase();
  if (!table[k]) throw new BDScriptError(`invalid invite property '${p}'`);
  return escape(table[k]());
}, req(2));
fn("getBotInvite", (ctx) => `nostr:${ctx.client.user?.id ?? ""}`, none);

// -- channels ----------------------------------------------------------------------------------------------------
fn(["channelID", "channelIDComplex", "channelIDFromName"], (ctx, name = "") => {
  if (!name.trim()) return ctx.channelId;
  const want = name.trim().toLowerCase();
  return chans(g(ctx)).find((c) => c.name === name.trim() || c.name.toLowerCase() === want || c.name.replace(/^.*┊/, "").toLowerCase() === want)?.id ?? "";
});
fn("channelName", (ctx, cid = "") => escape(getChannel(ctx, cid)?.name ?? "DM"));
fn("channelNames", (ctx, sep = ", ", gid = "") => nonCats(g(ctx, gid)).map((c) => c.name).join(sep || ", "));
fn(["channelPosition", "channelPositionComplex"], (ctx, cid = "") => String(getChannel(ctx, cid)?.position ?? 0));
fn(["channelTopic", "channelTopicComplex"], (ctx, cid = "") => escape(getChannel(ctx, cid)?.topic ?? ""));
fn("channelType", (ctx, cid = "") => {
  const t = getChannel(ctx, cid)?.type;
  return t === ChannelType.GuildVoice ? "voice" : t === ChannelType.GuildCategory ? "category" : t === ChannelType.DM ? "dm" : t === ChannelType.GuildForum ? "forum" : "text";
});
fn("categoryChannels", (ctx, cat, sep = ", ", option = "ids") => {
  const c = byName(cats(g(ctx)), stripMention(cat));
  if (!c) throw new BDScriptError(`invalid category '${cat}'`);
  const children = nonCats(g(ctx)).filter((x) => x.parentId === c.id);
  const o = option.trim().toLowerCase();
  if (o === "names" || o === "name") return children.map((x) => x.name).join(sep || ", ");
  if (o === "count") return String(children.length);
  return children.map((x) => x.id).join(sep || ", ");
}, req(1));
fn("categoryID", (ctx, name) => byName(cats(g(ctx)), name)?.id ?? "", req(1));
fn(["parentID", "parentIDComplex"], (ctx, cid = "") => getChannel(ctx, cid)?.parentId ?? "");
fn("createChannel", async (ctx, name, kind, category = "", returnId = "no") => {
  const guild = g(ctx);
  const parent = category.trim() ? byName(cats(guild), category)?.id : undefined;
  const k = kind.trim().toLowerCase();
  const type = { text: ChannelType.GuildText, chat: ChannelType.GuildText, voice: ChannelType.GuildVoice, category: ChannelType.GuildCategory, forum: ChannelType.GuildForum }[k];
  if (type === undefined) throw new BDScriptError(`invalid channel type '${kind}' (text/voice/category/forum)`);
  const c: any = await guild.channels.create({ name, type, parent });
  ctx.extras.last_channel_id = c.id;
  return truthy(returnId) ? c.id : "";
}, req(2));
fn("deleteChannels", async (ctx, ...cids) => {
  for (const c of cids) await getChannel(ctx, c).delete();
  return "";
}, req(1));
fn("deleteChannelsByName", async (ctx, ...names) => {
  for (const n of names) for (const c of chans(g(ctx)).filter((x) => x.name === n)) await c.delete();
  return "";
}, req(1));
fn("modifyChannel", async (ctx, cid, name = "", topic = "", _nsfw = "", position = "", category = "") => {
  const c = getChannel(ctx, cid);
  if (!c?.edit || !c.guild) throw new BDScriptError(`'${cid}' isn't a community channel`);
  const o: any = {};
  if (name) o.name = name;
  if (topic) o.topic = topic;
  if (position.trim()) o.position = toInt(position);
  if (category.trim()) o.parent = byName(cats(g(ctx)), category)?.id;
  await c.edit(o);
  return "";
}, req(1));

function permList(items: string[]): Record<string, boolean | null> {
  const out: Record<string, boolean | null> = {};
  for (let p of items) {
    p = p.trim();
    if (!p) continue;
    const sign = p[0];
    const n = permName("+-/".includes(sign) ? p.slice(1) : p);
    out[n] = sign === "-" ? false : sign === "/" ? null : true;
  }
  return out;
}
function overwriteTarget(ctx: Context, tid: string): string {
  const guild = g(ctx);
  const t = stripMention(tid);
  if (t === guild.id || t.toLowerCase() === "everyone") return guild.id;
  const r = guild.roles.cache.get(t) ?? byName(roles(guild), tid);
  if (r) return r.id;
  if (guild.members.cache.has(t) || t.startsWith("npub1")) return t;
  throw new BDScriptError(`invalid user/role '${tid}'`);
}
fn("modifyChannelPerms", async (ctx, cid, ...rest) => {
  const tid = rest.pop()!; // BDFD: target last
  await getChannel(ctx, cid).permissionOverwrites.edit(overwriteTarget(ctx, tid), permList(rest));
  return "";
}, req(3));
fn("editChannelPerms", async (ctx, cid, tid, ...perms) => (await getChannel(ctx, cid).permissionOverwrites.edit(overwriteTarget(ctx, tid), permList(perms)), ""), req(3));
fn("slowmode", (ctx, cid, d) => (ctx.bot.slowmodes.set(getChannel(ctx, cid).id, ["0", ""].includes(d.trim()) ? 0 : Math.floor(seconds(d))), ""), { ...req(2), status: "partial", note: "stored; Vector has no slowmode yet" });
fn("getSlowmode", (ctx, cid = "") => String(ctx.bot.slowmodes.get(getChannel(ctx, cid).id) ?? 0));
fn("isNSFW", () => false);
fn("findChannel", (ctx, query, returnCurrent = "yes") => {
  const q = stripMention(query).toLowerCase();
  const list = ctx.guild ? chans(ctx.guild) : [];
  const hit = list.find((c) => c.id.toLowerCase() === q || c.name.toLowerCase() === q) ?? (q ? list.find((c) => c.name.toLowerCase().includes(q)) : undefined);
  return hit?.id ?? (truthy(returnCurrent, true) ? ctx.channelId : "");
}, req(1));
fn(["randomChannelID", "'randomChannelID"], (ctx) => pick(nonCats(g(ctx)).filter((c) => c.type === ChannelType.GuildText))?.id ?? "", none);
fn("randomCategoryID", (ctx, gid = "") => pick(cats(g(ctx, gid)))?.id ?? "");
fn("lastPinTimestamp", async (ctx, cid = "") => {
  const pins = [...(await getChannel(ctx, cid).fetchPinned()).values()] as any[];
  return pins.length ? String(Math.floor(pins[0].createdTimestamp / 1000)) : "";
});
fn("dmChannelID", (ctx, uid = "") => getUser(ctx, uid).id); // a DM's id is the user's npub
fn("voiceUserLimit", () => "0");
fn("useChannel", (ctx, cid) => ((ctx.response.channelId = getChannel(ctx, cid).id), ""), req(1));

// -- roles -------------------------------------------------------------------------------------------------------
fn("roleID", (ctx, name) => getRole(ctx, name, undefined, false)?.id ?? "", req(1));
fn("roleName", (ctx, rid) => escape(getRole(ctx, rid).name), req(1));
fn("roleNames", (ctx, sep = ", ") => roles(g(ctx)).map((r) => r.name).join(sep || ", "));
fn("rolePerms", (ctx, ...a) => {
  let guild: any = ctx.guild, rid = a[0], sep = a[1] ?? ", ";
  if (a.length >= 2 && ctx.client.guilds.cache.has(a[0].trim())) [guild, rid, sep] = [ctx.client.guilds.cache.get(a[0].trim()), a[1], a[2] ?? ", "];
  return permNames(getRole(ctx, rid, guild).permissions.bitfield).join(sep || ", ");
}, req(1));
fn("rolePosition", (ctx, rid) => String(getRole(ctx, rid).position), req(1));
fn("roleExists", (ctx, rid) => getRole(ctx, rid, undefined, false) !== null, req(1));
fn("roleInfo", (ctx, rid) => {
  const r = getRole(ctx, rid);
  ctx.response.embed(1).setTitle(r.name).addFields(
    { name: "ID", value: r.id, inline: true }, { name: "Members", value: String(r.members.size), inline: true },
    { name: "Permissions", value: permNames(r.permissions.bitfield).join(", ") || "none", inline: false },
  );
  return "";
}, req(1));
fn("getRoleColor", (ctx, rid) => getRole(ctx, rid).color.toString(16).padStart(6, "0"), req(1));
fn("isHoisted", (ctx, rid) => Boolean(getRole(ctx, rid).hoist), req(1));
fn("isMentionable", (ctx, rid) => Boolean(getRole(ctx, rid).mentionable), req(1));
fn("createRole", async (ctx, name, color = "", hoist = "no", mentionable = "no", returnId = "no") => {
  const o: any = { name, hoist: truthy(hoist), mentionable: truthy(mentionable) };
  if (color.trim()) o.color = colourValue(color);
  const r = await g(ctx).roles.create(o);
  return truthy(returnId) ? r.id : "";
}, req(1));
fn("deleteRole", async (ctx, rid) => (await getRole(ctx, rid).delete(), ""), req(1));
async function give(ctx: Context, a: string, b: string, add: boolean) {
  const [m, r] = b.trim() ? [getMember(ctx, a), getRole(ctx, b)] : [getMember(ctx, ""), getRole(ctx, a)];
  await (add ? m.roles.add(r) : m.roles.remove(r));
}
fn("giveRole", async (ctx, a, b = "") => (await give(ctx, a, b, true), ""), req(1));
fn("takeRole", async (ctx, a, b = "") => (await give(ctx, a, b, false), ""), req(1));
fn("roleGrant", async (ctx, uid, ...changes) => {
  const m = getMember(ctx, uid);
  for (let c of changes) {
    c = c.trim();
    if (!c) continue;
    if (c[0] === "-") await m.roles.remove(getRole(ctx, c.slice(1)));
    else if (c[0] === "!") {
      const r = getRole(ctx, c.slice(1));
      await (m.roles.cache.has(r.id) ? m.roles.remove(r) : m.roles.add(r));
    } else await m.roles.add(getRole(ctx, c[0] === "+" ? c.slice(1) : c));
  }
  return "";
}, req(2));
fn("setUserRoles", async (ctx, uid, ...rids) => (await getMember(ctx, uid).roles.set(rids.filter((r) => r.trim()).map((r) => getRole(ctx, r))), ""), req(1));
fn("modifyRole", async (ctx, rid, name = "", color = "", hoist = "", mentionable = "") => {
  const o: any = {};
  if (name) o.name = name;
  if (color.trim()) o.color = colourValue(color);
  if (hoist.trim()) o.hoist = truthy(hoist);
  if (mentionable.trim()) o.mentionable = truthy(mentionable);
  await getRole(ctx, rid).edit(o);
  return "";
}, req(1));
fn("modifyRolePerms", async (ctx, rid, ...perms) => {
  const r = getRole(ctx, rid);
  const p = new PermissionsBitField(r.permissions.bitfield);
  for (const [k, v] of Object.entries(permList(perms))) v ? p.add(k as any) : p.remove(k as any);
  await r.edit({ permissions: p.bitfield });
  return "";
}, req(2));
fn("colorRole", async (ctx, color, rid = "") => {
  const r = rid.trim() ? getRole(ctx, rid) : [...getMember(ctx, "").roles.cache.values()].filter((x: any) => !x.isEveryone()).sort((a: any, b: any) => a.position - b.position).pop();
  if (!r) throw new BDScriptError("no role to colour");
  await r.edit({ color: colourValue(color) });
  return "";
}, req(1));
fn("findRole", (ctx, query) => {
  const q = stripMention(query).toLowerCase();
  const list = roles(g(ctx));
  return (list.find((r) => r.id.toLowerCase() === q || r.name.toLowerCase() === q) ?? (q ? list.find((r) => r.name.toLowerCase().includes(q)) : undefined))?.id ?? "";
}, req(1));
fn("randomRoleID", (ctx, gid = "") => pick(roles(g(ctx, gid)))?.id ?? "");

// -- moderation --------------------------------------------------------------------------------------------------
function firstMention(ctx: Context): string {
  const ids = [...((ctx.message as any)?.mentions?.users?.keys?.() ?? [])] as string[];
  const fromArgs = ctx.args.find((a) => /^nostr:npub1|^npub1|^<@/.test(a));
  const id = ids[0] ?? (fromArgs ? stripMention(fromArgs) : "");
  if (!id) throw new BDScriptError("no user mentioned");
  return id;
}
function looksLikeUser(ctx: Context, v: string): boolean {
  const s = stripMention(v ?? "");
  if (!s) return false;
  return s.startsWith("npub1") || /^[0-9a-f]{64}$/i.test(s) || /^\d{15,}$/.test(s) || Boolean(ctx.guild?.members.cache.has(s));
}
fn(["ban", "banComplex"], async (ctx, a = "", b = "") => {
  const [uid, reason] = looksLikeUser(ctx, a) ? [a, b] : [firstMention(ctx), a];
  await g(ctx).members.ban(stripMention(uid), { reason: reason || undefined });
  return "";
});
fn(["banID", "banIDComplex"], async (ctx, a = "", b = "") => {
  const [target, reason] = looksLikeUser(ctx, a) ? [a, b] : [b.trim() || ctx.args[0] || "", a];
  if (!target) throw new BDScriptError("no user ID");
  await g(ctx).members.ban(stripMention(target), { reason: reason || undefined });
  return "";
});
fn(["kick", "kickComplex"], async (ctx, uid = "", reason = "") => (await g(ctx).members.kick(stripMention(uid.trim() || firstMention(ctx)), reason || undefined), ""));
fn("kickMention", async (ctx, reason = "") => (await g(ctx).members.kick(firstMention(ctx), reason || undefined), ""));
fn("unban", async (ctx, uid = "") => {
  const target = uid.trim() || ctx.args[0] || "";
  if (!target) throw new BDScriptError("no user ID in the message");
  await g(ctx).members.unban(stripMention(target));
  return "";
});
fn(["unbanID", "unbanIDComplex"], async (ctx, uid = "") => (await g(ctx).members.unban(stripMention(uid.trim() || ctx.args[0] || "")), ""));
fn("timeout", async (ctx, duration, uid = "", ...reason) => {
  if (looksLikeUser(ctx, duration) && !looksLikeUser(ctx, uid)) [duration, uid] = [uid, duration]; // $timeout[userID;duration;reason]
  await getMember(ctx, uid).timeout(seconds(duration) * 1000, reason.join(";") || undefined);
  return "";
}, req(1));
fn("untimeout", async (ctx, uid = "") => (await getMember(ctx, uid).timeout(null), ""));
fn("mute", async (ctx, role, uid = "") => (await getMember(ctx, uid.trim() || firstMention(ctx)).roles.add(getRole(ctx, role)), ""), req(1));
fn("unmute", async (ctx, role, uid = "") => (await getMember(ctx, uid.trim() || firstMention(ctx)).roles.remove(getRole(ctx, role)), ""), req(1));
fn("isBanned", async (ctx, uid, gid = "") => (await g(ctx, gid).bans.fetch()).has(stripMention(uid)), req(1));
fn("getBanReason", () => "", req(1));
fn(["clear", "clearComplex"], async (ctx, amount = "", uid = "", removePinned = "no", cid = "") => {
  const n = amount.trim() ? toInt(amount) : ctx.args.length ? toInt(ctx.args[0]) : 0;
  if (n <= 0) throw new BDScriptError("amount must be at least 1");
  const ch = getChannel(ctx, cid);
  const target = uid.trim() ? stripMention(uid) : null;
  const keepPinned = !truthy(removePinned);
  const msgs = [...(await ch.messages.fetch({ limit: Math.min(n + (ctx.message ? 1 : 0), 1000) })).values()] as any[];
  const doomed = msgs.filter((m) => m.id !== ctx.message?.id && (!target || m.author?.id === target) && !(keepPinned && m.pinned)).slice(0, n);
  await ch.bulkDelete(doomed);
  return "";
});
