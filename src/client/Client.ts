/** `Client`: discord.js's entry point, backed by a Vector bot. */
import { EventEmitter } from "node:events";
import * as path from "node:path";
import { native, value, call, type NativeBot } from "../native";
import { State } from "./State";
import { GuildManager, type Guild } from "../structures/Guild";
import type { ClientUser, User } from "../structures/User";
import type { BaseChannel } from "../structures/Channel";
import { GuildEmoji, normalizeEmoji, isCustomEmoji, type EmojiResolvable } from "../structures/Emoji";
import { Collection } from "../util/Collection";
import { toNativeSpecs, SlashCommandBuilder, type APICommand } from "../structures/SlashCommand";
import { ApplicationCommandOptionType } from "../util/Constants";
import { NotInitialized, DiscordjsError } from "../errors";

export interface ClientOptions {
  /** Accepted for compatibility; Vector delivers everything the bot can see. */
  intents?: unknown;
  partials?: unknown;
  /** Where the bot keeps its database and caches (default `./vector-data/<npub>`). */
  dataDir?: string;
  /** `"manual"` (default): invites arrive as `guildInvite` events. `"public"`: accept every invite. */
  invitePolicy?: "manual" | "public";
  /** Only accept invites/DMs from these npubs. */
  whitelist?: string[];
  catchUp?: "inline" | "external";
  clearnet?: boolean;
  tor?: boolean;
  torBridges?: string[];
  i2p?: boolean;
  /** Wait for the next whole second before replying, so replies sort under the message they answer. Default true. */
  replyOrdering?: boolean;
  /** Messages kept in the cache (default 1000). */
  maxMessages?: number;
  /** Public base URL for webhook URLs (default `$WEBHOOKS_BASE_URL` or `http://localhost:8080`). */
  webhookBaseUrl?: string;
  /** SQLite file for webhooks (default `$WEBHOOKS_DB` or `<dataDir>/webhooks.db`). */
  webhookDb?: string;
  /** Log in from a BIP-39 mnemonic instead of an nsec. */
  mnemonic?: string;
  /** Encrypt the local key store with this password. */
  password?: string;
  [extra: string]: unknown;
}

type ResolvedOptions = ClientOptions & { replyOrdering: boolean; invitePolicy: "manual" | "public" };

export class ChannelManager {
  constructor(private readonly client: Client) {}
  /** Every known channel: community channels and open DMs. */
  get cache(): Collection<string, BaseChannel> {
    const out = new Collection<string, BaseChannel>();
    for (const g of this.client.guilds.cache.values()) for (const [id, ch] of g.channels.cache) out.set(id, ch);
    for (const [id, dm] of this.client._state.dms) out.set(id, dm);
    return out;
  }
  resolve(id: string): BaseChannel | null {
    return this.client._state.getChannel(id) ?? null;
  }
  async fetch(id: string): Promise<BaseChannel | null> {
    return (this.client._state.getChannel(id) ?? (await this.client._state.channelFor(id))) as BaseChannel;
  }
}

export class UserManager {
  constructor(private readonly client: Client) {}
  get cache(): Collection<string, User> {
    return new Collection(this.client._state.users);
  }
  resolve(id: string): User | null {
    return this.client._state.users.get(id) ?? null;
  }
  async fetch(id: string, options: { force?: boolean } = {}): Promise<User> {
    const u = this.client._state.user(id);
    if (options.force || !Object.keys(u.profile).length) {
      const p = await value(this.client._native(), "fetch_profile", { npub: id }).catch(() => null);
      if (p) u._patch(p);
    }
    return u;
  }
  createDM(id: string) {
    return this.client._state.dmChannel(id);
  }
}

