import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { open } from "@tauri-apps/plugin-dialog";
import { openPath } from "@tauri-apps/plugin-opener";
import { useCallback, useEffect, useState } from "react";
import { Icon, ICONS } from "../../lib/icons";
import { errorText, ipc, type PluginInfo } from "../../lib/ipc";
import { cx, joinPath } from "../../lib/util";
import { reloadPlugins } from "../../modules/plugin/loader";
import { resetSettings, updateSettings, useSettings } from "../../state/settings";
import { ui } from "../../state/ui";
import { Group, Hl, Searchable, Section, Switch, useMatch, useSearch } from "./controls";
import { attempt, openInDataDir, useDataDir } from "./helpers";

const PERMISSIONS: { id: string; icon: string; text: string; risky?: boolean }[] = [
  { id: "terminal.write", icon: "terminal", text: "Type into terminals in its tab", risky: true },
  { id: "terminal.read", icon: "terminal", text: "Read recent terminal output" },
  { id: "terminal.run", icon: "play", text: "Open new terminals that run commands", risky: true },
  { id: "fs.read", icon: "folder", text: "Read files and folders on your computer" },
  { id: "fs.write", icon: "folder", text: "Create and change files on your computer", risky: true },
  { id: "shell.exec", icon: "zap", text: "Run programs on your computer", risky: true },
  { id: "system.read", icon: "gauge", text: "Read CPU, memory and network statistics" },
  { id: "clipboard", icon: "clipboard-paste", text: "Read and write the clipboard" },
  { id: "net", icon: "globe", text: "Connect to the internet (HTTPS)" },
  { id: "claude.usage", icon: "gauge", text: "Read your Claude plan usage limits (never your sign-in token)" },
];
const permInfo = (id: string) => PERMISSIONS.find((p) => p.id === id);
const plainText = (v: unknown) => (typeof v === "string" || typeof v === "number" ? String(v) : undefined);

async function reload() {
  await attempt(() => reloadPlugins());
}

// ── plugin cards ──────────────────────────────────────────────────────────

