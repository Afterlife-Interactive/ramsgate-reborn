// RR-38 offline mode: the Tauri commands of the launcher's OFFLINE half. Every command here is named offline_* and
// takes only rate values or on/off flags. None takes or returns a token, ticket, URL or account data, and none can reach
// the live backend: this module has no HTTP client and no socket code (a test in offline/mod.rs and
// scripts/offline/scan-offline-build.mjs check that). Offline mode has its own local save, made on this PC at install;
// nothing is downloaded into it.

use serde::Serialize;
use serde_json::{json, Value};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::thread;
use tauri::{AppHandle, Manager};
use tauri_plugin_opener::OpenerExt;

use super::mode::{self, ModeState};
use super::paths;
use super::rates::{self, OfflineRates};
use super::stack::{self, EXIT_CLIENT_RUNNING};

/// One offline action at a time (start, stop, install ...): the scripts are not meant to run side by side.
static ACTION_LOCK: Mutex<()> = Mutex::new(());

fn busy() -> String {
    "Another offline action is still running. Wait for it to finish.".to_string()
}

async fn blocking<T, F>(f: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, String> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|_| "The offline task stopped unexpectedly.".to_string())?
}

fn locked<T>(f: impl FnOnce() -> Result<T, String>) -> Result<T, String> {
    let _guard = ACTION_LOCK.try_lock().map_err(|_| busy())?;
    f()
}

/// The scripts ship with the launcher (bundle resources, folder "offline"). A debug build also finds them in the repo.
fn script(app: &AppHandle, name: &str) -> Result<PathBuf, String> {
    if let Ok(dir) = app.path().resource_dir() {
        let p = dir.join("offline").join(name);
        if p.is_file() {
            return Ok(PathBuf::from(paths::plain(&p)));
        }
    }
    #[cfg(debug_assertions)]
    {
        let p = Path::new(env!("CARGO_MANIFEST_DIR")).join("..").join("..").join("scripts").join("offline").join(name);
        if p.is_file() {
            return Ok(p);
        }
    }
    Err("The offline scripts are missing from this launcher. Reinstall the launcher.".to_string())
}

fn root(app: &AppHandle) -> Result<PathBuf, String> {
    paths::offline_root(app)
}

fn mode_file(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    Ok(dir.join(mode::MODE_FILE))
}

fn require_configured(root: &Path) -> Result<(), String> {
    if !paths::offline_env_file(root).is_file() || !paths::offline_game_exe(root).is_file() {
        return Err("Offline mode is not installed yet. Press \"Install offline\" first.".to_string());
    }
    Ok(())
}

fn run_stack(app: &AppHandle, action: &str, extra: &[String]) -> Result<Option<Value>, String> {
    let root = root(app)?;
    require_configured(&root)?;
    let mut args = stack::stack_args(&root, action);
    args.extend_from_slice(extra);
    stack::run_ok(&script(app, "offline-stack.ps1")?, &args, &paths::logs_dir(&root), action)
}

// ---- mode and notice ------------------------------------------------------------------------------------------

#[tauri::command]
pub fn offline_get_mode(app: AppHandle) -> Result<ModeState, String> {
    Ok(mode::read(&mode_file(&app)?))
}

#[tauri::command]
pub fn offline_accept_notice(app: AppHandle) -> Result<ModeState, String> {
    let file = mode_file(&app)?;
    let state = ModeState { notice_accepted: true, ..mode::read(&file) };
    mode::write(&file, &state)?;
    Ok(state)
}

#[tauri::command]
pub fn offline_set_mode(app: AppHandle, mode: String) -> Result<ModeState, String> {
    let file = mode_file(&app)?;
    let state = mode::with_mode(&mode::read(&file), &mode)?;
    mode::write(&file, &state)?;
    Ok(state)
}

// ---- install progress (one state for the whole "Install offline") ----------------------------------------------

/// The single progress state of "Install offline" (also written to install-state.json).
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct InstallState {
    /// "idle", "running", "done" or "failed"
    pub phase: String,
    pub step: u8,
    pub steps: u8,
    pub message: String,
    pub error: Option<String>,
}

const INSTALL_STEPS: u8 = 3;
const MSG_COPY: &str = "Copying your game for offline play. This can take a few minutes.";
const MSG_READY: &str = "Getting offline mode ready.";
const MSG_SAVE: &str = "Creating your offline save.";
const MSG_DONE: &str = "Offline mode is ready.";

