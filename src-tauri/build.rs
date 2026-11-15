use sha2::Digest;
use std::fs;

// Pin the offline DLL: its sha256 comes from offline-component/manifest.json (written by make-offline-component.ps1)
// and is compiled into the launcher, so the install can refuse a bundle whose files were swapped.
fn main() {
    let manifest = "offline-component/manifest.json";
    println!("cargo:rerun-if-changed={manifest}");
    let mut pin = String::new();
    if let Ok(text) = fs::read_to_string(manifest) {
        if let Ok(v) = serde_json_pin(&text) {
            pin = v;
        }
    }
    println!("cargo:rustc-env=RR_OFFLINE_DLL_SHA256={pin}");
    // manifest.json is pinned as a whole file as well, so the other files it lists are covered by one compiled-in hash.
    let manifest_pin = fs::read(manifest).map(|bytes| sha2::Sha256::digest(&bytes).iter().map(|b| format!("{b:02x}")).collect::<String>()).unwrap_or_default();
    println!("cargo:rustc-env=RR_OFFLINE_MANIFEST_SHA256={manifest_pin}");
    // The offline PowerShell scripts run with the execution policy bypassed (they are not Authenticode-signed), so their
    // contents are pinned instead: their sha256 is compiled in and checked right before each run.
    let mut pins = String::from("pub const SCRIPT_PINS: &[(&str, &str)] = &[
");
    for name in ["offline-stack.ps1", "install-offline.ps1", "verify-component.ps1"] {
        let path = format!("../../scripts/offline/{name}");
        println!("cargo:rerun-if-changed={path}");
        let hash = fs::read(&path).map(|b| sha2::Sha256::digest(&b).iter().map(|x| format!("{x:02x}")).collect::<String>()).unwrap_or_default();
        pins.push_str(&format!("    (\"{name}\", \"{hash}\"),
"));
    }
    pins.push_str("];
");
    fs::write(std::path::Path::new(&std::env::var("OUT_DIR").unwrap()).join("script_pins.rs"), pins).unwrap();
    // A release build without https endpoints would silently fall back to the plain-http loopback defaults.
    for name in ["MYSTPAX_API_BASE_URL", "MYSTPAX_RUNTIME_ENDPOINT"] {
        println!("cargo:rerun-if-env-changed={name}");
        if std::env::var("PROFILE").as_deref() == Ok("release") {
            let value = std::env::var(name).unwrap_or_default();
            if !value.starts_with("https://") {
                panic!("{name} must be set to an https:// URL for a release build");
            }
        }
    }
    tauri_build::build()
}

// Finds "RamsgateRebornOffline.dll": "<64 hex>" without a JSON dependency in the build script.
fn serde_json_pin(text: &str) -> Result<String, ()> {
    let key = "\"RamsgateRebornOffline.dll\"";
    let rest = &text[text.find(key).ok_or(())? + key.len()..];
    let open = rest.find('"').ok_or(())?;
    let close = rest[open + 1..].find('"').ok_or(())? + open + 1;
    let v = &rest[open + 1..close];
    if v.len() == 64 && v.chars().all(|c| c.is_ascii_hexdigit()) {
        Ok(v.to_ascii_lowercase())
    } else {
        Err(())
    }
}
