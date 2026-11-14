/** Caches, structure factories, and raw-event → discord.js-event translation. */
import type { Client } from "./Client";
import { User, ClientUser } from "../structures/User";
import { Guild } from "../structures/Guild";
import { DMChannel, PartialGroupChannel, TextChannel, channelFromInfo, type BaseChannel, type ChannelKind, type TextBasedChannel } from "../structures/Channel";
import { Message, MessageReaction } from "../structures/Message";
import { ActionRow, type RenderedComponents } from "../structures/Components";
import { ButtonInteraction, ChatInputCommandInteraction, StringSelectMenuInteraction, type ModalSubmitInteraction } from "../structures/Interaction";
import { ApplicationCommandOptionType } from "../util/Constants";
import { value } from "../native";

class LRU<K, V> extends Map<K, V> {
  constructor(private readonly max: number) {
    super();
  }
  override set(k: K, v: V): this {
    if (this.max <= 0) return this;
    super.delete(k);
    super.set(k, v);
    while (this.size > this.max) super.delete(this.keys().next().value as K);
    return this;
  }
}

interface ComponentBinding {
  rendered: RenderedComponents;
  /** per-user select choices: customId -> user -> values */
  selected: Map<string, Map<string, string[]>>;
}

export interface CommandRoute {
  command: string;
  sub: string | null;
  group: string | null;
  types: Map<string, ApplicationCommandOptionType>;
}

export class State {
  readonly users = new Map<string, User>();
  readonly dms = new Map<string, DMChannel>();
  readonly messages: LRU<string, Message>;
  readonly components = new LRU<string, ComponentBinding>(5000);
  readonly commandRoutes = new Map<string, CommandRoute>();
  private readonly lastIncoming = new Map<string, number>();
  private readonly modalWaiters = new Set<{ test: (i: ModalSubmitInteraction) => boolean; resolve: (i: ModalSubmitInteraction) => void }>();
  private readonly profileFetches = new Map<string, Promise<void>>();
  readyOnce = false;

  constructor(private readonly client: Client, maxMessages = 1000) {
    this.messages = new LRU(maxMessages);
  }

  private bot() {
    return this.client._native();
  }

  // -- users ------------------------------------------------------------------------------------------------
  user(npub: string): User {
    let u = this.users.get(npub);
    if (!u) {
      u = npub === this.client.user?.id ? this.client.user : new User(this.client, npub);
      this.users.set(npub, u);
    }
    return u;
  }
  setClientUser(npub: string): ClientUser {
    const u = new ClientUser(this.client, npub);
    this.users.set(npub, u);
    return u;
  }
  /** Load a profile from the local cache quickly; refresh from relays in the background. */
  async ensureProfile(npub: string): Promise<User> {
    const u = this.user(npub);
    if (Object.keys(u.profile).length) return u;
    const cached = await value(this.bot(), "cached_profile", { npub }).catch(() => null);
    if (cached) return u._patch(cached);
    if (!this.profileFetches.has(npub)) {
      this.profileFetches.set(npub, value(this.bot(), "fetch_profile", { npub }).then((p) => void u._patch(p)).catch(() => undefined));
    }
    return u;
  }

  // -- guilds & channels --------------------------------------------------------------------------------------
  guild(id: string): Guild {
    let g = this.client.guilds.cache.get(id);
    if (!g) {
      g = new Guild(this.client, id);
      this.client.guilds.cache.set(id, g);
    }
    return g;
  }
  async addGuild(id: string, joined = false): Promise<Guild> {
    const isNew = !this.client.guilds.cache.has(id);
    const g = this.guild(id);
    await g._refresh();
    if (joined && isNew) this.client.emit("guildCreate", g);
    return g;
  }
  dmChannel(npub: string): DMChannel {
    let ch = this.dms.get(npub);
    if (!ch) {
      ch = new DMChannel(this.client, npub);
      this.dms.set(npub, ch);
    }
    return ch;
  }
  getChannel(id: string): BaseChannel | undefined {
    if (id.startsWith("npub1")) return this.dmChannel(id);
    for (const g of this.client.guilds.cache.values()) {
      const ch = g.channels.cache.get(id);
      if (ch) return ch;
    }
    return undefined;
  }
  async channelFor(chatId: string, kind?: ChannelKind | null, communityId?: string | null): Promise<TextBasedChannel> {
    if (kind === "dm" || chatId.startsWith("npub1")) return this.dmChannel(chatId);
    if (!communityId) {
      const known = this.getChannel(chatId);
      if (known && "send" in known) return known as unknown as TextBasedChannel;
      communityId = await value(this.bot(), "channel_community", { id: chatId, kind: kind ?? undefined }).catch(() => null);
    }
    if (communityId) {
      const g = this.guild(communityId);
      let ch = g.channels.cache.get(chatId);
      if (!ch) {
        ch = channelFromInfo(this.client, g, { channel_id: chatId, name: "" });
        g.channels.cache.set(chatId, ch);
        void g._refreshChannels().catch(() => undefined);
      }
      return ch as unknown as TextBasedChannel;
    }
    return new PartialGroupChannel(this.client, chatId) as TextBasedChannel;
  }

