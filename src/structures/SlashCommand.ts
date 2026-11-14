/**
 * Slash commands. Vector has native `/` commands (shown in the app's picker); `SlashCommandBuilder` maps onto them.
 * Option types: string, integer, number, boolean, user, and choices. Subcommands become `name sub` handled by the
 * library (Vector itself has no subcommand level).
 */
import { ApplicationCommandOptionType } from "../util/Constants";

export interface APICommandOption {
  type: ApplicationCommandOptionType;
  name: string;
  description: string;
  required?: boolean;
  choices?: { name: string; value: string | number }[];
  options?: APICommandOption[];
  autocomplete?: boolean;
  min_value?: number;
  max_value?: number;
  min_length?: number;
  max_length?: number;
}

export interface APICommand {
  name: string;
  description: string;
  options?: APICommandOption[];
  default_member_permissions?: string | null;
  dm_permission?: boolean;
  nsfw?: boolean;
}

class OptionBuilder {
  data: APICommandOption;
  constructor(type: ApplicationCommandOptionType) {
    this.data = { type, name: "", description: "" };
  }
  setName(name: string): this {
    this.data.name = name;
    return this;
  }
  setDescription(d: string): this {
    this.data.description = d;
    return this;
  }
  setRequired(r = true): this {
    this.data.required = r;
    return this;
  }
  setNameLocalizations(_l: unknown): this {
    return this;
  }
  setDescriptionLocalizations(_l: unknown): this {
    return this;
  }
  toJSON(): APICommandOption {
    return { ...this.data };
  }
}
class ChoiceOptionBuilder<T extends string | number> extends OptionBuilder {
  addChoices(...choices: ({ name: string; value: T } | { name: string; value: T }[])[]): this {
    (this.data.choices ??= []).push(...choices.flat());
    return this;
  }
  setChoices(...choices: ({ name: string; value: T } | { name: string; value: T }[])[]): this {
    this.data.choices = choices.flat();
    return this;
  }
  setAutocomplete(a = true): this {
    this.data.autocomplete = a;
    return this;
  }
}
export class SlashCommandStringOption extends ChoiceOptionBuilder<string> {
  constructor() {
    super(ApplicationCommandOptionType.String);
  }
  setMinLength(n: number): this {
    this.data.min_length = n;
    return this;
  }
  setMaxLength(n: number): this {
    this.data.max_length = n;
    return this;
  }
}
export class SlashCommandIntegerOption extends ChoiceOptionBuilder<number> {
  constructor() {
    super(ApplicationCommandOptionType.Integer);
  }
  setMinValue(n: number): this {
    this.data.min_value = n;
    return this;
  }
  setMaxValue(n: number): this {
    this.data.max_value = n;
    return this;
  }
}
export class SlashCommandNumberOption extends SlashCommandIntegerOption {
  constructor() {
    super();
    this.data.type = ApplicationCommandOptionType.Number;
  }
}
export class SlashCommandBooleanOption extends OptionBuilder {
  constructor() {
    super(ApplicationCommandOptionType.Boolean);
  }
}
export class SlashCommandUserOption extends OptionBuilder {
  constructor() {
    super(ApplicationCommandOptionType.User);
  }
}
/** Channel/role/mentionable/attachment options become strings on Vector (a name or id typed by the user). */
export class SlashCommandChannelOption extends OptionBuilder {
  constructor() {
    super(ApplicationCommandOptionType.Channel);
  }
  addChannelTypes(..._t: unknown[]): this {
    return this;
  }
}
export class SlashCommandRoleOption extends OptionBuilder {
  constructor() {
    super(ApplicationCommandOptionType.Role);
  }
}
export class SlashCommandMentionableOption extends OptionBuilder {
  constructor() {
    super(ApplicationCommandOptionType.Mentionable);
  }
}
export class SlashCommandAttachmentOption extends OptionBuilder {
  constructor() {
    super(ApplicationCommandOptionType.Attachment);
  }
}

type Adder<T> = T | ((b: T) => T);
const build = <T>(Cls: new () => T, input: Adder<T>): T => (typeof input === "function" ? (input as (b: T) => T)(new Cls()) : input);

class OptionsHolder {
  options: OptionBuilder[] = [];
  addStringOption(o: Adder<SlashCommandStringOption>): this {
    this.options.push(build(SlashCommandStringOption, o));
    return this;
  }
  addIntegerOption(o: Adder<SlashCommandIntegerOption>): this {
    this.options.push(build(SlashCommandIntegerOption, o));
    return this;
  }
  addNumberOption(o: Adder<SlashCommandNumberOption>): this {
    this.options.push(build(SlashCommandNumberOption, o));
    return this;
  }
  addBooleanOption(o: Adder<SlashCommandBooleanOption>): this {
    this.options.push(build(SlashCommandBooleanOption, o));
    return this;
  }
  addUserOption(o: Adder<SlashCommandUserOption>): this {
    this.options.push(build(SlashCommandUserOption, o));
    return this;
  }
  addChannelOption(o: Adder<SlashCommandChannelOption>): this {
    this.options.push(build(SlashCommandChannelOption, o));
    return this;
  }
  addRoleOption(o: Adder<SlashCommandRoleOption>): this {
    this.options.push(build(SlashCommandRoleOption, o));
    return this;
  }
  addMentionableOption(o: Adder<SlashCommandMentionableOption>): this {
    this.options.push(build(SlashCommandMentionableOption, o));
    return this;
  }
  addAttachmentOption(o: Adder<SlashCommandAttachmentOption>): this {
    this.options.push(build(SlashCommandAttachmentOption, o));
    return this;
  }
}

