//! Claude plan usage for plugins with the `claude.usage` permission: the session and
//! weekly limits that Claude Code's `/usage` shows.
//!
//! The access token Claude Code saved at sign-in is read here and sent to Anthropic
//! only; plugins get the usage numbers, never the token. It isn't refreshed here
//! either (that would rotate Claude Code's own credentials under it): once it
//! expires, running `claude` refreshes it and the next check picks it up.

use std::path::PathBuf;
use std::sync::OnceLock;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use reqwest::header::{HeaderValue, ACCEPT, AUTHORIZATION, RETRY_AFTER};
use reqwest::StatusCode;
use serde::Deserialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Manager};
use zeroize::Zeroizing;

/// The endpoint Claude Code's `/usage` reads (undocumented, so the plugin parses it leniently).
const ENDPOINT: &str = "https://api.anthropic.com/api/oauth/usage";
const OAUTH_BETA: &str = "oauth-2025-04-20";
/// Every pane of the plugin, in every window, polls on its own: answers this recent are
/// shared, so Anthropic sees at most one request a minute however many panes are open.
const FRESH: Duration = Duration::from_secs(60);
/// Longest wait after repeated "too many requests" answers.
const MAX_BACKOFF: u64 = 15 * 60;
const MAX_BODY: usize = 1024 * 1024;
const SIGN_IN: &str = "Run `claude` in a terminal and sign in.";

#[derive(Default)]
pub struct ClaudeUsage {
    /// held across the request, so callers that arrive meanwhile wait for its answer
    last: tokio::sync::Mutex<Option<Cached>>,
    client: OnceLock<reqwest::Client>,
}

/// How a request ended, for the backoff.
enum Outcome {
    Done,
    RateLimited(Option<u64>),
}

struct Cached {
    until: Instant,
    result: Result<Value, String>,
    /// "too many requests" answers in a row: each one doubles the wait
    strikes: u32,
}

#[derive(Deserialize)]
struct CredentialsFile {
    #[serde(rename = "claudeAiOauth")]
    oauth: Option<OAuth>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct OAuth {
    #[serde(default)]
    access_token: String,
    expires_at: Option<i64>,
    subscription_type: Option<String>,
    rate_limit_tier: Option<String>,
}

fn now_ms() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

/// Where Claude Code keeps its sign-in: `%CLAUDE_CONFIG_DIR%` or `~\.claude`.
fn credentials_path(app: &AppHandle) -> Option<PathBuf> {
    let dir = match std::env::var_os("CLAUDE_CONFIG_DIR").filter(|d| !d.is_empty()) {
        Some(d) => PathBuf::from(d),
        None => app.path().home_dir().ok()?.join(".claude"),
    };
    Some(dir.join(".credentials.json"))
}

async fn read_credentials(app: &AppHandle) -> Result<OAuth, String> {
    let path = credentials_path(app).ok_or("Couldn't find your home folder.")?;
    let bytes: Zeroizing<Vec<u8>> = match tokio::fs::read(&path).await {
        Ok(b) => Zeroizing::new(b),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Err(format!("Claude Code isn't signed in on this computer. {SIGN_IN}"))
        }
        Err(e) => return Err(format!("Couldn't read Claude Code's sign-in: {e}")),
    };
    let file: CredentialsFile =
        serde_json::from_slice(bytes.as_slice()).map_err(|_| "Claude Code's sign-in file isn't valid JSON.".to_string())?;
    match file.oauth {
        Some(o) if !o.access_token.is_empty() => Ok(o),
        // signed in with an API key, or logged out
        _ => Err(format!("Claude Code isn't signed in with a Claude account. {SIGN_IN}")),
    }
}

fn describe(e: reqwest::Error) -> String {
    if e.is_timeout() {
        "Claude didn't answer in time.".into()
    } else if e.is_connect() {
        "Couldn't connect to api.anthropic.com. Are you offline?".into()
    } else {
        format!("The usage request failed: {}", e.without_url())
    }
}

