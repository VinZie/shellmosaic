//! SSH connections to saved hosts (russh): host-key trust, authentication, and
//! terminal sessions. Terminal sessions plug into pty.rs (same ring buffer,
//! replay and restore as local shells); SFTP panes reuse `connect` (sftp.rs).
//!
//! Questions during connecting (unknown host key, passwords, 2FA codes, the
//! vault's master password) go through a [`Prompter`]: typed inline in the
//! terminal like ssh.exe for terminal sessions, app dialogs for SFTP panes.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use parking_lot::Mutex;
use russh::client::{self, AuthResult, KeyboardInteractiveAuthResponse};
use russh::keys::ssh_key::PublicKey;
use russh::keys::{HashAlg, PrivateKey, PrivateKeyWithHashAlg, PublicKeyOrCertificate};
use russh::{ChannelMsg, Disconnect, MethodKind, MethodSet};
use serde_json::json;
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::sync::{mpsc, oneshot, watch, Notify};
use zeroize::Zeroizing;

use crate::paths::ErrStr;
use crate::vault::{Host, HostSecrets, Vault};

/// Server-supplied text (banners, 2FA prompts) is printed into a terminal: keep it
/// to printable characters so it can't carry escape sequences.
fn printable(s: &str) -> String {
    s.chars().filter(|&c| c == '\n' || c == '\t' || !c.is_control()).take(4000).collect()
}

fn host_label(host: &str, port: u16) -> String {
    if port == 22 { host.to_string() } else { format!("[{host}]:{port}") }
}

// ── prompting ───────────────────────────────────────────────────────────

pub enum Prompter {
    Term(TermPrompter),
    Dialog(DialogPrompter),
}

pub struct TermPrompter {
    output: Arc<dyn Fn(&[u8]) + Send + Sync>,
    input: tokio::sync::Mutex<mpsc::UnboundedReceiver<Vec<u8>>>,
}

pub struct DialogPrompter {
    app: AppHandle,
    pane_id: String,
}

impl TermPrompter {
    fn write(&self, text: &str) {
        (self.output)(text.replace('\n', "\r\n").as_bytes());
    }

    /// A tiny line editor over the terminal's input: echo (or not), backspace,
    /// Ctrl+U, Ctrl+C to cancel; escape sequences (arrows, paste brackets) are ignored.
    async fn read_line(&self, echo: bool) -> Option<Zeroizing<String>> {
        let mut rx = self.input.lock().await;
        let mut line = Zeroizing::new(String::new());
        let mut esc = 0u8; // 1 = after ESC, 2 = inside a CSI/SS3 sequence
        loop {
            let chunk = Zeroizing::new(rx.recv().await?);
            let text = Zeroizing::new(String::from_utf8_lossy(&chunk).into_owned());
            for c in text.chars() {
                if esc == 1 {
                    esc = if c == '[' || c == 'O' { 2 } else { 0 };
                    continue;
                }
                if esc == 2 {
                    if ('@'..='~').contains(&c) {
                        esc = 0;
                    }
                    continue;
                }
                match c {
                    '\x1b' => esc = 1,
                    '\r' | '\n' => {
                        (self.output)(b"\r\n");
                        return Some(line);
                    }
                    '\x03' => {
                        (self.output)(b"^C\r\n");
                        return None;
                    }
                    '\x04' if line.is_empty() => return None,
                    '\x7f' | '\x08' => {
                        if line.pop().is_some() && echo {
                            (self.output)(b"\x08 \x08");
                        }
                    }
                    '\x15' => {
                        if echo {
                            (self.output)("\x08 \x08".repeat(line.chars().count()).as_bytes());
                        }
                        line.clear();
                    }
                    c if c.is_control() => {}
                    c => {
                        line.push(c);
                        if echo {
                            let mut b = [0u8; 4];
                            (self.output)(c.encode_utf8(&mut b).as_bytes());
                        }
                    }
                }
            }
        }
    }
}

impl DialogPrompter {
    pub fn new(app: AppHandle, pane_id: String) -> Self {
        Self { app, pane_id }
    }

    /// Shown as a toast on the pane (minus the terminal styling, e.g. "Connecting…" in dim).
    fn notice(&self, kind: &str, text: &str) {
        let plain = crate::vt::strip_ansi(text.as_bytes());
        let message = plain.trim();
        if !message.is_empty() && !message.starts_with("Connecting to ") {
            let _ = self.app.emit("ssh://notice", json!({ "paneId": self.pane_id, "kind": kind, "message": message }));
        }
    }

