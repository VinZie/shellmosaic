//! Saved SSH hosts in an encrypted vault (`vault.json`).
//!
//! Everything — host list, passwords, key passphrases, pasted private keys and
//! pinned host keys — is one JSON document sealed with XChaCha20-Poly1305 under a
//! key derived from the master password with Argon2id. The key lives only here,
//! in the backend, while the vault is unlocked; the webview gets host details but
//! never a stored secret (only "has a password" flags), and can set secrets but
//! not read them back.

use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine;
use chacha20poly1305::aead::{Aead, KeyInit, OsRng, Payload};
use chacha20poly1305::aead::rand_core::RngCore;
use chacha20poly1305::{XChaCha20Poly1305, XNonce};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};
use zeroize::{Zeroize, Zeroizing};

use crate::paths::{blocking, write_atomic, ErrStr, Paths};

const FORMAT: &str = "shellmosaic-vault";
const MIN_PASSWORD: usize = 8;

#[derive(Serialize, Deserialize, Clone)]
struct Kdf {
    alg: String,
    /// memory in KiB, iterations, lanes
    m: u32,
    t: u32,
    p: u32,
    salt: String,
}

impl Kdf {
    fn fresh() -> Self {
        let mut salt = [0u8; 16];
        OsRng.fill_bytes(&mut salt);
        Kdf { alg: "argon2id".into(), m: 64 * 1024, t: 3, p: 1, salt: B64.encode(salt) }
    }

    /// A tampered file must not be able to make unlocking take forever (or be trivial).
    fn check(&self) -> Result<(), String> {
        let ok = self.alg == "argon2id"
            && (8 * 1024..=1024 * 1024).contains(&self.m)
            && (1..=16).contains(&self.t)
            && (1..=8).contains(&self.p);
        if ok { Ok(()) } else { Err("the vault file has unsupported key-derivation settings".into()) }
    }

    /// Bound into the ciphertext, so the header can't be swapped without failing to decrypt.
    fn aad(&self) -> String {
        format!("{FORMAT}|1|{}|{}|{}|{}|{}", self.alg, self.m, self.t, self.p, self.salt)
    }

    fn derive(&self, password: &str) -> Result<Zeroizing<[u8; 32]>, String> {
        self.check()?;
        let salt = B64.decode(&self.salt).map_err(|_| "the vault file is damaged".to_string())?;
        let params = argon2::Params::new(self.m, self.t, self.p, Some(32)).s()?;
        let argon = argon2::Argon2::new(argon2::Algorithm::Argon2id, argon2::Version::V0x13, params);
        let mut key = Zeroizing::new([0u8; 32]);
        argon.hash_password_into(password.as_bytes(), &salt, key.as_mut()).s()?;
        Ok(key)
    }
}

#[derive(Serialize, Deserialize)]
struct VaultFile {
    format: String,
    v: u32,
    kdf: Kdf,
    nonce: String,
    data: String,
}

/// A saved host, secrets included. Never serialized to the webview (see [`HostView`]).
#[derive(Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct Host {
    pub id: String,
    pub name: String,
    pub host: String,
    pub port: u16,
    pub user: String,
    pub group: String,
    pub tags: Vec<String>,
    pub color: Option<String>,
    pub icon: Option<String>,
    pub notes: String,
    /// "auto" (key if set, then password), "password" or "key"
    pub auth: String,
    pub key_path: Option<String>,
    /// trusted host keys, OpenSSH public key lines ("ssh-ed25519 AAAA…")
    pub known_keys: Vec<String>,
    pub created: u64,
    pub last_used: Option<u64>,
    pub password: Option<String>,
    pub passphrase: Option<String>,
    /// a pasted private key (instead of a key file)
    pub key_data: Option<String>,
}

impl Host {
    /// Best effort: don't leave secrets around in freed memory.
    fn wipe(&mut self) {
        for s in [&mut self.password, &mut self.passphrase, &mut self.key_data].into_iter().flatten() {
            s.zeroize();
        }
    }
}

/// A host's details with secrets, handed out for connecting; wiped when dropped.
pub struct HostSecrets(Host);

impl std::ops::Deref for HostSecrets {
    type Target = Host;
    fn deref(&self) -> &Host {
        &self.0
    }
}

