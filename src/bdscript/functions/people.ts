/** Users, members, roles, permissions, and D.js-BDscript's condensed $user/$member/$role/$client/$server/$channel. */
import { randomInt } from "node:crypto";
import { escape } from "../parser";
import { BDScriptError, fn, req, none } from "../registry";
import { bdfdDate, getChannel, getGuild, getMember, getRole, getUser, permName, permNames, stripMention, toInt, truthy, ts } from "../util";
import { goFormat } from "./timefn";
import type { Context } from "../context";

const name = (u: any) => escape(u?.username ?? "");
const avatar = (u: any) => u?.displayAvatarURL?.() ?? u?.avatar ?? "";
const userRoles = (m: any): any[] => [...m.roles.cache.values()].filter((r: any) => !r.isEveryone()).sort((a: any, b: any) => a.position - b.position);
const members = (ctx: Context): any[] => {
  if (!ctx.guild) throw new BDScriptError("this only works in a community");
  return [...ctx.guild.members.cache.values()];
};
const pool = (ctx: Context): any[] => [...(ctx.guild ? [...ctx.guild.members.cache.values()].map((m: any) => m.user) : []), ...ctx.client.users.cache.values()];
const isAdmin = (m: any) => m.isOwner || m.permissions.has("Administrator");
const userDate = (d: Date | null, layout: string, ctx: Context) => (d ? (layout ? goFormat(d, layout, ctx.extras.timezone) : bdfdDate(d)) : "");

fn("authorID", (ctx) => ctx.authorId, none);
fn(["username", "usernameComplex"], (ctx, uid = "") => name(getUser(ctx, uid)));
fn("userID", (ctx, n = "") => {
  if (!n.trim()) return ctx.authorId;
  const want = n.split("#")[0].trim().toLowerCase();
  const u = pool(ctx).find((x) => [x.username, x.displayName].some((v) => (v ?? "").toLowerCase() === want));
  if (!u) throw new BDScriptError(`user '${n}' not found`);
  return u.id;
});
fn("discriminator", () => "0");
fn(["displayName", "displayNameComplex"], (ctx, uid = "") => {
  const m = ctx.guild ? getMember(ctx, uid, undefined, false) : null;
  return escape(m?.displayName ?? getUser(ctx, uid)?.displayName ?? "");
});
fn(["nickname", "nicknameComplex"], (ctx, uid = "", gid = "") => {
  const m = getMember(ctx, uid, getGuild(ctx, gid), false);
  return escape(m?.nickname ?? m?.user?.username ?? "");
});
fn("userAvatar", (ctx, uid = "") => avatar(getUser(ctx, uid)));
fn("authorAvatar", (ctx) => avatar(ctx.author), none);
fn("userServerAvatar", (ctx, uid = "") => avatar(getUser(ctx, uid)));
fn("userBanner", (ctx, uid = "") => getUser(ctx, uid)?.banner ?? "");
fn("userBannerColor", () => "", { status: "noop", note: "Vector profiles have no banner colour" });
fn("userBadges", (ctx, uid = "") => (getUser(ctx, uid)?.bot ? "bot" : ""), { status: "noop", note: "no badges on Vector" });
fn("hypesquad", () => "none", { status: "noop", note: "no HypeSquad on Vector" });
fn("userInfo", (ctx, ...msg) => {
  const u = getUser(ctx, "");
  const e = ctx.response.embed(1);
  e.setTitle(u.displayName ?? u.username);
  const a = avatar(u);
  if (a) e.setThumbnail(a);
  e.addFields({ name: "ID", value: u.id, inline: false });
  const m = ctx.guild ? getMember(ctx, "", undefined, false) : null;
  if (m) e.addFields({ name: "Roles", value: userRoles(m).map((r) => r.name).join(", ") || "none", inline: false });
  if (msg.length) e.setDescription(msg.join(";"));
  return "";
});
fn("userJoined", (ctx, uid = "", layout = "") => userDate(getMember(ctx, uid).joinedAt, layout, ctx));
fn("userJoinedDiscord", (ctx, uid = "", layout = "") => userDate(getUser(ctx, uid).createdAt, layout, ctx));
fn("userExists", (ctx, uid) => getUser(ctx, uid, false) !== null || stripMention(uid).startsWith("npub1"), req(1));
fn("isBot", (ctx, uid = "") => Boolean(getUser(ctx, uid)?.bot));
fn("isAdmin", (ctx, uid = "") => isAdmin(getMember(ctx, uid)));
fn("isBooster", () => false, { status: "noop", note: "no boosting on Vector" });
fn("isTimedOut", (ctx, uid = "") => getMember(ctx, uid).isCommunicationDisabled());
fn("getUserStatus", () => "online");
fn("getCustomStatus", (ctx, uid = "") => escape(getUser(ctx, uid)?.profile?.status ?? ""));
fn("isUserDMEnabled", () => true);
fn("authorOfMessage", async (ctx, cid, mid) => (await getChannel(ctx, cid).messages.fetch(mid)).author.id, req(2));
fn("findUser", (ctx, query, returnAuthor = "yes") => {
  const q = stripMention(query).toLowerCase();
  const all = pool(ctx);
  const exact = all.find((u) => u.id.toLowerCase() === q)
    ?? all.find((u) => [u.username, u.displayName, ctx.guild?.members.cache.get(u.id)?.nickname].some((v) => (v ?? "").toLowerCase() === q))
    ?? (q ? all.find((u) => (u.username ?? "").toLowerCase().includes(q)) : undefined);
  return exact?.id ?? (truthy(returnAuthor, true) ? ctx.authorId : "");
}, req(1));
const pick = <T>(a: T[]): T => {
  if (!a.length) throw new BDScriptError("no members cached");
  return a[randomInt(0, a.length)];
};
fn("randomUser", (ctx) => name(pick(members(ctx)).user), none);
fn("randomUserID", (ctx) => pick(members(ctx)).id, none);
fn("randomMention", (ctx) => pick(members(ctx)).user.toString(), none);
fn("changeUsername", async (ctx, nick) => (await getMember(ctx, "").setNickname(nick || null), ""), req(1));
fn("changeUsernameWithID", async (ctx, uid, nick) => (await getMember(ctx, uid).setNickname(nick || null), ""), req(2));

