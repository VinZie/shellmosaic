//! The Orchestrator: a lead Claude Code agent directs up to three worker agents, each a
//! real interactive Claude Code session in a Shellmosaic pane, working in its own git
//! worktree.
//!
//! Agents report to Shellmosaic through Claude Code's hooks and statusLine and act through
//! MCP tools, all relayed by the `shellmosaic-agent` shim over a named pipe (pipe.rs). The
//! state and its rules are in core.rs; this file connects them to the app: terminals
//! (PtyManager), the UI (events) and the commands the UI and the Orchestrator module use.

mod core;
mod launch;
mod mcp;
mod pipe;
mod procs;
pub mod proto;
mod roles;
mod startup;
mod tools;
mod transcript;
mod worktree;

use std::path::Path;
use std::sync::Arc;

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Listener, Manager};

pub use self::core::{Core, Host};
pub use self::launch::Launch;
use self::core::{Answer, Config};
use self::proto::{Activity, Agent, PaneRequest, Request, Routing, Run, Snapshot, Task};
use crate::paths::{blocking, Paths};
use crate::pty::PtyManager;

pub struct Agents {
    pub core: Arc<Core>,
}

struct TauriHost {
    app: AppHandle,
}

impl Host for TauriHost {
    fn spawn(&self, pane_id: &str, spec: &Launch) -> Result<Option<u32>, String> {
        self.app.state::<PtyManager>().spawn_agent(pane_id, spec)
    }
    fn write(&self, pane_id: &str, data: &str) -> Result<(), String> {
        self.app.state::<PtyManager>().write_to(pane_id, data)
    }
    fn kill(&self, pane_id: &str) {
        self.app.state::<PtyManager>().kill_session(pane_id, true);
    }
    fn running(&self, pane_id: &str) -> Option<u32> {
        self.app.state::<PtyManager>().running_pid(pane_id)
    }
    fn text(&self, pane_id: &str, max_bytes: usize) -> Option<String> {
        self.app.state::<PtyManager>().text_tail(pane_id, max_bytes)
    }
    fn screen(&self, pane_id: &str) -> Option<Vec<String>> {
        self.app.state::<PtyManager>().screen_lines(pane_id, 256 << 10)
    }
    fn changed(&self, rev: u64) {
        let _ = self.app.emit("agents://changed", rev);
    }
    fn panes(&self, req: PaneRequest) {
        let _ = self.app.emit("agents://pane", req);
    }
    fn attention(&self, req: &Request, agent_name: &str) {
        let _ = self.app.emit("agents://attention", json!({ "request": req, "agentName": agent_name }));
    }
    fn notice(&self, text: &str, kind: &str) {
        let _ = self.app.emit("agents://notice", json!({ "text": text, "kind": kind }));
    }
    fn repo_trusted(&self, root: &Path) -> Result<(), String> {
        crate::git::check_trusted(&self.app, root)
    }
}

/// Set up the Orchestrator: its state, the pipe (unless elevated), and exit reports.
pub fn init(app: &AppHandle, paths: &Paths) -> Agents {
    let elevated = crate::winutil::is_elevated();
    let pipe = format!(r"\\.\pipe\{}.orch.{}", app.config().identifier, uuid::Uuid::new_v4().simple());
    let shim = std::env::current_exe()
        .ok()
        .and_then(|e| e.parent().map(|d| d.join("shellmosaic-agent.exe")))
        .unwrap_or_default();
    let cfg = Config { dir: paths.root.join("orchestrator"), pipe: pipe.clone(), shim, elevated, home: app.path().home_dir().ok() };
    let rt = tauri::async_runtime::handle().inner().clone();
    let core = Core::new(cfg, Arc::new(TauriHost { app: app.clone() }), rt.clone());
    // (no pipe when elevated: no agent may start then)
    if !elevated {
        if let Err(e) = pipe::start(pipe, &rt, core.clone()) {
            eprintln!("[agents] {e}");
        }
    }
    let c = core.clone();
    app.listen_any("pty://exit", move |ev| {
        let Ok(v) = serde_json::from_str::<Value>(ev.payload()) else { return };
        let Some(pane) = v.get("paneId").and_then(Value::as_str) else { return };
        let pid = v.get("pid").and_then(Value::as_u64).map(|p| p as u32);
        let code = v.get("code").and_then(Value::as_u64).map(|c| c as u32);
        c.process_exited(pane, pid, code);
    });
    Agents { core }
}

fn core(app: &AppHandle) -> Arc<Core> {
    app.state::<Agents>().core.clone()
}

#[tauri::command]
pub fn agents_snapshot(app: AppHandle) -> Snapshot {
    core(&app).snapshot()
}

#[tauri::command]
pub fn agents_activity(app: AppHandle, run_id: Option<String>, after: Option<u64>, limit: Option<usize>, latest: Option<bool>) -> Vec<Activity> {
    core(&app).activity(run_id.as_deref(), after.unwrap_or(0), limit.unwrap_or(500).min(2000), latest.unwrap_or(false))
}

