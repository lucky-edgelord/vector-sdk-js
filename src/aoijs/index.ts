/**
 * aoi.js's client API for Vector, on the BDScript engine.
 *
 *     const { AoiClient } = require("vector-sdk/aoijs");   // or require("aoi.js") under vector-sdk/register
 *     const client = new AoiClient({ token: process.env.VECTOR_NSEC, prefix: "!", intents: ["MessageContent"], events: ["onMessage"] });
 *     client.command({ name: "ping", code: "Pong! $ping ms" });
 *
 * `code` strings are BDScript, so every BDScript function works inside them. Storage is SQLite (node:sqlite).
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { BDBot, Command, type BDBotOptions } from "../bdscript/bot";
import { Context } from "../bdscript/context";
import { compileCode, evaluate, run } from "../bdscript/interpreter";
import { escape } from "../bdscript/parser";
import { fn } from "../bdscript/registry";
import "../bdscript/functions";

const TYPES: Record<string, string> = {
  basic: "basicCommand", basiccommand: "basicCommand", ready: "readyCommand", join: "joinCommand", leave: "leaveCommand",
  banadd: "banAddCommand", banremove: "banRemoveCommand", messagedelete: "deleteCommand", deleted: "deleteCommand",
  delete: "deleteCommand", awaited: "awaitedCommand", interaction: "interactionCommand", slash: "slashCommand",
  reactionadd: "reactionCommand", reaction: "reactionCommand",
};

/** aoi.js commands/events with no Vector counterpart (accepted so ported bots still load). */
const UNSUPPORTED = [
  "guildJoin", "guildLeave", "guildUpdate", "guildUnavailable", "roleCreate", "roleUpdate", "roleDelete", "channelCreate",
  "channelUpdate", "channelDelete", "channelPinsUpdate", "stageInstanceCreate", "stageInstanceUpdate", "stageInstanceDelete",
  "threadCreate", "threadUpdate", "threadDelete", "threadListSync", "threadMemberUpdate", "threadMembersUpdate", "memberUpdate",
  "memberAvailable", "membersChunk", "emojiCreate", "emojiDelete", "emojiUpdate", "reactionRemove", "reactionRemoveAll",
  "reactionRemoveEmoji", "presenceUpdate", "voiceStateUpdate", "pollVoteAdd", "pollVoteRemove", "entitlementCreate",
  "entitlementUpdate", "entitlementDelete", "applicationCmdCreate", "applicationCmdDelete", "applicationCmdUpdate",
  "applicationCmdPermissionsUpdate", "userUpdate", "variableCreate", "variableDelete", "variableUpdate", "rateLimit",
  "webhooksUpdate", "autoModActionExecution", "autoModCreate", "autoModDelete", "autoModUpdate", "inviteCreate",
  "inviteDelete", "messageUpdate", "messageDeleteBulk", "bulkDelete", "update", "typingStart", "musicStart", "musicEnd",
];

const IGNORED_OPTIONS = ["intents", "events", "respondOnEdit", "sharding", "cache", "disableAoiDB", "suppressAllErrors", "errorMessage", "debugs", "aoiLogs", "aoiWarning", "aoiAutoUpdate", "shards", "voice", "disableLogs", "disableDefaultCommands", "partials", "presence", "fetchInvites", "guildOnly"];

/** aoi.js durations: milliseconds as a number, or "10s" / "1h30m". */
export function durationMs(v: unknown): number {
  if (typeof v === "number") return v;
  let total = 0, found = false;
  for (const m of String(v).matchAll(/(\d+(?:\.\d+)?)\s*(ms|s|m|h|d|w)?/gi)) {
    found = true;
    total += parseFloat(m[1]) * ({ ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 } as Record<string, number>)[(m[2] ?? "ms").toLowerCase()];
  }
  if (!found) throw new TypeError(`invalid duration ${JSON.stringify(v)}`);
  return total;
}

export interface AoiOptions extends Omit<BDBotOptions, "database"> {
  /** Your Vector nsec (or $VECTOR_NSEC). With a token the client logs in right away, like aoi.js. */
  token?: string;
  /** A SQLite file, or `{ path }` (aoi.js's `type`/`db` are ignored: storage is always SQLite). Default ./database/aoi.db */
  database?: string | { path?: string; file?: string; [k: string]: unknown };
  [k: string]: unknown;
}

