// Typed wrappers around the Rust commands in src-tauri/src.
import { Channel, invoke } from "@tauri-apps/api/core";

export interface Profile {
  id: string;
  name: string;
  command: string;
  args: string[];
  kind: string;
  icon?: string | null;
  color?: string | null;
  cwd?: string | null;
  env?: Record<string, string>;
  hidden?: boolean;
  custom?: boolean;
}

export interface SpawnSpec {
  profileId: string;
  command: string;
  args: string[];
  kind: string;
  env: Record<string, string>;
  cwd?: string | null;
  shellIntegration: boolean;
  restore: boolean;
  /** start from the user's default Windows environment (like Windows Terminal) */
  freshEnv: boolean;
  /** a saved SSH host's id: a remote shell instead of a local one */
  ssh?: string | null;
}

export interface AttachInfo {
  token: number;
  alive: boolean;
  spawned: boolean;
  pid?: number | null;
  cwd?: string | null;
  exitCode?: number | null;
}

export interface PtyInfo {
  alive: boolean;
  pid?: number | null;
  cwd?: string | null;
  title?: string | null;
  profileId?: string | null;
}

export type PtyMessage = ArrayBuffer | Uint8Array | number[] | { t: string; code?: number | null };

export interface FsEntry {
  name: string;
  path: string;
  isDir: boolean;
  isLink: boolean;
  hidden: boolean;
  size: number;
  modified: number;
}

export type Preview =
  | { kind: "text"; text: string; size: number; truncated: boolean }
  | { kind: "image"; dataUrl: string; size: number }
  | { kind: "binary"; size: number; head: string }
  | { kind: "directory" };

export interface SysSnapshot {
  cpu: number;
  cores: number[];
  cpuBrand: string;
  /** average clock in MHz (0 = unknown) */
  cpuFreq?: number;
  physicalCores?: number | null;
  memUsed: number;
  memTotal: number;
  swapUsed: number;
  swapTotal: number;
  netRx: number;
  netTx: number;
  /** bytes moved on all interfaces since they came up */
  netRxTotal?: number;
  netTxTotal?: number;
  disks: { name: string; mount: string; total: number; available: number; fs: string }[];
  uptime: number;
  host: string;
  os: string;
  processCount: number;
  threadCount?: number | null;
}

export interface ProcInfo {
  pid: number;
  ppid?: number | null;
  name: string;
  cpu: number;
  mem: number;
  exe?: string | null;
  status: string;
  runTime: number;
}

export interface SocketInfo {
  proto: "TCP" | "UDP";
  localAddr: string;
  localPort: number;
  remoteAddr?: string | null;
  remotePort?: number | null;
  state: string;
  pid?: number | null;
  process?: string | null;
}

export interface GitFile {
  path: string;
  index: string;
  worktree: string;
  kind: "changed" | "renamed" | "conflict" | "untracked";
}

export interface GitStatus {
  isRepo: boolean;
  root: string;
  branch: string;
  upstream?: string | null;
  ahead: number;
  behind: number;
  files: GitFile[];
  /** the repo's own settings that can run programs ("name = value"); set when it isn't trusted */
  untrusted: string[];
}

export interface GitCommit {
  hash: string;
  short: string;
  author: string;
  when: string;
  subject: string;
  refs: string;
}

export interface TaskGroup {
  source: string;
  file: string;
  icon: string;
  tasks: { name: string; command: string; detail?: string | null }[];
}

export interface PluginInfo {
  id: string;
  dir: string;
  manifest?: PluginManifest | null;
  error?: string | null;
}

export interface PluginManifest {
  id: string;
  name: string;
  version?: string;
  author?: string;
  description?: string;
  icon?: string;
  entry?: string;
  permissions?: string[];
}

