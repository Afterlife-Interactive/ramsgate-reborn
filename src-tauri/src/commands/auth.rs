use serde::{de::DeserializeOwned, Deserialize, Serialize};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::AppHandle;
use tauri_plugin_opener::OpenerExt;
use url::Url;

use crate::auth::secure_store;
use crate::commands::retry;

// Ramsgate Reborn is local-only: the backend always runs on this PC.
pub(crate) fn api_base_url() -> &'static str {
    option_env!("MYSTPAX_API_BASE_URL").unwrap_or("http://127.0.0.1:3000")
}

/// A random id for this install, created on first use and kept in the local app data folder. The server ties a session to it,
/// so a refresh token copied to another PC is refused there. Falls back to a per-run value if the folder cannot be written.
pub(crate) fn device_id() -> &'static str {
    static ID: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    ID.get_or_init(|| {
        let valid = |v: &str| v.len() == 32 && v.chars().all(|c| c.is_ascii_hexdigit());
        let dir = std::env::var_os("LOCALAPPDATA").map(|d| std::path::PathBuf::from(d).join("RamsgateReborn"));
        let path = dir.as_ref().map(|d| d.join("device-id"));
        if let Some(existing) = path.as_ref().and_then(|p| std::fs::read_to_string(p).ok()) {
            if valid(existing.trim()) {
                return existing.trim().to_string();
            }
        }
        use sha2::{Digest, Sha256};
        let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
        let local = 0u8;
        let mut hasher = Sha256::new();
        hasher.update(nanos.to_le_bytes());
        hasher.update(std::process::id().to_le_bytes());
        hasher.update((&local as *const u8 as usize).to_le_bytes());
        hasher.update(format!("{:?}", std::thread::current().id()));
        let id: String = hasher.finalize().iter().take(16).map(|b| format!("{b:02x}")).collect();
        if let (Some(dir), Some(path)) = (dir, path) {
            let _ = std::fs::create_dir_all(&dir);
            let _ = std::fs::write(path, &id);
        }
        id
    })
}

/// Redirects are followed only to the host that was asked, so a response cannot send the launcher (or its token) elsewhere.
pub(crate) fn same_host_redirects() -> reqwest::redirect::Policy {
    reqwest::redirect::Policy::custom(|attempt| {
        let same = attempt.previous().first().and_then(|first| first.host_str().map(str::to_owned)) == attempt.url().host_str().map(str::to_owned);
        if same && attempt.previous().len() < 5 { attempt.follow() } else { attempt.stop() }
    })
}

/// Game archive download: the backend answers with a 302 to a presigned R2 URL on another host.
/// Follow it (https only, max 5 hops). reqwest drops the Authorization header on a cross-host hop.
pub(crate) fn download_redirects() -> reqwest::redirect::Policy {
    reqwest::redirect::Policy::custom(|attempt| {
        if attempt.url().scheme() == "https" && attempt.previous().len() < 5 { attempt.follow() } else { attempt.stop() }
    })
}

pub(crate) fn http_client() -> Result<reqwest::blocking::Client, String> {
    let mut headers = reqwest::header::HeaderMap::new();
    headers.insert("x-launcher-version", reqwest::header::HeaderValue::from_static(env!("CARGO_PKG_VERSION")));
    reqwest::blocking::Client::builder()
        .default_headers(headers)
        .redirect(same_host_redirects())
        .connect_timeout(crate::commands::net_diag::CONNECT_TIMEOUT)
        .timeout(crate::commands::net_diag::TOTAL_TIMEOUT)
        .build()
        .map_err(|_| "Couldn't prepare the secure launcher connection.".to_string())
}

async fn run_auth_task<T, F>(operation: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, String> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(operation)
        .await
        .map_err(|_| "The launcher authentication task stopped unexpectedly.".to_string())?
}

#[derive(Deserialize)]
struct ErrorEnvelope {
    error: Option<ErrorBody>,
}

#[derive(Deserialize)]
struct ErrorBody {
    code: Option<String>,
}

