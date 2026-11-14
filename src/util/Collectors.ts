/** discord.js collectors over Vector events. */
import { EventEmitter } from "node:events";
import { Collection } from "./Collection";
import type { Client } from "../client/Client";
import type { Message, MessageReaction } from "../structures/Message";
import type { TextBasedChannel } from "../structures/Channel";
import type { User } from "../structures/User";

export interface CollectorOptions<T extends unknown[]> {
  filter?: (...args: T) => boolean | Promise<boolean>;
  time?: number;
  idle?: number;
  max?: number;
  dispose?: boolean;
}

export abstract class Collector<K, V, F extends unknown[] = []> extends EventEmitter {
  readonly collected = new Collection<K, V>();
  ended = false;
  endReason: string | null = null;
  private timer: NodeJS.Timeout | null = null;
  private idleTimer: NodeJS.Timeout | null = null;

  constructor(public readonly client: Client, public readonly options: CollectorOptions<[V, ...F]> & { max?: number } = {}) {
    super();
    if (options.time) this.timer = setTimeout(() => this.stop("time"), options.time).unref();
    if (options.idle) this.idleTimer = setTimeout(() => this.stop("idle"), options.idle).unref();
  }
  abstract collect(...args: any[]): K | null;

  /** @internal */
  async handleCollect(item: V, ...extra: F): Promise<void> {
    if (this.ended) return;
    const key = this.collect(item, ...extra);
    if (key === null) return;
    if (this.options.filter && !(await this.options.filter(item, ...extra))) return;
    this.collected.set(key, item);
    this.emit("collect", item, ...extra);
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = setTimeout(() => this.stop("idle"), this.options.idle!).unref();
    }
    if (this.options.max && this.collected.size >= this.options.max) this.stop("limit");
  }

  stop(reason = "user"): void {
    if (this.ended) return;
    this.ended = true;
    this.endReason = reason;
    if (this.timer) clearTimeout(this.timer);
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.cleanup();
    this.emit("end", this.collected, reason);
  }
  resetTimer(options: { time?: number; idle?: number } = {}): void {
    if (this.timer && (options.time ?? this.options.time)) {
      clearTimeout(this.timer);
      this.timer = setTimeout(() => this.stop("time"), options.time ?? this.options.time!).unref();
    }
  }
  protected abstract cleanup(): void;

  async *[Symbol.asyncIterator](): AsyncGenerator<V> {
    const queue: V[] = [];
    let wake: (() => void) | null = null;
    this.on("collect", (v: V) => (queue.push(v), wake?.()));
    this.once("end", () => wake?.());
    while (!this.ended || queue.length) {
      if (queue.length) yield queue.shift()!;
      else await new Promise<void>((r) => (wake = r));
    }
  }
}

export type MessageCollectorOptions = CollectorOptions<[Message]>;
export type AwaitMessagesOptions = MessageCollectorOptions & { errors?: string[] };

export class MessageCollector extends Collector<string, Message> {
  private readonly listener = (m: Message) => {
    if (m.channel.id === this.channel.id) void this.handleCollect(m);
  };
  constructor(public readonly channel: TextBasedChannel, options: MessageCollectorOptions = {}) {
    super(channel.client, options);
    this.client.on("messageCreate", this.listener);
  }
  collect(m: Message): string {
    return m.id;
  }
  protected cleanup(): void {
    this.client.off("messageCreate", this.listener);
  }
}

export type ReactionCollectorOptions = CollectorOptions<[MessageReaction, User]>;
export type AwaitReactionsOptions = ReactionCollectorOptions & { errors?: string[] };

export class ReactionCollector extends Collector<string, MessageReaction, [User]> {
  readonly users = new Collection<string, User>();
  private readonly listener = (r: MessageReaction, u: User) => {
    if (r.message.id === this.message.id) {
      this.users.set(u.id, u);
      void this.handleCollect(r, u);
    }
  };
  constructor(public readonly message: Message, options: ReactionCollectorOptions = {}) {
    super(message.client, options);
    this.client.on("messageReactionAdd", this.listener);
  }
  collect(r: MessageReaction): string {
    return r.emojiName;
  }
  protected cleanup(): void {
    this.client.off("messageReactionAdd", this.listener);
  }
}

export interface InteractionCollectorOptions extends CollectorOptions<[any]> {
  message?: Message;
  channel?: TextBasedChannel;
  componentType?: number;
  interactionType?: number;
}

export class InteractionCollector extends Collector<string, any> {
  private readonly listener = (i: any) => {
    const o = this.opts;
    if (o.message && i.message?.id !== o.message.id) return;
    if (o.channel && i.channel?.id !== o.channel.id) return;
    if (o.componentType && i.componentType !== o.componentType) return;
    void this.handleCollect(i);
  };
  constructor(client: Client, private readonly opts: InteractionCollectorOptions = {}) {
    super(client, opts);
    this.client.on("interactionCreate", this.listener);
  }
  collect(i: any): string {
    return i.id;
  }
  protected cleanup(): void {
    this.client.off("interactionCreate", this.listener);
  }
}
