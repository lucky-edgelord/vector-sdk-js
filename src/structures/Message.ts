import { Base } from "./Base";
import type { Client } from "../client/Client";
import type { TextBasedChannel } from "./Channel";
import type { Guild } from "./Guild";
import type { GuildMember } from "./GuildMember";
import type { User } from "./User";
import type { Role } from "./Role";
import { Collection } from "../util/Collection";
import { call, value } from "../native";
import { normalizeEmoji, type EmojiResolvable } from "./Emoji";
import { send, editMessage, type MessageCreateOptions, type MessageEditOptions, type MessagePayload } from "../sending";
import { ReactionCollector, InteractionCollector, type ReactionCollectorOptions, type AwaitReactionsOptions, type InteractionCollectorOptions } from "../util/Collectors";
import type { ActionRow } from "./Components";

const EXT_MIME: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", svg: "image/svg+xml",
  mp4: "video/mp4", webm: "video/webm", mov: "video/quicktime", mp3: "audio/mpeg", ogg: "audio/ogg", wav: "audio/wav",
  m4a: "audio/mp4", flac: "audio/flac", pdf: "application/pdf", txt: "text/plain", json: "application/json",
  zip: "application/zip", xdc: "application/webxdc+zip",
};

/** A file on a message. `await attachment.download()` fetches and decrypts it. */
export class Attachment {
  readonly id: string;
  readonly name: string;
  readonly size: number;
  readonly url: string;
  readonly extension: string;
  readonly width: number | null;
  readonly height: number | null;
  readonly blurhash: string | null;
  /** Vector Mini App topic, for `.xdc` files. */
  readonly miniAppTopic: string | null;
  constructor(private readonly client: Client, public readonly raw: any, private readonly authorId: string | null) {
    Object.defineProperty(this, "client", { enumerable: false });
    this.id = raw.id ?? "";
    this.extension = raw.extension ?? "";
    this.name = raw.name || (this.extension ? `${this.id.slice(0, 12)}.${this.extension}` : this.id.slice(0, 12));
    this.size = Number(raw.size ?? 0);
    this.url = raw.url ?? "";
    this.width = raw.img_meta?.width ?? null;
    this.height = raw.img_meta?.height ?? null;
    this.blurhash = raw.img_meta?.blurhash ?? null;
    this.miniAppTopic = raw.webxdc_topic ?? null;
  }
  get proxyURL(): string {
    return this.url;
  }
  get contentType(): string | null {
    return EXT_MIME[this.extension.toLowerCase()] ?? null;
  }
  get spoiler(): boolean {
    return this.name.startsWith("SPOILER_");
  }
  /** Download and decrypt the file. */
  async download(): Promise<Buffer> {
    const r = await call(this.client._native(), "download_attachment", { attachment: this.raw, author_npub: this.authorId ?? undefined });
    return r.bytes ?? Buffer.alloc(0);
  }
  /** Alias of {@link download} (discord.py-style name). */
  read() {
    return this.download();
  }
}

export class MessageReaction {
  count = 0;
  me = false;
  /** @internal reaction event id -> user npub */
  _ids = new Map<string, string>();
  /** @internal */
  _users: string[] = [];
  constructor(public readonly message: Message, public readonly emojiName: string, public readonly emojiURL: string | null = null) {}
  /** discord.js shape: `reaction.emoji.name` (`.id` is null for unicode, the URL for custom emoji). */
  get emoji(): { name: string; id: string | null; url: string | null; toString(): string } {
    const name = this.emojiName.replace(/^:|:$/g, "");
    return { name: this.emojiURL ? name : this.emojiName, id: this.emojiURL, url: this.emojiURL, toString: () => this.emojiName };
  }
  get client() {
    return this.message.client;
  }
  get users() {
    const r = this;
    return {
      get cache(): Collection<string, User> {
        const c = new Collection<string, User>();
        for (const id of r._users) c.set(id, r.client._state.user(id));
        return c;
      },
      fetch: async () => this.users.cache,
      remove: async (user?: string | User) => {
        const id = typeof user === "string" ? user : user?.id ?? r.client.user!.id;
        if (id !== r.client.user!.id) throw new Error("bots can only remove their own reactions on Vector");
        await r.remove();
      },
    };
  }
  /** Remove the bot's own reaction. */
  async remove(): Promise<this> {
    const [id, kind] = this.message.channel._target();
    await value(this.client._native(), "channel_unreact", { id, kind, message_id: this.message.id, emoji: this.emojiName });
    this.me = false;
    return this;
  }
  async fetch(): Promise<this> {
    return this;
  }
  toString(): string {
    return this.emojiName;
  }
}

