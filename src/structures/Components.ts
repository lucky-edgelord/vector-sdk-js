/**
 * Message components, discord.js-style. Vector has no buttons, so they become **reaction buttons**:
 * each button is a reaction under the message (its emoji, or a letter 🇦🇧… when it has none), and each select-menu
 * option is a numbered reaction (1️⃣2️⃣…). Tapping one emits `interactionCreate` with a ButtonInteraction or
 * StringSelectMenuInteraction carrying the `customId` (and `values`), so handlers port unchanged.
 */
import { ButtonStyle, ComponentType, LETTER_EMOJI, NUMBER_EMOJI, TextInputStyle } from "../util/Constants";
import { normalizeEmoji, type EmojiResolvable } from "./Emoji";

export interface APIButton {
  type: ComponentType.Button;
  style: ButtonStyle;
  label?: string;
  emoji?: string;
  custom_id?: string;
  url?: string;
  disabled?: boolean;
}
export interface APISelectOption {
  label: string;
  value: string;
  description?: string;
  emoji?: string;
  default?: boolean;
}
export interface APISelect {
  type: ComponentType.StringSelect | ComponentType.UserSelect | ComponentType.RoleSelect | ComponentType.ChannelSelect | ComponentType.MentionableSelect;
  custom_id: string;
  placeholder?: string;
  options?: APISelectOption[];
  min_values?: number;
  max_values?: number;
  disabled?: boolean;
}
export interface APITextInput {
  type: ComponentType.TextInput;
  custom_id: string;
  label: string;
  style: TextInputStyle;
  placeholder?: string;
  value?: string;
  required?: boolean;
  min_length?: number;
  max_length?: number;
}
export type APIComponent = APIButton | APISelect | APITextInput;
export interface APIActionRow<T extends APIComponent = APIComponent> {
  type: ComponentType.ActionRow;
  components: T[];
}

const emojiOf = (e: EmojiResolvable | undefined | null): string | undefined => normalizeEmoji(e) ?? undefined;

export class ButtonBuilder {
  data: APIButton;
  constructor(data: Partial<APIButton> = {}) {
    this.data = { type: ComponentType.Button, style: ButtonStyle.Secondary, ...data } as APIButton;
  }
  setCustomId(id: string): this {
    this.data.custom_id = id;
    return this;
  }
  setLabel(label: string): this {
    this.data.label = label;
    return this;
  }
  setStyle(style: ButtonStyle): this {
    this.data.style = style;
    return this;
  }
  setEmoji(emoji: EmojiResolvable): this {
    this.data.emoji = emojiOf(emoji);
    return this;
  }
  setURL(url: string): this {
    this.data.url = url;
    this.data.style = ButtonStyle.Link;
    return this;
  }
  setDisabled(disabled = true): this {
    this.data.disabled = disabled;
    return this;
  }
  setSKUId(_id: string): this {
    return this;
  }
  toJSON(): APIButton {
    return { ...this.data };
  }
}

export class StringSelectMenuOptionBuilder {
  data: Partial<APISelectOption>;
  constructor(data: Partial<APISelectOption> = {}) {
    this.data = { ...data };
  }
  setLabel(label: string): this {
    this.data.label = label;
    return this;
  }
  setValue(value: string): this {
    this.data.value = value;
    return this;
  }
  setDescription(description: string): this {
    this.data.description = description;
    return this;
  }
  setEmoji(emoji: EmojiResolvable): this {
    this.data.emoji = emojiOf(emoji);
    return this;
  }
  setDefault(isDefault = true): this {
    this.data.default = isDefault;
    return this;
  }
  toJSON(): APISelectOption {
    return { label: this.data.label ?? "", value: this.data.value ?? this.data.label ?? "", ...this.data } as APISelectOption;
  }
}

type OptionInput = APISelectOption | StringSelectMenuOptionBuilder | Partial<APISelectOption>;
const toOption = (o: OptionInput): APISelectOption => {
  const d = o instanceof StringSelectMenuOptionBuilder ? o.toJSON() : (o as APISelectOption);
  return { ...d, value: d.value ?? d.label, emoji: d.emoji ? emojiOf(d.emoji) : undefined };
};

