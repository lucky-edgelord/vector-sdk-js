/**
 * The native addon (Rust `vector_sdk` via napi-rs). Everything else talks to Vector through {@link NativeBot.call}.
 * Tests swap in a fake with {@link setNativeModule}.
 */
import { mapNativeError } from "./errors";

export interface CallResult {
  value: any;
  bytes?: Buffer | null;
}

export interface NativeBot {
  readonly npub: string;
  start(): Promise<void>;
  nextEvent(): Promise<any | null>;
  stop(): void;
  logout(): Promise<void>;
  registerCommand(name: string, description: string, args: unknown): void;
  registerXdc?(options: unknown): number;
  call(method: string, args?: Record<string, unknown> | null, data?: Buffer | null): Promise<CallResult>;
}

export interface NativeModule {
  NativeBot: { build(options: Record<string, unknown>): Promise<NativeBot> };
  sdkVersion(): string;
  features(): string[];
  generateNsec(): string;
  allowOutsideTransport?(on: boolean): void;
}

let override: NativeModule | null = null;
let loaded: NativeModule | null = null;

/** Use a different native module (tests use a fake). */
export function setNativeModule(mod: NativeModule | null): void {
  override = mod;
}

export function native(): NativeModule {
  if (override) return override;
  if (!loaded) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      loaded = require("../native/index.js") as NativeModule;
    } catch (e) {
      throw new Error(
        `vector-sdk: the native addon for ${process.platform}-${process.arch} could not be loaded ` +
          `(${(e as Error).message}). Build it with \`npm run build:native\` (needs Rust).`,
      );
    }
  }
  return loaded;
}

/** Call into the SDK, turning native error strings into vector-sdk error classes. */
export async function call(bot: NativeBot, method: string, args?: Record<string, unknown>, data?: Buffer | null): Promise<CallResult> {
  try {
    const clean: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(args ?? {})) if (v !== undefined) clean[k] = v;
    return await bot.call(method, clean, data ?? null);
  } catch (e) {
    throw mapNativeError(e);
  }
}

/** `call(...)` returning just the JSON value. */
export async function value<T = any>(bot: NativeBot, method: string, args?: Record<string, unknown>, data?: Buffer | null): Promise<T> {
  return (await call(bot, method, args, data)).value as T;
}