export class ClientEmojiManager {
  readonly cache = new Collection<string, GuildEmoji>();
  constructor(private readonly client: Client) {}
  /** Reload custom emoji from the bot's equipped packs. */
  async refresh(): Promise<Collection<string, GuildEmoji>> {
    const list: any[] = await value(this.client._native(), "emojis").catch(() => []);
    this.cache.clear();
    for (const e of list) {
      const name = String(e.shortcode ?? e.code ?? e.name ?? "").replace(/^:|:$/g, "");
      if (name) this.cache.set(name, new GuildEmoji(name, e.url ?? "", e.pack ?? null));
    }
    return this.cache;
  }
  resolve(e: EmojiResolvable): GuildEmoji | null {
    const code = (normalizeEmoji(e) ?? "").replace(/^:|:$/g, "");
    return this.cache.get(code) ?? null;
  }
  /** Equip an emoji pack (`naddr1…`). */
  async subscribe(naddr: string) {
    const r = await value(this.client._native(), "subscribe_emoji_pack", { naddr });
    await this.refresh();
    return r;
  }
  async unsubscribe(naddr: string) {
    await value(this.client._native(), "unsubscribe_emoji_pack", { naddr });
    await this.refresh();
  }
  async packs() {
    return value(this.client._native(), "emoji_packs");
  }
}

/** A registered slash command. */
export class ApplicationCommand {
  readonly id: string;
  constructor(public readonly data: APICommand) {
    this.id = data.name;
  }
  get name() {
    return this.data.name;
  }
  get description() {
    return this.data.description;
  }
  get options() {
    return this.data.options ?? [];
  }
  toString() {
    return `/${this.name}`;
  }
}

export class ApplicationCommandManager {
  readonly cache = new Collection<string, ApplicationCommand>();
  private pending: APICommand[] = [];
  constructor(private readonly client: Client) {}
  private norm(c: APICommand | SlashCommandBuilder | { toJSON(): APICommand }): APICommand {
    return typeof (c as any).toJSON === "function" ? (c as any).toJSON() : (c as APICommand);
  }
  /** Register commands. Vector registers per bot, not per guild, so a guild id is accepted and ignored. */
  async set(commands: (APICommand | SlashCommandBuilder | { toJSON(): APICommand })[], _guildId?: string): Promise<Collection<string, ApplicationCommand>> {
    for (const c of commands) await this.create(c);
    return this.cache;
  }
  async create(command: APICommand | SlashCommandBuilder | { toJSON(): APICommand }, _guildId?: string): Promise<ApplicationCommand> {
    const data = this.norm(command);
    if ((data as any).type && (data as any).type !== 1) {
      this.client.emit("warn", `context-menu command "${data.name}" has no Vector equivalent; skipped`);
      return new ApplicationCommand(data);
    }
    const cmd = new ApplicationCommand(data);
    this.cache.set(data.name, cmd);
    if (!this.client._hasNative()) {
      this.pending.push(data);
      return cmd;
    }
    this.register(data);
    return cmd;
  }
  async fetch(): Promise<Collection<string, ApplicationCommand>> {
    return this.cache;
  }
  /** Vector can't unregister a native command at runtime; this drops it locally (it stops dispatching). */
  async delete(name: string): Promise<void> {
    this.cache.delete(name);
  }
  /** @internal */
  _flush(): void {
    for (const d of this.pending.splice(0)) this.register(d);
  }
  private register(data: APICommand): void {
    const bot = this.client._native();
    for (const spec of toNativeSpecs(data)) {
      const types = new Map<string, ApplicationCommandOptionType>();
      const opts = spec.sub
        ? (spec.group
          ? data.options?.find((o) => o.name === spec.group)?.options?.find((o) => o.name === spec.sub)?.options
          : data.options?.find((o) => o.name === spec.sub)?.options) ?? []
        : data.options ?? [];
      for (const o of opts) types.set(o.name.toLowerCase(), o.type);
      this.client._state.commandRoutes.set(spec.name, { command: data.name, sub: spec.sub ?? null, group: spec.group ?? null, types });
      try {
        bot.registerCommand(spec.name, spec.description || spec.name, spec.args);
      } catch (e) {
        throw new DiscordjsError(`could not register /${spec.name}: ${(e as Error).message}`);
      }
    }
  }
}

export class ClientApplication {
  readonly commands: ApplicationCommandManager;
  constructor(private readonly client: Client) {
    this.commands = new ApplicationCommandManager(client);
  }
  get id(): string {
    return this.client.user?.id ?? "";
  }
  get name(): string {
    return this.client.user?.username ?? "";
  }
  async fetch() {
    return this;
  }
}

