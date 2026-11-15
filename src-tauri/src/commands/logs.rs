use serde::Serialize;
use std::fs;
use std::path::Path;
use tauri::{AppHandle, Manager};
use tauri_plugin_opener::OpenerExt;

use crate::commands::auth::{api_base_url, http_client, refresh_native_session, safe_api_error};
use crate::launch::logs;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LogPaths {
    pub sessions_root: String,
    pub latest_session_dir: Option<String>,
}

#[tauri::command]
pub fn native_get_log_paths(app: AppHandle) -> Result<LogPaths, String> {
    let root = logs::sessions_root(&app)?;
    // Best-effort so "open folder" has somewhere to open even before a first Play.
    let _ = fs::create_dir_all(&root);
    let latest = logs::latest_session_dir(&app)?;
    Ok(LogPaths {
        sessions_root: root.to_string_lossy().into_owned(),
        latest_session_dir: latest.map(|p| p.to_string_lossy().into_owned()),
    })
}

#[tauri::command]
pub fn native_open_log_folder(app: AppHandle) -> Result<(), String> {
    let root = logs::sessions_root(&app)?;
    fs::create_dir_all(&root).map_err(|e| format!("Couldn't create the log folder: {e}"))?;
    app.opener()
        .open_path(root.to_string_lossy().to_string(), None::<&str>)
        .map_err(|_| "Couldn't open the log folder.".to_string())
}

/// RR-38 log separation: the uploader takes a folder only when it sits directly inside the online sessions folder and
/// not inside the offline folder. Offline logs (RamsgateReborn\offline\logs) can never be sent.
pub(crate) fn ensure_online_session_dir(dir: &Path, sessions_root: &Path, offline_root: &Path) -> Result<(), String> {
    use crate::offline::paths::is_within;
    let refused = || Err("Only online session logs can be sent.".to_string());
    if is_within(dir, offline_root) || is_within(sessions_root, offline_root) {
        return refused();
    }
    match dir.parent() {
        Some(parent) if is_within(parent, sessions_root) && is_within(sessions_root, parent) => {}
        _ => return refused(),
    }
    let name = dir.file_name().and_then(|n| n.to_str()).unwrap_or("");
    if name.is_empty() || name == "." || name == ".." {
        return refused();
    }
    Ok(())
}

// Only ever uploads files the launcher itself writes into a session folder (see
// launch::logs) — never an arbitrary path from JS. The backend independently re-validates
// both the session id and file name against the same allow-list (routes/launcherLogs.ts) and
// re-checks the tester role server-side, since a local file existing is not proof of anything.
fn uploadable_files(dir: &std::path::Path) -> Vec<String> {
    let mut names = Vec::new();
    for fixed in ["metadata.json", "launcher.log"] {
        if dir.join(fixed).is_file() {
            names.push(fixed.to_string());
        }
    }
    let mut runtime = Vec::new();
    if let Ok(entries) = fs::read_dir(dir) {
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            if name.starts_with("runtime-") && name.ends_with(".log") {
                runtime.push(name);
            }
        }
    }
    runtime.sort_by_key(|name| (upload_rank(name), name.clone()));
    names.extend(runtime);
    names
}

/// The runtime DLL log and the Windows error report say why a game died, so they go up right after the
/// metadata; the ini dumps and file listing follow.
fn upload_rank(name: &str) -> u8 {
    if name.starts_with("runtime-ramsgatereborn_dll_port") {
        0
    } else if name.starts_with("runtime-wer-") {
        1
    } else if name.starts_with("runtime-game-engine") {
        2
    } else {
        3
    }
}

/// Time allowed for one file. The DLL log tail is 1.8 MB, and on a slow home uplink that takes minutes, which the
/// launcher's 10 s API timeout cut off every time (the DLL log of those players never arrived). Small files keep a short
/// limit; the cap stays under the server's 300 s request limit.
fn upload_timeout(len: usize) -> std::time::Duration {
    std::time::Duration::from_secs((15 + len as u64 / 4096).min(280))
}

