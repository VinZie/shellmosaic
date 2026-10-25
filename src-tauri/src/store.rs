//! Optional modules: plugins published in the Shellmosaic repository (`modules/` on
//! GitHub) with a catalog, `modules/index.json`, signed with the app's update key.
//!
//! Installs and removals are queued. An install downloads and verifies the files right
//! away (into `store/staged`), but the plugins folder only changes when Shellmosaic next
//! starts, so several can be lined up and applied with one restart.
//!
//! Testing without GitHub: `SHELLMOSAIC_MODULES_SOURCE=<a modules folder>` reads the
//! catalog and files from disk instead (still signature-checked).

use std::collections::HashMap;
use std::fs;
use std::path::{Component, Path, PathBuf};
use std::sync::OnceLock;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use base64::Engine;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Manager};

use crate::paths::{blocking, safe_key, write_atomic, ErrStr, Paths};

const REPO: &str = "VinZie/shellmosaic";
const MAX_INDEX: usize = 1 << 20;
const MAX_FILE: u64 = 20 << 20;
const MAX_MODULE: u64 = 64 << 20;
/// A catalog this fresh is reused (GitHub's API allows 60 unauthenticated calls an hour).
const CATALOG_TTL: Duration = Duration::from_secs(5 * 60);

#[derive(Default)]
pub struct Store {
    client: OnceLock<reqwest::Client>,
    catalogs: tokio::sync::Mutex<HashMap<String, (Instant, Catalog)>>,
    /// pending.json is read-modify-written by several commands
    queue: parking_lot::Mutex<()>,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Catalog {
    schema: u32,
    modules: Vec<Entry>,
    /// the commit (or branch) the catalog and its files come from
    #[serde(default)]
    source: String,
    #[serde(default)]
    branch: String,
    #[serde(default)]
    fetched_at: i64,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    id: String,
    name: String,
    version: String,
    #[serde(default)]
    description: String,
    #[serde(default)]
    icon: String,
    #[serde(default)]
    author: Option<String>,
    #[serde(default)]
    permissions: Vec<String>,
    min_app_version: String,
    files: Vec<FileEntry>,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct FileEntry {
    path: String,
    sha256: String,
    size: u64,
}

/// A queued change, applied at the next start.
#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Op {
    /// "install" (also updates) | "remove"
    op: String,
    id: String,
    #[serde(default)]
    name: String,
    #[serde(default)]
    version: Option<String>,
    /// what the user saw (and agreed to) when queueing the install
    #[serde(default)]
    permissions: Vec<String>,
    #[serde(default)]
    source: Option<String>,
    #[serde(default)]
    branch: Option<String>,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Installed {
    version: String,
    installed_at: i64,
    #[serde(default)]
    source: Option<String>,
    #[serde(default)]
    branch: Option<String>,
}

/// What happened to a queued change when it was applied.
#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Applied {
    op: String,
    id: String,
    name: String,
    ok: bool,
    error: Option<String>,
    #[serde(default)]
    permissions: Vec<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StoreState {
    installed: HashMap<String, Installed>,
    pending: Vec<Op>,
    last_apply: Vec<Applied>,
    app_version: String,
    /// plugin folders the store doesn't manage (an optional module with the same id replaces them)
    local: Vec<String>,
}

fn now_ms() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

fn dir(paths: &Paths) -> PathBuf {
    paths.root.join("store")
}

fn read_json<T: for<'de> Deserialize<'de>>(path: &Path) -> Option<T> {
    serde_json::from_slice(&fs::read(path).ok()?).ok()
}

fn write_json<T: Serialize>(path: &Path, value: &T) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).s()?;
    }
    write_atomic(path, &serde_json::to_vec_pretty(value).s()?).s()
}

fn installed_of(paths: &Paths) -> HashMap<String, Installed> {
    read_json(&dir(paths).join("installed.json")).unwrap_or_default()
}

fn pending_of(paths: &Paths) -> Vec<Op> {
    read_json(&dir(paths).join("pending.json")).unwrap_or_default()
}

fn state(app: &AppHandle, paths: &Paths) -> StoreState {
    let installed = installed_of(paths);
    let mut local = Vec::new();
    if let Ok(rd) = fs::read_dir(paths.plugins()) {
        for e in rd.flatten() {
            let id = e.file_name().to_string_lossy().into_owned();
            if e.path().is_dir() && safe_key(&id).is_ok() && !installed.contains_key(&id) {
                local.push(id);
            }
        }
    }
    local.sort();
    StoreState {
        installed,
        pending: pending_of(paths),
        last_apply: read_json(&dir(paths).join("last-apply.json")).unwrap_or_default(),
        app_version: app.package_info().version.to_string(),
        local,
    }
}

