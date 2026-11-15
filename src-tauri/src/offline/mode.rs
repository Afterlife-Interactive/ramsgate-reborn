// RR-38 offline mode: which half of the launcher is shown (Online | Offline) and whether the player has read the
// one-way notice. A launcher setting like install.json, kept in the launcher's config folder. It holds no account data.

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::Path;

pub const MODE_FILE: &str = "launcher-mode.json";

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModeState {
    /// "online" or "offline"
    pub mode: String,
    /// The player has seen and accepted the one-way notice (shown the first time they switch to Offline).
    pub notice_accepted: bool,
}

impl Default for ModeState {
    fn default() -> Self {
        ModeState { mode: "online".to_string(), notice_accepted: false }
    }
}

pub fn read(file: &Path) -> ModeState {
    let state: ModeState = fs::read_to_string(file)
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_default();
    normalize(state)
}

fn normalize(mut s: ModeState) -> ModeState {
    if s.mode != "offline" || !s.notice_accepted {
        s.mode = "online".to_string();
    }
    s
}

/// Switching to Offline needs the notice accepted first; anything else is Online.
pub fn with_mode(current: &ModeState, mode: &str) -> Result<ModeState, String> {
    match mode {
        "online" => Ok(ModeState { mode: "online".into(), ..current.clone() }),
        "offline" if current.notice_accepted => Ok(ModeState { mode: "offline".into(), ..current.clone() }),
        "offline" => Err("Read and accept the offline notice first.".to_string()),
        _ => Err("Unknown launcher mode.".to_string()),
    }
}

pub fn write(file: &Path, state: &ModeState) -> Result<(), String> {
    let text = serde_json::to_string_pretty(state).map_err(|e| e.to_string())?;
    super::rates::write_atomic(file, text.as_bytes())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn offline_needs_the_notice() {
        let fresh = ModeState::default();
        assert!(with_mode(&fresh, "offline").is_err());
        let accepted = ModeState { notice_accepted: true, ..fresh };
        assert_eq!(with_mode(&accepted, "offline").unwrap().mode, "offline");
        assert_eq!(with_mode(&accepted, "online").unwrap().mode, "online");
        assert!(with_mode(&accepted, "both").is_err());
    }

    #[test]
    fn a_hand_edited_file_cannot_skip_the_notice() {
        let s = normalize(ModeState { mode: "offline".into(), notice_accepted: false });
        assert_eq!(s.mode, "online");
        let s = normalize(ModeState { mode: "weird".into(), notice_accepted: true });
        assert_eq!(s.mode, "online");
    }
}
