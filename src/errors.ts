/** Errors. Names follow discord.js where one exists (DiscordAPIError -> VectorAPIError, aliased). */

export class VectorError extends Error {
  override name = "VectorError";
  /** discord.js-style numeric code; Vector errors use 0 unless mapped. */
  code: number | string = 0;
}

/** Any failure reported by the Vector SDK. `DiscordAPIError` is an alias for porting. */
export class VectorAPIError extends VectorError {
  override name = "VectorAPIError";
  status = 400;
  constructor(message: string, public readonly kind: string = "VectorException") {
    super(message);
  }
}

/** The bot lacks a Community permission the action needs (`needs` is the permission bit mask). */
export class NotPermitted extends VectorAPIError {
  override name = "NotPermitted";
  override status = 403;
  override code = 50013; // Discord's "Missing Permissions"
  constructor(message: string, public readonly needs: bigint = 0n) {
    super(message, "NotPermitted");
  }
}

/** No such Community, channel, role, category, message or member. */
export class NotFound extends VectorAPIError {
  override name = "NotFound";
  override status = 404;
  override code = 10003;
  constructor(message: string) {
    super(message, "NotFound");
  }
}

export class NotInitialized extends VectorAPIError {
  override name = "NotInitialized";
  constructor(message: string) {
    super(message, "NotInitialized");
  }
}

export class NetworkError extends VectorAPIError {
  override name = "NetworkError";
  override status = 503;
  constructor(message: string) {
    super(message, "NetworkError");
  }
}

/** A discord.js feature that Vector does not have. */
export class NotSupportedOnVector extends VectorError {
  override name = "NotSupportedOnVector";
  override code = "NOT_SUPPORTED_ON_VECTOR";
  constructor(what: string, hint = "") {
    super(`${what} is not supported on Vector${hint ? `: ${hint}` : ""}`);
  }
}

/** discord.js names, for `catch (e) { if (e instanceof DiscordAPIError) ... }`. */
export const DiscordAPIError = VectorAPIError;
export type DiscordAPIError = VectorAPIError;

export class DiscordjsError extends VectorError {
  override name = "DiscordjsError";
}
export class DiscordjsTypeError extends TypeError {
  override name = "DiscordjsTypeError";
}

/** `"Kind|needs|message"` from the addon -> an error class. */
export function mapNativeError(e: unknown): Error {
  const raw = e instanceof Error ? e.message : String(e);
  const m = /^(\w+)\|([^|]*)\|([\s\S]*)$/.exec(raw);
  if (!m) return e instanceof Error ? e : new VectorAPIError(raw);
  const [, kind, extra, message] = m;
  switch (kind) {
    case "NotPermitted":
      return new NotPermitted(message, extra ? BigInt(extra) : 0n);
    case "NotFound":
      return new NotFound(message);
    case "NotInitialized":
      return new NotInitialized(message);
    case "NetworkError":
      return new NetworkError(message);
    case "ValueError":
      return new TypeError(message);
    default:
      return new VectorAPIError(message, kind);
  }
}
