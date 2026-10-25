// What the user can customize (kept in the module's storage, shared by every inspector pane).
import type { PaneContext } from "../../../shared";
import type { Live } from "./resource";

export type TabId = "overview" | "modules" | "threads" | "handles" | "token" | "memory";

export const TAB_LABELS: Record<TabId, string> = {
  overview: "Overview",
  modules: "Modules",
  threads: "Threads",
  handles: "Handles",
  token: "Token",
  memory: "Memory",
};

export const ALL_TABS = Object.keys(TAB_LABELS) as TabId[];

export interface Prefs {
  /** order and visibility of the tabs */
  tabs: { id: TabId; visible: boolean }[];
  defaultTab: TabId;
  /** ms; 0 = off */
  interval: number;
}

export const DEFAULT_PREFS: Prefs = {
  tabs: ALL_TABS.map((id) => ({ id, visible: true })),
  defaultTab: "overview",
  interval: 2000,
};

export const INTERVALS = [
  { value: "0", label: "Off" },
  { value: "1000", label: "Every second" },
  { value: "2000", label: "Every 2 seconds" },
  { value: "5000", label: "Every 5 seconds" },
  { value: "10000", label: "Every 10 seconds" },
];

/** Saved prefs from older versions (or edited by hand) made whole again. */
export function normalizePrefs(p: Prefs): Prefs {
  const seen = new Set<TabId>();
  const tabs = (Array.isArray(p.tabs) ? p.tabs : []).filter((t) => t && ALL_TABS.includes(t.id) && !seen.has(t.id) && seen.add(t.id));
  for (const id of ALL_TABS) if (!seen.has(id)) tabs.push({ id, visible: true });
  if (!tabs.some((t) => t.visible)) tabs[0] = { ...tabs[0], visible: true };
  const interval = INTERVALS.some((i) => Number(i.value) === p.interval) ? p.interval : DEFAULT_PREFS.interval;
  const defaultTab = ALL_TABS.includes(p.defaultTab) ? p.defaultTab : "overview";
  return { tabs, defaultTab, interval };
}

/** What every tab gets from the inspector. */
export interface TabProps {
  ctx: PaneContext;
  pid: number;
  /** process name, once known */
  name: string;
  active: boolean;
  live: Live;
  /** process.control was granted */
  canControl: boolean;
  /** a call said the process exited: let the inspector check */
  onExited: () => void;
  /** switch this pane to another process */
  inspect: (pid: number) => void;
  /** refresh everything after an action changed the process */
  afterAction: () => void;
}