/** A live Mini App (webxdc) session the bot joined. */
export class MiniAppSession extends EventEmitter {
  private ended = false;
  private pumping = false;
  constructor(private readonly client: Client, public readonly handle: number, public readonly app: any, public readonly selfAddr: string, public readonly handler: number | null = null) {
    super();
    this.on("newListener", (ev) => {
      if (ev === "data" || ev === "peerJoin" || ev === "peerLeave" || ev === "end") queueMicrotask(() => void this.pump());
    });
  }
  /** Next event: `{type: "data", from, direct, data: Buffer}`, `{type: "peer_join"|"peer_leave", peer}`, or `null` when it ends. */
  async next(): Promise<any | null> {
    if (this.ended) return null;
    const r = await call(this.client._native(), "xdc_next", { handle: this.handle });
    if (r.value === null || r.value === undefined) {
      this.ended = true;
      return null;
    }
    return r.bytes ? { ...r.value, data: r.bytes, text: () => r.bytes!.toString("utf8"), json: () => JSON.parse(r.bytes!.toString("utf8")) } : r.value;
  }
  async *[Symbol.asyncIterator]() {
    for (let ev = await this.next(); ev; ev = await this.next()) yield ev;
  }
  private async pump() {
    if (this.pumping) return;
    this.pumping = true;
    try {
      for await (const ev of this) {
        if (ev.type === "data") this.emit("data", ev);
        else if (ev.type === "peer_join") this.emit("peerJoin", ev.peer);
        else if (ev.type === "peer_leave") this.emit("peerLeave", ev.peer);
      }
    } catch (e) {
      this.emit("error", e);
    }
    this.emit("end");
  }
  /** Broadcast to every peer: a Buffer, a string, or any JSON value. */
  async send(data: Buffer | string | unknown): Promise<void> {
    if (Buffer.isBuffer(data)) await call(this.client._native(), "xdc_send", { handle: this.handle }, data);
    else if (typeof data === "string") await value(this.client._native(), "xdc_send", { handle: this.handle, text: data });
    else await value(this.client._native(), "xdc_send", { handle: this.handle, json: data });
  }
  async peers(): Promise<any[]> {
    return value(this.client._native(), "xdc_peers", { handle: this.handle });
  }
  async leave(): Promise<void> {
    this.ended = true;
    await value(this.client._native(), "xdc_leave", { handle: this.handle }).catch(() => undefined);
  }
}

export class MiniAppManager {
  constructor(private readonly client: Client) {}
  private pending: Record<string, unknown>[] = [];
  /**
   * Join sessions of a Mini App (by name, id or `.xdc` hash) when someone opens (or shares) it. Sessions arrive as
   * `miniAppSession` events; the returned id is `session.handler`.
   */
  register(app: string, options: { byHash?: boolean; joinWhen?: "opened" | "shared"; idleTimeout?: number; quietTimeout?: number; maxSessions?: number; maxPerChat?: number } = {}): number | null {
    const o = { app, by_hash: options.byHash, join_when: options.joinWhen, idle_timeout: options.idleTimeout, quiet_timeout: options.quietTimeout, max_sessions: options.maxSessions, max_per_chat: options.maxPerChat };
    if (!this.client._hasNative()) {
      this.pending.push(o);
      return null;
    }
    const bot = this.client._native();
    if (!bot.registerXdc) throw new DiscordjsError("this build has no Mini App support (rebuild with the `xdc` feature)");
    return bot.registerXdc(JSON.parse(JSON.stringify(o)));
  }
  /** @internal */
  _flush() {
    for (const o of this.pending.splice(0)) this.register(String(o.app), { byHash: o.by_hash as boolean, joinWhen: o.join_when as any });
  }
  /** Join the Mini App carried by a message. */
  async join(messageId: string): Promise<MiniAppSession> {
    const r = await value(this.client._native(), "xdc_join", { message_id: messageId });
    return new MiniAppSession(this.client, r.session, r.app, r.self_addr);
  }
}

