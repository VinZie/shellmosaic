//! Read-mostly git integration using the git CLI (no libgit2 build dependency).
//!
//! The Git pane follows whatever folder the terminal is in, and a repository's own
//! config can make git run programs (filters, textconv, fsmonitor, gpg…) — a cloned
//! or extracted repo could run code just by being looked at. So before running
//! anything, a repo whose local config has such keys must be trusted by the user
//! ([`GitTrust`]); trust covers exactly the settings that were shown.

use std::collections::HashMap;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::Stdio;

use parking_lot::Mutex;
use serde::Serialize;
use tauri::{AppHandle, Manager};

use crate::paths::{hidden_command, write_atomic, ErrStr};

const GIT_MISSING: &str = "git is not available";
const UNTRUSTED: &str = "this repository's settings can run programs: trust it in the Git pane first";

fn git(cwd: &str, args: &[&str]) -> Result<String, String> {
    git_input(cwd, args, None)
}

/// Run git with `input` on stdin (long path lists go there instead of the command line).
fn git_input(cwd: &str, args: &[&str], input: Option<&[u8]>) -> Result<String, String> {
    if !Path::new(cwd).is_dir() {
        return Err("not a directory".into());
    }
    let mut child = hidden_command("git")
        // explicit: a bare repository hidden inside a cloned folder is never picked up on its own
        .args(["-c", "core.quotepath=off", "-c", "safe.bareRepository=explicit", "--no-optional-locks"])
        .args(args)
        .current_dir(cwd)
        .stdin(if input.is_some() { Stdio::piped() } else { Stdio::null() })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("{GIT_MISSING}: {e}"))?;
    if let (Some(data), Some(mut stdin)) = (input, child.stdin.take()) {
        let _ = stdin.write_all(data);
    }
    let out = child.wait_with_output().s()?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).into_owned())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
    }
}

/// Settings from the repository itself (local/worktree config, includes too) that
/// make git run a program, as "name = value".
fn repo_risks(cwd: &str) -> Vec<String> {
    let Ok(raw) = git(cwd, &["config", "--list", "--show-scope", "-z"]) else { return Vec::new() };
    // -z: scope \0 name \n value \0 …
    let mut out = Vec::new();
    let mut it = raw.split('\0');
    while let (Some(scope), Some(entry)) = (it.next(), it.next()) {
        if scope != "local" && scope != "worktree" {
            continue;
        }
        let (name, value) = entry.split_once('\n').unwrap_or((entry, ""));
        let n = name.to_ascii_lowercase();
        let last = n.rsplit('.').next().unwrap_or("");
        let off = matches!(value.trim().to_ascii_lowercase().as_str(), "false" | "0" | "no" | "off" | "");
        let risky = (n == "core.fsmonitor" && !off)
            || (n == "log.showsignature" && !off)
            || n == "diff.external"
            || n == "gpg.program"
            || (n.starts_with("gpg.") && last == "program")
            || (n.starts_with("filter.") && matches!(last, "clean" | "smudge" | "process"))
            || (n.starts_with("diff.") && matches!(last, "textconv" | "command"))
            // the Orchestrator merges agents' branches
            || (n.starts_with("merge.") && last == "driver");
        if risky {
            out.push(format!("{name} = {}", value.chars().take(200).collect::<String>()));
        }
    }
    out.sort();
    out.dedup();
    out
}

/// Repositories the user trusted, with the risky settings they saw at the time.
pub struct GitTrust {
    path: PathBuf,
    map: Mutex<HashMap<String, Vec<String>>>,
}

fn root_key(root: &str) -> String {
    root.trim().replace('\\', "/").trim_end_matches('/').to_lowercase()
}

impl GitTrust {
    pub fn load(path: PathBuf) -> Self {
        let map = std::fs::read(&path).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default();
        Self { path, map: Mutex::new(map) }
    }

    fn trusts(&self, root: &str, risks: &[String]) -> bool {
        risks.is_empty() || self.map.lock().get(&root_key(root)).is_some_and(|ok| risks.iter().all(|r| ok.contains(r)))
    }

    fn trust(&self, root: &str, risks: Vec<String>) -> Result<(), String> {
        let mut map = self.map.lock();
        map.insert(root_key(root), risks);
        write_atomic(&self.path, &serde_json::to_vec_pretty(&*map).s()?).s()
    }
}

/// The repository root, or an error if its settings can run programs and it isn't trusted.
fn checked_root(app: &AppHandle, cwd: &str) -> Result<String, String> {
    let root = git(cwd, &["rev-parse", "--show-toplevel"])?.trim().to_string();
    if app.state::<GitTrust>().trusts(&root, &repo_risks(cwd)) {
        Ok(root)
    } else {
        Err(UNTRUSTED.into())
    }
}