    async fn request(&self, kind: &str, message: &str) -> Option<Zeroizing<String>> {
        let prompts = self.app.state::<Prompts>();
        let id = prompts.next.fetch_add(1, Ordering::Relaxed) + 1;
        let (tx, rx) = oneshot::channel();
        prompts.pending.lock().insert(id, tx);
        let _ = self.app.emit(
            "ssh://prompt",
            json!({ "id": id, "paneId": self.pane_id, "kind": kind, "message": message }),
        );
        let answer = tokio::time::timeout(Duration::from_secs(300), rx).await;
        prompts.pending.lock().remove(&id);
        answer.ok().and_then(|r| r.ok()).flatten().map(Zeroizing::new)
    }
}

impl Prompter {
    pub fn say(&self, text: &str) {
        match self {
            Prompter::Term(t) => t.write(&format!("{text}\n")),
            Prompter::Dialog(d) => d.notice("info", text),
        }
    }

    pub fn warn(&self, text: &str) {
        match self {
            Prompter::Term(t) => t.write(&format!("\x1b[31m{text}\x1b[0m\n")),
            Prompter::Dialog(d) => d.notice("warning", text),
        }
    }

    /// One line of input; `None` when cancelled.
    pub async fn ask(&self, prompt: &str, echo: bool) -> Option<Zeroizing<String>> {
        match self {
            Prompter::Term(t) => {
                t.write(prompt);
                t.read_line(echo).await
            }
            Prompter::Dialog(d) => d.request(if echo { "text" } else { "secret" }, prompt.trim_end()).await,
        }
    }

    pub async fn confirm(&self, question: &str) -> bool {
        match self {
            Prompter::Term(t) => {
                t.write(&format!("{question} (yes/no)? "));
                loop {
                    let Some(a) = t.read_line(true).await else { return false };
                    match a.trim().to_ascii_lowercase().as_str() {
                        "yes" | "y" => return true,
                        "no" | "n" => return false,
                        _ => t.write("Please type 'yes' or 'no': "),
                    }
                }
            }
            Prompter::Dialog(d) => d.request("confirm", question).await.is_some_and(|a| a.as_str() == "yes"),
        }
    }
}

/// Questions waiting for an answer from an SFTP pane's dialog.
#[derive(Default)]
pub struct Prompts {
    next: AtomicU64,
    pending: Mutex<HashMap<u64, oneshot::Sender<Option<String>>>>,
}

#[tauri::command]
pub fn ssh_prompt_answer(prompts: State<'_, Prompts>, id: u64, value: Option<String>) {
    if let Some(tx) = prompts.pending.lock().remove(&id) {
        let _ = tx.send(value);
    }
}

// ── connecting ──────────────────────────────────────────────────────────

pub struct Client {
    app: AppHandle,
    host_id: String,
    host: String,
    port: u16,
    known: Vec<String>,
    prompter: Arc<Prompter>,
}

impl Client {
    async fn verify(&mut self, pk: PublicKey) -> bool {
        let fp = pk.fingerprint(HashAlg::Sha256);
        let alg = pk.algorithm();
        let label = host_label(&self.host, self.port);
        let pinned: Vec<PublicKey> = self.known.iter().filter_map(|l| PublicKey::from_openssh(l).ok()).collect();
        if pinned.iter().any(|k| k.key_data() == pk.key_data()) {
            return true;
        }
        if pinned.iter().any(|k| k.algorithm() == alg) {
            self.prompter.warn(&format!(
                "@@@ WARNING: THE HOST KEY FOR {label} HAS CHANGED! @@@\n\
                 Someone could be intercepting this connection (man-in-the-middle), or the server's key was replaced.\n\
                 The {} key it sent has fingerprint {fp}.\n\
                 If the change is legitimate, edit the host in the Hosts module and choose \"Forget host key\".",
                alg.as_str()
            ));
            return false;
        }
        // not pinned yet: an existing ~/.ssh/known_hosts entry counts too
        match russh::keys::check_known_hosts(&self.host, self.port, &pk) {
            Ok(true) => {
                self.pin(&pk);
                return true;
            }
            Err(russh::keys::Error::KeyChanged { line }) => {
                self.prompter.warn(&format!(
                    "@@@ WARNING: THE HOST KEY FOR {label} HAS CHANGED! @@@\n\
                     It doesn't match line {line} of ~/.ssh/known_hosts. Someone could be intercepting this connection.\n\
                     The {} key it sent has fingerprint {fp}.",
                    alg.as_str()
                ));
                return false;
            }
            _ => {}
        }
        let mut question = format!(
            "The authenticity of host '{label}' can't be established.\n{} key fingerprint is {fp}.",
            alg.as_str()
        );
        if !pinned.is_empty() {
            question.push_str("\nA different type of key is already trusted for this host.");
        }
        question.push_str("\nAre you sure you want to continue connecting");
        if self.prompter.confirm(&question).await {
            self.pin(&pk);
            true
        } else {
            false
        }
    }

