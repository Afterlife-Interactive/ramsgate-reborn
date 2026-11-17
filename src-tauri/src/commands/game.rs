//! Downloads the Dauntless 1.12.0 game files from the Ramsgate Reborn server, for players who don't have the
//! game yet. The server only offers this when an administrator has published an archive (see the backend's
//! routes/gameDownload.ts). The archive is resumable, checked against a SHA-256 from the manifest before
//! anything is unpacked, and unpacked with Windows' own tar.exe.

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs::{self, OpenOptions};
use std::io::{BufReader, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};
use windows_sys::Win32::Storage::FileSystem::{GetDiskFreeSpaceExW, GetDriveTypeW, GetLogicalDrives};

use crate::commands::auth::{api_base_url, refresh_native_session};
use crate::install::paths;

const PROGRESS_EVENT: &str = "game-download-progress";
const MAX_ATTEMPTS: u32 = 30;
pub(crate) static RUNNING: AtomicBool = AtomicBool::new(false);

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GameManifest {
    pub version: String,
    pub file_name: String,
    pub size: u64,
    pub sha256: String,
    pub format: String,
    /// Ed25519 signature (base64) by the pinned runtime update key over `game_manifest_message`. Without it the
    /// archive hash came only from the same server that serves the archive.
    #[serde(default)]
    pub signature: Option<String>,
}

/// The exact bytes the game manifest signature covers (see RamsgateLauncher/scripts/sign-game-manifest.mjs).
pub(crate) fn game_manifest_message(m: &GameManifest) -> String {
    format!("ramsgate-game-archive-v1\n{}\n{}\n{}\n{}\n{}", m.version, m.file_name, m.size, m.sha256.to_ascii_lowercase(), m.format)
}

/// Builds with MYSTPAX_REQUIRE_GAME_SIGNATURE=1 refuse an unsigned manifest. Until the published manifest is
/// signed the default build accepts one without a signature, but always refuses a signature that does not verify.
fn game_signature_required() -> bool {
    matches!(option_env!("MYSTPAX_REQUIRE_GAME_SIGNATURE"), Some("1") | Some("true"))
}

