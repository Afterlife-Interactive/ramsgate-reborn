use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use reqwest::{Client, Url};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::path::PathBuf;
use tauri::AppHandle;

use crate::commands::auth::refresh_native_session;
use crate::install::{paths, verify};
use crate::launch::process;

// Always send the signed-in session with runtime requests. A server may require an approved account for them
// (RUNTIME_REQUIRES_LOGIN in the backend); servers that don't ask simply ignore the header.
// refresh_native_session is blocking (reqwest::blocking), so it runs on a blocking thread
// even though this file otherwise uses the async reqwest client.
async fn bearer_token_for_channel(
    app: &AppHandle,
    channel: &str,
) -> Result<Option<String>, String> {
    let _ = channel;
    let app = app.clone();
    let session = tauri::async_runtime::spawn_blocking(move || refresh_native_session(&app))
        .await
        .map_err(|_| "The account session task stopped unexpectedly.".to_string())??;
    Ok(Some(session.access_token))
}

const DEFAULT_RUNTIME_ENDPOINT: &str = "http://127.0.0.1:3000/launcher/v1/runtime";
// No built-in default: a build must set MYSTPAX_RUNTIME_PUBLIC_KEY_B64 (one key, or old,new while rotating). Empty fails closed.
const DEFAULT_RUNTIME_UPDATE_PUBLIC_KEY_B64: &str = "";
const TARGET_CHANGELIST: u32 = 392819;

fn runtime_endpoint() -> &'static str {
    option_env!("MYSTPAX_RUNTIME_ENDPOINT").unwrap_or(DEFAULT_RUNTIME_ENDPOINT)
}

pub(crate) fn runtime_update_public_key_b64() -> &'static str {
    option_env!("MYSTPAX_RUNTIME_PUBLIC_KEY_B64").unwrap_or(DEFAULT_RUNTIME_UPDATE_PUBLIC_KEY_B64)
}

fn is_approved_runtime_url_for(endpoint: &str, candidate: &str) -> bool {
    let (Ok(endpoint), Ok(candidate)) = (Url::parse(endpoint), Url::parse(candidate)) else {
        return false;
    };
    // HTTPS, or plain HTTP to this PC's loopback backend (local-only builds).
    let secure_or_loopback = |url: &Url| {
        url.scheme() == "https"
            || (url.scheme() == "http" && matches!(url.host_str(), Some("127.0.0.1") | Some("localhost")))
    };
    secure_or_loopback(&candidate)
        && secure_or_loopback(&endpoint)
        && candidate.scheme() == endpoint.scheme()
        && candidate.host_str() == endpoint.host_str()
        && candidate.port_or_known_default() == endpoint.port_or_known_default()
}

fn is_approved_runtime_url(candidate: &str) -> bool {
    is_approved_runtime_url_for(runtime_endpoint(), candidate)
}
const MAX_RUNTIME_BYTES: usize = 200 * 1024 * 1024;
pub(crate) const RUNTIME_DLL_NAME: &str = "RamsgateReborn.dll";
pub(crate) const LEGACY_RUNTIME_DLL_NAME: &str = "RamsgateRebornServer.dll";
const RUNTIME_DLL_NAMES: [&str; 2] = [RUNTIME_DLL_NAME, LEGACY_RUNTIME_DLL_NAME];
const PRE_RENAME_RUNTIME_DLL_NAMES: [&str; 2] = ["MysticParadox.dll", "MystPaxInternalServer.dll"];

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RuntimeManifest {
    version: String,
    target_changelist: u32,
    size: usize,
    sha256: String,
    signature: String,
    url: String,
    #[serde(default)]
    extra_files: Vec<ExtraFile>,
    /// Patch paks to delete from the game's Content/Paks (rollback). Only names that pass `is_patch_pak_name`.
    #[serde(default)]
    remove_files: Vec<String>,
    /// Patch paks (RR-131 loading art) for Content/Paks. A separate list so launchers that do not know it ignore it
    /// instead of rejecting an unknown extra file name.
    #[serde(default)]
    patch_paks: Vec<ExtraFile>,
}

