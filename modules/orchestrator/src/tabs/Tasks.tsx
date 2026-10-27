// The team's tasks: what's queued, running, waiting for review and done, with each
// worker's report and the changes on its branch.
import { useMemo, useState } from "react";
import { Ban, Check, Ellipsis, ListPlus, Play, Plus, RotateCw, Undo2 } from "lucide-react";
import {
  Button,
  Chip,
  formatAgo,
  formatDateTime,
  Grow,
  IconButton,
  KeyValues,
  openMenu,
  SearchBox,
  Section,
  Select,
  Table,
  Toolbar,
  useColumnState,
  type Agent,
  type AgentRun,
  type AgentSnapshot,
  type AgentTask,
  type Column,
} from "../../../shared";
import { acceptTask, assignItems, cancelTask, retryLevel, sendBack, taskMenu } from "../actions";
import { DiffView } from "../Diff";
import { DIFFICULTY_LABEL, modelLabel, runAgents, runTasks, TASK_LABEL, TASK_RANK, taskNum } from "../lib";
import { MasterDetails } from "../Master";
import { AgentName, Difficulty, TaskChip } from "../parts";
import type { DetailsSide } from "../prefs";
import { openNewTask } from "./NewTask";

type Filter = "all" | "open" | "review" | "done" | "failed";

const FILTERS: { value: Filter; label: string }[] = [
  { value: "all", label: "All tasks" },
  { value: "open", label: "Open" },
  { value: "review", label: "To review" },
  { value: "done", label: "Done" },
  { value: "failed", label: "Failed or cancelled" },
];

function matches(t: AgentTask, f: Filter): boolean {
  switch (f) {
    case "open":
      return ["queued", "assigned", "working", "review"].includes(t.status);
    case "review":
      return t.status === "review";
    case "done":
      return t.status === "done";
    case "failed":
      return t.status === "failed" || t.status === "cancelled";
    default:
      return true;
  }
}

