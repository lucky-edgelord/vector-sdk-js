import { Base } from "./Base";
import type { Client } from "../client/Client";
import { Collection } from "../util/Collection";
import { ChannelType } from "../util/Constants";
import { PermissionsBitField, type PermissionResolvable } from "../util/PermissionsBitField";
import { Role, resolveColor, type RoleEditOptions } from "./Role";
import { GuildMember } from "./GuildMember";
import { CategoryChannel, GuildChannel, TextChannel, VoiceChannel, channelFromInfo, type OverwriteData } from "./Channel";
import type { User } from "./User";
import { value, call } from "../native";

export type UserResolvable = string | User | GuildMember;
const npubOf = (u: UserResolvable) => (typeof u === "string" ? u : u.id);

// ---------------------------------------------------------------------------------------------------------------------
// managers
// ---------------------------------------------------------------------------------------------------------------------

export interface GuildChannelCreateOptions {
  name: string;
  type?: ChannelType;
  topic?: string;
  parent?: string | CategoryChannel | null;
  permissionOverwrites?: OverwriteData[];
  position?: number;
  /** Vector: a private channel only listed members can read. */
  private?: boolean;
  reason?: string;
  nsfw?: boolean;
}

export class GuildChannelManager {
  readonly cache = new Collection<string, GuildChannel>();
  constructor(public readonly guild: Guild) {}

  get client() {
    return this.guild.client;
  }

  /** `guild.channels.create({ name, type, topic, parent })` (discord.js v14). */
  async create(options: GuildChannelCreateOptions | string): Promise<GuildChannel> {
    const o: GuildChannelCreateOptions = typeof options === "string" ? { name: options } : options;
    const g = this.guild;
    if (o.type === ChannelType.GuildCategory) {
      const id: string = await value(g._bot(), "community_create_category", { community_id: g.id, name: o.name });
      await g._refreshChannels();
      const cat = this.cache.get(id) ?? new CategoryChannel(g.client, g, { category_id: id, name: o.name });
      for (const ow of o.permissionOverwrites ?? []) await cat.permissionOverwrites.create(ow.id, ow);
      return cat;
    }
    const view = o.type === ChannelType.GuildVoice || o.type === ChannelType.GuildStageVoice ? "voice"
      : o.type === ChannelType.GuildForum ? "forum" : "chat";
    const parent = typeof o.parent === "string" ? o.parent : o.parent?.id;
    const id: string = await value(g._bot(), "community_create_channel", {
      community_id: g.id, name: o.name, private: Boolean(o.private), category_id: parent, view, topic: o.topic,
    });
    await g._refreshChannels();
    const ch = this.cache.get(id) ?? channelFromInfo(g.client, g, { channel_id: id, name: o.name, topic: o.topic, category_id: parent, view });
    for (const ow of o.permissionOverwrites ?? []) await ch.permissionOverwrites.create(ow.id, ow);
    if (o.position !== undefined && "setPosition" in ch) await (ch as TextChannel).setPosition(o.position);
    return ch;
  }

  async fetch(id?: string): Promise<any> {
    await this.guild._refreshChannels();
    return id ? this.cache.get(id) ?? null : this.cache;
  }

  async delete(channel: string | GuildChannel): Promise<void> {
    const ch = typeof channel === "string" ? this.cache.get(channel) : channel;
    if (ch) await ch.delete();
  }

  resolve(c: string | GuildChannel): GuildChannel | undefined {
    return typeof c === "string" ? this.cache.get(c) ?? this.cache.find((x) => x.name === c) : c;
  }
}

export class RoleManager {
  readonly cache = new Collection<string, Role>();
  constructor(public readonly guild: Guild) {}

  get everyone(): Role | undefined {
    return this.cache.get(this.guild.id);
  }
  get highest(): Role | undefined {
    return [...this.cache.values()].sort((a, b) => b.position - a.position)[0];
  }
  async create(options: RoleEditOptions & { channel?: string } = {}): Promise<Role> {
    const g = this.guild;
    const id: string = await value(g._bot(), "community_create_role", {
      community_id: g.id, name: options.name ?? "new role", color: resolveColor(options.color),
      permissions: options.permissions !== undefined ? Number(PermissionsBitField.resolve(options.permissions)) : undefined,
      channel_id: options.channel, shown: options.hoist, mentionable: options.mentionable,
    });
    await g._refreshRoles();
    return this.cache.get(id) ?? new Role(g.client, g, { role_id: id, name: options.name });
  }
  async fetch(id?: string): Promise<any> {
    await this.guild._refreshRoles();
    return id ? this.cache.get(id) ?? null : this.cache;
  }
  async delete(role: string | Role): Promise<void> {
    const r = typeof role === "string" ? this.cache.get(role) : role;
    if (r) await r.delete();
  }
  async edit(role: string | Role, options: RoleEditOptions): Promise<Role> {
    const r = typeof role === "string" ? this.cache.get(role)! : role;
    return r.edit(options);
  }
  /** Order roles, highest first. */
  async setPositions(order: (string | Role)[]): Promise<void> {
    await value(this.guild._bot(), "community_reorder_roles", { community_id: this.guild.id, top_first: order.map((r) => (typeof r === "string" ? r : r.id)) });
    await this.guild._refreshRoles();
  }
  resolve(r: string | Role): Role | undefined {
    return typeof r === "string" ? this.cache.get(r) ?? this.cache.find((x) => x.name === r) : r;
  }
}