/// "1.2.10" > "1.2.9"; pre-release suffixes ("-test.1") are ignored.
fn version_at_least(have: &str, need: &str) -> bool {
    let parse = |v: &str| -> Vec<u64> {
        v.split(['-', '+']).next().unwrap_or("").split('.').map(|p| p.parse().unwrap_or(0)).collect()
    };
    let (a, b) = (parse(have), parse(need));
    for i in 0..a.len().max(b.len()) {
        let (x, y) = (a.get(i).copied().unwrap_or(0), b.get(i).copied().unwrap_or(0));
        if x != y {
            return x > y;
        }
    }
    true
}

fn branch_of(channel: &str) -> &'static str {
    if channel == "test" {
        "test"
    } else {
        "main"
    }
}

/// A relative path made of plain names only (no `..`, drive or root).
fn plain_relative(p: &str) -> bool {
    !p.is_empty() && p.len() <= 260 && Path::new(p).components().all(|c| matches!(c, Component::Normal(_)))
}

// ── fetching ────────────────────────────────────────────────────────────

impl Store {
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
            .timeout(Duration::from_secs(30))
            .build()
            .map_err(|e| format!("Couldn't set up HTTPS: {e}"))?;
        Ok(self.client.get_or_init(|| c))
    }

    async fn get(&self, url: &str, limit: u64, accept: Option<&str>) -> Result<Option<Vec<u8>>, String> {
        let mut req = self.client()?.get(url);
        if let Some(a) = accept {
            req = req.header(reqwest::header::ACCEPT, a);
        }
        let mut resp = req.send().await.map_err(|e| {
            if e.is_connect() || e.is_timeout() {
                "Couldn't reach GitHub. Are you offline?".to_string()
            } else {
                format!("Download failed: {}", e.without_url())
            }
        })?;
        if resp.status() == reqwest::StatusCode::NOT_FOUND {
            return Ok(None);
        }
        if !resp.status().is_success() {
            return Err(format!("GitHub answered with HTTP {}.", resp.status().as_u16()));
        }
        let mut body = Vec::new();
        while let Some(chunk) = resp.chunk().await.map_err(|e| format!("Download failed: {}", e.without_url()))? {
            if (body.len() + chunk.len()) as u64 > limit {
                return Err("A download was larger than expected.".into());
            }
            body.extend_from_slice(&chunk);
        }
        Ok(Some(body))
    }
}

/// Where the catalog and files come from.
enum Source {
    Local(PathBuf),
    GitHub { reference: String },
}

impl Source {
    fn name(&self) -> String {
        match self {
            Source::Local(p) => p.to_string_lossy().into_owned(),
            Source::GitHub { reference } => reference.clone(),
        }
    }
}

fn local_source() -> Option<PathBuf> {
    std::env::var_os("SHELLMOSAIC_MODULES_SOURCE").filter(|v| !v.is_empty()).map(PathBuf::from)
}

async fn read_from(store: &Store, src: &Source, rel: &str, limit: u64) -> Result<Option<Vec<u8>>, String> {
    match src {
        Source::Local(root) => {
            let p = root.join(rel);
            match tokio::fs::read(&p).await {
                Ok(b) if b.len() as u64 <= limit => Ok(Some(b)),
                Ok(_) => Err("A file was larger than expected.".into()),
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
                Err(e) => Err(format!("Couldn't read {}: {e}", p.display())),
            }
        }
        Source::GitHub { reference } => {
            store.get(&format!("https://raw.githubusercontent.com/{REPO}/{reference}/modules/{rel}"), limit, None).await
        }
    }
}

/// The commit at the tip of `branch`, so the catalog and every file come from the same
/// snapshot (raw.githubusercontent.com caches branch names for a few minutes).
async fn resolve(store: &Store, branch: &str) -> Source {
    if let Some(p) = local_source() {
        return Source::Local(p);
    }
    let url = format!("https://api.github.com/repos/{REPO}/commits/{branch}");
    let sha = store
        .get(&url, 1024, Some("application/vnd.github.sha"))
        .await
        .ok()
        .flatten()
        .map(|b| String::from_utf8_lossy(&b).trim().to_string())
        .filter(|s| s.len() == 40 && s.bytes().all(|c| c.is_ascii_hexdigit()));
    Source::GitHub { reference: sha.unwrap_or_else(|| branch.to_string()) }
}

