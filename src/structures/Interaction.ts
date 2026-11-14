/** Interactions: slash commands, reaction-button taps, select choices and modal answers. */
import { randomUUID } from "node:crypto";
import { Base } from "./Base";
import type { Client } from "../client/Client";
import type { Message } from "./Message";
import type { TextBasedChannel } from "./Channel";
import type { Guild } from "./Guild";
import type { GuildMember } from "./GuildMember";
import type { User } from "./User";
import type { Role } from "./Role";
import { Collection } from "../util/Collection";
import { ApplicationCommandOptionType, ComponentType, InteractionType } from "../util/Constants";
import { PermissionsBitField } from "../util/PermissionsBitField";
import { isEphemeral, type MessageCreateOptions, type MessageEditOptions } from "../sending";
import type { ModalBuilder } from "./Components";

export type InteractionReplyOptions = MessageCreateOptions & { ephemeral?: boolean; fetchReply?: boolean; withResponse?: boolean };

export abstract class BaseInteraction extends Base {
  readonly id = randomUUID();
  abstract readonly type: InteractionType;
  readonly createdTimestamp = Date.now();
  replied = false;
  deferred = false;
  ephemeral: boolean | null = null;
  /** The message that triggered it (the user's `/command` message, or the message whose reaction was tapped). */
  protected _source: Message;
  private _reply: Message | null = null;
  private _typing: NodeJS.Timeout | null = null;

  constructor(client: Client, source: Message, public readonly user: User) {
    super(client);
    this._source = source;
  }

  get channel(): TextBasedChannel {
    return this._source.channel;
  }
  get channelId(): string {
    return this.channel.id;
  }
  get guild(): Guild | null {
    return this._source.guild;
  }
  get guildId(): string | null {
    return this.guild?.id ?? null;
  }
  get member(): GuildMember | null {
    return this.guild ? this.guild.members._get(this.user.id) : null;
  }
  get memberPermissions(): PermissionsBitField | null {
    return this.member?.permissions ?? null;
  }
  get appPermissions(): PermissionsBitField {
    return new PermissionsBitField(PermissionsBitField.All);
  }
  get createdAt(): Date {
    return new Date(this.createdTimestamp);
  }
  get locale(): string {
    return "en-US";
  }
  get guildLocale(): string | null {
    return null;
  }
  get applicationId(): string {
    return this.client.user?.id ?? "";
  }
  inGuild(): boolean {
    return this.guild !== null;
  }
  inCachedGuild(): boolean {
    return this.inGuild();
  }
  isRepliable(): boolean {
    return true;
  }
  isCommand(): this is ChatInputCommandInteraction {
    return this.type === InteractionType.ApplicationCommand;
  }
  isChatInputCommand(): this is ChatInputCommandInteraction {
    return this.isCommand();
  }
  isContextMenuCommand(): boolean {
    return false;
  }
  isAutocomplete(): boolean {
    return false;
  }
  isMessageComponent(): this is MessageComponentInteraction {
    return this.type === InteractionType.MessageComponent;
  }
  isButton(): this is ButtonInteraction {
    return this instanceof ButtonInteraction;
  }
  isStringSelectMenu(): this is StringSelectMenuInteraction {
    return this instanceof StringSelectMenuInteraction && this.componentType === ComponentType.StringSelect;
  }
  isAnySelectMenu(): this is StringSelectMenuInteraction {
    return this instanceof StringSelectMenuInteraction;
  }
  isSelectMenu(): this is StringSelectMenuInteraction {
    return this.isAnySelectMenu();
  }
  isUserSelectMenu(): boolean {
    return this instanceof StringSelectMenuInteraction && this.componentType === ComponentType.UserSelect;
  }
  isRoleSelectMenu(): boolean {
    return this instanceof StringSelectMenuInteraction && this.componentType === ComponentType.RoleSelect;
  }
  isChannelSelectMenu(): boolean {
    return this instanceof StringSelectMenuInteraction && this.componentType === ComponentType.ChannelSelect;
  }
  isModalSubmit(): this is ModalSubmitInteraction {
    return this.type === InteractionType.ModalSubmit;
  }

