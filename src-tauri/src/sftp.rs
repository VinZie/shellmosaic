//! SFTP panes: browse and transfer files on a saved host. One connection per pane
//! (connected via ssh.rs, questions asked through app dialogs).
//!
//! Remote names come from a server that may be hostile, so every name written to
//! the local disk is sanitized (no "..", separators, drive letters, device names),
//! and recursive transfers never follow symbolic links.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use parking_lot::Mutex;
use russh::client::Handle;
use russh_sftp::client::SftpSession;
use serde::Serialize;
use serde_json::json;
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager, State};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

use crate::paths::ErrStr;
use crate::sanitize::safe_local_name;
use crate::ssh::{self, Client, Prompter};

const CANCELLED: &str = "cancelled";

struct Conn {
    host_id: String,
    sftp: SftpSession,
    // keeps the SSH connection open for as long as the pane uses it
    _handle: tokio::sync::Mutex<Handle<Client>>,
}

#[derive(Default)]
pub struct SftpConns {
    conns: Mutex<HashMap<String, Arc<Conn>>>,
    transfers: Mutex<HashMap<u64, Arc<AtomicBool>>>,
    next: AtomicU64,
}

impl SftpConns {
    fn get(&self, pane_id: &str) -> Result<Arc<Conn>, String> {
        self.conns.lock().get(pane_id).cloned().ok_or_else(|| "not connected".to_string())
    }
}

/// POSIX join for remote paths.
fn rjoin(dir: &str, name: &str) -> String {
    if dir.ends_with('/') { format!("{dir}{name}") } else { format!("{dir}/{name}") }
}

/// `dir\name`, or `dir\name (2)` … when that exists already.
fn unique_local(dir: &Path, name: &str) -> PathBuf {
    let first = dir.join(name);
    if !first.exists() {
        return first;
    }
    let (stem, ext) = match name.rfind('.') {
        Some(i) if i > 0 => (&name[..i], &name[i..]),
        _ => (name, ""),
    };
    (2..10_000).map(|n| dir.join(format!("{stem} ({n}){ext}"))).find(|p| !p.exists()).unwrap_or(first)
}

fn mode_string(perms: Option<u32>) -> String {
    let Some(m) = perms else { return String::new() };
    let kind = match m & 0o170000 {
        0o040000 => 'd',
        0o120000 => 'l',
        _ => '-',
    };
    let bit = |mask: u32, c: char| if m & mask != 0 { c } else { '-' };
    format!(
        "{kind}{}{}{}{}{}{}{}{}{}",
        bit(0o400, 'r'), bit(0o200, 'w'), bit(0o100, 'x'),
        bit(0o040, 'r'), bit(0o020, 'w'), bit(0o010, 'x'),
        bit(0o004, 'r'), bit(0o002, 'w'), bit(0o001, 'x'),
    )
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SftpInfo {
    home: String,
    host_name: String,
}

#[tauri::command]
pub async fn sftp_connect(app: AppHandle, pane_id: String, host_id: String) -> Result<SftpInfo, String> {
    let conns = app.state::<SftpConns>();
    let existing = conns.conns.lock().get(&pane_id).cloned();
    // (the same host only: the pane may have been pointed at another one)
    if let Some(c) = existing.filter(|c| c.host_id == host_id) {
        if let Ok(home) = c.sftp.canonicalize(".").await {
            let host_name = app.state::<crate::vault::Vault>().host(&host_id).map(|h| h.name.clone()).unwrap_or_default();
            return Ok(SftpInfo { home, host_name });
        }
    }
    let p = Arc::new(Prompter::Dialog(ssh::DialogPrompter::new(app.clone(), pane_id.clone())));
    let (handle, host) = ssh::connect(&app, &host_id, p).await?;
    let channel = handle.channel_open_session().await.s()?;
    channel.request_subsystem(true, "sftp").await.s()?;
    let sftp = SftpSession::new(channel.into_stream()).await.map_err(|e| format!("the server has no SFTP: {e}"))?;
    let home = sftp.canonicalize(".").await.unwrap_or_else(|_| "/".into());
    conns.conns.lock().insert(pane_id, Arc::new(Conn { host_id, sftp, _handle: tokio::sync::Mutex::new(handle) }));
    Ok(SftpInfo { home, host_name: host.name.clone() })
}

#[tauri::command]
pub fn sftp_close(conns: State<'_, SftpConns>, pane_id: String) {
    conns.conns.lock().remove(&pane_id);
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteEntry {
    name: String,
    path: String,
    is_dir: bool,
    is_link: bool,
    size: u64,
    modified: u64,
    mode: String,
}

#[tauri::command]
pub async fn sftp_list(app: AppHandle, pane_id: String, path: String) -> Result<Vec<RemoteEntry>, String> {
    let c = app.state::<SftpConns>().get(&pane_id)?;
    let mut out = Vec::new();
    for e in c.sftp.read_dir(path.as_str()).await.s()? {
        let name = e.file_name();
        if name == "." || name == ".." {
            continue;
        }
        let meta = e.metadata();
        let full = rjoin(&path, &name);
        let is_link = meta.is_symlink();
        // a link's own attributes say "link": ask where it points to show folders as folders
        let is_dir = if is_link { c.sftp.metadata(full.as_str()).await.map(|m| m.is_dir()).unwrap_or(false) } else { meta.is_dir() };
        out.push(RemoteEntry {
            name,
            path: full,
            is_dir,
            is_link,
            size: meta.size.unwrap_or(0),
            modified: meta.mtime.map(|t| t as u64 * 1000).unwrap_or(0),
            mode: mode_string(meta.permissions),
        });
    }
    out.sort_by(|a, b| b.is_dir.cmp(&a.is_dir).then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase())));
    Ok(out)
}