pub(crate) fn safe_api_error(response: reqwest::blocking::Response, fallback: &str) -> String {
    let status = response.status();
    let code = response
        .json::<ErrorEnvelope>()
        .ok()
        .and_then(|body| body.error)
        .and_then(|error| error.code);
    match code.as_deref() {
        Some("AUTH_APPROVAL_PENDING") => {
            "Your closed-test access request is waiting for approval.".to_string()
        }
        Some("AUTH_APPROVAL_REJECTED") => {
            "Your closed-test access request was not approved.".to_string()
        }
        Some("AUTH_ACCOUNT_DISABLED") => "This account has been disabled.".to_string(),
        Some("AUTH_ACCOUNT_BANNED") => "This account has been banned.".to_string(),
        Some("AUTH_EMAIL_TAKEN") => "That email is already registered.".to_string(),
        Some("AUTH_DISPLAY_NAME_TAKEN") => "That username is already taken.".to_string(),
        Some("AUTH_INVALID_CREDENTIALS") => "The email or password is incorrect.".to_string(),
        Some("AUTH_REFRESH_INVALID") | Some("AUTH_UNAUTHORIZED") => {
            "Your session expired. Sign in again.".to_string()
        }
        Some("AUTH_TESTER_REQUIRED") => "Tester access is required for this.".to_string(),
        Some("AUTH_RATE_LIMITED") => "Too many attempts. Wait a moment and try again.".to_string(),
        Some("AUTH_USERNAME_REQUIRED") => {
            "Choose your launcher username before playing.".to_string()
        }
        Some("GAME_BUILD_UNSUPPORTED") => {
            "This game copy is not the Ramsgate Reborn build (a Revival or modified copy). Repair only fixes the launcher files, so download the Ramsgate Reborn game into a new empty folder and use that one.".to_string()
        }
        _ => format!("{fallback} (server status {})", status.as_u16()),
    }
}