#[derive(Debug, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ExtraFile {
    name: String,
    size: usize,
    sha256: String,
    signature: String,
    url: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeUpdateStatus {
    pub available: bool,
    pub version: Option<String>,
    pub current_sha256: Option<String>,
    pub latest_sha256: Option<String>,
    pub size: Option<usize>,
}

fn manifest_url(channel: &str) -> Result<String, String> {
    if !matches!(channel, "stable" | "beta" | "dev") {
        return Err("Invalid runtime update channel.".to_string());
    }
    Ok(format!(
        "{}/{channel}/windows-x86_64",
        runtime_endpoint().trim_end_matches('/')
    ))
}

async fn fetch_manifest(
    channel: &str,
    token: Option<&str>,
) -> Result<Option<RuntimeManifest>, String> {
    let url = manifest_url(channel)?;
    let mut request = Client::builder()
        .redirect(crate::commands::auth::same_host_redirects())
        .timeout(std::time::Duration::from_secs(20))
        .build()
        .map_err(|e| {
            eprintln!("[runtime update] client build failed: {e}");
            "Can't reach the update server. Check your connection.".to_string()
        })?
        .get(&url);
    if let Some(token) = token {
        request = request.bearer_auth(token);
    }
    let response = request.send().await.map_err(|e| {
        eprintln!("[runtime update] fetch failed for {url}: {e}");
        "Can't reach the update server. Check your connection.".to_string()
    })?;
    if response.status().as_u16() == 404 || response.status().as_u16() == 204 {
        return Ok(None);
    }
    if !response.status().is_success() {
        let status = response.status();
        eprintln!("[runtime update] server returned {status} for {url}");
        return Err("The update server is temporarily unavailable. Try again later.".to_string());
    }
    response.json().await.map(Some).map_err(|e| {
        eprintln!("[runtime update] manifest parse failed: {e}");
        "Couldn't read the update manifest. Try again later.".to_string()
    })
}

fn install_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let exe = paths::load_saved_exe_path(app)
        .ok_or_else(|| "Locate your Dauntless installation first.".to_string())?;
    if !exe.is_file() {
        return Err("Your Dauntless installation is missing.".to_string());
    }
    paths::game_dir(&exe)
}

/// The runtime update key setting may hold one key or several, comma separated. A file is accepted when its
/// signature verifies under any of them, so a key can be rotated by shipping one build that trusts both keys
/// before a build that trusts only the new one.
fn verify_runtime_signature(bytes: &[u8], signature_b64: &str) -> Result<(), String> {
    verify_runtime_signature_with(runtime_update_public_key_b64(), bytes, signature_b64)
}

fn verify_runtime_signature_with(keys_b64: &str, bytes: &[u8], signature_b64: &str) -> Result<(), String> {
    let signature_bytes = BASE64
        .decode(signature_b64.trim())
        .map_err(|_| "Runtime update signature is invalid.".to_string())?;
    let signature = Signature::from_slice(&signature_bytes)
        .map_err(|_| "Runtime update signature is invalid.".to_string())?;
    let mut usable_keys = 0;
    for encoded in keys_b64.split(',') {
        let Ok(public_bytes) = BASE64.decode(encoded.trim()) else { continue };
        let Ok(public_array) = <[u8; 32]>::try_from(public_bytes) else { continue };
        let Ok(key) = VerifyingKey::from_bytes(&public_array) else { continue };
        usable_keys += 1;
        if key.verify(bytes, &signature).is_ok() {
            return Ok(());
        }
    }
    if usable_keys == 0 {
        return Err("Runtime update public key is invalid.".to_string());
    }
    Err("Runtime update signature does not match a trusted key.".to_string())
}

fn verify_manifest(manifest: &RuntimeManifest, bytes: &[u8]) -> Result<(), String> {
    if manifest.target_changelist != TARGET_CHANGELIST
        || manifest.size != bytes.len()
        || bytes.len() > MAX_RUNTIME_BYTES
    {
        return Err("Runtime update does not match the supported game build.".to_string());
    }
    let digest = Sha256::digest(bytes);
    let actual_hash = digest
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect::<String>();
    if !actual_hash.eq_ignore_ascii_case(&manifest.sha256) {
        return Err("Runtime update hash verification failed.".to_string());
    }
    verify_runtime_signature(bytes, &manifest.signature)
        .map_err(|_| "Runtime update signature verification failed.".to_string())
}

