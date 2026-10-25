import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useEffect } from "react";
import { CommandPalette } from "./components/CommandPalette";
import { ContextMenu } from "./components/ContextMenu";
import { DialogHost } from "./components/Dialogs";
import { ModuleBar } from "./components/ModuleBar";
import { DragLayer, Toasts } from "./components/Overlays";
import { Rail } from "./components/Rail";
import { TitleBar } from "./components/TitleBar";
import { BackgroundLayer, ErrorBoundary, WorkspaceView } from "./components/Workspace";
import { Icon } from "./lib/icons";
import { ipc } from "./lib/ipc";
import { cx, shellQuote } from "./lib/util";
import { sftpUploadPaths } from "./modules/sftp/SftpPane";
import { focusTerm, getTerm } from "./modules/terminal/termRegistry";
import { SettingsView } from "./settings/SettingsView";
import { ThemeEditor } from "./settings/ThemeEditor";
import * as A from "./state/actions";
import { commandForEvent, eventToCombo } from "./state/commands";
import { findProfile } from "./state/profiles";
import { flushSettings, useSettings } from "./state/settings";
import { activeTab, getState } from "./state/store";
import { activeTheme, applyTheme, useThemes } from "./state/themes";
import { ui, useOverlayOpen, useUi } from "./state/ui";

function useGlobalShortcuts() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      // let dialogs/menus handle their own keys
      const s = ui.get();
      if (s.dialog || s.menu) return;
      // a focused widget can claim keys it handles itself (Files: F2 rename, Alt+arrows)
      const own = (e.target as HTMLElement | null)?.closest?.("[data-own-keys]")?.getAttribute("data-own-keys");
      const combo = own ? eventToCombo(e) : null;
      if (combo && own!.split(" ").includes(combo)) return;
      const cmd = commandForEvent(e);
      if (!cmd) return;
      e.preventDefault();
      e.stopPropagation();
      cmd.run();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);
}

function useBackendEvents() {
  useEffect(() => {
    const unsubs = [
      listen<{ paneId: string; cwd: string }>("pty://cwd", (e) => ui.setCwd(e.payload.paneId, e.payload.cwd)),
      listen<{ paneId: string; title: string }>("pty://title", (e) => ui.setTitle(e.payload.paneId, e.payload.title)),
      listen<string>("window://closed", (e) => {
        if (getState().label === "main") A.windowClosed(e.payload);
      }),
      // files dropped from Explorer onto a terminal paste their (quoted) paths
      getCurrentWebview().onDragDropEvent((e) => {
        if (e.payload.type !== "drop") return;
        const scale = window.devicePixelRatio || 1;
        const el = document.elementFromPoint(e.payload.position.x / scale, e.payload.position.y / scale);
        const paneId = el?.closest<HTMLElement>("[data-pane-id]")?.dataset.paneId;
        if (!paneId) return;
        const pane = getState().model.panes[paneId];
        if (pane?.module === "terminal" && getTerm(paneId)) {
          const kind = findProfile(pane.meta.profile)?.kind;
          ipc.ptyWrite(paneId, e.payload.paths.map((p) => shellQuote(p, kind)).join(" ") + " ").catch(() => {});
          getTerm(paneId)?.term.focus();
        } else if (pane?.module === "files" && e.payload.paths[0]) {
          A.setPaneMeta(paneId, { path: e.payload.paths[0], follow: false });
        } else if (pane?.module === "logs" && e.payload.paths[0]) {
          A.setPaneMeta(paneId, { path: e.payload.paths[0] });
        } else if (pane?.module === "sftp" && e.payload.paths.length) {
          sftpUploadPaths(paneId, e.payload.paths);
        }
      }),
    ];
    return () => unsubs.forEach((u) => u.then((f) => f()));
  }, []);
}

