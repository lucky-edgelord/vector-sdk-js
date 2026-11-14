#!/usr/bin/env node
// vector-run bot.js [args…]: run an existing discord.js bot on Vector (require("discord.js") -> vector-sdk).
// Log in with $VECTOR_NSEC (or pass an nsec to client.login()).
const path = require("path");
const script = process.argv[2];
if (!script || script === "-h" || script === "--help") {
  console.log("usage: vector-run <bot.js> [args…]\n\nRuns a discord.js bot on Vector. Set VECTOR_NSEC to the bot's nsec1… key.");
  process.exit(script ? 0 : 2);
}
require("../dist/compat/register");
process.argv.splice(1, 1); // the bot sees itself as argv[1]
require(path.resolve(script));
