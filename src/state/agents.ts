// The Orchestrator as the UI sees it: the backend's state (src-tauri/src/agents) mirrored
// here, agent panes placed and closed when the backend asks, requests that need the user,
// and the confirmations before closing panes that stop agents.
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow, UserAttentionType } from "@tauri-apps/api/window";
import { create } from "zustand";
import { errorText, ipc, type Agent, type AgentPaneRequest, type AgentRequest, type AgentSnapshot } from "../lib/ipc";
import { uid } from "../lib/util";
import { leaf, leaves, type LayoutNode } from "./layout";
import * as M from "./model";
import { commit, getState } from "./store";
import { ui } from "./ui";

export const useAgents = create<{ snap: AgentSnapshot | null }>(() => ({ snap: null }));

let refreshing: Promise<void> | null = null;
let again = false;

/** Fetch the backend's state (calls arriving meanwhile share one more fetch). */
export function refreshAgents(): Promise<void> {
  if (refreshing) {
    again = true;
    return refreshing;
  }
  refreshing = (async () => {
    do {
      again = false;
      try {
        useAgents.setState({ snap: await ipc.agentsSnapshot() });
      } catch (e) {
        console.warn("agents snapshot", e);
      }
    } while (again);
  })().finally(() => {
    refreshing = null;
  });
  return refreshing;
}

export function agentOfPane(paneId: string): Agent | undefined {
  return useAgents.getState().snap?.agents.find((a) => a.paneId === paneId);
}

export function runOfAgent(agent: Agent) {
  return useAgents.getState().snap?.runs.find((r) => r.id === agent.runId);
}

/** Where a workspace is shown: that window places and closes its agent panes (main when none shows it). */
function ownsWorkspace(wsId: string): boolean {
  const { model, label } = getState();
  return (M.windowOfWorkspace(model, wsId) ?? "main") === label;
}

/** The lead on the left, workers stacked on the right. */
function agentGrid(panes: string[]): LayoutNode {
  if (panes.length === 1) return leaf(panes[0]);
  if (panes.length === 2) return { kind: "split", id: uid(), dir: "row", children: panes.map(leaf), sizes: [0.5, 0.5] };
  const [lead, ...rest] = panes;
  const workers: LayoutNode = { kind: "split", id: uid(), dir: "col", children: rest.map(leaf), sizes: rest.map(() => 1 / rest.length) };
  return { kind: "split", id: uid(), dir: "row", children: [leaf(lead), workers], sizes: [0.5, 0.5] };
}

/** Lead first, then workers by slot. */
function byRole(panes: string[]): string[] {
  const agents = useAgents.getState().snap?.agents ?? [];
  const rank = (p: string) => {
    const a = agents.find((x) => x.paneId === p);
    return !a ? 99 : a.role === "lead" ? 0 : Number(a.slot.slice(1)) || 50;
  };
  return [...panes].sort((a, b) => rank(a) - rank(b));
}

/** Put an agent's pane into its run's tab. New panes never take the focus from the user. */
async function placePane(req: Extract<AgentPaneRequest, { op: "add" }>) {
  if (getState().model.panes[req.paneId] || !ownsWorkspace(req.workspaceId)) return;
  await refreshAgents();
  const snap = useAgents.getState().snap;
  const run = snap?.runs.find((r) => r.id === req.runId);
  const runPanes = new Set((snap?.agents ?? []).filter((a) => a.runId === req.runId).map((a) => a.paneId));
  const isLead = run?.leadId === req.agentId;
  const spec: M.PaneSpec = { id: req.paneId, module: "agent", meta: { agentId: req.agentId } };
  const tabId = await commit((d) => {
    const ws = d.workspaces[req.workspaceId];
    if (!ws || d.panes[req.paneId]) return null;
    let tab = req.tabId && ws.tabs.includes(req.tabId) ? d.tabs[req.tabId] : undefined;
    tab ??= ws.tabs.map((t) => d.tabs[t]).find((t) => leaves(t.root).some((p) => runPanes.has(p)));
    if (!tab) return M.createTab(d, ws.id, spec, { activate: isLead, name: run ? `${run.name} · team` : "Team" });
    const before = tab.focused ?? null;
    const others = leaves(tab.root).filter((p) => d.panes[p]?.module !== "agent");
    if (others.length === 0) {
      M.addPane(d, tab.id, spec);
      d.tabs[tab.id].root = agentGrid(byRole(leaves(d.tabs[tab.id].root)));
    } else {
      // the user arranged this tab: just put it next to the run's last agent
      const near = byRole(leaves(tab.root).filter((p) => runPanes.has(p))).pop() ?? null;
      M.addPane(d, tab.id, spec, { target: near, side: near ? "bottom" : "right" });
    }
    d.tabs[tab.id].focused = before ?? req.paneId;
    return tab.id;
  });
  if (tabId && tabId !== run?.tabId) ipc.agentsSetTab(req.runId, tabId).catch(() => {});
}

