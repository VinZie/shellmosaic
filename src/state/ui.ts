// Runtime UI state that is never persisted: menus, dialogs, toasts, per-pane
// runtime info (cwd, title, attention badges) and drag state.
import type { ReactNode } from "react";
import { create } from "zustand";
import { uid } from "../lib/util";
import { contains } from "./layout";
import type { Id } from "./model";
import { useModel } from "./store";

export type MenuItem =
  | {
      type?: "item";
      label: string;
      icon?: string;
      iconColor?: string;
      shortcut?: string;
      disabled?: boolean;
      checked?: boolean;
      danger?: boolean;
      hint?: string;
      onSelect?: () => void;
      submenu?: MenuItem[];
    }
  | { type: "separator" }
  | { type: "header"; label: string }
  | { type: "swatches"; colors: (string | null)[]; value?: string | null; onSelect: (c: string | null) => void };

export interface MenuState {
  x: number;
  y: number;
  items: MenuItem[];
}

export type Dialog =
  | {
      kind: "prompt";
      title: string;
      label?: string;
      value: string;
      placeholder?: string;
      okLabel?: string;
      /** a password field (not echoed, no autocomplete) */
      secret?: boolean;
      resolve: (v: string | null) => void;
    }
  | { kind: "confirm"; title: string; message: ReactNode; okLabel?: string; danger?: boolean; resolve: (ok: boolean) => void }
  | { kind: "workspace"; workspaceId: Id | null }
  | { kind: "tabStyle"; tabId: Id }
  | { kind: "background"; target: { kind: "workspace" | "tab" | "global"; id?: Id } }
  | { kind: "plugin-permissions"; pluginId: string; name: string; permissions: string[]; resolve: (ok: boolean) => void }
  | { kind: "update"; current: string; version: string; notes: string; resolve: (choice: UpdateChoice) => void }
  | { kind: "about" };

export type UpdateChoice = "update" | "skip" | "later";

export interface Toast {
  id: string;
  message: string;
  kind: "info" | "success" | "error" | "warning";
}

export type BadgeKind = "activity" | "bell" | "error" | "done";

interface UiState {
  menu: MenuState | null;
  dialog: Dialog | null;
  palette: { open: boolean; query: string; mode: "all" | "modules" | "profiles" };
  settings: { open: boolean; section: string };
  themeEditor: { open: boolean; themeId: string | null };
  toasts: Toast[];
  /** live cwd per terminal pane (from shell integration) */
  cwds: Record<Id, string>;
  /** live title per pane (terminal OSC title, plugin setTitle, ...) */
  titles: Record<Id, string>;
  badges: Record<Id, BadgeKind>;
  /** last focused terminal per tab: target for "send to terminal" actions */
  lastTerminal: Record<Id, Id>;
  broadcast: Record<Id, boolean>;
  dragging: boolean;
  findOpen: Record<Id, boolean>;
}

export const useUi = create<UiState>(() => ({
  menu: null,
  dialog: null,
  palette: { open: false, query: "", mode: "all" },
  settings: { open: false, section: "appearance" },
  themeEditor: { open: false, themeId: null },
  toasts: [],
  cwds: {},
  titles: {},
  badges: {},
  lastTerminal: {},
  broadcast: {},
  dragging: false,
  findOpen: {},
}));

/**
 * Show a dialog (or none). A prompt/confirm that leaves without an answer (replaced
 * by another dialog, closed from code) counts as cancelled instead of awaiting forever.
 * Its own buttons close it and answer right after, so the cancel waits a tick.
 * (plugin-permissions dialogs watch for this themselves.)
 */
function setDialog(dialog: Dialog | null) {
  const prev = useUi.getState().dialog;
  useUi.setState({ dialog });
  if (prev === dialog) return;
  if (prev?.kind === "prompt") queueMicrotask(() => prev.resolve(null));
  else if (prev?.kind === "confirm") queueMicrotask(() => prev.resolve(false));
  else if (prev?.kind === "update") queueMicrotask(() => prev.resolve("later"));
}

