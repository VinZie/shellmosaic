//! The Orchestrator's records as the UI and the agents' tools see them: runs, agents,
//! tasks, requests and the activity log.

use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "lowercase")]
pub enum Role {
    Lead,
    Worker,
}

#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "camelCase")]
pub enum AgentState {
    /// launched, Claude Code hasn't started its session yet
    Starting,
    /// waiting for input
    Idle,
    /// a turn is running (or a backgrounded tool call)
    Working,
    /// a permission prompt is open
    Waiting,
    /// interrupted by Pause; the process is still there
    Paused,
    /// no process: paused for too long, stopped, or Shellmosaic restarted
    Stopped,
    /// the process ended on its own
    Exited,
}

impl AgentState {
    /// A process is (supposed to be) running.
    pub fn live(self) -> bool {
        !matches!(self, AgentState::Stopped | AgentState::Exited)
    }
}

#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "camelCase")]
pub enum RunStatus {
    Active,
    Stopped,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Run {
    pub id: String,
    pub name: String,
    pub workspace_id: String,
    /// the tab holding the agent panes (the UI creates it and reports it back)
    pub tab_id: Option<String>,
    /// repository root (main worktree)
    pub root: String,
    /// the user's branch when the run started: approved work is merged into it
    pub base_branch: Option<String>,
    pub status: RunStatus,
    pub lead_id: String,
    pub created_at: i64,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Agent {
    pub id: String,
    pub run_id: String,
    pub role: Role,
    /// "lead", "w1", "w2", "w3"
    pub slot: String,
    pub name: String,
    pub pane_id: String,
    /// what it was launched with: an alias ("opus", "sonnet", "haiku") or a full model id
    pub model: String,
    /// the model statusLine reports (the source of truth once known)
    #[serde(default)]
    pub model_id: Option<String>,
    pub effort: String,
    /// current Claude Code session (`/clear` starts a new one)
    pub session_id: String,
    #[serde(default)]
    pub transcript: Option<String>,
    pub state: AgentState,
    pub state_since: i64,
    #[serde(default)]
    pub task_id: Option<String>,
    /// the task this session worked on last (a follow-up of it continues the conversation)
    #[serde(default)]
    pub last_task_id: Option<String>,
    /// the session has worked on a task: the next one that isn't a follow-up clears it first
    #[serde(default)]
    pub used: bool,
    /// working folder (the worker's own worktree; the repo root for the lead)
    pub cwd: String,
    #[serde(default)]
    pub branch: Option<String>,
    #[serde(default)]
    pub context_pct: Option<f64>,
    #[serde(default)]
    pub cost_usd: Option<f64>,
    #[serde(default)]
    pub pid: Option<u32>,
    #[serde(default)]
    pub last_message: Option<String>,
    pub created_at: i64,
}

#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "camelCase")]
pub enum TaskStatus {
    Queued,
    /// handed to a worker, not acknowledged yet
    Assigned,
    Working,
    /// the worker finished; the lead reviews it
    Review,
    Done,
    Failed,
    Cancelled,
}

impl TaskStatus {
    pub fn open(self) -> bool {
        matches!(self, TaskStatus::Queued | TaskStatus::Assigned | TaskStatus::Working | TaskStatus::Review)
    }
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Task {
    pub id: String,
    pub run_id: String,
    pub title: String,
    pub description: String,
    /// 1 (mechanical) … 5 (hard); picks the model
    pub difficulty: u8,
    pub status: TaskStatus,
    #[serde(default)]
    pub assignee: Option<String>,
    /// continues in the worker's current conversation instead of a fresh one
    #[serde(default)]
    pub follow_up_of: Option<String>,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub branch: Option<String>,
    #[serde(default)]
    pub summary: Option<String>,
    #[serde(default)]
    pub attempts: u32,
    /// times it failed, was blocked or was sent back: after two it runs one level up
    #[serde(default)]
    pub failures: u32,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "camelCase")]
pub enum RequestKind {
    /// a Claude Code permission prompt (answered by the user, here or in the pane)
    Permission,
    /// a worker's question for the lead (`ask_lead`)
    Question,
}

#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "camelCase")]
pub enum RequestStatus {
    Pending,
    Allowed,
    Denied,
    Answered,
    /// nobody answered in time, or the agent moved on (answered in its pane, interrupted)
    Closed,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Request {
    pub id: String,
    pub run_id: String,
    pub agent_id: String,
    pub kind: RequestKind,
    /// Claude Code's tool name (permission requests)
    #[serde(default)]
    pub tool: Option<String>,
    /// one line: what it wants to do, or the question
    pub summary: String,
    /// the tool input (trimmed), for the details view
    #[serde(default)]
    pub detail: Option<Value>,
    /// Claude Code's own "don't ask again" rules for this prompt (what "Allow always" applies)
    #[serde(default)]
    pub suggestions: Option<Value>,
    pub status: RequestStatus,
    /// "you", "terminal", "lead", "timeout"
    #[serde(default)]
    pub answered_by: Option<String>,
    #[serde(default)]
    pub answer: Option<String>,
    pub created_at: i64,
    #[serde(default)]
    pub answered_at: Option<i64>,
}

/// One line of the activity log. `lead` marks the events the lead's `wait` returns.
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Activity {
    pub seq: u64,
    pub t: i64,
    pub run_id: String,
    #[serde(default)]
    pub agent_id: Option<String>,
    #[serde(default)]
    pub task_id: Option<String>,
    /// machine-readable kind: "task.done", "agent.idle", "tool", "request", …
    pub kind: String,
    pub text: String,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub lead: bool,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ModelChoice {
    /// an alias ("opus", "sonnet", "haiku") or a full model id
    pub model: String,
    /// low | medium | high | xhigh | max
    pub effort: String,
}

impl ModelChoice {
    fn new(model: &str, effort: &str) -> Self {
        Self { model: model.into(), effort: effort.into() }
    }
}

/// Which model runs what, and the limits on the team (the Routing tab).
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct Routing {
    pub lead: ModelChoice,
    /// by task difficulty, 1 to 5
    pub levels: Vec<ModelChoice>,
    pub max_workers: u8,
    /// workers on an Opus model at the same time
    pub max_opus_workers: u8,
    /// at this share (%) of the 5-hour or weekly plan limit, workers get at most Sonnet
    pub sonnet_above: u8,
    /// at this share, no new workers start
    pub no_hire_above: u8,
}

impl Default for Routing {
    fn default() -> Self {
        Self {
            lead: ModelChoice::new("opus", "high"),
            levels: vec![
                ModelChoice::new("haiku", "medium"),
                ModelChoice::new("sonnet", "medium"),
                ModelChoice::new("sonnet", "high"),
                ModelChoice::new("opus", "high"),
                ModelChoice::new("opus", "xhigh"),
            ],
            max_workers: 3,
            max_opus_workers: 1,
            sonnet_above: 80,
            no_hire_above: 95,
        }
    }
}

impl Routing {
    /// Within what the Orchestrator supports, every level present.
    pub fn sanitized(mut self) -> Self {
        let d = Self::default();
        self.levels.truncate(5);
        while self.levels.len() < 5 {
            self.levels.push(d.levels[self.levels.len()].clone());
        }
        self.max_workers = self.max_workers.clamp(1, 3);
        self.max_opus_workers = self.max_opus_workers.min(self.max_workers);
        self.sonnet_above = self.sonnet_above.clamp(1, 100);
        self.no_hire_above = self.no_hire_above.clamp(1, 100);
        self
    }

    pub fn level(&self, difficulty: u8) -> &ModelChoice {
        &self.levels[(difficulty.clamp(1, 5) - 1) as usize]
    }
}

/// Everything the UI shows, except the activity log (paged separately).
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub rev: u64,
    pub last_seq: u64,
    pub runs: Vec<Run>,
    pub agents: Vec<Agent>,
    pub tasks: Vec<Task>,
    pub requests: Vec<Request>,
    /// the latest plan usage any agent's statusLine reported (`rate_limits`)
    pub usage: Option<Value>,
    pub routing: Routing,
    pub elevated: bool,
}

/// What the UI is asked to do with panes (the frontend owns the layout model).
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase", rename_all_fields = "camelCase", tag = "op")]
pub enum PaneRequest {
    /// put an existing agent's pane into the run's tab (creating the tab if needed)
    Add { run_id: String, workspace_id: String, tab_id: Option<String>, pane_id: String, agent_id: String, title: String },
    /// the agent is gone: close its pane
    Remove { pane_id: String },
}