#[derive(Debug)]
struct RuntimeAliasState {
    reported_hash: Option<String>,
    current_source: Option<PathBuf>,
    all_current: bool,
}

fn inspect_runtime_aliases(
    directory: &std::path::Path,
    expected_hash: &str,
) -> Result<RuntimeAliasState, String> {
    let mut fallback_hash = None;
    let mut current_source = None;
    let mut current_count = 0;

    for name in RUNTIME_DLL_NAMES {
        let path = directory.join(name);
        if !path.is_file() {
            continue;
        }
        let hash = verify::hash_file_sha256(&path)?;
        if fallback_hash.is_none() {
            fallback_hash = Some(hash.clone());
        }
        if hash.eq_ignore_ascii_case(expected_hash) {
            current_count += 1;
            if current_source.is_none() {
                current_source = Some(path);
            }
        }
    }

    let reported_hash = if current_source.is_some() {
        Some(expected_hash.to_string())
    } else {
        fallback_hash
    };

    Ok(RuntimeAliasState {
        reported_hash,
        current_source,
        all_current: current_count == RUNTIME_DLL_NAMES.len(),
    })
}

fn replace_runtime_alias(
    directory: &std::path::Path,
    name: &str,
    bytes: &[u8],
) -> Result<(), String> {
    let target = directory.join(name);
    let staged = directory.join(format!("{name}.new"));
    let backup = directory.join(format!("{name}.bak"));
    std::fs::write(&staged, bytes).map_err(|e| format!("Couldn't stage {name}: {e}"))?;
    if target.exists() {
        let _ = std::fs::remove_file(&backup);
        std::fs::rename(&target, &backup)
            .map_err(|e| format!("Couldn't prepare {name} replacement: {e}"))?;
    }
    if let Err(error) = std::fs::rename(&staged, &target) {
        if backup.exists() {
            let _ = std::fs::rename(&backup, &target);
        }
        let _ = std::fs::remove_file(&staged);
        return Err(format!("Couldn't install {name}: {error}"));
    }

    Ok(())
}

fn install_runtime_aliases(directory: &std::path::Path, bytes: &[u8]) -> Result<(), String> {
    for name in RUNTIME_DLL_NAMES {
        replace_runtime_alias(directory, name, bytes)?;
    }
    // The runtime used to ship under other file names. The current loader ignores them, so remove them now that
    // the new files are in place (best effort; the .bak backups are left alone).
    for old in PRE_RENAME_RUNTIME_DLL_NAMES {
        let _ = std::fs::remove_file(directory.join(old));
    }
    Ok(())
}

#[tauri::command]
pub async fn check_runtime_update(
    app: AppHandle,
    channel: String,
) -> Result<RuntimeUpdateStatus, String> {
    let token = bearer_token_for_channel(&app, &channel).await?;
    let Some(manifest) = fetch_manifest(&channel, token.as_deref()).await? else {
        return Ok(RuntimeUpdateStatus {
            available: false,
            version: None,
            current_sha256: None,
            latest_sha256: None,
            size: None,
        });
    };
    let directory = install_dir(&app)?;
    let runtime_state = inspect_runtime_aliases(&directory, &manifest.sha256)?;
    let current_hash = runtime_state.reported_hash;
    let mut available = !runtime_state.all_current;
    if !available {
        for extra in &manifest.extra_files {
            let extra_path = extra_target_dir(&directory, &extra.name).join(&extra.name);
            let up_to_date = extra_path.is_file()
                && verify::hash_file_sha256(&extra_path)
                    .map(|h| h.eq_ignore_ascii_case(&extra.sha256))
                    .unwrap_or(false);
            if !up_to_date {
                available = true;
                break;
            }
        }
    }
    if !available {
        available = manifest.patch_paks.iter().any(|pak| {
            is_patch_pak_name(&pak.name)
                && !extra_target_dir(&directory, &pak.name)
                    .join(&pak.name)
                    .is_file()
        });
    }
    if !available {
        available = manifest.remove_files.iter().any(|name| {
            is_patch_pak_name(name) && extra_target_dir(&directory, name).join(name).is_file()
        });
    }
    Ok(RuntimeUpdateStatus {
        available,
        version: Some(manifest.version),
        current_sha256: current_hash,
        latest_sha256: Some(manifest.sha256),
        size: Some(manifest.size),
    })
}

