// Context menu builders for tabs, workspaces, panes and terminals.
import { save as saveDialog } from "@tauri-apps/plugin-dialog";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { errorText, ipc } from "../lib/ipc";
import { allModules, getModule } from "../modules/registry";
import * as A from "./actions";
import { shortcutLabel } from "./commands";
import { leaves } from "./layout";
import { tabOfPane, windowOfWorkspace, WORKSPACE_COLORS, workspaceOfTab, type Background, type Id } from "./model";
import { allProfiles } from "./profiles";
import { allThemes } from "./themes";
import { commit, getState } from "./store";
import { ui, type MenuItem } from "./ui";
import * as M from "./model";

const model = () => getState().model;
const sep: MenuItem = { type: "separator" };

export const TAB_COLORS: (string | null)[] = [null, ...WORKSPACE_COLORS.slice(0, 9)];

export const GRADIENTS: { name: string; css: string }[] = [
  { name: "Aurora", css: "linear-gradient(135deg, #1b2a5a 0%, #4b2a7a 45%, #0d6b6b 100%)" },
  { name: "Sunset", css: "linear-gradient(160deg, #3a1c4a 0%, #a8384b 55%, #f29a4a 100%)" },
  { name: "Ocean", css: "radial-gradient(circle at 20% 20%, #1d6fa3 0%, #0b2a4a 55%, #06121f 100%)" },
  { name: "Forest", css: "linear-gradient(180deg, #0e2a1e 0%, #1f4d36 60%, #2f6b4a 100%)" },
  { name: "Ember", css: "radial-gradient(circle at 80% 90%, #ff7a3d 0%, #6b1f1f 40%, #160b0b 100%)" },
  { name: "Mono", css: "linear-gradient(135deg, #22252b 0%, #121418 100%)" },
  { name: "Candy", css: "linear-gradient(120deg, #ff6ec7 0%, #7873f5 50%, #4ade80 100%)" },
  { name: "Grid", css: "linear-gradient(#ffffff0a 1px, transparent 1px) 0 0 / 24px 24px, linear-gradient(90deg, #ffffff0a 1px, transparent 1px) 0 0 / 24px 24px, #0e1116" },
];

function backgroundMenu(target: { kind: "workspace" | "tab" | "global"; id?: Id }, current?: Background | null): MenuItem[] {
  return [
    {
      label: "Choose image…",
      icon: "image",
      onSelect: async () => {
        const path = await A.pickBackgroundImage();
        if (path) A.setBackground(target, { kind: "image", value: path, opacity: 0.35, fit: "cover", blur: 0 });
      },
    },
    { label: "Customize…", icon: "sliders", onSelect: () => ui.openDialog({ kind: "background", target }) },
    sep,
    ...GRADIENTS.map<MenuItem>((g) => ({
      label: g.name,
      checked: current?.value === g.css,
      onSelect: () => A.setBackground(target, { kind: "css", value: g.css, opacity: 0.6 }),
    })),
    sep,
    { label: "No background", icon: "image-off", disabled: !current, onSelect: () => A.setBackground(target, null) },
  ];
}

function moduleItems(onPick: (moduleId: string) => void): MenuItem[] {
  return allModules().map((m) => ({ label: m.name, icon: m.icon, onSelect: () => onPick(m.id) }));
}

// ── tab ─────────────────────────────────────────────────────────────────

