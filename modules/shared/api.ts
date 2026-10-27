// The Shellmosaic plugin SDK (window.shellmosaic, v2) as typed by the optional modules.
//
// This file is also the contract for the Rust side: every result type below is
// exactly the JSON a Tauri command in src-tauri/src returns (serde camelCase), and
// the broker (src/modules/plugin/broker.ts) passes it through unchanged.
//
// Big numbers: memory addresses and affinity masks don't fit a JS number, so they
// travel as strings ("0x00007ff6a1b20000" / decimal masks). Sizes and counts are numbers.

// ── host / pane ─────────────────────────────────────────────────────────

export interface PaneContext {
  pluginId: string;
  paneId: string;
  tabId: string;
  workspaceId: string | null;
  cwd: string | null;
  visible: boolean;
  grantedPermissions: string[];
  /** what opened this pane passed (e.g. {pid} from Processes → Inspect); null when opened from the module bar */
  args: Record<string, unknown> | null;
  /** what the module last saved with ui.setState (kept with the layout, restored after a restart) */
  state: Record<string, unknown> | null;
  appVersion: string;
  /** Shellmosaic runs as administrator */
  elevated: boolean;
}

export interface FileFilter {
  name: string;
  extensions: string[];
}

/** Modules a plugin may open next to itself, and what each accepts. */
export type OpenModule =
  | { module: "processes"; filter?: string }
  | { module: "ports"; filter?: string }
  | { module: "files"; path?: string }
  | { module: "git"; path?: string }
  | { module: `plugin:${string}`; args?: Record<string, unknown> };

// ── process.inspect ─────────────────────────────────────────────────────

/** Same as the Processes module's list. */
export interface ProcListItem {
  pid: number;
  ppid: number | null;
  name: string;
  cpu: number;
  mem: number;
  exe: string | null;
  status: string;
  runTime: number;
}

export type PriorityClass = "idle" | "belowNormal" | "normal" | "aboveNormal" | "high" | "realtime";

export interface Mitigation {
  /** "dep" | "aslr" | "dynamicCode" | "strictHandles" | "systemCalls" | "extensionPoints" | "cfg" | "signature" | "fonts" | "imageLoad" | "childProcess" | "shadowStack" */
  id: string;
  /** "DEP", "ASLR", "Control Flow Guard", … */
  name: string;
  enabled: boolean;
  /** the policy's flags that are on, e.g. ["High entropy", "Force relocate images"] */
  details: string[];
}

export interface ProcOverview {
  pid: number;
  ppid: number | null;
  /** null when the parent has exited (or its PID was reused by a younger process) */
  parentName: string | null;
  name: string;
  path: string | null;
  commandLine: string | null;
  currentDirectory: string | null;
  /** "DOMAIN\\user" */
  user: string | null;
  userSid: string | null;
  sessionId: number | null;
  /** "Untrusted" | "Low" | "Medium" | "Medium Plus" | "High" | "System" | "Protected" */
  integrity: string | null;
  elevated: boolean | null;
  elevationType: "default" | "full" | "limited" | null;
  virtualization: "enabled" | "disabled" | "notAllowed" | null;
  /** "None", "PPL (Antimalware)", "PP (WinTcb)", … */
  protection: string | null;
  /** "x64", "x86 (WOW64)", "ARM64", … */
  architecture: string | null;
  /** Unix ms */
  startTime: number | null;
  cpuKernelMs: number;
  cpuUserMs: number;
  workingSet: number;
  peakWorkingSet: number;
  privateBytes: number;
  virtualSize: number;
  ioReadBytes: number;
  ioWriteBytes: number;
  ioOtherBytes: number;
  handleCount: number;
  threadCount: number;
  priorityClass: PriorityClass | null;
  basePriority: number;
  /** decimal bit masks */
  affinity: string | null;
  systemAffinity: string | null;
  debugged: boolean | null;
  /** AppX/MSIX package full name */
  packageName: string | null;
  /** every thread is suspended */
  suspended: boolean;
  mitigations: Mitigation[];
  /** what couldn't be read for lack of access: "commandLine", "currentDirectory", "user", "integrity", "mitigations", "debugged", "affinity", … */
  denied: string[];
}