#[tauri::command]
pub async fn install_runtime_update(
    app: AppHandle,
    channel: String,
) -> Result<RuntimeUpdateStatus, String> {
    let directory = install_dir(&app)?;
    if process::is_dauntless_process_running_from(&directory)? {
        return Err(
            "Close Dauntless and its dedicated server before updating the runtime.".to_string(),
        );
    }
    let token = bearer_token_for_channel(&app, &channel).await?;
    let Some(manifest) = fetch_manifest(&channel, token.as_deref()).await? else {
        return Err("No runtime update is published for this channel.".to_string());
    };
    let runtime_state = inspect_runtime_aliases(&directory, &manifest.sha256)?;

    // Install extra files first — they must be fetched even when the main DLL is current.
    // Each install_extra_file already skips when the target file matches the published hash.
    for extra in &manifest.extra_files {
        install_extra_file(&directory, extra, token.as_deref(), false).await?;
    }
    // Patch paks are cosmetic: a failure here must never stop the DLL update or Play.
    for pak in &manifest.patch_paks {
        if let Err(e) = install_extra_file(&directory, pak, token.as_deref(), true).await {
            eprintln!("[runtime update] patch pak {} skipped: {e}", pak.name);
        }
    }
    remove_listed_paks(&directory, &manifest.remove_files);

    // During the migration both names carry identical bytes: the old loader
    // can keep using the legacy name while the new loader accepts either.
    if runtime_state.all_current {
        return Ok(RuntimeUpdateStatus {
            available: false,
            version: Some(manifest.version),
            current_sha256: runtime_state.reported_hash,
            latest_sha256: Some(manifest.sha256),
            size: Some(manifest.size),
        });
    }

    if let Some(source) = runtime_state.current_source {
        let bytes = std::fs::read(&source)
            .map_err(|e| format!("Couldn't read the installed runtime: {e}"))?;
        verify_manifest(&manifest, &bytes)?;
        install_runtime_aliases(&directory, &bytes)?;
        return Ok(RuntimeUpdateStatus {
            available: false,
            version: Some(manifest.version),
            current_sha256: Some(manifest.sha256.clone()),
            latest_sha256: Some(manifest.sha256),
            size: Some(manifest.size),
        });
    }

    if !is_approved_runtime_url(&manifest.url) {
        return Err("Runtime update URL is not an approved HTTPS endpoint.".to_string());
    }
    let mut download_request = Client::builder()
        .redirect(crate::commands::auth::same_host_redirects())
        .timeout(std::time::Duration::from_secs(120))
        .build()
        .map_err(|e| {
            eprintln!("[runtime update] download client build failed: {e}");
            "Couldn't prepare the download. Try again.".to_string()
        })?
        .get(manifest.url.clone());
    if let Some(token) = token.as_deref() {
        download_request = download_request.bearer_auth(token);
    }
    let response = download_request.send().await.map_err(|e| {
        eprintln!("[runtime update] download failed for {}: {e}", manifest.url);
        "Runtime download failed. Check your connection.".to_string()
    })?;
    if !response.status().is_success() {
        let status = response.status();
        eprintln!("[runtime update] download returned {status}");
        return Err("Runtime download failed. Check your connection.".to_string());
    }
    let bytes = response
        .bytes()
        .await
        .map_err(|e| {
            eprintln!("[runtime update] read response bytes failed: {e}");
            "Runtime download failed. Check your connection.".to_string()
        })?
        .to_vec();
    verify_manifest(&manifest, &bytes)?;

    install_runtime_aliases(&directory, &bytes)?;
    Ok(RuntimeUpdateStatus {
        available: false,
        version: Some(manifest.version),
        current_sha256: Some(manifest.sha256.clone()),
        latest_sha256: Some(manifest.sha256),
        size: Some(manifest.size),
    })
}

