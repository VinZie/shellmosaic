// The team's agents: who is doing what, on which model, and what each said last.
import { useMemo } from "react";
import { CircleStop, Ellipsis, Eye, MessageSquare, Pause, Play, Square, UserMinus } from "lucide-react";
import {
  Button,
  formatAgo,
  formatDateTime,
  IconButton,
  KeyValues,
  openMenu,
  Section,
  Table,
  Toolbar,
  useColumnState,
  type Agent,
  type AgentRun,
  type AgentSnapshot,
  type Column,
} from "../../../shared";
import { agentMenu, interruptAgent, messageAgent, pauseAgent, removeWorker, resumeAgent, revealAgent, stopTeam } from "../actions";
import { agentModel, isBusy, isLive, runAgents, slowStart, SLOW_START_HINT, STATE_LABEL, taskNum, TRUST_HINT, trustPending } from "../lib";
import { MasterDetails } from "../Master";
import { AgentName, StateChip } from "../parts";
import type { DetailsSide } from "../prefs";

const STATE_RANK = { waiting: 0, working: 1, starting: 2, idle: 3, paused: 4, exited: 5, stopped: 6 };

function money(v: number | null) {
  return v === null || v === undefined ? "" : `$${v.toFixed(v < 10 ? 2 : 1)}`;
}

