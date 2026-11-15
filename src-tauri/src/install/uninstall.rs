//! Uninstall of the game the launcher downloaded. Local file deletion only: nothing in here talks to a network, and it
//! only ever removes one folder, the install folder the launcher itself created (`<drive>:\Ramsgate Reborn\Game`).
//!
//! The path guard (`validate_target`) is the single gate in front of the delete. It refuses anything that is not
//! exactly the recorded install folder, reached without any link on the way, that is not a drive root, that holds
//! the launcher's own program, data or config folders, or that is not the launcher-made layout.

use std::fs;
use std::os::windows::fs::MetadataExt;
use std::path::{Component, Path, PathBuf};
use std::time::{Duration, Instant};

use crate::launch::process::LaunchedGameState;
use crate::offline::paths::is_within;

const FILE_ATTRIBUTE_READONLY: u32 = 0x1;
const FILE_ATTRIBUTE_DIRECTORY: u32 = 0x10;
/// Symbolic links and junctions both carry this flag.
const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;

/// The two folder names the launcher creates below a drive root for the game it downloads.
pub const MANAGED_FOLDERS: [&str; 2] = ["Ramsgate Reborn", "Game"];

/// What the delete must stay away from.
pub struct Guard {
    /// Folders the target may neither be nor contain (the launcher's program folder, data, config, logs, offline data,
    /// the user's profile): a target at or above any of them is refused.
    pub must_not_contain: Vec<PathBuf>,
    /// Folders the target may not be at or inside of (the launcher's program folder, config and offline data).
    pub must_not_be_inside: Vec<PathBuf>,
    /// Require the launcher-made layout `<drive>:\Ramsgate Reborn\Game`. Always true outside the tests of the other rules.
    pub require_managed_layout: bool,
}

fn plain(path: &Path) -> PathBuf {
    dunce::simplified(path).to_path_buf()
}

fn has_wildcard(path: &Path) -> bool {
    // `?` in the verbatim prefix is not a wildcard, so look at the plain form.
    plain(path).to_string_lossy().chars().any(|c| matches!(c, '*' | '?' | '"' | '<' | '>' | '|'))
}

fn is_reparse(meta: &fs::Metadata) -> bool {
    meta.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
}

fn normal_names(path: &Path) -> Vec<String> {
    path.components()
        .filter_map(|c| match c {
            Component::Normal(n) => Some(n.to_string_lossy().to_string()),
            _ => None,
        })
        .collect()
}

/// `<drive>:\Ramsgate Reborn\Game` and nothing else (a plain local drive, exactly two folders deep).
pub fn has_managed_layout(path: &Path) -> bool {
    let path = plain(path);
    let mut parts = path.components();
    let drive = matches!(parts.next(), Some(Component::Prefix(p)) if matches!(p.kind(), std::path::Prefix::Disk(_)));
    let root = matches!(parts.next(), Some(Component::RootDir));
    if !drive || !root {
        return false;
    }
    let names: Vec<String> = parts
        .filter_map(|c| match c {
            Component::Normal(n) => Some(n.to_string_lossy().to_string()),
            _ => None,
        })
        .collect();
    names.len() == 2 && names.iter().zip(MANAGED_FOLDERS.iter()).all(|(a, b)| a.eq_ignore_ascii_case(b))
}

/// The managed install folder an older launcher recorded only as an exe path: the exe has to sit inside
/// `<drive>:\Ramsgate Reborn\Game`.
pub fn derive_managed_dir(exe: &Path) -> Option<PathBuf> {
    let exe = plain(exe);
    exe.ancestors().find(|a| has_managed_layout(a)).map(Path::to_path_buf)
}