export class MessageMentions {
  readonly users = new Collection<string, User>();
  readonly members = new Collection<string, GuildMember>();
  readonly roles = new Collection<string, Role>();
  everyone = false;
  repliedUser: User | null = null;
  constructor(message: Message) {
    const st = message.client._state;
    for (const m of message.content.matchAll(/(?:nostr:)?(npub1[02-9ac-hj-np-z]{58})/g)) {
      const u = st.user(m[1]);
      this.users.set(u.id, u);
      if (message.guild) this.members.set(u.id, message.guild.members._get(u.id));
    }
    for (const id of message.raw.role_mentions ?? []) {
      const r = message.guild?.roles.cache.get(id);
      if (r) this.roles.set(id, r);
    }
    this.everyone = /@everyone|@here/.test(message.content);
    const replied = message.raw.replied_to_npub;
    if (replied) this.repliedUser = st.user(replied);
  }
  has(data: User | GuildMember | Role | string): boolean {
    const id = typeof data === "string" ? data : data.id;
    return this.users.has(id) || this.roles.has(id);
  }
}

export interface MessageReference {
  messageId: string;
  channelId: string;
  guildId: string | null;
}

/** A message. Mirrors discord.js's `Message`. */
export class Message extends Base {
  readonly id: string;
  readonly channel: TextBasedChannel;
  raw: any;
  content = "";
  createdTimestamp = 0;
  editedTimestamp: number | null = null;
  /** Vector: when a disappearing message expires. */
  expiresTimestamp: number | null = null;
  readonly attachments = new Collection<string, Attachment>();
  /** Rendered embeds can't be read back from Vector markdown, so received messages have none. */
  embeds: any[] = [];
  components: ActionRow[] = [];
  stickers = new Collection<string, never>();
  reactions!: { cache: Collection<string, MessageReaction>; resolve(e: string): MessageReaction | undefined; removeAll(): Promise<void> };
  pinned = false;
  tts = false;
  webhookId: string | null = null;
  applicationId: string | null = null;
  flags = 0;
  type = 0;
  /** Vector: the message is still sending / failed to send (for our own messages). */
  pending = false;
  failed = false;
  readonly authorId: string | null;
  reference: MessageReference | null = null;
  private _mentions: MessageMentions | null = null;

  constructor(client: Client, channel: TextBasedChannel, raw: any, authorId: string | null) {
    super(client);
    this.channel = channel;
    this.id = raw.id ?? "";
    this.authorId = authorId ?? (raw.mine ? client.user?.id ?? null : null);
    this.raw = raw;
    this._patch(raw);
  }

  /** @internal */
  _patch(raw: any): this {
    this.raw = raw;
    this.content = raw.content ?? "";
    this.createdTimestamp = Number(raw.at ?? 0);
    const hist = raw.edit_history ?? [];
    this.editedTimestamp = raw.edited && hist.length ? Number(hist[hist.length - 1].edited_at ?? hist[hist.length - 1].at ?? 0) || null : null;
    this.expiresTimestamp = raw.expiration ? Number(raw.expiration) * 1000 : null;
    this.pending = Boolean(raw.pending);
    this.failed = Boolean(raw.failed);
    this.attachments.clear();
    for (const a of raw.attachments ?? []) {
      const att = new Attachment(this.client, a, this.authorId);
      this.attachments.set(att.id, att);
    }
    this.reference = raw.replied_to ? { messageId: raw.replied_to, channelId: this.channel.id, guildId: this.guildId } : null;
    this.type = this.reference ? 19 : 0;
    const agg = new Collection<string, MessageReaction>();
    for (const r of raw.reactions ?? []) {
      const key = r.emoji ?? "";
      let rx = agg.get(key);
      if (!rx) agg.set(key, (rx = new MessageReaction(this, key, r.emoji_url ?? null)));
      rx.count++;
      rx._users.push(r.author_id ?? "");
      rx._ids.set(r.id ?? "", r.author_id ?? "");
      if (r.author_id === this.client.user?.id) rx.me = true;
    }
    const msg = this;
    this.reactions = {
      cache: agg,
      resolve: (e: string) => agg.get(normalizeEmoji(e) ?? e),
      removeAll: async () => {
        for (const r of agg.values()) if (r.me) await r.remove();
      },
    };
    void msg;
    this._mentions = null;
    return this;
  }

