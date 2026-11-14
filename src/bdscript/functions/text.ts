/** Message arguments, text manipulation, text splitting, mentions. */
import { escape } from "../parser";
import { BDScriptError, fn, req, none } from "../registry";
import { fmtNum, stripMention, toInt, toNum, truthy } from "../util";
import type { Context } from "../context";
import { randomInt } from "node:crypto";

const LINK = /https?:\/\/\S+|www\.\S+/gi;
const MENTION_TOKEN = /^(<[@#][!&]?[^>]+>|nostr:npub1[0-9a-z]+)$/;
const msgText = (ctx: Context) => ctx.args.join(" ");
const choice = <T>(a: T[]): T => a[randomInt(0, a.length)];

const message = (ctx: Context, index = "", name = "") => {
  const opts: Record<string, string> = ctx.extras.options ?? {};
  if (name && name in opts) return escape(String(opts[name]));
  const idx = index.trim();
  if (idx && !/^-?\d+$/.test(idx) && idx !== ">") return escape(String(opts[idx] ?? ""));
  if (index === "") return escape(msgText(ctx));
  if (idx === ">") return ctx.args.length ? escape(ctx.args[ctx.args.length - 1]) : "";
  const i = toInt(index);
  if (i <= 0) return escape(msgText(ctx));
  return i <= ctx.args.length ? escape(ctx.args[i - 1]) : "";
};
fn(["message", "messageComplex"], message);

fn(["noMentionMessage", "noMentionMessageComplex"], (ctx, index = "") => {
  const args = ctx.args.filter((a) => !MENTION_TOKEN.test(a));
  if (index === "") return escape(args.join(" ").trim());
  if (index.trim() === ">") return args.length ? escape(args[args.length - 1]) : "";
  const i = toInt(index);
  return i > 0 && i <= args.length ? escape(args[i - 1]) : "";
});
fn("argCount", (ctx, ...t) => {
  const s = t.length ? t.join(";") : msgText(ctx);
  return s.trim() ? String(s.trim().split(/\s+/).length) : "0";
});
fn("replaceText", (_c, text, sample, nw, amount = "-1") => {
  let n = amount.trim() ? toInt(amount) : -1;
  if (n < 0) return text.split(sample).join(nw);
  let out = text;
  let from = 0;
  while (n-- > 0) {
    const i = out.indexOf(sample, from);
    if (i === -1 || sample === "") break;
    out = out.slice(0, i) + nw + out.slice(i + sample.length);
    from = i + nw.length;
  }
  return out;
}, req(3));
fn("toLowercase", (_c, ...t) => t.join(";").toLowerCase(), req());
fn("toUppercase", (_c, ...t) => t.join(";").toUpperCase(), req());
fn("toTitleCase", (_c, ...t) => t.join(";").split(" ").map((w) => w.slice(0, 1).toUpperCase() + w.slice(1).toLowerCase()).join(" "), req());
fn("toTitle", (_c, text, sep = " ") => text.split(sep || " ").map((w) => w.slice(0, 1).toUpperCase() + w.slice(1)).join(sep || " "), req());
fn("cropText", (_c, text, max, ending = "") => {
  const m = toInt(max);
  return [...text].length <= m ? text : [...text].slice(0, m).join("") + ending;
}, req(2));
fn("charCount", (ctx, ...t) => String([...(t.length ? t.join(";") : msgText(ctx))].length));
fn("linesCount", (ctx, ...t) => {
  const s = t.length ? t.join(";") : msgText(ctx);
  return s ? String(s.split("\n").length) : "0";
});
fn("byteCount", (_c, ...t) => String(Buffer.byteLength(t.join(";"))), req());
fn("trimContent", (ctx) => escape(msgText(ctx).trim()), none);
fn("trimSpace", (_c, ...t) => t.join(";").trim(), req());
fn("randomString", (_c, length) => {
  const n = Math.max(0, Math.min(toInt(length), 2000));
  const abc = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  return Array.from({ length: n }, () => abc[randomInt(0, abc.length)]).join("");
}, req(1));
fn("randomText", (_c, ...options) => choice(options), req(1));
fn("removeContains", (ctx, ...words) => {
  let amount = -1;
  if (words.length > 1 && /^-?\d+$/.test(words[words.length - 1].trim())) amount = parseInt(words.pop()!, 10);
  let text = msgText(ctx);
  for (const w of words) {
    if (amount < 0) text = text.split(w).join("");
    else for (let k = 0; k < amount; k++) text = text.replace(w, "");
  }
  return escape(text);
}, req(1));
fn(["removeLinks", "removeLinksComplex"], (ctx, ...t) => {
  if (t.length) return t.join(";").replace(LINK, "").trim();
  ctx.response.removeLinks = true;
  return "";
});
fn("url", (ctx, mode, ...t) => {
  const s = t.join(";");
  const m = mode.trim().toLowerCase();
  if (m.startsWith("http://") || m.startsWith("https://")) {
    ctx.response.embed(/^\d+$/.test(s.trim()) ? s : "").setURL(mode.trim());
    return "";
  }
  if (m === "encode") return encodeURIComponent(s);
  if (m === "decode") return decodeURIComponent(s);
  throw new BDScriptError(`invalid mode '${mode}' (encode/decode)`);
}, req(1));
fn("numberSeparator", (_c, number, sep = ",") => {
  const [whole, frac] = fmtNum(toNum(number)).split(".");
  const neg = whole.startsWith("-");
  const digits = whole.replace(/^-/, "").replace(/\B(?=(\d{3})+(?!\d))/g, sep !== "" ? sep : ",");
  return (neg ? "-" : "") + digits + (frac ? "." + frac : "");
}, req(1));
fn("isNumber", (_c, ...v) => v.join(";").trim() !== "" && !Number.isNaN(Number(v.join(";").trim())), req());
fn("isInteger", (_c, ...v) => /^[+-]?\d+$/.test(v.join(";").trim()), req());
fn("isBoolean", (_c, ...v) => ["true", "false", "yes", "no"].includes(v.join(";").trim().toLowerCase()), req());
fn("isValidHex", (_c, ...v) => /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.test(v.join(";").trim()), req());
fn("checkContains", (_c, text, ...phrases) => phrases.some((p) => text.includes(p)), req(2));
fn("sort", (_c, ...args) => {
  const items = [...args];
  let direction = "asc", sep = ", ";
  const isNum = (x: string) => x.trim() !== "" && !Number.isNaN(Number(x));
  const tail: string[] = [];
  while (items.length && tail.length < 3 && !isNum(items[items.length - 1])) tail.unshift(items.pop()!);
  for (const t of tail) {
    if (["asc", "desc", "ascending", "descending"].includes(t.toLowerCase())) direction = t.toLowerCase();
    else if (t) sep = t;
  }
  const nums = items.filter((x) => x.trim() !== "").map((x) => toNum(x)).sort((a, b) => a - b);
  if (direction.startsWith("desc")) nums.reverse();
  return nums.map(fmtNum).join(sep);
}, req(1));
fn("repeatMessage", (_c, amount, ...t) => t.join(";").repeat(Math.max(0, Math.min(toInt(amount), 2000))), req(2));

// -- text splitting ------------------------------------------------------------------------------------------------
fn("textSplit", (ctx, text, sep = "") => ((ctx.split = sep === "" ? [...text] : text.split(sep)), ""), req(1));
fn("splitText", (ctx, index) => {
  if (index.trim() === "<") return ctx.split[0] ?? "";
  if (index.trim() === ">") return ctx.split[ctx.split.length - 1] ?? "";
  const i = toInt(index);
  return i > 0 && i <= ctx.split.length ? ctx.split[i - 1] : "";
}, req(1));
fn("getTextSplitIndex", (ctx, v) => String(ctx.split.indexOf(v) + 1 || -1), req(1));
fn("getTextSplitLength", (ctx) => String(ctx.split.length), none);
fn("joinSplitText", (ctx, sep = "") => ctx.split.join(sep), req());
fn("editSplitText", (ctx, index, v) => {
  const i = toInt(index);
  if (!(i > 0 && i <= ctx.split.length)) throw new BDScriptError(`index ${i} out of range`);
  ctx.split[i - 1] = v;
  return "";
}, req(2));
fn("removeSplitTextElement", (ctx, index) => {
  const i = toInt(index);
  if (i > 0 && i <= ctx.split.length) ctx.split.splice(i - 1, 1);
  return "";
}, req(1));

// -- mentions ------------------------------------------------------------------------------------------------------
function mentionIds(ctx: Context, kind: "user" | "channel" | "role"): string[] {
  const m: any = ctx.message;
  if (!m) return [];
  if (kind === "user") {
    const ids = [...(m.mentions?.users?.keys?.() ?? [])] as string[];
    return ids.length ? ids : ctx.args.filter((a) => /^<@!?[^>&]+>$|^nostr:npub1/.test(a)).map(stripMention);
  }
  if (kind === "channel") return [...(m.mentions?.channels?.keys?.() ?? [])] as string[];
  return [...(m.mentions?.roles?.keys?.() ?? [])] as string[];
}
fn("mentioned", (ctx, n, returnAuthor = "no") => {
  const ids = mentionIds(ctx, "user");
  if (n.trim() === ">") return ids[ids.length - 1] ?? (truthy(returnAuthor) ? ctx.authorId : "");
  const i = toInt(n);
  return i > 0 && i <= ids.length ? ids[i - 1] : truthy(returnAuthor) ? ctx.authorId : "";
}, req(1));
fn("mentionedChannels", (ctx, n, returnCurrent = "no") => {
  const ids = mentionIds(ctx, "channel");
  const i = toInt(n);
  return i > 0 && i <= ids.length ? ids[i - 1] : truthy(returnCurrent) ? ctx.channelId : "";
}, req(1));
fn("mentionedRoles", (ctx, n) => {
  const ids = mentionIds(ctx, "role");
  const i = toInt(n);
  return i > 0 && i <= ids.length ? ids[i - 1] : "";
}, req(1));
fn("isMentioned", (ctx, uid) => mentionIds(ctx, "user").includes(stripMention(uid)), req(1));