/// Shellmosaic may run git in the repository at `root` (the Orchestrator's worktrees and merges).
pub(crate) fn check_trusted(app: &AppHandle, root: &Path) -> Result<(), String> {
    let root = root.to_string_lossy();
    if app.state::<GitTrust>().trusts(&root, &repo_risks(&root)) {
        Ok(())
    } else {
        Err(format!("{UNTRUSTED} (open a Git pane in {root})"))
    }
}

/// Trust the repository at `cwd` with the risky settings it has right now.
#[tauri::command]
pub async fn git_trust(app: AppHandle, cwd: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = git(&cwd, &["rev-parse", "--show-toplevel"])?;
        app.state::<GitTrust>().trust(&root, repo_risks(&cwd))
    })
    .await
    .s()?
}

/// Cut to at most `max` bytes without splitting a UTF-8 character.
fn truncate_utf8(s: &mut String, max: usize) -> bool {
    if s.len() <= max {
        return false;
    }
    let mut cut = max;
    while !s.is_char_boundary(cut) {
        cut -= 1;
    }
    s.truncate(cut);
    true
}

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct FileStatus {
    path: String,
    index: char,
    worktree: char,
    kind: &'static str,
}

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    is_repo: bool,
    root: String,
    branch: String,
    upstream: Option<String>,
    ahead: i64,
    behind: i64,
    files: Vec<FileStatus>,
    /// set (and nothing else read) when the repo's own settings can run programs and it isn't trusted
    untrusted: Vec<String>,
}

#[tauri::command]
pub async fn git_status(app: AppHandle, cwd: String) -> Result<Status, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = match git(&cwd, &["rev-parse", "--show-toplevel"]) {
            Ok(root) => root.trim().to_string(),
            // missing git or a safe.directory refusal is not "not a repository": show the reason
            Err(e) if e.starts_with(GIT_MISSING) || e.contains("safe.directory") => return Err(e),
            Err(_) => return Ok(Status::default()),
        };
        let risks = repo_risks(&cwd);
        if !app.state::<GitTrust>().trusts(&root, &risks) {
            return Ok(Status { is_repo: true, root, untrusted: risks, ..Default::default() });
        }
        let raw = git(&cwd, &["status", "--porcelain=v2", "--branch", "-z"])?;
        let mut st = Status { is_repo: true, root, ..Default::default() };
        let mut fields = raw.split('\0');
        while let Some(entry) = fields.next() {
            if let Some(h) = entry.strip_prefix("# branch.head ") {
                st.branch = h.to_string();
            } else if let Some(u) = entry.strip_prefix("# branch.upstream ") {
                st.upstream = Some(u.to_string());
            } else if let Some(ab) = entry.strip_prefix("# branch.ab ") {
                let mut it = ab.split_whitespace();
                st.ahead = it.next().and_then(|a| a.trim_start_matches('+').parse().ok()).unwrap_or(0);
                st.behind = it.next().and_then(|b| b.trim_start_matches('-').parse().ok()).unwrap_or(0);
            } else if entry.starts_with("1 ") || entry.starts_with("2 ") || entry.starts_with("u ") {
                let n = match entry.as_bytes()[0] {
                    b'1' => 9,
                    b'2' => 10,
                    _ => 11,
                };
                let parts: Vec<&str> = entry.splitn(n, ' ').collect();
                let xy: Vec<char> = parts.get(1).unwrap_or(&"..").chars().collect();
                st.files.push(FileStatus {
                    path: parts.last().unwrap_or(&"").to_string(),
                    index: xy.first().copied().unwrap_or('.'),
                    worktree: xy.get(1).copied().unwrap_or('.'),
                    kind: match entry.as_bytes()[0] {
                        b'2' => "renamed",
                        b'u' => "conflict",
                        _ => "changed",
                    },
                });
                if entry.starts_with("2 ") {
                    fields.next(); // original path of the rename
                }
            } else if let Some(p) = entry.strip_prefix("? ") {
                st.files.push(FileStatus { path: p.to_string(), index: '?', worktree: '?', kind: "untracked" });
            }
        }
        Ok(st)
    })
    .await
    .s()?
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Commit {
    hash: String,
    short: String,
    author: String,
    when: String,
    subject: String,
    refs: String,
}

