/** discord.js's `PermissionsBitField` over Vector's permission bits. Discord-only flags read as granted. */

const B = (n: number) => 1n << BigInt(n);

/** Vector permission bits, under discord.js's names (plus Vector aliases). */
export const PermissionFlagsBits = {
  ManageRoles: B(0),
  ManageChannels: B(1),
  ManageGuild: B(2),
  KickMembers: B(3),
  BanMembers: B(4),
  ManageMessages: B(5),
  CreateInstantInvite: B(6),
  ViewAuditLog: B(8),
  MentionEveryone: B(9),
  PinMessages: B(11),
  ViewChannel: B(13),
  SendMessages: B(14),
  SendMessagesInThreads: B(15),
  AttachFiles: B(16),
  AddReactions: B(17),
  ReadMessageHistory: B(18),
  Connect: B(19),
  Speak: B(20),
  Stream: B(21),
  PrioritySpeaker: B(22),
  MuteMembers: B(23),
  DeafenMembers: B(24),
  MoveMembers: B(25),
  ModerateMembers: B(26),
  ManageNicknames: B(28),
  ChangeNickname: B(29),
  // Discord-only: no bit on Vector (0n), always treated as granted
  Administrator: 0n,
  EmbedLinks: 0n,
  UseExternalEmojis: 0n,
  UseExternalStickers: 0n,
  ManageEmojisAndStickers: 0n,
  ManageGuildExpressions: 0n,
  CreateGuildExpressions: 0n,
  ManageWebhooks: 0n,
  ManageEvents: 0n,
  CreateEvents: 0n,
  ManageThreads: 0n,
  CreatePublicThreads: 0n,
  CreatePrivateThreads: 0n,
  UseApplicationCommands: 0n,
  RequestToSpeak: 0n,
  UseVAD: 0n,
  UseEmbeddedActivities: 0n,
  ViewGuildInsights: 0n,
  SendTTSMessages: 0n,
  UseSoundboard: 0n,
  UseExternalSounds: 0n,
  SendVoiceMessages: 0n,
  SendPolls: 0n,
  UseExternalApps: 0n,
  ViewCreatorMonetizationAnalytics: 0n,
} as const;

export type PermissionFlag = keyof typeof PermissionFlagsBits;
export type PermissionResolvable = bigint | number | string | PermissionFlag | PermissionsBitField | PermissionResolvable[];

const ALL = Object.values(PermissionFlagsBits).reduce((a, b) => a | b, 0n);

export class PermissionsBitField {
  static Flags = PermissionFlagsBits;
  static All = ALL;
  static Default = PermissionFlagsBits.ViewChannel | PermissionFlagsBits.SendMessages | PermissionFlagsBits.AddReactions |
    PermissionFlagsBits.ReadMessageHistory | PermissionFlagsBits.AttachFiles | PermissionFlagsBits.Connect |
    PermissionFlagsBits.Speak | PermissionFlagsBits.ChangeNickname | PermissionFlagsBits.CreateInstantInvite;

  bitfield: bigint;

  constructor(bits: PermissionResolvable = 0n) {
    this.bitfield = PermissionsBitField.resolve(bits);
  }

  static resolve(bit: PermissionResolvable): bigint {
    if (typeof bit === "bigint") return bit;
    if (typeof bit === "number") return BigInt(bit);
    if (bit instanceof PermissionsBitField) return bit.bitfield;
    if (Array.isArray(bit)) return bit.reduce<bigint>((a, b) => a | PermissionsBitField.resolve(b), 0n);
    if (typeof bit === "string") {
      if (bit in PermissionFlagsBits) return PermissionFlagsBits[bit as PermissionFlag];
      if (/^\d+$/.test(bit)) return BigInt(bit);
      throw new RangeError(`unknown permission ${bit}`);
    }
    return 0n;
  }

  /** True when every bit is set. Discord-only flags (bit 0n) and an admin's permissions always pass. */
  has(bit: PermissionResolvable, checkAdmin = true): boolean {
    const want = PermissionsBitField.resolve(bit);
    if (checkAdmin && this.isAdmin) return true;
    return (this.bitfield & want) === want;
  }

  any(bit: PermissionResolvable, checkAdmin = true): boolean {
    const want = PermissionsBitField.resolve(bit);
    if (want === 0n || (checkAdmin && this.isAdmin)) return true;
    return (this.bitfield & want) !== 0n;
  }

  missing(bits: PermissionResolvable, checkAdmin = true): PermissionFlag[] {
    return (Object.keys(PermissionFlagsBits) as PermissionFlag[]).filter(
      (k) => PermissionsBitField.resolve(bits) & PermissionFlagsBits[k] && !this.has(k, checkAdmin),
    );
  }

  /** Vector's "admin" is holding every management permission. */
  get isAdmin(): boolean {
    const m = PermissionFlagsBits;
    const mgmt = m.ManageRoles | m.ManageChannels | m.ManageGuild | m.KickMembers | m.BanMembers | m.ManageMessages |
      m.CreateInstantInvite | m.ViewAuditLog | m.PinMessages;
    return (this.bitfield & mgmt) === mgmt;
  }

  add(...bits: PermissionResolvable[]): this {
    this.bitfield |= PermissionsBitField.resolve(bits);
    return this;
  }

  remove(...bits: PermissionResolvable[]): this {
    this.bitfield &= ~PermissionsBitField.resolve(bits);
    return this;
  }

  serialize(): Record<PermissionFlag, boolean> {
    const out = {} as Record<PermissionFlag, boolean>;
    for (const k of Object.keys(PermissionFlagsBits) as PermissionFlag[]) out[k] = this.has(k, false);
    return out;
  }

  toArray(): PermissionFlag[] {
    return (Object.keys(PermissionFlagsBits) as PermissionFlag[]).filter(
      (k) => PermissionFlagsBits[k] !== 0n && this.has(k, false),
    );
  }

  equals(other: PermissionResolvable): boolean {
    return this.bitfield === PermissionsBitField.resolve(other);
  }

  freeze(): Readonly<this> {
    return Object.freeze(this);
  }

  toJSON(): string {
    return this.bitfield.toString();
  }

  valueOf(): bigint {
    return this.bitfield;
  }
}
