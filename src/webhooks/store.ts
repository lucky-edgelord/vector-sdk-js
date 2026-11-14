/** SQLite storage for webhooks (tokens are stored hashed and shown once, at creation). Uses `node:sqlite`. */
import { createHash, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

export interface StoredWebhook {
  id: string;
  name: string;
  channelId: string;
  communityId: string | null;
  createdBy: string | null;
  createdAt: number;
}

const hash = (t: string) => createHash("sha256").update(t).digest("hex");

function openDb(file: string): any {
  const warn = process.emitWarning;
  // node:sqlite prints an ExperimentalWarning on first load; it's noise for bot owners.
  process.emitWarning = ((w: any, ...rest: any[]) => (String(w).includes("SQLite") ? undefined : (warn as any).call(process, w, ...rest))) as any;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { DatabaseSync } = require("node:sqlite");
    if (file !== ":memory:") fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
    return new DatabaseSync(file);
  } finally {
    process.emitWarning = warn;
  }
}
export { openDb as _openSqlite };

const COLS = "id, name, channel_id AS channelId, community_id AS communityId, created_by AS createdBy, created_at AS createdAt";

export class WebhookStore {
  private db: any;
  constructor(public readonly file = "webhooks.db") {
    this.db = openDb(file);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS webhooks (
        id TEXT PRIMARY KEY, token_hash TEXT NOT NULL, name TEXT NOT NULL, channel_id TEXT NOT NULL,
        community_id TEXT, created_by TEXT, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS messages (
        message_id TEXT PRIMARY KEY, webhook_id TEXT NOT NULL, channel_id TEXT NOT NULL);`);
  }
  private row(r: any): StoredWebhook | null {
    return r ? { ...r } : null;
  }
  /** Make a webhook; returns it with its secret token (only available now). */
  create(name: string, channelId: string, communityId: string | null = null, createdBy: string | null = null): { webhook: StoredWebhook; token: string } {
    // 19 digits so tools expecting Discord-shaped ids accept it
    const id = String(randomInt(1, 9)) + Array.from({ length: 18 }, () => randomInt(0, 10)).join("");
    const token = randomBytes(48).toString("base64url");
    const now = Math.floor(Date.now() / 1000);
    const n = (name || "webhook").slice(0, 80);
    this.db.prepare("INSERT INTO webhooks VALUES (?,?,?,?,?,?,?)").run(id, hash(token), n, channelId, communityId, createdBy, now);
    return { webhook: { id, name: n, channelId, communityId, createdBy, createdAt: now }, token };
  }
  verify(id: string, token: string): StoredWebhook | null {
    const r = this.db.prepare(`SELECT ${COLS}, token_hash AS th FROM webhooks WHERE id=?`).get(id);
    if (!r) return null;
    const a = Buffer.from(r.th), b = Buffer.from(hash(token));
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
    delete r.th;
    return this.row(r);
  }
  get(id: string): StoredWebhook | null {
    return this.row(this.db.prepare(`SELECT ${COLS} FROM webhooks WHERE id=?`).get(id));
  }
  list(filter: { channelId?: string; communityId?: string } = {}): StoredWebhook[] {
    const cond: string[] = [], args: string[] = [];
    if (filter.channelId) (cond.push("channel_id=?"), args.push(filter.channelId));
    if (filter.communityId) (cond.push("community_id=?"), args.push(filter.communityId));
    const q = `SELECT ${COLS} FROM webhooks${cond.length ? " WHERE " + cond.join(" AND ") : ""} ORDER BY created_at`;
    return this.db.prepare(q).all(...args).map((r: any) => ({ ...r }));
  }
  rename(id: string, name: string): void {
    this.db.prepare("UPDATE webhooks SET name=? WHERE id=?").run(name.slice(0, 80), id);
  }
  delete(id: string): boolean {
    const n = this.db.prepare("DELETE FROM webhooks WHERE id=?").run(id).changes;
    this.db.prepare("DELETE FROM messages WHERE webhook_id=?").run(id);
    return Number(n) > 0;
  }
  addMessage(messageId: string, webhookId: string, channelId: string): void {
    this.db.prepare("INSERT OR REPLACE INTO messages VALUES (?,?,?)").run(messageId, webhookId, channelId);
  }
  messageChannel(messageId: string, webhookId: string): string | null {
    return this.db.prepare("SELECT channel_id AS c FROM messages WHERE message_id=? AND webhook_id=?").get(messageId, webhookId)?.c ?? null;
  }
  dropMessage(messageId: string): void {
    this.db.prepare("DELETE FROM messages WHERE message_id=?").run(messageId);
  }
  close(): void {
    try {
      this.db.close();
    } catch {
      /* closed */
    }
  }
}
