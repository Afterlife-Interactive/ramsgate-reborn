//! Launcher self-update that can trust more than one signing key.
//!
//! The updater plugin checks a download against the one public key in tauri.conf.json (plugins.updater.pubkey). A build
//! may also list more keys, comma separated, in MYSTPAX_LAUNCHER_UPDATE_EXTRA_PUBKEYS (same format as the config value).
//! The key is picked by the key id written inside the update's signature, and the plugin then checks the download against
//! that key as usual. This lets one build accept updates signed by the old key or a new one while the key is replaced.

use std::sync::Mutex;

use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use serde::Serialize;
use tauri::{AppHandle, State};
use tauri_plugin_updater::{Update, UpdaterExt};

#[derive(Default)]
pub struct PendingLauncherUpdate(Mutex<Option<Update>>);

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LauncherUpdateInfo {
    pub version: String,
    pub notes: Option<String>,
}

/// The 8-byte key id inside a minisign public key or signature, both given the way Tauri stores them (base64 of the
/// minisign text file). The first line that is not a comment holds the key id at bytes 2..10.
pub(crate) fn minisign_key_id(encoded: &str) -> Option<[u8; 8]> {
    let text = String::from_utf8(BASE64.decode(encoded.trim()).ok()?).ok()?;
    let line = text
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty() && !line.starts_with("untrusted comment:") && !line.starts_with("trusted comment:"))?;
    let blob = BASE64.decode(line).ok()?;
    blob.get(2..10)?.try_into().ok()
}

fn configured_key(app: &AppHandle) -> Option<String> {
    app.config()
        .plugins
        .0
        .get("updater")
        .and_then(|updater| updater.get("pubkey"))
        .and_then(|key| key.as_str())
        .map(|key| key.trim().to_string())
        .filter(|key| !key.is_empty())
}

pub(crate) fn trusted_keys(configured: Option<String>, extra: &str) -> Vec<String> {
    let mut keys: Vec<String> = configured.into_iter().collect();
    for key in extra.split(',').map(str::trim).filter(|key| !key.is_empty()) {
        if minisign_key_id(key).is_some() && !keys.iter().any(|known| known == key) {
            keys.push(key.to_string());
        }
    }
    keys
}

fn extra_keys() -> &'static str {
    option_env!("MYSTPAX_LAUNCHER_UPDATE_EXTRA_PUBKEYS").unwrap_or("")
}

/// The trusted key whose id matches the one inside `signature`.
pub(crate) fn key_for_signature(keys: &[String], signature: &str) -> Option<String> {
    let wanted = minisign_key_id(signature)?;
    keys.iter().find(|key| minisign_key_id(key) == Some(wanted)).cloned()
}

#[tauri::command]
pub async fn launcher_update_check(
    app: AppHandle,
    pending: State<'_, PendingLauncherUpdate>,
) -> Result<Option<LauncherUpdateInfo>, String> {
    let update = app
        .updater()
        .map_err(|error| error.to_string())?
        .check()
        .await
        .map_err(|error| error.to_string())?;
    let info = update.as_ref().map(|update| LauncherUpdateInfo {
        version: update.version.clone(),
        notes: update.body.clone(),
    });
    *pending.0.lock().map_err(|_| "The launcher update state is unavailable.".to_string())? = update;
    Ok(info)
}

#[tauri::command]
pub async fn launcher_update_install(
    app: AppHandle,
    pending: State<'_, PendingLauncherUpdate>,
) -> Result<(), String> {
    let update = pending
        .0
        .lock()
        .map_err(|_| "The launcher update state is unavailable.".to_string())?
        .clone()
        .ok_or_else(|| "No launcher update is waiting.".to_string())?;
    let configured = configured_key(&app);
    let keys = trusted_keys(configured.clone(), extra_keys());
    let key = key_for_signature(&keys, &update.signature)
        .ok_or_else(|| "This launcher update is not signed by a trusted key.".to_string())?;
    let update = if Some(&key) == configured.as_ref() {
        update
    } else {
        let again = app
            .updater_builder()
            .pubkey(key)
            .build()
            .map_err(|error| error.to_string())?
            .check()
            .await
            .map_err(|error| error.to_string())?
            .ok_or_else(|| "The launcher update is no longer offered.".to_string())?;
        if again.signature != update.signature {
            return Err("The launcher update changed while it was being installed. Try again.".to_string());
        }
        again
    };
    // The plugin checks the download against the chosen key before it installs anything.
    update
        .download_and_install(|_, _| {}, || {})
        .await
        .map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    const OLD: &str = "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IEY0QTgxMTMyQ0M4NDg1NTMKUldSVGhZVE1NaEdvOVAveUtXUVNYSEVjZytIR0ovaVFqRk1FOUZRYkJHbGZ2T2QrcnZKN0M4THEK";
    const NEW: &str = "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IDVDNjU2RjNGQUQyMzRFRjEKUldUeFRpT3RQMjlsWElSN3Z0Nk0velk3MHpzd1JOMVpvaE0xTGJQQ2lzTzdleHI0U2huM211VVUK";

    fn id_hex(key: &str) -> String {
        // minisign prints the key id as the little-endian u64 in hex.
        let id = minisign_key_id(key).unwrap();
        format!("{:016X}", u64::from_le_bytes(id))
    }

    #[test]
    fn reads_key_ids() {
        assert_eq!(id_hex(OLD), "F4A81132CC848553");
        assert_eq!(id_hex(NEW), "5C656F3FAD234EF1");
    }

    #[test]
    fn extra_keys_are_added_once_and_bad_ones_skipped() {
        let keys = trusted_keys(Some(NEW.to_string()), &format!(" {OLD} ,{NEW},not-a-key,"));
        assert_eq!(keys, vec![NEW.to_string(), OLD.to_string()]);
        assert_eq!(trusted_keys(Some(NEW.to_string()), ""), vec![NEW.to_string()]);
    }

    #[test]
    fn picks_the_key_named_in_the_signature() {
        // The live 0.2.40 launcher signature (signed by the F4A8 key).
        let live_sig = include_str!("../../tests/fixtures/launcher-0.2.40.sig");
        let both = trusted_keys(Some(NEW.to_string()), OLD);
        assert_eq!(key_for_signature(&both, live_sig.trim()), Some(OLD.to_string()));
        let new_only = trusted_keys(Some(NEW.to_string()), "");
        assert_eq!(key_for_signature(&new_only, live_sig.trim()), None);
    }
}
