/**
 * `vector-port check <dir>`: find things in a discord.js bot that need attention before it runs on Vector.
 *
 * - discord.js names Vector doesn't have (errors) or only stubs (warnings)
 * - ID-shaped database columns declared INTEGER / BIGINT (Vector ids are 64-hex strings and npubs)
 * - hard-coded Discord snowflakes (17–20 digit strings/numbers) that won't match anything on Vector
 * - `BigInt(id)` / `parseInt(id)` / `Number(id)` applied to something ID-like
 * - Discord tokens in `login()` (Vector bots log in with an nsec)
 */
import * as fs from "node:fs";
import * as path from "node:path";

export interface Finding {
  level: "error" | "warn" | "info";
  file: string;
  line: number;
  message: string;
}

const ID_WORDS = "(?:guild|server|channel|user|member|author|owner|role|message|msg|mod|admin|target|moderator|staff|bot)";
const COLUMN = new RegExp(`(\\b\\w*${ID_WORDS}_?id\\b|\\bid_?${ID_WORDS}\\b)(\\s+)(INTEGER|INT|BIGINT)\\b`, "gi");
const SNOWFLAKE = /(["'`])(\d{17,20})\1|\b(\d{17,20})n?\b/g;
const NUMERIC_ID = new RegExp(`\\b(BigInt|parseInt|Number)\\(\\s*[\\w.]*(?:${ID_WORDS})[\\w.]*\\.?id\\b`, "gi");
const SKIP = new Set([".git", "node_modules", "dist", "build", ".next", "coverage"]);

function* files(root: string, exts: string[]): Generator<string> {
  const st = fs.statSync(root);
  if (st.isFile()) {
    if (exts.some((e) => root.endsWith(e))) yield root;
    return;
  }
  for (const ent of fs.readdirSync(root, { withFileTypes: true })) {
    if (SKIP.has(ent.name)) continue;
    const p = path.join(root, ent.name);
    if (ent.isDirectory()) yield* files(p, exts);
    else if (exts.some((e) => ent.name.endsWith(e))) yield p;
  }
}

/** discord.js names that need porting work. */
function knownNames(): { real: Set<string>; stubs: Map<string, string> } {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const idx = require("../index");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const stubs = require("./stubs");
  const stubHints = new Map<string, string>([
    ["ShardingManager", "Vector bots don't shard: run one Client"],
    ["ShardClientUtil", "Vector bots don't shard"],
    ["ThreadChannel", "Vector has no threads; use a channel or replies"],
    ["StageChannel", "use a voice channel"],
    ["Sticker", "send an image or custom emoji"],
    ["Poll", "use a select menu (reactions)"],
    ["REST", "only command registration (PUT …/commands) is supported; it saves .vector-commands.json for the next login()"],
  ]);
  for (const k of Object.keys(stubs)) if (!stubHints.has(k)) stubHints.set(k, "constant only (no Vector behaviour)");
  return { real: new Set(Object.keys(idx)), stubs: stubHints };
}

const DISCORD_ONLY_CALLS: [RegExp, string, Finding["level"]][] = [
  [/\.threads\b|\.startThread\(/g, "threads don't exist on Vector; use a channel or replies", "error"],
  [/\.stickers\b/g, "stickers don't exist on Vector", "warn"],
  [/\.scheduledEvents\b/g, "scheduled events don't exist on Vector", "error"],
  [/\.autoModerationRules\b/g, "AutoMod rules don't exist on Vector (see guild.containRaid())", "error"],
  [/\.shard\b|\bclient\.shard\b/g, "Vector bots don't shard", "warn"],
  [/\bMessageContent\b/g, "intents are ignored on Vector: the bot sees every message it can read (harmless)", "info"],
  [/\.discriminator\b/g, "Vector users have no discriminator ('0')", "info"],
  [/\bclient\.login\(\s*(["'`])[\w-]{20,}\.[\w-]{5,}\.[\w-]{20,}\1/g, "that's a Discord token: log in with an nsec1… key ($VECTOR_NSEC)", "error"],
];

export function check(root: string): Finding[] {
  const out: Finding[] = [];
  const { real, stubs } = knownNames();
  const rel = (p: string) => path.relative(process.cwd(), p) || p;
  for (const f of files(root, [".js", ".cjs", ".mjs", ".ts", ".mts", ".cts"])) {
    const text = fs.readFileSync(f, "utf8");
    const lines = text.split("\n");
    const lineOf = (i: number) => text.slice(0, i).split("\n").length;
    // names imported from discord.js
    const importRe = /(?:const|let|var)\s*\{([^}]+)\}\s*=\s*require\(\s*["']discord\.js["']\s*\)|import\s*\{([^}]+)\}\s*from\s*["']discord\.js["']/g;
    for (const m of text.matchAll(importRe)) {
      for (const raw of (m[1] ?? m[2]).split(",")) {
        const name = raw.trim().split(/\s+as\s+|\s*:\s*/)[0].trim();
        if (!name) continue;
        if (stubs.has(name)) out.push({ level: stubs.get(name)!.startsWith("constant") ? "info" : "warn", file: rel(f), line: lineOf(m.index!), message: `${name}: ${stubs.get(name)}` });
        else if (!real.has(name)) out.push({ level: "error", file: rel(f), line: lineOf(m.index!), message: `${name} isn't available on Vector` });
      }
    }
    for (const [re, msg, level] of DISCORD_ONLY_CALLS) for (const m of text.matchAll(re)) out.push({ level, file: rel(f), line: lineOf(m.index!), message: msg });
    lines.forEach((l, i) => {
      if (/^\s*(\/\/|\*)/.test(l)) return;
      for (const m of l.matchAll(SNOWFLAKE)) out.push({ level: "warn", file: rel(f), line: i + 1, message: `hard-coded Discord id ${m[2] ?? m[3]}: Vector ids are npubs / 64-hex strings` });
      for (const m of l.matchAll(NUMERIC_ID)) out.push({ level: "warn", file: rel(f), line: i + 1, message: `${m[1]}() on an id: Vector ids aren't numbers; keep them as strings` });
      for (const m of l.matchAll(COLUMN)) out.push({ level: "warn", file: rel(f), line: i + 1, message: `column ${m[1]} is ${m[3]}: Vector ids are strings; use TEXT (--fix rewrites it)` });
    });
  }
  for (const f of files(root, [".sql"])) {
    fs.readFileSync(f, "utf8").split("\n").forEach((l, i) => {
      for (const m of l.matchAll(COLUMN)) out.push({ level: "warn", file: rel(f), line: i + 1, message: `column ${m[1]} is ${m[3]}: use TEXT (--fix rewrites it)` });
    });
  }
  return out.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
}

/** Rewrite ID columns declared INTEGER/BIGINT to TEXT. Returns files changed. */
export function fix(root: string): string[] {
  const changed: string[] = [];
  for (const f of files(root, [".js", ".cjs", ".mjs", ".ts", ".sql"])) {
    const text = fs.readFileSync(f, "utf8");
    const next = text.replace(COLUMN, (_m, name, sp) => `${name}${sp}TEXT`);
    if (next !== text) (fs.writeFileSync(f, next), changed.push(f));
  }
  return changed;
}

export function main(argv = process.argv.slice(2)): number {
  const [cmd, dir = ".", ...rest] = argv;
  if (cmd !== "check") {
    console.log("usage: vector-port check <dir|file> [--fix]");
    return cmd ? 2 : 0;
  }
  if (rest.includes("--fix")) for (const f of fix(dir)) console.log(`fixed ID columns in ${f}`);
  const found = check(dir);
  for (const f of found) console.log(`${f.file}:${f.line}: ${f.level}: ${f.message}`);
  const errors = found.filter((f) => f.level === "error").length;
  const warns = found.filter((f) => f.level === "warn").length;
  console.log(`\n${errors} error(s), ${warns} warning(s). Run it with:  npx vector-run ${dir === "." ? "index.js" : dir}`);
  return errors ? 1 : 0;
}