export function tabMenu(tabId: Id): MenuItem[] {
  const m = model();
  const tab = m.tabs[tabId];
  const ws = workspaceOfTab(m, tabId);
  if (!tab || !ws) return [];
  const others = m.order.filter((w) => w !== ws.id).map((w) => m.workspaces[w]);
  const idx = ws.tabs.indexOf(tabId);
  return [
    { label: "Rename…", icon: "pencil", shortcut: "F2", onSelect: () => A.renameTab(tabId) },
    { type: "swatches", colors: TAB_COLORS, value: tab.color ?? null, onSelect: (c) => A.setTabColor(tabId, c) },
    { label: tab.pinned ? "Unpin tab" : "Pin tab", icon: tab.pinned ? "pin-off" : "pin", onSelect: () => A.togglePinTab(tabId) },
    { label: "Duplicate tab", icon: "copy", onSelect: () => A.duplicateTab(tabId) },
    sep,
    {
      label: "Move to workspace",
      icon: "arrow-right",
      submenu: [
        { type: "header", label: "Move this tab to" },
        ...others.map<MenuItem>((w) => ({
          label: w.name,
          icon: w.icon,
          iconColor: w.color,
          hint: `${w.tabs.length} tab${w.tabs.length === 1 ? "" : "s"}`,
          onSelect: () => A.moveTabToWorkspace(tabId, w.id),
        })),
        ...(others.length ? [sep] : []),
        { label: "New workspace…", icon: "plus", onSelect: () => A.moveTabToNewWorkspace(tabId) },
      ],
    },
    { label: "Move to new window", icon: "app-window", onSelect: () => A.moveTabToNewWindow(tabId) },
    sep,
    { label: "Add pane", icon: "layout-grid", submenu: moduleItems((id) => A.addModule(id, { tabId })) },
    { label: "Background", icon: "image", submenu: backgroundMenu({ kind: "tab", id: tabId }, tab.background) },
    { label: "Equalize pane sizes", icon: "columns-2", disabled: leaves(tab.root).length < 2, onSelect: () => A.equalizeTab(tabId) },
    sep,
    { label: "Close tab", icon: "x", shortcut: shortcutLabel("tab.close"), onSelect: () => A.closeTab(tabId) },
    { label: "Close other tabs", disabled: ws.tabs.length < 2, onSelect: () => A.closeOtherTabs(tabId) },
    { label: "Close tabs to the right", disabled: idx === ws.tabs.length - 1, onSelect: () => A.closeTabsToRight(tabId) },
  ];
}

// ── workspace ───────────────────────────────────────────────────────────

export function workspaceMenu(wsId: Id): MenuItem[] {
  const m = model();
  const ws = m.workspaces[wsId];
  if (!ws) return [];
  const me = getState().label;
  const owner = windowOfWorkspace(m, wsId);
  const elsewhere = owner && owner !== me;
  const i = m.order.indexOf(wsId);
  return [
    { type: "header", label: ws.name },
    elsewhere
      ? { label: "Show its window", icon: "app-window", onSelect: () => A.switchWorkspace(wsId) }
      : { label: "Open", icon: "folder-open", disabled: owner === me, onSelect: () => A.switchWorkspace(wsId) },
    { label: "New tab", icon: "plus", onSelect: () => A.newTab("terminal", {}, wsId) },
    sep,
    { label: "Rename…", icon: "pencil", onSelect: () => A.renameWorkspace(wsId) },
    { label: "Icon & color…", icon: "palette", onSelect: () => ui.openDialog({ kind: "workspace", workspaceId: wsId }) },
    { label: "Background", icon: "image", submenu: backgroundMenu({ kind: "workspace", id: wsId }, ws.background) },
    { label: "Duplicate workspace", icon: "copy", onSelect: () => A.duplicateWorkspace(wsId) },
    { label: elsewhere ? "Focus window" : "Open in new window", icon: "app-window", onSelect: () => A.popoutWorkspace(wsId) },
    sep,
    { label: "Move up", icon: "chevron-up", disabled: i <= 0, onSelect: () => commit((d) => M.reorderWorkspace(d, wsId, i - 1)) },
    {
      label: "Move down",
      icon: "chevron-down",
      disabled: i >= m.order.length - 1,
      onSelect: () => commit((d) => M.reorderWorkspace(d, wsId, i + 1)),
    },
    sep,
    { label: "Close all tabs", icon: "x", disabled: !ws.tabs.length, onSelect: () => A.closeAllTabs(wsId) },
    { label: "Delete workspace…", icon: "trash", danger: true, onSelect: () => A.deleteWorkspace(wsId) },
  ];
}