pub(crate) fn check_game_manifest_signature(m: &GameManifest, public_key_b64: &str, required: bool) -> Result<(), String> {
    use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
    use ed25519_dalek::{Signature, Verifier, VerifyingKey};
    let Some(sig_b64) = m.signature.as_deref().filter(|s| !s.is_empty()) else {
        return if required { Err("The server's game download is not signed.".to_string()) } else { Ok(()) };
    };
    let sig_bytes = BASE64.decode(sig_b64).map_err(|_| "The game download signature is invalid.".to_string())?;
    let sig = Signature::from_slice(&sig_bytes).map_err(|_| "The game download signature is invalid.".to_string())?;
    // The key setting may list several keys, comma separated, while a key is being rotated.
    let mut usable_keys = 0;
    for encoded in public_key_b64.split(',') {
        let Some(public) = BASE64.decode(encoded.trim()).ok().and_then(|b| <[u8; 32]>::try_from(b).ok()) else { continue };
        let Ok(key) = VerifyingKey::from_bytes(&public) else { continue };
        usable_keys += 1;
        if key.verify(game_manifest_message(m).as_bytes(), &sig).is_ok() {
            return Ok(());
        }
    }
    if usable_keys == 0 {
        return Err("The launcher's signing key is invalid.".to_string());
    }
    Err("The game download signature does not match. Not downloading.".to_string())
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Progress {
    phase: &'static str,
    received: u64,
    total: u64,
    /// Where the game is being installed, so the UI can say so.
    folder: String,
    /// Smoothed download speed and the time left at that speed; absent until a speed is known.
    bytes_per_second: Option<u64>,
    seconds_left: Option<u64>,
}

fn emit(app: &AppHandle, folder: &Path, phase: &'static str, received: u64, total: u64) {
    emit_progress(app, folder, phase, received, total, None);
}

fn emit_progress(app: &AppHandle, folder: &Path, phase: &'static str, received: u64, total: u64, speed: Option<f64>) {
    let _ = app.emit(
        PROGRESS_EVENT,
        Progress {
            phase,
            received,
            total,
            folder: folder.to_string_lossy().into_owned(),
            bytes_per_second: speed.map(|s| s as u64),
            seconds_left: speed.and_then(|s| seconds_left(total.saturating_sub(received), s)),
        },
    );
}

/// Smooths the download speed so the number on screen does not jump with every chunk. An exponential moving average
/// over the roughly 300 ms progress ticks (about a three second memory).
struct SpeedMeter {
    last_bytes: u64,
    average: Option<f64>,
}

impl SpeedMeter {
    fn new(start_bytes: u64) -> Self {
        Self { last_bytes: start_bytes, average: None }
    }

    /// `bytes` is the total received so far, `elapsed` the time since the previous sample.
    fn sample(&mut self, bytes: u64, elapsed: Duration) -> Option<f64> {
        let seconds = elapsed.as_secs_f64();
        if seconds <= 0.0 {
            return self.average;
        }
        let instant = bytes.saturating_sub(self.last_bytes) as f64 / seconds;
        self.last_bytes = bytes;
        self.average = Some(match self.average {
            None => instant,
            Some(previous) => previous * 0.9 + instant * 0.1,
        });
        self.average
    }
}

/// Whole seconds left at `speed` bytes per second. None when the speed is too low to say anything useful.
fn seconds_left(remaining: u64, speed: f64) -> Option<u64> {
    if speed < 1024.0 {
        return None;
    }
    Some((remaining as f64 / speed).ceil() as u64)
}

fn client() -> Result<reqwest::blocking::Client, String> {
    // No overall timeout: the archive is many GB. TCP keepalive notices a dead connection instead.
    reqwest::blocking::Client::builder()
        .redirect(crate::commands::auth::download_redirects())
        .connect_timeout(Duration::from_secs(8))
        .timeout(None::<Duration>)
        .tcp_keepalive(Duration::from_secs(30))
        .build()
        .map_err(|_| "Couldn't prepare the download connection.".to_string())
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// A manifest file name is one plain file name; nothing from the server may reach outside the chosen folder.
fn is_plain_file_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 120
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '_' || c == '-')
        && !name.starts_with('.')
}

const GIB: u64 = 1024 * 1024 * 1024;
const INSTALL_SUBFOLDER: [&str; 2] = ["Ramsgate Reborn", "Game"];

/// Fixed local drives with how much space is free on each, most free first.
pub(crate) fn fixed_drives_by_free_space() -> Vec<(PathBuf, u64)> {
    let mut drives = Vec::new();
    // SAFETY: plain Win32 queries with NUL-terminated wide strings and valid out pointers.
    unsafe {
        let mask = GetLogicalDrives();
        for index in 0..26u8 {
            if mask & (1 << index) == 0 {
                continue;
            }
            let root = format!("{}:\\", (b'A' + index) as char);
            let wide: Vec<u16> = root.encode_utf16().chain(std::iter::once(0)).collect();
            if GetDriveTypeW(wide.as_ptr()) != 3 {
                continue; // 3 = DRIVE_FIXED: skip removable, network and optical drives
            }
            let mut free = 0u64;
            if GetDiskFreeSpaceExW(wide.as_ptr(), &mut free, std::ptr::null_mut(), std::ptr::null_mut()) != 0 {
                drives.push((PathBuf::from(root), free));
            }
        }
    }
    drives.sort_by(|a, b| b.1.cmp(&a.1));
    drives
}