export interface ProcModule {
  name: string;
  path: string;
  /** hex address */
  base: string;
  size: number;
  /** the process's own executable */
  isMain: boolean;
  description: string | null;
  company: string | null;
  version: string | null;
}

export interface ProcThread {
  tid: number;
  /** hex; the kernel's start address (usually RtlUserThreadStart for user threads) */
  startAddress: string;
  /** "ntdll.dll+0x2c4a0", or null when it isn't inside a loaded module */
  startSymbol: string | null;
  /** hex; the start address passed to CreateThread (null without access) */
  win32StartAddress: string | null;
  win32StartSymbol: string | null;
  /** "Initialized" | "Ready" | "Running" | "Standby" | "Terminated" | "Waiting" | "Transition" | "DeferredReady" | … */
  state: string;
  /** "Suspended", "UserRequest", "DelayExecution", "WrQueue", …; null unless Waiting */
  waitReason: string | null;
  priority: number;
  basePriority: number;
  contextSwitches: number;
  kernelMs: number;
  userMs: number;
  /** Unix ms */
  createTime: number | null;
  /** SetThreadDescription name */
  description: string | null;
  suspendCount: number | null;
  suspended: boolean;
}

export interface ProcHandle {
  /** hex handle value */
  handle: string;
  /** "File", "Key", "Event", "Process", "Thread", "Section", "Mutant", "Token", "ALPC Port", … */
  type: string;
  /** file paths as C:\…, keys as HKLM\… / HKCU\…, processes as "name.exe (1234)", threads as "name.exe (1234): 5678" */
  name: string | null;
  /** granted access mask */
  access: number;
  /** OBJ_INHERIT 0x2, OBJ_PROTECT_CLOSE 0x1, OBJ_AUDIT_OBJECT_CLOSE 0x4 */
  attributes: number;
  handleCount: number;
  pointerCount: number;
  /** for Process/Thread handles: the process they point at */
  targetPid: number | null;
}

export interface TokenGroup {
  name: string | null;
  sid: string;
  attributes: number;
  /** "Mandatory", "EnabledByDefault", "Enabled", "Owner", "DenyOnly", "Integrity", "IntegrityEnabled", "LogonId", "Resource" */
  flags: string[];
}

export interface TokenPrivilege {
  /** "SeDebugPrivilege" */
  name: string;
  /** "Debug programs" */
  description: string | null;
  enabled: boolean;
  enabledByDefault: boolean;
  removed: boolean;
}

export interface ProcToken {
  user: string | null;
  userSid: string;
  owner: string | null;
  primaryGroup: string | null;
  integrity: string | null;
  integrityRid: number | null;
  sessionId: number;
  elevated: boolean;
  elevationType: "default" | "full" | "limited";
  tokenType: "primary" | "impersonation";
  /** only for impersonation tokens: "anonymous" | "identification" | "impersonation" | "delegation" */
  impersonationLevel: string | null;
  /** hex LUIDs */
  logonId: string;
  tokenId: string;
  /** token source name, e.g. "User32" */
  source: string | null;
  virtualizationAllowed: boolean;
  virtualizationEnabled: boolean;
  uiAccess: boolean;
  appContainer: boolean;
  appContainerSid: string | null;
  groups: TokenGroup[];
  privileges: TokenPrivilege[];
  capabilities: { name: string | null; sid: string }[];
}

export interface MemRegion {
  /** hex */
  base: string;
  allocationBase: string;
  size: number;
  state: "commit" | "reserve" | "free";
  type: "image" | "mapped" | "private" | null;
  /** "R", "RW", "RX", "RWX", "WC" (write-copy), "WCX", "NA" (no access), "X"; "+G" guard, "+NC" no-cache, "+WCB" write-combine; "" for free/reserved */
  protect: string;
  protectRaw: number;
  allocationProtect: string;
  /** module or mapped file path, "Stack (TID 123)", "TEB (TID 123)", "PEB", "Heap 2", … */
  usage: string | null;
}

export interface Signature {
  status: "valid" | "unsigned" | "invalid" | "unknown";
  /** human text: "Signed", "Not signed", "The file was changed after it was signed", … */
  detail: string;
  /** subject of the signing certificate, e.g. "Microsoft Windows" */
  signer: string | null;
  /** signed through a security catalog rather than an embedded signature */
  catalog: boolean;
}

// ── eventlog.read ───────────────────────────────────────────────────────

