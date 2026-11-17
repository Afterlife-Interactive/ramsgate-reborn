use serde::Deserialize;
use std::collections::HashSet;
use std::fs;
use std::path::Path;
use std::sync::Mutex;
use tauri::{AppHandle, Manager};
use tauri_plugin_dialog::DialogExt;

use crate::commands::auth::{api_base_url, http_client, refresh_native_session};

const MAX_CANDIDATES: usize = 8;
const DR_LAUNCHER_DIR: &str = "Dauntless Revived Launcher";

/// Account keys are made of these characters and are 8 to 128 long. Anything else is not a key.
fn is_key(value: &str) -> bool {
    (8..=128).contains(&value.len())
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

/// Pulls a key out of the text the Dauntless Revived launcher keeps: either its three-line backup
/// (`DRK2`, certificate line, key) or an exported file with a `Key: ...` line.
fn key_from_text(text: &str) -> Option<String> {
    let lines: Vec<&str> = text.lines().map(str::trim).collect();
    if lines.len() == 3 && lines[0] == "DRK2" && is_key(lines[2]) {
        return Some(lines[2].to_string());
    }
    for line in &lines {
        if let Some(rest) = line.strip_prefix("Key:") {
            let candidate = rest.trim();
            if is_key(candidate) {
                return Some(candidate.to_string());
            }
        }
    }
    let whole = text.trim();
    is_key(whole).then(|| whole.to_string())
}

fn push_unique(found: &mut Vec<String>, seen: &mut HashSet<String>, key: String) {
    if found.len() < MAX_CANDIDATES && seen.insert(key.clone()) {
        found.push(key);
    }
}

fn read_backups(dir: &Path, found: &mut Vec<String>, seen: &mut HashSet<String>) {
    let Ok(entries) = fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("txt") {
            continue;
        }
        // A real backup is a few hundred bytes at most.
        if entry.metadata().map(|m| m.len() > 8192).unwrap_or(true) {
            continue;
        }
        if let Some(key) = fs::read_to_string(&path).ok().as_deref().and_then(key_from_text) {
            push_unique(found, seen, key);
        }
    }
}

#[derive(Deserialize)]
struct LocalState {
    os_crypt: OsCrypt,
}

#[derive(Deserialize)]
struct OsCrypt {
    encrypted_key: String,
}

#[cfg(windows)]
fn dpapi_unprotect(data: &[u8]) -> Option<Vec<u8>> {
    use windows_sys::Win32::Foundation::LocalFree;
    use windows_sys::Win32::Security::Cryptography::{
        CryptUnprotectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB,
    };
    let input = CRYPT_INTEGER_BLOB {
        cbData: data.len().try_into().ok()?,
        pbData: data.as_ptr() as *mut u8,
    };
    let mut output = CRYPT_INTEGER_BLOB { cbData: 0, pbData: std::ptr::null_mut() };
    let ok = unsafe {
        CryptUnprotectData(
            &input,
            std::ptr::null_mut(),
            std::ptr::null(),
            std::ptr::null(),
            std::ptr::null(),
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut output,
        )
    };
    if ok == 0 {
        return None;
    }
    let clear = unsafe { std::slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec() };
    unsafe { LocalFree(output.pbData.cast()) };
    Some(clear)
}

#[cfg(not(windows))]
fn dpapi_unprotect(_data: &[u8]) -> Option<Vec<u8>> {
    None
}