impl Drop for HostSecrets {
    fn drop(&mut self) {
        self.0.wipe();
    }
}

#[derive(Serialize, Deserialize, Default)]
struct VaultData {
    hosts: Vec<Host>,
}

impl Drop for VaultData {
    fn drop(&mut self) {
        self.hosts.iter_mut().for_each(Host::wipe);
    }
}

/// What the webview sees of a host.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostView {
    id: String,
    name: String,
    host: String,
    port: u16,
    user: String,
    group: String,
    tags: Vec<String>,
    color: Option<String>,
    icon: Option<String>,
    notes: String,
    auth: String,
    key_path: Option<String>,
    created: u64,
    last_used: Option<u64>,
    has_password: bool,
    has_passphrase: bool,
    has_key_data: bool,
    /// "ssh-ed25519 SHA256:…" for each trusted host key
    known_keys: Vec<String>,
}

impl From<&Host> for HostView {
    fn from(h: &Host) -> Self {
        HostView {
            id: h.id.clone(),
            name: h.name.clone(),
            host: h.host.clone(),
            port: h.port,
            user: h.user.clone(),
            group: h.group.clone(),
            tags: h.tags.clone(),
            color: h.color.clone(),
            icon: h.icon.clone(),
            notes: h.notes.clone(),
            auth: h.auth.clone(),
            key_path: h.key_path.clone(),
            created: h.created,
            last_used: h.last_used,
            has_password: h.password.is_some(),
            has_passphrase: h.passphrase.is_some(),
            has_key_data: h.key_data.is_some(),
            known_keys: h.known_keys.iter().map(|k| fingerprint(k)).collect(),
        }
    }
}

pub fn fingerprint(openssh: &str) -> String {
    match russh::keys::ssh_key::PublicKey::from_openssh(openssh) {
        Ok(k) => format!("{} {}", k.algorithm().as_str(), k.fingerprint(russh::keys::HashAlg::Sha256)),
        Err(_) => "unreadable key".into(),
    }
}

/// Edits from the host editor. Secrets: `Some` sets, `clear…` removes, neither keeps.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostInput {
    id: Option<String>,
    name: String,
    host: String,
    port: u16,
    #[serde(default)]
    user: String,
    #[serde(default)]
    group: String,
    #[serde(default)]
    tags: Vec<String>,
    color: Option<String>,
    icon: Option<String>,
    #[serde(default)]
    notes: String,
    #[serde(default)]
    auth: String,
    key_path: Option<String>,
    password: Option<String>,
    #[serde(default)]
    clear_password: bool,
    passphrase: Option<String>,
    #[serde(default)]
    clear_passphrase: bool,
    key_data: Option<String>,
    #[serde(default)]
    clear_key_data: bool,
    /// a new host duplicated from this one starts with its secrets (the webview never sees them)
    copy_secrets_from: Option<String>,
}

impl Drop for HostInput {
    fn drop(&mut self) {
        for s in [&mut self.password, &mut self.passphrase, &mut self.key_data].into_iter().flatten() {
            s.zeroize();
        }
    }
}

struct Inner {
    key: Option<Zeroizing<[u8; 32]>>,
    kdf: Option<Kdf>,
    data: Option<VaultData>,
    last_used: Instant,
}

pub struct Vault {
    app: AppHandle,
    path: PathBuf,
    inner: Mutex<Inner>,
    /// 0 = never
    auto_lock_mins: AtomicU64,
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

/// Host names, users and similar end up on command lines and in prompts: no control characters.
fn clean(s: &str, max: usize) -> String {
    s.chars().filter(|c| !c.is_control()).take(max).collect::<String>().trim().to_string()
}

impl Vault {
    pub fn new(app: AppHandle, paths: &Paths) -> Self {
        Self {
            app,
            path: paths.root.join("vault.json"),
            inner: Mutex::new(Inner { key: None, kdf: None, data: None, last_used: Instant::now() }),
            auto_lock_mins: AtomicU64::new(15),
        }
    }

    /// Lock after the configured idle time (sessions already connected stay connected).
    pub fn start_auto_lock(app: AppHandle) {
        std::thread::spawn(move || loop {
            std::thread::sleep(Duration::from_secs(20));
            let vault = app.state::<Vault>();
            let mins = vault.auto_lock_mins.load(Ordering::Relaxed);
            let idle = { vault.inner.lock().last_used.elapsed() };
            if mins > 0 && vault.is_unlocked() && idle > Duration::from_secs(mins * 60) {
                vault.lock();
            }
        });
    }

