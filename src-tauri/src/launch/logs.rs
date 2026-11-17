use serde::Serialize;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager};

use sha2::{Digest, Sha256};

/// %LOCALAPPDATA%\RamsgateReborn\Logs\Sessions — a fixed, memorable path independent of the
/// Tauri bundle identifier, so testers/support can find it without asking the launcher.
pub fn sessions_root(app: &AppHandle) -> Result<PathBuf, String> {
    let base = app
        .path()
        .local_data_dir()
        .map_err(|e| format!("Couldn't locate the log directory: {e}"))?;
    // Earlier builds kept logs under a differently named folder; move it over once so no history is lost.
    let folder = base.join("RamsgateReborn");
    let legacy = base.join(["Mystic", "Paradox"].concat());
    if !folder.exists() && legacy.is_dir() {
        let _ = fs::rename(&legacy, &folder);
    }
    Ok(folder.join("Logs").join("Sessions"))
}

pub fn session_dir(app: &AppHandle, launch_session_id: &str) -> Result<PathBuf, String> {
    let dir = sessions_root(app)?.join(launch_session_id);
    fs::create_dir_all(&dir).map_err(|e| format!("Couldn't create the session log folder: {e}"))?;
    Ok(dir)
}

/// Not cryptographically random and not RFC4122-strict — just a globally-unique,
/// filesystem-safe id to correlate one Play attempt's logs. Built from sha2, which is
/// already a dependency, instead of pulling in a `uuid`/`rand` crate for this alone.
pub fn generate_launch_session_id() -> String {
    static COUNTER: AtomicU32 = AtomicU32::new(0);
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let count = COUNTER.fetch_add(1, Ordering::Relaxed);
    let seed = format!("{nanos}-{}-{count}", std::process::id());
    let digest = Sha256::digest(seed.as_bytes());
    let hex: String = digest.iter().take(16).map(|b| format!("{b:02x}")).collect();
    format!(
        "{}-{}-{}-{}-{}",
        &hex[0..8],
        &hex[8..12],
        &hex[12..16],
        &hex[16..20],
        &hex[20..32]
    )
}

/// Howard Hinnant's days-from-civil algorithm (public domain), inverted: days since the Unix
/// epoch -> (year, month, day). Avoids pulling in a date/time crate for one ISO 8601 stamp.
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719468;
    let era = if z >= 0 { z } else { z - 146096 } / 146097;
    let doe = (z - era * 146097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    let y = if m <= 2 { y + 1 } else { y };
    (y, m, d)
}

pub fn iso8601_now() -> String {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    let secs = now.as_secs();
    let millis = now.subsec_millis();
    let days = (secs / 86400) as i64;
    let time_of_day = secs % 86400;
    let (h, m, s) = (
        time_of_day / 3600,
        (time_of_day % 3600) / 60,
        time_of_day % 60,
    );
    let (y, mo, d) = civil_from_days(days);
    format!("{y:04}-{mo:02}-{d:02}T{h:02}:{m:02}:{s:02}.{millis:03}Z")
}