impl InstallState {
    fn idle() -> Self {
        InstallState { phase: "idle".into(), step: 0, steps: INSTALL_STEPS, message: String::new(), error: None }
    }
    fn running(step: u8, message: &str) -> Self {
        InstallState { phase: "running".into(), step, steps: INSTALL_STEPS, message: message.to_string(), error: None }
    }
    fn done() -> Self {
        InstallState { phase: "done".into(), step: INSTALL_STEPS, steps: INSTALL_STEPS, message: MSG_DONE.into(), error: None }
    }
    fn failed(step: u8, error: String) -> Self {
        InstallState { phase: "failed".into(), step, steps: INSTALL_STEPS, message: String::new(), error: Some(error) }
    }
}

static INSTALL: Mutex<Option<InstallState>> = Mutex::new(None);

fn install_state() -> InstallState {
    INSTALL.lock().ok().and_then(|g| g.clone()).unwrap_or_else(InstallState::idle)
}

fn set_install_state(root: &Path, state: InstallState) {
    if let Ok(mut g) = INSTALL.lock() {
        *g = Some(state.clone());
    }
    if let Ok(text) = serde_json::to_string(&state) {
        let _ = rates::write_atomic(&paths::install_state_file(root), text.as_bytes());
    }
}

#[tauri::command]
pub fn offline_install_state() -> InstallState {
    install_state()
}

// ---- overview -------------------------------------------------------------------------------------------------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OfflineOverview {
    pub root: String,
    pub logs_dir: String,
    /// The one-time install finished: separate game folder, local save and offline servers all worked once.
    pub installed: bool,
    /// The launcher knows where the player's own online RR game is (the installer copies it).
    pub online_game_found: bool,
    /// The offline files (offline DLL, programs, local data engine) are available to install from.
    pub component_found: bool,
    pub install: InstallState,
}

/// The offline files: RamsgateRebornOffline.dll, bundle\ (programs + node) and mongod.exe.
fn component_ok(dir: &Path) -> bool {
    dir.join("RamsgateRebornOffline.dll").is_file()
        && dir.join("bundle").join("offline-backend.js").is_file()
        && dir.join("mongod.exe").is_file()
}

/// First place that holds the offline files: the offline folder's own copy, then the launcher's resources.
fn find_component(app: &AppHandle, root: &Path) -> Option<PathBuf> {
    let local = paths::local_component_dir(root);
    if component_ok(&local) {
        return Some(local);
    }
    let shipped = app.path().resource_dir().ok()?.join("offline-component");
    component_ok(&shipped).then_some(shipped)
}

#[tauri::command]
pub fn offline_overview(app: AppHandle) -> Result<OfflineOverview, String> {
    let root = root(&app)?;
    Ok(OfflineOverview {
        root: root.to_string_lossy().to_string(),
        logs_dir: paths::logs_dir(&root).to_string_lossy().to_string(),
        installed: paths::install_ok_file(&root).is_file() && paths::offline_game_exe(&root).is_file(),
        online_game_found: crate::install::paths::load_saved_exe_path(&app).map(|p| p.is_file()).unwrap_or(false),
        component_found: find_component(&app, &root).is_some(),
        install: install_state(),
    })
}

// ---- install --------------------------------------------------------------------------------------------------

/// sha256 of the offline DLL, compiled in from the component manifest at build time (empty when built without a component).
const PINNED_DLL_SHA256: &str = env!("RR_OFFLINE_DLL_SHA256");
/// sha256 of manifest.json itself, compiled in at build time (empty when built without a component).
const PINNED_MANIFEST_SHA256: &str = env!("RR_OFFLINE_MANIFEST_SHA256");

fn pin_args(pin: &str) -> Result<Vec<String>, String> {
    if pin.len() != 64 {
        return Err("This launcher build has no pinned offline files, so offline setup is refused.".to_string());
    }
    let mut args = vec!["-ExpectedDllSha256".to_string(), pin.to_string()];
    // The manifest itself is pinned too, so the mongod, node and program hashes it lists cannot be swapped along with the files.
    if PINNED_MANIFEST_SHA256.len() == 64 {
        args.push("-ExpectedManifestSha256".to_string());
        args.push(PINNED_MANIFEST_SHA256.to_string());
    }
    Ok(args)
}