#[tauri::command]
pub async fn git_log(app: AppHandle, cwd: String, limit: Option<u32>) -> Result<Vec<Commit>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        checked_root(&app, &cwd)?;
        let n = format!("-n{}", limit.unwrap_or(30).min(500));
        let raw = git(&cwd, &["log", &n, "--pretty=format:%H%x1f%h%x1f%an%x1f%ar%x1f%s%x1f%D%x1e"])?;
        Ok(raw
            .split('\x1e')
            .filter(|r| !r.trim().is_empty())
            .map(|r| {
                let f: Vec<&str> = r.trim_start_matches('\n').split('\x1f').collect();
                let g = |i: usize| f.get(i).unwrap_or(&"").to_string();
                Commit { hash: g(0), short: g(1), author: g(2), when: g(3), subject: g(4), refs: g(5) }
            })
            .collect())
    })
    .await
    .s()?
}

/// Original path of each staged rename, keyed by its new path. Status only reports the
/// new path, but diffing or unstaging a rename needs both sides.
fn staged_renames(cwd: &str) -> HashMap<String, String> {
    let mut out = HashMap::new();
    let Ok(raw) = git(cwd, &["diff", "--cached", "--name-status", "-M", "-z", "--no-color", "--no-ext-diff"]) else {
        return out;
    };
    // -z: STATUS \0 path \0 (and a second path for R/C)
    let mut it = raw.split('\0');
    while let Some(status) = it.next() {
        if status.starts_with('R') || status.starts_with('C') {
            let (Some(from), Some(to)) = (it.next(), it.next()) else { break };
            if status.starts_with('R') {
                out.insert(to.to_string(), from.to_string());
            }
        } else if !status.is_empty() {
            it.next();
        }
    }
    out
}

#[tauri::command]
pub async fn git_diff(app: AppHandle, cwd: String, path: Option<String>, staged: Option<bool>, commit: Option<String>) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        checked_root(&app, &cwd)?;
        let staged = staged.unwrap_or(false) && commit.is_none();
        let renamed_from = match &path {
            Some(p) if staged => staged_renames(&cwd).remove(p),
            _ => None,
        };
        let mut args: Vec<String> = Vec::new();
        if let Some(c) = commit {
            if !c.chars().all(|ch| ch.is_ascii_hexdigit()) {
                return Err("invalid commit".into());
            }
            args.extend(["show".into(), "--stat".into(), "--patch".into(), "--no-color".into(), "--no-ext-diff".into(), c]);
        } else {
            // a user's color.ui=always or diff.external would otherwise leak into the pane's output
            args.extend(["diff".into(), "--no-color".into(), "--no-ext-diff".into()]);
            if staged {
                args.push("--cached".into());
            }
        }
        if let Some(p) = path {
            args.push("--".into());
            args.push(p);
            // with both sides in the pathspec git shows the rename, not a whole new file
            args.extend(renamed_from);
        }
        let refs: Vec<&str> = args.iter().map(String::as_str).collect();
        let mut out = git(&cwd, &refs)?;
        if truncate_utf8(&mut out, 2 * 1024 * 1024) {
            out.push_str("\n… (diff truncated)");
        }
        Ok(out)
    })
    .await
    .s()?
}

/// Stage / unstage / discard / branch listing — local, non-interactive operations only.
/// Anything that may need credentials (fetch/pull/push) runs in a terminal instead.
#[tauri::command]
pub async fn git_op(app: AppHandle, cwd: String, op: String, paths: Option<Vec<String>>) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        checked_root(&app, &cwd)?;
        let mut paths = paths.unwrap_or_default();
        if op == "unstage" {
            // unstaging only a rename's new path would leave its old path's deletion staged
            let renames = staged_renames(&cwd);
            let from: Vec<String> = paths.iter().filter_map(|p| renames.get(p).cloned()).collect();
            paths.extend(from);
        }
        // before the first commit there's no HEAD to restore the index from
        let unborn = || git(&cwd, &["rev-parse", "--verify", "-q", "HEAD"]).is_err();
        let mut args: Vec<&str> = match op.as_str() {
            "stage" => vec!["add"],
            "unstage" if unborn() => vec!["rm", "--cached", "-r", "-q"],
            "unstage" => vec!["restore", "--staged"],
            "stage-all" => vec!["add", "-A"],
            "unstage-all" => vec!["reset", "-q"],
            "branches" => vec!["branch", "--format=%(refname:short)"],
            _ => return Err(format!("unsupported git operation: {op}")),
        };
        let mut input = None;
        if matches!(op.as_str(), "stage" | "unstage") {
            if paths.is_empty() {
                return Err("no paths given".into());
            }
            // Windows caps a command line at 32K characters; big selections go over stdin
            if paths.iter().map(|p| p.len() + 3).sum::<usize>() > 24_000 {
                args.extend(["--pathspec-from-file=-", "--pathspec-file-nul"]);
                input = Some(paths.join("\0").into_bytes());
            } else {
                args.push("--");
                args.extend(paths.iter().map(String::as_str));
            }
        }
        git_input(&cwd, &args, input.as_deref())
    })
    .await
    .s()?
}
