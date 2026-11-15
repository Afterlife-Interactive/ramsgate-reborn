// RR-38 offline mode: nothing the offline half starts outlives the launcher.
//
// 1. A Windows job object with "kill on job close". Every offline script the launcher runs (offline-stack.ps1,
//    install-offline.ps1) is put into this one job right after it starts, so everything those scripts start (the local
//    database, the offline backend, the director, game servers and the offline game) belongs to the job too. The launcher
//    holds the only handle; when the launcher exits, crashes or is killed, Windows closes it and ends every process in
//    the job. Only offline processes are ever put in it: the online game and the launcher itself are not.
// 2. A sweep at launcher start for what an earlier run could not clean up (a power cut, a launcher from before this
//    existed). It ends a process only when its program file lies inside the offline folder, so the online game and
//    unrelated programs are never touched.
//
// No network code here; this only deals with process handles and the offline folder path.

use std::path::Path;
use std::process::Child;
use std::sync::OnceLock;

use windows_sys::Win32::Foundation::{CloseHandle, HANDLE, INVALID_HANDLE_VALUE};
use windows_sys::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS,
};
use windows_sys::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation, SetInformationJobObject,
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
};
use windows_sys::Win32::System::Threading::{
    OpenProcess, QueryFullProcessImageNameW, TerminateProcess, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SET_QUOTA,
    PROCESS_TERMINATE,
};

/// A job whose processes all end when its last handle closes. The handle stays open for as long as this value lives.
pub struct KillOnCloseJob(HANDLE);

// The handle is only ever used through the Win32 calls below, which are thread safe.
unsafe impl Send for KillOnCloseJob {}
unsafe impl Sync for KillOnCloseJob {}

impl KillOnCloseJob {
    pub fn new() -> Result<Self, String> {
        unsafe {
            let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
            if job.is_null() {
                return Err("Couldn't create the offline process group.".to_string());
            }
            let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            let ok = SetInformationJobObject(
                job,
                JobObjectExtendedLimitInformation,
                &info as *const _ as *const core::ffi::c_void,
                std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            );
            if ok == 0 {
                CloseHandle(job);
                return Err("Couldn't set up the offline process group.".to_string());
            }
            Ok(KillOnCloseJob(job))
        }
    }

    /// Puts a started child (and so everything it starts from now on) into the job.
    pub fn adopt(&self, child: &Child) -> Result<(), String> {
        use std::os::windows::io::AsRawHandle;
        let ok = unsafe { AssignProcessToJobObject(self.0, child.as_raw_handle() as HANDLE) };
        if ok == 0 {
            return Err("Couldn't add an offline process to the process group.".to_string());
        }
        Ok(())
    }
}

impl Drop for KillOnCloseJob {
    fn drop(&mut self) {
        unsafe {
            CloseHandle(self.0);
        }
    }
}

static OFFLINE_JOB: OnceLock<Option<KillOnCloseJob>> = OnceLock::new();

/// The launcher-wide job. Created on first use and never closed, so it closes when the launcher process ends.
pub fn offline_job() -> Option<&'static KillOnCloseJob> {
    OFFLINE_JOB.get_or_init(|| KillOnCloseJob::new().ok()).as_ref()
}

/// Called right after an offline script starts. A failure is not fatal (the sweep at the next start still cleans up), but
/// it is reported to the caller so it can be logged.
pub fn adopt_offline_child(child: &Child) -> Result<(), String> {
    offline_job().ok_or_else(|| "The offline process group is not available.".to_string())?.adopt(child)
}

// ---- sweep of leftovers --------------------------------------------------------------------------------------

