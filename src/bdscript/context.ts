/** Execution state for one run of a BDScript command. */
import { EmbedBuilder } from "../structures/Embed";
import type { Client } from "../client/Client";
import type { User } from "../structures/User";
import type { Guild } from "../structures/Guild";
import type { GuildMember } from "../structures/GuildMember";
import type { Message } from "../structures/Message";
import type { TextBasedChannel } from "../structures/Channel";
import type { BDBot, Command } from "./bot";

export interface ButtonSpec {
  kind: "button";
  customId: string;
  label: string;
  style: string;
  disabled: boolean;
  emoji: string | null;
  url: string | null;
  newRow: boolean;
}
export interface SelectSpec {
  kind: "select";
  customId: string;
  placeholder: string;
  minValues: number;
  maxValues: number;
  options: { label: string; value: string; description?: string; emoji?: string; default?: boolean }[];
  disabled: boolean;
}
export type ComponentSpec = ButtonSpec | SelectSpec;
export interface ModalSpec {
  customId: string;
  title: string;
  inputs: { id: string; label: string; style: string; placeholder?: string; value?: string; required?: boolean; min?: number; max?: number }[];
}

/** Everything the script asked to send (built by functions, sent at the end). */
export class Response {
  embeds = new Map<number, EmbedBuilder>();
  rows: ComponentSpec[][] = [[]];
  modal: ModalSpec | null = null;
  reactions: string[] = [];
  cmdReactions: string[] = [];
  files: { attachment: Buffer | string; name: string }[] = [];
  mentionAuthor = true;
  replyTo: string | null = null;
  replyMention = false;
  ephemeral = false;
  tts = false;
  deleteAfter: number | null = null;
  expiresIn: number | null = null;
  deleteCommandAfter: number | null = null;
  channelId: string | null = null;
  allowedUsers: string[] | null = null;
  allowedRoles: string[] | null = null;
  removeLinks = false;
  removeComponents = false;
  editTarget: string | null = null;
  defer = false;
  suppress = false;

  embed(index?: string | number | null): EmbedBuilder {
    let i = index === undefined || index === null || index === "" ? 1 : parseInt(String(index), 10);
    if (Number.isNaN(i)) i = 1;
    if (!this.embeds.has(i)) this.embeds.set(i, new EmbedBuilder());
    return this.embeds.get(i)!;
  }
  hasComponents(): boolean {
    return this.rows.some((r) => r.length > 0);
  }
  clearExtras(): void {
    this.embeds.clear();
    this.rows = [[]];
  }
}

export interface ContextInit {
  message?: Message | null;
  channel?: TextBasedChannel | null;
  author?: User | null;
  guild?: Guild | null;
  args?: string[];
  command?: Command | null;
  interaction?: any;
  extras?: Record<string, any>;
  mentionDefault?: boolean;
}

export class Context {
  readonly client: Client;
  message: Message | null;
  channel: TextBasedChannel | null;
  author: User | null;
  guild: Guild | null;
  args: string[];
  command: Command | null;
  interaction: any;
  extras: Record<string, any>;
  response = new Response();
  vars: Record<string, string> = {};
  keywords: Record<string, string> = {};
  split: string[] = [];
  json: any = null;
  http: { headers: Record<string, string>; result: string; status: number } = { headers: {}, result: "", status: 0 };
  error: Record<string, string> = {};
  suppressErrors: string | null = null;
  embedSuppressErrors: EmbedBuilder | null = null;
  innerSpaceRemoval = true;
  specialEscaping = true;
  readonly started = performance.now();
  asyncTasks = new Map<string, Promise<string>>();
  randomCache = new Map<string, string>();
  sentIds: string[] = [];
  depth = 0;
  loop: { index?: number; count?: number; value?: string; key?: string } = {};
  inErrorHandler = false;
  failure: string | null = null;

  constructor(public readonly bot: BDBot, o: ContextInit = {}) {
    this.client = bot.client;
    this.message = o.message ?? null;
    this.channel = o.channel ?? (o.message?.channel as TextBasedChannel | undefined) ?? null;
    this.author = o.author ?? o.message?.author ?? null;
    this.guild = o.guild !== undefined && o.guild !== null ? o.guild : ((this.channel as any)?.guild ?? null);
    this.args = [...(o.args ?? [])];
    this.command = o.command ?? null;
    this.interaction = o.interaction ?? null;
    this.extras = { ...(o.extras ?? {}) };
    this.response.mentionAuthor = o.mentionDefault ?? true;
  }

  get authorId(): string {
    return this.author?.id ?? "";
  }
  get channelId(): string {
    return this.channel?.id ?? "";
  }
  get guildId(): string {
    return this.guild?.id ?? "";
  }
  member(userId?: string): GuildMember | null {
    if (!this.guild) return null;
    const id = userId || this.authorId;
    return this.guild.members.cache.get(id) ?? (this.guild.members as any)._get(id);
  }
}