type CmdData = Record<string, any>;

export class AoiClient extends BDBot {
  loops: CmdData[] = [];
  ignoredCommands: Record<string, CmdData[]> = {};
  private loopTimers: NodeJS.Timeout[] = [];
  [key: string]: any;

  constructor(options: AoiOptions = {}) {
    const o: AoiOptions = { ...options };
    for (const k of IGNORED_OPTIONS) delete o[k];
    let db = o.database;
    if (db && typeof db === "object") db = (db.path ?? db.file) as string | undefined;
    if (!db) db = path.join((o.dataDir as string | undefined) ?? "database", "aoi.db");
    if (db !== ":memory:") fs.mkdirSync(path.dirname(path.resolve(db)), { recursive: true });
    const token = o.token;
    delete o.token;
    super({ ...(o as BDBotOptions), database: db as string, mentionAuthor: Boolean(o.mentionAuthor ?? false) });
    this.client.on("ready", () => this.loops.forEach((d) => this.spawnLoop(d)));
    if (token) queueMicrotask(() => void this.login(token).catch((e) => this.client.emit("error", e)));
    // *Command registrars for Discord-only events, and on<Event>() switches (events are always on)
    return new Proxy(this, {
      get(t, p, r) {
        if (typeof p !== "string" || p in t) return Reflect.get(t, p, r);
        if (p.endsWith("Command") && UNSUPPORTED.includes(p.slice(0, -7))) {
          return (d: CmdData) => {
            (t.ignoredCommands[p.slice(0, -7)] ??= []).push(d);
            t.client.emit("warn", `${p} has no Vector equivalent; the command is kept but never runs`);
          };
        }
        if (/^on[A-Z]\w*$/.test(p)) return () => r;
        return undefined;
      },
    });
  }

  private normalise(d: CmdData, kind?: string): CmdData {
    d = { ...d };
    if (kind !== undefined) d.type = kind;
    else {
      const t = String(d.type ?? "").trim();
      d.type = t ? TYPES[t.toLowerCase()] ?? t : "";
    }
    const channel = d.channel;
    delete d.channel;
    if (channel && d.code && !String(d.code).toLowerCase().includes("$usechannel[")) d.code = `$useChannel[${channel}]\n${d.code}`;
    if (d.nonPrefixed && d.name && !d.trigger) d.trigger = d.name;
    delete d.nonPrefixed;
    return d;
  }

