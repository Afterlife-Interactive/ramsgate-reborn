//! The signed-in player's own playtime, read from the server. The path is fixed and carries no input,
//! so the account is always the one in the session token.

use serde_json::Value;
use std::time::Duration;
use tauri::AppHandle;

use crate::commands::auth::{api_base_url, refresh_native_session, refresh_native_session_forced};

const PLAYTIME_PATH: &str = "/launcher/v1/playtime";

fn fetch(client: &reqwest::blocking::Client, token: &str) -> Result<reqwest::blocking::Response, String> {
    client
        .get(format!("{}{}", api_base_url(), PLAYTIME_PATH))
        .bearer_auth(token)
        .send()
        .map_err(|_| "Couldn't reach the server.".to_string())
}

fn call(app: &AppHandle) -> Result<Value, String> {
    let client = reqwest::blocking::Client::builder()
        .connect_timeout(Duration::from_secs(4))
        .timeout(Duration::from_secs(10))
        .build()
        .map_err(|_| "Couldn't prepare the secure launcher connection.".to_string())?;

    let token = refresh_native_session(app)?.access_token;
    let mut response = fetch(&client, &token)?;
    if response.status().as_u16() == 401 {
        let token = refresh_native_session_forced(app)?.access_token;
        response = fetch(&client, &token)?;
    }
    if !response.status().is_success() {
        return Err(format!("The request failed (server status {}).", response.status().as_u16()));
    }
    response
        .json::<Value>()
        .map_err(|_| "The server sent an unreadable reply.".to_string())
}

#[tauri::command]
pub async fn native_get_playtime(app: AppHandle) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || call(&app))
        .await
        .map_err(|_| "The playtime task stopped unexpectedly.".to_string())?
}
