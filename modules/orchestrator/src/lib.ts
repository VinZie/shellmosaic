// Words, colors and small derivations shared by the Orchestrator's views.
import { errorText, type Agent, type AgentRequest, type AgentRun, type AgentSnapshot, type AgentState, type AgentTask, type TaskStatus, type Tone } from "../../shared";

export const STATE_LABEL: Record<AgentState, string> = {
  starting: "Starting",
  idle: "Idle",
  working: "Working",
  waiting: "Needs you",
  paused: "Paused",
  stopped: "Stopped",
  exited: "Exited",
};

export const STATE_TONE: Record<AgentState, Tone | undefined> = {
  starting: "dim",
  idle: "success",
  working: "accent",
  waiting: "warning",
  paused: undefined,
  stopped: "dim",
  exited: "danger",
};

/** What the state means, for tooltips. */
export const STATE_HINT: Record<AgentState, string> = {
  starting: "Claude Code is starting",
  idle: "Waiting for its next message or task",
  working: "In a turn (or running a long tool call)",
  waiting: "A permission or trust prompt is open: answer it in Requests or in its pane",
  paused: "Interrupted by Pause; its session is kept (it ends after 30 minutes)",
  stopped: "No process: resume it to continue its conversation",
  exited: "Claude Code ended on its own",
};

/** The `tool` of a request that stands for Claude Code's folder trust prompt. */
export const TRUST_TOOL = "Trust";
/** Its trust prompt waits for an answer: nothing can be typed into it or interrupted until then. */
export const trustPending = (snap: AgentSnapshot, a: Agent) => snap.requests.some((q) => q.agentId === a.id && q.status === "pending" && q.tool === TRUST_TOOL);
export const TRUST_HINT = "Claude Code asks whether to trust its folder: answer in Requests or in its pane";

/** Still starting after this long: it may be stuck on a screen in its pane (a sign-in, an update notice…). */
const SLOW_START_MS = 20_000;
export const slowStart = (a: Agent, now: number) => a.state === "starting" && now - a.stateSince >= SLOW_START_MS;
export const SLOW_START_HINT = "Still starting after 20 s: look at its pane, Claude Code may be waiting for you there";

export const TASK_LABEL: Record<TaskStatus, string> = {
  queued: "Queued",
  assigned: "Starting",
  working: "Working",
  review: "To review",
  done: "Done",
  failed: "Failed",
  cancelled: "Cancelled",
};

export const TASK_TONE: Record<TaskStatus, Tone | undefined> = {
  queued: undefined,
  assigned: "accent",
  working: "accent",
  review: "warning",
  done: "success",
  failed: "danger",
  cancelled: "dim",
};

/** Sort order of task states: what needs attention first. */
export const TASK_RANK: Record<TaskStatus, number> = { review: 0, failed: 1, working: 2, assigned: 3, queued: 4, done: 5, cancelled: 6 };

export const DIFFICULTY_LABEL = ["", "Trivial", "Easy", "Normal", "Hard", "Very hard"];

export const EFFORTS = ["low", "medium", "high", "xhigh", "max"];
export const MODEL_ALIASES = ["haiku", "sonnet", "opus"];

/** "claude-sonnet-5-5" → "Sonnet 5.5"; "opus" → "Opus"; anything else as it is. */
export function modelLabel(id: string | null | undefined): string {
  if (!id) return "";
  const m = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-|$)/i.exec(id);
  if (m) return `${cap(m[1])} ${m[2]}${m[3] ? `.${m[3]}` : ""}`;
  if (MODEL_ALIASES.includes(id.toLowerCase())) return cap(id);
  return id;
}

/** The model an agent runs now: what statusLine reported, else what it was started with. */
export const agentModel = (a: Agent) => modelLabel(a.modelId ?? a.model);