  // -- messages ------------------------------------------------------------------------------------------------
  private cache(m: Message): Message {
    this.messages.set(m.id, m);
    m.channel.messages.cache.set(m.id, m);
    m.channel.lastMessageId = m.id;
    const binding = this.components.get(m.id);
    if (binding) m.components = binding.rendered.rows.map((r) => new ActionRow(r));
    return m;
  }
  async messageFromIncoming(data: any): Promise<Message> {
    const channel = await this.channelFor(data.chat_id ?? "", data.is_group ? "community" : "dm", data.community_id);
    const prev = this.messages.get(data.message?.id);
    if (prev) return this.cache(prev._patch(data.message ?? {}));
    return this.cache(new Message(this.client, channel, data.message ?? {}, data.author ?? null));
  }
  messageFromRaw(raw: any, channel: TextBasedChannel): Message {
    let author: string | null = raw.npub ?? null;
    if (!author && channel instanceof DMChannel && !raw.mine) author = channel.id;
    const prev = this.messages.get(raw.id);
    if (prev) return this.cache(prev._patch(raw));
    return this.cache(new Message(this.client, channel, raw, author));
  }
  async sentMessage(id: string, channelId: string, kind: ChannelKind | null, text: string, replyTo?: string): Promise<Message> {
    const data = await value(this.bot(), "message", { message_id: id }).catch(() => null);
    if (data) return this.messageFromIncoming(data);
    const channel = await this.channelFor(channelId, kind);
    const raw = { id, content: text, replied_to: replyTo ?? "", attachments: [], reactions: [], at: Date.now(), mine: true, npub: this.client.user?.id, pending: false, failed: false };
    return this.cache(new Message(this.client, channel, raw, this.client.user?.id ?? null));
  }

  // -- reply ordering ----------------------------------------------------------------------------------------
  noteIncoming(chatId: string, atMs: number): void {
    if (atMs > (this.lastIncoming.get(chatId) ?? 0)) this.lastIncoming.set(chatId, atMs);
  }
  /**
   * Vector sorts messages by whole-second timestamps: a reply sent within the same second as the message it answers
   * (or when the sender's clock is a little ahead) shows *above* it. Wait until our clock passes that second.
   */
  async orderAfterIncoming(chatId: string): Promise<void> {
    if (!this.client.options.replyOrdering) return;
    const at = this.lastIncoming.get(chatId);
    if (at === undefined) return;
    const wait = (Math.floor(at / 1000) + 1) * 1000 - Date.now();
    if (wait > 0 && wait <= 2500) await new Promise((r) => setTimeout(r, wait + 50));
  }

  // -- components ----------------------------------------------------------------------------------------------
  async attachComponents(message: Message, rendered: RenderedComponents): Promise<void> {
    this.components.set(message.id, { rendered, selected: new Map() });
    message.components = rendered.rows.map((r) => new ActionRow(r));
    for (const e of rendered.emojis) await message.react(e).catch((err) => this.client.emit("warn", `couldn't add ${e}: ${err}`));
  }
  private componentTap(message: Message, emoji: string, userId: string, added: boolean): void {
    const binding = this.components.get(message.id);
    const target = binding?.rendered.targets.get(emoji);
    if (!binding || !target || userId === this.client.user?.id) return;
    const user = this.user(userId);
    if (target.kind === "button") {
      if (!added) return; // un-tapping a button does nothing
      this.client.emit("interactionCreate", new ButtonInteraction(this.client, message, user, target.customId, target.componentType));
      return;
    }
    const byUser = binding.selected.get(target.customId) ?? new Map<string, string[]>();
    binding.selected.set(target.customId, byUser);
    let chosen = byUser.get(userId) ?? [];
    if ((target.maxValues ?? 1) <= 1) chosen = added ? [target.value!] : [];
    else if (added && !chosen.includes(target.value!) && chosen.length < target.maxValues!) chosen = [...chosen, target.value!];
    else if (!added) chosen = chosen.filter((v) => v !== target.value);
    else return;
    byUser.set(userId, chosen);
    if (!added && (target.maxValues ?? 1) <= 1) return;
    this.client.emit("interactionCreate", new StringSelectMenuInteraction(this.client, message, user, target.customId, target.componentType, chosen));
  }

