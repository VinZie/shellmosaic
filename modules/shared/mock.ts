// A stand-in for the host while developing a module in a plain browser
// (`pnpm modules:dev <id>`): storage in localStorage, dialogs in the page, and the
// module's own fake data for everything else. Never part of a release build:
// modules import it only behind `import.meta.env.DEV`.
import type { PaneContext, ShellmosaicSdk } from "./api";

type DeepPartial<T> = { [K in keyof T]?: T[K] extends (...a: never[]) => unknown ? T[K] : DeepPartial<T[K]> };

const DARK: Record<string, string> = {
  "--sm-bg": "#14171c",
  "--sm-surface": "#0e1116",
  "--sm-surface-2": "#1c2129",
  "--sm-border": "#2a303a",
  "--sm-text": "#d9dee7",
  "--sm-text-dim": "#8891a2",
  "--sm-accent": "#7c9cff",
  "--sm-accent-text": "#0b0e12",
  "--sm-danger": "#ef6b7b",
  "--sm-warning": "#f6b958",
  "--sm-success": "#3fd39a",
  "--sm-radius": "8px",
  "--sm-font": '"Segoe UI Variable Text", "Segoe UI", system-ui, sans-serif',
  "--sm-font-size": "13px",
  "--sm-mono": '"Cascadia Code", "Cascadia Mono", Consolas, monospace',
};

const LIGHT: Record<string, string> = {
  ...DARK,
  "--sm-bg": "#ffffff",
  "--sm-surface": "#f2f3f7",
  "--sm-surface-2": "#f7f8fb",
  "--sm-border": "#d9dce4",
  "--sm-text": "#1b1f27",
  "--sm-text-dim": "#5f6879",
  "--sm-accent": "#4a66e8",
  "--sm-accent-text": "#ffffff",
  "--sm-danger": "#d63a4f",
  "--sm-warning": "#b9770e",
  "--sm-success": "#13925f",
};

function toast(message: string, kind = "info") {
  console.log(`[${kind}] ${message}`);
  const el = document.createElement("div");
  el.textContent = message;
  el.style.cssText =
    "position:fixed;right:12px;bottom:12px;z-index:999;padding:8px 12px;border-radius:8px;font:12px system-ui;" +
    `background:${kind === "error" ? "#ef6b7b" : kind === "success" ? "#3fd39a" : "#7c9cff"};color:#000;box-shadow:0 6px 20px #0006`;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 2500);
}

/**
 * Install the stand-in. `api` supplies the module's fake data (process, eventlog,
 * sqlite …); URL parameters choose the rest: ?light for the light theme, ?admin to
 * pretend to run elevated, ?args={"pid":4} for pane arguments.
 */