  get author(): User {
    return this.client._state.user(this.authorId ?? "");
  }
  get member(): GuildMember | null {
    return this.guild && this.authorId ? this.guild.members._get(this.authorId) : null;
  }
  get guild(): Guild | null {
    return (this.channel as any).guild ?? null;
  }
  get guildId(): string | null {
    return this.guild?.id ?? null;
  }
  get channelId(): string {
    return this.channel.id;
  }
  get createdAt(): Date {
    return new Date(this.createdTimestamp);
  }
  get editedAt(): Date | null {
    return this.editedTimestamp ? new Date(this.editedTimestamp) : null;
  }
  get mentions(): MessageMentions {
    return (this._mentions ??= new MessageMentions(this));
  }
  get cleanContent(): string {
    return this.content.replace(/nostr:(npub1\w+)/g, (_, n) => `@${this.client._state.user(n).displayName}`);
  }
  get url(): string {
    return `vector://message/${this.channel.id}/${this.id}`;
  }
  get editable(): boolean {
    return this.authorId === this.client.user?.id;
  }
  get deletable(): boolean {
    return true;
  }
  get pinnable(): boolean {
    return Boolean(this.guild);
  }
  get system(): boolean {
    return false;
  }
  /** Is this our own message? */
  get mine(): boolean {
    return Boolean(this.raw.mine) || this.authorId === this.client.user?.id;
  }
  inGuild(): boolean {
    return this.guild !== null;
  }
  override toString(): string {
    return this.content;
  }

  /** Reply to this message (shows as a reply in Vector). */
  reply(options: string | MessageCreateOptions | MessagePayload): Promise<Message> {
    const o: MessageCreateOptions = typeof options === "string" ? { content: options } : { ...(options as MessageCreateOptions) };
    o.reply = { messageReference: this.id };
    const [id, kind] = this.channel._target();
    return send(this.client, id, kind, o);
  }
  async edit(options: string | MessageEditOptions): Promise<Message> {
    return editMessage(this, options);
  }
  /** Delete (moderators can delete others' messages in communities). */
  async delete(): Promise<this> {
    const [id, kind] = this.channel._target();
    await value(this.native, "channel_delete_message", { id, kind, message_id: this.id });
    this.client._state.messages.delete(this.id);
    this.channel.messages.cache.delete(this.id);
    return this;
  }
  /** Vector: hide a message from this device only. */
  async hide(): Promise<void> {
    const [id, kind] = this.channel._target();
    await value(this.native, "channel_hide", { id, kind, message_id: this.id });
  }
  async react(emoji: EmojiResolvable): Promise<MessageReaction> {
    const [id, kind] = this.channel._target();
    const resolved = this.client._resolveEmoji(emoji);
    await value(this.native, "channel_react", { id, kind, message_id: this.id, emoji: resolved.code, image_url: resolved.url ?? undefined });
    let rx = this.reactions.cache.get(resolved.code);
    if (!rx) this.reactions.cache.set(resolved.code, (rx = new MessageReaction(this, resolved.code, resolved.url)));
    if (!rx.me) {
      rx.me = true;
      rx.count++;
      rx._users.push(this.client.user!.id);
    }
    return rx;
  }
  async pin(): Promise<this> {
    await value(this.native, "channel_pin", { id: this.channel.id, message_id: this.id });
    this.pinned = true;
    return this;
  }
  async unpin(): Promise<this> {
    await value(this.native, "channel_unpin", { id: this.channel.id, message_id: this.id });
    this.pinned = false;
    return this;
  }
  async fetch(): Promise<Message> {
    return this.channel.messages.fetch(this.id);
  }
  async fetchReference(): Promise<Message> {
    if (!this.reference) throw new Error("this message is not a reply");
    return this.channel.messages.fetch(this.reference.messageId);
  }
  createReactionCollector(options?: ReactionCollectorOptions): ReactionCollector {
    return new ReactionCollector(this, options);
  }
  awaitReactions(options: AwaitReactionsOptions = {}): Promise<Collection<string, MessageReaction>> {
    return new Promise((resolve, reject) => {
      const c = new ReactionCollector(this, options);
      c.once("end", (collected, reason) => (options.errors?.includes(reason) ? reject(collected) : resolve(collected)));
    });
  }
  createMessageComponentCollector(options?: InteractionCollectorOptions): InteractionCollector {
    return new InteractionCollector(this.client, { ...options, message: this });
  }
  awaitMessageComponent(options: InteractionCollectorOptions & { time?: number } = {}): Promise<any> {
    return new Promise((resolve, reject) => {
      const c = new InteractionCollector(this.client, { ...options, message: this, max: 1 });
      c.once("end", (collected, reason) => {
        const first = collected.first();
        if (first) resolve(first);
        else reject(new Error(`Collector received no interactions before ending with reason: ${reason}`));
      });
    });
  }
  /** Threads don't exist on Vector. */
  startThread(): never {
    throw new (require("../errors").NotSupportedOnVector)("Threads", "use a separate channel");
  }
  async crosspost(): Promise<this> {
    return this;
  }
  async suppressEmbeds(): Promise<this> {
    return this;
  }
  /** Re-send this message's content to another channel. */
  async forward(channel: TextBasedChannel): Promise<Message> {
    return channel.send({ content: this.content });
  }
}

/** discord.js's message link helper. */
export function messageLink(channelId: string, messageId: string): string {
  return `vector://message/${channelId}/${messageId}`;
}