export const ui = {
  get: () => useUi.getState(),
  openMenu(e: { clientX: number; clientY: number } | { x: number; y: number }, items: MenuItem[]) {
    const x = "clientX" in e ? e.clientX : e.x;
    const y = "clientY" in e ? e.clientY : e.y;
    useUi.setState({ menu: { x, y, items } });
  },
  closeMenu: () => useUi.setState({ menu: null }),
  toast(message: string, kind: Toast["kind"] = "info", ms = 3500) {
    const id = uid();
    useUi.setState((s) => ({ toasts: [...s.toasts.slice(-4), { id, message, kind }] }));
    setTimeout(() => useUi.setState((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })), ms);
  },
  prompt(title: string, value = "", opts: { label?: string; placeholder?: string; okLabel?: string; secret?: boolean } = {}): Promise<string | null> {
    return new Promise((resolve) => setDialog({ kind: "prompt", title, value, resolve, ...opts }));
  },
  confirm(title: string, message: ReactNode, opts: { okLabel?: string; danger?: boolean } = {}): Promise<boolean> {
    return new Promise((resolve) => setDialog({ kind: "confirm", title, message, resolve, ...opts }));
  },
  /** "A new version is available": update now, skip this version, or later. */
  askUpdate(info: { current: string; version: string; notes: string }): Promise<UpdateChoice> {
    return new Promise((resolve) => setDialog({ kind: "update", ...info, resolve }));
  },
  openDialog: (dialog: Dialog) => setDialog(dialog),
  closeDialog: () => setDialog(null),
  openPalette: (mode: UiState["palette"]["mode"] = "all", query = "") => useUi.setState({ palette: { open: true, query, mode } }),
  closePalette: () => useUi.setState((s) => ({ palette: { ...s.palette, open: false } })),
  openSettings: (section = "appearance") => useUi.setState({ settings: { open: true, section } }),
  closeSettings: () => useUi.setState((s) => ({ settings: { ...s.settings, open: false } })),
  setCwd: (pane: Id, cwd: string) => useUi.setState((s) => (s.cwds[pane] === cwd ? s : { cwds: { ...s.cwds, [pane]: cwd } })),
  setTitle: (pane: Id, title: string) =>
    useUi.setState((s) => (s.titles[pane] === title ? s : { titles: { ...s.titles, [pane]: title } })),
  setBadge(pane: Id, badge: BadgeKind | null) {
    useUi.setState((s) => {
      if ((s.badges[pane] ?? null) === badge) return s;
      // don't downgrade an important badge to plain activity
      if (badge === "activity" && (s.badges[pane] === "bell" || s.badges[pane] === "error")) return s;
      const badges = { ...s.badges };
      if (badge) badges[pane] = badge;
      else delete badges[pane];
      return { badges };
    });
  },
  setLastTerminal: (tab: Id, pane: Id) =>
    useUi.setState((s) => (s.lastTerminal[tab] === pane ? s : { lastTerminal: { ...s.lastTerminal, [tab]: pane } })),
  toggleBroadcast: (tab: Id) => useUi.setState((s) => ({ broadcast: { ...s.broadcast, [tab]: !s.broadcast[tab] } })),
  setFind: (pane: Id, open: boolean) => useUi.setState((s) => ({ findOpen: { ...s.findOpen, [pane]: open } })),
};

// A terminal that left its tab (moved, closed, changed module) is no longer that tab's
// target: otherwise "send to terminal" types into a pane in another tab or workspace.
useModel.subscribe(({ model }) => {
  const last = useUi.getState().lastTerminal;
  const stale = Object.keys(last).filter(
    (tab) => model.panes[last[tab]]?.module !== "terminal" || !contains(model.tabs[tab]?.root ?? null, last[tab]),
  );
  if (!stale.length) return;
  const next = { ...last };
  stale.forEach((tab) => delete next[tab]);
  useUi.setState({ lastTerminal: next });
});

/** True while anything covers the app (native web panes must hide then). */
export function useOverlayOpen(): boolean {
  return useUi((s) => !!s.menu || !!s.dialog || s.palette.open || s.settings.open || s.themeEditor.open || s.dragging);
}