#[tauri::command]
pub async fn sftp_mkdir(app: AppHandle, pane_id: String, path: String) -> Result<(), String> {
    app.state::<SftpConns>().get(&pane_id)?.sftp.create_dir(path).await.s()
}

#[tauri::command]
pub async fn sftp_rename(app: AppHandle, pane_id: String, from: String, to: String) -> Result<(), String> {
    let c = app.state::<SftpConns>().get(&pane_id)?;
    if c.sftp.try_exists(to.as_str()).await.unwrap_or(false) {
        return Err("something with that name already exists".into());
    }
    c.sftp.rename(from, to).await.s()
}

/// Delete files and folders (folders with everything in them; links themselves, never their targets).
#[tauri::command]
pub async fn sftp_delete(app: AppHandle, pane_id: String, paths: Vec<String>) -> Result<(), String> {
    let c = app.state::<SftpConns>().get(&pane_id)?;
    for p in paths {
        let meta = c.sftp.symlink_metadata(p.as_str()).await.s()?;
        if meta.is_dir() && !meta.is_symlink() {
            delete_tree(&c.sftp, &p, 0).await?;
        } else {
            c.sftp.remove_file(p.as_str()).await.s()?;
        }
    }
    Ok(())
}

async fn delete_tree(sftp: &SftpSession, dir: &str, depth: usize) -> Result<(), String> {
    if depth > 64 {
        return Err("folders nested too deeply".into());
    }
    for e in sftp.read_dir(dir).await.s()? {
        let name = e.file_name();
        if name == "." || name == ".." {
            continue;
        }
        let path = rjoin(dir, &name);
        let meta = e.metadata();
        if meta.is_dir() && !meta.is_symlink() {
            Box::pin(delete_tree(sftp, &path, depth + 1)).await?;
        } else {
            sftp.remove_file(path.as_str()).await.s()?;
        }
    }
    sftp.remove_dir(dir).await.s()
}

#[tauri::command]
pub fn sftp_cancel(conns: State<'_, SftpConns>, id: u64) {
    if let Some(flag) = conns.transfers.lock().get(&id) {
        flag.store(true, Ordering::Relaxed);
    }
}

/// Progress reporting for a transfer, throttled to a few events per second.
struct Progress {
    ch: Channel<serde_json::Value>,
    done: u64,
    total: u64,
    last: Instant,
}

impl Progress {
    fn add(&mut self, n: u64, file: &str) {
        self.done += n;
        if self.last.elapsed() > Duration::from_millis(150) {
            self.last = Instant::now();
            let _ = self.ch.send(json!({ "t": "progress", "done": self.done, "total": self.total, "file": file }));
        }
    }
}

fn start_transfer(app: &AppHandle) -> (u64, Arc<AtomicBool>) {
    let conns = app.state::<SftpConns>();
    let id = conns.next.fetch_add(1, Ordering::Relaxed) + 1;
    let flag = Arc::new(AtomicBool::new(false));
    conns.transfers.lock().insert(id, flag.clone());
    (id, flag)
}

