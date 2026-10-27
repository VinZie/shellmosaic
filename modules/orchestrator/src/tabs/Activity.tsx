// What happened in the team, newest at the bottom: tasks, agents, requests, tool calls.
import { useEffect, useMemo, useState } from "react";
import { ArrowDownToLine, Flag, X } from "lucide-react";
import {
  Chip,
  formatDateTime,
  Grow,
  IconButton,
  SearchBox,
  Select,
  Table,
  Toolbar,
  useColumnState,
  useStored,
  type AgentActivity,
  type AgentRun,
  type AgentSnapshot,
  type Column,
  type Tone,
} from "../../../shared";
import { runAgents } from "../lib";

type Group = "all" | "tasks" | "agents" | "requests" | "tools" | "notes";

const GROUPS: { value: Group; label: string }[] = [
  { value: "all", label: "Everything" },
  { value: "tasks", label: "Tasks" },
  { value: "agents", label: "Agents and team" },
  { value: "requests", label: "Requests" },
  { value: "tools", label: "Tool calls and progress" },
  { value: "notes", label: "Notices" },
];

function groupOf(kind: string): Group {
  if (kind.startsWith("task.")) return "tasks";
  if (kind.startsWith("agent.") || kind.startsWith("run.")) return "agents";
  if (kind === "request") return "requests";
  if (kind === "tool" || kind === "progress") return "tools";
  return "notes";
}

const KIND: Record<string, [string, Tone | undefined]> = {
  "task.created": ["Task created", undefined],
  "task.assigned": ["Assigned", "accent"],
  "task.review": ["Finished", "warning"],
  "task.failed": ["Failed", "danger"],
  "task.blocked": ["Blocked", "danger"],
  "task.done": ["Accepted", "success"],
  "task.rework": ["Sent back", "warning"],
  "task.cancelled": ["Cancelled", "dim"],
  "task.undelivered": ["Not delivered", "danger"],
  "agent.hired": ["Started", "accent"],
  "agent.removed": ["Removed", "dim"],
  "agent.exited": ["Exited", "danger"],
  "agent.stopped": ["Stopped early", "warning"],
  "agent.interrupt": ["Interrupted", undefined],
  "run.start": ["Team started", "success"],
  "run.stop": ["Team stopped", "dim"],
  "run.merged": ["Merged", "success"],
  request: ["Request", "warning"],
  tool: ["Tool", "dim"],
  progress: ["Progress", undefined],
  notice: ["Notice", "accent"],
};

const kindLabel = (k: string) => KIND[k]?.[0] ?? k;

export function ActivityTab({ snap, run, items, active }: { snap: AgentSnapshot; run: AgentRun; items: AgentActivity[]; active: boolean }) {
  const [group, setGroup] = useStored<Group>("activity:group", "all");
  const [who, setWho] = useState("");
  const [q, setQ] = useState("");
  const [leadOnly, setLeadOnly] = useState(false);
  const [follow, setFollow] = useState(true);
  const [sel, setSel] = useState<number | null>(null);
  const [cols, setCols] = useColumnState("activity");
  const agents = runAgents(snap, run);
  const nameOf = (id: string | null) => (id ? agents.find((a) => a.id === id)?.name ?? "Removed agent" : "Team");

  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return items.filter(
      (a) => (group === "all" || groupOf(a.kind) === group) && (!who || a.agentId === who) && (!leadOnly || a.lead) && (!needle || a.text.toLowerCase().includes(needle) || a.taskId === needle),
    );
  }, [items, group, who, leadOnly, q]);

  const columns = useMemo<Column<AgentActivity>[]>(
    () => [
      { id: "time", label: "Time", width: 74, mono: true, text: (a) => formatDateTime(a.t).slice(11), title: "Local time" },
      { id: "agent", label: "Who", width: 96, text: (a) => nameOf(a.agentId) },
      {
        id: "kind",
        label: "What",
        width: 116,
        text: (a) => kindLabel(a.kind),
        render: (a) => (
          <span className="orc-kind">
            {a.lead && <Flag size={11} className="orc-lead-flag" aria-label="The lead was told" />}
            <Chip tone={KIND[a.kind]?.[1]}>{kindLabel(a.kind)}</Chip>
          </span>
        ),
      },
      { id: "task", label: "Task", width: 50, mono: true, text: (a) => a.taskId ?? "", hidden: true },
      { id: "text", label: "Event", width: 420, text: (a) => a.text },
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [agents],
  );

  const last = rows.length ? rows[rows.length - 1].seq : null;
  const [scrollKey, setScrollKey] = useState<number | null>(null);
  useEffect(() => {
    if (follow && active && last !== null) setScrollKey(last);
  }, [follow, active, last]);

  const current = sel !== null ? items.find((a) => a.seq === sel) : undefined;
  return (
    <div className="orc-tab-col">
      <Toolbar>
        <Select value={group} onChange={setGroup} options={GROUPS} title="Kinds of events" />
        <Select value={who} onChange={setWho} options={[{ value: "", label: "Everyone" }, ...agents.map((a) => ({ value: a.id, label: a.name }))]} title="One agent's events" />
        <SearchBox value={q} onChange={setQ} placeholder="Filter activity" width={190} />
        <IconButton title="Only what the lead was told (tasks finished, questions, workers that stopped)" on={leadOnly} onClick={() => setLeadOnly((v) => !v)}>
          <Flag size={14} />
        </IconButton>
        <Grow />
        <span className="sm-dim orc-counts">{rows.length === items.length ? `${items.length} events` : `${rows.length} of ${items.length}`}</span>
        <IconButton title={follow ? "Following new events (click to stop)" : "Follow new events"} on={follow} onClick={() => setFollow((v) => !v)}>
          <ArrowDownToLine size={14} />
        </IconButton>
      </Toolbar>
      <Table
        columns={columns}
        rows={rows}
        rowKey={(a) => a.seq}
        columnState={cols}
        onColumnState={setCols}
        sortRows={false}
        selected={sel !== null ? [sel] : []}
        onSelect={(keys) => {
          setSel((keys[0] as number) ?? null);
          setFollow(false);
        }}
        scrollTo={scrollKey}
        rowClass={(a) => a.lead && "orc-row-lead"}
        rowHeight={24}
        empty={items.length ? "Nothing matches the filters" : "Nothing has happened yet"}
      />
      {current && (
        <div className="orc-activity-detail">
          <div className="orc-activity-detail-head">
            <span className="mono sm-dim">{formatDateTime(current.t)}</span>
            <span>{nameOf(current.agentId)}</span>
            <Chip tone={KIND[current.kind]?.[1]}>{kindLabel(current.kind)}</Chip>
            {current.taskId && <span className="orc-task-id">{current.taskId}</span>}
            {current.lead && <Chip tone="accent" icon={<Flag size={11} />}>The lead was told</Chip>}
            <span className="sm-grow" />
            <IconButton title="Close" onClick={() => setSel(null)}>
              <X size={13} />
            </IconButton>
          </div>
          <div className="orc-prose sm-selectable">{current.text}</div>
        </div>
      )}
    </div>
  );
}