/// The whole install in one go: copy the installed game into the separate offline folder, make the local
/// save, start the offline servers. Runs in the background; the UI polls offline_install_state. It never touches the
/// online game folder and never contacts anything.
fn run_install(app: &AppHandle) -> Result<(), (u8, String)> {
    let root = root(app).map_err(|e| (1, e))?;
    let logs = paths::logs_dir(&root);
    let component = find_component(app, &root).ok_or((1, "The offline files are not part of this launcher build yet.".to_string()))?;
    let game_exe = crate::install::paths::load_saved_exe_path(app)
        .filter(|p| p.is_file())
        .ok_or((1, "Install the game first (Play tab): offline mode uses a separate copy of your installed game.".to_string()))?;
    if paths::is_within(&game_exe, &root) {
        return Err((1, "The online game can't be inside the offline folder.".to_string()));
    }
    let _ = fs::remove_file(paths::install_ok_file(&root));

    set_install_state(&root, InstallState::running(1, MSG_COPY));
    let mut args = vec![
        "-GameExe".to_string(),
        paths::plain(&game_exe),
        "-OfflineDll".to_string(),
        paths::plain(&component.join("RamsgateRebornOffline.dll")),
        "-BundleDir".to_string(),
        paths::plain(&component.join("bundle")),
        "-MongodExe".to_string(),
        paths::plain(&component.join("mongod.exe")),
        "-OfflineRoot".to_string(),
        paths::plain(&root),
    ];
    args.extend(pin_args(PINNED_DLL_SHA256).map_err(|e| (1, e))?);
    args.push("-ComponentDir".to_string());
    args.push(paths::plain(&component));
    let data = component.join("game-data");
    if data.is_dir() {
        args.push("-GameDataDir".to_string());
        args.push(paths::plain(&data));
    }
    stack::run_ok(&script(app, "install-offline.ps1").map_err(|e| (1, e))?, &args, &logs, "Offline setup").map_err(|e| (1, e))?;

    set_install_state(&root, InstallState::running(2, MSG_READY));
    run_stack(app, "Start", &[]).map_err(|e| (2, e))?;

    set_install_state(&root, InstallState::running(3, MSG_SAVE));
    run_stack(app, "Seed", &[]).map_err(|e| (3, e))?;

    fs::write(paths::install_ok_file(&root), b"ok").map_err(|e| (3, format!("Couldn't finish the install: {e}")))?;
    set_install_state(&root, InstallState::done());
    Ok(())
}

/// "Install offline": the one button. Returns at once with the running state; the work continues in the background.
#[tauri::command]
pub fn offline_install(app: AppHandle) -> Result<InstallState, String> {
    {
        let mut g = INSTALL.lock().map_err(|_| busy())?;
        if g.as_ref().map(|s| s.phase == "running").unwrap_or(false) {
            return Err(busy());
        }
        *g = Some(InstallState::running(1, "Starting."));
    }
    let worker_app = app.clone();
    thread::spawn(move || {
        let outcome = match ACTION_LOCK.lock() {
            Ok(_guard) => run_install(&worker_app),
            Err(_) => Err((1, busy())),
        };
        if let Err((step, error)) = outcome {
            let failed = InstallState::failed(step, error);
            match root(&worker_app) {
                Ok(r) => set_install_state(&r, failed),
                Err(_) => {
                    if let Ok(mut g) = INSTALL.lock() {
                        *g = Some(failed);
                    }
                }
            }
        }
    });
    Ok(install_state())
}

// ---- servers and play -----------------------------------------------------------------------------------------

#[tauri::command]
pub async fn offline_status(app: AppHandle) -> Result<Value, String> {
    blocking(move || {
        let root = root(&app)?;
        if require_configured(&root).is_err() {
            return Ok(json!({ "configured": false }));
        }
        // Status only reads process state, so it does not take the action lock.
        Ok(run_stack(&app, "Status", &[])?.unwrap_or(Value::Null))
    })
    .await
}

#[tauri::command]
pub async fn offline_start(app: AppHandle) -> Result<Value, String> {
    blocking(move || locked(|| Ok(run_stack(&app, "Start", &[])?.unwrap_or(Value::Null)))).await
}

#[tauri::command]
pub async fn offline_stop(app: AppHandle) -> Result<Value, String> {
    blocking(move || locked(|| Ok(run_stack(&app, "Stop", &[])?.unwrap_or(Value::Null)))).await
}

#[tauri::command]
pub async fn offline_restart(app: AppHandle) -> Result<Value, String> {
    blocking(move || locked(|| Ok(run_stack(&app, "Restart", &[])?.unwrap_or(Value::Null)))).await
}