export function installMock(api: DeepPartial<ShellmosaicSdk>, pluginId = "dev") {
  const q = new URLSearchParams(location.search);
  const theme = q.has("light") ? LIGHT : DARK;
  for (const [k, v] of Object.entries(theme)) document.documentElement.style.setProperty(k, v);
  const stateKey = `mock:${pluginId}:state`;
  let args: Record<string, unknown> | null = null;
  try {
    args = q.get("args") ? JSON.parse(q.get("args")!) : null;
  } catch {
    /* ignore */
  }
  const ctx: PaneContext = {
    pluginId,
    paneId: "dev-pane",
    tabId: "dev-tab",
    workspaceId: "dev",
    cwd: "C:\\Users\\dev",
    visible: true,
    grantedPermissions: [],
    args,
    state: JSON.parse(localStorage.getItem(stateKey) ?? "null"),
    appVersion: "0.3.0",
    elevated: q.has("admin"),
  };
  const store = (k: string) => `mock:${pluginId}:storage:${k}`;
  const later = <T>(v: T, ms = 120) => new Promise<T>((r) => setTimeout(() => r(v), ms));
  const notImplemented = (name: string) => () => Promise.reject(new Error(`${name} isn't mocked`));

  const base: ShellmosaicSdk = {
    version: 2,
    context: () => later(ctx, 0),
    on: () => () => {},
    storage: {
      get: (k) => later(JSON.parse(localStorage.getItem(store(k)) ?? "null"), 0),
      set: (k, v) => (localStorage.setItem(store(k), JSON.stringify(v)), later(true, 0)),
      all: () => later({}, 0),
    },
    ui: {
      notify: (m, kind) => (toast(m, kind), later(true, 0)),
      setTitle: (t) => ((document.title = t), later(true, 0)),
      setState: (s) => (localStorage.setItem(stateKey, JSON.stringify(s)), later(true, 0)),
      confirm: (title, message) => later(window.confirm(`${title}\n\n${message}`), 0),
      pickFile: () => later(window.prompt("Path of the file to open") || null, 0),
      pickFolder: () => later(window.prompt("Folder") || null, 0),
      openModule: (t) => (toast(`would open ${JSON.stringify(t)}`), later(true, 0)),
      reveal: (p) => (toast(`would reveal ${p}`), later(true, 0)),
    },
    app: {
      info: () => later({ version: ctx.appVersion, elevated: ctx.elevated }, 0),
      restartAsAdmin: () => (toast("would restart as administrator"), later(false)),
    },
    clipboard: {
      readText: () => navigator.clipboard.readText(),
      writeText: (t) => navigator.clipboard.writeText(t).then(() => true, () => (console.log("clipboard:", t), true)),
    },
    process: {
      list: notImplemented("process.list"),
      overview: notImplemented("process.overview"),
      modules: notImplemented("process.modules"),
      threads: notImplemented("process.threads"),
      handles: notImplemented("process.handles"),
      token: notImplemented("process.token"),
      memory: notImplemented("process.memory"),
      signature: notImplemented("process.signature"),
      suspend: notImplemented("process.suspend"),
      resume: notImplemented("process.resume"),
      setPriority: notImplemented("process.setPriority"),
      setAffinity: notImplemented("process.setAffinity"),
    },
    thread: {
      suspend: notImplemented("thread.suspend"),
      resume: notImplemented("thread.resume"),
      terminate: notImplemented("thread.terminate"),
    },
    eventlog: {
      channels: notImplemented("eventlog.channels"),
      info: notImplemented("eventlog.info"),
      query: notImplemented("eventlog.query"),
      more: notImplemented("eventlog.more"),
      close: () => later(true, 0),
      subscribe: notImplemented("eventlog.subscribe"),
      poll: () => later([], 0),
      unsubscribe: () => later(true, 0),
    },
    sqlite: {
      open: notImplemented("sqlite.open"),
      schema: notImplemented("sqlite.schema"),
      count: notImplemented("sqlite.count"),
      query: notImplemented("sqlite.query"),
      setWritable: notImplemented("sqlite.setWritable"),
      interrupt: () => later(true, 0),
      close: () => later(true, 0),
    },
    claude: {
      usage: notImplemented("claude.usage"),
    },
    agents: {
      snapshot: notImplemented("agents.snapshot"),
      activity: notImplemented("agents.activity"),
      reveal: notImplemented("agents.reveal"),
      start: notImplemented("agents.start"),
      gitInit: notImplemented("agents.gitInit"),
      stopRun: notImplemented("agents.stopRun"),
      forgetRun: notImplemented("agents.forgetRun"),
      hire: notImplemented("agents.hire"),
      remove: notImplemented("agents.remove"),
      resume: notImplemented("agents.resume"),
      interrupt: notImplemented("agents.interrupt"),
      send: notImplemented("agents.send"),
      answer: notImplemented("agents.answer"),
      createTask: notImplemented("agents.createTask"),
      assign: notImplemented("agents.assign"),
      cancelTask: notImplemented("agents.cancelTask"),
      review: notImplemented("agents.review"),
      setRouting: notImplemented("agents.setRouting"),
      taskDiff: notImplemented("agents.taskDiff"),
      mergePreview: notImplemented("agents.mergePreview"),
      mergeToBase: notImplemented("agents.mergeToBase"),
    },
  };

  const merged = base as unknown as Record<string, Record<string, unknown>>;
  for (const [ns, fns] of Object.entries(api)) {
    if (fns && typeof fns === "object") merged[ns] = { ...(merged[ns] ?? {}), ...(fns as object) };
  }
  const sdk = merged as unknown as ShellmosaicSdk & { ready: Promise<PaneContext> };
  sdk.ready = Promise.resolve({ ...ctx, theme });
  window.shellmosaic = sdk;
}