  // -- modals --------------------------------------------------------------------------------------------------
  emitModal(i: ModalSubmitInteraction): void {
    for (const w of [...this.modalWaiters]) if (w.test(i)) (this.modalWaiters.delete(w), w.resolve(i));
  }
  awaitModal(test: (i: ModalSubmitInteraction) => boolean, ms: number): Promise<ModalSubmitInteraction> {
    return new Promise((resolve, reject) => {
      const w = { test, resolve: (i: ModalSubmitInteraction) => (clearTimeout(t), resolve(i)) };
      const t = setTimeout(() => (this.modalWaiters.delete(w), reject(new Error("Collector received no interactions before ending with reason: time"))), ms);
      this.modalWaiters.add(w);
    });
  }

  // -- events --------------------------------------------------------------------------------------------------
  async handle(ev: any): Promise<void> {
    const c = this.client;
    c.emit("raw", ev);
    try {
      switch (ev.type) {
        case "ready":
          return await this.onReady(ev);
        case "message":
          return await this.onMessage(ev);
        case "command":
          return await this.onCommand(ev);
        case "reaction_add":
          return await this.onReaction(ev, true);
        case "reaction_remove":
          return await this.onReaction(ev, false);
        case "message_edit":
          return await this.onEdit(ev);
        case "message_delete":
          return await this.onDelete(ev);
        case "member_join":
          return await this.onMember(ev, true);
        case "member_remove":
          return await this.onMember(ev, false);
        case "typing": {
          const ch = await this.channelFor(ev.chat_id);
          c.emit("typingStart", { channel: ch, user: this.user(ev.npub), startedTimestamp: Date.now(), get startedAt() { return new Date(); } });
          return;
        }
        case "community_change": {
          const g = this.guild(ev.community_id);
          await g._refresh().catch(() => undefined);
          c.emit("communityChange", g, ev.change);
          c.emit("guildUpdate", g, g);
          return;
        }
        case "community_dissolve":
        case "community_remove": {
          const g = this.client.guilds.cache.get(ev.community_id);
          if (g) {
            this.client.guilds.cache.delete(g.id);
            c.emit("guildDelete", g);
          }
          return;
        }
        case "community_invite":
          if (c.options.invitePolicy === "public") return;
          c.emit("guildInvite", {
            communityId: ev.community_id,
            accept: async () => {
              await value(this.bot(), "accept_invite", { community_id: ev.community_id });
              return this.addGuild(ev.community_id, true);
            },
          });
          return;
        case "channel_keyed": {
          const g = this.guild(ev.community_id);
          await g._refreshChannels().catch(() => undefined);
          c.emit("channelKeyed", g.channels.cache.get(ev.channel_id) ?? null, ev);
          return;
        }
        case "xdc_session":
          c.emit("miniAppSession", c._miniAppSession(ev));
          return;
        case "xdc_presence":
          c.emit("miniAppPresence", ev);
          return;
        case "voice_presence":
          c.emit("voiceStateUpdate", null, { channelId: ev.channel_id });
          return;
        case "disconnect":
          c.emit("shardDisconnect", { code: 1000, reason: ev.error ?? "" }, 0);
          if (ev.error) c.emit("error", new Error(ev.error));
          return;
        default:
          c.emit("debug", `unhandled event ${ev.type}`);
      }
    } catch (e) {
      c.emit("error", e as Error);
    }
  }

