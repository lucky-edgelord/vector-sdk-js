# BDScript on Vector

`vector-sdk/bdscript` runs **BDScript 2** (Bot Designer for Discord) and **D.js-BDscript** code on Vector. Every
BDFD function (wiki and changelog), every function in D.js-BDscript, and a set of Vector-only functions are
implemented: see the [function reference](bdscript-functions.md). A test checks the list stays complete.

## Run a bot

```sh
npm install vector-sdk
VECTOR_NSEC=nsec1... vector-bdscript run ./my-bot      # files reload when they change
vector-bdscript check ./my-bot                         # syntax-check every command
vector-bdscript functions                              # list functions and their status
```

A bot folder holds one command per file plus an optional `bot.json` (prefix, owners, variables, slash commands).
See [`examples/bdscript`](../examples/bdscript).

```
---
trigger: !daily
---
$nomention
$cooldown[24h;Come back in %time%.]
$setUserVar[money;$sum[$getUserVar[money];100]]
+100 coins! You now have $getUserVar[money].
```

Header keys: `trigger` (a full trigger such as `!ping`, or a callback such as `$onJoined[channelID]`), `name`
(uses the bot prefix), `aliases`, `type` (D.js-BDscript types), `description`. `.json` files and `.js` files (`module.exports = {…}` or an array) work too.

## From JavaScript

```js
const { BDBot } = require("vector-sdk/bdscript");

const bot = new BDBot({ prefix: "!", database: "./bdscript.db" });   // SQLite
bot.variables({ money: 0 });
bot.command({ name: "ping", code: "Pong! $ping ms" });
bot.command({ trigger: "!balance", code: "$username has $getUserVar[money] coins." });
bot.command({ trigger: "$onJoined[<channel id>]", code: "Welcome $username!" });
bot.login(process.env.VECTOR_NSEC);
```

`BDBot` makes its own `Client` (`bot.client`). It takes every `Client` option plus `prefix`, `owners`, `database`,
`mentionAuthor`, `autoVariables`, `allowHttp`, `httpLimit`, `allowExec`, `allowFiles` and `ai`.
`new BDBot({ …, listen: false })` is a pure library. Load a folder with `bot.manager.load("./commands")` and
`bot.manager.watch()`.

## Inside a regular discord.js bot

```js
const { Client } = require("vector-sdk");
const { BDScript, BDScriptError } = require("vector-sdk/bdscript");

const client = new Client();
const bd = new BDScript(client);                      // adds listeners; your own handlers keep working
bd.command({ name: "balance", code: "$nomention You have $getUserVar[money] coins." });

client.on("messageCreate", async (msg) => {
  if (msg.content === "!hello") {
    const r = await bd.run("Hi $username! $randomText[a;b;c]", msg);   // call it from JS
    console.log(r.text, r.ok);
  }
});
client.login(process.env.VECTOR_NSEC);
```

`bd.run(code, from, options)` returns a `Result`:

| field | meaning |
|---|---|
| `text` / `String(result)` | the reply text |
| `ok` / `failure` | `false` and a BDFD-style message if a function failed or an `$onlyIf` / `$argsCheck` stopped the run |
| `embeds`, `rows`, `reactions`, `files` | what the script queued: `EmbedBuilder`s, button/select rows, … |
| `sent` | ids of messages the script sent itself (`$sendMessage`…) |
| `context` | the BDScript `Context`, for the curious |

`from` can be a `Message`, an interaction or a channel. Without one, give `{ channel, author }` in the options, or
nothing at all for pure computation. By default the reply is sent when there is a channel to send to.

Evaluate without sending anything:

```js
await bd.evaluate("$calculate[6*7] $toTitleCase[a b]");                 // "42 A B"
await bd.run("$getVar[money] / $message[1]", null, { args: "3", vars: { x: 1 }, send: false });
```

### Teach BDScript new functions in JavaScript

```js
bd.function("shout", (ctx, text = "") => {              // strings in, a string out; async works too
  if (!text) throw new BDScriptError("nothing to shout");   // shows as a normal function error
  return text.toUpperCase() + "!";
});
// BDScript:  $shout[hello]  ->  HELLO!
```

Registered functions are process-wide, so they work in every engine and in `.bds` files.

## Language

