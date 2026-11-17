//! Region selection: asks the backend which regions exist, pings each region's QoS URL, and sends the
//! results back so matchmaking can place hunts in the closest region. When the backend answers
//! `{ "enabled": false }` nothing is pinged and the region UI stays hidden.
//!
//! Only URLs that the backend lists are pinged; the web side cannot pass its own URLs in.

use serde::Serialize;
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::time::{Duration, Instant};
use tauri::AppHandle;

use crate::commands::auth::{api_base_url, refresh_native_session, refresh_native_session_forced};

const SAMPLES: usize = 5;
const DROP_OVER_MS: f64 = 1000.0;

/// Median of samples 2..N (the first one pays for DNS/TLS), ignoring anything over 1 s. None if nothing usable.
pub fn summarize_samples(samples: &[f64]) -> Option<f64> {
    let mut kept: Vec<f64> = samples
        .iter()
        .skip(1)
        .copied()
        .filter(|ms| ms.is_finite() && *ms >= 0.0 && *ms <= DROP_OVER_MS)
        .collect();
    if kept.is_empty() {
        return None;
    }
    kept.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let mid = kept.len() / 2;
    Some(if kept.len() % 2 == 1 { kept[mid] } else { (kept[mid - 1] + kept[mid]) / 2.0 })
}

// Region ping targets come from the server's reply, so only public https hosts are fetched: no plain http, no IP literals,
// no localhost or internal names, no credentials in the URL.
fn is_ping_url(url: &str) -> bool {
    if url.len() > 300 || url.contains(char::is_whitespace) {
        return false;
    }
    let Ok(parsed) = url::Url::parse(url) else { return false };
    if parsed.scheme() != "https" || !parsed.username().is_empty() || parsed.password().is_some() {
        return false;
    }
    match parsed.host() {
        Some(url::Host::Domain(host)) => {
            let host = host.to_ascii_lowercase();
            host.contains('.') && host != "localhost" && !host.ends_with(".localhost") && !host.ends_with(".local") && !host.ends_with(".internal")
        }
        _ => false,
    }
}

fn client() -> Result<reqwest::blocking::Client, String> {
    reqwest::blocking::Client::builder()
        .connect_timeout(Duration::from_secs(3))
        .timeout(Duration::from_secs(5))
        .build()
        .map_err(|_| "Couldn't prepare the launcher connection.".to_string())
}

fn authed(app: &AppHandle, method: &str, path: &str, body: Option<Value>) -> Result<Value, String> {
    let http = client()?;
    let url = format!("{}{}", api_base_url(), path);
    let send = |token: &str| {
        let req = if method == "POST" { http.post(&url).json(&body.clone().unwrap_or_else(|| json!({}))) } else { http.get(&url) };
        req.bearer_auth(token).send().map_err(|_| "Couldn't reach the server.".to_string())
    };
    let mut response = send(&refresh_native_session(app)?.access_token)?;
    if response.status().as_u16() == 401 {
        response = send(&refresh_native_session_forced(app)?.access_token)?;
    }
    if !response.status().is_success() {
        return Err(format!("The request failed (server status {}).", response.status().as_u16()));
    }
    response.json::<Value>().map_err(|_| "The server sent an unreadable reply.".to_string())
}

fn ping(url: &str) -> Option<f64> {
    let http = client().ok()?;
    let mut samples = Vec::with_capacity(SAMPLES);
    for _ in 0..SAMPLES {
        let start = Instant::now();
        let ok = http.get(url).send().map(|r| r.status().is_success()).unwrap_or(false);
        samples.push(if ok { start.elapsed().as_secs_f64() * 1000.0 } else { f64::INFINITY });
        std::thread::sleep(Duration::from_millis(100));
    }
    summarize_samples(&samples)
}

#[derive(Serialize)]
pub struct RegionRefresh {
    enabled: bool,
    info: Value,
    pings: BTreeMap<String, f64>,
}

fn refresh(app: &AppHandle) -> Result<RegionRefresh, String> {
    let info = authed(app, "GET", "/launcher/v1/regions", None)?;
    if info.get("enabled").and_then(Value::as_bool) != Some(true) {
        return Ok(RegionRefresh { enabled: false, info, pings: BTreeMap::new() });
    }
    let mut pings = BTreeMap::new();
    if let Some(regions) = info.get("regions").and_then(Value::as_array) {
        for region in regions.iter().take(16) {
            let (Some(id), Some(url)) = (region.get("id").and_then(Value::as_str), region.get("qosUrl").and_then(Value::as_str)) else { continue };
            if !is_ping_url(url) {
                continue;
            }
            if let Some(ms) = ping(url) {
                pings.insert(id.to_string(), ms.round());
            }
        }
    }
    if !pings.is_empty() {
        authed(app, "POST", "/launcher/v1/pings", Some(json!({ "pings": pings })))?;
    }
    Ok(RegionRefresh { enabled: true, info, pings })
}

/// Fetch the region list, ping every region and report the results. Returns `enabled:false` when the server has region selection off.
#[tauri::command]
pub async fn native_region_refresh(app: AppHandle) -> Result<RegionRefresh, String> {
    tauri::async_runtime::spawn_blocking(move || refresh(&app))
        .await
        .map_err(|_| "The region check stopped unexpectedly.".to_string())?
}

#[cfg(test)]
mod tests {
    use super::{is_ping_url, summarize_samples};

    #[test]
    fn median_skips_first_sample_and_outliers() {
        assert_eq!(summarize_samples(&[400.0, 40.0, 42.0, 41.0, 2000.0]), Some(41.0));
        assert_eq!(summarize_samples(&[400.0, 40.0, 50.0, 45.0]), Some(45.0));
        assert_eq!(summarize_samples(&[30.0, f64::INFINITY, f64::INFINITY]), None);
        assert_eq!(summarize_samples(&[]), None);
    }

    #[test]
    fn only_plain_http_urls_are_pinged() {
        assert!(is_ping_url("https://ca.example/api/v1/matchmaking/QoS"));
        assert!(!is_ping_url("file:///c:/x"));
        assert!(!is_ping_url("https://a b"));
    }
}

#[cfg(test)]
mod ping_url_tests {
    use super::is_ping_url;

    #[test]
    fn only_public_https_hosts_are_pinged() {
        assert!(is_ping_url("https://ping.example.com/QoS"));
        assert!(!is_ping_url("http://ping.example.com/QoS"));
        assert!(!is_ping_url("https://127.0.0.1/QoS"));
        assert!(!is_ping_url("https://localhost/QoS"));
        assert!(!is_ping_url("https://box.internal/QoS"));
        assert!(!is_ping_url("https://user:pw@example.com/QoS"));
    }
}
