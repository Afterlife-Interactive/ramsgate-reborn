// RR-38 offline mode: runs the offline scripts (offline-stack.ps1, install-offline.ps1). The launcher passes them an
// action plus local folder paths. It never passes a token, a ticket, a URL or any account data, and it adds nothing to
// their environment. Every process started here is hidden (CREATE_NO_WINDOW and -WindowStyle Hidden): the player sees
// only the launcher and the game.
// There is no network code here: the scripts start the offline services, which bind 127.0.0.1 only.

use serde_json::Value;
use std::fs;
use std::io::Write;
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{SystemTime, UNIX_EPOCH};

const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// Exit code offline-stack.ps1 uses for "close the offline game first".
pub const EXIT_CLIENT_RUNNING: i32 = 3;

pub struct ScriptOutput {
    pub code: i32,
    pub json: Option<Value>,
    pub message: Option<String>,
}

/// Windows PowerShell by absolute path, so a powershell.exe elsewhere on PATH is never picked up.
fn powershell_exe() -> PathBuf {
    let root = std::env::var_os("SystemRoot").map(PathBuf::from).unwrap_or_else(|| PathBuf::from(r"C:\Windows"));
    root.join("System32").join("WindowsPowerShell").join("v1.0").join("powershell.exe")
}

/// The scripts print progress first and, with -Json, their result as the last JSON line on stdout.
pub fn last_json_line(stdout: &str) -> Option<Value> {
    stdout
        .lines()
        .rev()
        .map(str::trim)
        .filter(|l| l.starts_with('{') || l.starts_with('['))
        .find_map(|l| serde_json::from_str(l).ok())
}

/// The first useful line of a PowerShell error (the rest is the "At <file>:<line>" position block).
pub fn first_error_line(stderr: &str, stdout: &str) -> Option<String> {
    let pick = |text: &str| {
        text.lines()
            .map(str::trim)
            .filter(|l| !l.is_empty() && !l.starts_with("At ") && !l.starts_with('+') && !l.starts_with("CategoryInfo") && !l.starts_with("FullyQualifiedErrorId"))
            .map(|l| l.to_string())
            .next()
    };
    pick(stderr).or_else(|| {
        // install-offline.ps1 reports its own stops on the host stream ("Offline setup stopped: ...").
        stdout.lines().map(str::trim).find(|l| l.starts_with("Offline setup stopped:")).map(|l| l.to_string())
    })
}

fn unix_now() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

/// Offline actions are logged to offline\logs\launcher-offline.log only, never to the online session folders.
pub fn log_line(logs: &Path, line: &str) {
    let _ = fs::create_dir_all(logs);
    if let Ok(mut f) = fs::OpenOptions::new().create(true).append(true).open(logs.join("launcher-offline.log")) {
        let _ = writeln!(f, "[unix {}] {line}", unix_now());
    }
}

include!(concat!(env!("OUT_DIR"), "/script_pins.rs"));

/// The scripts run unsigned (execution policy bypassed), so a script whose bytes differ from the build's pin is never started.
/// Debug builds run the repo's scripts and skip the check.
fn verify_script_pin(script: &Path) -> Result<(), String> {
    if cfg!(debug_assertions) {
        return Ok(());
    }
    use sha2::{Digest, Sha256};
    let name = script.file_name().and_then(|n| n.to_str()).unwrap_or("");
    let pin = SCRIPT_PINS.iter().find(|(n, _)| *n == name).map(|(_, h)| *h).unwrap_or("");
    let bytes = fs::read(script).map_err(|_| "The offline scripts could not be read. Reinstall the launcher.".to_string())?;
    let actual: String = Sha256::digest(&bytes).iter().map(|b| format!("{b:02x}")).collect();
    if pin.len() != 64 || !actual.eq_ignore_ascii_case(pin) {
        return Err("An offline script does not match this launcher build, so it was not run. Reinstall the launcher.".to_string());
    }
    Ok(())
}

/// Runs one script with -NoProfile -NonInteractive. `args` are passed as separate arguments (no shell string).
pub fn run_script(script: &Path, args: &[String], logs: &Path) -> Result<ScriptOutput, String> {
    if !script.is_file() {
        return Err("The offline scripts are missing from this launcher. Reinstall the launcher.".to_string());
    }
    verify_script_pin(script)?;
    let mut cmd = Command::new(powershell_exe());
    cmd.args(["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-ExecutionPolicy", "Bypass", "-File"])
        .arg(super::paths::plain(script))
        .args(args)
        .creation_flags(CREATE_NO_WINDOW)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let name = script.file_name().and_then(|n| n.to_str()).unwrap_or("script").to_string();
    log_line(logs, &format!("run {name} {}", args.join(" ")));
    let child = cmd.spawn().map_err(|e| format!("Couldn't start {name}: {e}"))?;
    // Everything this script starts (database, backend, director, game servers) ends when the launcher does.
    if let Err(e) = super::lifetime::adopt_offline_child(&child) {
        log_line(logs, &format!("  {e}"));
    }
    let out = child.wait_with_output().map_err(|e| format!("Couldn't run {name}: {e}"))?;
    let stdout = String::from_utf8_lossy(&out.stdout).to_string();
    let stderr = String::from_utf8_lossy(&out.stderr).to_string();
    for l in stdout.lines().chain(stderr.lines()).filter(|l| !l.trim().is_empty()) {
        log_line(logs, &format!("  {l}"));
    }
    let code = out.status.code().unwrap_or(-1);
    log_line(logs, &format!("{name} exit {code}"));
    Ok(ScriptOutput { code, json: last_json_line(&stdout), message: first_error_line(&stderr, &stdout) })
}

/// For actions where any non-zero exit is an error.
pub fn run_ok(script: &Path, args: &[String], logs: &Path, what: &str) -> Result<Option<Value>, String> {
    let out = run_script(script, args, logs)?;
    if out.code != 0 {
        return Err(out.message.unwrap_or_else(|| format!("{what} failed (exit {}). See the offline log folder.", out.code)));
    }
    Ok(out.json)
}

pub fn stack_args(root: &Path, action: &str) -> Vec<String> {
    vec![
        "-Action".to_string(),
        action.to_string(),
        "-OfflineRoot".to_string(),
        super::paths::plain(root),
        "-Json".to_string(),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn json_is_the_last_json_line() {
        let out = "mongod ready\n{\"old\":1}\noffline backend ready\n{\"mongod\":{\"running\":true}}\n\n";
        assert_eq!(last_json_line(out).unwrap()["mongod"]["running"], true);
        assert!(last_json_line("no json here").is_none());
        assert_eq!(last_json_line("[{\"_id\":\"OFF-1\"}]").unwrap()[0]["_id"], "OFF-1");
    }

    #[test]
    fn error_lines() {
        let err = "the offline stack is not running (-Action Start first)\nAt C:\\x\\offline-stack.ps1:200 char:9\n+ throw\n";
        assert_eq!(first_error_line(err, "").unwrap(), "the offline stack is not running (-Action Start first)");
        let out = "Copying...\nOffline setup stopped: the Ramsgate Reborn game is not installed\n";
        assert!(first_error_line("", out).unwrap().contains("not installed"));
        assert!(first_error_line("", "fine").is_none());
    }

    #[test]
    fn stack_args_carry_no_secret_or_address() {
        let a = stack_args(Path::new(r"C:\U\RamsgateReborn\offline"), "Status");
        assert_eq!(a[0], "-Action");
        assert!(a.iter().all(|x| !x.contains("://") && !x.to_ascii_lowercase().contains("token")));
    }
}
