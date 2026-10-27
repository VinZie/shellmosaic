//! The Orchestrator's state and everything that changes it: runs, agents and their
//! Claude Code processes, tasks and how they reach a worker, requests, the activity log,
//! and what the agents' hooks, statusLines and tools report.
//!
//! The UI owns the pane layout and the terminals live in the PtyManager; both sit behind
//! [`Host`], so nothing here depends on Tauri.

use std::collections::{HashMap, HashSet, VecDeque};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Weak};
use std::time::Duration;

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::sync::{oneshot, Notify};

use super::launch::{self, Launch};
use super::mcp::{BoxFut, CallCtx, ToolHost, ToolOutput};
use super::pipe::Gate;
use super::proto::*;
use super::{procs, roles, startup, tools, worktree};
use crate::paths::write_atomic;

pub const MAX_WORKERS: usize = 3;
const MAX_ACTIVITY: usize = 2000;
/// A paused agent's process is ended after this long (Resume continues from its transcript).
const PAUSE_KILL: Duration = Duration::from_secs(30 * 60);
/// How long a worker's `ask_lead` waits for an answer.
const QUESTION_WAIT: Duration = Duration::from_secs(20 * 60);
/// Lead events are batched this long before they're typed into an idle lead's pane.
const NUDGE_DELAY: Duration = Duration::from_millis(2500);
/// An agent still starting after this long may be stuck on a screen in its pane: the user hears about it.
const SLOW_START: Duration = Duration::from_secs(20);
/// How long a starting agent's pane is watched for Claude Code's trust prompt.
const START_WATCH: Duration = Duration::from_secs(10 * 60);
/// The `tool` of the request that stands for Claude Code's folder trust prompt.
pub const TRUST_TOOL: &str = "Trust";

/// What the Orchestrator needs from the app.
pub trait Host: Send + Sync + 'static {
    /// Start a detached terminal session for `pane_id`; returns its process id.
    fn spawn(&self, pane_id: &str, spec: &Launch) -> Result<Option<u32>, String>;
    fn write(&self, pane_id: &str, data: &str) -> Result<(), String>;
    /// End the session (its process tree is ended separately).
    fn kill(&self, pane_id: &str);
    /// The session's process id while it runs.
    fn running(&self, pane_id: &str) -> Option<u32>;
    /// The session's recent output as plain text.
    fn text(&self, pane_id: &str, max_bytes: usize) -> Option<String>;
    /// The session's screen as it is now, line by line.
    fn screen(&self, pane_id: &str) -> Option<Vec<String>>;
    /// Something changed (the UI re-reads the snapshot).
    fn changed(&self, rev: u64);
    fn panes(&self, req: PaneRequest);
    /// A request needs the user (a permission prompt, or a question nobody answered).
    fn attention(&self, req: &Request, agent_name: &str);
    /// A notice for the user (`notify_user`, a run that couldn't continue…).
    fn notice(&self, text: &str, kind: &str);
    /// Shellmosaic may run git in this repository (its settings can't run programs, or it's trusted).
    fn repo_trusted(&self, root: &Path) -> Result<(), String>;
}

pub struct Config {
    /// `<app data>\orchestrator`
    pub dir: PathBuf,
    pub pipe: String,
    /// shellmosaic-agent.exe
    pub shim: PathBuf,
    pub elevated: bool,
    pub home: Option<PathBuf>,
}

/// An answer to a permission request or a question.
#[derive(Debug)]
pub enum Answer {
    Allow,
    /// allow, and let the agent do the like for the rest of its session (Claude Code's suggestions)
    AllowAlways,
    Deny(String),
    Text(String),
}

#[derive(Default)]
struct Signals {
    /// UserPromptSubmit: typed text was accepted
    prompt: Notify,
    /// SessionStart: a session is ready (startup, resume, `/clear`)
    session: Notify,
    /// one typed message at a time
    typing: tokio::sync::Mutex<()>,
}

#[derive(Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
struct Saved {
    seq: u64,
    next_task: u32,
    next_req: u32,
    runs: Vec<Run>,
    agents: Vec<Agent>,
    tasks: Vec<Task>,
    requests: Vec<Request>,
    routing: Option<Routing>,
}

#[derive(Default)]
struct State {
    rev: u64,
    seq: u64,
    next_task: u32,
    next_req: u32,
    runs: Vec<Run>,
    agents: Vec<Agent>,
    tasks: Vec<Task>,
    requests: Vec<Request>,
    routing: Routing,
    activity: VecDeque<Activity>,
    /// activity lines not written to activity.jsonl yet
    unsaved: Vec<String>,
    /// agent → its launch's secret (memory only: a restarted Shellmosaic relaunches with new ones)
    tokens: HashMap<String, String>,
    /// agent → (pid, creation time) of its Claude Code process
    procs: HashMap<String, (u32, u64)>,
    /// run → the last activity seq its lead has seen
    lead_seen: HashMap<String, u64>,
    usage: Option<Value>,
    dirty: bool,
    /// runs whose lead got new events in this edit (see `Core::edit`)
    lead_news: HashSet<String>,
}

impl State {
    fn agent(&self, id: &str) -> Option<&Agent> {
        self.agents.iter().find(|a| a.id == id)
    }
    fn agent_mut(&mut self, id: &str) -> Option<&mut Agent> {
        self.agents.iter_mut().find(|a| a.id == id)
    }
    fn run(&self, id: &str) -> Option<&Run> {
        self.runs.iter().find(|r| r.id == id)
    }
    fn task(&self, id: &str) -> Option<&Task> {
        self.tasks.iter().find(|t| t.id == id)
    }
    fn task_mut(&mut self, id: &str) -> Option<&mut Task> {
        self.tasks.iter_mut().find(|t| t.id == id)
    }
    fn workers(&self, run: &str) -> impl Iterator<Item = &Agent> {
        let run = run.to_string();
        self.agents.iter().filter(move |a| a.run_id == run && a.role == Role::Worker)
    }

    /// The larger of the 5-hour and weekly plan usage (%), as last reported by a statusLine.
    fn usage_pct(&self) -> Option<f64> {
        let l = self.usage.as_ref()?.get("rateLimits")?;
        let pct = |k: &str| l.get(k).and_then(|w| w.get("used_percentage")).and_then(Value::as_f64);
        match (pct("five_hour"), pct("seven_day")) {
            (None, None) => None,
            (a, b) => Some(a.unwrap_or(0.0).max(b.unwrap_or(0.0))),
        }
    }

    /// Model and effort for a task, after the usage gate. The note says why it was changed.
    fn route(&self, difficulty: u8) -> (ModelChoice, Option<String>) {
        let mut c = self.routing.level(difficulty).clone();
        if let Some(p) = self.usage_pct() {
            if is_opus(&c.model) && p >= self.routing.sonnet_above as f64 {
                c.model = "sonnet".into();
                return (c, Some(format!("plan usage is at {p:.0}%")));
            }
        }
        (c, None)
    }

    /// Whether another worker may start (team size, plan usage).
    fn may_hire(&self, run: &str) -> Result<(), String> {
        let n = self.workers(run).count();
        let max = self.routing.max_workers as usize;
        if n >= max {
            return Err(format!("The team is full ({max} workers). Dismiss one or wait for one to finish."));
        }
        if let Some(p) = self.usage_pct() {
            if p >= self.routing.no_hire_above as f64 {
                return Err(format!("Plan usage is at {p:.0}%: no new workers start above {}%. Reuse an idle worker.", self.routing.no_hire_above));
            }
        }
        Ok(())
    }

    fn log(&mut self, run: &str, agent: Option<&str>, task: Option<&str>, kind: &str, text: String, lead: bool) {
        self.seq += 1;
        let a = Activity {
            seq: self.seq,
            t: now_ms(),
            run_id: run.into(),
            agent_id: agent.map(str::to_string),
            task_id: task.map(str::to_string),
            kind: kind.into(),
            text,
            lead,
        };
        if let Ok(line) = serde_json::to_string(&a) {
            self.unsaved.push(line);
        }
        if lead {
            self.lead_news.insert(run.to_string());
        }
        self.activity.push_back(a);
        while self.activity.len() > MAX_ACTIVITY {
            self.activity.pop_front();
        }
    }
}

fn set_state(a: &mut Agent, s: AgentState) {
    if a.state != s {
        a.state = s;
        a.state_since = now_ms();
    }
}

pub fn now_ms() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

fn hex(n: usize) -> String {
    let mut s = String::new();
    while s.len() < n {
        s.push_str(&uuid::Uuid::new_v4().simple().to_string());
    }
    s.truncate(n);
    s
}

fn short(text: &str, max: usize) -> String {
    let t = text.trim();
    if t.chars().count() <= max {
        return t.to_string();
    }
    let mut s: String = t.chars().take(max).collect();
    s.push('…');
    s
}

/// Text that is safe to paste into an agent's input: no escape sequences (they could end
/// the bracketed paste early) and no other control characters.
fn paste_safe(text: &str) -> String {
    text.replace("\r\n", "\n")
        .chars()
        .filter(|&c| c == '\n' || c == '\t' || !c.is_control())
        .collect::<String>()
        .trim_end()
        .to_string()
}

/// One line saying what a tool call wants to do.
pub fn describe_tool(tool: &str, input: &Value) -> String {
    let s = |k: &str| input.get(k).and_then(Value::as_str).unwrap_or("").to_string();
    match tool {
        "Bash" | "PowerShell" => format!("run `{}`", short(&s("command"), 300)),
        "Write" => format!("create {}", s("file_path")),
        "Edit" | "MultiEdit" | "NotebookEdit" => format!("edit {}", if s("file_path").is_empty() { s("notebook_path") } else { s("file_path") }),
        "Read" => format!("read {}", s("file_path")),
        "WebFetch" => format!("fetch {}", s("url")),
        "WebSearch" => format!("search the web for \"{}\"", short(&s("query"), 120)),
        t if t.starts_with("mcp__") => format!("use {}", t.trim_start_matches("mcp__").replace("__", " → ")),
        t => format!("use {t}"),
    }
}

/// A JSON value with long strings shortened (request details, kept in state.json).
fn trimmed(v: &Value, max: usize) -> Value {
    match v {
        Value::String(s) => Value::String(short(s, max)),
        Value::Array(a) => Value::Array(a.iter().take(50).map(|x| trimmed(x, max)).collect()),
        Value::Object(o) => Value::Object(o.iter().take(50).map(|(k, x)| (k.clone(), trimmed(x, max))).collect()),
        x => x.clone(),
    }
}

