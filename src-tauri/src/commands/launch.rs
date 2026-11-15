use serde::{Deserialize, Serialize};
use std::sync::{Mutex, OnceLock};
use tauri::AppHandle;

use crate::commands::auth::{
    api_base_url, fetch_policy, http_client, refresh_native_session, safe_api_error,
};
use crate::commands::retry;
use crate::commands::updates::RUNTIME_DLL_NAME;
use crate::commands::install::{saved_game_state, SavedGame};
use crate::install::{paths, verify};
use crate::launch::flags;
use crate::launch::logs::{self, SessionMetadata};
use crate::launch::process::{self, LaunchIdentity};

/// Shown when the saved game file is gone; the Home tab then offers the folder picker.
pub(crate) const MISSING_GAME_MESSAGE: &str =
    "We can't find Dauntless where it was before. It may have been moved or deleted. Choose the folder it's in now.";

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ServerStatus {
    supported_build_changelist: u32,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct GameSessionRequest<'a> {
    build_changelist: u32,
    executable_sha256: &'a str,
    // The server re-validates this against the account's CURRENT roles at the moment the
    // ticket is issued — the actual authoritative boundary, since the policy fetch/channel
    // check a few lines above this could already be stale by the time this request lands.
    runtime_channel: &'a str,
    // Exact installed DLL hash; the backend compares it with the signed manifest for the
    // server-derived account channel and stores it in the one-time exchange-code record.
    runtime_sha256: &'a str,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct GameSessionResponse {
    exchange_code: String,
}

// Async on purpose: a plain `fn` command runs on the window's main thread, and this one is polled every 8 seconds.
#[tauri::command]
pub async fn is_game_running() -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(process::is_game_running)
        .await
        .map_err(|_| "The process check stopped unexpectedly.".to_string())?
}

/// "none", "running" or "exited" for the game this launcher started, read from the launcher's own wait on the game
/// process. Cheap (no process scan), so the Home tab polls it while the game is open.
#[tauri::command]
pub fn launched_game_state() -> String {
    process::launched_game_state().as_str().to_string()
}

/// Security boundary for Play: the WebView supplies no token, identity, build
/// hash, or exchange code. Rust loads the DPAPI/Credential Manager refresh
/// token, rotates it, verifies the install, requests the one-time game ticket,
/// and spawns immediately. The ticket never becomes JavaScript-visible.
/// `expected_channel` is the channel value the TS side already fetched and used to
/// check/install the runtime DLL for this exact Play attempt (see HomeTab.tsx's
/// `handlePlay`). Re-fetching policy here and comparing closes a race: TS's policy fetch and
/// this function's fetch happen moments apart, so an admin could revoke Tester in between —
/// without this check, the already-installed beta/dev runtime would still launch even though
/// the account is no longer entitled to it.
#[tauri::command]
pub fn secure_launch(app: AppHandle, expected_channel: String) -> Result<(), String> {
    static SECURE_LAUNCH_LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    let _guard = SECURE_LAUNCH_LOCK
        .get_or_init(|| Mutex::new(()))
        .try_lock()
        .map_err(|_| "A launch is already being prepared. Please wait a moment.".to_string())?;

    // The window goes to the taskbar as soon as Play is accepted; any failure before or at game start brings it back
    // so the error is visible.
    set_launcher_window_minimized(&app, true);
    let result = secure_launch_inner(&app, expected_channel);
    if result.is_err() {
        set_launcher_window_minimized(&app, false);
    }
    result
}

#[tauri::command]
pub fn set_launcher_minimized(app: AppHandle, minimized: bool) {
    set_launcher_window_minimized(&app, minimized);
}

fn set_launcher_window_minimized(app: &AppHandle, minimized: bool) {
    use tauri::Manager;
    if let Some(window) = app.get_webview_window("main") {
        if minimized {
            let _ = window.minimize();
        } else {
            let _ = window.unminimize();
            let _ = window.show();
            let _ = window.set_focus();
        }
    }
}

/// The log folder is made first, before anything that can fail, so a launch that stops early (game file gone, no
/// connection) still leaves a log. Such a folder gets a `launch-failed` marker, which makes the automatic report send it.
fn secure_launch_inner(app: &AppHandle, expected_channel: String) -> Result<(), String> {
    let launch_session_id = logs::generate_launch_session_id();
    let session_dir = logs::session_dir(app, &launch_session_id)?;
    logs::append_launcher_log(&session_dir, &format!("play requested, launcher {}", env!("CARGO_PKG_VERSION")));
    let result = secure_launch_steps(app, expected_channel, &launch_session_id, &session_dir);
    if let Err(message) = &result {
        record_launch_failure(&session_dir, message);
    }
    result
}

