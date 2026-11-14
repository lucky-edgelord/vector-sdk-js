/** Newer BDFD functions (uncached $' variants, entity selects, autocomplete) and D.js-BDscript music on Vector voice. */
import { escape } from "../parser";
import { FUNCTIONS, BDScriptError, fn, req, none, type Impl } from "../registry";
import { getChannel, toInt } from "../util";
import type { Context, SelectSpec } from "../context";
import { VoiceConnection, createAudioResource } from "../../structures/Voice";

/** $'random, $'randomText…: BDFD caches identical calls in one run; these never do. */
export function registerUncached(): void {
  for (const n of ["random", "randomText", "randomUser", "randomMention", "randomUserID", "randomString", "randomChannelID"]) {
    const base = FUNCTIONS.get(n.toLowerCase());
    if (!base) continue;
    const impl: Impl = async (ctx, ...args) => {
      ctx.extras.no_cache = true;
      try {
        return await (base.impl as Impl)(ctx, ...args);
      } finally {
        delete ctx.extras.no_cache;
      }
    };
    FUNCTIONS.set("'" + n.toLowerCase(), { ...base, name: "'" + n, impl });
  }
}

fn("getSplitText", (ctx, index) => (FUNCTIONS.get("splittext")!.impl as Impl)(ctx, index), req(1));
fn("addButtonCV2", (ctx, ...a) => (FUNCTIONS.get("addbutton")!.impl as Impl)(ctx, ...a), req(4));

function entitySelect(ctx: Context, cid: string, placeholder: string, mn: string, mx: string, options: SelectSpec["options"]): void {
  const spec: SelectSpec = { kind: "select", customId: cid, placeholder, minValues: toInt(mn || "1"), maxValues: toInt(mx || "1"), options: options.slice(0, 25), disabled: false };
  const rows = ctx.response.rows;
  if (rows[rows.length - 1].length) rows.push([]);
  rows[rows.length - 1].push(spec);
  rows.push([]);
}
const memberOptions = (ctx: Context) => {
  if (!ctx.guild) throw new BDScriptError("user selects need a community");
  return [...ctx.guild.members.cache.values()].slice(0, 25).map((m: any) => ({ label: m.displayName, value: m.id }));
};
const roleOptions = (ctx: Context) => {
  if (!ctx.guild) throw new BDScriptError("role selects need a community");
  return [...ctx.guild.roles.cache.values()].filter((r: any) => !r.isEveryone()).slice(0, 25).map((r: any) => ({ label: r.name, value: r.id }));
};
fn("addUserSelect", (ctx, cid, ph = "", mn = "1", mx = "1") => (entitySelect(ctx, cid, ph, mn, mx, memberOptions(ctx)), ""), req(1));
fn("addRoleSelect", (ctx, cid, ph = "", mn = "1", mx = "1") => (entitySelect(ctx, cid, ph, mn, mx, roleOptions(ctx)), ""), req(1));
fn("addMentionableSelect", (ctx, cid, ph = "", mn = "1", mx = "1") => (entitySelect(ctx, cid, ph, mn, mx, [...memberOptions(ctx), ...roleOptions(ctx)]), ""), req(1));
const values = (ctx: Context): string[] => [...(ctx.extras.values ?? [])];
for (const kind of ["UserSelectUser", "RoleSelectRole", "MentionableSelectUser"]) {
  fn(`get${kind}ID`, (ctx, index = "1") => {
    const v = values(ctx);
    const i = toInt(index || "1");
    return i > 0 && i <= v.length ? v[i - 1] : "";
  });
  fn(`get${kind}IDs`, (ctx, sep = ", ") => values(ctx).join(sep || ", "));
  fn(`get${kind}Count`, (ctx) => String(values(ctx).length));
}

// -- slash autocomplete (Vector has no autocomplete yet: collected only) ---------------------------------------
fn("appendOptionSuggestion", (ctx, label, value) => {
  const s: any[] = (ctx.extras.suggestions ??= []);
  if (s.length >= 25) throw new BDScriptError("at most 25 suggestions");
  s.push({ label, value });
  return "";
}, { ...req(2), status: "partial", note: "collected; Vector has no autocomplete yet" });
fn("autoCompleteOptionName", (ctx) => ctx.extras.ac_option ?? "", none);
fn("autoCompleteOptionValue", (ctx) => escape(ctx.extras.ac_value ?? ""), none);
fn("onAutoComplete", () => "");