fn is_opus(model: &str) -> bool {
    model.to_ascii_lowercase().contains("opus")
}

pub struct Core {
    cfg: Config,
    host: Arc<dyn Host>,
    rt: tokio::runtime::Handle,
    me: Weak<Core>,
    st: Mutex<State>,
    /// activity was added (the lead's `wait` and the nudges)
    wake: Notify,
    /// request id → the hook or tool call waiting for its answer
    answers: Mutex<HashMap<String, oneshot::Sender<Answer>>>,
    signals: Mutex<HashMap<String, Arc<Signals>>>,
    notify_scheduled: AtomicBool,
    save_scheduled: AtomicBool,
    /// runs with a team update scheduled for their lead
    nudging: Mutex<HashSet<String>>,
    /// one assignment at a time: two at once could pick the same idle worker
    assigning: Mutex<()>,
    /// one new worker at a time: two at once could pick the same slot
    hiring: Mutex<()>,
}

impl Core {
    pub fn new(cfg: Config, host: Arc<dyn Host>, rt: tokio::runtime::Handle) -> Arc<Self> {
        let _ = std::fs::create_dir_all(&cfg.dir);
        let st = Self::load(&cfg.dir);
        Arc::new_cyclic(|me| Self {
            cfg,
            host,
            rt,
            me: me.clone(),
            st: Mutex::new(st),
            wake: Notify::new(),
            answers: Mutex::default(),
            signals: Mutex::default(),
            notify_scheduled: AtomicBool::new(false),
            save_scheduled: AtomicBool::new(false),
            nudging: Mutex::default(),
            assigning: Mutex::new(()),
            hiring: Mutex::new(()),
        })
    }

    fn arc(&self) -> Arc<Self> {
        self.me.upgrade().expect("core alive")
    }

    /// state.json from the last run. No agent process survives a restart: they're stopped
    /// until the user resumes them, and nothing is waiting for the open requests any more.
    fn load(dir: &Path) -> State {
        let saved: Saved = std::fs::read(dir.join("state.json")).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default();
        let mut st = State {
            seq: saved.seq,
            next_task: saved.next_task,
            next_req: saved.next_req,
            runs: saved.runs,
            agents: saved.agents,
            tasks: saved.tasks,
            requests: saved.requests,
            routing: saved.routing.unwrap_or_default().sanitized(),
            ..Default::default()
        };
        for a in &mut st.agents {
            if a.state.live() {
                set_state(a, AgentState::Stopped);
            }
            a.pid = None;
        }
        for r in &mut st.requests {
            if r.status == RequestStatus::Pending {
                r.status = RequestStatus::Closed;
                r.answered_by = Some("restart".into());
            }
        }
        if let Ok(text) = std::fs::read_to_string(dir.join("activity.jsonl")) {
            let lines: Vec<&str> = text.lines().collect();
            for line in &lines[lines.len().saturating_sub(MAX_ACTIVITY)..] {
                if let Ok(a) = serde_json::from_str::<Activity>(line) {
                    st.activity.push_back(a);
                }
            }
        }
        // the lead has seen everything from before the restart
        for r in &st.runs {
            st.lead_seen.insert(r.id.clone(), st.seq);
        }
        st
    }

    // ── bookkeeping ─────────────────────────────────────────────────────────

    /// Change the state; the UI hears about it and it's saved shortly after. An idle lead
    /// whose team has news gets a team update.
    fn edit<R>(&self, f: impl FnOnce(&mut State) -> R) -> R {
        let (r, news) = {
            let mut st = self.st.lock();
            let r = f(&mut st);
            st.rev += 1;
            st.dirty = true;
            (r, std::mem::take(&mut st.lead_news))
        };
        self.wake.notify_waiters();
        self.schedule();
        for run in news {
            self.maybe_nudge(&run);
        }
        r
    }

    fn schedule(&self) {
        if !self.notify_scheduled.swap(true, Ordering::AcqRel) {
            let me = self.arc();
            self.rt.spawn(async move {
                tokio::time::sleep(Duration::from_millis(60)).await;
                me.notify_scheduled.store(false, Ordering::Release);
                let rev = me.st.lock().rev;
                me.host.changed(rev);
            });
        }
        if !self.save_scheduled.swap(true, Ordering::AcqRel) {
            let me = self.arc();
            self.rt.spawn(async move {
                tokio::time::sleep(Duration::from_millis(400)).await;
                me.save_scheduled.store(false, Ordering::Release);
                let _ = tokio::task::spawn_blocking(move || me.save()).await;
            });
        }
    }

