//! Remote client: talk to the Buffers server (a tiny Flask app; see the spec in
//! server/). The philosophy is one-way — this machine PUSHes its own open
//! buffers under its own hostname, and can READ every machine's buffers; it
//! never writes another host's state. All scheduling, payload shaping and
//! settings live in the frontend (src/remote.ts); these commands are stateless
//! plumbing, exactly like store.rs.
//!
//! Deliberately no retries: every push is a full snapshot, so a missed one
//! self-heals on the next. Never log the token or full request URLs.

use serde_json::Value;

fn client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .map_err(|e| e.to_string())
}

/// The configured base URL, with any trailing slash trimmed so joins are clean.
fn base(url: &str) -> &str {
    url.trim_end_matches('/')
}

/// A short, token-free message for a transport-level failure. reqwest's Display
/// includes the request URL; strip it — the UI shows these strings verbatim.
fn net_err(e: reqwest::Error) -> String {
    if e.is_timeout() {
        "request timed out".into()
    } else if e.is_connect() {
        "cannot reach the server".into()
    } else {
        e.without_url().to_string()
    }
}

/// Pass 2xx through; map anything else to a short message the UI can show.
fn ok_status(resp: reqwest::Response) -> Result<reqwest::Response, String> {
    let status = resp.status();
    if status.is_success() {
        return Ok(resp);
    }
    Err(match status.as_u16() {
        401 => "HTTP 401 — bad or missing token".into(),
        413 => "HTTP 413 — buffers exceed the server's 1 MB cap".into(),
        _ => format!("HTTP {status}"),
    })
}

/// PUT this host's buffers. The payload is shaped by the frontend
/// (`{buffers: [{name, language, text}]}`) — pass it through untouched.
#[tauri::command]
pub async fn remote_push(
    url: String,
    user: String,
    host: String,
    token: String,
    payload: Value,
) -> Result<(), String> {
    let resp = client()?
        .put(format!("{}/api/v1/{}/{}", base(&url), user, host))
        .header("X-Buffers-Token", token)
        .json(&payload)
        .send()
        .await
        .map_err(net_err)?;
    ok_status(resp).map(|_| ())
}

/// GET every host's buffers, newest host first (the Remote tab's data).
#[tauri::command]
pub async fn remote_fetch(url: String, user: String, token: String) -> Result<Value, String> {
    let resp = client()?
        .get(format!("{}/api/v1/{}", base(&url), user))
        .header("X-Buffers-Token", token)
        .send()
        .await
        .map_err(net_err)?;
    ok_status(resp)?
        .json::<Value>()
        .await
        .map_err(|e| e.without_url().to_string())
}

/// GET /ping — liveness only (no auth, so it can't validate a token).
#[tauri::command]
pub async fn remote_ping(url: String) -> Result<(), String> {
    let resp = client()?
        .get(format!("{}/ping", base(&url)))
        .send()
        .await
        .map_err(net_err)?;
    ok_status(resp).map(|_| ())
}

/// This machine's hostname, sanitized to the server's host charset
/// (`^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`): lowercased, runs of disallowed
/// characters collapsed to one `-`, leading non-alphanumerics stripped,
/// truncated to 64. Used to seed the remoteHost setting on first run; may be
/// empty if the hostname contains nothing usable.
#[tauri::command]
pub fn machine_hostname() -> String {
    sanitize_host(&gethostname::gethostname().to_string_lossy())
}

fn sanitize_host(raw: &str) -> String {
    let mut out = String::new();
    let mut in_run = false; // inside a run of disallowed chars (→ one dash)
    for c in raw.to_lowercase().chars() {
        if out.len() == 64 {
            break;
        }
        // First char must be alphanumeric; after that ., _ and - pass through.
        let ok = c.is_ascii_alphanumeric() || (!out.is_empty() && matches!(c, '.' | '_' | '-'));
        if ok {
            out.push(c);
            in_run = false;
        } else if !out.is_empty() && !in_run {
            out.push('-');
            in_run = true;
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::sanitize_host;

    #[test]
    fn plain_hostnames_pass_through_lowercased() {
        assert_eq!(sanitize_host("Martons-MacBook.local"), "martons-macbook.local");
        assert_eq!(sanitize_host("DESKTOP-ABC123"), "desktop-abc123");
    }

    #[test]
    fn disallowed_runs_collapse_to_one_dash() {
        assert_eq!(sanitize_host("Marton's Mac"), "marton-s-mac");
        assert_eq!(sanitize_host("héllo wörld"), "h-llo-w-rld");
    }

    #[test]
    fn leading_junk_is_stripped_not_dashed() {
        assert_eq!(sanitize_host("--weird"), "weird");
        assert_eq!(sanitize_host("'quoted'"), "quoted-");
        assert_eq!(sanitize_host("???"), "");
    }

    #[test]
    fn truncates_to_64() {
        let long = "a".repeat(100);
        assert_eq!(sanitize_host(&long).len(), 64);
    }
}
