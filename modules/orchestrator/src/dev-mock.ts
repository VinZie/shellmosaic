// A simulated Orchestrator for `node modules/build.mjs --dev orchestrator`, in exactly the
// shapes of shared/api.ts. Workspace "dev" has a running team (a lead and three workers,
// one waiting on a permission prompt), ~25 tasks in every status, pending and answered
// requests, and an earlier stopped team. A ticker moves the work along: tool calls, tasks
// finishing and being accepted, new prompts, a request that times out.
//
// URL: ?scenario=empty|team|merge|requests|trust|slow  ?usage=85|96  ?nousage  ?deny=agents.manage
//      ?app=0.3.0  ?elevated  ?conflict  ?dirty  ?branch (repo on another branch)  ?still (no ticker)  ?light
import type {
  Agent,
  AgentActivity,
  AgentRequest,
  AgentRun,
  AgentSnapshot,
  AgentState,
  AgentTask,
  MergePreview,
  PaneContext,
  Routing,
  TaskDiff,
  TaskStatus,
} from "../../shared/api";
import { installMock } from "../../shared/mock";

const q = new URLSearchParams(location.search);
const SCENARIO = q.get("scenario") ?? "team";
const APP = q.get("app") ?? "0.4.0";
const NOW = Date.now();
const MIN = 60_000;
const HOUR = 60 * MIN;
const ROOT = "C:\\Users\\dev\\src\\shellmosaic";
const WT = "C:\\Users\\dev\\src\\shellmosaic.wt";

const later = <T>(v: T, ms = 60) => new Promise<T>((r) => setTimeout(() => r(structuredClone(v)), ms));
const fail = (msg: string, ms = 200) => new Promise<never>((_, rej) => setTimeout(() => rej(new Error(msg)), ms));

// ── the world ───────────────────────────────────────────────────────────

const ROUTING: Routing = {
  lead: { model: "opus", effort: "high" },
  levels: [
    { model: "haiku", effort: "medium" },
    { model: "sonnet", effort: "medium" },
    { model: "sonnet", effort: "high" },
    { model: "opus", effort: "high" },
    { model: "opus", effort: "xhigh" },
  ],
  maxWorkers: 3,
  maxOpusWorkers: 1,
  sonnetAbove: 80,
  noHireAbove: 95,
};

const W = {
  rev: 1,
  seq: 0,
  runs: [] as AgentRun[],
  agents: [] as Agent[],
  tasks: [] as AgentTask[],
  requests: [] as AgentRequest[],
  activity: [] as AgentActivity[],
  routing: structuredClone(ROUTING),
  usage: null as AgentSnapshot["usage"],
  nextTask: 0,
  nextReq: 0,
  repos: new Set<string>([ROOT.toLowerCase(), "c:\\users\\dev\\src\\website"]),
};

const listeners = new Set<(d: unknown) => void>();
function changed() {
  W.rev++;
  listeners.forEach((l) => l({ rev: W.rev }));
}

function log(runId: string, agentId: string | null, taskId: string | null, kind: string, text: string, lead = false, t = Date.now()) {
  W.activity.push({ seq: ++W.seq, t, runId, agentId, taskId, kind, text, ...(lead ? { lead: true } : {}) });
}

function agent(run: AgentRun, slot: string, model: string, modelId: string | null, effort: string, state: AgentState, extra: Partial<Agent> = {}): Agent {
  const lead = slot === "lead";
  return {
    id: `${run.id}-${slot}`,
    runId: run.id,
    role: lead ? "lead" : "worker",
    slot,
    name: lead ? "Lead" : `Worker ${slot.slice(1)}`,
    paneId: `pane-${run.id}-${slot}`,
    model,
    modelId,
    effort,
    sessionId: crypto.randomUUID(),
    transcript: null,
    state,
    stateSince: Date.now() - 4 * MIN,
    taskId: null,
    lastTaskId: null,
    used: true,
    cwd: lead ? run.root : `${WT}\\${slot}`,
    branch: null,
    contextPct: lead ? 31 : 12,
    costUsd: lead ? 2.84 : 0.61,
    pid: 10_000 + Math.floor(Math.random() * 20_000),
    lastMessage: null,
    createdAt: run.createdAt,
    ...extra,
  };
}

interface Seed {
  title: string;
  description: string;
  difficulty: number;
  status: TaskStatus;
  who?: string;
  summary?: string;
  attempts?: number;
  failures?: number;
  followUpOf?: string;
}

