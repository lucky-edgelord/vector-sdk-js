import { Base } from "./Base";
import type { Client } from "../client/Client";
import type { Guild } from "./Guild";
import { PermissionsBitField, type PermissionResolvable } from "../util/PermissionsBitField";
import { Collection } from "../util/Collection";
import type { GuildMember } from "./GuildMember";
import { value } from "../native";

export interface RoleEditOptions {
  name?: string;
  color?: number | string;
  permissions?: PermissionResolvable;
  hoist?: boolean;
  mentionable?: boolean;
  position?: number;
  reason?: string;
}

export function resolveColor(c: number | string | undefined): number | undefined {
  if (c === undefined) return undefined;
  if (typeof c === "number") return c;
  if (c.startsWith("#")) return parseInt(c.slice(1), 16);
  return Number(c) || 0;
}

export class Role extends Base {
  readonly id: string;
  name = "";
  color = 0;
  position = 0;
  hoist = false;
  mentionable = false;
  managed = false;
  permissions = new PermissionsBitField(0n);
  /** Vector-only: the channel a role is scoped to, if any. */
  channelId: string | null = null;
  raw: any = {};

  constructor(client: Client, public readonly guild: Guild, data: any) {
    super(client);
    this.id = data.role_id ?? data.id ?? "";
    this._patch(data);
  }

  /** @internal */
  _patch(data: any): this {
    this.raw = data;
    this.name = data.name ?? this.name;
    this.color = Number(data.color ?? 0);
    this.position = Number(data.position ?? 0);
    this.hoist = Boolean(data.display);
    this.mentionable = Boolean(data.mentionable);
    this.permissions = new PermissionsBitField(BigInt(data.permissions ?? 0));
    this.channelId = data.scope?.channel_id ?? null;
    return this;
  }

  get hexColor(): string {
    return `#${this.color.toString(16).padStart(6, "0")}`;
  }
  get members(): Collection<string, GuildMember> {
    const out = new Collection<string, GuildMember>();
    for (const m of this.guild.members.cache.values()) if (m.roles.cache.has(this.id)) out.set(m.id, m);
    return out;
  }
  /** `@everyone` is the guild's default role (its id is the guild id). */
  isEveryone(): boolean {
    return this.id === this.guild.id;
  }
  override toString(): string {
    return this.isEveryone() ? "@everyone" : `@${this.name}`;
  }

  async edit(options: RoleEditOptions): Promise<this> {
    await value(this.native, "role_edit", {
      community_id: this.guild.id, role_id: this.id, name: options.name, color: resolveColor(options.color),
      permissions: options.permissions !== undefined ? Number(PermissionsBitField.resolve(options.permissions)) : undefined,
      shown: options.hoist, mentionable: options.mentionable,
    });
    await this.guild._refreshRoles();
    return this;
  }
  setName(name: string) {
    return this.edit({ name });
  }
  setColor(color: number | string) {
    return this.edit({ color });
  }
  setPermissions(permissions: PermissionResolvable) {
    return this.edit({ permissions });
  }
  setHoist(hoist = true) {
    return this.edit({ hoist });
  }
  setMentionable(mentionable = true) {
    return this.edit({ mentionable });
  }
  async delete(): Promise<this> {
    await value(this.native, "role_delete", { community_id: this.guild.id, role_id: this.id });
    this.guild.roles.cache.delete(this.id);
    return this;
  }
  /** Role holders (npubs), straight from the roster. */
  async fetchHolders(): Promise<string[]> {
    return value(this.native, "role_holders", { community_id: this.guild.id, role_id: this.id });
  }
}