    fn pin(&self, pk: &PublicKey) {
        let Ok(line) = pk.to_openssh() else { return };
        let line = line.trim().to_string();
        let _ = self.app.state::<Vault>().update_host(&self.host_id, |h| {
            if !h.known_keys.contains(&line) {
                h.known_keys.push(line);
            }
        });
    }
}

impl client::Handler for Client {
    type Error = russh::Error;

    async fn auth_banner(&mut self, banner: &str, _session: &mut client::Session) -> Result<(), Self::Error> {
        self.prompter.say(printable(banner).trim_end());
        Ok(())
    }

    async fn check_server_key(&mut self, key: &PublicKeyOrCertificate) -> Result<bool, Self::Error> {
        Ok(self.verify(key.public_key()).await)
    }
}

async fn ensure_unlocked(app: &AppHandle, p: &Prompter) -> Result<(), String> {
    let vault = app.state::<Vault>();
    if vault.is_unlocked() {
        return Ok(());
    }
    if !vault.exists() {
        return Err("there's no vault yet: open the Hosts module to create one".into());
    }
    for _ in 0..3 {
        let Some(pw) = p.ask("Vault is locked. Master password: ", false).await else {
            return Err("cancelled".into());
        };
        let a = app.clone();
        match tauri::async_runtime::spawn_blocking(move || a.state::<Vault>().unlock(&pw)).await.s()? {
            Ok(()) => return Ok(()),
            Err(e) => p.warn(&e),
        }
    }
    Err("the vault stays locked".into())
}

/// Connect to a saved host and authenticate. The vault is unlocked first if needed.
pub async fn connect(app: &AppHandle, host_id: &str, p: Arc<Prompter>) -> Result<(client::Handle<Client>, HostSecrets), String> {
    ensure_unlocked(app, &p).await?;
    let host = app.state::<Vault>().host(host_id)?;
    let who = if host.user.is_empty() { host.host.clone() } else { format!("{}@{}", host.user, host.host) };
    p.say(&format!("\x1b[2mConnecting to {who}{}…\x1b[0m", if host.port == 22 { String::new() } else { format!(":{}", host.port) }));

    let tcp = tokio::time::timeout(Duration::from_secs(15), tokio::net::TcpStream::connect((host.host.as_str(), host.port)))
        .await
        .map_err(|_| format!("timed out connecting to {}:{}", host.host, host.port))?
        .map_err(|e| format!("can't reach {}:{}: {e}", host.host, host.port))?;
    let _ = tcp.set_nodelay(true);

    let mut config = client::Config::default();
    config.keepalive_interval = Some(Duration::from_secs(30));
    config.keepalive_max = 4;
    config.inactivity_timeout = None;
    let handler = Client {
        app: app.clone(),
        host_id: host.id.clone(),
        host: host.host.clone(),
        port: host.port,
        known: host.known_keys.clone(),
        prompter: p.clone(),
    };
    // (no timeout around the handshake: it includes the host-key question)
    let mut handle = client::connect_stream(Arc::new(config), tcp, handler).await.map_err(|e| match e {
        russh::Error::UnknownKey => "host key not trusted, connection closed".to_string(),
        e => format!("SSH handshake failed: {e}"),
    })?;
    authenticate(app, &mut handle, &host, &p).await?;
    app.state::<Vault>().touch(host_id);
    Ok((handle, host))
}

fn read_key_file(path: &str) -> Result<Zeroizing<String>, String> {
    let path = match path.strip_prefix("~") {
        Some(rest) => format!("{}{rest}", std::env::var("USERPROFILE").unwrap_or_default()),
        None => path.to_string(),
    };
    let meta = std::fs::metadata(&path).s()?;
    if meta.len() > 64 * 1024 {
        return Err("that doesn't look like a private key (too large)".into());
    }
    Ok(Zeroizing::new(std::fs::read_to_string(&path).s()?))
}