const SEEDS: Seed[] = [
  {
    title: "Add a cursor blink-rate setting",
    description: "Settings → Terminal: a blink rate (slow / normal / fast) next to \"Cursor blink\". Apply it live to every terminal. Add it to the settings schema with a default of normal.",
    difficulty: 1,
    status: "done",
    who: "w2",
    summary: "Added terminal.cursorBlinkRate (slow/normal/fast, default normal) to the schema and the Terminal section; termRegistry applies it live. pnpm typecheck passes.",
  },
  {
    title: "Fix tab drag ghost on high-DPI screens",
    description: "Dragging a tab on a 150% display shows the ghost image offset by the scale. Use devicePixelRatio in the drag layer. Check at 100%, 125% and 150%.",
    difficulty: 2,
    status: "done",
    who: "w1",
    summary: "The drag layer positioned the ghost in device pixels. Divided by devicePixelRatio in dnd.ts; checked by hand at 100/125/150%.",
  },
  { title: "Extract pane layout helpers into layout.ts", description: "Move the split-tree functions out of model.ts.", difficulty: 2, status: "done", who: "w2", summary: "Moved 9 pure functions to layout.ts with their tests; model.ts re-exports the types. No behavior change." },
  { title: "Write tests for the routing table", description: "Unit tests for Routing.sanitized() and level().", difficulty: 2, status: "done", who: "w1", summary: "8 tests: clamping, missing levels filled from defaults, opus cap above max workers." },
  { title: "Make the module store retry downloads", description: "Retry a failed module download twice with backoff before reporting it.", difficulty: 3, status: "done", who: "w3", summary: "Two retries with 1 s and 3 s backoff; the error names the file that failed." },
  { title: "Event Viewer: remember column widths per channel", description: "", difficulty: 2, status: "done", who: "w2", summary: "Column state is keyed by channel now." },
  { title: "Speed up the Files pane for 10 000-entry folders", description: "Profile, then virtualize the list.", difficulty: 4, status: "done", who: "w3", summary: "Virtualized the list (render ~60 rows); first paint of C:\\Windows\\WinSxS went from 2.3 s to 140 ms." },
  { title: "Debounce Git status refreshes", description: "", difficulty: 1, status: "done", who: "w2", summary: "One refresh per 400 ms burst of file events." },
  { title: "SFTP: keep the transfer list after reconnecting", description: "", difficulty: 2, status: "done", who: "w1", summary: "The list lives in the pane state now." },
  {
    title: "Agents tab: show context window use",
    description: "A Context column in the Orchestrator's Agents table, from the statusLine's context_window.used_percentage.",
    difficulty: 2,
    status: "review",
    who: "w2",
    summary: "Added the Context column (hidden until an agent reports it) and a row in the details. Verified with the dev mock; typecheck clean.",
  },
  {
    title: "Rework the restore marker for alt-screen apps",
    description: "Programs in the alternate screen (vim, Claude Code) must not leave their frame above the marker.",
    difficulty: 4,
    status: "review",
    who: "w3",
    summary: "Reset modes before the marker, ?1049l only when the alt screen is active; replay at the saved size. Tested with headless xterm.js against recordings of vim and Claude Code.",
    attempts: 2,
    failures: 1,
  },
  {
    title: "Port scanner: show the owning service",
    description: "For svchost ports, show the service name.",
    difficulty: 3,
    status: "failed",
    who: "w1",
    summary: "Blocked: QueryServiceStatusEx needs SERVICE_QUERY_STATUS per service, and enumerating every service on each refresh is too slow (~900 ms). Needs a cache design decision from the lead.",
    attempts: 2,
    failures: 2,
  },
  { title: "Keyboard shortcut cheat sheet", description: "A searchable overlay of every shortcut (F1).", difficulty: 2, status: "working", who: "w1" },
  { title: "Theme editor: import VS Code themes", description: "Map a VS Code color theme JSON to our theme keys.", difficulty: 3, status: "working", who: "w3" },
  { title: "Notes: export a note as PDF", description: "", difficulty: 2, status: "queued" },
  { title: "Process Inspector: copy a thread's stack", description: "", difficulty: 3, status: "queued" },
  { title: "Workspace templates", description: "Save a workspace's tabs and panes as a template; new workspaces can start from one.", difficulty: 4, status: "queued" },
  { title: "Rename the \"magnify\" command to \"zoom pane\"", description: "", difficulty: 1, status: "queued" },
  { title: "Log viewer: follow log rotation", description: "", difficulty: 3, status: "queued" },
  { title: "Tab overflow menu", description: "", difficulty: 2, status: "cancelled", summary: undefined },
  { title: "Try a Rust-side pane layout engine", description: "", difficulty: 5, status: "cancelled" },
  { title: "Follow-up: cheat sheet search ranks prefixes first", description: "", difficulty: 1, status: "queued", followUpOf: "t13" },
  { title: "Status bar clock option", description: "", difficulty: 1, status: "done", who: "w2", summary: "Added; off by default." },
  { title: "Fix the about dialog in light themes", description: "", difficulty: 1, status: "done", who: "w2", summary: "The logo used a hard-coded white; it follows --text now." },
  { title: "Port scanner: owning service (cached)", description: "Cache service lookups for 30 s, as the lead decided.", difficulty: 3, status: "assigned", who: "w1", followUpOf: "t12" },
];

