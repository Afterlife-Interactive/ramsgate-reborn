use serde::Serialize;
use tauri::AppHandle;
use tauri_plugin_dialog::DialogExt;

use crate::install::{paths, verify};

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct InstallStatus {
    pub located: bool,
    pub exe_path: Option<String>,
    pub exe_sha256: Option<String>,
    /// Set whenever something about a located installation is wrong (missing
    /// DLLs, unreadable exe, etc.) — `located` can be true with an error set,
    /// meaning "we found something at the saved path, but it's not usable."
    pub error: Option<String>,
    /// A game location was saved earlier but the game file is no longer there (moved, deleted, drive gone). The
    /// launcher then asks the player to pick the folder again.
    pub saved_missing: bool,
}

/// What the saved game location points at right now.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) enum SavedGame {
    NothingSaved,
    Missing,
    Present,
}

pub(crate) fn saved_game_state(saved: Option<&std::path::Path>) -> SavedGame {
    match saved {
        None => SavedGame::NothingSaved,
        Some(path) if path.is_file() => SavedGame::Present,
        Some(_) => SavedGame::Missing,
    }
}

fn not_located() -> InstallStatus {
    InstallStatus {
        located: false,
        exe_path: None,
        exe_sha256: None,
        error: None,
        saved_missing: false,
    }
}

fn build_status(exe_path: &std::path::Path) -> InstallStatus {
    let exe_path_string = exe_path.display().to_string();

    let game_dir = match paths::game_dir(exe_path) {
        Ok(d) => d,
        Err(e) => {
            return InstallStatus {
                located: true,
                exe_path: Some(exe_path_string),
                exe_sha256: None,
                error: Some(e),
                saved_missing: false,
            }
        }
    };

    if let Err(e) = verify::verify_runtime_dlls_present(&game_dir) {
        return InstallStatus {
            located: true,
            exe_path: Some(exe_path_string),
            exe_sha256: None,
            error: Some(e),
            saved_missing: false,
        };
    }

    match verify::hash_file_sha256(exe_path) {
        Ok(hash) => InstallStatus {
            located: true,
            exe_path: Some(exe_path_string),
            exe_sha256: Some(hash),
            error: None,
            saved_missing: false,
        },
        Err(e) => InstallStatus {
            located: true,
            exe_path: Some(exe_path_string),
            exe_sha256: None,
            error: Some(e),
            saved_missing: false,
        },
    }
}

#[tauri::command]
pub fn get_install_status(app: AppHandle) -> InstallStatus {
    let saved = paths::load_saved_exe_path(&app);
    match (saved_game_state(saved.as_deref()), saved) {
        (SavedGame::Present, Some(exe_path)) => build_status(&exe_path),
        (SavedGame::Missing, _) => InstallStatus { saved_missing: true, ..not_located() },
        _ => not_located(),
    }
}

#[tauri::command]
pub async fn pick_install_path(app: AppHandle) -> Result<InstallStatus, String> {
    // File dialogs block the calling thread until the user responds — run it
    // on a blocking-friendly task so it doesn't stall the async runtime.
    let dialog_app = app.clone();
    let picked = tauri::async_runtime::spawn_blocking(move || {
        dialog_app
            .dialog()
            .file()
            .set_title("Select your Dauntless installation folder")
            .blocking_pick_folder()
    })
    .await
    .map_err(|e| e.to_string())?;

    let Some(file_path) = picked else {
        // User cancelled the dialog — not an error, just report whatever was
        // already saved (or "not located" if nothing was).
        return Ok(get_install_status(app));
    };

    let selected_folder = file_path.into_path().map_err(|e| e.to_string())?;
    let canonical = paths::find_game_executable(&selected_folder)?;

    paths::save_exe_path(&app, &canonical)?;

    Ok(build_status(&canonical))
}

/// Folders where an existing Dauntless install is usually found, below each fixed drive. Only these exact folders are
/// looked at (plus the two levels the normal folder pick already searches); nothing walks the drive.
const USUAL_INSTALL_FOLDERS: [&str; 8] = [
    r"Program Files (x86)\Steam\steamapps\common\Dauntless",
    r"Program Files\Steam\steamapps\common\Dauntless",
    r"SteamLibrary\steamapps\common\Dauntless",
    r"Steam\steamapps\common\Dauntless",
    r"Program Files\Epic Games\Dauntless",
    r"Epic Games\Dauntless",
    r"Games\Dauntless",
    r"Dauntless",
];

/// Read-only look at the usual folders. Returns the game folder and its executable, or None.
fn probe_existing_install() -> Option<(std::path::PathBuf, std::path::PathBuf)> {
    for (root, _) in crate::commands::game::fixed_drives_by_free_space() {
        for rel in USUAL_INSTALL_FOLDERS {
            let folder = root.join(rel);
            if !folder.is_dir() {
                continue;
            }
            if let Ok(exe) = paths::find_game_executable(&folder) {
                return Some((folder, exe));
            }
        }
    }
    None
}

/// Tells the UI where an existing install seems to be, so it can ask the player. Changes nothing.
#[tauri::command]
pub async fn find_existing_install() -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(|| probe_existing_install().map(|(folder, _)| folder.display().to_string()))
        .await
        .map_err(|_| "The task stopped unexpectedly.".to_string())
}

/// Called only after the player says yes. Looks again instead of trusting a path from the UI, then saves it.
#[tauri::command]
pub async fn use_existing_install(app: AppHandle) -> Result<InstallStatus, String> {
    let found = tauri::async_runtime::spawn_blocking(probe_existing_install)
        .await
        .map_err(|_| "The task stopped unexpectedly.".to_string())?;
    let Some((_, exe)) = found else {
        return Ok(get_install_status(app));
    };
    paths::save_exe_path(&app, &exe)?;
    Ok(build_status(&exe))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(tag: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("rr-install-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn no_saved_location_is_not_a_missing_game() {
        assert_eq!(saved_game_state(None), SavedGame::NothingSaved);
    }

    #[test]
    fn a_saved_file_that_exists_is_present() {
        let dir = scratch("present");
        let exe = dir.join("game.exe");
        std::fs::write(&exe, b"x").unwrap();
        assert_eq!(saved_game_state(Some(&exe)), SavedGame::Present);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_saved_file_that_is_gone_is_missing() {
        let dir = scratch("gone");
        assert_eq!(saved_game_state(Some(&dir.join("game.exe"))), SavedGame::Missing);
        // A folder where the file should be does not count as the game either.
        assert_eq!(saved_game_state(Some(&dir)), SavedGame::Missing);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_missing_game_asks_to_be_located_again() {
        let status = InstallStatus { saved_missing: true, ..not_located() };
        assert!(!status.located && status.saved_missing && status.error.is_none());
    }
}