export class GuildMemberManager {
  readonly cache = new Collection<string, GuildMember>();
  constructor(public readonly guild: Guild) {}

  get me(): GuildMember | null {
    const id = this.guild.client.user?.id;
    return id ? this._get(id) : null;
  }
  /** @internal */
  _get(npub: string): GuildMember {
    let m = this.cache.get(npub);
    if (!m) {
      m = new GuildMember(this.guild.client, this.guild, npub);
      this.cache.set(npub, m);
    }
    return m;
  }
  async fetch(id?: UserResolvable | { user?: UserResolvable; force?: boolean }): Promise<any> {
    if (id && typeof id === "object" && !("id" in id)) id = (id as any).user;
    if (id) {
      const m = this._get(npubOf(id as UserResolvable));
      return m.fetch();
    }
    await this.guild._refreshMembers();
    return this.cache;
  }
  async kick(user: UserResolvable, reason?: string) {
    return this._get(npubOf(user)).kick(reason);
  }
  async ban(user: UserResolvable, options?: { reason?: string }) {
    return this.guild.bans.create(user, options);
  }
  async unban(user: UserResolvable) {
    return this.guild.bans.remove(user);
  }
  async edit(user: UserResolvable, data: Parameters<GuildMember["edit"]>[0]) {
    return this._get(npubOf(user)).edit(data);
  }
  resolve(u: UserResolvable): GuildMember | undefined {
    return this.cache.get(npubOf(u));
  }
}

export class GuildBanManager {
  constructor(public readonly guild: Guild) {}
  async create(user: UserResolvable, _options?: { reason?: string; deleteMessageSeconds?: number }): Promise<void> {
    await value(this.guild._bot(), "member_ban", { community_id: this.guild.id, npub: npubOf(user) });
    this.guild.members.cache.delete(npubOf(user));
  }
  async remove(user: UserResolvable, _reason?: string): Promise<void> {
    await value(this.guild._bot(), "member_unban", { community_id: this.guild.id, npub: npubOf(user) });
  }
  /** Banned npubs -> `{ user }` entries, like discord.js's GuildBan. */
  async fetch(): Promise<Collection<string, { user: User; reason: null; guild: Guild }>> {
    const ids: string[] = await value(this.guild._bot(), "community_banned", { community_id: this.guild.id });
    const out = new Collection<string, { user: User; reason: null; guild: Guild }>();
    for (const id of ids) out.set(id, { user: this.guild.client._state.user(id), reason: null, guild: this.guild });
    return out;
  }
  async bulkCreate(users: UserResolvable[]): Promise<void> {
    await value(this.guild._bot(), "community_ban_many", { community_id: this.guild.id, npubs: users.map(npubOf) });
  }
}

export class Invite {
  constructor(public readonly guild: Guild, public readonly url: string, public readonly raw: any = {}) {}
  get code(): string {
    return this.raw.token ?? this.url.split("/").pop() ?? this.url;
  }
  get expiresTimestamp(): number | null {
    return this.raw.expires_at_ms ?? null;
  }
  get expiresAt(): Date | null {
    return this.expiresTimestamp ? new Date(this.expiresTimestamp) : null;
  }
  get label(): string | null {
    return this.raw.label ?? null;
  }
  toString(): string {
    return this.url;
  }
  async delete(): Promise<void> {
    await value(this.guild._bot(), "community_revoke_invite", { community_id: this.guild.id, token: this.code });
  }
}

