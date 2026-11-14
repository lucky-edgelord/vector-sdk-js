import { test } from "node:test";
import assert from "node:assert/strict";
import { readyClient, messageEvent, tick, ALICE, COMMUNITY, CHANNEL } from "./fake";
import { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder, SlashCommandBuilder, Events } from "../src/index";

test("ready loads communities and channels", async () => {
  const { client, bot } = await readyClient();
  const g = client.guilds.cache.get(COMMUNITY)!;
  assert.equal(g.name, "Test Community");
  assert.ok(g.channels.cache.get(CHANNEL));
  assert.equal(client.user!.id, bot.npub);
  await client.destroy();
});

test("messageCreate and reply", async () => {
  const { client, bot } = await readyClient();
  const got = new Promise<any>((r) => client.on(Events.MessageCreate, r));
  bot.push(messageEvent("!ping"));
  const msg = await got;
  assert.equal(msg.content, "!ping");
  assert.equal(msg.author.id, ALICE);
  assert.equal(msg.guild.id, COMMUNITY);
  await msg.reply("Pong!");
  const send = bot.calls.find((c) => c.method === "channel_send")!;
  assert.equal(send.args.text, "Pong!");
  assert.equal(send.args.reply_to, msg.id);
  await client.destroy();
});

test("embeds render as a faux embed", async () => {
  const { client, bot } = await readyClient();
  const ch: any = client.channels.resolve(CHANNEL);
  await ch.send({ content: "hi", embeds: [new EmbedBuilder().setTitle("Title").setDescription("Body").addFields({ name: "A", value: "1", inline: true })] });
  const [text] = bot.sentTexts();
  assert.match(text, /^hi/);
  assert.match(text, /Title/);
  assert.match(text, /Body/);
  assert.match(text, /A/);
  await client.destroy();
});

test("buttons become reactions and taps become ButtonInteractions", async () => {
  const { client, bot } = await readyClient();
  const ch: any = client.channels.resolve(CHANNEL);
  const row = new ActionRowBuilder<any>().addComponents(new ButtonBuilder().setCustomId("yes").setLabel("Yes").setEmoji("✅").setStyle(ButtonStyle.Success));
  const sent = await ch.send({ content: "ok?", components: [row] });
  assert.ok(bot.calls.some((c) => c.method === "channel_react" && c.args.emoji === "✅"));
  const got = new Promise<any>((r) => client.on("interactionCreate", r));
  bot.push({ type: "reaction_add", chat_id: CHANNEL, message: { id: sent.id, content: "ok?", at: Date.now(), mine: true, reactions: [] }, reaction: { id: "r1", emoji: "✅", author_id: ALICE }, at: Date.now() });
  const i = await got;
  assert.ok(i.isButton());
  assert.equal(i.customId, "yes");
  assert.equal(i.user.id, ALICE);
  await client.destroy();
});

test("select menus map number reactions to values", async () => {
  const { client, bot } = await readyClient();
  const ch: any = client.channels.resolve(CHANNEL);
  const sel = new StringSelectMenuBuilder().setCustomId("f").addOptions({ label: "Mint", value: "mint" }, { label: "Berry", value: "berry" });
  const sent = await ch.send({ content: "pick", components: [new ActionRowBuilder<any>().addComponents(sel)] });
  const got = new Promise<any>((r) => client.on("interactionCreate", r));
  bot.push({ type: "reaction_add", chat_id: CHANNEL, message: { id: sent.id, at: Date.now(), mine: true, reactions: [] }, reaction: { id: "r2", emoji: "2️⃣", author_id: ALICE }, at: Date.now() });
  const i = await got;
  assert.ok(i.isStringSelectMenu());
  assert.deepEqual(i.values, ["berry"]);
  await client.destroy();
});

test("slash commands register natively and dispatch with options", async () => {
  const { client, bot } = await readyClient();
  await client.application.commands.set([new SlashCommandBuilder().setName("echo").setDescription("Echo").addStringOption((o) => o.setName("text").setDescription("t").setRequired(true))]);
  assert.equal(bot.commands[0].name, "echo");
  const got = new Promise<any>((r) => client.on("interactionCreate", r));
  const m = messageEvent("/echo hi");
  bot.push({ type: "command", name: "echo", args: { text: "hi" }, message: m.message });
  const i = await got;
  assert.ok(i.isChatInputCommand());
  assert.equal(i.options.getString("text"), "hi");
  await i.reply("hi");
  assert.ok(bot.sentTexts().includes("hi"));
  await client.destroy();
});

test("subcommands flatten to cmd-sub", async () => {
  const { client, bot } = await readyClient();
  await client.application.commands.create(new SlashCommandBuilder().setName("cfg").setDescription("c").addSubcommand((s) => s.setName("show").setDescription("s")));
  assert.equal(bot.commands[0].name, "cfg-show");
  const got = new Promise<any>((r) => client.on("interactionCreate", r));
  bot.push({ type: "command", name: "cfg-show", args: {}, message: messageEvent("/cfg-show").message });
  const i = await got;
  assert.equal(i.commandName, "cfg");
  assert.equal(i.options.getSubcommand(), "show");
  await client.destroy();
});

test("login rejects Discord tokens", async () => {
  const { Client } = await import("../src/index");
  await assert.rejects(new Client().login("MTA5.abcdef.ghijklmnopqrstuvwxyz0123456789"), /Discord token/);
});

test("message delete and edit events", async () => {
  const { client, bot } = await readyClient();
  const created = new Promise<any>((r) => client.once("messageCreate", r));
  bot.push(messageEvent("before"));
  const m = await created;
  const edited = new Promise<any[]>((r) => client.once("messageUpdate", (a, b) => r([a, b])));
  bot.push({ type: "message_edit", chat_id: CHANNEL, message: { ...m.raw, content: "after" }, at: Date.now() });
  const [, after] = await edited;
  assert.equal(after.content, "after");
  const deleted = new Promise<any>((r) => client.once("messageDelete", r));
  bot.push({ type: "message_delete", chat_id: CHANNEL, message_id: m.id, by: ALICE, moderated: false, at: Date.now() });
  assert.equal((await deleted).id, m.id);
  await tick();
  await client.destroy();
});
