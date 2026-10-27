// Permission-checked bridge between sandboxed plugin iframes and the app.
//
// Plugins run in `<iframe sandbox="allow-scripts …">` (opaque origin, no IPC).
// The SDK (src-tauri/plugin-sdk/shellmosaic.js) posts `{__sm: 1, id, method,
// params}` to the parent; we answer with `{__sm: 1, id, result | error}` and
// push `{__sm: 1, event, data}` for "theme", "cwd" and "visible".
//
// A method that needs a permission only runs when the plugin declared it in
// manifest.json AND the user granted it (settings.plugins.grants[pluginId]).
import { getVersion } from "@tauri-apps/api/app";
import { readText, writeText } from "@tauri-apps/plugin-clipboard-manager";
import { open } from "@tauri-apps/plugin-dialog";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { errorText, ipc, type Routing } from "../../lib/ipc";
import { isPlainObject } from "../../lib/util";
import { addModule, focusPane, runInNewTerminal, sendToTerminal, setPaneMeta, switchTab, switchWorkspace } from "../../state/actions";
import { useModules } from "../registry";
import { restartApp } from "../../state/moduleStore";
import { commandForEvent } from "../../state/commands";
import { leaves, type Side } from "../../state/layout";
import { tabOfPane, workspaceOfTab } from "../../state/model";
import { settings, updateSettings, useSettings } from "../../state/settings";
import { getState } from "../../state/store";
import { useAgents } from "../../state/agents";
import { activeTheme, pluginThemeVars, useThemes } from "../../state/themes";
import { ui, useUi, type Dialog, type Toast } from "../../state/ui";

/** Messages bigger than this (roughly, in characters) are rejected unread. */
const MAX_MESSAGE = 1024 * 1024;

/**
 * App shortcuts pressed while focus is inside a plugin frame are forwarded by the
 * SDK. A plugin could forge these, so only navigation-style commands are honoured
 * (never paste, close, run or anything that moves data).
 */
const FORWARDABLE = /^(palette\.(open|modules)|settings\.open|tab\.(next|prev|goto\.\d)|workspace\.(next|prev|goto\.\d)|pane\.(focus\w+|zoom)|view\.moduleBar)$/;

function forwardShortcut(k: Record<string, unknown>) {
  if (typeof k.code !== "string" || k.code.length > 32) return;
  const ev = new KeyboardEvent("keydown", {
    code: k.code,
    key: typeof k.key === "string" ? k.key.slice(0, 16) : "",
    ctrlKey: !!k.ctrlKey,
    altKey: !!k.altKey,
    shiftKey: !!k.shiftKey,
    metaKey: !!k.metaKey,
  });
  const cmd = commandForEvent(ev);
  if (cmd && FORWARDABLE.test(cmd.id)) cmd.run();
}
/** Unanswered calls one pane may have at a time. */
const MAX_INFLIGHT = 64;

/** Which permission each SDK method needs (null = always allowed). */
const METHOD_PERMISSION: Record<string, string | null> = {
  ready: null,
  context: null,
  "terminal.write": "terminal.write",
  "terminal.run": "terminal.run",
  "terminal.read": "terminal.read",
  "fs.list": "fs.read",
  "fs.readText": "fs.read",
  "fs.writeText": "fs.write",
  "shell.exec": "shell.exec",
  "system.stats": "system.read",
  "clipboard.readText": "clipboard",
  "clipboard.writeText": "clipboard",
  "claude.usage": "claude.usage",
  "process.list": "process.inspect",
  "process.overview": "process.inspect",
  "process.modules": "process.inspect",
  "process.threads": "process.inspect",
  "process.handles": "process.inspect",
  "process.token": "process.inspect",
  "process.memory": "process.inspect",
  "process.signature": "process.inspect",
  "process.suspend": "process.control",
  "process.resume": "process.control",
  "process.setPriority": "process.control",
  "process.setAffinity": "process.control",
  "thread.suspend": "process.control",
  "thread.resume": "process.control",
  "thread.terminate": "process.control",
  "eventlog.channels": "eventlog.read",
  "eventlog.info": "eventlog.read",
  "eventlog.query": "eventlog.read",
  "eventlog.more": "eventlog.read",
  "eventlog.close": "eventlog.read",
  "eventlog.subscribe": "eventlog.read",
  "eventlog.poll": "eventlog.read",
  "eventlog.unsubscribe": "eventlog.read",
  "sqlite.open": "sqlite",
  "sqlite.schema": "sqlite",
  "sqlite.count": "sqlite",
  "sqlite.query": "sqlite",
  "sqlite.setWritable": "sqlite",
  "sqlite.interrupt": "sqlite",
  "sqlite.close": "sqlite",
  "agents.snapshot": "agents.read",
  "agents.activity": "agents.read",
  "agents.reveal": "agents.read",
  "agents.start": "agents.manage",
  "agents.gitInit": "agents.manage",
  "agents.stopRun": "agents.manage",
  "agents.forgetRun": "agents.manage",
  "agents.hire": "agents.manage",
  "agents.remove": "agents.manage",
  "agents.resume": "agents.manage",
  "agents.interrupt": "agents.manage",
  "agents.send": "agents.manage",
  "agents.answer": "agents.manage",
  "agents.createTask": "agents.manage",
  "agents.assign": "agents.manage",
  "agents.cancelTask": "agents.manage",
  "agents.review": "agents.manage",
  "agents.setRouting": "agents.manage",
  "agents.taskDiff": "agents.read",
  "agents.mergePreview": "agents.read",
  "agents.mergeToBase": "agents.manage",
  "storage.get": null,
  "storage.set": null,
  "storage.all": null,
  "ui.notify": null,
  "ui.setTitle": null,
  "ui.setState": null,
  // the user answers these themselves: a dialog, a file picker, a pane opening next to the plugin
  "ui.confirm": null,
  "ui.pickFile": null,
  "ui.pickFolder": null,
  "ui.openModule": null,
  "ui.reveal": null,
  "app.info": null,
  "app.restartAsAdmin": null,
};