/// The Dauntless Revived launcher encrypts its saved keys with Electron's safeStorage: `v10`, a 12 byte nonce,
/// AES-256-GCM ciphertext and a 16 byte tag, under a key that Windows protects for the signed-in user.
fn read_safe_storage(dr_dir: &Path, found: &mut Vec<String>, seen: &mut HashSet<String>) {
    use aes_gcm::aead::{Aead, KeyInit};
    use aes_gcm::{Aes256Gcm, Nonce};
    use base64::Engine;

    let Ok(state_text) = fs::read_to_string(dr_dir.join("Local State")) else { return };
    let Ok(state) = serde_json::from_str::<LocalState>(&state_text) else { return };
    let Ok(wrapped) = base64::engine::general_purpose::STANDARD.decode(state.os_crypt.encrypted_key) else {
        return;
    };
    let Some(wrapped) = wrapped.strip_prefix(b"DPAPI") else { return };
    let Some(master) = dpapi_unprotect(wrapped) else { return };
    let Ok(cipher) = Aes256Gcm::new_from_slice(&master) else { return };

    let Ok(entries) = fs::read_dir(dr_dir.join("keys")) else { return };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("key") {
            continue;
        }
        if entry.metadata().map(|m| m.len() > 8192).unwrap_or(true) {
            continue;
        }
        let Ok(blob) = fs::read(&path) else { continue };
        if blob.len() < 3 + 12 + 16 || &blob[..3] != b"v10" {
            continue;
        }
        let Ok(clear) = cipher.decrypt(Nonce::from_slice(&blob[3..15]), &blob[15..]) else { continue };
        if let Some(key) = std::str::from_utf8(&clear).ok().and_then(key_from_text) {
            push_unique(found, seen, key);
        }
    }
}

/// A key the player picked or pasted by hand. Held in memory only (never written, logged or sent back to the page) and sent
/// to the dr-claim endpoint together with the keys found on this PC.
static MANUAL_KEY: Mutex<Option<String>> = Mutex::new(None);

fn set_manual_key(key: String) {
    if let Ok(mut slot) = MANUAL_KEY.lock() {
        *slot = Some(key);
    }
}

/// The player chooses a key file (the .txt backup from the Dauntless Revived launcher). Returns `ok`, `cancelled` or `invalid`.
#[tauri::command]
pub async fn native_pick_dr_key_file(app: AppHandle) -> Result<String, String> {
    let start = app.path().document_dir().ok().map(|d| d.join("Dauntless Revived"));
    let picked = tauri::async_runtime::spawn_blocking(move || {
        let mut dialog = app
            .dialog()
            .file()
            .set_title("Select your Dauntless Revived account key")
            .add_filter("Account key (.txt)", &["txt"]);
        if let Some(dir) = start.filter(|d| d.is_dir()) {
            dialog = dialog.set_directory(dir);
        }
        dialog.blocking_pick_file()
    })
    .await
    .map_err(|_| "The file picker stopped unexpectedly.".to_string())?;
    let Some(file) = picked else { return Ok("cancelled".to_string()) };
    let Ok(path) = file.into_path() else { return Ok("invalid".to_string()) };
    // A real key file is a few hundred bytes at most.
    if fs::metadata(&path).map(|m| m.len() > 8192).unwrap_or(true) {
        return Ok("invalid".to_string());
    }
    match fs::read_to_string(&path).ok().as_deref().and_then(key_from_text) {
        Some(key) => {
            set_manual_key(key);
            Ok("ok".to_string())
        }
        None => Ok("invalid".to_string()),
    }
}

/// The player pastes the key text. Returns `ok` or `invalid`.
#[tauri::command]
pub fn native_set_dr_key(key: String) -> String {
    match key_from_text(&key) {
        Some(key) => {
            set_manual_key(key);
            "ok".to_string()
        }
        None => "invalid".to_string(),
    }
}

fn find_candidates(app: &AppHandle) -> Vec<String> {
    let mut found = Vec::new();
    let mut seen = HashSet::new();
    if let Some(key) = MANUAL_KEY.lock().ok().and_then(|slot| slot.clone()) {
        push_unique(&mut found, &mut seen, key);
    }
    if let Ok(documents) = app.path().document_dir() {
        read_backups(&documents.join("Dauntless Revived").join("Account Keys"), &mut found, &mut seen);
    }
    // The encrypted store is only a fallback for when the plain backup folder gave nothing.
    if found.is_empty() {
        if let Ok(data) = app.path().data_dir() {
            read_safe_storage(&data.join(DR_LAUNCHER_DIR), &mut found, &mut seen);
        }
    }
    found
}

