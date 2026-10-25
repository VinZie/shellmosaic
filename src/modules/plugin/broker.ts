// Permission-checked bridge between sandboxed plugin iframes and the app.
//
// Plugins run in `<iframe sandbox="allow-scripts …">` (opaque origin, no IPC).
// The SDK (src-tauri/plugin-sdk/shellmosaic.js) posts `{__sm: 1, id, method,
// params}` to the parent; we answer with `{__sm: 1, id, result | error}` and
// push `{__sm: 1, event, data}` for "theme", "cwd" and "visible".
//
// A method that needs a permission only runs when the plugin declared it in
// manifest.json AND the user granted it (settings.plugins.grants[pluginId]).
import { readText, writeText } from "@tauri-apps/plugin-clipboard-manager";
import { errorText, ipc } from "../../lib/ipc";
import { isPlainObject } from "../../lib/util";
import { runInNewTerminal, sendToTerminal } from "../../state/actions";
import { commandForEvent } from "../../state/commands";
import { leaves, type Side } from "../../state/layout";
import { workspaceOfTab } from "../../state/model";
import { settings, updateSettings, useSettings } from "../../state/settings";
import { getState } from "../../state/store";
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
  "storage.get": null,
  "storage.set": null,
  "storage.all": null,
  "ui.notify": null,
  "ui.setTitle": null,
};

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
    },
  };
}

function install() {
  if (installed) return;
  installed = true;
  window.addEventListener("message", onWindowMessage);
  watchTheme();
}

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

function contextOf(s: Internal) {
  const { info } = s;
  const granted = grantedPermissions(info.pluginId);
  return {
    pluginId: info.pluginId,
    paneId: info.paneId,
    tabId: info.tabId,
    workspaceId: workspaceOfTab(getState().model, info.tabId)?.id ?? null,
    cwd: info.cwd ?? null,
    visible: info.visible,
    grantedPermissions: info.permissions.filter((p) => granted.includes(p)),
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
      if (missingPermissions(pluginId, permissions).length && !deniedThisRun.has(pluginId)) {
        // style the plugin right away; the reply waits for the user's answer
        push(s, "theme", themeVars());
        await requestPermissions(pluginId, name, permissions);
      }
      return { ...contextOf(s), theme: themeVars() };
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
  }
  throw new Error(`unknown method: ${method}`);
}