fn parse_success<T: DeserializeOwned>(
    response: reqwest::blocking::Response,
    fallback: &str,
) -> Result<T, String> {
    if !response.status().is_success() {
        return Err(safe_api_error(response, fallback));
    }
    response
        .json::<T>()
        .map_err(|_| "The account server returned an invalid response.".to_string())
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeAccount {
    pub user_id: String,
    pub display_name: String,
    pub email: String,
    pub discord_linked: bool,
    pub status: String,
    pub approval_status: String,
    pub needs_username: bool,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NativeSession {
    pub access_token: String,
    pub refresh_token: String,
    pub account: NativeAccount,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DeviceRequest<'a> {
    device_id: &'a str,
    device_name: &'a str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct LoginRequest<'a> {
    email: &'a str,
    password: &'a str,
    device_id: &'a str,
    device_name: &'a str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RegisterRequest<'a> {
    display_name: &'a str,
    email: &'a str,
    password: &'a str,
    device_id: &'a str,
    device_name: &'a str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RefreshRequest<'a> {
    refresh_token: &'a str,
    device_id: &'a str,
    device_name: &'a str,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PendingRegistration {
    account: NativeAccount,
}

/// The most recent session, shared by every native command. Each refresh rotates the refresh token, and the server
/// treats two refreshes racing on one token as theft and cancels the whole session, so commands that start together
/// (sign-in checks, game offer, crash report, admin panels) must not each refresh. Access tokens live 12 minutes
/// on the server; reuse one for less than that.
static SESSION_CACHE: Mutex<Option<(NativeSession, Instant)>> = Mutex::new(None);
const SESSION_REUSE: Duration = Duration::from_secs(8 * 60);

/// Forgets the cached session. Called wherever the saved sign-in is cleared.
pub(crate) fn clear_session_cache() {
    *SESSION_CACHE.lock().unwrap_or_else(|poisoned| poisoned.into_inner()) = None;
}

fn refresh_with(app: &AppHandle, force: bool) -> Result<NativeSession, String> {
    // Held across the network call on purpose: a second caller waits for this refresh and then reuses its result.
    let mut cache = SESSION_CACHE.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    if !force {
        if let Some((session, fetched)) = cache.as_ref() {
            if fetched.elapsed() < SESSION_REUSE {
                return Ok(session.clone());
            }
        }
    }

    let token = secure_store::load(app)?
        .ok_or_else(|| "Your session expired. Sign in again.".to_string())?;
    let client = http_client()?;
    let response = retry::send(retry::Kind::Write, || {
        client
            .post(format!("{}/launcher/v1/auth/refresh", api_base_url()))
            .json(&RefreshRequest {
                refresh_token: &token,
                device_id: device_id(),
                device_name: "Windows PC",
            })
    })
    .map_err(|_| "Couldn't reach the Ramsgate Reborn account server.".to_string())?;
    let session: NativeSession =
        parse_success(response, "Couldn't restore your launcher session.")?;
    secure_store::save(app, &session.refresh_token)?;
    *cache = Some((session.clone(), Instant::now()));
    Ok(session)
}

pub(crate) fn refresh_native_session(app: &AppHandle) -> Result<NativeSession, String> {
    refresh_with(app, false)
}

/// For a caller whose cached access token was just rejected (server restart, revoked session): refresh for real.
pub(crate) fn refresh_native_session_forced(app: &AppHandle) -> Result<NativeSession, String> {
    refresh_with(app, true)
}

#[tauri::command]
pub async fn native_restore_session(app: AppHandle) -> Result<Option<NativeAccount>, String> {
    run_auth_task(move || {
        if secure_store::load(&app)?.is_none() {
            return Ok(None);
        }
        match refresh_native_session(&app) {
            Ok(session) => Ok(Some(session.account)),
            Err(error) => {
                if error.contains("expired")
                    || error.contains("approval")
                    || error.contains("approved")
                    || error.contains("disabled")
                    || error.contains("banned")
                {
                    let _ = { clear_session_cache(); secure_store::clear(&app) };
                }
                Err(error)
            }
        }
    })
    .await
}

#[tauri::command]
pub async fn native_login(
    app: AppHandle,
    email: String,
    password: String,
) -> Result<NativeAccount, String> {
    run_auth_task(move || {
        let client = http_client()?;
        let response = retry::send(retry::Kind::Write, || {
            client
                .post(format!("{}/launcher/v1/auth/login", api_base_url()))
                .json(&LoginRequest {
                    email: &email,
                    password: &password,
                    device_id: device_id(),
                    device_name: "Windows PC",
                })
        })
        .map_err(|_| "Can't reach the Ramsgate Reborn server right now.".to_string())?;
        let session: NativeSession = parse_success(response, "Sign-in failed.")?;
        clear_session_cache();
        secure_store::save(&app, &session.refresh_token)?;
        Ok(session.account)
    })
    .await
}

#[tauri::command]
pub async fn native_register(
    app: AppHandle,
    display_name: String,
    email: String,
    password: String,
) -> Result<NativeAccount, String> {
    run_auth_task(move || {
        let response = http_client()?
            .post(format!("{}/launcher/v1/auth/register", api_base_url()))
            .json(&RegisterRequest {
                display_name: &display_name,
                email: &email,
                password: &password,
                device_id: device_id(),
                device_name: "Windows PC",
            })
            .send()
            .map_err(|_| "Can't reach the Ramsgate Reborn server right now.".to_string())?;
        let pending: PendingRegistration = parse_success(response, "Registration failed.")?;
        let _ = { clear_session_cache(); secure_store::clear(&app) };
        Ok(pending.account)
    })
    .await
}

/// A Discord sign-in this launcher started, and when. A `ramsgatereborn://auth/complete?code=` link is only
/// accepted while one is pending, so a link from someone else (a web page, a chat message) cannot sign this
/// launcher into the sender's account (login CSRF). One completion per start.
static PENDING_DISCORD_LOGIN: Mutex<Option<Instant>> = Mutex::new(None);
const DISCORD_LOGIN_WINDOW: Duration = Duration::from_secs(15 * 60);

fn mark_discord_login_started() {
    if let Ok(mut pending) = PENDING_DISCORD_LOGIN.lock() {
        *pending = Some(Instant::now());
    }
}

/// Takes the pending sign-in: true only if one was started within the window.
fn take_pending_discord_login(now: Instant) -> bool {
    match PENDING_DISCORD_LOGIN.lock() {
        Ok(mut pending) => matches!(pending.take(), Some(started) if now.duration_since(started) <= DISCORD_LOGIN_WINDOW),
        Err(_) => false,
    }
}

#[tauri::command]
pub async fn native_discord_complete(
    app: AppHandle,
    code: String,
) -> Result<NativeAccount, String> {
    if !take_pending_discord_login(Instant::now()) {
        return Err("This sign-in link was not started from this launcher. Click Sign in with Discord again.".to_string());
    }
    run_auth_task(move || {
        #[derive(Serialize)]
        #[serde(rename_all = "camelCase")]
        struct CompleteRequest<'a> {
            code: &'a str,
            device_id: &'a str,
            device_name: &'a str,
        }
        let response = http_client()?
            .post(format!(
                "{}/launcher/v1/auth/discord/complete",
                api_base_url()
            ))
            .json(&CompleteRequest {
                code: &code,
                device_id: device_id(),
                device_name: "Windows PC",
            })
            .send()
            .map_err(|_| "Couldn't complete Discord sign-in.".to_string())?;
        let session: NativeSession = parse_success(response, "Discord sign-in failed.")?;
        clear_session_cache();
        secure_store::save(&app, &session.refresh_token)?;
        Ok(session.account)
    })
    .await
}

#[tauri::command]
pub async fn native_start_discord_login(app: AppHandle) -> Result<(), String> {
    run_auth_task(move || {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct StartResponse {
            authorize_url: String,
        }

        // The admin launcher build tags its start request so the backend returns to its own deep link.
        let variant = option_env!("MYSTPAX_DISCORD_VARIANT");
        let response = http_client()?
            .post(format!("{}/launcher/v1/auth/discord/start", api_base_url()))
            .json(&serde_json::json!({
                "deviceId": device_id(),
                "deviceName": "Windows PC",
                "variant": variant,
            }))
            .send()
            .map_err(|_| "Couldn't start Discord sign-in.".to_string())?;
        let start: StartResponse = parse_success(response, "Couldn't start Discord sign-in.")?;
        let parsed = Url::parse(&start.authorize_url)
            .map_err(|_| "Discord returned an invalid URL.".to_string())?;
        if parsed.scheme() != "https" || parsed.host_str() != Some("discord.com") {
            return Err("Refusing to open a non-Discord URL.".to_string());
        }
        mark_discord_login_started();
        app.opener()
            .open_url(start.authorize_url, None::<&str>)
            .map_err(|_| "Couldn't open Discord in your browser.".to_string())
    })
    .await
}

#[cfg(test)]
mod discord_login_csrf_tests {
    use super::*;

    #[test]
    fn completion_needs_a_started_sign_in_and_is_used_once() {
        // Shared static: run the whole sequence in one test.
        let _ = take_pending_discord_login(Instant::now());
        assert!(!take_pending_discord_login(Instant::now()), "no sign-in started");
        mark_discord_login_started();
        assert!(take_pending_discord_login(Instant::now()));
        assert!(!take_pending_discord_login(Instant::now()), "second link for the same start");
        mark_discord_login_started();
        assert!(!take_pending_discord_login(Instant::now() + DISCORD_LOGIN_WINDOW + Duration::from_secs(1)), "expired");
    }
}

#[tauri::command]
pub async fn native_set_username(
    app: AppHandle,
    username: String,
) -> Result<NativeAccount, String> {
    run_auth_task(move || {
        #[derive(Serialize)]
        struct UsernameRequest<'a> {
            username: &'a str,
        }
        let session = refresh_native_session(&app)?;
        let response = http_client()?
            .post(format!("{}/launcher/v1/username", api_base_url()))
            .bearer_auth(&session.access_token)
            .json(&UsernameRequest {
                username: &username,
            })
            .send()
            .map_err(|_| "Couldn't set your username.".to_string())?;
        parse_success(response, "Couldn't set your username.")
    })
    .await
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeLogUpload {
    pub auto: bool,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativePolicy {
    pub policy_version: String,
    pub roles: Vec<String>,
    pub channel: String,
    // True when the server lets this account pick the beta runtime; the launcher shows the Stable/Beta selector only then.
    #[serde(default)]
    pub test_channel_eligible: bool,
    pub managed_feature_ids: Vec<String>,
    pub log_upload: NativeLogUpload,
}

// Only "beta" is ever sent: stable is the default, and the server ignores a beta request from an account that is not
// on its test list, so this is a request, never an entitlement.
fn policy_url(base: &str, requested_channel: Option<&str>) -> String {
    match requested_channel {
        Some("beta") => format!("{base}/launcher/v1/policy?channel=beta"),
        _ => format!("{base}/launcher/v1/policy"),
    }
}

// Shared by native_get_policy (badge/channel, exposed to JS) and secure_launch's flag
// reconciliation (Rust-internal, right before spawn_game) so both reuse a single already
//-fetched access token instead of each rotating the refresh token separately.
pub(crate) fn fetch_policy(access_token: &str, requested_channel: Option<&str>) -> Result<NativePolicy, String> {
    let client = http_client()?;
    let response = retry::send(retry::Kind::Read, || {
        client
            .get(policy_url(&api_base_url(), requested_channel))
            .bearer_auth(access_token)
    })
    .map_err(|_| "Can't reach the Ramsgate Reborn server right now.".to_string())?;
    parse_success(response, "Couldn't refresh your account policy.")
}

// Called after login, after session restore, and immediately before Play — the runtime
// caches several flags for the process lifetime, so this must run before spawn_game(),
// not just periodically in the background.
#[tauri::command]
pub async fn native_get_policy(app: AppHandle, channel: Option<String>) -> Result<NativePolicy, String> {
    run_auth_task(move || {
        let session = refresh_native_session(&app)?;
        fetch_policy(&session.access_token, channel.as_deref())
    })
    .await
}

#[tauri::command]
pub fn native_logout(app: AppHandle) -> Result<(), String> {
    let refresh_token = secure_store::load(&app)?;
    { clear_session_cache(); secure_store::clear(&app) }?;

    // Local sign-out must never wait for an offline server. If a token existed,
    // rotate it and revoke the resulting session family in the background.
    if let Some(refresh_token) = refresh_token {
        let _background_revoke = tauri::async_runtime::spawn_blocking(move || {
            let response = http_client()?
                .post(format!("{}/launcher/v1/auth/refresh", api_base_url()))
                .json(&RefreshRequest {
                    refresh_token: &refresh_token,
                    device_id: device_id(),
                    device_name: "Windows PC",
                })
                .send()
                .map_err(|_| "Couldn't reach the account server.".to_string())?;
            let session: NativeSession =
                parse_success(response, "Couldn't revoke the launcher session.")?;
            let response = http_client()?
                .post(format!("{}/launcher/v1/auth/logout", api_base_url()))
                .bearer_auth(&session.access_token)
                .send()
                .map_err(|_| "Couldn't reach the account server.".to_string())?;
            if response.status().is_success() {
                Ok(())
            } else {
                Err(safe_api_error(response, "Sign-out failed."))
            }
        });
    }

    Ok(())
}

#[tauri::command]
pub fn native_forget_session(app: AppHandle) -> Result<(), String> {
    { clear_session_cache(); secure_store::clear(&app) }
}

#[cfg(test)]
mod channel_tests {
    use super::policy_url;

    #[test]
    fn only_beta_adds_the_channel_query() {
        assert_eq!(policy_url("https://x", Some("beta")), "https://x/launcher/v1/policy?channel=beta");
        assert_eq!(policy_url("https://x", Some("stable")), "https://x/launcher/v1/policy");
        assert_eq!(policy_url("https://x", Some("dev")), "https://x/launcher/v1/policy");
        assert_eq!(policy_url("https://x", Some("beta&x=1")), "https://x/launcher/v1/policy");
        assert_eq!(policy_url("https://x", None), "https://x/launcher/v1/policy");
    }
}