/// One request, and whether Claude turned it away for asking too often.
async fn fetch(app: &AppHandle, client: &reqwest::Client) -> (Result<Value, String>, Outcome) {
    let mut oauth = match read_credentials(app).await {
        Ok(o) => o,
        Err(e) => return (Err(e), Outcome::Done),
    };
    if oauth.expires_at.is_some_and(|t| t <= now_ms()) {
        let msg = "Your Claude sign-in has expired. Run `claude` once to refresh it; usage shows up again on the next check.";
        return (Err(msg.into()), Outcome::Done);
    }
    let token = Zeroizing::new(std::mem::take(&mut oauth.access_token));
    let bearer = Zeroizing::new(format!("Bearer {}", token.as_str()));
    let Ok(mut auth) = HeaderValue::from_str(bearer.as_str()) else {
        return (Err(format!("Claude Code's saved token is malformed. {SIGN_IN}")), Outcome::Done);
    };
    auth.set_sensitive(true);

    let sent = client
        .get(ENDPOINT)
        .header(AUTHORIZATION, auth)
        .header("anthropic-beta", OAUTH_BETA)
        .header(ACCEPT, "application/json")
        .send()
        .await;
    let mut resp = match sent {
        Ok(r) => r,
        Err(e) => return (Err(describe(e)), Outcome::Done),
    };
    let status = resp.status();
    if status == StatusCode::TOO_MANY_REQUESTS {
        let after = resp
            .headers()
            .get(RETRY_AFTER)
            .and_then(|v| v.to_str().ok())
            .and_then(|s| s.trim().parse::<u64>().ok());
        return (Err(String::new()), Outcome::RateLimited(after));
    }
    if status == StatusCode::UNAUTHORIZED || status == StatusCode::FORBIDDEN {
        return (Err(format!("Claude didn't accept the saved sign-in. {SIGN_IN}")), Outcome::Done);
    }
    if !status.is_success() {
        return (Err(format!("Claude answered the usage request with HTTP {}.", status.as_u16())), Outcome::Done);
    }

    let mut body = Vec::new();
    loop {
        match resp.chunk().await {
            Ok(Some(chunk)) if body.len() + chunk.len() <= MAX_BODY => body.extend_from_slice(&chunk),
            Ok(Some(_)) => return (Err("Claude's usage answer was unexpectedly large.".into()), Outcome::Done),
            Ok(None) => break,
            Err(e) => return (Err(describe(e)), Outcome::Done),
        }
    }
    let usage = match serde_json::from_slice::<Value>(&body) {
        Ok(v) if v.is_object() => v,
        _ => return (Err("Claude's usage answer wasn't in the expected format.".into()), Outcome::Done),
    };
    let out = json!({
        "fetchedAt": now_ms(),
        "plan": { "subscription": oauth.subscription_type, "tier": oauth.rate_limit_tier },
        "usage": usage,
    });
    (Ok(out), Outcome::Done)
}

/// Wait after the `strikes`-th "too many requests" in a row: what Claude asked for, but
/// at least a minute, doubling with each strike, at most 15 minutes.
fn backoff(strikes: u32, retry_after: Option<u64>) -> u64 {
    let doubled = FRESH.as_secs().saturating_mul(1u64 << strikes.saturating_sub(1).min(8));
    retry_after.unwrap_or(0).max(doubled).clamp(FRESH.as_secs(), MAX_BACKOFF)
}

impl ClaudeUsage {
    fn client(&self) -> Result<&reqwest::Client, String> {
        if let Some(c) = self.client.get() {
            return Ok(c);
        }
        // reqwest is built without a TLS provider of its own (like the updater's): use ring
        if rustls::crypto::CryptoProvider::get_default().is_none() {
            let _ = rustls::crypto::ring::default_provider().install_default();
        }
        let c = reqwest::Client::builder()
            .user_agent(concat!("Shellmosaic/", env!("CARGO_PKG_VERSION")))
            .timeout(Duration::from_secs(10))
            // the bearer token goes to api.anthropic.com and nowhere else
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .map_err(|e| format!("Couldn't set up HTTPS: {e}"))?;
        Ok(self.client.get_or_init(|| c))
    }
}

/// `{fetchedAt, plan: {subscription, tier}, usage}`, where `usage` is the endpoint's JSON as is.
#[tauri::command]
pub async fn claude_usage(app: AppHandle, state: tauri::State<'_, ClaudeUsage>) -> Result<Value, String> {
    let mut last = state.last.lock().await;
    if let Some(c) = last.as_ref().filter(|c| Instant::now() < c.until) {
        return c.result.clone();
    }
    let (result, outcome) = fetch(&app, state.client()?).await;
    let prev = last.take();
    let cached = match outcome {
        Outcome::Done => Cached { until: Instant::now() + FRESH, result, strikes: 0 },
        Outcome::RateLimited(after) => {
            let strikes = prev.as_ref().map_or(0, |c| c.strikes) + 1;
            let wait = backoff(strikes, after);
            // (the plugin keeps showing its last good numbers, marked stale)
            let msg = format!("Claude is rate-limiting usage checks. Trying again in {}.", minutes(wait));
            Cached { until: Instant::now() + Duration::from_secs(wait), result: Err(msg), strikes }
        }
    };
    let result = cached.result.clone();
    *last = Some(cached);
    result
}

fn minutes(secs: u64) -> String {
    match secs {
        0..=89 => format!("{secs} s"),
        _ => format!("{} min", (secs + 30) / 60),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn backoff_doubles_from_a_minute_up_to_fifteen() {
        assert_eq!(backoff(1, None), 60);
        assert_eq!(backoff(2, None), 120);
        assert_eq!(backoff(3, Some(30)), 240);
        assert_eq!(backoff(1, Some(300)), 300);
        assert_eq!(backoff(9, None), 900);
        assert_eq!(backoff(1, Some(5000)), 900);
    }
}