/// Returns the canonical folder that may be deleted, or says why it may not.
pub fn validate_target(recorded: &Path, exe: Option<&Path>, guard: &Guard) -> Result<PathBuf, String> {
    let refuse = |why: &str| Err(format!("The launcher won't delete this folder: {why}"));
    let recorded = plain(recorded);

    if has_wildcard(&recorded) {
        return refuse("the path contains wildcard characters.");
    }
    if recorded.components().any(|c| matches!(c, Component::ParentDir | Component::CurDir)) {
        return refuse("the path is not written out in full.");
    }
    match recorded.components().next() {
        Some(Component::Prefix(p)) if matches!(p.kind(), std::path::Prefix::Disk(_)) => {}
        _ => return refuse("it is not on a local drive."),
    }
    if normal_names(&recorded).is_empty() {
        return refuse("that is a whole drive.");
    }
    if guard.require_managed_layout && !has_managed_layout(&recorded) {
        return refuse("it is not the folder the launcher installs the game into.");
    }

    let meta = match fs::symlink_metadata(&recorded) {
        Ok(m) => m,
        Err(_) => return refuse("the folder does not exist."),
    };
    if is_reparse(&meta) {
        return refuse("it is a link to another folder.");
    }
    if !meta.is_dir() {
        return refuse("it is not a folder.");
    }

    // A junction or symbolic link anywhere on the way resolves to a different place, so the canonical path stops
    // matching what was recorded (and 8.3 short names or a changed drive mapping are refused the same way).
    let canonical = dunce::canonicalize(&recorded).map_err(|_| "The launcher won't delete this folder: it can't be resolved.".to_string())?;
    if !is_within(&canonical, &recorded) || !is_within(&recorded, &canonical) {
        return refuse("a link on the way leads somewhere else.");
    }
    if normal_names(&canonical).is_empty() {
        return refuse("that is a whole drive.");
    }

    for protected in &guard.must_not_contain {
        let protected = plain(protected);
        let protected = dunce::canonicalize(&protected).unwrap_or(protected);
        if is_within(&protected, &canonical) {
            return refuse("it holds the launcher's own program or data.");
        }
    }
    for outer in &guard.must_not_be_inside {
        let outer = plain(outer);
        let outer = dunce::canonicalize(&outer).unwrap_or(outer);
        if is_within(&canonical, &outer) {
            return refuse("it is part of the launcher's own program or data.");
        }
    }

    if let Some(exe) = exe {
        if !is_within(&plain(exe), &canonical) {
            return refuse("the recorded game is not inside it.");
        }
    }
    Ok(canonical)
}

/// Fails closed: the game is only treated as closed when both the launcher's own process tracking and a scan of the
/// process list say so.
pub fn ensure_not_running(launched: LaunchedGameState, scan_from_folder: Result<bool, String>) -> Result<(), String> {
    if launched == LaunchedGameState::Running {
        return Err("Dauntless is running. Close the game first.".to_string());
    }
    match scan_from_folder {
        Ok(false) => Ok(()),
        Ok(true) => Err("Dauntless is running from this folder. Close the game first.".to_string()),
        Err(_) => Err("The launcher couldn't confirm that Dauntless is closed, so it won't delete anything.".to_string()),
    }
}

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct Tally {
    pub files: u64,
    pub bytes: u64,
}

/// Size of a folder, not following links (a link is counted as one entry and never entered).
pub fn measure(root: &Path) -> Result<Tally, String> {
    let mut tally = Tally::default();
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let entries = fs::read_dir(&dir).map_err(|e| format!("Couldn't read {}: {e}", dir.display()))?;
        for entry in entries.flatten() {
            let Ok(meta) = fs::symlink_metadata(entry.path()) else { continue };
            if is_reparse(&meta) {
                tally.files += 1;
            } else if meta.is_dir() {
                stack.push(entry.path());
            } else {
                tally.files += 1;
                tally.bytes += meta.len();
            }
        }
    }
    Ok(tally)
}