export class GuildInviteManager {
  constructor(public readonly guild: Guild) {}
  /** `maxAge` in seconds (0 = never expires); `label` is Vector's invite label. */
  async create(_channel?: unknown, options: { maxAge?: number; label?: string } = {}): Promise<Invite> {
    const expires = options.maxAge ? Date.now() + options.maxAge * 1000 : undefined;
    const url: string = await value(this.guild._bot(), "community_create_invite", { community_id: this.guild.id, expires_at_ms: expires, label: options.label });
    return new Invite(this.guild, url, { label: options.label, expires_at_ms: expires });
  }
  async fetch(): Promise<Collection<string, Invite>> {
    const list: any[] = await value(this.guild._bot(), "community_invite_links", { community_id: this.guild.id });
    const out = new Collection<string, Invite>();
    for (const d of list) {
      const inv = new Invite(this.guild, d.url ?? d.link ?? d.token ?? "", d);
      out.set(inv.code, inv);
    }
    return out;
  }
  async delete(code: string): Promise<void> {
    await value(this.guild._bot(), "community_revoke_invite", { community_id: this.guild.id, token: code });
  }
  async deleteAll(): Promise<void> {
    await value(this.guild._bot(), "community_revoke_all_invites", { community_id: this.guild.id });
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Guild (a Vector Community)
// ---------------------------------------------------------------------------------------------------------------------

/** A Vector Community, under discord.js's name. */
export class Guild extends Base {
  readonly id: string;
  name = "";
  description: string | null = null;
  ownerId = "";
  available = true;
  readonly channels: GuildChannelManager;
  readonly roles: RoleManager;
  readonly members: GuildMemberManager;
  readonly bans: GuildBanManager;
  readonly invites: GuildInviteManager;
  /** @internal */
  _categoryOrder: string[] = [];

  constructor(client: Client, id: string) {
    super(client);
    this.id = id;
    this.channels = new GuildChannelManager(this);
    this.roles = new RoleManager(this);
    this.members = new GuildMemberManager(this);
    this.bans = new GuildBanManager(this);
    this.invites = new GuildInviteManager(this);
  }

  /** @internal */
  _bot() {
    return this.native;
  }

  get memberCount(): number {
    return this.members.cache.size;
  }
  get owner(): GuildMember | null {
    return this.ownerId ? this.members._get(this.ownerId) : null;
  }
  async fetchOwner(): Promise<GuildMember> {
    return this.members._get(this.ownerId).fetch();
  }
  /** The community's first channel (Vector's "primary" channel). */
  get systemChannel(): TextChannel | null {
    const first = this.channels.cache.find((c) => c instanceof TextChannel && !(c instanceof VoiceChannel));
    return (first as TextChannel) ?? null;
  }
  get systemChannelId(): string | null {
    return this.systemChannel?.id ?? null;
  }
  get emojis() {
    return this.client.emojis;
  }
  iconURL(): string | null {
    return null;
  }
  override toString(): string {
    return this.name;
  }

  /** @internal Load everything (name, channels, roles, members). */
  async _refresh(): Promise<this> {
    const bot = this.native;
    this.name = (await value(bot, "community_name", { community_id: this.id }).catch(() => null)) || this.name;
    this.description = await value(bot, "community_description", { community_id: this.id }).catch(() => null);
    this.ownerId = (await value(bot, "community_owner", { community_id: this.id }).catch(() => null)) || this.ownerId;
    await this._refreshChannels();
    await this._refreshRoles();
    await this._refreshMembers().catch(() => undefined);
    return this;
  }

  /** @internal */
  async _refreshChannels(): Promise<void> {
    const bot = this.native;
    const infos: any[] = await value(bot, "community_channel_infos", { community_id: this.id }).catch(() => []);
    const listing: any[] = await value(bot, "community_channels", { community_id: this.id }).catch(() => []);
    const known = new Set(infos.map((i) => i.channel_id));
    for (const c of listing) if (!known.has(c.channel_id)) infos.push({ channel_id: c.channel_id, name: c.name ?? "", private: c.private, readable: c.readable });
    const readable = new Map(listing.map((c) => [c.channel_id, c.readable !== false]));
    const cats: any[] = await value(bot, "community_categories", { community_id: this.id }).catch(() => []);
    const fresh = new Collection<string, GuildChannel>();
    for (const c of cats) {
      const prev = this.channels.cache.get(c.category_id);
      fresh.set(c.category_id, prev instanceof CategoryChannel ? prev._patch(c) : new CategoryChannel(this.client, this, c));
    }
    this._categoryOrder = cats.map((c) => c.category_id);
    infos.forEach((info, i) => {
      info.readable = readable.get(info.channel_id) ?? true;
      info._index = i;
      const prev = this.channels.cache.get(info.channel_id);
      const made = channelFromInfo(this.client, this, info);
      fresh.set(info.channel_id, prev && prev.constructor === made.constructor ? prev._patch(info) : made);
    });
    this.channels.cache.clear();
    for (const [k, v] of fresh) this.channels.cache.set(k, v);
  }

  /** @internal */
  async _refreshRoles(): Promise<void> {
    const bot = this.native;
    const roles: any[] = await value(bot, "community_roles", { community_id: this.id }).catch(() => []);
    const everyone: number | null = await value(bot, "community_everyone_permissions", { community_id: this.id }).catch(() => null);
    this.roles.cache.clear();
    this.roles.cache.set(this.id, new Role(this.client, this, { role_id: this.id, name: "@everyone", permissions: everyone ?? Number(PermissionsBitField.Default), position: -1 }));
    for (const r of roles) {
      const role = new Role(this.client, this, r);
      this.roles.cache.set(role.id, role);
    }
  }

  /** @internal */
  async _refreshMembers(): Promise<void> {
    const npubs: string[] = await value(this.native, "community_members", { community_id: this.id });
    const keep = new Set(npubs);
    for (const id of this.members.cache.keys()) if (!keep.has(id)) this.members.cache.delete(id);
    for (const n of npubs) this.members._get(n);
  }

  async fetch(): Promise<this> {
    return this._refresh();
  }
  async edit(data: { name?: string; description?: string | null; icon?: Buffer | null; banner?: Buffer | null }): Promise<this> {
    if (data.name !== undefined || data.description !== undefined) {
      await value(this.native, "community_edit", { community_id: this.id, name: data.name, description: data.description ?? undefined });
      if (data.name !== undefined) this.name = data.name;
      if (data.description !== undefined) this.description = data.description;
    }
    if (data.icon !== undefined) await this.setIcon(data.icon);
    if (data.banner !== undefined) await this.setBanner(data.banner);
    return this;
  }
  setName(name: string) {
    return this.edit({ name });
  }
  async setIcon(image: Buffer | null): Promise<this> {
    await call(this.native, "community_set_icon", { community_id: this.id }, image);
    return this;
  }
  async setBanner(image: Buffer | null): Promise<this> {
    await call(this.native, "community_set_banner", { community_id: this.id }, image);
    return this;
  }
  async fetchIcon(): Promise<Buffer | null> {
    return (await call(this.native, "community_icon", { community_id: this.id })).bytes ?? null;
  }
  /** Webhooks for this community's channels (see `channel.createWebhook()`). */
  async fetchWebhooks() {
    const { Webhook } = await import("./Webhook");
    return Webhook.forGuild(this);
  }
  async leave(): Promise<this> {
    await value(this.native, "community_leave", { community_id: this.id });
    this.client.guilds.cache.delete(this.id);
    return this;
  }
  /** Dissolve the community (owner only). */
  async delete(): Promise<this> {
    await value(this.native, "community_dissolve", { community_id: this.id });
    this.client.guilds.cache.delete(this.id);
    return this;
  }
  async fetchAuditLogs(): Promise<any> {
    return value(this.native, "community_audit_log", { community_id: this.id });
  }
  /** Invite a specific user by npub. */
  async invite(user: UserResolvable): Promise<void> {
    await value(this.native, "community_invite", { community_id: this.id, npub: npubOf(user) });
  }
  /** Vector moderation: ban a set of accounts and lock down new joins since a time. */
  async containRaid(npubs: string[], windowStart: Date | number, cutAlso: string[] = []): Promise<any> {
    const secs = Math.floor((windowStart instanceof Date ? windowStart.getTime() : windowStart) / 1000);
    return value(this.native, "community_contain_raid", { community_id: this.id, npubs, window_start_secs: secs, cut_also: cutAlso });
  }
  get everyonePermissions(): PermissionsBitField {
    return this.roles.everyone?.permissions ?? new PermissionsBitField(PermissionsBitField.Default);
  }
  async setEveryonePermissions(perms: PermissionResolvable): Promise<void> {
    await value(this.native, "community_set_everyone_permissions", { community_id: this.id, permissions: Number(PermissionsBitField.resolve(perms)) });
    await this._refreshRoles();
  }
}

export class GuildManager {
  readonly cache = new Collection<string, Guild>();
  constructor(public readonly client: Client) {}
  async fetch(id?: string): Promise<any> {
    if (id) {
      const g = this.client._state.guild(id);
      return g._refresh();
    }
    return this.cache;
  }
  /** Create a new Vector Community. */
  async create(options: { name: string; description?: string; firstChannel?: string; relays?: string[] }): Promise<Guild> {
    const id: string = await value(this.client._native(), "create_community", {
      name: options.name, description: options.description, first_channel: options.firstChannel, relays: options.relays,
    });
    return this.client._state.addGuild(id, true);
  }
  resolve(g: string | Guild): Guild | undefined {
    return typeof g === "string" ? this.cache.get(g) : g;
  }
}