#[derive(Deserialize)]
struct ClaimResponse {
    status: String,
}

/// `replace` is only true after the player confirmed it: the server then backs up and removes the RR progress.
/// Looks for the player's Dauntless Revived account key on this PC and asks the server to port that account.
/// Returns `ported`, `already`, `no_match`, `not_found`, `fetching` (the server is fetching the save: ask again in a few seconds), `wait` (rate limit: ask again later), `not_ready`, `no_key` (nothing found locally), or one of the stable codes `not_copied_yet`, `transfers_ended`, `try_later`, `declined`. The key is only
/// held in memory for the one request: it is never logged, stored or returned to the page.
#[tauri::command]
pub async fn native_dr_claim(app: AppHandle, replace: Option<bool>) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let keys = find_candidates(&app);
        if keys.is_empty() {
            return Ok("no_key".to_string());
        }
        let session = refresh_native_session(&app)?;
        let response = http_client()?
            .post(format!("{}/launcher/v1/dr-claim", api_base_url()))
            .bearer_auth(&session.access_token)
            .json(&serde_json::json!({ "keys": keys, "replace": replace.unwrap_or(false) }))
            .send()
            .map_err(|_| "Couldn't reach the Ramsgate Reborn server right now.".to_string())?;
        // Too many tries in the last hour: the page waits quietly and asks again, it never shows a 429.
        if response.status().as_u16() == 429 {
            return Ok("wait".to_string());
        }
        if !response.status().is_success() {
            return Err("The server couldn't check your Dauntless Revived account right now.".to_string());
        }
        let body: ClaimResponse = response
            .json()
            .map_err(|_| "The server sent an answer the launcher couldn't read.".to_string())?;
        match body.status.as_str() {
            "ported" | "already" | "no_match" | "not_found" | "fetching" | "has_progress" | "in_game" | "not_ready"
            | "not_copied_yet" | "transfers_ended" | "try_later" | "declined" => Ok(body.status),
            _ => Err("The server sent an answer the launcher couldn't read.".to_string()),
        }
    })
    .await
    .map_err(|_| "The account check stopped unexpectedly.".to_string())?
}

/// What the launcher shows for the player-initiated re-pull (POST /launcher/v1/dr-reclaim). The route is idempotent and
/// allowed once per account per hour; it refuses while the game is connected and when real progress already exists.
/// Returns one of: started, has_progress, in_game, wait, not_ready, no_key. Anything unreadable is an error the screen
/// turns into a plain "try again" line, so a network problem never blocks Play or changes anything.
pub(crate) fn reclaim_outcome(http_status: u16, word: &str) -> Option<&'static str> {
    if http_status == 429 {
        return Some("wait");
    }
    // The route is not on this server (yet): "not available", never "could not reach the server".
    if http_status == 404 {
        return Some("unavailable");
    }
    match word {
        // The real route (always HTTP 200 with { status, code, message }).
        "reclaimed" => Some("reclaimed"),
        "will_apply_on_start" => Some("will_apply"),
        "already_done" => Some("already_done"),
        "nothing_to_move" => Some("nothing"),
        "not_eligible" => Some("not_eligible"),
        "in_game" => Some("in_game"),
        "rate_limited" => Some("wait"),
        "fetching" => Some("fetching"),
        "not_ready" | "not_copied_yet" => Some("not_ready"),
        "no_match" => Some("no_match"),
        "transfers_ended" => Some("transfers_ended"),
        "declined" => Some("declined"),
        "try_later" => Some("try_later"),
        // Older guessed words, still accepted.
        "ok" | "started" | "queued" | "ported" | "already_pulled" => Some("started"),
        "has_progress" | "already" | "progress_exists" => Some("has_progress"),
        "game_connected" | "client_connected" => Some("in_game"),
        "wait" | "too_soon" => Some("wait"),
        _ => None,
    }
}

#[derive(Deserialize, Default)]
struct ReclaimReply {
    #[serde(default)]
    status: Option<String>,
    #[serde(default)]
    code: Option<String>,
    #[serde(default)]
    state: Option<String>,
}