export interface EventChannel {
  /** "Application", "Microsoft-Windows-Sysmon/Operational", … */
  name: string;
  enabled: boolean;
  kind: "admin" | "operational" | "analytic" | "debug" | "classic";
}

export interface EventLogInfo {
  records: number | null;
  fileSize: number | null;
  /** Unix ms */
  lastWrite: number | null;
  oldestRecord: number | null;
}

/**
 * One page of a query. `events` are event XML strings: the formatted form (with
 * <RenderingInfo> holding Message, Level, Task, Opcode, Keywords) when the
 * provider's message files are available, otherwise the raw <Event> XML.
 */
export interface EventPage {
  /** pass to eventlog.more for the next page; null when the query is finished (or `done`) */
  cursor: number | null;
  events: string[];
  /** no more events */
  done: boolean;
  /** events looked at for this page (more than events.length when a text filter is set) */
  scanned: number;
}

export interface EventQuery {
  channel: string;
  /** an XPath event filter such as "*[System[(Level=1 or Level=2)]]"; omit for every event */
  xpath?: string;
  /** newest first (default true) */
  reverse?: boolean;
  /** case-insensitive text every returned event's XML must contain */
  text?: string;
  /** events per page (1–1000, default 200) */
  max?: number;
}

// ── sqlite ──────────────────────────────────────────────────────────────

export interface DbInfo {
  id: number;
  /** the file the user opened */
  path: string;
  /** file name */
  file: string;
  /** opened from a temporary copy (the original was locked, or a copy was asked for) */
  copied: boolean;
  copyReason: string | null;
  writable: boolean;
  size: number;
  sqliteVersion: string;
  pageSize: number;
  pageCount: number;
  encoding: string;
  journalMode: string;
  userVersion: number;
  applicationId: number;
  freelistCount: number;
}

export interface DbColumn {
  cid: number;
  name: string;
  /** declared type, "" when none */
  type: string;
  notNull: boolean;
  default: string | null;
  /** position in the primary key (1-based), 0 when not part of it */
  pk: number;
  /** 0 normal, 1 hidden (virtual tables), 2 generated virtual, 3 generated stored */
  hidden: number;
}

export interface DbIndex {
  name: string;
  unique: boolean;
  /** "c" CREATE INDEX, "u" UNIQUE constraint, "pk" PRIMARY KEY */
  origin: string;
  partial: boolean;
  columns: string[];
}

export interface DbForeignKey {
  id: number;
  table: string;
  from: string;
  to: string | null;
  onUpdate: string;
  onDelete: string;
}

export interface SchemaObject {
  type: "table" | "view" | "index" | "trigger";
  name: string;
  /** table an index/trigger belongs to */
  tblName: string;
  sql: string | null;
  withoutRowid: boolean;
  /** CREATE VIRTUAL TABLE */
  virtual: boolean;
  /** tables and views */
  columns: DbColumn[];
  /** tables */
  indexes: DbIndex[];
  foreignKeys: DbForeignKey[];
}

/**
 * A result cell. Plain JSON where it fits; otherwise tagged:
 * integers beyond ±2^53 → {$int}, non-finite reals → {$real}, text over 100 000
 * characters → {$text: first part, length}, blobs → {$blob: hex of the first 256 bytes, length}.
 */
export type Cell =
  | null
  | number
  | string
  | { $int: string }
  | { $real: string }
  | { $text: string; length: number }
  | { $blob: string; length: number };

/** Query parameters: null, booleans (stored as 0/1), numbers, text, or {$blob: hex}. */
export type Param = null | boolean | number | string | { $blob: string };

export interface QueryResult {
  columns: { name: string; declType: string | null }[];
  /** rows of the last statement that returns rows */
  rows: Cell[][];
  /** more rows existed than maxRows */
  truncated: boolean;
  /** rows changed by the statements (INSERT/UPDATE/DELETE) */
  changes: number;
  lastInsertRowid: number;
  elapsedMs: number;
  /** statements run */
  statements: number;
  /** some statement returned rows (columns/rows are meaningful) */
  returnedRows: boolean;
}

// ── agents (the Orchestrator; src-tauri/src/agents/proto.rs) ─────────────

