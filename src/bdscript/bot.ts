/**
 * BDBot: runs BDScript commands on Vector.
 *
 * - **BDFD style**: commands with a trigger (`!ping`) or a callback trigger (`$onJoined[channelID]`,
 *   `$onInteraction[id]`, `$awaitedCommand[name]`, `$onLeave`, `$onBanAdd`, `$onBanRemove`, `$onMessageDelete`,
 *   `$alwaysReply`), slash commands, variables with defaults.
 * - **D.js-BDscript / aoi.js style**: `bot.command({ name, type: "basicCommand", code })`, `bot.variables([...])`,
 *   `bot.manager.load("./commands")`, `bot.login(nsec)`.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { Client, type ClientOptions } from "../client/Client";
import { Context, type ComponentSpec } from "./context";
import { compileCode, run } from "./interpreter";
import { buildRows } from "./output";
import { Storage } from "./storage";
import type { Message } from "../structures/Message";
import type { User } from "../structures/User";
import { ApplicationCommandOptionType } from "../util/Constants";

const FORK_TYPES: Record<string, string> = {
  basicCommand: "message", readyCommand: "ready", slashCommand: "slash", buttonCommand: "interaction",
  musicStartCommand: "musicStart", musicEndCommand: "musicEnd", joinCommand: "join", leaveCommand: "leave",
  interactionCommand: "interaction", awaitedCommand: "awaited", deleteCommand: "delete", banAddCommand: "banAdd",
  banRemoveCommand: "banRemove", reactionCommand: "reaction",
};
const CALLBACK = /^\$(onJoined|onLeave|onInteraction|onInteractionComplex|awaitedCommand|awaitedCommandError|onBanAdd|onBanRemove|onMessageDelete|onAutoComplete|alwaysReply|reaction)(?:\[(.*)\])?$/i;
const KIND: Record<string, string> = {
  onjoined: "join", onleave: "leave", oninteraction: "interaction", oninteractioncomplex: "interaction",
  awaitedcommand: "awaited", awaitedcommanderror: "awaitedError", onbanadd: "banAdd", onbanremove: "banRemove",
  onmessagedelete: "delete", onautocomplete: "autocomplete", alwaysreply: "always", reaction: "reaction",
};
const CHANNEL_CALLBACKS = new Set(["join", "leave", "banAdd", "banRemove"]);

export class Command {
  code = "";
  name = "";
  trigger = "";
  /** message, slash, ready, join, leave, interaction, awaited, awaitedError, delete, reaction, always, … */
  kind = "message";
  /** callback argument: channel id, custom id, awaited name… */
  arg = "";
  aliases: string[] = [];
  description = "";
  folder = "";
  type = "";
  options: any[] = [];
  ignoreCase = false;
  contains: string[] = [];
  always = false;
  source = "";
  constructor(init: Partial<Command> = {}) {
    Object.assign(this, init);
  }
  get isEvent(): boolean {
    return !["message", "always", "awaited"].includes(this.kind);
  }
}

