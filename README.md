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

## What's included

- **discord.js-compatible API**: `Client`, managers, `EmbedBuilder`, components, slash commands, collectors, permissions. [Porting guide](docs/porting-from-discordjs.md)
- **Faux embeds and custom emoji**: embeds render as Vector's quote-bar messages; emoji packs work in text, buttons and reactions.
- **Porting kit**: `vector-run`, `vector-port check`, the `REST` / `Routes` shim for `deploy-commands.js`.
- **Webhooks**: Discord-compatible HTTP server plus the bot-side `Webhook` / `WebhookClient`. [Docs](docs/webhooks.md)
- **BDScript**: every BDFD / D.js-BDscript function, run from `.bds` files or from JS. [Docs](docs/bdscript.md), [functions](docs/bdscript-functions.md)
- **aoi.js-style API**: `AoiClient` with SQLite storage. [Docs](docs/aoijs.md)

![Embed with quote bar](docs/images/embed-quote.png)

## Webhooks

```sh
VECTOR_NSEC=nsec1… npx vector-webhooks serve --port 8080 --base-url https://hooks.example.com
```

See [docs/webhooks.md](docs/webhooks.md). Admins type `!webhook create CI` in a channel and get a URL by DM. Anything that posts to Discord webhooks (CI, Grafana, uptime monitors) can post to it, and `…/slack` and `…/github` accept those formats.

## Reply order

Vector sorts messages by whole-second timestamps, so an instant reply could appear above the message it answers. Sends
therefore wait (at most ~2.5 s, usually well under one) until the bot's clock passes the incoming message's second.
`new Client({ replyOrdering: false })` turns it off.

## Building

Requires Node ≥ 22.5 and Rust.

```sh
npm install
npm run build:native   # compiles the Rust addon
npm run build
```

## License

MIT. See THIRD_PARTY_NOTICES.md.
