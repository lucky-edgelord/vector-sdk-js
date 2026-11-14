/**
 * vector-sdk: a discord.js-compatible SDK for Vector bots (unofficial; not affiliated with Discord or discord.js).
 */
export { Client, ChannelManager, UserManager, ClientEmojiManager, ApplicationCommand, ApplicationCommandManager, ClientApplication, MiniAppSession, MiniAppManager, type ClientOptions } from "./client/Client";
export { State } from "./client/State";
export { setNativeModule, native as nativeModule, type NativeBot, type NativeModule } from "./native";
export * from "./errors";
export { Collection } from "./util/Collection";
export * from "./util/Constants";
export * from "./util/PermissionsBitField";
export * from "./util/Formatters";
export * from "./util/Collectors";
export { Base } from "./structures/Base";
export * from "./structures/User";
export * from "./structures/Role";
export * from "./structures/GuildMember";
export * from "./structures/Guild";
export * from "./structures/Channel";
export * from "./structures/MessageManager";
export * from "./structures/Message";
export * from "./structures/Emoji";
export * from "./structures/Embed";
export * from "./structures/Components";
export * from "./structures/SlashCommand";
export * from "./structures/Interaction";
export * from "./structures/Webhook";
export * from "./structures/Voice";
export { AttachmentBuilder, MessagePayload, type MessageCreateOptions, type MessageEditOptions, type FileInput, type BufferResolvable } from "./sending";

/** discord.js exports `version`; this is the vector-sdk version. */
function readVersion(): string {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  for (const p of ["../package.json", "../../package.json"]) try { return require(p).version; } catch { /* next layout */ }
  return "0.0.0";
}
export const version: string = readVersion();
