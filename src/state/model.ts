// The persisted workspace model and pure operations on it. Every operation takes
// a draft (already cloned by the store) and mutates it in place.
import { isPlainObject, uid } from "../lib/util";
import {
  autoInsert, contains, insertOuter, insertPane, leaf, leaves, mapPanes, normalize, removePane, swapPanes,
  type Id, type LayoutNode, type Side,
} from "./layout";

export type { Id, LayoutNode, Side } from "./layout";

export interface Background {
  /** "image" = file in the app's backgrounds folder, "css" = any CSS background (color/gradient) */
  kind: "image" | "css";
  value: string;
  opacity: number;
  blur?: number;
  fit?: "cover" | "contain" | "tile";
}

export interface Pane {
  id: Id;
  module: string;
  meta: Record<string, any>;
  title?: string | null;
}

export interface Tab {
  id: Id;
  name: string;
  /** true once the user renamed it; otherwise the name follows the focused pane */
  userNamed?: boolean;
  color?: string | null;
  icon?: string | null;
  pinned?: boolean;
  root: LayoutNode | null;
  focused?: Id | null;
  zoomed?: Id | null;
  background?: Background | null;
}

export interface Workspace {
  id: Id;
  name: string;
  icon: string;
  color: string;
  tabs: Id[];
  activeTab: Id | null;
  background?: Background | null;
}

export interface WindowInfo {
  workspace: Id;
}

export interface Model {
  v: 1;
  order: Id[];
  workspaces: Record<Id, Workspace>;
  tabs: Record<Id, Tab>;
  panes: Record<Id, Pane>;
  windows: Record<string, WindowInfo>;
}

export interface PaneSpec {
  module: string;
  meta?: Record<string, any>;
  title?: string | null;
}

export const WORKSPACE_COLORS = [
  "#6c8cff", "#3fd39a", "#f6b958", "#ef6b7b", "#b07cff", "#4cc9f0", "#ff8c42", "#e2e86c", "#ff6ec7", "#9aa4b2",
];

export function emptyModel(): Model {
  return { v: 1, order: [], workspaces: {}, tabs: {}, panes: {}, windows: {} };
}

/** The object entries of a record from disk, each given its key as id (anything else is dropped). */
function records<T>(v: unknown, withId = true): Record<Id, T> {
  const out: Record<Id, T> = {};
  if (isPlainObject(v)) for (const [k, x] of Object.entries(v)) if (isPlainObject(x)) out[k] = (withId ? { ...x, id: k } : x) as T;
  return out;
}

/** A layout tree without malformed nodes (null when nothing usable is left). */
function cleanLayout(n: any): LayoutNode | null {
  if (n?.kind === "leaf") return typeof n.pane === "string" ? leaf(n.pane) : null;
  if (n?.kind !== "split" || !Array.isArray(n.children)) return null;
  const children: LayoutNode[] = [];
  const sizes: number[] = [];
  n.children.forEach((c: unknown, i: number) => {
    const node = cleanLayout(c);
    const s = Array.isArray(n.sizes) ? n.sizes[i] : undefined;
    if (!node) return;
    children.push(node);
    sizes.push(typeof s === "number" && Number.isFinite(s) && s > 0 ? s : 1 / n.children.length);
  });
  if (!children.length) return null;
  return normalize({ kind: "split", id: typeof n.id === "string" ? n.id : uid(), dir: n.dir === "col" ? "col" : "row", children, sizes });
}

/**
 * Accept whatever was on disk; repair anything inconsistent instead of failing
 * (a damaged or hand-edited state.json must not break every start).
 */