function PluginCard({ p, onChanged }: { p: PluginInfo; onChanged: () => void }) {
  const disabled = useSettings((s) => s.settings.plugins.disabled.includes(p.id));
  const grants = useSettings((s) => s.settings.plugins.grants[p.id]);
  const m = p.manifest;
  const match = useMatch(m?.name, p.id, m?.description, m?.author, "plugin extension");
  if (!match) return null;

  const setEnabled = async (on: boolean) => {
    updateSettings((s) => {
      s.plugins.disabled = on ? s.plugins.disabled.filter((x) => x !== p.id) : [...new Set([...s.plugins.disabled, p.id])];
    });
    await reload();
  };
  const revoke = async () => {
    updateSettings((s) => void delete s.plugins.grants[p.id]);
    await reload();
    ui.toast(`Permissions revoked. ${m?.name ?? p.id} will ask again next time it opens.`, "info");
  };
  const remove = async () => {
    const ok = await ui.confirm(`Remove “${m?.name ?? p.id}”?`, "The plugin folder is moved to the Recycle Bin. Open panes of this plugin will close.", {
      okLabel: "Remove",
      danger: true,
    });
    if (!ok) return;
    const done = await attempt(async () => {
      await ipc.pluginRemove(p.id);
      return true;
    });
    if (!done) return;
    updateSettings((s) => {
      delete s.plugins.grants[p.id];
      s.plugins.disabled = s.plugins.disabled.filter((x) => x !== p.id);
    });
    await reload();
    onChanged();
    ui.toast(`Removed “${m?.name ?? p.id}”`, "success");
  };
  const openFolder = () => openPath(p.dir).catch((e) => ui.toast(errorText(e), "error"));

  if (!m) {
    return (
      <div className="plugin-card invalid setting-hit">
        <span className="plugin-icon">
          <Icon name="warning" size={18} />
        </span>
        <div className="plugin-body">
          <div className="plugin-title">
            <strong>
              <Hl text={p.id} />
            </strong>
            <span className="chip">not loaded</span>
          </div>
          <div className="plugin-error">{p.error ?? "Unknown error"}</div>
          <div className="plugin-foot">
            <button className="btn small" onClick={openFolder}>
              <Icon name="folder-open" size={13} /> Open folder
            </button>
            <span className="grow" />
            <button className="btn small danger subtle" onClick={remove}>
              <Icon name="trash" size={13} /> Remove
            </button>
          </div>
        </div>
      </div>
    );
  }

  // the backend only checks id, name, entry and permission names: an npm-style
  // `"author": { … }` or a string `permissions` must not crash this page
  const declared = Array.isArray(m.permissions) ? m.permissions : [];
  const icon = typeof m.icon === "string" && Object.prototype.hasOwnProperty.call(ICONS, m.icon) ? m.icon : "puzzle";
  const version = plainText(m.version);
  const author = plainText(m.author);
  const description = plainText(m.description);
  const granted = new Set(grants ?? []);
  return (
    <div className={cx("plugin-card setting-hit", disabled && "disabled")}>
      <span className="plugin-icon">
        <Icon name={icon} size={18} />
      </span>
      <div className="plugin-body">
        <div className="plugin-title">
          <strong>
            <Hl text={m.name} />
          </strong>
          {version && <span className="chip">v{version}</span>}
          {author && <span className="dim">by {author}</span>}
          <span className="grow" />
          <span className="plugin-state dim">{disabled ? "Disabled" : "Enabled"}</span>
          <Switch value={!disabled} onChange={setEnabled} title={disabled ? "Enable plugin" : "Disable plugin"} />
        </div>
        {description && <p className="plugin-desc">{description}</p>}
        <div className="perm-chips">
          {declared.length === 0 && <span className="dim small-text">Needs no special permissions.</span>}
          {declared.map((perm) => {
            const info = permInfo(perm);
            const ok = granted.has(perm);
            return (
              <span key={perm} className={cx("chip", ok ? "granted" : info?.risky && "risky")} title={`${info?.text ?? perm} — ${ok ? "allowed" : "not allowed yet (asked when the plugin opens)"}`}>
                <Icon name={ok ? "check" : (info?.icon ?? "shield")} size={11} />
                {perm}
              </span>
            );
          })}
        </div>
        <div className="plugin-foot">
          <code className="plugin-id">{p.id}</code>
          <span className="grow" />
          <button className="btn small subtle" onClick={openFolder}>
            <Icon name="folder-open" size={13} /> Folder
          </button>
          {granted.size > 0 && (
            <button className="btn small subtle" onClick={revoke} title="Forget the permissions you allowed; the plugin asks again next time">
              <Icon name="shield" size={13} /> Revoke permissions
            </button>
          )}
          <button className="btn small danger subtle" onClick={remove}>
            <Icon name="trash" size={13} /> Remove
          </button>
        </div>
      </div>
    </div>
  );
}

// ── guide ─────────────────────────────────────────────────────────────────

const MANIFEST_EXAMPLE = `{
  "id": "my-plugin",
  "name": "My Plugin",
  "version": "1.0.0",
  "author": "You",
  "description": "What it does, in one line.",
  "icon": "rocket",
  "entry": "index.html",
  "permissions": ["terminal.write"]
}`;

const HTML_EXAMPLE = `<!doctype html>
<html>
  <body>
    <button id="hi" class="primary">Say hi in the terminal</button>
    <script src="/__sdk/shellmosaic.js"></script>
    <script>
      document.getElementById("hi").onclick = () =>
        shellmosaic.terminal.write("echo hello from my plugin\\r");
    </script>
  </body>
</html>`;

