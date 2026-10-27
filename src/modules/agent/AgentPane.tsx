// An Orchestrator agent's pane: its Claude Code session in a terminal. The Orchestrator
// (src-tauri/src/agents) starts and ends the session; the pane shows it, and its header
// says what the agent is doing.
import { Icon } from "../../lib/icons";
import { errorText, ipc, type Agent, type AgentState } from "../../lib/ipc";
import { cx } from "../../lib/util";
import * as A from "../../state/actions";
import { agentOfPane, confirmAgentPanes, runOfAgent, useAgents } from "../../state/agents";
import { ui, type MenuItem } from "../../state/ui";
import { getModule, type ModuleDef, type ModuleProps } from "../registry";
import { disposeTerm } from "../terminal/termRegistry";
import { TerminalPane } from "../terminal/TerminalPane";
import "./agent.css";

const STATE_LABEL: Record<AgentState, string> = {
  starting: "starting",
  idle: "idle",
  working: "working",
  waiting: "needs you",
  paused: "paused",
  stopped: "stopped",
  exited: "exited",
};

/** "claude-sonnet-5-5" → "sonnet", an alias as it is. */
export function modelName(agent: Agent): string {
  const id = agent.modelId ?? agent.model;
  return id.replace(/^claude-/, "").replace(/-\d.*$/, "") || id;
}

function useAgent(paneId: string): { agent: Agent | undefined; loaded: boolean } {
  const agent = useAgents((s) => s.snap?.agents.find((a) => a.paneId === paneId));
  const loaded = useAgents((s) => !!s.snap);
  return { agent, loaded };
}

function AgentPane(props: ModuleProps) {
  const { agent, loaded } = useAgent(props.pane.id);
  if (loaded && !agent) {
    return (
      <div className="empty-state">
        <Icon name="bot" size={28} />
        <p>This agent no longer exists.</p>
        <p className="dim">Its team was stopped and forgotten, or the Orchestrator's data was reset.</p>
        <div className="row">
          <button className="btn" onClick={() => A.closePane(props.pane.id)}>
            Close pane
          </button>
        </div>
      </div>
    );
  }
  return <TerminalPane {...props} />;
}

function HeaderStatus({ pane }: ModuleProps) {
  const { agent } = useAgent(pane.id);
  if (!agent) return null;
  const task = agent.taskId ? ` · ${agent.taskId}` : "";
  const ctx = agent.contextPct != null ? ` · ctx ${Math.round(agent.contextPct)}%` : "";
  return (
    <span className={cx("agent-chip", `agent-${agent.state}`)} title={`${agent.name}: ${STATE_LABEL[agent.state]}${task}\nModel: ${agent.modelId ?? agent.model} (${agent.effort} effort)${ctx}`}>
      <span className="agent-dot" />
      {modelName(agent)}
      {task}
      <span className="agent-state">{STATE_LABEL[agent.state]}</span>
    </span>
  );
}

const run = (p: Promise<unknown>) => p.catch((e) => ui.toast(errorText(e), "error"));

function agentMenu(paneId: string): MenuItem[] {
  const agent = agentOfPane(paneId);
  if (!agent) return [];
  const live = agent.state !== "stopped" && agent.state !== "exited";
  const busy = agent.state === "working" || agent.state === "waiting";
  const items: MenuItem[] = [{ type: "header", label: `${agent.name} · ${runOfAgent(agent)?.name ?? "team"}` }];
  if (!live || agent.state === "paused") items.push({ label: "Resume", icon: "play", onSelect: () => run(ipc.agentsResume(agent.id)) });
  if (busy) {
    items.push({ label: "Interrupt (Esc)", icon: "square", onSelect: () => run(ipc.agentsInterrupt(agent.id)) });
    items.push({ label: "Pause", icon: "pause", onSelect: () => run(ipc.agentsInterrupt(agent.id, true)) });
  }
  items.push({
    label: "Send a message…",
    icon: "message-square",
    disabled: !live,
    onSelect: async () => {
      const text = await ui.prompt(`Message to ${agent.name}`, "", { placeholder: "Typed into its session as if you wrote it there", okLabel: "Send" });
      if (text?.trim()) run(ipc.agentsSend(agent.id, text.trim()));
    },
  });
  items.push({
    label: "Open the Orchestrator",
    icon: "bot",
    onSelect: () => (getModule("plugin:orchestrator") ? A.addModule("plugin:orchestrator", { target: paneId, side: "bottom" }) : ui.openSettings("optional-modules")),
  });
  items.push({ type: "separator" });
  items.push(
    agent.role === "lead"
      ? { label: "Stop the team…", icon: "circle-stop", danger: true, onSelect: () => confirmAgentPanes([paneId]) }
      : { label: "Remove worker…", icon: "user-minus", danger: true, onSelect: () => confirmAgentPanes([paneId]) },
  );
  return items;
}

export const agentModule: ModuleDef = {
  id: "agent",
  name: "Agent",
  icon: "bot",
  description: "A Claude Code agent of the Orchestrator",
  hidden: true,
  component: AgentPane,
  headerActions: HeaderStatus,
  title: (pane) => {
    const agent = agentOfPane(pane.id);
    return agent ? `${agent.name} — ${runOfAgent(agent)?.name ?? "team"}` : "Agent";
  },
  menu: (pane) => agentMenu(pane.id),
  // the agent itself is stopped through the Orchestrator (see confirmAgentPanes); the view goes
  onRemove: (paneId) => disposeTerm(paneId),
};
