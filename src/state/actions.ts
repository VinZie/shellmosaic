// App-level operations shared by menus, the command palette, keybindings and
// drag-and-drop. Each combines model mutations with their side effects.
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { errorText, ipc } from "../lib/ipc";
import { basename, uid } from "../lib/util";
import { getModule } from "../modules/registry";
import { equalize, leaves, type Side } from "./layout";
import * as M from "./model";
import type { Background, Id, PaneSpec } from "./model";
import { defaultProfile } from "./profiles";
import { settings, setSetting, updateSettings } from "./settings";
import { agentOfPane, confirmAgentPanes } from "./agents";
import { activeTab, commit, currentWorkspace, getState } from "./store";
import { ui } from "./ui";

export const windowLabel = () => getState().label;
const model = () => getState().model;

// ── runtime info ────────────────────────────────────────────────────────

export function knownCwd(paneId: Id | null | undefined): string | undefined {
  if (!paneId) return undefined;
  return ui.get().cwds[paneId] ?? (model().panes[paneId]?.meta.cwd as string | undefined) ?? agentOfPane(paneId)?.cwd;
}

/** Every pane of these tabs. */
const panesOfTabs = (tabIds: Id[]) => tabIds.flatMap((t) => leaves(model().tabs[t]?.root ?? null));

/** Directory of the terminal the user is most likely "in" for this tab. */
export function tabCwd(tabId?: Id): string | undefined {
  const tab = tabId ? model().tabs[tabId] : activeTab();
  if (!tab) return undefined;
  const candidates = [ui.get().lastTerminal[tab.id], tab.focused, ...leaves(tab.root)];
  for (const id of candidates) {
    if (id && model().panes[id]?.module === "terminal") {
      const cwd = knownCwd(id);
      if (cwd) return cwd;
    }
  }
  return undefined;
}

function terminalPanes(tabId: Id): Id[] {
  const tab = model().tabs[tabId];
  return leaves(tab?.root ?? null).filter((p) => model().panes[p]?.module === "terminal");
}

// ── module specs ────────────────────────────────────────────────────────

export function paneSpec(moduleId: string, extra: Record<string, any> = {}, cwd?: string): PaneSpec {
  const def = getModule(moduleId);
  const meta = { ...(def?.defaultMeta?.({ cwd }) ?? {}), ...extra };
  if (moduleId === "terminal") {
    meta.profile ??= defaultProfile()?.id;
    if (cwd && meta.cwd === undefined) meta.cwd = cwd;
  }
  return { module: moduleId, meta };
}

// ── workspaces ──────────────────────────────────────────────────────────

export async function newWorkspace(opts: { name?: string; icon?: string; color?: string; edit?: boolean } = {}) {
  const label = windowLabel();
  const id = await commit((m) => {
    const id = M.createWorkspace(m, { ...opts, firstPane: paneSpec("terminal") });
    M.setWindowWorkspace(m, label, id);
    return id;
  });
  if (opts.edit) ui.openDialog({ kind: "workspace", workspaceId: id });
  return id;
}

export async function switchWorkspace(wsId: Id) {
  const m = model();
  const label = windowLabel();
  const owner = M.windowOfWorkspace(m, wsId);
  if (owner && owner !== label) {
    await ipc.windowFocus(owner).catch(() => {});
    return;
  }
  await commit((d) => M.setWindowWorkspace(d, label, wsId));
}

export function switchWorkspaceIndex(i: number) {
  const id = model().order[i];
  if (id) switchWorkspace(id);
}

export function cycleWorkspace(delta: number) {
  const order = model().order;
  const cur = currentWorkspace()?.id;
  if (!order.length) return;
  const i = Math.max(0, order.indexOf(cur ?? ""));
  switchWorkspace(order[(i + delta + order.length) % order.length]);
}

export async function renameWorkspace(wsId: Id) {
  const ws = model().workspaces[wsId];
  const name = await ui.prompt("Rename workspace", ws?.name ?? "");
  if (name?.trim()) await commit((m) => M.updateWorkspace(m, wsId, { name: name.trim() }));
}

export async function deleteWorkspace(wsId: Id) {
  const ws = model().workspaces[wsId];
  if (!ws) return;
  if (!(await confirmAgentPanes(panesOfTabs(ws.tabs)))) return;
  const ok = await ui.confirm(
    `Delete "${ws.name}"?`,
    `This closes its ${ws.tabs.length} tab${ws.tabs.length === 1 ? "" : "s"} and every shell running in them.`,
    { okLabel: "Delete workspace", danger: true },
  );
  if (!ok) return;
  const label = windowLabel();
  await commit((m) => {
    M.deleteWorkspace(m, wsId);
    const main = m.windows.main;
    if (!main || !m.workspaces[main.workspace]) {
      const free = m.order.find((w) => !M.windowOfWorkspace(m, w));
      const id = free ?? M.createWorkspace(m, { name: "Main", firstPane: paneSpec("terminal") });
      M.setWindowWorkspace(m, "main", id);
    }
  });
  if (label !== "main" && !model().windows[label]) getCurrentWindow().close();
}