/** The app's version and whether it runs elevated, read once. */
let appInfo: Promise<{ version: string; elevated: boolean }> | null = null;
function appInfoOnce() {
  appInfo ??= Promise.all([getVersion().catch(() => ""), ipc.appElevated().catch(() => false)]).then(([version, elevated]) => ({ version, elevated }));
  return appInfo;
}

export interface SessionInfo {
  pluginId: string;
  name: string;
  paneId: string;
  tabId: string;
  /** permissions declared in the manifest */
  permissions: string[];
  cwd?: string;
  visible: boolean;
  /** one-time secret in the frame's URL (#smt=…): only the page we loaded has it */
  token: string;
}

export interface Session {
  update(patch: Partial<SessionInfo>): void;
  push(event: string, data: unknown): void;
  dispose(): void;
}

interface Internal {
  info: SessionInfo;
  frame: () => HTMLIFrameElement | null;
  /** the document in the frame called `ready` */
  ready: boolean;
  /** bumped on every `ready` so replies meant for a previous document are dropped */
  gen: number;
  inflight: number;
  connected: boolean;
  disposed: boolean;
  onConnect?: () => void;
}

type Params = Record<string, unknown>;

const sessions = new Set<Internal>();
let installed = false;

// ── sessions ────────────────────────────────────────────────────────────

/**
 * Start brokering for one plugin pane. `frame` returns the pane's iframe (it is
 * looked up on every message so a re-created element keeps working).
 */
export function attachFrame(
  frame: () => HTMLIFrameElement | null,
  info: SessionInfo,
  hooks: { onConnect?: () => void } = {},
): Session {
  install();
  const s: Internal = {
    info: { ...info },
    frame,
    ready: false,
    gen: 0,
    inflight: 0,
    connected: false,
    disposed: false,
    onConnect: hooks.onConnect,
  };
  sessions.add(s);
  return {
    update(patch) {
      const prev = s.info;
      s.info = { ...prev, ...patch };
      if (!s.ready) return;
      if ("cwd" in patch && patch.cwd !== prev.cwd) push(s, "cwd", patch.cwd ?? null);
      if ("visible" in patch && patch.visible !== prev.visible) push(s, "visible", !!patch.visible);
    },
    push: (event, data) => push(s, event, data),
    dispose() {
      s.disposed = true;
      sessions.delete(s);
      // event-log queries and databases the page had open die with it
      ipc.pluginRelease(s.info.paneId).catch(() => {});
    },
  };
}

function install() {
  if (installed) return;
  installed = true;
  window.addEventListener("message", onWindowMessage);
  watchTheme();
}

/** An event for every ready plugin pane that declared and was granted `perm`. */
function pushToGranted(perm: string, event: string, data: unknown) {
  for (const s of sessions) {
    if (s.ready && s.info.permissions.includes(perm) && grantedPermissions(s.info.pluginId).includes(perm)) push(s, event, data);
  }
}

// the Orchestrator changed: modules that show it fetch what they need
useAgents.subscribe((s, prev) => {
  if (s.snap && s.snap.rev !== prev.snap?.rev) pushToGranted("agents.read", "agents", { rev: s.snap.rev });
});