    /// Write state.json and the new activity lines (also called at exit).
    pub fn save(&self) {
        let (data, lines) = {
            let mut st = self.st.lock();
            if !st.dirty && st.unsaved.is_empty() {
                return;
            }
            st.dirty = false;
            let saved = Saved {
                seq: st.seq,
                next_task: st.next_task,
                next_req: st.next_req,
                runs: st.runs.clone(),
                agents: st.agents.clone(),
                tasks: st.tasks.clone(),
                requests: st.requests.clone(),
                routing: Some(st.routing.clone()),
            };
            (serde_json::to_vec_pretty(&saved).unwrap_or_default(), std::mem::take(&mut st.unsaved))
        };
        if write_atomic(&self.cfg.dir.join("state.json"), &data).is_err() {
            self.st.lock().dirty = true;
        }
        if !lines.is_empty() {
            let path = self.cfg.dir.join("activity.jsonl");
            // keep the log bounded: one old generation
            if std::fs::metadata(&path).is_ok_and(|m| m.len() > 8 << 20) {
                let _ = std::fs::rename(&path, self.cfg.dir.join("activity.1.jsonl"));
            }
            if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&path) {
                let _ = f.write_all((lines.join("\n") + "\n").as_bytes());
            }
        }
    }

    fn signals(&self, agent: &str) -> Arc<Signals> {
        self.signals.lock().entry(agent.to_string()).or_default().clone()
    }

    pub fn snapshot(&self) -> Snapshot {
        let st = self.st.lock();
        Snapshot {
            rev: st.rev,
            last_seq: st.seq,
            runs: st.runs.clone(),
            agents: st.agents.clone(),
            tasks: st.tasks.clone(),
            requests: st.requests.clone(),
            usage: st.usage.clone(),
            routing: st.routing.clone(),
            elevated: self.cfg.elevated,
        }
    }

    /// New routing; applies to tasks assigned from now on. `base`: the routing the change
    /// was made on (another window or the lead may have changed it meanwhile).
    pub fn set_routing(&self, routing: Routing, base: Option<Routing>) -> Result<Routing, String> {
        let routing = routing.sanitized();
        self.edit(|st| {
            if base.is_some_and(|b| b.sanitized() != st.routing) {
                return Err("The routing changed meanwhile; look at it again.".to_string());
            }
            st.routing = routing.clone();
            Ok(routing)
        })
    }

    /// Activity after `after`, oldest first, at most `limit`, optionally one run's. `latest`:
    /// the newest `limit` of those instead of the oldest (a pane catching up).
    pub fn activity(&self, run: Option<&str>, after: u64, limit: usize, latest: bool) -> Vec<Activity> {
        let st = self.st.lock();
        let hits = st.activity.iter().filter(|a| a.seq > after && run.is_none_or(|r| a.run_id == r));
        if latest {
            let mut v: Vec<Activity> = hits.rev().take(limit).cloned().collect();
            v.reverse();
            v
        } else {
            hits.take(limit).cloned().collect()
        }
    }

    fn agent(&self, id: &str) -> Result<Agent, String> {
        self.st.lock().agent(id).cloned().ok_or_else(|| "There's no such agent.".to_string())
    }

    /// An agent by id, slot ("w1") or name, within a run.
    pub fn find_agent(&self, run: &str, key: &str) -> Result<Agent, String> {
        let st = self.st.lock();
        let k = key.trim();
        st.agents
            .iter()
            .find(|a| a.run_id == run && (a.id == k || a.slot.eq_ignore_ascii_case(k) || a.name.eq_ignore_ascii_case(k)))
            .cloned()
            .ok_or_else(|| format!("There's no agent \"{k}\" in this run."))
    }

    pub fn agent_by_pane(&self, pane: &str) -> Option<Agent> {
        self.st.lock().agents.iter().find(|a| a.pane_id == pane).cloned()
    }

    fn run(&self, id: &str) -> Result<Run, String> {
        self.st.lock().run(id).cloned().ok_or_else(|| "There's no such run.".to_string())
    }

    fn task(&self, id: &str) -> Result<Task, String> {
        self.st.lock().task(id.trim()).cloned().ok_or_else(|| format!("There's no task \"{}\".", id.trim()))
    }

    // ── runs ────────────────────────────────────────────────────────────────

    /// Start a run in a workspace: the lead's session in a new pane, working in the repository at `cwd`.
    pub fn start_run(&self, workspace: &str, cwd: &str, name: Option<String>) -> Result<Run, String> {
        if self.cfg.elevated {
            return Err("Shellmosaic runs as administrator, and its agents would too. Restart Shellmosaic normally to use the Orchestrator.".into());
        }
        if let Some(r) = self.st.lock().runs.iter().find(|r| r.workspace_id == workspace && r.status == RunStatus::Active) {
            return Err(format!("This workspace already has a running team ({}).", r.name));
        }
        let repo = worktree::repo(Path::new(cwd))?;
        self.host.repo_trusted(&repo.root)?;
        worktree::ensure_integration(&repo.root)?;
        let root = repo.root.to_string_lossy().into_owned();
        let run_id = hex(6);
        let lead_id = hex(8);
        let name = name.filter(|n| !n.trim().is_empty()).unwrap_or_else(|| {
            repo.root.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| "Team".into())
        });
        let now = now_ms();
        let lead_model = self.st.lock().routing.lead.clone();
        let run = Run {
            id: run_id.clone(),
            name,
            workspace_id: workspace.into(),
            tab_id: None,
            root: root.clone(),
            base_branch: repo.branch,
            status: RunStatus::Active,
            lead_id: lead_id.clone(),
            created_at: now,
        };
        let lead = Agent {
            id: lead_id.clone(),
            run_id: run_id.clone(),
            role: Role::Lead,
            slot: "lead".into(),
            name: "Lead".into(),
            pane_id: hex(12),
            model: lead_model.model,
            model_id: None,
            effort: lead_model.effort,
            session_id: uuid::Uuid::new_v4().to_string(),
            transcript: None,
            state: AgentState::Starting,
            state_since: now,
            task_id: None,
            last_task_id: None,
            used: false,
            cwd: root,
            branch: None,
            context_pct: None,
            cost_usd: None,
            pid: None,
            last_message: None,
            created_at: now,
        };
        self.edit(|st| {
            st.runs.push(run.clone());
            st.agents.push(lead.clone());
            st.lead_seen.insert(run_id.clone(), st.seq);
            st.log(&run_id, Some(&lead_id), None, "run.start", format!("Started the team in {}", run.root), false);
        });
        if let Err(e) = self.launch(&lead_id) {
            self.edit(|st| {
                st.runs.retain(|r| r.id != run_id);
                st.agents.retain(|a| a.id != lead_id);
            });
            return Err(e);
        }
        self.add_pane(&lead_id);
        Ok(run)
    }

    /// The UI made (or found) the run's tab.
    pub fn set_tab(&self, run: &str, tab: &str) {
        self.edit(|st| {
            if let Some(r) = st.runs.iter_mut().find(|r| r.id == run) {
                r.tab_id = Some(tab.to_string());
            }
        });
    }

    fn add_pane(&self, agent: &str) {
        let (a, r) = {
            let st = self.st.lock();
            let Some(a) = st.agent(agent).cloned() else { return };
            let Some(r) = st.run(&a.run_id).cloned() else { return };
            (a, r)
        };
        self.host.panes(PaneRequest::Add {
            run_id: r.id,
            workspace_id: r.workspace_id,
            tab_id: r.tab_id,
            pane_id: a.pane_id,
            agent_id: a.id,
            title: a.name,
        });
    }

    /// Stop every agent of a run and close their panes. Worktrees with unmerged work stay.
    pub fn stop_run(&self, run: &str) -> Result<(), String> {
        let r = self.run(run)?;
        let agents: Vec<Agent> = self.st.lock().agents.iter().filter(|a| a.run_id == run).cloned().collect();
        for a in &agents {
            self.end_process(a);
        }
        let closed: Vec<String> = self.edit(|st| {
            if let Some(r) = st.runs.iter_mut().find(|r| r.id == run) {
                r.status = RunStatus::Stopped;
            }
            let mut closed = Vec::new();
            for q in st.requests.iter_mut().filter(|q| q.run_id == run && q.status == RequestStatus::Pending) {
                q.status = RequestStatus::Closed;
                q.answered_by = Some("stopped".into());
                closed.push(q.id.clone());
            }
            for t in st.tasks.iter_mut().filter(|t| t.run_id == run && matches!(t.status, TaskStatus::Assigned | TaskStatus::Working)) {
                t.status = TaskStatus::Queued;
                t.assignee = None;
            }
            st.log(run, None, None, "run.stop", "Stopped the team".into(), false);
            closed
        });
        for id in closed {
            self.answers.lock().remove(&id);
        }
        for a in &agents {
            self.host.panes(PaneRequest::Remove { pane_id: a.pane_id.clone() });
        }
        let root = PathBuf::from(&r.root);
        let slots: Vec<(String, Vec<String>)> = agents.iter().filter(|a| a.role == Role::Worker).map(|a| (a.slot.clone(), self.branches_of(&a.id))).collect();
        self.rt.spawn_blocking(move || {
            for (slot, branches) in slots {
                if worktree::all_merged(&root, &branches) {
                    let _ = worktree::remove_slot(&root, &slot);
                }
            }
        });
        Ok(())
    }

    /// Forget a stopped run (its branches and unmerged worktrees stay in the repository).
    pub fn forget_run(&self, run: &str) -> Result<(), String> {
        let r = self.run(run)?;
        if r.status == RunStatus::Active {
            return Err("Stop the team first.".into());
        }
        let gone: Vec<String> = self.edit(|st| {
            let gone = st.agents.iter().filter(|a| a.run_id == run).map(|a| a.id.clone()).collect();
            st.runs.retain(|x| x.id != run);
            st.agents.retain(|a| a.run_id != run);
            st.tasks.retain(|t| t.run_id != run);
            st.requests.retain(|q| q.run_id != run);
            gone
        });
        for id in gone {
            self.forget_files(&id);
        }
        Ok(())
    }

    /// An agent's generated files (settings, MCP config, role prompt).
    fn forget_files(&self, agent_id: &str) {
        let _ = std::fs::remove_dir_all(self.cfg.dir.join("agents").join(agent_id));
    }

    // ── processes ───────────────────────────────────────────────────────────

    /// Start the agent's Claude Code in its pane's terminal (continuing its session when it has one).
    fn launch(&self, agent_id: &str) -> Result<(), String> {
        if self.cfg.elevated {
            return Err("Shellmosaic runs as administrator; agents won't start.".into());
        }
        if !self.cfg.shim.is_file() {
            return Err(format!("{} is missing; reinstall Shellmosaic.", self.cfg.shim.display()));
        }
        let (agent, run) = {
            let st = self.st.lock();
            let a = st.agent(agent_id).cloned().ok_or("There's no such agent.")?;
            let r = st.run(&a.run_id).cloned().ok_or("There's no such run.")?;
            (a, r)
        };
        if self.host.running(&agent.pane_id).is_some() {
            return Ok(());
        }
        let base = crate::env::fresh_environment().unwrap_or_else(|| std::env::vars().collect());
        let claude = launch::find_claude(&base, self.cfg.home.as_deref())?;
        let role = match agent.role {
            Role::Lead => roles::lead(&run, self.st.lock().routing.max_workers as usize),
            Role::Worker => roles::worker(&run, &agent),
        };
        let files = launch::write_files(&self.cfg.dir.join("agents").join(&agent.id), &self.cfg.shim, &role)?;
        let resume = agent.transcript.as_deref().is_some_and(|t| Path::new(t).is_file());
        let token = hex(64);
        let target = (agent.role == Role::Worker).then(|| worktree::base(Path::new(&run.root)).join("_target").join(&agent.slot));
        let spec = Launch {
            program: claude,
            args: launch::args(&agent, &files, resume),
            env: launch::env(base, &agent, &self.cfg.pipe, &token, target.as_deref()),
            cwd: agent.cwd.clone(),
            cols: 120,
            rows: 36,
        };
        // known before the process can call in
        self.st.lock().tokens.insert(agent.id.clone(), token);
        let pid = self.host.spawn(&agent.pane_id, &spec)?;
        let created = pid.and_then(procs::created);
        self.edit(|st| {
            if let (Some(p), Some(c)) = (pid, created) {
                st.procs.insert(agent.id.clone(), (p, c));
            }
            if let Some(a) = st.agent_mut(&agent.id) {
                a.pid = pid;
                set_state(a, AgentState::Starting);
            }
        });
        self.watch_start(&agent.id, pid);
        Ok(())
    }

    /// Until the agent's session starts, watch its pane for Claude Code's trust prompt (no
    /// hook runs before it's answered): the user answers it in Requests. Tell the user when
    /// it's slow to start for another reason (a sign-in, an update notice…).
    fn watch_start(&self, agent_id: &str, pid: Option<u32>) {
        let me = self.arc();
        let id = agent_id.to_string();
        self.rt.spawn(async move {
            let since = tokio::time::Instant::now();
            let mut told = false;
            while since.elapsed() < START_WATCH {
                tokio::time::sleep(Duration::from_millis(500)).await;
                let Ok(a) = me.agent(&id) else { return };
                if a.state != AgentState::Starting || a.pid != pid {
                    return;
                }
                if me.host.screen(&a.pane_id).and_then(|s| startup::trust_prompt(&s)).is_some() {
                    me.clone().ask_trust(&a).await;
                    // (the pane takes a moment to move on after the answer)
                    tokio::time::sleep(Duration::from_secs(3)).await;
                    continue;
                }
                if !told && since.elapsed() >= SLOW_START {
                    told = true;
                    let text = format!("{} hasn't started after {} s. Look at its pane: Claude Code may be waiting for you there.", a.name, SLOW_START.as_secs());
                    me.edit(|st| st.log(&a.run_id, Some(&a.id), None, "agent.slow", text.clone(), false));
                    me.host.notice(&text, "warning");
                }
            }
        });
    }

    /// Claude Code asks whether to trust the agent's folder: a request for the user. Allow
    /// picks "Yes, I trust this folder" in the pane; Deny stops the team (or removes the
    /// worker), which can't work there otherwise. Answering in the pane works too.
    async fn ask_trust(self: Arc<Self>, agent: &Agent) {
        let (tx, mut rx) = oneshot::channel();
        let summary = format!("trust the folder {}", agent.cwd);
        let q = self.new_request(agent, RequestKind::Permission, Some(TRUST_TOOL.into()), summary, Some(json!({ "folder": agent.cwd })), None, false);
        self.answers.lock().insert(q.id.clone(), tx);
        self.host.attention(&q, &agent.name);
        let answer = loop {
            tokio::select! {
                a = &mut rx => break a.ok(),
                _ = tokio::time::sleep(Duration::from_millis(500)) => {}
            }
            if !self.st.lock().requests.iter().any(|x| x.id == q.id && x.status == RequestStatus::Pending) {
                // answered (the answer is on its way) or closed (it never comes)
                break (&mut rx).await.ok();
            }
            let shown = self.agent(&agent.id).is_ok_and(|a| a.state == AgentState::Waiting && a.pid == agent.pid)
                && self.host.screen(&agent.pane_id).and_then(|s| startup::trust_prompt(&s)).is_some();
            if !shown {
                // answered in the pane, or the agent is gone
                self.close_request(&q.id, "terminal");
                self.edit(|st| {
                    if let Some(a) = st.agent_mut(&agent.id).filter(|a| a.state == AgentState::Waiting) {
                        set_state(a, AgentState::Starting);
                    }
                });
                return;
            }
        };
        match answer {
            Some(Answer::Allow | Answer::AllowAlways) => {
                if let Err(e) = self.choose_trust(&agent.pane_id).await {
                    let text = format!("Couldn't answer {}'s trust prompt ({e}). Answer it in its pane.", agent.name);
                    self.edit(|st| st.log(&agent.run_id, Some(&agent.id), None, "agent.trust", text.clone(), false));
                    self.host.notice(&text, "warning");
                }
            }
            Some(Answer::Deny(_)) => {
                let a = agent.clone();
                let me = self.clone();
                self.rt.spawn_blocking(move || {
                    let r = if a.role == Role::Lead { me.stop_run(&a.run_id) } else { me.remove_agent(&a.id) };
                    if let Err(e) = r {
                        me.host.notice(&e, "error");
                    }
                });
            }
            _ => {}
        }
    }

    /// Pick "Yes, I trust this folder" in the pane's trust prompt: down to it, and Enter only
    /// once the screen shows it selected (Enter on "No, exit" ends the session).
    async fn choose_trust(&self, pane: &str) -> Result<(), String> {
        let selected = || self.host.screen(pane).and_then(|s| startup::trust_prompt(&s)).map(|p| p.yes_selected);
        for attempt in 0..4 {
            match selected() {
                None => return Err("it isn't showing any more".into()),
                Some(true) => return self.host.write(pane, "\r"),
                Some(false) if attempt == 3 => break,
                Some(false) => {}
            }
            self.host.write(pane, startup::DOWN)?;
            for _ in 0..10 {
                tokio::time::sleep(Duration::from_millis(100)).await;
                if selected() != Some(false) {
                    break;
                }
            }
        }
        Err("\"Yes, I trust this folder\" didn't get selected".into())
    }

    /// The agent's trust prompt waits for the user (see `ask_trust`).
    fn trust_pending(&self, agent_id: &str) -> bool {
        self.st.lock().requests.iter().any(|q| q.agent_id == agent_id && q.status == RequestStatus::Pending && q.tool.as_deref() == Some(TRUST_TOOL))
    }

    /// End an agent's process tree (marked stopped first, so its exit isn't reported as a crash).
    fn end_process(&self, a: &Agent) {
        self.edit(|st| {
            if let Some(x) = st.agent_mut(&a.id) {
                set_state(x, AgentState::Stopped);
                x.pid = None;
            }
            st.procs.remove(&a.id);
            st.tokens.remove(&a.id);
        });
        if let Some(pid) = self.host.running(&a.pane_id) {
            procs::kill_tree(pid);
        }
        self.host.kill(&a.pane_id);
    }

    async fn wait_gone(&self, pane: &str) {
        for _ in 0..50 {
            if self.host.running(pane).is_none() {
                return;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    }

    /// The terminal session of an agent's pane ended. `pid`: the process that ended (a
    /// relaunch replaces a pane's process, and the old one's exit may be reported late).
    pub fn process_exited(&self, pane: &str, pid: Option<u32>, code: Option<u32>) {
        let Some(a) = self.agent_by_pane(pane) else { return };
        if !a.state.live() || (pid.is_some() && a.pid.is_some() && pid != a.pid) {
            return;
        }
        self.edit(|st| {
            let lead = a.role == Role::Worker;
            if let Some(x) = st.agent_mut(&a.id) {
                set_state(x, AgentState::Exited);
                x.pid = None;
            }
            st.procs.remove(&a.id);
            // (Windows exit codes are often negative NTSTATUS-style values)
            let code = code.map(|c| format!(" (exit code {})", c as i32)).unwrap_or_default();
            st.log(&a.run_id, Some(&a.id), a.task_id.as_deref(), "agent.exited", format!("{} exited{code}", a.name), lead);
        });
    }

    /// Start (or continue) the agent whose pane the user resumed. Returns once its terminal exists.
    pub fn resume(&self, agent_id: &str) -> Result<(), String> {
        let a = self.agent(agent_id)?;
        let run = self.run(&a.run_id)?;
        if run.status != RunStatus::Active {
            return Err("This team was stopped.".into());
        }
        if self.host.running(&a.pane_id).is_some() {
            if a.state == AgentState::Paused {
                self.edit(|st| {
                    if let Some(x) = st.agent_mut(agent_id) {
                        set_state(x, AgentState::Idle);
                    }
                });
                if a.task_id.is_some() {
                    self.send_later(agent_id, "Continue where you left off.".into());
                }
            }
            return Ok(());
        }
        self.launch(agent_id)?;
        // (its pane may be gone, e.g. the tab was closed while the team was stopped)
        self.add_pane(agent_id);
        if a.task_id.is_some() {
            self.send_later(agent_id, "Continue where you left off.".into());
        }
        Ok(())
    }

    /// Esc: stop the current turn. Paused agents keep their process for a while.
    pub fn interrupt(&self, agent_id: &str, pause: bool) -> Result<(), String> {
        let a = self.agent(agent_id)?;
        if self.host.running(&a.pane_id).is_none() {
            return Err(format!("{} isn't running.", a.name));
        }
        if self.trust_pending(agent_id) {
            // (Esc there means "no": Claude Code would exit)
            return Err(format!("{} is waiting for you to trust its folder: answer that in Requests first.", a.name));
        }
        self.host.write(&a.pane_id, "\x1b")?;
        // (an interrupted turn fires no Stop hook)
        self.edit(|st| {
            if let Some(x) = st.agent_mut(agent_id) {
                set_state(x, if pause { AgentState::Paused } else { AgentState::Idle });
            }
            let what = if pause { "Paused" } else { "Interrupted" };
            st.log(&a.run_id, Some(agent_id), a.task_id.as_deref(), "agent.interrupt", format!("{what} {}", a.name), false);
        });
        if pause {
            let me = self.arc();
            let (id, since) = (agent_id.to_string(), self.agent(agent_id).map(|a| a.state_since).unwrap_or(0));
            self.rt.spawn(async move {
                tokio::time::sleep(PAUSE_KILL).await;
                // still the same pause: end the process (Resume continues from the transcript)
                if let Ok(a) = me.agent(&id) {
                    if a.state == AgentState::Paused && a.state_since == since {
                        me.end_process(&a);
                    }
                }
            });
        }
        Ok(())
    }

    /// Remove a worker: its process ends, its open task goes back to the queue, and its
    /// worktree is deleted once everything it did is merged.
    pub fn remove_agent(&self, agent_id: &str) -> Result<(), String> {
        let a = self.agent(agent_id)?;
        if a.role == Role::Lead {
            return Err("The lead can't be removed: stop the whole team instead.".into());
        }
        self.end_process(&a);
        let run = self.run(&a.run_id)?;
        self.edit(|st| {
            for t in st.tasks.iter_mut().filter(|t| t.assignee.as_deref() == Some(agent_id) && matches!(t.status, TaskStatus::Assigned | TaskStatus::Working)) {
                t.status = TaskStatus::Queued;
                t.assignee = None;
                t.updated_at = now_ms();
            }
            for q in st.requests.iter_mut().filter(|q| q.agent_id == agent_id && q.status == RequestStatus::Pending) {
                q.status = RequestStatus::Closed;
                q.answered_by = Some("removed".into());
            }
            st.agents.retain(|x| x.id != agent_id);
            st.log(&a.run_id, None, a.task_id.as_deref(), "agent.removed", format!("Removed {}", a.name), true);
        });
        self.forget_files(agent_id);
        self.host.panes(PaneRequest::Remove { pane_id: a.pane_id.clone() });
        let (root, slot, branches) = (PathBuf::from(&run.root), a.slot.clone(), self.branches_of(agent_id));
        self.rt.spawn_blocking(move || {
            if worktree::all_merged(&root, &branches) {
                let _ = worktree::remove_slot(&root, &slot);
            }
        });
        Ok(())
    }

    // ── workers and tasks ───────────────────────────────────────────────────

    /// A new worker with its own worktree, in `slot` ("w2") or the next free one.
    pub fn hire(&self, run_id: &str, model: Option<&str>, effort: Option<&str>, slot: Option<&str>) -> Result<Agent, String> {
        let _one = self.hiring.lock();
        let run = self.run(run_id)?;
        if run.status != RunStatus::Active {
            return Err("This team was stopped.".into());
        }
        let (slot, opus_full) = {
            let st = self.st.lock();
            st.may_hire(run_id)?;
            let used: Vec<String> = st.workers(run_id).map(|w| w.slot.clone()).collect();
            let free = |s: &String| !used.contains(s) && s.trim_start_matches('w').parse::<usize>().is_ok_and(|n| (1..=MAX_WORKERS).contains(&n));
            let wanted = slot.map(|s| s.trim().to_ascii_lowercase()).filter(free);
            let slot = wanted.or_else(|| (1..=MAX_WORKERS).map(|i| format!("w{i}")).find(free)).unwrap_or_default();
            let opus = st.workers(run_id).filter(|w| is_opus(&w.model)).count();
            (slot, opus >= st.routing.max_opus_workers as usize)
        };
        let mut model = model.unwrap_or("sonnet").to_string();
        if is_opus(&model) && opus_full {
            model = "sonnet".into();
        }
        let wt = worktree::ensure_slot(Path::new(&run.root), &slot)?;
        let now = now_ms();
        let n = slot.trim_start_matches('w');
        let agent = Agent {
            id: hex(8),
            run_id: run_id.into(),
            role: Role::Worker,
            slot: slot.clone(),
            name: format!("Worker {n}"),
            pane_id: hex(12),
            model,
            model_id: None,
            effort: effort.unwrap_or("medium").into(),
            session_id: uuid::Uuid::new_v4().to_string(),
            transcript: None,
            state: AgentState::Starting,
            state_since: now,
            task_id: None,
            last_task_id: None,
            used: false,
            cwd: wt.to_string_lossy().into_owned(),
            branch: None,
            context_pct: None,
            cost_usd: None,
            pid: None,
            last_message: None,
            created_at: now,
        };
        self.edit(|st| {
            st.agents.push(agent.clone());
            st.log(run_id, Some(&agent.id), None, "agent.hired", format!("Started {} ({})", agent.name, agent.model), false);
        });
        if let Err(e) = self.launch(&agent.id) {
            self.edit(|st| st.agents.retain(|x| x.id != agent.id));
            return Err(e);
        }
        self.add_pane(&agent.id);
        Ok(agent)
    }

    pub fn create_task(&self, run_id: &str, title: &str, description: &str, difficulty: u8, follow_up_of: Option<&str>) -> Result<Task, String> {
        let run = self.run(run_id)?;
        if run.status != RunStatus::Active {
            return Err("This team was stopped.".into());
        }
        if title.trim().is_empty() {
            return Err("A task needs a title.".into());
        }
        if let Some(f) = follow_up_of {
            let t = self.task(f)?;
            if t.run_id != run_id {
                return Err(format!("Task {f} belongs to another team."));
            }
        }
        Ok(self.edit(|st| {
            st.next_task += 1;
            let now = now_ms();
            let t = Task {
                id: format!("t{}", st.next_task),
                run_id: run_id.into(),
                title: short(title, 200),
                description: description.trim().to_string(),
                difficulty: difficulty.clamp(1, 5),
                status: TaskStatus::Queued,
                assignee: None,
                follow_up_of: follow_up_of.map(|f| f.trim().to_string()),
                model: None,
                branch: None,
                summary: None,
                attempts: 0,
                failures: 0,
                created_at: now,
                updated_at: now,
            };
            st.tasks.push(t.clone());
            st.log(run_id, None, Some(&t.id), "task.created", format!("New task {}: {}", t.id, t.title), false);
            t
        }))
    }

    /// Hand a queued task to a worker (the given one, an idle one, or a new one).
    /// Returns the worker's id; the task reaches it in the background.
    pub fn assign(&self, task_id: &str, worker: Option<&str>) -> Result<String, String> {
        let _one = self.assigning.lock();
        let task = self.task(task_id)?;
        // (a failed task can be tried again)
        if !matches!(task.status, TaskStatus::Queued | TaskStatus::Failed) {
            return Err(format!("Task {} is {:?}, not queued.", task.id, task.status).to_lowercase());
        }
        // two failures (or reviews sent back): one level up
        let level = (task.difficulty + u8::from(task.failures >= 2)).min(5);
        let run = self.run(&task.run_id)?;
        // a follow-up goes back to whoever did the original, in the same conversation
        let original = task.follow_up_of.as_deref().and_then(|f| self.st.lock().task(f).and_then(|t| t.assignee.clone()));
        let free = |a: &Agent| a.task_id.is_none() && !matches!(a.state, AgentState::Paused);
        let agent = match worker {
            // a slot nobody holds yet: start a worker there
            Some(w) if self.find_agent(&run.id, w).is_err() && w.trim().len() == 2 && w.trim().to_ascii_lowercase().starts_with('w') => {
                let (c, _) = self.st.lock().route(level);
                self.hire(&run.id, Some(&c.model), Some(&c.effort), Some(w))?
            }
            Some(w) => {
                let a = self.find_agent(&run.id, w)?;
                if a.role != Role::Worker {
                    return Err("Tasks go to workers, not the lead.".into());
                }
                if !free(&a) {
                    return Err(format!("{} is busy with {}.", a.name, a.task_id.as_deref().unwrap_or("something")));
                }
                a
            }
            None => {
                let pick = {
                    let st = self.st.lock();
                    let workers: Vec<&Agent> = st.workers(&run.id).filter(|a| free(a)).collect();
                    original.as_ref().and_then(|o| workers.iter().find(|a| &a.id == o)).or_else(|| workers.first()).map(|a| (*a).clone())
                };
                match pick {
                    Some(a) => a,
                    None => {
                        let (c, _) = self.st.lock().route(level);
                        self.hire(&run.id, Some(&c.model), Some(&c.effort), None)?
                    }
                }
            }
        };
        let follow_up = original.as_deref() == Some(agent.id.as_str()) && agent.last_task_id.as_deref() == task.follow_up_of.as_deref();
        // model: a follow-up stays on the conversation's model; a fresh task gets the one its
        // difficulty asks for, within the usage gate and the Opus cap
        let (mut model, effort, mut note) = if follow_up {
            (agent.model.clone(), agent.effort.clone(), None)
        } else {
            let (c, note) = self.st.lock().route(level);
            (c.model, c.effort, note)
        };
        let opus_full = {
            let st = self.st.lock();
            let others = st.workers(&run.id).filter(|w| w.id != agent.id && is_opus(&w.model) && w.task_id.is_some()).count();
            others >= st.routing.max_opus_workers as usize
        };
        if is_opus(&model) && opus_full && !follow_up {
            model = "sonnet".into();
            note = Some("the Opus slot is taken".into());
        }
        let mut note = note.map(|n| format!(", Sonnet because {n}")).unwrap_or_default();
        if level > task.difficulty && !follow_up {
            note.push_str(", one level up after two failures");
        }
        let relaunch = !follow_up && (model != agent.model || effort != agent.effort || !agent.state.live());
        let branch = if follow_up {
            agent.branch.clone().unwrap_or_default()
        } else {
            let b = worktree::task_branch(&run.id, &task.id);
            worktree::start_task(Path::new(&agent.cwd), &b)?;
            b
        };
        self.edit(|st| {
            if let Some(t) = st.task_mut(&task.id) {
                t.status = TaskStatus::Assigned;
                t.assignee = Some(agent.id.clone());
                t.model = Some(model.clone());
                t.branch = Some(branch.clone());
                t.attempts += 1;
                t.updated_at = now_ms();
            }
            if let Some(a) = st.agent_mut(&agent.id) {
                a.task_id = Some(task.id.clone());
                a.branch = Some(branch.clone());
                if relaunch {
                    a.model = model.clone();
                    a.effort = effort.clone();
                }
            }
            st.log(&run.id, Some(&agent.id), Some(&task.id), "task.assigned", format!("{} → {} ({model}{note})", task.id, agent.name), false);
        });
        let me = self.arc();
        let (aid, tid) = (agent.id.clone(), task.id.clone());
        self.rt.spawn(async move { me.deliver(aid, tid, follow_up, relaunch).await });
        Ok(agent.id)
    }

    /// Get the agent ready (a fresh session unless it's a follow-up) and type the task in.
    async fn deliver(self: Arc<Self>, agent_id: String, task_id: String, follow_up: bool, relaunch: bool) {
        let res: Result<(), String> = async {
            let a = self.agent(&agent_id)?;
            if relaunch {
                self.end_process(&a);
                self.wait_gone(&a.pane_id).await;
                self.edit(|st| {
                    if let Some(x) = st.agent_mut(&agent_id) {
                        x.session_id = uuid::Uuid::new_v4().to_string();
                        x.transcript = None;
                        x.used = false;
                    }
                });
                self.launch(&agent_id)?;
            } else if !follow_up && a.used {
                self.ready(&agent_id, Duration::from_secs(60)).await?;
                let sig = self.signals(&agent_id);
                let cleared = sig.session.notified();
                tokio::pin!(cleared);
                cleared.as_mut().enable();
                self.host.write(&a.pane_id, "/clear")?;
                tokio::time::sleep(Duration::from_millis(200)).await;
                self.host.write(&a.pane_id, "\r")?;
                tokio::time::timeout(Duration::from_secs(15), cleared).await.map_err(|_| "its conversation didn't clear".to_string())?;
            }
            self.ready(&agent_id, Duration::from_secs(120)).await?;
            let text = {
                let st = self.st.lock();
                let t = st.task(&task_id).ok_or("the task is gone")?;
                roles::task_message(t, follow_up)
            };
            self.type_text(&agent_id, &text).await
        }
        .await;
        match res {
            Ok(()) => self.edit(|st| {
                if let Some(t) = st.task_mut(&task_id) {
                    if t.status == TaskStatus::Assigned {
                        t.status = TaskStatus::Working;
                    }
                }
                if let Some(a) = st.agent_mut(&agent_id) {
                    a.used = true;
                }
            }),
            Err(e) => self.edit(|st| {
                let name = st.agent(&agent_id).map(|a| a.name.clone()).unwrap_or_default();
                let run = st.task(&task_id).map(|t| t.run_id.clone()).unwrap_or_default();
                if let Some(t) = st.task_mut(&task_id) {
                    t.status = TaskStatus::Queued;
                    t.assignee = None;
                }
                if let Some(a) = st.agent_mut(&agent_id) {
                    if a.task_id.as_deref() == Some(task_id.as_str()) {
                        a.task_id = None;
                    }
                }
                st.log(&run, Some(&agent_id), Some(&task_id), "task.undelivered", format!("Couldn't start {task_id} on {name}: {e}. It's queued again."), true);
            }),
        }
    }

    /// Wait until the agent's session is up and not in a turn.
    async fn ready(&self, agent_id: &str, limit: Duration) -> Result<(), String> {
        let deadline = tokio::time::Instant::now() + limit;
        loop {
            let a = self.agent(agent_id)?;
            match a.state {
                AgentState::Idle => return Ok(()),
                AgentState::Exited | AgentState::Stopped => return Err(format!("{} isn't running", a.name)),
                _ => {}
            }
            if tokio::time::Instant::now() >= deadline {
                return Err(format!("{} didn't become ready", a.name));
            }
            tokio::time::sleep(Duration::from_millis(200)).await;
        }
    }

    /// Type a message into an agent's input and submit it: a bracketed paste, then Enter on
    /// its own (in one write Claude Code may take the Enter as part of the paste). An idle
    /// agent confirms with UserPromptSubmit; a busy one queues the message.
    pub async fn type_text(&self, agent_id: &str, text: &str) -> Result<(), String> {
        let a = self.agent(agent_id)?;
        if self.host.running(&a.pane_id).is_none() {
            return Err(format!("{} isn't running", a.name));
        }
        let text = paste_safe(text);
        if text.is_empty() {
            return Ok(());
        }
        let sig = self.signals(agent_id);
        let _turn = sig.typing.lock().await;
        let busy = matches!(self.agent(agent_id)?.state, AgentState::Working | AgentState::Waiting);
        let submitted = sig.prompt.notified();
        tokio::pin!(submitted);
        submitted.as_mut().enable();
        self.host.write(&a.pane_id, &format!("\x1b[200~{text}\x1b[201~"))?;
        tokio::time::sleep(Duration::from_millis(150)).await;
        self.host.write(&a.pane_id, "\r")?;
        if busy {
            return Ok(());
        }
        if tokio::time::timeout(Duration::from_secs(3), submitted.as_mut()).await.is_ok() {
            return Ok(());
        }
        // once more: the first Enter can land while the paste is still being taken in
        self.host.write(&a.pane_id, "\r")?;
        tokio::time::timeout(Duration::from_secs(3), submitted).await.map(|_| ()).map_err(|_| format!("{} didn't take the message", a.name))
    }

    /// Type a message once the agent is ready (in the background).
    fn send_later(&self, agent_id: &str, text: String) {
        let me = self.arc();
        let id = agent_id.to_string();
        self.rt.spawn(async move {
            if me.ready(&id, Duration::from_secs(120)).await.is_ok() {
                let _ = me.type_text(&id, &text).await;
            }
        });
    }

    /// The user (or the lead) writes to an agent.
    pub async fn send(&self, agent_id: &str, text: &str) -> Result<(), String> {
        let a = self.agent(agent_id)?;
        if self.trust_pending(agent_id) {
            // (typing there would answer it: Enter is "No, exit")
            return Err(format!("{} is waiting for you to trust its folder: answer that in Requests first.", a.name));
        }
        if a.state == AgentState::Starting {
            self.ready(agent_id, Duration::from_secs(120)).await?;
        }
        self.type_text(agent_id, text).await
    }

    /// A worker says it's done (or can't be): the lead reviews it.
    pub fn complete_task(&self, agent_id: &str, summary: &str, status: &str) -> Result<String, String> {
        let a = self.agent(agent_id)?;
        let task_id = a.task_id.clone().ok_or("You have no task right now.")?;
        let task = self.task(&task_id)?;
        let (new, kind, verb) = match status {
            "failed" => (TaskStatus::Failed, "task.failed", "couldn't finish"),
            "blocked" => (TaskStatus::Failed, "task.blocked", "is blocked on"),
            _ => (TaskStatus::Review, "task.review", "finished"),
        };
        let wt = Path::new(&a.cwd);
        let saved = if new == TaskStatus::Review {
            // done means committed: what's left over is either part of the work or build
            // output that belongs in .gitignore, and only the worker knows which
            let left = worktree::changes(wt)?;
            if !left.is_empty() {
                let list: Vec<String> = left.iter().take(30).map(|l| format!("  {l}")).collect();
                return Err(format!(
                    "There are uncommitted changes in your worktree:\n{}\nCommit what belongs to the task; delete build output or add it to .gitignore. Then call complete_task again.",
                    list.join("\n")
                ));
            }
            false
        } else {
            // unfinished work is kept on the task's branch, junk and all
            worktree::commit_all(wt, &format!("{}: {} (unfinished work saved by Shellmosaic)", task.id, task.title)).unwrap_or(false)
        };
        let stats = task.branch.as_deref().and_then(|b| worktree::stats(Path::new(&self.run(&a.run_id).ok()?.root), b).ok());
        let changes = stats.map(|s| format!(" [{} commit(s), {} file(s), +{} −{}]", s.commits, s.files, s.added, s.removed)).unwrap_or_default();
        self.edit(|st| {
            if let Some(t) = st.task_mut(&task_id) {
                if new == TaskStatus::Failed {
                    t.failures += 1;
                }
                t.status = new;
                t.summary = Some(summary.trim().to_string());
                t.updated_at = now_ms();
            }
            if let Some(x) = st.agent_mut(agent_id) {
                x.task_id = None;
                x.last_task_id = Some(task_id.clone());
            }
            let note = if saved { " (Shellmosaic committed the unfinished changes)" } else { "" };
            st.log(&a.run_id, Some(agent_id), Some(&task_id), kind, format!("{} {verb} {task_id} \"{}\"{changes}{note}: {}", a.name, task.title, short(summary, 1500)), true);
        });
        Ok(match new {
            TaskStatus::Review => "Thanks — the lead will review it. You can stop now.".into(),
            _ => "Noted — the lead will decide what's next. You can stop now.".into(),
        })
    }

    /// The lead accepts a finished task (merged into the integration branch) or sends it back.
    pub fn review(&self, task_id: &str, accept: bool, note: &str) -> Result<String, String> {
        let task = self.task(task_id)?;
        if !matches!(task.status, TaskStatus::Review | TaskStatus::Failed) {
            return Err(format!("Task {} isn't waiting for review.", task.id));
        }
        let run = self.run(&task.run_id)?;
        if !accept {
            let worker = task.assignee.clone().ok_or("Nobody worked on that task.")?;
            let a = self.agent(&worker)?;
            if a.task_id.is_some() {
                return Err(format!("{} is busy with {}; create a follow-up task instead.", a.name, a.task_id.unwrap_or_default()));
            }
            self.edit(|st| {
                if let Some(t) = st.task_mut(task_id) {
                    t.status = TaskStatus::Working;
                    t.attempts += 1;
                    t.failures += 1;
                    t.updated_at = now_ms();
                }
                if let Some(x) = st.agent_mut(&worker) {
                    x.task_id = Some(task.id.clone());
                }
                st.log(&run.id, Some(&worker), Some(task_id), "task.rework", format!("{} sent back to {}: {}", task.id, a.name, short(note, 300)), false);
            });
            let me = self.arc();
            let text = roles::rework_message(&task, note);
            self.rt.spawn(async move {
                if me.ready(&worker, Duration::from_secs(120)).await.is_ok() {
                    let _ = me.type_text(&worker, &text).await;
                }
            });
            return Ok(format!("Sent {} back to {}.", task.id, a.name));
        }
        let branch = task.branch.clone().ok_or("That task has no branch.")?;
        let outcome = worktree::merge_into_integration(Path::new(&run.root), &branch, &format!("{}: {}", task.id, task.title))?;
        let (status, msg) = match outcome {
            worktree::Merge::Merged => (TaskStatus::Done, format!("Merged {branch} into {}.", worktree::INTEGRATION)),
            worktree::Merge::Empty => (TaskStatus::Done, format!("{branch} had no commits; nothing to merge.")),
            worktree::Merge::Conflict(files) => {
                return Err(format!(
                    "{branch} conflicts with {} in: {}. Ask the worker to merge {} into its branch and resolve it (a follow-up task), then review again.",
                    worktree::INTEGRATION,
                    files.join(", "),
                    worktree::INTEGRATION
                ));
            }
        };
        self.edit(|st| {
            if let Some(t) = st.task_mut(task_id) {
                t.status = status;
                t.updated_at = now_ms();
            }
            st.log(&run.id, task.assignee.as_deref(), Some(task_id), "task.done", format!("Accepted {}: {msg}", task.id), false);
        });
        Ok(msg)
    }

    /// A task's changes: `{branch, commits, files, added, removed, diff, truncated}`.
    pub fn task_diff(&self, task_id: &str) -> Result<Value, String> {
        let t = self.task(task_id)?;
        let r = self.run(&t.run_id)?;
        let b = t.branch.ok_or("That task has no branch yet.")?;
        let root = Path::new(&r.root);
        let s = worktree::stats(root, &b)?;
        let (diff, truncated) = worktree::diff(root, &b, 400_000)?;
        Ok(json!({ "branch": b, "commits": s.commits, "files": s.files, "added": s.added, "removed": s.removed, "diff": diff, "truncated": truncated }))
    }

    /// What merging the team's work into the user's branch would do.
    pub fn merge_preview(&self, run: &str) -> Result<Value, String> {
        let r = self.run(run)?;
        let base = r.base_branch.ok_or("The repository was on a detached HEAD when the team started: merge orch/integration yourself.")?;
        let p = worktree::base_preview(Path::new(&r.root), &base)?;
        Ok(json!({
            "base": base,
            "integration": worktree::INTEGRATION,
            "commits": p.commits,
            "files": p.files,
            "added": p.added,
            "removed": p.removed,
            "conflicts": p.conflicts,
            "dirtyOverlap": p.dirty_overlap,
            "current": p.current,
        }))
    }

    /// The user approved: merge the team's work into their branch.
    pub fn merge_to_base(&self, run: &str) -> Result<String, String> {
        let r = self.run(run)?;
        let base = r.base_branch.clone().ok_or("The repository was on a detached HEAD when the team started.")?;
        let n = worktree::merge_into_base(Path::new(&r.root), &base)?;
        if n == 0 {
            return Ok(format!("{base} already has everything from {}.", worktree::INTEGRATION));
        }
        let msg = format!("Merged {n} commit(s) from {} into {base}.", worktree::INTEGRATION);
        self.edit(|st| st.log(run, None, None, "run.merged", msg.clone(), true));
        Ok(msg)
    }

    pub fn cancel_task(&self, task_id: &str) -> Result<(), String> {
        let task = self.task(task_id)?;
        if !task.status.open() {
            return Ok(());
        }
        if let Some(w) = task.assignee.as_deref() {
            if let Ok(a) = self.agent(w) {
                if a.task_id.as_deref() == Some(task_id) && matches!(a.state, AgentState::Working | AgentState::Waiting) {
                    let _ = self.interrupt(w, false);
                }
            }
        }
        self.edit(|st| {
            if let Some(t) = st.task_mut(task_id) {
                t.status = TaskStatus::Cancelled;
                t.updated_at = now_ms();
            }
            for a in st.agents.iter_mut().filter(|a| a.task_id.as_deref() == Some(task_id)) {
                a.task_id = None;
                a.last_task_id = Some(task_id.to_string());
            }
            st.log(&task.run_id, task.assignee.as_deref(), Some(task_id), "task.cancelled", format!("Cancelled {}", task.id), true);
        });
        Ok(())
    }

    // ── requests ────────────────────────────────────────────────────────────

    fn new_request(&self, agent: &Agent, kind: RequestKind, tool: Option<String>, summary: String, detail: Option<Value>, suggestions: Option<Value>, lead: bool) -> Request {
        self.edit(|st| {
            st.next_req += 1;
            let q = Request {
                id: format!("r{}", st.next_req),
                run_id: agent.run_id.clone(),
                agent_id: agent.id.clone(),
                kind,
                tool,
                summary,
                detail,
                suggestions,
                status: RequestStatus::Pending,
                answered_by: None,
                answer: None,
                created_at: now_ms(),
                answered_at: None,
            };
            if kind == RequestKind::Permission {
                if let Some(a) = st.agent_mut(&agent.id) {
                    set_state(a, AgentState::Waiting);
                }
            }
            let text = match kind {
                RequestKind::Permission => format!("{} asks to {} ({})", agent.name, q.summary, q.id),
                RequestKind::Question => format!("{} asks ({}): {}", agent.name, q.id, q.summary),
            };
            st.log(&agent.run_id, Some(&agent.id), agent.task_id.as_deref(), "request", text, lead);
            st.requests.push(q.clone());
            q
        })
    }

    /// Answer a request (from the UI, or the lead for questions).
    pub fn answer(&self, req_id: &str, answer: Answer, by: &str) -> Result<(), String> {
        let q = self.st.lock().requests.iter().find(|q| q.id == req_id).cloned().ok_or("There's no such request.")?;
        if q.status != RequestStatus::Pending {
            return Err(format!("That request was already handled ({}).", q.answered_by.as_deref().unwrap_or("closed")));
        }
        let tx = self.answers.lock().remove(req_id);
        let Some(tx) = tx else {
            self.close_request(req_id, "gone");
            return Err("Nothing is waiting for that answer any more.".into());
        };
        let (status, text) = match &answer {
            Answer::Allow => (RequestStatus::Allowed, None),
            Answer::AllowAlways => (RequestStatus::Allowed, Some("always".to_string())),
            Answer::Deny(m) => (RequestStatus::Denied, Some(m.clone()).filter(|m| !m.is_empty())),
            Answer::Text(t) => (RequestStatus::Answered, Some(t.clone())),
        };
        self.edit(|st| {
            if let Some(x) = st.requests.iter_mut().find(|x| x.id == req_id) {
                x.status = status;
                x.answered_by = Some(by.into());
                x.answer = text;
                x.answered_at = Some(now_ms());
            }
            if let Some(a) = st.agent_mut(&q.agent_id) {
                if a.state == AgentState::Waiting {
                    // (the trust prompt comes before the session: it's still starting)
                    set_state(a, if q.tool.as_deref() == Some(TRUST_TOOL) { AgentState::Starting } else { AgentState::Working });
                }
            }
        });
        let _ = tx.send(answer);
        Ok(())
    }

    /// Nobody will answer this request any more (answered in the pane, timed out, agent moved on).
    fn close_request(&self, req_id: &str, why: &str) {
        let pending = self.st.lock().requests.iter().any(|q| q.id == req_id && q.status == RequestStatus::Pending);
        if !pending {
            return;
        }
        self.answers.lock().remove(req_id);
        self.edit(|st| {
            if let Some(q) = st.requests.iter_mut().find(|q| q.id == req_id) {
                q.status = RequestStatus::Closed;
                q.answered_by = Some(why.into());
                q.answered_at = Some(now_ms());
            }
        });
    }

    /// The agent did something else: whatever permission prompt it had open was settled in its pane.
    fn settle_prompts(&self, agent_id: &str) {
        let open: Vec<String> = self
            .st
            .lock()
            .requests
            .iter()
            .filter(|q| q.agent_id == agent_id && q.kind == RequestKind::Permission && q.status == RequestStatus::Pending)
            .map(|q| q.id.clone())
            .collect();
        for id in open {
            if let Some(tx) = self.answers.lock().remove(&id) {
                drop(tx);
            }
            self.close_request(&id, "terminal");
        }
    }

    async fn permission(self: Arc<Self>, agent_id: String, input: Value) -> Value {
        let Ok(agent) = self.agent(&agent_id) else { return Value::Null };
        let tool = input.get("tool_name").and_then(Value::as_str).unwrap_or("a tool").to_string();
        let tool_input = input.get("tool_input").cloned().unwrap_or(Value::Null);
        let summary = describe_tool(&tool, &tool_input);
        let (tx, rx) = oneshot::channel();
        let suggestions = input.get("permission_suggestions").filter(|s| s.as_array().is_some_and(|a| !a.is_empty())).cloned();
        let q = self.new_request(&agent, RequestKind::Permission, Some(tool), summary, Some(trimmed(&tool_input, 2000)), suggestions.clone(), false);
        self.answers.lock().insert(q.id.clone(), tx);
        self.host.attention(&q, &agent.name);
        // dropped with this future when Claude Code stops waiting (the pane's own dialog was used)
        struct Pending(Arc<Core>, String);
        impl Drop for Pending {
            fn drop(&mut self) {
                self.0.close_request(&self.1, "terminal");
            }
        }
        let _pending = Pending(self.clone(), q.id.clone());
        match rx.await {
            Ok(Answer::Allow) => json!({ "hookSpecificOutput": { "hookEventName": "PermissionRequest", "decision": { "behavior": "allow" } } }),
            Ok(Answer::AllowAlways) => {
                let mut decision = json!({ "behavior": "allow" });
                if let Some(s) = suggestions {
                    decision["updatedPermissions"] = s;
                }
                json!({ "hookSpecificOutput": { "hookEventName": "PermissionRequest", "decision": decision } })
            }
            Ok(Answer::Deny(m)) => {
                let message = if m.trim().is_empty() { "The user said no.".to_string() } else { m };
                json!({ "hookSpecificOutput": { "hookEventName": "PermissionRequest", "decision": { "behavior": "deny", "message": message } } })
            }
            _ => Value::Null,
        }
    }

    /// A worker's question for the lead. Blocks the worker's tool call until it's answered.
    pub async fn ask_lead(&self, agent_id: &str, question: &str, ctx: CallCtx) -> ToolOutput {
        let Ok(agent) = self.agent(agent_id) else { return ToolOutput::err("unknown agent") };
        let (tx, rx) = oneshot::channel();
        let q = self.new_request(&agent, RequestKind::Question, None, short(question, 4000), None, None, true);
        self.answers.lock().insert(q.id.clone(), tx);
        tokio::select! {
            a = rx => match a {
                Ok(Answer::Text(t)) => ToolOutput::ok(format!("The lead answered: {t}")),
                Ok(Answer::Allow | Answer::AllowAlways) => ToolOutput::ok("The lead answered: yes."),
                Ok(Answer::Deny(m)) => ToolOutput::ok(format!("The lead answered: no. {m}")),
                Err(_) => ToolOutput::ok("Your question was closed without an answer. Use your best judgment and mention the assumption in your summary."),
            },
            _ = ctx.cancelled() => {
                self.close_request(&q.id, "cancelled");
                ToolOutput::err("cancelled")
            }
            _ = tokio::time::sleep(QUESTION_WAIT) => {
                self.close_request(&q.id, "timeout");
                ToolOutput::ok("No answer from the lead for 20 minutes. Use your best judgment and mention the assumption in your summary.")
            }
        }
    }

    // ── the lead's events ───────────────────────────────────────────────────

    /// Lead events its lead hasn't seen yet (and marks them seen).
    pub fn take_lead_events(&self, run: &str) -> Vec<Activity> {
        let mut st = self.st.lock();
        let seen = st.lead_seen.get(run).copied().unwrap_or(0);
        let out: Vec<Activity> = st.activity.iter().filter(|a| a.lead && a.run_id == run && a.seq > seen).cloned().collect();
        if let Some(last) = out.last() {
            st.lead_seen.insert(run.to_string(), last.seq);
        }
        out
    }

    /// Block until the lead has events, it's cancelled, or `timeout` passes. Progress is
    /// reported every minute (that also keeps the stdio connection from timing out).
    pub async fn wait_events(&self, run: &str, timeout: Duration, ctx: &CallCtx) -> Option<Vec<Activity>> {
        let deadline = tokio::time::Instant::now() + timeout;
        let mut next_progress = tokio::time::Instant::now() + Duration::from_secs(60);
        let started = tokio::time::Instant::now();
        loop {
            let woke = self.wake.notified();
            tokio::pin!(woke);
            woke.as_mut().enable();
            let events = self.take_lead_events(run);
            if !events.is_empty() {
                return Some(events);
            }
            if tokio::time::Instant::now() >= deadline {
                return Some(Vec::new());
            }
            tokio::select! {
                _ = woke => {}
                _ = ctx.cancelled() => return None,
                _ = tokio::time::sleep_until(deadline.min(next_progress)) => {
                    if tokio::time::Instant::now() >= next_progress {
                        let secs = started.elapsed().as_secs();
                        ctx.progress(secs as f64, Some(timeout.as_secs() as f64), Some("waiting for the team"));
                        next_progress += Duration::from_secs(60);
                    }
                }
            }
        }
    }

    /// The lead is idle and its team has news: type a team update into its pane (batched).
    fn nudge_lead(&self, run: &str) {
        if !self.nudging.lock().insert(run.to_string()) {
            return;
        }
        let me = self.arc();
        let run = run.to_string();
        self.rt.spawn(async move {
            tokio::time::sleep(NUDGE_DELAY).await;
            me.nudging.lock().remove(&run);
            let Ok(r) = me.run(&run) else { return };
            let Ok(lead) = me.agent(&r.lead_id) else { return };
            if r.status != RunStatus::Active || lead.state != AgentState::Idle {
                return; // a running `wait` takes them; a busy lead gets them when it stops
            }
            let events = me.take_lead_events(&run);
            if events.is_empty() {
                return;
            }
            if me.type_text(&lead.id, &roles::team_update(&events)).await.is_err() {
                // not delivered: hand them out again next time
                let first = events.first().map(|e| e.seq.saturating_sub(1)).unwrap_or(0);
                me.st.lock().lead_seen.insert(run.clone(), first);
            }
        });
    }

    fn maybe_nudge(&self, run: &str) {
        let has_news = {
            let st = self.st.lock();
            let seen = st.lead_seen.get(run).copied().unwrap_or(0);
            let lead_idle = st.run(run).and_then(|r| st.agent(&r.lead_id)).is_some_and(|l| l.state == AgentState::Idle);
            lead_idle && st.activity.iter().any(|a| a.lead && a.run_id == run && a.seq > seen)
        };
        if has_news {
            self.nudge_lead(run);
        }
    }

    // ── hooks and statusLine ────────────────────────────────────────────────

    fn on_hook(&self, agent_id: &str, event: &str, input: &Value) {
        let Ok(a) = self.agent(agent_id) else { return };
        let s = |k: &str| input.get(k).and_then(Value::as_str).map(str::to_string);
        match event {
            "SessionStart" => {
                self.edit(|st| {
                    if let Some(x) = st.agent_mut(agent_id) {
                        if let Some(id) = s("session_id") {
                            x.session_id = id;
                        }
                        if let Some(t) = s("transcript_path") {
                            x.transcript = Some(t);
                        }
                        if let Some(m) = s("model") {
                            x.model_id = Some(m);
                        }
                        if x.state != AgentState::Paused {
                            set_state(x, AgentState::Idle);
                        }
                    }
                });
                self.signals(agent_id).session.notify_waiters();
                if a.role == Role::Lead {
                    self.maybe_nudge(&a.run_id);
                }
            }
            "UserPromptSubmit" => {
                self.settle_prompts(agent_id);
                self.edit(|st| {
                    if let Some(x) = st.agent_mut(agent_id) {
                        set_state(x, AgentState::Working);
                    }
                });
                self.signals(agent_id).prompt.notify_waiters();
            }
            "PostToolUse" => {
                self.settle_prompts(agent_id);
                let tool = s("tool_name").unwrap_or_default();
                let what = describe_tool(&tool, input.get("tool_input").unwrap_or(&Value::Null));
                self.edit(|st| {
                    if let Some(x) = st.agent_mut(agent_id) {
                        if x.state != AgentState::Paused {
                            set_state(x, AgentState::Working);
                        }
                    }
                    // the agents' own coordination calls are logged by the tools themselves
                    if !tool.starts_with("mcp__shellmosaic") && tool != "ToolSearch" {
                        st.log(&a.run_id, Some(agent_id), a.task_id.as_deref(), "tool", format!("{}: {}", a.name, short(&what, 300)), false);
                    }
                });
            }
            "Stop" => {
                self.settle_prompts(agent_id);
                let background = input.get("background_tasks").and_then(Value::as_array).is_some_and(|b| !b.is_empty());
                let last = s("last_assistant_message").map(|m| short(&m, 4000));
                self.edit(|st| {
                    let mut open_task = None;
                    if let Some(x) = st.agent_mut(agent_id) {
                        if last.is_some() {
                            x.last_message = last.clone();
                        }
                        if x.state != AgentState::Paused {
                            set_state(x, if background { AgentState::Working } else { AgentState::Idle });
                        }
                        open_task = x.task_id.clone();
                    }
                    // a worker that stops without complete_task: the lead decides what's next
                    if let (Some(t), Role::Worker, false) = (open_task, a.role, background) {
                        let said = last.as_deref().map(|m| format!(": \"{}\"", short(m, 600))).unwrap_or_default();
                        st.log(&a.run_id, Some(agent_id), Some(&t), "agent.stopped", format!("{} stopped without finishing {t}{said}", a.name), true);
                    }
                });
                if a.role == Role::Lead {
                    self.maybe_nudge(&a.run_id);
                }
            }
            "Notification" => match s("notification_type").as_deref() {
                Some("permission_prompt") => self.edit(|st| {
                    if let Some(x) = st.agent_mut(agent_id) {
                        if x.state == AgentState::Working {
                            set_state(x, AgentState::Waiting);
                        }
                    }
                }),
                // also how an interrupted turn (no Stop hook) ends up idle
                Some("idle_prompt") => {
                    self.edit(|st| {
                        if let Some(x) = st.agent_mut(agent_id) {
                            if matches!(x.state, AgentState::Working | AgentState::Waiting) {
                                set_state(x, AgentState::Idle);
                            }
                        }
                    });
                    if a.role == Role::Lead {
                        self.maybe_nudge(&a.run_id);
                    }
                }
                _ => {}
            },
            "SessionEnd" => {
                // `/clear` ends one session and starts the next; anything else is the process leaving
                if s("reason").as_deref() != Some("clear") {
                    self.settle_prompts(agent_id);
                }
            }
            _ => {}
        }
    }

    fn on_status(&self, agent_id: &str, input: &Value) -> String {
        let Ok(a) = self.agent(agent_id) else { return String::new() };
        let model_id = input.pointer("/model/id").and_then(Value::as_str).map(str::to_string);
        let display = input.pointer("/model/display_name").and_then(Value::as_str).unwrap_or(&a.model).to_string();
        let ctx = input.pointer("/context_window/used_percentage").and_then(Value::as_f64);
        let cost = input.pointer("/cost/total_cost_usd").and_then(Value::as_f64);
        let limits = input.get("rate_limits").filter(|v| v.is_object()).cloned();
        let changed = model_id != a.model_id || ctx != a.context_pct || cost != a.cost_usd || limits.is_some();
        if changed {
            self.edit(|st| {
                if let Some(x) = st.agent_mut(agent_id) {
                    if model_id.is_some() {
                        x.model_id = model_id;
                    }
                    x.context_pct = ctx.or(x.context_pct);
                    x.cost_usd = cost.or(x.cost_usd);
                }
                if let Some(l) = limits {
                    st.usage = Some(json!({ "rateLimits": l, "at": now_ms() }));
                }
            });
        }
        let task = a.task_id.map(|t| format!(" · {t}")).unwrap_or_default();
        let ctx = ctx.map(|c| format!(" · ctx {c:.0}%")).unwrap_or_default();
        format!("{}{task} · {display}{ctx}", a.name)
    }

    /// `notify_user`
    pub fn notice(&self, agent_id: &str, text: &str) {
        let Ok(a) = self.agent(agent_id) else { return };
        self.host.notice(&format!("{}: {}", a.name, short(text, 300)), "info");
        self.edit(|st| st.log(&a.run_id, Some(agent_id), None, "notice", format!("{}: {}", a.name, short(text, 1000)), false));
    }

    /// `report_progress`
    pub fn progress(&self, agent_id: &str, text: &str) {
        let Ok(a) = self.agent(agent_id) else { return };
        self.edit(|st| st.log(&a.run_id, Some(agent_id), a.task_id.as_deref(), "progress", format!("{}: {}", a.name, short(text, 500)), false));
    }

    /// Recent conversation of an agent, for the lead (its transcript; the screen as a fallback).
    pub fn read_output(&self, agent_id: &str, max_entries: usize) -> Result<String, String> {
        let a = self.agent(agent_id)?;
        if let Some(t) = a.transcript.as_deref().filter(|t| Path::new(t).is_file()) {
            return Ok(super::transcript::recent(Path::new(t), max_entries, 12_000));
        }
        let text = self.host.text(&a.pane_id, 32 * 1024).unwrap_or_default();
        let lines: Vec<&str> = text.lines().filter(|l| !l.trim().is_empty()).collect();
        Ok(lines[lines.len().saturating_sub(80)..].join("\n"))
    }

    /// A short text overview for the lead's `status` tool.
    pub fn status_text(&self, run: &str) -> String {
        let st = self.st.lock();
        let mut s = String::new();
        s.push_str("Workers:\n");
        let mut any = false;
        for w in st.workers(run) {
            any = true;
            let task = w.task_id.as_deref().map(|t| format!(", on {t}")).unwrap_or_default();
            s.push_str(&format!("- {} ({}): {:?}{task}, model {}\n", w.slot, w.name, w.state, w.model_id.as_deref().unwrap_or(&w.model)).to_lowercase());
        }
        if !any {
            s.push_str("- none yet (assign_task starts one)\n");
        }
        s.push_str("Tasks:\n");
        for t in st.tasks.iter().filter(|t| t.run_id == run) {
            let who = t.assignee.as_deref().and_then(|a| st.agent(a)).map(|a| format!(" [{}]", a.slot)).unwrap_or_default();
            s.push_str(&format!("- {} {:?}{who}: {}\n", t.id, t.status, t.title));
        }
        let pending: Vec<&Request> = st.requests.iter().filter(|q| q.run_id == run && q.status == RequestStatus::Pending).collect();
        if !pending.is_empty() {
            s.push_str("Waiting:\n");
            for q in pending {
                let who = st.agent(&q.agent_id).map(|a| a.slot.clone()).unwrap_or_default();
                let kind = if q.kind == RequestKind::Question { "question for you" } else { "permission from the user" };
                s.push_str(&format!("- {} ({who}, {kind}): {}\n", q.id, short(&q.summary, 200)));
            }
        }
        s
    }

    /// Something in the team can still produce events for the lead (a task on a worker, a
    /// worker starting or in a turn, a question waiting). Otherwise `wait` would wait for nothing.
    pub fn in_progress(&self, run: &str) -> bool {
        let st = self.st.lock();
        st.tasks.iter().any(|t| t.run_id == run && matches!(t.status, TaskStatus::Assigned | TaskStatus::Working))
            || st.workers(run).any(|w| w.task_id.is_some() || matches!(w.state, AgentState::Starting | AgentState::Working | AgentState::Waiting))
            || st.requests.iter().any(|q| q.run_id == run && q.status == RequestStatus::Pending)
    }

    /// The branches of the tasks a worker did.
    fn branches_of(&self, agent_id: &str) -> Vec<String> {
        self.st.lock().tasks.iter().filter(|t| t.assignee.as_deref() == Some(agent_id)).filter_map(|t| t.branch.clone()).collect()
    }

    /// Run of an agent (for tools).
    pub fn run_of(&self, agent_id: &str) -> Option<String> {
        self.st.lock().agent(agent_id).map(|a| a.run_id.clone())
    }

    pub fn questions_of_run(&self, run: &str, req: &str) -> bool {
        self.st.lock().requests.iter().any(|q| q.id == req && q.run_id == run && q.kind == RequestKind::Question)
    }
}

impl Gate for Core {
    fn authenticate(&self, agent: &str, token: &str, client_pid: u32) -> Result<(), String> {
        let (expected, proc_) = {
            let st = self.st.lock();
            (st.tokens.get(agent).cloned(), st.procs.get(agent).copied())
        };
        let expected = expected.ok_or("unknown or stopped agent")?;
        // constant time: don't leak how much of a guessed token was right
        let ok = expected.len() == token.len() && expected.bytes().zip(token.bytes()).fold(0u8, |acc, (a, b)| acc | (a ^ b)) == 0;
        if !ok {
            return Err("wrong token".into());
        }
        let (pid, created) = proc_.ok_or("the agent's process isn't known")?;
        if !procs::descends_from(client_pid, pid, created, 8) {
            return Err("the caller doesn't run under the agent's Claude Code".into());
        }
        Ok(())
    }

    fn tool_host(&self, agent: &str) -> Option<Arc<dyn ToolHost>> {
        let role = self.st.lock().agent(agent).map(|a| a.role)?;
        Some(Arc::new(tools::AgentTools::new(self.arc(), agent.to_string(), role)))
    }

    fn hook(&self, agent: &str, event: &str, input: Value) -> BoxFut<Value> {
        if event == "PermissionRequest" {
            return Box::pin(self.arc().permission(agent.to_string(), input));
        }
        self.on_hook(agent, event, &input);
        Box::pin(async { Value::Null })
    }

    fn status(&self, agent: &str, input: Value) -> String {
        self.on_status(agent, &input)
    }
}
