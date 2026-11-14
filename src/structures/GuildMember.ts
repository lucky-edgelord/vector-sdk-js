import { Base } from "./Base";
import type { Client } from "../client/Client";
import type { Guild } from "./Guild";
import type { User } from "./User";
import type { Role } from "./Role";
import { Collection } from "../util/Collection";
import { PermissionsBitField } from "../util/PermissionsBitField";
import { value } from "../native";
import type { MessageCreateOptions, MessagePayload } from "../sending";

export class GuildMemberRoleManager {
  constructor(private readonly member: GuildMember) {}

  /** @internal role ids from the roster */
  _ids: string[] = [];

  get cache(): Collection<string, Role> {
    const out = new Collection<string, Role>();
    const g = this.member.guild;
    const everyone = g.roles.everyone;
    if (everyone) out.set(everyone.id, everyone);
    for (const id of this._ids) {
      const r = g.roles.cache.get(id);
      if (r) out.set(id, r);
    }
    return out;
  }
  get highest(): Role | undefined {
    return [...this.cache.values()].sort((a, b) => b.position - a.position)[0];
  }
  get hoist(): Role | null {
    return [...this.cache.values()].filter((r) => r.hoist).sort((a, b) => b.position - a.position)[0] ?? null;
  }
  get color(): Role | null {
    return [...this.cache.values()].filter((r) => r.color).sort((a, b) => b.position - a.position)[0] ?? null;
  }
  async fetch(): Promise<Collection<string, Role>> {
    const roles: any[] = await value(this.member.client._native(), "member_roles", { community_id: this.member.guild.id, npub: this.member.id });
    this._ids = roles.map((r) => r.role_id ?? r.id ?? r);
    return this.cache;
  }
  private ids(roles: RoleResolvable | RoleResolvable[]): string[] {
    return (Array.isArray(roles) ? roles : [roles]).map((r) => (typeof r === "string" ? r : r.id));
  }
  async add(roles: RoleResolvable | RoleResolvable[], _reason?: string): Promise<GuildMember> {
    for (const id of this.ids(roles)) {
      await value(this.member.client._native(), "member_add_role", { community_id: this.member.guild.id, npub: this.member.id, role_id: id });
      if (!this._ids.includes(id)) this._ids.push(id);
    }
    return this.member;
  }
  async remove(roles: RoleResolvable | RoleResolvable[], _reason?: string): Promise<GuildMember> {
    for (const id of this.ids(roles)) {
      await value(this.member.client._native(), "member_remove_role", { community_id: this.member.guild.id, npub: this.member.id, role_id: id });
      this._ids = this._ids.filter((x) => x !== id);
    }
    return this.member;
  }
  async set(roles: RoleResolvable[], _reason?: string): Promise<GuildMember> {
    const ids = this.ids(roles).filter((id) => id !== this.member.guild.id);
    await value(this.member.client._native(), "member_set_roles", { community_id: this.member.guild.id, npub: this.member.id, role_ids: ids });
    this._ids = ids;
    return this.member;
  }
}

export type RoleResolvable = Role | string;

export class GuildMember extends Base {
  readonly id: string;
  readonly roles: GuildMemberRoleManager;
  nickname: string | null = null;
  communicationDisabledTimestamp: number | null = null;
  joinedTimestamp: number | null = null;
  pending = false;

  constructor(client: Client, public readonly guild: Guild, id: string) {
    super(client);
    this.id = id;
    this.roles = new GuildMemberRoleManager(this);
  }

