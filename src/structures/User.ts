import { Base } from "./Base";
import type { Client } from "../client/Client";
import { value } from "../native";
import type { DMChannel } from "./Channel";
import type { MessageCreateOptions, MessagePayload } from "../sending";

/** A Vector profile (Nostr kind 0 plus Vector extras). */
export interface Profile {
  name?: string;
  display_name?: string;
  nickname?: string;
  avatar?: string;
  banner?: string;
  about?: string;
  website?: string;
  nip05?: string;
  lud16?: string;
  bot?: boolean;
  status?: { title?: string; url?: string };
  [k: string]: unknown;
}

const short = (npub: string) => (npub.length > 16 ? `${npub.slice(0, 12)}…` : npub);

/** A Vector user. `id` is their npub (discord.js ids are strings too, so `user.id` keeps working). */
export class User extends Base {
  /** The npub (`npub1…`). */
  readonly id: string;
  profile: Profile = {};
  system = false;

  constructor(client: Client, id: string, profile?: Profile) {
    super(client);
    this.id = id;
    if (profile) this.profile = profile;
  }

  /** @internal */
  _patch(profile: Profile | null | undefined): this {
    if (profile) this.profile = { ...this.profile, ...profile };
    return this;
  }

  get npub(): string {
    return this.id;
  }
  get username(): string {
    return this.profile.name || this.profile.display_name || short(this.id);
  }
  get globalName(): string | null {
    return this.profile.display_name || null;
  }
  get displayName(): string {
    return this.profile.nickname || this.profile.display_name || this.username;
  }
  /** discord.js's `tag` (no discriminators on Vector). */
  get tag(): string {
    return this.username;
  }
  get discriminator(): string {
    return "0";
  }
  get bot(): boolean {
    return Boolean(this.profile.bot);
  }
  get avatar(): string | null {
    return this.profile.avatar || null;
  }
  get banner(): string | null {
    return this.profile.banner || null;
  }
  get about(): string {
    return this.profile.about || "";
  }
  get createdAt(): Date | null {
    return null;
  }
  avatarURL(): string | null {
    return this.avatar;
  }
  displayAvatarURL(): string {
    return this.avatar ?? "";
  }
  bannerURL(): string | null {
    return this.banner;
  }
  /** A NIP-27 mention Vector renders as the user's name. */
  override toString(): string {
    return `nostr:${this.id}`;
  }
  equals(other: User): boolean {
    return other?.id === this.id;
  }

  get dmChannel(): DMChannel {
    return this.client._state.dmChannel(this.id);
  }
  async createDM(): Promise<DMChannel> {
    return this.dmChannel;
  }
  async send(options: string | MessageCreateOptions | MessagePayload) {
    return this.dmChannel.send(options);
  }
  /** Refresh the profile from relays. */
  async fetch(force = true): Promise<this> {
    const p = await value(this.native, force ? "fetch_profile" : "cached_profile", { npub: this.id });
    return this._patch(p);
  }
  async block(): Promise<void> {
    await value(this.native, "block", { npub: this.id });
  }
  async unblock(): Promise<void> {
    await value(this.native, "unblock", { npub: this.id });
  }
}

export interface ClientUserEditOptions {
  username?: string;
  avatar?: string | Buffer | null;
  banner?: string | Buffer | null;
  about?: string;
}

/** The bot's own user. */
export class ClientUser extends User {
  /** Update the bot's profile. `avatar`/`banner` take a URL, a file path or image bytes. */
  async edit(options: ClientUserEditOptions): Promise<this> {
    const p = this.profile;
    const image = async (v: string | Buffer | null | undefined, current: string): Promise<string> => {
      if (v === undefined) return current;
      if (v === null) return "";
      if (Buffer.isBuffer(v)) {
        const fs = await import("node:fs/promises");
        const os = await import("node:os");
        const path = await import("node:path");
        const file = path.join(await fs.mkdtemp(path.join(os.tmpdir(), "vector-")), "image.png");
        await fs.writeFile(file, v);
        return value(this.native, "upload_image", { path: file });
      }
      if (/^https?:\/\//.test(v)) return v;
      return value(this.native, "upload_image", { path: v });
    };
    const avatar = await image(options.avatar, p.avatar ?? "");
    const banner = await image(options.banner, p.banner ?? "");
    const name = options.username ?? p.name ?? "";
    const about = options.about ?? p.about ?? "";
    await value(this.native, "update_profile", { name, avatar, banner, about });
    this._patch({ name, avatar, banner, about });
    return this;
  }
  setUsername(username: string) {
    return this.edit({ username });
  }
  setAvatar(avatar: string | Buffer | null) {
    return this.edit({ avatar });
  }
  setBanner(banner: string | Buffer | null) {
    return this.edit({ banner });
  }
  /** Vector has a profile status text; Discord presence types are flattened into it. */
  async setActivity(name?: string | { name?: string }, _options?: unknown): Promise<this> {
    const text = typeof name === "string" ? name : name?.name ?? "";
    await value(this.native, "set_status", { status: text });
    return this;
  }
  async setPresence(data: { activities?: { name?: string }[]; status?: string }): Promise<this> {
    return this.setActivity(data.activities?.[0]?.name ?? "");
  }
  /** Online/idle/dnd don't exist on Vector; accepted and ignored. */
  async setStatus(_status: string): Promise<this> {
    return this;
  }
  setAFK(): this {
    return this;
  }
}