// ── pane ────────────────────────────────────────────────────────────────

export function paneMenu(paneId: Id): MenuItem[] {
  const m = model();
  const pane = m.panes[paneId];
  const tab = tabOfPane(m, paneId);
  const ws = tab ? workspaceOfTab(m, tab.id) : undefined;
  if (!pane || !tab || !ws) return [];
  const def = getModule(pane.module);
  const count = leaves(tab.root).length;
  return [
    {
      label: "Split right",
      icon: "columns-2",
      shortcut: shortcutLabel("pane.splitRight"),
      submenu: moduleItems((id) => A.splitPane(paneId, "right", id)),
    },
    {
      label: "Split down",
      icon: "rows-2",
      shortcut: shortcutLabel("pane.splitDown"),
      submenu: moduleItems((id) => A.splitPane(paneId, "bottom", id)),
    },
    {
      label: tab.zoomed === paneId ? "Restore size" : "Magnify",
      icon: tab.zoomed === paneId ? "minimize" : "maximize",
      shortcut: shortcutLabel("pane.zoom"),
      disabled: count < 2,
      onSelect: () => A.toggleZoom(tab.id, paneId),
    },
    ...(def?.menu ? [sep, ...def.menu(pane, tab.id)] : []),
    sep,
    { label: "Change module", icon: "layout-grid", submenu: moduleItems((id) => A.changeModule(paneId, id)) },
    { label: "Rename pane…", icon: "pencil", onSelect: () => A.renamePane(paneId) },
    { label: "Move to new tab", icon: "square", disabled: count < 2, onSelect: () => A.movePaneToNewTab(paneId) },
    {
      label: "Move to tab",
      icon: "arrow-right",
      disabled: ws.tabs.length < 2,
      submenu: ws.tabs.filter((t) => t !== tab.id).map<MenuItem>((t) => ({ label: A.tabLabel(t), onSelect: () => A.movePaneToTab(paneId, t) })),
    },
    {
      label: "Move to workspace",
      icon: "arrow-right",
      submenu: [
        { type: "header", label: "Opens as a new tab in" },
        ...m.order
          .filter((w) => w !== ws.id)
          .map<MenuItem>((w) => ({
            label: m.workspaces[w].name,
            icon: m.workspaces[w].icon,
            iconColor: m.workspaces[w].color,
            onSelect: () => A.movePaneToNewTab(paneId, w),
          })),
      ],
    },
    sep,
    { label: "Close pane", icon: "x", shortcut: shortcutLabel("pane.close"), onSelect: () => A.closePane(paneId) },
  ];
}

// ── terminal ────────────────────────────────────────────────────────────