  get user(): User {
    return this.client._state.user(this.id);
  }
  get displayName(): string {
    return this.nickname || this.user.displayName;
  }
  get nick(): string | null {
    return this.nickname;
  }
  get joinedAt(): Date | null {
    return this.joinedTimestamp ? new Date(this.joinedTimestamp) : null;
  }
  get communicationDisabledUntil(): Date | null {
    return this.communicationDisabledTimestamp ? new Date(this.communicationDisabledTimestamp) : null;
  }
  isCommunicationDisabled(): boolean {
    return (this.communicationDisabledTimestamp ?? 0) > Date.now();
  }
  get isOwner(): boolean {
    return this.guild.ownerId === this.id;
  }
  /** Permissions from @everyone and the member's roles (the owner has everything). */
  get permissions(): PermissionsBitField {
    if (this.isOwner) return new PermissionsBitField(PermissionsBitField.All);
    let bits = 0n;
    for (const r of this.roles.cache.values()) bits |= r.permissions.bitfield;
    return new PermissionsBitField(bits);
  }
  permissionsIn(channel: { permissionsFor(m: GuildMember): PermissionsBitField | null }): PermissionsBitField {
    return channel.permissionsFor(this) ?? this.permissions;
  }
  get kickable(): boolean {
    return !this.isOwner;
  }
  get bannable(): boolean {
    return !this.isOwner;
  }
  get moderatable(): boolean {
    return !this.isOwner;
  }
  get manageable(): boolean {
    return !this.isOwner;
  }
  override toString(): string {
    return `nostr:${this.id}`;
  }

  async kick(_reason?: string): Promise<this> {
    await value(this.native, "member_kick", { community_id: this.guild.id, npub: this.id });
    this.guild.members.cache.delete(this.id);
    return this;
  }
  async ban(_options?: { reason?: string; deleteMessageSeconds?: number }): Promise<this> {
    await value(this.native, "member_ban", { community_id: this.guild.id, npub: this.id });
    this.guild.members.cache.delete(this.id);
    return this;
  }
  /** `timeout(ms)` or `timeout(null)` to clear it, like discord.js. */
  async timeout(ms: number | null, _reason?: string): Promise<this> {
    if (ms === null || ms <= 0) {
      await value(this.native, "member_remove_timeout", { community_id: this.guild.id, npub: this.id });
      this.communicationDisabledTimestamp = null;
    } else {
      await value(this.native, "member_timeout", { community_id: this.guild.id, npub: this.id, seconds: ms / 1000 });
      this.communicationDisabledTimestamp = Date.now() + ms;
    }
    return this;
  }
  disableCommunicationUntil(until: Date | number | null, reason?: string) {
    if (until === null) return this.timeout(null, reason);
    const t = until instanceof Date ? until.getTime() : until;
    return this.timeout(t - Date.now(), reason);
  }
  async setNickname(nick: string | null, _reason?: string): Promise<this> {
    await value(this.native, "member_set_nickname", { community_id: this.guild.id, npub: this.id, nickname: nick ?? "" });
    this.nickname = nick || null;
    return this;
  }
  edit(data: { nick?: string | null; roles?: RoleResolvable[]; communicationDisabledUntil?: Date | number | null }) {
    const jobs: Promise<unknown>[] = [];
    if (data.nick !== undefined) jobs.push(this.setNickname(data.nick));
    if (data.roles) jobs.push(this.roles.set(data.roles));
    if (data.communicationDisabledUntil !== undefined) jobs.push(this.disableCommunicationUntil(data.communicationDisabledUntil));
    return Promise.all(jobs).then(() => this);
  }
  /** Vector admin = every management permission. */
  async grantAdmin(): Promise<void> {
    await value(this.native, "member_grant_admin", { community_id: this.guild.id, npub: this.id });
  }
  async revokeAdmin(): Promise<void> {
    await value(this.native, "member_revoke_admin", { community_id: this.guild.id, npub: this.id });
  }
  async fetch(): Promise<this> {
    await this.roles.fetch().catch(() => undefined);
    this.nickname = (await value(this.native, "member_nickname", { community_id: this.guild.id, npub: this.id }).catch(() => null)) || null;
    const until: number | null = await value(this.native, "member_timed_out_until", { community_id: this.guild.id, npub: this.id }).catch(() => null);
    this.communicationDisabledTimestamp = until ? (until < 1e12 ? until * 1000 : until) : null;
    await this.user.fetch(false).catch(() => undefined);
    return this;
  }
  send(options: string | MessageCreateOptions | MessagePayload) {
    return this.user.send(options);
  }
  createDM() {
    return this.user.createDM();
  }
}