export function TasksTab({
  snap,
  run,
  canManage,
  side,
  selected,
  onSelect,
  onShowAgent,
  now,
}: {
  snap: AgentSnapshot;
  run: AgentRun;
  canManage: boolean;
  side: DetailsSide;
  selected: string | null;
  onSelect: (id: string | null) => void;
  onShowAgent: (a: Agent) => void;
  now: number;
}) {
  const [filter, setFilter] = useState<Filter>("all");
  const [who, setWho] = useState("");
  const [q, setQ] = useState("");
  const [cols, setCols] = useColumnState("tasks");
  const agents = runAgents(snap, run);
  const workers = agents.filter((a) => a.role === "worker");
  const all = runTasks(snap, run);
  const nameOf = (id: string | null) => agents.find((a) => a.id === id)?.name ?? (id ? "Removed worker" : "");
  const active = run.status === "active";
  const manage = canManage && active;

  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return all.filter(
      (t) =>
        matches(t, filter) &&
        (!who || t.assignee === who) &&
        (!needle || `${t.id} ${t.title} ${t.description} ${t.summary ?? ""}`.toLowerCase().includes(needle)),
    );
  }, [all, filter, who, q]);

  const columns = useMemo<Column<AgentTask>[]>(
    () => [
      { id: "id", label: "#", width: 52, mono: true, text: (t) => t.id, sort: (t) => taskNum(t.id) },
      { id: "title", label: "Title", width: 280, text: (t) => t.title, sort: (t) => t.title },
      { id: "status", label: "Status", width: 100, render: (t) => <TaskChip status={t.status} />, text: (t) => TASK_LABEL[t.status], sort: (t) => TASK_RANK[t.status] },
      { id: "difficulty", label: "Difficulty", width: 82, render: (t) => <Difficulty value={t.difficulty} />, text: (t) => `${t.difficulty} ${DIFFICULTY_LABEL[t.difficulty]}`, sort: (t) => t.difficulty },
      { id: "assignee", label: "Worker", width: 100, text: (t) => nameOf(t.assignee), sort: (t) => nameOf(t.assignee) || null },
      { id: "model", label: "Model", width: 90, text: (t) => modelLabel(t.model), sort: (t) => t.model },
      { id: "attempts", label: "Tries", width: 52, align: "right", text: (t) => (t.attempts ? String(t.attempts) : ""), sort: (t) => t.attempts, title: "How often it was started or sent back" },
      { id: "failures", label: "Failures", width: 64, align: "right", text: (t) => (t.failures ? String(t.failures) : ""), sort: (t) => t.failures, title: "Times it failed, was blocked or was sent back (from 2 on a retry runs one level up)", hidden: true },
      { id: "updated", label: "Updated", width: 100, text: (t) => formatAgo(t.updatedAt, now), sort: (t) => t.updatedAt },
      { id: "branch", label: "Branch", width: 150, mono: true, text: (t) => t.branch ?? "", hidden: true },
      { id: "created", label: "Created", width: 140, text: (t) => formatDateTime(t.createdAt), sort: (t) => t.createdAt, hidden: true },
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [agents, now],
  );

  const current = all.find((t) => t.id === selected) ?? null;
  const counts = {
    review: all.filter((t) => t.status === "review").length,
    open: all.filter((t) => ["queued", "assigned", "working"].includes(t.status)).length,
    done: all.filter((t) => t.status === "done").length,
  };
  const followUp = (t: AgentTask) => openNewTask(snap, run, { followUpOf: t, onCreated: (n) => onSelect(n.id) });
  const menuFor = (t: AgentTask) =>
    taskMenu(t, {
      run,
      workers,
      canManage,
      routing: snap.routing,
      worker: agents.find((a) => a.id === t.assignee),
      onFollowUp: followUp,
      onShowWorker: onShowAgent,
    });

  const list = (
    <div className="orc-tab-col">
      <Toolbar>
        <Button small kind="primary" disabled={!manage} onClick={() => openNewTask(snap, run, { onCreated: (t) => onSelect(t.id) })} title={manage ? "Create a task for a worker" : "Needs a running team and the agents.manage permission"}>
          <Plus size={13} /> New task
        </Button>
        <Select value={filter} onChange={setFilter} options={FILTERS} title="Which tasks to show" />
        <Select value={who} onChange={setWho} options={[{ value: "", label: "Every worker" }, ...workers.map((w) => ({ value: w.id, label: w.name }))]} title="Tasks of one worker" />
        <SearchBox value={q} onChange={setQ} placeholder="Filter tasks" width={180} />
        <Grow />
        <span className="orc-counts">
          {counts.review > 0 && <Chip tone="warning">{counts.review} to review</Chip>}
          <span className="sm-dim">
            {counts.open} open · {counts.done} done · {all.length} total
          </span>
        </span>
      </Toolbar>
      <Table
        columns={columns}
        rows={rows}
        rowKey={(t) => t.id}
        columnState={cols}
        onColumnState={setCols}
        defaultSort={{ id: "status", desc: false }}
        selected={current ? [current.id] : []}
        onSelect={(keys) => onSelect((keys[0] as string) ?? null)}
        onContextMenu={(at, r) => r[0] && openMenu(at, menuFor(r[0]))}
        rowClass={(t) => t.status === "review" && "orc-row-attention"}
        empty={
          all.length === 0 ? (
            <span>
              No tasks yet. Tell the lead what you want done (above) and it creates them, or add one with <b>New task</b>.
            </span>
          ) : (
            "No task matches"
          )
        }
      />
    </div>
  );

  return (
    <MasterDetails
      side={side}
      open={!!current}
      list={list}
      details={current && <TaskDetails key={current.id} task={current} snap={snap} run={run} agents={agents} workers={workers} manage={manage} menu={menuFor(current)} onFollowUp={followUp} onShowAgent={onShowAgent} onSelect={onSelect} />}
    />
  );
}