export type AgentRole = "lead" | "worker";
/** starting → idle ⇄ working (waiting: a permission prompt is open); paused (Esc, process kept); stopped (no process); exited (ended on its own) */
export type AgentState = "starting" | "idle" | "working" | "waiting" | "paused" | "stopped" | "exited";
/** queued → assigned → working → review → done; failed / cancelled */
export type TaskStatus = "queued" | "assigned" | "working" | "review" | "done" | "failed" | "cancelled";
export type RequestStatus = "pending" | "allowed" | "denied" | "answered" | "closed";

export interface AgentRun {
  id: string;
  /** the repository folder's name unless named */
  name: string;
  workspaceId: string;
  /** the tab holding the agents' panes */
  tabId: string | null;
  /** repository root */
  root: string;
  /** the user's branch when the team started (approved work goes there) */
  baseBranch: string | null;
  status: "active" | "stopped";
  leadId: string;
  createdAt: number;
}

export interface Agent {
  id: string;
  runId: string;
  role: AgentRole;
  /** "lead", "w1", "w2", "w3" */
  slot: string;
  /** "Lead", "Worker 1", … */
  name: string;
  paneId: string;
  /** what it was started with: "opus" | "sonnet" | "haiku" or a full model id */
  model: string;
  /** what its statusLine reports, e.g. "claude-sonnet-5-5" (null until it started) */
  modelId: string | null;
  effort: string;
  sessionId: string;
  transcript: string | null;
  state: AgentState;
  /** Unix ms */
  stateSince: number;
  taskId: string | null;
  lastTaskId: string | null;
  used: boolean;
  /** its worktree (the repository root for the lead) */
  cwd: string;
  branch: string | null;
  /** context window used, % */
  contextPct: number | null;
  costUsd: number | null;
  pid: number | null;
  /** its last reply (the text it ended its turn with) */
  lastMessage: string | null;
  createdAt: number;
}

export interface AgentTask {
  /** "t1", "t2", … */
  id: string;
  runId: string;
  title: string;
  description: string;
  /** 1–5; picks the model (Routing) */
  difficulty: number;
  status: TaskStatus;
  /** agent id */
  assignee: string | null;
  followUpOf: string | null;
  /** the model it ran on */
  model: string | null;
  branch: string | null;
  /** the worker's report (complete_task) */
  summary: string | null;
  attempts: number;
  /** times it failed, was blocked or sent back; from 2 on it runs one difficulty level up */
  failures: number;
  createdAt: number;
  updatedAt: number;
}

export interface AgentRequest {
  /** "r1", "r2", … */
  id: string;
  runId: string;
  agentId: string;
  /** permission: a Claude Code permission prompt (the user's to answer); question: a worker's ask_lead */
  kind: "permission" | "question";
  /** Claude Code tool name ("Bash", "PowerShell", "Write", "mcp__…") */
  tool: string | null;
  /** one line: "run `cargo test`", "create C:\…\x.rs", or the question */
  summary: string;
  /** the tool's input (long strings shortened) */
  detail: unknown;
  /** Claude Code's own "don't ask again" rules; answering with always applies them for the session */
  suggestions: unknown;
  status: RequestStatus;
  /** "you" | "lead" | "terminal" (settled in the agent's pane) | "timeout" | "cancelled" | "restart" (Shellmosaic restarted) | "stopped" (team stopped) | "removed" (agent removed) | "gone" (nothing was waiting for the answer any more) */
  answeredBy: string | null;
  answer: string | null;
  createdAt: number;
  answeredAt: number | null;
}

export interface AgentActivity {
  seq: number;
  /** Unix ms */
  t: number;
  runId: string;
  agentId: string | null;
  taskId: string | null;
  /** "run.start" | "run.stop" | "agent.hired" | "agent.removed" | "agent.exited" | "agent.stopped" | "agent.interrupt" | "task.created" | "task.assigned" | "task.review" | "task.failed" | "task.blocked" | "task.done" | "task.rework" | "task.cancelled" | "task.undelivered" | "request" | "tool" | "progress" | "notice" */
  kind: string;
  text: string;
  /** one of the events the lead is told about */
  lead?: boolean;
}

export interface ModelChoice {
  model: string;
  /** "low" | "medium" | "high" | "xhigh" | "max" */
  effort: string;
}

