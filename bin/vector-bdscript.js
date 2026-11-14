#!/usr/bin/env node
// vector-bdscript run <folder> | check <folder> | functions
// Run a folder of BDScript commands (.bds/.json/.js, plus optional bot.json) as a Vector bot.
const fs = require("node:fs");
const path = require("node:path");
const { parseArgs } = require("node:util");
const { values: o, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    nsec: { type: "string", default: process.env.VECTOR_NSEC },
    prefix: { type: "string" },
    "data-dir": { type: "string", default: process.env.VECTOR_DATA_DIR },
    "no-watch": { type: "boolean", default: false },
  },
});
const [cmd, folder] = positionals;
const bds = require("../dist/bdscript");

if (cmd === "functions") {
  const seen = new Map();
  for (const f of bds.FUNCTIONS.values()) seen.set(f.name.toLowerCase(), f);
  for (const f of [...seen.values()].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }))) {
    console.log(`$${f.name}${f.status === "full" ? "" : `  (${f.status}${f.note ? ": " + f.note : ""})`}`);
  }
  process.exit(0);
}
if (!["run", "check"].includes(cmd) || !folder) {
  console.log("usage: vector-bdscript run <folder> [--nsec nsec1…] [--prefix !] [--data-dir dir] [--no-watch]\n" +
    "       vector-bdscript check <folder>\n       vector-bdscript functions");
  process.exit(cmd ? 2 : 0);
}
const cfgPath = path.join(folder, "bot.json");
const cfg = fs.existsSync(cfgPath) ? JSON.parse(fs.readFileSync(cfgPath, "utf8")) : {};

if (cmd === "check") {
  let bad = 0, n = 0;
  const bot = new bds.BDBot({ database: ":memory:", listen: false });
  bot.command = (d) => {
    n++;
    try {
      bds.compileCode(String(d.code ?? ""));
    } catch (ex) {
      bad++;
      console.log(`${d.name || d.trigger || d.type || "?"}: ${ex.message}${ex.line ? ` (at ${ex.line}:${ex.col})` : ""}`);
    }
  };
  bot.manager.load(folder);
  console.log(bad ? `${bad} error(s) in ${n} command(s)` : `ok (${n} command(s))`);
  process.exit(bad ? 1 : 0);
}

if (!o.nsec) {
  console.error("--nsec or $VECTOR_NSEC is required");
  process.exit(2);
}
const bot = new bds.BDBot({ prefix: o.prefix ?? cfg.prefix ?? "!", owners: cfg.owners ?? [], dataDir: o["data-dir"], autoVariables: cfg.autoVariables ?? cfg.auto_variables ?? false });
bot.variables(cfg.variables ?? {});
for (const s of cfg.slash ?? []) bot.slashCommand(s.name, s.description ?? "", s.options ?? []);
console.log(`loaded ${bot.manager.load(folder)} command(s)`);
if (!o["no-watch"]) bot.manager.watch();
bot.client.on("error", (e) => console.error(e));
bot.client.once("ready", () => console.log(`ready as ${bot.client.user.id}`));
bot.login(o.nsec);
process.on("SIGINT", async () => (await bot.destroy(), process.exit(0)));