#[tauri::command]
pub async fn native_dr_reclaim(app: AppHandle) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let keys = find_candidates(&app);
        if keys.is_empty() {
            return Ok("no_key".to_string());
        }
        let session = refresh_native_session(&app)?;
        let response = http_client()?
            .post(format!("{}/launcher/v1/dr-reclaim", api_base_url()))
            .bearer_auth(&session.access_token)
            .json(&serde_json::json!({ "keys": keys }))
            .send()
            .map_err(|_| "Couldn't reach the Ramsgate Reborn server right now.".to_string())?;
        let http_status = response.status().as_u16();
        if http_status == 429 {
            return Ok("wait".to_string());
        }
        let reply: ReclaimReply = response.json().unwrap_or_default();
        let word = reply.status.or(reply.code).or(reply.state).unwrap_or_default();
        match reclaim_outcome(http_status, &word) {
            Some(outcome) => Ok(outcome.to_string()),
            None => Err("The server couldn't start the transfer right now.".to_string()),
        }
    })
    .await
    .map_err(|_| "The transfer check stopped unexpectedly.".to_string())?
}

const CHOICE_STATES: [&str; 8] = [
    "dr_choice_open",
    "dr_not_copied_yet",
    "dr_transfers_ended",
    "dr_already_declined",
    "dr_already_transferred",
    "dr_has_progress",
    "dr_no_dr_account",
    "dr_try_again_later",
];

#[derive(Deserialize, serde::Serialize)]
pub struct ChoiceReply {
    // The decision answer is { ok, state, text }; the status answer is { state, text }. A 400 answer has no state at all.
    #[serde(default)]
    state: String,
    #[serde(default)]
    text: Option<String>,
}

/// Body of POST /launcher/v1/dr-choice/status. The keys travel in the body, never in the URL.
fn status_body(keys: &[String]) -> serde_json::Value {
    serde_json::json!({ "keys": keys })
}

/// Body of POST /launcher/v1/dr-choice. `confirmed` is always the boolean true: the server answers 400 dr_confirmation_required otherwise.
fn decision_body(keys: &[String], choice: &str) -> serde_json::Value {
    serde_json::json!({ "keys": keys, "choice": choice, "confirmed": true })
}

/// 404 and 401 on the check mean there is no Dauntless Revived account to ask about (or no usable session for it): Play stays on.
/// Everything else that is not a 2xx (5xx, 429, ...) is "try again later", which the launcher re-checks before it asks the player.
pub(crate) fn choice_state_for_http(http_status: u16) -> Option<&'static str> {
    match http_status {
        200..=299 => None,
        401 | 404 => Some("dr_no_dr_account"),
        _ => Some("dr_try_again_later"),
    }
}

fn read_choice_reply(response: reqwest::blocking::Response) -> Result<ChoiceReply, String> {
    if let Some(state) = choice_state_for_http(response.status().as_u16()) {
        return Ok(ChoiceReply { state: state.to_string(), text: None });
    }
    let mut reply: ChoiceReply = response
        .json()
        .map_err(|_| "The server sent an answer the launcher couldn't read.".to_string())?;
    if !CHOICE_STATES.contains(&reply.state.as_str()) {
        reply = ChoiceReply { state: "dr_try_again_later".to_string(), text: None };
    }
    if reply.text.as_ref().map(|t| t.len() > 600).unwrap_or(false) {
        reply.text = None;
    }
    Ok(reply)
}

/// Asks the server where this account stands on the one-time Dauntless Revived choice. Read only: one request, no retry.
#[tauri::command]
pub async fn native_dr_choice_status(app: AppHandle) -> Result<ChoiceReply, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let keys = find_candidates(&app);
        if keys.is_empty() {
            // Nothing on this PC to ask with: the same answer the server gives for keys it does not know. Nothing is sent.
            return Ok(ChoiceReply { state: "dr_no_dr_account".to_string(), text: None });
        }
        let session = refresh_native_session(&app)?;
        let response = http_client()?
            .post(format!("{}/launcher/v1/dr-choice/status", api_base_url()))
            .bearer_auth(&session.access_token)
            .json(&status_body(&keys))
            .send()
            .map_err(|_| "Couldn't reach the Ramsgate Reborn server right now.".to_string())?;
        read_choice_reply(response)
    })
    .await
    .map_err(|_| "The check stopped unexpectedly.".to_string())?
}