export function sanitize(raw: unknown): Model {
  const m = emptyModel();
  if (!raw || typeof raw !== "object") return m;
  const r = raw as Partial<Model>;
  Object.assign(m, {
    workspaces: records<Workspace>(r.workspaces),
    tabs: records<Tab>(r.tabs),
    panes: records<Pane>(r.panes),
    windows: records<WindowInfo>(r.windows, false),
    order: Array.isArray(r.order) ? r.order : [],
  });
  for (const [id, p] of Object.entries(m.panes)) {
    if (typeof p.module !== "string") delete m.panes[id];
    else if (!isPlainObject(p.meta)) p.meta = {};
  }
  m.order = m.order.filter((id, i) => m.workspaces[id] && m.order.indexOf(id) === i);
  for (const id of Object.keys(m.workspaces)) if (!m.order.includes(id)) m.order.push(id);
  const usedTabs = new Set<string>();
  for (const id of m.order) {
    const ws = m.workspaces[id];
    if (typeof ws.color !== "string") ws.color = WORKSPACE_COLORS[0];
    // a tab belongs to one workspace only
    ws.tabs = (Array.isArray(ws.tabs) ? ws.tabs : []).filter((t) => m.tabs[t] && !usedTabs.has(t) && !!usedTabs.add(t));
    if (!ws.activeTab || !ws.tabs.includes(ws.activeTab)) ws.activeTab = ws.tabs[0] ?? null;
  }
  const usedPanes = new Set<string>();
  for (const tab of Object.values(m.tabs)) {
    tab.root = cleanLayout(tab.root);
    if (tab.root) {
      // (a pane shown in two tabs stays in the first)
      for (const p of leaves(tab.root)) if (!m.panes[p] || usedPanes.has(p)) tab.root = removePane(tab.root, p);
      leaves(tab.root).forEach((p) => usedPanes.add(p));
    }
    if (tab.focused && !contains(tab.root, tab.focused)) tab.focused = leaves(tab.root)[0] ?? null;
    if (tab.zoomed && !contains(tab.root, tab.zoomed)) tab.zoomed = null;
  }
  for (const p of Object.keys(m.panes)) if (!usedPanes.has(p)) delete m.panes[p];
  // (stale pop-out windows from a previous run are dropped by the backend at load)
  for (const label of Object.keys(m.windows)) {
    if (label !== "main" && !m.workspaces[m.windows[label]?.workspace]) delete m.windows[label];
  }
  return m;
}

// ── queries ─────────────────────────────────────────────────────────────

export function workspaceOfTab(m: Model, tabId: Id): Workspace | undefined {
  return Object.values(m.workspaces).find((w) => w.tabs.includes(tabId));
}

export function tabOfPane(m: Model, paneId: Id): Tab | undefined {
  return Object.values(m.tabs).find((t) => contains(t.root, paneId));
}

/** Which window currently shows a workspace (if any). */
export function windowOfWorkspace(m: Model, wsId: Id): string | undefined {
  return Object.entries(m.windows).find(([, w]) => w.workspace === wsId)?.[0];
}

// ── workspaces ──────────────────────────────────────────────────────────

export function createWorkspace(
  m: Model,
  opts: { name?: string; icon?: string; color?: string; firstPane?: PaneSpec | null } = {},
): Id {
  const id = uid();
  const n = m.order.length;
  m.workspaces[id] = {
    id,
    name: opts.name ?? `Workspace ${n + 1}`,
    icon: opts.icon ?? "square-terminal",
    color: opts.color ?? WORKSPACE_COLORS[n % WORKSPACE_COLORS.length],
    tabs: [],
    activeTab: null,
  };
  m.order.push(id);
  if (opts.firstPane !== null) createTab(m, id, opts.firstPane ?? { module: "terminal" });
  return id;
}

export function updateWorkspace(m: Model, id: Id, patch: Partial<Pick<Workspace, "name" | "icon" | "color" | "background">>) {
  const ws = m.workspaces[id];
  if (ws) Object.assign(ws, patch);
}

export function deleteWorkspace(m: Model, id: Id): Id[] {
  const ws = m.workspaces[id];
  if (!ws) return [];
  const removed = ws.tabs.flatMap((t) => removeTabData(m, t));
  delete m.workspaces[id];
  m.order = m.order.filter((w) => w !== id);
  for (const [label, win] of Object.entries(m.windows)) {
    if (win.workspace === id) {
      const fallback = m.order.find((w) => !windowOfWorkspace(m, w));
      if (fallback) win.workspace = fallback;
      else if (label !== "main") delete m.windows[label];
    }
  }
  return removed;
}

export function reorderWorkspace(m: Model, id: Id, toIndex: number) {
  const from = m.order.indexOf(id);
  if (from < 0) return;
  m.order.splice(from, 1);
  m.order.splice(Math.max(0, Math.min(toIndex, m.order.length)), 0, id);
}

export function setWindowWorkspace(m: Model, label: string, wsId: Id) {
  m.windows[label] = { workspace: wsId };
}

// ── tabs ────────────────────────────────────────────────────────────────

function newPane(m: Model, spec: PaneSpec): Pane {
  const pane: Pane = { id: uid(12), module: spec.module, meta: { ...(spec.meta ?? {}) }, title: spec.title ?? null };
  m.panes[pane.id] = pane;
  return pane;
}

export function createTab(m: Model, wsId: Id, first: PaneSpec, opts: { activate?: boolean; index?: number; name?: string } = {}): Id {
  const ws = m.workspaces[wsId];
  const pane = newPane(m, first);
  const id = uid();
  m.tabs[id] = { id, name: opts.name ?? "", userNamed: !!opts.name, root: leaf(pane.id), focused: pane.id, zoomed: null };
  const index = opts.index ?? ws.tabs.length;
  ws.tabs.splice(index, 0, id);
  if (opts.activate !== false) ws.activeTab = id;
  return id;
}