export interface Routing {
  lead: ModelChoice;
  /** by task difficulty 1–5 */
  levels: ModelChoice[];
  /** 1–3 */
  maxWorkers: number;
  maxOpusWorkers: number;
  /** at this % of the 5-hour or weekly plan limit, workers get at most Sonnet */
  sonnetAbove: number;
  /** at this %, no new workers start */
  noHireAbove: number;
}

export interface TaskDiff {
  branch: string;
  commits: number;
  files: number;
  added: number;
  removed: number;
  /** unified diff against orch/integration (at most ~400 KB) */
  diff: string;
  truncated: boolean;
}

export interface MergePreview {
  /** the user's branch */
  base: string;
  /** "orch/integration" */
  integration: string;
  /** commits it would bring in (0: nothing to merge) */
  commits: number;
  files: string[];
  added: number;
  removed: number;
  /** files that would conflict (merging is refused then) */
  conflicts: string[];
  /** files the merge changes that have uncommitted changes in the user's tree (refused then) */
  dirtyOverlap: string[];
  /** the branch the user's tree is on now (must be `base` to merge) */
  current: string | null;
}

export interface AgentSnapshot {
  /** bumped on every change (the "agents" event carries it) */
  rev: number;
  /** newest activity seq */
  lastSeq: number;
  runs: AgentRun[];
  agents: Agent[];
  tasks: AgentTask[];
  requests: AgentRequest[];
  /** plan usage the agents' statusLine last reported */
  usage: { rateLimits: Record<string, { used_percentage?: number; resets_at?: number }>; at: number } | null;
  routing: Routing;
  /** Shellmosaic runs as administrator: no agent can start */
  elevated: boolean;
}

// ── the SDK object ──────────────────────────────────────────────────────