/// Check `data` against a minisign signature (base64 of the .sig text, as `tauri signer`
/// writes it) with the public key the updater uses.
fn verify(app: &AppHandle, data: &[u8], sig: &[u8]) -> Result<(), String> {
    let b64 = base64::engine::general_purpose::STANDARD;
    let pubkey = app
        .config()
        .plugins
        .0
        .get("updater")
        .and_then(|u| u.get("pubkey"))
        .and_then(|k| k.as_str())
        .ok_or("This build has no signing key to check modules with.")?;
    let bad = || "The module catalog's signature is not valid. It was not installed.".to_string();
    let key_text = String::from_utf8(b64.decode(pubkey.trim()).map_err(|_| bad())?).map_err(|_| bad())?;
    let key = minisign_verify::PublicKey::decode(&key_text).map_err(|_| bad())?;
    let sig_text = String::from_utf8(b64.decode(String::from_utf8_lossy(sig).trim()).map_err(|_| bad())?).map_err(|_| bad())?;
    let signature = minisign_verify::Signature::decode(&sig_text).map_err(|_| bad())?;
    key.verify(data, &signature, true).map_err(|_| bad())
}

async fn fetch_catalog(app: &AppHandle, store: &Store, branch: &str) -> Result<Catalog, String> {
    let src = resolve(store, branch).await;
    let missing = || format!("No optional modules are published for this update channel ({branch}) yet.");
    let index = read_from(store, &src, "index.json", MAX_INDEX as u64).await?.ok_or_else(missing)?;
    let sig = read_from(store, &src, "index.json.sig", 4096).await?.ok_or("The module catalog isn't signed. Nothing was installed.")?;
    verify(app, &index, &sig)?;
    let mut catalog: Catalog = serde_json::from_slice(&index).map_err(|e| format!("The module catalog couldn't be read: {e}"))?;
    if catalog.schema != 1 {
        return Err("This module catalog needs a newer Shellmosaic.".into());
    }
    catalog.modules.retain(|m| {
        safe_key(&m.id).is_ok() && !m.files.is_empty() && m.files.iter().all(|f| plain_relative(&f.path) && f.sha256.len() == 64)
    });
    catalog.source = src.name();
    catalog.branch = branch.to_string();
    catalog.fetched_at = now_ms();
    Ok(catalog)
}

impl Store {
    async fn catalog(&self, app: &AppHandle, branch: &str, refresh: bool) -> Result<Catalog, String> {
        let mut cache = self.catalogs.lock().await;
        if !refresh {
            if let Some((t, c)) = cache.get(branch) {
                if t.elapsed() < CATALOG_TTL {
                    return Ok(c.clone());
                }
            }
        }
        let c = fetch_catalog(app, self, branch).await?;
        cache.insert(branch.to_string(), (Instant::now(), c.clone()));
        Ok(c)
    }
}

// ── commands ────────────────────────────────────────────────────────────

/// Installed modules, queued changes and the results of the last start's changes (no network).
#[tauri::command]
pub async fn store_state(app: AppHandle) -> Result<StoreState, String> {
    blocking(move || state(&app, &app.state::<Paths>())).await
}

/// The catalog for an update channel ("stable" → main branch, "test" → test branch).
#[tauri::command]
pub async fn store_catalog(app: AppHandle, channel: String, refresh: Option<bool>) -> Result<Catalog, String> {
    app.state::<Store>().catalog(&app, branch_of(&channel), refresh.unwrap_or(false)).await
}

