/**
 * Voice calls. Audio is 48 kHz mono signed 16-bit PCM (little-endian Buffers; one 20 ms frame = 960 samples = 1920
 * bytes). The shape follows `@discordjs/voice`: `createAudioResource()` + `connection.play()`, plus Vector extras:
 * bots can *hear* (`for await (const speech of connection.listen())`).
 */
import { EventEmitter } from "node:events";
import { call, value } from "../native";
import type { VoiceChannel } from "./Channel";
import type { Client } from "../client/Client";

export const SAMPLE_RATE = 48_000;
export const FRAME_SAMPLES = 960;
export const FRAME_BYTES = FRAME_SAMPLES * 2;

export enum VoiceConnectionStatus { Signalling = "signalling", Connecting = "connecting", Ready = "ready", Disconnected = "disconnected", Destroyed = "destroyed" }
export enum AudioPlayerStatus { Idle = "idle", Buffering = "buffering", Playing = "playing", Paused = "paused", AutoPaused = "autopaused" }

/** Something to play: raw PCM, or a file path decoded with ffmpeg (needs `ffmpeg` on PATH). */
export class AudioResource {
  private pcm: Buffer | null;
  constructor(public readonly input: Buffer | string, public readonly metadata: unknown = null) {
    this.pcm = Buffer.isBuffer(input) ? input : null;
  }
  /** @internal */
  async _pcm(client: Client): Promise<Buffer> {
    if (!this.pcm) this.pcm = (await call(client._native(), "voice_decode", { path: String(this.input) })).bytes ?? Buffer.alloc(0);
    return this.pcm;
  }
  get playbackDuration(): number {
    return this.pcm ? Math.round((this.pcm.length / 2 / SAMPLE_RATE) * 1000) : 0;
  }
}

export function createAudioResource(input: Buffer | string, options: { metadata?: unknown } = {}): AudioResource {
  return new AudioResource(input, options.metadata ?? null);
}

/** One speaker's audio frames. */
export interface Speech {
  userId: string;
  pcm: Buffer;
}

export class VoiceConnection extends EventEmitter {
  status = VoiceConnectionStatus.Ready;
  private constructor(public readonly channel: VoiceChannel, private readonly handle: number) {
    super();
  }
  /** @internal: use `voiceChannel.join()` or `joinVoiceChannel()`. */
  static async join(channel: VoiceChannel): Promise<VoiceConnection> {
    const r = await value(channel.client._native(), "channel_join_voice", { id: channel.id });
    return new VoiceConnection(channel, r.call);
  }
  private get client() {
    return this.channel.client;
  }
  private v(method: string, args: Record<string, unknown> = {}, data?: Buffer) {
    return call(this.client._native(), method, { handle: this.handle, ...args }, data);
  }
  get joinConfig() {
    return { channelId: this.channel.id, guildId: this.channel.guild.id, selfDeaf: false, selfMute: false };
  }

  /** Queue audio. Resolves when it's queued; `await connection.finished()` to wait for playback. */
  async play(resource: AudioResource | Buffer | string): Promise<void> {
    const r = resource instanceof AudioResource ? resource : createAudioResource(resource);
    const pcm = await r._pcm(this.client);
    await this.v("voice_say", {}, pcm);
    this.emit(AudioPlayerStatus.Playing, r);
  }
  /** Play and wait until it has been heard. */
  async playAndWait(resource: AudioResource | Buffer | string): Promise<void> {
    const r = resource instanceof AudioResource ? resource : createAudioResource(resource);
    await this.v("voice_say_and_wait", {}, await r._pcm(this.client));
    this.emit(AudioPlayerStatus.Idle, r);
  }
  /** Wait for the queue to drain. */
  async finished(): Promise<void> {
    await this.v("voice_finished");
  }
  /** Stop playback and drop the queue. */
  stop(): void {
    void this.v("voice_hush").catch(() => undefined);
  }
  async fetchStatus(): Promise<{ ended: boolean; queued: number; connected: boolean; moved_to: string | null; state: unknown }> {
    return (await this.v("voice_status")).value;
  }
  async setMuted(on = true): Promise<void> {
    await this.v("voice_set_muted", { on });
  }
  async setDeafened(on = true): Promise<void> {
    await this.v("voice_set_deafened", { on });
  }
  /** Hear the call: yields each speaker's PCM as it arrives. */
  async *listen(): AsyncGenerator<Speech> {
    for (;;) {
      const r = await this.v("voice_listen");
      if (!r.value) return;
      yield { userId: r.value.npub, pcm: r.bytes ?? Buffer.alloc(0) };
    }
  }
  async disconnect(): Promise<void> {
    await this.v("voice_leave").catch(() => undefined);
    this.status = VoiceConnectionStatus.Disconnected;
    this.emit(VoiceConnectionStatus.Disconnected);
  }
  destroy(): void {
    void this.disconnect().then(() => {
      this.status = VoiceConnectionStatus.Destroyed;
      this.emit(VoiceConnectionStatus.Destroyed);
    });
  }
}

/** `@discordjs/voice`'s entry point. `adapterCreator` and `guildId` are accepted and ignored. */
export async function joinVoiceChannel(options: { channel?: VoiceChannel; channelId?: string; guildId?: string; client?: Client; [k: string]: unknown }): Promise<VoiceConnection> {
  let ch = options.channel;
  if (!ch && options.client && options.channelId) ch = options.client.channels.resolve(options.channelId) as VoiceChannel;
  if (!ch) throw new TypeError("joinVoiceChannel needs { channel } (or { client, channelId })");
  return VoiceConnection.join(ch);
}

/** A sine tone as PCM. */
export async function tone(client: Client, hz: number, ms: number): Promise<Buffer> {
  return (await call(client._native(), "voice_tone", { hz, ms })).bytes ?? Buffer.alloc(0);
}
/** Loudness of a PCM buffer, 0–1. */
export async function level(client: Client, pcm: Buffer): Promise<number> {
  return (await call(client._native(), "voice_level", {}, pcm)).value;
}