pub fn append_launcher_log(dir: &Path, line: &str) {
    let path = dir.join("launcher.log");
    if let Ok(mut file) = fs::OpenOptions::new().create(true).append(true).open(path) {
        let _ = writeln!(file, "[{}] {line}", iso8601_now());
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionMetadata {
    pub launch_session_id: String,
    pub started_at: String,
    pub account_id: String,
    pub display_name: String,
    pub game_exe_path: String,
    pub channel: String,
    pub exit_code: Option<u32>,
    pub exited_at: Option<String>,
}

pub fn write_metadata(dir: &Path, metadata: &SessionMetadata) {
    if let Ok(json) = serde_json::to_string_pretty(metadata) {
        let _ = fs::write(dir.join("metadata.json"), json);
    }
}

/// Best-effort: copies any runtime DLL log (`ramsgatereborn_dll_port*.log`, written
/// beside the game exe — see the runtime) modified since launch
/// into the session folder (last 1.8 MB of each). The DLL doesn't accept a log-path argument, so this is the
/// non-invasive way to get its output into the per-session folder without changing the
/// (signed, separately-published) runtime DLL itself.
pub fn copy_runtime_logs_best_effort(game_dir: &Path, session_dir: &Path, since: SystemTime) {
    let Ok(entries) = fs::read_dir(game_dir) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let name_str = name.to_string_lossy();
        if !name_str.starts_with("ramsgatereborn_dll_port") || !name_str.ends_with(".log") {
            continue;
        }
        let Ok(meta) = entry.metadata() else { continue };
        let Ok(modified) = meta.modified() else {
            continue;
        };
        if modified < since {
            continue;
        }
        // The DLL logs grow past the 2 MB the backend accepts, and one refused file used to stop the whole upload,
        // so only the newest part is kept (the same cut the game's own logs get).
        if let Some(bytes) = read_log_tail(&entry.path()) {
            let _ = fs::write(session_dir.join(format!("runtime-{name_str}")), bytes);
        }
    }
}

/// True when the runtime DLL wrote (or touched) any `ramsgatereborn_dll_port*.log` beside the game exe since `since`.
/// The DLL logs its version in the first second of every start, so no fresh log means the runtime never loaded and the
/// stock game ran on its own (the "Failed to create IGameClient instance" dialog).
pub fn runtime_log_written_since(game_dir: &Path, since: SystemTime) -> bool {
    let Ok(entries) = fs::read_dir(game_dir) else { return false };
    entries.flatten().any(|entry| {
        let name = entry.file_name();
        let name = name.to_string_lossy();
        name.starts_with("ramsgatereborn_dll_port")
            && name.ends_with(".log")
            && entry.metadata().and_then(|m| m.modified()).map(|m| m >= since).unwrap_or(false)
    })
}

/// One line for launcher.log describing a launch where the runtime did not start, with the file sizes (no paths).
pub fn runtime_not_started_note(game_dir: &Path) -> String {
    let size = |n: &str| fs::metadata(game_dir.join(n)).map(|m| m.len().to_string()).unwrap_or_else(|_| "missing".into());
    format!(
        "runtime did not start: no runtime log was written (winmm.dll {} bytes, RamsgateReborn.dll {} bytes); a security program may be blocking the game folder",
        size("winmm.dll"),
        size("RamsgateReborn.dll")
    )
}

/// Newest session folders kept under Sessions/. Every Play attempt copies up to ~13 MB of log tails into its own
/// folder and nothing ever removed them, so the folder grew without bound.
pub const KEEP_SESSIONS: usize = 40;

/// A launch session id is 36 hex digits and dashes (see `generate_launch_session_id`). Only folders named like that
/// are ever removed, so anything a person put in Sessions/ by hand is left alone.
fn looks_like_session_id(name: &str) -> bool {
    name.len() == 36 && name.chars().all(|c| c.is_ascii_hexdigit() || c == '-')
}

/// Best-effort: removes the oldest session folders so at most `keep` remain. `protect` (the folder of the attempt that
/// is starting right now) is never removed and counts toward `keep`.
pub fn prune_old_sessions(root: &Path, keep: usize, protect: &Path) {
    let Ok(entries) = fs::read_dir(root) else { return };
    let mut sessions: Vec<(PathBuf, SystemTime)> = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if path == protect {
            continue;
        }
        let name = entry.file_name();
        if !looks_like_session_id(&name.to_string_lossy()) {
            continue;
        }
        let Ok(meta) = entry.metadata() else { continue };
        if !meta.is_dir() {
            continue;
        }
        sessions.push((path, meta.modified().unwrap_or(UNIX_EPOCH)));
    }
    // newest first; the protected folder takes one of the kept places
    sessions.sort_by(|a, b| b.1.cmp(&a.1));
    for (path, _) in sessions.into_iter().skip(keep.saturating_sub(1)) {
        let _ = fs::remove_dir_all(path);
    }
}

/// The runtime DLL appends to `ramsgatereborn_dll_port*.log` beside the game exe on every start and never trims it.
/// Before the game starts, a log bigger than `max_bytes` is moved to `<name>.old` (replacing the previous `.old`),
/// so the folder holds at most about twice that per log. The game is not running yet, so nothing has the file open.
pub fn rotate_runtime_logs(game_dir: &Path, max_bytes: u64) {
    let Ok(entries) = fs::read_dir(game_dir) else { return };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let name_str = name.to_string_lossy();
        if !name_str.starts_with("ramsgatereborn_dll_port") || !name_str.ends_with(".log") {
            continue;
        }
        let Ok(meta) = entry.metadata() else { continue };
        if !meta.is_file() || meta.len() <= max_bytes {
            continue;
        }
        let old = game_dir.join(format!("{name_str}.old"));
        let _ = fs::remove_file(&old);
        let _ = fs::rename(entry.path(), &old);
    }
}

/// Biggest runtime DLL log left in place at launch (16 MB).
pub const RUNTIME_LOG_ROTATE_BYTES: u64 = 16 * 1024 * 1024;

