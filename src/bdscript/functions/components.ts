/** Buttons, select menus, modals, interactions and slash commands (rendered as reactions / chat prompts on Vector). */
import { BDScriptError, fn, req, none } from "../registry";
import { toInt, truthy } from "../util";
import type { ButtonSpec, ComponentSpec, Context, SelectSpec } from "../context";

const idOf = (i: ComponentSpec) => (i.kind === "button" ? i.url ?? i.customId : i.customId);
const find = (rows: ComponentSpec[][], cid: string) => rows.flat().find((i) => idOf(i) === cid || i.customId === cid) ?? null;

function place(rows: ComponentSpec[][], item: ComponentSpec, newRow: boolean, limit = true): void {
  if (newRow && rows[rows.length - 1].length) rows.push([]);
  if (rows[rows.length - 1].length >= 5) rows.push([]);
  if (limit && rows.flat().length >= 25) throw new BDScriptError("a message can have at most 25 components");
  rows[rows.length - 1].push(item);
}
const interactionMessageId = (ctx: Context) => ctx.interaction?.message?.id ?? "";
async function edit(ctx: Context, messageId: string, apply: (rows: ComponentSpec[][]) => void): Promise<void> {
  const mid = messageId.trim() || interactionMessageId(ctx);
  if (mid) await ctx.bot.editComponents(ctx, mid, apply);
  else apply(ctx.response.rows);
}

fn("addButton", async (ctx, newRow, cid, label = "", style = "secondary", disabled = "no", emoji = "", messageId = "") => {
  style = style.trim().toLowerCase() || "secondary";
  const isUrl = /^https?:\/\//.test(cid);
  if (style === "link" && !isUrl) throw new BDScriptError("link buttons need a URL");
  const spec: ButtonSpec = { kind: "button", customId: cid, label, style: isUrl ? "link" : style, disabled: truthy(disabled, false), emoji: emoji || null, url: isUrl ? cid : null, newRow: truthy(newRow, false) };
  if (messageId.trim()) {
    await ctx.bot.editComponents(ctx, messageId.trim(), (rows) => place(rows, spec, spec.newRow, false));
    return "";
  }
  if (!isUrl && ctx.response.rows.flat().some((i) => i.customId === cid)) throw new BDScriptError(`duplicate button ID '${cid}'`);
  place(ctx.response.rows, spec, spec.newRow);
  return "";
}, req(4));

fn("addActionRow", (ctx) => {
  if (ctx.response.rows[ctx.response.rows.length - 1].length) ctx.response.rows.push([]);
  return "";
});

fn("editButton", async (ctx, cid, label, style, disabled = "no", emoji = "", messageId = "") => {
  await edit(ctx, messageId, (rows) => {
    const b = find(rows, cid);
    if (!b || b.kind !== "button") throw new BDScriptError(`no button '${cid}'`);
    b.label = label;
    b.style = style.trim().toLowerCase() || b.style;
    b.disabled = truthy(disabled, false);
    b.emoji = emoji || null;
  });
  return "";
}, req(3));

fn(["removeButtons", "removeButtonsComplex"], async (ctx, messageId = "") => {
  await edit(ctx, messageId, (rows) => rows.splice(0, rows.length, ...(rows.map((r) => r.filter((i) => i.kind !== "button")) || [[]])));
  if (!ctx.response.rows.length) ctx.response.rows = [[]];
  return "";
});
fn(["removeAllComponents", "removeAllComponentsComplex"], async (ctx, messageId = "") => {
  await edit(ctx, messageId, (rows) => rows.splice(0, rows.length, []));
  return "";
});
fn("removeComponent", async (ctx, cid, messageId = "") => {
  await edit(ctx, messageId, (rows) => rows.splice(0, rows.length, ...rows.map((r) => r.filter((i) => idOf(i) !== cid && i.customId !== cid))));
  if (!ctx.response.rows.length) ctx.response.rows = [[]];
  return "";
}, req(1));

fn("newSelectMenu", async (ctx, cid, mn, mx, placeholder = "", messageId = "") => {
  const spec: SelectSpec = { kind: "select", customId: cid, placeholder, minValues: toInt(mn), maxValues: toInt(mx), options: [], disabled: false };
  if (messageId.trim()) {
    await ctx.bot.editComponents(ctx, messageId.trim(), (rows) => rows.push([spec]));
    return "";
  }
  const rows = ctx.response.rows;
  if (rows[rows.length - 1].length) rows.push([]);
  rows[rows.length - 1].push(spec);
  rows.push([]);
  return "";
}, req(3));