/// "Play offline": starts the offline servers if needed, then the game from the offline folder with the local save.
#[tauri::command]
pub async fn offline_play(app: AppHandle) -> Result<Value, String> {
    blocking(move || {
        locked(|| {
            let root = root(&app)?;
            if !paths::install_ok_file(&root).is_file() {
                return Err("Offline mode is not installed yet. Press \"Install offline\" first.".to_string());
            }
            run_stack(&app, "Start", &[])?;
            run_stack(&app, "Seed", &[])?;
            Ok(run_stack(&app, "Play", &[])?.unwrap_or(Value::Null))
        })
    })
    .await
}

// ---- load the player's online save (read-only copy, one way down) -----------------------------------------------

/// The importer checks the downloaded copy's Ed25519 signature against the public key built into the offline bundle and
/// refuses anything it does not verify; there is no unsigned option.
pub fn import_args(file: &Path) -> Vec<String> {
    vec!["-SaveFile".to_string(), paths::plain(file)]
}

/// "Load my online save": fills the local offline save from the downloaded copy named `file_name` (the launcher's separate
/// download command saved it). Reads that one file, writes the local offline save only, and sends nothing anywhere. The
/// current offline save is backed up first. Refused while the offline game runs.
#[tauri::command]
pub async fn offline_import_save(app: AppHandle, file_name: String) -> Result<Value, String> {
    blocking(move || {
        locked(|| {
            if !paths::is_saved_copy_name(&file_name) {
                return Err("That is not a saved copy of your online save.".to_string());
            }
            let root = root(&app)?;
            require_configured(&root)?;
            let base = app.path().local_data_dir().map_err(|e| format!("Couldn't locate the saved copy: {e}"))?;
            let file = paths::online_save_downloads_under(&base).join(&file_name);
            if !file.is_file() {
                return Err("The saved copy of your online save was not found. Download it again.".to_string());
            }
            let mut args = stack::stack_args(&root, "ImportSave");
            args.extend(import_args(&file));
            let out = stack::run_script(&script(&app, "offline-stack.ps1")?, &args, &paths::logs_dir(&root))?;
            match out.code {
                0 => Ok(out.json.unwrap_or(Value::Null)),
                EXIT_CLIENT_RUNNING => Err("Close the offline game first, then load your online save.".to_string()),
                c => Err(out.message.unwrap_or_else(|| format!("Loading your online save failed (exit {c}). See the offline log folder."))),
            }
        })
    })
    .await
}

// ---- launcher start: nothing from an earlier run is left behind --------------------------------------------------

/// Called once when the launcher starts: creates the process group every offline script is added to (so the offline
/// processes end with the launcher) and ends offline processes an earlier run left behind. Only programs inside the offline
/// folder are matched. Runs in the background; the launcher does not wait for it.
pub fn start_lifetime_guard(app: &AppHandle) {
    let _ = super::lifetime::offline_job();
    let Ok(root) = root(app) else { return };
    if !root.is_dir() {
        return;
    }
    thread::spawn(move || {
        // Do not run next to an offline action that is just starting.
        let Ok(_guard) = ACTION_LOCK.lock() else { return };
        let ended = super::lifetime::sweep_leftovers(&root);
        if !ended.is_empty() {
            stack::log_line(&paths::logs_dir(&root), &format!("ended {} leftover offline process(es) from an earlier run", ended.len()));
        }
    });
}

// ---- rates ----------------------------------------------------------------------------------------------------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RatesView {
    pub rates: OfflineRates,
    pub source: String,
    pub warnings: Vec<String>,
}

#[tauri::command]
pub fn offline_get_rates(app: AppHandle) -> Result<RatesView, String> {
    let r = rates::read(&paths::rates_file(&root(&app)?));
    Ok(RatesView { rates: r.rates, source: r.source.to_string(), warnings: r.warnings })
}

/// Validates, clamps and writes rates.json atomically. The offline backend re-reads it within a few seconds.
#[tauri::command]
pub fn offline_save_rates(app: AppHandle, rates: OfflineRates) -> Result<RatesView, String> {
    let (_, notes) = rates::clamp(&rates);
    let written = rates::save(&paths::rates_file(&root(&app)?), &rates)?;
    Ok(RatesView { rates: written, source: "file".to_string(), warnings: notes })
}

#[tauri::command]
pub fn offline_reset_rates(app: AppHandle) -> Result<RatesView, String> {
    let written = rates::save(&paths::rates_file(&root(&app)?), &OfflineRates::official())?;
    Ok(RatesView { rates: written, source: "file".to_string(), warnings: Vec::new() })
}