/// Biggest slice of any one log that is kept; the backend refuses files over 2 MB.
const LOG_KEEP_BYTES: u64 = 1_800_000;
const MAX_ENGINE_LOGS: usize = 6;
const MAX_CRASH_LOGS: usize = 6;

/// Reads the last `LOG_KEEP_BYTES` of a file as lossy text bytes.
fn read_log_tail(path: &Path) -> Option<Vec<u8>> {
    use std::io::{Read, Seek, SeekFrom};
    let mut file = fs::File::open(path).ok()?;
    let len = file.metadata().ok()?.len();
    if len > LOG_KEEP_BYTES {
        file.seek(SeekFrom::Start(len - LOG_KEEP_BYTES)).ok()?;
    }
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes).ok()?;
    Some(bytes)
}

/// Text files (`.log`, `.txt`, `.xml`) under `dir` that were modified since `since`, newest first.
fn recent_text_files(dir: &Path, since: SystemTime, depth: u32, out: &mut Vec<(PathBuf, SystemTime)>) {
    let Ok(entries) = fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let path = entry.path();
        let Ok(meta) = entry.metadata() else { continue };
        if meta.is_dir() {
            if depth > 0 {
                recent_text_files(&path, since, depth - 1, out);
            }
            continue;
        }
        let ext = path.extension().and_then(|e| e.to_str()).map(|e| e.to_ascii_lowercase());
        if !matches!(ext.as_deref(), Some("log") | Some("txt") | Some("xml")) {
            continue;
        }
        let Ok(modified) = meta.modified() else { continue };
        if modified >= since {
            out.push((path, modified));
        }
    }
    out.sort_by(|a, b| b.1.cmp(&a.1));
}

/// The game's Saved folders: `%LOCALAPPDATA%\Archon\Saved` (Dauntless is the "Archon" project), the older
/// `Dauntless\Saved`, and `...\Dauntless\Archon\Saved` beside the install (game_dir is ...\Archon\Binaries\Win64).
fn saved_roots(game_dir: &Path) -> Vec<PathBuf> {
    let mut roots: Vec<PathBuf> = Vec::new();
    if let Some(base) = std::env::var_os("LOCALAPPDATA") {
        let base = PathBuf::from(base);
        roots.push(base.join("Archon").join("Saved"));
        roots.push(base.join("Dauntless").join("Saved"));
    }
    if let Some(archon) = game_dir.ancestors().nth(2) {
        roots.push(archon.join("Saved"));
    }
    roots
}

/// How many crash folders one session reports, and the most their dumps may add up to (the server takes 50 MB).
pub const MAX_CRASH_FOLDERS: usize = 2;
pub const MAX_DUMP_BYTES: u64 = 50 * 1024 * 1024;
/// Local list of the crash folders found for a session. It is never uploaded (not on the upload allow-list); it only
/// tells the dump sender where this session's dumps are.
pub const CRASH_FOLDERS_FILE: &str = "crash-folders.txt";

/// Newest-changed time of a crash folder: the folder itself or any file directly in it.
fn crash_folder_time(dir: &Path) -> Option<SystemTime> {
    let mut newest = fs::metadata(dir).and_then(|m| m.modified()).ok();
    for entry in fs::read_dir(dir).ok()?.flatten() {
        if let Ok(modified) = entry.metadata().and_then(|m| m.modified()) {
            if newest.map(|n| modified > n).unwrap_or(true) {
                newest = Some(modified);
            }
        }
    }
    newest
}

/// Crash folders (`Saved\Crashes\UE4CC-Windows-*`) the game wrote since `since`, newest first, at most `MAX_CRASH_FOLDERS`.
pub fn recent_crash_folders(roots: &[PathBuf], since: SystemTime) -> Vec<PathBuf> {
    let mut found: Vec<(PathBuf, SystemTime)> = Vec::new();
    for root in roots {
        let Ok(entries) = fs::read_dir(root.join("Crashes")) else { continue };
        for entry in entries.flatten() {
            let path = entry.path();
            if !entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                continue;
            }
            if let Some(at) = crash_folder_time(&path) {
                if at >= since {
                    found.push((path, at));
                }
            }
        }
    }
    found.sort_by(|a, b| b.1.cmp(&a.1));
    found.dedup_by(|a, b| a.0 == b.0);
    found.into_iter().take(MAX_CRASH_FOLDERS).map(|(path, _)| path).collect()
}