export class StringSelectMenuBuilder {
  data: APISelect;
  constructor(data: Partial<APISelect> = {}) {
    this.data = { type: ComponentType.StringSelect, custom_id: "", options: [], ...data } as APISelect;
  }
  setCustomId(id: string): this {
    this.data.custom_id = id;
    return this;
  }
  setPlaceholder(text: string): this {
    this.data.placeholder = text;
    return this;
  }
  setMinValues(n: number): this {
    this.data.min_values = n;
    return this;
  }
  setMaxValues(n: number): this {
    this.data.max_values = n;
    return this;
  }
  setDisabled(disabled = true): this {
    this.data.disabled = disabled;
    return this;
  }
  addOptions(...options: (OptionInput | OptionInput[])[]): this {
    (this.data.options ??= []).push(...options.flat().map(toOption));
    return this;
  }
  setOptions(...options: (OptionInput | OptionInput[])[]): this {
    this.data.options = options.flat().map(toOption);
    return this;
  }
  spliceOptions(index: number, deleteCount: number, ...options: OptionInput[]): this {
    (this.data.options ??= []).splice(index, deleteCount, ...options.map(toOption));
    return this;
  }
  toJSON(): APISelect {
    return { ...this.data, options: [...(this.data.options ?? [])] };
  }
}
/** Older discord.js name. */
export const SelectMenuBuilder = StringSelectMenuBuilder;

/**
 * User/role/channel/mentionable selects: on Vector they're option menus too. Fill them with `addOptions()`
 * (e.g. from `guild.roles.cache`); without options they render nothing.
 */
export class UserSelectMenuBuilder extends StringSelectMenuBuilder {
  constructor(data: Partial<APISelect> = {}) {
    super({ ...data, type: ComponentType.UserSelect });
  }
}
export class RoleSelectMenuBuilder extends StringSelectMenuBuilder {
  constructor(data: Partial<APISelect> = {}) {
    super({ ...data, type: ComponentType.RoleSelect });
  }
}
export class ChannelSelectMenuBuilder extends StringSelectMenuBuilder {
  constructor(data: Partial<APISelect> = {}) {
    super({ ...data, type: ComponentType.ChannelSelect });
  }
  setChannelTypes(..._types: unknown[]): this {
    return this;
  }
}
export class MentionableSelectMenuBuilder extends StringSelectMenuBuilder {
  constructor(data: Partial<APISelect> = {}) {
    super({ ...data, type: ComponentType.MentionableSelect });
  }
}

export class TextInputBuilder {
  data: APITextInput;
  constructor(data: Partial<APITextInput> = {}) {
    this.data = { type: ComponentType.TextInput, custom_id: "", label: "", style: TextInputStyle.Short, ...data } as APITextInput;
  }
  setCustomId(id: string): this {
    this.data.custom_id = id;
    return this;
  }
  setLabel(label: string): this {
    this.data.label = label;
    return this;
  }
  setStyle(style: TextInputStyle): this {
    this.data.style = style;
    return this;
  }
  setPlaceholder(p: string): this {
    this.data.placeholder = p;
    return this;
  }
  setValue(v: string): this {
    this.data.value = v;
    return this;
  }
  setRequired(r = true): this {
    this.data.required = r;
    return this;
  }
  setMinLength(n: number): this {
    this.data.min_length = n;
    return this;
  }
  setMaxLength(n: number): this {
    this.data.max_length = n;
    return this;
  }
  toJSON(): APITextInput {
    return { ...this.data };
  }
}

type AnyBuilder = ButtonBuilder | StringSelectMenuBuilder | TextInputBuilder;
type ComponentInput = AnyBuilder | APIComponent;
const toComponent = (c: ComponentInput): APIComponent => ("toJSON" in c ? (c as AnyBuilder).toJSON() : c);

export class ActionRowBuilder<T extends ComponentInput = ComponentInput> {
  components: T[];
  constructor(data: { components?: T[] } = {}) {
    this.components = [...(data.components ?? [])];
  }
  addComponents(...components: (T | T[])[]): this {
    this.components.push(...(components.flat() as T[]));
    return this;
  }
  setComponents(...components: (T | T[])[]): this {
    this.components = components.flat() as T[];
    return this;
  }
  toJSON(): APIActionRow {
    return { type: ComponentType.ActionRow, components: this.components.map(toComponent) };
  }
}

