import { getCurrentWindow } from "@tauri-apps/api/window";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { ErrorBoundary } from "./components/Workspace";
import { errorText } from "./lib/ipc";
import { registerBuiltinModules } from "./modules";
import { loadPlugins } from "./modules/plugin/loader";
import { paneSpec } from "./state/actions";
import { createWorkspace, emptyModel, setWindowWorkspace, windowOfWorkspace, type Model } from "./state/model";
import { loadProfiles } from "./state/profiles";
import { loadSettings, settings } from "./state/settings";
import { getState, initModel, onPanesRemoved, useModel } from "./state/store";
import { activeTheme, applyTheme, loadThemes } from "./state/themes";
import { startModuleStore } from "./state/moduleStore";
import { startUpdateChecks } from "./state/updater";
import { getModule } from "./modules/registry";
import "./styles/app.css";

let freshStartDone = false;
// a reloaded window (e.g. "Reload window" after an error) is not a new session: its shells are still running
const reloaded = (performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined)?.type === "reload";

/** Make sure this window has a workspace to show (and the app has at least one). */
function seed(m: Model) {
  const label = getCurrentWindow().label;
  if (label !== "main") return;
  if (!settings().restore.session && !freshStartDone && !reloaded) {
    freshStartDone = true;
    Object.assign(m, emptyModel());
  }
  if (!m.order.length) createWorkspace(m, { name: "Main", icon: "square-terminal", firstPane: paneSpec("terminal") });
  const current = m.windows.main?.workspace;
  if (!current || !m.workspaces[current]) {
    setWindowWorkspace(m, "main", m.order.find((w) => !windowOfWorkspace(m, w)) ?? m.order[0]);
  }
}

async function boot() {
  await loadSettings();
  await loadThemes();
  applyTheme(activeTheme(settings()), settings());
  registerBuiltinModules();
  await loadProfiles();
  // free a pane's resources (shell, web view, log tail…) when it's closed for good
  onPanesRemoved((ids, prev) => {
    for (const id of ids) {
      const pane = prev.panes[id];
      if (pane) getModule(pane.module)?.onRemove?.(id, pane);
    }
  });
  await initModel(seed);
  const label = getCurrentWindow().label;
  if (label !== "main" && !getState().model.windows[label]) {
    await getCurrentWindow().close();
    return;
  }
  if (label !== "main") {
    // its workspace was deleted (from any window) with none free to show instead: nothing left here.
    // (only once a change is saved: a local commit shows its draft before the backend accepts it)
    let closing = false;
    useModel.subscribe((s, prev) => {
      if (closing || s.version === prev.version || s.model.windows[label]) return;
      closing = true;
      getCurrentWindow().close().catch(console.error);
    });
  }
  // (first: installs applied at this start get their permissions before their panes load)
  await startModuleStore();
  loadPlugins().catch(console.error);
  startUpdateChecks();
  // last resort: a render error outside any pane would otherwise leave a blank window.
  // Shells live in the backend, so reloading the window loses nothing.
  createRoot(document.getElementById("root")!).render(
    <ErrorBoundary
      name="Shellmosaic"
      fallback={(err) => (
        <div className="empty-state" style={{ position: "fixed", inset: 0, background: "var(--bg)", color: "var(--text)" }}>
          <h2 style={{ fontSize: 14 }}>Shellmosaic hit an error</h2>
          <p className="dim selectable" style={{ maxWidth: 520 }}>{err.message}</p>
          <button className="btn primary" onClick={() => location.reload()}>
            Reload window
          </button>
        </div>
      )}
    >
      <App />
    </ErrorBoundary>,
  );
  requestAnimationFrame(() => getCurrentWindow().show());
}

boot().catch((e) => {
  const pre = document.createElement("pre");
  pre.style.cssText = "color:#f88;padding:24px;font:13px monospace;white-space:pre-wrap";
  pre.textContent = `Shellmosaic failed to start:\n\n${errorText(e)}`;
  document.body.replaceChildren(pre);
  getCurrentWindow().show();
});
