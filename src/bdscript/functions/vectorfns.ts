/**
 * Vector-only functions: npubs and profiles, Mini Apps, community admins, private/read-only channels, disappearing
 * and hidden messages, blocking, emoji packs, image hosting, relays, raid containment, and `$community…` names for
 * the `$server…` functions.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { escape } from "../parser";
import { FUNCTIONS, BDScriptError, alias, fn, req, none } from "../registry";
import { getChannel, getGuild, getMember, getUser, seconds, stripMention, truthy } from "../util";
import { value } from "../../native";
import type { Context } from "../context";

const nat = (ctx: Context) => ctx.client._native();

fn("npub", (ctx, uid = "") => getUser(ctx, uid).id);
fn("authorNpub", (ctx) => ctx.authorId, none);
fn("botNpub", (ctx) => ctx.client.user?.id ?? "", none);
fn("isNpub", (_c, text) => {
  const t = stripMention(text);
  return t.startsWith("npub1") && t.length === 63;
}, req(1));
fn("userAbout", (ctx, uid = "") => escape(getUser(ctx, uid)?.about ?? ""));
fn("isDM", (ctx) => ctx.guild === null, none);
fn("setBotName", async (ctx, name) => (await ctx.client.user!.edit({ username: name }), ""), req(1));
fn("setBotAbout", async (ctx, ...t) => (await ctx.client.user!.edit({ about: t.join(";") }), ""), req(1));
fn("setBotAvatar", async (ctx, url) => (await ctx.client.user!.edit({ avatar: url.trim() }), ""), req(1));
fn("setBotBanner", async (ctx, url) => (await ctx.client.user!.edit({ banner: url.trim() }), ""), req(1));
fn("setBotStatus", async (ctx, ...t) => (await value(nat(ctx), "set_status", { status: t.join(";") }), ""), { brackets: "required" });
fn("blockUser", async (ctx, uid) => (await value(nat(ctx), "block", { npub: stripMention(uid) }), ""), req(1));
fn("unblockUser", async (ctx, uid) => (await value(nat(ctx), "unblock", { npub: stripMention(uid) }), ""), req(1));
fn("setLocalNickname", async (ctx, uid, nick) => (await value(nat(ctx), "set_local_nickname", { npub: stripMention(uid), nickname: nick }), ""), req(2));

// -- messages ------------------------------------------------------------------------------------------------------
fn(["expireIn", "disappearIn"], (ctx, d) => ((ctx.response.expiresIn = seconds(d)), ""), req(1));
fn("hideMessage", async (ctx, cid = "", mid = "") => {
  const msg: any = mid.trim() ? await getChannel(ctx, cid).messages.fetch(mid.trim()) : ctx.message;
  if (!msg) throw new BDScriptError("no message here; give a channel and message ID");
  await msg.hide();
  return "";
});
async function download(url: string, suffix: string, limit: number): Promise<string> {
  const r = await fetch(url, { signal: AbortSignal.timeout(20_000) });
  const data = Buffer.from(await r.arrayBuffer());
  if (data.length > limit) throw new BDScriptError("file too large");
  const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "bds-")), `file${suffix}`);
  fs.writeFileSync(p, data);
  return p;
}
fn(["sendMiniApp", "sendXdc"], async (ctx, source, cid = "", returnId = "no") => {
  const s = source.trim();
  let file = ctx.bot.miniApps.get(s) ?? null;
  if (!file && /^https?:\/\//.test(s)) file = await download(s, ".xdc", 50 * 1024 * 1024);
  if (!file && ctx.bot.allowFiles && fs.existsSync(s)) file = s;
  if (!file) throw new BDScriptError(`unknown Mini App '${source}' (register it: bot.miniApps.set('name', 'app.xdc'))`);
  const app = await getChannel(ctx, cid).sendMiniApp(file);
  return truthy(returnId) ? String(app?.message_id ?? "") : "";
}, req(1));
fn("uploadImage", async (ctx, source) => {
  const s = source.trim();
  let file: string;
  if (/^\d+$/.test(s)) {
    const atts: any[] = [...((ctx.message as any)?.attachments?.values?.() ?? [])];
    const i = parseInt(s, 10);
    if (!(i > 0 && i <= atts.length)) throw new BDScriptError(`no attachment ${i}`);
    file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "bds-")), atts[i - 1].name || "image.png");
    fs.writeFileSync(file, await atts[i - 1].download());
  } else if (/^https?:\/\//.test(s)) file = await download(s, ".png", 25 * 1024 * 1024);
  else throw new BDScriptError("give an image URL or an attachment number");
  try {
    return await value(nat(ctx), "upload_image", { path: file });
  } finally {
    fs.rmSync(path.dirname(file), { recursive: true, force: true });
  }
}, req(1));

// -- communities ---------------------------------------------------------------------------------------------------
fn("joinCommunity", async (ctx, invite, returnId = "yes") => {
  const g = await ctx.client.acceptInvite(invite.trim());
  return truthy(returnId, true) ? g.id : "";
}, req(1));
fn("createCommunity", async (ctx, name, description = "", firstChannel = "", returnId = "yes") => {
  const g = await ctx.client.guilds.create({ name, description: description || undefined, firstChannel: firstChannel || undefined });
  return truthy(returnId, true) ? g.id : "";
}, req(1));
fn("pendingInvites", async (ctx, sep = ", ") => (await ctx.client.fetchInvites()).map((p: any) => p.community_id ?? p.id ?? p).join(sep || ", "));
fn("acceptInvite", async (ctx, cid) => (await ctx.client.acceptInvite(cid.trim()), ""), req(1));
fn("grantAdmin", async (ctx, uid) => (await getMember(ctx, uid).grantAdmin(), ""), req(1));
fn("revokeAdmin", async (ctx, uid) => (await getMember(ctx, uid).revokeAdmin(), ""), req(1));
fn(["communityRelays", "relays"], async (ctx, sep = ", ", gid = "") => ((await value(nat(ctx), "community_relays", { community_id: getGuild(ctx, gid).id })) as string[]).join(sep || ", "));
fn("containRaid", async (ctx, window, ...uids) => {
  const g = getGuild(ctx);
  await g.containRaid(uids.filter((u) => u.trim()).map(stripMention), Date.now() - seconds(window) * 1000);
  return "";
}, req(2));

// -- channels ------------------------------------------------------------------------------------------------------
fn("grantChannelAccess", async (ctx, cid, uid) => (await getChannel(ctx, cid).grantAccess(getMember(ctx, uid).id), ""), req(2));
fn("revokeChannelAccess", async (ctx, cid, uid) => (await getChannel(ctx, cid).revokeAccess(getMember(ctx, uid).id), ""), req(2));
fn("setChannelPrivate", async (ctx, cid, v) => (await getChannel(ctx, cid).setPrivate(truthy(v)), ""), req(2));
fn("setChannelReadOnly", async (ctx, cid, v) => (await getChannel(ctx, cid).setReadOnly(truthy(v)), ""), req(2));
fn("isReadOnly", (ctx, cid = "") => Boolean(getChannel(ctx, cid)?.readOnly));

// -- emoji packs ---------------------------------------------------------------------------------------------------
fn("subscribeEmojiPack", async (ctx, naddr) => (await ctx.client.emojis.subscribe(naddr.trim()), ""), req(1));
fn("unsubscribeEmojiPack", async (ctx, naddr) => (await ctx.client.emojis.unsubscribe(naddr.trim()), ""), req(1));
fn("emojiPacks", async (ctx, sep = ", ") => ((await ctx.client.emojis.packs()) as any[]).map((p) => p.name ?? p.id ?? "").join(sep || ", "));
fn("botEmojis", (ctx, sep = " ") => [...ctx.client.emojis.cache.values()].map(String).join(sep || " "));

/** `$community…` names for the `$server…` functions. */
export function registerAliases(): void {
  const pairs: Record<string, string> = {
    communityID: "guildID", communityName: "serverName", communityIcon: "serverIcon", communityOwner: "serverOwner",
    communityDescription: "serverDescription", communityMembersCount: "membersCount", communityCount: "serverCount",
    communityExists: "guildExists", communityNames: "serverNames", communityInvite: "getServerInvite", leaveCommunity: "botLeave",
    communityInfo: "serverInfo", communityEmojis: "serverEmojis", communityChannelExists: "serverChannelExists",
    randomCommunityID: "randomGuildID", communityBanner: "guildBanner", setCommunityVar: "setServerVar",
    getCommunityVar: "getServerVar", resetCommunityVar: "resetServerVar", communityLeaderboard: "serverLeaderboard",
    communityCooldown: "serverCooldown", onlyForCommunities: "onlyForServers", blackListCommunities: "blackListServers",
  };
  for (const [n, old] of Object.entries(pairs)) if (!FUNCTIONS.has(n.toLowerCase())) alias(n, old);
}