function useAppearance() {
  const settings = useSettings((s) => s.settings);
  const preview = useThemes((s) => s.preview);
  const user = useThemes((s) => s.user);
  const theme = activeTheme(settings);
  useEffect(() => {
    applyTheme(theme, settings);
  }, [theme, settings, preview, user]);
  const effect = settings.window.effect;
  useEffect(() => {
    ipc.windowSetEffect(effect, theme.type === "dark").catch(() => {});
  }, [effect, theme.type]);
  const ring = settings.restore.scrollbackMB;
  const persist = settings.restore.scrollback;
  useEffect(() => {
    ipc.ptyConfigure(Math.round(ring * 1024 * 1024), persist).catch(() => {});
  }, [ring, persist]);
}

/** Closing a dialog, the palette or settings leaves the keyboard focus on <body>: give it back to the terminal. */
function useFocusReturn() {
  const overlay = useUi((s) => !!s.dialog || s.palette.open || s.settings.open || s.themeEditor.open);
  useEffect(() => {
    if (overlay || (document.activeElement && document.activeElement !== document.body)) return;
    const paneId = activeTab()?.focused;
    if (paneId) focusTerm(paneId);
  }, [overlay]);
}

/** Native web panes paint above HTML, so hide them while an overlay is open. */
function useWebPaneOverlayGuard() {
  const overlay = useOverlayOpen();
  useEffect(() => {
    if (overlay) ipc.webHideAll().catch(() => {});
  }, [overlay]);
}

export function App() {
  useGlobalShortcuts();
  useBackendEvents();
  useAppearance();
  useWebPaneOverlayGuard();
  useFocusReturn();
  const appearance = useSettings((s) => s.settings.appearance);
  const globalBg = useSettings((s) => s.settings.window.background);
  const confirmQuit = useSettings((s) => s.settings.window.confirmQuit);
  const settingsOpen = useUi((s) => s.settings.open);

  useEffect(() => {
    const w = getCurrentWindow();
    const un = w.onCloseRequested(async (e) => {
      flushSettings();
      if (confirmQuit && w.label === "main") {
        e.preventDefault();
        if (await ui.confirm("Quit Shellmosaic?", "Your workspaces and sessions will be restored next time.", { okLabel: "Quit" })) w.destroy();
      }
    });
    return () => {
      un.then((f) => f());
    };
  }, [confirmQuit]);

  return (
    <div
      className={cx("app", `rail-${appearance.railPosition}`, `modbar-${appearance.moduleBar}`, `density-${appearance.density}`)}
      onContextMenu={(e) => {
        // no browser menu except in text fields
        const t = e.target as HTMLElement;
        if (!t.closest("input, textarea, [contenteditable=true]")) e.preventDefault();
      }}
    >
      <BackgroundLayer bg={globalBg} className="global" />
      <Rail />
      <div className="main">
        <TitleBar />
        <div className="body">
          <WorkspaceView />
          {appearance.moduleBar !== "hidden" && <ModuleBar />}
        </div>
      </div>
      {settingsOpen && (
        <ErrorBoundary
          name="Settings"
          fallback={(err, retry) => (
            <div className="settings-overlay" role="dialog" aria-modal="true" aria-label="Settings">
              <div className="empty-state" style={{ flex: 1 }}>
                <Icon name="warning" size={26} />
                <h2 style={{ fontSize: 14 }}>Settings stopped working</h2>
                <p className="dim selectable" style={{ maxWidth: 420 }}>{err.message}</p>
                <div className="row">
                  <button className="btn" onClick={retry}>
                    <Icon name="rotate-cw" size={14} /> Try again
                  </button>
                  <button className="btn subtle" onClick={ui.closeSettings}>
                    Close settings
                  </button>
                </div>
              </div>
            </div>
          )}
        >
          <SettingsView />
        </ErrorBoundary>
      )}
      <ThemeEditor />
      <CommandPalette />
      <DialogHost />
      <ContextMenu />
      <DragLayer />
      <Toasts />
    </div>
  );
}