/// Uploads one session folder's allow-listed files. Shared by the manual "send last session" button and the
/// automatic crash report, so both go through the same checks.
fn upload_session(app: &AppHandle, access_token: &str, dir: &std::path::Path) -> Result<u32, String> {
    // RR-38: only an online session folder can ever be sent; offline logs stay on this PC.
    let local = app
        .path()
        .local_data_dir()
        .map_err(|e| format!("Couldn't locate the log directory: {e}"))?;
    ensure_online_session_dir(dir, &logs::sessions_root(app)?, &crate::offline::paths::offline_root_under(&local))?;

    let session_id = dir
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or_else(|| "Invalid session folder.".to_string())?
        .to_string();

    // Windows writes its own crash report a few seconds after the game dies; by now it is there.
    logs::copy_wer_reports_best_effort(dir);

    let files = uploadable_files(dir);
    if files.is_empty() {
        return Err("No log files were found in the last session.".to_string());
    }

    let client = http_client()?;
    let base = api_base_url();
    let mut uploaded = 0u32;
    let mut failed: Option<String> = None;
    let mut problems: Vec<String> = Vec::new();
    for name in files {
        let Ok(bytes) = fs::read(dir.join(&name)) else {
            problems.push(format!("{name}: unreadable"));
            continue;
        };
        let len = bytes.len();
        let started = std::time::Instant::now();
        let response = client
            .put(format!("{base}/launcher/v1/logs/sessions/{session_id}/{name}"))
            .bearer_auth(access_token)
            .header("Content-Type", "application/octet-stream")
            .timeout(upload_timeout(len))
            .body(bytes)
            .send();
        let response = match response {
            Ok(response) => response,
            Err(error) => {
                // One file that does not get through (slow line, timeout) must not keep the others from arriving.
                let kind = if error.is_timeout() { "timed out" } else { "not sent" };
                problems.push(format!("{name}: {kind} after {} s ({len} bytes)", started.elapsed().as_secs()));
                failed = Some("Couldn't reach the Ramsgate Reborn server right now.".to_string());
                continue;
            }
        };
        if !response.status().is_success() {
            // One refused file (for example one over the size limit) must not keep the others from arriving.
            problems.push(format!("{name}: refused ({})", response.status().as_u16()));
            failed = Some(safe_api_error(response, "Log upload failed."));
            continue;
        }
        uploaded += 1;
    }
    if !problems.is_empty() && uploaded > 0 {
        // Say on the server which files did not arrive and why, so a missing log is never a mystery again.
        let note = format!("launcher {}\n{}\n", env!("CARGO_PKG_VERSION"), problems.join("\n"));
        let _ = client
            .put(format!("{base}/launcher/v1/logs/sessions/{session_id}/runtime-upload-problems.log"))
            .bearer_auth(access_token)
            .header("Content-Type", "application/octet-stream")
            .timeout(upload_timeout(note.len()))
            .body(note.into_bytes())
            .send();
    }
    if uploaded == 0 {
        if let Some(error) = failed {
            return Err(error);
        }
    }
    // The game's crash dumps go only when the player chose "always send" in Settings; with "ask" the dashboard asks
    // after a crash (native_crash_dump_offer), with "never" they stay on this PC.
    if read_dump_choice(&dump_choice_file(app)?) == DumpChoice::Always && !dir.join(DUMPS_MARKER).exists() {
        uploaded += upload_dumps(access_token, dir, &session_id);
    }
    Ok(uploaded)
}

/// Whether the game's crash dumps may be sent. Kept in `%LOCALAPPDATA%\RamsgateReborn\crash-dumps.txt`; no file means ask.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum DumpChoice {
    Ask,
    Always,
    Never,
}

/// Written into a session folder once its dumps were sent or the player said no, so nobody is asked twice.
const DUMPS_MARKER: &str = "crash-dumps-done";

fn dump_choice_file(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    let local = app
        .path()
        .local_data_dir()
        .map_err(|e| format!("Couldn't locate the launcher folder: {e}"))?;
    Ok(local.join("RamsgateReborn").join("crash-dumps.txt"))
}

pub(crate) fn read_dump_choice(file: &Path) -> DumpChoice {
    match fs::read_to_string(file).unwrap_or_default().trim() {
        "always" => DumpChoice::Always,
        "never" => DumpChoice::Never,
        _ => DumpChoice::Ask,
    }
}

fn dump_choice_name(choice: DumpChoice) -> &'static str {
    match choice {
        DumpChoice::Ask => "ask",
        DumpChoice::Always => "always",
        DumpChoice::Never => "never",
    }
}

