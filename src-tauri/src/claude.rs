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
/// Every pane of the plugin, in every window, polls on its own: answers this recent are shared.
const FRESH: Duration = Duration::from_secs(25);
const MAX_BODY: usize = 1024 * 1024;
const SIGN_IN: &str = "Run `claude` in a terminal and sign in.";

#[derive(Default)]
pub struct ClaudeUsage {
    /// held across the request, so callers that arrive meanwhile wait for its answer
    last: tokio::sync::Mutex<Option<Cached>>,
    client: OnceLock<reqwest::Client>,
}

struct Cached {
    until: Instant,
    result: Result<Value, String>,
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

/// One request. Also says how long its answer may be reused.
async fn fetch(app: &AppHandle, client: &reqwest::Client) -> (Result<Value, String>, Duration) {
    let mut oauth = match read_credentials(app).await {
        Ok(o) => o,
        Err(e) => return (Err(e), FRESH),
    };
    if oauth.expires_at.is_some_and(|t| t <= now_ms()) {
        let msg = "Your Claude sign-in has expired. Run `claude` once to refresh it; usage shows up again on the next check.";
        return (Err(msg.into()), FRESH);
    }
    let token = Zeroizing::new(std::mem::take(&mut oauth.access_token));
    let bearer = Zeroizing::new(format!("Bearer {}", token.as_str()));
    let Ok(mut auth) = HeaderValue::from_str(bearer.as_str()) else {
        return (Err(format!("Claude Code's saved token is malformed. {SIGN_IN}")), FRESH);
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
        Err(e) => return (Err(describe(e)), FRESH),
    };
    let status = resp.status();
    if status == StatusCode::TOO_MANY_REQUESTS {
        let wait = resp
            .headers()
            .get(RETRY_AFTER)
            .and_then(|v| v.to_str().ok())
            .and_then(|s| s.trim().parse::<u64>().ok())
            .unwrap_or(60)
            .clamp(FRESH.as_secs(), 900);
        return (Err(format!("Claude is rate-limiting usage checks. Trying again in {wait} s.")), Duration::from_secs(wait));
    }
    if status == StatusCode::UNAUTHORIZED || status == StatusCode::FORBIDDEN {
        return (Err(format!("Claude didn't accept the saved sign-in. {SIGN_IN}")), FRESH);
    }
    if !status.is_success() {
        return (Err(format!("Claude answered the usage request with HTTP {}.", status.as_u16())), FRESH);
    }

    let mut body = Vec::new();
    loop {
        match resp.chunk().await {
            Ok(Some(chunk)) if body.len() + chunk.len() <= MAX_BODY => body.extend_from_slice(&chunk),
            Ok(Some(_)) => return (Err("Claude's usage answer was unexpectedly large.".into()), FRESH),
            Ok(None) => break,
            Err(e) => return (Err(describe(e)), FRESH),
        }
    }
    let usage = match serde_json::from_slice::<Value>(&body) {
        Ok(v) if v.is_object() => v,
        _ => return (Err("Claude's usage answer wasn't in the expected format.".into()), FRESH),
    };
    let out = json!({
        "fetchedAt": now_ms(),
        "plan": { "subscription": oauth.subscription_type, "tier": oauth.rate_limit_tier },
        "usage": usage,
    });
    (Ok(out), FRESH)
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
    let (result, keep) = fetch(&app, state.client()?).await;
    *last = Some(Cached { until: Instant::now() + keep, result: result.clone() });
    result
}
