/**
 * `BDScript`: the engine attached to an *existing* discord.js-style client, callable from JavaScript.
 *
 *     const bd = new BDScript(client);                      // extra listeners; your handlers are untouched
 *     bd.command({ name: "balance", code: "$nomention You have $getUserVar[money] coins." });
 *     const r = await bd.run("Hi $username! $randomText[a;b;c]", message);   // call it from JS
 *     await bd.evaluate("$sum[2;3] $toUppercase[ok]");                      // "5 OK" (no bot needed)
 */
import { BDBot, Command, type BDBotOptions } from "./bot";
import { Context } from "./context";
import { run as runCode } from "./interpreter";
import { FUNCTIONS, fn, type FnOptions } from "./registry";
import type { Client } from "../client/Client";
import type { EmbedBuilder } from "../structures/Embed";
import type { ComponentSpec } from "./context";

/** What one run produced. `String(result)` is the text. */
export class Result {
  constructor(
    public readonly text: string,
    /** BDFD-style error message, or the message of a failed $onlyIf/$argsCheck. */
    public readonly failure: string | null,
    public readonly embeds: EmbedBuilder[],
    public readonly rows: ComponentSpec[][],
    public readonly reactions: string[],
    public readonly files: { attachment: Buffer | string; name: string }[],
    /** Ids of messages the script sent. */
    public readonly sent: string[],
    public readonly context: Context,
  ) {}
  get ok(): boolean {
    return this.failure === null;
  }
  toString(): string {
    return this.text;
  }
}

export interface RunOptions {
  send?: boolean;
  message?: any;
  channel?: any;
  author?: any;
  guild?: any;
  args?: string | string[];
  /** Pre-set `$var[...]` values. */
  vars?: Record<string, unknown>;
  extras?: Record<string, any>;
  mention?: boolean;
}

export class BDScript extends BDBot {
  /** Attach to a client you already have. `listen: false` = a pure library (nothing runs unless you call it). */
  constructor(client?: Client | null, options: Omit<BDBotOptions, "client"> = {}) {
    super({ ...options, client: client ?? undefined, listen: (options.listen as boolean | undefined) ?? Boolean(client) });
  }

  private makeContext(code: string, from: any, o: RunOptions): Context {
    let { message, channel, author } = o;
    if (from) {
      if (typeof from.content === "string" && from.channel) message ??= from; // a Message
      else if (from.user && from.channel) {
        author ??= from.user; // an interaction
        channel ??= from.channel;
      } else if (typeof from.send === "function") channel ??= from; // a channel
      channel ??= message?.channel;
      author ??= message?.author;
    }
    const args = o.args === undefined ? [] : typeof o.args === "string" ? o.args.split(/\s+/).filter(Boolean) : o.args.map(String);
    const ctx = new Context(this, { message, channel, author, guild: o.guild, args, command: new Command({ code, name: "eval" }), extras: o.extras, mentionDefault: o.mention ?? false });
    for (const [k, v] of Object.entries(o.vars ?? {})) ctx.vars[k] = String(v);
    return ctx;
  }

  /**
   * Run BDScript. `from` may be a Message, an interaction or a channel. By default the reply is sent when there is
   * somewhere to send it; `send: false` just returns the Result.
   */
  async run(code: string, from: any = null, o: RunOptions = {}): Promise<Result> {
    const ctx = this.makeContext(code, from, o);
    const text = await runCode(ctx, code, { send: o.send ?? Boolean(ctx.channel) });
    const r = ctx.response;
    return new Result(text, ctx.failure, [...r.embeds.entries()].sort((a, b) => a[0] - b[0]).map(([, e]) => e), r.rows.filter((x) => x.length), [...r.reactions], [...r.files], [...ctx.sentIds], ctx);
  }

  /** Run without sending; returns the text. */
  async evaluate(code: string, from: any = null, o: RunOptions = {}): Promise<string> {
    return (await this.run(code, from, { ...o, send: false })).text;
  }

  /**
   * Teach BDScript a new function written in JS (strings in, string out; async works):
   *
   *     bd.function("shout", (ctx, text = "") => text.toUpperCase() + "!");   // $shout[hi] -> HI!
   *
   * Throw `new BDScriptError("…")` to fail like a built-in. The registry is process-wide.
   */
  function(names: string | string[], impl: (ctx: Context, ...args: string[]) => unknown, options: FnOptions = {}): this {
    fn(names, impl, { status: "custom", ...options });
    return this;
  }
  functions(): string[] {
    return [...FUNCTIONS.keys()].sort();
  }
}
