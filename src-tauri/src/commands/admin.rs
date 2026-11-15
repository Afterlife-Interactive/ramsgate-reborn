//! Administration requests for the admin launcher build.
//!
//! This module only exists in builds made with the `admin` cargo feature; the player launcher does not
//! contain it. It is not what protects the server: every route it reaches still requires the signed-in
//! account to hold the server-assigned "admin" role.

use serde::Deserialize;
use serde_json::Value;
use std::time::Duration;
use tauri::AppHandle;

use crate::commands::auth::{api_base_url, refresh_native_session, refresh_native_session_forced};

const ADMIN_PREFIX: &str = "/launcher/v1/admin/";

/// Only fixed-shape admin paths: no traversal, no other characters than a route plus a simple query string.
fn is_admin_path(path: &str) -> bool {
    path.starts_with(ADMIN_PREFIX)
        && path.len() <= 300
        && !path.contains("..")
        && path
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "/-_?=&.%".contains(c))
}

#[derive(Deserialize)]
struct ErrorEnvelope {
    error: Option<ErrorBody>,
}

#[derive(Deserialize)]
struct ErrorBody {
    message: Option<String>,
}

fn send(
    client: &reqwest::blocking::Client,
    method: &str,
    url: &str,
    token: &str,
    body: &Option<Value>,
) -> Result<reqwest::blocking::Response, String> {
    let request = match method {
        "GET" => client.get(url),
        "POST" => client.post(url).json(&body.clone().unwrap_or_else(|| serde_json::json!({}))),
        _ => return Err("Invalid admin request.".to_string()),
    };
    request
        .bearer_auth(token)
        .send()
        .map_err(|_| "Couldn't reach the server.".to_string())
}

fn call(app: &AppHandle, method: &str, path: &str, body: Option<Value>) -> Result<Value, String> {
    if !is_admin_path(path) {
        return Err("Invalid admin request.".to_string());
    }

    // Status checks run a script on the server, so allow longer than the sign-in client does.
    let client = reqwest::blocking::Client::builder()
        .connect_timeout(Duration::from_secs(4))
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|_| "Couldn't prepare the secure launcher connection.".to_string())?;
    let url = format!("{}{}", api_base_url(), path);

    // The shared session cache means concurrent admin panels reuse one token instead of racing refreshes.
    let token = refresh_native_session(app)?.access_token;
    let mut response = send(&client, method, &url, &token, &body)?;
    if response.status().as_u16() == 401 {
        // The cached token was cut short (server restart, revoked session): refresh once for real and retry.
        let token = refresh_native_session_forced(app)?.access_token;
        response = send(&client, method, &url, &token, &body)?;
    }

    if response.status().is_success() {
        return response
            .json::<Value>()
            .map_err(|_| "The server sent an unreadable reply.".to_string());
    }

    let status = response.status().as_u16();
    let message = response
        .json::<ErrorEnvelope>()
        .ok()
        .and_then(|envelope| envelope.error)
        .and_then(|error| error.message)
        .map(|message| message.chars().take(160).collect::<String>());
    Err(message.unwrap_or_else(|| format!("The request failed (server status {status}).")))
}

#[tauri::command]
pub async fn native_admin_request(
    app: AppHandle,
    method: String,
    path: String,
    body: Option<Value>,
) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || call(&app, &method, &path, body))
        .await
        .map_err(|_| "The admin task stopped unexpectedly.".to_string())?
}

#[cfg(test)]
mod tests {
    use super::is_admin_path;

    #[test]
    fn accepts_admin_routes() {
        assert!(is_admin_path("/launcher/v1/admin/players?approvalStatus=pending&limit=50"));
        assert!(is_admin_path("/launcher/v1/admin/server/restart-all"));
        assert!(is_admin_path("/launcher/v1/admin/players/3f2a-9c/access"));
    }

    #[test]
    fn rejects_everything_else() {
        assert!(!is_admin_path("/launcher/v1/me"));
        assert!(!is_admin_path("/launcher/v1/admin/../me"));
        assert!(!is_admin_path("/launcher/v1/admin/x\\y"));
        assert!(!is_admin_path("/launcher/v1/admin/x#y"));
        assert!(!is_admin_path("https://evil.example/launcher/v1/admin/x"));
    }
}
