use std::os::windows::process::CommandExt;
use std::path::Path;
use std::process::Command;
use std::sync::atomic::{AtomicU64, Ordering};

const GAME_EXE_NAME: &str = "Dauntless-Win64-Shipping.exe";
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// The game this launcher started in this run. The background thread in `spawn_game` waits on the real process
/// handle, so this knows the moment the game exits, without guessing from the process list (which can still hold a
/// client the launcher did not start, a dedicated server whose command line Windows hides, or a copy that is still
/// shutting down).
/// Packed as (pid << 2) | state, so a launch and its exit can never be mixed up with a later launch.
static LAUNCHED_GAME: AtomicU64 = AtomicU64::new(STATE_NONE);
const STATE_NONE: u64 = 0;
const STATE_RUNNING: u64 = 1;
const STATE_EXITED: u64 = 2;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LaunchedGameState {
    /// Nothing was launched by this launcher run.
    None,
    Running,
    Exited,
}

impl LaunchedGameState {
    pub fn as_str(self) -> &'static str {
        match self {
            LaunchedGameState::None => "none",
            LaunchedGameState::Running => "running",
            LaunchedGameState::Exited => "exited",
        }
    }
}

fn decode(packed: u64) -> LaunchedGameState {
    match packed & 0b11 {
        STATE_RUNNING => LaunchedGameState::Running,
        STATE_EXITED => LaunchedGameState::Exited,
        _ => LaunchedGameState::None,
    }
}

fn mark_launched(cell: &AtomicU64, pid: u32) {
    cell.store(((pid as u64) << 2) | STATE_RUNNING, Ordering::SeqCst);
}

/// Only the launch that is still current is marked exited; the exit of an older game never hides a newer one.
fn mark_exited(cell: &AtomicU64, pid: u32) {
    let running = ((pid as u64) << 2) | STATE_RUNNING;
    let exited = ((pid as u64) << 2) | STATE_EXITED;
    let _ = cell.compare_exchange(running, exited, Ordering::SeqCst, Ordering::SeqCst);
}

pub fn launched_game_state() -> LaunchedGameState {
    decode(LAUNCHED_GAME.load(Ordering::SeqCst))
}

// A Win32 process handle has no thread affinity (unlike some GUI handles), so it's sound to
// hand off to another thread as long as exactly one thread owns and closes it. windows-sys'
// HANDLE (*mut c_void) isn't Send by default; this newtype asserts that it's fine here.
struct SendableHandle(windows_sys::Win32::Foundation::HANDLE);
unsafe impl Send for SendableHandle {}

/// Process ids of every running process with this image name, from a Toolhelp snapshot. No child process, a few
/// hundred microseconds. `None` when the snapshot cannot be taken (the caller then falls back to PowerShell).
fn pids_named(name: &str) -> Option<Vec<u32>> {
    use windows_sys::Win32::Foundation::{CloseHandle, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS,
    };
    unsafe {
        let snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if snapshot == INVALID_HANDLE_VALUE {
            return None;
        }
        let mut entry: PROCESSENTRY32W = std::mem::zeroed();
        entry.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
        let mut pids = Vec::new();
        let mut more = Process32FirstW(snapshot, &mut entry) != 0;
        while more {
            let len = entry.szExeFile.iter().position(|&c| c == 0).unwrap_or(entry.szExeFile.len());
            if String::from_utf16_lossy(&entry.szExeFile[..len]).eq_ignore_ascii_case(name) {
                pids.push(entry.th32ProcessID);
            }
            more = Process32NextW(snapshot, &mut entry) != 0;
        }
        CloseHandle(snapshot);
        Some(pids)
    }
}