/// "Start fresh": gives up the Dauntless Revived move (POST /launcher/v1/dr-claim/skip, no keys, idempotent). A server that does
/// not have the route (404) or any failure is a plain sentence and changes nothing.
#[tauri::command]
pub async fn native_dr_skip(app: AppHandle) -> Result<ChoiceReply, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let session = refresh_native_session(&app)?;
        let response = http_client()?
            .post(format!("{}/launcher/v1/dr-claim/skip", api_base_url()))
            .bearer_auth(&session.access_token)
            .json(&serde_json::json!({}))
            .send()
            .map_err(|_| "Couldn't reach the Ramsgate Reborn server right now.".to_string())?;
        if !response.status().is_success() {
            return Err("We could not do that just now. Nothing was changed. Try again in a little while.".to_string());
        }
        let mut reply: ChoiceReply = response
            .json()
            .map_err(|_| "The server sent an answer the launcher couldn't read.".to_string())?;
        if reply.state != "dr_already_declined" && reply.state != "dr_already_transferred" {
            reply.state = "dr_already_declined".to_string();
        }
        if reply.text.as_ref().map(|t| t.len() > 600).unwrap_or(false) {
            reply.text = None;
        }
        Ok(reply)
    })
    .await
    .map_err(|_| "The choice stopped unexpectedly.".to_string())?
}

/// Sends the player's decision. The page only calls this after the second confirm, and the request always says `confirmed: true`.
/// One request, no retry: a failure is shown and the player presses the button again.
#[tauri::command]
pub async fn native_dr_choice_decide(app: AppHandle, choice: String) -> Result<ChoiceReply, String> {
    if choice != "transfer" && choice != "decline" {
        return Err("That choice isn't valid.".to_string());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let keys = find_candidates(&app);
        if keys.is_empty() {
            return Err("No Dauntless Revived account key was found on this PC.".to_string());
        }
        let session = refresh_native_session(&app)?;
        let response = http_client()?
            .post(format!("{}/launcher/v1/dr-choice", api_base_url()))
            .bearer_auth(&session.access_token)
            .json(&decision_body(&keys, &choice))
            .send()
            .map_err(|_| "Couldn't reach the Ramsgate Reborn server right now.".to_string())?;
        read_choice_reply(response)
    })
    .await
    .map_err(|_| "The choice stopped unexpectedly.".to_string())?
}

/// States the queue routes can answer. Anything else is treated as "try again later".
const QUEUE_STATES: &[&str] = &[
    "queue_waiting",
    "queue_pulling",
    "dr_choice_open",
    "queue_expired",
    "queue_left",
    "queue_full",
    "queue_not_found",
    "dr_transfers_ended",
    "dr_not_copied_yet",
    "dr_already_declined",
    "dr_already_transferred",
    "dr_has_progress",
    "dr_no_dr_account",
    "dr_try_again_later",
];

/// What the three queue routes answer (join, status, leave). The page gets it as camelCase, the same names the server uses.
#[derive(Deserialize, serde::Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct QueueReply {
    #[serde(default)]
    state: String,
    #[serde(default)]
    text: Option<String>,
    #[serde(default)]
    queue_state: Option<String>,
    #[serde(default)]
    position: Option<u32>,
    #[serde(default)]
    waiting_total: Option<u32>,
    #[serde(default)]
    eta_low_minutes: Option<u32>,
    #[serde(default)]
    eta_high_minutes: Option<u32>,
    #[serde(default)]
    eta_text: Option<String>,
    #[serde(default)]
    long_wait: Option<bool>,
    #[serde(default)]
    start_fresh_text: Option<String>,
    #[serde(default)]
    retry_after_seconds: Option<u32>,
}

