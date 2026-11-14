/** Embeds (BDFD + D.js-BDscript), and Components V2 rendered as embeds. */
import * as fs from "node:fs";
import * as path from "node:path";
import { randomInt } from "node:crypto";
import { BDScriptError, fn, req } from "../registry";
import { getChannel, seconds, toInt, truthy } from "../util";
import { EmbedBuilder } from "../../structures/Embed";
import type { Context } from "../context";

const NAMED: Record<string, number> = {
  red: 0xed4245, green: 0x57f287, blue: 0x3498db, yellow: 0xfee75c, orange: 0xe67e22, purple: 0x9b59b6, black: 0x000000,
  white: 0xffffff, grey: 0x95a5a6, gray: 0x95a5a6, blurple: 0x5865f2, pink: 0xeb459e, vector: 0x59fcb3,
};

export function colourValue(c: string): number {
  c = c.trim().toLowerCase();
  if (c === "random") return randomInt(0, 0xffffff + 1);
  if (c in NAMED) return NAMED[c];
  if (/^\d+$/.test(c)) return parseInt(c, 10);
  let h = c.replace(/^#/, "");
  if (/^[0-9a-f]{3}$/.test(h)) h = [...h].map((x) => x + x).join("");
  if (!/^[0-9a-f]{6}$/.test(h)) throw new BDScriptError(`invalid color '${c}'`);
  return parseInt(h, 16);
}

const e = (ctx: Context, index: string) => ctx.response.embed(index);
const isIdx = (s: string) => /^\d+$/.test(s.trim());

fn("title", (ctx, text, index = "") => {
  const em = e(ctx, isIdx(index) ? index : "");
  em.setTitle(text);
  if (index && !isIdx(index) && index.startsWith("http")) em.setURL(index); // D.js-BDscript: $title[text;url]
  return "";
}, req(1));
fn("description", (ctx, text, index = "") => (e(ctx, index).setDescription(text), ""), req(1));
fn("color", (ctx, c, index = "") => (e(ctx, index).setColor(colourValue(c)), ""), req(1));
fn("footer", (ctx, text, indexOrIcon = "", ...rest) => {
  if (indexOrIcon && !isIdx(indexOrIcon)) e(ctx, rest[0] ?? "").setFooter({ text, iconURL: indexOrIcon });
  else {
    const em = e(ctx, indexOrIcon);
    em.setFooter({ text, iconURL: em.data.footer?.icon_url });
  }
  return "";
}, req(1));
fn("footerIcon", (ctx, url, index = "") => {
  const em = e(ctx, index);
  em.setFooter({ text: em.data.footer?.text || "​", iconURL: url });
  return "";
}, req(1));
fn("image", (ctx, url, index = "") => (e(ctx, index).setImage(url), ""), req(1));
fn("thumbnail", (ctx, url, index = "") => (e(ctx, index).setThumbnail(url), ""), req(1));
fn("author", (ctx, text = "", indexOrIcon = "", url = "") => {
  if (text === "" && !indexOrIcon) return ctx.author?.username ?? ""; // bare $author (fork): author name
  if (indexOrIcon && !isIdx(indexOrIcon)) e(ctx, "").setAuthor({ name: text, iconURL: indexOrIcon, url: url || undefined });
  else {
    const em = e(ctx, indexOrIcon);
    em.setAuthor({ name: text, iconURL: em.data.author?.icon_url, url: em.data.author?.url });
  }
  return "";
});
fn("authorIcon", (ctx, url, index = "") => {
  const em = e(ctx, index);
  em.setAuthor({ name: em.data.author?.name || "​", iconURL: url, url: em.data.author?.url });
  return "";
}, req(1));
fn("authorURL", (ctx, url, index = "") => {
  const em = e(ctx, index);
  em.setAuthor({ name: em.data.author?.name || "​", iconURL: em.data.author?.icon_url, url });
  return "";
}, req(1));
fn("embeddedURL", (ctx, url, index = "") => (e(ctx, index).setURL(url), ""), req(1));
fn("addField", (ctx, name, value, inline = "no", index = "") => (e(ctx, index).addFields({ name, value, inline: inline ? truthy(inline, false) : false }), ""), req(2));
fn(["addTimestamp", "addTimestampComplex"], (ctx, index = "", ms = "") => (e(ctx, index).setTimestamp(ms.trim() ? toInt(ms) : Date.now()), ""));

fn("attachment", async (ctx, source, name = "file") => {
  if (/^https?:\/\//.test(source)) {
    const r = await fetch(source);
    const data = Buffer.from(await r.arrayBuffer());
    if (data.length > 25 * 1024 * 1024) throw new BDScriptError("file too large");
    ctx.response.files.push({ attachment: data, name: name || path.basename(new URL(source).pathname) || "file" });
  } else if (ctx.bot.allowFiles && fs.existsSync(source) && fs.statSync(source).isFile()) {
    ctx.response.files.push({ attachment: source, name: name || path.basename(source) });
  } else ctx.response.files.push({ attachment: Buffer.from(source), name: name || "file.txt" });
  return "";
}, req(1));

fn("getEmbedData", async (ctx, channelId, messageId, index, prop) => {
  // Vector messages don't carry embeds back (they're rendered markdown); only embeds this bot sent this session are known.
  const ch = getChannel(ctx, channelId);
  const msg: any = await ch.messages.fetch(messageId).catch(() => null);
  const embeds: any[] = msg?.embeds ?? [];
  const i = toInt(index);
  if (!(i > 0 && i <= embeds.length)) return "";
  const d = embeds[i - 1].data ?? embeds[i - 1];
  return ({ title: d.title, description: d.description, footer: d.footer?.text, color: d.color !== undefined ? `#${d.color.toString(16).padStart(6, "0")}` : "", image: d.image?.url, timestamp: d.timestamp ? String(Math.floor(Date.parse(d.timestamp) / 1000)) : "" } as Record<string, string | undefined>)[prop.trim().toLowerCase()] ?? "";
}, req(4));

fn("sendEmbedMessage", async (ctx, channelId, content = "", title = "", titleUrl = "", description = "", color = "", author = "", authorIcon = "", footer = "", footerIcon = "", thumbnail = "", image = "", addTs = "no", returnId = "no") => {
  const ch = getChannel(ctx, channelId);
  const em = new EmbedBuilder();
  if (title) em.setTitle(title);
  if (titleUrl) em.setURL(titleUrl);
  if (description) em.setDescription(description);
  if (color) em.setColor(colourValue(color));
  if (author) em.setAuthor({ name: author, iconURL: authorIcon || undefined });
  if (footer) em.setFooter({ text: footer, iconURL: footerIcon || undefined });
  if (thumbnail) em.setThumbnail(thumbnail);
  if (image) em.setImage(image);
  if (truthy(addTs)) em.setTimestamp();
  const msg = await ch.send({ content: content || null, embeds: [em] });
  return truthy(returnId) ? msg.id : "";
}, req(2));

fn("editEmbedIn", (ctx, when, title = "", description = "", footer = "", color = "") => {
  const em = new EmbedBuilder();
  if (title) em.setTitle(title);
  if (description) em.setDescription(description);
  if (footer) em.setFooter({ text: footer });
  if (color) em.setColor(colourValue(color));
  const ms = seconds(when) * 1000;
  setTimeout(async () => {
    for (const id of ctx.sentIds.slice(-1)) {
      const m: any = await (ctx.channel as any)?.messages.fetch(id).catch(() => null);
      await m?.edit({ embeds: [em] }).catch(() => undefined);
    }
  }, ms);
  return "";
}, req(1));

// -- Components V2, rendered with embeds (Vector has no component layouts) ------------------------------------------
const v2 = (ctx: Context): Record<string, { kind: string; embed: EmbedBuilder }> => (ctx.extras.v2 ??= {});
function named(ctx: Context, name: string, kind: string) {
  const item = v2(ctx)[name];
  if (!item) throw new BDScriptError(`no ${kind} named '${name}'`);
  return item;
}
const lastIndex = (ctx: Context) => Math.max(0, ...ctx.response.embeds.keys());
const target = (ctx: Context, name: string) => (name ? named(ctx, name, "container/section").embed : ctx.response.embed(lastIndex(ctx) || 1));

fn("addContainer", (ctx, name, color = "") => {
  const em = ctx.response.embed(lastIndex(ctx) + 1);
  if (color) em.setColor(colourValue(color));
  v2(ctx)[name] = { kind: "container", embed: em };
  return "";
}, req(1));
fn("addSection", (ctx, name, container = "") => ((v2(ctx)[name] = { kind: "section", embed: target(ctx, container) }), ""), req(1));
fn("addTextDisplay", (ctx, content, t = "") => {
  const em = target(ctx, t);
  em.setDescription((em.data.description ? em.data.description + "\n" : "") + content);
  return "";
}, req(1));
fn("addSeparator", (ctx, divider = "yes", _spacing = "", container = "") => {
  const em = target(ctx, container);
  if (em.data.description) em.setDescription(em.data.description + (truthy(divider, true) ? "\n―――――――――" : "\n​"));
  return "";
});
fn("addThumbnail", (ctx, url, _d = "", _s = "", section = "") => (target(ctx, section).setThumbnail(url), ""), req(1));
fn("addMediaGallery", (ctx, name, container = "") => ((v2(ctx)[name] = { kind: "gallery", embed: target(ctx, container) }), ""), req(1));
fn("addMediaGalleryItem", (ctx, url, desc = "", _s = "", gallery = "") => {
  const em = target(ctx, gallery);
  if (!em.data.image?.url) em.setImage(url);
  else em.setDescription((em.data.description ? em.data.description + "\n" : "") + `[${desc || "image"}](<${url}>)`);
  return "";
}, req(1));