async fn load_key(host: &Host, p: &Prompter) -> Result<Option<PrivateKey>, String> {
    let label = host.key_path.clone().unwrap_or_else(|| "saved key".into());
    let text = match (&host.key_data, &host.key_path) {
        (Some(k), _) => Zeroizing::new(k.clone()),
        (None, Some(path)) => match read_key_file(path) {
            Ok(t) => t,
            Err(e) => {
                p.warn(&format!("Can't read key {path}: {e}"));
                return Ok(None);
            }
        },
        _ => return Ok(None),
    };
    match russh::keys::decode_secret_key(&text, None) {
        Ok(k) => return Ok(Some(k)),
        Err(russh::keys::Error::KeyIsEncrypted) => {}
        Err(e) => {
            p.warn(&format!("Can't use the private key ({label}): {e}"));
            return Ok(None);
        }
    }
    if let Some(pp) = &host.passphrase {
        if let Ok(k) = russh::keys::decode_secret_key(&text, Some(pp)) {
            return Ok(Some(k));
        }
        p.warn("The saved key passphrase is wrong.");
    }
    for _ in 0..3 {
        let Some(pp) = p.ask(&format!("Enter passphrase for key '{label}': "), false).await else {
            return Err("cancelled".into());
        };
        match russh::keys::decode_secret_key(&text, Some(&pp)) {
            Ok(k) => return Ok(Some(k)),
            Err(_) => p.warn("Bad passphrase, try again."),
        }
    }
    Ok(None)
}

/// Like OpenSSH: ask "none" first to learn the methods, then key, saved password,
/// keyboard-interactive (2FA), and finally password prompts.
async fn authenticate(app: &AppHandle, h: &mut client::Handle<Client>, host: &Host, p: &Prompter) -> Result<(), String> {
    let user = if host.user.is_empty() {
        let u = p.ask("login as: ", true).await.ok_or("cancelled")?;
        u.trim().to_string()
    } else {
        host.user.clone()
    };
    if user.is_empty() {
        return Err("no user name".into());
    }
    let allows = |m: &Option<MethodSet>, k: MethodKind| m.as_ref().is_none_or(|s| s.contains(&k));
    let mut methods: Option<MethodSet> = match h.authenticate_none(&user).await.s()? {
        AuthResult::Success => return Ok(()),
        AuthResult::Failure { remaining_methods, .. } => Some(remaining_methods),
    };

    let has_key = host.key_data.is_some() || host.key_path.is_some();
    if host.auth != "password" && has_key && allows(&methods, MethodKind::PublicKey) {
        if let Some(key) = load_key(host, p).await? {
            let hash = if key.algorithm().is_rsa() { h.best_supported_rsa_hash().await.ok().flatten().flatten() } else { None };
            match h.authenticate_publickey(&user, PrivateKeyWithHashAlg::new(Arc::new(key), hash)).await.s()? {
                AuthResult::Success => return Ok(()),
                AuthResult::Failure { remaining_methods, partial_success } => {
                    if !partial_success {
                        p.warn("The server didn't accept the key.");
                    }
                    methods = Some(remaining_methods);
                }
            }
        }
    }
    if host.auth == "key" {
        return Err(format!("Permission denied for {user}: the key was not accepted"));
    }

    let mut stored = host.password.clone().map(Zeroizing::new);
    if let Some(pw) = &stored {
        if allows(&methods, MethodKind::Password) {
            match h.authenticate_password(&user, pw.as_str()).await.s()? {
                AuthResult::Success => return Ok(()),
                AuthResult::Failure { remaining_methods, partial_success } => {
                    methods = Some(remaining_methods);
                    if !partial_success {
                        p.warn("The saved password was rejected.");
                        stored = None;
                    }
                }
            }
        }
    }

    if allows(&methods, MethodKind::KeyboardInteractive) {
        if keyboard_interactive(h, &user, stored.as_deref().map(String::as_str), p).await? {
            return Ok(());
        }
    }

    if allows(&methods, MethodKind::Password) {
        for _ in 0..3 {
            let Some(pw) = p.ask(&format!("{user}@{}'s password: ", host.host), false).await else {
                return Err("cancelled".into());
            };
            match h.authenticate_password(&user, pw.as_str()).await.s()? {
                AuthResult::Success => {
                    if host.password.is_none() && p.confirm("Save this password in the vault").await {
                        let _ = app.state::<Vault>().update_host(&host.id, |h| h.password = Some(pw.to_string()));
                    }
                    return Ok(());
                }
                AuthResult::Failure { remaining_methods, .. } => {
                    p.warn("Permission denied, please try again.");
                    methods = Some(remaining_methods);
                    if !allows(&methods, MethodKind::Password) {
                        break;
                    }
                }
            }
        }
    }
    let offered: Vec<&str> = methods.as_ref().map(|m| m.iter().map(<&str>::from).collect()).unwrap_or_default();
    Err(format!("Permission denied ({}).", offered.join(",")))
}

