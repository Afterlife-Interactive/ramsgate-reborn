//! The launcher must not start hidden script hosts or system tools that antivirus products flag. This scans the
//! launcher source for them. The offline mode still runs its three hash-pinned scripts through Windows PowerShell
//! (src/offline/stack.rs) and the separate one-click installer still uses PowerShell; both are listed here on purpose
//! so any new use elsewhere fails this test.

use std::path::{Path, PathBuf};

fn rust_files(dir: &Path, out: &mut Vec<PathBuf>) {
    for entry in std::fs::read_dir(dir).unwrap().flatten() {
        let path = entry.path();
        if path.is_dir() {
            rust_files(&path, out);
        } else if path.extension().map_or(false, |e| e == "rs") {
            out.push(path);
        }
    }
}

#[test]
fn no_hidden_script_hosts_or_flagged_tools_in_the_launcher_source() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    let mut files = Vec::new();
    rust_files(&root, &mut files);
    assert!(files.len() > 20);
    let everywhere = [
        "-EncodedCommand", "SecurityCenter2", "AntiVirusProduct", "Get-CimInstance", "Get-Process", "Get-NetTCPConnection",
        "certutil", "bitsadmin", "mshta", "regsvr32", "rundll32", "URLDownloadToFile", "schtasks", "netsh", "wmic",
        "Add-MpPreference", "Set-MpPreference", "ExclusionPath", "New-NetFirewallRule", "Invoke-Expression",
    ];
    let script_users = ["offline/stack.rs"];
    for file in files {
        let text = std::fs::read_to_string(&file).unwrap();
        let name = file.strip_prefix(&root).unwrap().to_string_lossy().replace(char::from(92), "/");
        // This test file's own list is not under src/, so no self-exclusion is needed.
        for bad in everywhere {
            // Comments may mention a tool by name; code and strings may not.
            let hit = text.lines().filter(|l| !l.trim_start().starts_with("//")).any(|l| l.contains(bad));
            assert!(!hit, "{name} uses `{bad}`");
        }
        if !script_users.contains(&name.as_str()) {
            for bad in ["powershell", "-ExecutionPolicy", "-WindowStyle"] {
                let hit = text.lines().filter(|l| !l.trim_start().starts_with("//")).any(|l| l.to_ascii_lowercase().contains(&bad.to_ascii_lowercase()));
                assert!(!hit, "{name} uses `{bad}`");
            }
        }
    }
}
