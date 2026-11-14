import { test } from "node:test";
import assert from "node:assert/strict";
import * as http from "node:http";
import { readyClient, CHANNEL, COMMUNITY } from "./fake";
import { WebhookStore, createWebhookHandler, discordPayload, slackPayload, githubPayload, parseMultipart } from "../src/webhooks";
import { WebhookClient } from "../src/structures/Webhook";

test("store hashes tokens and verifies", () => {
  const s = new WebhookStore(":memory:");
  const { webhook, token } = s.create("CI", CHANNEL, COMMUNITY);
  assert.match(webhook.id, /^\d{19}$/);
  assert.ok(s.verify(webhook.id, token));
  assert.equal(s.verify(webhook.id, token + "x"), null);
  assert.equal(s.list({ channelId: CHANNEL }).length, 1);
  assert.ok(s.delete(webhook.id));
});

test("payload translation", () => {
  assert.deepEqual(discordPayload({ content: "hi", username: "CI" }).text, "**CI**\nhi");
  const sl = slackPayload({ text: "deploy", attachments: [{ title: "ok", color: "#36a64f", fields: [{ title: "env", value: "prod", short: true }] }] });
  assert.equal(sl.embeds[0].color, 0x36a64f);
  assert.equal(sl.embeds[0].fields![0].name, "env");
  const gh = githubPayload("push", { repository: { full_name: "a/b" }, ref: "refs/heads/main", commits: [{ id: "abcdef1234", message: "fix", url: "u" }] });
  assert.match(gh!.embeds[0].title!, /\[a\/b:main\] 1 new commit/);
  assert.equal(githubPayload("watch", {}), null);
});

test("multipart parser", () => {
  const b = "XyZ";
  const body = Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="payload_json"\r\n\r\n{"content":"hi"}\r\n--${b}\r\nContent-Disposition: form-data; name="files[0]"; filename="a.txt"\r\n\r\nfile!\r\n--${b}--\r\n`);
  const parts = parseMultipart(body, b);
  assert.equal(parts[0].data.toString(), '{"content":"hi"}');
  assert.equal(parts[1].filename, "a.txt");
  assert.equal(parts[1].data.toString(), "file!");
});

test("HTTP server posts into the channel and WebhookClient talks to it", async () => {
  const { client, bot } = await readyClient();
  const store = new WebhookStore(":memory:");
  const server = http.createServer(createWebhookHandler(client, store, { adminKey: "k", baseUrl: "http://127.0.0.1" }));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as any).port;
  const base = `http://127.0.0.1:${port}`;
  try {
    const created: any = await (await fetch(`${base}/admin/webhooks`, { method: "POST", headers: { authorization: "Bearer k", "content-type": "application/json" }, body: JSON.stringify({ channel_id: CHANNEL, name: "CI" }) })).json();
    assert.ok(created.token);
    const url = `${base}/api/webhooks/${created.id}/${created.token}`;
    const r = await fetch(`${url}?wait=true`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ content: "build passed", username: "CI" }) });
    assert.equal(r.status, 200);
    const msg: any = await r.json();
    assert.equal(msg.content, "build passed");
    assert.ok(bot.sentTexts().some((t) => t.includes("**CI**") && t.includes("build passed")));
    // wrong token
    assert.equal((await fetch(`${base}/api/webhooks/${created.id}/nope`, { method: "POST", body: "{}" })).status, 401);
    // discord.js-style WebhookClient
    const wc = new WebhookClient({ url });
    await wc.send({ content: "from WebhookClient" });
    assert.ok(bot.sentTexts().includes("from WebhookClient"));
    // GitHub ping
    const gh = await fetch(`${url}/github`, { method: "POST", headers: { "x-github-event": "ping", "content-type": "application/json" }, body: JSON.stringify({ zen: "Keep it simple", repository: { full_name: "a/b" } }) });
    assert.equal(gh.status, 204);
    // rate limit (5 per 2s)
    let limited = false;
    for (let i = 0; i < 6; i++) if ((await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: '{"content":"x"}' })).status === 429) limited = true;
    assert.ok(limited);
  } finally {
    server.close();
    await client.destroy();
  }
});

test("channel.createWebhook sends through the bot", async () => {
  const { client, bot } = await readyClient({ webhookDb: ":memory:" });
  const ch: any = client.channels.resolve(CHANNEL);
  const wh = await ch.createWebhook({ name: "Alerts" });
  assert.match(wh.url, /\/api\/webhooks\/\d+\//);
  await wh.send({ content: "disk full", username: "Grafana" });
  assert.ok(bot.sentTexts().some((t) => t === "**Grafana**\ndisk full"));
  assert.equal((await ch.fetchWebhooks()).size, 1);
  await client.destroy();
});