export function setActiveTab(m: Model, wsId: Id, tabId: Id) {
  const ws = m.workspaces[wsId];
  if (ws?.tabs.includes(tabId)) ws.activeTab = tabId;
}

export function updateTab(m: Model, tabId: Id, patch: Partial<Pick<Tab, "name" | "userNamed" | "color" | "icon" | "pinned" | "background">>) {
  const tab = m.tabs[tabId];
  if (!tab) return;
  Object.assign(tab, patch);
  if (patch.pinned !== undefined) sortPinned(m, workspaceOfTab(m, tabId));
}

function sortPinned(m: Model, ws?: Workspace) {
  if (!ws) return;
  const pinned = ws.tabs.filter((t) => m.tabs[t]?.pinned);
  const rest = ws.tabs.filter((t) => !m.tabs[t]?.pinned);
  ws.tabs = [...pinned, ...rest];
}

/** Remove a tab's data; returns removed pane ids (for cleanup of their resources). */
function removeTabData(m: Model, tabId: Id): Id[] {
  const tab = m.tabs[tabId];
  if (!tab) return [];
  const panes = leaves(tab.root);
  panes.forEach((p) => delete m.panes[p]);
  delete m.tabs[tabId];
  return panes;
}

export function closeTab(m: Model, tabId: Id): Id[] {
  const ws = workspaceOfTab(m, tabId);
  if (ws) {
    const i = ws.tabs.indexOf(tabId);
    ws.tabs.splice(i, 1);
    if (ws.activeTab === tabId) ws.activeTab = ws.tabs[Math.min(i, ws.tabs.length - 1)] ?? null;
  }
  return removeTabData(m, tabId);
}

export function reorderTab(m: Model, tabId: Id, toIndex: number) {
  const ws = workspaceOfTab(m, tabId);
  if (!ws) return;
  const from = ws.tabs.indexOf(tabId);
  ws.tabs.splice(from, 1);
  ws.tabs.splice(Math.max(0, Math.min(toIndex, ws.tabs.length)), 0, tabId);
  sortPinned(m, ws);
}

/** Move a tab into another workspace (appended, or at `index`). */
export function moveTab(m: Model, tabId: Id, toWs: Id, index?: number, activate = true) {
  const from = workspaceOfTab(m, tabId);
  const to = m.workspaces[toWs];
  if (!from || !to) return;
  if (from.id === toWs) {
    if (index !== undefined) reorderTab(m, tabId, index);
    return;
  }
  const i = from.tabs.indexOf(tabId);
  from.tabs.splice(i, 1);
  if (from.activeTab === tabId) from.activeTab = from.tabs[Math.min(i, from.tabs.length - 1)] ?? null;
  to.tabs.splice(index ?? to.tabs.length, 0, tabId);
  if (activate || !to.activeTab) to.activeTab = tabId;
  sortPinned(m, to);
}

export function duplicateTab(m: Model, tabId: Id, cwdOf: (paneId: Id) => string | undefined): Id | null {
  const tab = m.tabs[tabId];
  const ws = workspaceOfTab(m, tabId);
  if (!tab || !ws || !tab.root) return null;
  const map = new Map<Id, Id>();
  const root = mapPanes(tab.root, (old) => {
    const src = m.panes[old];
    const meta = { ...src.meta };
    if (src.module === "terminal") meta.cwd = cwdOf(old) ?? meta.cwd;
    const p = newPane(m, { module: src.module, meta, title: src.title });
    map.set(old, p.id);
    return p.id;
  });
  const id = uid();
  m.tabs[id] = {
    ...structuredClone(tab),
    id,
    root,
    focused: tab.focused ? map.get(tab.focused) ?? null : null,
    zoomed: null,
    pinned: false,
    name: tab.userNamed ? `${tab.name} copy` : tab.name,
  };
  ws.tabs.splice(ws.tabs.indexOf(tabId) + 1, 0, id);
  ws.activeTab = id;
  return id;
}

// ── panes ───────────────────────────────────────────────────────────────

export function addPane(m: Model, tabId: Id, spec: PaneSpec, place?: { target?: Id | null; side?: Side; outer?: boolean }): Id {
  const tab = m.tabs[tabId];
  const pane = newPane(m, spec);
  if (place?.outer) tab.root = insertOuter(tab.root, pane.id, place.side ?? "right");
  else if (place?.side) tab.root = insertPane(tab.root, place.target ?? tab.focused ?? null, pane.id, place.side);
  else tab.root = autoInsert(tab.root, tab.focused ?? null, pane.id);
  tab.focused = pane.id;
  tab.zoomed = null;
  return pane.id;
}

