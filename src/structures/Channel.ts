import { Base } from "./Base";
import type { Client } from "../client/Client";
import type { Guild } from "./Guild";
import type { GuildMember } from "./GuildMember";
import type { Role } from "./Role";
import type { User } from "./User";
import type { Message } from "./Message";
import { Collection } from "../util/Collection";
import { ChannelType } from "../util/Constants";
import { PermissionsBitField, type PermissionResolvable } from "../util/PermissionsBitField";
import { value } from "../native";
import { send, type MessageCreateOptions, type MessagePayload } from "../sending";
import { MessageManager } from "./MessageManager";
import { MessageCollector, type MessageCollectorOptions, type AwaitMessagesOptions } from "../util/Collectors";
import { NotSupportedOnVector } from "../errors";

export type ChannelKind = "dm" | "community";

export abstract class BaseChannel extends Base {
  readonly id: string;
  abstract readonly type: ChannelType;
  constructor(client: Client, id: string) {
    super(client);
    this.id = id;
  }
  /** @internal (channel id, kind) for native calls */
  abstract _target(): [string, ChannelKind | null];
  get createdAt(): Date | null {
    return null;
  }
  get url(): string {
    return `vector://channel/${this.id}`;
  }
  isTextBased(): this is TextBasedChannel {
    return "send" in this;
  }
  isDMBased(): this is DMChannel {
    return this.type === ChannelType.DM;
  }
  isVoiceBased(): this is VoiceChannel {
    return this.type === ChannelType.GuildVoice;
  }
  isThread(): boolean {
    return false;
  }
  isSendable(): this is TextBasedChannel {
    return this.isTextBased();
  }
  override toString(): string {
    return `#${(this as any).name ?? this.id}`;
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// text-based behaviour, shared by community text/voice/forum channels and DMs
// ---------------------------------------------------------------------------------------------------------------------

export interface TextBasedChannel extends BaseChannel {
  readonly messages: MessageManager;
  lastMessageId: string | null;
  readonly lastMessage: Message | null;
  send(options: string | MessageCreateOptions | MessagePayload): Promise<Message>;
  sendTyping(): Promise<void>;
  bulkDelete(messages: number | string[] | Message[] | Collection<string, Message>, filterOld?: boolean): Promise<Collection<string, Message>>;
  createMessageCollector(options?: MessageCollectorOptions): MessageCollector;
  awaitMessages(options?: AwaitMessagesOptions): Promise<Collection<string, Message>>;
  createWebhook(options: { name: string; avatar?: string | null; reason?: string }): Promise<any>;
  fetchWebhooks(): Promise<Collection<string, any>>;
  /** Vector: share a Mini App (`.xdc` file path). Resolves to the app info. */
  sendMiniApp(path: string): Promise<any>;
}

function applyTextBased(cls: abstract new (...args: any[]) => BaseChannel): void {
  const p = cls.prototype as any;
  p.send = function (this: TextBasedChannel, options: string | MessageCreateOptions | MessagePayload) {
    const [id, kind] = this._target();
    return send(this.client, id, kind, options);
  };
  p.sendTyping = async function (this: TextBasedChannel) {
    const [id, kind] = this._target();
    await value(this.client._native(), "channel_typing", { id, kind });
  };
  p.bulkDelete = async function (this: TextBasedChannel, messages: any) {
    let list: Message[];
    if (typeof messages === "number") list = [...(await this.messages.fetch({ limit: messages })).values()];
    else if (messages instanceof Map) list = [...messages.values()];
    else list = await Promise.all((messages as any[]).map((m) => (typeof m === "string" ? this.messages.fetch(m) : m)));
    const out = new Collection<string, Message>();
    for (const m of list) {
      await m.delete().catch(() => undefined);
      out.set(m.id, m);
    }
    return out;
  };
  p.createMessageCollector = function (this: TextBasedChannel, options?: MessageCollectorOptions) {
    return new MessageCollector(this, options);
  };
  p.awaitMessages = function (this: TextBasedChannel, options: AwaitMessagesOptions = {}) {
    return new Promise((resolve, reject) => {
      const c = new MessageCollector(this, options);
      c.once("end", (collected, reason) => {
        if (options.errors?.includes(reason)) reject(collected);
        else resolve(collected);
      });
    });
  };
  p.createWebhook = async function (this: TextBasedChannel, options: { name: string; avatar?: string | null }) {
    const { Webhook } = await import("./Webhook");
    return Webhook.create(this as any, options);
  };
  p.fetchWebhooks = async function (this: TextBasedChannel) {
    const { Webhook } = await import("./Webhook");
    return Webhook.forChannel(this as any);
  };
  p.sendMiniApp = async function (this: TextBasedChannel, file: string) {
    const [id, kind] = this._target();
    return value(this.client._native(), "channel_send_xdc", { id, kind: kind ?? undefined, path: file });
  };
  Object.defineProperty(p, "lastMessage", {
    get(this: TextBasedChannel) {
      return this.lastMessageId ? this.messages.cache.get(this.lastMessageId) ?? null : null;
    },
  });
}

// ---------------------------------------------------------------------------------------------------------------------
// permission overwrites
// ---------------------------------------------------------------------------------------------------------------------

export interface OverwriteData {
  id: string | Role | User | GuildMember;
  allow?: PermissionResolvable;
  deny?: PermissionResolvable;
  type?: 0 | 1;
}

export interface PermissionOverwriteOptions {
  [flag: string]: boolean | null | undefined;
}

export class PermissionOverwrites {
  constructor(public readonly id: string, public readonly type: 0 | 1, public readonly allow: PermissionsBitField, public readonly deny: PermissionsBitField) {}
}

const flagBits = (opts: PermissionOverwriteOptions) => {
  let allow = 0n;
  let deny = 0n;
  for (const [k, v] of Object.entries(opts)) {
    if (v === true) allow |= PermissionsBitField.resolve(k as any);
    else if (v === false) deny |= PermissionsBitField.resolve(k as any);
  }
  return { allow, deny };
};

export class PermissionOverwriteManager {
  readonly cache = new Collection<string, PermissionOverwrites>();
  constructor(public readonly channel: GuildChannel) {}

  private target(id: OverwriteData["id"]): { kind: string; id?: string } {
    const g = this.channel.guild;
    const raw = typeof id === "string" ? id : id.id;
    if (raw === g.id || raw === "@everyone") return { kind: "everyone" };
    if (g.roles.cache.has(raw)) return { kind: "role", id: raw };
    return { kind: "member", id: raw };
  }

  /** @internal */
  async _write(target: OverwriteData["id"], allow: bigint, deny: bigint): Promise<void> {
    const t = this.target(target);
    const ch = this.channel;
    if (ch instanceof CategoryChannel) {
      await value(ch.client._native(), "category_set_overwrite", { community_id: ch.guild.id, category_id: ch.id, target_kind: t.kind, target_id: t.id, allow: Number(allow), deny: Number(deny) });
    } else {
      await value(ch.client._native(), "channel_set_overwrite", { id: ch.id, target_kind: t.kind, target_id: t.id, allow: Number(allow), deny: Number(deny) });
    }
    const key = t.id ?? ch.guild.id;
    this.cache.set(key, new PermissionOverwrites(key, t.kind === "member" ? 1 : 0, new PermissionsBitField(allow), new PermissionsBitField(deny)));
  }

  /** `create(roleOrMember, { SendMessages: false })` or with `{allow, deny}` bit fields. */
  async create(target: OverwriteData["id"], options: PermissionOverwriteOptions | OverwriteData): Promise<GuildChannel> {
    const o = options as OverwriteData;
    const bits = "allow" in o || "deny" in o
      ? { allow: PermissionsBitField.resolve(o.allow ?? 0n), deny: PermissionsBitField.resolve(o.deny ?? 0n) }
      : flagBits(options as PermissionOverwriteOptions);
    await this._write(target, bits.allow, bits.deny);
    return this.channel;
  }

  /** Merge into the existing overwrite (`null` clears a flag). */
  async edit(target: OverwriteData["id"], options: PermissionOverwriteOptions): Promise<GuildChannel> {
    const key = typeof target === "string" ? target : target.id;
    const prev = this.cache.get(key);
    let allow = prev?.allow.bitfield ?? 0n;
    let deny = prev?.deny.bitfield ?? 0n;
    for (const [k, v] of Object.entries(options)) {
      const bit = PermissionsBitField.resolve(k as any);
      allow &= ~bit;
      deny &= ~bit;
      if (v === true) allow |= bit;
      else if (v === false) deny |= bit;
    }
    await this._write(target, allow, deny);
    return this.channel;
  }

  async delete(target: OverwriteData["id"]): Promise<GuildChannel> {
    const t = this.target(target);
    await value(this.channel.client._native(), "channel_clear_overwrite", { id: this.channel.id, target_kind: t.kind, target_id: t.id });
    this.cache.delete(t.id ?? this.channel.guild.id);
    return this.channel;
  }

  async set(overwrites: OverwriteData[]): Promise<GuildChannel> {
    for (const o of overwrites) await this.create(o.id, o);
    return this.channel;
  }

  /** @internal */
  async _load(): Promise<void> {
    if (this.channel instanceof CategoryChannel) return;
    const list: any[] = await value(this.channel.client._native(), "channel_overwrites", { id: this.channel.id }).catch(() => []);
    this.cache.clear();
    for (const o of list) {
      const t = o.target ?? {};
      const id = t.Role ?? t.role ?? t.Member ?? t.member ?? this.channel.guild.id;
      const type: 0 | 1 = t.Member || t.member ? 1 : 0;
      this.cache.set(id, new PermissionOverwrites(id, type, new PermissionsBitField(BigInt(o.allow ?? 0)), new PermissionsBitField(BigInt(o.deny ?? 0))));
    }
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// community channels
// ---------------------------------------------------------------------------------------------------------------------

export abstract class GuildChannel extends BaseChannel {
  name = "";
  parentId: string | null = null;
  /** Vector: private channels are readable only by the members granted access. */
  private_ = false;
  readable = true;
  rawPosition = 0;
  raw: any = {};
  readonly permissionOverwrites: PermissionOverwriteManager;

  constructor(client: Client, public readonly guild: Guild, id: string) {
    super(client, id);
    this.permissionOverwrites = new PermissionOverwriteManager(this);
  }
  /** @internal */
  abstract _patch(data: any): this;

  get guildId(): string {
    return this.guild.id;
  }
  get parent(): CategoryChannel | null {
    const p = this.parentId ? this.guild.channels.cache.get(this.parentId) : null;
    return p instanceof CategoryChannel ? p : null;
  }
  get position(): number {
    return this.rawPosition;
  }
  get isPrivate(): boolean {
    return this.private_;
  }
  get viewable(): boolean {
    return this.readable;
  }
  get manageable(): boolean {
    return true;
  }
  override toString(): string {
    return `#${this.name}`;
  }

  /** Effective permissions of a member here (the SDK resolves overwrites). */
  permissionsFor(member: GuildMember | User | string): PermissionsBitField | null {
    const id = typeof member === "string" ? member : member.id;
    const m = this.guild.members._get(id);
    let bits = m.permissions.bitfield;
    for (const o of this.permissionOverwrites.cache.values()) {
      if (o.id === this.guild.id || m.roles.cache.has(o.id) || o.id === id) bits = (bits & ~o.deny.bitfield) | o.allow.bitfield;
    }
    return new PermissionsBitField(bits);
  }
  /** Ask the SDK for the exact effective permissions (async, authoritative). */
  async fetchPermissionsFor(member: GuildMember | User | string): Promise<PermissionsBitField> {
    const id = typeof member === "string" ? member : member.id;
    return new PermissionsBitField(BigInt(await value(this.native, "channel_permissions_of", { id: this.id, npub: id })));
  }

  async setName(name: string, _reason?: string): Promise<this> {
    if (this instanceof CategoryChannel) await value(this.native, "category_rename", { community_id: this.guild.id, category_id: this.id, name });
    else await value(this.native, "channel_rename", { id: this.id, name });
    this.name = name;
    return this;
  }
  async setParent(category: string | CategoryChannel | null, options: { lockPermissions?: boolean } = {}): Promise<this> {
    const cat = typeof category === "string" ? category : category?.id ?? null;
    await value(this.native, "channel_move", { id: this.id, category_id: cat, index: this.rawPosition });
    this.parentId = cat;
    if (options.lockPermissions) await this.lockPermissions();
    return this;
  }
  async setPosition(position: number): Promise<this> {
    if (this instanceof CategoryChannel) await value(this.native, "category_move", { community_id: this.guild.id, category_id: this.id, index: position });
    else await value(this.native, "channel_move", { id: this.id, category_id: this.parentId, index: position });
    this.rawPosition = position;
    return this;
  }
  /** Copy the category's permissions onto this channel. */
  async lockPermissions(): Promise<this> {
    await value(this.native, "channel_sync_permissions", { id: this.id, category_id: this.parentId });
    return this;
  }
  /** Vector: make the channel private (members need access) or public. */
  async setPrivate(isPrivate = true): Promise<this> {
    await value(this.native, "community_set_channel_private", { community_id: this.guild.id, channel_id: this.id, private: isPrivate });
    this.private_ = isPrivate;
    return this;
  }
  async grantAccess(user: GuildMember | User | string): Promise<void> {
    await value(this.native, "community_grant_access", { community_id: this.guild.id, channel_id: this.id, npub: typeof user === "string" ? user : user.id });
  }
  async revokeAccess(user: GuildMember | User | string): Promise<void> {
    await value(this.native, "community_revoke_access", { community_id: this.guild.id, channel_id: this.id, npub: typeof user === "string" ? user : user.id });
  }
  async delete(_reason?: string): Promise<this> {
    if (this instanceof CategoryChannel) await value(this.native, "category_delete", { community_id: this.guild.id, category_id: this.id });
    else await value(this.native, "community_delete_channel", { community_id: this.guild.id, channel_id: this.id });
    this.guild.channels.cache.delete(this.id);
    return this;
  }
  async clone(options: { name?: string } = {}): Promise<GuildChannel> {
    return this.guild.channels.create({ name: options.name ?? this.name, type: this.type, parent: this.parentId, topic: (this as any).topic ?? undefined, private: this.private_ });
  }
}

export class TextChannel extends GuildChannel {
  readonly type: ChannelType = ChannelType.GuildText;
  topic: string | null = null;
  nsfw = false;
  rateLimitPerUser = 0;
  /** Vector: read-only channels (announcements). */
  readOnly = false;
  lastMessageId: string | null = null;
  readonly messages: MessageManager;

  constructor(client: Client, guild: Guild, data: any) {
    super(client, guild, data.channel_id ?? data.id);
    this.messages = new MessageManager(this);
    this._patch(data);
  }
  _target(): [string, ChannelKind | null] {
    return [this.id, "community"];
  }
  _patch(data: any): this {
    this.raw = data;
    this.name = data.name ?? this.name;
    this.topic = data.topic ?? null;
    this.parentId = data.category_id ?? null;
    this.private_ = Boolean(data.private);
    this.readable = data.readable !== false;
    this.readOnly = Boolean(data.read_only);
    this.rawPosition = data.position ?? data._index ?? this.rawPosition;
    return this;
  }
  async setTopic(topic: string | null, _reason?: string): Promise<this> {
    await value(this.native, "channel_set_topic", { id: this.id, topic });
    this.topic = topic;
    return this;
  }
  /** Vector: only admins can post in a read-only channel. */
  async setReadOnly(readOnly = true): Promise<this> {
    await value(this.native, "channel_set_read_only", { id: this.id, read_only: readOnly });
    this.readOnly = readOnly;
    return this;
  }
  async setNSFW(_nsfw = true): Promise<this> {
    return this;
  }
  async setRateLimitPerUser(_seconds: number): Promise<this> {
    return this;
  }
  async edit(data: { name?: string; topic?: string | null; parent?: string | CategoryChannel | null; position?: number; readOnly?: boolean; private?: boolean }): Promise<this> {
    if (data.name !== undefined) await this.setName(data.name);
    if (data.topic !== undefined) await this.setTopic(data.topic);
    if (data.parent !== undefined) await this.setParent(data.parent);
    if (data.position !== undefined) await this.setPosition(data.position);
    if (data.readOnly !== undefined) await this.setReadOnly(data.readOnly);
    if (data.private !== undefined) await this.setPrivate(data.private);
    return this;
  }
  /** Pinned messages. */
  async fetchPinned(): Promise<Collection<string, Message>> {
    const pins: any[] = await value(this.native, "channel_pins", { id: this.id });
    const out = new Collection<string, Message>();
    for (const p of pins) {
      const m = await this.messages.fetch(p.message_id).catch(() => null);
      if (m) out.set(m.id, m);
    }
    return out;
  }
  get threads(): never {
    throw new NotSupportedOnVector("Threads", "use a separate channel");
  }
  async setView(view: "chat" | "voice" | "forum"): Promise<this> {
    await value(this.native, "channel_set_view", { id: this.id, view });
    return this;
  }
}
export interface TextChannel extends TextBasedChannel {}
applyTextBased(TextChannel);

/** Announcement channels are read-only text channels on Vector. */
export class NewsChannel extends TextChannel {
  override readonly type: ChannelType = ChannelType.GuildAnnouncement;
}

export class ForumChannel extends TextChannel {
  override readonly type: ChannelType = ChannelType.GuildForum;
}

/** A voice channel. It also has a text chat, like Discord's text-in-voice. */
export class VoiceChannel extends TextChannel {
  override readonly type: ChannelType = ChannelType.GuildVoice;
  bitrate = 64000;
  userLimit = 0;
  /** npubs in the call right now. */
  async fetchVoiceMembers(): Promise<any[]> {
    return value(this.native, "channel_voice_members", { id: this.id });
  }
  get joinable(): boolean {
    return true;
  }
  /** Join the call. See `VoiceConnection`. */
  async join(): Promise<import("./Voice").VoiceConnection> {
    const { VoiceConnection } = await import("./Voice");
    return VoiceConnection.join(this);
  }
}

export class CategoryChannel extends GuildChannel {
  readonly type: ChannelType = ChannelType.GuildCategory;
  constructor(client: Client, guild: Guild, data: any) {
    super(client, guild, data.category_id ?? data.id);
    this._patch(data);
  }
  _target(): [string, ChannelKind | null] {
    return [this.id, "community"];
  }
  _patch(data: any): this {
    this.raw = data;
    this.name = data.name ?? this.name;
    this.rawPosition = data.position ?? this.rawPosition;
    return this;
  }
  get children() {
    const g = this.guild;
    const self = this;
    return {
      get cache(): Collection<string, GuildChannel> {
        return g.channels.cache.filter((c) => c.parentId === self.id);
      },
      create: (options: Parameters<typeof g.channels.create>[0]) =>
        g.channels.create({ ...(typeof options === "string" ? { name: options } : options), parent: self.id }),
    };
  }
  async edit(data: { name?: string; position?: number }): Promise<this> {
    if (data.name !== undefined) await this.setName(data.name);
    if (data.position !== undefined) await this.setPosition(data.position);
    return this;
  }
}

export function channelFromInfo(client: Client, guild: Guild, info: any): GuildChannel {
  switch (info.view) {
    case "voice":
      return new VoiceChannel(client, guild, info);
    case "forum":
      return new ForumChannel(client, guild, info);
    default:
      return new TextChannel(client, guild, info);
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// DMs
// ---------------------------------------------------------------------------------------------------------------------

export class DMChannel extends BaseChannel {
  readonly type = ChannelType.DM;
  lastMessageId: string | null = null;
  readonly messages: MessageManager;
  constructor(client: Client, recipientId: string) {
    super(client, recipientId);
    this.messages = new MessageManager(this);
  }
  _target(): [string, ChannelKind | null] {
    return [this.id, "dm"];
  }
  get recipientId(): string {
    return this.id;
  }
  get recipient(): User {
    return this.client._state.user(this.id);
  }
  override toString(): string {
    return `nostr:${this.id}`;
  }
}
export interface DMChannel extends TextBasedChannel {}
applyTextBased(DMChannel);

/** A channel we only know the id of. */
export class PartialGroupChannel extends BaseChannel {
  readonly type = ChannelType.GuildText;
  lastMessageId: string | null = null;
  readonly messages: MessageManager;
  constructor(client: Client, id: string) {
    super(client, id);
    this.messages = new MessageManager(this);
  }
  _target(): [string, ChannelKind | null] {
    return [this.id, null];
  }
}
export interface PartialGroupChannel extends TextBasedChannel {}
applyTextBased(PartialGroupChannel);