/// Download and verify a module now; it's installed (or updated) at the next start.
#[tauri::command]
pub async fn store_queue_install(app: AppHandle, channel: String, id: String) -> Result<StoreState, String> {
    let id = safe_key(&id)?;
    let branch = branch_of(&channel);
    let store = app.state::<Store>();
    let catalog = store.catalog(&app, branch, false).await?;
    let entry = catalog.modules.iter().find(|m| m.id == id).cloned().ok_or("That module isn't in the catalog any more.")?;
    let version = app.package_info().version.to_string();
    if !version_at_least(&version, &entry.min_app_version) {
        return Err(format!("{} needs Shellmosaic {} or newer.", entry.name, entry.min_app_version));
    }
    if entry.files.iter().map(|f| f.size).sum::<u64>() > MAX_MODULE {
        return Err("That module is too large.".into());
    }
    let src = match local_source() {
        Some(p) => Source::Local(p),
        None => Source::GitHub { reference: catalog.source.clone() },
    };

    let paths = app.state::<Paths>().inner().clone();
    let staged = dir(&paths).join("staged");
    let part = staged.join(format!("{id}.part"));
    let _ = fs::remove_dir_all(&part);
    fs::create_dir_all(&part).s()?;
    let result: Result<(), String> = async {
        for f in &entry.files {
            let mismatch = || format!("A file of {} didn't match the signed catalog ({}). Nothing was installed.", entry.name, f.path);
            // never more than the catalog says: a longer file is a mismatch, not a download to finish
            let data = match read_from(&store, &src, &format!("{id}/dist/{}", f.path), MAX_FILE.min(f.size)).await {
                Ok(Some(d)) => d,
                Ok(None) => return Err(format!("A file of {} is missing on the server ({}). Try again in a few minutes.", entry.name, f.path)),
                Err(e) if e.contains("larger than expected") => return Err(mismatch()),
                Err(e) => return Err(e),
            };
            let hash = Sha256::digest(&data);
            let hex: String = hash.iter().map(|b| format!("{b:02x}")).collect();
            if data.len() as u64 != f.size || !hex.eq_ignore_ascii_case(&f.sha256) {
                return Err(mismatch());
            }
            let dest = part.join(&f.path);
            if let Some(parent) = dest.parent() {
                fs::create_dir_all(parent).s()?;
            }
            fs::write(dest, data).s()?;
        }
        crate::plugins::check_manifest(&part, &id)?;
        Ok(())
    }
    .await;
    if let Err(e) = result {
        let _ = fs::remove_dir_all(&part);
        return Err(e);
    }

    let app2 = app.clone();
    blocking(move || {
        let store = app2.state::<Store>();
        let _guard = store.queue.lock();
        let ready = staged.join(&id);
        let _ = fs::remove_dir_all(&ready);
        fs::rename(&part, &ready).s()?;
        let mut pending = pending_of(&paths);
        pending.retain(|o| o.id != id);
        pending.push(Op {
            op: "install".into(),
            id: id.clone(),
            name: entry.name.clone(),
            version: Some(entry.version.clone()),
            permissions: entry.permissions.clone(),
            source: Some(catalog.source.clone()),
            branch: Some(branch.to_string()),
        });
        write_json(&dir(&paths).join("pending.json"), &pending)?;
        Ok(state(&app2, &paths))
    })
    .await?
}

/// Remove a module at the next start (or just drop its queued install).
#[tauri::command]
pub async fn store_queue_remove(app: AppHandle, id: String, name: Option<String>) -> Result<StoreState, String> {
    let id = safe_key(&id)?;
    blocking(move || {
        let paths = app.state::<Paths>().inner().clone();
        let store = app.state::<Store>();
        let _guard = store.queue.lock();
        let mut pending = pending_of(&paths);
        pending.retain(|o| o.id != id);
        let _ = fs::remove_dir_all(dir(&paths).join("staged").join(&id));
        if paths.plugins().join(&id).is_dir() {
            pending.push(Op {
                op: "remove".into(),
                id: id.clone(),
                name: name.unwrap_or_else(|| id.clone()),
                version: None,
                permissions: Vec::new(),
                source: None,
                branch: None,
            });
        }
        write_json(&dir(&paths).join("pending.json"), &pending)?;
        Ok(state(&app, &paths))
    })
    .await?
}

/// Forget a queued change.
#[tauri::command]
pub async fn store_cancel(app: AppHandle, id: Option<String>) -> Result<StoreState, String> {
    blocking(move || {
        let paths = app.state::<Paths>().inner().clone();
        let store = app.state::<Store>();
        let _guard = store.queue.lock();
        let mut pending = pending_of(&paths);
        let staged = dir(&paths).join("staged");
        match id {
            Some(id) => {
                pending.retain(|o| o.id != id);
                if safe_key(&id).is_ok() {
                    let _ = fs::remove_dir_all(staged.join(&id));
                }
            }
            None => {
                pending.clear();
                let _ = fs::remove_dir_all(&staged);
            }
        }
        write_json(&dir(&paths).join("pending.json"), &pending)?;
        Ok(state(&app, &paths))
    })
    .await?
}

/// The app has shown the results of the last start's changes.
#[tauri::command]
pub async fn store_ack(app: AppHandle) -> Result<(), String> {
    blocking(move || {
        let _ = fs::remove_file(dir(&app.state::<Paths>()).join("last-apply.json"));
    })
    .await
}

/// A store module's folder was replaced or removed by hand (Settings → Plugins): it's the
/// user's own plugin from now on, and store updates must not overwrite it.
pub fn forget(paths: &Paths, id: &str) {
    let mut installed = installed_of(paths);
    if installed.remove(id).is_some() {
        let _ = write_json(&dir(paths).join("installed.json"), &installed);
    }
}

// ── at startup ──────────────────────────────────────────────────────────

