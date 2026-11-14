/**
 * A Discord-compatible webhook server for Vector, on plain `node:http`.
 *
 * Anything that can post to a Discord webhook (CI, Grafana, GitHub, uptime monitors, scripts) can post to a Vector
 * channel by swapping the URL for `https://your-host/api/webhooks/<id>/<token>`. Supported:
 *
 * - `POST /api/webhooks/{id}/{token}`: Discord execute (JSON, or multipart `payload_json` + files), `?wait=true`
 * - `POST …/slack` and `POST …/github`: Slack- and GitHub-format bodies
 * - `GET/PATCH/DELETE /api/webhooks/{id}/{token}`: the webhook itself
 * - `GET/PATCH/DELETE …/messages/{message_id}`: read, edit and delete messages the webhook sent
 * - `/api/v8`–`/api/v10` prefixes, `Retry-After` rate limiting, Discord-shaped JSON errors
 * - `/admin/webhooks`: create, list and delete webhooks with a bearer key; `/health`
 */
import * as http from "node:http";
import { timingSafeEqual } from "node:crypto";
import type { Client } from "../client/Client";
import type { WebhookStore, StoredWebhook } from "./store";
import { PayloadError, discordPayload, githubPayload, messageJson, slackPayload } from "./compat";
import { AttachmentBuilder } from "../sending";
import type { APIEmbed } from "../structures/Embed";
import type { Message } from "../structures/Message";

const RATE = { n: 5, per: 2000 }; // Discord's own per-webhook limit
const MAX_FILE = 25 * 1024 * 1024;
const MAX_BODY = 30 * 1024 * 1024;

class HttpError extends Error {
  constructor(public readonly status: number, message: string, public readonly code = 0) {
    super(message);
  }
}

class Limiter {
  private hits = new Map<string, number[]>();
  check(key: string): number | null {
    const now = Date.now();
    const q = (this.hits.get(key) ?? []).filter((t) => now - t <= RATE.per);
    this.hits.set(key, q);
    if (q.length >= RATE.n) return Math.round(RATE.per - (now - q[0])) / 1000;
    q.push(now);
    return null;
  }
}

interface Body {
  payload: any;
  files: { name: string; data: Buffer }[];
}

async function readRaw(req: http.IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > MAX_BODY) throw new HttpError(413, "Request entity too large", 40005);
    chunks.push(c as Buffer);
  }
  return Buffer.concat(chunks);
}

/** Minimal multipart/form-data parser (what webhook clients send). */
export function parseMultipart(raw: Buffer, boundary: string): { name: string; filename: string | null; data: Buffer }[] {
  const delim = Buffer.from(`--${boundary}`);
  const parts: { name: string; filename: string | null; data: Buffer }[] = [];
  let pos = raw.indexOf(delim);
  while (pos !== -1) {
    pos += delim.length;
    if (raw.slice(pos, pos + 2).toString() === "--") break;
    if (raw.slice(pos, pos + 2).toString() === "\r\n") pos += 2;
    const headEnd = raw.indexOf("\r\n\r\n", pos);
    if (headEnd === -1) break;
    const head = raw.slice(pos, headEnd).toString("utf8");
    const next = raw.indexOf(delim, headEnd + 4);
    if (next === -1) break;
    const data = raw.slice(headEnd + 4, next - 2); // strip the CRLF before the delimiter
    const name = /name="([^"]*)"/i.exec(head)?.[1] ?? "";
    const filename = /filename="([^"]*)"/i.exec(head)?.[1] ?? null;
    parts.push({ name, filename, data });
    pos = next;
  }
  return parts;
}

async function readBody(req: http.IncomingMessage): Promise<Body> {
  const ctype = req.headers["content-type"] ?? "";
  const raw = await readRaw(req);
  if (ctype.startsWith("multipart/form-data")) {
    const boundary = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(ctype);
    if (!boundary) throw new PayloadError("multipart body without a boundary", 50109);
    let payload: any = {};
    const files: Body["files"] = [];
    for (const p of parseMultipart(raw, boundary[1] ?? boundary[2])) {
      if (p.name === "payload_json") payload = JSON.parse(p.data.toString("utf8") || "{}");
      else if (p.filename !== null) {
        if (p.data.length > MAX_FILE) throw new PayloadError("files: file too large", 40005);
        files.push({ name: p.filename || p.name, data: p.data });
      } else if (p.name === "content") payload.content = p.data.toString("utf8");
    }
    return { payload, files };
  }
  if (ctype.startsWith("application/x-www-form-urlencoded")) {
    const form = new URLSearchParams(raw.toString("utf8"));
    return { payload: form.has("payload") ? JSON.parse(form.get("payload")!) : Object.fromEntries(form), files: [] };
  }
  if (!raw.length) return { payload: {}, files: [] };
  try {
    return { payload: JSON.parse(raw.toString("utf8")), files: [] };
  } catch {
    throw new PayloadError("Cannot parse request body as JSON", 50109);
  }
}

