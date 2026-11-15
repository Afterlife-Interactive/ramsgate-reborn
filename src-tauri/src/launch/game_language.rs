//! The game's text language. The shipped Dauntless 1.12 files carry text for exactly these cultures (found in the
//! Localization/Game folder of Archon_Intl_0): de, en, es, fr, it, ja, pt-BR, ru. The choice is kept in the game's
//! own `GameUserSettings.ini` as `[Internationalization] Culture=<code>` and also passed as `-culture=<code>` on
//! launch so it wins over the in-game default. An empty choice leaves everything as it is.

use std::fs;
use std::path::PathBuf;

pub const LANGUAGES: &[(&str, &str)] = &[
    ("en", "English"),
    ("de", "Deutsch"),
    ("es", "Espa\u{f1}ol"),
    ("fr", "Fran\u{e7}ais"),
    ("it", "Italiano"),
    ("ja", "\u{65e5}\u{672c}\u{8a9e}"),
    ("pt-BR", "Portugu\u{ea}s (Brasil)"),
    ("ru", "\u{420}\u{443}\u{441}\u{441}\u{43a}\u{438}\u{439}"),
];

const SECTION: &str = "[Internationalization]";

fn settings_path() -> Option<PathBuf> {
    let base = std::env::var_os("LOCALAPPDATA")?;
    Some(PathBuf::from(base).join("Archon").join("Saved").join("Config").join("WindowsClient").join("GameUserSettings.ini"))
}

pub fn is_supported(code: &str) -> bool {
    LANGUAGES.iter().any(|(c, _)| *c == code)
}

fn read_culture(text: &str) -> Option<String> {
    let mut in_section = false;
    for line in text.lines() {
        let t = line.trim();
        if t.starts_with('[') {
            in_section = t.eq_ignore_ascii_case(SECTION);
        } else if in_section {
            if let Some((k, v)) = t.split_once('=') {
                if k.trim().eq_ignore_ascii_case("Culture") {
                    return Some(v.trim().to_string());
                }
            }
        }
    }
    None
}

/// Returns `text` with the Culture line set (Some) or removed (None), keeping every other line.
fn apply_culture(text: &str, culture: Option<&str>) -> String {
    let mut out: Vec<String> = Vec::new();
    let mut in_section = false;
    let mut has_section = false;
    let mut written = false;
    for line in text.lines() {
        let t = line.trim();
        if t.starts_with('[') {
            if in_section && !written {
                if let Some(c) = culture {
                    out.push(format!("Culture={c}"));
                    written = true;
                }
            }
            in_section = t.eq_ignore_ascii_case(SECTION);
            has_section |= in_section;
        } else if in_section {
            if let Some((k, _)) = t.split_once('=') {
                if k.trim().eq_ignore_ascii_case("Culture") {
                    if let (Some(c), false) = (culture, written) {
                        out.push(format!("Culture={c}"));
                        written = true;
                    }
                    continue;
                }
            }
        }
        out.push(line.to_string());
    }
    if in_section && !written {
        if let Some(c) = culture {
            out.push(format!("Culture={c}"));
            written = true;
        }
    }
    if !has_section && !written {
        if let Some(c) = culture {
            out.push(String::new());
            out.push(SECTION.to_string());
            out.push(format!("Culture={c}"));
        }
    }
    let mut s = out.join("\r\n");
    s.push_str("\r\n");
    s
}

/// The chosen culture, or "" when none is set or it is not one the game has.
pub fn current() -> String {
    let Some(text) = settings_path().and_then(|p| fs::read_to_string(p).ok()) else { return String::new() };
    match read_culture(&text) {
        Some(c) if is_supported(&c) => c,
        _ => String::new(),
    }
}

/// Saves the choice ("" clears it). Keeps a one-time backup of the file.
pub fn set(code: &str) -> Result<(), String> {
    if !code.is_empty() && !is_supported(code) {
        return Err("That language is not in the game files.".into());
    }
    let path = settings_path().ok_or("Couldn't find the game's settings folder.")?;
    let existing = fs::read_to_string(&path).unwrap_or_default();
    if existing.is_empty() && code.is_empty() {
        return Ok(());
    }
    if path.is_file() {
        let backup = path.with_file_name("GameUserSettings.ini.ramsgate-backup");
        if !backup.exists() {
            let _ = fs::copy(&path, backup);
        }
    } else if let Some(dir) = path.parent() {
        let _ = fs::create_dir_all(dir);
    }
    let updated = apply_culture(&existing, if code.is_empty() { None } else { Some(code) });
    fs::write(&path, updated).map_err(|_| "Couldn't save the language.".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn adds_changes_and_removes_the_culture_line() {
        let base = "[/Script/Archon.ArchonGameUserSettings]\r\nTextLanguage=0\r\n";
        let a = apply_culture(base, Some("de"));
        assert!(a.contains("TextLanguage=0") && a.contains("[Internationalization]\r\nCulture=de"));
        assert_eq!(read_culture(&a).as_deref(), Some("de"));
        let b = apply_culture(&a, Some("fr"));
        assert_eq!(read_culture(&b).as_deref(), Some("fr"));
        assert_eq!(b.matches("Culture=").count(), 1);
        let c = apply_culture(&b, None);
        assert_eq!(read_culture(&c), None);
        assert!(c.contains("TextLanguage=0"));
    }

    #[test]
    fn inserts_into_an_existing_section_before_the_next_one() {
        let base = "[Internationalization]\r\nOther=1\r\n[Next]\r\nX=2\r\n";
        let a = apply_culture(base, Some("ja"));
        assert_eq!(a, "[Internationalization]\r\nOther=1\r\nCulture=ja\r\n[Next]\r\nX=2\r\n");
    }

    #[test]
    fn only_the_shipped_languages_are_accepted() {
        assert!(is_supported("pt-BR") && is_supported("en"));
        assert!(!is_supported("ko") && !is_supported(""));
        assert_eq!(LANGUAGES.len(), 8);
    }
}