function push(s: Internal, event: string, data: unknown) {
  if (s.disposed) return;
  try {
    s.frame()?.contentWindow?.postMessage({ __sm: 1, event, data }, "*");
  } catch (e) {
    console.warn(`[plugin ${s.info.pluginId}] could not send "${event}"`, e);
  }
}

function reply(s: Internal, gen: number, id: number | string, out: { result: unknown } | { error: string }) {
  if (s.disposed || s.gen !== gen) return;
  const w = s.frame()?.contentWindow;
  if (!w) return;
  try {
    w.postMessage({ __sm: 1, id, ...out }, "*");
  } catch {
    // result wasn't cloneable
    w.postMessage({ __sm: 1, id, error: "the result could not be sent to the plugin" }, "*");
  }
}

function onWindowMessage(e: MessageEvent) {
  if (!e.source) return;
  let s: Internal | undefined;
  for (const x of sessions) {
    if (x.frame()?.contentWindow === e.source) {
      s = x;
      break;
    }
  }
  if (!s) return;
  const d = e.data;
  if (!isPlainObject(d) || d.__sm !== 1) return;
  // the frame may have navigated elsewhere (a link in the plugin): that page has no token
  if (!s.info.token || d.token !== s.info.token) return;
  if (isPlainObject(d.shortcut)) return forwardShortcut(d.shortcut);
  const id = d.id;
  if (typeof id !== "number" && typeof id !== "string") return;
  const session = s;
  if (!session.connected) {
    session.connected = true;
    session.onConnect?.();
  }
  if (d.method === "ready") {
    // a (re)loaded document: forget calls the previous one still has in flight
    session.gen++;
    session.inflight = 0;
  }
  const gen = session.gen;
  if (!fitsIn(d, MAX_MESSAGE)) return reply(session, gen, id, { error: "request too large" });
  if (typeof d.method !== "string") return reply(session, gen, id, { error: "invalid request" });
  if (session.inflight >= MAX_INFLIGHT) return reply(session, gen, id, { error: "too many pending requests" });
  const params: Params = isPlainObject(d.params) ? d.params : {};
  session.inflight++;
  handle(session, d.method, params)
    .then(
      (result) => reply(session, gen, id, { result }),
      (err) => reply(session, gen, id, { error: errorText(err) || "request failed" }),
    )
    .finally(() => {
      if (session.gen === gen) session.inflight = Math.max(0, session.inflight - 1);
    });
}

/** Rough size check that stops walking as soon as the budget is exceeded. */
function fitsIn(value: unknown, budget: number): boolean {
  let left = budget;
  const walk = (v: unknown, depth: number): boolean => {
    if (depth > 64) return false;
    if (typeof v === "string") return (left -= v.length + 2) >= 0;
    if (v === null || typeof v !== "object") return (left -= 8) >= 0;
    if (v instanceof ArrayBuffer) return (left -= v.byteLength) >= 0;
    if (ArrayBuffer.isView(v)) return (left -= v.byteLength) >= 0;
    if (typeof Blob !== "undefined" && v instanceof Blob) return (left -= v.size) >= 0;
    if (v instanceof Map || v instanceof Set) return walk([...v], depth + 1);
    left -= 2;
    if (Array.isArray(v)) {
      for (const x of v) if (!walk(x, depth + 1)) return false;
      return left >= 0;
    }
    for (const [k, x] of Object.entries(v)) {
      left -= k.length + 2;
      if (left < 0 || !walk(x, depth + 1)) return false;
    }
    return left >= 0;
  };
  return walk(value, 0);
}

// ── permissions ─────────────────────────────────────────────────────────

const prompts = new Map<string, Promise<boolean>>();
/** plugins the user said "Don't allow" to during this run (not asked again until forced) */
const deniedThisRun = new Set<string>();
let dialogQueue: Promise<unknown> = Promise.resolve();

export function grantedPermissions(pluginId: string): string[] {
  return settings().plugins.grants[pluginId] ?? [];
}

/** Declared permissions the user hasn't granted yet. */
export function missingPermissions(pluginId: string, declared: string[]): string[] {
  const granted = grantedPermissions(pluginId);
  return declared.filter((p) => !granted.includes(p));
}

/** A permission prompt for this plugin is showing (or queued). */
export function isPrompting(pluginId: string): boolean {
  return prompts.has(pluginId);
}

function dialogFree(): Promise<void> {
  if (!ui.get().dialog) return Promise.resolve();
  return new Promise((resolve) => {
    const unsub = useUi.subscribe((s) => {
      if (!s.dialog) {
        unsub();
        resolve();
      }
    });
  });
}

/**
 * Ask the user to grant whatever `declared` permissions are still missing.
 * One prompt per plugin at a time (every pane of the plugin shares it), and
 * prompts for different plugins queue instead of replacing each other.
 * After "Don't allow" the plugin isn't asked again this run unless `force`.
 */