export interface ExecResult {
  code?: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export interface VaultStatus {
  exists: boolean;
  unlocked: boolean;
}

export type HostAuth = "auto" | "password" | "key";

/** A saved SSH host as the webview sees it: secrets only as "has…" flags. */
export interface HostView {
  id: string;
  name: string;
  host: string;
  port: number;
  user: string;
  group: string;
  tags: string[];
  color: string | null;
  icon: string | null;
  notes: string;
  auth: HostAuth;
  keyPath: string | null;
  created: number;
  lastUsed: number | null;
  hasPassword: boolean;
  hasPassphrase: boolean;
  hasKeyData: boolean;
  /** "ssh-ed25519 SHA256:…" per trusted host key */
  knownKeys: string[];
}

/** Host editor output. Secrets: set only when typed, `clear…` removes, omitted keeps. */
export interface HostInput {
  /** omit for a new host */
  id?: string;
  name: string;
  host: string;
  port: number;
  user: string;
  group: string;
  tags: string[];
  color: string | null;
  icon: string | null;
  notes: string;
  auth: HostAuth;
  keyPath: string | null;
  password?: string;
  clearPassword?: boolean;
  passphrase?: string;
  clearPassphrase?: boolean;
  /** a pasted private key */
  keyData?: string;
  clearKeyData?: boolean;
  /** new host only: start with the saved secrets of this host (duplicate) */
  copySecretsFrom?: string;
}

/** A question from a connecting SFTP pane (event "ssh://prompt"). */
export interface SshPrompt {
  id: number;
  paneId: string;
  kind: "text" | "secret" | "confirm";
  message: string;
}

export interface RemoteEntry {
  name: string;
  /** POSIX */
  path: string;
  isDir: boolean;
  isLink: boolean;
  size: number;
  modified: number;
  /** "drwxr-xr-x" */
  mode: string;
}

export type TransferEvent =
  | { t: "start"; total: number; files: number }
  | { t: "progress"; done: number; total: number; file: string }
  | { t: "done"; files: number; skipped: number }
  | { t: "cancelled" }
  | { t: "error"; message: string };

/** An optional module in the signed catalog (modules/index.json on GitHub). */
export interface CatalogEntry {
  id: string;
  name: string;
  version: string;
  description: string;
  icon: string;
  author?: string | null;
  permissions: string[];
  minAppVersion: string;
  files: { path: string; sha256: string; size: number }[];
}

export interface Catalog {
  schema: number;
  modules: CatalogEntry[];
  /** commit (or local folder) the catalog came from */
  source: string;
  branch: string;
  fetchedAt: number;
}

/** A change queued for the next start. */
export interface StoreOp {
  op: "install" | "remove";
  id: string;
  name: string;
  version?: string | null;
  permissions: string[];
}

export interface StoreState {
  installed: Record<string, { version: string; installedAt: number; branch?: string | null }>;
  pending: StoreOp[];
  /** what happened to the changes queued before the last start */
  lastApply: { op: "install" | "remove"; id: string; name: string; ok: boolean; error?: string | null; permissions: string[] }[];
  appVersion: string;
  /** plugin folders the store doesn't manage */
  local: string[];
}

export type UpdateChannel = "stable" | "test";

type CommitResult = { status: "ok"; version: number } | { status: "conflict"; version: number; model: unknown };

export const ipc = {
  // model
  stateGet: () => invoke<{ version: number; model: unknown }>("state_get"),
  stateCommit: (baseVersion: number, model: unknown, source: string) =>
    invoke<CommitResult>("state_commit", { baseVersion, model, source }),

  // terminals
  ptyAttach: (paneId: string, spec: SpawnSpec, cols: number, rows: number, onData: Channel<PtyMessage>) =>
    invoke<AttachInfo>("pty_attach", { paneId, spec, cols, rows, onData }),
  ptyDetach: (paneId: string, token: number) => invoke<void>("pty_detach", { paneId, token }),
  ptyWrite: (paneId: string, data: string) => invoke<void>("pty_write", { paneId, data }),
  ptyResize: (paneId: string, cols: number, rows: number) => invoke<void>("pty_resize", { paneId, cols, rows }),
  ptyKill: (paneId: string, forget = true) => invoke<void>("pty_kill", { paneId, forget }),
  ptyInfo: (paneId: string) => invoke<PtyInfo | null>("pty_info", { paneId }),
  ptyText: (paneId: string, maxBytes?: number) => invoke<string>("pty_text", { paneId, maxBytes }),
  ptyConfigure: (ringBytes: number, persistScrollback: boolean) =>
    invoke<void>("pty_configure", { ringBytes, persistScrollback }),
  shellsList: (refresh = false) => invoke<Profile[]>("shells_list", { refresh }),

  // config
  settingsRead: () => invoke<Record<string, unknown>>("settings_read"),
  settingsWrite: (settings: unknown) => invoke<void>("settings_write", { settings }),
  themesList: () => invoke<unknown[]>("themes_list"),
  themeSave: (theme: unknown) => invoke<void>("theme_save", { theme }),
  themeDelete: (id: string) => invoke<void>("theme_delete", { id }),
  themeReadFile: (path: string) => invoke<unknown>("theme_read_file", { path }),
  notesRead: (key: string) => invoke<string>("notes_read", { key }),
  notesWrite: (key: string, text: string) => invoke<void>("notes_write", { key, text }),
  backgroundImport: (path: string) => invoke<string>("background_import", { path }),
  dataDir: () => invoke<string>("data_dir"),
  pluginStorageGet: (pluginId: string) => invoke<Record<string, unknown>>("plugin_storage_get", { pluginId }),
  pluginStorageSet: (pluginId: string, data: unknown) => invoke<void>("plugin_storage_set", { pluginId, data }),

  // files
  fsList: (path: string, showHidden = false) => invoke<FsEntry[]>("fs_list", { path, showHidden }),
  fsPreview: (path: string, maxBytes?: number) => invoke<Preview>("fs_preview", { path, maxBytes }),
  fsHome: () => invoke<string>("fs_home"),
  fsDrives: () => invoke<string[]>("fs_drives"),
  fsIsDir: (path: string) => invoke<boolean>("fs_is_dir", { path }),
  fsReadText: (path: string) => invoke<string>("fs_read_text", { path }),
  fsWriteText: (path: string, text: string) => invoke<void>("fs_write_text", { path, text }),
  fsRename: (from: string, to: string) => invoke<void>("fs_rename", { from, to }),
  fsMkdir: (path: string) => invoke<void>("fs_mkdir", { path }),
  fsNewFile: (path: string) => invoke<void>("fs_new_file", { path }),
  fsTrash: (path: string) => invoke<void>("fs_trash", { path }),

  // system
  sysSnapshot: (withDisks = false) => invoke<SysSnapshot>("sys_snapshot", { withDisks }),
  procList: () => invoke<ProcInfo[]>("proc_list"),
  procKill: (pid: number, tree = false) => invoke<void>("proc_kill", { pid, tree }),
  netSockets: () => invoke<SocketInfo[]>("net_sockets"),

  // git
  gitStatus: (cwd: string) => invoke<GitStatus>("git_status", { cwd }),
  gitLog: (cwd: string, limit = 40) => invoke<GitCommit[]>("git_log", { cwd, limit }),
  gitDiff: (cwd: string, opts: { path?: string; staged?: boolean; commit?: string } = {}) =>
    invoke<string>("git_diff", { cwd, ...opts }),
  gitOp: (cwd: string, op: string, paths?: string[]) => invoke<string>("git_op", { cwd, op, paths }),
  /** trust the repository at `cwd` with the settings it has now (see git.rs) */
  gitTrust: (cwd: string) => invoke<void>("git_trust", { cwd }),

  // tasks & logs
  tasksDetect: (cwd: string) => invoke<TaskGroup[]>("tasks_detect", { cwd }),
  logOpen: (path: string, onEvent: Channel<{ t: string; lines?: string[] }>, tailBytes?: number) =>
    invoke<number>("log_open", { path, tailBytes, onEvent }),
  logClose: (id: number) => invoke<void>("log_close", { id }),

  // web panes
  webOpen: (paneId: string, url: string, r: Rect) => invoke<string>("web_open", { paneId, url, ...rectArgs(r) }),
  webBounds: (paneId: string, r: Rect) => invoke<void>("web_bounds", { paneId, ...rectArgs(r) }),
  webVisible: (paneId: string, visible: boolean) => invoke<void>("web_visible", { paneId, visible }),
  webNavigate: (paneId: string, url: string) => invoke<string>("web_navigate", { paneId, url }),
  webAction: (paneId: string, action: "back" | "forward" | "reload" | "stop") =>
    invoke<void>("web_action", { paneId, action }),
  webZoom: (paneId: string, factor: number) => invoke<void>("web_zoom", { paneId, factor }),
  webClose: (paneId: string) => invoke<void>("web_close", { paneId }),
  webHideAll: () => invoke<void>("web_hide_all"),

  // windows
  windowCreate: (label: string, effect: string, title?: string) =>
    invoke<void>("window_create", { label, effect, title }),
  windowFocus: (label: string) => invoke<void>("window_focus", { label }),
  windowLabels: () => invoke<string[]>("window_labels"),
  windowSetEffect: (effect: string, dark: boolean) => invoke<void>("window_set_effect", { effect, dark }),

  // plugins
  pluginsList: () => invoke<PluginInfo[]>("plugins_list"),
  pluginInstallFolder: (src: string) => invoke<string>("plugin_install_folder", { src }),
  pluginRemove: (id: string) => invoke<void>("plugin_remove", { id }),
  runCommand: (program: string, args: string[], cwd?: string, timeoutMs?: number) =>
    invoke<ExecResult>("run_command", { program, args, cwd, timeoutMs }),
  /** Claude plan usage for plugins with `claude.usage`; `usage` is Anthropic's answer as is. */
  claudeUsage: () =>
    invoke<{ fetchedAt: number; plan: { subscription: string | null; tier: string | null }; usage: Record<string, unknown> }>("claude_usage"),

  // saved SSH hosts (secrets go in, never come back out)
  vaultStatus: () => invoke<VaultStatus>("vault_status"),
  vaultCreate: (password: string) => invoke<void>("vault_create", { password }),
  vaultUnlock: (password: string) => invoke<void>("vault_unlock", { password }),
  vaultChangePassword: (current: string, next: string) => invoke<void>("vault_change_password", { current, new: next }),
  vaultLock: () => invoke<void>("vault_lock"),
  vaultReset: () => invoke<void>("vault_reset"),
  vaultConfigure: (autoLockMins: number) => invoke<void>("vault_configure", { autoLockMins }),
  hostsList: () => invoke<HostView[]>("hosts_list"),
  hostSave: (host: HostInput) => invoke<HostView>("host_save", { host }),
  hostDelete: (id: string) => invoke<void>("host_delete", { id }),
  hostForgetKeys: (id: string) => invoke<HostView>("host_forget_keys", { id }),
  sshPromptAnswer: (id: number, value: string | null) => invoke<void>("ssh_prompt_answer", { id, value }),

  // sftp (one connection per pane; remote paths are POSIX)
  sftpConnect: (paneId: string, hostId: string) => invoke<{ home: string; hostName: string }>("sftp_connect", { paneId, hostId }),
  sftpClose: (paneId: string) => invoke<void>("sftp_close", { paneId }),
  sftpList: (paneId: string, path: string) => invoke<RemoteEntry[]>("sftp_list", { paneId, path }),
  sftpMkdir: (paneId: string, path: string) => invoke<void>("sftp_mkdir", { paneId, path }),
  sftpRename: (paneId: string, from: string, to: string) => invoke<void>("sftp_rename", { paneId, from, to }),
  sftpDelete: (paneId: string, paths: string[]) => invoke<void>("sftp_delete", { paneId, paths }),
  sftpDownload: (paneId: string, paths: string[], localDir: string, onEvent: Channel<TransferEvent>) =>
    invoke<number>("sftp_download", { paneId, paths, localDir, onEvent }),
  sftpUpload: (paneId: string, paths: string[], remoteDir: string, overwrite: boolean, onEvent: Channel<TransferEvent>) =>
    invoke<number>("sftp_upload", { paneId, paths, remoteDir, overwrite, onEvent }),
  sftpCancel: (id: number) => invoke<void>("sftp_cancel", { id }),
  /** save layout and scrollback now (before the updater's installer closes the app) */
  appPersist: () => invoke<void>("app_persist"),
  /** save everything and start Shellmosaic again (as administrator when `elevated`) */
  appRestart: (elevated = false) => invoke<void>("app_restart", { elevated }),
  appElevated: () => invoke<boolean>("app_elevated"),
  /** metadata for the updater's `new Update(…)`, or null when there's nothing newer on the channel */
  updateCheck: (channel: UpdateChannel) =>
    invoke<{ rid: number; currentVersion: string; version: string; body?: string; rawJson: Record<string, unknown> } | null>("update_check", { channel }),

  // optional modules
  storeState: () => invoke<StoreState>("store_state"),
  storeCatalog: (channel: UpdateChannel, refresh = false) => invoke<Catalog>("store_catalog", { channel, refresh }),
  storeQueueInstall: (channel: UpdateChannel, id: string) => invoke<StoreState>("store_queue_install", { channel, id }),
  storeQueueRemove: (id: string, name?: string) => invoke<StoreState>("store_queue_remove", { id, name }),
  /** forget one queued change, or all of them */
  storeCancel: (id?: string) => invoke<StoreState>("store_cancel", { id }),
  storeAck: () => invoke<void>("store_ack"),

  // backends of the optional modules' SDK calls (results are passed to the plugin as is)
  /** close the event-log queries and databases a plugin pane had open */
  pluginRelease: (owner: string) => invoke<void>("plugin_release", { owner }),
  processOverview: (pid: number) => invoke<unknown>("process_overview", { pid }),
  processModules: (pid: number) => invoke<unknown>("process_modules", { pid }),
  processThreads: (pid: number) => invoke<unknown>("process_threads", { pid }),
  processHandles: (pid: number) => invoke<unknown>("process_handles", { pid }),
  processToken: (pid: number) => invoke<unknown>("process_token", { pid }),
  processMemory: (pid: number) => invoke<unknown>("process_memory", { pid }),
  processSignature: (path: string) => invoke<unknown>("process_signature", { path }),
  processControl: (pid: number, action: string, value?: string) => invoke<void>("process_control", { pid, action, value }),
  threadControl: (pid: number, tid: number, action: string) => invoke<void>("thread_control", { pid, tid, action }),
  eventlogChannels: () => invoke<unknown>("eventlog_channels"),
  eventlogInfo: (channel: string) => invoke<unknown>("eventlog_info", { channel }),
  eventlogQuery: (owner: string, q: { channel: string; xpath?: string; reverse?: boolean; text?: string; max?: number }) =>
    invoke<unknown>("eventlog_query", { owner, ...q }),
  eventlogMore: (owner: string, cursor: number, max?: number) => invoke<unknown>("eventlog_more", { owner, cursor, max }),
  eventlogClose: (owner: string, cursor: number) => invoke<void>("eventlog_close", { owner, cursor }),
  eventlogSubscribe: (owner: string, q: { channel: string; xpath?: string; text?: string }) => invoke<number>("eventlog_subscribe", { owner, ...q }),
  eventlogPoll: (owner: string, subscription: number, max?: number) => invoke<string[]>("eventlog_poll", { owner, subscription, max }),
  eventlogUnsubscribe: (owner: string, subscription: number) => invoke<void>("eventlog_unsubscribe", { owner, subscription }),
  sqliteOpen: (owner: string, path: string, writable?: boolean, copy?: boolean) => invoke<unknown>("sqlite_open", { owner, path, writable, copy }),
  sqliteSchema: (owner: string, id: number) => invoke<unknown>("sqlite_schema", { owner, id }),
  sqliteCount: (owner: string, id: number, table: string) => invoke<number>("sqlite_count", { owner, id, table }),
  sqliteQuery: (owner: string, id: number, sql: string, params?: unknown[], maxRows?: number) =>
    invoke<unknown>("sqlite_query", { owner, id, sql, params, maxRows }),
  sqliteSetWritable: (owner: string, id: number, writable: boolean) => invoke<unknown>("sqlite_set_writable", { owner, id, writable }),
  sqliteInterrupt: (owner: string, id: number) => invoke<void>("sqlite_interrupt", { owner, id }),
  sqliteClose: (owner: string, id: number) => invoke<void>("sqlite_close", { owner, id }),
};

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

function rectArgs(r: Rect) {
  return { x: r.x, y: r.y, width: r.width, height: r.height };
}

export function errorText(e: unknown): string {
  if (typeof e === "string") return e;
  if (e instanceof Error) return e.message;
  try {
    return JSON.stringify(e);
  } catch {
    return String(e);
  }
}
