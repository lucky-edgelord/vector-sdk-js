/** discord.js enums. Gateway concepts (intents, partials, shards) are accepted and ignored on Vector. */

export const Events = {
  ClientReady: "ready",
  Ready: "ready",
  MessageCreate: "messageCreate",
  MessageUpdate: "messageUpdate",
  MessageDelete: "messageDelete",
  MessageBulkDelete: "messageDeleteBulk",
  MessageReactionAdd: "messageReactionAdd",
  MessageReactionRemove: "messageReactionRemove",
  MessageReactionRemoveAll: "messageReactionRemoveAll",
  MessageReactionRemoveEmoji: "messageReactionRemoveEmoji",
  InteractionCreate: "interactionCreate",
  GuildCreate: "guildCreate",
  GuildDelete: "guildDelete",
  GuildUpdate: "guildUpdate",
  GuildMemberAdd: "guildMemberAdd",
  GuildMemberRemove: "guildMemberRemove",
  GuildMemberUpdate: "guildMemberUpdate",
  GuildBanAdd: "guildBanAdd",
  GuildBanRemove: "guildBanRemove",
  ChannelCreate: "channelCreate",
  ChannelDelete: "channelDelete",
  ChannelUpdate: "channelUpdate",
  ChannelPinsUpdate: "channelPinsUpdate",
  GuildRoleCreate: "roleCreate",
  GuildRoleDelete: "roleDelete",
  GuildRoleUpdate: "roleUpdate",
  TypingStart: "typingStart",
  UserUpdate: "userUpdate",
  VoiceStateUpdate: "voiceStateUpdate",
  InviteCreate: "inviteCreate",
  InviteDelete: "inviteDelete",
  Error: "error",
  Warn: "warn",
  Debug: "debug",
  ShardDisconnect: "shardDisconnect",
  ShardReconnecting: "shardReconnecting",
  ShardResume: "shardResume",
  Raw: "raw",
  // Vector-only
  CommunityChange: "communityChange",
  ChannelKeyed: "channelKeyed",
  MiniAppSession: "miniAppSession",
} as const;

function bits<T extends string>(names: readonly T[]): Record<T, number> {
  const out = {} as Record<T, number>;
  names.forEach((n, i) => (out[n] = 1 << i));
  return out;
}

export const GatewayIntentBits = bits([
  "Guilds", "GuildMembers", "GuildModeration", "GuildEmojisAndStickers", "GuildIntegrations", "GuildWebhooks",
  "GuildInvites", "GuildVoiceStates", "GuildPresences", "GuildMessages", "GuildMessageReactions",
  "GuildMessageTyping", "DirectMessages", "DirectMessageReactions", "DirectMessageTyping", "MessageContent",
  "GuildScheduledEvents", "AutoModerationConfiguration", "AutoModerationExecution", "GuildMessagePolls",
  "DirectMessagePolls",
] as const);
export const IntentsBitField = { Flags: GatewayIntentBits };

export enum Partials {
  User, Channel, GuildMember, Message, Reaction, GuildScheduledEvent, ThreadMember, SoundboardSound, Poll, PollAnswer,
}

export enum ChannelType {
  GuildText = 0, DM = 1, GuildVoice = 2, GroupDM = 3, GuildCategory = 4, GuildAnnouncement = 5,
  AnnouncementThread = 10, PublicThread = 11, PrivateThread = 12, GuildStageVoice = 13, GuildDirectory = 14,
  GuildForum = 15, GuildMedia = 16,
}

export enum ButtonStyle { Primary = 1, Secondary = 2, Success = 3, Danger = 4, Link = 5, Premium = 6 }

export enum ComponentType {
  ActionRow = 1, Button = 2, StringSelect = 3, TextInput = 4, UserSelect = 5, RoleSelect = 6, MentionableSelect = 7,
  ChannelSelect = 8, Section = 9, TextDisplay = 10, Thumbnail = 11, MediaGallery = 12, File = 13, Separator = 14,
  Container = 17,
}

export enum TextInputStyle { Short = 1, Paragraph = 2 }

export enum InteractionType { Ping = 1, ApplicationCommand = 2, MessageComponent = 3, ApplicationCommandAutocomplete = 4, ModalSubmit = 5 }

export enum ApplicationCommandType { ChatInput = 1, User = 2, Message = 3, PrimaryEntryPoint = 4 }

export enum ApplicationCommandOptionType {
  Subcommand = 1, SubcommandGroup = 2, String = 3, Integer = 4, Boolean = 5, User = 6, Channel = 7, Role = 8,
  Mentionable = 9, Number = 10, Attachment = 11,
}

export enum MessageFlags { Ephemeral = 1 << 6, SuppressEmbeds = 1 << 2, SuppressNotifications = 1 << 12, IsComponentsV2 = 1 << 15 }

export enum ActivityType { Playing = 0, Streaming = 1, Listening = 2, Watching = 3, Custom = 4, Competing = 5 }

export enum MessageType { Default = 0, Reply = 19, ChatInputCommand = 20 }

/** discord.js's `Colors`. Note: faux embeds always use Vector mint so they match the app. */
export const Colors = {
  Default: 0x000000, White: 0xffffff, Aqua: 0x1abc9c, Green: 0x57f287, Blue: 0x3498db, Yellow: 0xfee75c,
  Purple: 0x9b59b6, LuminousVividPink: 0xe91e63, Fuchsia: 0xeb459e, Gold: 0xf1c40f, Orange: 0xe67e22, Red: 0xed4245,
  Grey: 0x95a5a6, Navy: 0x34495e, DarkAqua: 0x11806a, DarkGreen: 0x1f8b4c, DarkBlue: 0x206694, DarkPurple: 0x71368a,
  DarkVividPink: 0xad1457, DarkGold: 0xc27c0e, DarkOrange: 0xa84300, DarkRed: 0x992d22, DarkGrey: 0x979c9f,
  DarkerGrey: 0x7f8c8d, LightGrey: 0xbcc0c0, DarkNavy: 0x2c3e50, Blurple: 0x5865f2, Greyple: 0x99aab5,
  DarkButNotBlack: 0x2c2f33, NotQuiteBlack: 0x23272a,
  /** Vector's accent */
  Vector: 0x59fcb3,
} as const;

export const VECTOR_ACCENT = "#59fcb3";

/** Reaction emoji used for buttons without an emoji (🇦 … 🇿) and select options (1️⃣ … 🔟). */
export const LETTER_EMOJI = Array.from({ length: 26 }, (_, i) => String.fromCodePoint(0x1f1e6 + i));
export const NUMBER_EMOJI = ["1️⃣", "2️⃣", "3️⃣", "4️⃣", "5️⃣", "6️⃣", "7️⃣", "8️⃣", "9️⃣", "🔟"];
