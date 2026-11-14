/** discord.js formatters, producing Vector markdown. */

export const bold = (s: string) => `**${s}**`;
export const italic = (s: string) => `*${s}*`;
export const underline = (s: string) => `__${s}__`;
export const strikethrough = (s: string) => `~~${s}~~`;
export const spoiler = (s: string) => `||${s}||`;
export const inlineCode = (s: string) => `\`${s}\``;
export const codeBlock = (lang: string, code?: string) => (code === undefined ? `\`\`\`\n${lang}\n\`\`\`` : `\`\`\`${lang}\n${code}\n\`\`\``);
export const quote = (s: string) => `> ${s}`;
export const blockQuote = (s: string) => s.split("\n").map((l) => (l ? `> ${l}` : ">")).join("\n");
export const hyperlink = (text: string, url: string, title?: string) => (title ? `[${text}](${url} "${title}")` : `[${text}](${url})`);
export const hideLinkEmbed = (url: string) => `<${url}>`;
export const heading = (s: string, level: 1 | 2 | 3 = 1) => `${"#".repeat(level)} ${s}`;
export const subtext = (s: string) => `-# ${s}`;
/** A user mention: Vector uses NIP-27 `nostr:npub…`, which it renders as the name. */
export const userMention = (id: string) => `nostr:${id}`;
export const channelMention = (name: string) => `#${name}`;
export const roleMention = (name: string) => `@${name}`;
export const formatEmoji = (name: string) => `:${name.replace(/^:|:$/g, "")}:`;
export const TimestampStyles = { ShortTime: "t", LongTime: "T", ShortDate: "d", LongDate: "D", ShortDateTime: "f", LongDateTime: "F", RelativeTime: "R" } as const;
export function time(date?: Date | number, style?: string): string {
  const secs = date === undefined ? Math.floor(Date.now() / 1000) : date instanceof Date ? Math.floor(date.getTime() / 1000) : date;
  return style ? `<t:${secs}:${style}>` : `<t:${secs}>`;
}
/** Vector colour markup: `<color #59fcb3>text</color>`. */
export const color = (text: string, hex: string) => `<color ${hex}>${text}</color>`;
export const escapeMarkdown = (s: string) => s.replace(/([\\*_`~|>#\[\]()-])/g, "\\$1");
