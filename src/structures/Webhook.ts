/**
 * discord.js's `Webhook` and `WebhookClient` for Vector.
 *
 * - **Bot-side** (`channel.createWebhook()`, `channel.fetchWebhooks()`, `guild.fetchWebhooks()`): sends go straight
 *   through the running bot; no HTTP server needed.
 * - **URL-only** (`new WebhookClient({ url })`): sends go over HTTP to a `vector-webhooks` server, exactly like
 *   posting to a Discord webhook URL.
 *
 * URLs look like Discord's: `<base>/api/webhooks/<id>/<token>`.
 */
import type { Client } from "../client/Client";
import { Collection } from "../util/Collection";
import { embedData, type APIEmbed, type EmbedLike } from "./Embed";
import { AttachmentBuilder, type FileInput, type MessageCreateOptions } from "../sending";
import { VectorAPIError, NotFound, NotPermitted } from "../errors";
import type { StoredWebhook } from "../webhooks/store";
import * as fs from "node:fs";
import * as path from "node:path";

const URL_RE = /^(https?:\/\/[^/]+(?:\/.*?)?)\/api(?:\/v\d+)?\/webhooks\/(\d{17,20})\/([\w\-.]+)\/?$/;

export type WebhookMessageCreateOptions = MessageCreateOptions & { username?: string; avatarURL?: string; threadId?: string; threadName?: string; wait?: boolean };

async function http(method: string, url: string, payload?: unknown, files: { name: string; data: Buffer }[] = []): Promise<any> {
  let body: any;
  const headers: Record<string, string> = { "User-Agent": "vector-sdk-js" };
  if (files.length) {
    const form = new FormData();
    form.append("payload_json", JSON.stringify(payload ?? {}));
    files.forEach((f, i) => form.append(`files[${i}]`, new Blob([new Uint8Array(f.data)]), f.name));
    body = form;
  } else if (payload !== undefined) {
    body = JSON.stringify(payload);
    headers["Content-Type"] = "application/json";
  }
  const r = await fetch(url, { method, body, headers });
  const text = await r.text();
  if (r.status >= 300) {
    let msg = text;
    try {
      msg = JSON.parse(text).message ?? text;
    } catch {
      /* not JSON */
    }
    if (r.status === 404) throw new NotFound(msg);
    if (r.status === 401 || r.status === 403) throw new NotPermitted(msg, 0n);
    throw Object.assign(new VectorAPIError(msg, "HTTP"), { status: r.status });
  }
  return text ? JSON.parse(text) : null;
}

async function fileData(f: FileInput): Promise<{ name: string; data: Buffer }> {
  const a = f instanceof AttachmentBuilder ? f : typeof f === "string" || Buffer.isBuffer(f) ? new AttachmentBuilder(f) : "attachment" in f ? new AttachmentBuilder(f.attachment, { name: f.name }) : new AttachmentBuilder((f as any).data ?? Buffer.alloc(0), { name: f.name });
  const src = a.attachment;
  if (typeof src === "string") {
    if (/^https?:/.test(src)) return { name: a.name, data: Buffer.from(await (await fetch(src)).arrayBuffer()) };
    return { name: a.name || path.basename(src), data: fs.readFileSync(src) };
  }
  return { name: a.name, data: Buffer.from(src) };
}

function normalize(input: string | WebhookMessageCreateOptions): WebhookMessageCreateOptions {
  return typeof input === "string" ? { content: input } : input;
}

function apiPayload(o: WebhookMessageCreateOptions) {
  const p: Record<string, unknown> = {};
  if (o.content !== undefined && o.content !== null) p.content = String(o.content);
  if (o.username) p.username = o.username;
  if (o.embeds?.length) p.embeds = o.embeds.map((e: EmbedLike) => embedData(e));
  return p;
}

/** A message a webhook sent. */
export class WebhookMessage {
  readonly id: string;
  readonly content: string;
  readonly channelId: string;
  readonly webhookId: string;
  readonly embeds: APIEmbed[];
  readonly author: { id: string; username: string; bot: true };
  constructor(private readonly webhook: Webhook | WebhookClient, data: any, public readonly message: any = null) {
    this.id = String(data.id ?? "");
    this.content = data.content ?? "";
    this.channelId = data.channel_id ?? webhook.channelId ?? "";
    this.webhookId = webhook.id;
    this.embeds = data.embeds ?? [];
    this.author = { id: webhook.id, username: data.author?.username ?? webhook.name ?? "webhook", bot: true };
  }
  edit(options: string | WebhookMessageCreateOptions) {
    return this.webhook.editMessage(this.id, options);
  }
  delete() {
    return this.webhook.deleteMessage(this.id);
  }
}

