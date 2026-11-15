// RR-38 offline mode: the launcher's OFFLINE half (Ramsgate Reborn only).
//
// Offline mode never talks to the live server. It has its own local save, made on this PC at "Install offline". So this
// module:
//   - has no HTTP client and no socket code, and names no live host (the test below and the CI scan check it),
//   - never uses the online session, its tokens or the secure store (crate::commands / crate::auth are off limits),
//   - downloads, imports and copies nothing from the online account,
//   - writes only inside %LOCALAPPDATA%\RamsgateReborn\offline (and the launcher-mode file),
//   - starts the offline scripts with an action and local paths, nothing else, and every process it starts is hidden
//     (CREATE_NO_WINDOW; a test below fails if a spawn lacks it).

pub mod commands;
pub mod lifetime;
pub mod mode;
pub mod paths;
pub mod rates;
pub mod stack;

#[cfg(test)]
mod one_way_tests {
    use std::fs;
    use std::path::Path;

    /// Every source file of this module, read at test time so a new file cannot slip past the check.
    fn module_sources() -> Vec<(String, String)> {
        let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("src").join("offline");
        let mut out = Vec::new();
        for e in fs::read_dir(&dir).expect("offline module folder").flatten() {
            let p = e.path();
            if p.extension().and_then(|x| x.to_str()) == Some("rs") {
                out.push((p.file_name().unwrap().to_string_lossy().to_string(), fs::read_to_string(&p).unwrap()));
            }
        }
        assert!(out.len() >= 6, "expected the offline module files, found {}", out.len());
        out
    }

    /// Code without comments and without the #[cfg(test)] tail (tests spell out the very names they forbid).
    pub(crate) fn code_only(src: &str) -> String {
        let src = match src.find("#[cfg(test)]") {
            Some(i) => &src[..i],
            None => src,
        };
        src.lines()
            .map(|l| match l.find("//") {
                Some(i) if !l[..i].contains('"') => &l[..i],
                _ => l,
            })
            .collect::<Vec<_>>()
            .join("\n")
    }

    const FORBIDDEN: [&str; 30] = [
        // HTTP / socket crates and std networking
        "reqwest", "hyper", "ureq", "curl", "isahc", "surf::", "attohttpc", "tungstenite", "websocket", "std::net",
        "TcpStream", "TcpListener", "UdpSocket", "ToSocketAddrs", "SocketAddr",
        // any URL at all (the offline half needs none; the services bind 127.0.0.1 by their own config)
        "http://", "https://", "ws://", "wss://",
        // the online half: its module, session, tokens and secure store
        "crate::commands", "crate::auth", "crate::launch", "secure_store", "api_base_url", "http_client",
        "refresh_native_session", "access_token", "refresh_token", "bearer", "MYSTPAX",
    ];

    #[test]
    fn offline_module_has_no_network_code_and_no_online_session() {
        for (name, src) in module_sources() {
            let code = code_only(&src);
            for f in FORBIDDEN {
                assert!(!code.contains(f), "{name} contains forbidden `{f}`: the offline half must not be able to reach the network or the online session");
            }
            assert!(!code.to_ascii_lowercase().contains("authorization"), "{name} builds an Authorization header");
        }
    }

    /// Every process the offline half starts must be hidden: the player sees only the launcher and the game.
    #[test]
    fn every_offline_spawn_is_hidden() {
        let mut spawns = 0;
        for (name, src) in module_sources() {
            let code = code_only(&src);
            // Each Command::new needs its own creation_flags(CREATE_NO_WINDOW) in the same file, and the flag must be the
            // real CREATE_NO_WINDOW value.
            let made = code.matches("Command::new(").count();
            let hidden = code.matches("creation_flags(CREATE_NO_WINDOW)").count();
            spawns += made;
            assert!(hidden >= made, "{name}: {made} spawn(s) but only {hidden} with CREATE_NO_WINDOW");
            if made > 0 {
                assert!(code.contains("CREATE_NO_WINDOW: u32 = 0x0800_0000"), "{name}: CREATE_NO_WINDOW is not the real flag value");
            }
            for bad in ["ShellExecute", "open::that", "Command::new(\"cmd", ".spawn()", "Stdio::inherit"] {
                assert!(!code.contains(bad) || bad == ".spawn()", "{name} uses `{bad}`");
            }
            assert!(!code.contains("CREATE_NEW_CONSOLE"), "{name} opens a console window");
        }
        assert!(spawns >= 1, "expected the offline script spawn, found none");
    }

    #[test]
    fn offline_module_imports_only_itself_and_the_install_path() {
        for (name, src) in module_sources() {
            let code = code_only(&src);
            for (i, _) in code.match_indices("crate::") {
                let rest = &code[i..];
                assert!(
                    rest.starts_with("crate::offline") || rest.starts_with("crate::install::paths"),
                    "{name}: `{}` is outside the offline module",
                    &rest[..rest.find(|c: char| c == ';' || c == '(' || c == '\n').unwrap_or(rest.len()).min(60)]
                );
            }
        }
    }

    /// Every Tauri command here is named offline_* and takes no token, ticket, URL, password, secret or key.
    #[test]
    fn offline_commands_take_no_credentials_or_addresses() {
        let mut commands = 0;
        for (name, src) in module_sources() {
            let code = code_only(&src);
            let mut at = 0;
            while let Some(i) = code[at..].find("#[tauri::command]") {
                let start = at + i;
                let sig_start = code[start..].find("fn ").map(|j| start + j + 3).unwrap();
                let sig_end = code[sig_start..].find('{').map(|j| sig_start + j).unwrap();
                let sig = &code[sig_start..sig_end];
                let fn_name = sig.split('(').next().unwrap().trim();
                assert!(fn_name.starts_with("offline_"), "{name}: command {fn_name} is not named offline_*");
                let params = &sig[sig.find('(').unwrap() + 1..sig.rfind(')').unwrap()];
                for p in params.split(',') {
                    let pname = p.split(':').next().unwrap().trim().to_ascii_lowercase();
                    for bad in ["token", "ticket", "url", "password", "secret", "key", "auth", "host", "session"] {
                        assert!(!pname.contains(bad), "{name}: {fn_name} takes `{pname}`");
                    }
                }
                commands += 1;
                at = sig_end;
            }
        }
        assert!(commands >= 14, "expected the offline commands, found {commands}");
    }

    /// The code-only filter itself must not hide real code.
    #[test]
    fn code_only_keeps_code() {
        let s = "let a = \"http://x\"; // note\n// use reqwest;\nuse std::net::TcpStream;\n#[cfg(test)]\nmod t { reqwest }";
        let c = code_only(s);
        assert!(c.contains("http://x"));
        assert!(c.contains("std::net"));
        assert!(!c.contains("reqwest"));
    }
}