/// Blanks who and which PC from a UE4 CrashContext.runtime-xml, and its command line (it holds the login exchange code).
/// The server blanks the same tags again, and the user name in paths and IP addresses, when it stores the file.
pub fn blank_crash_context(text: &str) -> String {
    const TAGS: [&str; 9] = [
        "UserName", "LoginId", "EpicAccountId", "MachineId", "ComputerName", "UserDescription", "UserEmail", "CommandLine",
        "UserActivityHint",
    ];
    let mut out = text.to_string();
    for tag in TAGS {
        let open = format!("<{tag}>");
        let close = format!("</{tag}>");
        let mut from = 0;
        while let Some(start) = out[from..].find(&open).map(|i| i + from + open.len()) {
            let Some(end) = out[start..].find(&close).map(|i| i + start) else { break };
            out.replace_range(start..end, "redacted");
            from = start + "redacted".len() + close.len();
        }
    }
    out
}

/// One line per crash folder (its full path) already noted in an earlier launch's `crash-folders.txt`. Lives beside
/// Sessions/ (one level up from a session folder), so it survives across launches and launcher restarts. Without
/// this, the same crash folder — still "recent" relative to `since` if the clock/folder-time comparison in
/// `recent_crash_folders` ever lands on the wrong side of a launch boundary — could be noted and its dump offered
/// again on a later, unrelated launch instead of exactly once.
fn reported_crash_folders_file(session_dir: &Path) -> Option<PathBuf> {
    let logs_dir = session_dir.parent()?.parent()?;
    Some(logs_dir.join("reported-crash-folders.txt"))
}

fn already_reported_crash_folder(file: &Path, folder: &Path) -> bool {
    let Ok(text) = fs::read_to_string(file) else { return false };
    let target = folder.to_string_lossy();
    text.lines().any(|l| l.trim() == target)
}

/// Appends newly-noted crash folders to the cross-launch registry, keeping at most the most recent 200 entries.
fn mark_crash_folders_reported(file: &Path, folders: &[PathBuf]) {
    let mut existing: Vec<String> = fs::read_to_string(file)
        .map(|t| t.lines().map(str::to_string).collect())
        .unwrap_or_default();
    for folder in folders {
        existing.push(folder.to_string_lossy().into_owned());
    }
    if existing.len() > 200 {
        let cut = existing.len() - 200;
        existing.drain(0..cut);
    }
    let _ = fs::write(file, existing.join("\n") + "\n");
}

/// Best-effort: for the newest crash folders the game wrote during this session, copies the crash context
/// (`CrashContext.runtime-xml`, blanked) into the session folder as `runtime-crash-<n>-context.log` and notes the folders
/// in `crash-folders.txt`, so their dumps can be sent if the player allows it. The engine log copy in each folder is
/// already taken as `runtime-game-crash-<n>.log`. Read-only on the game's side. Each crash folder is reported at most
/// once across the launcher's lifetime, never only within one session — see `reported_crash_folders_file`.
pub fn copy_crash_folders_best_effort(game_dir: &Path, session_dir: &Path, since: SystemTime) {
    let folders = recent_crash_folders(&saved_roots(game_dir), since);
    if folders.is_empty() {
        return;
    }
    let registry = reported_crash_folders_file(session_dir);
    let folders: Vec<PathBuf> = folders
        .into_iter()
        .filter(|f| registry.as_deref().map(|r| !already_reported_crash_folder(r, f)).unwrap_or(true))
        .collect();
    if folders.is_empty() {
        return;
    }
    let mut listed = Vec::new();
    for (index, folder) in folders.iter().enumerate() {
        listed.push(folder.to_string_lossy().into_owned());
        let Ok(entries) = fs::read_dir(folder) else { continue };
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_ascii_lowercase();
            if !name.ends_with(".runtime-xml") {
                continue;
            }
            if let Some(bytes) = read_log_tail(&entry.path()) {
                let text = blank_crash_context(&String::from_utf8_lossy(&bytes));
                let _ = fs::write(session_dir.join(format!("runtime-crash-{}-context.log", index + 1)), text);
            }
            break;
        }
    }
    let _ = fs::write(session_dir.join(CRASH_FOLDERS_FILE), listed.join("\n") + "\n");
    if let Some(registry) = registry {
        mark_crash_folders_reported(&registry, &folders);
    }
}