export function AgentsTab({
  snap,
  run,
  canManage,
  side,
  selected,
  onSelect,
  onShowTask,
  now,
}: {
  snap: AgentSnapshot;
  run: AgentRun;
  canManage: boolean;
  side: DetailsSide;
  selected: string | null;
  onSelect: (id: string | null) => void;
  onShowTask: (taskId: string) => void;
  now: number;
}) {
  const agents = runAgents(snap, run);
  const [cols, setCols] = useColumnState("agents");
  const titleOf = (id: string | null) => (id ? snap.tasks.find((t) => t.id === id)?.title ?? "" : "");

  const columns = useMemo<Column<Agent>[]>(
    () => [
      { id: "name", label: "Agent", width: 130, render: (a) => <AgentName agent={a} />, text: (a) => a.name, sort: (a) => (a.role === "lead" ? "0" : a.slot) },
      { id: "state", label: "State", width: 108, render: (a) => <StateChip state={a.state} slow={slowStart(a, now)} />, text: (a) => STATE_LABEL[a.state], sort: (a) => STATE_RANK[a.state] },
      { id: "model", label: "Model", width: 100, text: (a) => agentModel(a), sort: (a) => agentModel(a) },
      { id: "effort", label: "Effort", width: 70, text: (a) => a.effort, hidden: true },
      {
        id: "task",
        label: "Task",
        width: 220,
        text: (a) => (a.taskId ? `${a.taskId} ${titleOf(a.taskId)}` : a.role === "lead" ? "Coordinates the team" : ""),
        render: (a) =>
          a.taskId ? (
            <span className="sm-cell-text">
              <span className="orc-task-id">{a.taskId}</span> {titleOf(a.taskId)}
            </span>
          ) : (
            <span className="sm-dim sm-cell-text">{a.role === "lead" ? "Coordinates the team" : "No task"}</span>
          ),
        sort: (a) => (a.taskId ? taskNum(a.taskId) : null),
      },
      { id: "ctx", label: "Context", width: 72, align: "right", text: (a) => (a.contextPct === null ? "" : `${Math.round(a.contextPct)}%`), sort: (a) => a.contextPct, title: "Context window used" },
      { id: "cost", label: "Cost", width: 70, align: "right", text: (a) => money(a.costUsd), sort: (a) => a.costUsd, title: "What this session would cost at API prices (Claude Code's estimate)" },
      { id: "since", label: "Since", width: 100, text: (a) => formatAgo(a.stateSince, now), sort: (a) => a.stateSince, title: "In this state since" },
      { id: "branch", label: "Branch", width: 160, mono: true, text: (a) => a.branch ?? "", hidden: true },
      { id: "pid", label: "PID", width: 64, align: "right", text: (a) => (a.pid ? String(a.pid) : ""), sort: (a) => a.pid, hidden: true },
      { id: "cwd", label: "Folder", width: 240, mono: true, text: (a) => a.cwd, hidden: true },
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [snap.tasks, now],
  );

  const current = agents.find((a) => a.id === selected) ?? null;

  const list = (
    <Table
      columns={columns}
      rows={agents}
      rowKey={(a) => a.id}
      columnState={cols}
      onColumnState={setCols}
      selected={current ? [current.id] : []}
      onSelect={(keys) => onSelect((keys[0] as string) ?? null)}
      onOpen={(a) => isLive(a) && revealAgent(a)}
      onContextMenu={(at, rows) => rows[0] && openMenu(at, agentMenu(rows[0], run, canManage, { onShowTask, trusting: trustPending(snap, rows[0]) }))}
      rowClass={(a) => (a.state === "waiting" || slowStart(a, now)) && "orc-row-attention"}
      empty="No agents"
    />
  );

  return <MasterDetails side={side} open={!!current} list={list} details={current && <AgentDetails agent={current} run={run} snap={snap} canManage={canManage} onShowTask={onShowTask} now={now} />} />;
}

function AgentDetails({ agent: a, run, snap, canManage, onShowTask, now }: { agent: Agent; run: AgentRun; snap: AgentSnapshot; canManage: boolean; onShowTask: (id: string) => void; now: number }) {
  const active = run.status === "active";
  const live = isLive(a);
  const task = a.taskId ? snap.tasks.find((t) => t.id === a.taskId) : undefined;
  const lastTask = !task && a.lastTaskId ? snap.tasks.find((t) => t.id === a.lastTaskId) : undefined;
  const started = a.modelId && a.model && !a.modelId.toLowerCase().includes(a.model.toLowerCase()) ? ` (started as ${a.model})` : "";
  const manage = canManage && active;
  const trusting = trustPending(snap, a);
  const hint = trusting ? TRUST_HINT : slowStart(a, now) ? SLOW_START_HINT : null;
  return (
    <>
      <div className="orc-details-head">
        <AgentName agent={a} />
        <StateChip state={a.state} slow={slowStart(a, now)} />
        <span className="sm-grow" />
        <IconButton title="More" onClick={(e) => openMenu(e.currentTarget, agentMenu(a, run, canManage, { onShowTask, trusting }))}>
          <Ellipsis size={15} />
        </IconButton>
      </div>
      <Toolbar className="orc-details-actions">
        <Button small onClick={() => revealAgent(a)} disabled={!live} title="Switch to its pane">
          <Eye size={13} /> Show pane
        </Button>
        {manage && (!live || a.state === "paused") && (
          <Button small kind="primary" onClick={() => resumeAgent(a)}>
            <Play size={13} /> Resume
          </Button>
        )}
        {manage && isBusy(a) && !trusting && (
          <>
            <Button small onClick={() => interruptAgent(a)} title="Stop its current turn (Esc)">
              <Square size={12} /> Interrupt
            </Button>
            <Button small onClick={() => pauseAgent(a)} title="Interrupt and keep it paused until you resume it">
              <Pause size={13} /> Pause
            </Button>
          </>
        )}
        {manage && live && !trusting && (
          <Button small onClick={() => messageAgent(a)}>
            <MessageSquare size={13} /> Message…
          </Button>
        )}
        <span className="sm-grow" />
        {manage &&
          (a.role === "lead" ? (
            <Button small kind="subtle" onClick={() => stopTeam(run)} title="Stop the lead and every worker">
              <CircleStop size={13} /> Stop team
            </Button>
          ) : (
            <Button small kind="subtle" onClick={() => removeWorker(a)}>
              <UserMinus size={13} /> Remove
            </Button>
          ))}
      </Toolbar>
      <div className="sm-scroll sm-pad">
        {hint && <p className="sm-warning-text orc-details-hint">{hint}.</p>}
        <Section title="Details">
          <KeyValues
            labelWidth={110}
            rows={[
              { label: "Role", value: a.role === "lead" ? "Lead: plans, assigns and reviews" : `Worker (${a.slot})` },
              { label: "Model", value: `${agentModel(a)}${started} · ${a.effort} effort`, copyText: a.modelId ?? a.model },
              task
                ? { label: "Task", value: <button type="button" className="orc-link" onClick={() => onShowTask(task.id)}>{`${task.id} · ${task.title}`}</button>, copyText: task.id }
                : lastTask
                  ? { label: "Last task", value: <button type="button" className="orc-link" onClick={() => onShowTask(lastTask.id)}>{`${lastTask.id} · ${lastTask.title}`}</button>, copyText: lastTask.id }
                  : null,
              a.branch ? { label: "Branch", value: a.branch, mono: true } : null,
              { label: "Folder", value: a.cwd, mono: true },
              a.contextPct !== null && { label: "Context", value: `${Math.round(a.contextPct)}% of the window used` },
              a.costUsd !== null && { label: "Cost", value: `${money(a.costUsd)} at API prices`, copyText: null },
              { label: "State", value: `${STATE_LABEL[a.state]} since ${formatAgo(a.stateSince, now)}`, title: formatDateTime(a.stateSince), copyText: null },
              a.pid ? { label: "PID", value: String(a.pid), mono: true } : null,
              { label: "Session", value: a.sessionId, mono: true },
              { label: "Started", value: formatDateTime(a.createdAt) },
            ]}
          />
        </Section>
        <Section title="Last message">
          {a.lastMessage ? <div className="orc-prose sm-selectable">{a.lastMessage}</div> : <p className="sm-dim orc-none">It hasn't finished a turn yet.</p>}
        </Section>
      </div>
    </>
  );
}
