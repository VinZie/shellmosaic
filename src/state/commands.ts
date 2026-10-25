// Commands: everything runnable from the palette or a keybinding.
import { getModule } from "../modules/registry";
import * as A from "./actions";
import { settings } from "./settings";
import { activeTab, currentWorkspace } from "./store";
import { ui, useUi } from "./ui";

export interface Command {
  id: string;
  title: string;
  category: string;
  icon?: string;
  run: () => unknown;
}

const withFocusedTerm = (fn: (paneId: string) => void) => () => {
  const tab = activeTab();
  const id = tab?.focused;
  if (id) fn(id);
};

const term = () => import("../modules/terminal/termRegistry");

export const COMMANDS: Command[] = [
  { id: "palette.open", title: "Command palette", category: "General", icon: "command", run: () => ui.openPalette("all") },
  { id: "palette.modules", title: "Add module…", category: "Panes", icon: "layout-grid", run: () => ui.openPalette("modules") },
  { id: "palette.profiles", title: "New tab with profile…", category: "Tabs", icon: "terminal", run: () => ui.openPalette("profiles") },
  { id: "settings.open", title: "Settings", category: "General", icon: "settings", run: () => ui.openSettings() },
  { id: "settings.themes", title: "Change theme", category: "Appearance", icon: "palette", run: () => ui.openSettings("appearance") },
  { id: "settings.themeEditor", title: "Edit current theme", category: "Appearance", icon: "palette",
    run: () => useUi.setState({ themeEditor: { open: true, themeId: settings().theme } }) },
  { id: "tab.new", title: "New tab", category: "Tabs", icon: "plus", run: () => A.newTab() },
  { id: "tab.close", title: "Close tab", category: "Tabs", icon: "x", run: () => { const t = activeTab(); if (t) A.closeTab(t.id); } },
  { id: "tab.next", title: "Next tab", category: "Tabs", run: () => A.cycleTab(1) },
  { id: "tab.prev", title: "Previous tab", category: "Tabs", run: () => A.cycleTab(-1) },
  { id: "tab.rename", title: "Rename tab", category: "Tabs", icon: "pencil", run: () => { const t = activeTab(); if (t) A.renameTab(t.id); } },
  { id: "tab.duplicate", title: "Duplicate tab", category: "Tabs", icon: "copy", run: () => { const t = activeTab(); if (t) A.duplicateTab(t.id); } },
  { id: "tab.pin", title: "Pin / unpin tab", category: "Tabs", icon: "pin", run: () => { const t = activeTab(); if (t) A.togglePinTab(t.id); } },
  { id: "tab.toNewWindow", title: "Move tab to new window", category: "Tabs", icon: "app-window",
    run: () => { const t = activeTab(); if (t) A.moveTabToNewWindow(t.id); } },
  ...Array.from({ length: 9 }, (_, i) => ({
    id: `tab.goto.${i + 1}`, title: i === 8 ? "Go to last tab" : `Go to tab ${i + 1}`, category: "Tabs", run: () => A.switchTabIndex(i),
  })),
  { id: "workspace.new", title: "New workspace", category: "Workspaces", icon: "plus", run: () => A.newWorkspace({ edit: true }) },
  { id: "workspace.next", title: "Next workspace", category: "Workspaces", run: () => A.cycleWorkspace(1) },
  { id: "workspace.prev", title: "Previous workspace", category: "Workspaces", run: () => A.cycleWorkspace(-1) },
  { id: "workspace.popout", title: "Open workspace in new window", category: "Workspaces", icon: "app-window",
    run: () => { const id = currentWsId(); if (id) A.popoutWorkspace(id); } },
  { id: "workspace.edit", title: "Edit workspace (name, icon, color)", category: "Workspaces", icon: "pencil",
    run: () => { const id = currentWsId(); if (id) ui.openDialog({ kind: "workspace", workspaceId: id }); } },
  ...Array.from({ length: 9 }, (_, i) => ({
    id: `workspace.goto.${i + 1}`, title: `Go to workspace ${i + 1}`, category: "Workspaces", run: () => A.switchWorkspaceIndex(i),
  })),
  { id: "pane.splitRight", title: "Split right (terminal)", category: "Panes", icon: "columns-2", run: () => A.splitFocused("right") },
  { id: "pane.splitDown", title: "Split down (terminal)", category: "Panes", icon: "rows-2", run: () => A.splitFocused("bottom") },
  { id: "pane.close", title: "Close pane", category: "Panes", icon: "x", run: () => A.closeFocusedPane() },
  { id: "pane.zoom", title: "Magnify / restore pane", category: "Panes", icon: "maximize", run: () => A.toggleZoom() },
  { id: "pane.equalize", title: "Make all panes equal size", category: "Panes", icon: "layout-grid", run: () => A.equalizeTab() },
  { id: "pane.toNewTab", title: "Move pane to new tab", category: "Panes",
    run: withFocusedTerm((id) => A.movePaneToNewTab(id)) },
  { id: "pane.focusLeft", title: "Focus pane left", category: "Panes", run: () => A.focusDirection("left") },
  { id: "pane.focusRight", title: "Focus pane right", category: "Panes", run: () => A.focusDirection("right") },
  { id: "pane.focusUp", title: "Focus pane above", category: "Panes", run: () => A.focusDirection("up") },
  { id: "pane.focusDown", title: "Focus pane below", category: "Panes", run: () => A.focusDirection("down") },
  { id: "term.copy", title: "Copy selection", category: "Terminal", icon: "copy",
    run: withFocusedTerm(async (id) => { const t = await term(); const e = t.getTerm(id); if (e) t.copySelection(e); }) },
  { id: "term.paste", title: "Paste", category: "Terminal", icon: "clipboard-paste",
    run: withFocusedTerm(async (id) => { const t = await term(); const e = t.getTerm(id); if (e) t.pasteInto(e); }) },
  { id: "term.find", title: "Find in terminal", category: "Terminal", icon: "search", run: withFocusedTerm((id) => ui.setFind(id, true)) },
  { id: "term.clear", title: "Clear terminal", category: "Terminal", icon: "eraser",
    run: withFocusedTerm(async (id) => (await term()).getTerm(id)?.term.clear()) },
  { id: "term.restart", title: "Restart shell", category: "Terminal", icon: "rotate-cw",
    run: withFocusedTerm(async (id) => (await term()).restartTerm(id)) },
  { id: "term.broadcast", title: "Toggle typing into all terminals in this tab", category: "Terminal", icon: "radio",
    run: () => { const t = activeTab(); if (t) { ui.toggleBroadcast(t.id); ui.toast(ui.get().broadcast[t.id] ? "Broadcast input ON for this tab" : "Broadcast input off", "info", 1800); } } },
  { id: "term.fontUp", title: "Increase terminal font size", category: "Terminal", icon: "zoom-in", run: () => A.terminalFontSize(1) },
  { id: "term.fontDown", title: "Decrease terminal font size", category: "Terminal", icon: "zoom-out", run: () => A.terminalFontSize(-1) },
  { id: "term.fontReset", title: "Reset terminal font size", category: "Terminal", run: () => A.terminalFontSize(null) },
  { id: "view.moduleBar", title: "Toggle module bar", category: "View", icon: "panel-right", run: () => A.toggleModuleBar() },
  { id: "app.about", title: "About Shellmosaic", category: "General", icon: "info", run: () => ui.openDialog({ kind: "about" }) },
];

