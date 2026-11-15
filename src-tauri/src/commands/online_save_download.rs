// Download-only copy of the player's own online save (RR-38).
//
// The direction is live -> this PC and nothing else:
//   1. refresh the signed-in session, as every online command does,
//   2. GET /launcher/v1/offline-snapshot/ticket with the launcher access token -> a single-use, read-only ticket,
//   3. GET /launcher/v1/offline-snapshot with that ticket -> the signed save file (gzip),
//   4. write it atomically into %LOCALAPPDATA%\RamsgateReborn\online-save-downloads.
// Both requests are GET with no body. Nothing is sent from this PC: no file, no offline data, no local state. The
// folder it writes to is outside the offline folder, and no offline code reads it, so the file is only a copy until the
// owner decides how (or whether) offline mode may use it. The ticket never leaves this function (not returned, not
// logged, not written). This file lives in the online half of the launcher; the offline module has no network code.
//
// Both routes are off on the backend unless RR_OFFLINE_SNAPSHOT_ENABLED=1, so a server without them answers 404 and
// the result is "not available yet".

use serde::{Deserialize, Serialize};
use std::io::{Read, Write};
use std::path::PathBuf;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager};

use crate::commands::auth::{api_base_url, refresh_native_session, safe_api_error};

pub const TICKET_PATH: &str = "/launcher/v1/offline-snapshot/ticket";
pub const SNAPSHOT_PATH: &str = "/launcher/v1/offline-snapshot";
const MAX_BYTES: u64 = 64 * 1024 * 1024;

#[derive(Serialize, Debug, PartialEq)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum OnlineSaveResult {
    #[serde(rename_all = "camelCase")]
    Saved { file_name: String, size: u64 },
    #[serde(rename_all = "camelCase")]
    Unavailable { message: String },
}

#[derive(Deserialize)]
struct TicketResponse {
    ticket: String,
}

/// Status codes that mean "this server does not offer the snapshot" rather than an error the player can fix.
pub fn endpoint_unavailable(status: u16) -> bool {
    matches!(status, 404 | 405 | 410 | 501 | 503)
}

/// A ticket is a compact JWT: three base64url parts. Anything else is not sent anywhere.
pub fn ticket_looks_valid(t: &str) -> bool {
    t.len() >= 20
        && t.len() <= 4096
        && t.split('.').count() == 3
        && t.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.')
}

pub fn looks_like_gzip(bytes: &[u8]) -> bool {
    bytes.len() > 18 && bytes[0] == 0x1f && bytes[1] == 0x8b
}

pub fn download_file_name(unix_secs: u64) -> String {
    format!("online-save-{unix_secs}.rrsave")
}

fn unavailable() -> OnlineSaveResult {
    OnlineSaveResult::Unavailable {
        message: "Downloading your online save is not available on this server yet.".to_string(),
    }
}

fn downloads_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let base = app
        .path()
        .local_data_dir()
        .map_err(|e| format!("Couldn't locate the downloads folder: {e}"))?;
    Ok(base.join("RamsgateReborn").join("online-save-downloads"))
}

fn client() -> Result<reqwest::blocking::Client, String> {
    reqwest::blocking::Client::builder()
        .connect_timeout(Duration::from_secs(5))
        .timeout(Duration::from_secs(90))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| "Couldn't prepare the secure launcher connection.".to_string())
}

fn write_atomic(path: &std::path::Path, bytes: &[u8]) -> Result<(), String> {
    let dir = path.parent().ok_or("Bad download path.")?;
    std::fs::create_dir_all(dir).map_err(|e| format!("Couldn't create the downloads folder: {e}"))?;
    let tmp = path.with_extension("part");
    let mut f = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&tmp)
        .map_err(|e| format!("Couldn't write the save: {e}"))?;
    f.write_all(bytes).map_err(|e| format!("Couldn't write the save: {e}"))?;
    f.sync_all().ok();
    drop(f);
    std::fs::rename(&tmp, path).map_err(|e| format!("Couldn't finish the save: {e}"))
}