export function requestPermissions(pluginId: string, name: string, declared: string[], opts: { force?: boolean } = {}): Promise<boolean> {
  const existing = prompts.get(pluginId);
  if (existing) return existing;
  if (!missingPermissions(pluginId, declared).length) return Promise.resolve(true);
  if (deniedThisRun.has(pluginId) && !opts.force) return Promise.resolve(false);

  const run = async (): Promise<boolean> => {
    await dialogFree();
    // granted meanwhile (another pane or window)?
    const missing = missingPermissions(pluginId, declared);
    if (!missing.length) return true;
    const answer = await new Promise<boolean | null>((resolve) => {
      let done = false;
      const finish = (v: boolean | null) => {
        if (done) return;
        done = true;
        unsub();
        resolve(v);
      };
      const dialog: Dialog = { kind: "plugin-permissions", pluginId, name, permissions: missing, resolve: (ok) => finish(ok) };
      // if something else replaces our dialog, treat it as dismissed. The dialog
      // closes itself right before calling resolve, so check a tick later.
      const unsub = useUi.subscribe((s) => {
        if (s.dialog !== dialog) queueMicrotask(() => finish(null));
      });
      ui.openDialog(dialog);
    });
    if (answer) {
      deniedThisRun.delete(pluginId);
      updateSettings((s) => {
        const cur = s.plugins.grants[pluginId] ?? [];
        s.plugins.grants[pluginId] = [...new Set([...cur, ...missing])];
      });
      return true;
    }
    if (answer === false) deniedThisRun.add(pluginId);
    return false;
  };

  const p = dialogQueue.then(run, run);
  dialogQueue = p.catch(() => false);
  const tracked = p.finally(() => prompts.delete(pluginId));
  prompts.set(pluginId, tracked);
  return tracked;
}

async function requirePermission(s: Internal, perm: string) {
  const pending = prompts.get(s.info.pluginId);
  if (pending) await pending.catch(() => false);
  if (!s.info.permissions.includes(perm)) throw new Error(`permission denied: ${perm} (not declared in manifest.json)`);
  if (!grantedPermissions(s.info.pluginId).includes(perm)) throw new Error(`permission denied: ${perm}`);
}

// ── theme ───────────────────────────────────────────────────────────────

function themeVars(): Record<string, string> {
  const s = settings();
  return pluginThemeVars(activeTheme(s), s);
}

/** Push "theme" to every ready plugin when the effective theme vars change. */
function watchTheme() {
  let last = JSON.stringify(themeVars());
  let timer: ReturnType<typeof setTimeout> | undefined;
  const check = () => {
    if (timer) return;
    timer = setTimeout(() => {
      timer = undefined;
      const vars = themeVars();
      const key = JSON.stringify(vars);
      if (key === last) return;
      last = key;
      for (const s of sessions) if (s.ready) push(s, "theme", vars);
    }, 30);
  };
  useSettings.subscribe(check);
  useThemes.subscribe(check);
}

// ── storage ─────────────────────────────────────────────────────────────

// Not cached: every window has its own broker and a plugin pane can move between
// windows (or be open in two), so a cached copy goes stale and its next write would
// drop what the other window saved. Reads and read-modify-writes run one at a time
// per plugin, so a get after a set in this window sees it.
const storageQueue = new Map<string, Promise<unknown>>();

function storageOp<T>(pluginId: string, fn: () => Promise<T>): Promise<T> {
  const p = (storageQueue.get(pluginId) ?? Promise.resolve()).then(fn, fn);
  storageQueue.set(pluginId, p.catch(() => {}));
  return p;
}

const storageOf = (pluginId: string): Promise<Record<string, unknown>> =>
  storageOp(pluginId, () => ipc.pluginStorageGet(pluginId).then((d) => (isPlainObject(d) ? { ...d } : {})));

async function storageSet(pluginId: string, key: string, raw: unknown) {
  let value: unknown;
  try {
    value = raw === undefined ? undefined : JSON.parse(JSON.stringify(raw));
  } catch {
    throw new Error("storage values must be JSON-serializable");
  }
  await storageOp(pluginId, async () => {
    const d = await ipc.pluginStorageGet(pluginId);
    const data: Record<string, unknown> = isPlainObject(d) ? { ...d } : {};
    if (value === undefined) delete data[key];
    else data[key] = value;
    await ipc.pluginStorageSet(pluginId, data);
  });
}

// ── methods ─────────────────────────────────────────────────────────────

function reqStr(p: Params, key: string): string {
  const v = p[key];
  if (typeof v !== "string") throw new Error(`"${key}" must be a string`);
  return v;
}