export interface ShellmosaicSdk {
  version: number;
  context(): Promise<PaneContext>;
  /** "agents": { rev } whenever the Orchestrator changed (needs agents.read) */
  on(event: "theme" | "cwd" | "visible" | "agents", fn: (data: any) => void): () => void;
  claude: {
    /** plan limits of the signed-in Claude Code account (claude.usage) */
    usage(): Promise<{ fetchedAt: number; plan: { subscription: string | null; tier: string | null }; usage: Record<string, unknown> }>;
  };
  /** agents.read: snapshot, activity, reveal; agents.manage: everything else */
  agents: {
    snapshot(): Promise<AgentSnapshot>;
    /** entries after `after`, oldest first; `latest`: the newest `limit` of them (still oldest first) */
    activity(opts?: { runId?: string; after?: number; limit?: number; latest?: boolean }): Promise<AgentActivity[]>;
    /** show the agent's pane (switches workspace and tab) */
    reveal(agentId: string): Promise<boolean>;
    /** a team in this pane's workspace, working in the repository `cwd` (default: the pane's cwd) is in.
     *  Fails with "not-a-repo: …" for a plain folder (offer gitInit) and "no-commits: …" for an empty repository. */
    start(opts?: { cwd?: string; name?: string }): Promise<AgentRun>;
    /** git init + everything committed */
    gitInit(cwd: string): Promise<boolean>;
    stopRun(runId: string): Promise<boolean>;
    /** forget a stopped team (its branches stay in the repository) */
    forgetRun(runId: string): Promise<boolean>;
    hire(runId: string, opts?: { model?: string }): Promise<Agent>;
    remove(agentId: string): Promise<boolean>;
    /** start a stopped agent again (continuing its conversation), or un-pause it */
    resume(agentId: string): Promise<boolean>;
    /** Esc; pause keeps it stopped until resumed (its process ends after 30 min) */
    interrupt(agentId: string, opts?: { pause?: boolean }): Promise<boolean>;
    /** type a message into the agent's session (the lead: what the user wants done) */
    send(agentId: string, text: string): Promise<boolean>;
    answer(requestId: string, answer: { allow: boolean; always?: boolean; text?: string } | { text: string }): Promise<boolean>;
    createTask(runId: string, task: { title: string; description: string; difficulty: number; followUpOf?: string }): Promise<AgentTask>;
    /** a queued or failed task; `agentId` may also be a slot ("w2"): a free slot starts a new worker there.
     *  Without it an idle worker is picked or a new one starts. Returns the worker's agent id. */
    assign(taskId: string, agentId?: string): Promise<string>;
    cancelTask(taskId: string): Promise<boolean>;
    /** accept (merged into orch/integration) or send back with a note; returns what happened */
    review(taskId: string, accept: boolean, note?: string): Promise<string>;
    /** `base`: the routing it was edited from (fails if it changed meanwhile) */
    setRouting(routing: Routing, base?: Routing): Promise<Routing>;
    /** a task branch's changes against orch/integration */
    taskDiff(taskId: string): Promise<TaskDiff>;
    /** what merging orch/integration into the user's branch would do */
    mergePreview(runId: string): Promise<MergePreview>;
    /** the user approved it: merge orch/integration into their branch (their working tree must be on it) */
    mergeToBase(runId: string): Promise<string>;
  };
  storage: {
    get<T = unknown>(key: string): Promise<T | null>;
    set(key: string, value: unknown): Promise<boolean>;
    all(): Promise<Record<string, unknown>>;
  };
  ui: {
    notify(message: string, kind?: "info" | "success" | "warning" | "error"): Promise<boolean>;
    setTitle(title: string): Promise<boolean>;
    /** saved with the pane (max 64 KB of JSON) and handed back in context().state */
    setState(state: Record<string, unknown> | null): Promise<boolean>;
    /** the app's own confirmation dialog */
    confirm(title: string, message: string, opts?: { okLabel?: string; danger?: boolean }): Promise<boolean>;
    /** the system "Open" dialog; the chosen path or null */
    pickFile(opts?: { title?: string; filters?: FileFilter[] }): Promise<string | null>;
    /** the folder picker; the chosen folder or null */
    pickFolder(opts?: { title?: string }): Promise<string | null>;
    /** open another module next to this pane */
    openModule(target: OpenModule): Promise<boolean>;
    /** show a local file (C:\…) selected in Explorer */
    reveal(path: string): Promise<boolean>;
  };
  app: {
    info(): Promise<{ version: string; elevated: boolean }>;
    /** asks the user, then relaunches Shellmosaic as administrator; false when they decline */
    restartAsAdmin(): Promise<boolean>;
  };
  clipboard: {
    readText(): Promise<string>;
    writeText(text: string): Promise<boolean>;
  };
  process: {
    list(): Promise<ProcListItem[]>;
    overview(pid: number): Promise<ProcOverview>;
    modules(pid: number): Promise<ProcModule[]>;
    threads(pid: number): Promise<ProcThread[]>;
    handles(pid: number): Promise<ProcHandle[]>;
    token(pid: number): Promise<ProcToken>;
    memory(pid: number): Promise<MemRegion[]>;
    /** Authenticode check of a file, embedded or catalog signature (cached by path and timestamp) */
    signature(path: string): Promise<Signature>;
    // process.control
    suspend(pid: number): Promise<boolean>;
    resume(pid: number): Promise<boolean>;
    setPriority(pid: number, priority: PriorityClass): Promise<boolean>;
    /** decimal mask */
    setAffinity(pid: number, mask: string): Promise<boolean>;
  };
  /** process.control */
  thread: {
    suspend(pid: number, tid: number): Promise<boolean>;
    resume(pid: number, tid: number): Promise<boolean>;
    terminate(pid: number, tid: number): Promise<boolean>;
  };
  eventlog: {
    channels(): Promise<EventChannel[]>;
    info(channel: string): Promise<EventLogInfo>;
    query(q: EventQuery): Promise<EventPage>;
    more(cursor: number, max?: number): Promise<EventPage>;
    close(cursor: number): Promise<boolean>;
    /** new events from now on; poll for them */
    subscribe(q: Omit<EventQuery, "reverse" | "max">): Promise<number>;
    /** events written since the last poll, oldest first */
    poll(subscription: number, max?: number): Promise<string[]>;
    unsubscribe(subscription: number): Promise<boolean>;
  };
  sqlite: {
    open(path: string, opts?: { writable?: boolean; copy?: boolean }): Promise<DbInfo>;
    schema(db: number): Promise<SchemaObject[]>;
    count(db: number, table: string): Promise<number>;
    query(db: number, sql: string, params?: Param[], opts?: { maxRows?: number }): Promise<QueryResult>;
    setWritable(db: number, writable: boolean): Promise<DbInfo>;
    interrupt(db: number): Promise<boolean>;
    close(db: number): Promise<boolean>;
  };
}
