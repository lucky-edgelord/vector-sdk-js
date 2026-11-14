//! Node.js bindings for the Vector messenger Rust SDK (`vector_sdk`).
//!
//! This addon is an implementation detail of the `vector-sdk` npm package, which wraps it in a
//! discord.js-style API. The surface is deliberately small:
//!
//! * `NativeBot.build(options)` logs in and returns a bot.
//! * `bot.call(method, args, data?)` runs one SDK operation addressed by ids. Arguments and the result
//!   are JSON; binary input/output (files, PCM, images) travels as a `Buffer`.
//! * `bot.nextEvent()` resolves with the next inbound event (or `null` once the queue closes).
//!
//! Live objects (voice calls, Mini App sessions) live in a handle table and are addressed by number.

#![deny(clippy::all)]

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use napi::bindgen_prelude::Buffer;
use napi::Result;
use napi_derive::napi;
use serde_json::{json, Map, Value};
use tokio::sync::mpsc::{unbounded_channel, UnboundedReceiver, UnboundedSender};
use tokio::sync::Mutex;
use vector_sdk::{
    Attachment, Channel, Cursor, InvitePolicy, NewChannel, NewCommunity, Overwrite, Permissions, PostOptions, RoleSpec,
    VectorBot,
};

mod convert;
use convert::{audit_json, bytes_to_pcm, err, event_json, hex, incoming_json, invalid, json_of, other, pcm_to_bytes};

pub const SDK_VERSION: &str = "0.12.0";

#[napi]
pub fn sdk_version() -> &'static str {
    SDK_VERSION
}

/// Which optional features this build has.
#[napi]
pub fn features() -> Vec<&'static str> {
    let mut f = vec![];
    if cfg!(feature = "voice") {
        f.push("voice");
    }
    if cfg!(feature = "xdc") {
        f.push("xdc");
    }
    if cfg!(feature = "whisper") {
        f.push("whisper");
    }
    if cfg!(feature = "tor") {
        f.push("tor");
    }
    if cfg!(feature = "i2p") {
        f.push("i2p");
    }
    f
}

/// Mint a fresh `nsec1…` secret key.
#[napi]
pub fn generate_nsec() -> Result<String> {
    VectorBot::generate_nsec().map_err(err)
}

/// Let Mini App sessions join even over Tor/I2P (peers can see the bot's IP).
#[cfg(feature = "xdc")]
#[napi]
pub fn allow_outside_transport(on: bool) {
    vector_sdk::xdc::allow_outside_transport(on);
}

// ------------------------------------------------------------------------------------------------
// Arguments
// ------------------------------------------------------------------------------------------------

struct Args(Map<String, Value>);

impl Args {
    fn get(&self, k: &str) -> Option<&Value> {
        self.0.get(k).filter(|v| !v.is_null())
    }
    fn s(&self, k: &str) -> Result<String> {
        self.os(k).ok_or_else(|| invalid(format!("missing argument {k:?}")))
    }
    fn os(&self, k: &str) -> Option<String> {
        self.get(k).map(|v| match v {
            Value::String(s) => s.clone(),
            other => other.to_string(),
        })
    }
    fn u(&self, k: &str) -> Result<u64> {
        self.ou(k).ok_or_else(|| invalid(format!("missing number {k:?}")))
    }
    fn ou(&self, k: &str) -> Option<u64> {
        self.get(k).and_then(|v| v.as_u64().or_else(|| v.as_f64().map(|f| f.max(0.0) as u64)).or_else(|| v.as_str().and_then(|s| s.parse().ok())))
    }
    fn of(&self, k: &str) -> Option<f64> {
        self.get(k).and_then(Value::as_f64)
    }
    fn b(&self, k: &str, default: bool) -> bool {
        self.get(k).and_then(Value::as_bool).unwrap_or(default)
    }
    fn ob(&self, k: &str) -> Option<bool> {
        self.get(k).and_then(Value::as_bool)
    }
    fn vs(&self, k: &str) -> Vec<String> {
        self.get(k)
            .and_then(Value::as_array)
            .map(|a| a.iter().filter_map(|v| v.as_str().map(str::to_string)).collect())
            .unwrap_or_default()
    }
}

fn post_opts(a: &Args, caption: Option<String>) -> PostOptions {
    let mut o = PostOptions::default().compress(a.b("compress", true));
    if let Some(r) = a.os("reply_to") {
        o = o.reply_to(r);
    }
    if let Some(s) = a.ou("expires_in") {
        o = o.expires_in(s);
    }
    if let Some(b) = a.os("to_bot") {
        o = o.to_bot(b);
    }
    if let Some(c) = caption {
        o = o.caption(c);
    }
    o
}

fn cursor(s: Option<String>) -> Result<Option<Cursor>> {
    s.map(|s| s.parse::<Cursor>().map_err(invalid)).transpose()
}

fn role_spec(a: &Args) -> RoleSpec {
    let mut s = RoleSpec::unchanged();
    if let Some(n) = a.os("name") {
        s = s.name(n);
    }
    if let Some(c) = a.ou("color") {
        s = s.color(c as u32);
    }
    if let Some(p) = a.ou("permissions") {
        s = s.permissions(Permissions(p));
    }
    if let Some(c) = a.os("channel_id") {
        s = s.in_channel(c);
    }
    match a.ob("shown") {
        Some(true) => s = s.shown(),
        Some(false) => s = s.hidden(),
        None => {}
    }
    if let Some(m) = a.ob("mentionable") {
        s = s.mentionable(m);
    }
    s
}

fn target(kind: &str, id: Option<String>) -> Result<vector_sdk::OverwriteTarget> {
    use vector_sdk::OverwriteTarget as T;
    Ok(match kind {
        "everyone" => T::Everyone,
        "role" => T::Role(id.ok_or_else(|| other("needs a role id"))?),
        "member" => T::Member(id.ok_or_else(|| other("needs an npub"))?),
        k => return Err(invalid(format!("unknown overwrite target {k:?}"))),
    })
}

