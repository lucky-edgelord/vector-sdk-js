/**
 * Embeds. Vector has no native embeds, so they're rendered as Vector markdown (the "faux embed"):
 *
 *   > -# author
 *   > ### **[Title](<url>)**            (in Vector's mint)
 *   > description
 *   > | inline | fields |               (a table, up to 3 per row)
 *   [image, sent as its own attachment]
 *   > -# footer • <t:timestamp:f>
 *
 * Colours are always Vector's accent so embeds match the app. Body, image and footer go out as separate messages
 * so they survive the app reloading the chat.
 */
import { VECTOR_ACCENT } from "../util/Constants";

export interface APIEmbedField {
  name: string;
  value: string;
  inline?: boolean;
}
export interface APIEmbed {
  title?: string;
  description?: string;
  url?: string;
  color?: number;
  timestamp?: string;
  author?: { name: string; url?: string; icon_url?: string };
  footer?: { text: string; icon_url?: string };
  image?: { url: string };
  thumbnail?: { url: string };
  fields?: APIEmbedField[];
}

export type ColorResolvable = number | string | [number, number, number];

function resolveColor(c: ColorResolvable | null): number | undefined {
  if (c === null) return undefined;
  if (typeof c === "number") return c;
  if (Array.isArray(c)) return (c[0] << 16) + (c[1] << 8) + c[2];
  if (c.startsWith("#")) return parseInt(c.slice(1), 16);
  return undefined;
}

export class EmbedBuilder {
  data: APIEmbed;
  constructor(data: APIEmbed = {}) {
    this.data = { ...data, fields: data.fields ? [...data.fields] : undefined };
  }
  static from(other: EmbedBuilder | Embed | APIEmbed): EmbedBuilder {
    return new EmbedBuilder("data" in other ? (other as EmbedBuilder).data : (other as APIEmbed));
  }
  setTitle(title: string | null): this {
    this.data.title = title ?? undefined;
    return this;
  }
  setDescription(description: string | null): this {
    this.data.description = description ?? undefined;
    return this;
  }
  setURL(url: string | null): this {
    this.data.url = url ?? undefined;
    return this;
  }
  /** Accepted for compatibility; faux embeds always use Vector's accent colour. */
  setColor(color: ColorResolvable | null): this {
    this.data.color = resolveColor(color);
    return this;
  }
  setAuthor(author: { name: string; url?: string; iconURL?: string } | null): this {
    this.data.author = author ? { name: author.name, url: author.url, icon_url: author.iconURL } : undefined;
    return this;
  }
  setFooter(footer: { text: string; iconURL?: string } | null): this {
    this.data.footer = footer ? { text: footer.text, icon_url: footer.iconURL } : undefined;
    return this;
  }
  setImage(url: string | null): this {
    this.data.image = url ? { url } : undefined;
    return this;
  }
  setThumbnail(url: string | null): this {
    this.data.thumbnail = url ? { url } : undefined;
    return this;
  }
  setTimestamp(timestamp: Date | number | null = Date.now()): this {
    this.data.timestamp = timestamp === null ? undefined : new Date(timestamp).toISOString();
    return this;
  }
  addFields(...fields: (APIEmbedField | APIEmbedField[])[]): this {
    (this.data.fields ??= []).push(...fields.flat());
    return this;
  }
  setFields(...fields: (APIEmbedField | APIEmbedField[])[]): this {
    this.data.fields = fields.flat();
    return this;
  }
  spliceFields(index: number, deleteCount: number, ...fields: APIEmbedField[]): this {
    (this.data.fields ??= []).splice(index, deleteCount, ...fields);
    return this;
  }
  toJSON(): APIEmbed {
    return { ...this.data };
  }
}

/** A read-only embed (what discord.js gives you back). */
export class Embed {
  constructor(public readonly data: APIEmbed) {}
  get title() {
    return this.data.title ?? null;
  }
  get description() {
    return this.data.description ?? null;
  }
  get url() {
    return this.data.url ?? null;
  }
  get fields() {
    return this.data.fields ?? [];
  }
  get footer() {
    return this.data.footer ?? null;
  }
  get author() {
    return this.data.author ?? null;
  }
  get image() {
    return this.data.image ?? null;
  }
  get thumbnail() {
    return this.data.thumbnail ?? null;
  }
  get timestamp() {
    return this.data.timestamp ?? null;
  }
  get color() {
    return this.data.color ?? null;
  }
  toJSON(): APIEmbed {
    return { ...this.data };
  }
}

export type EmbedLike = EmbedBuilder | Embed | APIEmbed;

export function embedData(e: EmbedLike): APIEmbed {
  return e instanceof EmbedBuilder || e instanceof Embed ? e.data : e;
}

/** Image URLs that aren't attachments (downloaded and sent as files by `send`). */
export function imageUrls(e: APIEmbed): string[] {
  return [e.image?.url, e.thumbnail?.url].filter((u): u is string => Boolean(u) && !u!.startsWith("attachment://"));
}

/** `attachment://name` references. */
export function attachmentNames(e: APIEmbed): string[] {
  return [e.image?.url, e.thumbnail?.url]
    .filter((u): u is string => Boolean(u) && u!.startsWith("attachment://"))
    .map((u) => u.slice("attachment://".length));
}

/** Render an embed as Vector markdown. `part`: everything, the body (above the footer) or the footer alone. */
export function renderEmbed(e: APIEmbed, part: "all" | "body" | "footer" = "all", images = true): string {
  const paint = (t: string) => `<color ${VECTOR_ACCENT}>${t}</color>`;
  // [text](<url>) is a link Vector will not unfurl into a big preview card
  const link = (t: string, url?: string) => (url ? `[${t}](<${url}>)` : t);
  const cell = (t: string) => String(t).replace(/\|/g, "\\|").replace(/\n/g, "<br>");
  const lines: string[] = [];
  if (e.author?.name) lines.push(`-# ${link(e.author.name, e.author.url)}`);
  if (e.title) lines.push(`### ${paint(`**${link(e.title, e.url)}**`)}`);
  if (e.description) lines.push(...e.description.split("\n"));
  const rows: APIEmbedField[][] = [];
  for (const f of e.fields ?? []) {
    const last = rows[rows.length - 1];
    if (f.inline && last && last[last.length - 1]?.inline && last.length < 3) last.push(f);
    else rows.push([f]);
  }
  for (const row of rows) {
    if (lines.length) lines.push("");
    if (row.length === 1) {
      lines.push(`**${row[0].name}**`, ...String(row[0].value).split("\n"));
    } else {
      lines.push(`| ${row.map((f) => cell(f.name)).join(" | ")} |`);
      lines.push(`|${"---|".repeat(row.length)}`);
      lines.push(`| ${row.map((f) => cell(f.value)).join(" | ")} |`);
    }
  }
  const outside = images ? imageUrls(e) : [];
  const footer: string[] = [];
  if (e.footer?.text) footer.push(e.footer.text);
  if (e.timestamp) footer.push(`<t:${Math.floor(new Date(e.timestamp).getTime() / 1000)}:f>`);
  const quote = (ls: string[]) => ls.map((l) => (l ? `> ${l}` : ">")).join("\n");
  const blocks: string[] = [];
  if (part === "all" || part === "body") {
    if (lines.length) blocks.push(quote(lines));
    blocks.push(...outside);
  }
  if (footer.length && (part === "all" || part === "footer")) blocks.push(quote([`-# ${footer.join(" • ")}`]));
  return blocks.join("\n\n");
}
