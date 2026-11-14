import { test } from "node:test";
import assert from "node:assert/strict";
import { BDScript, BDBot } from "../src/bdscript";
import { AoiClient } from "../src/aoijs";
import { readyClient, messageEvent, tick } from "./fake";

const bd = new BDScript(null, { database: ":memory:" });
bd.variables({ money: 10 });
const ev = (code: string, args?: string[]) => bd.evaluate(code, null, { args });

test("arithmetic, text and conditions", async () => {
  assert.equal(await ev("$sum[2;3] $toUppercase[ok]"), "5 OK");
  assert.equal(await ev("$if[1==1]yes$else no$endif"), "yes");
  assert.equal(await ev("$if[2>1;big;small]"), "big");
  assert.equal(await ev("$calculate[2^10 + (3*4)]"), "1036");
  assert.equal(await ev("$numberSeparator[1234567.5]"), "1,234,567.5");
  assert.equal(await ev("$message[2]", ["a", "b"]), "b");
  assert.equal(await ev("$replaceText[aaa;a;b;2]"), "bba");
});

test("loops, vars, json and errors", async () => {
  assert.equal(await ev("$for[i;1;3]<$var[i]>$endfor"), "<1><2><3>");
  assert.equal(await ev('$jsonParse[{"a":\\[1,2,{"b":"hi"}\\]}]$json[a;2;b] $jsonArrayCount[a]'), "hi 3");
  assert.equal(await ev("$try$sum[a;1]$catch caught: $error[message]$endtry"), "caught: invalid number 'a'");
  assert.match(await ev("$sum[a;1]"), /Function `\$sum` at 1:1 returned an error/);
  assert.match(await ev("$sum[1;2"), /Syntax error/);
});

test("persistent variables and cooldowns", async () => {
  assert.equal(await ev("$getVar[money]"), "10");
  await ev("$setVar[money;25]");
  assert.equal(await ev("$getVar[money]"), "25");
  assert.match(await ev("$getVar[nope]"), /doesn't exist/);
  const r1 = await bd.run("$cooldown[1m;wait %time%]ok", null, { send: false });
  const r2 = await bd.run("$cooldown[1m;wait %time%]ok", null, { send: false });
  assert.equal(r1.text, "ok");
  assert.match(r2.text, /^wait /);
});

test("embeds and buttons build the response", async () => {
  const r = await bd.run("$title[Hi]$description[Body]$color[vector]$addButton[no;b1;Click;primary]", null, { send: false });
  assert.equal(r.embeds[0].data.title, "Hi");
  assert.equal(r.embeds[0].data.color, 0x59fcb3);
  assert.equal(r.rows[0][0].customId, "b1");
});

test("custom JS functions", async () => {
  bd.function("shout", (_ctx, t = "") => t.toUpperCase() + "!");
  assert.equal(await ev("$shout[hey]"), "HEY!");
});

test("aoi.js client", async () => {
  const c = new AoiClient({ prefix: "!", intents: ["MessageContent"], events: ["onMessage"], database: { path: ":memory:" } });
  c.guildJoinCommand({ code: "x" });
  c.addFunction({ name: "$greet", params: ["who"], type: "aoi.js", code: "Hello {who}!" });
  c.functionErrorCommand({ code: "Oops: $handleError[error]" });
  assert.equal(await c.runCode("$greet[Vector]", { send: false }), "Hello Vector!");
  assert.equal(await c.runCode("$sum[a;1]", { send: false }), "Oops: invalid number 'a'");
  assert.deepEqual(Object.keys(c.ignoredCommands), ["guildJoin"]);
  await c.destroy();
});

test("BDBot answers prefix commands live", async () => {
  const { client, bot } = await readyClient();
  const b = new BDBot({ client, database: ":memory:", mentionAuthor: false });
  b.command({ name: "ping", code: "Pong $authorID" });
  bot.push(messageEvent("!ping"));
  await tick(150);
  assert.ok(bot.sentTexts().some((t) => t.startsWith("Pong npub1")));
  await b.destroy();
  await client.destroy();
});
