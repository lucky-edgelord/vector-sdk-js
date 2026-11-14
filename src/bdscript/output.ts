/** Turns a finished Response into Vector messages (text, embeds, buttons, menus, reactions). */
import type { Context, ComponentSpec } from "./context";
import { ActionRowBuilder, ButtonBuilder, StringSelectMenuBuilder, ModalBuilder, TextInputBuilder } from "../structures/Components";
import { ButtonStyle, TextInputStyle } from "../util/Constants";
import type { EmbedBuilder } from "../structures/Embed";

const STYLES: Record<string, ButtonStyle> = {
  primary: ButtonStyle.Primary, blurple: ButtonStyle.Primary, secondary: ButtonStyle.Secondary, grey: ButtonStyle.Secondary,
  gray: ButtonStyle.Secondary, success: ButtonStyle.Success, green: ButtonStyle.Success, danger: ButtonStyle.Danger,
  red: ButtonStyle.Danger, link: ButtonStyle.Link, url: ButtonStyle.Link,
};
const LINK = /https?:\/\/\S+/g;

/** `$addButton`/`$newSelectMenu` specs -> discord.js component rows (rendered as reactions on Vector). */
export function buildRows(rows: ComponentSpec[][]): ActionRowBuilder<any>[] {
  const out: ActionRowBuilder<any>[] = [];
  for (const row of rows) {
    if (!row.length) continue;
    const r = new ActionRowBuilder<any>();
    for (const s of row) {
      if (s.kind === "button") {
        const b = new ButtonBuilder().setStyle(STYLES[s.style.toLowerCase()] ?? ButtonStyle.Secondary).setDisabled(s.disabled);
        if (s.label) b.setLabel(s.label);
        if (s.emoji) b.setEmoji(s.emoji);
        if (s.url) b.setURL(s.url);
        else b.setCustomId(s.customId);
        r.addComponents(b);
      } else {
        const m = new StringSelectMenuBuilder().setCustomId(s.customId).setMinValues(s.minValues).setMaxValues(s.maxValues).setDisabled(s.disabled);
        if (s.placeholder) m.setPlaceholder(s.placeholder);
        m.addOptions(s.options.map((o) => ({ label: o.label, value: o.value || o.label, description: o.description || undefined, emoji: o.emoji || undefined, default: o.default ?? false })));
        r.addComponents(m);
      }
    }
    out.push(r);
  }
  return out;
}

export function buildModal(spec: NonNullable<Context["response"]["modal"]>): ModalBuilder {
  const m = new ModalBuilder().setCustomId(spec.customId).setTitle(spec.title);
  for (const i of spec.inputs) {
    const t = new TextInputBuilder().setCustomId(i.id).setLabel(i.label).setStyle(i.style === "short" ? TextInputStyle.Short : TextInputStyle.Paragraph).setRequired(i.required ?? true);
    if (i.placeholder) t.setPlaceholder(i.placeholder);
    if (i.value) t.setValue(i.value);
    if (i.min !== undefined) t.setMinLength(i.min);
    if (i.max !== undefined) t.setMaxLength(i.max);
    m.addComponents(new ActionRowBuilder<any>().addComponents(t));
  }
  return m;
}

function emptyEmbed(e: EmbedBuilder): boolean {
  const d: any = e.data;
  return !["title", "description", "fields", "image", "thumbnail", "author", "footer"].some((k) => (Array.isArray(d[k]) ? d[k].length : d[k]));
}

export async function sendResponse(ctx: Context, text: string): Promise<any> {
  const resp = ctx.response;
  if (resp.suppress) return null;
  if (resp.removeLinks) text = text.replace(LINK, "");
  const embeds = [...resp.embeds.entries()].sort((a, b) => a[0] - b[0]).map(([, e]) => e).filter((e) => !emptyEmbed(e));
  const components = buildRows(resp.rows);
  const files = resp.files.map((f) => ({ attachment: f.attachment, name: f.name }));
  let msg: any = null;

  if (ctx.interaction && (text || embeds.length || components.length || files.length || resp.modal)) {
    msg = await replyInteraction(ctx, text, embeds, components, files);
  } else if (text || embeds.length || files.length) {
    let channel: any = ctx.channel;
    const dms: string[] | undefined = ctx.extras.dm_targets;
    if (dms?.length) {
      for (const uid of dms) {
        const u = ctx.client._state.user(uid.trim().replace(/^<@!?|>$/g, ""));
        msg = await u.send({ content: text || null, embeds, files }).catch(() => null);
      }
      return msg;
    }
    if (resp.channelId) channel = ctx.client.channels.resolve(resp.channelId) ?? channel;
    if (!channel) return null;
    if (resp.mentionAuthor && ctx.author && text && !resp.replyTo && ctx.message && !ctx.command?.isEvent) text = `${ctx.author.toString()} ${text}`;
    msg = await channel.send({
      content: text || null, embeds, files, components, tts: resp.tts, expiresIn: resp.expiresIn ?? undefined,
      reply: resp.replyTo ? { messageReference: resp.replyTo, failIfNotExists: false } : undefined,
    });
    if (resp.deleteAfter !== null) setTimeout(() => void msg?.delete().catch(() => undefined), resp.deleteAfter * 1000);
  } else if (components.length && ctx.channel) {
    msg = await ctx.channel.send({ content: "​", components });
  }

  if (msg) {
    ctx.sentIds.push(String(msg.id));
    if (components.length) ctx.bot.rememberRows(String(msg.id), resp.rows);
    const waits = ctx.extras.await_reactions;
    if (waits) ctx.bot.reactionWaits.set(String(msg.id), { user: ctx.authorId, map: waits });
    for (const r of resp.reactions) await msg.react(r).catch((e: Error) => ctx.client.emit("warn", `add reaction ${r} failed: ${e.message}`));
  }
  if (ctx.message) {
    for (const r of resp.cmdReactions) await ctx.message.react(r).catch((e: Error) => ctx.client.emit("warn", `add reaction ${r} failed: ${e.message}`));
    if (resp.deleteCommandAfter !== null) setTimeout(() => void ctx.message?.delete().catch(() => undefined), resp.deleteCommandAfter * 1000);
  }
  return msg;
}

async function replyInteraction(ctx: Context, text: string, embeds: EmbedBuilder[], components: ActionRowBuilder<any>[], files: any[]): Promise<any> {
  const resp = ctx.response;
  const i = ctx.interaction;
  if (resp.modal) {
    await i.showModal(buildModal(resp.modal));
    const spec = resp.modal;
    i.awaitModalSubmit({ time: 10 * 60_000 })
      .then((sub: any) => ctx.bot.dispatchInteraction(spec.customId, sub, { inputs: Object.fromEntries(spec.inputs.map((x) => [x.id, sub.fields.getTextInputValue(x.id)])) }))
      .catch(() => undefined);
    return null;
  }
  if (resp.editTarget === "interaction" && i.message && typeof i.update === "function") {
    return i.update({ content: text || null, embeds, components });
  }
  const payload = { content: text || null, embeds, components, files, ephemeral: resp.ephemeral, fetchReply: true };
  return i.replied || i.deferred ? i.followUp(payload) : i.reply(payload);
}