function seed() {
  const usagePct = Number(q.get("usage") ?? 42);
  if (!q.has("nousage")) {
    W.usage = {
      rateLimits: {
        five_hour: { used_percentage: usagePct, resets_at: Math.round((NOW + 2.2 * HOUR) / 1000) },
        seven_day: { used_percentage: Math.min(100, Math.round(usagePct * 0.55)), resets_at: Math.round((NOW + 3.6 * 24 * HOUR) / 1000) },
      },
      at: NOW - 40_000,
    };
  }

  // an earlier team, stopped yesterday
  const old: AgentRun = { id: "a1b2c3", name: "website", workspaceId: "dev", tabId: null, root: "C:\\Users\\dev\\src\\website", baseBranch: "main", status: "stopped", leadId: "a1b2c3-lead", createdAt: NOW - 26 * HOUR };
  W.runs.push(old);
  W.agents.push(agent(old, "lead", "opus", "claude-opus-5-5", "high", "stopped", { costUsd: 6.1, contextPct: 64, lastMessage: "Everything is merged into orch/integration. Merge it into main when you're ready." }));
  W.agents.push(agent(old, "w1", "sonnet", "claude-sonnet-5-5", "medium", "exited", { costUsd: 1.9 }));
  for (const [title, st] of [
    ["Landing page: new hero section", "done"],
    ["Fix broken links in the docs", "done"],
    ["Compress the screenshots", "done"],
    ["Dark mode for the docs", "failed"],
  ] as const) {
    W.nextTask++;
    W.tasks.push(task(old, `t${W.nextTask}`, { title, description: "", difficulty: 2, status: st, who: "w1", summary: st === "done" ? "Done and checked." : "Ran out of time." }, NOW - 25 * HOUR));
  }
  log(old.id, null, null, "run.start", `Started the team in ${old.root}`, false, NOW - 26 * HOUR);
  log(old.id, null, null, "run.stop", "Stopped the team", false, NOW - 22 * HOUR);

  if (SCENARIO === "empty") return;

  if (SCENARIO === "trust" || SCENARIO === "slow") {
    // a team just started in a folder Claude Code doesn't trust yet, or one slow to start
    const run: AgentRun = { id: "5d0c4b", name: "research", workspaceId: "dev", tabId: "tab-team", root: "C:\\Users\\dev\\src\\research", baseBranch: "master", status: "active", leadId: "5d0c4b-lead", createdAt: NOW - 40_000 };
    W.runs.push(run);
    const lead = agent(run, "lead", "opus", null, "high", SCENARIO === "trust" ? "waiting" : "starting", { contextPct: null, costUsd: null, used: false, stateSince: NOW - 30_000 });
    W.agents.push(lead);
    log(run.id, lead.id, null, "run.start", `Started the team in ${run.root}`, false, run.createdAt);
    if (SCENARIO === "trust") req(run, lead, "permission", "Trust", `trust the folder ${run.root}`, { folder: run.root }, false, NOW - 28_000);
    else log(run.id, lead.id, null, "agent.slow", "Lead hasn't started after 20 s. Look at its pane: Claude Code may be waiting for you there.", false, NOW - 10_000);
    return;
  }

  const run: AgentRun = { id: "7f3e9a", name: "shellmosaic", workspaceId: "dev", tabId: "tab-team", root: ROOT, baseBranch: "main", status: "active", leadId: "7f3e9a-lead", createdAt: NOW - 2 * HOUR };
  W.runs.push(run);
  const lead = agent(run, "lead", "opus", "claude-opus-5-5", "high", "working", {
    contextPct: 38,
    costUsd: 4.27,
    lastMessage: "Assigned t17 (cheat sheet) to Worker 1 and t18 (VS Code themes) to Worker 3. t14 and t15 are finished and waiting for review.",
  });
  const w1 = agent(run, "w1", "sonnet", "claude-sonnet-5-5", "medium", "waiting", { contextPct: 22, costUsd: 1.12 });
  const w2 = agent(run, "w2", "haiku", "claude-haiku-5-5", "medium", "idle", { contextPct: 9, costUsd: 0.18, lastMessage: "Done: the Context column is in, typecheck is clean. Committed as 4c1d2e0." });
  const w3 = agent(run, "w3", "opus", "claude-opus-5-5", "high", "working", { contextPct: 47, costUsd: 3.05 });
  W.agents.push(lead, w1, w2, w3);

  SEEDS.forEach((s, i) => {
    W.nextTask++;
    const id = `t${W.nextTask}`;
    // the seeds' own numbering (t13 = the 13th seed) refers to this run's tasks
    const fixed: Seed = { ...s, followUpOf: s.followUpOf ? `t${4 + Number(s.followUpOf.slice(1))}` : undefined };
    const t = task(run, id, fixed, NOW - 2 * HOUR + i * 4 * MIN);
    W.tasks.push(t);
    log(run.id, null, id, "task.created", `New task ${id}: ${t.title}`, false, t.createdAt);
    if (t.assignee) log(run.id, t.assignee, id, "task.assigned", `${id} → ${W.agents.find((a) => a.id === t.assignee)?.name} (${t.model})`, false, t.createdAt + MIN);
    if (t.status === "done") log(run.id, t.assignee, id, "task.done", `Accepted ${id}: Merged orch/${run.id}/${id} into orch/integration.`, false, t.updatedAt);
    if (t.status === "review") log(run.id, t.assignee, id, "task.review", `${W.agents.find((a) => a.id === t.assignee)?.name} finished ${id} "${t.title}": ${t.summary}`, true, t.updatedAt);
    if (t.status === "failed") log(run.id, t.assignee, id, "task.blocked", `${W.agents.find((a) => a.id === t.assignee)?.name} is blocked on ${id} "${t.title}": ${t.summary}`, true, t.updatedAt);
  });
  const byTitle = (s: string) => W.tasks.find((t) => t.runId === run.id && t.title.startsWith(s))!;
  w1.taskId = byTitle("Keyboard shortcut").id;
  w1.branch = byTitle("Keyboard shortcut").branch;
  w3.taskId = byTitle("Theme editor").id;
  w3.branch = byTitle("Theme editor").branch;
  w2.lastTaskId = byTitle("Agents tab").id;
  w2.branch = byTitle("Agents tab").branch;

  // requests: two waiting for you, one for the lead, and a history
  req(run, w1, "permission", "Bash", "run `cargo test -p shellmosaic --lib agents`", { command: "cargo test -p shellmosaic --lib agents", description: "Run the agents unit tests" }, true, NOW - 70_000);
  req(run, w3, "question", null, "The VS Code theme has 300+ token colors but we only have 16 ANSI slots. Should I map the closest token colors to ANSI, or only import the editor/terminal colors and leave syntax colors out?", null, false, NOW - 3 * MIN);
  req(run, w1, "permission", "WebFetch", "fetch https://code.visualstudio.com/api/references/theme-color", { url: "https://code.visualstudio.com/api/references/theme-color", prompt: "List the terminal.* color keys" }, false, NOW - 20_000);
  const hist: [Agent, "permission" | "question", string | null, string, AgentRequest["status"], string, string | null][] = [
    [w2, "permission", "PowerShell", "run `pnpm typecheck`", "allowed", "you", null],
    [w3, "permission", "Write", "create C:\\Users\\dev\\src\\shellmosaic.wt\\w3\\scripts\\bench.ps1", "allowed", "terminal", null],
    [w1, "permission", "Bash", "run `rm -rf node_modules && pnpm install`", "denied", "you", "Don't reinstall; pnpm install alone is enough."],
    [w1, "question", null, "Should the cheat sheet include plugin shortcuts?", "answered", "lead", "Yes, under a separate heading per plugin."],
    [w2, "permission", "PowerShell", "run `git stash`", "closed", "timeout", null],
    [lead, "permission", "PowerShell", "run `git log --oneline -20 orch/integration`", "allowed", "you", null],
  ];
  hist.forEach(([a, kind, tool, summary, status, by, answer], i) => {
    const r = req(run, a, kind, tool, summary, tool === "Write" ? { file_path: summary.slice(7), content: "param([int]$n = 5)\n" } : null, false, NOW - (90 - i * 12) * MIN);
    r.status = status;
    r.answeredBy = by;
    r.answer = answer;
    r.answeredAt = r.createdAt + 40_000;
  });
  for (let i = 0; i < 40; i++) {
    const a = [w1, w2, w3][i % 3];
    log(run.id, a.id, a.taskId, "tool", `${a.name}: ${pick(TOOLS)}`, false, NOW - 80 * MIN + i * 2 * MIN);
  }
  log(run.id, null, null, "run.start", `Started the team in ${ROOT}`, false, run.createdAt);
  W.activity.sort((a, b) => a.t - b.t).forEach((a, i) => (a.seq = i + 1));
  W.seq = W.activity.length;
}