export async function duplicateWorkspace(wsId: Id) {
  const src = model().workspaces[wsId];
  if (!src) return;
  const label = windowLabel();
  await commit((m) => {
    const id = M.createWorkspace(m, { name: `${src.name} copy`, icon: src.icon, color: src.color, firstPane: null });
    const active = m.workspaces[wsId]?.activeTab ?? null;
    for (const tabId of src.tabs) {
      const copy = M.duplicateTab(m, tabId, knownCwd);
      if (copy) M.moveTab(m, copy, id, undefined, tabId === active);
    }
    // duplicateTab activates each copy in the source workspace; keep its own active tab
    if (m.workspaces[wsId]) m.workspaces[wsId].activeTab = active;
    m.workspaces[id].background = src.background ?? null;
    M.setWindowWorkspace(m, label, id);
  });
}

export async function closeAllTabs(wsId: Id) {
  const ws = model().workspaces[wsId];
  if (!ws?.tabs.length) return;
  if (!(await confirmAgentPanes(panesOfTabs(ws.tabs)))) return;
  const ok = await ui.confirm(`Close all tabs in "${ws.name}"?`, "Every shell in this workspace will be stopped.", {
    okLabel: "Close all",
    danger: true,
  });
  if (ok) await commit((m) => [...m.workspaces[wsId].tabs].forEach((t) => M.closeTab(m, t)));
}

/** Open a workspace in its own window (multi-monitor). */
export async function popoutWorkspace(wsId: Id) {
  const m = model();
  const owner = M.windowOfWorkspace(m, wsId);
  if (owner && owner !== windowLabel()) return ipc.windowFocus(owner);
  const label = `win-${uid(8)}`;
  const me = windowLabel();
  await commit((d) => {
    M.setWindowWorkspace(d, label, wsId);
    if (d.windows[me]?.workspace === wsId || me === label) {
      const free = d.order.find((w) => !M.windowOfWorkspace(d, w));
      if (free) M.setWindowWorkspace(d, me, free);
      else {
        const id = M.createWorkspace(d, { name: "Main", firstPane: paneSpec("terminal") });
        M.setWindowWorkspace(d, me, id);
      }
    }
  });
  const ws = model().workspaces[wsId];
  await ipc.windowCreate(label, settings().window.effect, `${ws?.name ?? "Workspace"} — Shellmosaic`).catch((e) => {
    ui.toast(`Could not open window: ${errorText(e)}`, "error");
    // no window will ever claim that label; free the workspace so it can be opened here again
    return commit((d) => delete d.windows[label]);
  });
}

export async function windowClosed(label: string) {
  if (model().windows[label]) await commit((m) => delete m.windows[label]);
}

// ── tabs ────────────────────────────────────────────────────────────────

export async function newTab(moduleId = "terminal", meta: Record<string, any> = {}, wsId?: Id) {
  const ws = wsId ? model().workspaces[wsId] : currentWorkspace();
  if (!ws) return;
  const spec = paneSpec(moduleId, meta, moduleId === "terminal" ? undefined : tabCwd());
  return commit((m) => M.createTab(m, ws.id, spec));
}

export function switchTab(tabId: Id) {
  const ws = M.workspaceOfTab(model(), tabId);
  if (ws && ws.activeTab !== tabId) commit((m) => M.setActiveTab(m, ws.id, tabId));
}

export function switchTabIndex(i: number) {
  const ws = currentWorkspace();
  const id = i === 8 ? ws?.tabs[ws.tabs.length - 1] : ws?.tabs[i];
  if (id) switchTab(id);
}

export function cycleTab(delta: number) {
  const ws = currentWorkspace();
  if (!ws?.tabs.length) return;
  const i = Math.max(0, ws.tabs.indexOf(ws.activeTab ?? ""));
  switchTab(ws.tabs[(i + delta + ws.tabs.length) % ws.tabs.length]);
}

export async function renameTab(tabId: Id) {
  const tab = model().tabs[tabId];
  if (!tab) return;
  const name = await ui.prompt("Rename tab", tab.userNamed ? tab.name : tabLabel(tabId), {
    placeholder: "Leave empty to name it after the current folder",
  });
  if (name === null) return;
  await commit((m) => M.updateTab(m, tabId, { name: name.trim(), userNamed: !!name.trim() }));
}