  private stopTyping(): void {
    if (this._typing) clearInterval(this._typing);
    this._typing = null;
  }

  /** Ephemeral replies go to the user's DMs (Vector has no "only you can see this"). */
  private async post(options: string | InteractionReplyOptions, asReply: boolean): Promise<Message> {
    const o: InteractionReplyOptions = typeof options === "string" ? { content: options } : { ...options };
    const ephemeral = isEphemeral(o.flags, o.ephemeral);
    if (ephemeral) {
      this.ephemeral = true;
      return this.user.send(o);
    }
    if (asReply) return this._source.reply(o);
    return this.channel.send(o);
  }

  async reply(options: string | InteractionReplyOptions): Promise<any> {
    if (this.replied || this.deferred) throw new Error("The reply to this interaction has already been sent or deferred.");
    this.stopTyping();
    this._reply = await this.post(options, this.type === InteractionType.ApplicationCommand);
    this.replied = true;
    return typeof options === "object" && (options.fetchReply || options.withResponse) ? this._reply : undefined;
  }
  /** Shows "typing…" until you `editReply()`. */
  async deferReply(options: { ephemeral?: boolean; flags?: number } = {}): Promise<void> {
    if (this.replied || this.deferred) throw new Error("The reply to this interaction has already been sent or deferred.");
    this.deferred = true;
    this.ephemeral = isEphemeral(options.flags, options.ephemeral);
    const tick = () => void this.channel.sendTyping().catch(() => undefined);
    tick();
    this._typing = setInterval(tick, 5000).unref();
    setTimeout(() => this.stopTyping(), 60_000).unref();
  }
  async editReply(options: string | InteractionReplyOptions): Promise<Message> {
    this.stopTyping();
    if (this._reply) return this._reply.edit(options as string | MessageEditOptions);
    const o: InteractionReplyOptions = typeof options === "string" ? { content: options } : { ...options };
    if (this.ephemeral) o.ephemeral = true;
    this._reply = await this.post(o, this.type === InteractionType.ApplicationCommand);
    this.replied = true;
    return this._reply;
  }
  async fetchReply(): Promise<Message> {
    if (!this._reply) throw new Error("The reply to this interaction has not been sent.");
    return this._reply;
  }
  async deleteReply(): Promise<void> {
    await this._reply?.delete();
    this._reply = null;
  }
  async followUp(options: string | InteractionReplyOptions): Promise<Message> {
    this.stopTyping();
    return this.post(options, false);
  }

  /**
   * Modals don't exist on Vector: each text input is asked in chat, one at a time, and the user's answers arrive
   * as a `ModalSubmitInteraction` (on `interactionCreate` and from `awaitModalSubmit`).
   */
  async showModal(modal: ModalBuilder | { toJSON(): any }): Promise<void> {
    const data = "inputs" in modal ? (modal as ModalBuilder) : null;
    const json = modal.toJSON();
    const inputs = data?.inputs ?? json.components.flatMap((r: any) => r.components);
    const answers = new Map<string, string>();
    const channel = this.channel;
    await channel.send({ content: `**${json.title}**${inputs.length > 1 ? ` · ${inputs.length} questions` : ""} for nostr:${this.user.id}` });
    for (const input of inputs) {
      const q = `${input.label}${input.required === false ? " *(optional, reply `-` to skip)*" : ""}${input.placeholder ? `\n-# ${input.placeholder}` : ""}`;
      await channel.send(q);
      const got = await channel.awaitMessages({ filter: (m) => m.author.id === this.user.id, max: 1, time: 5 * 60_000 });
      const msg = got.first();
      if (!msg) {
        await channel.send("-# ⏰ Timed out.");
        return;
      }
      answers.set(input.custom_id, input.required === false && msg.content.trim() === "-" ? "" : msg.content);
    }
    const submit = new ModalSubmitInteraction(this.client, this._source, this.user, json.custom_id, answers);
    this.client._state.emitModal(submit);
    this.client.emit("interactionCreate", submit);
  }