fn write_dump_choice(file: &Path, choice: &str) -> Result<(), String> {
    if !matches!(choice, "ask" | "always" | "never") {
        return Err("Unknown crash dump setting.".to_string());
    }
    if let Some(parent) = file.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("Couldn't save the setting: {e}"))?;
    }
    fs::write(file, choice).map_err(|e| format!("Couldn't save the setting: {e}"))
}

/// Sends a session's crash dumps (newest 2 crashes, 50 MB at most together) as crash-<n>.dmp. Only called after the
/// player agreed, which the request says in a header the server requires. Returns how many arrived.
fn upload_dumps(access_token: &str, dir: &Path, session_id: &str) -> u32 {
    let dumps = logs::session_crash_dumps(dir);
    if dumps.is_empty() {
        let _ = fs::write(dir.join(DUMPS_MARKER), "none");
        return 0;
    }
    let Ok(client) = http_client() else { return 0 };
    let base = api_base_url();
    let mut sent = 0u32;
    let mut problems = Vec::new();
    for (number, path, size) in dumps {
        let Ok(bytes) = fs::read(&path) else {
            problems.push(format!("crash-{number}.dmp: unreadable"));
            continue;
        };
        let response = client
            .put(format!("{base}/launcher/v1/logs/sessions/{session_id}/crash-{number}.dmp"))
            .bearer_auth(access_token)
            .header("Content-Type", "application/octet-stream")
            .header("X-RR-Crash-Dump-Consent", "yes")
            .timeout(upload_timeout(bytes.len()))
            .body(bytes)
            .send();
        match response {
            Ok(r) if r.status().is_success() => sent += 1,
            Ok(r) => problems.push(format!("crash-{number}.dmp: refused ({}) ({size} bytes)", r.status().as_u16())),
            Err(e) => problems.push(format!("crash-{number}.dmp: {} ({size} bytes)", if e.is_timeout() { "timed out" } else { "not sent" })),
        }
    }
    if !problems.is_empty() {
        let note = format!("launcher {}\n{}\n", env!("CARGO_PKG_VERSION"), problems.join("\n"));
        let _ = client
            .put(format!("{base}/launcher/v1/logs/sessions/{session_id}/runtime-dump-upload-problems.log"))
            .bearer_auth(access_token)
            .header("Content-Type", "application/octet-stream")
            .timeout(upload_timeout(note.len()))
            .body(note.into_bytes())
            .send();
    }
    let _ = fs::write(dir.join(DUMPS_MARKER), if problems.is_empty() { "sent" } else { "partly sent" });
    sent
}

#[tauri::command]
pub fn native_get_crash_dump_choice(app: AppHandle) -> Result<String, String> {
    Ok(dump_choice_name(read_dump_choice(&dump_choice_file(&app)?)).to_string())
}