/// Move a plugin folder out of the way: deleted when the store manages it, kept in
/// `store/replaced` when it's the user's own.
fn clear_plugin(paths: &Paths, id: &str, managed: bool) -> Result<(), String> {
    let path = paths.plugins().join(id);
    if !path.exists() {
        return Ok(());
    }
    if managed {
        fs::remove_dir_all(&path).map_err(|e| format!("couldn't remove the old version: {e}"))
    } else {
        let backup = dir(paths).join("replaced").join(format!("{id}-{}", now_ms()));
        fs::create_dir_all(backup.parent().unwrap_or(&backup)).s()?;
        fs::rename(&path, &backup).map_err(|e| format!("couldn't move your plugin of the same name aside: {e}"))
    }
}

fn copy_dir(src: &Path, dst: &Path) -> std::io::Result<()> {
    fs::create_dir_all(dst)?;
    for e in fs::read_dir(src)?.flatten() {
        let to = dst.join(e.file_name());
        if e.file_type()?.is_dir() {
            copy_dir(&e.path(), &to)?;
        } else {
            fs::copy(e.path(), to)?;
        }
    }
    Ok(())
}

/// Claude Usage was bundled with 0.2.x: a copy we installed back then is the store's now.
fn adopt_bundled(paths: &Paths, installed: &mut HashMap<String, Installed>) -> bool {
    const ID: &str = "claude-usage";
    let marker = fs::read_to_string(paths.plugins().join(".examples-installed")).unwrap_or_default();
    let dir = paths.plugins().join(ID);
    if installed.contains_key(ID) || !dir.is_dir() || !marker.lines().any(|l| l.trim() == ID) {
        return false;
    }
    let version = read_json::<serde_json::Value>(&dir.join("manifest.json"))
        .and_then(|m| m.get("version").and_then(|v| v.as_str()).map(String::from))
        .unwrap_or_else(|| "1.0.0".into());
    installed.insert(ID.into(), Installed { version, installed_at: now_ms(), source: None, branch: None });
    true
}

/// Apply the installs and removals queued before the last exit (before anything reads
/// the plugins folder).
pub fn apply_pending(paths: &Paths) {
    let store = dir(paths);
    let mut installed = installed_of(paths);
    let adopted = adopt_bundled(paths, &mut installed);
    let pending = pending_of(paths);
    if pending.is_empty() {
        if adopted {
            let _ = write_json(&store.join("installed.json"), &installed);
        }
        return;
    }
    let mut results: Vec<Applied> = read_json(&store.join("last-apply.json")).unwrap_or_default();
    for op in pending {
        let r: Result<(), String> = (|| {
            safe_key(&op.id)?;
            let managed = installed.contains_key(&op.id);
            match op.op.as_str() {
                "install" => {
                    let staged = store.join("staged").join(&op.id);
                    if !staged.is_dir() {
                        return Err("the downloaded files are missing".into());
                    }
                    clear_plugin(paths, &op.id, managed)?;
                    let dest = paths.plugins().join(&op.id);
                    if fs::rename(&staged, &dest).is_err() {
                        copy_dir(&staged, &dest).s()?;
                        let _ = fs::remove_dir_all(&staged);
                    }
                    installed.insert(
                        op.id.clone(),
                        Installed {
                            version: op.version.clone().unwrap_or_default(),
                            installed_at: now_ms(),
                            source: op.source.clone(),
                            branch: op.branch.clone(),
                        },
                    );
                    Ok(())
                }
                "remove" => {
                    clear_plugin(paths, &op.id, managed)?;
                    installed.remove(&op.id);
                    Ok(())
                }
                other => Err(format!("unknown change {other:?}")),
            }
        })();
        results.push(Applied {
            op: op.op.clone(),
            id: op.id.clone(),
            name: if op.name.is_empty() { op.id.clone() } else { op.name.clone() },
            ok: r.is_ok(),
            error: r.err(),
            permissions: op.permissions.clone(),
        });
    }
    let _ = write_json(&store.join("installed.json"), &installed);
    let _ = write_json(&store.join("last-apply.json"), &results);
    let _ = fs::remove_file(store.join("pending.json"));
    let _ = fs::remove_dir_all(store.join("staged"));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn versions() {
        assert!(version_at_least("0.3.0", "0.3.0"));
        assert!(version_at_least("0.10.0", "0.9.9"));
        assert!(version_at_least("0.3.0-test.2", "0.3.0"));
        assert!(!version_at_least("0.2.1", "0.3.0"));
        assert!(plain_relative("app.js") && plain_relative("assets/x.png"));
        assert!(!plain_relative("../x") && !plain_relative("C:\\x") && !plain_relative("/x") && !plain_relative(""));
    }
}
