// Stand-in for the launcher in scripts/offline/import-e2e.mjs. It uses the launcher's own process-group and sweep code
// (src/offline/lifetime.rs, included by path) and runs a script the way the launcher runs the offline scripts: hidden,
// then added to the kill-on-close group. The check kills this process and confirms nothing it started is left.
//
//   offline_lifetime_probe run <script.ps1> [script args...]   run the script, then stay alive until killed
//   offline_lifetime_probe sweep <offline folder>              end leftover processes inside that folder, print how many

#[path = "../src/offline/lifetime.rs"]
#[allow(dead_code)]
mod lifetime;

use std::os::windows::process::CommandExt;
use std::path::PathBuf;
use std::process::{Command, Stdio};

const CREATE_NO_WINDOW: u32 = 0x0800_0000;

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.first().map(String::as_str) {
        Some("run") if args.len() >= 2 => {
            let root = std::env::var_os("SystemRoot").map(PathBuf::from).unwrap_or_else(|| PathBuf::from(r"C:\Windows"));
            let ps = root.join("System32").join("WindowsPowerShell").join("v1.0").join("powershell.exe");
            // Output goes to a file (PROBE_LOG), not to pipes: services the script starts would otherwise hold the pipe.
            let log_path = std::env::var_os("PROBE_LOG").map(PathBuf::from).unwrap_or_else(|| std::env::temp_dir().join("offline_lifetime_probe.out"));
            let log = std::fs::File::create(log_path).expect("log file");
            let log_err = log.try_clone().expect("log file");
            let mut child = Command::new(ps)
                .args(["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-ExecutionPolicy", "Bypass", "-File"])
                .args(&args[1..])
                .creation_flags(CREATE_NO_WINDOW)
                .stdin(Stdio::null())
                .stdout(Stdio::from(log))
                .stderr(Stdio::from(log_err))
                .spawn()
                .expect("start script");
            lifetime::adopt_offline_child(&child).expect("adopt");
            let status = child.wait().expect("script");
            println!("script-exit {}", status.code().unwrap_or(-1));
            loop {
                std::thread::sleep(std::time::Duration::from_secs(1));
            }
        }
        Some("sweep") if args.len() == 2 => {
            let ended = lifetime::sweep_leftovers(std::path::Path::new(&args[1]));
            println!("swept {}", ended.len());
        }
        _ => {
            eprintln!("usage: offline_lifetime_probe run <script.ps1> [args...] | sweep <folder>");
            std::process::exit(2);
        }
    }
}