/// "Apply now": restarts the offline director so new hub servers read the rates. Refused while the offline game runs.
#[tauri::command]
pub async fn offline_apply_rates(app: AppHandle) -> Result<Value, String> {
    blocking(move || {
        locked(|| {
            let root = root(&app)?;
            require_configured(&root)?;
            let args = stack::stack_args(&root, "ApplyRates");
            let out = stack::run_script(&script(&app, "offline-stack.ps1")?, &args, &paths::logs_dir(&root))?;
            match out.code {
                0 => Ok(out.json.unwrap_or(Value::Null)),
                EXIT_CLIENT_RUNNING => Ok(json!({ "applied": false, "reason": "client-running" })),
                c => Err(out.message.unwrap_or_else(|| format!("Applying the rates failed (exit {c}).")) ),
            }
        })
    })
    .await
}

// ---- logs -----------------------------------------------------------------------------------------------------

/// Offline has no crash report: it opens the offline log folder instead. Offline logs stay on this PC.
#[tauri::command]
pub fn offline_open_log_folder(app: AppHandle) -> Result<(), String> {
    let logs = paths::logs_dir(&root(&app)?);
    fs::create_dir_all(&logs).map_err(|e| format!("Couldn't create the offline log folder: {e}"))?;
    app.opener()
        .open_path(logs.to_string_lossy().to_string(), None::<&str>)
        .map_err(|_| "Couldn't open the offline log folder.".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn install_states_have_one_shape() {
        let idle = InstallState::idle();
        assert_eq!((idle.phase.as_str(), idle.step, idle.steps), ("idle", 0, INSTALL_STEPS));
        let r = InstallState::running(2, "x");
        assert_eq!((r.phase.as_str(), r.step), ("running", 2));
        assert_eq!(InstallState::done().step, INSTALL_STEPS);
        let f = InstallState::failed(1, "no".into());
        assert_eq!(f.phase, "failed");
        assert_eq!(f.error.as_deref(), Some("no"));
    }

    #[test]
    fn player_facing_messages_use_no_database_words() {
        for s in [MSG_COPY, MSG_READY, MSG_SAVE, MSG_DONE] {
            let l = s.to_ascii_lowercase();
            assert!(!l.contains("mongo") && !l.contains("database") && !l.contains("replica"), "{s}");
        }
    }

    #[test]
    fn only_a_downloaded_copy_name_is_accepted() {
        assert!(paths::is_saved_copy_name("online-save-1761912000.rrsave"));
        for bad in [
            "", "online-save-.rrsave", "online-save-1.rrsnap", "../online-save-1.rrsave", "online-save-1/../x.rrsave",
            r"C:\x\online-save-1.rrsave", "online-save-12a.rrsave", "save.rrsave", "online-save-1.rrsave.exe",
        ] {
            assert!(!paths::is_saved_copy_name(bad), "{bad}");
        }
    }

    #[test]
    fn import_args_carry_one_local_file_and_nothing_else() {
        let a = import_args(Path::new(r"C:\U\RamsgateReborn\online-save-downloads\online-save-5.rrsave"));
        assert_eq!(a[0], "-SaveFile");
        assert!(a[1].ends_with("online-save-5.rrsave"));
        assert!(a.iter().all(|x| !x.contains("://")));
        assert_eq!(a.len(), 2);
        assert!(!a.iter().any(|x| x.to_lowercase().contains("unsigned")));
    }

    #[test]
    fn install_is_refused_without_a_pinned_dll_hash() {
        assert!(pin_args("").is_err());
        assert!(pin_args("abc").is_err());
        let h = "c78b3cf47358a13b29af2d4129e934c97b64edb5688ec1891bd6cb108dd0917b";
        assert_eq!(pin_args(h).unwrap()[..2], ["-ExpectedDllSha256".to_string(), h.to_string()]);
    }

    #[test]
    fn component_needs_dll_programs_and_engine() {
        let d = std::env::temp_dir().join(format!("rr38-comp-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(d.join("bundle")).unwrap();
        assert!(!component_ok(&d));
        fs::write(d.join("RamsgateRebornOffline.dll"), b"x").unwrap();
        fs::write(d.join("bundle").join("offline-backend.js"), b"x").unwrap();
        assert!(!component_ok(&d));
        fs::write(d.join("mongod.exe"), b"x").unwrap();
        assert!(component_ok(&d));
        fs::remove_dir_all(&d).unwrap();
    }
}
