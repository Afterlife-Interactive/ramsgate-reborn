//! Removes leftover settings from other launchers and servers that make the game talk to a local proxy that does not
//! exist here. Some launchers write `127.0.0.1:61000` endpoints into the game's user config (`Game.ini`, and an XMPP
//! stanza in `Engine.ini`); the game then sends every login and account call there instead of to the server, and the
//! login times out. Only lines that point at that local proxy are removed, a one-time backup of each changed file is
//! kept beside it, and everything is logged to the session's launcher log. Best effort; it never blocks Play.

use std::fs;
use std::path::{Path, PathBuf};

const LOCAL_PROXY_MARKERS: &[&str] = &["127.0.0.1:61000", "localhost:61000"];

fn config_dir() -> Option<PathBuf> {
    let base = std::env::var_os("LOCALAPPDATA")?;
    Some(PathBuf::from(base).join("Archon").join("Saved").join("Config").join("WindowsClient"))
}

fn is_ipv4(host: &str) -> bool {
    let parts: Vec<&str> = host.split('.').collect();
    parts.len() == 4 && parts.iter().all(|p| !p.is_empty() && p.len() <= 3 && p.chars().all(|c| c.is_ascii_digit()))
}

/// True when the line has an endpoint `<scheme>://<host>:61000` whose host is `localhost` or a bare IP address (a LAN,
/// VPN or Tailscale address of another launcher's proxy). Our own servers always use domain names.
fn has_literal_host_on_proxy_port(line: &str) -> bool {
    let mut rest = line;
    while let Some(i) = rest.find(":61000") {
        let before = &rest[..i];
        if let Some(j) = before.rfind("//") {
            let host = &before[j + 2..];
            if host.eq_ignore_ascii_case("localhost") || is_ipv4(host) {
                return true;
            }
        }
        rest = &rest[i + 6..];
    }
    false
}

fn points_at_local_proxy(line: &str) -> bool {
    LOCAL_PROXY_MARKERS.iter().any(|m| line.contains(m)) || has_literal_host_on_proxy_port(line)
}

/// Lines of the `[OnlineSubsystemMcp.XMPP]` stanza that Revived-style launchers write for their local proxy.
fn is_local_xmpp_line(line: &str) -> bool {
    let t = line.trim().replace(' ', "");
    let ws_ip = t.to_ascii_lowercase().strip_prefix("serveraddr=\"ws://").and_then(|r| r.strip_suffix('"')).map(is_ipv4).unwrap_or(false);
    ws_ip
        || t.eq_ignore_ascii_case("ServerAddr=\"ws://127.0.0.1\"")
        || is_stray_xmpp_port(&t)
        || t.eq_ignore_ascii_case("bUseSSL=false")
}

/// A `ServerPort=` line other than 443 in the chat stanza. The game is pointed at the server's secure port, so any other
/// port left behind by another launcher (61000, 61099, ...) makes the chat connection hang and friend requests are lost.
fn is_stray_xmpp_port(compact_line: &str) -> bool {
    let lower = compact_line.to_ascii_lowercase();
    match lower.strip_prefix("serverport=") {
        Some(port) => port.trim_matches('"') != "443",
        None => false,
    }
}

fn backup(path: &Path) {
    let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("config.ini");
    let backup = path.with_file_name(format!("{name}.ramsgate-backup"));
    if !backup.exists() {
        let _ = fs::copy(path, backup);
    }
}

/// Returns a short description of what was changed (empty when nothing needed changing).
fn repair_file(path: &Path, drop_line: impl Fn(&str, bool) -> bool) -> Option<String> {
    let text = fs::read_to_string(path).ok()?;
    let mut kept = Vec::new();
    let mut removed = 0usize;
    let mut in_xmpp = false;
    for line in text.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with('[') {
            in_xmpp = trimmed.eq_ignore_ascii_case("[OnlineSubsystemMcp.XMPP]");
        }
        if drop_line(line, in_xmpp) {
            removed += 1;
        } else {
            kept.push(line);
        }
    }
    if removed == 0 {
        return None;
    }
    backup(path);
    let mut out = kept.join("\r\n");
    out.push_str("\r\n");
    fs::write(path, out).ok()?;
    Some(format!("{} ({removed} line(s))", path.file_name()?.to_string_lossy()))
}

/// Cleans the game's user config. Returns one line per file that was changed.
pub fn repair_game_config() -> Vec<String> {
    let Some(dir) = config_dir() else { return Vec::new() };
    let mut changed = Vec::new();
    if let Some(c) = repair_file(&dir.join("Game.ini"), |line, _| points_at_local_proxy(line)) {
        changed.push(c);
    }
    if let Some(c) = repair_file(&dir.join("Engine.ini"), |line, in_xmpp| {
        points_at_local_proxy(line) || (in_xmpp && is_local_xmpp_line(line))
    }) {
        changed.push(c);
    }
    changed
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recognises_local_proxy_lines_only() {
        assert!(points_at_local_proxy("AuthEndpoint=\"http://127.0.0.1:61000/game/login\""));
        assert!(!points_at_local_proxy("AuthEndpoint=\"https://example.test/game/login\""));
        assert!(points_at_local_proxy("AuthEndpoint=\"http://100.64.0.10:61000/game/login\""));
        assert!(points_at_local_proxy("QueryLoginQueueEndpoint=\"http://192.168.1.20:61000/login\""));
        assert!(!points_at_local_proxy("AuthEndpoint=\"https://play.afterlifeinteractive.com:61000/login\""));
        assert!(is_local_xmpp_line("ServerAddr=\"ws://100.64.0.10\""));
        assert!(!is_local_xmpp_line("ServerAddr=\"ws://chat.example.test\""));
        assert!(is_local_xmpp_line("ServerAddr=\"ws://127.0.0.1\""));
        assert!(is_local_xmpp_line("ServerPort=61000"));
        assert!(!is_local_xmpp_line("ServerPort=443"));
        assert!(is_local_xmpp_line("ServerPort=61099"));
        assert!(is_local_xmpp_line("ServerPort = 8080"));
        assert!(!is_local_xmpp_line("ServerPort=\"443\""));
    }

    #[test]
    fn removes_only_the_local_proxy_lines() {
        let dir = std::env::temp_dir().join(format!("rr-config-test-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let file = dir.join("Game.ini");
        fs::write(&file, "[OnlineSubsystemPhoenix]\r\nAuthEndpoint=\"http://127.0.0.1:61000/login\"\r\nKeep=1\r\n").unwrap();
        let note = repair_file(&file, |l, _| points_at_local_proxy(l));
        assert!(note.is_some());
        let after = fs::read_to_string(&file).unwrap();
        assert!(after.contains("Keep=1") && !after.contains("61000"));
        assert!(dir.join("Game.ini.ramsgate-backup").exists());
        let _ = fs::remove_dir_all(&dir);
    }
}