fn fetch(app: &AppHandle) -> Result<OnlineSaveResult, String> {
    let session = refresh_native_session(app)?;
    let client = client()?;
    let base = api_base_url();

    let response = client
        .get(format!("{base}{TICKET_PATH}"))
        .bearer_auth(&session.access_token)
        .send()
        .map_err(|_| "Couldn't reach the Ramsgate Reborn server right now.".to_string())?;
    let status = response.status().as_u16();
    if endpoint_unavailable(status) {
        return Ok(unavailable());
    }
    if status == 429 {
        return Err("You can download your online save a few times per hour. Try again later.".to_string());
    }
    if !response.status().is_success() {
        return Err(safe_api_error(response, "Couldn't download your online save."));
    }
    let ticket = response
        .json::<TicketResponse>()
        .map_err(|_| "The server returned an invalid response.".to_string())?
        .ticket;
    if !ticket_looks_valid(&ticket) {
        return Err("The server returned an invalid response.".to_string());
    }

    let response = client
        .get(format!("{base}{SNAPSHOT_PATH}"))
        .header("Authorization", format!("RR-Snapshot {ticket}"))
        .send()
        .map_err(|_| "Couldn't reach the Ramsgate Reborn server right now.".to_string())?;
    drop(ticket);
    let status = response.status().as_u16();
    if endpoint_unavailable(status) {
        return Ok(unavailable());
    }
    if status == 409 {
        return Err("Leave the game first, then download your save.".to_string());
    }
    if !response.status().is_success() {
        return Err(safe_api_error(response, "Couldn't download your online save."));
    }

    let mut bytes = Vec::new();
    response
        .take(MAX_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "The download of your save stopped. Try again.".to_string())?;
    if bytes.len() as u64 > MAX_BYTES || !looks_like_gzip(&bytes) {
        return Err("The server sent something that is not a save file.".to_string());
    }

    let secs = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    let name = download_file_name(secs);
    write_atomic(&downloads_dir(app)?.join(&name), &bytes)?;
    Ok(OnlineSaveResult::Saved { file_name: name, size: bytes.len() as u64 })
}

#[tauri::command]
pub async fn native_download_online_save(app: AppHandle) -> Result<OnlineSaveResult, String> {
    tauri::async_runtime::spawn_blocking(move || fetch(&app))
        .await
        .map_err(|_| "The save download stopped unexpectedly.".to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unavailable_statuses() {
        for s in [404, 405, 410, 501, 503] {
            assert!(endpoint_unavailable(s), "{s}");
        }
        for s in [200, 401, 403, 409, 429, 500] {
            assert!(!endpoint_unavailable(s), "{s}");
        }
    }

    #[test]
    fn tickets_and_files() {
        assert!(ticket_looks_valid("eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ4In0.c2lnbmF0dXJlLXBhcnQ"));
        assert!(!ticket_looks_valid("a.b"));
        assert!(!ticket_looks_valid("eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ4In0.sig\r\nX-Other: 1"));
        assert!(looks_like_gzip(&[0x1f, 0x8b, 8, 0, 0, 0, 0, 0, 0, 3, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]));
        assert!(!looks_like_gzip(b"{\"json\":true}............"));
    }

    /// Download only, checked on this file's code: no local file is read, no offline folder is named, no request body
    /// is built, and there are exactly two GET requests and no other HTTP verb.
    #[test]
    fn only_downloads() {
        let src = include_str!("online_save_download.rs");
        let code = &src[..src.find("#[cfg(test)]").unwrap()];
        let code: String = code.lines().filter(|l| !l.trim_start().starts_with("//")).collect::<Vec<_>>().join("\n");
        for bad in [
            "fs::read", "read_dir", "File::open", "read_to_string", ".body(", ".json(&", ".multipart(", ".form(", ".post(", ".put(",
            ".patch(", ".delete(", "crate::offline", "\"offline\"", "println!", "eprintln!",
        ] {
            assert!(!code.contains(bad), "online_save_download.rs contains `{bad}`");
        }
        assert_eq!(code.matches(".get(").count(), 2);
    }
}