export function setTabColor(tabId: Id, color: string | null) {
  commit((m) => M.updateTab(m, tabId, { color }));
}

export function togglePinTab(tabId: Id) {
  commit((m) => M.updateTab(m, tabId, { pinned: !m.tabs[tabId]?.pinned }));
}

export function duplicateTab(tabId: Id) {
  commit((m) => M.duplicateTab(m, tabId, knownCwd));
}

export async function closeTab(tabId: Id) {
  if (!(await confirmAgentPanes(panesOfTabs([tabId])))) return;
  await commit((m) => M.closeTab(m, tabId));
}

export async function closeOtherTabs(tabId: Id) {
  const ws = M.workspaceOfTab(model(), tabId);
  if (!ws) return;
  const others = ws.tabs.filter((t) => t !== tabId && !model().tabs[t]?.pinned);
  if (!(await confirmAgentPanes(panesOfTabs(others)))) return;
  await commit((m) => others.forEach((t) => M.closeTab(m, t)));
}

export async function closeTabsToRight(tabId: Id) {
  const ws = M.workspaceOfTab(model(), tabId);
  if (!ws) return;
  const right = ws.tabs.slice(ws.tabs.indexOf(tabId) + 1).filter((t) => !model().tabs[t]?.pinned);
  if (!(await confirmAgentPanes(panesOfTabs(right)))) return;
  await commit((m) => right.forEach((t) => M.closeTab(m, t)));
}

export function moveTabToWorkspace(tabId: Id, wsId: Id, index?: number) {
  commit((m) => M.moveTab(m, tabId, wsId, index));
  const ws = model().workspaces[wsId];
  if (ws) ui.toast(`Moved tab to ${ws.name}`, "success", 1800);
}

export async function moveTabToNewWorkspace(tabId: Id) {
  const name = await ui.prompt("New workspace name", tabLabel(tabId));
  if (name === null) return;
  await commit((m) => {
    const id = M.createWorkspace(m, { name: name.trim() || undefined, firstPane: null });
    M.moveTab(m, tabId, id);
  });
}

export async function moveTabToNewWindow(tabId: Id) {
  const id = await commit((m) => {
    const id = M.createWorkspace(m, { name: tabLabel(tabId), firstPane: null });
    M.moveTab(m, tabId, id);
    return id;
  });
  await popoutWorkspace(id);
}

/** What a tab's label shows: its custom name, else derived from its focused pane. */
export function tabLabel(tabId: Id): string {
  const m = model();
  const tab = m.tabs[tabId];
  if (!tab) return "";
  if (tab.userNamed && tab.name) return tab.name;
  const paneId = tab.focused ?? leaves(tab.root)[0];
  const pane = paneId ? m.panes[paneId] : undefined;
  if (!pane) return "Empty";
  if (pane.title) return pane.title;
  if (pane.module === "terminal") {
    if (typeof pane.meta.sshName === "string" && pane.meta.sshName) return pane.meta.sshName;
    const cwd = knownCwd(pane.id);
    return cwd ? basename(cwd) || cwd : "Terminal";
  }
  return getModule(pane.module)?.name ?? pane.module;
}

// ── panes ───────────────────────────────────────────────────────────────

/** Split along the pane's longer side so repeated adds tile into a grid, not slivers. */
function autoSide(paneId: Id | null | undefined): Side | undefined {
  if (!paneId) return undefined;
  const el = document.querySelector<HTMLElement>(`[data-pane-id="${paneId}"]`);
  if (!el) return undefined;
  const r = el.getBoundingClientRect();
  if (!r.width || !r.height) return undefined;
  return r.width >= r.height * 1.3 ? "right" : "bottom";
}

export async function addModule(
  moduleId: string,
  opts: { tabId?: Id; target?: Id | null; side?: Side; outer?: boolean; meta?: Record<string, any>; newTab?: boolean } = {},
) {
  const tab = opts.tabId ? model().tabs[opts.tabId] : activeTab();
  const target = opts.target ?? tab?.focused ?? null;
  const cwd = settings().terminal.inheritCwd || moduleId !== "terminal" ? knownCwd(target) ?? tabCwd(tab?.id) : undefined;
  const spec = paneSpec(moduleId, opts.meta, cwd);
  if (!tab || opts.newTab) {
    const ws = currentWorkspace();
    if (!ws) return;
    return commit((m) => {
      const t = M.createTab(m, ws.id, spec);
      return m.tabs[t].focused!;
    });
  }
  const side = opts.side ?? (opts.outer ? undefined : autoSide(target));
  return commit((m) => M.addPane(m, tab.id, spec, { target, side, outer: opts.outer }));
}