/// Answer the server's questions (PAM password prompts, OTP codes…). The saved password,
/// if any, answers the first hidden prompt that asks for a password.
async fn keyboard_interactive(h: &mut client::Handle<Client>, user: &str, stored: Option<&str>, p: &Prompter) -> Result<bool, String> {
    let mut stored = stored;
    let mut resp = h.authenticate_keyboard_interactive_start(user, None::<String>).await.s()?;
    for _ in 0..12 {
        match resp {
            KeyboardInteractiveAuthResponse::Success => return Ok(true),
            KeyboardInteractiveAuthResponse::Failure { .. } => return Ok(false),
            KeyboardInteractiveAuthResponse::InfoRequest { name, instructions, prompts } => {
                for text in [name, instructions] {
                    if !text.trim().is_empty() {
                        p.say(printable(&text).trim_end());
                    }
                }
                let mut answers = Vec::new();
                for prompt in prompts.iter().take(16) {
                    let text = printable(&prompt.prompt);
                    if !prompt.echo && text.to_ascii_lowercase().contains("password") {
                        if let Some(pw) = stored.take() {
                            answers.push(pw.to_string());
                            continue;
                        }
                    }
                    let Some(a) = p.ask(&text, prompt.echo).await else { return Err("cancelled".into()) };
                    answers.push(a.to_string());
                }
                resp = h.authenticate_keyboard_interactive_respond(answers).await.s()?;
            }
        }
    }
    Ok(false)
}

// ── terminal sessions ───────────────────────────────────────────────────

/// What pty.rs hands an SSH terminal session.
pub struct TermIo {
    /// into the session's ring buffer and the attached view
    pub output: Arc<dyn Fn(&[u8]) + Send + Sync>,
    pub input: mpsc::UnboundedReceiver<Vec<u8>>,
    pub size: watch::Receiver<(u16, u16)>,
    pub kill: Arc<Notify>,
}

/// Connect and run a remote shell; `on_end` gets the exit code once it's over.
pub fn start_terminal(app: AppHandle, host_id: String, io: TermIo, on_end: impl FnOnce(Option<u32>) + Send + 'static) {
    tauri::async_runtime::spawn(async move {
        let TermIo { output, input, size, kill } = io;
        let p = Arc::new(Prompter::Term(TermPrompter { output, input: tokio::sync::Mutex::new(input) }));
        let code = tokio::select! {
            r = run_terminal(&app, &host_id, p.clone(), size) => match r {
                Ok(code) => code,
                Err(e) => {
                    p.warn(&e);
                    None
                }
            },
            _ = kill.notified() => None,
        };
        on_end(code);
    });
}

async fn run_terminal(app: &AppHandle, host_id: &str, p: Arc<Prompter>, mut size: watch::Receiver<(u16, u16)>) -> Result<Option<u32>, String> {
    let (handle, _host) = connect(app, host_id, p.clone()).await?;
    let channel = handle.channel_open_session().await.s()?;
    let (cols, rows) = *size.borrow_and_update();
    channel.request_pty(false, "xterm-256color", cols as u32, rows as u32, 0, 0, &[]).await.s()?;
    channel.request_shell(false).await.s()?;
    let Prompter::Term(t) = &*p else { return Err("not a terminal".into()) };
    let mut input = t.input.lock().await;
    let (mut read, write) = channel.split();
    let mut code = None;
    loop {
        tokio::select! {
            msg = read.wait() => match msg {
                Some(ChannelMsg::Data { data }) => (t.output)(&data),
                Some(ChannelMsg::ExtendedData { data, .. }) => (t.output)(&data),
                Some(ChannelMsg::ExitStatus { exit_status }) => code = Some(exit_status),
                Some(ChannelMsg::Close) | None => break,
                Some(_) => {}
            },
            data = input.recv() => match data {
                Some(d) => write.data_bytes(d).await.s()?,
                None => break,
            },
            Ok(()) = size.changed() => {
                let (cols, rows) = *size.borrow_and_update();
                let _ = write.window_change(cols as u32, rows as u32, 0, 0).await;
            }
        }
    }
    let _ = handle.disconnect(Disconnect::ByApplication, "", "en").await;
    Ok(code)
}