export class Client extends EventEmitter {
  readonly options: ResolvedOptions;
  user: ClientUser | null = null;
  readonly guilds: GuildManager;
  readonly channels: ChannelManager;
  readonly users: UserManager;
  readonly emojis: ClientEmojiManager;
  readonly application: ClientApplication;
  readonly miniApps: MiniAppManager;
  readyTimestamp: number | null = null;
  /** discord.js keeps the bot token here; Vector never exposes the nsec. */
  token: string | null = null;
  readonly ws = { ping: 0, status: 5, shards: new Collection<number, unknown>() };
  /** @internal */
  _state: State;
  private bot: NativeBot | null = null;
  private loop: Promise<void> | null = null;
  private stopping = false;
  private webhookStoreObj: any = null;

  constructor(options: ClientOptions = {}) {
    super();
    this.options = { replyOrdering: true, invitePolicy: "manual", ...options } as ResolvedOptions;
    this._state = new State(this, options.maxMessages ?? 1000);
    this.guilds = new GuildManager(this);
    this.channels = new ChannelManager(this);
    this.users = new UserManager(this);
    this.emojis = new ClientEmojiManager(this);
    this.application = new ClientApplication(this);
    this.miniApps = new MiniAppManager(this);
  }

  /** A fresh Vector identity (`nsec1…`). Keep it secret. */
  static generateNsec(): string {
    return native().generateNsec();
  }
  static get sdkVersion(): string {
    return native().sdkVersion();
  }

  get readyAt(): Date | null {
    return this.readyTimestamp ? new Date(this.readyTimestamp) : null;
  }
  get uptime(): number | null {
    return this.readyTimestamp ? Date.now() - this.readyTimestamp : null;
  }
  isReady(): this is Client & { user: ClientUser } {
    return this.readyTimestamp !== null;
  }

  /** @internal */
  _native(): NativeBot {
    if (!this.bot) throw new NotInitialized("the client isn't logged in yet: call client.login(nsec) first");
    return this.bot;
  }
  /** @internal */
  _hasNative(): boolean {
    return this.bot !== null;
  }
  /** @internal: emoji in any form -> the reaction code plus image URL for custom emoji. */
  _resolveEmoji(emoji: EmojiResolvable): { code: string; url: string | null } {
    const code = normalizeEmoji(emoji) ?? "";
    if (!isCustomEmoji(code)) return { code, url: null };
    const given = typeof emoji === "object" && emoji && "url" in emoji ? (emoji as any).url : null;
    if (given) return { code, url: given };
    const known = this.emojis.cache.get(code.slice(1, -1));
    if (!known) throw new DiscordjsError(`unknown custom emoji ${code}: equip a pack that has it (client.emojis.subscribe)`);
    return { code, url: known.url };
  }
  /** @internal */
  _miniAppSession(ev: any): MiniAppSession {
    return new MiniAppSession(this, ev.session, ev.app, ev.self_addr, ev.handler ?? null);
  }

  /** Where `channel.createWebhook()` keeps webhooks (SQLite). Share the file with `vector-webhooks serve`. */
  get webhookStore(): any {
    if (!this.webhookStoreObj) {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { WebhookStore } = require("../webhooks/store") as typeof import("../webhooks/store");
      const p = this.options.webhookDb ?? process.env.WEBHOOKS_DB ?? path.join(this.options.dataDir ?? process.env.VECTOR_DATA_DIR ?? ".", "webhooks.db");
      this.webhookStoreObj = new WebhookStore(p);
    }
    return this.webhookStoreObj;
  }
  set webhookStore(store: any) {
    this.webhookStoreObj = store;
  }
  get webhookBaseUrl(): string {
    return (this.options.webhookBaseUrl ?? process.env.WEBHOOKS_BASE_URL ?? "http://localhost:8080").replace(/\/+$/, "");
  }