export function splitPane(paneId: Id, side: Side, moduleId = "terminal") {
  const tab = M.tabOfPane(model(), paneId);
  if (tab) return addModule(moduleId, { tabId: tab.id, target: paneId, side });
}

export function splitFocused(side: Side, moduleId = "terminal") {
  const tab = activeTab();
  if (!tab) return newTab(moduleId);
  if (!tab.focused) return addModule(moduleId, { tabId: tab.id });
  return splitPane(tab.focused, side, moduleId);
}

export async function closePane(paneId: Id) {
  if (!(await confirmAgentPanes([paneId]))) return;
  await commit((m) => M.closePane(m, paneId));
}

export function closeFocusedPane() {
  const tab = activeTab();
  if (tab?.focused) closePane(tab.focused);
}

export function focusPane(paneId: Id) {
  const tab = M.tabOfPane(model(), paneId);
  if (tab && tab.focused !== paneId) commit((m) => M.focusPane(m, paneId));
  if (model().panes[paneId]?.module === "terminal" && tab) ui.setLastTerminal(tab.id, paneId);
}

export function toggleZoom(tabId?: Id, paneId?: Id) {
  const tab = tabId ? model().tabs[tabId] : activeTab();
  if (tab) commit((m) => M.toggleZoom(m, tab.id, paneId));
}

export function movePaneToNewTab(paneId: Id, wsId?: Id) {
  commit((m) => M.movePaneToNewTab(m, paneId, wsId));
}

export function movePaneToTab(paneId: Id, tabId: Id) {
  const tab = model().tabs[tabId];
  commit((m) => M.movePane(m, paneId, { tab: tabId, target: tab?.focused ?? null, side: "right" }));
}

export function changeModule(paneId: Id, moduleId: string) {
  const pane = model().panes[paneId];
  if (!pane || pane.module === moduleId) return;
  // (its agent lives in the backend: removing it goes through the Orchestrator)
  if (pane.module === "agent" && agentOfPane(paneId)) return ui.toast("An agent's pane can't become something else: close it to remove the agent.", "info");
  const cwd = knownCwd(paneId) ?? tabCwd();
  getModule(pane.module)?.onRemove?.(paneId, pane);
  commit((m) => M.changePaneModule(m, paneId, paneSpec(moduleId, {}, cwd)));
}

export async function renamePane(paneId: Id) {
  const pane = model().panes[paneId];
  const name = await ui.prompt("Pane title", pane?.title ?? "", { placeholder: "Leave empty for automatic" });
  if (name !== null) commit((m) => M.setPaneTitle(m, paneId, name.trim() || null));
}

export function setPaneMeta(paneId: Id, patch: Record<string, any>) {
  return commit((m) => M.setPaneMeta(m, paneId, patch));
}

export function equalizeTab(tabId?: Id) {
  const tab = tabId ? model().tabs[tabId] : activeTab();
  if (tab?.root) commit((m) => M.setTabRoot(m, tab.id, equalize(m.tabs[tab.id].root!)));
}

/** Move focus to the nearest pane in a direction, using on-screen geometry. */
export function focusDirection(dir: "left" | "right" | "up" | "down") {
  const tab = activeTab();
  if (!tab?.focused) return;
  const els = [...document.querySelectorAll<HTMLElement>(`[data-tab-id="${tab.id}"] [data-pane-id]`)];
  const rect = (id: string) => els.find((e) => e.dataset.paneId === id)?.getBoundingClientRect();
  const cur = rect(tab.focused);
  if (!cur) return;
  const cx = cur.left + cur.width / 2;
  const cy = cur.top + cur.height / 2;
  let best: { id: string; score: number } | null = null;
  for (const el of els) {
    const id = el.dataset.paneId!;
    if (id === tab.focused) continue;
    const r = el.getBoundingClientRect();
    const ox = r.left + r.width / 2;
    const oy = r.top + r.height / 2;
    const ok =
      (dir === "left" && r.right <= cur.left + 2) ||
      (dir === "right" && r.left >= cur.right - 2) ||
      (dir === "up" && r.bottom <= cur.top + 2) ||
      (dir === "down" && r.top >= cur.bottom - 2);
    if (!ok) continue;
    const primary = dir === "left" || dir === "right" ? Math.abs(ox - cx) : Math.abs(oy - cy);
    const secondary = dir === "left" || dir === "right" ? Math.abs(oy - cy) : Math.abs(ox - cx);
    const score = primary + secondary * 2;
    if (!best || score < best.score) best = { id, score };
  }
  if (best) {
    focusPane(best.id);
    import("../modules/terminal/termRegistry").then((t) => t.focusTerm(best!.id));
  }
}