export class SlashCommandSubcommandBuilder extends OptionsHolder {
  name = "";
  description = "";
  setName(n: string): this {
    this.name = n;
    return this;
  }
  setDescription(d: string): this {
    this.description = d;
    return this;
  }
  toJSON(): APICommandOption {
    return { type: ApplicationCommandOptionType.Subcommand, name: this.name, description: this.description, options: this.options.map((o) => o.toJSON()) };
  }
}

export class SlashCommandSubcommandGroupBuilder {
  name = "";
  description = "";
  subcommands: SlashCommandSubcommandBuilder[] = [];
  setName(n: string): this {
    this.name = n;
    return this;
  }
  setDescription(d: string): this {
    this.description = d;
    return this;
  }
  addSubcommand(s: Adder<SlashCommandSubcommandBuilder>): this {
    this.subcommands.push(build(SlashCommandSubcommandBuilder, s));
    return this;
  }
  toJSON(): APICommandOption {
    return { type: ApplicationCommandOptionType.SubcommandGroup, name: this.name, description: this.description, options: this.subcommands.map((s) => s.toJSON()) };
  }
}

export class SlashCommandBuilder extends OptionsHolder {
  name = "";
  description = "";
  subcommands: (SlashCommandSubcommandBuilder | SlashCommandSubcommandGroupBuilder)[] = [];
  default_member_permissions: string | null = null;
  setName(n: string): this {
    this.name = n;
    return this;
  }
  setDescription(d: string): this {
    this.description = d;
    return this;
  }
  addSubcommand(s: Adder<SlashCommandSubcommandBuilder>): this {
    this.subcommands.push(build(SlashCommandSubcommandBuilder, s));
    return this;
  }
  addSubcommandGroup(g: Adder<SlashCommandSubcommandGroupBuilder>): this {
    this.subcommands.push(build(SlashCommandSubcommandGroupBuilder, g));
    return this;
  }
  setDefaultMemberPermissions(p: bigint | number | string | null): this {
    this.default_member_permissions = p === null ? null : String(p);
    return this;
  }
  setDMPermission(_v: boolean): this {
    return this;
  }
  setContexts(..._c: unknown[]): this {
    return this;
  }
  setIntegrationTypes(..._c: unknown[]): this {
    return this;
  }
  setNSFW(_v = true): this {
    return this;
  }
  setNameLocalizations(_l: unknown): this {
    return this;
  }
  setDescriptionLocalizations(_l: unknown): this {
    return this;
  }
  toJSON(): APICommand {
    return {
      name: this.name,
      description: this.description,
      options: [...this.subcommands.map((s) => s.toJSON()), ...this.options.map((o) => o.toJSON())],
      default_member_permissions: this.default_member_permissions,
    };
  }
}

export class ContextMenuCommandBuilder {
  name = "";
  type = 2;
  setName(n: string): this {
    this.name = n;
    return this;
  }
  setType(t: number): this {
    this.type = t;
    return this;
  }
  toJSON(): APICommand {
    return { name: this.name, description: "" };
  }
}

/**
 * Flatten one command to Vector's spec(s). Subcommands become separate native commands named `cmd-sub`
 * (Vector commands are one level); the library re-assembles `getSubcommand()` for the handler.
 */
export function toNativeSpecs(cmd: APICommand): { name: string; description: string; args: any[]; sub?: string; group?: string }[] {
  const typeName = (t: ApplicationCommandOptionType) =>
    t === ApplicationCommandOptionType.Integer ? "int"
      : t === ApplicationCommandOptionType.Number ? "number"
        : t === ApplicationCommandOptionType.Boolean ? "flag"
          : t === ApplicationCommandOptionType.User ? "user" : "string";
  const args = (opts: APICommandOption[] = []) =>
    opts.map((o) => ({
      name: o.name.toLowerCase(),
      type: o.choices?.length ? "choice" : typeName(o.type),
      description: o.description.slice(0, 200),
      required: Boolean(o.required),
      choices: o.choices?.map((c) => String(c.value).slice(0, 32)) ?? [],
    }));
  const subs = (cmd.options ?? []).filter((o) => o.type === ApplicationCommandOptionType.Subcommand || o.type === ApplicationCommandOptionType.SubcommandGroup);
  if (!subs.length) return [{ name: cmd.name, description: cmd.description, args: args(cmd.options) }];
  const out: ReturnType<typeof toNativeSpecs> = [];
  for (const s of subs) {
    if (s.type === ApplicationCommandOptionType.Subcommand) out.push({ name: `${cmd.name}-${s.name}`, description: s.description, args: args(s.options), sub: s.name });
    else for (const ss of s.options ?? []) out.push({ name: `${cmd.name}-${s.name}-${ss.name}`, description: ss.description, args: args(ss.options), sub: ss.name, group: s.name });
  }
  return out;
}