const currentWsId = () => currentWorkspace()?.id;

export const DEFAULT_KEYBINDINGS: Record<string, string> = {
  "palette.open": "ctrl+shift+p",
  "palette.modules": "ctrl+shift+x",
  "settings.open": "ctrl+,",
  "tab.new": "ctrl+shift+t",
  "tab.close": "ctrl+alt+w",
  "tab.next": "ctrl+tab",
  "tab.prev": "ctrl+shift+tab",
  "tab.rename": "f2",
  "workspace.new": "ctrl+shift+n",
  "workspace.next": "ctrl+alt+pagedown",
  "workspace.prev": "ctrl+alt+pageup",
  "pane.splitRight": "ctrl+shift+d",
  "pane.splitDown": "ctrl+shift+e",
  "pane.close": "ctrl+shift+w",
  "pane.zoom": "ctrl+shift+m",
  "pane.focusLeft": "alt+left",
  "pane.focusRight": "alt+right",
  "pane.focusUp": "alt+up",
  "pane.focusDown": "alt+down",
  "term.copy": "ctrl+shift+c",
  "term.paste": "ctrl+shift+v",
  "term.find": "ctrl+shift+f",
  "term.clear": "ctrl+shift+k",
  "term.broadcast": "ctrl+shift+i",
  "term.fontUp": "ctrl+=",
  "term.fontDown": "ctrl+-",
  "term.fontReset": "ctrl+0",
  "view.moduleBar": "ctrl+shift+b",
  ...Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`tab.goto.${i + 1}`, `alt+${i + 1}`])),
  ...Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`workspace.goto.${i + 1}`, `ctrl+alt+${i + 1}`])),
};

