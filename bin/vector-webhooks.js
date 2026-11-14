#!/usr/bin/env node
// vector-webhooks serve: run a Vector bot plus a Discord-compatible webhook HTTP server in one process.
const { parseArgs } = require("node:util");
const { Client } = require("../dist");
const { serveWebhooks, WebhookStore } = require("../dist/webhooks");
const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    nsec: { type: "string", default: process.env.VECTOR_NSEC },
    host: { type: "string", default: "0.0.0.0" },
    port: { type: "string", default: process.env.PORT || "8080" },
    db: { type: "string", default: process.env.WEBHOOKS_DB || "webhooks.db" },
    "base-url": { type: "string", default: process.env.WEBHOOKS_BASE_URL },
    "admin-key": { type: "string", default: process.env.WEBHOOKS_ADMIN_KEY },
    "data-dir": { type: "string", default: process.env.VECTOR_DATA_DIR },
    prefix: { type: "string", default: "!" },
  },
});
if (positionals[0] !== "serve") {
  console.log("usage: vector-webhooks serve [--nsec nsec1…] [--port 8080] [--db webhooks.db] [--base-url https://…] [--admin-key KEY]\n\n" +
    "In any channel the bot can read, admins can type `!webhook create <name>`, `!webhook list`, `!webhook delete <id>`.");
  process.exit(positionals[0] ? 2 : 0);
}
if (!values.nsec) {
  console.error("--nsec or $VECTOR_NSEC is required");
  process.exit(2);
}
const port = Number(values.port);
const baseUrl = (values["base-url"] || `http://localhost:${port}`).replace(/\/+$/, "");
const store = new WebhookStore(values.db);
const client = new Client({ dataDir: values["data-dir"], webhookBaseUrl: baseUrl });
client.webhookStore = store;
const p = values.prefix;

client.on("messageCreate", async (msg) => {
  if (msg.author.id === client.user.id || !msg.content.startsWith(`${p}webhook`)) return;
  const [, sub, ...rest] = msg.content.trim().split(/\s+/);
  if (!msg.guild) return void msg.reply("Webhooks live in community channels.");
  const member = await msg.guild.members.fetch(msg.author.id).catch(() => null);
  if (!member?.permissions.has("ManageWebhooks") && !member?.permissions.has("Administrator") && msg.guild.ownerId !== msg.author.id) {
    return void msg.reply("You need permission to manage this channel to do that.");
  }
  if (sub === "create") {
    const { webhook, token } = store.create(rest.join(" ") || "webhook", msg.channel.id, msg.guild.id, msg.author.id);
    const url = `${baseUrl}/api/webhooks/${webhook.id}/${token}`;
    await msg.author.send(`Webhook **${webhook.name}** for #${msg.channel.name}:\n${url}\n\nKeep it secret: anyone with the URL can post. Append \`/slack\` or \`/github\` for those formats.`);
    await msg.reply(`Created **${webhook.name}** (id \`${webhook.id}\`). I DMed you the URL.`);
  } else if (sub === "list") {
    const hooks = store.list({ channelId: msg.channel.id });
    await msg.reply(hooks.length ? hooks.map((h) => `\`${h.id}\` **${h.name}**`).join("\n") : "No webhooks in this channel.");
  } else if (sub === "delete" && rest[0]) {
    await msg.reply(store.delete(rest[0]) ? "Deleted." : "No such webhook.");
  } else {
    await msg.reply(`\`${p}webhook create <name>\` · \`${p}webhook list\` · \`${p}webhook delete <id>\``);
  }
});
client.on("error", (e) => console.error(e));
client.once("ready", () => console.log(`bot ready as ${client.user.id}`));
(async () => {
  await client.login(values.nsec);
  const server = await serveWebhooks(client, { store, port, host: values.host, baseUrl, adminKey: values["admin-key"] });
  console.log(`webhooks listening on ${values.host}:${port} (public URL ${baseUrl})`);
  const stop = async () => (server.close(), await client.destroy(), process.exit(0));
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
})();