/// Which of the game executable's processes are clients (not `-server` dedicated servers), by PowerShell. Only asked
/// when a process id has not been classified yet.
fn client_pids_via_powershell() -> Result<Vec<u32>, String> {
    // Ramsgate and Training Dojo are dedicated-server processes using the same
    // executable as the client. `tasklist` only exposes the image name, so it
    // makes a healthy server look like a running game client. Inspect the
    // command line and exclude UE's explicit `-server` launch mode instead.
    let query = format!(
        "$processes = Get-CimInstance Win32_Process -Filter \"Name='{GAME_EXE_NAME}'\"; \
         $client = $processes | Where-Object {{ $_.CommandLine -notmatch '(^|\\s)-server(\\s|$)' }}; \
         $client | ForEach-Object {{ $_.ProcessId }}"
    );

    let output = Command::new("powershell.exe")
        .args(["-NoProfile", "-NonInteractive", "-Command", &query])
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .map_err(|e| format!("Couldn't check running processes: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(format!("Couldn't check running processes: {stderr}"));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut pids = Vec::new();
    for line in stdout.lines().map(str::trim).filter(|l| !l.is_empty()) {
        pids.push(
            line.parse::<u32>()
                .map_err(|_| format!("Couldn't determine whether Dauntless is running: {line}"))?,
        );
    }
    Ok(pids)
}

/// Is any of `present` a client process? `known` remembers, per process id, whether it was a client, so a game that
/// keeps running is classified once instead of by a new PowerShell every poll (the launcher polls every 8 seconds,
/// and each PowerShell cost a third of a second or more of CPU while the game was running). Entries for processes
/// that are gone are dropped. `lookup` is only called when an id has not been seen before and returns the client ids.
fn any_client(
    present: &[u32],
    known: &mut std::collections::HashMap<u32, bool>,
    lookup: impl FnOnce() -> Result<Vec<u32>, String>,
) -> Result<bool, String> {
    known.retain(|pid, _| present.contains(pid));
    if present.iter().any(|pid| !known.contains_key(pid)) {
        let clients = lookup()?;
        for pid in present {
            known.entry(*pid).or_insert_with(|| clients.contains(pid));
        }
    }
    Ok(present.iter().any(|pid| known.get(pid).copied().unwrap_or(false)))
}

static CLIENT_PIDS: std::sync::Mutex<Option<std::collections::HashMap<u32, bool>>> = std::sync::Mutex::new(None);

/// Image names of the anti-cheat helper the game leaves behind when it is killed instead of closed.
const ANTI_CHEAT_EXE_NAMES: [&str; 2] = ["EasyAntiCheat_EOS.exe", "EasyAntiCheat.exe"];

/// One log line about game and anti-cheat processes still alive at Play, so a report of "stuck after several restarts"
/// shows whether something from the last session was still running. Counts only, no process details. `None` when the
/// process snapshot cannot be taken.
pub fn leftover_processes_note() -> Option<String> {
    let game = pids_named(GAME_EXE_NAME)?.len();
    let anti_cheat: usize = ANTI_CHEAT_EXE_NAMES.iter().filter_map(|n| pids_named(n)).map(|v| v.len()).sum();
    Some(format_leftover_note(game, anti_cheat))
}

fn format_leftover_note(game: usize, anti_cheat: usize) -> String {
    if game == 0 && anti_cheat == 0 {
        "leftover check: no game or anti-cheat process running".to_string()
    } else {
        format!("leftover check: {game} game process(es) and {anti_cheat} anti-cheat process(es) already running at Play")
    }
}

pub fn is_game_running() -> Result<bool, String> {
    if let Some(present) = pids_named(GAME_EXE_NAME) {
        let mut guard = CLIENT_PIDS.lock().unwrap_or_else(|e| e.into_inner());
        return any_client(&present, guard.get_or_insert_with(Default::default), client_pids_via_powershell);
    }
    // No snapshot available: the old way, one PowerShell per call.
    Ok(!client_pids_via_powershell()?.is_empty())
}

/// Runtime DLL updates must wait for both client and dedicated-server
/// processes because either one can have the DLL mapped and locked.
pub fn is_dauntless_process_running() -> Result<bool, String> {
    if let Some(present) = pids_named(GAME_EXE_NAME) {
        if present.is_empty() {
            return Ok(false);
        }
    }
    let query = format!(
        "$processes = Get-CimInstance Win32_Process -Filter \"Name='{GAME_EXE_NAME}'\"; if ($null -ne $processes) {{ 'true' }} else {{ 'false' }}"
    );
    let output = Command::new("powershell.exe")
        .args(["-NoProfile", "-NonInteractive", "-Command", &query])
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .map_err(|e| format!("Couldn't check Dauntless processes: {e}"))?;
    if !output.status.success() {
        return Err("Couldn't check Dauntless processes.".to_string());
    }
    match String::from_utf8_lossy(&output.stdout)
        .trim()
        .to_lowercase()
        .as_str()
    {
        "true" => Ok(true),
        "false" => Ok(false),
        other => Err(format!(
            "Couldn't determine Dauntless process state: {other}"
        )),
    }
}

/// Like `is_dauntless_process_running`, but only counts processes that run from `directory`. A game or server started
/// from another folder (another install, a local test server) does not hold this folder's DLL, so it must not block
/// updating it.
pub fn is_dauntless_process_running_from(directory: &std::path::Path) -> Result<bool, String> {
    let dir = directory.display().to_string().replace('\'', "''");
    let query = format!(
        r#"$d = '{dir}'.TrimEnd([char]92) + [string][char]92; $n = @(Get-CimInstance Win32_Process -Filter "Name='{GAME_EXE_NAME}'" | Where-Object {{ $_.ExecutablePath -and $_.ExecutablePath.StartsWith($d, [System.StringComparison]::OrdinalIgnoreCase) }}).Count; if ($n -gt 0) {{ 'true' }} else {{ 'false' }}"#
    );
    let output = Command::new("powershell.exe")
        .args(["-NoProfile", "-NonInteractive", "-Command", &query])
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .map_err(|e| format!("Couldn't check Dauntless processes: {e}"))?;
    if !output.status.success() {
        return Err("Couldn't check Dauntless processes.".to_string());
    }
    match String::from_utf8_lossy(&output.stdout).trim().to_lowercase().as_str() {
        "true" => Ok(true),
        "false" => Ok(false),
        other => Err(format!("Couldn't determine Dauntless process state: {other}")),
    }
}

pub struct LaunchIdentity {
    pub account_id: String,
    pub display_name: String,
}

/// Phase 2 (in-process redirect): the game is launched with NO proxy env vars. The injected
/// DLL's FCurlHttpRequest::SetURL hook rewrites backend URLs straight to the configured backend,
/// so the old WinDivert interceptor / HTTP_PROXY path is no longer used (matches
/// start-client-direct.bat). epicapp/epicenv/epicsandboxid/epicdeploymentid stay fixed
/// constants matching routes/eos.ts's EOS-compat values; the epic* identity args carry the
/// authenticated player's real account id/display name.
pub fn spawn_game(
    exe_path: &Path,
    exchange_code: &str,
    identity: &LaunchIdentity,
    session_dir: &Path,
    mut metadata: super::logs::SessionMetadata,
) -> Result<(), String> {
    use std::os::windows::ffi::OsStrExt;
    use std::ptr;
    use std::time::SystemTime;
    use windows_sys::Win32::Foundation::{CloseHandle, GetLastError, HANDLE, WAIT_OBJECT_0};
    use windows_sys::Win32::System::Threading::{
        CreateProcessW, DeleteProcThreadAttributeList, GetExitCodeProcess,
        InitializeProcThreadAttributeList, OpenProcess, UpdateProcThreadAttribute,
        WaitForSingleObject, CREATE_NEW_PROCESS_GROUP, EXTENDED_STARTUPINFO_PRESENT, INFINITE,
        PROCESS_CREATE_PROCESS, PROCESS_INFORMATION, PROC_THREAD_ATTRIBUTE_PARENT_PROCESS,
        STARTUPINFOEXW,
    };
    use windows_sys::Win32::UI::WindowsAndMessaging::{GetShellWindow, GetWindowThreadProcessId};

    use super::logs;

    let game_dir = exe_path
        .parent()
        .ok_or_else(|| "Invalid installation path.".to_string())?;
    let launch_started_at = SystemTime::now();

    // Root cause of "no audio only when launched by the launcher" (confirmed: non-elevated, launcher
    // rebuilt with a detached spawn, still silent; `start` from a separate cmd = audio): the game
    // inherits the launcher's process context. Under Parallels that inherited context breaks UE4's
    // audio-device init. The fix is to REPARENT the game under Explorer (the shell) via the
    // PROC_THREAD_ATTRIBUTE_PARENT_PROCESS attribute, so it launches in a clean interactive context
    // exactly like a double-click — no inherited job/session from the launcher. If the shell handle
    // can't be obtained, we fall back to a plain CreateProcess (still launches; may lack audio).
    let mut args: Vec<String> = vec![
        "-EpicPortal".into(),
        "-NoEAC".into(),
        "-AUTH_TYPE=exchangecode".into(),
        // UE's MCP/social subsystem uses AUTH_LOGIN as its local account key; the metagame OAuth
        // endpoint authenticates from AUTH_PASSWORD, so the verified UUID here is correct.
        format!("-AUTH_LOGIN={}", identity.account_id),
        format!("-AUTH_PASSWORD={exchange_code}"),
        "-epicapp=Archon".into(),
        "-epicenv=Prod".into(),
        format!("-epicusername={}", identity.display_name),
        format!("-epicuserid={}", identity.account_id),
        format!("-epicaccountid={}", identity.account_id),
        "-epicsandboxid=jackal".into(),
        "-epicdeploymentid=53565ba467df4edbb6f5a3d939a8b4f2".into(),
    ];
    let culture = super::game_language::current();
    if !culture.is_empty() {
        args.push(format!("-culture={culture}"));
    }

    // Build one command line: "exe" arg1 arg2 ... A -key=value whose value has spaces becomes
    // -key="value"; other space-bearing tokens are wrapped whole.
    let mut cmdline = format!("\"{}\"", exe_path.to_string_lossy());
    for a in &args {
        cmdline.push(' ');
        if a.contains(' ') {
            if let Some(eq) = a.find('=') {
                cmdline.push_str(&a[..eq]);
                cmdline.push_str("=\"");
                cmdline.push_str(&a[eq + 1..]);
                cmdline.push('"');
            } else {
                cmdline.push('"');
                cmdline.push_str(a);
                cmdline.push('"');
            }
        } else {
            cmdline.push_str(a);
        }
    }
    let mut cmdline_w: Vec<u16> = cmdline.encode_utf16().chain(std::iter::once(0)).collect();
    let dir_w: Vec<u16> = game_dir
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();

    unsafe {
        // Obtain a handle to the shell (Explorer) process to reparent under.
        let mut parent_handle: HANDLE = ptr::null_mut();
        let shell_hwnd = GetShellWindow();
        if !shell_hwnd.is_null() {
            let mut shell_pid: u32 = 0;
            GetWindowThreadProcessId(shell_hwnd, &mut shell_pid);
            if shell_pid != 0 {
                parent_handle = OpenProcess(PROCESS_CREATE_PROCESS, 0, shell_pid);
            }
        }

        let mut si: STARTUPINFOEXW = std::mem::zeroed();
        si.StartupInfo.cb = std::mem::size_of::<STARTUPINFOEXW>() as u32;

        // Build the attribute list carrying the parent-process handle. Kept in scope until after
        // CreateProcessW so the pointers stay valid.
        let mut attr_buf: Vec<u8> = Vec::new();
        let mut have_attr = false;
        let parent_for_attr = parent_handle;
        if !parent_handle.is_null() {
            let mut size: usize = 0;
            InitializeProcThreadAttributeList(ptr::null_mut(), 1, 0, &mut size);
            if size > 0 {
                attr_buf.resize(size, 0);
                let list = attr_buf.as_mut_ptr() as *mut core::ffi::c_void;
                if InitializeProcThreadAttributeList(list, 1, 0, &mut size) != 0 {
                    let ok = UpdateProcThreadAttribute(
                        list,
                        0,
                        PROC_THREAD_ATTRIBUTE_PARENT_PROCESS as usize,
                        &parent_for_attr as *const HANDLE as *const core::ffi::c_void,
                        std::mem::size_of::<HANDLE>(),
                        ptr::null_mut(),
                        ptr::null_mut(),
                    );
                    if ok != 0 {
                        si.lpAttributeList = list;
                        have_attr = true;
                    }
                }
            }
        }

        let mut flags = CREATE_NEW_PROCESS_GROUP;
        if have_attr {
            flags |= EXTENDED_STARTUPINFO_PRESENT;
        }

        let mut pi: PROCESS_INFORMATION = std::mem::zeroed();
        let created = CreateProcessW(
            ptr::null(),
            cmdline_w.as_mut_ptr(),
            ptr::null(),
            ptr::null(),
            0, // bInheritHandles = FALSE
            flags,
            ptr::null(),
            dir_w.as_ptr(),
            &mut si as *mut STARTUPINFOEXW as *mut _,
            &mut pi,
        );

        if have_attr {
            DeleteProcThreadAttributeList(si.lpAttributeList);
        }
        if !parent_handle.is_null() {
            CloseHandle(parent_handle);
        }

        if created == 0 {
            let err = GetLastError();
            logs::append_launcher_log(session_dir, &format!("CreateProcess failed (error {err})"));
            return Err(format!(
                "Couldn't start Dauntless (CreateProcess error {err})."
            ));
        }
        logs::append_launcher_log(
            session_dir,
            &format!("process created (pid {})", pi.dwProcessId),
        );

        // Wait briefly to catch immediate crashes (missing DLL, wrong working dir, etc.).
        let wait = WaitForSingleObject(pi.hProcess, 500);
        if wait == WAIT_OBJECT_0 {
            let mut code: u32 = 0;
            GetExitCodeProcess(pi.hProcess, &mut code);
            CloseHandle(pi.hThread);
            CloseHandle(pi.hProcess);
            logs::append_launcher_log(session_dir, &format!("exited immediately (code {code})"));
            metadata.exit_code = Some(code);
            metadata.exited_at = Some(logs::iso8601_now());
            logs::write_metadata(session_dir, &metadata);
            logs::copy_runtime_logs_best_effort(game_dir, session_dir, launch_started_at);
            logs::copy_game_log_tail_best_effort(game_dir, session_dir, launch_started_at);
            logs::copy_crash_folders_best_effort(game_dir, session_dir, launch_started_at);
            logs::copy_game_config_best_effort(session_dir);
            return Err(format!("Dauntless exited immediately (code: {code})."));
        }

        // Past the previous behavior of discarding the handle here: retain hProcess (an
        // isize-backed HANDLE, trivially Send/Copy) and hand it to a background thread that
        // blocks until the real exit, then finalizes this session's logs. hThread isn't
        // needed for that and is closed immediately.
        CloseHandle(pi.hThread);
        logs::append_launcher_log(
            session_dir,
            "post-spawn crash check passed; monitoring in background",
        );

        let game_pid = pi.dwProcessId;
        mark_launched(&LAUNCHED_GAME, game_pid);
        let h_process = SendableHandle(pi.hProcess);
        let session_dir_owned = session_dir.to_path_buf();
        let game_dir_owned = game_dir.to_path_buf();
        std::thread::spawn(move || {
            // `let h_process = h_process;` forces the closure to capture the whole
            // SendableHandle (and use its `unsafe impl Send`) — with 2021 edition disjoint
            // closure captures, going straight to `h_process.0` below would instead capture
            // just the inner *mut c_void field, silently bypassing the Send wrapper.
            let h_process = h_process;
            let h_process = h_process.0;
            let mut code: u32 = 0;
            WaitForSingleObject(h_process, INFINITE);
            GetExitCodeProcess(h_process, &mut code);
            CloseHandle(h_process);
            mark_exited(&LAUNCHED_GAME, game_pid);
            logs::append_launcher_log(&session_dir_owned, &format!("exited (code {code})"));
            metadata.exit_code = Some(code);
            metadata.exited_at = Some(logs::iso8601_now());
            logs::write_metadata(&session_dir_owned, &metadata);
            logs::copy_runtime_logs_best_effort(
                &game_dir_owned,
                &session_dir_owned,
                launch_started_at,
            );
            logs::copy_game_log_tail_best_effort(&game_dir_owned, &session_dir_owned, launch_started_at);
            logs::copy_crash_folders_best_effort(&game_dir_owned, &session_dir_owned, launch_started_at);
            logs::copy_game_config_best_effort(&session_dir_owned);
        });
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn nothing_launched_reads_none() {
        let cell = AtomicU64::new(STATE_NONE);
        assert_eq!(decode(cell.load(Ordering::SeqCst)), LaunchedGameState::None);
    }

    #[test]
    fn launched_game_reads_running_until_it_exits() {
        let cell = AtomicU64::new(STATE_NONE);
        mark_launched(&cell, 4242);
        assert_eq!(decode(cell.load(Ordering::SeqCst)), LaunchedGameState::Running);
        mark_exited(&cell, 4242);
        assert_eq!(decode(cell.load(Ordering::SeqCst)), LaunchedGameState::Exited);
    }

    #[test]
    fn exit_of_an_older_game_does_not_hide_a_newer_one() {
        let cell = AtomicU64::new(STATE_NONE);
        mark_launched(&cell, 100);
        mark_launched(&cell, 200);
        mark_exited(&cell, 100);
        assert_eq!(decode(cell.load(Ordering::SeqCst)), LaunchedGameState::Running);
        mark_exited(&cell, 200);
        assert_eq!(decode(cell.load(Ordering::SeqCst)), LaunchedGameState::Exited);
    }

    #[test]
    fn large_pids_survive_packing() {
        let cell = AtomicU64::new(STATE_NONE);
        mark_launched(&cell, u32::MAX);
        assert_eq!(decode(cell.load(Ordering::SeqCst)), LaunchedGameState::Running);
        mark_exited(&cell, u32::MAX);
        assert_eq!(decode(cell.load(Ordering::SeqCst)), LaunchedGameState::Exited);
    }

    #[test]
    fn state_names_match_the_frontend() {
        assert_eq!(LaunchedGameState::None.as_str(), "none");
        assert_eq!(LaunchedGameState::Running.as_str(), "running");
        assert_eq!(LaunchedGameState::Exited.as_str(), "exited");
    }

    #[test]
    fn a_running_game_is_classified_once() {
        use std::collections::HashMap;
        let mut known = HashMap::new();
        let mut asked = 0;
        // client 10 and server 11 are running
        let r = super::any_client(&[10, 11], &mut known, || { asked += 1; Ok(vec![10]) });
        assert_eq!(r, Ok(true));
        // the same two on the next polls: no lookup at all
        for _ in 0..5 {
            let r = super::any_client(&[10, 11], &mut known, || { asked += 1; Ok(vec![]) });
            assert_eq!(r, Ok(true));
        }
        assert_eq!(asked, 1);
        // only the server left: answered from the cache, and the client entry is dropped
        assert_eq!(super::any_client(&[11], &mut known, || { asked += 1; Ok(vec![]) }), Ok(false));
        assert_eq!(asked, 1);
        assert!(!known.contains_key(&10));
        // a new process appears: exactly one more lookup
        assert_eq!(super::any_client(&[11, 12], &mut known, || { asked += 1; Ok(vec![12]) }), Ok(true));
        assert_eq!(asked, 2);
        // nothing running: no lookup, false, cache emptied
        assert_eq!(super::any_client(&[], &mut known, || { asked += 1; Ok(vec![]) }), Ok(false));
        assert_eq!(asked, 2);
        assert!(known.is_empty());
    }

    #[test]
    fn a_failed_lookup_is_not_cached() {
        use std::collections::HashMap;
        let mut known = HashMap::new();
        assert!(super::any_client(&[5], &mut known, || Err("boom".to_string())).is_err());
        assert!(known.is_empty());
        assert_eq!(super::any_client(&[5], &mut known, || Ok(vec![5])), Ok(true));
    }

    #[test]
    fn toolhelp_finds_this_test_process_and_not_a_missing_one() {
        let me = std::env::current_exe().unwrap();
        let name = me.file_name().unwrap().to_string_lossy().to_string();
        let found = super::pids_named(&name).expect("snapshot");
        assert!(found.contains(&std::process::id()));
        assert_eq!(super::pids_named("definitely-not-running-xyz.exe"), Some(vec![]));
    }

    #[test]
    fn dedicated_server_arguments_are_distinct_from_client_arguments() {
        let server = "Dauntless-Win64-Shipping.exe key 8790 map -EpicPortal -server -nullrhi";
        let client = "Dauntless-Win64-Shipping.exe -EpicPortal -NoEAC -AUTH_TYPE=exchangecode";

        assert!(server.contains("-server"));
        assert!(!client.contains("-server"));
    }
    #[test]
    fn leftover_note_counts_only() {
        assert_eq!(super::format_leftover_note(0, 0), "leftover check: no game or anti-cheat process running");
        assert!(super::format_leftover_note(1, 2).contains("1 game process(es) and 2 anti-cheat"));
    }
}
