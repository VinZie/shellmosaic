// What the user can arrange (kept in the module's storage, shared by every Orchestrator pane).

export type TabId = "agents" | "tasks" | "activity" | "requests" | "routing";

export const TAB_LABELS: Record<TabId, string> = {
  agents: "Agents",
  tasks: "Tasks",
  activity: "Activity",
  requests: "Requests",
  routing: "Routing",
};

export const ALL_TABS = Object.keys(TAB_LABELS) as TabId[];

export type DetailsSide = "auto" | "right" | "bottom";

export interface Prefs {
  /** order and visibility of the tabs */
  tabs: { id: TabId; visible: boolean }[];
  defaultTab: TabId;
  /** where Agents and Tasks show the selected row's details */
  details: DetailsSide;
}

export const DEFAULT_PREFS: Prefs = {
  tabs: ALL_TABS.map((id) => ({ id, visible: true })),
  defaultTab: "agents",
  details: "auto",
};

/** Saved prefs from older versions (or edited by hand) made whole again. */
export function normalizePrefs(p: Prefs): Prefs {
  const seen = new Set<TabId>();
  const tabs = (Array.isArray(p.tabs) ? p.tabs : []).filter((t) => t && ALL_TABS.includes(t.id) && !seen.has(t.id) && seen.add(t.id));
  for (const id of ALL_TABS) if (!seen.has(id)) tabs.push({ id, visible: true });
  if (!tabs.some((t) => t.visible)) tabs[0] = { ...tabs[0], visible: true };
  const defaultTab = ALL_TABS.includes(p.defaultTab) && tabs.find((t) => t.id === p.defaultTab)?.visible ? p.defaultTab : tabs.find((t) => t.visible)!.id;
  const details: DetailsSide = p.details === "right" || p.details === "bottom" ? p.details : "auto";
  return { tabs, defaultTab, details };
}

/** Sizes of the details panes (px), shared by the tabs. */
export interface Layout {
  detailsW: number;
  detailsH: number;
}

export const DEFAULT_LAYOUT: Layout = { detailsW: 380, detailsH: 260 };