    fn changed(&self) {
        let _ = self.app.emit("vault://changed", ());
    }

    pub fn exists(&self) -> bool {
        self.path.is_file()
    }

    pub fn is_unlocked(&self) -> bool {
        self.inner.lock().key.is_some()
    }

    pub fn lock(&self) {
        {
            let mut g = self.inner.lock();
            g.key = None; // Zeroizing wipes it
            g.data = None; // Host::drop wipes the secrets
            g.kdf = None;
        }
        self.changed();
    }

    fn read_file(&self) -> Result<VaultFile, String> {
        let bytes = fs::read(&self.path).map_err(|_| "there is no vault yet".to_string())?;
        let f: VaultFile = serde_json::from_slice(&bytes).map_err(|_| "the vault file is damaged".to_string())?;
        if f.format != FORMAT || f.v != 1 {
            return Err("the vault file is from an unknown version".into());
        }
        Ok(f)
    }

    fn seal(key: &[u8; 32], kdf: &Kdf, data: &VaultData) -> Result<Vec<u8>, String> {
        let plain = Zeroizing::new(serde_json::to_vec(data).s()?);
        let mut nonce = [0u8; 24];
        OsRng.fill_bytes(&mut nonce);
        let aad = kdf.aad();
        let cipher = XChaCha20Poly1305::new(key.into());
        let ct = cipher
            .encrypt(XNonce::from_slice(&nonce), Payload { msg: &plain, aad: aad.as_bytes() })
            .map_err(|_| "encryption failed".to_string())?;
        let file = VaultFile { format: FORMAT.into(), v: 1, kdf: kdf.clone(), nonce: B64.encode(nonce), data: B64.encode(ct) };
        serde_json::to_vec_pretty(&file).s()
    }

    fn open(key: &[u8; 32], f: &VaultFile) -> Result<VaultData, String> {
        let nonce = B64.decode(&f.nonce).map_err(|_| "the vault file is damaged".to_string())?;
        let ct = B64.decode(&f.data).map_err(|_| "the vault file is damaged".to_string())?;
        if nonce.len() != 24 {
            return Err("the vault file is damaged".into());
        }
        let aad = f.kdf.aad();
        let cipher = XChaCha20Poly1305::new(key.into());
        let plain = Zeroizing::new(
            cipher
                .decrypt(XNonce::from_slice(&nonce), Payload { msg: &ct, aad: aad.as_bytes() })
                .map_err(|_| "wrong master password".to_string())?,
        );
        serde_json::from_slice(&plain).map_err(|_| "the vault contents are damaged".to_string())
    }

    fn save(&self, g: &Inner) -> Result<(), String> {
        let (Some(key), Some(kdf), Some(data)) = (&g.key, &g.kdf, &g.data) else {
            return Err("the vault is locked".into());
        };
        write_atomic(&self.path, &Self::seal(key, kdf, data)?).s()
    }

    pub fn create(&self, password: &str) -> Result<(), String> {
        if self.exists() {
            return Err("a vault already exists".into());
        }
        if password.chars().count() < MIN_PASSWORD {
            return Err(format!("use at least {MIN_PASSWORD} characters"));
        }
        let kdf = Kdf::fresh();
        let key = kdf.derive(password)?;
        {
            let mut g = self.inner.lock();
            *g = Inner { key: Some(key), kdf: Some(kdf), data: Some(VaultData::default()), last_used: Instant::now() };
            self.save(&g)?;
        }
        self.changed();
        Ok(())
    }

    /// Slow on purpose (Argon2id): call from a blocking thread.
    pub fn unlock(&self, password: &str) -> Result<(), String> {
        let f = self.read_file()?;
        let key = f.kdf.derive(password)?;
        let data = Self::open(&key, &f)?;
        {
            let mut g = self.inner.lock();
            *g = Inner { key: Some(key), kdf: Some(f.kdf), data: Some(data), last_used: Instant::now() };
        }
        self.changed();
        Ok(())
    }