function removePane(paneId: string) {
  const m = getState().model;
  const tab = M.tabOfPane(m, paneId);
  const ws = tab ? M.workspaceOfTab(m, tab.id) : undefined;
  if (ws && ownsWorkspace(ws.id)) commit((d) => M.closePane(d, paneId));
}

/** A request the user should see: a toast, and the window asks for attention when it isn't focused. */
function attention(req: AgentRequest, agentName: string) {
  const agent = useAgents.getState().snap?.agents.find((a) => a.id === req.agentId);
  const run = agent ? runOfAgent(agent) : undefined;
  if (run && !ownsWorkspace(run.workspaceId)) return;
  ui.toast(`${agentName} asks to ${req.summary}. Answer in its pane or in the Orchestrator's Requests.`, "warning", 8000);
  if (agent) ui.setBadge(agent.paneId, "bell");
  if (!document.hasFocus()) getCurrentWindow().requestUserAttention(UserAttentionType.Informational).catch(() => {});
}

/** Listen to the Orchestrator (each window). */
export async function startAgents() {
  await Promise.all([
    listen<number>("agents://changed", () => refreshAgents()),
    listen<AgentPaneRequest>("agents://pane", (e) => {
      if (e.payload.op === "add") placePane(e.payload).catch((err) => ui.toast(`Couldn't place the agent's pane: ${errorText(err)}`, "error"));
      else removePane(e.payload.paneId);
    }),
    listen<{ request: AgentRequest; agentName: string }>("agents://attention", (e) => attention(e.payload.request, e.payload.agentName)),
    listen<{ text: string; kind: "info" | "success" | "warning" | "error" }>("agents://notice", (e) => {
      if (getState().label === "main") ui.toast(e.payload.text, e.payload.kind ?? "info", 6000);
    }),
  ]);
  await refreshAgents();
}

/**
 * Before closing panes: the agents in them stop, after asking. Closing a lead's pane stops
 * its whole team; closing a worker's removes that worker. False: the user said no.
 */
export async function confirmAgentPanes(paneIds: string[]): Promise<boolean> {
  const snap = useAgents.getState().snap;
  if (!snap) return true;
  const active = new Set(snap.runs.filter((r) => r.status === "active").map((r) => r.id));
  const agents = paneIds.map(agentOfPane).filter((a): a is Agent => !!a && active.has(a.runId));
  if (!agents.length) return true;
  const runs = [...new Set(agents.filter((a) => a.role === "lead").map((a) => a.runId))];
  if (runs.length) {
    const names = runs.map((r) => snap.runs.find((x) => x.id === r)?.name ?? "team").join(", ");
    const ok = await ui.confirm(
      runs.length === 1 ? `Stop the ${names} team?` : `Stop ${runs.length} teams (${names})?`,
      "The lead and every worker end their Claude Code sessions. Work that isn't merged stays on its branches, and the task list is kept.",
      { okLabel: "Stop team", danger: true },
    );
    if (!ok) return false;
    for (const r of runs) await ipc.agentsStopRun(r).catch((e) => ui.toast(errorText(e), "error"));
  }
  const workers = agents.filter((a) => a.role === "worker" && !runs.includes(a.runId));
  if (workers.length) {
    const ok = await ui.confirm(
      workers.length === 1 ? `Remove ${workers[0].name}?` : `Remove ${workers.length} workers?`,
      "Their Claude Code sessions end and their current tasks go back to the queue. What they committed stays on its branches.",
      { okLabel: "Remove", danger: true },
    );
    if (!ok) return false;
    for (const w of workers) await ipc.agentsRemove(w.id).catch((e) => ui.toast(errorText(e), "error"));
  }
  return true;
}