// -- permissions & roles of members ----------------------------------------------------------------------------
fn("userPerms", (ctx, uid = "", amount = "-1", sep = ", ") => {
  const m = getMember(ctx, uid);
  const names = permNames(m.permissions.bitfield);
  if (isAdmin(m)) names.unshift("admin");
  const n = amount.trim() ? toInt(amount) : -1;
  return (n < 0 ? names : names.slice(0, n)).join(sep || ", ");
});
fn("checkUserPerms", (ctx, uid, ...perms) => {
  const m = getMember(ctx, uid);
  return perms.every((p) => {
    const flag = permName(p);
    return flag === "Administrator" ? isAdmin(m) : m.permissions.has(flag);
  });
}, req(2));
fn("userRoles", (ctx, uid = "", _gid = "", option = "ids", sep = ", ") => {
  const roles = userRoles(getMember(ctx, uid));
  const o = option.trim().toLowerCase();
  if (o === "names" || o === "name") return roles.map((r) => r.name).join(sep || ", ");
  if (o === "mentions" || o === "mention") return roles.map((r) => `@${r.name}`).join(sep || ", ");
  return roles.map((r) => r.id).join(sep || ", ");
});
fn("hasRole", (ctx, uid, role) => getMember(ctx, uid).roles.cache.has(getRole(ctx, role).id), req(2));
fn(["highestRole", "highestRoleComplex"], (ctx, uid = "") => userRoles(getMember(ctx, uid)).pop()?.id ?? "");
fn(["lowestRole", "lowestRoleComplex"], (ctx, uid = "") => userRoles(getMember(ctx, uid))[0]?.id ?? "");
const rolesWith = (ctx: Context, perms: string[]) => {
  const wanted = perms.filter((p) => p.trim()).map(permName);
  return userRoles(getMember(ctx, "")).filter((r) => wanted.every((w) => r.permissions.has(w)));
};
fn("highestRoleWithPerms", (ctx, ...p) => rolesWith(ctx, p).pop()?.id ?? "", req(1));
fn("lowestRoleWithPerms", (ctx, ...p) => rolesWith(ctx, p)[0]?.id ?? "", req(1));

