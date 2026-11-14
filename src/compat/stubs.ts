/**
 * Discord-only names, so `require("discord.js")` destructuring doesn't explode. Constants are real values (harmless);
 * features Vector doesn't have throw {@link NotSupportedOnVector} when *used*, with a hint.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { NotSupportedOnVector } from "../errors";

function unsupported(name: string, hint = ""): any {
  const C = class {
    constructor() {
      throw new NotSupportedOnVector(name, hint);
    }
  };
  Object.defineProperty(C, "name", { value: name });
  return C;
}

export const ShardingManager = unsupported("ShardingManager", "Vector bots don't shard: run one Client.");
export const ShardClientUtil = unsupported("ShardClientUtil", "Vector bots don't shard.");
export const ThreadChannel = unsupported("ThreadChannel", "Vector has no threads; use a channel or replies.");
export const StageChannel = unsupported("StageChannel", "use a voice channel.");
export const GuildScheduledEvent = unsupported("GuildScheduledEvent");
export const AutoModerationRule = unsupported("AutoModerationRule");
export const Sticker = unsupported("Sticker", "send an image or a custom emoji instead.");
export const Poll = unsupported("Poll", "use a select menu (reactions) instead.");
export const Entitlement = unsupported("Entitlement");
export const SKU = unsupported("SKU");

/** Where `REST.put(Routes.applicationCommands(...))` saves commands; `Client.login()` registers them. */
export function commandsFile(): string {
  return process.env.VECTOR_COMMANDS_FILE ?? path.join(process.cwd(), ".vector-commands.json");
}

/**
 * `@discordjs/rest`'s `REST`, for the usual `deploy-commands.js` script. Vector registers commands when the bot
 * logs in, so `put(Routes.applicationCommands(…), { body })` writes them to `.vector-commands.json` and the bot
 * picks them up at its next `login()`. Every other route throws.
 */
export class REST {
  constructor(_options: unknown = {}) {}
  setToken(_token: string): this {
    return this;
  }
  async put(route: string, options: { body?: unknown } = {}): Promise<unknown> {
    if (/\/commands$/.test(route)) {
      const body = Array.isArray(options.body) ? options.body : [];
      fs.writeFileSync(commandsFile(), JSON.stringify(body, null, 2));
      return body.map((c: any) => ({ ...c, id: c.name }));
    }
    throw new NotSupportedOnVector(`REST PUT ${route}`, "use the Client's methods instead.");
  }
  async get(route: string): Promise<unknown> {
    if (/\/commands$/.test(route)) return fs.existsSync(commandsFile()) ? JSON.parse(fs.readFileSync(commandsFile(), "utf8")) : [];
    throw new NotSupportedOnVector(`REST GET ${route}`, "use the Client's methods instead.");
  }
  async post(route: string): Promise<never> {
    throw new NotSupportedOnVector(`REST POST ${route}`, "use the Client's methods instead.");
  }
  async patch(route: string): Promise<never> {
    throw new NotSupportedOnVector(`REST PATCH ${route}`, "use the Client's methods instead.");
  }
  async delete(route: string): Promise<unknown> {
    if (/\/commands(\/[^/]+)?$/.test(route)) return null;
    throw new NotSupportedOnVector(`REST DELETE ${route}`, "use the Client's methods instead.");
  }
}

export const Routes = {
  applicationCommands: (appId: string) => `/applications/${appId}/commands`,
  applicationGuildCommands: (appId: string, guildId: string) => `/applications/${appId}/guilds/${guildId}/commands`,
  applicationCommand: (appId: string, id: string) => `/applications/${appId}/commands/${id}`,
  applicationGuildCommand: (appId: string, guildId: string, id: string) => `/applications/${appId}/guilds/${guildId}/commands/${id}`,
  channelMessages: (id: string) => `/channels/${id}/messages`,
  channelMessage: (id: string, m: string) => `/channels/${id}/messages/${m}`,
  guild: (id: string) => `/guilds/${id}`,
  user: (id = "@me") => `/users/${id}`,
};

// -- constants (real values; used only for comparisons/config) ---------------------------------------------------
export enum PresenceUpdateStatus { Online = "online", DoNotDisturb = "dnd", Idle = "idle", Invisible = "invisible", Offline = "offline" }
export enum ThreadAutoArchiveDuration { OneHour = 60, OneDay = 1440, ThreeDays = 4320, OneWeek = 10080 }
export enum GuildVerificationLevel { None = 0, Low = 1, Medium = 2, High = 3, VeryHigh = 4 }
export enum GuildDefaultMessageNotifications { AllMessages = 0, OnlyMentions = 1 }
export enum GuildExplicitContentFilter { Disabled = 0, MembersWithoutRoles = 1, AllMembers = 2 }
export enum AuditLogEvent { GuildUpdate = 1, ChannelCreate = 10, ChannelUpdate = 11, ChannelDelete = 12, MemberKick = 20, MemberBanAdd = 22, MemberBanRemove = 23, MemberUpdate = 24, MemberRoleUpdate = 25, RoleCreate = 30, RoleUpdate = 31, RoleDelete = 32, InviteCreate = 40, InviteDelete = 42, MessageDelete = 72, MessagePin = 74, MessageUnpin = 75 }
export enum Locale { EnglishUS = "en-US", EnglishGB = "en-GB", German = "de", French = "fr", Spanish = "es-ES", Japanese = "ja" }
export enum StickerFormatType { PNG = 1, APNG = 2, Lottie = 3, GIF = 4 }
export enum WebhookType { Incoming = 1, ChannelFollower = 2, Application = 3 }
export enum OverwriteType { Role = 0, Member = 1 }
export enum InteractionContextType { Guild = 0, BotDM = 1, PrivateChannel = 2 }
export enum ApplicationIntegrationType { GuildInstall = 0, UserInstall = 1 }
export const UserFlags = {} as Record<string, number>;
export const ChannelFlags = {} as Record<string, number>;
export const Options = {
  cacheWithLimits: (_o: unknown) => undefined,
  cacheEverything: () => undefined,
  DefaultMakeCacheSettings: {},
  DefaultSweeperSettings: {},
};
export const Status = { Ready: 0, Connecting: 1, Reconnecting: 2, Idle: 3, Nearly: 4, Disconnected: 5 };