/// Slash command manifest rules, checked up front so a bad spec is a clean error instead of a panic.
fn validate_command(name: &str, description: &str, args: &[(String, String, String, bool, Vec<String>)]) -> std::result::Result<(), String> {
    fn slug(s: &str) -> bool {
        !s.is_empty() && s.len() <= 32 && s.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_' || b == b'-')
    }
    if !slug(name) {
        return Err(format!("bad command name {name:?} (lowercase a-z, 0-9, '_' or '-', at most 32)"));
    }
    if description.len() > 200 {
        return Err("description longer than 200 bytes".into());
    }
    if args.len() > 8 {
        return Err("more than 8 arguments".into());
    }
    let mut seen = std::collections::HashSet::new();
    let mut optional_seen = false;
    for (n, t, d, required, choices) in args {
        if !slug(n) {
            return Err(format!("bad argument name {n:?}"));
        }
        if !seen.insert(n) {
            return Err(format!("duplicate argument {n:?}"));
        }
        if d.len() > 200 {
            return Err(format!("description of {n:?} longer than 200 bytes"));
        }
        if *required && optional_seen {
            return Err(format!("required argument {n:?} after an optional one"));
        }
        optional_seen |= !required;
        if t == "choice" {
            if choices.is_empty() || choices.len() > 32 || choices.iter().any(|c| c.is_empty() || c.len() > 32) {
                return Err(format!("choice argument {n:?} needs 1-32 choices of 1-32 bytes"));
            }
        } else if !choices.is_empty() {
            return Err(format!("choices on non-choice argument {n:?}"));
        }
    }
    Ok(())
}

// ------------------------------------------------------------------------------------------------
// Live handles
// ------------------------------------------------------------------------------------------------

#[cfg(feature = "xdc")]
struct XdcHandle {
    inner: Mutex<Option<vector_sdk::XdcSession>>,
    sender: vector_sdk::XdcSender,
}

enum Handle {
    #[cfg(feature = "voice")]
    Voice(Arc<vector_sdk::VoiceCall>),
    #[cfg(feature = "xdc")]
    Xdc(Arc<XdcHandle>),
}

#[cfg(feature = "xdc")]
fn app_json(x: &vector_sdk::Xdc) -> Value {
    json!({
        "chat_id": x.chat_id(), "message_id": x.message_id(), "file_name": x.file_name(),
        "file_hash": x.file_hash(), "topic": x.topic(),
        "attachment": serde_json::to_value(x.attachment()).unwrap_or(Value::Null),
    })
}

#[cfg(feature = "xdc")]
fn peer_json(p: &vector_sdk::XdcPeer) -> Value {
    json!({"node": hex(&p.node), "npub": p.npub})
}

// ------------------------------------------------------------------------------------------------
// The bot
// ------------------------------------------------------------------------------------------------

struct Inner {
    bot: VectorBot,
    tx: UnboundedSender<Value>,
    rx: Mutex<UnboundedReceiver<Value>>,
    shutdown: tokio::sync::Notify,
    handles: std::sync::Mutex<HashMap<u64, Handle>>,
    next_handle: AtomicU64,
}

impl Inner {
    fn ch(&self, id: String, kind: Option<&str>) -> Channel {
        match kind {
            Some("dm") => self.bot.dm(id),
            Some("community") => self.bot.community(String::new()).channel(id),
            _ => self.bot.channel(id),
        }
    }

    fn overwrite(&self, community_id: &str, target_kind: &str, target_id: Option<String>, allow: u64, deny: u64) -> Result<Overwrite> {
        let base = match target_kind {
            "everyone" => Overwrite::everyone(),
            "role" => Overwrite::role(&self.bot.community(community_id.to_string()).role(target_id.ok_or_else(|| other("role overwrite needs a role id"))?)),
            "member" => Overwrite::member(target_id.ok_or_else(|| other("member overwrite needs an npub"))?),
            k => return Err(invalid(format!("unknown overwrite target {k:?}"))),
        };
        Ok(base.allow(Permissions(allow)).deny(Permissions(deny)))
    }

    #[allow(dead_code)]
    fn add_handle(&self, h: Handle) -> u64 {
        let id = self.next_handle.fetch_add(1, Ordering::Relaxed);
        self.handles.lock().unwrap().insert(id, h);
        id
    }

    #[cfg(feature = "voice")]
    fn voice(&self, a: &Args) -> Result<Arc<vector_sdk::VoiceCall>> {
        let id = a.u("handle")?;
        match self.handles.lock().unwrap().get(&id) {
            Some(Handle::Voice(v)) => Ok(v.clone()),
            _ => Err(other(format!("no voice call #{id}"))),
        }
    }

    #[cfg(feature = "xdc")]
    fn xdc(&self, a: &Args) -> Result<Arc<XdcHandle>> {
        let id = a.u("handle")?;
        match self.handles.lock().unwrap().get(&id) {
            Some(Handle::Xdc(x)) => Ok(x.clone()),
            _ => Err(other(format!("no Mini App session #{id}"))),
        }
    }
}

/// What a call returns: a JSON value, plus bytes for binary results.
#[napi(object)]
pub struct CallResult {
    pub value: Value,
    pub bytes: Option<Buffer>,
}

fn j(v: Value) -> CallResult {
    CallResult { value: v, bytes: None }
}

fn unit() -> CallResult {
    j(Value::Null)
}

fn bytes(b: Vec<u8>) -> CallResult {
    CallResult { value: Value::Null, bytes: Some(b.into()) }
}

#[napi]
pub struct NativeBot {
    inner: Arc<Inner>,
}

#[napi]
impl NativeBot {
    /// Build (log in) a bot. Options mirror `VectorBotBuilder`: `nsec`, `mnemonic`, `password`, `data_dir`,
    /// `invite_policy` ("manual" | "public"), `whitelist`, `catch_up` ("inline" | "external"), `clearnet`,
    /// `tor`, `tor_bridges`, `i2p`, `i2p_sam_port`, `xdc_download_limit`.
    #[napi(factory)]
    pub async fn build(options: Value) -> Result<NativeBot> {
        let a = Args(options.as_object().cloned().unwrap_or_default());
        let mut b = VectorBot::builder();
        if let Some(k) = a.os("nsec") {
            b = b.nsec(k);
        } else if let Some(m) = a.os("mnemonic") {
            b = b.mnemonic(m);
        }
        if let Some(p) = a.os("password") {
            b = b.password(p);
        }
        if let Some(d) = a.os("data_dir") {
            b = b.data_dir(d);
        }
        let whitelist = a.vs("whitelist");
        let policy = a.os("invite_policy").unwrap_or_else(|| "manual".into());
        b = if !whitelist.is_empty() {
            b.whitelist(whitelist)
        } else {
            match policy.as_str() {
                "public" => b.public(),
                "manual" => b.invite_policy(InvitePolicy::Manual),
                p => return Err(invalid(format!("invite_policy must be 'manual' or 'public', not {p:?}"))),
            }
        };
        b = b.catch_up(match a.os("catch_up").as_deref().unwrap_or("inline") {
            "inline" => vector_sdk::CatchUp::Inline,
            "external" => vector_sdk::CatchUp::External,
            c => return Err(invalid(format!("catch_up must be 'inline' or 'external', not {c:?}"))),
        });
        if a.b("clearnet", false) {
            b = b.clearnet();
        }
        if a.b("tor", false) {
            #[cfg(feature = "tor")]
            {
                b = b.tor();
                let br = a.vs("tor_bridges");
                if !br.is_empty() {
                    b = b.tor_bridges(br);
                }
            }
            #[cfg(not(feature = "tor"))]
            return Err(other("this build has no Tor support: rebuild with the `tor` feature"));
        }
        if a.b("i2p", false) {
            #[cfg(feature = "i2p")]
            {
                let mut o = vector_sdk::I2pOptions::default();
                if let Some(p) = a.ou("i2p_sam_port") {
                    o.sam_port = p as u16;
                }
                b = b.i2p_with(o);
            }
            #[cfg(not(feature = "i2p"))]
            return Err(other("this build has no I2P support: rebuild with the `i2p` feature"));
        }
        #[cfg(feature = "xdc")]
        if let Some(n) = a.ou("xdc_download_limit") {
            b = b.xdc_download_limit(n as usize);
        }
        let bot = b.build().await.map_err(err)?;
        let (tx, rx) = unbounded_channel();
        Ok(NativeBot {
            inner: Arc::new(Inner {
                bot,
                tx,
                rx: Mutex::new(rx),
                shutdown: tokio::sync::Notify::new(),
                handles: std::sync::Mutex::new(HashMap::new()),
                next_handle: AtomicU64::new(1),
            }),
        })
    }

