//! What kind of network problem stopped the launcher, and the shared timeout and retry settings.
//!
//! When the launcher can't reach the servers the player only sees "can't reach", which doesn't tell us whether the
//! name lookup failed, the connection hung, a certificate was refused or a proxy got in the way. The class is written
//! to the launcher log (no addresses, no paths) so the uploaded log says which one it was.

use std::time::Duration;

/// Time allowed to open a connection.
pub(crate) const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
/// Time allowed for the whole request.
pub(crate) const TOTAL_TIMEOUT: Duration = Duration::from_secs(20);
/// A failed request is tried once more, never more.
pub(crate) const EXTRA_TRIES: u32 = 1;
const RETRY_PAUSE: Duration = Duration::from_secs(1);

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) enum NetClass {
    Dns,
    Timeout,
    Tls,
    Proxy,
    Other,
}

impl NetClass {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            NetClass::Dns => "dns",
            NetClass::Timeout => "timeout",
            NetClass::Tls => "tls",
            NetClass::Proxy => "proxy",
            NetClass::Other => "other",
        }
    }
}

/// Maps the text of an error (with everything it wraps) to a class. Proxy and name-lookup wording is checked first
/// because those failures are often reported inside a generic "connect" or "timed out" message.
pub(crate) fn class_from_text(text: &str) -> NetClass {
    let t = text.to_ascii_lowercase();
    let has = |words: &[&str]| words.iter().any(|w| t.contains(w));
    if has(&["proxy", "tunnel"]) {
        NetClass::Proxy
    } else if has(&[
        "dns error",
        "failed to lookup",
        "no such host",
        "name or service not known",
        "nodename nor servname",
        "no address associated",
        "os error 11001",
        "temporary failure in name resolution",
    ]) {
        NetClass::Dns
    } else if has(&["certificate", "tls", "ssl", "handshake", "unknown issuer", "received fatal alert"]) {
        NetClass::Tls
    } else if has(&["timed out", "timeout", "deadline has elapsed", "os error 10060"]) {
        NetClass::Timeout
    } else {
        NetClass::Other
    }
}

/// The error and every error it wraps, as one string.
fn error_chain_text(error: &reqwest::Error) -> String {
    use std::error::Error as _;
    let mut text = error.to_string();
    let mut source = error.source();
    while let Some(inner) = source {
        text.push_str(": ");
        text.push_str(&inner.to_string());
        source = inner.source();
    }
    text
}

pub(crate) fn classify(error: &reqwest::Error) -> NetClass {
    match class_from_text(&error_chain_text(error)) {
        NetClass::Other if error.is_timeout() => NetClass::Timeout,
        other => other,
    }
}

/// Runs `attempt` and, when it fails, once more after a short pause. Returns the result and how many tries were made.
pub(crate) fn try_with_retry<T, E>(
    mut attempt: impl FnMut() -> Result<T, E>,
    mut pause: impl FnMut(Duration),
) -> (Result<T, E>, u32) {
    let mut tries = 0;
    loop {
        tries += 1;
        match attempt() {
            Ok(value) => return (Ok(value), tries),
            Err(error) if tries > EXTRA_TRIES => return (Err(error), tries),
            Err(_) => pause(RETRY_PAUSE),
        }
    }
}

/// Checks that the servers answer and writes one line saying which class of problem it is when they don't.
/// Called after a launch stopped early, off the player's path.
pub(crate) fn log_reachability(session_dir: &std::path::Path) {
    use crate::commands::auth::{api_base_url, http_client};
    use crate::launch::logs::append_launcher_log;
    let Ok(client) = http_client() else {
        append_launcher_log(session_dir, "network check: could not set up a connection");
        return;
    };
    let url = format!("{}/launcher/v1/status", api_base_url());
    let (result, tries) = try_with_retry(|| client.get(&url).send(), std::thread::sleep);
    match result {
        Ok(response) => append_launcher_log(
            session_dir,
            &format!("network check: server answered HTTP {} (tries: {tries})", response.status().as_u16()),
        ),
        Err(error) => append_launcher_log(
            session_dir,
            &format!("network check: server not reachable, class={} (tries: {tries})", classify(&error).as_str()),
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::{Cell, RefCell};

    #[test]
    fn dns_failures_are_dns() {
        for text in [
            "error sending request: error trying to connect: dns error: failed to lookup address information: No such host is known. (os error 11001)",
            "dns error: Temporary failure in name resolution",
            "Name or service not known",
        ] {
            assert_eq!(class_from_text(text), NetClass::Dns, "{text}");
        }
    }

    #[test]
    fn timeouts_are_timeouts() {
        for text in ["operation timed out", "connection timed out (os error 10060)", "deadline has elapsed"] {
            assert_eq!(class_from_text(text), NetClass::Timeout, "{text}");
        }
    }

    #[test]
    fn certificate_and_handshake_problems_are_tls() {
        for text in [
            "invalid peer certificate: UnknownIssuer",
            "received fatal alert: HandshakeFailure",
            "tls handshake eof",
        ] {
            assert_eq!(class_from_text(text), NetClass::Tls, "{text}");
        }
    }

    #[test]
    fn proxy_wording_wins_over_the_generic_failure() {
        assert_eq!(class_from_text("proxy connect failed: operation timed out"), NetClass::Proxy);
        assert_eq!(class_from_text("tunnel error: unsuccessful tunnel"), NetClass::Proxy);
    }

    #[test]
    fn anything_else_is_other() {
        assert_eq!(class_from_text("connection refused (os error 10061)"), NetClass::Other);
        assert_eq!(class_from_text(""), NetClass::Other);
    }

    #[test]
    fn class_names_are_the_logged_words() {
        let names: Vec<_> = [NetClass::Dns, NetClass::Timeout, NetClass::Tls, NetClass::Proxy, NetClass::Other]
            .iter()
            .map(|c| c.as_str())
            .collect();
        assert_eq!(names, ["dns", "timeout", "tls", "proxy", "other"]);
    }

    #[test]
    fn timeouts_are_ten_and_twenty_seconds() {
        assert_eq!(CONNECT_TIMEOUT.as_secs(), 10);
        assert_eq!(TOTAL_TIMEOUT.as_secs(), 20);
        assert!(CONNECT_TIMEOUT < TOTAL_TIMEOUT);
        assert_eq!(EXTRA_TRIES, 1);
    }

    #[test]
    fn a_failing_call_is_tried_exactly_twice() {
        let calls = Cell::new(0);
        let pauses = RefCell::new(Vec::new());
        let (result, tries) = try_with_retry(
            || {
                calls.set(calls.get() + 1);
                Err::<(), _>("down")
            },
            |d| pauses.borrow_mut().push(d),
        );
        assert_eq!(result, Err("down"));
        assert_eq!((tries, calls.get()), (2, 2));
        assert_eq!(pauses.borrow().len(), 1);
    }

    #[test]
    fn a_call_that_works_the_second_time_succeeds() {
        let calls = Cell::new(0);
        let (result, tries) = try_with_retry(
            || {
                calls.set(calls.get() + 1);
                if calls.get() == 1 { Err("blip") } else { Ok(7) }
            },
            |_| {},
        );
        assert_eq!((result, tries), (Ok(7), 2));
    }

    #[test]
    fn a_call_that_works_is_not_repeated() {
        let (result, tries) = try_with_retry(|| Ok::<_, ()>(1), |_| panic!("no pause expected"));
        assert_eq!((result, tries), (Ok(1), 1));
    }
}
