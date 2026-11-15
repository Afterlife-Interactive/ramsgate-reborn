use tauri::{AppHandle, Emitter};
use tauri_plugin_deep_link::DeepLinkExt;
use url::Url;

const DISCORD_AUTH_COMPLETE_EVENT: &str = "discord-auth-complete";
const DISCORD_AUTH_ERROR_EVENT: &str = "discord-auth-error";

/// URL scheme the backend's Discord callback redirects to. Must match the scheme registered in the
/// Tauri config and the backend's LAUNCHER_DEEPLINK_SCHEME; hosted builds override it so they never
/// collide with another launcher installed on the same PC.
const DEEP_LINK_SCHEME: &str = match option_env!("MYSTPAX_DEEPLINK_SCHEME") {
    Some(scheme) => scheme,
    None => "ramsgatereborn",
};

/// Cold-start / macOS path: the deep-link plugin fires this directly when the
/// app is launched (or already running, on macOS) via `ramsgatereborn://...`.
pub fn listen(app: AppHandle) {
    let handler_app = app.clone();

    app.deep_link().on_open_url(move |event| {
        for url in event.urls() {
            handle_url(&handler_app, &url);
        }
    });
}

/// Cold launch on Windows/Linux: if the OS started this process BECAUSE of the
/// URL (the app wasn't already running), that URL arrived as argv before
/// `listen`'s handler existed to catch it. Tauri's deep-link docs recommend
/// checking `get_current()` once at startup for exactly this case, in addition
/// to the ongoing `on_open_url` listener above.
pub fn check_startup_url(app: &AppHandle) {
    if let Ok(Some(urls)) = app.deep_link().get_current() {
        for url in urls {
            handle_url(app, &url);
        }
    }
}

/// Warm-instance path on Windows/Linux: re-invoking the protocol while the app
/// is already running spawns a new process whose argv carries the URL, caught
/// by the single-instance plugin callback in `lib.rs` rather than `on_open_url`.
pub fn handle_url(app: &AppHandle, url: &Url) {
    if let Some(code) = extract_discord_completion_code(url) {
        let _ = app.emit(DISCORD_AUTH_COMPLETE_EVENT, code);
        return;
    }

    if let Some(code) = extract_discord_error_code(url) {
        let _ = app.emit(DISCORD_AUTH_ERROR_EVENT, code);
    }
}

fn is_launcher_auth_path(url: &Url, path: &str) -> bool {
    url.scheme() == DEEP_LINK_SCHEME && url.host_str() == Some("auth") && url.path() == path
}

pub fn extract_discord_completion_code(url: &Url) -> Option<String> {
    if !is_launcher_auth_path(url, "/complete") {
        return None;
    }

    url.query_pairs()
        .find(|(key, _)| key == "code")
        .map(|(_, value)| value.into_owned())
        .filter(|value| is_plain_code(value))
}

/// Codes arriving over the URL handler are short tokens; anything else is dropped before it reaches the page or the backend.
fn is_plain_code(value: &str) -> bool {
    !value.is_empty() && value.len() <= 256 && value.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-' || c == '.')
}

/// `ramsgatereborn://auth/error?code=<LauncherErrorCode>` — the backend's Discord
/// callback redirects here (instead of /complete) when the flow fails server-side
/// (expired state, Discord denied consent, etc.) — see routes/launcherAuth.ts's
/// GET /launcher/v1/auth/discord/callback handler.
pub fn extract_discord_error_code(url: &Url) -> Option<String> {
    if !is_launcher_auth_path(url, "/error") {
        return None;
    }

    url.query_pairs()
        .find(|(key, _)| key == "code")
        .map(|(_, value)| value.into_owned())
        .filter(|value| is_plain_code(value))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_code_from_valid_completion_url() {
        let url = Url::parse("ramsgatereborn://auth/complete?code=abc123").unwrap();
        assert_eq!(
            extract_discord_completion_code(&url),
            Some("abc123".to_string())
        );
    }

    #[test]
    fn rejects_wrong_scheme() {
        let url = Url::parse("https://auth/complete?code=abc123").unwrap();
        assert_eq!(extract_discord_completion_code(&url), None);
    }

    #[test]
    fn rejects_wrong_path() {
        let url = Url::parse("ramsgatereborn://auth/other?code=abc123").unwrap();
        assert_eq!(extract_discord_completion_code(&url), None);
    }

    #[test]
    fn rejects_missing_code() {
        let url = Url::parse("ramsgatereborn://auth/complete").unwrap();
        assert_eq!(extract_discord_completion_code(&url), None);
    }

    #[test]
    fn extracts_code_from_valid_error_url() {
        let url = Url::parse("ramsgatereborn://auth/error?code=AUTH_DISCORD_CANCELLED").unwrap();
        assert_eq!(
            extract_discord_error_code(&url),
            Some("AUTH_DISCORD_CANCELLED".to_string())
        );
    }

    #[test]
    fn error_extractor_rejects_complete_path() {
        let url = Url::parse("ramsgatereborn://auth/complete?code=abc123").unwrap();
        assert_eq!(extract_discord_error_code(&url), None);
    }

    #[test]
    fn drops_codes_with_odd_characters_or_length() {
        let odd = Url::parse("ramsgatereborn://auth/complete?code=a%20b%3Cscript%3E").unwrap();
        assert_eq!(extract_discord_completion_code(&odd), None);
        let long = Url::parse(&format!("ramsgatereborn://auth/complete?code={}", "a".repeat(300))).unwrap();
        assert_eq!(extract_discord_completion_code(&long), None);
    }
}
