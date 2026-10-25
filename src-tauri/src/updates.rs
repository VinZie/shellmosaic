//! App updates by channel. Stable reads GitHub's latest release; Test reads the rolling
//! `test-build` pre-release too and offers whichever is newer, so testers move on to a stable
//! release once it passes their build.
//!
//! The update found is handed to the updater plugin's JS side (its `Update` class), which
//! downloads, verifies the signature and installs it as usual.

use std::time::Duration;

use serde_json::{json, Value};
use tauri::{Manager, Webview};
use tauri_plugin_updater::{Update, UpdaterExt};

const STABLE: &str = "https://github.com/VinZie/shellmosaic/releases/latest/download/latest.json";
const TEST: &str = "https://github.com/VinZie/shellmosaic/releases/download/test-build/latest.json";

async fn check_one(webview: &Webview, url: &str) -> Result<Option<Update>, String> {
    let url = url.parse().map_err(|e| format!("{e}"))?;
    let updater = webview
        .updater_builder()
        .endpoints(vec![url])
        .map_err(|e| e.to_string())?
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|e| e.to_string())?;
    updater.check().await.map_err(|e| e.to_string())
}

fn newer(a: &str, b: &str) -> bool {
    match (semver::Version::parse(a), semver::Version::parse(b)) {
        (Ok(a), Ok(b)) => a > b,
        _ => false,
    }
}

/// `{rid, currentVersion, version, body, rawJson}` (what `new Update(…)` takes), or null
/// when there's nothing newer on the channel.
#[tauri::command]
pub async fn update_check(webview: Webview, channel: String) -> Result<Option<Value>, String> {
    let stable = check_one(&webview, STABLE).await;
    let found = if channel == "test" {
        // no test build published (yet) is fine: fall back to stable
        match (check_one(&webview, TEST).await, stable) {
            (Ok(Some(t)), Ok(Some(s))) => Some(if newer(&s.version, &t.version) { s } else { t }),
            (Ok(t), Ok(s)) => t.or(s),
            (Ok(t), Err(_)) => t,
            (Err(_), s) => s?,
        }
    } else {
        stable?
    };
    Ok(found.map(|u| {
        let meta = json!({
            "currentVersion": u.current_version,
            "version": u.version,
            "body": u.body,
            "rawJson": u.raw_json,
        });
        let rid = webview.resources_table().add(u);
        let mut meta = meta;
        meta["rid"] = json!(rid);
        meta
    }))
}