// -- music (D.js-BDscript) on Vector voice ---------------------------------------------------------------------
interface Track { title: string; url: string; requester: string }
class Audio {
  conn: VoiceConnection | null = null;
  queue: Track[] = [];
  current: Track | null = null;
  playing = false;
  ctx: Context | null = null;
}
const audios = new WeakMap<object, Map<string, Audio>>();
function audio(ctx: Context): Audio {
  let byGuild = audios.get(ctx.bot);
  if (!byGuild) audios.set(ctx.bot, (byGuild = new Map()));
  if (!byGuild.has(ctx.guildId)) byGuild.set(ctx.guildId, new Audio());
  return byGuild.get(ctx.guildId)!;
}
async function voiceChannel(ctx: Context, cid: string): Promise<any> {
  if (cid.trim()) {
    const ch = getChannel(ctx, cid);
    if (typeof ch?.join !== "function") throw new BDScriptError(`'${cid}' isn't a voice channel`);
    return ch;
  }
  const ch = [...(ctx.guild?.channels.cache.values() ?? [])].find((c: any) => typeof c.join === "function" && c.view === "voice");
  if (!ch) throw new BDScriptError("give a voice channel ID");
  return ch;
}
async function playNext(ctx: Context, a: Audio): Promise<void> {
  if (a.playing || !a.conn) return;
  const t = a.queue.shift();
  if (!t) {
    a.current = null;
    return;
  }
  a.current = t;
  a.playing = true;
  const base = a.ctx ?? ctx;
  await ctx.bot.fire("musicStart", base, { extras: { track: t } });
  try {
    await a.conn.playAndWait(createAudioResource(t.url));
  } catch (e) {
    ctx.client.emit("warn", `music: ${(e as Error).message}`);
  }
  a.playing = false;
  await ctx.bot.fire("musicEnd", base, { extras: { track: t } });
  void playNext(ctx, a);
}
fn(["joinVoice", "joinVC"], async (ctx, cid = "") => {
  const a = audio(ctx);
  if (!a.conn) a.conn = await VoiceConnection.join(await voiceChannel(ctx, cid));
  a.ctx = ctx;
  return "";
});
fn(["leaveVoice", "leaveVC"], async (ctx) => {
  const a = audio(ctx);
  a.queue = [];
  await a.conn?.disconnect();
  a.conn = null;
  return "";
});
fn(["playSong", "playTrack"], async (ctx, ...query) => {
  const q = query.join(";").trim();
  const a = audio(ctx);
  if (!a.conn) a.conn = await VoiceConnection.join(await voiceChannel(ctx, ""));
  if (!/^https?:\/\//.test(q) && !(ctx.bot.allowFiles && require("node:fs").existsSync(q))) throw new BDScriptError("give a direct audio URL (searching isn't supported)");
  const t: Track = { title: q.split("/").pop() || q, url: q, requester: ctx.authorId };
  a.queue.push(t);
  a.ctx = ctx;
  void playNext(ctx, a);
  return escape(t.title);
}, req(1));
fn(["skipSong", "skipTrack"], (ctx) => (audio(ctx).conn?.stop(), ""), none);
fn(["stopSong", "stopMusic"], (ctx) => {
  const a = audio(ctx);
  a.queue = [];
  a.conn?.stop();
  return "";
}, none);
fn("pauseSong", () => "", { brackets: "none", status: "partial", note: "Vector voice can stop, not pause" });
fn("resumeSong", () => "", { brackets: "none", status: "partial" });
fn("queueLength", (ctx) => String(audio(ctx).queue.length), none);
fn("queue", (ctx, sep = "\n") => audio(ctx).queue.map((t, i) => `${i + 1}. ${t.title}`).join(sep || "\n"));
fn(["songInfo", "trackInfo"], (ctx, p = "title") => {
  const t: any = ctx.extras.track ?? audio(ctx).current;
  return t ? escape(String(t[p.trim() || "title"] ?? "")) : "";
});
fn("say", () => {
  throw new BDScriptError("text-to-speech isn't available in this SDK; play an audio URL with $playSong");
}, { ...req(1), status: "partial" });