    pub fn change_password(&self, current: &str, new: &str) -> Result<(), String> {
        if new.chars().count() < MIN_PASSWORD {
            return Err(format!("use at least {MIN_PASSWORD} characters"));
        }
        let f = self.read_file()?;
        let old_key = f.kdf.derive(current)?;
        let data = Self::open(&old_key, &f)?;
        let kdf = Kdf::fresh();
        let key = kdf.derive(new)?;
        {
            let mut g = self.inner.lock();
            *g = Inner { key: Some(key), kdf: Some(kdf), data: Some(data), last_used: Instant::now() };
            self.save(&g)?;
        }
        // (it also unlocks a locked vault: tell every window)
        self.changed();
        Ok(())
    }

    /// Delete the vault (to the Recycle Bin) — the way out of a forgotten master password.
    pub fn reset(&self) -> Result<(), String> {
        if self.exists() {
            trash::delete(&self.path).s()?;
        }
        self.lock();
        Ok(())
    }

    fn with_data<R>(&self, f: impl FnOnce(&mut VaultData) -> R) -> Result<R, String> {
        let mut g = self.inner.lock();
        g.last_used = Instant::now();
        let data = g.data.as_mut().ok_or("the vault is locked")?;
        Ok(f(data))
    }

    /// Change one host and save. Returns the updated host's view.
    pub fn update_host(&self, id: &str, f: impl FnOnce(&mut Host)) -> Result<HostView, String> {
        let view = {
            let mut g = self.inner.lock();
            g.last_used = Instant::now();
            let data = g.data.as_mut().ok_or("the vault is locked")?;
            let host = data.hosts.iter_mut().find(|h| h.id == id).ok_or("this saved host no longer exists")?;
            f(host);
            let view = HostView::from(&*host);
            self.save(&g)?;
            view
        };
        self.changed();
        Ok(view)
    }

    /// A copy of a host with its secrets, for connecting.
    pub fn host(&self, id: &str) -> Result<HostSecrets, String> {
        self.with_data(|d| d.hosts.iter().find(|h| h.id == id).cloned())?
            .map(HostSecrets)
            .ok_or_else(|| "this saved host no longer exists".to_string())
    }

    pub fn list(&self) -> Result<Vec<HostView>, String> {
        self.with_data(|d| d.hosts.iter().map(HostView::from).collect())
    }

    fn save_input(&self, input: HostInput) -> Result<HostView, String> {
        let host = clean(&input.host, 255);
        if host.is_empty() || host.contains(char::is_whitespace) {
            return Err("enter a host name or address".into());
        }
        if input.port == 0 {
            return Err("the port must be between 1 and 65535".into());
        }
        let auth = match input.auth.as_str() {
            "password" | "key" => input.auth.clone(),
            _ => "auto".into(),
        };
        let apply = |h: &mut Host, input: &HostInput| {
            h.name = match clean(&input.name, 120) {
                n if n.is_empty() => host.clone(),
                n => n,
            };
            h.host = host.clone();
            h.port = input.port;
            h.user = clean(&input.user, 120);
            h.group = clean(&input.group, 80);
            h.tags = input.tags.iter().map(|t| clean(t, 40)).filter(|t| !t.is_empty()).take(32).collect();
            h.color = input.color.as_deref().map(|c| clean(c, 40)).filter(|c| !c.is_empty());
            h.icon = input.icon.as_deref().map(|c| clean(c, 40)).filter(|c| !c.is_empty());
            h.notes = input.notes.chars().take(10_000).collect();
            h.auth = auth.clone();
            h.key_path = input.key_path.as_deref().map(|p| clean(p, 1024)).filter(|p| !p.is_empty());
            if input.clear_password {
                h.password = None;
            } else if let Some(p) = &input.password {
                h.password = Some(p.clone());
            }
            if input.clear_passphrase {
                h.passphrase = None;
            } else if let Some(p) = &input.passphrase {
                h.passphrase = Some(p.clone());
            }
            if input.clear_key_data {
                h.key_data = None;
            } else if let Some(k) = input.key_data.as_deref().map(str::trim).filter(|k| !k.is_empty()) {
                russh::keys::decode_secret_key(k, None)
                    .map(|_| ())
                    .or_else(|e| match e {
                        // fine: it's encrypted, the passphrase is checked when connecting
                        russh::keys::Error::KeyIsEncrypted => Ok(()),
                        e => Err(e),
                    })
                    .map_err(|e| format!("that private key can't be read: {e}"))?;
                h.key_data = Some(k.to_string());
            }
            Ok::<(), String>(())
        };
        let view = {
            let mut g = self.inner.lock();
            g.last_used = Instant::now();
            let data = g.data.as_mut().ok_or("the vault is locked")?;
            let view = match input.id.as_deref().filter(|id| !id.is_empty()) {
                Some(id) => {
                    let h = data.hosts.iter_mut().find(|h| h.id == id).ok_or("this saved host no longer exists")?;
                    // a different machine must not inherit the old one's trusted keys
                    if h.host != host || h.port != input.port {
                        h.known_keys.clear();
                    }
                    apply(h, &input)?;
                    HostView::from(&*h)
                }
                None => {
                    let source = input.copy_secrets_from.as_deref().and_then(|src| data.hosts.iter().find(|h| h.id == src));
                    let mut h = Host {
                        id: uuid::Uuid::new_v4().simple().to_string(),
                        created: now_ms(),
                        password: source.and_then(|s| s.password.clone()),
                        passphrase: source.and_then(|s| s.passphrase.clone()),
                        key_data: source.and_then(|s| s.key_data.clone()),
                        ..Host::default()
                    };
                    apply(&mut h, &input)?;
                    let view = HostView::from(&h);
                    data.hosts.push(h);
                    view
                }
            };
            self.save(&g)?;
            view
        };
        self.changed();
        Ok(view)
    }