function select(rows: ComponentSpec[][], cid: string): SelectSpec {
  const s = find(rows, cid);
  if (!s || s.kind !== "select") throw new BDScriptError(`no select menu '${cid}'`);
  return s;
}
fn("addSelectMenuOption", async (ctx, cid, label, value, description = "", def = "no", emoji = "", messageId = "") => {
  const opt = { label, value, description: description || undefined, default: truthy(def, false), emoji: emoji || undefined };
  if (messageId.trim()) await ctx.bot.editComponents(ctx, messageId.trim(), (rows) => select(rows, cid).options.push(opt));
  else {
    const s = select(ctx.response.rows, cid);
    if (s.options.length >= 25) throw new BDScriptError("a select menu can have at most 25 options");
    s.options.push(opt);
  }
  return "";
}, req(3));
fn("editSelectMenu", async (ctx, cid, mn, mx, placeholder = "", messageId = "") => {
  await edit(ctx, messageId, (rows) => {
    const s = select(rows, cid);
    s.minValues = toInt(mn);
    s.maxValues = toInt(mx);
    s.placeholder = placeholder || s.placeholder;
  });
  return "";
}, req(3));
fn("editSelectMenuOption", async (ctx, cid, label, value, description = "", def = "no", emoji = "", messageId = "") => {
  await edit(ctx, messageId, (rows) => {
    for (const item of rows.flat()) {
      if (item.kind !== "select") continue;
      for (const o of item.options) {
        if (o.value === value || (item.customId === cid && o.label === label)) {
          Object.assign(o, { label, value, description: description || undefined, default: truthy(def, false), emoji: emoji || undefined });
          return;
        }
      }
    }
    throw new BDScriptError(`no select option '${value}'`);
  });
  return "";
}, req(3));

fn("newModal", (ctx, cid, title) => ((ctx.response.modal = { customId: cid, title, inputs: [] }), ""), req(2));
fn("addTextInput", (ctx, cid, style, label, mn = "", mx = "", required = "yes", value = "", placeholder = "") => {
  if (!ctx.response.modal) throw new BDScriptError("use $newModal first");
  const s = style.trim().toLowerCase();
  if (!["short", "paragraph", "long"].includes(s)) throw new BDScriptError(`invalid text input style '${style}' (short/paragraph)`);
  ctx.response.modal.inputs.push({ id: cid, style: s, label, min: mn.trim() ? toInt(mn) : undefined, max: mx.trim() ? toInt(mx) : undefined, required: truthy(required, true), value, placeholder });
  return "";
}, req(3));
fn("input", (ctx, cid) => String(ctx.extras.inputs?.[cid] ?? ""), req(1));
fn(["customID", "interactionID"], (ctx) => ctx.extras.custom_id ?? "", none);
fn(["selectMenuValues", "interactionValues"], (ctx, sep = ", ") => (ctx.extras.values ?? []).join(sep || ", "));
fn("isSlash", (ctx) => Boolean(ctx.extras.slash), none);
fn("slashOption", (ctx, name) => String(ctx.extras.options?.[name] ?? ""), req(1));
fn(["slashID", "slashIDComplex"], (ctx, name = "") => name.trim() || ctx.extras.slash_name || ""); // Vector slash commands are identified by name
fn("slashCommandsCount", (ctx) => String(ctx.bot.slashCommands.size), none);
fn(["registerGuildCommands", "registerGuildCommandsComplex", "createSlashCommand"], (ctx, ...names) => {
  let n = names.filter((x) => x.trim());
  if (n.length >= 2 && (n[0].toLowerCase() === "global" || /^\d+$/.test(n[0]) || n[0].length === 64)) n = n.slice(1);
  ctx.bot.publishSlash(n.length ? n : undefined);
  return "";
}, { status: "partial", note: "Vector slash commands are bot-wide; the server argument is accepted" });
fn(["unregisterGuildCommands", "unregisterGuildCommandsComplex"], (ctx, ...names) => {
  const n = names.filter((x) => x.trim());
  for (const name of n.length ? n : [...ctx.bot.slashCommands.keys()]) {
    ctx.bot.slashCommands.delete(name);
    void ctx.client.application.commands.delete(name);
  }
  return "";
});