/** Loads commands from a folder (`bot.manager.load("./commands")`). `.bds` files with an optional `---` header, `.json`, or `.js` (module.exports). */
export class CommandManager {
  paths: string[] = [];
  private mtimes = new Map<string, number>();
  private watcher: NodeJS.Timeout | null = null;
  constructor(private readonly bot: BDBot) {}
  get mainPath(): string | null {
    return this.paths[0] ?? null;
  }
  load(dir: string): number {
    dir = path.resolve(dir);
    if (!this.paths.includes(dir)) this.paths.push(dir);
    let n = 0;
    const walk = (d: string) => {
      for (const ent of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        const full = path.join(d, ent.name);
        if (ent.isDirectory()) walk(full);
        else {
          for (const data of this.read(full)) {
            data.folder ??= d !== dir ? path.relative(dir, d) : "";
            this.bot.command(data, full);
            n++;
          }
          this.mtimes.set(full, fs.statSync(full).mtimeMs);
        }
      }
    };
    walk(dir);
    return n;
  }
  private read(full: string): any[] {
    try {
      if (/\.(bds|bdscript)$/.test(full)) {
        let text = fs.readFileSync(full, "utf8");
        const meta: any = {};
        if (text.startsWith("---")) {
          const end = text.indexOf("\n---", 3);
          if (end !== -1) {
            const head = text.slice(3, end);
            text = text.slice(end + 4).replace(/^\n+/, "");
            for (const line of head.trim().split("\n")) {
              const i = line.indexOf(":");
              if (i !== -1) meta[line.slice(0, i).trim()] = line.slice(i + 1).trim();
            }
          }
        }
        if (typeof meta.aliases === "string") meta.aliases = meta.aliases.replace(/^\[|\]$/g, "").split(",").map((a: string) => a.trim()).filter(Boolean);
        if (!meta.name && !meta.trigger && !meta.type) meta.name = path.basename(full).replace(/\.[^.]+$/, "");
        meta.code = text;
        return [meta];
      }
      if (full.endsWith(".json")) {
        const d = JSON.parse(fs.readFileSync(full, "utf8"));
        return Array.isArray(d) ? d : [d];
      }
      if (/\.(c?js)$/.test(full)) {
        delete require.cache[require.resolve(full)];
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const mod = require(full);
        const ex = mod?.default ?? mod;
        return Array.isArray(ex) ? ex : ex && typeof ex === "object" && "code" in ex ? [ex] : Array.isArray(ex?.commands) ? ex.commands : [];
      }
    } catch (e) {
      this.bot.client.emit("warn", `could not load command file ${full}: ${(e as Error).message}`);
    }
    return [];
  }
  /** Reload every loaded folder (`$updateCommands`). */
  refresh(): number {
    this.bot.commands = this.bot.commands.filter((c) => !c.source);
    this.mtimes.clear();
    return this.paths.reduce((n, p) => n + this.load(p), 0);
  }
  changed(): boolean {
    for (const [f, mt] of this.mtimes) if (!fs.existsSync(f) || fs.statSync(f).mtimeMs !== mt) return true;
    const seen = (d: string): boolean => fs.readdirSync(d, { withFileTypes: true }).some((e) => (e.isDirectory() ? seen(path.join(d, e.name)) : !this.mtimes.has(path.join(d, e.name))));
    return this.paths.some((p) => fs.existsSync(p) && seen(p));
  }
  /** Hot reload: re-read commands whenever a file changes. */
  watch(intervalMs = 1000): void {
    this.watcher ??= setInterval(() => {
      if (this.changed()) this.bot.client.emit("debug", `commands changed, reloaded ${this.refresh()}`);
    }, intervalMs).unref();
  }
  unwatch(): void {
    if (this.watcher) clearInterval(this.watcher);
    this.watcher = null;
  }
}

export interface BDBotOptions extends ClientOptions {
  prefix?: string | string[];
  owners?: string[];
  /** SQLite file (default `<dataDir>/bdscript.db`). */
  database?: string;
  mentionAuthor?: boolean;
  /** Undeclared variables read as "" instead of failing. */
  autoVariables?: boolean;
  /** A server variable that overrides the prefix per community. */
  prefixVariable?: string;
  allowHttp?: boolean;
  /** HTTP requests allowed per run (default 5). */
  httpLimit?: number;
  allowExec?: boolean;
  allowFiles?: boolean;
  /** `$ai` backend: `({prompt, system, maxTokens, history}) => Promise<string>`. Default: Anthropic when $ANTHROPIC_API_KEY is set. */
  ai?: AiFunction | null;
  customImages?: Record<string, string>;
  /** Attach to an existing Client instead of making one. */
  client?: Client;
  /** Hook the client's events (default true). */
  listen?: boolean;
}

export type AiFunction = (o: { prompt: string; system: string | null; maxTokens: number; history: { role: string; content: string }[] }) => Promise<string>;

export class BDBot {
  readonly client: Client;
  prefixes: string[];
  owners: string[];
  readonly storage: Storage;
  commands: Command[] = [];
  variablesDef: Record<string, unknown> = {};
  variableTypes: Record<string, string> = {};
  mentionAuthor: boolean;
  autoVariables: boolean;
  prefixVariable: string | null;
  allowHttp: boolean;
  httpLimit: number;
  allowExec: boolean;
  allowFiles: boolean;
  ai: AiFunction | null;
  customImages: Record<string, string>;
  slashData = new Map<string, any>();
  slashCommands = new Map<string, any>();
  rows = new Map<string, ComponentSpec[][]>();
  messageCounts = new Map<string, number>();
  tickets: Set<string>;
  threads = new Map<string, { parent?: string; members: Set<string> }>();
  slowmodes = new Map<string, number>();
  miniApps = new Map<string, string>();
  logLines: string[] = [];
  startedAt = Date.now();
  readonly manager: CommandManager;
  /** aoi.js `functionErrorCommand` code. */
  functionErrorCode: string | null = null;
  readonly awaits = new Map<string, { name: string; since: number }>();
  readonly reactionWaits = new Map<string, { user: string; map: Record<string, string> }>();
  private attached: boolean;