function optStr(p: Params, key: string): string | undefined {
  const v = p[key];
  if (v === undefined || v === null || v === "") return undefined;
  if (typeof v !== "string") throw new Error(`"${key}" must be a string`);
  return v;
}

function optInt(p: Params, key: string, min: number, max: number, fallback: number): number {
  const v = p[key];
  if (v === undefined || v === null) return fallback;
  if (typeof v !== "number" || !Number.isFinite(v)) throw new Error(`"${key}" must be a number`);
  return Math.round(Math.min(max, Math.max(min, v)));
}

/** A whole number in range (process and thread ids, database and query ids). */
function reqInt(p: Params, key: string, min = 0, max = 0xffff_ffff): number {
  const v = p[key];
  if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max) throw new Error(`"${key}" must be a whole number`);
  return v;
}

function optBool(p: Params, key: string): boolean | undefined {
  const v = p[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "boolean") throw new Error(`"${key}" must be true or false`);
  return v;
}

/** `C:\…` only: a `\\host\share` path would make Windows log in to that host. */
function localPath(p: Params, key: string): string {
  const v = reqStr(p, key);
  if (!/^[a-zA-Z]:[\\/]/.test(v) || v.includes("..") || v.length > 32_767) throw new Error("only files on this computer (C:\\…) can be used");
  return v;
}

const PLUGIN_MODULE = /^plugin:[a-z0-9][a-z0-9._-]{0,119}$/;

/** Open a built-in module or another plugin next to the plugin's pane (only harmless options). */
async function openModule(info: SessionInfo, p: Params): Promise<boolean> {
  const module = reqStr(p, "module");
  const near = { tabId: info.tabId, target: info.paneId, side: "right" as const };
  if (module === "processes" || module === "ports") {
    await addModule(module, { ...near, meta: { filter: (optStr(p, "filter") ?? "").slice(0, 200) || null } });
    return true;
  }
  if (module === "files" || module === "git") {
    const path = p.path === undefined || p.path === null ? undefined : localPath(p, "path");
    await addModule(module, { ...near, meta: path ? { path, follow: false } : undefined });
    return true;
  }
  if (PLUGIN_MODULE.test(module)) {
    const def = useModules.getState().modules[module];
    if (!def?.plugin) throw new Error(`${module.slice(7)} isn't installed (Settings → Optional modules)`);
    const args = p.args === undefined || p.args === null ? null : p.args;
    if (args !== null && (!isPlainObject(args) || !fitsIn(args, 16 * 1024))) throw new Error('"args" must be a small object');
    await addModule(module, { ...near, meta: args ? { args: JSON.parse(JSON.stringify(args)) } : undefined });
    return true;
  }
  throw new Error(`can't open "${module}"`);
}

/** Saved pane state, written at most every 300 ms per pane. */
const stateWrites = new Map<string, { timer: ReturnType<typeof setTimeout>; value: unknown }>();
function savePaneState(paneId: string, value: unknown) {
  const pending = stateWrites.get(paneId);
  if (pending) clearTimeout(pending.timer);
  stateWrites.set(paneId, {
    value,
    timer: setTimeout(() => {
      stateWrites.delete(paneId);
      setPaneMeta(paneId, { state: value });
    }, 300),
  });
}

function storageKey(p: Params): string {
  const key = reqStr(p, "key");
  if (!key || key.length > 256) throw new Error('"key" must be 1–256 characters');
  return key;
}

/** The terminal a plugin's terminal.read targets: last focused in its tab, else the first one. */
function terminalTarget(tabId: string): string | undefined {
  const m = getState().model;
  const inTab = leaves(m.tabs[tabId]?.root ?? null).filter((id) => m.panes[id]?.module === "terminal");
  const last = ui.get().lastTerminal[tabId];
  return last && inTab.includes(last) ? last : inTab[0];
}

async function contextOf(s: Internal) {
  const { info } = s;
  const granted = grantedPermissions(info.pluginId);
  const meta = getState().model.panes[info.paneId]?.meta ?? {};
  const pendingState = stateWrites.get(info.paneId);
  const app = await appInfoOnce();
  return {
    pluginId: info.pluginId,
    paneId: info.paneId,
    tabId: info.tabId,
    workspaceId: workspaceOfTab(getState().model, info.tabId)?.id ?? null,
    cwd: info.cwd ?? null,
    visible: info.visible,
    grantedPermissions: info.permissions.filter((p) => granted.includes(p)),
    args: isPlainObject(meta.args) ? meta.args : null,
    state: pendingState ? pendingState.value : isPlainObject(meta.state) ? meta.state : null,
    appVersion: app.version,
    elevated: app.elevated,
  };
}

