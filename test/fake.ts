/** A fake native module: records calls, answers with canned values, and lets tests push events. */
import { setNativeModule, type NativeBot, type NativeModule, type CallResult } from "../src/native";
import { Client } from "../src/client/Client";

export const BOT = "npub1" + "b".repeat(58);
export const ALICE = "npub1" + "a".repeat(58);
export const COMMUNITY = "c".repeat(64);
export const CHANNEL = "d".repeat(64);

export class FakeBot implements NativeBot {
  readonly npub = BOT;
  calls: { method: string; args: any; data?: Buffer | null }[] = [];
  commands: { name: string; description: string; args: any }[] = [];
  handlers: Record<string, (args: any, data?: Buffer | null) => any> = {};
  private queue: any[] = [];
  private waiters: ((ev: any) => void)[] = [];
  private nextId = 1;
  stopped = false;

  constructor() {
    this.handlers = {
      communities: () => [COMMUNITY],
      community_name: () => "Test Community",
      community_description: () => "A test",
      community_owner: () => BOT,
      community_channel_infos: () => [{ channel_id: CHANNEL, name: "🤖┊bot-test", category_id: null, private: false, topic: "", view: "chat" }],
      community_channels: () => [{ channel_id: CHANNEL, name: "🤖┊bot-test", private: false, readable: true }],
      community_categories: () => [],
      community_roles: () => [],
      community_everyone_permissions: () => 0,
      community_members: () => [ALICE, BOT],
      community_admins: () => [],
      member_roles: () => [],
      community_nicknames: () => ({}),
      community_timeouts: () => ({}),
      channel_community: () => COMMUNITY,
      channel_send: (a) => this.sent(a),
      channel_send_bytes: (a) => this.sent(a),
      channel_react: () => null,
      message: () => null,
      cached_profile: (a) => ({ name: a.npub === ALICE ? "alice" : "bot" }),
      fetch_profile: (a) => ({ name: a.npub === ALICE ? "alice" : "bot" }),
      emojis: () => [],
      channel_typing: () => null,
    };
  }
  private sent(a: any): string {
    return `m${this.nextId++}`;
  }
  sentTexts(): string[] {
    return this.calls.filter((c) => c.method === "channel_send").map((c) => c.args.text);
  }
  async start(): Promise<void> {
    await new Promise<void>((r) => {
      const check = () => (this.stopped ? r() : setTimeout(check, 20));
      check();
    });
  }
  push(ev: any): void {
    const w = this.waiters.shift();
    if (w) w(ev);
    else this.queue.push(ev);
  }
  async nextEvent(): Promise<any> {
    if (this.queue.length) return this.queue.shift();
    if (this.stopped) return null;
    return new Promise((r) => this.waiters.push(r));
  }
  stop(): void {
    this.stopped = true;
    for (const w of this.waiters.splice(0)) w(null);
  }
  async logout(): Promise<void> {}
  registerCommand(name: string, description: string, args: unknown): void {
    this.commands.push({ name, description, args });
  }
  async call(method: string, args?: any, data?: Buffer | null): Promise<CallResult> {
    this.calls.push({ method, args, data });
    const h = this.handlers[method];
    return { value: h ? h(args ?? {}, data) : null, bytes: null };
  }
}

export function fakeModule(bot: FakeBot): NativeModule {
  return {
    NativeBot: { build: async () => bot },
    sdkVersion: () => "0.0.0-test",
    features: () => [],
    generateNsec: () => "nsec1test",
  };
}

/** A logged-in client wired to a fake bot, already "ready". */
export async function readyClient(options: Record<string, unknown> = {}): Promise<{ client: Client; bot: FakeBot }> {
  const bot = new FakeBot();
  setNativeModule(fakeModule(bot));
  const client = new Client({ replyOrdering: false, ...options });
  const ready = new Promise((r) => client.once("ready", r));
  await client.login("nsec1" + "x".repeat(58));
  bot.push({ type: "ready", communities: [COMMUNITY] });
  await ready;
  return { client, bot };
}

let n = 0;
/** An incoming community message event. */
export function messageEvent(content: string, author = ALICE, extra: Record<string, unknown> = {}) {
  n++;
  return {
    type: "message",
    message: {
      chat_id: CHANNEL, is_group: true, is_file: false, author, community_id: COMMUNITY,
      message: { id: `in${n}`, content, at: Date.now(), mine: false, npub: author, attachments: [], reactions: [], replied_to: "", ...extra },
    },
  };
}

export const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));