/// Loading-art style patch paks: `Archon_RR_<Name>-WindowsClient_P.pak`, installed into Content/Paks.
/// The `_P` suffix makes the engine mount it ahead of the base paks.
fn is_patch_pak_name(name: &str) -> bool {
    let Some(middle) = name
        .strip_prefix("Archon_RR_")
        .and_then(|rest| rest.strip_suffix("-WindowsClient_P.pak"))
    else {
        return false;
    };
    !middle.is_empty() && middle.len() <= 40 && middle.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
}

/// Where an extra file goes: DLLs beside the game executable, patch paks in `<Archon>/Content/Paks`.
fn extra_target_dir(directory: &std::path::Path, name: &str) -> PathBuf {
    if is_patch_pak_name(name) {
        // directory is <Archon>/Binaries/Win64
        if let Some(archon) = directory.parent().and_then(|p| p.parent()) {
            return archon.join("Content").join("Paks");
        }
    }
    directory.to_path_buf()
}

/// Rollback: deletes listed patch paks (and their .bak/.new leftovers). Missing files are fine.
fn remove_listed_paks(directory: &std::path::Path, names: &[String]) {
    for name in names {
        if !is_patch_pak_name(name) {
            eprintln!("[runtime update] ignoring unsafe remove entry: {name}");
            continue;
        }
        let dir = extra_target_dir(directory, name);
        for file in [name.clone(), format!("{name}.bak"), format!("{name}.new")] {
            let path = dir.join(&file);
            if path.is_file() {
                if let Err(e) = std::fs::remove_file(&path) {
                    eprintln!("[runtime update] couldn't remove {file}: {e}");
                }
            }
        }
    }
}

fn is_safe_extra_name(name: &str) -> bool {
    !name.is_empty()
        && !name.contains('/')
        && !name.contains('\\')
        && !name.contains("..")
        && name != "."
        && name.to_ascii_lowercase().ends_with(".dll")
        && !name.eq_ignore_ascii_case(RUNTIME_DLL_NAME)
        && !name.eq_ignore_ascii_case(LEGACY_RUNTIME_DLL_NAME)
        && !PRE_RENAME_RUNTIME_DLL_NAMES
            .iter()
            .any(|old| name.eq_ignore_ascii_case(old))
}