/// Picks (and creates) the install folder without asking: an unfinished download's folder if there is one, otherwise
/// `<drive>\Ramsgate Reborn\Game` on the fixed drive with the most free space. The archive and the unpacked game
/// exist side by side for a while, so about twice the archive size is needed.
fn choose_install_folder(manifest: &GameManifest) -> Result<PathBuf, String> {
    let drives = fixed_drives_by_free_space();
    let sub: PathBuf = INSTALL_SUBFOLDER.iter().collect();
    let part_name = format!("{}.part", manifest.file_name);

    for (root, _) in &drives {
        let folder = root.join(&sub);
        if folder.join(&part_name).is_file() {
            return Ok(folder); // resume where the last attempt stopped
        }
    }

    let needed = manifest.size.saturating_mul(2).saturating_add(2 * GIB);
    for (root, free) in &drives {
        if *free < needed {
            continue;
        }
        let folder = root.join(&sub);
        if fs::create_dir_all(&folder).is_ok() {
            return Ok(folder);
        }
    }

    Err(format!(
        "There isn't enough free disk space. The game needs about {} GB free on one drive while it installs.",
        needed / GIB + 1
    ))
}

fn fetch_manifest(access_token: &str) -> Result<Option<GameManifest>, String> {
    let response = client()?
        .get(format!("{}/launcher/v1/game/manifest", api_base_url()))
        .bearer_auth(access_token)
        .timeout(Duration::from_secs(15))
        .send()
        .map_err(|_| "Couldn't reach the Ramsgate Reborn server.".to_string())?;
    if response.status().as_u16() == 404 {
        return Ok(None);
    }
    if !response.status().is_success() {
        return Err(format!("The server refused the request (status {}).", response.status().as_u16()));
    }
    let manifest: GameManifest = response
        .json()
        .map_err(|_| "The server sent an unreadable download description.".to_string())?;
    if manifest.format != "tar" || !is_plain_file_name(&manifest.file_name) || manifest.size == 0 || manifest.sha256.len() != 64 {
        return Err("The server's download description isn't valid.".to_string());
    }
    check_game_manifest_signature(&manifest, crate::commands::updates::runtime_update_public_key_b64(), game_signature_required())?;
    Ok(Some(manifest))
}

/// Tells the UI whether the server offers the game. Never an error the player has to act on.
#[tauri::command]
pub async fn native_game_manifest(app: AppHandle) -> Result<Option<GameManifest>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let session = refresh_native_session(&app)?;
        fetch_manifest(&session.access_token)
    })
    .await
    .map_err(|_| "The task stopped unexpectedly.".to_string())?
}

/// Hashes the bytes already on disk so a resumed download keeps a single running hash.
fn hash_existing(part: &Path, hasher: &mut Sha256) -> Result<u64, String> {
    let mut file = fs::File::open(part).map_err(|e| format!("Couldn't read the partial download: {e}"))?;
    let mut buffer = vec![0u8; 1 << 20];
    let mut total = 0u64;
    loop {
        let read = file.read(&mut buffer).map_err(|e| format!("Couldn't read the partial download: {e}"))?;
        if read == 0 {
            return Ok(total);
        }
        hasher.update(&buffer[..read]);
        total += read as u64;
    }
}

/// One download attempt from the current end of the part file. Returns Ok(true) once every byte has arrived.
fn attempt(app: &AppHandle, folder: &Path, manifest: &GameManifest, part: &Path, hasher: &mut Sha256, offset: &mut u64) -> Result<bool, String> {
    let session = refresh_native_session(app)?;
    let mut request = client()?
        .get(format!("{}/launcher/v1/game/download", api_base_url()))
        .bearer_auth(&session.access_token);
    if *offset > 0 {
        request = request.header("Range", format!("bytes={}-", *offset));
    }
    let mut response = request
        .send()
        .map_err(|_| "Lost the connection to the server.".to_string())?;

    let status = response.status().as_u16();
    if status == 416 && *offset >= manifest.size {
        return Ok(true);
    }
    if status == 503 {
        return Err("The server is busy with other downloads. Retrying…".to_string());
    }
    if status != 200 && status != 206 {
        return Err(format!("The server refused the download (status {status})."));
    }
    if status == 200 && *offset > 0 {
        // The server ignored the range: start over rather than splice two different byte streams together.
        *offset = 0;
        *hasher = Sha256::new();
        fs::remove_file(part).ok();
    }

    let mut file = OpenOptions::new()
        .create(true)
        .write(true)
        .open(part)
        .map_err(|e| format!("Couldn't write to the download folder: {e}"))?;
    file.seek(SeekFrom::Start(*offset)).map_err(|e| format!("Couldn't write to the download folder: {e}"))?;

    let mut buffer = vec![0u8; 1 << 20];
    let mut last_emit = Instant::now();
    let mut meter = SpeedMeter::new(*offset);
    loop {
        let read = response
            .read(&mut buffer)
            .map_err(|_| "Lost the connection to the server.".to_string())?;
        if read == 0 {
            break;
        }
        file.write_all(&buffer[..read]).map_err(|e| format!("Couldn't write to the download folder: {e}"))?;
        hasher.update(&buffer[..read]);
        *offset += read as u64;
        if *offset > manifest.size {
            return Err("The server sent more data than expected.".to_string());
        }
        if last_emit.elapsed() >= Duration::from_millis(300) {
            let speed = meter.sample(*offset, last_emit.elapsed());
            emit_progress(app, folder, "downloading", *offset, manifest.size, speed);
            last_emit = Instant::now();
        }
    }
    file.flush().ok();
    Ok(*offset == manifest.size)
}