    #[napi(getter)]
    pub fn npub(&self) -> String {
        self.inner.bot.npub().to_string()
    }

    /// Start the SDK listener; resolves when the bot disconnects. Events go to `nextEvent()`.
    #[napi]
    pub async fn start(&self) -> Result<()> {
        let inner = self.inner.clone();
        let etx = inner.tx.clone();
        let res = tokio::select! {
            r = inner.bot.on_event(move |_bot, ev| {
                let tx = etx.clone();
                async move {
                    let _ = tx.send(event_json(&ev));
                }
            }) => r,
            _ = inner.shutdown.notified() => Ok(()),
        };
        let _ = inner.tx.send(json!({"type": "disconnect", "error": res.as_ref().err().map(|e| e.to_string())}));
        res.map_err(err)
    }

    /// The next inbound event, or `null` once the queue is closed.
    #[napi]
    pub async fn next_event(&self) -> Result<Option<Value>> {
        let inner = self.inner.clone();
        let mut rx = inner.rx.lock().await;
        Ok(rx.recv().await)
    }

    /// Stop the listener started by `start()` (without logging out).
    #[napi]
    pub fn stop(&self) {
        self.inner.shutdown.notify_one();
    }

    /// Stop listening, disconnect from relays and close the database.
    #[napi]
    pub async fn logout(&self) -> Result<()> {
        self.inner.shutdown.notify_one();
        self.inner.bot.logout().await;
        Ok(())
    }

    /// Register a native slash command. `args`: `[{name, type, description, required, choices}]` with type
    /// `string|int|number|flag|user|choice`. Invocations arrive as `{type: "command", ...}` events.
    #[napi]
    pub fn register_command(&self, name: String, description: String, args: Value) -> Result<()> {
        let mut spec: Vec<(String, String, String, bool, Vec<String>)> = Vec::new();
        for a in args.as_array().cloned().unwrap_or_default() {
            let a = Args(a.as_object().cloned().unwrap_or_default());
            spec.push((a.s("name")?, a.os("type").unwrap_or_else(|| "string".into()), a.os("description").unwrap_or_default(), a.b("required", false), a.vs("choices")));
        }
        validate_command(&name, &description, &spec).map_err(|e| invalid(format!("invalid command /{name}: {e}")))?;
        let mut b = self.inner.bot.command(&name, &description);
        let mut kinds = Vec::new();
        for (n, t, d, req, choices) in &spec {
            b = match t.as_str() {
                "string" => b.string(n, d, *req),
                "int" => b.int(n, d, *req),
                "number" => b.number(n, d, *req),
                "flag" => b.flag(n, d, *req),
                "user" => b.user(n, d, *req),
                "choice" => b.choice(n, d, choices.clone(), *req),
                o => return Err(invalid(format!("unknown argument type {o:?}"))),
            };
            kinds.push((n.clone(), t.clone()));
        }
        let tx = self.inner.tx.clone();
        let cmd = name.clone();
        let handler = move |ctx: vector_sdk::CommandCtx| {
            let tx = tx.clone();
            let kinds = kinds.clone();
            let cmd = cmd.clone();
            async move {
                let mut a = Map::new();
                for (n, t) in kinds {
                    let v = match t.as_str() {
                        "int" => ctx.int(&n).map(Value::from),
                        "number" => ctx.number(&n).map(Value::from),
                        "flag" => ctx.flag(&n).map(Value::from),
                        _ => ctx.str(&n).map(Value::from),
                    };
                    a.insert(n, v.unwrap_or(Value::Null));
                }
                let _ = tx.send(json!({"type": "command", "name": cmd, "args": a, "message": incoming_json(&ctx.msg)}));
            }
        };
        std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| b.run(handler))).map_err(|p| {
            let why = p.downcast_ref::<String>().cloned().or_else(|| p.downcast_ref::<&str>().map(|s| s.to_string())).unwrap_or_default();
            invalid(format!("invalid command /{name}: {why}"))
        })
    }

    /// Register a Mini App handler. Sessions arrive as `{type: "xdc_session", handler, app, session}` where
    /// `session` is a handle for the `xdc_*` calls.
    #[cfg(feature = "xdc")]
    #[napi]
    pub fn register_xdc(&self, options: Value) -> Result<u32> {
        let a = Args(options.as_object().cloned().unwrap_or_default());
        let app = a.s("app")?;
        let matcher = if a.b("by_hash", false) { vector_sdk::XdcMatch::Hash(app) } else { vector_sdk::XdcMatch::from(app.as_str()) };
        let when = match a.os("join_when").as_deref().unwrap_or("opened") {
            "opened" => vector_sdk::JoinWhen::Opened,
            "shared" => vector_sdk::JoinWhen::Shared,
            w => return Err(invalid(format!("join_when must be 'opened' or 'shared', not {w:?}"))),
        };
        let handler = self.inner.next_handle.fetch_add(1, Ordering::Relaxed);
        let inner = Arc::downgrade(&self.inner);
        self.inner
            .bot
            .xdc(matcher)
            .join_when(when)
            .idle_timeout(Some(a.of("idle_timeout").unwrap_or(180.0)).filter(|s| *s > 0.0).map(Duration::from_secs_f64))
            .quiet_timeout(Some(a.of("quiet_timeout").unwrap_or(900.0)).filter(|s| *s > 0.0).map(Duration::from_secs_f64))
            .max_sessions(a.ou("max_sessions").unwrap_or(32) as usize)
            .max_per_chat(a.ou("max_per_chat").unwrap_or(4) as usize)
            .run(move |_bot, session| {
                let inner = inner.clone();
                async move {
                    if let Some(inner) = inner.upgrade() {
                        let app = app_json(session.app());
                        let self_addr = session.self_addr().to_string();
                        let sender = session.sender();
                        let id = inner.add_handle(Handle::Xdc(Arc::new(XdcHandle { inner: Mutex::new(Some(session)), sender })));
                        let _ = inner.tx.send(json!({"type": "xdc_session", "handler": handler, "app": app, "session": id, "self_addr": self_addr}));
                    }
                }
            });
        Ok(handler as u32)
    }

    /// Run one SDK operation. See `src/native.ts` for the typed list of methods.
    #[napi]
    pub async fn call(&self, method: String, args: Option<Value>, data: Option<Buffer>) -> Result<CallResult> {
        let inner = self.inner.clone();
        let a = Args(args.and_then(|v| v.as_object().cloned()).unwrap_or_default());
        let data: Option<Vec<u8>> = data.map(|b| b.to_vec());
        dispatch(inner, &method, a, data).await
    }
}