const API: [string, string, string?][] = [
  ["terminal.write(text)", "Type text into the last focused terminal in this tab (add \\r to press Enter)", "terminal.write"],
  ["terminal.run(command)", "Open a new terminal pane that runs a command", "terminal.run"],
  ["terminal.read()", "Recent output of the focused terminal as plain text", "terminal.read"],
  ["fs.list / fs.readText(path)", "List folders, read text files", "fs.read"],
  ["fs.writeText(path, text)", "Write a text file", "fs.write"],
  ["shell.exec(program, args)", "Run a program and get its output", "shell.exec"],
  ["system.stats()", "CPU, memory and network numbers", "system.read"],
  ["clipboard.readText / writeText", "Use the clipboard", "clipboard"],
  ["claude.usage()", "Claude plan limits of the signed-in Claude Code account", "claude.usage"],
  ["storage.get / set / all", "Save the plugin's own data"],
  ["ui.notify(message, kind)", "Show a toast"],
  ["ui.setTitle(title)", "Set the pane title"],
  ["context() · on(event, fn)", "Pane/tab info; listen for \"theme\", \"cwd\", \"visible\""],
];

function CodeBlock({ code }: { code: string }) {
  return (
    <div className="code-block">
      <pre>{code}</pre>
      <button
        className="icon-btn"
        title="Copy"
        onClick={() =>
          writeText(code)
            .then(() => ui.toast("Copied", "success", 1200))
            .catch((e) => ui.toast(errorText(e), "error"))
        }
      >
        <Icon name="copy" size={13} />
      </button>
    </div>
  );
}