#[tauri::command]
pub fn native_set_crash_dump_choice(app: AppHandle, choice: String) -> Result<(), String> {
    write_dump_choice(&dump_choice_file(&app)?, &choice)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CrashDumpOffer {
    pub count: u32,
    pub bytes: u64,
}

/// The latest session's crash dumps, when the player should be asked about them: its logs already went up (automatic
/// report), the setting is "ask" (when `only_when_asking`), and nobody answered for this session yet.
fn pending_offer(app: &AppHandle, only_when_asking: bool) -> Result<Option<(std::path::PathBuf, CrashDumpOffer)>, String> {
    let Some(dir) = logs::latest_session_dir(app)? else { return Ok(None) };
    let local = app
        .path()
        .local_data_dir()
        .map_err(|e| format!("Couldn't locate the log directory: {e}"))?;
    if ensure_online_session_dir(&dir, &logs::sessions_root(app)?, &crate::offline::paths::offline_root_under(&local)).is_err()
        || !dir.join("crash-reported").exists()
        || dir.join(DUMPS_MARKER).exists()
        || (only_when_asking && read_dump_choice(&dump_choice_file(app)?) != DumpChoice::Ask)
    {
        return Ok(None);
    }
    let dumps = logs::session_crash_dumps(&dir);
    if dumps.is_empty() {
        return Ok(None);
    }
    let offer = CrashDumpOffer { count: dumps.len() as u32, bytes: dumps.iter().map(|d| d.2).sum() };
    Ok(Some((dir, offer)))
}

#[tauri::command]
pub async fn native_crash_dump_offer(app: AppHandle) -> Result<Option<CrashDumpOffer>, String> {
    tauri::async_runtime::spawn_blocking(move || Ok(pending_offer(&app, true)?.map(|(_, offer)| offer)))
        .await
        .map_err(|_| "The crash dump check stopped unexpectedly.".to_string())?
}

/// The player's answer to the crash dump question. `remember` makes it the setting for next time.
#[tauri::command]
pub async fn native_answer_crash_dump(app: AppHandle, send: bool, remember: bool) -> Result<u32, String> {
    tauri::async_runtime::spawn_blocking(move || {
        if remember {
            write_dump_choice(&dump_choice_file(&app)?, if send { "always" } else { "never" })?;
        }
        // "remember" may have just changed the setting away from "ask"; the question was still about this session.
        let Some((dir, _)) = pending_offer(&app, false)? else { return Ok(0) };
        if !send {
            let _ = fs::write(dir.join(DUMPS_MARKER), "declined");
            return Ok(0);
        }
        let session_id = dir.file_name().and_then(|n| n.to_str()).unwrap_or_default().to_string();
        let session = refresh_native_session(&app)?;
        Ok(upload_dumps(&session.access_token, &dir, &session_id))
    })
    .await
    .map_err(|_| "The crash dump upload stopped unexpectedly.".to_string())?
}

#[tauri::command]
pub async fn native_upload_last_session(app: AppHandle) -> Result<u32, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let Some(dir) = logs::latest_session_dir(&app)? else {
            return Err("No session logs found yet — play once first.".to_string());
        };
        let refreshed = refresh_native_session(&app)?;
        upload_session(&app, &refreshed.access_token, &dir)
    })
    .await
    .map_err(|_| "The upload task stopped unexpectedly.".to_string())?
}

/// True for a session folder the launcher marked as ended before the game was started.
pub(crate) fn failed_before_game_start(dir: &Path) -> bool {
    dir.join(crate::commands::launch::LAUNCH_FAILED_MARKER).is_file() && !dir.join("metadata.json").is_file()
}

/// Automatic session report. Sends the latest finished session's logs once, and only when the server's policy
/// switches automatic reports on. A marker file stops it sending twice.
/// Returns true when a report was sent. Errors are for the caller to ignore: reporting must never get in the way.
#[tauri::command]
pub async fn native_report_crash(app: AppHandle) -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let Some(dir) = logs::latest_session_dir(&app)? else {
            return Ok(false);
        };
        let marker = dir.join("crash-reported");
        if marker.exists() {
            return Ok(false);
        }

        // A launch that stopped before the game started (game file gone, servers unreachable) has no exit code and
        // never will; its log is sent as it is, whatever the automatic-report setting says, so we can see why.
        if failed_before_game_start(&dir) {
            let session = refresh_native_session(&app)?;
            upload_session(&app, &session.access_token, &dir)?;
            let _ = fs::write(&marker, "sent");
            return Ok(true);
        }

        // The exit code is written by the thread that watches the game; give it a moment after the game stops.
        let mut exit_code: Option<u64> = None;
        for attempt in 0..8 {
            if let Ok(text) = fs::read_to_string(dir.join("metadata.json")) {
                if let Ok(meta) = serde_json::from_str::<serde_json::Value>(&text) {
                    exit_code = meta.get("exitCode").and_then(|v| v.as_u64());
                }
            }
            if exit_code.is_some() || attempt == 7 {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(500));
        }
        // No exit code yet means the game is still running (or the launcher was closed before it ended). Any finished
        // session is reported, not only crashes: a game that shows an error and is then closed exits normally, and its
        // log is exactly what is needed to find out why.
        if exit_code.is_none() {
            return Ok(false);
        }

        let session = refresh_native_session(&app)?;
        if !crate::commands::auth::fetch_policy(&session.access_token, None)?.log_upload.auto {
            return Ok(false);
        }
        upload_session(&app, &session.access_token, &dir)?;
        let _ = fs::write(&marker, "sent");
        Ok(true)
    })
    .await
    .map_err(|_| "The crash report task stopped unexpectedly.".to_string())?
}

#[cfg(test)]
mod tests {
    use super::{ensure_online_session_dir, failed_before_game_start};
    use std::path::{Path, PathBuf};