const SIDES: Side[] = ["left", "right", "top", "bottom"];
const TOAST_KINDS: Toast["kind"][] = ["info", "success", "warning", "error"];

async function handle(s: Internal, method: string, p: Params): Promise<unknown> {
  if (!Object.prototype.hasOwnProperty.call(METHOD_PERMISSION, method)) throw new Error(`unknown method: ${method}`);
  const perm = METHOD_PERMISSION[method];
  if (perm) await requirePermission(s, perm);
  const { info } = s;

  switch (method) {
    case "ready": {
      s.ready = true;
      const { pluginId, name, permissions } = info;
      // a reloaded page starts over: what the previous one had open is gone
      ipc.pluginRelease(info.paneId).catch(() => {});
      if (missingPermissions(pluginId, permissions).length && !deniedThisRun.has(pluginId)) {
        // style the plugin right away; the reply waits for the user's answer
        push(s, "theme", themeVars());
        await requestPermissions(pluginId, name, permissions);
      }
      return { ...(await contextOf(s)), theme: themeVars() };
    }
    case "context":
      return contextOf(s);

    case "terminal.write":
      // (never opens a terminal of its own: that would run the text, which needs terminal.run)
      if (!(await sendToTerminal(reqStr(p, "text"), { tabId: info.tabId }))) throw new Error("there's no running terminal in this tab");
      return true;
    case "terminal.run": {
      const side = SIDES.includes(p.side as Side) ? (p.side as Side) : undefined;
      const paneId = await runInNewTerminal(reqStr(p, "command"), { tabId: info.tabId, cwd: optStr(p, "cwd") ?? info.cwd, side });
      return { paneId: paneId ?? null };
    }
    case "terminal.read": {
      const target = terminalTarget(info.tabId);
      if (!target) throw new Error("there is no terminal in this tab");
      return ipc.ptyText(target, optInt(p, "maxBytes", 1, 1024 * 1024, 64 * 1024));
    }

    case "fs.list":
      return ipc.fsList(reqStr(p, "path"), p.showHidden === true);
    case "fs.readText":
      return ipc.fsReadText(reqStr(p, "path"));
    case "fs.writeText":
      await ipc.fsWriteText(reqStr(p, "path"), reqStr(p, "text"));
      return true;

    case "shell.exec": {
      const args = p.args ?? [];
      if (!Array.isArray(args) || !args.every((a) => typeof a === "string")) throw new Error('"args" must be an array of strings');
      return ipc.runCommand(reqStr(p, "program"), args, optStr(p, "cwd") ?? info.cwd, optInt(p, "timeoutMs", 100, 600_000, 30_000));
    }
    case "system.stats":
      return ipc.sysSnapshot(p.disks === true);

    case "clipboard.readText":
      return (await readText()) ?? "";
    case "clipboard.writeText":
      await writeText(reqStr(p, "text"));
      return true;

    case "claude.usage":
      // the backend reads Claude Code's token and keeps it: only the numbers come back
      return ipc.claudeUsage();

    case "storage.get": {
      const key = storageKey(p);
      const data = await storageOf(info.pluginId);
      return Object.prototype.hasOwnProperty.call(data, key) ? data[key] : null;
    }
    case "storage.set":
      await storageSet(info.pluginId, storageKey(p), p.value);
      return true;
    case "storage.all":
      return { ...(await storageOf(info.pluginId)) };

    case "ui.notify": {
      const message = String(p.message ?? "").slice(0, 500);
      const kind = TOAST_KINDS.includes(p.kind as Toast["kind"]) ? (p.kind as Toast["kind"]) : "info";
      if (message) ui.toast(`${info.name}: ${message}`, kind);
      return true;
    }
    case "ui.setTitle":
      ui.setTitle(info.paneId, String(p.title ?? "").slice(0, 200));
      return true;
    case "ui.setState": {
      const value = p.state ?? null;
      if (value !== null && (!isPlainObject(value) || !fitsIn(value, 64 * 1024))) throw new Error("state must be an object of at most 64 KB");
      savePaneState(info.paneId, value === null ? null : JSON.parse(JSON.stringify(value)));
      return true;
    }
    case "ui.confirm": {
      await dialogFree();
      return ui.confirm(String(p.title ?? "").slice(0, 200), String(p.message ?? "").slice(0, 2000), {
        okLabel: optStr(p, "okLabel")?.slice(0, 40),
        danger: p.danger === true,
      });
    }
    case "ui.pickFile": {
      const filters = Array.isArray(p.filters)
        ? p.filters
            .filter(isPlainObject)
            .slice(0, 10)
            .map((f) => ({
              name: String(f.name ?? "Files").slice(0, 60),
              extensions: (Array.isArray(f.extensions) ? f.extensions : []).map(String).filter((x) => /^(\*|[a-z0-9]{1,16})$/i.test(x)).slice(0, 20),
            }))
            .filter((f) => f.extensions.length)
        : undefined;
      const picked = await open({ multiple: false, directory: false, title: optStr(p, "title")?.slice(0, 120), filters });
      return typeof picked === "string" ? picked : null;
    }
    case "ui.pickFolder": {
      const picked = await open({ multiple: false, directory: true, title: optStr(p, "title")?.slice(0, 120) });
      return typeof picked === "string" ? picked : null;
    }
    case "ui.openModule":
      return openModule(info, p);
    case "ui.reveal":
      await revealItemInDir(localPath(p, "path"));
      return true;

    case "app.info":
      return appInfoOnce();
    case "app.restartAsAdmin": {
      if ((await appInfoOnce()).elevated) throw new Error("Shellmosaic already runs as administrator");
      await dialogFree();
      return restartApp({ elevated: true, reason: `${info.name} asked for it.` });
    }

    case "process.list":
      return ipc.procList();
    case "process.overview":
      return ipc.processOverview(reqInt(p, "pid"));
    case "process.modules":
      return ipc.processModules(reqInt(p, "pid"));
    case "process.threads":
      return ipc.processThreads(reqInt(p, "pid"));
    case "process.handles":
      return ipc.processHandles(reqInt(p, "pid"));
    case "process.token":
      return ipc.processToken(reqInt(p, "pid"));
    case "process.memory":
      return ipc.processMemory(reqInt(p, "pid"));
    case "process.signature":
      return ipc.processSignature(reqStr(p, "path"));
    case "process.suspend":
    case "process.resume":
      await ipc.processControl(reqInt(p, "pid"), method.slice(8));
      return true;
    case "process.setPriority":
      await ipc.processControl(reqInt(p, "pid"), "priority", reqStr(p, "priority"));
      return true;
    case "process.setAffinity": {
      const mask = reqStr(p, "mask");
      if (!/^\d{1,20}$/.test(mask)) throw new Error('"mask" must be a decimal number');
      await ipc.processControl(reqInt(p, "pid"), "affinity", mask);
      return true;
    }
    case "thread.suspend":
    case "thread.resume":
    case "thread.terminate":
      await ipc.threadControl(reqInt(p, "pid"), reqInt(p, "tid"), method.slice(7));
      return true;

    case "eventlog.channels":
      return ipc.eventlogChannels();
    case "eventlog.info":
      return ipc.eventlogInfo(reqStr(p, "channel"));
    case "eventlog.query":
      return ipc.eventlogQuery(info.paneId, {
        channel: reqStr(p, "channel"),
        xpath: optStr(p, "xpath"),
        reverse: optBool(p, "reverse"),
        text: optStr(p, "text"),
        max: p.max === undefined ? undefined : reqInt(p, "max", 1, 1000),
      });
    case "eventlog.more":
      return ipc.eventlogMore(info.paneId, reqInt(p, "cursor"), p.max === undefined ? undefined : reqInt(p, "max", 1, 1000));
    case "eventlog.close":
      await ipc.eventlogClose(info.paneId, reqInt(p, "cursor"));
      return true;
    case "eventlog.subscribe":
      return ipc.eventlogSubscribe(info.paneId, { channel: reqStr(p, "channel"), xpath: optStr(p, "xpath"), text: optStr(p, "text") });
    case "eventlog.poll":
      return ipc.eventlogPoll(info.paneId, reqInt(p, "subscription"), p.max === undefined ? undefined : reqInt(p, "max", 1, 1000));
    case "eventlog.unsubscribe":
      await ipc.eventlogUnsubscribe(info.paneId, reqInt(p, "subscription"));
      return true;

    case "sqlite.open":
      return ipc.sqliteOpen(info.paneId, localPath(p, "path"), optBool(p, "writable"), optBool(p, "copy"));
    case "sqlite.schema":
      return ipc.sqliteSchema(info.paneId, reqInt(p, "db"));
    case "sqlite.count":
      return ipc.sqliteCount(info.paneId, reqInt(p, "db"), reqStr(p, "table"));
    case "sqlite.query": {
      const params = p.params ?? [];
      if (!Array.isArray(params) || params.length > 999) throw new Error('"params" must be a list');
      return ipc.sqliteQuery(info.paneId, reqInt(p, "db"), reqStr(p, "sql"), params, p.maxRows === undefined ? undefined : reqInt(p, "maxRows", 1, 50_000));
    }
    case "sqlite.setWritable":
      return ipc.sqliteSetWritable(info.paneId, reqInt(p, "db"), optBool(p, "writable") ?? false);
    case "sqlite.interrupt":
      await ipc.sqliteInterrupt(info.paneId, reqInt(p, "db"));
      return true;
    case "sqlite.close":
      await ipc.sqliteClose(info.paneId, reqInt(p, "db"));
      return true;

    case "agents.snapshot":
      return ipc.agentsSnapshot();
    case "agents.activity":
      return ipc.agentsActivity(
        optStr(p, "runId") ?? null,
        p.after === undefined ? undefined : reqInt(p, "after", 0, Number.MAX_SAFE_INTEGER),
        optInt(p, "limit", 1, 2000, 500),
        optBool(p, "latest"),
      );
    case "agents.reveal":
      return revealAgent(reqStr(p, "agentId"));
    case "agents.start": {
      const ws = workspaceOfTab(getState().model, info.tabId);
      if (!ws) throw new Error("the module's pane isn't in a workspace");
      const cwd = p.cwd === undefined || p.cwd === null ? info.cwd : localPath(p, "cwd");
      if (!cwd) throw new Error("open it next to a terminal in your repository, or pick the folder");
      return ipc.agentsStart(ws.id, cwd, optStr(p, "name")?.slice(0, 80) ?? null);
    }
    case "agents.gitInit":
      await ipc.agentsGitInit(localPath(p, "cwd"));
      return true;
    case "agents.stopRun":
      await ipc.agentsStopRun(reqStr(p, "runId"));
      return true;
    case "agents.forgetRun":
      await ipc.agentsForgetRun(reqStr(p, "runId"));
      return true;
    case "agents.hire":
      return ipc.agentsHire(reqStr(p, "runId"), optStr(p, "model") ?? null);
    case "agents.remove":
      await ipc.agentsRemove(reqStr(p, "agentId"));
      return true;
    case "agents.resume":
      await ipc.agentsResume(reqStr(p, "agentId"));
      return true;
    case "agents.interrupt":
      await ipc.agentsInterrupt(reqStr(p, "agentId"), optBool(p, "pause") ?? false);
      return true;
    case "agents.send": {
      const text = reqStr(p, "text");
      if (!text.trim() || text.length > 100_000) throw new Error('"text" must be 1–100000 characters');
      await ipc.agentsSend(reqStr(p, "agentId"), text);
      return true;
    }
    case "agents.answer":
      await ipc.agentsAnswer(reqStr(p, "requestId"), { allow: optBool(p, "allow"), always: optBool(p, "always"), text: optStr(p, "text") });
      return true;
    case "agents.createTask":
      return ipc.agentsTaskCreate(reqStr(p, "runId"), {
        title: reqStr(p, "title"),
        description: optStr(p, "description") ?? "",
        difficulty: reqInt(p, "difficulty", 1, 5),
        followUpOf: optStr(p, "followUpOf") ?? null,
      });
    case "agents.assign":
      return ipc.agentsTaskAssign(reqStr(p, "taskId"), optStr(p, "agentId") ?? null);
    case "agents.cancelTask":
      await ipc.agentsTaskCancel(reqStr(p, "taskId"));
      return true;
    case "agents.review":
      return ipc.agentsTaskReview(reqStr(p, "taskId"), optBool(p, "accept") ?? false, optStr(p, "note"));
    case "agents.setRouting": {
      if (!isPlainObject(p.routing) || !fitsIn(p.routing, 16 * 1024)) throw new Error('"routing" must be a routing object');
      const base = isPlainObject(p.base) ? (p.base as unknown as Routing) : null;
      return ipc.agentsSetRouting(p.routing as unknown as Routing, base);
    }
    case "agents.taskDiff":
      return ipc.agentsTaskDiff(reqStr(p, "taskId"));
    case "agents.mergePreview":
      return ipc.agentsMergePreview(reqStr(p, "runId"));
    case "agents.mergeToBase":
      return ipc.agentsMergeBase(reqStr(p, "runId"));
  }
  throw new Error(`unknown method: ${method}`);
}

/** Show an agent's pane: its workspace, tab and the pane itself. */
async function revealAgent(agentId: string): Promise<boolean> {
  const agent = useAgents.getState().snap?.agents.find((a) => a.id === agentId);
  if (!agent) throw new Error("there's no such agent");
  const m = getState().model;
  const tab = tabOfPane(m, agent.paneId);
  const ws = tab ? workspaceOfTab(m, tab.id) : undefined;
  if (!tab || !ws) throw new Error(`${agent.name}'s pane isn't open`);
  await switchWorkspace(ws.id);
  switchTab(tab.id);
  focusPane(agent.paneId);
  return true;
}