/// Marker file that tells the automatic report this session ended before the game started.
pub(crate) const LAUNCH_FAILED_MARKER: &str = "launch-failed";

/// Failures whose text says the servers could not be reached.
fn is_unreachable_message(message: &str) -> bool {
    let m = message.to_ascii_lowercase();
    m.contains("couldn't reach") || m.contains("can't reach") || m.contains("check your connection") || m.contains("couldn't request a game session")
}

fn record_launch_failure(session_dir: &std::path::Path, message: &str) {
    logs::append_launcher_log(session_dir, &format!("launch stopped: {message}"));
    let _ = std::fs::write(session_dir.join(LAUNCH_FAILED_MARKER), "1");
    if is_unreachable_message(message) {
        // The check can take up to a minute on a dead connection, so it runs beside the error being shown.
        let dir = session_dir.to_path_buf();
        std::thread::spawn(move || crate::commands::net_diag::log_reachability(&dir));
    }
}

fn secure_launch_steps(
    app: &AppHandle,
    expected_channel: String,
    launch_session_id: &str,
    session_dir: &std::path::Path,
) -> Result<(), String> {
    let app = app.clone();
    let saved = paths::load_saved_exe_path(&app);
    match saved_game_state(saved.as_deref()) {
        SavedGame::NothingSaved => {
            logs::append_launcher_log(session_dir, "no game location is saved");
            return Err("Choose the folder where Dauntless is installed first.".to_string());
        }
        SavedGame::Missing => {
            logs::append_launcher_log(session_dir, "the saved game file was not found (moved, deleted or its drive is gone)");
            return Err(MISSING_GAME_MESSAGE.to_string());
        }
        SavedGame::Present => {}
    }
    let exe_path = saved.ok_or_else(|| "Choose the folder where Dauntless is installed first.".to_string())?;
    let game_dir = paths::game_dir(&exe_path)?;
    verify::verify_runtime_dlls_present(&game_dir)?;
    if process::is_game_running()? {
        return Err("Dauntless is already running.".to_string());
    }
    if let Some(note) = process::leftover_processes_note() {
        logs::append_launcher_log(session_dir, &note);
    }
    let executable_sha256 = verify::hash_file_sha256(&exe_path)?;
    let runtime_sha256 = verify::hash_file_sha256(&game_dir.join(RUNTIME_DLL_NAME))?;
    let refreshed = refresh_native_session(&app)?;

    // Fetch policy fresh, right before spawning — used for flag reconciliation AND the
    // channel-consistency check above. Fails closed: if we can't reach the policy endpoint we
    // can't confirm current entitlement, so we don't launch. This doesn't cost real
    // availability — the ticket request a few lines below needs the same backend anyway, so a
    // backend outage was going to fail Play regardless.
    let policy = fetch_policy(&refreshed.access_token, Some(&expected_channel)).map_err(|_| {
        "Couldn't verify your account access. Check your connection and try again.".to_string()
    })?;
    if policy.channel != expected_channel {
        return Err(
            "Your account access changed. Press Play again to pick up the new settings."
                .to_string(),
        );
    }

    logs::append_launcher_log(
        session_dir,
        &format!("play requested for {}", refreshed.account.display_name),
    );
    // Keep the log folders from growing for ever: trim old sessions and an oversized runtime DLL log (the game is not
    // running yet, so nothing holds either open).
    if let Ok(root) = logs::sessions_root(&app) {
        logs::prune_old_sessions(&root, logs::KEEP_SESSIONS, session_dir);
    }
    logs::rotate_runtime_logs(&game_dir, logs::RUNTIME_LOG_ROTATE_BYTES);

    {
        // Off the Play path: walking the whole game folder must not delay the game starting.
        let (exe_path, game_dir, session_dir) = (exe_path.clone(), game_dir.clone(), session_dir.to_path_buf());
        let (exe_hash, runtime_hash) = (executable_sha256.clone(), runtime_sha256.clone());
        std::thread::spawn(move || write_game_files_listing(&exe_path, &game_dir, &session_dir, &exe_hash, &runtime_hash));
    }
    // Other launchers leave endpoints pointing at a local proxy in the game's user config; remove them before the game
    // reads it (a backup of each changed file is kept beside it).
    for changed in crate::launch::config_repair::repair_game_config() {
        logs::append_launcher_log(session_dir, &format!("removed leftover local-proxy settings from {changed}"));
    }
    // Brand-new or reset installs never accepted the game's built-in ToS, which stalls the stock login screen on an
    // invisible EULA page forever under our auto-login. Bring the saved version up to date before the game reads it.
    if let Some(changed) = crate::launch::tos_accept::ensure_accepted() {
        logs::append_launcher_log(session_dir, &format!("accepted the game's Terms of Service in {changed}"));
    }
    spawn_network_check(session_dir.to_path_buf());

    // Diagnostic flags only (VERBOSE_DIAG.flag) — not the actual access control (that's
    // fully server-side; see the channel check above and testerFeatures.ts). A failure here
    // is logged but doesn't block Play.
    if let Err(error) = flags::reconcile(&game_dir, &policy.managed_feature_ids) {
        logs::append_launcher_log(session_dir, &format!("flag reconcile failed: {error}"));
    }

    let client = http_client()?;
    let base = api_base_url();

    let status_response = retry::send(retry::Kind::Read, || client.get(format!("{base}/launcher/v1/status")))
        .map_err(|_| "Couldn't reach the Ramsgate Reborn game server.".to_string())?;
    if !status_response.status().is_success() {
        return Err(safe_api_error(
            status_response,
            "Couldn't read the supported game build.",
        ));
    }
    let status: ServerStatus = status_response
        .json()
        .map_err(|_| "The game server returned an invalid build response.".to_string())?;

    let ticket_response = retry::send(retry::Kind::Write, || {
        client
            .post(format!("{base}/launcher/v1/game-sessions"))
            .bearer_auth(&refreshed.access_token)
            .json(&GameSessionRequest {
                build_changelist: status.supported_build_changelist,
                executable_sha256: &executable_sha256,
                runtime_channel: &expected_channel,
                runtime_sha256: &runtime_sha256,
            })
    })
    .map_err(|_| "Couldn't request a game session.".to_string())?;
    if !ticket_response.status().is_success() {
        return Err(safe_api_error(
            ticket_response,
            "Couldn't request a game session.",
        ));
    }
    let ticket: GameSessionResponse = ticket_response
        .json()
        .map_err(|_| "The game server returned an invalid launch response.".to_string())?;

    let metadata = SessionMetadata {
        launch_session_id: launch_session_id.to_string(),
        started_at: logs::iso8601_now(),
        account_id: refreshed.account.user_id.clone(),
        display_name: refreshed.account.display_name.clone(),
        game_exe_path: exe_path.to_string_lossy().into_owned(),
        channel: policy.channel,
        exit_code: None,
        exited_at: None,
    };
    logs::write_metadata(session_dir, &metadata);

    process::spawn_game(
        &exe_path,
        &ticket.exchange_code,
        &LaunchIdentity {
            account_id: refreshed.account.user_id,
            display_name: refreshed.account.display_name,
        },
        session_dir,
        metadata,
    )
}