function task(run: AgentRun, id: string, s: Seed, created: number): AgentTask {
  const who = s.who ? `${run.id}-${s.who}` : null;
  const model = who ? W.agents.find((a) => a.id === who)?.model ?? "sonnet" : null;
  return {
    id,
    runId: run.id,
    title: s.title,
    description: s.description || `${s.title}. Keep the change focused; verify with pnpm typecheck and by trying it in the app.`,
    difficulty: s.difficulty,
    status: s.status,
    assignee: who,
    followUpOf: s.followUpOf ?? null,
    model,
    branch: who || s.status === "done" ? `orch/${run.id}/${id}` : null,
    summary: s.summary ?? null,
    attempts: s.attempts ?? (who ? 1 : 0),
    failures: s.failures ?? (s.status === "failed" ? 1 : 0),
    createdAt: created,
    updatedAt: s.status === "queued" ? created : created + 25 * MIN,
  };
}

function req(run: AgentRun, a: Agent, kind: "permission" | "question", tool: string | null, summary: string, detail: unknown, suggestions: boolean, t: number): AgentRequest {
  const r: AgentRequest = {
    id: `r${++W.nextReq}`,
    runId: run.id,
    agentId: a.id,
    kind,
    tool,
    summary,
    detail,
    suggestions: suggestions ? [{ type: "addRules", rules: [{ toolName: tool, ruleContent: "cargo test:*" }], behavior: "allow", destination: "session" }] : null,
    status: "pending",
    answeredBy: null,
    answer: null,
    createdAt: t,
    answeredAt: null,
  };
  W.requests.push(r);
  log(run.id, a.id, a.taskId, "request", kind === "permission" ? `${a.name} asks to ${summary} (${r.id})` : `${a.name} asks (${r.id}): ${summary}`, kind === "question", t);
  return r;
}

const TOOLS = [
  "read C:\\Users\\dev\\src\\shellmosaic.wt\\w1\\src\\state\\commands.ts",
  "edit C:\\Users\\dev\\src\\shellmosaic.wt\\w1\\src\\components\\CheatSheet.tsx",
  "run `pnpm typecheck`",
  "use Grep",
  "read C:\\Users\\dev\\src\\shellmosaic.wt\\w3\\src\\state\\themes.ts",
  "edit C:\\Users\\dev\\src\\shellmosaic.wt\\w3\\src\\settings\\ThemeEditor.tsx",
  "run `cargo check`",
  "create C:\\Users\\dev\\src\\shellmosaic.wt\\w3\\src\\lib\\vscodeTheme.ts",
  "run `git status --short`",
];
const pick = <T>(a: T[]) => a[Math.floor(Math.random() * a.length)];