/** A received action row (read back from our own sent messages). */
export class ActionRow {
  constructor(public readonly data: APIActionRow) {}
  get components() {
    return this.data.components;
  }
  toJSON() {
    return this.data;
  }
}

export class ModalBuilder {
  data: { custom_id: string; title: string; components: APIActionRow<APITextInput>[] };
  constructor() {
    this.data = { custom_id: "", title: "", components: [] };
  }
  setCustomId(id: string): this {
    this.data.custom_id = id;
    return this;
  }
  setTitle(title: string): this {
    this.data.title = title;
    return this;
  }
  addComponents(...rows: (ActionRowBuilder<TextInputBuilder> | APIActionRow<APITextInput> | (ActionRowBuilder<TextInputBuilder> | APIActionRow<APITextInput>)[])[]): this {
    for (const r of rows.flat()) this.data.components.push((r instanceof ActionRowBuilder ? r.toJSON() : r) as APIActionRow<APITextInput>);
    return this;
  }
  setComponents(...rows: Parameters<ModalBuilder["addComponents"]>): this {
    this.data.components = [];
    return this.addComponents(...rows);
  }
  /** Text inputs in order. */
  get inputs(): APITextInput[] {
    return this.data.components.flatMap((r) => r.components);
  }
  toJSON() {
    return this.data;
  }
}

export type RowInput = ActionRowBuilder<any> | APIActionRow | { components: ComponentInput[] };

// ---------------------------------------------------------------------------------------------------------------------
// rendering as reactions
// ---------------------------------------------------------------------------------------------------------------------

export interface ReactionTarget {
  kind: "button" | "select";
  customId: string;
  componentType: ComponentType;
  /** select option value */
  value?: string;
  /** select config */
  maxValues?: number;
}

export interface RenderedComponents {
  /** reactions to add, in order */
  emojis: string[];
  /** text lines for link buttons, letter-labelled buttons and select menus */
  legend: string;
  /** emoji -> what it triggers */
  targets: Map<string, ReactionTarget>;
  rows: APIActionRow[];
}

export function toRows(rows: RowInput[] | undefined): APIActionRow[] {
  return (rows ?? []).map((r) =>
    r instanceof ActionRowBuilder ? r.toJSON() : { type: ComponentType.ActionRow, components: (r.components as ComponentInput[]).map(toComponent) },
  );
}

export function renderComponents(input: RowInput[] | undefined): RenderedComponents {
  const rows = toRows(input);
  const emojis: string[] = [];
  const legend: string[] = [];
  const targets = new Map<string, ReactionTarget>();
  const used = new Set<string>();
  for (const row of rows) for (const c of row.components) if (c.type === ComponentType.Button && c.emoji) used.add(c.emoji);
  const letters = LETTER_EMOJI.filter((e) => !used.has(e));
  for (const row of rows) {
    for (const c of row.components) {
      if (c.type === ComponentType.Button) {
        if (c.url) {
          legend.push(`🔗 [${c.label ?? c.url}](<${c.url}>)`);
          continue;
        }
        let emoji = c.emoji;
        if (!emoji) {
          emoji = letters.shift() ?? "🔘";
          // no emoji of its own: a letter reaction needs its label beside it
          if (c.label) legend.push(c.disabled ? `~~${emoji} ${c.label}~~` : `${emoji} ${c.label}`);
        }
        if (c.disabled) continue;
        emojis.push(emoji);
        targets.set(emoji, { kind: "button", customId: c.custom_id ?? "", componentType: ComponentType.Button });
      } else if (c.type !== ComponentType.TextInput) {
        const opts = c.options ?? [];
        if (!opts.length) continue;
        if (c.placeholder) legend.push(`**${c.placeholder}**`);
        opts.forEach((o, i) => {
          const emoji = o.emoji || (i < NUMBER_EMOJI.length ? NUMBER_EMOJI[i] : LETTER_EMOJI[i - NUMBER_EMOJI.length]);
          let line = `${emoji} ${o.label}`;
          if (o.description) line += ` — *${o.description}*`;
          legend.push(c.disabled ? `~~${line}~~` : line);
          if (!c.disabled) {
            emojis.push(emoji);
            targets.set(emoji, { kind: "select", customId: c.custom_id, componentType: c.type, value: o.value, maxValues: c.max_values ?? 1 });
          }
        });
      }
    }
  }
  return { emojis, legend: legend.join("\n"), targets, rows };
}
