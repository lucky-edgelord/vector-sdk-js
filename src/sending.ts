/** Sending and editing messages: content, embeds, files and components, with Vector's quirks handled. */
import * as fs from "node:fs";
import * as path from "node:path";
import type { Client } from "./client/Client";
import type { Message } from "./structures/Message";
import type { ChannelKind } from "./structures/Channel";
import { call, value } from "./native";
import { attachmentNames, embedData, imageUrls, renderEmbed, type EmbedLike } from "./structures/Embed";
import { renderComponents, type RowInput } from "./structures/Components";
import { convertDiscordEmojiMarkup } from "./structures/Emoji";
import { MessageFlags } from "./util/Constants";

export type BufferResolvable = Buffer | string;

/** discord.js's `AttachmentBuilder`: a Buffer, a file path, or a URL. */
export class AttachmentBuilder {
  attachment: BufferResolvable | Uint8Array;
  name: string;
  description?: string;
  /** Vector: upload without compressing images/video. */
  compress = true;
  constructor(attachment: BufferResolvable | Uint8Array, data: { name?: string; description?: string; compress?: boolean } = {}) {
    this.attachment = attachment;
    this.name = data.name ?? (typeof attachment === "string" ? path.basename(attachment.split("?")[0]) : "file.bin");
    this.description = data.description;
    if (data.compress === false) this.compress = false;
  }
  setName(name: string): this {
    this.name = name;
    return this;
  }
  setDescription(d: string): this {
    this.description = d;
    return this;
  }
  setFile(attachment: BufferResolvable, name?: string): this {
    this.attachment = attachment;
    if (name) this.name = name;
    return this;
  }
  setSpoiler(spoiler = true): this {
    if (spoiler && !this.name.startsWith("SPOILER_")) this.name = `SPOILER_${this.name}`;
    if (!spoiler) this.name = this.name.replace(/^SPOILER_/, "");
    return this;
  }
  get spoiler(): boolean {
    return this.name.startsWith("SPOILER_");
  }
}

export type FileInput = AttachmentBuilder | BufferResolvable | { attachment: BufferResolvable; name?: string } | { name?: string; data?: Buffer };

export interface MessageCreateOptions {
  content?: string | null;
  embeds?: EmbedLike[];
  files?: FileInput[];
  components?: RowInput[];
  reply?: { messageReference: string | Message; failIfNotExists?: boolean };
  /** Vector: disappearing message, seconds until it expires (NIP-40). */
  expiresIn?: number;
  /** Vector: address a specific bot's command (npub). */
  toBot?: string;
  flags?: number | MessageFlags[];
  tts?: boolean;
  nonce?: string | number;
  allowedMentions?: unknown;
  stickers?: unknown[];
  poll?: unknown;
  enforceNonce?: boolean;
}

export interface MessageEditOptions {
  content?: string | null;
  embeds?: EmbedLike[];
  components?: RowInput[];
  files?: FileInput[];
  attachments?: unknown[];
  flags?: number;
  allowedMentions?: unknown;
}

/** discord.js's `MessagePayload` (just carries options here). */
export class MessagePayload {
  constructor(public readonly target: unknown, public readonly options: MessageCreateOptions) {}
  static create(target: unknown, options: string | MessageCreateOptions): MessagePayload {
    return new MessagePayload(target, typeof options === "string" ? { content: options } : options);
  }
}

interface ResolvedFile {
  name: string;
  path?: string;
  data?: Buffer;
  compress: boolean;
}

