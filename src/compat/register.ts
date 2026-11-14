/**
 * `require("vector-sdk/register")` (or `node -r vector-sdk/register bot.js`, or `vector-run bot.js`) makes
 * `require("discord.js")`, `@discordjs/builders`, `@discordjs/rest`, `discord-api-types/v10` and `@discordjs/voice`
 * resolve to vector-sdk, so an existing discord.js bot runs on Vector without editing its imports.
 */
import Module = require("node:module");
import * as path from "node:path";

const ROOT = path.join(__dirname, "..");
const ALIASES: Record<string, string> = {
  "discord.js": path.join(ROOT, "compat", "discordjs.js"),
  "@discordjs/builders": path.join(ROOT, "compat", "discordjs.js"),
  "@discordjs/rest": path.join(ROOT, "compat", "discordjs.js"),
  "@discordjs/voice": path.join(ROOT, "structures", "Voice.js"),
  "discord-api-types/v10": path.join(ROOT, "compat", "discordjs.js"),
  "discord-api-types/v9": path.join(ROOT, "compat", "discordjs.js"),
};

const M = Module as unknown as { _resolveFilename: (req: string, ...rest: unknown[]) => string; __vectorPatched?: boolean };
if (!M.__vectorPatched) {
  const orig = M._resolveFilename;
  M._resolveFilename = function (request: string, ...rest: unknown[]) {
    const target = ALIASES[request];
    return orig.call(this, target ?? request, ...rest);
  };
  M.__vectorPatched = true;
}

export const aliases = Object.keys(ALIASES);