/** Remove a pane; closes the tab when it was the last one. Returns removed pane ids. */
export function closePane(m: Model, paneId: Id): Id[] {
  const tab = tabOfPane(m, paneId);
  if (!tab) return [];
  tab.root = removePane(tab.root, paneId);
  delete m.panes[paneId];
  if (!tab.root) {
    closeTab(m, tab.id);
    return [paneId];
  }
  if (tab.focused === paneId) tab.focused = leaves(tab.root)[0] ?? null;
  if (tab.zoomed === paneId || leaves(tab.root).length < 2) tab.zoomed = null;
  return [paneId];
}

export function focusPane(m: Model, paneId: Id) {
  const tab = tabOfPane(m, paneId);
  if (tab) tab.focused = paneId;
}

export function toggleZoom(m: Model, tabId: Id, paneId?: Id) {
  const tab = m.tabs[tabId];
  if (!tab) return;
  const target = paneId ?? tab.focused ?? null;
  tab.zoomed = tab.zoomed === target || leaves(tab.root).length < 2 ? null : target;
}

/**
 * Move a pane somewhere else: next to another pane (any tab), swapped with it
 * (side "center"), or to the outer edge of a tab.
 */
export function movePane(m: Model, paneId: Id, dest: { tab: Id; target?: Id | null; side: Side | "center"; outer?: boolean }) {
  const fromTab = tabOfPane(m, paneId);
  const toTab = m.tabs[dest.tab];
  if (!fromTab || !toTab || paneId === dest.target) return;
  if (dest.side === "center" && dest.target) {
    if (fromTab.id === toTab.id) {
      toTab.root = swapPanes(toTab.root!, paneId, dest.target);
      return;
    }
    // swap across tabs (focus/magnify follow the slot, else they'd name a pane in the other tab)
    fromTab.root = swapPanes(fromTab.root!, paneId, dest.target);
    toTab.root = swapPanes(toTab.root!, dest.target, paneId);
    if (fromTab.focused === paneId) fromTab.focused = dest.target;
    if (fromTab.zoomed === paneId) fromTab.zoomed = dest.target;
    if (toTab.zoomed === dest.target) toTab.zoomed = paneId;
    toTab.focused = paneId;
    return;
  }
  fromTab.root = removePane(fromTab.root, paneId);
  if (fromTab.focused === paneId) fromTab.focused = leaves(fromTab.root)[0] ?? null;
  if (fromTab.zoomed === paneId || leaves(fromTab.root).length < 2) fromTab.zoomed = null;
  const side: Side = dest.side === "center" ? "right" : dest.side;
  toTab.root = dest.outer ? insertOuter(toTab.root, paneId, side) : insertPane(toTab.root, dest.target ?? null, paneId, side);
  toTab.focused = paneId;
  toTab.zoomed = null;
  if (!fromTab.root && fromTab.id !== toTab.id) closeTab(m, fromTab.id);
}

/** Pull a pane out into its own new tab (optionally in another workspace). */
export function movePaneToNewTab(m: Model, paneId: Id, wsId?: Id): Id | null {
  const fromTab = tabOfPane(m, paneId);
  if (!fromTab) return null;
  const fromWs = workspaceOfTab(m, fromTab.id);
  const ws = m.workspaces[wsId ?? fromWs?.id ?? ""];
  if (!ws) return null;
  // already alone in a tab of that workspace: a new tab would only drop this one's name, color, pin…
  if (fromWs?.id === ws.id && leaves(fromTab.root).length < 2) return fromTab.id;
  fromTab.root = removePane(fromTab.root, paneId);
  if (fromTab.focused === paneId) fromTab.focused = leaves(fromTab.root)[0] ?? null;
  if (fromTab.zoomed === paneId || leaves(fromTab.root).length < 2) fromTab.zoomed = null;
  const id = uid();
  m.tabs[id] = { id, name: "", root: leaf(paneId), focused: paneId, zoomed: null };
  const insertAt = fromWs?.id === ws.id ? ws.tabs.indexOf(fromTab.id) + 1 : ws.tabs.length;
  ws.tabs.splice(insertAt, 0, id);
  ws.activeTab = id;
  if (!fromTab.root) closeTab(m, fromTab.id);
  return id;
}

export function setPaneMeta(m: Model, paneId: Id, patch: Record<string, any>) {
  const p = m.panes[paneId];
  if (!p) return;
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined || v === null) delete p.meta[k];
    else p.meta[k] = v;
  }
}

export function setPaneTitle(m: Model, paneId: Id, title: string | null) {
  const p = m.panes[paneId];
  if (p) p.title = title;
}

export function changePaneModule(m: Model, paneId: Id, spec: PaneSpec) {
  const p = m.panes[paneId];
  if (!p) return;
  p.module = spec.module;
  p.meta = { ...(spec.meta ?? {}) };
  p.title = spec.title ?? null;
}

export function setTabRoot(m: Model, tabId: Id, root: LayoutNode) {
  const tab = m.tabs[tabId];
  if (tab) tab.root = normalize(root);
}