fn finish_transfer(app: &AppHandle, id: u64, ch: &Channel<serde_json::Value>, result: Result<(usize, usize), String>, cancel: &AtomicBool) {
    app.state::<SftpConns>().transfers.lock().remove(&id);
    let _ = ch.send(match result {
        Err(e) if e == CANCELLED && cancel.load(Ordering::Relaxed) => json!({ "t": "cancelled" }),
        Ok((files, skipped)) => json!({ "t": "done", "files": files, "skipped": skipped }),
        Err(e) => json!({ "t": "error", "message": e }),
    });
}

/// Download remote files/folders into `local_dir`. Returns a transfer id at once;
/// progress, completion and errors arrive on `on_event`.
#[tauri::command]
pub async fn sftp_download(
    app: AppHandle,
    pane_id: String,
    paths: Vec<String>,
    local_dir: String,
    on_event: Channel<serde_json::Value>,
) -> Result<u64, String> {
    let c = app.state::<SftpConns>().get(&pane_id)?;
    let dir = PathBuf::from(&local_dir);
    if !dir.is_dir() {
        return Err("choose an existing folder to download into".into());
    }
    let (id, cancel) = start_transfer(&app);
    tauri::async_runtime::spawn(async move {
        let result = download(&c.sftp, &paths, &dir, &on_event, &cancel).await;
        finish_transfer(&app, id, &on_event, result, &cancel);
    });
    Ok(id)
}

async fn download(sftp: &SftpSession, paths: &[String], dir: &Path, ch: &Channel<serde_json::Value>, cancel: &AtomicBool) -> Result<(usize, usize), String> {
    // plan first (sizes for the progress bar); links are skipped, never followed
    let mut files: Vec<(String, PathBuf, u64)> = Vec::new();
    let mut dirs: Vec<PathBuf> = Vec::new();
    let mut skipped = 0;
    for p in paths {
        let meta = sftp.symlink_metadata(p.as_str()).await.s()?;
        let name = safe_local_name(p.trim_end_matches('/').rsplit('/').next().unwrap_or("download"));
        let local = unique_local(dir, &name);
        if meta.is_symlink() {
            skipped += 1;
        } else if meta.is_dir() {
            dirs.push(local.clone());
            plan_dir(sftp, p, &local, &mut files, &mut dirs, &mut skipped, 0).await?;
        } else {
            files.push((p.clone(), local, meta.size.unwrap_or(0)));
        }
        if files.len() + dirs.len() > 100_000 {
            return Err("too many files in one download".into());
        }
    }
    let total = files.iter().map(|f| f.2).sum();
    let _ = ch.send(json!({ "t": "start", "total": total, "files": files.len() }));
    for d in &dirs {
        std::fs::create_dir_all(d).s()?;
    }
    let mut progress = Progress { ch: ch.clone(), done: 0, total, last: Instant::now() };
    let mut buf = vec![0u8; 256 * 1024];
    for (remote, local, _) in &files {
        let name = local.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        let mut src = sftp.open(remote.as_str()).await.s()?;
        let mut dst = tokio::fs::File::create(local).await.s()?;
        loop {
            if cancel.load(Ordering::Relaxed) {
                drop(dst);
                let _ = std::fs::remove_file(local);
                return Err(CANCELLED.into());
            }
            let n = src.read(&mut buf).await.s()?;
            if n == 0 {
                break;
            }
            dst.write_all(&buf[..n]).await.s()?;
            progress.add(n as u64, &name);
        }
        dst.flush().await.s()?;
    }
    Ok((files.len(), skipped))
}

async fn plan_dir(
    sftp: &SftpSession,
    remote: &str,
    local: &Path,
    files: &mut Vec<(String, PathBuf, u64)>,
    dirs: &mut Vec<PathBuf>,
    skipped: &mut usize,
    depth: usize,
) -> Result<(), String> {
    if depth > 32 {
        return Err("folders nested too deeply".into());
    }
    for e in sftp.read_dir(remote).await.s()? {
        let name = e.file_name();
        if name == "." || name == ".." {
            continue;
        }
        let meta = e.metadata();
        let path = rjoin(remote, &name);
        let to = local.join(safe_local_name(&name));
        if meta.is_symlink() {
            *skipped += 1;
        } else if meta.is_dir() {
            dirs.push(to.clone());
            Box::pin(plan_dir(sftp, &path, &to, files, dirs, skipped, depth + 1)).await?;
        } else {
            files.push((path, to, meta.size.unwrap_or(0)));
        }
        if files.len() + dirs.len() > 100_000 {
            return Err("too many files in one download".into());
        }
    }
    Ok(())
}