async fn install_extra_file(
    directory: &std::path::Path,
    extra: &ExtraFile,
    token: Option<&str>,
    patch_pak: bool,
) -> Result<(), String> {
    let name_ok = if patch_pak {
        is_patch_pak_name(&extra.name)
    } else {
        is_safe_extra_name(&extra.name)
    };
    if !name_ok {
        return Err(format!("Rejected unsafe extra file name: {}", extra.name));
    }
    if !is_approved_runtime_url(&extra.url) {
        return Err("Extra file URL is not an approved HTTPS endpoint.".to_string());
    }
    let directory = &extra_target_dir(directory, &extra.name);
    if !directory.is_dir() {
        return Err(format!("Couldn't find the folder for {}.", extra.name));
    }
    let target = directory.join(&extra.name);
    // Already up to date? skip.
    if target.is_file() {
        if let Ok(existing) = verify::hash_file_sha256(&target) {
            if existing.eq_ignore_ascii_case(&extra.sha256) {
                return Ok(());
            }
        }
    }
    let mut extra_request = Client::builder()
        .redirect(crate::commands::auth::same_host_redirects())
        .timeout(std::time::Duration::from_secs(120))
        .build()
        .map_err(|e| {
            eprintln!("[runtime update] extra download client build failed: {e}");
            "Couldn't prepare the download. Try again.".to_string()
        })?
        .get(&extra.url);
    if let Some(token) = token {
        extra_request = extra_request.bearer_auth(token);
    }
    let response = extra_request.send().await.map_err(|e| {
        eprintln!("[runtime update] download of {} failed: {e}", extra.name);
        "Runtime download failed. Check your connection.".to_string()
    })?;
    if !response.status().is_success() {
        let status = response.status();
        eprintln!(
            "[runtime update] download of {} returned {status}",
            extra.name
        );
        return Err("Runtime download failed. Check your connection.".to_string());
    }
    let bytes = response
        .bytes()
        .await
        .map_err(|e| {
            eprintln!("[runtime update] read of {} failed: {e}", extra.name);
            "Runtime download failed. Check your connection.".to_string()
        })?
        .to_vec();
    if bytes.len() != extra.size || bytes.len() > MAX_RUNTIME_BYTES {
        return Err(format!("Extra file {} size mismatch.", extra.name));
    }
    let digest = Sha256::digest(&bytes);
    let actual_hash = digest
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect::<String>();
    if !actual_hash.eq_ignore_ascii_case(&extra.sha256) {
        return Err(format!(
            "Extra file {} hash verification failed.",
            extra.name
        ));
    }
    verify_runtime_signature(&bytes, &extra.signature)
        .map_err(|_| format!("Extra file {} signature verification failed.", extra.name))?;

    let staged = directory.join(format!("{}.new", extra.name));
    let backup = directory.join(format!("{}.bak", extra.name));
    std::fs::write(&staged, &bytes).map_err(|e| format!("Couldn't stage {}: {e}", extra.name))?;
    if target.exists() {
        let _ = std::fs::remove_file(&backup);
        std::fs::rename(&target, &backup)
            .map_err(|e| format!("Couldn't back up {}: {e}", extra.name))?;
    }
    if let Err(error) = std::fs::rename(&staged, &target) {
        if backup.exists() {
            let _ = std::fs::rename(&backup, &target);
        }
        let _ = std::fs::remove_file(&staged);
        return Err(format!("Couldn't install {}: {error}", extra.name));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{
        extra_target_dir, inspect_runtime_aliases, install_runtime_aliases, is_approved_runtime_url_for,
        is_patch_pak_name, is_safe_extra_name, remove_listed_paks, LEGACY_RUNTIME_DLL_NAME, RUNTIME_DLL_NAME,
    };

    #[test]
    fn runtime_downloads_must_use_the_configured_https_origin() {
        let endpoint = "https://community.example/launcher/v1/runtime";

        assert!(is_approved_runtime_url_for(
            endpoint,
            "https://community.example/launcher/v1/runtime/stable/runtime.dll"
        ));
        assert!(!is_approved_runtime_url_for(
            endpoint,
            "https://attacker.example/runtime.dll"
        ));
        assert!(!is_approved_runtime_url_for(
            endpoint,
            "http://community.example/runtime.dll"
        ));
        assert!(!is_approved_runtime_url_for(
            endpoint,
            "https://community.example.evil.test/runtime.dll"
        ));
    }

    #[test]
    fn runtime_extra_files_remain_flat_dll_names() {
        assert!(is_safe_extra_name("winmm.dll"));
        assert!(!is_safe_extra_name("../winmm.dll"));
        assert!(!is_safe_extra_name("nested/winmm.dll"));
        assert!(!is_safe_extra_name("notes.txt"));
        assert!(!is_safe_extra_name(RUNTIME_DLL_NAME));
        assert!(!is_safe_extra_name(LEGACY_RUNTIME_DLL_NAME));
        assert!(!is_safe_extra_name("ramsgatereborn.dll"));
        assert!(!is_safe_extra_name("RAMSGATEREBORN.DLL"));
        assert!(!is_safe_extra_name("MysticParadox.dll"));
        assert!(!is_safe_extra_name("MYSTPAXINTERNALSERVER.DLL"));
    }

    #[test]
    fn patch_paks_are_only_the_named_rr_pattern() {
        assert!(is_patch_pak_name("Archon_RR_LoadingArt-WindowsClient_P.pak"));
        assert!(!is_safe_extra_name("Archon_RR_LoadingArt-WindowsClient_P.pak"));
        assert!(!is_patch_pak_name("Archon_0-WindowsClient.pak"));
        assert!(!is_patch_pak_name("Archon_RR_-WindowsClient_P.pak"));
        assert!(!is_patch_pak_name("Archon_RR_a/b-WindowsClient_P.pak"));
        assert!(!is_patch_pak_name("Archon_RR_..-WindowsClient_P.pak"));
        assert!(!is_patch_pak_name("Archon_RR_LoadingArt-WindowsClient_P.pak.exe"));
        assert!(!is_safe_extra_name("Archon_RR_LoadingArt-WindowsClient.pak"));
    }

    #[test]
    fn patch_paks_go_to_content_paks_and_rollback_removes_them() {
        let root = std::env::temp_dir().join(format!("rr-pak-test-{}", std::process::id()));
        let bin = root.join("Archon").join("Binaries").join("Win64");
        let paks = root.join("Archon").join("Content").join("Paks");
        std::fs::create_dir_all(&bin).unwrap();
        std::fs::create_dir_all(&paks).unwrap();
        let name = "Archon_RR_LoadingArt-WindowsClient_P.pak";
        assert_eq!(extra_target_dir(&bin, name), paks);
        assert_eq!(extra_target_dir(&bin, "winmm.dll"), bin);
        std::fs::write(paks.join(name), b"x").unwrap();
        std::fs::write(paks.join("Archon_0-WindowsClient.pak"), b"base").unwrap();
        remove_listed_paks(
            &bin,
            &[name.to_string(), "Archon_0-WindowsClient.pak".to_string()],
        );
        assert!(!paks.join(name).exists());
        assert!(paks.join("Archon_0-WindowsClient.pak").exists());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn synchronizes_both_runtime_aliases_from_one_current_copy() {
        let dir =
            std::env::temp_dir().join(format!("mystpax-runtime-alias-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let canonical = dir.join(RUNTIME_DLL_NAME);
        std::fs::write(&canonical, b"runtime").unwrap();
        let expected_hash = crate::install::verify::hash_file_sha256(&canonical).unwrap();
        let before = inspect_runtime_aliases(&dir, &expected_hash).unwrap();
        assert!(!before.all_current);
        assert!(before.current_source.is_some());

        install_runtime_aliases(&dir, b"runtime").unwrap();
        let after = inspect_runtime_aliases(&dir, &expected_hash).unwrap();
        assert!(after.all_current);
        assert_eq!(
            std::fs::read(dir.join(RUNTIME_DLL_NAME)).unwrap(),
            b"runtime"
        );
        assert_eq!(
            std::fs::read(dir.join(LEGACY_RUNTIME_DLL_NAME)).unwrap(),
            b"runtime"
        );

        std::fs::remove_dir_all(dir).ok();
    }
}

#[cfg(test)]
mod key_rotation_tests {
    use super::verify_runtime_signature_with;

    const OLD: &str = "BKTOfIr4PMEQk/95iDrmnhRrMnbIhcBjro06gtX0D5Y=";
    const NEW: &str = "ACjrw03t0+B0xlScOTRADIoZj751mZ4AYm/djMV1blI=";

    /// RR_RUNTIME_KEY_FIXTURES names a folder holding winmm.dll plus winmm.dll.old.sig (the live signature, old key) and
    /// winmm.dll.new.sig (the same file signed with the new key). Without it the test has nothing to check.
    #[test]
    fn old_and_new_keys_during_the_rotation() {
        let Ok(dir) = std::env::var("RR_RUNTIME_KEY_FIXTURES") else { return };
        let dir = std::path::PathBuf::from(dir);
        let bytes = std::fs::read(dir.join("winmm.dll")).unwrap();
        let old_sig = std::fs::read_to_string(dir.join("winmm.dll.old.sig")).unwrap();
        let new_sig = std::fs::read_to_string(dir.join("winmm.dll.new.sig")).unwrap();
        let bridge = format!("{OLD},{NEW}");
        assert!(verify_runtime_signature_with(&bridge, &bytes, &old_sig).is_ok());
        assert!(verify_runtime_signature_with(&bridge, &bytes, &new_sig).is_ok());
        assert!(verify_runtime_signature_with(OLD, &bytes, &old_sig).is_ok());
        assert!(verify_runtime_signature_with(OLD, &bytes, &new_sig).is_err());
        assert!(verify_runtime_signature_with(NEW, &bytes, &new_sig).is_ok());
        assert!(verify_runtime_signature_with(NEW, &bytes, &old_sig).is_err());
        let mut tampered = bytes.clone();
        tampered[100] ^= 1;
        assert!(verify_runtime_signature_with(&bridge, &tampered, &new_sig).is_err());
        assert!(verify_runtime_signature_with("", &bytes, &old_sig).is_err());
    }
}
