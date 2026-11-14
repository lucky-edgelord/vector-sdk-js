# vector-sdk (JavaScript / TypeScript)

An **unofficial**, community-maintained, **discord.js-compatible** library for [Vector](https://vectorapp.io) messenger bots, powered by the official Rust `vector_sdk` (via napi-rs). Not affiliated with Discord or discord.js.

```js
const { Client, Events, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require("vector-sdk");
const client = new Client({ intents: [] });

client.once(Events.ClientReady, (c) => console.log(`Ready as ${c.user.tag}`));
client.on(Events.MessageCreate, async (msg) => {
  if (msg.content === "!ping") await msg.reply("Pong!");
});
client.login(process.env.VECTOR_NSEC); // an nsec1… key, not a Discord token
```

## Running an existing discord.js bot

```sh
npx vector-port check ./my-bot     # what needs attention (Discord ids, INTEGER id columns, Discord-only APIs)
VECTOR_NSEC=nsec1… npx vector-run ./my-bot/index.js
```

`vector-run` makes `require("discord.js")`, `@discordjs/builders`, `@discordjs/rest` and `@discordjs/voice` resolve to vector-sdk. A `deploy-commands.js` that calls `rest.put(Routes.applicationCommands(…))` saves the commands to `.vector-commands.json`, and the bot registers them at its next login.

## How Discord concepts map

| discord.js | Vector |
| --- | --- |
| Guild | Community (`guild.id` is the community id) |
| User / member id | npub (`user.toString()` → `nostr:npub…`) |
| Embeds | faux embeds: quote bar, fields table, image and footer as separate messages |
| Buttons / select menus | reactions on the message (emoji, 🇦🇧… or 1️⃣2️⃣…), arriving as `ButtonInteraction` / `StringSelectMenuInteraction` |
| Slash commands | Vector native commands (subcommands become `cmd-sub`) |
| Modals | questions asked in chat |
| Ephemeral replies | sent by DM |
| Webhooks | `channel.createWebhook()` plus a Discord-compatible HTTP server (`vector-webhooks serve`) |
| Voice | `channel.join()` / `joinVoiceChannel()`; bots can also *listen* |

Intents and partials are accepted and ignored. Threads, stickers, scheduled events, AutoMod and sharding don't exist on Vector; their names are importable but throw `NotSupportedOnVector` when used.

## Webhooks

```sh
VECTOR_NSEC=nsec1… npx vector-webhooks serve --port 8080 --base-url https://hooks.example.com
```

Admins type `!webhook create CI` in a channel and get a URL by DM. Anything that posts to Discord webhooks (CI, Grafana, uptime monitors) can post to it, and `…/slack` and `…/github` accept those formats.

## Building

Requires Node ≥ 22.5 and Rust.

```sh
npm install
npm run build:native   # compiles the Rust addon
npm run build
```

## License

MIT. See THIRD_PARTY_NOTICES.md.