/// Writes a compact listing of the installed game (every file outside Content, plus the paks and a per-folder total for
/// the rest) and the runtime file hashes into the session folder, so a broken install can be compared with a good one.
/// Best effort: a failure here never blocks Play.
fn write_game_files_listing(
    exe_path: &std::path::Path,
    game_dir: &std::path::Path,
    session_dir: &std::path::Path,
    exe_hash: &str,
    runtime_hash: &str,
) {
    use std::fmt::Write as _;
    use std::path::Path;

    fn walk(root: &Path, dir: &Path, out: &mut String, content_totals: &mut std::collections::BTreeMap<String, (u64, u64)>) {
        let Ok(entries) = std::fs::read_dir(dir) else { return };
        for entry in entries.flatten() {
            let path = entry.path();
            let Ok(meta) = entry.metadata() else { continue };
            if meta.is_dir() {
                walk(root, &path, out, content_totals);
                continue;
            }
            let rel = path.strip_prefix(root).unwrap_or(&path).to_string_lossy().replace('\\', "/");
            let in_content = rel.contains("/Content/") && !rel.contains("/Paks/");
            if in_content {
                let folder = rel.rsplit_once('/').map(|(a, _)| a.to_string()).unwrap_or_default();
                let total = content_totals.entry(folder).or_insert((0, 0));
                total.0 += 1;
                total.1 += meta.len();
            } else {
                let _ = writeln!(out, "{}	{}", meta.len(), rel);
            }
        }
    }

    let root = exe_path.ancestors().nth(5).unwrap_or(game_dir);
    let mut out = String::new();
    let winmm = verify::hash_file_sha256(&game_dir.join("winmm.dll")).unwrap_or_else(|e| format!("unreadable: {e}"));
    let _ = writeln!(out, "sha256 winmm.dll {winmm}");
    let _ = writeln!(out, "sha256 {RUNTIME_DLL_NAME} {runtime_hash}");
    let _ = writeln!(out, "sha256 Dauntless-Win64-Shipping.exe {exe_hash}");
    let mut totals = std::collections::BTreeMap::new();
    walk(root, root, &mut out, &mut totals);
    for (folder, (count, bytes)) in totals {
        let _ = writeln!(out, "folder	{count} files	{bytes}	{folder}");
    }
    let _ = std::fs::write(session_dir.join("runtime-game-files.log"), out);
}

