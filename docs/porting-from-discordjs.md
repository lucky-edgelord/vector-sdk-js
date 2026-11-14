# Porting a discord.js bot to Vector

Most bots run unchanged. Three steps:

```sh
npm install vector-sdk
npx vector-port check ./your-bot          # find what needs attention (add --fix to repair SQL id columns)
VECTOR_NSEC=nsec1… npx vector-run ./your-bot/index.js
```

`vector-run` (or `node -r vector-sdk/register index.js`) makes `require("discord.js")`, `@discordjs/builders`,
`@discordjs/rest`, `@discordjs/voice`, `discord-api-types` and `aoi.js` resolve to this library. To make it permanent,
replace the dependency: `"discord.js": "npm:vector-sdk@^0.1"` in `package.json`, or change the imports to `vector-sdk`.

Log in with a Vector bot key instead of a token: `client.login(process.env.VECTOR_NSEC)`. A Discord token is rejected
with a message saying so.

## What works the same

`Client` and its events (`ready`/`clientReady`, `messageCreate`, `messageUpdate`, `messageDelete`,
`messageReactionAdd/Remove`, `guildCreate`, `guildMemberAdd/Remove`, `interactionCreate`, `typingStart`),
`Collection`, `EmbedBuilder`, `ActionRowBuilder` + `ButtonBuilder` / `StringSelectMenuBuilder` / `ModalBuilder`,
`SlashCommandBuilder` (+ subcommands), `PermissionsBitField`, message/reaction/interaction collectors, `awaitMessages`,
`guild.channels/roles/members/bans/invites` managers, `AttachmentBuilder`, webhooks (`createWebhook`, `WebhookClient`),
voice (`channel.join()`, `joinVoiceChannel`), and the usual `deploy-commands.js` script.

## What is different

| Discord | Vector | What to do |
| --- | --- | --- |
| Guilds | Communities (`guild` is a community; its `id` is the community id) | nothing |
| Snowflake IDs | 64-hex strings and `npub…` keys | keep IDs as strings; see below |
| Hard-coded IDs (owner, channels) | different values | move them to config; `vector-port` flags them |
| Bot token | `nsec…` secret key | pass it to `login()` |
| Embeds | Rendered as Vector markdown: quote bar, fields table, Vector's mint colour | nothing; colours you set are ignored |
| Buttons, selects | Emoji reactions under the message | nothing; a button without an emoji gets 🇦 🇧 🇨, options get 1️⃣ 2️⃣ 3️⃣ with a legend |
| Modals | The bot asks each field in chat | nothing; `awaitModalSubmit` works |
| Ephemeral replies | Sent by DM | nothing |
| Slash commands | Vector native commands, bot-wide (guild ids are ignored; subcommands are flattened to `cmd-sub`) | nothing |
| Custom emoji | Emoji from equipped packs: `client.emojis`, `<:name:id>` and `:name:` | `await client.emojis.subscribe(naddr)` once |
| Threads, stages, stickers, polls, AutoMod, scheduled events, sharding | Not in Vector | the names import; using one throws `NotSupportedOnVector` |
| Presence/status, intents, partials | Accepted; `setPresence` is a no-op, `setActivity` sets the profile status | nothing |
| Several bots in one process | One `Client` per identity works, but each needs its own `dataDir` | give each its own `dataDir` |

## IDs and databases

Vector IDs are strings, so every place a bot stores a Discord ID needs a text column.

* SQLite is forgiving: a text value in an ordinary `INTEGER` column is stored as text, so many bots just work.
* `INTEGER PRIMARY KEY` is the exception: SQLite requires real integers there. Change ID columns to `TEXT PRIMARY KEY`.
* `vector-port check --fix` rewrites ID-shaped columns (`guild_id`, `userId`, `channel_id`, …) from `INTEGER` / `BIGINT`
  to `TEXT` in `.sql` and `.js` / `.ts` files. A plain `id INTEGER PRIMARY KEY` row number is left alone.
* Delete the old database once, or migrate it: existing rows hold Discord snowflakes that match nothing on Vector.
* Remove `BigInt(id)` / `Number(id)` / `parseInt(id)` around IDs.

## Troubleshooting

* `X isn't available on Vector`: `vector-port check` reports whether the name is missing (error) or a stub (warning).
* `NotSupportedOnVector`: the bot used a Discord-only feature; wrap or remove that code path.
* Commands do nothing in a community: check the bot was invited (`invitePolicy: "public"` accepts every invite, or
  handle the `guildInvite` event).
* Slash commands: register them before or right after `login()`; they appear in Vector's `/` picker.
* `vector-port` exits non-zero while errors remain.
