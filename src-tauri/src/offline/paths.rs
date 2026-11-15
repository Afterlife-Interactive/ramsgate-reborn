// RR-38 offline mode: where the offline half keeps its files. Everything is under
// %LOCALAPPDATA%\RamsgateReborn\offline, a different folder from the online session logs
// (%LOCALAPPDATA%\RamsgateReborn\Logs\Sessions) and from the online game install. The offline save lives in there too:
// it is a separate local save made on this PC, not a copy of the online account.

use std::path::{Component, Path, PathBuf};
use tauri::{AppHandle, Manager};

pub const OFFLINE_GAME_EXE: &str = "Dauntless-Win64-Shipping.exe";

pub fn offline_root(app: &AppHandle) -> Result<PathBuf, String> {
    let base = app
        .path()
        .local_data_dir()
        .map_err(|e| format!("Couldn't locate the offline folder: {e}"))?;
    Ok(offline_root_under(&base))
}

pub fn offline_root_under(local_data_dir: &Path) -> PathBuf {
    local_data_dir.join("RamsgateReborn").join("offline")
}

/// A path as a plain `C:\...` string. Tauri's resource folder comes back in the `\\?\C:\...` form, which Windows
/// PowerShell's Join-Path cannot handle (it fails with a "drive" error), so nothing handed to a script keeps it.
pub fn plain(p: &Path) -> String {
    let s = dunce::simplified(p).to_string_lossy().to_string();
    match s.strip_prefix(r"\\?\UNC\") {
        Some(rest) => format!(r"\\{rest}"),
        None => s,
    }
}

/// The folder the launcher's separate download command saves the player's online save copy into. It sits next to the offline
/// folder, not inside it. The offline half only ever reads one file from it, by name, when the player asks to load it.
pub fn online_save_downloads_under(local_data_dir: &Path) -> PathBuf {
    local_data_dir.join("RamsgateReborn").join("online-save-downloads")
}

/// `online-save-<digits>.rrsave` and nothing else: no path parts, no other names.
pub fn is_saved_copy_name(name: &str) -> bool {
    let Some(rest) = name.strip_prefix("online-save-") else { return false };
    let Some(digits) = rest.strip_suffix(".rrsave") else { return false };
    !digits.is_empty() && digits.len() <= 20 && digits.bytes().all(|b| b.is_ascii_digit())
}

pub fn logs_dir(root: &Path) -> PathBuf {
    root.join("logs")
}

pub fn rates_file(root: &Path) -> PathBuf {
    root.join("rates.json")
}

pub fn offline_env_file(root: &Path) -> PathBuf {
    root.join("offline.env")
}

pub fn offline_game_exe(root: &Path) -> PathBuf {
    root.join("game")
        .join("Dauntless")
        .join("Archon")
        .join("Binaries")
        .join("Win64")
        .join(OFFLINE_GAME_EXE)
}

pub fn bin_dir(root: &Path) -> PathBuf {
    root.join("bin")
}

/// Written when the one-time offline install finished (game folder, local profile and servers all worked once).
pub fn install_ok_file(root: &Path) -> PathBuf {
    root.join("install.ok")
}

/// Written while an install runs, so the launcher can show one progress state.
pub fn install_state_file(root: &Path) -> PathBuf {
    root.join("install-state.json")
}

/// The offline component (RamsgateRebornOffline.dll, bundle\, mongod.exe, game-data\) next to the offline folder's own
/// copy, or shipped with the launcher.
pub fn local_component_dir(root: &Path) -> PathBuf {
    root.join("component")
}

/// True when `child` is `parent` or inside it, compared by path components after removing `.`/`..` lexically and
/// ignoring ASCII case (Windows paths). No file system access.
pub fn is_within(child: &Path, parent: &Path) -> bool {
    let c = normalize(child);
    let p = normalize(parent);
    if p.is_empty() || c.len() < p.len() {
        return false;
    }
    c.iter().zip(p.iter()).all(|(a, b)| a.eq_ignore_ascii_case(b))
}

fn normalize(path: &Path) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for comp in path.components() {
        match comp {
            Component::CurDir => {}
            Component::ParentDir => {
                out.pop();
            }
            Component::Prefix(p) => out.push(p.as_os_str().to_string_lossy().to_string()),
            Component::RootDir => out.push("\\".to_string()),
            Component::Normal(n) => out.push(n.to_string_lossy().to_string()),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn layout_is_under_one_offline_folder() {
        let root = offline_root_under(Path::new(r"C:\Users\p\AppData\Local"));
        assert!(root.ends_with(r"RamsgateReborn\offline"));
        for p in [logs_dir(&root), install_ok_file(&root), install_state_file(&root), local_component_dir(&root), rates_file(&root), offline_game_exe(&root), bin_dir(&root)] {
            assert!(is_within(&p, &root), "{p:?}");
        }
        // The online session logs are a sibling folder, never inside the offline one and vice versa.
        let online = Path::new(r"C:\Users\p\AppData\Local\RamsgateReborn\Logs\Sessions");
        assert!(!is_within(online, &root));
        assert!(!is_within(&root, online));
    }

    #[test]
    fn plain_drops_the_verbatim_prefix() {
        assert_eq!(plain(Path::new(r"\\?\C:\Program Files\Ramsgate\resources\offline-component")), r"C:\Program Files\Ramsgate\resources\offline-component");
        assert_eq!(plain(Path::new(r"C:\Ramsgate Reborn\Game")), r"C:\Ramsgate Reborn\Game");
        assert_eq!(plain(Path::new(r"\\?\UNC\srv\share\x")), r"\\srv\share\x");
    }

    #[test]
    fn is_within_handles_dots_and_case() {
        let root = Path::new(r"C:\X\RamsgateReborn\offline");
        assert!(is_within(Path::new(r"c:\x\ramsgatereborn\OFFLINE\logs\a.log"), root));
        assert!(!is_within(Path::new(r"C:\X\RamsgateReborn\offline\..\Logs\Sessions\abc"), root));
        assert!(!is_within(Path::new(r"C:\X\RamsgateReborn\offline-other"), root));
    }
}