abstract class WebhookBase {
  id: string;
  token: string | null;
  name: string | null = null;
  channelId: string | null = null;
  guildId: string | null = null;
  readonly type = 1;
  readonly avatar = null;
  readonly owner = null;
  constructor(id: string, token: string | null, protected readonly base: string) {
    this.id = id;
    this.token = token;
  }
  get url(): string {
    return `${this.base}/api/webhooks/${this.id}/${this.token}`;
  }
  protected api(p = "", wait = false): string {
    return `${this.url}${p}${wait ? "?wait=true" : ""}`;
  }
  isIncoming(): boolean {
    return true;
  }
  isChannelFollower(): boolean {
    return false;
  }
  isApplicationCreated(): boolean {
    return false;
  }
  abstract send(options: string | WebhookMessageCreateOptions): Promise<WebhookMessage>;
  abstract editMessage(id: string, options: string | WebhookMessageCreateOptions): Promise<WebhookMessage>;
  abstract deleteMessage(id: string): Promise<void>;
}

/** discord.js's `Webhook`. */
export class Webhook extends WebhookBase {
  constructor(public readonly client: Client | null, data: { id: string; token?: string | null; name?: string | null; channelId?: string | null; guildId?: string | null }, base?: string) {
    super(data.id, data.token ?? null, (base ?? client?.webhookBaseUrl ?? process.env.WEBHOOKS_BASE_URL ?? "http://localhost:8080").replace(/\/+$/, ""));
    this.name = data.name ?? null;
    this.channelId = data.channelId ?? null;
    this.guildId = data.guildId ?? null;
  }
  /** @internal */
  static fromRow(client: Client, row: StoredWebhook, token: string | null = null): Webhook {
    return new Webhook(client, { id: row.id, token, name: row.name, channelId: row.channelId, guildId: row.communityId });
  }
  /** @internal: `channel.createWebhook()` */
  static async create(channel: { id: string; guild?: { id: string } | null; client: Client }, options: { name: string; avatar?: string | null }): Promise<Webhook> {
    const { webhook, token } = channel.client.webhookStore.create(options.name, channel.id, channel.guild?.id ?? null, channel.client.user?.id ?? null);
    return Webhook.fromRow(channel.client, webhook, token);
  }
  /** @internal: `channel.fetchWebhooks()` (tokens aren't recoverable: they're stored hashed). */
  static async forChannel(channel: { id: string; client: Client }): Promise<Collection<string, Webhook>> {
    const out = new Collection<string, Webhook>();
    for (const r of channel.client.webhookStore.list({ channelId: channel.id })) out.set(r.id, Webhook.fromRow(channel.client, r));
    return out;
  }
  static async forGuild(guild: { id: string; client: Client }): Promise<Collection<string, Webhook>> {
    const out = new Collection<string, Webhook>();
    for (const r of guild.client.webhookStore.list({ communityId: guild.id })) out.set(r.id, Webhook.fromRow(guild.client, r));
    return out;
  }
  /** From a webhook URL; with a client that owns it, sends go through the bot directly. */
  static fromURL(url: string, client: Client | null = null): Webhook {
    const m = URL_RE.exec(url.trim());
    if (!m) throw new TypeError("Invalid webhook URL given.");
    const w = new Webhook(client, { id: m[2], token: m[3] }, m[1]);
    const known = w.local();
    if (known) (w.name = known.name, w.channelId = known.channelId, w.guildId = known.communityId);
    return w;
  }

  private local(): StoredWebhook | null {
    if (!this.client) return null;
    try {
      return this.client.webhookStore.get(this.id);
    } catch {
      return null;
    }
  }
  get channel() {
    return this.client && this.channelId ? this.client.channels.resolve(this.channelId) : null;
  }
  get guild() {
    return this.client && this.guildId ? this.client.guilds.cache.get(this.guildId) ?? null : null;
  }

  async fetch(): Promise<this> {
    const row = this.local();
    if (row) {
      (this.name = row.name, this.channelId = row.channelId, this.guildId = row.communityId);
      return this;
    }
    const d = await http("GET", this.api());
    (this.name = d.name, this.channelId = d.channel_id, this.guildId = d.guild_id);
    return this;
  }