  /** Wait for this user's answers to `showModal()`. */
  awaitModalSubmit(options: { time: number; filter?: (i: ModalSubmitInteraction) => boolean }): Promise<ModalSubmitInteraction> {
    return this.client._state.awaitModal((i) => i.user.id === this.user.id && (!options.filter || options.filter(i)), options.time);
  }
}

// ---------------------------------------------------------------------------------------------------------------------

export class CommandInteractionOptionResolver {
  constructor(
    private readonly interaction: ChatInputCommandInteraction,
    private readonly values: Record<string, unknown>,
    private readonly types: Map<string, ApplicationCommandOptionType>,
    private readonly sub: string | null,
    private readonly group: string | null,
  ) {}
  get data() {
    return Object.entries(this.values).map(([name, value]) => ({ name, value, type: this.types.get(name) ?? ApplicationCommandOptionType.String }));
  }
  private raw(name: string, required: boolean): unknown {
    const v = this.values[name.toLowerCase()];
    if ((v === undefined || v === null) && required) throw new TypeError(`Required option "${name}" not found.`);
    return v ?? null;
  }
  get(name: string, required = false) {
    const value = this.raw(name, required);
    return value === null ? null : { name, value, type: this.types.get(name) ?? ApplicationCommandOptionType.String };
  }
  getString(name: string, required = false): string | null {
    const v = this.raw(name, required);
    return v === null ? null : String(v);
  }
  getInteger(name: string, required = false): number | null {
    const v = this.raw(name, required);
    return v === null ? null : Math.trunc(Number(v));
  }
  getNumber(name: string, required = false): number | null {
    const v = this.raw(name, required);
    return v === null ? null : Number(v);
  }
  getBoolean(name: string, required = false): boolean | null {
    const v = this.raw(name, required);
    return v === null ? null : v === true || v === "true";
  }
  private npub(name: string, required: boolean): string | null {
    const v = this.raw(name, required);
    if (v === null) return null;
    const m = /npub1[02-9ac-hj-np-z]{58}/.exec(String(v));
    return m ? m[0] : String(v);
  }
  getUser(name: string, required = false): User | null {
    const id = this.npub(name, required);
    return id ? this.interaction.client._state.user(id) : null;
  }
  getMember(name: string): GuildMember | null {
    const id = this.npub(name, false);
    return id && this.interaction.guild ? this.interaction.guild.members._get(id) : null;
  }
  getChannel(name: string, required = false): any {
    const v = this.raw(name, required);
    if (v === null) return null;
    const g = this.interaction.guild;
    const s = String(v).replace(/^#/, "");
    return g?.channels.cache.get(s) ?? g?.channels.cache.find((c) => c.name.toLowerCase().includes(s.toLowerCase())) ?? null;
  }
  getRole(name: string, required = false): Role | null {
    const v = this.raw(name, required);
    if (v === null) return null;
    const g = this.interaction.guild;
    const s = String(v).replace(/^@/, "");
    return g?.roles.cache.get(s) ?? g?.roles.cache.find((r) => r.name.toLowerCase() === s.toLowerCase()) ?? null;
  }
  getMentionable(name: string, required = false): User | Role | null {
    return this.getRole(name, false) ?? this.getUser(name, required);
  }
  getAttachment(_name: string): null {
    return null;
  }
  getSubcommand(required = true): string | null {
    if (!this.sub && required) throw new TypeError("No subcommand specified for interaction.");
    return this.sub;
  }
  getSubcommandGroup(required = false): string | null {
    if (!this.group && required) throw new TypeError("No subcommand group specified for interaction.");
    return this.group;
  }
  getFocused(): string {
    return "";
  }
}

export class ChatInputCommandInteraction extends BaseInteraction {
  readonly type = InteractionType.ApplicationCommand;
  readonly commandType = 1;
  readonly options: CommandInteractionOptionResolver;
  constructor(
    client: Client,
    source: Message,
    user: User,
    public readonly commandName: string,
    values: Record<string, unknown>,
    types: Map<string, ApplicationCommandOptionType>,
    sub: string | null = null,
    group: string | null = null,
  ) {
    super(client, source, user);
    this.options = new CommandInteractionOptionResolver(this, values, types, sub, group);
  }
  get commandId(): string {
    return this.commandName;
  }
  get command() {
    return this.client.application.commands.cache.get(this.commandName) ?? null;
  }
  override toString(): string {
    return `/${this.commandName}`;
  }
}
/** discord.js aliases */
export const CommandInteraction = ChatInputCommandInteraction;

export class MessageComponentInteraction extends BaseInteraction {
  readonly type = InteractionType.MessageComponent;
  constructor(client: Client, public readonly message: Message, user: User, public readonly customId: string, public readonly componentType: ComponentType) {
    super(client, message, user);
  }
  /** Edit the message the button is on. */
  async update(options: string | MessageEditOptions): Promise<Message> {
    this.replied = true;
    return this.message.edit(options);
  }
  async deferUpdate(): Promise<void> {
    this.deferred = true;
  }
  get component() {
    for (const row of this.message.components) for (const c of row.components as any[]) if (c.custom_id === this.customId) return c;
    return null;
  }
}

export class ButtonInteraction extends MessageComponentInteraction {}

export class StringSelectMenuInteraction extends MessageComponentInteraction {
  constructor(client: Client, message: Message, user: User, customId: string, componentType: ComponentType, public readonly values: string[]) {
    super(client, message, user, customId, componentType);
  }
  get users(): Collection<string, User> {
    return new Collection(this.values.filter((v) => v.startsWith("npub1")).map((v) => [v, this.client._state.user(v)]));
  }
  get roles(): Collection<string, Role> {
    const g = this.guild;
    return new Collection(this.values.map((v) => [v, g?.roles.cache.get(v)]).filter((x): x is [string, Role] => Boolean(x[1])));
  }
}
export const SelectMenuInteraction = StringSelectMenuInteraction;
export const UserSelectMenuInteraction = StringSelectMenuInteraction;
export const RoleSelectMenuInteraction = StringSelectMenuInteraction;
export const ChannelSelectMenuInteraction = StringSelectMenuInteraction;

export class ModalSubmitFields {
  constructor(private readonly answers: Map<string, string>) {}
  get fields(): Collection<string, { customId: string; value: string }> {
    return new Collection([...this.answers].map(([k, v]) => [k, { customId: k, value: v }]));
  }
  getTextInputValue(customId: string): string {
    const v = this.answers.get(customId);
    if (v === undefined) throw new TypeError(`Field with custom id "${customId}" not found.`);
    return v;
  }
  getField(customId: string) {
    return { customId, value: this.getTextInputValue(customId) };
  }
}

export class ModalSubmitInteraction extends BaseInteraction {
  readonly type = InteractionType.ModalSubmit;
  readonly fields: ModalSubmitFields;
  constructor(client: Client, source: Message, user: User, public readonly customId: string, answers: Map<string, string>) {
    super(client, source, user);
    this.fields = new ModalSubmitFields(answers);
  }
  get message(): Message {
    return this._source;
  }
  isFromMessage(): boolean {
    return true;
  }
  async update(options: string | MessageEditOptions): Promise<Message> {
    this.replied = true;
    return this.channel.send(options as any);
  }
  async deferUpdate(): Promise<void> {
    this.deferred = true;
  }
}