/// Deletes a folder and everything in it. Links inside are removed as links, never entered. Calls `on_progress` with
/// the number of files removed so far, at most about five times a second.
pub fn remove_tree(root: &Path, on_progress: &mut dyn FnMut(u64)) -> Result<Tally, String> {
    let mut removed = Tally::default();
    let mut dirs = vec![root.to_path_buf()];
    let mut stack = vec![root.to_path_buf()];
    let mut last = Instant::now();
    while let Some(dir) = stack.pop() {
        let entries = fs::read_dir(&dir).map_err(|e| format!("Couldn't read {}: {e}", dir.display()))?;
        for entry in entries.flatten() {
            let path = entry.path();
            let meta = fs::symlink_metadata(&path).map_err(|e| format!("Couldn't read {}: {e}", path.display()))?;
            if is_reparse(&meta) {
                let result = if meta.file_attributes() & FILE_ATTRIBUTE_DIRECTORY != 0 { fs::remove_dir(&path) } else { fs::remove_file(&path) };
                result.map_err(|e| format!("Couldn't remove {}: {e}", path.display()))?;
                removed.files += 1;
            } else if meta.is_dir() {
                dirs.push(path.clone());
                stack.push(path);
            } else {
                if meta.file_attributes() & FILE_ATTRIBUTE_READONLY != 0 {
                    let mut perms = meta.permissions();
                    #[allow(clippy::permissions_set_readonly_false)]
                    perms.set_readonly(false);
                    let _ = fs::set_permissions(&path, perms);
                }
                fs::remove_file(&path).map_err(|e| format!("Couldn't remove {}: {e}", path.display()))?;
                removed.files += 1;
                removed.bytes += meta.len();
            }
            if last.elapsed() >= Duration::from_millis(200) {
                on_progress(removed.files);
                last = Instant::now();
            }
        }
    }
    // Deepest folders first; the root is last.
    for dir in dirs.iter().rev() {
        fs::remove_dir(dir).map_err(|e| format!("Couldn't remove {}: {e}", dir.display()))?;
    }
    on_progress(removed.files);
    Ok(removed)
}

