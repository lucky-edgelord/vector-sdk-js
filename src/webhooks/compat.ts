/** Translate Discord / Slack / GitHub webhook payloads into Vector messages, and messages back into Discord JSON. */
import type { APIEmbed } from "../structures/Embed";

export const MAX_CONTENT = 2000;
export const MAX_EMBEDS = 10;

/** Bad request; `code` is the Discord error code. */
export class PayloadError extends Error {
  constructor(message: string, public readonly code = 50035) {
    super(message);
  }
}

function colour(v: unknown): number | undefined {
  if (typeof v === "number") return v;
  if (typeof v === "string") {
    const h = v.replace(/^#/, "");
    if (/^[0-9a-f]{3}$|^[0-9a-f]{6}$/i.test(h)) return parseInt(h.length === 3 ? [...h].map((c) => c + c).join("") : h, 16);
  }
  return undefined;
}

const named = (name: unknown, text: string) => (name && typeof name === "string" ? (text ? `**${name}**\n${text}` : `**${name}**`) : text);

/** A Discord "execute webhook" body -> text + embeds. `username` becomes a bold first line (Vector messages always come from the bot). */
export function discordPayload(p: any): { text: string; embeds: APIEmbed[] } {
  const content = p?.content ?? "";
  if (typeof content !== "string") throw new PayloadError("content: must be a string");
  if (content.length > MAX_CONTENT) throw new PayloadError(`content: Must be ${MAX_CONTENT} or fewer in length.`);
  const raw = p?.embeds ?? [];
  if (!Array.isArray(raw) || raw.length > MAX_EMBEDS) throw new PayloadError(`embeds: Must be ${MAX_EMBEDS} or fewer in length.`);
  return { text: named(p?.username, content), embeds: raw.filter((e: unknown) => e && typeof e === "object") };
}

/** Slack incoming-webhook body (`text` + `attachments`) -> text + embeds. */
export function slackPayload(p: any): { text: string; embeds: APIEmbed[] } {
  let text = named(p?.username, String(p?.text ?? ""));
  const embeds: APIEmbed[] = [];
  for (const a of p?.attachments ?? []) {
    const e: APIEmbed = { title: a.title, description: a.text ?? a.fallback, url: a.title_link, color: colour(a.color) };
    if (a.author_name) e.author = { name: a.author_name, url: a.author_link };
    if (a.fields?.length) e.fields = a.fields.map((f: any) => ({ name: String(f.title ?? ""), value: String(f.value ?? ""), inline: Boolean(f.short) }));
    if (a.footer) e.footer = { text: a.footer };
    if (a.image_url) e.image = { url: a.image_url };
    if (a.ts) e.timestamp = new Date(Number(a.ts) * 1000).toISOString();
    embeds.push(e);
  }
  if (text.length > MAX_CONTENT) text = text.slice(0, MAX_CONTENT - 1) + "…";
  return { text, embeds: embeds.slice(0, MAX_EMBEDS) };
}

/** A GitHub delivery -> text + embeds; `null` for events we don't render. */
export function githubPayload(event: string, p: any): { text: string; embeds: APIEmbed[] } | null {
  const repo = p?.repository?.full_name ?? "";
  const sender = p?.sender?.login ?? "";
  const e: APIEmbed = { color: 0x59fcb3, author: { name: sender || repo, url: p?.sender?.html_url } };
  const cut = (s: string, n: number) => s.slice(0, n);
  if (event === "ping") {
    e.title = `Webhook connected: ${repo}`;
    e.description = p.zen ?? "";
  } else if (event === "push") {
    const commits: any[] = p.commits ?? [];
    if (!commits.length) return null;
    const branch = String(p.ref ?? "").replace("refs/heads/", "");
    e.title = `[${repo}:${branch}] ${commits.length} new commit${commits.length !== 1 ? "s" : ""}`;
    e.url = p.compare;
    e.description = commits.slice(0, 8).map((c) => `[\`${String(c.id).slice(0, 7)}\`](${c.url ?? ""}) ${cut(String(c.message ?? "").split("\n")[0], 80)}`).join("\n");
    if (commits.length > 8) e.description += `\n… and ${commits.length - 8} more`;
  } else if (event === "issues" || event === "pull_request") {
    const obj = p.issue ?? p.pull_request ?? {};
    let action = p.action ?? "";
    if (event === "pull_request" && action === "closed" && obj.merged) action = "merged";
    if (!["opened", "closed", "reopened", "merged"].includes(action)) return null;
    const kind = event === "pull_request" ? "Pull request" : "Issue";
    e.title = cut(`[${repo}] ${kind} ${action}: #${obj.number} ${obj.title ?? ""}`, 250);
    e.url = obj.html_url;
    if (action === "opened") e.description = cut(obj.body ?? "", 300);
  } else if (event === "issue_comment") {
    if (p.action !== "created") return null;
    e.title = cut(`[${repo}] New comment on #${p.issue?.number}: ${p.issue?.title ?? ""}`, 250);
    e.url = p.comment?.html_url;
    e.description = cut(p.comment?.body ?? "", 400);
  } else if (event === "release") {
    if (p.action !== "published") return null;
    const r = p.release ?? {};
    e.title = cut(`[${repo}] Release ${r.tag_name ?? ""}: ${r.name ?? ""}`, 250);
    e.url = r.html_url;
    e.description = cut(r.body ?? "", 400);
  } else if (event === "star" && p.action === "created") {
    e.title = `⭐ ${sender} starred ${repo}`;
    e.url = p.repository?.html_url;
  } else if (event === "fork") {
    e.title = `🍴 ${sender} forked ${repo}`;
    e.url = p.forkee?.html_url;
  } else return null;
  return { text: "", embeds: [e] };
}

/** A Discord message object (the subset webhook clients read). */
export function messageJson(o: { id: string; channelId: string; webhookId: string; name: string; content: string; embeds: APIEmbed[]; timestamp?: Date; edited?: boolean }) {
  const ts = (o.timestamp ?? new Date()).toISOString();
  return {
    id: o.id, type: 0, content: o.content, channel_id: o.channelId, webhook_id: o.webhookId,
    author: { id: o.webhookId, username: o.name, avatar: null, discriminator: "0000", bot: true },
    attachments: [], embeds: o.embeds, mentions: [], mention_roles: [], mention_everyone: false, pinned: false,
    tts: false, flags: 0, components: [], timestamp: ts, edited_timestamp: o.edited ? ts : null,
  };
}
