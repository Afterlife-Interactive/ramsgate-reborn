//! Brand-new or reset game installs never have `LastAcceptedTermsOfServiceVersion` set in
//! `GameUserSettings.ini`, which leaves the stock login screen stuck on an invisible End User
//! License Agreement page forever (our DLL's auto-login never presses Play, because that only
//! arms once the login screen leaves the EULA state). Established players who ran Dauntless or
//! DR before already have the value and never see this. Before Play starts the game, make sure
//! the saved ToS version is at least the one the game ships with, the same way `game_language`
//! and `config_repair` touch this file: only the one key is changed, a one-time backup is kept,
//! and every other line is left exactly as it was.

use std::fs;
use std::path::PathBuf;

const SECTION: &str = "[/Script/Archon.ArchonGameUserSettings]";
const KEY: &str = "LastAcceptedTermsOfServiceVersion";
/// The version the stock login screen checks against. Anything at or above this is treated as
/// already accepted.
pub const CURRENT_VERSION: &str = "2019.07.01-14.00.00";

fn settings_path() -> Option<PathBuf> {
    let base = std::env::var_os("LOCALAPPDATA")?;
    Some(PathBuf::from(base).join("Archon").join("Saved").join("Config").join("WindowsClient").join("GameUserSettings.ini"))
}

fn read_version(text: &str) -> Option<String> {
    let mut in_section = false;
    for line in text.lines() {
        let t = line.trim();
        if t.starts_with('[') {
            in_section = t.eq_ignore_ascii_case(SECTION);
        } else if in_section {
            if let Some((k, v)) = t.split_once('=') {
                if k.trim().eq_ignore_ascii_case(KEY) {
                    return Some(v.trim().to_string());
                }
            }
        }
    }
    None
}

/// Lexical compare works here because every component of this dotted/dashed timestamp-like
/// version is fixed-width and zero-padded (`YYYY.MM.DD-HH.MM.SS`), so there is no need to parse it.
fn is_at_least_current(version: &str) -> bool {
    version >= CURRENT_VERSION
}

/// Returns `text` with the key set under `SECTION`, keeping every other line untouched. Creates
/// the section (and, if the file was empty, its header comment-free) when missing.
fn apply_version(text: &str, version: &str) -> String {
    let mut out: Vec<String> = Vec::new();
    let mut in_section = false;
    let mut has_section = false;
    let mut written = false;
    for line in text.lines() {
        let t = line.trim();
        if t.starts_with('[') {
            if in_section && !written {
                out.push(format!("{KEY}={version}"));
                written = true;
            }
            in_section = t.eq_ignore_ascii_case(SECTION);
            has_section |= in_section;
        } else if in_section {
            if let Some((k, _)) = t.split_once('=') {
                if k.trim().eq_ignore_ascii_case(KEY) {
                    if !written {
                        out.push(format!("{KEY}={version}"));
                        written = true;
                    }
                    continue;
                }
            }
        }
        out.push(line.to_string());
    }
    if in_section && !written {
        out.push(format!("{KEY}={version}"));
        written = true;
    }
    if !has_section && !written {
        if !out.is_empty() {
            out.push(String::new());
        }
        out.push(SECTION.to_string());
        out.push(format!("{KEY}={version}"));
    }
    let mut s = out.join("\r\n");
    s.push_str("\r\n");
    s
}

/// Ensures the saved ToS version is at least `CURRENT_VERSION` so the stock login screen does not
/// stall on its (invisible, under our auto-login) EULA page. No-op, with no backup write, when the
/// file is missing-but-unreadable in a way we can't safely touch, or already at/above the current
/// version. Returns a short description of what changed, or `None` when nothing needed changing.
pub fn ensure_accepted() -> Option<String> {
    let path = settings_path()?;
    let existing = fs::read_to_string(&path).unwrap_or_default();
    if let Some(v) = read_version(&existing) {
        if is_at_least_current(&v) {
            return None;
        }
    }
    if path.is_file() {
        let backup = path.with_file_name("GameUserSettings.ini.ramsgate-backup");
        if !backup.exists() {
            let _ = fs::copy(&path, &backup);
        }
    } else if let Some(dir) = path.parent() {
        let _ = fs::create_dir_all(dir);
    }
    let updated = apply_version(&existing, CURRENT_VERSION);
    fs::write(&path, updated).ok()?;
    Some(format!("GameUserSettings.ini (set {KEY}={CURRENT_VERSION})"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn missing_file_gets_the_section_and_key() {
        let out = apply_version("", CURRENT_VERSION);
        assert_eq!(out, format!("{SECTION}\r\n{KEY}={CURRENT_VERSION}\r\n"));
        assert_eq!(read_version(&out).as_deref(), Some(CURRENT_VERSION));
    }

    #[test]
    fn missing_section_and_key_are_added_without_disturbing_other_sections() {
        let base = "[Internationalization]\r\nCulture=en\r\n";
        let out = apply_version(base, CURRENT_VERSION);
        assert!(out.contains("[Internationalization]\r\nCulture=en\r\n"));
        assert!(out.contains(&format!("{SECTION}\r\n{KEY}={CURRENT_VERSION}\r\n")));
        assert_eq!(read_version(&out).as_deref(), Some(CURRENT_VERSION));
    }

    #[test]
    fn old_value_is_replaced_in_place() {
        let base = format!("{SECTION}\r\nFullscreenMode=1\r\n{KEY}=0001.01.01-00.00.00\r\nResolutionSizeX=1920\r\n");
        let out = apply_version(&base, CURRENT_VERSION);
        assert_eq!(read_version(&out).as_deref(), Some(CURRENT_VERSION));
        assert!(out.contains("FullscreenMode=1"));
        assert!(out.contains("ResolutionSizeX=1920"));
        assert_eq!(out.matches(KEY).count(), 1);
    }

    #[test]
    fn already_accepted_value_is_left_untouched() {
        let base = format!("{SECTION}\r\n{KEY}={CURRENT_VERSION}\r\nOther=1\r\n");
        assert!(is_at_least_current(CURRENT_VERSION));
        let out = apply_version(&base, CURRENT_VERSION);
        assert_eq!(out, base.replace('\n', "\r\n").replace("\r\r", "\r"));
    }

    #[test]
    fn newer_than_current_counts_as_accepted() {
        assert!(is_at_least_current("2099.01.01-00.00.00"));
        assert!(!is_at_least_current("0001.01.01-00.00.00"));
    }

    #[test]
    fn every_other_key_survives_untouched() {
        let base = format!(
            "[Other]\r\nX=1\r\n{SECTION}\r\nA=1\r\n{KEY}=0001.01.01-00.00.00\r\nB=2\r\n[More]\r\nY=9\r\n"
        );
        let out = apply_version(&base, CURRENT_VERSION);
        for line in ["[Other]", "X=1", "A=1", "B=2", "[More]", "Y=9"] {
            assert!(out.contains(line), "missing {line} in {out}");
        }
        assert_eq!(read_version(&out).as_deref(), Some(CURRENT_VERSION));
    }
}
