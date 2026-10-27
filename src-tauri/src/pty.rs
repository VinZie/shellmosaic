//! Terminal sessions: local shells on Windows ConPTY (via portable-pty) and SSH
//! shells on saved hosts (ssh.rs).
//!
//! Each pane owns at most one session. Output is kept in a bounded ring buffer so
//! a view can (re)attach at any time — after a tab switch, from a popped-out
//! window, or after an app restart (the ring is persisted to `sessions/`).

use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;

use parking_lot::Mutex;
use portable_pty::{native_pty_system, ChildKiller, MasterPty, PtySize};
use serde::{Deserialize, Serialize};
use serde_json::json;
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::{AppHandle, Emitter, State};
use tokio::sync::{mpsc, watch, Notify};

use crate::paths::{safe_key, write_atomic, ErrStr};
use crate::shells::{build_command, SpawnSpec};
use crate::ssh::{self, TermIo};
use crate::vt::{push_ring, strip_ansi, OscEvent, OscScanner, Screen};

const DEFAULT_RING_BYTES: usize = 2 * 1024 * 1024;

#[derive(Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct SessionMeta {
    pub cwd: Option<String>,
    pub profile_id: Option<String>,
    /// the terminal size the saved scrollback was last drawn at
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cols: Option<u16>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rows: Option<u16>,
}

pub struct PtyManager {
    app: AppHandle,
    dir: PathBuf,
    sessions: Mutex<HashMap<String, Arc<Session>>>,
    meta: Mutex<HashMap<String, SessionMeta>>,
    attach_seq: AtomicU64,
    /// shared with every reader thread so a settings change applies to live sessions
    ring_cap: Arc<AtomicUsize>,
    persist_scrollback: AtomicBool,
    /// one `persist` at a time (periodic + exit): an older ring must not overwrite a newer one
    persisting: Mutex<()>,
}

struct Session {
    id: String,
    profile_id: String,
    backend: Backend,
    /// Input goes to a writer thread (local: a write blocks while the shell isn't
    /// reading its input, and commands run on the main thread) or the SSH task.
    input: Mutex<Option<mpsc::UnboundedSender<Vec<u8>>>>,
    out: Mutex<Output>,
    alive: AtomicBool,
    dirty: AtomicBool,
    pid: Option<u32>,
    cwd: Mutex<Option<String>>,
    title: Mutex<Option<String>>,
    exit_code: Mutex<Option<u32>>,
    size: Mutex<(u16, u16)>,
    /// scrollback and cwd are saved for restarts (not for Orchestrator agents: their TUI's
    /// output is redraw noise, and `claude --resume` draws the conversation again itself)
    persist: bool,
}

enum Backend {
    Local {
        master: Mutex<Option<Box<dyn MasterPty + Send>>>,
        killer: Mutex<Box<dyn ChildKiller + Send + Sync>>,
    },
    Ssh {
        size: watch::Sender<(u16, u16)>,
        kill: Arc<Notify>,
    },
}

impl Session {
    fn resize(&self, cols: u16, rows: u16) -> Result<(), String> {
        let (cols, rows) = (cols.max(2), rows.max(1));
        *self.size.lock() = (cols, rows);
        match &self.backend {
            Backend::Local { master, .. } => {
                if let Some(m) = master.lock().as_ref() {
                    m.resize(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 }).s()?;
                }
            }
            Backend::Ssh { size, .. } => {
                size.send_replace((cols, rows));
            }
        }
        Ok(())
    }

    fn kill(&self) {
        match &self.backend {
            Backend::Local { killer, .. } => {
                let _ = killer.lock().kill();
            }
            // (a permit: also stops a session that is still connecting)
            Backend::Ssh { kill, .. } => kill.notify_one(),
        }
    }

    fn meta(&self) -> SessionMeta {
        let (cols, rows) = *self.size.lock();
        SessionMeta {
            cwd: self.cwd.lock().clone(),
            profile_id: Some(self.profile_id.clone()),
            cols: Some(cols),
            rows: Some(rows),
        }
    }
}

