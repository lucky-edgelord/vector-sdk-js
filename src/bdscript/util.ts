/** Helpers shared by BDScript functions: lookups, permissions, durations, booleans. */
import { BDScriptError } from "./registry";
import type { Context } from "./context";
import { PermissionFlagsBits } from "../util/PermissionsBitField";

const MENTION = /^<[@#](?:!|&)?([^>]+)>$/;

/** BDFD permission names -> discord.js flag names. */
export const PERMS: Record<string, string> = {
  admin: "Administrator", administrator: "Administrator", kick: "KickMembers", kickmembers: "KickMembers",
  ban: "BanMembers", banmembers: "BanMembers", managechannels: "ManageChannels", managechannel: "ManageChannels",
  manageserver: "ManageGuild", manageguild: "ManageGuild", addreactions: "AddReactions", viewauditlog: "ViewAuditLog",
  auditlog: "ViewAuditLog", priorityspeaker: "PrioritySpeaker", stream: "Stream", readmessages: "ViewChannel",
  viewchannel: "ViewChannel", sendmessages: "SendMessages", sendtts: "SendTTSMessages", managemessages: "ManageMessages",
  embedlinks: "EmbedLinks", attachfiles: "AttachFiles", readmessagehistory: "ReadMessageHistory",
  mentioneveryone: "MentionEveryone", externalemojis: "UseExternalEmojis", useexternalemojis: "UseExternalEmojis",
  connect: "Connect", speak: "Speak", mutemembers: "MuteMembers", deafenmembers: "DeafenMembers",
  movemembers: "MoveMembers", usevad: "UseVAD", changenickname: "ChangeNickname", managenicknames: "ManageNicknames",
  manageroles: "ManageRoles", managewebhooks: "ManageWebhooks", manageemojis: "ManageGuildExpressions",
  manageemojisandstickers: "ManageGuildExpressions", useslashcommands: "UseApplicationCommands",
  usecommands: "UseApplicationCommands", requesttospeak: "RequestToSpeak", manageevents: "ManageEvents",
  managethreads: "ManageThreads", createpublicthreads: "CreatePublicThreads", createprivatethreads: "CreatePrivateThreads",
  externalstickers: "UseExternalStickers", sendmessagesinthreads: "SendMessagesInThreads",
  moderatemembers: "ModerateMembers", timeout: "ModerateMembers", createinvite: "CreateInstantInvite",
  createinstantinvite: "CreateInstantInvite",
};

export function permName(p: string): string {
  const key = p.trim().toLowerCase().replace(/[_ ]/g, "");
  const name = PERMS[key];
  if (!name || !(name in PermissionFlagsBits)) throw new BDScriptError(`invalid permission '${p}'`);
  return name;
}

/** BDFD-style names of every permission in a bitfield. */
export function permNames(bits: bigint): string[] {
  const rev = new Map<string, string>();
  for (const [k, v] of Object.entries(PERMS)) if (!rev.has(v)) rev.set(v, k);
  const out: string[] = [];
  for (const [flag, bit] of Object.entries(PermissionFlagsBits)) if (bit && (bits & (bit as bigint)) === bit && rev.has(flag)) out.push(rev.get(flag)!);
  return [...new Set(out)];
}

export function stripMention(text: string): string {
  text = text.trim();
  const m = MENTION.exec(text);
  let id = m ? m[1] : text;
  if (id.startsWith("nostr:")) id = id.slice(6);
  return id;
}

export function truthy(v: unknown, def = false): boolean {
  if (v === undefined || v === null) return def;
  const s = String(v).trim().toLowerCase();
  if (s === "") return def;
  if (["yes", "true", "1", "on", "y"].includes(s)) return true;
  if (["no", "false", "0", "off", "n"].includes(s)) return false;
  throw new BDScriptError(`expected yes/no, got '${v}'`);
}

export function toNum(v: unknown, what = "number"): number {
  const s = String(v ?? "").trim().replace(/,/g, "");
  const n = s === "" ? NaN : Number(s);
  if (Number.isNaN(n)) throw new BDScriptError(`invalid ${what} '${v}'`);
  return n;
}
export function toInt(v: unknown, what = "number"): number {
  return Math.trunc(toNum(v, what));
}

export function fmtNum(x: number): string {
  if (Number.isInteger(x) && Math.abs(x) < 1e18) return String(x);
  if (!Number.isFinite(x)) return String(x);
  return String(parseFloat(x.toFixed(12)));
}

const DUR = /(\d+(?:\.\d+)?)\s*(ms|s|secs?|seconds?|mo|months?|m|mins?|minutes?|h|hrs?|hours?|d|days?|w|weeks?|y|years?)?/gi;
const UNIT: Record<string, number> = {
  ms: 0.001, s: 1, sec: 1, secs: 1, second: 1, seconds: 1, m: 60, min: 60, mins: 60, minute: 60, minutes: 60,
  h: 3600, hr: 3600, hrs: 3600, hour: 3600, hours: 3600, d: 86400, day: 86400, days: 86400, w: 604800, week: 604800,
  weeks: 604800, mo: 2592000, month: 2592000, months: 2592000, y: 31536000, year: 31536000, years: 31536000,
};

/** `10s`, `5m`, `1h30m`, `2d`; a bare number is seconds. */
export function seconds(text: string): number {
  text = String(text).trim();
  if (!text) throw new BDScriptError("empty duration");
  let total = 0, found = false;
  for (const m of text.matchAll(DUR)) {
    found = true;
    total += parseFloat(m[1]) * (UNIT[(m[2] ?? "s").toLowerCase()] ?? 1);
  }
  if (!found) throw new BDScriptError(`invalid duration '${text}'`);
  return total;
}

export function humanDuration(secs: number): string {
  secs = Math.floor(secs);
  const parts: string[] = [];
  for (const [name, size] of [["day", 86400], ["hour", 3600], ["minute", 60], ["second", 1]] as const) {
    if (secs >= size) {
      const n = Math.floor(secs / size);
      secs %= size;
      parts.push(`${n} ${name}${n !== 1 ? "s" : ""}`);
    }
  }
  return parts.join(", ") || "0 seconds";
}

// -- lookups -----------------------------------------------------------------------------------------------------

export function userId(ctx: Context, value?: string | null): string {
  const v = (value ?? "").trim();
  return v ? stripMention(v) : ctx.authorId;
}

export function getUser(ctx: Context, value?: string | null, required = true): any {
  if (!value && ctx.author) return ctx.author;
  const id = userId(ctx, value);
  let u: any = ctx.guild?.members.cache.get(id)?.user ?? ctx.client.users.resolve(id);
  if (!u && /^npub1[0-9a-z]{58}$/.test(id)) u = ctx.client._state.user(id);
  if (!u && required) throw new BDScriptError(`invalid user ID '${id}'`);
  return u ?? null;
}

export function getMember(ctx: Context, value?: string | null, guild?: any, required = true): any {
  const g = guild ?? ctx.guild;
  if (!g) {
    if (required) throw new BDScriptError("this only works in a community");
    return null;
  }
  const id = userId(ctx, value);
  let m = g.members.cache.get(id);
  if (!m && /^npub1[0-9a-z]{58}$/.test(id)) m = g.members._get(id);
  if (!m && required) throw new BDScriptError(`invalid user ID '${id}'`);
  return m ?? null;
}

export function getGuild(ctx: Context, value?: string | null, required = true): any {
  const v = (value ?? "").trim();
  if (!v) {
    if (!ctx.guild && required) throw new BDScriptError("this only works in a community");
    return ctx.guild;
  }
  const g = ctx.client.guilds.cache.get(v);
  if (!g && required) throw new BDScriptError(`invalid server ID '${v}'`);
  return g ?? null;
}

export function getChannel(ctx: Context, value?: string | null, required = true): any {
  const v = stripMention(value ?? "").replace(/^#/, "");
  if (!v) return ctx.channel;
  let c: any = ctx.client.channels.resolve(v);
  if (!c && ctx.guild) c = ctx.guild.channels.cache.find((x: any) => x.name === v || x.name?.replace(/^.*┊/, "") === v);
  if (!c && required) throw new BDScriptError(`invalid channel ID '${v}'`);
  return c ?? null;
}

export function getRole(ctx: Context, value: string, guild?: any, required = true): any {
  const g = guild ?? ctx.guild;
  if (!g) throw new BDScriptError("this only works in a community");
  const v = stripMention(value);
  let r = g.roles.cache.get(v);
  if (!r) r = g.roles.cache.find((x: any) => x.name === value.trim() || x.name.toLowerCase() === value.trim().toLowerCase());
  if (!r && required) throw new BDScriptError(`invalid role '${value}'`);
  return r ?? null;
}

export function ts(d: Date | null | undefined, unit = "s"): string {
  if (!d) return "";
  return unit === "ms" || unit === "milliseconds" ? String(d.getTime()) : String(Math.floor(d.getTime() / 1000));
}

export function bdfdDate(d: Date | null | undefined): string {
  if (!d) return "";
  return d.toISOString().replace("T", " ").slice(0, 19);
}

export function joinArgs(a: string[]): string {
  return a.join(";");
}