/// The dumps that belong to a session: the biggest `.dmp` in each crash folder noted for it, as (number, path, size).
/// Newest crash first; a dump that would take the total past `MAX_DUMP_BYTES` is left out.
pub fn session_crash_dumps(session_dir: &Path) -> Vec<(usize, PathBuf, u64)> {
    let Ok(listed) = fs::read_to_string(session_dir.join(CRASH_FOLDERS_FILE)) else { return Vec::new() };
    let mut out = Vec::new();
    let mut total = 0u64;
    for (index, folder) in listed.lines().map(str::trim).filter(|l| !l.is_empty()).take(MAX_CRASH_FOLDERS).enumerate() {
        let Ok(entries) = fs::read_dir(folder) else { continue };
        let mut best: Option<(PathBuf, u64)> = None;
        for entry in entries.flatten() {
            let path = entry.path();
            let is_dump = path.extension().and_then(|e| e.to_str()).map(|e| e.eq_ignore_ascii_case("dmp")) == Some(true);
            let Ok(meta) = entry.metadata() else { continue };
            if is_dump && meta.is_file() && best.as_ref().map(|(_, s)| meta.len() > *s).unwrap_or(true) {
                best = Some((path, meta.len()));
            }
        }
        if let Some((path, size)) = best {
            if size >= 32 && total + size <= MAX_DUMP_BYTES {
                total += size;
                out.push((index + 1, path, size));
            }
        }
    }
    out
}

/// Best-effort: copies the game's own logs from this play attempt into the session folder, so a failed login can be
/// diagnosed from what the game itself reported. Dauntless is the "Archon" project, so its logs live in
/// `%LOCALAPPDATA%\Archon\Saved\Logs` (older builds of this launcher looked in `Dauntless\Saved\Logs`, which does not
/// exist). Every engine log touched since launch is kept (newest as `runtime-game-engine.log`, the rest numbered),
/// as are any crash reports the engine wrote (`runtime-game-crash-N.log`).
pub fn copy_game_log_tail_best_effort(game_dir: &Path, session_dir: &Path, since: SystemTime) {
    let roots = saved_roots(game_dir);

    let mut engine: Vec<(PathBuf, SystemTime)> = Vec::new();
    let mut crashes: Vec<(PathBuf, SystemTime)> = Vec::new();
    for root in &roots {
        recent_text_files(&root.join("Logs"), since, 0, &mut engine);
        recent_text_files(&root.join("Crashes"), since, 3, &mut crashes);
    }
    engine.sort_by(|a, b| b.1.cmp(&a.1));
    engine.dedup_by(|a, b| a.0 == b.0);
    crashes.sort_by(|a, b| b.1.cmp(&a.1));
    crashes.dedup_by(|a, b| a.0 == b.0);

    for (i, (path, _)) in engine.iter().take(MAX_ENGINE_LOGS).enumerate() {
        if let Some(bytes) = read_log_tail(path) {
            let name = if i == 0 { "runtime-game-engine.log".to_string() } else { format!("runtime-game-engine-{i}.log") };
            let _ = fs::write(session_dir.join(name), bytes);
        }
    }
    for (i, (path, _)) in crashes.iter().take(MAX_CRASH_LOGS).enumerate() {
        if let Some(bytes) = read_log_tail(path) {
            let _ = fs::write(session_dir.join(format!("runtime-game-crash-{}.log", i + 1)), bytes);
        }
    }
}

/// Best-effort: copies the game's user config files (`Engine.ini`, `Game.ini`, `GameUserSettings.ini`, ...) from
/// `%LOCALAPPDATA%\Archon\Saved\Config\WindowsClient` into the session folder as `runtime-config-<name>.log`. Leftover
/// settings from other launchers or servers there (for example an XMPP address and port) change how the game connects,
/// so they are needed to diagnose a stalled login. Read-only: nothing in that folder is modified.
pub fn copy_game_config_best_effort(session_dir: &Path) {
    let Some(base) = std::env::var_os("LOCALAPPDATA") else { return };
    let dir = PathBuf::from(base).join("Archon").join("Saved").join("Config").join("WindowsClient");
    let Ok(entries) = fs::read_dir(&dir) else { return };
    // Filter to .ini files first, then cap the count — taking the raw directory listing's first 12 entries (as before)
    // could lose GameUserSettings.ini (the file that holds the ToS-acceptance state we most need to diagnose a stalled
    // login) behind unrelated non-.ini files or ones that simply sort earlier. The known-important files are also
    // ordered first so they are never the ones dropped if a folder somehow has more than 12 .ini files.
    let mut ini_paths: Vec<PathBuf> = entries
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| path.extension().and_then(|e| e.to_str()).map(|e| e.eq_ignore_ascii_case("ini")) == Some(true))
        .collect();
    const PRIORITY: &[&str] = &["GameUserSettings", "Engine", "Game", "Input"];
    ini_paths.sort_by_key(|path| {
        let stem = path.file_stem().and_then(|s| s.to_str()).unwrap_or("");
        PRIORITY.iter().position(|p| p.eq_ignore_ascii_case(stem)).unwrap_or(PRIORITY.len())
    });
    for path in ini_paths.into_iter().take(12) {
        let Some(stem) = path.file_stem().and_then(|s| s.to_str()) else { continue };
        let safe: String = stem.chars().filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_').take(40).collect();
        if safe.is_empty() {
            continue;
        }
        if let Some(bytes) = read_log_tail(&path) {
            let _ = fs::write(session_dir.join(format!("runtime-config-{safe}.log")), bytes);
        }
    }
}