export function keybinding(id: string): string | undefined {
  const override = settings().keybindings[id];
  if (override !== undefined) return override || undefined;
  return DEFAULT_KEYBINDINGS[id];
}

const CODE_KEYS: Record<string, string> = {
  Comma: ",", Period: ".", Slash: "/", Backslash: "\\", BracketLeft: "[", BracketRight: "]", Minus: "-", Equal: "=",
  Semicolon: ";", Quote: "'", Backquote: "`", Space: "space", Tab: "tab", Enter: "enter", Escape: "escape",
  Backspace: "backspace", Delete: "delete", Insert: "insert", Home: "home", End: "end", PageUp: "pageup",
  PageDown: "pagedown", ArrowLeft: "left", ArrowRight: "right", ArrowUp: "up", ArrowDown: "down",
  NumpadAdd: "=", NumpadSubtract: "-",
};

/** Normalised combo for a key event, e.g. "ctrl+shift+t"; null for bare modifiers. */
export function eventToCombo(e: KeyboardEvent): string | null {
  let key: string | undefined;
  if (/^Key[A-Z]$/.test(e.code)) key = e.code.slice(3).toLowerCase();
  else if (/^Digit\d$/.test(e.code)) key = e.code.slice(5);
  else if (/^Numpad\d$/.test(e.code)) key = e.code.slice(6);
  else if (/^F\d{1,2}$/.test(e.code)) key = e.code.toLowerCase();
  else key = CODE_KEYS[e.code];
  if (!key) return null;
  const mods = [e.ctrlKey && "ctrl", e.altKey && "alt", e.shiftKey && "shift", e.metaKey && "meta"].filter(Boolean);
  return [...mods, key].join("+");
}

export function commandForEvent(e: KeyboardEvent): Command | undefined {
  // AltGr arrives as Ctrl+Alt on Windows; on many layouts it types { [ ] } \ @ # | etc.
  if (e.ctrlKey && e.altKey && e.key.length === 1 && !/^[a-z0-9]$/i.test(e.key) && e.getModifierState("AltGraph")) return undefined;
  const combo = eventToCombo(e);
  if (!combo) return undefined;
  const plain = !e.ctrlKey && !e.altKey && !e.metaKey;
  // plain keys (other than function keys) never trigger commands while typing
  if (plain && !/^f\d+$/.test(combo.replace("shift+", ""))) return undefined;
  return COMMANDS.find((c) => keybinding(c.id) === combo);
}

export function formatCombo(combo?: string): string {
  if (!combo) return "";
  return combo
    .split("+")
    .map((p) => ({ ctrl: "Ctrl", alt: "Alt", shift: "Shift", meta: "Win", pagedown: "PgDn", pageup: "PgUp", escape: "Esc" })[p] ??
      (p.length === 1 ? p.toUpperCase() : p[0].toUpperCase() + p.slice(1)))
    .join("+");
}

export function shortcutLabel(id: string): string {
  return formatCombo(keybinding(id));
}

/** Palette title helpers for modules (also used in menus). */
export function moduleTitle(id: string) {
  return getModule(id)?.name ?? id;
}
