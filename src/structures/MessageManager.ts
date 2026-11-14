import { Collection } from "../util/Collection";
import type { Message } from "./Message";
import type { BaseChannel, TextBasedChannel } from "./Channel";
import { value } from "../native";
import { NotFound } from "../errors";

export interface FetchMessagesOptions {
  limit?: number;
  before?: string | Message;
  after?: string | Message;
  around?: string;
  cache?: boolean;
}

const tsOf = (client: any, m: string | Message | undefined): number | null => {
  if (!m) return null;
  if (typeof m !== "string") return m.createdTimestamp;
  return client._state.messages.get(m)?.createdTimestamp ?? null;
};

/** `channel.messages`: cache + fetch (local store first, then relay sync for older community history). */
export class MessageManager {
  readonly cache = new Collection<string, Message>();
  constructor(public readonly channel: BaseChannel) {}

  get client() {
    return this.channel.client;
  }

  /** `fetch(id)` -> one message; `fetch({ limit, before, after })` -> newest first. */
  async fetch(options: string | FetchMessagesOptions = {}): Promise<any> {
    const client = this.client;
    if (typeof options === "string") {
      const data = await value(client._native(), "message", { message_id: options });
      if (!data) {
        const cached = client._state.messages.get(options);
        if (cached) return cached;
        throw new NotFound(`no message ${options}`);
      }
      return client._state.messageFromIncoming(data);
    }
    const [id, kind] = this.channel._target();
    const limit = Math.min(options.limit ?? 50, 1000);
    const beforeTs = tsOf(client, options.before);
    const afterTs = tsOf(client, options.after);
    let cursor: string | undefined = beforeTs !== null ? `${beforeTs}:${"0".repeat(64)}` : undefined;
    const out = new Collection<string, Message>();
    let synced = false;
    while (out.size < limit) {
      const page = Math.min(100, limit - out.size);
      const raw: any[] = await value(client._native(), "channel_history", { id, kind, limit: page, before: cursor });
      if (!raw.length) {
        if (kind !== "dm" && !synced) {
          synced = true;
          const got = await value(client._native(), "channel_sync", { id, max_events: 500, before: cursor }).catch(() => 0);
          if (got) continue;
        }
        break;
      }
      raw.sort((a, b) => (b.at ?? 0) - (a.at ?? 0) || String(b.id).localeCompare(String(a.id)));
      let stop = false;
      for (const r of raw) {
        if (afterTs !== null && (r.at ?? 0) <= afterTs) {
          stop = true;
          break;
        }
        const m = client._state.messageFromRaw(r, this.channel as TextBasedChannel);
        out.set(m.id, m);
        if (out.size >= limit) break;
      }
      const last = raw[raw.length - 1];
      cursor = `${last.at ?? 0}:${last.id ?? ""}`;
      if (stop || raw.length < page) {
        if (kind === "dm" || synced) break;
        synced = true;
        const got = await value(client._native(), "channel_sync", { id, max_events: 500, before: cursor }).catch(() => 0);
        if (!got) break;
      }
    }
    return out;
  }

  async delete(message: string | Message): Promise<void> {
    const m = typeof message === "string" ? await this.fetch(message) : message;
    await m.delete();
  }

  async react(message: string | Message, emoji: string): Promise<void> {
    const m = typeof message === "string" ? await this.fetch(message) : message;
    await m.react(emoji);
  }

  async edit(message: string | Message, options: any): Promise<Message> {
    const m = typeof message === "string" ? await this.fetch(message) : message;
    return m.edit(options);
  }

  async fetchPinned(): Promise<Collection<string, Message>> {
    return (this.channel as any).fetchPinned?.() ?? new Collection();
  }

  resolve(m: string | Message): Message | undefined {
    return typeof m === "string" ? this.cache.get(m) : m;
  }
}