/// Upload local files/folders into `remote_dir`. Existing remote files are replaced
/// only with `overwrite` (otherwise skipped).
#[tauri::command]
pub async fn sftp_upload(
    app: AppHandle,
    pane_id: String,
    paths: Vec<String>,
    remote_dir: String,
    overwrite: bool,
    on_event: Channel<serde_json::Value>,
) -> Result<u64, String> {
    let c = app.state::<SftpConns>().get(&pane_id)?;
    let (id, cancel) = start_transfer(&app);
    tauri::async_runtime::spawn(async move {
        let result = upload(&c.sftp, &paths, &remote_dir, overwrite, &on_event, &cancel).await;
        finish_transfer(&app, id, &on_event, result, &cancel);
    });
    Ok(id)
}

fn plan_local(local: &Path, remote: &str, files: &mut Vec<(PathBuf, String, u64)>, dirs: &mut Vec<String>, skipped: &mut usize, depth: usize) -> Result<(), String> {
    if depth > 32 {
        return Err("folders nested too deeply".into());
    }
    let meta = std::fs::symlink_metadata(local).s()?;
    // (junctions and symlinks are skipped: they could lead anywhere on the disk)
    if meta.file_type().is_symlink() {
        *skipped += 1;
    } else if meta.is_dir() {
        dirs.push(remote.to_string());
        for e in std::fs::read_dir(local).s()?.flatten() {
            let name = e.file_name().to_string_lossy().into_owned();
            plan_local(&e.path(), &rjoin(remote, &name), files, dirs, skipped, depth + 1)?;
            if files.len() + dirs.len() > 100_000 {
                return Err("too many files in one upload".into());
            }
        }
    } else {
        files.push((local.to_path_buf(), remote.to_string(), meta.len()));
    }
    Ok(())
}

async fn upload(sftp: &SftpSession, paths: &[String], remote_dir: &str, overwrite: bool, ch: &Channel<serde_json::Value>, cancel: &AtomicBool) -> Result<(usize, usize), String> {
    let mut files = Vec::new();
    let mut dirs = Vec::new();
    let mut skipped = 0;
    for p in paths {
        let local = PathBuf::from(p);
        let name = local.file_name().map(|n| n.to_string_lossy().into_owned()).ok_or("can't upload a drive root")?;
        plan_local(&local, &rjoin(remote_dir, &name), &mut files, &mut dirs, &mut skipped, 0)?;
    }
    let total = files.iter().map(|f| f.2).sum();
    let _ = ch.send(json!({ "t": "start", "total": total, "files": files.len() }));
    for d in &dirs {
        if !sftp.try_exists(d.as_str()).await.unwrap_or(false) {
            sftp.create_dir(d.as_str()).await.s()?;
        }
    }
    let mut progress = Progress { ch: ch.clone(), done: 0, total, last: Instant::now() };
    let mut buf = vec![0u8; 256 * 1024];
    let mut sent = 0;
    for (local, remote, size) in &files {
        if !overwrite && sftp.try_exists(remote.as_str()).await.unwrap_or(false) {
            skipped += 1;
            progress.add(*size, "");
            continue;
        }
        let name = local.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        let mut src = tokio::fs::File::open(local).await.s()?;
        let mut dst = sftp.create(remote.as_str()).await.s()?;
        loop {
            if cancel.load(Ordering::Relaxed) {
                // don't leave half a file on the server
                let _ = dst.shutdown().await;
                drop(dst);
                let _ = sftp.remove_file(remote.as_str()).await;
                return Err(CANCELLED.into());
            }
            let n = src.read(&mut buf).await.s()?;
            if n == 0 {
                break;
            }
            dst.write_all(&buf[..n]).await.s()?;
            progress.add(n as u64, &name);
        }
        dst.shutdown().await.s()?;
        sent += 1;
    }
    Ok((sent, skipped))
}