    fn delete(&self, id: &str) -> Result<(), String> {
        {
            let mut g = self.inner.lock();
            g.last_used = Instant::now();
            let data = g.data.as_mut().ok_or("the vault is locked")?;
            data.hosts.retain(|h| h.id != id);
            self.save(&g)?;
        }
        self.changed();
        Ok(())
    }

    pub fn touch(&self, id: &str) {
        let _ = self.update_host(id, |h| h.last_used = Some(now_ms()));
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultStatus {
    exists: bool,
    unlocked: bool,
}

#[tauri::command]
pub fn vault_status(vault: State<'_, Vault>) -> VaultStatus {
    VaultStatus { exists: vault.exists(), unlocked: vault.is_unlocked() }
}

#[tauri::command]
pub async fn vault_create(app: AppHandle, password: String) -> Result<(), String> {
    let password = Zeroizing::new(password);
    tauri::async_runtime::spawn_blocking(move || app.state::<Vault>().create(&password)).await.s()?
}

#[tauri::command]
pub async fn vault_unlock(app: AppHandle, password: String) -> Result<(), String> {
    let password = Zeroizing::new(password);
    tauri::async_runtime::spawn_blocking(move || app.state::<Vault>().unlock(&password)).await.s()?
}

#[tauri::command]
pub async fn vault_change_password(app: AppHandle, current: String, new: String) -> Result<(), String> {
    let (current, new) = (Zeroizing::new(current), Zeroizing::new(new));
    tauri::async_runtime::spawn_blocking(move || app.state::<Vault>().change_password(&current, &new)).await.s()?
}

#[tauri::command]
pub fn vault_lock(vault: State<'_, Vault>) {
    vault.lock();
}

#[tauri::command]
pub async fn vault_reset(app: AppHandle) -> Result<(), String> {
    blocking(move || app.state::<Vault>().reset()).await?
}

#[tauri::command]
pub fn vault_configure(vault: State<'_, Vault>, auto_lock_mins: u64) {
    vault.auto_lock_mins.store(auto_lock_mins.min(24 * 60), Ordering::Relaxed);
}

#[tauri::command]
pub fn hosts_list(vault: State<'_, Vault>) -> Result<Vec<HostView>, String> {
    vault.list()
}

#[tauri::command(async)]
pub fn host_save(vault: State<'_, Vault>, host: HostInput) -> Result<HostView, String> {
    vault.save_input(host)
}

#[tauri::command(async)]
pub fn host_delete(vault: State<'_, Vault>, id: String) -> Result<(), String> {
    vault.delete(&id)
}

/// Forget the trusted host keys (after the server's key legitimately changed).
#[tauri::command(async)]
pub fn host_forget_keys(vault: State<'_, Vault>, id: String) -> Result<HostView, String> {
    vault.update_host(&id, |h| h.known_keys.clear())
}