// ── terminals ───────────────────────────────────────────────────────────

/** Type text into the tab's most recent terminal (creating one if needed). */
/**
 * The terminal `sendToTerminal` types into for this tab (undefined: it opens a new one).
 * `local` skips SSH sessions: for commands about this machine (local paths, git, tasks).
 */
export function terminalTarget(tabId: Id, opts: { local?: boolean } = {}): Id | undefined {
  const usable = (id: Id | undefined): id is Id => !!id && !!model().panes[id] && !(opts.local && model().panes[id].meta.ssh);
  const last = ui.get().lastTerminal[tabId];
  return usable(last) ? last : terminalPanes(tabId).find(usable);
}

/** Type into the tab's terminal. Resolves false (after telling the user) when nothing was typed. */
export async function sendToTerminal(text: string, opts: { tabId?: Id; enter?: boolean; local?: boolean } = {}): Promise<boolean> {
  const tab = opts.tabId ? model().tabs[opts.tabId] : activeTab();
  if (!tab) return false;
  const target = terminalTarget(tab.id, { local: opts.local });
  const payload = text + (opts.enter ? "\r" : "");
  if (target) {
    // no fallback to a new terminal here: the text was quoted for this one's shell,
    // and another shell could read it differently
    return ipc.ptyWrite(target, payload).then(
      () => true,
      () => {
        ui.toast("That terminal has exited: press Enter in it to restart, then try again", "warning");
        return false;
      },
    );
  }
  // a new terminal always presses Enter on what it's given: only for text meant to run
  if (!opts.enter) {
    ui.toast("Open a terminal in this tab first", "info");
    return false;
  }
  await runInNewTerminal(text, { tabId: tab.id });
  return true;
}

/** Open a new terminal pane that runs `command` once its shell starts. */
export function runInNewTerminal(command: string, opts: { tabId?: Id; cwd?: string; side?: Side } = {}) {
  const tab = opts.tabId ? model().tabs[opts.tabId] : activeTab();
  const cwd = opts.cwd ?? tabCwd(tab?.id);
  return addModule("terminal", { tabId: tab?.id, side: opts.side ?? "bottom", meta: { run: command, ...(cwd ? { cwd } : {}) } });
}

export function openWebPane(url: string, nearPane?: Id) {
  const tab = nearPane ? M.tabOfPane(model(), nearPane) : activeTab();
  return addModule("web", { tabId: tab?.id, target: nearPane, side: "right", meta: { url } });
}

export function openFilesAt(path: string, nearPane?: Id) {
  const tab = nearPane ? M.tabOfPane(model(), nearPane) : activeTab();
  return addModule("files", { tabId: tab?.id, target: nearPane, side: "right", meta: { path, follow: false } });
}

export function openPreview(path: string, nearPane?: Id) {
  const tab = nearPane ? M.tabOfPane(model(), nearPane) : activeTab();
  return addModule("files", { tabId: tab?.id, target: nearPane, side: "right", meta: { path, preview: path, follow: false } });
}

export function terminalFontSize(delta: number | null) {
  if (delta === null) setSetting("terminal.fontSize", 14);
  else updateSettings((s) => (s.terminal.fontSize = Math.max(6, Math.min(40, s.terminal.fontSize + delta))));
}

// ── appearance ──────────────────────────────────────────────────────────

export function setTheme(id: string) {
  setSetting("theme", id);
}

export async function pickBackgroundImage(): Promise<string | null> {
  const file = await openDialog({
    multiple: false,
    filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg", "gif", "webp", "bmp", "avif"] }],
  });
  if (!file || Array.isArray(file)) return null;
  try {
    return await ipc.backgroundImport(file);
  } catch (e) {
    ui.toast(errorText(e), "error");
    return null;
  }
}

export function setBackground(target: { kind: "workspace" | "tab" | "global"; id?: Id }, bg: Background | null) {
  if (target.kind === "global") return setSetting("window.background", bg);
  return commit((m) => {
    if (target.kind === "workspace" && target.id) M.updateWorkspace(m, target.id, { background: bg });
    if (target.kind === "tab" && target.id) M.updateTab(m, target.id, { background: bg });
  });
}

export function toggleModuleBar() {
  updateSettings((s) => (s.appearance.moduleBar = s.appearance.moduleBar === "hidden" ? "right" : "hidden"));
}
