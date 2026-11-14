# aoi.js-style interface

`vector-sdk/aoijs` (also `require("aoi.js")` under `vector-run`) gives vector-sdk the API of [aoi.js](https://github.com/aoijs/aoi.js): `AoiClient`,
`client.command({...})`, `readyCommand`, `variables`, `loadCommands`, `addFunction` and friends. The `code` strings
are **BDScript** (see [bdscript.md](bdscript.md)), the same engine as the rest of the SDK, so all of its functions
work inside them. This is the interface, not a port of aoi.js's own function set.

```js
const { AoiClient } = require("vector-sdk/aoijs");

const client = new AoiClient({
  prefix: "!",
  intents: ["MessageContent"], events: ["onMessage"],     // accepted, ignored
  database: { path: "./database/aoi.db" },                // SQLite
});
client.variables({ coins: 0 });
client.command({ name: "ping", aliases: ["p"], code: "Pong! $ping ms" });
client.login(process.env.VECTOR_NSEC);                    // or: new AoiClient({ token: "nsec1…" })
```

## Options

`token`, `prefix` (string or list), `database` (a SQLite path or `{"path": ...}`), `mentionAuthor`, plus any
`Client` option (`dataDir`, `replyOrdering`, ...). aoi.js's `intents`, `events`, `respondOnEdit`, `sharding`, `cache` and
`debugs` are accepted so ported code loads. **Storage is always SQLite** (default `./database/aoi.db`); aoi.js's
database `type` and `db` are ignored.

## Commands

| aoi.js | here |
|---|---|
| `client.command({name, aliases, code, nonPrefixed})` | same, several dicts at once |
| `readyCommand`, `joinCommand`, `leaveCommand`, `banAddCommand`, `banRemoveCommand`, `deletedCommand`, `reactionAddCommand` | same; `channel` sends there |
| `awaitedCommand({name, code})` | same (use `$awaitFunc[name]` to trigger) |
| `interactionCommand({name, prototype, code})` | `name` is the button/menu/modal custom id; `prototype: "slash"` defines a slash command |
| `functionErrorCommand({code})` | renders function errors; `$handleError[function]`, `[command]`, `[error]` |
| `loopCommand({every, channel, executeOnStartup, code})` | `every` in ms or `"1h30m"` |
| `variables({...}, table)` | table accepted and ignored |
| `loadCommands(dir, debug)` | `.js` files `module.exports = {…}` or `[…]`; `.json` and `.bds` work too |
| `addFunction({name, params, type, code})` | `type: "aoi.js"` is BDScript with `{param}` placeholders; `"djs"` takes a JS function `(ctx, ...args)` |
| `onMessage()`, `onInteractionCreate()`, ... | no-ops (every event is on); chainable |
| `status(...)` | accepted; Vector bots have no presence |

Commands for Discord-only events (`guildJoinCommand`, `roleCreateCommand`, `presenceUpdateCommand`, ...) are
accepted so ported bots still load, but never run.

## Notes for aoi.js users

* Code is BDScript, not aoi.js's function set. BDScript runs top to bottom, and its embed functions don't take an
  index first (`$title[text]`, not `$title[1;text]`). Message formatters such as `{newEmbed:...}` are not supported.
* Every BDScript function is available, plus the Vector-only ones in [bdscript.md](bdscript.md).
* Already running a regular bot? `new BDScript(client)` attaches the same engine to it; see [bdscript.md](bdscript.md).
* Example bot: [examples/aoijs](../examples/aoijs); `new LoadCommands(client).load(client.cmd, "./commands")` works as in aoi.js.

## Reply order

Vector sorts messages by whole-second timestamps, so an instant reply could appear above the message it answers.
Sends therefore wait (at most ~2.5 s, usually well under one) until the bot's clock passes the incoming message's
second. Pass `replyOrdering: false` to turn it off. See the README for details.