/// The launcher's online session logs (`...\RamsgateReborn\Logs\Sessions`) and nothing else. The offline folder is
/// never touched, and the folder must really be the sessions folder.
pub fn validate_logs_dir(sessions_root: &Path, offline_root: &Path) -> Result<(), String> {
    let names = normal_names(&plain(sessions_root));
    let n = names.len();
    let right_place = n >= 3 && names[n - 1].eq_ignore_ascii_case("Sessions") && names[n - 2].eq_ignore_ascii_case("Logs") && names[n - 3].eq_ignore_ascii_case("RamsgateReborn");
    if !right_place || has_wildcard(sessions_root) {
        return Err("The launcher won't delete this log folder: it is not the launcher's session log folder.".to_string());
    }
    if is_within(sessions_root, offline_root) || is_within(offline_root, sessions_root) {
        return Err("The launcher won't delete the logs: they overlap the offline data.".to_string());
    }
    if let Ok(meta) = fs::symlink_metadata(sessions_root) {
        if is_reparse(&meta) {
            return Err("The launcher won't delete this log folder: it is a link.".to_string());
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;

    fn scratch(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("rr-uninstall-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dunce::canonicalize(&dir).unwrap()
    }

    fn free_guard() -> Guard {
        Guard { must_not_contain: vec![], must_not_be_inside: vec![], require_managed_layout: false }
    }

    fn make_game(root: &Path) -> (PathBuf, PathBuf) {
        let game = root.join("Ramsgate Reborn").join("Game");
        let bin = game.join("Dauntless").join("Archon").join("Binaries").join("Win64");
        fs::create_dir_all(&bin).unwrap();
        let exe = bin.join("Dauntless-Win64-Shipping.exe");
        fs::write(&exe, b"exe").unwrap();
        (game, exe)
    }

    fn junction(link: &Path, target: &Path) -> bool {
        Command::new("cmd").args(["/C", "mklink", "/J"]).arg(link).arg(target).output().map(|o| o.status.success()).unwrap_or(false)
    }

    #[test]
    fn accepts_the_recorded_install_folder() {
        let root = scratch("ok");
        let (game, exe) = make_game(&root);
        assert_eq!(validate_target(&game, Some(&exe), &free_guard()).unwrap(), game);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn refuses_a_drive_root() {
        for root in [r"C:\", r"D:\", r"C:"] {
            assert!(validate_target(Path::new(root), None, &free_guard()).is_err(), "{root}");
        }
    }

    #[test]
    fn refuses_a_parent_of_the_launcher_folder_and_of_its_data() {
        let root = scratch("parent");
        let (game, _) = make_game(&root);
        let launcher = game.join("Launcher");
        fs::create_dir_all(&launcher).unwrap();
        let data = root.join("AppData");
        fs::create_dir_all(&data).unwrap();
        // The launcher lives inside the target: refused, as is the folder above the launcher.
        for contained in [launcher.clone(), launcher.join("launcher.exe"), game.clone()] {
            let guard = Guard { must_not_contain: vec![contained], ..free_guard() };
            assert!(validate_target(&game, None, &guard).is_err());
        }
        // A target that is an ancestor of the launcher's data/config folders is refused too.
        let guard = Guard { must_not_contain: vec![game.join("x").join("config")], ..free_guard() };
        assert!(validate_target(&game, None, &guard).is_err());
        // The folder above the target holds the launcher's data: refused when it is the target itself.
        let guard = Guard { must_not_contain: vec![data.clone()], ..free_guard() };
        assert!(validate_target(&root, None, &guard).is_err());
        // Unrelated launcher folders next to the game do not block it.
        let guard = Guard { must_not_contain: vec![data], ..free_guard() };
        assert!(validate_target(&game, None, &guard).is_ok());
        // The target inside the launcher's own folder is refused.
        let guard = Guard { must_not_be_inside: vec![root.join("Ramsgate Reborn")], ..free_guard() };
        assert!(validate_target(&game, None, &guard).is_err());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn refuses_a_folder_outside_the_recorded_layout_and_a_missing_one() {
        let root = scratch("outside");
        let (game, exe) = make_game(&root);
        let other = root.join("Documents");
        fs::create_dir_all(&other).unwrap();
        let strict = Guard { require_managed_layout: true, ..free_guard() };
        assert!(validate_target(&other, None, &strict).is_err());
        assert!(validate_target(&game, Some(&exe), &strict).is_err(), "a temp folder is not <drive>:\\Ramsgate Reborn\\Game");
        // The recorded game must be inside the folder.
        assert!(validate_target(&other, Some(&exe), &free_guard()).is_err());
        assert!(validate_target(&root.join("nothing"), None, &free_guard()).is_err());
        assert!(validate_target(&exe, None, &free_guard()).is_err(), "a file is not a folder");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn refuses_wildcards_dotdot_and_network_paths() {
        let root = scratch("syntax");
        let (game, _) = make_game(&root);
        assert!(validate_target(&root.join("Ramsgate Reborn").join("*"), None, &free_guard()).is_err());
        assert!(validate_target(&root.join("Ramsgate Reborn").join("Ga?e"), None, &free_guard()).is_err());
        assert!(validate_target(&game.join("..").join("Game"), None, &free_guard()).is_err());
        assert!(validate_target(Path::new(r"\\server\share\Ramsgate Reborn\Game"), None, &free_guard()).is_err());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn refuses_a_junction_as_the_target_and_on_the_way() {
        let root = scratch("junction");
        let (game, _) = make_game(&root);
        let elsewhere = root.join("Elsewhere");
        fs::create_dir_all(elsewhere.join("Ramsgate Reborn")).unwrap();
        // The recorded folder itself is a junction to a real folder.
        let link = root.join("Link");
        if !junction(&link, &game) {
            eprintln!("junction could not be created here; skipping");
            fs::remove_dir_all(root).unwrap();
            return;
        }
        assert!(validate_target(&link, None, &free_guard()).is_err());
        // A junction in the middle of the path: Link\Ramsgate Reborn\Game resolves into the real tree.
        assert!(validate_target(&link.join("Ramsgate Reborn").join("Game"), None, &free_guard()).is_err());
        // Removing the junction leaves what it pointed at.
        fs::remove_dir(&link).unwrap();
        assert!(game.is_dir());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn the_symbolic_link_case_is_refused_when_one_can_be_made() {
        let root = scratch("symlink");
        let (game, _) = make_game(&root);
        let link = root.join("SymGame");
        if std::os::windows::fs::symlink_dir(&game, &link).is_err() {
            eprintln!("symbolic links need a privilege this run lacks; skipping");
            fs::remove_dir_all(root).unwrap();
            return;
        }
        assert!(validate_target(&link, None, &free_guard()).is_err());
        fs::remove_dir(&link).unwrap();
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn a_running_game_blocks_the_delete_and_an_unknown_state_does_too() {
        assert!(ensure_not_running(LaunchedGameState::Running, Ok(false)).is_err());
        assert!(ensure_not_running(LaunchedGameState::None, Ok(true)).is_err());
        assert!(ensure_not_running(LaunchedGameState::Exited, Ok(true)).is_err());
        assert!(ensure_not_running(LaunchedGameState::None, Err("scan failed".into())).is_err());
        assert!(ensure_not_running(LaunchedGameState::None, Ok(false)).is_ok());
        assert!(ensure_not_running(LaunchedGameState::Exited, Ok(false)).is_ok());
    }

    #[test]
    fn the_launcher_made_layout_is_exactly_drive_ramsgate_reborn_game() {
        assert!(has_managed_layout(Path::new(r"D:\Ramsgate Reborn\Game")));
        assert!(has_managed_layout(Path::new(r"d:\ramsgate reborn\game")));
        assert!(has_managed_layout(Path::new(r"\\?\D:\Ramsgate Reborn\Game")));
        for bad in [r"D:\", r"D:\Game", r"D:\Ramsgate Reborn", r"D:\Ramsgate Reborn\Game\Dauntless", r"D:\Other\Ramsgate Reborn\Game", r"\\srv\share\Ramsgate Reborn\Game", r"D:Ramsgate Reborn\Game"] {
            assert!(!has_managed_layout(Path::new(bad)), "{bad}");
        }
        let exe = Path::new(r"E:\Ramsgate Reborn\Game\Dauntless\Archon\Binaries\Win64\Dauntless-Win64-Shipping.exe");
        assert_eq!(derive_managed_dir(exe).unwrap(), PathBuf::from(r"E:\Ramsgate Reborn\Game"));
        assert!(derive_managed_dir(Path::new(r"E:\Games\Dauntless\Archon\Binaries\Win64\Dauntless-Win64-Shipping.exe")).is_none());
    }

    #[test]
    fn measure_and_remove_delete_everything_and_count_it() {
        let root = scratch("remove");
        let (game, exe) = make_game(&root);
        fs::write(game.join("a.bin"), vec![0u8; 1000]).unwrap();
        fs::write(game.join("Dauntless").join("b.bin"), vec![0u8; 500]).unwrap();
        let ro = game.join("readonly.txt");
        fs::write(&ro, b"x").unwrap();
        let mut perms = fs::metadata(&ro).unwrap().permissions();
        perms.set_readonly(true);
        fs::set_permissions(&ro, perms).unwrap();
        let sibling = root.join("Ramsgate Reborn").join("keep.txt");
        fs::write(&sibling, b"keep").unwrap();

        let size = measure(&game).unwrap();
        assert_eq!(size.files, 4);
        assert_eq!(size.bytes, 3 + 1000 + 500 + 1);
        let mut last = 0;
        let removed = remove_tree(&game, &mut |n| last = n).unwrap();
        assert_eq!(removed, size);
        assert_eq!(last, 4);
        assert!(!game.exists());
        assert!(!exe.exists());
        assert!(sibling.is_file(), "files next to the game folder stay");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn a_link_inside_the_folder_is_removed_without_touching_its_target() {
        let root = scratch("inner");
        let (game, _) = make_game(&root);
        let outside = root.join("Precious");
        fs::create_dir_all(&outside).unwrap();
        fs::write(outside.join("save.dat"), b"keep me").unwrap();
        if !junction(&game.join("Saved"), &outside) {
            eprintln!("junction could not be created here; skipping");
            fs::remove_dir_all(root).unwrap();
            return;
        }
        let size = measure(&game).unwrap();
        assert_eq!(size.bytes, 3, "the link is not followed when measuring");
        remove_tree(&game, &mut |_| {}).unwrap();
        assert!(!game.exists());
        assert_eq!(fs::read(outside.join("save.dat")).unwrap(), b"keep me");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn the_log_folder_check_accepts_only_the_sessions_folder_and_never_offline_data() {
        let local = Path::new(r"C:\Users\p\AppData\Local");
        let offline = local.join("RamsgateReborn").join("offline");
        let sessions = local.join("RamsgateReborn").join("Logs").join("Sessions");
        assert!(validate_logs_dir(&sessions, &offline).is_ok());
        assert!(validate_logs_dir(local, &offline).is_err());
        assert!(validate_logs_dir(&local.join("RamsgateReborn"), &offline).is_err());
        assert!(validate_logs_dir(&offline.join("logs"), &offline).is_err());
        assert!(validate_logs_dir(&offline.join("Logs").join("Sessions"), &offline).is_err());
        assert!(validate_logs_dir(Path::new(r"C:\Logs\Sessions"), &offline).is_err());
    }
}