/// Best-effort: copies the Windows Error Reporting summary of a game crash during this session (Report.wer under
/// ReportArchive / ReportQueue, user and machine wide) into the session folder as `runtime-wer-<n>.log`. Some crashes
/// (fast-fail, 0xC0000409) end the game before the runtime DLL can log anything; the report names the faulting module,
/// its offset and the exception code. Only the signature lines are kept (event type, time, Sig / DynamicSig values),
/// never the loaded-module list or paths. Read-only.
pub fn copy_wer_reports_best_effort(session_dir: &Path) {
    let since = fs::metadata(session_dir)
        .and_then(|m| m.created())
        .unwrap_or_else(|_| SystemTime::now() - std::time::Duration::from_secs(12 * 3600));
    let mut roots = Vec::new();
    for var in ["LOCALAPPDATA", "PROGRAMDATA"] {
        if let Some(base) = std::env::var_os(var) {
            let wer = PathBuf::from(base).join("Microsoft").join("Windows").join("WER");
            roots.push(wer.join("ReportArchive"));
            roots.push(wer.join("ReportQueue"));
        }
    }
    let mut found: Vec<(PathBuf, SystemTime)> = Vec::new();
    for root in roots {
        let Ok(entries) = fs::read_dir(&root) else { continue };
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_ascii_lowercase();
            if !name.contains("dauntless") {
                continue;
            }
            let report = entry.path().join("Report.wer");
            let Ok(modified) = fs::metadata(&report).and_then(|m| m.modified()) else { continue };
            if modified >= since {
                found.push((report, modified));
            }
        }
    }
    found.sort_by(|a, b| b.1.cmp(&a.1));
    for (index, (report, _)) in found.into_iter().take(3).enumerate() {
        let Ok(bytes) = fs::read(&report) else { continue };
        if bytes.len() > 512 * 1024 {
            continue;
        }
        let text = decode_wer_text(&bytes);
        let kept: Vec<&str> = text
            .lines()
            .map(str::trim)
            .filter(|line| {
                ["EventType=", "EventTime=", "ReportType=", "FriendlyEventName=", "Sig[", "DynamicSig["]
                    .iter()
                    .any(|prefix| line.starts_with(prefix))
                    && !line.contains(":\\")
            })
            .take(80)
            .collect();
        if kept.is_empty() {
            continue;
        }
        let _ = fs::write(session_dir.join(format!("runtime-wer-{index}.log")), kept.join("\n") + "\n");
    }
}

/// Report.wer is UTF-16LE with a byte-order mark; fall back to UTF-8 for anything else.
fn decode_wer_text(bytes: &[u8]) -> String {
    if bytes.len() >= 2 && bytes[0] == 0xFF && bytes[1] == 0xFE {
        let units: Vec<u16> = bytes[2..].chunks_exact(2).map(|c| u16::from_le_bytes([c[0], c[1]])).collect();
        String::from_utf16_lossy(&units)
    } else {
        String::from_utf8_lossy(bytes).into_owned()
    }
}

