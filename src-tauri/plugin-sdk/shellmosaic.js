/*
 * Shellmosaic plugin SDK (v2)
 *
 * Include from your plugin's HTML:
 *   <script src="/__sdk/shellmosaic.js"></script>
 *
 * Plugins run in a sandboxed iframe. Every call below is a message to the host,
 * which checks it against the permissions in your manifest.json (and that the
 * user granted them) before doing anything.
 */
(() => {
  if (window.shellmosaic) return;

  const pending = new Map();
  const listeners = new Map();
  let seq = 0;

  // The host loads this page with a one-time token (#smt=…) and only answers messages
  // that carry it, so another page that ends up in the frame (a followed link) gets nothing.
  const m = /(?:^#|&)smt=([\w-]+)/.exec(location.hash);
  const token = m ? m[1] : "";
  if (m) {
    const hash = location.hash.replace(/(^#|&)smt=[\w-]+/, "$1").replace(/^#&/, "#").replace(/^#$/, "");
    try {
      history.replaceState(history.state, "", location.pathname + location.search + hash);
    } catch {
      /* the token stays in the address; harmless */
    }
  }

  const call = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++seq;
      pending.set(id, { resolve, reject });
      window.parent.postMessage({ __sm: 1, token, id, method, params }, "*");
    });

  function applyTheme(vars) {
    if (!vars) return;
    const root = document.documentElement;
    for (const [k, v] of Object.entries(vars)) root.style.setProperty(k, String(v));
  }

  window.addEventListener("message", (ev) => {
    if (ev.source !== window.parent) return;
    const m = ev.data;
    if (!m || m.__sm !== 1) return;
    if (m.id && pending.has(m.id)) {
      const p = pending.get(m.id);
      pending.delete(m.id);
      if (m.error) p.reject(new Error(m.error));
      else p.resolve(m.result);
      return;
    }
    if (m.event) {
      if (m.event === "theme") applyTheme(m.data);
      for (const fn of listeners.get(m.event) || []) {
        try {
          fn(m.data);
        } catch (e) {
          console.error(e);
        }
      }
    }
  });

  // Let app shortcuts (Ctrl/Alt combos, F-keys) work while focus is in the plugin.
  // The host only honours navigation commands from these.
  window.addEventListener(
    "keydown",
    (e) => {
      if (!(e.ctrlKey || e.altKey || e.metaKey || /^F\d+$/.test(e.key))) return;
      window.parent.postMessage(
        { __sm: 1, token, shortcut: { code: e.code, key: e.key, ctrlKey: e.ctrlKey, altKey: e.altKey, shiftKey: e.shiftKey, metaKey: e.metaKey } },
        "*",
      );
    },
    true,
  );

  // Base styles that follow the user's theme. Opt out with <html data-sm-nostyle>.
  if (!document.documentElement.hasAttribute("data-sm-nostyle")) {
    const style = document.createElement("style");
    style.textContent = `
      :root { color-scheme: dark light; }
      html, body { margin: 0; height: 100%; }
      body { background: var(--sm-bg, #111); color: var(--sm-text, #ddd);
             font: var(--sm-font-size, 13px)/1.45 var(--sm-font, system-ui, sans-serif); }
      button { font: inherit; color: var(--sm-text); background: var(--sm-surface-2, #222);
               border: 1px solid var(--sm-border, #333); border-radius: var(--sm-radius, 6px);
               padding: 4px 10px; cursor: pointer; }
      button:hover { border-color: var(--sm-accent, #79f); }
      button.primary { background: var(--sm-accent, #79f); color: var(--sm-accent-text, #000); border-color: transparent; }
      input, textarea, select { font: inherit; color: var(--sm-text); background: var(--sm-surface, #181818);
               border: 1px solid var(--sm-border, #333); border-radius: var(--sm-radius, 6px); padding: 4px 8px; }
      input:focus, textarea:focus { outline: 1px solid var(--sm-accent, #79f); border-color: transparent; }
      code, pre { font-family: var(--sm-mono, ui-monospace, monospace); }
      .dim { color: var(--sm-text-dim, #888); }
    `;
    document.head.appendChild(style);
  }

  let markReady;
  const ready = new Promise((resolve) => (markReady = resolve));

  window.shellmosaic = {
    version: 2,
    /** Resolves with the context (and theme) once the host answered (permissions asked). */
    ready,
    /** { pluginId, paneId, tabId, workspaceId, cwd, visible, grantedPermissions, args, state, appVersion, elevated } */
    context: () => call("context"),
    /** Subscribe to host events: "theme", "cwd", "visible". Returns an unsubscribe fn. */
    on(event, fn) {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event).add(fn);
      return () => listeners.get(event).delete(fn);
    },
    terminal: {
      /** Type text into the most recently focused terminal in this tab. Needs terminal.write */
      write: (text) => call("terminal.write", { text }),
      /** Open a new terminal pane running `command`. Needs terminal.run */
      run: (command, opts = {}) => call("terminal.run", { command, ...opts }),
      /** Recent output of the focused terminal as plain text. Needs terminal.read */
      read: (opts = {}) => call("terminal.read", opts),
    },
    fs: {
      list: (path) => call("fs.list", { path }), // fs.read
      readText: (path) => call("fs.readText", { path }), // fs.read
      writeText: (path, text) => call("fs.writeText", { path, text }), // fs.write
    },
    shell: {
      /** Run a program to completion (no shell). Needs shell.exec */
      exec: (program, args = [], opts = {}) => call("shell.exec", { program, args, ...opts }),
    },
    system: {
      stats: () => call("system.stats"), // system.read
    },
    clipboard: {
      readText: () => call("clipboard.readText"), // clipboard
      writeText: (text) => call("clipboard.writeText", { text }), // clipboard
    },
    claude: {
      /** Claude plan limits of the account Claude Code is signed in with. Needs claude.usage */
      usage: () => call("claude.usage"),
    },
    /** Per-plugin key/value storage (no permission needed). */
    storage: {
      get: (key) => call("storage.get", { key }),
      set: (key, value) => call("storage.set", { key, value }),
      all: () => call("storage.all"),
    },
    ui: {
      notify: (message, kind = "info") => call("ui.notify", { message, kind }),
      setTitle: (title) => call("ui.setTitle", { title }),
      /** Saved with the pane (max 64 KB of JSON); context().state after a restart. */
      setState: (state) => call("ui.setState", { state }),
      /** The app's confirmation dialog → true / false. */
      confirm: (title, message, opts = {}) => call("ui.confirm", { title, message, ...opts }),
      /** The Open dialog → a path or null. filters: [{ name, extensions: ["db"] }] */
      pickFile: (opts = {}) => call("ui.pickFile", opts),
      /** The folder picker → a path or null. */
      pickFolder: (opts = {}) => call("ui.pickFolder", opts),
      /** Open a module next to this pane: { module: "processes" | "ports", filter } | { module: "files" | "git", path } | { module: "plugin:<id>", args } */
      openModule: (target) => call("ui.openModule", target),
      /** Show a local file selected in Explorer. */
      reveal: (path) => call("ui.reveal", { path }),
    },
    app: {
      /** { version, elevated } */
      info: () => call("app.info"),
      /** Ask the user, then relaunch Shellmosaic as administrator. false when declined. */
      restartAsAdmin: () => call("app.restartAsAdmin"),
    },
    /** process.inspect (inspection) and process.control (suspend, priority, affinity, threads) */
    process: {
      list: () => call("process.list"),
      overview: (pid) => call("process.overview", { pid }),
      modules: (pid) => call("process.modules", { pid }),
      threads: (pid) => call("process.threads", { pid }),
      handles: (pid) => call("process.handles", { pid }),
      token: (pid) => call("process.token", { pid }),
      memory: (pid) => call("process.memory", { pid }),
      signature: (path) => call("process.signature", { path }),
      suspend: (pid) => call("process.suspend", { pid }),
      resume: (pid) => call("process.resume", { pid }),
      setPriority: (pid, priority) => call("process.setPriority", { pid, priority }),
      setAffinity: (pid, mask) => call("process.setAffinity", { pid, mask: String(mask) }),
    },
    thread: {
      suspend: (pid, tid) => call("thread.suspend", { pid, tid }),
      resume: (pid, tid) => call("thread.resume", { pid, tid }),
      terminate: (pid, tid) => call("thread.terminate", { pid, tid }),
    },
    /** eventlog.read */
    eventlog: {
      channels: () => call("eventlog.channels"),
      info: (channel) => call("eventlog.info", { channel }),
      /** { channel, xpath?, reverse? (default true), text?, max? } → { cursor, events (XML), done, scanned } */
      query: (q) => call("eventlog.query", q),
      more: (cursor, max) => call("eventlog.more", { cursor, max }),
      close: (cursor) => call("eventlog.close", { cursor }),
      subscribe: (q) => call("eventlog.subscribe", q),
      poll: (subscription, max) => call("eventlog.poll", { subscription, max }),
      unsubscribe: (subscription) => call("eventlog.unsubscribe", { subscription }),
    },
    /** sqlite: databases open read-only unless writable is asked for */
    sqlite: {
      open: (path, opts = {}) => call("sqlite.open", { path, ...opts }),
      schema: (db) => call("sqlite.schema", { db }),
      count: (db, table) => call("sqlite.count", { db, table }),
      query: (db, sql, params = [], opts = {}) => call("sqlite.query", { db, sql, params, ...opts }),
      setWritable: (db, writable) => call("sqlite.setWritable", { db, writable }),
      interrupt: (db) => call("sqlite.interrupt", { db }),
      close: (db) => call("sqlite.close", { db }),
    },
    /**
     * The Orchestrator: teams of Claude Code agents. Reading needs agents.read (and the
     * "agents" event { rev } arrives on every change); everything else needs agents.manage.
     */
    agents: {
      snapshot: () => call("agents.snapshot"),
      activity: (opts = {}) => call("agents.activity", opts),
      reveal: (agentId) => call("agents.reveal", { agentId }),
      /** { cwd?, name? }: a team in this pane's workspace, in the repository cwd is in */
      start: (opts = {}) => call("agents.start", opts),
      gitInit: (cwd) => call("agents.gitInit", { cwd }),
      stopRun: (runId) => call("agents.stopRun", { runId }),
      forgetRun: (runId) => call("agents.forgetRun", { runId }),
      hire: (runId, opts = {}) => call("agents.hire", { runId, ...opts }),
      remove: (agentId) => call("agents.remove", { agentId }),
      resume: (agentId) => call("agents.resume", { agentId }),
      interrupt: (agentId, opts = {}) => call("agents.interrupt", { agentId, ...opts }),
      send: (agentId, text) => call("agents.send", { agentId, text }),
      /** { allow, always? } for permission requests, { text } for questions */
      answer: (requestId, answer) => call("agents.answer", { requestId, ...answer }),
      createTask: (runId, task) => call("agents.createTask", { runId, ...task }),
      assign: (taskId, agentId) => call("agents.assign", { taskId, agentId }),
      cancelTask: (taskId) => call("agents.cancelTask", { taskId }),
      review: (taskId, accept, note) => call("agents.review", { taskId, accept, note }),
      setRouting: (routing, base) => call("agents.setRouting", { routing, base }),
      taskDiff: (taskId) => call("agents.taskDiff", { taskId }),
      mergePreview: (runId) => call("agents.mergePreview", { runId }),
      mergeToBase: (runId) => call("agents.mergeToBase", { runId }),
    },
  };

  call("ready").then((info) => {
    applyTheme(info && info.theme);
    markReady(info);
    window.dispatchEvent(new CustomEvent("shellmosaic:ready", { detail: info }));
  });
})();
