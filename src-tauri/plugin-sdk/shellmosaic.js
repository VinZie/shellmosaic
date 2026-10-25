/*
 * Shellmosaic plugin SDK (v1)
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

  window.shellmosaic = {
    version: 1,
    /** { pluginId, paneId, tabId, workspaceId, cwd, grantedPermissions } */
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
    },
  };

  call("ready").then((info) => {
    applyTheme(info && info.theme);
    window.dispatchEvent(new CustomEvent("shellmosaic:ready", { detail: info }));
  });
})();