/// Most recently modified session folder under Sessions/, if any — used by the Settings tab
/// to show/upload the last Play attempt without the frontend needing to remember the id
/// across launcher restarts.
pub fn latest_session_dir(app: &AppHandle) -> Result<Option<PathBuf>, String> {
    let root = sessions_root(app)?;
    let Ok(entries) = fs::read_dir(&root) else {
        return Ok(None);
    };
    let mut latest: Option<(PathBuf, SystemTime)> = None;
    for entry in entries.flatten() {
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        if !file_type.is_dir() {
            continue;
        }
        let Ok(meta) = entry.metadata() else { continue };
        let Ok(modified) = meta.modified() else {
            continue;
        };
        if latest.as_ref().map(|(_, t)| modified > *t).unwrap_or(true) {
            latest = Some((entry.path(), modified));
        }
    }
    Ok(latest.map(|(path, _)| path))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn generates_unique_filesystem_safe_ids() {
        let a = generate_launch_session_id();
        let b = generate_launch_session_id();
        assert_ne!(a, b);
        assert_eq!(a.len(), 36);
        assert!(a.chars().all(|c| c.is_ascii_hexdigit() || c == '-'));
    }

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("rr-logs-test-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn prune_keeps_the_newest_sessions_and_the_protected_one() {
        let root = scratch("prune");
        let mut ids = Vec::new();
        for _ in 0..6 {
            std::thread::sleep(std::time::Duration::from_millis(40)); // distinct modification times, oldest first
            let id = generate_launch_session_id();
            let dir = root.join(&id);
            fs::create_dir_all(&dir).unwrap();
            fs::write(dir.join("launcher.log"), "x").unwrap();
            ids.push(id);
        }
        // a folder that is not a session id must survive
        fs::create_dir_all(root.join("notes-by-hand")).unwrap();
        let protect = root.join(&ids[0]); // the oldest, but it is the attempt starting now
        prune_old_sessions(&root, 3, &protect);
        let left: Vec<String> = {
            let mut v: Vec<String> = fs::read_dir(&root).unwrap().flatten().map(|e| e.file_name().to_string_lossy().to_string()).collect();
            v.sort();
            v
        };
        assert!(left.contains(&"notes-by-hand".to_string()));
        assert!(left.contains(&ids[0]), "protected session was removed");
        assert!(left.contains(&ids[5]) && left.contains(&ids[4]), "newest sessions must stay");
        assert!(!left.contains(&ids[1]) && !left.contains(&ids[2]) && !left.contains(&ids[3]));
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn rotate_moves_only_big_runtime_logs() {
        let dir = scratch("rotate");
        fs::write(dir.join("ramsgatereborn_dll_port0.log"), vec![b'a'; 200]).unwrap();
        fs::write(dir.join("ramsgatereborn_dll_port1.log"), vec![b'b'; 10]).unwrap();
        fs::write(dir.join("ramsgatereborn_dll_port0.log.old"), b"stale").unwrap();
        fs::write(dir.join("other.log"), vec![b'c'; 500]).unwrap();
        rotate_runtime_logs(&dir, 100);
        assert!(!dir.join("ramsgatereborn_dll_port0.log").exists());
        assert_eq!(fs::read(dir.join("ramsgatereborn_dll_port0.log.old")).unwrap().len(), 200);
        assert!(dir.join("ramsgatereborn_dll_port1.log").exists());
        assert!(dir.join("other.log").exists());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn formats_a_plausible_iso8601_timestamp() {
        let stamp = iso8601_now();
        // e.g. 2026-07-27T10:00:00.000Z
        assert_eq!(stamp.len(), 24);
        assert!(stamp.starts_with("20"));
        assert!(stamp.ends_with('Z'));
    }
}

#[cfg(test)]
mod crash_folder_tests {
    use super::*;

    #[test]
    fn crash_context_loses_user_machine_and_command_line() {
        let xml = "<UserName>alice</UserName><LoginId>abc</LoginId><CommandLine>-AUTH_PASSWORD=xyz</CommandLine>\
                   <ErrorMessage>EXCEPTION_ACCESS_VIOLATION</ErrorMessage><UserName>bob</UserName>";
        let out = blank_crash_context(xml);
        for secret in ["alice", "abc", "xyz", "bob"] {
            assert!(!out.contains(secret), "{secret} in {out}");
        }
        assert!(out.contains("<ErrorMessage>EXCEPTION_ACCESS_VIOLATION</ErrorMessage>"));
        assert_eq!(blank_crash_context("<UserName>no close"), "<UserName>no close");
    }

    #[test]
    fn newest_two_crash_folders_and_their_dumps_within_the_cap() {
        let root = std::env::temp_dir().join(format!("rr-crash-folders-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        let crashes = root.join("Saved").join("Crashes");
        let since = SystemTime::now() - std::time::Duration::from_secs(5);
        for (name, dump) in [("UE4CC-Windows-A", 100usize), ("UE4CC-Windows-B", 200), ("UE4CC-Windows-C", 300)] {
            let dir = crashes.join(name);
            fs::create_dir_all(&dir).unwrap();
            fs::write(dir.join("CrashContext.runtime-xml"), format!("<UserName>u</UserName><Name>{name}</Name>")).unwrap();
            fs::write(dir.join("UE4Minidump.dmp"), vec![b'M'; dump]).unwrap();
            std::thread::sleep(std::time::Duration::from_millis(30));
        }
        let folders = recent_crash_folders(&[root.join("Saved")], since);
        assert_eq!(folders.len(), MAX_CRASH_FOLDERS);
        assert!(folders[0].ends_with("UE4CC-Windows-C"));

        // A folder older than the session start is not this session's crash.
        assert!(recent_crash_folders(&[root.join("Saved")], SystemTime::now() + std::time::Duration::from_secs(60)).is_empty());

        let session = root.join("session");
        fs::create_dir_all(&session).unwrap();
        let listed: Vec<String> = folders.iter().map(|f| f.to_string_lossy().into_owned()).collect();
        fs::write(session.join(CRASH_FOLDERS_FILE), listed.join("\n")).unwrap();
        let dumps = session_crash_dumps(&session);
        assert_eq!(dumps.iter().map(|d| (d.0, d.2)).collect::<Vec<_>>(), vec![(1, 300), (2, 200)]);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn a_crash_is_only_ever_reported_once_across_later_launches() {
        let root = std::env::temp_dir().join(format!("rr-crash-once-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        let crashes = root.join("Saved").join("Crashes");
        let dir = crashes.join("UE4CC-Windows-ONLY");
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("CrashContext.runtime-xml"), "<UserName>u</UserName>").unwrap();
        fs::write(dir.join("UE4Minidump.dmp"), vec![b'M'; 64]).unwrap();

        let sessions_root = root.join("Logs").join("Sessions");
        let session_1 = sessions_root.join("session-1");
        let session_2 = sessions_root.join("session-2");
        fs::create_dir_all(&session_1).unwrap();
        fs::create_dir_all(&session_2).unwrap();

        let game_dir = root.join("Binaries").join("Win64");
        let since = SystemTime::now() - std::time::Duration::from_secs(5);
        // Launch 1: the crash just happened, so it is noted and its dump offered.
        copy_crash_folders_best_effort(&game_dir, &session_1, since);
        assert!(session_1.join(CRASH_FOLDERS_FILE).exists());
        assert_eq!(session_crash_dumps(&session_1).len(), 1);

        // Launch 2: nothing new crashed, but the same folder still satisfies `since` (e.g. a clock/rounding edge) —
        // it must not be noted a second time.
        copy_crash_folders_best_effort(&game_dir, &session_2, since);
        assert!(!session_2.join(CRASH_FOLDERS_FILE).exists());
        assert_eq!(session_crash_dumps(&session_2).len(), 0);

        let _ = fs::remove_dir_all(&root);
    }
}

#[cfg(test)]
mod wer_tests {
    #[test]
    fn wer_text_decodes_utf16_and_keeps_only_signature_lines() {
        let text = "Version=1\r\nEventType=BEX64\r\nSig[3].Name=Fault Module Name\r\nSig[3].Value=Dauntless-Win64-Shipping.exe\r\nLoadedModule[0]=C:\\Users\\x\\a.dll\r\n";
        let mut bytes = vec![0xFF, 0xFE];
        for unit in text.encode_utf16() {
            bytes.extend_from_slice(&unit.to_le_bytes());
        }
        let decoded = super::decode_wer_text(&bytes);
        assert!(decoded.contains("EventType=BEX64"));
        let dir = std::env::temp_dir().join(format!("rr-wer-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        super::copy_wer_reports_best_effort(&dir);
        let _ = std::fs::remove_dir_all(&dir);
    }
}

#[cfg(test)]
mod runtime_log_tests {
    use super::*;
    use std::time::Duration;

    #[test]
    fn a_fresh_runtime_log_counts_and_an_old_or_missing_one_does_not() {
        let dir = std::env::temp_dir().join(format!("rr-rtlog-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let before = SystemTime::now() - Duration::from_secs(60);
        assert!(!runtime_log_written_since(&dir, before));
        fs::write(dir.join("ramsgatereborn_dll_port0.log"), b"x").unwrap();
        assert!(runtime_log_written_since(&dir, before));
        assert!(!runtime_log_written_since(&dir, SystemTime::now() + Duration::from_secs(60)));
        assert!(runtime_not_started_note(&dir).contains("missing"));
        let _ = fs::remove_dir_all(&dir);
    }
}