/// Counts the bytes the unpacker has read from the archive, which is the progress of the unpack.
struct CountingReader<R> {
    inner: R,
    count: Arc<AtomicU64>,
}

impl<R: Read> Read for CountingReader<R> {
    fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
        let read = self.inner.read(buffer)?;
        self.count.fetch_add(read as u64, Ordering::Relaxed);
        Ok(read)
    }
}

const MAX_UNPACKED_BYTES: u64 = 64 * 1024 * 1024 * 1024;

/// Unpacks a tar archive into `destination` inside this program (no external tool, so no console window), reporting
/// how many archive bytes have been consumed. An entry that would land outside `destination` aborts the unpack.
fn unpack_with_progress(archive: &Path, destination: &Path, mut on_progress: impl FnMut(u64)) -> Result<(), String> {
    let file = fs::File::open(archive).map_err(|e| format!("Couldn't open the downloaded archive: {e}"))?;
    let count = Arc::new(AtomicU64::new(0));
    let reader = CountingReader { inner: BufReader::with_capacity(1 << 20, file), count: count.clone() };
    let mut tar = tar::Archive::new(reader);
    let mut last = Instant::now();
    let mut unpacked: u64 = 0;

    for entry in tar.entries().map_err(|e| format!("The downloaded archive is unreadable: {e}"))? {
        let mut entry = entry.map_err(|e| format!("The downloaded archive is unreadable: {e}"))?;
        // Links can point outside the game folder and a later entry could write through them; the game archive has none.
        let kind = entry.header().entry_type();
        if kind.is_symlink() || kind.is_hard_link() {
            return Err("The downloaded archive contains a link, so it was not unpacked.".to_string());
        }
        unpacked += entry.size();
        if unpacked > MAX_UNPACKED_BYTES {
            return Err("The downloaded archive is larger than expected, so it was not unpacked.".to_string());
        }
        let inside = entry
            .unpack_in(destination)
            .map_err(|e| format!("Couldn't write a game file: {e}"))?;
        if !inside {
            return Err("The downloaded archive contains a file outside the game folder, so it was not unpacked.".to_string());
        }
        if last.elapsed() >= Duration::from_millis(300) {
            on_progress(count.load(Ordering::Relaxed));
            last = Instant::now();
        }
    }
    on_progress(count.load(Ordering::Relaxed));
    Ok(())
}

/// True when `archive` is a complete copy of what the manifest describes (right size, right SHA-256).
fn archive_matches(archive: &Path, manifest: &GameManifest) -> Result<bool, String> {
    let size = fs::metadata(archive).map(|m| m.len()).unwrap_or(0);
    if size != manifest.size {
        return Ok(false);
    }
    let mut hasher = Sha256::new();
    hash_existing(archive, &mut hasher)?;
    Ok(hex(&hasher.finalize()) == manifest.sha256.to_ascii_lowercase())
}