#[allow(clippy::too_many_lines)]
async fn dispatch(inner: Arc<Inner>, method: &str, a: Args, data: Option<Vec<u8>>) -> Result<CallResult> {
    let bot = inner.bot.clone();
    let kind = a.os("kind");
    Ok(match method {
        // ---- account ----
        "subscription_ready" => j(json!(bot.subscription_ready())),
        "generate_nsec" => j(json!(VectorBot::generate_nsec().map_err(err)?)),

        // ---- invites, communities, joining ----
        "pending_invites" => j(json_of(&bot.pending_invites().map_err(err)?)),
        "accept_invite" => j(bot.accept_invite(&a.s("community_id")?).await.map_err(err)?),
        "process_pending_invites" => {
            bot.process_pending_invites().await;
            unit()
        }
        "communities" => j(json!(bot.communities().await.iter().map(|c| c.id().to_string()).collect::<Vec<_>>())),
        "create_community" => {
            let mut o = NewCommunity::default();
            if let Some(d) = a.os("description") {
                o = o.description(d);
            }
            if let Some(f) = a.os("first_channel") {
                o = o.first_channel(f);
            }
            let relays = a.vs("relays");
            if !relays.is_empty() {
                o = o.relays(relays);
            }
            j(json!(bot.create_community(&a.s("name")?, o).await.map_err(err)?.id().to_string()))
        }
        "join" => j(json!(bot.join(&a.s("invite_url")?).await.map_err(err)?.id().to_string())),
        "preview_link" => j(json_of(&bot.preview_link(&a.s("invite_url")?).await.map_err(err)?)),

        // ---- messages ----
        "message" => j(bot.message(&a.s("message_id")?).await.map(|m| incoming_json(&m)).unwrap_or(Value::Null)),
        "messages_with_attachment" => j(Value::Array(bot.messages_with_attachment(&a.s("content_hash")?).await.iter().map(incoming_json).collect())),
        "sync_dms" => j(json_of(&bot.sync_dms(a.ou("since_days")).await.map_err(err)?)),
        "sync_communities" => j(json_of(&bot.sync_communities().await.map_err(err)?)),

        // ---- profiles ----
        "fetch_profile" => j(bot.fetch_profile(&a.s("npub")?).await.map(|p| json_of(&p)).unwrap_or(Value::Null)),
        "cached_profile" => j(bot.cached_profile(&a.s("npub")?).await.map(|p| json_of(&p)).unwrap_or(Value::Null)),
        "update_profile" => j(json_of(
            &bot.update_profile(&a.os("name").unwrap_or_default(), &a.os("avatar").unwrap_or_default(), &a.os("banner").unwrap_or_default(), &a.os("about").unwrap_or_default())
                .await
                .map_err(err)?,
        )),
        "set_status" => j(json_of(&bot.set_status(&a.s("status")?).await.map_err(err)?)),
        "block" => j(json_of(&bot.block(&a.s("npub")?).await.map_err(err)?)),
        "unblock" => j(json_of(&bot.unblock(&a.s("npub")?).await.map_err(err)?)),
        "set_local_nickname" => j(json_of(&bot.set_nickname(&a.s("npub")?, &a.s("nickname")?).await.map_err(err)?)),
        "blocked_users" => j(json_of(&bot.blocked_users().await)),
        "upload_image" => j(json_of(&bot.upload_image(a.s("path")?).await.map_err(err)?)),

        // ---- custom emoji ----
        "subscribe_emoji_pack" => j(json_of(&bot.subscribe_emoji_pack(&a.s("naddr")?).await.map_err(err)?)),
        "unsubscribe_emoji_pack" => j(json_of(&bot.unsubscribe_emoji_pack(&a.s("naddr")?).await.map_err(err)?)),
        "emoji_packs" => j(json_of(&bot.emoji_packs().map_err(err)?)),
        "emojis" => j(json_of(&bot.emojis())),
        "refresh_emoji_packs" => j(json_of(&bot.refresh_emoji_packs().await.map_err(err)?)),

        // ---- attachments ----
        "download_attachment" => {
            let att: Attachment = serde_json::from_value(a.get("attachment").cloned().unwrap_or(Value::Null)).map_err(|e| invalid(format!("bad attachment: {e}")))?;
            bytes(bot.download_attachment_from(&att, a.os("author_npub").as_deref()).await.map_err(err)?)
        }

        // ---- channels ----
        "channel_kind" => j(json!(if bot.channel(a.s("id")?).is_dm() { "dm" } else { "community" })),
        "channel_community" => j(json!(inner.ch(a.s("id")?, kind.as_deref()).community().map(|c| c.id().to_string()))),
        "channel_send" => {
            let c = inner.ch(a.s("id")?, kind.as_deref());
            let text = a.s("text")?;
            let r = if a.get("reply_to").is_none() && a.get("expires_in").is_none() && a.get("to_bot").is_none() {
                c.send(&text).await
            } else {
                c.post(&text, post_opts(&a, None)).await
            };
            j(json_of(&r.map_err(err)?))
        }
        "channel_send_bytes" => {
            let c = inner.ch(a.s("id")?, kind.as_deref());
            let buf = data.ok_or_else(|| invalid("channel_send_bytes needs data"))?;
            j(json_of(&c.send_bytes(buf, &a.s("filename")?, post_opts(&a, a.os("caption"))).await.map_err(err)?))
        }
        "channel_send_file" => {
            let c = inner.ch(a.s("id")?, kind.as_deref());
            j(json_of(&c.send_file_with(a.s("path")?, post_opts(&a, a.os("caption"))).await.map_err(err)?))
        }
        "channel_react" => {
            let c = inner.ch(a.s("id")?, kind.as_deref());
            let (m, e) = (a.s("message_id")?, a.s("emoji")?);
            j(json_of(&match a.os("image_url") {
                Some(url) => c.react_custom(&m, &e, &url).await.map_err(err)?,
                None => c.react(&m, &e).await.map_err(err)?,
            }))
        }
        "channel_unreact" => j(json_of(&inner.ch(a.s("id")?, kind.as_deref()).unreact(&a.s("message_id")?, &a.s("emoji")?).await.map_err(err)?)),
        "channel_typing" => j(json_of(&inner.ch(a.s("id")?, kind.as_deref()).typing().await.map_err(err)?)),
        "channel_edit" => j(json_of(&inner.ch(a.s("id")?, kind.as_deref()).edit(&a.s("message_id")?, &a.s("text")?).await.map_err(err)?)),
        "channel_delete_message" => j(json_of(&inner.ch(a.s("id")?, kind.as_deref()).delete(&a.s("message_id")?).await.map_err(err)?)),
        "channel_hide" => j(json_of(&inner.ch(a.s("id")?, kind.as_deref()).hide(&a.s("message_id")?).await.map_err(err)?)),
        "channel_history" => {
            let c = inner.ch(a.s("id")?, kind.as_deref());
            let limit = a.ou("limit").unwrap_or(50) as usize;
            j(json_of(&match cursor(a.os("before"))? {
                Some(cur) => c.history_before(&cur, limit).await,
                None => c.history(limit).await,
            }))
        }
        "channel_sync" => {
            let c = inner.ch(a.s("id")?, Some("community"));
            let max = a.ou("max_events").unwrap_or(500) as usize;
            j(json_of(&match (cursor(a.os("before"))?, a.ou("since_ms")) {
                (Some(cur), _) => c.sync_before(&cur, max).await.map_err(err)?,
                (None, Some(s)) => c.sync_since(s, max).await.map_err(err)?,
                (None, None) => c.sync(max).await.map_err(err)?,
            }))
        }
        "channel_info" => j(json_of(&inner.ch(a.s("id")?, Some("community")).info().map_err(err)?)),
        "channel_rename" => j(json_of(&inner.ch(a.s("id")?, Some("community")).rename(&a.s("name")?).await.map_err(err)?)),
        "channel_set_topic" => j(json_of(&inner.ch(a.s("id")?, Some("community")).set_topic(a.os("topic").as_deref()).await.map_err(err)?)),
        "channel_set_view" => j(json_of(&inner.ch(a.s("id")?, Some("community")).set_view(&a.s("view")?).await.map_err(err)?)),
        "channel_set_read_only" => j(json_of(&inner.ch(a.s("id")?, Some("community")).set_read_only(a.b("read_only", true)).await.map_err(err)?)),
        "channel_move" => {
            let c = inner.ch(a.s("id")?, Some("community"));
            let cat = match (a.os("category_id"), c.community()) {
                (Some(k), Some(comm)) => Some(comm.category(k)),
                (Some(_), None) => return Err(other("channel is not in a community this bot holds")),
                _ => None,
            };
            j(json_of(&c.move_to(cat.as_ref(), a.ou("index").unwrap_or(0) as usize).await.map_err(err)?))
        }
        "channel_overwrites" => {
            let o = inner.ch(a.s("id")?, Some("community")).overwrites().map_err(err)?;
            j(Value::Array(o.iter().map(|o| json!({"target": serde_json::to_value(&o.target).unwrap_or(Value::Null), "allow": o.allow.0, "deny": o.deny.0})).collect()))
        }
        "channel_set_overwrite" => {
            let c = inner.ch(a.s("id")?, Some("community"));
            let cid = c.community().map(|c| c.id().to_string()).unwrap_or_default();
            let ow = inner.overwrite(&cid, &a.s("target_kind")?, a.os("target_id"), a.ou("allow").unwrap_or(0), a.ou("deny").unwrap_or(0))?;
            j(json_of(&c.set_overwrite(ow).await.map_err(err)?))
        }
        "channel_clear_overwrite" => {
            let c = inner.ch(a.s("id")?, Some("community"));
            j(json_of(&c.clear_overwrite(target(&a.s("target_kind")?, a.os("target_id"))?).await.map_err(err)?))
        }
        "channel_sync_permissions" => {
            let c = inner.ch(a.s("id")?, Some("community"));
            let cat = a.os("category_id").and_then(|k| c.community().map(|comm| comm.category(k)));
            j(json_of(&c.sync_permissions(cat.as_ref()).await.map_err(err)?))
        }
        "channel_permissions_of" => j(json!(inner.ch(a.s("id")?, Some("community")).permissions_of(&a.s("npub")?).map_err(err)?.0)),
        "channel_pins" => {
            let pins = inner.ch(a.s("id")?, Some("community")).pins().map_err(err)?;
            j(Value::Array(pins.iter().map(|p| json!({"message_id": p.message_id, "author": p.author, "content": p.content, "at_ms": p.at_ms})).collect()))
        }
        "channel_pin" => j(json_of(&inner.ch(a.s("id")?, Some("community")).pin(&a.s("message_id")?).await.map_err(err)?)),
        "channel_unpin" => j(json_of(&inner.ch(a.s("id")?, Some("community")).unpin(&a.s("message_id")?).await.map_err(err)?)),

        // ---- communities ----
        "community_name" => j(json!(bot.community(a.s("community_id")?).name().await)),
        "community_description" => j(json!(bot.community(a.s("community_id")?).description())),
        "community_owner" => j(json!(bot.community(a.s("community_id")?).owner())),
        "community_admins" => j(json!(bot.community(a.s("community_id")?).admins().map_err(err)?)),
        "community_capabilities" => j(bot.community(a.s("community_id")?).capabilities().map_err(err)?),
        "community_is_dissolved" => j(json!(bot.community(a.s("community_id")?).is_dissolved().await)),
        "community_channels" => {
            let c = bot.community(a.s("community_id")?);
            j(Value::Array(c.channels().await.iter().map(|ch| json!({"channel_id": ch.id(), "name": ch.name(), "private": ch.is_private(), "readable": ch.is_readable(), "epoch": ch.epoch()})).collect()))
        }
        "community_channel_infos" => j(json_of(&bot.community(a.s("community_id")?).channel_infos().map_err(err)?)),
        "community_primary_channel" => j(json!(bot.community(a.s("community_id")?).primary_channel().map(|c| c.id().to_string()))),
        "community_create_channel" => {
            let c = bot.community(a.s("community_id")?);
            let mut o = NewChannel::default();
            if a.b("private", false) {
                o = o.private();
            }
            if let Some(k) = a.os("category_id") {
                o = o.in_category(k);
            }
            if let Some(v) = a.os("view") {
                o = o.view(v);
            }
            if let Some(t) = a.os("topic") {
                o = o.topic(t);
            }
            j(json!(c.create_channel_with(&a.s("name")?, o).await.map_err(err)?.id().to_string()))
        }
        "community_set_channel_private" => j(json_of(&bot.community(a.s("community_id")?).set_channel_private(&a.s("channel_id")?, a.b("private", true)).await.map_err(err)?)),
        "community_delete_channel" => j(json_of(&bot.community(a.s("community_id")?).delete_channel(&a.s("channel_id")?).await.map_err(err)?)),
        "community_grant_access" => j(json_of(&bot.community(a.s("community_id")?).grant_access(&a.s("channel_id")?, &a.s("npub")?).await.map_err(err)?)),
        "community_revoke_access" => j(json_of(&bot.community(a.s("community_id")?).revoke_access(&a.s("channel_id")?, &a.s("npub")?).await.map_err(err)?)),
        "community_channel_members" => j(json!(bot.community(a.s("community_id")?).channel_members(&a.s("channel_id")?).iter().map(|m| m.npub().to_string()).collect::<Vec<_>>())),
        "community_channel_access" => j(bot.community(a.s("community_id")?).channel_access(&a.s("channel_id")?).map_err(err)?),
        "community_members" => j(json!(bot.community(a.s("community_id")?).members().await.iter().map(|m| m.npub().to_string()).collect::<Vec<_>>())),
        "community_banned" => j(json!(bot.community(a.s("community_id")?).banned())),
        "community_ban_many" => {
            let npubs = a.vs("npubs");
            let refs: Vec<&str> = npubs.iter().map(String::as_str).collect();
            j(json_of(&bot.community(a.s("community_id")?).ban_many(&refs).await.map_err(err)?))
        }
        "community_unban_many" => {
            let npubs = a.vs("npubs");
            let refs: Vec<&str> = npubs.iter().map(String::as_str).collect();
            j(json_of(&bot.community(a.s("community_id")?).unban_many(&refs).await.map_err(err)?))
        }
        "community_contain_raid" => {
            let (npubs, cut) = (a.vs("npubs"), a.vs("cut_also"));
            let refs: Vec<&str> = npubs.iter().map(String::as_str).collect();
            let cut: Vec<&str> = cut.iter().map(String::as_str).collect();
            j(json_of(&bot.community(a.s("community_id")?).contain_raid_with(&refs, a.ou("window_start_secs").unwrap_or(0), &cut).await.map_err(err)?))
        }
        "community_raid_report" => j(bot.community(a.s("community_id")?).raid_report().map_err(err)?),
        "community_invite" => j(json_of(&bot.community(a.s("community_id")?).invite(&a.s("npub")?).await.map_err(err)?)),
        "community_create_invite" => j(json_of(&bot.community(a.s("community_id")?).create_invite_with(a.ou("expires_at_ms"), a.os("label")).await.map_err(err)?)),
        "community_invite_links" => j(json_of(&bot.community(a.s("community_id")?).invite_links().map_err(err)?)),
        "community_revoke_invite" => j(json_of(&bot.community(a.s("community_id")?).revoke_invite(&a.s("token")?).await.map_err(err)?)),
        "community_revoke_all_invites" => j(json_of(&bot.community(a.s("community_id")?).revoke_all_invites().await.map_err(err)?)),
        "community_edit" => j(json_of(&bot.community(a.s("community_id")?).edit(a.os("name").as_deref(), a.os("description").as_deref()).await.map_err(err)?)),
        "community_leave" => j(json_of(&bot.community(a.s("community_id")?).leave().await.map_err(err)?)),
        "community_dissolve" => j(json_of(&bot.community(a.s("community_id")?).dissolve().await.map_err(err)?)),

        // ---- roles ----
        "community_roles" => j(json_of(&bot.community(a.s("community_id")?).roles().map_err(err)?)),
        "community_create_role" => j(json!(bot.community(a.s("community_id")?).create_role(role_spec(&a)).await.map_err(err)?.id().to_string())),
        "community_reorder_roles" => {
            let c = bot.community(a.s("community_id")?);
            let roles: Vec<_> = a.vs("top_first").into_iter().map(|id| c.role(id)).collect();
            let refs: Vec<&_> = roles.iter().collect();
            j(json_of(&c.reorder_roles(&refs).await.map_err(err)?))
        }
        "community_everyone_permissions" => j(json!(bot.community(a.s("community_id")?).everyone_permissions().map_err(err)?.map(|p| p.0))),
        "community_set_everyone_permissions" => j(json_of(&bot.community(a.s("community_id")?).set_everyone_permissions(Permissions(a.u("permissions")?)).await.map_err(err)?)),
        "role_info" => j(json_of(&bot.community(a.s("community_id")?).role(a.s("role_id")?).info().map_err(err)?)),
        "role_holders" => j(json!(bot.community(a.s("community_id")?).role(a.s("role_id")?).holders().map_err(err)?)),
        "role_edit" => j(json_of(&bot.community(a.s("community_id")?).role(a.s("role_id")?).edit(role_spec(&a)).await.map_err(err)?)),
        "role_delete" => j(json_of(&bot.community(a.s("community_id")?).role(a.s("role_id")?).delete().await.map_err(err)?)),

        // ---- categories ----
        "community_categories" => j(json_of(&bot.community(a.s("community_id")?).categories().map_err(err)?)),
        "community_create_category" => j(json!(bot.community(a.s("community_id")?).create_category(&a.s("name")?).await.map_err(err)?.id().to_string())),
        "category_info" => j(json_of(&bot.community(a.s("community_id")?).category(a.s("category_id")?).info().map_err(err)?)),
        "category_channels" => j(json_of(&bot.community(a.s("community_id")?).category(a.s("category_id")?).channels().map_err(err)?)),
        "category_rename" => j(json_of(&bot.community(a.s("community_id")?).category(a.s("category_id")?).rename(&a.s("name")?).await.map_err(err)?)),
        "category_move" => j(json_of(&bot.community(a.s("community_id")?).category(a.s("category_id")?).move_to(a.ou("index").unwrap_or(0) as usize).await.map_err(err)?)),
        "category_delete" => j(json_of(&bot.community(a.s("community_id")?).category(a.s("category_id")?).delete().await.map_err(err)?)),
        "category_set_overwrite" => {
            let cid = a.s("community_id")?;
            let ow = inner.overwrite(&cid, &a.s("target_kind")?, a.os("target_id"), a.ou("allow").unwrap_or(0), a.ou("deny").unwrap_or(0))?;
            j(json_of(&bot.community(cid).category(a.s("category_id")?).set_overwrite(ow).await.map_err(err)?))
        }

        // ---- moderation state, relays, images, recovery ----
        "community_timeouts" => j(json!(bot.community(a.s("community_id")?).timeouts().map_err(err)?)),
        "community_nicknames" => j(json!(bot.community(a.s("community_id")?).nicknames().map_err(err)?)),
        "community_audit_log" => j(audit_json(&bot.community(a.s("community_id")?).audit_log().await.map_err(err)?)),
        "community_relays" => j(json!(bot.community(a.s("community_id")?).relays().map_err(err)?)),
        "community_check_relays" => j(json_of(&bot.community(a.s("community_id")?).check_relays(&a.vs("relays")).await.map_err(err)?)),
        "community_move_relays" => j(json_of(&bot.community(a.s("community_id")?).move_relays(&a.vs("relays")).await.map_err(err)?)),
        "community_voice_relays" => j(json!(bot.community(a.s("community_id")?).voice_relays().map_err(err)?)),
        "community_set_voice_relays" => j(json_of(&bot.community(a.s("community_id")?).set_voice_relays(&a.vs("relays")).await.map_err(err)?)),
        "community_icon" => match bot.community(a.s("community_id")?).icon().await.map_err(err)? {
            Some(b) => bytes(b),
            None => unit(),
        },
        "community_banner" => match bot.community(a.s("community_id")?).banner().await.map_err(err)? {
            Some(b) => bytes(b),
            None => unit(),
        },
        "community_set_icon" => {
            let c = bot.community(a.s("community_id")?);
            j(json_of(&match data {
                Some(b) => c.set_icon(&b).await.map_err(err)?,
                None => c.remove_icon().await.map_err(err)?,
            }))
        }
        "community_set_banner" => {
            let c = bot.community(a.s("community_id")?);
            j(json_of(&match data {
                Some(b) => c.set_banner(&b).await.map_err(err)?,
                None => c.remove_banner().await.map_err(err)?,
            }))
        }
        "community_refound" => {
            let keep = a.vs("retain");
            let refs: Vec<&str> = keep.iter().map(String::as_str).collect();
            j(json_of(&bot.community(a.s("community_id")?).refound(&refs).await.map_err(err)?))
        }
        "community_rescue_stranded" => {
            let npubs = a.vs("npubs");
            let refs: Vec<&str> = npubs.iter().map(String::as_str).collect();
            j(bot.community(a.s("community_id")?).rescue_stranded(&refs).await.map_err(err)?)
        }
        "community_repair_roster" => j(bot.community(a.s("community_id")?).repair_roster().await.map_err(err)?),
        "community_explain_epoch" => j(bot.community(a.s("community_id")?).explain_epoch().await.map_err(err)?),

        // ---- members ----
        "member_kick" => j(json_of(&bot.community(a.s("community_id")?).member(a.s("npub")?).kick().await.map_err(err)?)),
        "member_ban" => j(json_of(&bot.community(a.s("community_id")?).member(a.s("npub")?).ban().await.map_err(err)?)),
        "member_unban" => j(json_of(&bot.community(a.s("community_id")?).member(a.s("npub")?).unban().await.map_err(err)?)),
        "member_is_banned" => j(json!(bot.community(a.s("community_id")?).member(a.s("npub")?).is_banned())),
        "member_grant_admin" => j(json_of(&bot.community(a.s("community_id")?).member(a.s("npub")?).grant_admin().await.map_err(err)?)),
        "member_revoke_admin" => j(json_of(&bot.community(a.s("community_id")?).member(a.s("npub")?).revoke_admin().await.map_err(err)?)),
        "member_is_owner" => j(json!(bot.community(a.s("community_id")?).member(a.s("npub")?).is_owner())),
        "member_is_admin" => j(json!(bot.community(a.s("community_id")?).member(a.s("npub")?).try_is_admin().map_err(err)?)),
        "member_can" => j(json!(bot.community(a.s("community_id")?).member(a.s("npub")?).try_can(a.u("permission")?).map_err(err)?)),
        "member_can_read" => j(json!(bot.community(a.s("community_id")?).member(a.s("npub")?).can_read(&a.s("channel_id")?))),
        "member_permissions" => j(json!(bot.community(a.s("community_id")?).member(a.s("npub")?).permissions().map_err(err)?.0)),
        "member_roles" => j(json_of(&bot.community(a.s("community_id")?).member(a.s("npub")?).roles().map_err(err)?)),
        "member_set_roles" => {
            let c = bot.community(a.s("community_id")?);
            let m = c.member(a.s("npub")?);
            let roles: Vec<_> = a.vs("role_ids").into_iter().map(|id| c.role(id)).collect();
            let refs: Vec<&_> = roles.iter().collect();
            j(json_of(&m.set_roles(&refs).await.map_err(err)?))
        }
        "member_add_role" => {
            let c = bot.community(a.s("community_id")?);
            let (m, r) = (c.member(a.s("npub")?), c.role(a.s("role_id")?));
            j(json_of(&m.add_role(&r).await.map_err(err)?))
        }
        "member_remove_role" => {
            let c = bot.community(a.s("community_id")?);
            let (m, r) = (c.member(a.s("npub")?), c.role(a.s("role_id")?));
            j(json_of(&m.remove_role(&r).await.map_err(err)?))
        }
        "member_timeout" => j(json_of(&bot.community(a.s("community_id")?).member(a.s("npub")?).timeout(Duration::from_secs_f64(a.of("seconds").unwrap_or(0.0).max(0.0))).await.map_err(err)?)),
        "member_remove_timeout" => j(json_of(&bot.community(a.s("community_id")?).member(a.s("npub")?).remove_timeout().await.map_err(err)?)),
        "member_timed_out_until" => j(json!(bot.community(a.s("community_id")?).member(a.s("npub")?).timed_out_until().map_err(err)?)),
        "member_nickname" => j(json!(bot.community(a.s("community_id")?).member(a.s("npub")?).nickname())),
        "member_set_nickname" => j(json_of(&bot.community(a.s("community_id")?).member(a.s("npub")?).set_nickname(&a.s("nickname")?).await.map_err(err)?)),

        // ---- Mini Apps ----
        #[cfg(feature = "xdc")]
        "message_xdc" => j(bot.message(&a.s("message_id")?).await.and_then(|m| m.xdc()).map(|x| app_json(&x)).unwrap_or(Value::Null)),
        #[cfg(feature = "xdc")]
        "xdc_manifest" => {
            let x = bot.message(&a.s("message_id")?).await.and_then(|m| m.xdc()).ok_or_else(|| other("that message carries no Mini App"))?;
            let m = x.manifest().await.map_err(err)?;
            j(json!({"name": m.name, "id": m.id, "description": m.description, "icon": m.icon, "version": m.version, "source_code_url": m.source_code_url}))
        }
        #[cfg(feature = "xdc")]
        "xdc_join" => {
            let x = bot.message(&a.s("message_id")?).await.and_then(|m| m.xdc()).ok_or_else(|| other("that message carries no Mini App"))?;
            let s = x.join().await.map_err(err)?;
            let (app, self_addr, sender) = (app_json(s.app()), s.self_addr().to_string(), s.sender());
            let id = inner.add_handle(Handle::Xdc(Arc::new(XdcHandle { inner: Mutex::new(Some(s)), sender })));
            j(json!({"session": id, "app": app, "self_addr": self_addr}))
        }
        #[cfg(feature = "xdc")]
        "channel_send_xdc" => j(app_json(&inner.ch(a.s("id")?, kind.as_deref()).send_xdc(a.s("path")?).await.map_err(err)?)),
        #[cfg(feature = "xdc")]
        "xdc_next" => {
            let h = inner.xdc(&a)?;
            let mut g = h.inner.lock().await;
            let Some(s) = g.as_mut() else { return Ok(unit()) };
            match s.next().await {
                None => unit(),
                Some(vector_sdk::XdcEvent::Data(f)) => CallResult {
                    value: json!({"type": "data", "from": peer_json(&f.from), "direct": f.direct, "verified_sender": f.verified_sender()}),
                    bytes: Some(f.payload.clone().into()),
                },
                Some(vector_sdk::XdcEvent::PeerJoined(p)) => j(json!({"type": "peer_join", "peer": peer_json(&p)})),
                Some(vector_sdk::XdcEvent::PeerLeft(p)) => j(json!({"type": "peer_leave", "peer": peer_json(&p)})),
                Some(vector_sdk::XdcEvent::Lagged) => j(json!({"type": "lagged"})),
                #[allow(unreachable_patterns)]
                Some(_) => j(json!({"type": "unknown"})),
            }
        }
        #[cfg(feature = "xdc")]
        "xdc_send" => {
            let h = inner.xdc(&a)?;
            match (data, a.os("text"), a.get("json")) {
                (Some(d), _, _) => h.sender.send(d).await.map_err(err)?,
                (None, Some(t), _) => h.sender.send_text(&t).await.map_err(err)?,
                (None, None, Some(v)) => h.sender.send_json(v).await.map_err(err)?,
                _ => return Err(invalid("xdc_send needs data, text or json")),
            }
            unit()
        }
        #[cfg(feature = "xdc")]
        "xdc_peers" => {
            let h = inner.xdc(&a)?;
            let g = h.inner.lock().await;
            j(Value::Array(g.as_ref().map(|s| s.peers().iter().map(peer_json).collect()).unwrap_or_default()))
        }
        #[cfg(feature = "xdc")]
        "xdc_leave" => {
            let id = a.u("handle")?;
            let h = inner.xdc(&a)?;
            if let Some(s) = h.inner.lock().await.take() {
                s.leave().await;
            }
            inner.handles.lock().unwrap().remove(&id);
            unit()
        }

        // ---- voice ----
        #[cfg(feature = "voice")]
        "channel_join_voice" => {
            let call = inner.ch(a.s("id")?, Some("community")).join_voice().await.map_err(err)?;
            let channel_id = call.channel_id().to_string();
            let id = inner.add_handle(Handle::Voice(Arc::new(call)));
            j(json!({"call": id, "channel_id": channel_id}))
        }
        #[cfg(feature = "voice")]
        "channel_voice_members" => j(json_of(&inner.ch(a.s("id")?, Some("community")).voice_members())),
        #[cfg(feature = "voice")]
        "voice_listen" => match inner.voice(&a)?.listen().await {
            Some(s) => CallResult { value: json!({"npub": s.npub, "samples": s.pcm.len()}), bytes: Some(pcm_to_bytes(&s.pcm).into()) },
            None => unit(),
        },
        #[cfg(feature = "voice")]
        "voice_say" => j(json!(inner.voice(&a)?.say(&bytes_to_pcm(&data.unwrap_or_default())))),
        #[cfg(feature = "voice")]
        "voice_say_and_wait" => j(json_of(&inner.voice(&a)?.say_and_wait(&bytes_to_pcm(&data.unwrap_or_default())).await)),
        #[cfg(feature = "voice")]
        "voice_finished" => j(json_of(&inner.voice(&a)?.finished().await)),
        #[cfg(feature = "voice")]
        "voice_status" => {
            let v = inner.voice(&a)?;
            j(json!({"ended": v.ended(), "queued": v.queued().as_secs_f64(), "connected": v.connected(), "moved_to": v.moved_to(), "state": v.state().map(|s| json_of(&s))}))
        }
        #[cfg(feature = "voice")]
        "voice_hush" => {
            inner.voice(&a)?.hush();
            unit()
        }
        #[cfg(feature = "voice")]
        "voice_set_muted" => {
            inner.voice(&a)?.set_muted(a.b("on", true)).map_err(err)?;
            unit()
        }
        #[cfg(feature = "voice")]
        "voice_set_deafened" => {
            inner.voice(&a)?.set_deafened(a.b("on", true)).map_err(err)?;
            unit()
        }
        #[cfg(feature = "voice")]
        "voice_leave" => {
            let id = a.u("handle")?;
            let v = inner.voice(&a)?;
            v.hush();
            if !v.ended() {
                vector_sdk::vector_core::calls::voice::leave_channel(v.channel_id()).await;
            }
            inner.handles.lock().unwrap().remove(&id);
            unit()
        }
        #[cfg(feature = "voice")]
        "voice_tone" => {
            let hz = a.of("hz").unwrap_or(440.0) as f32;
            let ms = a.ou("ms").unwrap_or(500) as u32;
            bytes(pcm_to_bytes(&vector_sdk::voice::tone(hz, ms)))
        }

        #[cfg(feature = "voice")]
        "voice_level" => j(json!(vector_sdk::voice::level(&bytes_to_pcm(&data.unwrap_or_default())))),
        #[cfg(feature = "voice")]
        "voice_decode" => bytes(pcm_to_bytes(&vector_sdk::voice::decode_with_ffmpeg(a.s("path")?).await.map_err(err)?)),

        m => return Err(invalid(format!("unknown method {m:?}"))),
    })
}