/// Runs a short connectivity check from this PC in the background (names resolved, our server and the real Epic hosts
/// reached, with timings) and writes it beside the other session logs. Best effort; it never delays Play.
fn spawn_network_check(session_dir: std::path::PathBuf) {
    std::thread::spawn(move || {
        use std::fmt::Write as _;
        use std::net::ToSocketAddrs;
        use std::time::Instant;

        let mut out = String::new();
        let base = api_base_url();
        let host = base.trim_start_matches("https://").trim_start_matches("http://").split('/').next().unwrap_or("").to_string();
        let _ = writeln!(out, "launcher {}", env!("CARGO_PKG_VERSION"));
        for key in ["HTTPS_PROXY", "HTTP_PROXY", "ALL_PROXY", "NO_PROXY"] {
            if let Ok(value) = std::env::var(key) {
                let _ = writeln!(out, "env {key}={value}");
            }
        }
        for name in [host.as_str(), "api.epicgames.dev", "account-public-service-prod03.ol.epicgames.com"] {
            let started = Instant::now();
            let result = (name, 443u16).to_socket_addrs().map(|a| a.map(|x| x.to_string()).collect::<Vec<_>>().join(" "));
            let _ = writeln!(out, "dns {name}: {:?} ({} ms)", result, started.elapsed().as_millis());
        }
        let Ok(client) = http_client() else { return };
        let targets = [
            format!("{base}/launcher/v1/status"),
            format!("{base}/__origin/gamesession-prod.steelyard.ca/features/platform/win"),
            format!("{base}/__origin/account-public-service-prod03.ol.epicgames.com/account/api/oauth/verify"),
            "https://api.epicgames.dev/".to_string(),
            "https://account-public-service-prod03.ol.epicgames.com/".to_string(),
        ];
        for url in targets {
            let started = Instant::now();
            let result = match client.get(&url).send() {
                Ok(response) => format!("HTTP {}", response.status().as_u16()),
                Err(error) => format!("ERROR {error}"),
            };
            let _ = writeln!(out, "get {url} -> {result} ({} ms)", started.elapsed().as_millis());
        }
        // A WebSocket upgrade the way the game's realtime connection does it, to see whether something on this PC or its
        // network interferes with it.
        for path in ["/", "/__ws/xmpp"] {
            let started = Instant::now();
            let result = match client
                .get(format!("{base}{path}"))
                .header("Connection", "Upgrade")
                .header("Upgrade", "websocket")
                .header("Sec-WebSocket-Version", "13")
                .header("Sec-WebSocket-Key", "dGhlIHNhbXBsZSBub25jZQ==")
                .header("Sec-WebSocket-Protocol", "xmpp")
                .send()
            {
                Ok(response) => format!("HTTP {}", response.status().as_u16()),
                Err(error) => format!("ERROR {error}"),
            };
            let _ = writeln!(out, "websocket {path} -> {result} ({} ms)", started.elapsed().as_millis());
        }
        let _ = std::fs::write(session_dir.join("runtime-network-check.log"), &out);

        let _ = std::fs::write(session_dir.join("runtime-network-check.log"), out);
    });
}

#[cfg(test)]
mod early_failure_tests {
    use super::*;

    #[test]
    fn connection_failures_are_recognised() {
        for m in [
            "Couldn't reach the Ramsgate Reborn game server.",
            "Can't reach the Ramsgate Reborn server right now.",
            "Couldn't verify your account access. Check your connection and try again.",
            "Couldn't request a game session.",
        ] {
            assert!(is_unreachable_message(m), "{m}");
        }
        assert!(!is_unreachable_message(MISSING_GAME_MESSAGE));
        assert!(!is_unreachable_message("Dauntless is already running."));
    }

    #[test]
    fn a_failed_launch_leaves_a_log_and_a_marker() {
        let dir = std::env::temp_dir().join(format!("rr-launch-fail-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        record_launch_failure(&dir, MISSING_GAME_MESSAGE);
        assert!(dir.join(LAUNCH_FAILED_MARKER).is_file());
        let log = std::fs::read_to_string(dir.join("launcher.log")).unwrap();
        assert!(log.contains("launch stopped"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_missing_game_text_is_plain_and_points_at_the_folder_choice() {
        assert!(MISSING_GAME_MESSAGE.contains("Choose the folder"));
    }
}