/// Unpacks a verified archive into the install folder, removes it, and remembers where the game is.
fn finish_install(app: &AppHandle, folder: &Path, archive: &Path, manifest: &GameManifest) -> Result<(), String> {
    emit(app, folder, "unpacking", 0, manifest.size);
    // The verbatim form (\\?\Q:\...) lets the unpacker create paths longer than the classic 260 characters.
    let destination = fs::canonicalize(folder).unwrap_or_else(|_| folder.to_path_buf());
    unpack_with_progress(archive, &destination, |bytes| emit(app, folder, "unpacking", bytes, manifest.size)).map_err(
        |message| format!("{message} The finished download is kept, so pressing Download again will not download it twice."),
    )?;
    fs::remove_file(archive).ok();

    let exe = paths::find_game_executable(folder)?;
    paths::save_managed_install(app, &exe, folder)?;
    emit(app, folder, "done", manifest.size, manifest.size);
    Ok(())
}

/// Looks for an already-unpacked game in the automatic install folder on each fixed drive. A half-finished unpack
/// keeps its complete archive, so a folder with the exe and no complete archive beside it is a finished install.
/// A leftover `.part` file only means a second download was started on top of a finished install, so it does not
/// count; it is removed when the existing game is used.
fn find_existing_install(manifest: &GameManifest) -> Option<(PathBuf, PathBuf)> {
    let sub: PathBuf = INSTALL_SUBFOLDER.iter().collect();
    for (root, _) in fixed_drives_by_free_space() {
        let folder = root.join(&sub);
        if !folder.is_dir() || folder.join(&manifest.file_name).is_file() {
            continue;
        }
        if let Ok(exe) = paths::find_game_executable(&folder) {
            fs::remove_file(folder.join(format!("{}.part", manifest.file_name))).ok();
            return Some((folder, exe));
        }
    }
    None
}

fn run_download(app: &AppHandle) -> Result<(), String> {
    let session = refresh_native_session(app)?;
    let manifest = fetch_manifest(&session.access_token)?
        .ok_or_else(|| "The server doesn't offer the game download right now.".to_string())?;
    // A game that is already unpacked in the install folder (an earlier run finished unpacking but could not
    // record the exe, or the player pressed Download again) is used as it is. Nothing is downloaded twice.
    if let Some((folder, exe)) = find_existing_install(&manifest) {
        paths::save_managed_install(app, &exe, &folder)?;
        emit(app, &folder, "done", manifest.size, manifest.size);
        return Ok(());
    }
    let folder = choose_install_folder(&manifest)?;

    let part = folder.join(format!("{}.part", manifest.file_name));
    let archive = folder.join(&manifest.file_name);

    // A finished archive left behind by an interrupted unpack: check it and unpack it instead of downloading 15 GB again.
    if archive.is_file() {
        emit(app, &folder, "verifying", manifest.size, manifest.size);
        if archive_matches(&archive, &manifest)? {
            return finish_install(app, &folder, &archive, &manifest);
        }
        fs::remove_file(&archive).ok();
    }

    let mut hasher = Sha256::new();
    let mut offset = if part.is_file() { hash_existing(&part, &mut hasher)? } else { 0 };
    if offset > manifest.size {
        fs::remove_file(&part).ok();
        hasher = Sha256::new();
        offset = 0;
    }
    emit(app, &folder, "downloading", offset, manifest.size);

    let mut attempts = 0u32;
    loop {
        match attempt(app, &folder, &manifest, &part, &mut hasher, &mut offset) {
            Ok(true) => break,
            Ok(false) | Err(_) if attempts + 1 < MAX_ATTEMPTS => {
                attempts += 1;
                std::thread::sleep(Duration::from_secs(5));
            }
            Ok(false) => return Err("The download kept stopping early. Run it again to resume.".to_string()),
            Err(message) => return Err(format!("{message} Run the download again to resume.")),
        }
    }

    emit(app, &folder, "verifying", manifest.size, manifest.size);
    if hex(&hasher.finalize()) != manifest.sha256.to_ascii_lowercase() {
        fs::remove_file(&part).ok();
        return Err("The downloaded file failed its integrity check and was deleted. Run the download again.".to_string());
    }
    fs::rename(&part, &archive).map_err(|e| format!("Couldn't finish the download: {e}"))?;

    finish_install(app, &folder, &archive, &manifest)
}