fn normalise(p: &str) -> String {
    let p = p.trim().replace('/', "\\");
    let p = p.strip_prefix(r"\\?\").unwrap_or(&p);
    p.trim_end_matches('\\').to_ascii_lowercase()
}

/// True when `image` (a program file path) is an .exe inside the offline folder `root`. Nothing else matches: not the
/// online game, not the launcher, not a program that merely has "offline" in its name, not the folder itself.
pub fn is_offline_image(image: &str, root: &Path) -> bool {
    let root = normalise(&root.to_string_lossy());
    if root.len() < 8 {
        return false;
    }
    let image = normalise(image);
    match image.strip_prefix(&root) {
        Some(rest) => rest.starts_with('\\') && rest.len() > 1 && rest.ends_with(".exe"),
        None => false,
    }
}

fn image_path(pid: u32) -> Option<String> {
    unsafe {
        let h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if h.is_null() {
            return None;
        }
        let mut buf = vec![0u16; 1024];
        let mut len = buf.len() as u32;
        let ok = QueryFullProcessImageNameW(h, 0, buf.as_mut_ptr(), &mut len);
        CloseHandle(h);
        if ok == 0 {
            return None;
        }
        Some(String::from_utf16_lossy(&buf[..len as usize]))
    }
}

fn terminate(pid: u32) -> bool {
    unsafe {
        let h = OpenProcess(PROCESS_TERMINATE | PROCESS_SET_QUOTA | PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if h.is_null() {
            return false;
        }
        let ok = TerminateProcess(h, 1);
        CloseHandle(h);
        ok != 0
    }
}

fn all_pids() -> Vec<u32> {
    let mut out = Vec::new();
    unsafe {
        let snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if snap == INVALID_HANDLE_VALUE {
            return out;
        }
        let mut entry: PROCESSENTRY32W = std::mem::zeroed();
        entry.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
        let mut more = Process32FirstW(snap, &mut entry) != 0;
        while more {
            out.push(entry.th32ProcessID);
            more = Process32NextW(snap, &mut entry) != 0;
        }
        CloseHandle(snap);
    }
    out
}

/// Ends every process whose program file is inside the offline folder `root` (a leftover of an earlier run). Returns the
/// process ids it ended. The launcher itself and anything outside the folder are never matched.
pub fn sweep_leftovers(root: &Path) -> Vec<u32> {
    let me = std::process::id();
    let mut ended = Vec::new();
    for pid in all_pids() {
        if pid == me || pid == 0 {
            continue;
        }
        if let Some(image) = image_path(pid) {
            if is_offline_image(&image, root) && terminate(pid) {
                ended.push(pid);
            }
        }
    }
    ended
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::windows::process::CommandExt;
    use std::process::{Command, Stdio};
    use std::time::{Duration, Instant};

    const CREATE_NO_WINDOW: u32 = 0x0800_0000;

    #[test]
    fn sweep_matches_only_programs_inside_the_offline_folder() {
        let root = Path::new(r"C:\Users\p\AppData\Local\RamsgateReborn\offline");
        for yes in [
            r"C:\Users\p\AppData\Local\RamsgateReborn\offline\bin\node.exe",
            r"c:\users\p\appdata\local\ramsgatereborn\OFFLINE\bin\mongod.exe",
            r"\\?\C:\Users\p\AppData\Local\RamsgateReborn\offline\game\Dauntless\Archon\Binaries\Win64\Dauntless-Win64-Shipping.exe",
            r"C:/Users/p/AppData/Local/RamsgateReborn/offline/bin/node.exe",
        ] {
            assert!(is_offline_image(yes, root), "{yes}");
        }
        for no in [
            // the online game and the launcher
            r"C:\Users\p\AppData\Local\RamsgateReborn\game\Dauntless\Archon\Binaries\Win64\Dauntless-Win64-Shipping.exe",
            r"C:\Program Files\Ramsgate Reborn\launcher.exe",
            // look-alike folders and files
            r"C:\Users\p\AppData\Local\RamsgateReborn\offline-old\bin\node.exe",
            r"C:\Users\p\AppData\Local\RamsgateReborn\offlinebin\node.exe",
            r"C:\Users\p\AppData\Local\RamsgateReborn\offline\logs\notes.txt",
            r"C:\Users\p\AppData\Local\RamsgateReborn\offline",
            r"C:\Users\p\AppData\Local\RamsgateReborn\offline\",
            r"C:\Windows\System32\cmd.exe",
            "",
        ] {
            assert!(!is_offline_image(no, root), "{no}");
        }
        // A root that is empty or tiny never matches anything.
        assert!(!is_offline_image(r"C:\x.exe", Path::new("")));
        assert!(!is_offline_image(r"C:\a\b.exe", Path::new(r"C:\")));
    }

    fn alive(child: &mut Child) -> bool {
        matches!(child.try_wait(), Ok(None))
    }

    #[test]
    fn closing_the_job_ends_a_process_in_it_and_only_that() {
        let job = KillOnCloseJob::new().expect("job");
        // ping to the loopback address is only a timer here.
        let sleeper = || {
            Command::new("ping")
                .args(["-n", "60", "127.0.0.1"])
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .creation_flags(CREATE_NO_WINDOW)
                .spawn()
                .expect("start")
        };
        let mut inside = sleeper();
        let mut outside = sleeper();
        job.adopt(&inside).expect("adopt");
        assert!(alive(&mut inside) && alive(&mut outside));
        drop(job);
        let end = Instant::now() + Duration::from_secs(5);
        while alive(&mut inside) && Instant::now() < end {
            std::thread::sleep(Duration::from_millis(50));
        }
        assert!(!alive(&mut inside), "the process in the job must end when the job closes");
        assert!(alive(&mut outside), "a process outside the job must be left alone");
        let _ = outside.kill();
        let _ = outside.wait();
    }

    #[test]
    fn sweep_ends_a_leftover_from_the_offline_folder_and_spares_others() {
        let base = std::env::temp_dir().join(format!("rr38-sweep-{}", std::process::id()));
        let root = base.join("offline");
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(root.join("bin")).unwrap();
        std::fs::create_dir_all(base.join("online")).unwrap();
        let ping = std::env::var_os("SystemRoot").map(std::path::PathBuf::from).unwrap_or_else(|| "C:\\Windows".into()).join("System32").join("PING.EXE");
        let leftover_exe = root.join("bin").join("leftover.exe");
        let other_exe = base.join("online").join("other.exe");
        std::fs::copy(&ping, &leftover_exe).unwrap();
        std::fs::copy(&ping, &other_exe).unwrap();
        let start = |exe: &Path| {
            Command::new(exe)
                .args(["-n", "60", "127.0.0.1"])
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .creation_flags(CREATE_NO_WINDOW)
                .spawn()
                .expect("start")
        };
        let mut leftover = start(&leftover_exe);
        let mut other = start(&other_exe);
        let ended = sweep_leftovers(&root);
        assert!(ended.contains(&leftover.id()));
        assert!(!ended.contains(&other.id()));
        let end = Instant::now() + Duration::from_secs(5);
        while alive(&mut leftover) && Instant::now() < end {
            std::thread::sleep(Duration::from_millis(50));
        }
        assert!(!alive(&mut leftover));
        assert!(alive(&mut other));
        let _ = other.kill();
        let _ = other.wait();
        let _ = std::fs::remove_dir_all(&base);
    }
}