    fn roots() -> (PathBuf, PathBuf) {
        let local = Path::new(r"C:\Users\p\AppData\Local");
        (local.join("RamsgateReborn").join("Logs").join("Sessions"), crate::offline::paths::offline_root_under(local))
    }

    #[test]
    fn online_session_folders_are_accepted() {
        let (sessions, offline) = roots();
        assert!(ensure_online_session_dir(&sessions.join("0f8fad5b-d9cb-469f-a165-70867728950e"), &sessions, &offline).is_ok());
    }

    #[test]
    fn offline_folders_are_never_uploadable() {
        let (sessions, offline) = roots();
        for dir in [
            offline.join("logs"),
            offline.join("logs").join("gameservers"),
            offline.join("inbox"),
            offline.clone(),
            sessions.join("..").join("..").join("offline").join("logs"),
            sessions.clone(),
            sessions.join("a").join("b"),
            PathBuf::from(r"C:\Temp\x"),
        ] {
            assert!(ensure_online_session_dir(&dir, &sessions, &offline).is_err(), "{dir:?}");
        }
        // A sessions root pointed into the offline folder is refused as a whole.
        let moved = offline.join("logs");
        assert!(ensure_online_session_dir(&moved.join("abc"), &moved, &offline).is_err());
    }

    #[test]
    fn dump_choice_defaults_to_ask_and_only_takes_known_values() {
        use super::{read_dump_choice, write_dump_choice, DumpChoice};
        let dir = std::env::temp_dir().join(format!("rr-dump-choice-{}", std::process::id()));
        let file = dir.join("crash-dumps.txt");
        let _ = std::fs::remove_dir_all(&dir);
        assert_eq!(read_dump_choice(&file), DumpChoice::Ask);
        write_dump_choice(&file, "always").unwrap();
        assert_eq!(read_dump_choice(&file), DumpChoice::Always);
        write_dump_choice(&file, "never").unwrap();
        assert_eq!(read_dump_choice(&file), DumpChoice::Never);
        assert!(write_dump_choice(&file, "yes please").is_err());
        assert_eq!(read_dump_choice(&file), DumpChoice::Never);
        std::fs::write(&file, "garbage").unwrap();
        assert_eq!(read_dump_choice(&file), DumpChoice::Ask);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn crash_dumps_and_local_notes_are_not_on_the_log_list() {
        let dir = std::env::temp_dir().join(format!("rr-upload-nodump-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        for name in ["metadata.json", "crash-folders.txt", "crash-1.dmp", "UE4Minidump.dmp", "crash-dumps-done", "runtime-crash-1-context.log"] {
            std::fs::write(dir.join(name), b"x").unwrap();
        }
        let names = super::uploadable_files(&dir);
        assert_eq!(names, vec!["metadata.json".to_string(), "runtime-crash-1-context.log".to_string()]);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn dll_log_goes_up_first_and_slow_lines_get_time() {
        let dir = std::env::temp_dir().join(format!("rr-upload-order-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        for name in ["metadata.json", "launcher.log", "runtime-config-Engine.log", "runtime-game-files.log",
            "runtime-ramsgatereborn_dll_port0.log", "runtime-wer-0.log", "runtime-game-engine.log"] {
            std::fs::write(dir.join(name), b"x").unwrap();
        }
        let names = super::uploadable_files(&dir);
        assert_eq!(&names[..4], &["metadata.json", "launcher.log", "runtime-ramsgatereborn_dll_port0.log", "runtime-wer-0.log"]);
        assert_eq!(names.len(), 7);
        let _ = std::fs::remove_dir_all(&dir);
        assert_eq!(super::upload_timeout(100).as_secs(), 15);
        assert!(super::upload_timeout(1_800_000).as_secs() >= 250);
        assert!(super::upload_timeout(50_000_000).as_secs() <= 280);
    }

    #[test]
    fn only_a_marked_session_without_metadata_counts_as_failed_early() {
        let dir = std::env::temp_dir().join(format!("rr-failed-early-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        assert!(!failed_before_game_start(&dir));
        std::fs::write(dir.join(crate::commands::launch::LAUNCH_FAILED_MARKER), "1").unwrap();
        assert!(failed_before_game_start(&dir));
        std::fs::write(dir.join("metadata.json"), "{}").unwrap();
        assert!(!failed_before_game_start(&dir));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