fn queue_try_later() -> QueueReply {
    QueueReply { state: "dr_try_again_later".to_string(), ..Default::default() }
}

/// Body of POST /launcher/v1/dr-queue/join and /status. The keys travel in the body, never in the URL.
fn queue_body(keys: &[String]) -> serde_json::Value {
    serde_json::json!({ "keys": keys })
}

fn read_queue_reply(response: reqwest::blocking::Response) -> Result<QueueReply, String> {
    if !response.status().is_success() {
        return Ok(queue_try_later());
    }
    let mut reply: QueueReply = response
        .json()
        .map_err(|_| "The server sent an answer the launcher couldn't read.".to_string())?;
    if !QUEUE_STATES.contains(&reply.state.as_str()) {
        return Ok(queue_try_later());
    }
    for field in [&mut reply.text, &mut reply.eta_text, &mut reply.start_fresh_text] {
        if field.as_ref().map(|t| t.len() > 600).unwrap_or(false) {
            *field = None;
        }
    }
    Ok(reply)
}

/// One queue request. `path` is "join", "status" or "leave". Join and status carry the PC's keys in the body; leave sends an empty body.
/// One request, no retry. The keys are never logged and never put in the URL.
fn queue_request(app: &AppHandle, path: &str) -> Result<QueueReply, String> {
    let body = if path == "leave" {
        serde_json::json!({})
    } else {
        let keys = find_candidates(app);
        if keys.is_empty() {
            // Nothing on this PC to ask with: nothing is sent.
            return Ok(QueueReply { state: "dr_no_dr_account".to_string(), ..Default::default() });
        }
        queue_body(&keys)
    };
    let session = refresh_native_session(app)?;
    let response = http_client()?
        .post(format!("{}/launcher/v1/dr-queue/{}", api_base_url(), path))
        .bearer_auth(&session.access_token)
        .json(&body)
        .send()
        .map_err(|_| "Couldn't reach the Ramsgate Reborn server right now.".to_string())?;
    read_queue_reply(response)
}

/// Joins the line. Only called when the player presses "Join the line".
#[tauri::command]
pub async fn native_dr_queue_join(app: AppHandle) -> Result<QueueReply, String> {
    tauri::async_runtime::spawn_blocking(move || queue_request(&app, "join"))
        .await
        .map_err(|_| "Joining the line stopped unexpectedly.".to_string())?
}

/// Place in line. Also the heartbeat: the page calls it every couple of minutes while the screen is open.
#[tauri::command]
pub async fn native_dr_queue_status(app: AppHandle) -> Result<QueueReply, String> {
    tauri::async_runtime::spawn_blocking(move || queue_request(&app, "status"))
        .await
        .map_err(|_| "The check stopped unexpectedly.".to_string())?
}