Everything in BDScript 2: top-to-bottom evaluation, `$if/$elseif/$else/$endif`, `$try/$catch/$error[]/$endtry`,
`$async[name]/$endasync/$await[name]`, `$eval[]`, `$var[]`, `$optOff[]`, `$c[]` comments, `$stop` (sends what's
queued), escapes `\; \[ \] \$ \\` and `%{DOL}%`, `%{-SEMICOL-}%`, `%semi%`, cached `$random` with uncached `$'random`
variants, BDFD error messages (`❌ Function $sum at 2:5 returned an error: ...`), `$suppressErrors`. D.js-BDscript's
inline `$if[condition;then;else]` works too (a `$if` with two or three arguments).

## Callbacks (triggers)

`$onJoined[channel]`, `$onLeave[channel]`, `$onBanAdd`, `$onBanRemove`, `$onMessageDelete`, `$onInteraction` /
`$onInteraction[customID]`, `$awaitedCommand[name]` / `$awaitedCommandError[name]` (with `$awaitFunc`),
`$onAutoComplete[command]`, `$alwaysReply`, `$messageContains[...]`, `$awaitReactions`. D.js-BDscript types:
`basicCommand`, `readyCommand`, `slashCommand`, `buttonCommand`, `musicStartCommand`, `musicEndCommand`.

## How Discord features map to Vector

| BDScript | On Vector |
|---|---|
| Servers, `$guildID`, `$serverName` | Communities (`$communityID`, `$communityName` also work) |
| IDs | 64-hex IDs and `npub`s; mentions `<@id>` are accepted everywhere |
| Embeds | Vector's quote-style embeds (Vector colours) |
| Buttons, select menus | Emoji reactions; buttons without an emoji get 🇦 🇧 🇨 |
| Modals | The bot asks each field in chat, then runs `$onInteraction[modalID]` with `$input[]` |
| `$ephemeral` | Sent to the user's DMs |
| Slash commands | Vector's `/` picker (bot-wide) |
| Custom emoji | Emoji packs (`$subscribeEmojiPack`, `<:name:id>` and `:name:`) |
| Webhooks | `Webhook` (`$webhookCreate`, `$webhookSend`, …) |
| Threads | A channel next to the parent (*partial*) |
| Boosts, HypeSquad, regions, shards, premium | Neutral values (*noop*), so code keeps running |
| `$ai`, `$aiDecide` … | Your model: `new BDBot({ ai })`, or Anthropic's API with `ANTHROPIC_API_KEY` |
| HTTP | Standard library, 35 s timeout, 5 requests per run (`new BDBot({ httpLimit })`) |

## Vector-only functions

`$npub[user]`, `$authorNpub`, `$botNpub`, `$isNpub[text]`, `$userAbout[user]`, `$isDM`,
`$expireIn[duration]` (disappearing reply), `$hideMessage[(channel;message)]`, `$sendMiniApp[name or URL;(channel)]`,
`$uploadImage[URL or attachment #]`, `$joinCommunity[invite]`, `$createCommunity[name;(description)]`,
`$pendingInvites`, `$acceptInvite[id]`, `$grantAdmin[user]`, `$revokeAdmin[user]`, `$communityRelays`,
`$containRaid[window;user;...]`, `$grantChannelAccess[channel;user]`, `$revokeChannelAccess[channel;user]`,
`$setChannelPrivate[channel;yes/no]`, `$setChannelReadOnly[channel;yes/no]`, `$isReadOnly`, `$blockUser`,
`$unblockUser`, `$setLocalNickname`, `$setBotName`, `$setBotAbout`, `$setBotAvatar`, `$setBotBanner`,
`$setBotStatus`, `$subscribeEmojiPack`, `$unsubscribeEmojiPack`, `$emojiPacks`, `$botEmojis`, `$say[text]`
(voice TTS), `$sendDM[user;text]`, and `$community...` names for every `$server...` function.

## Safety switches

`$exec` is off unless `new BDBot({ allowExec: true })`; local file paths (for `$attachment`, `$sendMiniApp`, music) need
`allowFiles: true`; HTTP can be turned off with `allowHttp: false`.

## Reply order

Replies are timestamped after the message they answer: sends wait briefly (at most ~2.5 s) when needed, so a fast
reply never shows above the question. This is on by default for every bot; `new BDBot({ replyOrdering: false })`
turns it off.
