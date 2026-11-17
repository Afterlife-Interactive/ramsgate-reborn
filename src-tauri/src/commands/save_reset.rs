use serde::{Deserialize, Serialize};
use tauri::AppHandle;

use crate::commands::auth::{api_base_url, http_client, refresh_native_session};

/// What the launcher shows for the player-started save data reset (POST /launcher/v1/account/reset-save).
/// The route answers HTTP 200 with { status, code, message, retryAfterSeconds? }. Anything not listed here is "unknown", and the
/// screen turns it into a plain "nothing was changed, try again" line.
pub(crate) fn reset_outcome(http_status: u16, word: &str) -> &'static str {
    if http_status == 429 {
        return "wait";
    }
    // The route is not on this server yet: "not available", never "could not reach the server".
    if http_status == 404 {
        return "unavailable";
    }
    match word {
        "reset" => "reset",
        "already_fresh" => "already_fresh",
        "confirm_required" => "confirm_required",
        "not_allowed" => "not_allowed",
        "in_game" => "in_game",
        "cooldown" => "cooldown",
        "error" => "error",
        _ => "unknown",
    }
}

#[derive(Deserialize, Default)]
struct ResetReply {
    #[serde(default)]
    status: Option<String>,
    #[serde(default)]
    code: Option<String>,
    #[serde(default)]
    message: Option<String>,
    #[serde(default, rename = "retryAfterSeconds")]
    retry_after_seconds: Option<u64>,
}

#[derive(Serialize)]
pub struct ResetSaveResult {
    pub outcome: String,
    /// The server's own plain text, only used for "not_allowed" (it says why). At most 300 characters.
    pub message: Option<String>,
    #[serde(rename = "retryAfterSeconds")]
    pub retry_after_seconds: Option<u64>,
}

fn clean_message(m: Option<String>) -> Option<String> {
    let t = m.unwrap_or_default().trim().to_string();
    if t.is_empty() || t.chars().count() > 300 {
        None
    } else {
        Some(t)
    }
}

/// Sends the confirm word. An empty word is the availability probe: a server that has the route answers "confirm_required" and
/// changes nothing, a server without it answers 404.
#[tauri::command]
pub async fn native_reset_save(app: AppHandle, confirm: String) -> Result<ResetSaveResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let session = refresh_native_session(&app)?;
        let response = http_client()?
            .post(format!("{}/launcher/v1/account/reset-save", api_base_url()))
            .bearer_auth(&session.access_token)
            .json(&serde_json::json!({ "confirm": confirm }))
            .send()
            .map_err(|_| "Couldn't reach the Ramsgate Reborn server right now.".to_string())?;
        let http_status = response.status().as_u16();
        let reply: ResetReply = response.json().unwrap_or_default();
        let word = reply.status.or(reply.code).unwrap_or_default();
        let outcome = reset_outcome(http_status, &word);
        Ok(ResetSaveResult {
            outcome: outcome.to_string(),
            message: if outcome == "not_allowed" { clean_message(reply.message) } else { None },
            retry_after_seconds: reply.retry_after_seconds,
        })
    })
    .await
    .map_err(|_| "The reset stopped unexpectedly.".to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn answers_map_to_plain_outcomes() {
        for w in ["reset", "already_fresh", "confirm_required", "not_allowed", "in_game", "cooldown", "error"] {
            assert_eq!(reset_outcome(200, w), w);
        }
        assert_eq!(reset_outcome(500, "error"), "error");
        assert_eq!(reset_outcome(429, ""), "wait");
        assert_eq!(reset_outcome(404, ""), "unavailable");
        assert_eq!(reset_outcome(404, "reset"), "unavailable");
        assert_eq!(reset_outcome(200, "something_new"), "unknown");
        assert_eq!(reset_outcome(200, ""), "unknown");
    }

    #[test]
    fn reply_reads_the_real_payloads() {
        let r: ResetReply = serde_json::from_str(r#"{"ok":false,"status":"cooldown","code":"cooldown","message":"x","retryAfterSeconds":86000}"#).unwrap();
        assert_eq!(r.status.as_deref(), Some("cooldown"));
        assert_eq!(r.retry_after_seconds, Some(86000));
        let r: ResetReply = serde_json::from_str(r#"{"ok":true,"status":"reset","code":"reset","message":"done","backupKeptDays":30}"#).unwrap();
        assert_eq!(reset_outcome(200, &r.status.unwrap()), "reset");
        let r: ResetReply = serde_json::from_str("{}").unwrap();
        assert!(r.status.is_none());
    }

    #[test]
    fn server_text_is_trimmed_and_bounded() {
        assert_eq!(clean_message(Some("  Finish your transfer first.  ".into())).as_deref(), Some("Finish your transfer first."));
        assert_eq!(clean_message(Some("".into())), None);
        assert_eq!(clean_message(Some("x".repeat(301))), None);
        assert_eq!(clean_message(None), None);
    }
}