async function resolveFile(f: FileInput): Promise<ResolvedFile> {
  if (f instanceof AttachmentBuilder) {
    const a = f.attachment;
    if (typeof a === "string") {
      if (/^https?:\/\//.test(a)) return { name: f.name, data: await download(a), compress: f.compress };
      return { name: f.name, path: path.resolve(a), compress: f.compress };
    }
    return { name: f.name, data: Buffer.from(a), compress: f.compress };
  }
  if (Buffer.isBuffer(f)) return { name: "file.bin", data: f, compress: true };
  if (typeof f === "string") return resolveFile(new AttachmentBuilder(f));
  const o = f as any;
  if ("attachment" in o) return resolveFile(new AttachmentBuilder(o.attachment, { name: o.name }));
  return { name: o.name ?? "file.bin", data: o.data ?? Buffer.alloc(0), compress: true };
}

async function download(url: string, max = 8 * 1024 * 1024): Promise<Buffer> {
  const r = await fetch(url, { headers: { "User-Agent": "vector-sdk-js" }, signal: AbortSignal.timeout(10_000) });
  if (!r.ok) throw new Error(`HTTP ${r.status} for ${url}`);
  const buf = Buffer.from(await r.arrayBuffer());
  if (!buf.length || buf.length > max) throw new Error(`bad size for ${url}`);
  return buf;
}

/** Embed images on web URLs are downloaded and sent as attachments (Vector shows no inline images). */
async function fetchEmbedImages(embeds: ReturnType<typeof embedData>[]): Promise<ResolvedFile[]> {
  const urls = [...new Set(embeds.flatMap(imageUrls).filter((u) => /^https?:\/\//.test(u)))];
  const out: ResolvedFile[] = [];
  for (const u of urls) {
    try {
      out.push({ name: path.basename(new URL(u).pathname) || "image.png", data: await download(u), compress: true });
    } catch {
      return []; // if any image fails, they all stay links
    }
  }
  return out;
}

function referenceId(ref: MessageCreateOptions["reply"]): string | undefined {
  if (!ref) return undefined;
  const r = ref.messageReference;
  return typeof r === "string" ? r : r?.id;
}

/** Send a message: the heart of `channel.send`, `message.reply` and `interaction.reply`. */
export async function send(client: Client, channelId: string, kind: ChannelKind | null, input: string | MessageCreateOptions | MessagePayload): Promise<Message> {
  const o: MessageCreateOptions = typeof input === "string" ? { content: input } : input instanceof MessagePayload ? input.options : input;
  const bot = client._native();
  const state = client._state;
  await state.orderAfterIncoming(channelId);

  const embeds = (o.embeds ?? []).map(embedData);
  const files = await Promise.all((o.files ?? []).map(resolveFile));
  const fetched = await fetchEmbedImages(embeds);
  files.push(...fetched);
  const keepUrls = fetched.length === 0;
  const rendered = renderComponents(o.components);

  const build = (part: "all" | "body" | "footer"): string => {
    const out: string[] = [];
    if (part !== "footer" && o.content) out.push(convertDiscordEmojiMarkup(String(o.content)));
    for (const e of embeds) {
      const md = renderEmbed(e, part, keepUrls);
      if (md) out.push(md);
    }
    if (part !== "body" && rendered.legend) out.push(rendered.legend);
    return out.filter(Boolean).join("\n\n");
  };

  // with an attached image the footer goes in a second message, so the image sits above it
  const wanted = new Set([...embeds.flatMap(attachmentNames), ...fetched.map((f) => f.name)]);
  const split = files.length > 0 && files.some((f) => wanted.has(f.name)) && embeds.some((e) => renderEmbed(e, "footer"));
  const text = split ? build("body") : build("all");
  const footerText = split ? build("footer") : "";
  files.sort((a, b) => Number(!wanted.has(a.name)) - Number(!wanted.has(b.name)));

  const replyTo = referenceId(o.reply);
  const expires = o.expiresIn ? Math.ceil(o.expiresIn) : undefined;
  if (!text && !files.length && !rendered.emojis.length) throw new RangeError("Cannot send an empty message");

  let messageId: string;
  const sendText = (t: string, reply?: string) =>
    value<string>(bot, "channel_send", { id: channelId, kind, text: t || "​", reply_to: reply, expires_in: expires, to_bot: o.toBot });

  if (files.length) {
    // captions don't survive Vector reloading a chat, so with an embed the text goes out as its own message
    const ownText = embeds.length > 0 && Boolean(text);
    let first: string | null = null;
    if (ownText) first = await sendText(text, replyTo);
    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      const caption = i === 0 && text && !ownText ? text : undefined;
      const args = { id: channelId, kind, filename: f.name, path: f.path, caption, reply_to: !ownText && i === 0 ? replyTo : undefined, expires_in: expires, compress: f.compress };
      const id = f.path
        ? await value<string>(bot, "channel_send_file", args)
        : (await call(bot, "channel_send_bytes", args, f.data ?? Buffer.alloc(0))).value as string;
      first ??= id;
      if (!ownText) messageId = first;
    }
    messageId = first!;
  } else {
    messageId = await sendText(text, replyTo);
  }

  let message = await state.sentMessage(messageId, channelId, kind, text, replyTo);
  if (footerText) {
    const id = await sendText(footerText);
    message = await state.sentMessage(id, channelId, kind, footerText, undefined);
  }
  if (rendered.emojis.length) await state.attachComponents(message, rendered);
  return message;
}

/** Edit our own message's text (embeds re-rendered; components re-bound). */
export async function editMessage(message: Message, input: string | MessageEditOptions): Promise<Message> {
  const o: MessageEditOptions = typeof input === "string" ? { content: input } : input;
  const parts: string[] = [];
  const content = o.content === undefined ? null : o.content;
  if (content) parts.push(convertDiscordEmojiMarkup(content));
  else if (o.content === undefined && o.embeds === undefined) parts.push(message.content);
  for (const e of o.embeds ?? []) {
    const md = renderEmbed(embedData(e), "all", true);
    if (md) parts.push(md);
  }
  const rendered = o.components !== undefined ? renderComponents(o.components) : null;
  if (rendered?.legend) parts.push(rendered.legend);
  const text = parts.filter(Boolean).join("\n\n") || "​";
  const [id, kind] = message.channel._target();
  await value(message.client._native(), "channel_edit", { id, kind, message_id: message.id, text });
  message._patch({ ...message.raw, content: text, edited: true });
  if (rendered) await message.client._state.attachComponents(message, rendered);
  return message;
}

/** `flags` contains Ephemeral? */
export function isEphemeral(flags: MessageCreateOptions["flags"], ephemeral?: boolean): boolean {
  if (ephemeral) return true;
  if (flags === undefined) return false;
  if (Array.isArray(flags)) return flags.includes(MessageFlags.Ephemeral);
  return (flags & MessageFlags.Ephemeral) !== 0;
}

export function readFileIfExists(p: string): Buffer | null {
  try {
    return fs.readFileSync(p);
  } catch {
    return null;
  }
}