/// Start a team in a workspace, in the repository `cwd` is in.
#[tauri::command]
pub async fn agents_start(app: AppHandle, workspace_id: String, cwd: String, name: Option<String>) -> Result<Run, String> {
    let c = core(&app);
    blocking(move || c.start_run(&workspace_id, &cwd, name)).await?
}

/// Make `cwd` a git repository with everything in it committed (offered for plain folders).
#[tauri::command]
pub async fn agents_git_init(cwd: String) -> Result<(), String> {
    blocking(move || worktree::init(Path::new(&cwd))).await?
}

#[tauri::command]
pub fn agents_set_tab(app: AppHandle, run_id: String, tab_id: String) {
    core(&app).set_tab(&run_id, &tab_id);
}

#[tauri::command]
pub async fn agents_stop_run(app: AppHandle, run_id: String) -> Result<(), String> {
    let c = core(&app);
    blocking(move || c.stop_run(&run_id)).await?
}

#[tauri::command]
pub fn agents_forget_run(app: AppHandle, run_id: String) -> Result<(), String> {
    core(&app).forget_run(&run_id)
}

#[tauri::command]
pub async fn agents_hire(app: AppHandle, run_id: String, model: Option<String>) -> Result<Agent, String> {
    let c = core(&app);
    blocking(move || c.hire(&run_id, model.as_deref(), None, None)).await?
}

#[tauri::command]
pub async fn agents_remove(app: AppHandle, agent_id: String) -> Result<(), String> {
    let c = core(&app);
    blocking(move || c.remove_agent(&agent_id)).await?
}

/// Start a stopped agent again (continuing its conversation), or un-pause it.
#[tauri::command]
pub async fn agents_resume(app: AppHandle, agent_id: String) -> Result<(), String> {
    let c = core(&app);
    blocking(move || c.resume(&agent_id)).await?
}

#[tauri::command]
pub fn agents_interrupt(app: AppHandle, agent_id: String, pause: Option<bool>) -> Result<(), String> {
    core(&app).interrupt(&agent_id, pause.unwrap_or(false))
}

/// Type a message to an agent (the user's goal for the lead, a note for a worker).
#[tauri::command]
pub async fn agents_send(app: AppHandle, agent_id: String, text: String) -> Result<(), String> {
    core(&app).send(&agent_id, &text).await
}

/// Answer a request: `allow` for permission prompts (`always`: the agent may do the like for
/// the rest of its session), `text` for questions.
#[tauri::command]
pub fn agents_answer(app: AppHandle, request_id: String, allow: Option<bool>, always: Option<bool>, text: Option<String>) -> Result<(), String> {
    let answer = match (allow, text) {
        (Some(true), _) if always == Some(true) => Answer::AllowAlways,
        (Some(true), _) => Answer::Allow,
        (Some(false), t) => Answer::Deny(t.unwrap_or_default()),
        (None, Some(t)) => Answer::Text(t),
        (None, None) => return Err("Say allow or deny, or write an answer.".into()),
    };
    core(&app).answer(&request_id, answer, "you")
}

#[tauri::command]
pub fn agents_task_create(app: AppHandle, run_id: String, title: String, description: String, difficulty: u8, follow_up_of: Option<String>) -> Result<Task, String> {
    core(&app).create_task(&run_id, &title, &description, difficulty, follow_up_of.as_deref())
}

#[tauri::command]
pub async fn agents_task_assign(app: AppHandle, task_id: String, agent_id: Option<String>) -> Result<String, String> {
    let c = core(&app);
    blocking(move || c.assign(&task_id, agent_id.as_deref())).await?
}

#[tauri::command]
pub fn agents_task_cancel(app: AppHandle, task_id: String) -> Result<(), String> {
    core(&app).cancel_task(&task_id)
}

#[tauri::command]
pub async fn agents_task_diff(app: AppHandle, task_id: String) -> Result<Value, String> {
    let c = core(&app);
    blocking(move || c.task_diff(&task_id)).await?
}

#[tauri::command]
pub async fn agents_merge_preview(app: AppHandle, run_id: String) -> Result<Value, String> {
    let c = core(&app);
    blocking(move || c.merge_preview(&run_id)).await?
}

/// The user approved merging the team's integration branch into their own branch.
#[tauri::command]
pub async fn agents_merge_base(app: AppHandle, run_id: String) -> Result<String, String> {
    let c = core(&app);
    blocking(move || c.merge_to_base(&run_id)).await?
}

/// The Routing tab saved its table (`base`: the routing it was edited from).
#[tauri::command]
pub fn agents_set_routing(app: AppHandle, routing: Routing, base: Option<Routing>) -> Result<Routing, String> {
    core(&app).set_routing(routing, base)
}

#[tauri::command]
pub async fn agents_task_review(app: AppHandle, task_id: String, accept: bool, note: Option<String>) -> Result<String, String> {
    let c = core(&app);
    blocking(move || c.review(&task_id, accept, note.as_deref().unwrap_or(""))).await?
}