/// Downloads, verifies and unpacks the game into an automatically chosen folder. Resolves true when finished.
#[tauri::command]
pub async fn native_download_game(app: AppHandle) -> Result<bool, String> {
    if RUNNING.swap(true, Ordering::SeqCst) {
        return Err("A game download is already running.".to_string());
    }

    let result = tauri::async_runtime::spawn_blocking(move || run_download(&app))
        .await
        .map_err(|_| "The download task stopped unexpectedly.".to_string())
        .and_then(|inner| inner.map(|_| true));

    RUNNING.store(false, Ordering::SeqCst);
    result
}

#[cfg(test)]
mod tests {
    use super::{fixed_drives_by_free_space, hex, is_plain_file_name, seconds_left, unpack_with_progress, SpeedMeter};
    use super::{check_game_manifest_signature, game_manifest_message, GameManifest};

    #[test]
    fn game_manifest_signature_is_checked_against_the_pinned_key() {
        use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
        use ed25519_dalek::{Signer, SigningKey};
        let signer = SigningKey::from_bytes(&[7u8; 32]);
        let public = BASE64.encode(signer.verifying_key().to_bytes());
        let mut m = GameManifest {
            version: "1.12.0-392819".into(), file_name: "Dauntless-1.12.0.tar".into(), size: 123,
            sha256: "AB".repeat(32), format: "tar".into(), signature: None,
        };
        // Unsigned: allowed only while signatures are not required.
        assert!(check_game_manifest_signature(&m, &public, false).is_ok());
        assert!(check_game_manifest_signature(&m, &public, true).is_err());
        m.signature = Some(BASE64.encode(signer.sign(game_manifest_message(&m).as_bytes()).to_bytes()));
        assert!(check_game_manifest_signature(&m, &public, true).is_ok());
        // A swapped hash (the attack) no longer verifies, even when signatures are optional.
        m.sha256 = "cd".repeat(32);
        assert!(check_game_manifest_signature(&m, &public, false).is_err());
    }
    use std::time::Duration;

    #[test]
    fn accepts_plain_archive_names() {
        assert!(is_plain_file_name("Dauntless-1.12.0.tar"));
        assert!(is_plain_file_name("game_392819.tar"));
    }

    #[test]
    fn rejects_names_that_could_leave_the_folder() {
        assert!(!is_plain_file_name(""));
        assert!(!is_plain_file_name("..\\evil.tar"));
        assert!(!is_plain_file_name("a/b.tar"));
        assert!(!is_plain_file_name(".hidden"));
        assert!(!is_plain_file_name("C:evil.tar"));
    }

    #[test]
    fn hex_is_lowercase_and_padded() {
        assert_eq!(hex(&[0, 15, 255]), "000fff");
    }

    #[test]
    fn lists_this_machines_fixed_drives_most_free_first() {
        let drives = fixed_drives_by_free_space();
        assert!(!drives.is_empty(), "a Windows machine has at least one fixed drive");
        assert!(drives.windows(2).all(|pair| pair[0].1 >= pair[1].1));
        assert!(drives.iter().all(|(root, _)| root.to_string_lossy().ends_with(":\\")));
    }

    #[test]
    fn first_speed_sample_is_the_measured_rate() {
        let mut meter = SpeedMeter::new(0);
        // 3 MB in 0.3 s is 10 MB/s
        let speed = meter.sample(3_000_000, Duration::from_millis(300)).unwrap();
        assert!((speed - 10_000_000.0).abs() < 1.0);
    }

    #[test]
    fn speed_is_smoothed_not_jumpy() {
        let mut meter = SpeedMeter::new(0);
        meter.sample(3_000_000, Duration::from_millis(300)); // 10 MB/s
        // one very slow tick (0.3 MB in 0.3 s = 1 MB/s) must not drag the average down to 1 MB/s
        let speed = meter.sample(3_300_000, Duration::from_millis(300)).unwrap();
        assert!(speed > 8_000_000.0 && speed < 10_000_000.0, "got {speed}");
    }

