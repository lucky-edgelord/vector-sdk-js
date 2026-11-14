//! Conversions between the Rust SDK's types and JSON for JavaScript.

use napi::{Error, Status};
use serde_json::{json, Value};
use vector_sdk::{AuditAction, AuditEntry, AuditLog, AuditTarget, BotEvent, IncomingMessage, VectorError};

/// Errors cross as `"<Kind>|<needs>|<message>"`; the TypeScript layer turns them into error classes.
pub fn err(e: VectorError) -> Error {
    let msg = e.to_string();
    let (kind, extra) = match &e {
        VectorError::NotPermitted { needs, .. } => ("NotPermitted", needs.0.to_string()),
        VectorError::NotFound(_) => ("NotFound", String::new()),
        VectorError::NotInitialized(_) => ("NotInitialized", String::new()),
        VectorError::Network(_) | VectorError::Nostr(_) => ("NetworkError", String::new()),
        _ => ("VectorException", String::new()),
    };
    Error::new(Status::GenericFailure, format!("{kind}|{extra}|{msg}"))
}

pub fn other(msg: impl Into<String>) -> Error {
    Error::new(Status::GenericFailure, format!("VectorException||{}", msg.into()))
}

pub fn invalid(msg: impl Into<String>) -> Error {
    Error::new(Status::InvalidArg, format!("ValueError||{}", msg.into()))
}

pub fn json_of<T: serde::Serialize + ?Sized>(v: &T) -> Value {
    serde_json::to_value(v).unwrap_or(Value::Null)
}

pub fn pcm_to_bytes(pcm: &[i16]) -> Vec<u8> {
    let mut out = Vec::with_capacity(pcm.len() * 2);
    for s in pcm {
        out.extend_from_slice(&s.to_le_bytes());
    }
    out
}

pub fn bytes_to_pcm(bytes: &[u8]) -> Vec<i16> {
    bytes.chunks_exact(2).map(|c| i16::from_le_bytes([c[0], c[1]])).collect()
}

pub fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

pub fn incoming_json(msg: &IncomingMessage) -> Value {
    json!({
        "chat_id": msg.chat_id,
        "is_group": msg.is_group,
        "is_file": msg.is_file,
        "author": msg.author(),
        "community_id": msg.community().map(|c| c.id().to_string()),
        "message": serde_json::to_value(&msg.message).unwrap_or(Value::Null),
    })
}

pub fn event_json(ev: &BotEvent) -> Value {
    let to = |v: &dyn erased::Ser| v.value();
    match ev {
        BotEvent::Ready { communities } => json!({"type": "ready", "communities": communities}),
        BotEvent::Message(m) => json!({"type": "message", "message": incoming_json(m)}),
        BotEvent::Reaction { chat_id, message, reaction, at } => json!({
            "type": "reaction_add", "chat_id": chat_id, "message": to(message), "reaction": to(reaction), "at": at,
        }),
        BotEvent::ReactionRemoved { chat_id, message, reaction_id, by, at } => json!({
            "type": "reaction_remove", "chat_id": chat_id, "message": to(message), "reaction_id": reaction_id, "by": by, "at": at,
        }),
        BotEvent::Edit { chat_id, message, at } => json!({"type": "message_edit", "chat_id": chat_id, "message": to(message), "at": at}),
        BotEvent::Delete { chat_id, message_id, by, moderated, at } => json!({
            "type": "message_delete", "chat_id": chat_id, "message_id": message_id, "by": by, "moderated": moderated, "at": at,
        }),
        BotEvent::MemberJoin { community_id, channel_id, npub, invited_by, invite_label } => json!({
            "type": "member_join", "community_id": community_id, "channel_id": channel_id, "npub": npub,
            "invited_by": invited_by, "invite_label": invite_label,
        }),
        BotEvent::MemberLeave { community_id, channel_id, npub } => json!({
            "type": "member_remove", "community_id": community_id, "channel_id": channel_id, "npub": npub,
        }),
        BotEvent::Typing { chat_id, npub, until } => json!({"type": "typing", "chat_id": chat_id, "npub": npub, "until": until}),
        BotEvent::CommunityChange { community_id, change } => json!({
            "type": "community_change", "community_id": community_id, "change": to(change),
        }),
        BotEvent::Dissolved { community_id } => json!({"type": "community_dissolve", "community_id": community_id}),
        BotEvent::VoicePresence { channel_id } => json!({"type": "voice_presence", "channel_id": channel_id}),
        BotEvent::Invite { community_id } => json!({"type": "community_invite", "community_id": community_id}),
        BotEvent::Removed { community_id } => json!({"type": "community_remove", "community_id": community_id}),
        BotEvent::ChannelKeyed { community_id, channel_id, backfilled } => json!({
            "type": "channel_keyed", "community_id": community_id, "channel_id": channel_id, "backfilled": backfilled,
        }),
        BotEvent::XdcPresence { chat_id, topic, npub, online, at } => json!({
            "type": "xdc_presence", "chat_id": chat_id, "topic": topic, "npub": npub, "online": online, "at": at,
        }),
        #[allow(unreachable_patterns)]
        other => json!({"type": "unknown", "debug": format!("{other:?}")}),
    }
}

mod erased {
    pub trait Ser {
        fn value(&self) -> serde_json::Value;
    }
    impl<T: serde::Serialize> Ser for T {
        fn value(&self) -> serde_json::Value {
            serde_json::to_value(self).unwrap_or(serde_json::Value::Null)
        }
    }
}

fn snake(s: &str) -> String {
    let mut out = String::new();
    for (i, c) in s.chars().enumerate() {
        if c.is_ascii_uppercase() {
            if i > 0 {
                out.push('_');
            }
            out.push(c.to_ascii_lowercase());
        } else {
            out.push(c);
        }
    }
    out
}

fn action_name(a: &AuditAction) -> String {
    match a {
        AuditAction::Other(s) => s.clone(),
        #[allow(unreachable_patterns)]
        a => snake(&format!("{a:?}")),
    }
}

fn target_json(t: &AuditTarget) -> Value {
    match t {
        AuditTarget::Member { npub } => json!({"kind": "member", "npub": npub}),
        AuditTarget::Everyone => json!({"kind": "everyone"}),
        AuditTarget::Role { id, name } => json!({"kind": "role", "id": id, "name": name}),
        AuditTarget::Channel { id, name } => json!({"kind": "channel", "id": id, "name": name}),
        AuditTarget::Category { id, name } => json!({"kind": "category", "id": id, "name": name}),
        AuditTarget::Message { id, author, channel_id } => {
            json!({"kind": "message", "id": id, "author": author, "channel_id": channel_id})
        }
        AuditTarget::Overwrite { target, scope } => {
            json!({"kind": "overwrite", "target": target_json(target), "scope": target_json(scope)})
        }
        AuditTarget::Other(v) => json!({"kind": "other", "raw": v}),
        #[allow(unreachable_patterns)]
        _ => json!({"kind": "other"}),
    }
}

fn entry_json(e: &AuditEntry) -> Value {
    json!({
        "id": e.id,
        "at_ms": e.at_ms,
        "actor": e.actor,
        "action": action_name(&e.action),
        "target": e.target.as_ref().map(target_json),
        "changes": e.changes,
        "partial": e.partial,
    })
}

pub fn audit_json(log: &AuditLog) -> Value {
    json!({"compacted": log.compacted, "entries": log.entries.iter().map(entry_json).collect::<Vec<_>>()})
}