/// Leaves the line. Safe to call twice.
#[tauri::command]
pub async fn native_dr_queue_leave(app: AppHandle) -> Result<QueueReply, String> {
    tauri::async_runtime::spawn_blocking(move || queue_request(&app, "leave"))
        .await
        .map_err(|_| "Leaving the line stopped unexpectedly.".to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn choice_bodies_match_the_backend() {
        let keys = vec!["abcDEF12_-xyz".to_string()];
        assert_eq!(status_body(&keys), serde_json::json!({ "keys": ["abcDEF12_-xyz"] }));
        let body = decision_body(&keys, "decline");
        assert_eq!(body["confirmed"], serde_json::Value::Bool(true));
        assert_eq!(body["choice"], "decline");
        assert_eq!(body["keys"][0], "abcDEF12_-xyz");
        assert_eq!(body.as_object().map(|o| o.len()), Some(3));
    }

    #[test]
    fn reclaim_answers_map_to_plain_outcomes() {
        assert_eq!(reclaim_outcome(200, "reclaimed"), Some("reclaimed"));
        assert_eq!(reclaim_outcome(200, "will_apply_on_start"), Some("will_apply"));
        assert_eq!(reclaim_outcome(200, "already_done"), Some("already_done"));
        assert_eq!(reclaim_outcome(200, "nothing_to_move"), Some("nothing"));
        assert_eq!(reclaim_outcome(200, "not_eligible"), Some("not_eligible"));
        assert_eq!(reclaim_outcome(200, "in_game"), Some("in_game"));
        assert_eq!(reclaim_outcome(200, "rate_limited"), Some("wait"));
        assert_eq!(reclaim_outcome(200, "fetching"), Some("fetching"));
        assert_eq!(reclaim_outcome(200, "not_ready"), Some("not_ready"));
        assert_eq!(reclaim_outcome(200, "no_match"), Some("no_match"));
        assert_eq!(reclaim_outcome(200, "try_later"), Some("try_later"));
        assert_eq!(reclaim_outcome(500, "try_later"), Some("try_later"));
        assert_eq!(reclaim_outcome(429, ""), Some("wait"));
        assert_eq!(reclaim_outcome(404, ""), Some("unavailable"));
        assert_eq!(reclaim_outcome(200, "started"), Some("started"));
        assert_eq!(reclaim_outcome(200, "something_new"), None);
    }

    #[test]
    fn reclaim_reply_reads_the_real_payloads() {
        let r: ReclaimReply = serde_json::from_str(r#"{"status":"reclaimed","code":"reclaimed","message":"Your Dauntless Revived progress has been moved into your account again. You can start the game now."}"#).unwrap();
        assert_eq!(r.status.as_deref(), Some("reclaimed"));
        let r: ReclaimReply = serde_json::from_str(r#"{"status":"rate_limited","code":"rate_limited","message":"x","retryAfterSeconds":2750}"#).unwrap();
        assert_eq!(reclaim_outcome(200, &r.status.unwrap()), Some("wait"));
        let r: ReclaimReply = serde_json::from_str(r#"{"status":"not_eligible","code":"not_eligible","message":"x","caseOpened":true}"#).unwrap();
        assert_eq!(reclaim_outcome(200, &r.status.unwrap()), Some("not_eligible"));
    }

    #[test]
    fn choice_check_http_codes_never_trap_play() {
        assert_eq!(choice_state_for_http(200), None);
        assert_eq!(choice_state_for_http(404), Some("dr_no_dr_account"));
        assert_eq!(choice_state_for_http(401), Some("dr_no_dr_account"));
        assert_eq!(choice_state_for_http(500), Some("dr_try_again_later"));
        assert_eq!(choice_state_for_http(429), Some("dr_try_again_later"));
    }

    #[test]
    fn queue_bodies_match_the_backend() {
        let keys = vec!["abcDEF12_-xyz".to_string()];
        assert_eq!(queue_body(&keys), serde_json::json!({ "keys": ["abcDEF12_-xyz"] }));
        assert!(QUEUE_STATES.contains(&"queue_waiting"));
        assert!(!QUEUE_STATES.contains(&"anything_else"));
    }

    #[test]
    fn queue_reply_reads_the_server_names() {
        let reply: QueueReply = serde_json::from_str(
            r#"{"state":"queue_waiting","queueState":"waiting","position":3,"waitingTotal":9,"etaLowMinutes":120,"etaHighMinutes":240,"longWait":false,"retryAfterSeconds":120}"#,
        )
        .unwrap();
        assert_eq!(reply.position, Some(3));
        assert_eq!(reply.retry_after_seconds, Some(120));
        assert_eq!(serde_json::to_value(&reply).unwrap()["waitingTotal"], 9);
    }

    #[test]
    fn reads_backup_and_export_formats() {
        assert_eq!(key_from_text("DRK2\n-\nabcDEF12_-xyz\n").as_deref(), Some("abcDEF12_-xyz"));
        assert_eq!(key_from_text("Server: x\nKey: abcDEF12_-xyz\n\nKeep private").as_deref(), Some("abcDEF12_-xyz"));
        assert_eq!(key_from_text("short"), None);
        assert_eq!(key_from_text("DRK2\n-\nbad key here!\n"), None);
    }
}
