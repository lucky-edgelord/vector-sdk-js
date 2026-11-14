/** Emoji: unicode characters, or Vector custom emoji from equipped packs (`:code:` with an image URL). */

const DISCORD_EMOJI = /^<a?:([\w~-]+):(\d*)>$/;

/** A custom emoji from an equipped pack (discord.js's `GuildEmoji`; `id` is its code). */
export class GuildEmoji {
  readonly id: string;
  readonly animated = false;
  readonly available = true;
  readonly managed = false;
  readonly requiresColons = true;
  constructor(public readonly name: string, public readonly url: string, public readonly pack: string | null = null) {
    this.id = name;
  }
  get identifier(): string {
    return `:${this.name}:`;
  }
  imageURL(): string {
    return this.url;
  }
  toString(): string {
    return `:${this.name}:`;
  }
}

export type EmojiResolvable = string | GuildEmoji | { name?: string | null; id?: string | null; url?: string | null };

/** Any emoji form -> what Vector reactions use: the character, or `:code:` for a custom emoji. */
export function normalizeEmoji(emoji: EmojiResolvable | null | undefined): string | null {
  if (emoji === null || emoji === undefined) return null;
  if (emoji instanceof GuildEmoji) return emoji.toString();
  if (typeof emoji === "object") {
    const name = emoji.name ?? emoji.id ?? "";
    const custom = Boolean(emoji.url) || (emoji.id && !/^\d*$/.test(emoji.id) ? false : Boolean(emoji.id));
    return custom || /^:.+:$/.test(name) ? `:${name.replace(/^:|:$/g, "")}:` : name;
  }
  const s = String(emoji).trim();
  const m = DISCORD_EMOJI.exec(s);
  if (m) return `:${m[1]}:`;
  return s;
}

export function isCustomEmoji(code: string): boolean {
  return code.length > 2 && code.startsWith(":") && code.endsWith(":");
}

/** Discord's custom-emoji markup in text (`<:wave:123>`) -> `:wave:`. */
export function convertDiscordEmojiMarkup(text: string): string {
  return text.replace(/<a?:([\w~-]+):\d*>/g, ":$1:");
}