  /**
   * Log in with an `nsec1…` secret key (or `$VECTOR_NSEC`; or `options.mnemonic`). Resolves once connected; the
   * `ready` event follows when communities are loaded.
   */
  async login(nsec?: string): Promise<string> {
    if (this.bot) throw new DiscordjsError("already logged in");
    const key = nsec ?? process.env.VECTOR_NSEC ?? process.env.DISCORD_TOKEN;
    if (!key && !this.options.mnemonic) throw new DiscordjsError("no key: pass an nsec to login() or set $VECTOR_NSEC");
    if (key && !key.startsWith("nsec1") && !/^[0-9a-f]{64}$/i.test(key)) {
      throw new DiscordjsError("that looks like a Discord token. Vector bots log in with an nsec1… secret key (Client.generateNsec() makes one)");
    }
    const o = this.options;
    this.bot = await native().NativeBot.build(JSON.parse(JSON.stringify({
      nsec: key, mnemonic: key ? undefined : o.mnemonic, password: o.password, data_dir: o.dataDir,
      invite_policy: o.invitePolicy, whitelist: o.whitelist, catch_up: o.catchUp, clearnet: o.clearnet,
      tor: o.tor, tor_bridges: o.torBridges, i2p: o.i2p,
    })));
    this.user = this._state.setClientUser(this.bot.npub);
    this.loadSavedCommands();
    this.application.commands._flush();
    this.miniApps._flush();
    this.emit("debug", `logged in as ${this.bot.npub}`);
    await this.emojis.refresh().catch(() => undefined);
    this.loop = this.run();
    // start() runs the listener until stop(); it resolves (or rejects) only when the bot disconnects.
    this.bot.start().catch((e) => {
      if (!this.stopping) this.emit("error", e);
    });
    return "nsec-hidden";
  }

  /** Commands a `deploy-commands.js` script saved through the `REST` shim (`.vector-commands.json`). */
  private loadSavedCommands(): void {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { commandsFile } = require("../compat/stubs") as typeof import("../compat/stubs");
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fs = require("node:fs") as typeof import("node:fs");
    const file = commandsFile();
    if (!fs.existsSync(file)) return;
    try {
      for (const c of JSON.parse(fs.readFileSync(file, "utf8"))) if (!this.application.commands.cache.has(c.name)) void this.application.commands.create(c);
      this.emit("debug", `loaded slash commands from ${file}`);
    } catch (e) {
      this.emit("warn", `couldn't read ${file}: ${(e as Error).message}`);
    }
  }

  private async run(): Promise<void> {
    const bot = this.bot!;
    while (!this.stopping) {
      let ev: any;
      try {
        ev = await bot.nextEvent();
      } catch (e) {
        if (this.stopping) break;
        this.emit("error", e as Error);
        continue;
      }
      if (ev === null || ev === undefined) break;
      // Don't block the loop on handlers: events are processed concurrently but each await inside handle() keeps
      // per-event ordering for the common path.
      await this._state.handle(ev);
    }
    this.emit("invalidated");
  }

  /** Disconnect. */
  async destroy(): Promise<void> {
    if (!this.bot) return;
    this.stopping = true;
    try {
      this.bot.stop();
    } catch {
      /* already stopped */
    }
    await Promise.race([this.loop, new Promise((r) => setTimeout(r, 3000))]);
    this.webhookStoreObj?.close?.();
    this.readyTimestamp = null;
  }

  /** Log out and forget this identity's local session. */
  async logout(): Promise<void> {
    await this._native().logout();
    await this.destroy();
  }

  /** Accept a pending community invite, or join from an invite link. */
  async acceptInvite(communityIdOrLink: string): Promise<Guild> {
    if (/^https?:|^vector:/.test(communityIdOrLink)) {
      const id: string = await value(this._native(), "join", { invite_url: communityIdOrLink });
      return this._state.addGuild(id, true);
    }
    await value(this._native(), "accept_invite", { community_id: communityIdOrLink });
    return this._state.addGuild(communityIdOrLink, true);
  }
  async fetchInvites(): Promise<any[]> {
    return value(this._native(), "pending_invites");
  }
  /** The bot's address to share (Vector has no OAuth2 invite: people DM the bot or invite it to a community). */
  generateInvite(): string {
    return `nostr:${this.user?.id ?? ""}`;
  }
}