    #[test]
    fn speed_meter_ignores_a_zero_length_tick() {
        let mut meter = SpeedMeter::new(0);
        assert_eq!(meter.sample(1_000, Duration::ZERO), None);
        meter.sample(3_000_000, Duration::from_millis(300));
        let before = meter.average;
        assert_eq!(meter.sample(4_000_000, Duration::ZERO), before);
    }

    #[test]
    fn a_resumed_download_measures_from_where_it_restarted() {
        // 5 GB already on disk must not count as a burst of speed
        let mut meter = SpeedMeter::new(5_000_000_000);
        let speed = meter.sample(5_003_000_000, Duration::from_millis(300)).unwrap();
        assert!((speed - 10_000_000.0).abs() < 1.0);
    }

    #[test]
    fn time_left_is_remaining_over_speed_rounded_up() {
        assert_eq!(seconds_left(10_000_000_000, 10_000_000.0), Some(1000));
        assert_eq!(seconds_left(1, 2048.0), Some(1));
        assert_eq!(seconds_left(0, 2048.0), Some(0));
    }

    #[test]
    fn no_time_left_estimate_when_speed_is_tiny() {
        assert_eq!(seconds_left(1_000_000, 100.0), None);
    }

    fn scratch_dir(tag: &str) -> std::path::PathBuf {
        let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
        let dir = std::env::temp_dir().join(format!("rr-unpack-{tag}-{}-{nanos}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn build_tar(entries: &[(&str, &[u8])]) -> Vec<u8> {
        let mut builder = tar::Builder::new(Vec::new());
        for (name, data) in entries {
            let mut header = tar::Header::new_gnu();
            header.set_size(data.len() as u64);
            header.set_mode(0o644);
            header.set_cksum();
            builder.append_data(&mut header, name, *data).unwrap();
        }
        builder.into_inner().unwrap()
    }

    #[test]
    fn unpacks_nested_files_and_reports_progress() {
        let dir = scratch_dir("ok");
        let archive = dir.join("game.tar");
        let bytes = build_tar(&[("Dauntless/Archon/a.txt", b"alpha"), ("Dauntless/b.bin", &[7u8; 4096])]);
        std::fs::write(&archive, &bytes).unwrap();
        let out = dir.join("out");
        std::fs::create_dir_all(&out).unwrap();

        let mut seen = Vec::new();
        unpack_with_progress(&archive, &out, |b| seen.push(b)).unwrap();

        assert_eq!(std::fs::read(out.join("Dauntless/Archon/a.txt")).unwrap(), b"alpha");
        assert_eq!(std::fs::read(out.join("Dauntless/b.bin")).unwrap().len(), 4096);
        assert!(seen.windows(2).all(|pair| pair[0] <= pair[1]), "progress must not go backwards");
        assert!(*seen.last().unwrap() > 0);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn refuses_an_entry_that_escapes_the_folder() {
        let dir = scratch_dir("escape");
        let out = dir.join("out");
        std::fs::create_dir_all(&out).unwrap();

        // A hand-made header: the builder itself refuses to write a ".." name.
        let mut builder = tar::Builder::new(Vec::new());
        let mut header = tar::Header::new_gnu();
        let name = b"../escaped.txt";
        header.as_old_mut().name[..name.len()].copy_from_slice(name);
        header.set_size(4);
        header.set_mode(0o644);
        header.set_cksum();
        builder.append(&header, &b"evil"[..]).unwrap();
        let archive = dir.join("evil.tar");
        std::fs::write(&archive, builder.into_inner().unwrap()).unwrap();

        let result = unpack_with_progress(&archive, &out, |_| {});
        assert!(result.is_err(), "an escaping entry must abort the unpack");
        assert!(!dir.join("escaped.txt").exists(), "nothing may be written outside the folder");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_missing_archive_is_an_error_not_a_panic() {
        let dir = scratch_dir("missing");
        assert!(unpack_with_progress(&dir.join("nope.tar"), &dir, |_| {}).is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