struct Output {
    ring: Vec<u8>,
    channel: Option<(u64, Channel<InvokeResponseBody>)>,
    /// Set until a view has drawn the "restored session" marker (pty_restored).
    restored: Option<Restored>,
}

/// Where the saved output of a restored session ends in the ring, and the size it was
/// drawn at. A view replays it at that size, then draws the marker below it.
#[derive(Clone, Copy)]
struct Restored {
    at: usize,
    cols: Option<u16>,
    rows: Option<u16>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AttachInfo {
    token: u64,
    alive: bool,
    spawned: bool,
    pid: Option<u32>,
    cwd: Option<String>,
    exit_code: Option<u32>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PtyInfo {
    alive: bool,
    pid: Option<u32>,
    cwd: Option<String>,
    title: Option<String>,
    profile_id: Option<String>,
}

fn send_json(ch: &Channel<InvokeResponseBody>, value: serde_json::Value) -> bool {
    ch.send(InvokeResponseBody::Json(value.to_string())).is_ok()
}

impl PtyManager {
    pub fn new(app: AppHandle, dir: PathBuf) -> Self {
        let meta = fs::read(dir.join("meta.json"))
            .ok()
            .and_then(|b| serde_json::from_slice(&b).ok())
            .unwrap_or_default();
        Self {
            app,
            dir,
            sessions: Mutex::new(HashMap::new()),
            meta: Mutex::new(meta),
            attach_seq: AtomicU64::new(0),
            ring_cap: Arc::new(AtomicUsize::new(DEFAULT_RING_BYTES)),
            persist_scrollback: AtomicBool::new(true),
            persisting: Mutex::new(()),
        }
    }

    fn bin_path(&self, id: &str) -> PathBuf {
        self.dir.join(format!("{id}.bin"))
    }

    /// Drop saved sessions for panes that no longer exist in the model.
    pub fn gc(&self, live: &HashSet<String>) {
        self.meta.lock().retain(|id, _| live.contains(id));
        if let Ok(entries) = fs::read_dir(&self.dir) {
            for e in entries.flatten() {
                let path = e.path();
                match path.extension().and_then(|x| x.to_str()) {
                    Some("bin") => {
                        let stem = path.file_stem().and_then(|s| s.to_str()).unwrap_or("");
                        if !live.contains(stem) {
                            let _ = fs::remove_file(&path);
                        }
                    }
                    // a write_atomic temp file left by a crash (names are unique, so nothing reuses it)
                    Some("tmp~") => {
                        let _ = fs::remove_file(&path);
                    }
                    _ => {}
                }
            }
        }
        self.save_meta();
    }

    fn save_meta(&self) {
        let data = serde_json::to_vec_pretty(&*self.meta.lock()).unwrap_or_default();
        let _ = write_atomic(&self.dir.join("meta.json"), &data);
    }

    /// Persist every dirty session ring plus cwd metadata.
    pub fn persist(&self) {
        let _persisting = self.persisting.lock();
        let scrollback = self.persist_scrollback.load(Ordering::Relaxed);
        let sessions: Vec<Arc<Session>> = self.sessions.lock().values().filter(|s| s.persist).cloned().collect();
        {
            let mut meta = self.meta.lock();
            for s in &sessions {
                meta.insert(s.id.clone(), s.meta());
            }
        }
        self.save_meta();
        if !scrollback {
            return;
        }
        for s in sessions {
            if s.dirty.swap(false, Ordering::Relaxed) {
                let ring = s.out.lock().ring.clone();
                if write_atomic(&self.bin_path(&s.id), &ring).is_err() {
                    s.dirty.store(true, Ordering::Relaxed); // retry next time
                }
            }
        }
    }

    /// The saved scrollback of a pane being restored. The view resets the terminal and
    /// draws the "restored session" marker after it: only the view knows where the old
    /// output left the cursor (Claude Code, for one, leaves it in the middle of its frame).
    fn restored_ring(&self, id: &str, spec: &SpawnSpec) -> (Vec<u8>, Option<Restored>) {
        if spec.restore && self.persist_scrollback.load(Ordering::Relaxed) {
            if let Ok(old) = fs::read(self.bin_path(id)) {
                if !old.is_empty() {
                    let saved = self.meta.lock().get(id).cloned().unwrap_or_default();
                    let restored = Restored { at: old.len(), cols: saved.cols, rows: saved.rows };
                    return (old, Some(restored));
                }
            }
        }
        (Vec::new(), None)
    }

    /// A shell on a saved SSH host. A pane restored at startup only shows its old
    /// output and waits (Enter reconnects) instead of dialing out on its own.
    fn spawn_ssh(&self, id: &str, spec: &SpawnSpec, host_id: &str, cols: u16, rows: u16) -> Arc<Session> {
        let (ring, restored) = self.restored_ring(id, spec);
        // restored = it ran in an earlier session (saved scrollback, or at least its metadata
        // when scrollback isn't saved); a pane opened just now connects right away
        let dormant = spec.restore && (!ring.is_empty() || self.meta.lock().contains_key(id));
        let (size, size_rx) = watch::channel((cols, rows));
        let kill = Arc::new(Notify::new());
        let (input, input_rx) = mpsc::unbounded_channel();
        let session = Arc::new(Session {
            id: id.to_string(),
            profile_id: spec.profile_id.clone(),
            backend: Backend::Ssh { size, kill: kill.clone() },
            input: Mutex::new((!dormant).then_some(input)),
            out: Mutex::new(Output { ring, channel: None, restored }),
            alive: AtomicBool::new(!dormant),
            dirty: AtomicBool::new(true),
            pid: None,
            cwd: Mutex::new(None),
            title: Mutex::new(None),
            exit_code: Mutex::new(None),
            size: Mutex::new((cols, rows)),
            persist: true,
        });
        if dormant {
            return session;
        }
        let (app, cap) = (self.app.clone(), self.ring_cap.clone());
        let osc = Mutex::new(OscScanner::default());
        let output: Arc<dyn Fn(&[u8]) + Send + Sync> = {
            let (s, app) = (session.clone(), app.clone());
            // (no cwd tracking: a remote folder means nothing to the local Files/Git panes)
            Arc::new(move |chunk: &[u8]| on_output(&s, &app, &mut osc.lock(), chunk, cap.load(Ordering::Relaxed), false))
        };
        let s = session.clone();
        ssh::start_terminal(app.clone(), host_id.to_string(), TermIo { output, input: input_rx, size: size_rx, kill }, move |code| {
            *s.exit_code.lock() = code;
            s.input.lock().take();
            on_exit(&s, &app, code);
        });
        session
    }

    fn spawn(&self, id: &str, spec: &SpawnSpec, cols: u16, rows: u16) -> Result<Arc<Session>, String> {
        if let Some(host_id) = spec.ssh.as_deref() {
            return Ok(self.spawn_ssh(id, spec, host_id, cols, rows));
        }
        // the last cwd we saw for this pane beats the pane's initial directory
        let saved = self.meta.lock().get(id).cloned().unwrap_or_default();
        let cwd = saved.cwd.or_else(|| spec.cwd.clone());
        let cmd = build_command(spec, cwd.as_deref());
        let (ring, restored) = self.restored_ring(id, spec);
        let local = LocalSpec { id, profile_id: &spec.profile_id, command: &spec.command, cwd, persist: true };
        self.start_local(local, cmd, cols, rows, ring, restored)
    }

    /// An Orchestrator agent's terminal, started without a view (its workspace may not be on
    /// screen). A view attaches later; the agent's command, environment and folder come from
    /// the Orchestrator, never from the pane. Returns the process id.
    pub fn spawn_agent(&self, pane_id: &str, spec: &crate::agents::Launch) -> Result<Option<u32>, String> {
        safe_key(pane_id)?;
        if let Some(s) = self.sessions.lock().get(pane_id) {
            if s.alive.load(Ordering::SeqCst) {
                return Err("the agent's terminal is already running".into());
            }
        }
        let mut cmd = portable_pty::CommandBuilder::new(&spec.program);
        cmd.args(&spec.args);
        cmd.cwd(&spec.cwd);
        cmd.env_clear();
        for (k, v) in &spec.env {
            cmd.env(k, v);
        }
        let local = LocalSpec { id: pane_id, profile_id: "agent", command: &spec.program, cwd: Some(spec.cwd.clone()), persist: false };
        let session = self.start_local(local, cmd, spec.cols.max(2), spec.rows.max(1), Vec::new(), None)?;
        let pid = session.pid;
        self.sessions.lock().insert(pane_id.to_string(), session);
        // a view showing the pane's previous session attaches to this one
        let _ = self.app.emit("pty://spawned", json!({ "paneId": pane_id, "pid": pid }));
        Ok(pid)
    }

    fn start_local(&self, l: LocalSpec<'_>, cmd: portable_pty::CommandBuilder, cols: u16, rows: u16, ring: Vec<u8>, restored: Option<Restored>) -> Result<Arc<Session>, String> {
        let pty = native_pty_system();
        let pair = pty
            .openpty(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
            .s()?;
        let mut child = pair.slave.spawn_command(cmd).map_err(|e| {
            format!("failed to start {}: {e}", l.command)
        })?;
        drop(pair.slave);

        let reader = pair.master.try_clone_reader().s()?;
        let mut writer = pair.master.take_writer().s()?;
        let (input, mut input_rx) = mpsc::unbounded_channel::<Vec<u8>>();
        // ends when the session drops its sender (process exited) or a write fails
        std::thread::spawn(move || {
            while let Some(data) = input_rx.blocking_recv() {
                if writer.write_all(&data).and_then(|_| writer.flush()).is_err() {
                    break;
                }
            }
        });
        let killer = child.clone_killer();
        let pid = child.process_id();

        let session = Arc::new(Session {
            id: l.id.to_string(),
            profile_id: l.profile_id.to_string(),
            backend: Backend::Local { master: Mutex::new(Some(pair.master)), killer: Mutex::new(killer) },
            input: Mutex::new(Some(input)),
            out: Mutex::new(Output { ring, channel: None, restored }),
            alive: AtomicBool::new(true),
            dirty: AtomicBool::new(true),
            pid,
            cwd: Mutex::new(l.cwd.filter(|c| !c.is_empty())),
            title: Mutex::new(None),
            exit_code: Mutex::new(None),
            size: Mutex::new((cols, rows)),
            persist: l.persist,
        });

        // Waiter: ConPTY keeps the output pipe open after the child exits, so once
        // the process is gone we close the pseudoconsole to let the reader hit EOF.
        {
            let s = session.clone();
            std::thread::spawn(move || {
                let code = child.wait().ok().map(|st| st.exit_code());
                *s.exit_code.lock() = code;
                s.alive.store(false, Ordering::SeqCst);
                std::thread::sleep(Duration::from_millis(150));
                s.input.lock().take();
                if let Backend::Local { master, .. } = &s.backend {
                    master.lock().take();
                }
            });
        }

        // Reader: ring buffer + live forwarding + OSC (cwd/title) scanning.
        {
            let s = session.clone();
            let app = self.app.clone();
            let cap = self.ring_cap.clone();
            std::thread::spawn(move || reader_loop(reader, s, app, cap));
        }

        Ok(session)
    }

    /// Type into a session (a view's keystrokes, or the Orchestrator's messages).
    pub fn write_to(&self, pane_id: &str, data: &str) -> Result<(), String> {
        let s = self.sessions.lock().get(pane_id).cloned();
        let Some(s) = s else { return Err("no such terminal".into()) };
        let input = s.input.lock();
        match input.as_ref() {
            Some(tx) if tx.send(data.as_bytes().to_vec()).is_ok() => Ok(()),
            _ => Err("terminal has exited".into()),
        }
    }

    /// Terminate a session. `forget` also deletes its saved scrollback (pane closed).
    pub fn kill_session(&self, pane_id: &str, forget: bool) {
        // the id becomes a file name below ("..\x" would delete outside sessions/)
        if safe_key(pane_id).is_err() {
            return;
        }
        let s = self.sessions.lock().remove(pane_id);
        if let Some(s) = s {
            s.kill();
            s.out.lock().channel = None;
            if !forget && s.persist {
                // restarting: remember where the shell was so the new one starts there
                self.meta.lock().insert(pane_id.to_string(), s.meta());
            }
        }
        if forget {
            let _ = fs::remove_file(self.bin_path(pane_id));
            self.meta.lock().remove(pane_id);
        }
    }

    /// The process id of a running local session.
    pub fn running_pid(&self, pane_id: &str) -> Option<u32> {
        let s = self.sessions.lock().get(pane_id).cloned()?;
        if s.alive.load(Ordering::SeqCst) {
            s.pid
        } else {
            None
        }
    }

    /// Plain text of a session's most recent output.
    pub fn text_tail(&self, pane_id: &str, max_bytes: usize) -> Option<String> {
        let s = self.sessions.lock().get(pane_id).cloned()?;
        let tail = {
            let out = s.out.lock();
            out.ring[out.ring.len().saturating_sub(max_bytes)..].to_vec()
        };
        Some(strip_ansi(&tail))
    }

    /// A session's screen as it is now, rebuilt from its last `max_bytes` of output at its
    /// current size (exact for a session whose whole output fits, such as one just started).
    pub fn screen_lines(&self, pane_id: &str, max_bytes: usize) -> Option<Vec<String>> {
        let s = self.sessions.lock().get(pane_id).cloned()?;
        let tail = {
            let out = s.out.lock();
            out.ring[out.ring.len().saturating_sub(max_bytes)..].to_vec()
        };
        let (cols, rows) = *s.size.lock();
        let mut screen = Screen::new(cols, rows);
        screen.feed(&tail);
        Some(screen.lines())
    }
}

/// Who a local session is for.
struct LocalSpec<'a> {
    id: &'a str,
    profile_id: &'a str,
    command: &'a str,
    cwd: Option<String>,
    persist: bool,
}

/// A chunk of terminal output: OSC scanning (cwd, title), ring buffer, live view.
fn on_output(s: &Session, app: &AppHandle, osc: &mut OscScanner, chunk: &[u8], cap: usize, track_cwd: bool) {
    for ev in osc.feed(chunk) {
        match ev {
            OscEvent::Cwd(cwd) if track_cwd => {
                let changed = {
                    let mut c = s.cwd.lock();
                    let changed = c.as_deref() != Some(cwd.as_str());
                    *c = Some(cwd.clone());
                    changed
                };
                if changed {
                    let _ = app.emit("pty://cwd", json!({ "paneId": s.id, "cwd": cwd }));
                }
            }
            OscEvent::Cwd(_) => {}
            OscEvent::Title(title) => {
                *s.title.lock() = Some(title.clone());
                let _ = app.emit("pty://title", json!({ "paneId": s.id, "title": title }));
            }
        }
    }
    let mut out = s.out.lock();
    let cut = push_ring(&mut out.ring, chunk, cap);
    if let Some(r) = out.restored {
        // (trimmed past the old output: there's no spot left to mark)
        out.restored = (cut < r.at).then_some(Restored { at: r.at - cut, ..r });
    }
    s.dirty.store(true, Ordering::Relaxed);
    let failed = match &out.channel {
        Some((_, ch)) => ch.send(InvokeResponseBody::Raw(chunk.to_vec())).is_err(),
        None => false,
    };
    if failed {
        out.channel = None;
    }
}

fn on_exit(s: &Session, app: &AppHandle, code: Option<u32>) {
    s.alive.store(false, Ordering::SeqCst);
    if let Some((_, ch)) = &s.out.lock().channel {
        send_json(ch, json!({ "t": "exit", "code": code }));
    }
    let _ = app.emit("pty://exit", json!({ "paneId": s.id, "code": code, "pid": s.pid }));
}

fn reader_loop(mut reader: Box<dyn Read + Send>, s: Arc<Session>, app: AppHandle, cap: Arc<AtomicUsize>) {
    let mut buf = vec![0u8; 64 * 1024];
    let mut osc = OscScanner::default();
    loop {
        match reader.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => on_output(&s, &app, &mut osc, &buf[..n], cap.load(Ordering::Relaxed), true),
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(_) => break,
        }
    }
    s.alive.store(false, Ordering::SeqCst);
    // give the waiter a moment to record the exit code
    for _ in 0..20 {
        if s.exit_code.lock().is_some() {
            break;
        }
        std::thread::sleep(Duration::from_millis(25));
    }
    let code = *s.exit_code.lock();
    on_exit(&s, &app, code);
}

#[tauri::command]
pub fn pty_attach(
    mgr: State<'_, PtyManager>,
    pane_id: String,
    spec: SpawnSpec,
    cols: u16,
    rows: u16,
    on_data: Channel<InvokeResponseBody>,
) -> Result<AttachInfo, String> {
    safe_key(&pane_id)?;
    let cols = cols.max(2);
    let rows = rows.max(1);
    let token = mgr.attach_seq.fetch_add(1, Ordering::Relaxed) + 1;

    let existing = mgr.sessions.lock().get(&pane_id).cloned();
    let (session, spawned) = match existing {
        Some(s) => (s, false),
        // an agent's terminal is started by the Orchestrator only (Resume), never by a view
        None if spec.agent.is_some() => return Err("agent-stopped".into()),
        None => {
            let s = mgr.spawn(&pane_id, &spec, cols, rows)?;
            mgr.sessions.lock().insert(pane_id.clone(), s.clone());
            (s, true)
        }
    };
    if !spawned {
        let _ = session.resize(cols, rows);
    }

    // Replay under the output lock so no live chunk slips in between.
    let mut out = session.out.lock();
    let send_raw = |data: &[u8]| {
        if !data.is_empty() {
            let _ = on_data.send(InvokeResponseBody::Raw(data.to_vec()));
        }
    };
    match out.restored {
        Some(r) => {
            send_json(&on_data, json!({ "t": "replay-start", "cols": r.cols, "rows": r.rows }));
            send_raw(&out.ring[..r.at]);
            // the view draws the marker here, then calls pty_restored
            send_json(&on_data, json!({ "t": "restored", "token": token }));
            send_raw(&out.ring[r.at..]);
        }
        None => {
            send_json(&on_data, json!({ "t": "replay-start" }));
            send_raw(&out.ring);
        }
    }
    send_json(&on_data, json!({ "t": "replay-end" }));
    let alive = session.alive.load(Ordering::SeqCst);
    if !alive {
        send_json(&on_data, json!({ "t": "exit", "code": *session.exit_code.lock() }));
    }
    out.channel = Some((token, on_data));
    drop(out);

    let cwd = session.cwd.lock().clone();
    let exit_code = *session.exit_code.lock();
    Ok(AttachInfo { token, alive, spawned, pid: session.pid, cwd, exit_code })
}

/// A view drew the "restored session" marker (and the resets before it) where the old
/// session's output ends. The same bytes go into the ring there, so a later replay (in
/// another window, or after the next restart) looks the way this view does now.
#[tauri::command]
pub fn pty_restored(mgr: State<'_, PtyManager>, pane_id: String, token: u64, data: String) {
    if data.len() > 4096 {
        return;
    }
    let s = mgr.sessions.lock().get(&pane_id).cloned();
    let Some(s) = s else { return };
    let mut out = s.out.lock();
    if !matches!(&out.channel, Some((t, _)) if *t == token) {
        return; // a newer view replays the old output again and marks it itself
    }
    if let Some(r) = out.restored.take() {
        out.ring.splice(r.at..r.at, data.into_bytes());
        s.dirty.store(true, Ordering::Relaxed);
    }
}

/// Stop forwarding to a view. Ignored if another view attached since (token mismatch).
#[tauri::command]
pub fn pty_detach(mgr: State<'_, PtyManager>, pane_id: String, token: u64) {
    if let Some(s) = mgr.sessions.lock().get(&pane_id) {
        let mut out = s.out.lock();
        if matches!(&out.channel, Some((t, _)) if *t == token) {
            out.channel = None;
        }
    }
}

#[tauri::command]
pub fn pty_write(mgr: State<'_, PtyManager>, pane_id: String, data: String) -> Result<(), String> {
    mgr.write_to(&pane_id, &data)
}

#[tauri::command]
pub fn pty_resize(mgr: State<'_, PtyManager>, pane_id: String, cols: u16, rows: u16) -> Result<(), String> {
    let s = mgr.sessions.lock().get(&pane_id).cloned();
    match s {
        Some(s) => s.resize(cols, rows),
        None => Ok(()),
    }
}

/// Terminate a session. `forget` also deletes its saved scrollback (pane closed).
#[tauri::command]
pub fn pty_kill(mgr: State<'_, PtyManager>, pane_id: String, forget: Option<bool>) {
    mgr.kill_session(&pane_id, forget.unwrap_or(true));
}

#[tauri::command]
pub fn pty_info(mgr: State<'_, PtyManager>, pane_id: String) -> Option<PtyInfo> {
    if let Some(s) = mgr.sessions.lock().get(&pane_id) {
        return Some(PtyInfo {
            alive: s.alive.load(Ordering::SeqCst),
            pid: s.pid,
            cwd: s.cwd.lock().clone(),
            title: s.title.lock().clone(),
            profile_id: Some(s.profile_id.clone()),
        });
    }
    mgr.meta.lock().get(&pane_id).map(|m| PtyInfo {
        alive: false,
        pid: None,
        cwd: m.cwd.clone(),
        title: None,
        profile_id: m.profile_id.clone(),
    })
}

/// Plain text of the most recent output (escape sequences stripped).
#[tauri::command]
pub fn pty_text(mgr: State<'_, PtyManager>, pane_id: String, max_bytes: Option<usize>) -> Result<String, String> {
    let s = mgr.sessions.lock().get(&pane_id).cloned();
    let Some(s) = s else { return Err("no such terminal".into()) };
    let max = max_bytes.unwrap_or(64 * 1024).min(DEFAULT_RING_BYTES);
    // copy only the tail: the ring can be 64 MB and this runs on the main thread
    let tail = {
        let out = s.out.lock();
        out.ring[out.ring.len().saturating_sub(max)..].to_vec()
    };
    Ok(strip_ansi(&tail))
}

/// Apply user settings: scrollback ring size and whether scrollback is saved to disk.
#[tauri::command]
pub fn pty_configure(mgr: State<'_, PtyManager>, ring_bytes: usize, persist_scrollback: bool) {
    mgr.ring_cap
        .store(ring_bytes.clamp(64 * 1024, 64 * 1024 * 1024), Ordering::Relaxed);
    // wait out a running persist: it would write .bin files back after we delete them
    let _persisting = mgr.persisting.lock();
    let was = mgr.persist_scrollback.swap(persist_scrollback, Ordering::Relaxed);
    if was && !persist_scrollback {
        if let Ok(entries) = fs::read_dir(&mgr.dir) {
            for e in entries.flatten() {
                if e.path().extension().and_then(|x| x.to_str()) == Some("bin") {
                    let _ = fs::remove_file(e.path());
                }
            }
        }
    }
}

