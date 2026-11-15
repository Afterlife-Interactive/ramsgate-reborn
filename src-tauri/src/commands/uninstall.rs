//! Uninstall of the downloaded game, from the Game files tab. Local deletion only: no network code here.
//! Keeps the launcher's settings, saved logins/keys and the offline data; launcher logs go only when asked.

use serde::Serialize;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{AppHandle, Emitter, Manager};

use crate::commands::game;
use crate::install::{paths, uninstall};
use crate::launch::{logs, process};
use crate::offline::paths as offline_paths;

const PROGRESS_EVENT: &str = "game-uninstall-progress";
static RUNNING: AtomicBool = AtomicBool::new(false);

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UninstallPreview {
    pub can_uninstall: bool,
    /// Why not, in plain words, when `can_uninstall` is false.
    pub reason: Option<String>,
    pub path: Option<String>,
    pub bytes: u64,
    pub files: u64,
    pub logs_bytes: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UninstallResult {
    pub path: String,
    pub files: u64,
    pub bytes: u64,
    pub logs_deleted: bool,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct Progress {
    phase: &'static str,
    done: u64,
    total: u64,
}

fn emit(app: &AppHandle, phase: &'static str, done: u64, total: u64) {
    let _ = app.emit(PROGRESS_EVENT, Progress { phase, done, total });
}

fn build_guard(app: &AppHandle) -> uninstall::Guard {
    let mut contain: Vec<PathBuf> = Vec::new();
    let mut inside: Vec<PathBuf> = Vec::new();
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            contain.push(dir.to_path_buf());
            inside.push(dir.to_path_buf());
        }
    }
    let path = app.path();
    for dir in [path.app_config_dir(), path.app_data_dir(), path.app_local_data_dir(), path.local_data_dir(), path.data_dir(), path.config_dir(), path.home_dir(), path.temp_dir(), path.resource_dir()]
        .into_iter()
        .flatten()
    {
        contain.push(dir);
    }
    if let Ok(dir) = path.app_config_dir() {
        inside.push(dir);
    }
    if let Ok(root) = offline_paths::offline_root(app) {
        contain.push(root.clone());
        inside.push(root);
    }
    if let Ok(root) = logs::sessions_root(app) {
        contain.push(root.clone());
        inside.push(root);
    }
    uninstall::Guard { must_not_contain: contain, must_not_be_inside: inside, require_managed_layout: true }
}

/// The recorded install folder, checked by the guard. Errors say why nothing may be deleted.
fn resolve_target(app: &AppHandle) -> Result<PathBuf, String> {
    let exe = paths::load_saved_exe_path(app).ok_or_else(|| "No game install is recorded.".to_string())?;
    let dir = paths::load_install_dir(app)
        .or_else(|| uninstall::derive_managed_dir(&exe))
        .ok_or_else(|| "This game was located by hand rather than downloaded by the launcher, so the launcher won't delete it. Remove that folder yourself.".to_string())?;
    uninstall::validate_target(&dir, Some(&exe), &build_guard(app))
}

fn check_closed(target: &std::path::Path) -> Result<(), String> {
    if game::RUNNING.load(Ordering::SeqCst) {
        return Err("A game download is running. Wait for it to finish first.".to_string());
    }
    uninstall::ensure_not_running(process::launched_game_state(), process::is_dauntless_process_running_from(target))
}

fn logs_size(app: &AppHandle) -> u64 {
    let Ok(sessions) = logs::sessions_root(app) else { return 0 };
    let Ok(offline) = offline_paths::offline_root(app) else { return 0 };
    if uninstall::validate_logs_dir(&sessions, &offline).is_err() || !sessions.is_dir() {
        return 0;
    }
    uninstall::measure(&sessions).map(|t| t.bytes).unwrap_or(0)
}

fn preview_blocking(app: &AppHandle) -> UninstallPreview {
    let refused = |reason: String, path: Option<String>| UninstallPreview { can_uninstall: false, reason: Some(reason), path, bytes: 0, files: 0, logs_bytes: 0 };
    let target = match resolve_target(app) {
        Ok(t) => t,
        Err(reason) => return refused(reason, None),
    };
    let shown = Some(target.display().to_string());
    if let Err(reason) = check_closed(&target) {
        return refused(reason, shown);
    }
    match uninstall::measure(&target) {
        Ok(size) => UninstallPreview { can_uninstall: true, reason: None, path: shown, bytes: size.bytes, files: size.files, logs_bytes: logs_size(app) },
        Err(reason) => refused(reason, shown),
    }
}

/// Where the game is, how big it is and whether it may be deleted now. Nothing is changed.
#[tauri::command]
pub async fn uninstall_preview(app: AppHandle) -> Result<UninstallPreview, String> {
    tauri::async_runtime::spawn_blocking(move || preview_blocking(&app)).await.map_err(|_| "The size check stopped unexpectedly.".to_string())
}

fn uninstall_blocking(app: &AppHandle, delete_logs: bool) -> Result<UninstallResult, String> {
    // Everything is checked again here, right before deleting; the earlier preview proves nothing.
    let target = resolve_target(app)?;
    check_closed(&target)?;
    let total = uninstall::measure(&target)?.files;
    emit(app, "removing", 0, total);
    let removed = uninstall::remove_tree(&target, &mut |done| emit(app, "removing", done, total));

    // The game is gone (or partly gone): whatever happened, do not leave a record that points into the folder.
    // A partial delete keeps the record so the player can run the uninstall again.
    let removed = match removed {
        Ok(r) => r,
        Err(e) => return Err(format!("{e} Some files may be left; run Uninstall again after closing anything that uses them.")),
    };
    paths::clear_install(app).map_err(|e| format!("The game files are deleted, but the launcher couldn't clear its record: {e}"))?;

    let mut logs_deleted = false;
    if delete_logs {
        emit(app, "logs", 0, 0);
        let sessions = logs::sessions_root(app)?;
        let offline = offline_paths::offline_root(app)?;
        uninstall::validate_logs_dir(&sessions, &offline)?;
        if sessions.is_dir() {
            uninstall::remove_tree(&sessions, &mut |_| {}).map_err(|e| format!("The game is uninstalled, but the logs weren't all deleted: {e}"))?;
        }
        logs_deleted = true;
    }
    emit(app, "done", removed.files, total);
    Ok(UninstallResult { path: target.display().to_string(), files: removed.files, bytes: removed.bytes, logs_deleted })
}

/// Deletes the launcher-installed game folder. Runs off the UI thread and reports `game-uninstall-progress`.
#[tauri::command]
pub async fn uninstall_game(app: AppHandle, delete_logs: bool) -> Result<UninstallResult, String> {
    if RUNNING.swap(true, Ordering::SeqCst) {
        return Err("An uninstall is already running.".to_string());
    }
    let result = tauri::async_runtime::spawn_blocking(move || uninstall_blocking(&app, delete_logs))
        .await
        .map_err(|_| "The uninstall stopped unexpectedly.".to_string())
        .and_then(|inner| inner);
    RUNNING.store(false, Ordering::SeqCst);
    result
}