// ── the ticker ──────────────────────────────────────────────────────────

let ticks = 0;
function tick() {
  ticks++;
  const run = W.runs.find((r) => r.status === "active");
  if (!run) return;
  const agents = W.agents.filter((a) => a.runId === run.id);
  for (const a of agents.filter((x) => x.state === "working")) {
    if (a.role === "worker" && Math.random() < 0.7) log(run.id, a.id, a.taskId, "tool", `${a.name}: ${pick(TOOLS)}`);
    a.contextPct = Math.min(95, (a.contextPct ?? 0) + 0.6);
    a.costUsd = (a.costUsd ?? 0) + 0.03;
  }
  const u = W.usage?.rateLimits.five_hour;
  if (u?.used_percentage !== undefined && u.used_percentage < 99) u.used_percentage = Math.round((u.used_percentage + 0.15) * 100) / 100;

  // a queued task starts on an idle worker
  if (ticks % 5 === 0) {
    const idle = agents.find((a) => a.role === "worker" && a.state === "idle" && !a.taskId);
    const next = W.tasks.find((t) => t.runId === run.id && t.status === "queued");
    if (idle && next) startTask(run, next, idle);
  }
  // a task gets finished
  if (ticks % 9 === 0) {
    const busy = agents.find((a) => a.role === "worker" && a.state === "working" && a.taskId);
    const t = busy && W.tasks.find((x) => x.id === busy.taskId);
    if (busy && t) {
      t.status = "review";
      t.summary = `Implemented "${t.title}". Verified with pnpm typecheck and by hand in the dev build; nothing left open.`;
      t.updatedAt = Date.now();
      busy.lastTaskId = t.id;
      busy.taskId = null;
      busy.state = "idle";
      busy.stateSince = Date.now();
      busy.lastMessage = `Finished ${t.id}: ${t.summary}`;
      log(run.id, busy.id, t.id, "task.review", `${busy.name} finished ${t.id} "${t.title}" [2 commit(s), 3 file(s), +84 −12]: ${t.summary}`, true);
    }
  }
  // the lead reviews
  if (ticks % 13 === 0) {
    const lead = agents.find((a) => a.role === "lead")!;
    const t = W.tasks.find((x) => x.runId === run.id && x.status === "review");
    lead.state = "working";
    lead.stateSince = Date.now();
    if (t) {
      t.status = "done";
      t.updatedAt = Date.now();
      log(run.id, t.assignee, t.id, "task.done", `Accepted ${t.id}: Merged ${t.branch} into orch/integration.`);
    }
  }
  if (ticks % 13 === 6) {
    const lead = agents.find((a) => a.role === "lead")!;
    lead.state = "idle";
    lead.stateSince = Date.now();
  }
  // a new prompt now and then; old ones time out (the real hook waits an hour)
  if (ticks % 17 === 0) {
    const a = agents.find((x) => x.role === "worker" && x.state === "working");
    if (a) {
      a.state = "waiting";
      a.stateSince = Date.now();
      req(run, a, "permission", "PowerShell", `run \`${pick(["pnpm test", "cargo build --release", "git diff --stat"])}\``, { command: "pnpm test" }, Math.random() < 0.5, Date.now());
    }
  }
  for (const r of W.requests) {
    if (r.status === "pending" && r.kind === "permission" && Date.now() - r.createdAt > 150_000 && r.id !== "r1") {
      r.status = "closed";
      r.answeredBy = "terminal";
      r.answeredAt = Date.now();
      const a = W.agents.find((x) => x.id === r.agentId);
      if (a?.state === "waiting") a.state = "working";
    }
  }
  if (W.usage) W.usage.at = Date.now();
  changed();
}

function startTask(run: AgentRun, t: AgentTask, w: Agent, model = w.model) {
  t.status = "assigned";
  t.assignee = w.id;
  t.model = model;
  t.branch = `orch/${run.id}/${t.id}`;
  t.attempts++;
  t.updatedAt = Date.now();
  w.taskId = t.id;
  w.branch = t.branch;
  w.state = "working";
  w.stateSince = Date.now();
  log(run.id, w.id, t.id, "task.assigned", `${t.id} → ${w.name} (${w.model})`);
  setTimeout(() => {
    if (t.status === "assigned") {
      t.status = "working";
      changed();
    }
  }, 1200);
}

// ── the API ─────────────────────────────────────────────────────────────

const view = (): AgentSnapshot => ({
  rev: W.rev,
  lastSeq: W.seq,
  runs: W.runs,
  agents: W.agents,
  tasks: W.tasks,
  requests: W.requests,
  usage: W.usage,
  routing: W.routing,
  elevated: q.has("elevated"),
});

const denied = (q.get("deny") ?? "").split(",").filter(Boolean);
const manage = <T>(fn: () => T | Promise<T>): Promise<T> => {
  if (denied.includes("agents.manage")) return fail("permission denied: agents.manage", 50);
  try {
    const r = fn();
    changed();
    return r instanceof Promise ? r : later(r);
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e));
  }
};

const find = <T extends { id: string }>(list: T[], id: string, what: string): T => {
  const x = list.find((i) => i.id === id);
  if (!x) throw new Error(`There's no such ${what}.`);
  return x;
};