export interface WebhookServerOptions {
  /** Enables `/admin/webhooks` (Authorization: Bearer <key>). */
  adminKey?: string;
  /** Public URL shown in created hooks (default `client.webhookBaseUrl`). */
  baseUrl?: string;
}

/** Build the HTTP request handler. `client` is a logged-in (or logging-in) Vector `Client`. */
export function createWebhookHandler(client: Client, store: WebhookStore, options: WebhookServerOptions = {}): http.RequestListener {
  const limiter = new Limiter();
  const baseUrl = (options.baseUrl ?? client.webhookBaseUrl).replace(/\/+$/, "");
  const pub = (w: StoredWebhook) => ({ id: w.id, type: 1, name: w.name, avatar: null, channel_id: w.channelId, guild_id: w.communityId, application_id: null, token: null });

  const auth = (id: string, token: string): StoredWebhook => {
    const w = store.verify(id, token);
    if (w) return w;
    throw store.get(id) ? new HttpError(401, "Invalid Webhook Token", 50027) : new HttpError(404, "Unknown Webhook", 10015);
  };
  const channelFor = async (channelId: string): Promise<any> => {
    const ch = client.channels.resolve(channelId) ?? (await client.channels.fetch(channelId).catch(() => null));
    if (!ch || !("send" in ch)) throw new HttpError(404, "Unknown Channel", 10003);
    return ch;
  };
  const fetchMessage = async (w: StoredWebhook, mid: string): Promise<Message> => {
    const chan = store.messageChannel(mid, w.id);
    if (!chan) throw new HttpError(404, "Unknown Message", 10008);
    const ch = await channelFor(chan);
    const m = await ch.messages.fetch(mid).catch(() => null);
    if (!m) throw new HttpError(404, "Unknown Message", 10008);
    return m;
  };

  async function deliver(w: StoredWebhook, text: string, embeds: APIEmbed[], files: Body["files"], wait: boolean, shown?: string, username?: string) {
    if (!text && !embeds.length && !files.length) throw new HttpError(400, "Cannot send an empty message", 50006);
    const retry = limiter.check(w.id);
    if (retry !== null) return { status: 429, body: { message: "You are being rate limited.", code: 0, retry_after: retry, global: false }, headers: { "Retry-After": String(Math.ceil(retry)) } };
    const ch = await channelFor(w.channelId);
    let sent: Message | null = null;
    if (text || embeds.length) sent = await ch.send({ content: text || null, embeds });
    for (const f of files) sent = await ch.send({ files: [new AttachmentBuilder(f.data, { name: f.name })] });
    store.addMessage(sent!.id, w.id, w.channelId);
    if (!wait) return { status: 204 };
    return { status: 200, body: messageJson({ id: sent!.id, channelId: w.channelId, webhookId: w.id, name: username || w.name, content: shown ?? text, embeds }) };
  }

  const admin = (req: http.IncomingMessage) => {
    if (!options.adminKey) throw new HttpError(403, "admin API is disabled (no admin key configured)");
    const got = Buffer.from(String(req.headers.authorization ?? ""));
    const want = Buffer.from(`Bearer ${options.adminKey}`);
    if (got.length !== want.length || !timingSafeEqual(got, want)) throw new HttpError(401, "Unauthorized");
  };

  type Reply = { status: number; body?: unknown; headers?: Record<string, string> };
  async function route(req: http.IncomingMessage): Promise<Reply> {
    const url = new URL(req.url ?? "/", "http://x");
    const method = req.method ?? "GET";
    const wait = ["true", "1"].includes(url.searchParams.get("wait") ?? "");
    const p = url.pathname.replace(/\/+$/, "");

    if (p === "/health") return { status: 200, body: { ok: true, ready: client.isReady() } };

    if (p === "/admin/webhooks" && method === "POST") {
      admin(req);
      const { payload } = await readBody(req);
      const ch = await channelFor(String(payload.channel_id ?? ""));
      const { webhook, token } = store.create(String(payload.name || "webhook"), ch.id, ch.guild?.id ?? null, payload.created_by ?? null);
      return { status: 200, body: { ...pub(webhook), token, url: `${baseUrl}/api/webhooks/${webhook.id}/${token}` } };
    }
    if (p === "/admin/webhooks" && method === "GET") {
      admin(req);
      return { status: 200, body: store.list({ channelId: url.searchParams.get("channel_id") ?? undefined }).map(pub) };
    }
    const ad = /^\/admin\/webhooks\/(\d+)$/.exec(p);
    if (ad && method === "DELETE") {
      admin(req);
      if (!store.delete(ad[1])) throw new HttpError(404, "Unknown Webhook", 10015);
      return { status: 204 };
    }

    const m = /^\/api(?:\/v\d+)?\/webhooks\/(\d+)\/([\w\-.]+)(?:\/(slack|github)|\/messages\/([^/]+))?$/.exec(p);
    if (!m) throw new HttpError(404, "404: Not Found");
    const [, id, token, flavour, mid] = m;
    const w = auth(id, token);

    if (mid) {
      if (method === "GET") {
        const msg = await fetchMessage(w, mid);
        return { status: 200, body: messageJson({ id: msg.id, channelId: w.channelId, webhookId: w.id, name: w.name, content: msg.content, embeds: [], timestamp: msg.createdAt }) };
      }
      if (method === "PATCH") {
        const msg = await fetchMessage(w, mid);
        const { text, embeds } = discordPayload((await readBody(req)).payload);
        await msg.edit({ content: text || null, embeds: embeds.slice(0, 1) });
        return { status: 200, body: messageJson({ id: mid, channelId: w.channelId, webhookId: w.id, name: w.name, content: text, embeds, edited: true }) };
      }
      if (method === "DELETE") {
        const msg = await fetchMessage(w, mid);
        await msg.delete();
        store.dropMessage(mid);
        return { status: 204 };
      }
      throw new HttpError(405, "405: Method Not Allowed");
    }

    if (method === "POST") {
      const body = await readBody(req);
      if (flavour === "slack") {
        const { text, embeds } = slackPayload(body.payload);
        return deliver(w, text, embeds, body.files, wait);
      }
      if (flavour === "github") {
        const r = githubPayload(String(req.headers["x-github-event"] ?? ""), body.payload);
        if (!r) return { status: 204 }; // an event we don't render; GitHub just needs a 2xx
        return deliver(w, r.text, r.embeds, [], wait);
      }
      const { text, embeds } = discordPayload(body.payload);
      return deliver(w, text, embeds, body.files, wait, body.payload.content ?? "", body.payload.username);
    }
    if (flavour) throw new HttpError(405, "405: Method Not Allowed");
    if (method === "GET") return { status: 200, body: pub(w) };
    if (method === "PATCH") {
      const { payload } = await readBody(req);
      if (payload.name) {
        store.rename(w.id, String(payload.name));
        w.name = String(payload.name).slice(0, 80);
      }
      return { status: 200, body: pub(w) };
    }
    if (method === "DELETE") {
      store.delete(w.id);
      return { status: 204 };
    }
    throw new HttpError(405, "405: Method Not Allowed");
  }

  return (req, res) => {
    route(req)
      .catch((e): Reply => {
        if (e instanceof HttpError) return { status: e.status, body: { message: e.message, code: e.code } };
        if (e instanceof PayloadError) return { status: 400, body: { message: e.message, code: e.code } };
        if (e instanceof SyntaxError) return { status: 400, body: { message: "Cannot parse request body as JSON", code: 50109 } };
        client.emit("error", e);
        return { status: 500, body: { message: String(e?.message ?? e), code: 0 } };
      })
      .then((r) => {
        const headers: Record<string, string> = { ...(r.headers ?? {}) };
        if (r.body !== undefined) headers["Content-Type"] = "application/json";
        res.writeHead(r.status, headers);
        res.end(r.body !== undefined ? JSON.stringify(r.body) : undefined);
      });
  };
}

/** Start the server. Returns the `http.Server` (already listening). */
export function serveWebhooks(client: Client, options: WebhookServerOptions & { port?: number; host?: string; store?: WebhookStore } = {}): Promise<http.Server> {
  const store = options.store ?? client.webhookStore;
  const server = http.createServer(createWebhookHandler(client, store, options));
  return new Promise((resolve) => server.listen(options.port ?? 8080, options.host ?? "0.0.0.0", () => resolve(server)));
}