export function modelFamily(id: string | null | undefined): "opus" | "sonnet" | "haiku" | "other" {
  const s = (id ?? "").toLowerCase();
  return s.includes("opus") ? "opus" : s.includes("sonnet") ? "sonnet" : s.includes("haiku") ? "haiku" : "other";
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();

export function agentById(snap: AgentSnapshot | null, id: string | null | undefined): Agent | undefined {
  return id ? snap?.agents.find((a) => a.id === id) : undefined;
}

export function runAgents(snap: AgentSnapshot, run: AgentRun): Agent[] {
  return snap.agents
    .filter((a) => a.runId === run.id)
    .sort((a, b) => (a.role === b.role ? a.slot.localeCompare(b.slot) : a.role === "lead" ? -1 : 1));
}

export const runTasks = (snap: AgentSnapshot, run: AgentRun): AgentTask[] => snap.tasks.filter((t) => t.runId === run.id);
export const runRequests = (snap: AgentSnapshot, run: AgentRun): AgentRequest[] => snap.requests.filter((q) => q.runId === run.id);

export const isLive = (a: Agent) => a.state !== "stopped" && a.state !== "exited";
export const isBusy = (a: Agent) => a.state === "working" || a.state === "waiting";

/** Task numbers sort as numbers: t2 before t10. */
export const taskNum = (id: string) => Number(id.replace(/\D/g, "")) || 0;

// ── plan usage ──────────────────────────────────────────────────────────

export interface UsageWindow {
  /** % of the limit used */
  pct: number;
  /** Unix ms */
  resetsAt: number | null;
}

export interface Usage {
  fiveHour: UsageWindow | null;
  sevenDay: UsageWindow | null;
  /** where it came from: an agent's statusLine, or Claude's usage endpoint */
  source: "agents" | "account";
  at: number;
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v.trim() && Number.isFinite(Number(v)) ? Number(v) : null);

function when(v: unknown): number | null {
  const n = num(v);
  if (n !== null) return n < 1e12 ? n * 1000 : n; // statusLine: Unix seconds
  if (typeof v === "string") {
    const t = Date.parse(v);
    return Number.isNaN(t) ? null : t;
  }
  return null;
}

/** From the snapshot (what the agents' statusLine reported). */
export function usageFromSnapshot(snap: AgentSnapshot | null): Usage | null {
  const r = snap?.usage?.rateLimits;
  if (!r) return null;
  const w = (k: string): UsageWindow | null => {
    const pct = num(r[k]?.used_percentage);
    return pct === null ? null : { pct, resetsAt: when(r[k]?.resets_at) };
  };
  const u = { fiveHour: w("five_hour"), sevenDay: w("seven_day") };
  return u.fiveHour || u.sevenDay ? { ...u, source: "agents", at: snap!.usage!.at } : null;
}

/** From claude.usage (Claude's own usage endpoint, read leniently: its format isn't documented). */
export function usageFromAccount(res: { fetchedAt: number; usage: Record<string, unknown> } | null): Usage | null {
  const u = res?.usage as Record<string, any> | undefined;
  if (!u) return null;
  let fiveHour: UsageWindow | null = null;
  let sevenDay: UsageWindow | null = null;
  if (Array.isArray(u.limits)) {
    for (const l of u.limits) {
      const pct = num(l?.percent);
      if (pct === null || l?.scope?.model) continue;
      if (l.kind === "session") fiveHour ??= { pct, resetsAt: when(l.resets_at) };
      else if (l.kind === "weekly_all") sevenDay ??= { pct, resetsAt: when(l.resets_at) };
    }
  }
  if (!fiveHour && num(u.five_hour?.utilization) !== null) fiveHour = { pct: num(u.five_hour.utilization)!, resetsAt: when(u.five_hour.resets_at) };
  if (!sevenDay && num(u.seven_day?.utilization) !== null) sevenDay = { pct: num(u.seven_day.utilization)!, resetsAt: when(u.seven_day.resets_at) };
  return fiveHour || sevenDay ? { fiveHour, sevenDay, source: "account", at: res!.fetchedAt } : null;
}

export function usageLevel(pct: number, sonnetAbove: number, noHireAbove: number): "ok" | "warning" | "critical" {
  return pct >= noHireAbove ? "critical" : pct >= sonnetAbove ? "warning" : "ok";
}

/** "in 2 h 10 min", "in 3 days". */
export function untilText(ms: number | null, now = Date.now()): string {
  if (!ms) return "";
  const s = Math.max(0, Math.round((ms - now) / 1000));
  if (s < 60) return "in under a minute";
  if (s < 3600) return `in ${Math.round(s / 60)} min`;
  if (s < 86400) return `in ${Math.floor(s / 3600)} h ${Math.round((s % 3600) / 60)} min`;
  const d = Math.round(s / 86400);
  return `in ${d} day${d === 1 ? "" : "s"}`;
}

// ── errors ──────────────────────────────────────────────────────────────

export type ErrorKind = "not-a-repo" | "no-commits" | "untrusted" | "elevated" | "unsupported" | "permission" | "other";

/** What kind of failure a backend error text is (the backend's wording, see agents/core.rs). */
export function errorKind(e: unknown): ErrorKind {
  const t = errorText(e);
  if (t.startsWith("not-a-repo")) return "not-a-repo";
  if (t.startsWith("no-commits")) return "no-commits";
  if (/settings can run programs|trust it in the Git pane/i.test(t)) return "untrusted";
  if (/runs as administrator/i.test(t)) return "elevated";
  if (/^unknown method: agents\./.test(t)) return "unsupported";
  if (/^permission denied: agents\./.test(t)) return "permission";
  return "other";
}

/** The message without the machine-readable prefix ("not-a-repo: …"). */
export function errorMessage(e: unknown): string {
  return errorText(e).replace(/^(not-a-repo|no-commits):\s*/, "");
}