function diffFor(t: AgentTask): TaskDiff {
  const slug = t.title.replace(/[^a-z]+/gi, "").slice(0, 18) || "Feature";
  const diff = [
    `diff --git a/src/state/settings.ts b/src/state/settings.ts`,
    `index 3f1a2c0..9be47d1 100644`,
    `--- a/src/state/settings.ts`,
    `+++ b/src/state/settings.ts`,
    `@@ -41,6 +41,8 @@ export interface TerminalSettings {`,
    `   cursorStyle: "block" | "bar" | "underline";`,
    `   cursorBlink: boolean;`,
    `+  /** ${t.title} */`,
    `+  ${slug.charAt(0).toLowerCase() + slug.slice(1)}: boolean;`,
    `   scrollback: number;`,
    `   fontFamily: string;`,
    `@@ -120,7 +122,7 @@ export const DEFAULTS: Settings = {`,
    `-    cursorBlink: true,`,
    `+    cursorBlink: true,`,
    `+    ${slug.charAt(0).toLowerCase() + slug.slice(1)}: false,`,
    `diff --git a/src/components/${slug}.tsx b/src/components/${slug}.tsx`,
    `new file mode 100644`,
    `index 0000000..b71c2e4`,
    `--- /dev/null`,
    `+++ b/src/components/${slug}.tsx`,
    `@@ -0,0 +1,14 @@`,
    `+import { useSettings } from "../state/settings";`,
    `+`,
    `+export function ${slug}() {`,
    `+  const on = useSettings((s) => s.settings.terminal.cursorBlink);`,
    `+  return (`,
    `+    <div className="${slug.toLowerCase()}">`,
    `+      {on ? "On" : "Off"}`,
    `+    </div>`,
    `+  );`,
    `+}`,
  ].join("\n");
  return { branch: t.branch!, commits: 2, files: 2, added: 14, removed: 1, diff, truncated: false };
}

function preview(run: AgentRun): MergePreview {
  const done = W.tasks.filter((t) => t.runId === run.id && t.status === "done").length;
  const files = ["src/state/settings.ts", "src/settings/sections/Terminal.tsx", "src/modules/terminal/termRegistry.ts", "src/lib/dnd.ts", "src/state/layout.ts", "src/state/model.ts", "src/modules/files/FilesPane.tsx", "src-tauri/src/store.rs"];
  return {
    base: run.baseBranch ?? "main",
    integration: "orch/integration",
    commits: done * 2,
    files: done ? files : [],
    added: done * 61,
    removed: done * 17,
    conflicts: q.has("conflict") ? ["src/state/settings.ts"] : [],
    dirtyOverlap: q.has("dirty") ? ["src/modules/terminal/termRegistry.ts"] : [],
    current: q.has("branch") ? "feature/notes-pdf" : run.baseBranch,
  };
}