function TaskDetails({
  task: t,
  snap,
  run,
  agents,
  workers,
  manage,
  menu,
  onFollowUp,
  onShowAgent,
  onSelect,
}: {
  task: AgentTask;
  snap: AgentSnapshot;
  run: AgentRun;
  agents: Agent[];
  workers: Agent[];
  manage: boolean;
  menu: ReturnType<typeof taskMenu>;
  onFollowUp: (t: AgentTask) => void;
  onShowAgent: (a: Agent) => void;
  onSelect: (id: string) => void;
}) {
  const worker = agents.find((a) => a.id === t.assignee);
  const parent = t.followUpOf ? snap.tasks.find((x) => x.id === t.followUpOf) : undefined;
  const followUps = snap.tasks.filter((x) => x.followUpOf === t.id);
  const reviewable = t.status === "review" || t.status === "failed";
  return (
    <>
      <div className="orc-details-head">
        <span className="orc-task-id">{t.id}</span>
        <span className="orc-details-title sm-ellipsis" title={t.title}>
          {t.title}
        </span>
        <TaskChip status={t.status} />
        <span className="sm-grow" />
        <IconButton title="More" onClick={(e) => openMenu(e.currentTarget, menu)}>
          <Ellipsis size={15} />
        </IconButton>
      </div>
      {manage && (t.status === "queued" || reviewable || t.status === "done" || t.status === "working" || t.status === "assigned") && (
        <Toolbar className="orc-details-actions">
          {t.status === "queued" && (
            <Button small kind="primary" onClick={(e) => openMenu(e.currentTarget, assignItems(t, workers, snap.routing.maxWorkers))}>
              <Play size={13} /> Assign…
            </Button>
          )}
          {t.status === "failed" && (
            <Button small kind="primary" onClick={(e) => openMenu(e.currentTarget, assignItems(t, workers, snap.routing.maxWorkers))} title="Start it again, in a fresh session">
              <RotateCw size={13} /> {t.failures >= 2 ? "Retry one level up…" : "Retry…"}
            </Button>
          )}
          {reviewable && (
            <>
              <Button small kind={t.status === "review" ? "primary" : undefined} onClick={() => acceptTask(t)} title="Merge its branch into orch/integration">
                <Check size={13} /> {t.status === "review" ? "Accept" : "Accept as is"}
              </Button>
              <Button small onClick={() => sendBack(t, worker)} disabled={!t.assignee}>
                <Undo2 size={13} /> Send back…
              </Button>
            </>
          )}
          {(t.status === "done" || reviewable) && (
            <Button small onClick={() => onFollowUp(t)}>
              <ListPlus size={13} /> Follow-up…
            </Button>
          )}
          <span className="sm-grow" />
          {["queued", "assigned", "working", "review"].includes(t.status) && (
            <Button small kind="subtle" onClick={() => cancelTask(t)}>
              <Ban size={13} /> Cancel
            </Button>
          )}
        </Toolbar>
      )}
      {(t.status === "failed" || t.status === "queued") && retryLevel(t, snap.routing) && <div className="orc-retry-note">{retryLevel(t, snap.routing)}</div>}
      <div className="sm-scroll sm-pad">
        {t.summary && (
          <Section title={t.status === "failed" ? "Worker's report (didn't finish)" : "Worker's report"}>
            <div className={`orc-prose sm-selectable orc-report ${t.status === "failed" ? "failed" : ""}`}>{t.summary}</div>
          </Section>
        )}
        <Section title="Task">
          {t.description ? <div className="orc-prose sm-selectable">{t.description}</div> : <p className="sm-dim orc-none">No description.</p>}
        </Section>
        <Section title="Details">
          <KeyValues
            labelWidth={110}
            rows={[
              { label: "Difficulty", value: `${t.difficulty} of 5 · ${DIFFICULTY_LABEL[t.difficulty]}`, copyText: null },
              {
                label: "Worker",
                value: worker ? (
                  <button type="button" className="orc-link" onClick={() => onShowAgent(worker)}>
                    <AgentName agent={worker} />
                  </button>
                ) : t.assignee ? (
                  "A removed worker"
                ) : (
                  "Not assigned"
                ),
                copyText: null,
              },
              t.model ? { label: "Model", value: modelLabel(t.model), copyText: t.model } : null,
              t.branch ? { label: "Branch", value: t.branch, mono: true } : null,
              t.attempts > 1 && { label: "Tries", value: `${t.attempts} (sent back or restarted)`, copyText: null },
              t.failures > 0 && {
                label: "Failures",
                value: `${t.failures} (failed, blocked or sent back)${t.failures >= 2 ? " · retries run one level up" : ""}`,
                copyText: null,
              },
              parent && {
                label: "Follow-up of",
                value: <button type="button" className="orc-link" onClick={() => onSelect(parent.id)}>{`${parent.id} · ${parent.title}`}</button>,
                copyText: parent.id,
              },
              followUps.length > 0 && {
                label: "Follow-ups",
                value: (
                  <span className="orc-inline-list">
                    {followUps.map((f) => (
                      <button key={f.id} type="button" className="orc-link" onClick={() => onSelect(f.id)}>
                        {f.id}
                      </button>
                    ))}
                  </span>
                ),
                copyText: null,
              },
              { label: "Created", value: formatDateTime(t.createdAt) },
              { label: "Updated", value: formatDateTime(t.updatedAt) },
            ]}
          />
        </Section>
        {t.branch && (
          <Section title="Changes">
            <DiffView taskId={t.id} branch={t.branch} auto={reviewable || t.status === "done"} />
          </Section>
        )}
        {run.status !== "active" && t.status !== "done" && t.status !== "cancelled" && <p className="sm-dim orc-none">This team was stopped: start a new team to continue the work.</p>}
      </div>
    </>
  );
}
