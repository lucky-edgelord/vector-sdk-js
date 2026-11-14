import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { check, fix } from "../src/compat/port";
import { REST, Routes, commandsFile } from "../src/compat/stubs";

test("vector-port finds Discord-only names, ids and INTEGER columns", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "port-"));
  fs.writeFileSync(path.join(dir, "bot.js"), `const { Client, ShardingManager, Nope } = require("discord.js");\nconst OWNER = "123456789012345678";\ndb.exec("CREATE TABLE x (guild_id INTEGER)");\n`);
  const f = check(dir);
  assert.ok(f.some((x) => x.level === "error" && x.message.includes("Nope")));
  assert.ok(f.some((x) => x.message.includes("ShardingManager")));
  assert.ok(f.some((x) => x.message.includes("123456789012345678")));
  assert.ok(f.some((x) => x.message.includes("guild_id")));
  fix(dir);
  assert.match(fs.readFileSync(path.join(dir, "bot.js"), "utf8"), /guild_id TEXT/);
});

test("REST shim saves deployed commands", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rest-"));
  process.env.VECTOR_COMMANDS_FILE = path.join(dir, "cmds.json");
  await new REST().setToken("t").put(Routes.applicationCommands("1"), { body: [{ name: "hi", description: "hi" }] });
  assert.equal(JSON.parse(fs.readFileSync(commandsFile(), "utf8"))[0].name, "hi");
  delete process.env.VECTOR_COMMANDS_FILE;
});