function BuildYourOwn({ hasExample }: { hasExample: boolean }) {
  const dir = useDataDir();
  const pluginsDir = dir ? joinPath(dir, "plugins") : "<data>\\plugins";
  return (
    <Searchable label="Build your own plugin" keywords="sdk api develop manifest html guide example command board">
      <details className="guide card">
        <summary>
          <Icon name="wrench" size={15} /> Build your own plugin
          <span className="dim"> — a folder with a manifest and a web page</span>
        </summary>
        <div className="guide-body">
          <p>
            A plugin is a folder <code>{joinPath(pluginsDir, "<id>")}</code> that holds a <code>manifest.json</code> and an HTML page. It shows up as a module
            you can add to any tab and runs in a sandbox: it can only do what its permissions allow, after you agree.
          </p>
          {hasExample && (
            <p>
              The easiest start: copy the bundled <b>Command Board</b> example, rename the folder, change its <code>id</code> to match, then press <b>Reload</b>.{" "}
              <button className="btn small" onClick={() => openInDataDir("plugins", "command-board")}>
                <Icon name="folder-open" size={13} /> Open the example
              </button>
            </p>
          )}
          <h4>manifest.json</h4>
          <p>
            <code>id</code> must match the folder name (letters, digits, <code>-</code>, <code>_</code>). <code>icon</code> is any icon name used in the app.
          </p>
          <CodeBlock code={MANIFEST_EXAMPLE} />
          <h4>index.html</h4>
          <p>
            Include the SDK with <code>&lt;script src="/__sdk/shellmosaic.js"&gt;&lt;/script&gt;</code>. Basic styles follow the user's theme automatically;
            the colors are also available as CSS variables (<code>--sm-accent</code>, <code>--sm-text</code>, …).
          </p>
          <CodeBlock code={HTML_EXAMPLE} />
          <h4>API — everything returns a Promise</h4>
          <table className="api-table">
            <tbody>
              {API.map(([call, what, perm]) => (
                <tr key={call}>
                  <td>
                    <code>shellmosaic.{call}</code>
                  </td>
                  <td>{what}</td>
                  <td>{perm ? <span className="chip">{perm}</span> : <span className="dim">—</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <h4>Permissions</h4>
          <ul className="perm-list">
            {PERMISSIONS.map((p) => (
              <li key={p.id}>
                <Icon name={p.icon} size={14} />
                <span>{p.text}</span>
                <code>{p.id}</code>
              </li>
            ))}
          </ul>
          <p>
            Without <code>net</code>, plugins can't reach the internet. After editing files, press <b>Reload</b> here to pick up the changes.
          </p>
        </div>
      </details>
    </Searchable>
  );
}

// ── section ───────────────────────────────────────────────────────────────

export function PluginsSection() {
  const [list, setList] = useState<PluginInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const q = useSearch();

  const load = useCallback(async () => {
    try {
      setList(await ipc.pluginsList());
      setError(null);
    } catch (e) {
      setError(errorText(e));
    }
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  const reloadAll = async () => {
    setBusy(true);
    await reload();
    await load();
    setBusy(false);
    ui.toast("Plugins reloaded", "success", 1500);
  };

  const install = async () => {
    const dir = await open({ directory: true, multiple: false, title: "Choose a plugin folder (it contains manifest.json)" });
    if (typeof dir !== "string") return;
    // warn before replacing an installed plugin with the same id
    const norm = (p: string) => p.replace(/[\\/]+$/, "").toLowerCase();
    let replacing = false;
    try {
      const manifest = JSON.parse(await ipc.fsReadText(joinPath(dir, "manifest.json"))) as { id?: string; name?: string };
      const existing = list?.find((p) => p.id === manifest.id);
      // (picking the installed folder itself is a no-op in the backend, not a replacement)
      if (existing && norm(existing.dir) !== norm(dir)) {
        const ok = await ui.confirm(`Replace “${existing.manifest?.name ?? existing.id}”?`, "A plugin with this id is already installed. The old copy goes to the Recycle Bin, and the new one has to ask for its permissions again.", { okLabel: "Replace" });
        if (!ok) return;
        replacing = true;
      }
    } catch {
      /* let the backend report what's wrong */
    }
    const id = await attempt(() => ipc.pluginInstallFolder(dir));
    if (!id) return;
    // different code under the same id must not inherit what the user granted the old copy.
    // Always, not only when `replacing`: reading the manifest above can fail (it's capped)
    // while the backend still installs over an existing plugin.
    void replacing;
    updateSettings((s) => void delete s.plugins.grants[id]);
    await reload();
    await load();
    ui.toast(`Installed “${id}”. Add it from the module bar or “Add module…”.`, "success", 4500);
  };

  const valid = list?.filter((p) => p.manifest) ?? [];
  const broken = list?.filter((p) => !p.manifest) ?? [];
  const hasExample = !!list?.some((p) => p.id === "command-board");

  return (
    <Section
      id="plugins"
      title="Plugins"
      icon="puzzle"
      desc="Extra modules made by you or others. Plugins run sandboxed and only get the permissions you allow."
      onReset={() => {
        resetSettings("plugins");
        reload();
      }}
      resetHint="Re-enables every plugin and forgets all permissions you granted (plugins will ask again). Installed plugins are kept."
    >
      <Group
        title="Installed"
        plain
        actions={
          <>
            <button className="btn small primary" onClick={install}>
              <Icon name="download" size={13} /> Install from folder…
            </button>
            <button className="btn small" onClick={() => openInDataDir("plugins")}>
              <Icon name="folder-open" size={13} /> Plugins folder
            </button>
            <button className="btn small subtle" onClick={reloadAll} disabled={busy} title="Scan the plugins folder again">
              <Icon name="refresh" size={13} className={busy ? "spin" : undefined} /> Reload
            </button>
          </>
        }
      >
        {error && <div className="settings-empty small danger-text">Couldn't list plugins: {error}</div>}
        {!list && !error && <div className="settings-empty small">Looking for plugins…</div>}
        {list && list.length === 0 && !q && (
          <div className="settings-empty small">
            No plugins installed. Use “Install from folder…”, or build one with the guide below.
          </div>
        )}
        <div className="plugin-list">
          {[...valid, ...broken].map((p) => (
            <PluginCard key={p.id} p={p} onChanged={load} />
          ))}
        </div>
      </Group>
      <Group title="Develop" plain>
        <BuildYourOwn hasExample={hasExample} />
      </Group>
    </Section>
  );
}