export function install() {
  seed();
  const unsupported = (name: string) => () => fail(`unknown method: agents.${name}`, 30);
  const old = APP.localeCompare("0.4.0", undefined, { numeric: true }) < 0;
  const agentsApi = {
    snapshot: () => later(view(), 40),
    activity: (o: { runId?: string; after?: number; limit?: number; latest?: boolean } = {}) => {
      const list = W.activity.filter((a) => a.seq > (o.after ?? 0) && (!o.runId || a.runId === o.runId));
      const n = o.limit ?? 500;
      return later(o.latest ? list.slice(-n) : list.slice(0, n), 50);
    },
    reveal: (id: string) => later(!!find(W.agents, id, "agent"), 0),
    start: (o: { cwd?: string; name?: string } = {}) =>
      manage(() => {
        const cwd = (o.cwd ?? ROOT).trim();
        if (q.has("elevated")) throw new Error("Shellmosaic runs as administrator, and its agents would too. Restart Shellmosaic normally to use the Orchestrator.");
        if (/empty/i.test(cwd)) throw new Error("no-commits: the repository has no commits yet; commit something first");
        if (/untrusted/i.test(cwd)) throw new Error("this repository's settings can run programs: trust it in the Git pane first (open a Git pane in " + cwd + ")");
        if (!W.repos.has(cwd.toLowerCase())) throw new Error(`not-a-repo: ${cwd} isn't in a git repository`);
        if (W.runs.some((r) => r.workspaceId === "dev" && r.status === "active")) throw new Error("This workspace already has a running team.");
        const id = Math.random().toString(16).slice(2, 8);
        const run: AgentRun = { id, name: o.name || cwd.split("\\").pop() || "team", workspaceId: "dev", tabId: null, root: cwd, baseBranch: "main", status: "active", leadId: `${id}-lead`, createdAt: Date.now() };
        W.runs.push(run);
        const lead = agent(run, "lead", W.routing.lead.model, null, W.routing.lead.effort, "starting", { contextPct: null, costUsd: null, lastMessage: null });
        W.agents.push(lead);
        log(id, lead.id, null, "run.start", `Started the team in ${cwd}`);
        setTimeout(() => {
          lead.state = "idle";
          lead.modelId = "claude-opus-5-5";
          lead.stateSince = Date.now();
          changed();
        }, 1500);
        return run;
      }),
    gitInit: (cwd: string) => manage(() => (W.repos.add(cwd.toLowerCase()), true)),
    stopRun: (runId: string) =>
      manage(() => {
        const run = find(W.runs, runId, "run");
        run.status = "stopped";
        for (const a of W.agents.filter((x) => x.runId === runId)) a.state = "stopped";
        for (const r of W.requests.filter((x) => x.runId === runId && x.status === "pending")) (r.status = "closed"), (r.answeredBy = "stopped");
        for (const t of W.tasks.filter((x) => x.runId === runId && (x.status === "working" || x.status === "assigned"))) (t.status = "queued"), (t.assignee = null);
        log(runId, null, null, "run.stop", "Stopped the team");
        return true;
      }),
    forgetRun: (runId: string) =>
      manage(() => {
        W.runs = W.runs.filter((r) => r.id !== runId);
        W.agents = W.agents.filter((a) => a.runId !== runId);
        W.tasks = W.tasks.filter((t) => t.runId !== runId);
        W.requests = W.requests.filter((r) => r.runId !== runId);
        return true;
      }),
    hire: (runId: string, o: { model?: string } = {}) =>
      manage(() => {
        const run = find(W.runs, runId, "run");
        const used = W.agents.filter((a) => a.runId === runId && a.role === "worker").map((a) => a.slot);
        const slot = ["w1", "w2", "w3"].find((s) => !used.includes(s));
        if (!slot) throw new Error("The team is full (3 workers). Dismiss one or wait for one to finish.");
        const a = agent(run, slot, o.model ?? "sonnet", null, "medium", "starting", { contextPct: null, costUsd: null });
        W.agents.push(a);
        log(runId, a.id, null, "agent.hired", `Started ${a.name} (${a.model})`);
        return a;
      }),
    remove: (agentId: string) =>
      manage(() => {
        const a = find(W.agents, agentId, "agent");
        if (a.role === "lead") throw new Error("The lead can't be removed: stop the whole team instead.");
        for (const t of W.tasks.filter((t) => t.assignee === agentId && (t.status === "working" || t.status === "assigned"))) (t.status = "queued"), (t.assignee = null);
        W.agents = W.agents.filter((x) => x.id !== agentId);
        log(a.runId, null, a.taskId, "agent.removed", `Removed ${a.name}`, true);
        return true;
      }),
    resume: (agentId: string) =>
      manage(() => {
        const a = find(W.agents, agentId, "agent");
        a.state = a.taskId ? "working" : "idle";
        a.stateSince = Date.now();
        return true;
      }),
    interrupt: (agentId: string, o: { pause?: boolean } = {}) =>
      manage(() => {
        const a = find(W.agents, agentId, "agent");
        a.state = o.pause ? "paused" : "idle";
        a.stateSince = Date.now();
        log(a.runId, a.id, a.taskId, "agent.interrupt", `${o.pause ? "Paused" : "Interrupted"} ${a.name}`);
        return true;
      }),
    send: (agentId: string, text: string) =>
      manage(() => {
        const a = find(W.agents, agentId, "agent");
        a.state = "working";
        a.stateSince = Date.now();
        log(a.runId, a.id, null, "notice", `You → ${a.name}: ${text}`);
        return true;
      }),
    answer: (requestId: string, ans: { allow?: boolean; always?: boolean; text?: string }) =>
      manage(() => {
        const r = find(W.requests, requestId, "request");
        if (r.status !== "pending") throw new Error(`That request was already handled (${r.answeredBy ?? "closed"}).`);
        r.status = ans.allow === true ? "allowed" : ans.allow === false ? "denied" : "answered";
        r.answeredBy = "you";
        r.answer = ans.always ? "always" : ans.text ?? null;
        r.answeredAt = Date.now();
        const a = W.agents.find((x) => x.id === r.agentId);
        if (a && r.tool === "Trust") {
          // trusted: the session starts; not trusted: the team stops
          if (ans.allow) (a.state = "idle"), (a.stateSince = Date.now());
          else for (const x of W.agents.filter((x) => x.runId === a.runId)) x.state = "stopped";
          if (!ans.allow) find(W.runs, a.runId, "run").status = "stopped";
        } else if (a?.state === "waiting") a.state = "working";
        return true;
      }),
    createTask: (runId: string, t: { title: string; description: string; difficulty: number; followUpOf?: string }) =>
      manage(() => {
        const run = find(W.runs, runId, "run");
        const task: AgentTask = {
          id: `t${++W.nextTask}`,
          runId,
          title: t.title,
          description: t.description,
          difficulty: t.difficulty,
          status: "queued",
          assignee: null,
          followUpOf: t.followUpOf ?? null,
          model: null,
          branch: null,
          summary: null,
          attempts: 0,
          failures: 0,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        };
        W.tasks.push(task);
        log(run.id, null, task.id, "task.created", `New task ${task.id}: ${task.title}`);
        return task;
      }),
    assign: (taskId: string, agentId?: string) =>
      manage(() => {
        const t = find(W.tasks, taskId, "task");
        const run = find(W.runs, t.runId, "run");
        if (t.status !== "queued" && t.status !== "failed") throw new Error(`task ${t.id} is ${t.status}, not queued or failed.`);
        const level = W.routing.levels[Math.min(5, t.difficulty + (t.failures >= 2 ? 1 : 0)) - 1];
        let w = agentId ? W.agents.find((a) => a.id === agentId || (a.runId === run.id && a.slot === agentId)) : W.agents.find((a) => a.runId === run.id && a.role === "worker" && !a.taskId && a.state !== "paused");
        if (!w) {
          const used = W.agents.filter((a) => a.runId === run.id && a.role === "worker").map((a) => a.slot);
          const slot = agentId && /^w[1-3]$/.test(agentId) ? agentId : ["w1", "w2", "w3"].find((s) => !used.includes(s));
          if (!slot || used.length >= W.routing.maxWorkers) throw new Error("All workers are busy and the team is full.");
          w = agent(run, slot, level.model, null, level.effort, "starting", { contextPct: null, costUsd: null });
          W.agents.push(w);
          log(run.id, w.id, null, "agent.hired", `Started ${w.name} (${w.model})`);
        }
        if (w.taskId) throw new Error(`${w.name} is busy with ${w.taskId}.`);
        startTask(run, t, w, level.model);
        return w.id;
      }),
    cancelTask: (taskId: string) =>
      manage(() => {
        const t = find(W.tasks, taskId, "task");
        t.status = "cancelled";
        t.updatedAt = Date.now();
        for (const a of W.agents.filter((a) => a.taskId === taskId)) (a.taskId = null), (a.state = "idle");
        log(t.runId, t.assignee, t.id, "task.cancelled", `Cancelled ${t.id}`, true);
        return true;
      }),
    review: (taskId: string, accept: boolean, note?: string) =>
      manage(() => {
        const t = find(W.tasks, taskId, "task");
        if (accept) {
          if (q.has("conflict")) throw new Error(`${t.branch} conflicts with orch/integration in: src/state/settings.ts. Ask the worker to merge orch/integration into its branch and resolve it (a follow-up task), then review again.`);
          t.status = "done";
          t.updatedAt = Date.now();
          log(t.runId, t.assignee, t.id, "task.done", `Accepted ${t.id}: Merged ${t.branch} into orch/integration.`);
          return `Merged ${t.branch} into orch/integration.`;
        }
        t.status = "working";
        t.attempts++;
        t.failures++;
        const w = W.agents.find((a) => a.id === t.assignee);
        if (w) (w.taskId = t.id), (w.state = "working");
        log(t.runId, t.assignee, t.id, "task.rework", `${t.id} sent back to ${w?.name ?? "its worker"}: ${note}`);
        return `Sent ${t.id} back to ${w?.name ?? "its worker"}.`;
      }),
    setRouting: (r: Routing, base?: Routing) =>
      manage(() => {
        if (base && JSON.stringify(base) !== JSON.stringify(W.routing)) throw new Error("The routing changed meanwhile; look at it again.");
        W.routing = structuredClone(r);
        return W.routing;
      }),
    taskDiff: (taskId: string) => {
      const t = W.tasks.find((x) => x.id === taskId);
      return t?.branch ? later(diffFor(t), 250) : fail("That task has no branch yet.");
    },
    mergePreview: (runId: string) => later(preview(find(W.runs, runId, "run")), 300),
    mergeToBase: (runId: string) =>
      manage(() => {
        const run = find(W.runs, runId, "run");
        const p = preview(run);
        if (p.current !== p.base) throw new Error(`Your repository is on ${p.current} now; switch it back to ${p.base} to merge the team's work into it.`);
        if (p.conflicts.length) throw new Error("orch/integration conflicts with main.");
        log(runId, null, null, "run.merged", `Merged ${p.commits} commit(s) from orch/integration into ${p.base}.`, true);
        return `Merged ${p.commits} commit(s) from orch/integration into ${p.base}.`;
      }),
  };
  installMock(
    {
      agents: old ? Object.fromEntries(Object.keys(agentsApi).map((k) => [k, unsupported(k)])) : agentsApi,
      claude: {
        usage: () =>
          later(
            {
              fetchedAt: Date.now(),
              plan: { subscription: "max", tier: "default_claude_max_20x" },
              usage: { five_hour: { utilization: 37, resets_at: new Date(NOW + 3 * HOUR).toISOString() }, seven_day: { utilization: 19, resets_at: new Date(NOW + 4 * 24 * HOUR).toISOString() } },
            },
            150,
          ),
      },
    } as never,
    "orchestrator",
  );

  // the stand-in grants nothing by default; this module's manifest asks for these
  const granted = ["agents.read", "agents.manage", "claude.usage"].filter((p) => !denied.includes(p));
  const onRequests = SCENARIO === "requests" || SCENARIO === "trust";
  const args = SCENARIO === "merge" ? { open: "merge" } : onRequests ? { tab: "requests" } : null;
  const sdk = window.shellmosaic as unknown as { ready: Promise<PaneContext>; context: () => Promise<PaneContext>; on: (e: string, fn: (d: unknown) => void) => () => void };
  const patch = <T extends PaneContext>(c: T): T => ({ ...c, grantedPermissions: granted, args, appVersion: APP, cwd: ROOT, state: onRequests ? { tab: "requests" } : c.state });
  sdk.ready = sdk.ready.then(patch);
  const context = sdk.context;
  sdk.context = () => context().then(patch);
  sdk.on = (event, fn) => {
    if (event !== "agents") return () => {};
    listeners.add(fn);
    return () => listeners.delete(fn);
  };
  if (!q.has("still")) setInterval(tick, 2500);
}