  /** `client.command({ name: "ping", aliases: ["p"], code: "..." }, {...})`. `nonPrefixed: true` makes the name a bare trigger. */
  override command(...commands: any[]): any {
    const source = typeof commands[commands.length - 1] === "string" ? (commands.pop() as unknown as string) : "";
    const made: Command[] = [];
    for (const d of commands) {
      if (!d || typeof d !== "object") throw new TypeError(`Command ${this.commands.length} must be an object`);
      if (!d.name && !d.trigger && !d.type) throw new TypeError(`Command ${this.commands.length} needs a name!`);
      if (!d.code) throw new TypeError(`Command ${this.commands.length} needs a code!`);
      made.push(super.command(this.normalise(d), source));
    }
    return made.length === 1 ? made[0] : made;
  }
  private typed(kind: string, d: CmdData): Command {
    if (!d.code) throw new TypeError(`Code is not provided in ${d.name || "unknown name"}: ${kind}`);
    return super.command({ name: "", ...this.normalise(d, kind) });
  }
  readyCommand(d: CmdData) {
    return this.typed("readyCommand", d);
  }
  joinCommand(d: CmdData) {
    return this.typed("joinCommand", d);
  }
  leaveCommand(d: CmdData) {
    return this.typed("leaveCommand", d);
  }
  banAddCommand(d: CmdData) {
    return this.typed("banAddCommand", d);
  }
  banRemoveCommand(d: CmdData) {
    return this.typed("banRemoveCommand", d);
  }
  deletedCommand(d: CmdData) {
    return this.typed("deleteCommand", d);
  }
  reactionAddCommand(d: CmdData) {
    return this.typed("reactionCommand", d);
  }
  /** Run with BDScript's `$awaitFunc[name]`. */
  awaitedCommand(d: CmdData) {
    if (!d.name) throw new TypeError("awaitedCommand needs a name!");
    return this.typed("awaitedCommand", d);
  }
  /** `{ name: "yes", prototype: "button", code }`: the name is the custom id ("slash" defines a slash command). */
  interactionCommand(d: CmdData) {
    if (!d.prototype) throw new TypeError(`Prototype is not provided in ${d.name || "unknown name"}: interactionCommand.`);
    if (!d.code) throw new TypeError(`Code is not provided in ${d.name || "unknown name"}: interactionCommand.`);
    const { prototype, ...rest } = d;
    return ["slash", "slashcommand"].includes(String(prototype).toLowerCase()) ? this.typed("slashCommand", rest) : this.typed("interactionCommand", rest);
  }
  /** Runs for any function error instead of the default message (`$handleError[function|command|error]`). */
  functionErrorCommand(d: CmdData): void {
    this.functionErrorCode = String(d.code);
    compileCode(this.functionErrorCode);
  }
  /** `{ every: 60000 | "1h", channel, executeOnStartup, code }` runs the code repeatedly. */
  loopCommand(d: CmdData): void {
    if (!d.code) throw new TypeError("Code is not provided in loopCommand");
    const loop = { ...d, ms: durationMs(d.every ?? 60000) };
    compileCode(String(d.code));
    this.loops.push(loop);
    if (this.client.isReady()) this.spawnLoop(loop);
  }
  timeoutCommand(d: CmdData): void {
    (this.ignoredCommands.timeout ??= []).push(d);
  }
  private spawnLoop(d: CmdData): void {
    const tick = async () => {
      const ch: any = d.channel ? this.client.channels.resolve(String(d.channel)) : null;
      const ctx = new Context(this, { channel: ch, author: this.client.user, command: new Command({ code: d.code, name: "loop", kind: "ready" }), mentionDefault: false });
      await run(ctx, String(d.code)).catch((e) => this.client.emit("error", e));
    };
    if (d.executeOnStartup) void tick();
    this.loopTimers.push(setInterval(() => void tick(), d.ms));
  }

  /** `client.variables({ money: 0 }, "main")` (the table name is accepted and ignored). */
  override variables(defaults: Parameters<BDBot["variables"]>[0], _table = "main"): this {
    return super.variables(defaults);
  }
  /** Vector bots have no presence; accepted so aoi.js bots load. */
  status(...statuses: CmdData[]): void {
    (this.ignoredCommands.status ??= []).push(...statuses);
  }
  /** Load command files (`.js` with module.exports, `.json`, `.bds`). */
  loadCommands(directory: string, debug = false): number {
    const before = new Set(this.commands);
    const n = this.manager.load(directory);
    if (debug) for (const c of this.commands) if (!before.has(c)) console.log(`loaded ${c.kind} command: ${c.name || c.trigger || c.arg}`);
    return n;
  }
  /**
   * Custom functions, aoi.js style:
   * - `{ name: "$greet", params: ["who"], type: "aoi.js", code: "Hello {who}!" }` (BDScript with {param} placeholders)
   * - `{ name: "$shout", type: "djs", code: (ctx, text = "") => text.toUpperCase() }` (a JS function)
   */
  addFunction(d: { name: string; type?: string; params?: string[]; code: string | ((ctx: Context, ...a: string[]) => unknown); brackets?: "none" | "optional" | "required" }): void {
    const name = String(d.name).replace(/^\$/, "");
    if (typeof d.code === "function") {
      fn(name, d.code, { brackets: d.brackets ?? "optional", status: "custom" });
      return;
    }
    const params = [...(d.params ?? [])];
    const template = String(d.code);
    fn(name, async (ctx, ...args) => {
      let body = template;
      params.forEach((p, i) => (body = body.split(`{${p}}`).join(escape(args[i] ?? ""))));
      return evaluate(ctx, compileCode(body));
    }, { status: "custom" });
  }
  override async destroy(): Promise<void> {
    for (const t of this.loopTimers) clearInterval(t);
    await super.destroy();
  }
}

export { AoiClient as Bot };
export { LoadCommands } from "./loader";
