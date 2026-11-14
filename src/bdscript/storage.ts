/** SQLite storage (node:sqlite) for BDScript variables and cooldowns. */
import { _openSqlite } from "../webhooks/store";

export const SCOPES = ["global", "user", "user_global", "server", "channel"] as const;

export class Storage {
  private db: any;
  constructor(public readonly file = "bdscript.db") {
    this.db = _openSqlite(file);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS vars (scope TEXT NOT NULL, name TEXT NOT NULL, key TEXT NOT NULL,
        value TEXT NOT NULL, PRIMARY KEY (scope, name, key));
      CREATE INDEX IF NOT EXISTS vars_name ON vars (scope, name);
      CREATE TABLE IF NOT EXISTS cooldowns (kind TEXT NOT NULL, command TEXT NOT NULL, key TEXT NOT NULL,
        until REAL NOT NULL, PRIMARY KEY (kind, command, key));
      CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);`);
  }
  get(scope: string, name: string, key: string): string | null {
    return this.db.prepare("SELECT value FROM vars WHERE scope=? AND name=? AND key=?").get(scope, name, key)?.value ?? null;
  }
  set(scope: string, name: string, key: string, value: string): void {
    this.db.prepare("INSERT OR REPLACE INTO vars VALUES (?,?,?,?)").run(scope, name, key, String(value));
  }
  delete(scope: string, name: string, key?: string | null): number {
    const r = key === undefined || key === null
      ? this.db.prepare("DELETE FROM vars WHERE scope=? AND name=?").run(scope, name)
      : this.db.prepare("DELETE FROM vars WHERE scope=? AND name=? AND key=?").run(scope, name, key);
    return Number(r.changes);
  }
  rows(scope: string, name: string, keyPrefix = ""): [string, string][] {
    return this.db.prepare("SELECT key, value FROM vars WHERE scope=? AND name=? AND key LIKE ? ESCAPE '\\'")
      .all(scope, name, keyPrefix.replace(/[\\%_]/g, (c) => "\\" + c) + "%").map((r: any) => [r.key, r.value]);
  }
  count(scope?: string): number {
    return Number((scope ? this.db.prepare("SELECT COUNT(*) AS n FROM vars WHERE scope=?").get(scope) : this.db.prepare("SELECT COUNT(*) AS n FROM vars").get()).n);
  }
  cooldownLeft(kind: string, command: string, key: string): number {
    const r = this.db.prepare("SELECT until FROM cooldowns WHERE kind=? AND command=? AND key=?").get(kind, command, key);
    return r ? Math.max(0, r.until - Date.now() / 1000) : 0;
  }
  setCooldown(kind: string, command: string, key: string, seconds: number): void {
    this.db.prepare("INSERT OR REPLACE INTO cooldowns VALUES (?,?,?,?)").run(kind, command, key, Date.now() / 1000 + seconds);
  }
  kvGet(key: string, def: string | null = null): string | null {
    return this.db.prepare("SELECT value FROM kv WHERE key=?").get(key)?.value ?? def;
  }
  kvSet(key: string, value: string): void {
    this.db.prepare("INSERT OR REPLACE INTO kv VALUES (?,?)").run(key, value);
  }
  close(): void {
    try {
      this.db.close();
    } catch {
      /* closed */
    }
  }
}