  async send(input: string | WebhookMessageCreateOptions): Promise<WebhookMessage> {
    const o = normalize(input);
    if (this.local()) {
      const channel: any = this.client!.channels.resolve(this.channelId!) ?? (await this.client!.channels.fetch(this.channelId!));
      if (!channel) throw new NotFound("Unknown Channel");
      let text = o.content ?? null;
      if (o.username) text = text ? `**${o.username}**\n${text}` : `**${o.username}**`;
      const msg = await channel.send({ ...o, content: text });
      this.client!.webhookStore.addMessage(msg.id, this.id, this.channelId!);
      return new WebhookMessage(this, { id: msg.id, content: text ?? "", channel_id: this.channelId, embeds: (o.embeds ?? []).map(embedData), author: { username: o.username ?? this.name } }, msg);
    }
    const files = await Promise.all((o.files ?? []).map(fileData));
    const d = await http("POST", this.api("", true), apiPayload(o), files);
    return new WebhookMessage(this, d ?? {});
  }

  private async localMessage(id: string): Promise<any> {
    const chan = this.client!.webhookStore.messageChannel(id, this.id);
    if (!chan) throw new NotFound("Unknown Message");
    const channel: any = this.client!.channels.resolve(chan) ?? (await this.client!.channels.fetch(chan));
    return channel.messages.fetch(id);
  }
  async fetchMessage(id: string): Promise<WebhookMessage> {
    if (this.local()) {
      const m = await this.localMessage(id);
      return new WebhookMessage(this, { id: m.id, content: m.content, channel_id: this.channelId }, m);
    }
    return new WebhookMessage(this, await http("GET", this.api(`/messages/${id}`)));
  }
  async editMessage(id: string, input: string | WebhookMessageCreateOptions): Promise<WebhookMessage> {
    const o = normalize(input);
    if (this.local()) {
      const m = await this.localMessage(id);
      await m.edit({ content: o.content, embeds: o.embeds, components: o.components });
      return new WebhookMessage(this, { id, content: o.content ?? "", channel_id: this.channelId }, m);
    }
    return new WebhookMessage(this, await http("PATCH", this.api(`/messages/${id}`), apiPayload(o)));
  }
  async deleteMessage(id: string): Promise<void> {
    if (this.local()) {
      await (await this.localMessage(id)).delete();
      this.client!.webhookStore.dropMessage(id);
      return;
    }
    await http("DELETE", this.api(`/messages/${id}`));
  }
  async edit(options: { name?: string; avatar?: string | null; channel?: unknown; reason?: string }): Promise<this> {
    if (this.local()) {
      if (options.channel) throw new TypeError("moving a webhook to another channel isn't supported; create a new one");
      if (options.name) {
        this.client!.webhookStore.rename(this.id, options.name);
        this.name = options.name.slice(0, 80);
      }
      return this;
    }
    const d = await http("PATCH", this.api(), options.name ? { name: options.name } : {});
    this.name = d?.name ?? this.name;
    return this;
  }
  async delete(_reason?: string): Promise<void> {
    if (this.local()) {
      this.client!.webhookStore.delete(this.id);
      return;
    }
    await http("DELETE", this.api());
  }
}

/** discord.js's `WebhookClient`: URL-only, talks HTTP to a `vector-webhooks` server. */
export class WebhookClient extends WebhookBase {
  constructor(data: { url: string } | { id: string; token: string }, _options: unknown = {}) {
    let id: string, token: string, base: string;
    if ("url" in data) {
      const m = URL_RE.exec(data.url.trim());
      if (!m) throw new TypeError("Invalid webhook URL given.");
      [base, id, token] = [m[1], m[2], m[3]];
    } else {
      [id, token, base] = [data.id, data.token, (process.env.WEBHOOKS_BASE_URL ?? "http://localhost:8080").replace(/\/+$/, "")];
    }
    super(id, token, base);
  }
  async send(input: string | WebhookMessageCreateOptions): Promise<WebhookMessage> {
    const o = normalize(input);
    const files = await Promise.all((o.files ?? []).map(fileData));
    return new WebhookMessage(this, (await http("POST", this.api("", true), apiPayload(o), files)) ?? {});
  }
  async fetchMessage(id: string): Promise<WebhookMessage> {
    return new WebhookMessage(this, await http("GET", this.api(`/messages/${id}`)));
  }
  async editMessage(id: string, input: string | WebhookMessageCreateOptions): Promise<WebhookMessage> {
    return new WebhookMessage(this, await http("PATCH", this.api(`/messages/${id}`), apiPayload(normalize(input))));
  }
  async deleteMessage(id: string): Promise<void> {
    await http("DELETE", this.api(`/messages/${id}`));
  }
  destroy(): void {
    /* nothing to close */
  }
}