// -- D.js-BDscript condensed functions ------------------------------------------------------------------------
function prop(table: Record<string, () => unknown>, p: string, what: string): string {
  if (!(p in table)) throw new BDScriptError(`invalid ${what} property '${p}'. Valid: ${Object.keys(table).join(", ")}`);
  return escape(String(table[p]() ?? ""));
}
fn("user", (ctx, uid, p = "username") => {
  const u = getUser(ctx, uid);
  return prop({
    id: () => u.id, username: () => u.username, tag: () => u.tag ?? u.username, discriminator: () => "0", avatar: () => avatar(u),
    bot: () => String(Boolean(u.bot)), badges: () => "", createdTimestamp: () => ts(u.createdAt, "ms"), lastMessageChannelID: () => "",
    lastMessageID: () => "", mention: () => u.toString(), displayName: () => u.displayName ?? u.username, npub: () => u.id,
    about: () => u.about ?? "", banner: () => u.banner ?? "", status: () => u.profile?.status ?? "",
  }, p.trim(), "user");
}, req(1));
fn("member", (ctx, uid, p = "displayName") => {
  const m = getMember(ctx, uid);
  const top = userRoles(m).pop();
  const color = m.roles.color?.color ?? 0;
  return prop({
    guildID: () => m.guild.id, voiceChannelID: () => "", nickname: () => m.nickname ?? "", displayName: () => m.displayName,
    joinedTimestamp: () => (m.joinedTimestamp ? String(m.joinedTimestamp) : ""), id: () => m.id, hexColor: () => `#${color.toString(16).padStart(6, "0")}`,
    color: () => String(color), highestRoleID: () => top?.id ?? "", permissions: () => permNames(m.permissions.bitfield).join(", "),
    roles: () => userRoles(m).map((r) => r.id).join(", "), isAdmin: () => String(isAdmin(m)), timedOut: () => String(m.isCommunicationDisabled()),
  }, p.trim(), "member");
}, req(1));
fn("role", (ctx, rid, p = "name") => {
  const r = getRole(ctx, rid);
  return prop({
    permissions: () => permNames(r.permissions.bitfield).join(", "), name: () => r.name, id: () => r.id, position: () => String(r.position),
    isEveryoneRole: () => String(r.isEveryone()), isMentionable: () => String(r.mentionable), members: () => [...r.members.keys()].join(", "),
    mention: () => `@${r.name}`, hexColor: () => r.hexColor, color: () => String(r.color), hoist: () => String(r.hoist),
  }, p.trim(), "role");
}, req(1));
fn("client", (ctx, p) => {
  const c = ctx.client;
  const users = [...c.users.cache.values()];
  const channels = () => c.channels.cache.size;
  return prop({
    id: () => c.user?.id, users: () => users.length, guilds: () => c.guilds.cache.size, channels, emojis: () => c.emojis.cache.size,
    commands: () => ctx.bot.commands.length, guildCount: () => c.guilds.cache.size, userCount: () => users.length,
    botCount: () => users.filter((u) => u.bot).length, channelCount: channels, owners: () => ctx.bot.owners.join(", "),
    name: () => c.user?.username, npub: () => c.user?.id, ping: () => c.ws.ping,
  }, p.trim(), "client");
}, req(1));
fn("server", (ctx, gid, p = "name") => {
  const g = getGuild(ctx, gid);
  return prop({
    id: () => g.id, name: () => g.name, description: () => g.description ?? "", ownerID: () => g.ownerId ?? "", memberCount: () => g.memberCount,
    members: () => [...g.members.cache.keys()].join(", "), roles: () => [...g.roles.cache.keys()].join(", "), channels: () => [...g.channels.cache.keys()].join(", "),
    emojis: () => [...ctx.client.emojis.cache.values()].map(String).join(", "), systemChannelID: () => g.systemChannelId ?? "", available: () => "true",
    afkChannelID: () => "", afkTimeout: () => "0", rulesChannelID: () => "", region: () => "nostr", verificationLevel: () => "none", premiumTier: () => "0",
    premiumSubscriptionCount: () => "0", isPartnered: () => "false", mfaLevel: () => "none", preferredLocale: () => "en-US", features: () => "",
    publicUpdatesChannelID: () => "", explicitContentFilter: () => "disabled", defaultMessageNotifications: () => "all", commands: () => ctx.bot.commands.length,
    bans: () => [...g.bans.cache.keys()].join(", "),
  }, p.trim(), "server");
}, req(1));
fn("channel", (ctx, cid, p = "name") => {
  const c = getChannel(ctx, cid);
  return prop({
    id: () => c.id, name: () => c.name ?? "", type: () => c.constructor.name.replace("Channel", "").toLowerCase(), topic: () => c.topic ?? "",
    position: () => c.position ?? 0, parentID: () => c.parentId ?? "", guildID: () => c.guild?.id ?? "", mention: () => `#${c.name ?? ""}`,
    nsfw: () => "false", deleteable: () => "true", manageable: () => "true", readOnly: () => String(Boolean(c.readOnly)),
  }, p.trim(), "channel");
}, req(1));