export async function terminalMenu(paneId: Id): Promise<MenuItem[]> {
  const t = await import("../modules/terminal/termRegistry");
  const e = t.getTerm(paneId);
  const pane = model().panes[paneId];
  const cwd = A.knownCwd(paneId);
  const hasSel = !!e?.term.hasSelection();
  const fontSizes = [10, 11, 12, 13, 14, 15, 16, 18, 20, 24];
  return [
    { label: "Copy", icon: "copy", shortcut: "Ctrl+C", disabled: !hasSel, onSelect: () => e && t.copySelection(e) },
    { label: "Paste", icon: "clipboard-paste", shortcut: "Ctrl+V", onSelect: () => e && t.pasteInto(e) },
    { label: "Select all", onSelect: () => e?.term.selectAll() },
    sep,
    { label: "Find…", icon: "search", shortcut: shortcutLabel("term.find"), onSelect: () => ui.setFind(paneId, true) },
    { label: "Clear", icon: "eraser", shortcut: shortcutLabel("term.clear"), onSelect: () => e?.term.clear() },
    { label: "Save output to file…", icon: "save", onSelect: () => saveOutput(paneId) },
    sep,
    { label: "Open folder in Files", icon: "folder-open", disabled: !cwd, onSelect: () => cwd && A.openFilesAt(cwd, paneId) },
    { label: "Open folder in Explorer", icon: "external-link", disabled: !cwd, onSelect: () => cwd && revealItemInDir(cwd) },
    { label: "Copy working directory", icon: "clipboard-copy", disabled: !cwd, onSelect: () => cwd && writeText(cwd) },
    sep,
    { label: "Restart shell", icon: "rotate-cw", onSelect: () => t.restartTerm(paneId) },
    {
      label: "Change shell",
      icon: "terminal",
      submenu: allProfiles()
        .filter((p) => !p.hidden)
        .map<MenuItem>((p) => ({
          label: p.name,
          checked: !pane?.meta.ssh && pane?.meta.profile === p.id,
          onSelect: async () => {
            // (on an SSH pane this swaps the remote session for a local shell)
            await A.setPaneMeta(paneId, { profile: p.id, ssh: null, sshName: null });
            t.restartTerm(paneId);
          },
        })),
    },
    {
      label: "Pane theme",
      icon: "palette",
      submenu: [
        { label: "Follow app theme", checked: !pane?.meta.theme, onSelect: () => A.setPaneMeta(paneId, { theme: null }) },
        sep,
        ...allThemes().map<MenuItem>((th) => ({
          label: th.name,
          checked: pane?.meta.theme === th.id,
          onSelect: () => A.setPaneMeta(paneId, { theme: th.id }),
        })),
      ],
    },
    {
      label: "Pane font size",
      icon: "type",
      submenu: [
        { label: "Follow settings", checked: !pane?.meta.fontSize, onSelect: () => A.setPaneMeta(paneId, { fontSize: null }) },
        sep,
        ...fontSizes.map<MenuItem>((n) => ({ label: `${n}px`, checked: pane?.meta.fontSize === n, onSelect: () => A.setPaneMeta(paneId, { fontSize: n }) })),
      ],
    },
    sep,
    { label: "Pane", icon: "square", submenu: paneMenu(paneId) },
  ];
}

async function saveOutput(paneId: Id) {
  try {
    const text = await ipc.ptyText(paneId, 2 * 1024 * 1024);
    const path = await saveDialog({ defaultPath: "terminal-output.txt", filters: [{ name: "Text", extensions: ["txt", "log"] }] });
    if (!path) return;
    await ipc.fsWriteText(path, text);
    ui.toast("Output saved", "success");
  } catch (e) {
    ui.toast(errorText(e), "error");
  }
}

// ── new tab / module bar ────────────────────────────────────────────────

export function newTabMenu(): MenuItem[] {
  const profiles = allProfiles().filter((p) => !p.hidden);
  return [
    { type: "header", label: "Shells" },
    ...profiles.map<MenuItem>((p) => ({
      label: p.name,
      icon: p.icon ?? "terminal",
      iconColor: p.color ?? undefined,
      onSelect: () => A.newTab("terminal", { profile: p.id }),
    })),
    sep,
    { type: "header", label: "Modules" },
    ...allModules()
      .filter((d) => d.id !== "terminal")
      .map<MenuItem>((d) => ({ label: d.name, icon: d.icon, onSelect: () => A.newTab(d.id) })),
    sep,
    { label: "Settings → Profiles…", icon: "settings", onSelect: () => ui.openSettings("profiles") },
  ];
}

export function moduleBarMenu(): MenuItem[] {
  return [
    { label: "Customize module bar…", icon: "sliders", onSelect: () => ui.openSettings("modules") },
    { label: "Browse plugins…", icon: "puzzle", onSelect: () => ui.openSettings("plugins") },
    sep,
    { label: "Hide module bar", icon: "eye-off", shortcut: shortcutLabel("view.moduleBar"), onSelect: () => A.toggleModuleBar() },
  ];
}