  constructor(options: BDBotOptions = {}) {
    const { prefix = "!", owners = [], database, mentionAuthor = true, autoVariables = false, prefixVariable, allowHttp = true, httpLimit = 5, allowExec = false, allowFiles = false, ai, customImages, client, listen = true, ...clientOptions } = options;
    this.prefixes = Array.isArray(prefix) ? [...prefix] : [prefix];
    this.owners = owners.map(String);
    this.attached = Boolean(client);
    this.client = client ?? new Client(clientOptions);
    (this.client as any).bdbot = this;
    this.storage = new Storage(database ?? path.join(options.dataDir ?? ".", "bdscript.db"));
    this.mentionAuthor = mentionAuthor;
    this.autoVariables = autoVariables;
    this.prefixVariable = prefixVariable ?? null;
    this.allowHttp = allowHttp;
    this.httpLimit = httpLimit;
    this.allowExec = allowExec;
    this.allowFiles = allowFiles;
    this.ai = ai === undefined ? defaultAi() : ai;
    this.customImages = { ...(customImages ?? {}) };
    this.tickets = new Set(JSON.parse(this.storage.kvGet("tickets", "[]") ?? "[]"));
    this.manager = new CommandManager(this);
    if (listen) this.wire();
  }

  // -- registration -----------------------------------------------------------------------------------------------
  /**
   * Add a command: BDFD style `{ trigger: "!ping", code }` / `{ trigger: "$onJoined[id]", code }`, prefix style
   * `{ name: "ping", aliases: [...], code }`, or D.js-BDscript `{ name, type: "basicCommand", code }`.
   */
  command(data: Record<string, any>, source = ""): Command {
    const code = String(data.code ?? "");
    const cmd = new Command({
      code, name: String(data.name ?? ""), trigger: String(data.trigger ?? ""), aliases: [...(data.aliases ?? [])].map(String),
      description: String(data.description ?? ""), folder: String(data.folder ?? ""), type: String(data.type ?? ""), source,
    });
    const cb = CALLBACK.exec(cmd.trigger.trim()) ?? CALLBACK.exec(cmd.type.trim());
    if (cb) {
      cmd.kind = KIND[cb[1].toLowerCase()];
      cmd.arg = (cb[2] ?? "").trim();
    } else if (cmd.type in FORK_TYPES) {
      cmd.kind = FORK_TYPES[cmd.type];
      cmd.arg = ["interaction", "awaited"].includes(cmd.kind) ? cmd.name : "";
    } else if (cmd.type === "slash") cmd.kind = "slash";
    const low = code.toLowerCase();
    cmd.ignoreCase = low.includes("$ignoretriggercase");
    if (low.includes("$alwaysreply") && cmd.kind === "message" && !cmd.trigger && !cmd.name) cmd.kind = "always";
    const m = /\$messagecontains\[([^\]]*)\]/i.exec(code);
    if (m) cmd.contains = m[1].split(";").filter(Boolean);
    if (cmd.kind === "slash" && cmd.name && data.options) cmd.options = [...data.options];
    compileCode(code); // syntax errors surface at load time
    this.commands.push(cmd);
    return cmd;
  }

  /** Declare variables and defaults: `{ money: 0 }` or `[{ name: "coins", default: 0, type: "INTEGER" }]`. */
  variables(defaults: Record<string, unknown> | { name: string; default?: unknown; type?: string }[]): this {
    if (Array.isArray(defaults)) {
      for (const v of defaults) {
        this.variablesDef[v.name] = v.default ?? "";
        if (v.type) this.variableTypes[v.name] = String(v.type).toUpperCase();
      }
    } else for (const [k, v] of Object.entries(defaults)) this.variablesDef[k] = v ?? "";
    return this;
  }
  /** D.js-BDscript name. */
  variable(defaults: Parameters<BDBot["variables"]>[0]) {
    return this.variables(defaults);
  }
  /** Every event is always on; kept for compatibility. */
  event(..._names: string[]): void {}

  /** Define a slash command. Options: `{ name, type: "USER"|"STRING"|…, description, required, choices }`. */
  slashCommand(name: string, description = "", options: any[] = [], code?: string): void {
    this.slashData.set(name, { name, description: description || name, options });
    if (code !== undefined) this.command({ name, type: "slashCommand", code });
    if (this.client.isReady()) this.publishSlash([name]);
  }
  createSlashCommandData(data: any): void {
    this.slashData.set(data.name, { ...data });
  }
  publishSlash(names?: string[]): void {
    const typeOf = (t: unknown) => {
      const s = String(t ?? "STRING").toUpperCase();
      return s === "USER" ? ApplicationCommandOptionType.User : s === "INTEGER" ? ApplicationCommandOptionType.Integer
        : s === "NUMBER" ? ApplicationCommandOptionType.Number : s === "BOOLEAN" ? ApplicationCommandOptionType.Boolean
          : typeof t === "number" ? (t as ApplicationCommandOptionType) : ApplicationCommandOptionType.String;
    };
    for (const n of names ?? [...this.slashData.keys()]) {
      const d = this.slashData.get(n) ?? { name: n, description: n, options: [] };
      const data = {
        name: n, description: d.description || n,
        options: (d.options ?? []).map((o: any) => ({
          name: o.name, description: o.description ?? o.name, type: typeOf(o.type), required: Boolean(o.required),
          choices: (o.choices ?? []).map((c: any) => (typeof c === "object" ? { name: String(c.name ?? c.value), value: c.value ?? c.name } : { name: String(c), value: c })),
        })),
      };
      this.client.application.commands.create(data as any).then(() => this.slashCommands.set(n, d)).catch((e) => this.client.emit("warn", `could not publish /${n}: ${e.message}`));
    }
  }
  getCommand(name: string): Command | undefined {
    return this.commands.find((c) => c.name === name || c.trigger === name || c.aliases.includes(name));
  }
  reload(): number {
    return this.manager.refresh();
  }
  later(p: Promise<unknown>): void {
    p.catch((e) => this.client.emit("error", e));
  }

  // -- running ---------------------------------------------------------------------------------------------------
  async login(nsec?: string): Promise<string> {
    return this.client.login(nsec);
  }
  /** Alias of login. */
  start(nsec?: string) {
    return this.login(nsec);
  }

  /** Run BDScript directly (tests, REPLs). */
  async runCode(code: string, o: { message?: Message; channel?: any; author?: User; args?: string[]; send?: boolean; extras?: Record<string, any> } = {}): Promise<string> {
    const ctx = new Context(this, { message: o.message, channel: o.channel, author: o.author, args: o.args, command: new Command({ code, name: "eval" }), extras: o.extras, mentionDefault: false });
    return run(ctx, code, { send: o.send ?? true });
  }

  /** @internal */
  async fire(kind: string, base: Context | null, o: { arg?: string; match?: (c: Command) => boolean; message?: any; channel?: any; author?: any; guild?: any; args?: string[]; interaction?: any; extras?: Record<string, any> } = {}): Promise<number> {
    let n = 0;
    for (const cmd of [...this.commands]) {
      if (cmd.kind !== kind) continue;
      if (o.match && !o.match(cmd)) continue;
      if (o.arg !== undefined && cmd.arg && cmd.arg !== o.arg) continue;
      const co = { ...o };
      if (CHANNEL_CALLBACKS.has(cmd.kind)) {
        // $onJoined[channelID] etc. post into the given channel (or the community's system channel)
        const g = co.guild;
        const ch: any = cmd.arg ? this.client.channels.resolve(cmd.arg) : g?.systemChannel ?? null;
        if (!ch || (g && ch.guild && ch.guild.id !== g.id)) continue;
        co.channel = ch;
      }
      const ctx = this.ctxFor(cmd, base, co);
      this.later(run(ctx, cmd.code));
      n++;
    }
    return n;
  }

  /** @internal */
  ctxFor(cmd: Command, base: Context | null, o: Record<string, any> = {}): Context {
    const mention = this.mentionAuthor && ["message", "always", "awaited"].includes(cmd.kind) && !cmd.type;
    return new Context(this, {
      message: o.message ?? base?.message, channel: o.channel ?? base?.channel, author: o.author ?? base?.author,
      guild: o.guild ?? base?.guild, args: o.args, interaction: o.interaction, command: cmd, extras: o.extras, mentionDefault: mention,
    });
  }

  private wire(): void {
    const c = this.client;
    c.on("ready", () => {
      this.startedAt = Date.now();
      this.publishSlash();
      void this.fire("ready", null, { author: c.user });
    });
    c.on("messageCreate", (m: Message) => void this.onMessage(m).catch((e) => c.emit("error", e)));
    c.on("guildMemberAdd", (m: any) => void this.fire("join", null, { author: m.user, guild: m.guild }));
    c.on("guildMemberRemove", (m: any) => void this.fire("leave", null, { author: m.user, guild: m.guild }));
    c.on("guildBanAdd", (b: any) => void this.fire("banAdd", null, { author: b.user, guild: b.guild }));
    c.on("guildBanRemove", (b: any) => void this.fire("banRemove", null, { author: b.user, guild: b.guild }));
    c.on("messageDelete", (m: any) => void this.fire("delete", null, { message: m.partial ? null : m, channel: m.channel, author: m.partial ? null : m.author, extras: { deleted: true } }));
    c.on("messageReactionAdd", (r: any, u: User) => void this.onReaction(r, u).catch((e) => c.emit("error", e)));
    c.on("interactionCreate", (i: any) => void this.onInteraction(i).catch((e) => c.emit("error", e)));
  }

  private prefixesFor(message: Message): string[] {
    const out = [...this.prefixes];
    if (this.prefixVariable && message.guild) {
      const v = this.storage.get("server", this.prefixVariable, message.guild.id);
      if (v) out.unshift(v);
    }
    return out;
  }

  private async onMessage(message: Message): Promise<void> {
    const author = message.author;
    if (!author || author.bot || author.id === this.client.user?.id) return;
    const ch = message.channel;
    this.messageCounts.set(ch.id, (this.messageCounts.get(ch.id) ?? 0) + 1);
    const content = message.content ?? "";
    const base = new Context(this, { message });
    const words = content.split(/\s+/).filter(Boolean);

    // awaited commands ($awaitFunc)
    const key = `${author.id}|${ch.id}`;
    const waiting = this.awaits.get(key);
    if (waiting) {
      this.awaits.delete(key);
      const n = await this.fire("awaited", base, { arg: waiting.name, args: words, extras: { awaited: waiting.name } });
      if (!n) await this.fire("awaitedError", base, { arg: waiting.name, args: words });
      return;
    }

    for (const cmd of [...this.commands]) {
      if (cmd.kind === "always" || (cmd.kind === "message" && cmd.always)) this.later(run(this.ctxFor(cmd, base, { args: words }), cmd.code));
      else if (cmd.contains.length && cmd.kind === "message" && !cmd.trigger && !cmd.name) {
        const low = content.toLowerCase();
        if (cmd.contains.some((w) => low.includes(w.toLowerCase()))) this.later(run(this.ctxFor(cmd, base, { args: words }), cmd.code));
      }
    }

    // triggers, longest first
    const candidates: [number, Command, string][] = [];
    const prefixes = this.prefixesFor(message);
    for (const cmd of this.commands) {
      if (cmd.kind !== "message") continue;
      const triggers: string[] = [];
      if (cmd.trigger) triggers.push(cmd.trigger);
      else for (const p of prefixes) for (const n of [cmd.name, ...cmd.aliases]) if (n) triggers.push(p + n);
      for (const t of triggers) {
        const fold = cmd.ignoreCase || !cmd.trigger;
        const hay = fold ? content.toLowerCase() : content;
        const needle = fold ? t.toLowerCase() : t;
        if (hay === needle || hay.startsWith(needle + " ") || hay.startsWith(needle + "\n")) candidates.push([t.length, cmd, content.slice(t.length).trim()]);
      }
    }
    if (!candidates.length) return;
    const best = Math.max(...candidates.map((c) => c[0]));
    for (const [len, cmd, rest] of candidates) {
      if (len === best) this.later(run(this.ctxFor(cmd, base, { args: rest ? rest.split(/\s+/) : [] }), cmd.code));
    }
  }

  /** @internal ($awaitFunc) */
  awaitCommand(name: string, userId: string, channelId: string): void {
    this.awaits.set(`${userId}|${channelId}`, { name, since: Date.now() });
  }

  private async onReaction(reaction: any, user: User): Promise<void> {
    if (user.id === this.client.user?.id) return;
    const msg = reaction.message;
    const emoji = String(reaction.emoji?.name ?? reaction.emojiName ?? "");
    const wait = this.reactionWaits.get(msg.id);
    if (wait && user.id === wait.user && wait.map[emoji]) {
      await this.fire("awaited", new Context(this, { message: msg, author: user }), { arg: wait.map[emoji], author: user, extras: { emoji } });
    }
    await this.fire("reaction", new Context(this, { message: msg, author: user }), { author: user, arg: emoji, extras: { emoji } });
  }

  private async onInteraction(i: any): Promise<void> {
    if (i.isChatInputCommand?.()) {
      const opts: Record<string, string> = {};
      for (const o of i.options.data) opts[o.name] = String(o.value);
      const base = new Context(this, { message: i.message ?? null, channel: i.channel, author: i.user });
      const extras = { options: opts, slash: true, slash_name: i.commandName };
      const n = await this.fire("slash", base, { args: Object.values(opts), interaction: i, extras, match: (c) => c.name === i.commandName || c.trigger.replace(/^\//, "") === i.commandName });
      if (!n) {
        // BDFD: a slash command with the same name as a prefix command runs it
        for (const cmd of this.commands) {
          const bare = this.prefixes.reduce((t, p) => (t.startsWith(p) ? t.slice(p.length) : t), cmd.trigger);
          if (cmd.kind === "message" && (cmd.name === i.commandName || bare === i.commandName)) this.later(run(this.ctxFor(cmd, base, { args: Object.values(opts), interaction: i, extras }), cmd.code));
        }
      }
      return;
    }
    if (i.isButton?.()) return this.dispatchInteraction(i.customId, i);
    if (i.isStringSelectMenu?.()) return this.dispatchInteraction(i.customId, i, { values: i.values });
  }

  /** Run `$onInteraction` handlers for a component click / modal submit. */
  async dispatchInteraction(customId: string, interaction: any, o: { values?: string[]; inputs?: Record<string, string> } = {}): Promise<void> {
    const extras = { custom_id: customId, values: o.values ?? [], inputs: o.inputs ?? {} };
    const base = new Context(this, { message: interaction.message ?? null, channel: interaction.channel, author: interaction.user });
    const runs: Promise<string>[] = [];
    for (const cmd of this.commands) {
      if (cmd.kind !== "interaction" || (cmd.arg && cmd.arg !== customId)) continue;
      const ctx = this.ctxFor(cmd, base, { author: interaction.user, interaction, args: [...(o.values ?? [])], extras });
      ctx.response.mentionAuthor = false;
      runs.push(run(ctx, cmd.code));
    }
    await Promise.all(runs);
  }

  /** @internal */
  rememberRows(messageId: string, rows: ComponentSpec[][]): void {
    this.rows.set(messageId, rows.map((r) => [...r]));
    if (this.rows.size > 2000) this.rows.delete(this.rows.keys().next().value!);
  }

  /** @internal: `$editButton`, `$removeButtons`… */
  async editComponents(ctx: Context, messageId: string, change: (rows: ComponentSpec[][]) => void): Promise<void> {
    const rows = (this.rows.get(messageId) ?? [[]]).map((r) => [...r]);
    change(rows);
    const channel: any = ctx.channel;
    const msg = await channel.messages.fetch(messageId);
    await msg.edit({ components: buildRows(rows) });
    if (rows.some((r) => r.length)) this.rows.set(messageId, rows);
    else this.rows.delete(messageId);
  }

  saveTickets(): void {
    this.storage.kvSet("tickets", JSON.stringify([...this.tickets]));
  }
  isOwner(id: string): boolean {
    return this.owners.includes(id);
  }
  async destroy(): Promise<void> {
    this.manager.unwatch();
    if (!this.attached) await this.client.destroy();
    this.storage.close();
  }
}

/** `$ai` via Anthropic's API when ANTHROPIC_API_KEY is set (model: $BDSCRIPT_AI_MODEL). */
function defaultAi(): AiFunction | null {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return null;
  const model = process.env.BDSCRIPT_AI_MODEL ?? "claude-haiku-5-5";
  return async ({ prompt, system, maxTokens, history }) => {
    const body: any = { model, max_tokens: maxTokens, messages: [...history, { role: "user", content: prompt }] };
    if (system) body.system = system;
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST", body: JSON.stringify(body),
      headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    });
    const d: any = await r.json();
    if (!r.ok) throw new Error(d?.error?.message ?? `HTTP ${r.status}`);
    return (d.content ?? []).map((b: any) => b.text ?? "").join("");
  };
}