  private async onReady(ev: any): Promise<void> {
    const ids = new Set<string>(Array.isArray(ev.communities) ? ev.communities.map((x: any) => (typeof x === "string" ? x : x.community_id ?? x.id)) : []);
    for (const id of await value<string[]>(this.bot(), "communities").catch(() => [])) ids.add(id);
    await Promise.allSettled([...ids].filter(Boolean).map((id) => this.addGuild(id)));
    if (this.client.user) await this.ensureProfile(this.client.user.id).catch(() => undefined);
    if (!this.readyOnce) {
      this.readyOnce = true;
      this.client.readyTimestamp = Date.now();
      this.client.emit("ready", this.client);
      this.client.emit("clientReady", this.client);
    } else {
      this.client.emit("shardResume", 0, 0);
    }
  }

  private async onMessage(ev: any): Promise<void> {
    const data = ev.message;
    if (data.author) await Promise.race([this.ensureProfile(data.author), new Promise((r) => setTimeout(r, 2000))]);
    const msg = await this.messageFromIncoming(data);
    if (!msg.mine) this.noteIncoming(msg.channel.id, msg.createdTimestamp);
    this.client.emit("messageCreate", msg);
  }

  private async onCommand(ev: any): Promise<void> {
    const data = ev.message;
    if (data.author) await Promise.race([this.ensureProfile(data.author), new Promise((r) => setTimeout(r, 2000))]);
    const msg = await this.messageFromIncoming(data);
    this.noteIncoming(msg.channel.id, msg.createdTimestamp);
    const route = this.commandRoutes.get(ev.name) ?? { command: ev.name, sub: null, group: null, types: new Map() };
    const i = new ChatInputCommandInteraction(this.client, msg, msg.author, route.command, ev.args ?? {}, route.types, route.sub, route.group);
    this.client.emit("interactionCreate", i);
  }

  private async onReaction(ev: any, added: boolean): Promise<void> {
    const channel = await this.channelFor(ev.chat_id ?? "");
    const raw = ev.message ?? {};
    const cached = this.messages.get(raw.id);
    let emoji = "";
    let emojiUrl: string | null = null;
    let userId = "";
    if (added) {
      const r = ev.reaction ?? {};
      emoji = r.emoji ?? "";
      emojiUrl = r.emoji_url ?? null;
      userId = r.author_id ?? "";
    } else {
      userId = ev.by ?? "";
      for (const rx of cached?.reactions.cache.values() ?? []) if (rx._ids.has(ev.reaction_id)) (emoji = rx.emojiName, emojiUrl = rx.emojiURL);
    }
    const msg = raw.id ? this.messageFromRaw(raw, channel) : cached;
    if (!msg) return;
    if (userId) await this.ensureProfile(userId).catch(() => undefined);
    const reaction = msg.reactions.cache.get(emoji) ?? new MessageReaction(msg, emoji, emojiUrl);
    const user = this.user(userId);
    this.client.emit(added ? "messageReactionAdd" : "messageReactionRemove", reaction, user, { type: 0, burst: false });
    if (emoji) this.componentTap(msg, emoji, userId, added);
  }

  private async onEdit(ev: any): Promise<void> {
    const channel = await this.channelFor(ev.chat_id ?? "");
    const raw = ev.message ?? {};
    const before = this.messages.get(raw.id);
    const snapshot = before ? Object.assign(Object.create(Object.getPrototypeOf(before)), before, { content: before.content }) : null;
    const after = this.messageFromRaw(raw, channel);
    this.client.emit("messageUpdate", snapshot ?? after, after);
  }

  private async onDelete(ev: any): Promise<void> {
    const cached = this.messages.get(ev.message_id);
    this.messages.delete(ev.message_id);
    this.components.delete(ev.message_id);
    const channel = await this.channelFor(ev.chat_id ?? "");
    channel.messages.cache.delete(ev.message_id);
    this.client.emit("messageDelete", cached ?? ({ id: ev.message_id, channel, partial: true, deletedBy: ev.by, moderated: ev.moderated } as any));
  }

  private async onMember(ev: any, joined: boolean): Promise<void> {
    const g = this.guild(ev.community_id);
    await this.ensureProfile(ev.npub).catch(() => undefined);
    const m = g.members._get(ev.npub);
    if (joined) {
      m.joinedTimestamp = Date.now();
      (m as any).invitedBy = ev.invited_by ?? null;
      (m as any).inviteLabel = ev.invite_label ?? null;
      this.client.emit("guildMemberAdd", m);
    } else {
      g.members.cache.delete(ev.npub);
      this.client.emit("guildMemberRemove", m);
    }
  }
}

export { TextChannel };
