//! The backend's launch queue (POST /launcher/v1/queue). While the hunt servers are near full,
//! Play waits in a server-side line before secure_launch; HomeTab polls this every few seconds and
//! shows the player's place with a Leave queue button.
//!
//! Fails open: an older backend without the route, an unreachable one, a signed-out session, or
//! anything other than {"state":"queued"} lets the game start.

use serde::{Deserialize, Serialize};
use serde_json::json;
use tauri::AppHandle;

use crate::commands::auth::{api_base_url, http_client, refresh_native_session};

#[derive(Deserialize)]
struct QueueReply {
    state: String,
    position: Option<u32>,
    length: Option<u32>,
}

#[derive(Serialize, Debug, PartialEq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum QueueAnswer {
    Go,
    Queued { position: u32, length: u32 },
}

fn answer_from(reply: QueueReply) -> QueueAnswer {
    if reply.state != "queued" {
        return QueueAnswer::Go;
    }
    let position = reply.position.filter(|p| *p >= 1).unwrap_or(1);
    let length = reply.length.unwrap_or(position).max(position);
    QueueAnswer::Queued { position, length }
}

fn post(app: &AppHandle, leave: bool) -> Option<QueueReply> {
    // The shared session cache: polling every few seconds reuses one access token.
    let token = refresh_native_session(app).ok()?.access_token;
    let response = http_client()
        .ok()?
        .post(format!("{}/launcher/v1/queue", api_base_url()))
        .bearer_auth(token)
        .json(&json!({ "leave": leave }))
        .send()
        .ok()?;
    if !response.status().is_success() {
        return None;
    }
    response.json::<QueueReply>().ok()
}

#[tauri::command]
pub async fn native_queue_poll(app: AppHandle) -> Result<QueueAnswer, String> {
    let reply = tauri::async_runtime::spawn_blocking(move || post(&app, false))
        .await
        .ok()
        .flatten();
    Ok(reply.map(answer_from).unwrap_or(QueueAnswer::Go))
}

#[tauri::command]
pub async fn native_queue_leave(app: AppHandle) -> Result<(), String> {
    let _ = tauri::async_runtime::spawn_blocking(move || post(&app, true)).await;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{answer_from, QueueAnswer, QueueReply};

    fn reply(state: &str, position: Option<u32>, length: Option<u32>) -> QueueReply {
        QueueReply { state: state.to_string(), position, length }
    }

    #[test]
    fn anything_but_queued_lets_the_game_start() {
        assert_eq!(answer_from(reply("open", None, None)), QueueAnswer::Go);
        assert_eq!(answer_from(reply("ready", None, None)), QueueAnswer::Go);
        assert_eq!(answer_from(reply("", Some(2), Some(5))), QueueAnswer::Go);
    }

    #[test]
    fn queued_place_is_kept_sane() {
        assert_eq!(answer_from(reply("queued", Some(2), Some(5))), QueueAnswer::Queued { position: 2, length: 5 });
        assert_eq!(answer_from(reply("queued", Some(0), None)), QueueAnswer::Queued { position: 1, length: 1 });
        assert_eq!(answer_from(reply("queued", Some(4), Some(2))), QueueAnswer::Queued { position: 4, length: 4 });
    }
}
