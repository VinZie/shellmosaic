// What the agents are waiting for: permission prompts (yours to answer, here or in the
// agent's pane) and workers' questions (the lead's, though you can answer too).
import { useMemo, useState } from "react";
import { Check, CheckCheck, CircleHelp, Eye, ShieldQuestion, X } from "lucide-react";
import {
  Button,
  Chip,
  cx,
  formatAgo,
  formatDateTime,
  Section,
  sm,
  Table,
  Toolbar,
  useColumnState,
  type Agent,
  type AgentRequest,
  type AgentRun,
  type AgentSnapshot,
  type Column,
  type RequestStatus,
  type Tone,
} from "../../../shared";
import { act, revealAgent } from "../actions";
import { runAgents, runRequests } from "../lib";
import { AgentName } from "../parts";

const STATUS: Record<RequestStatus, [string, Tone | undefined]> = {
  pending: ["Waiting", "warning"],
  allowed: ["Allowed", "success"],
  denied: ["Denied", "danger"],
  answered: ["Answered", "success"],
  closed: ["Closed", "dim"],
};

/** Who settled it, in words. */
function byText(q: AgentRequest): string {
  switch (q.answeredBy) {
    case "you":
      return "You, here";
    case "terminal":
      return "In its pane";
    case "lead":
      return "The lead";
    case "timeout":
      return "Nobody (timed out)";
    case "restart":
      return "Closed: Shellmosaic restarted";
    case "stopped":
      return "Closed: the team stopped";
    case "removed":
      return "Closed: the agent was removed";
    case "cancelled":
      return "Cancelled by the agent";
    case "gone":
      return "Closed: nothing was waiting any more";
    case null:
    case undefined:
      return "";
    default:
      return q.answeredBy;
  }
}

export function RequestsTab({ snap, run, canManage, now }: { snap: AgentSnapshot; run: AgentRun; canManage: boolean; now: number }) {
  const agents = runAgents(snap, run);
  const all = runRequests(snap, run);
  const pending = all.filter((q) => q.status === "pending").sort((a, b) => a.createdAt - b.createdAt);
  const history = all.filter((q) => q.status !== "pending");
  const [cols, setCols] = useColumnState("requests");
  const nameOf = (id: string) => agents.find((a) => a.id === id)?.name ?? "Removed agent";

  const columns = useMemo<Column<AgentRequest>[]>(
    () => [
      { id: "id", label: "#", width: 50, mono: true, text: (q) => q.id, sort: (q) => Number(q.id.slice(1)) },
      { id: "who", label: "Agent", width: 96, text: (q) => nameOf(q.agentId), sort: (q) => nameOf(q.agentId) },
      { id: "kind", label: "Kind", width: 90, text: (q) => (q.kind === "permission" ? "Permission" : "Question"), sort: (q) => q.kind },
      { id: "summary", label: "Request", width: 300, text: (q) => q.summary },
      { id: "status", label: "Result", width: 92, render: (q) => <Chip tone={STATUS[q.status][1]}>{STATUS[q.status][0]}</Chip>, text: (q) => STATUS[q.status][0], sort: (q) => q.status },
      { id: "by", label: "By", width: 140, text: byText, sort: byText },
      { id: "when", label: "When", width: 100, text: (q) => formatAgo(q.answeredAt ?? q.createdAt, now), sort: (q) => q.answeredAt ?? q.createdAt },
      { id: "answer", label: "Answer", width: 220, text: (q) => q.answer ?? "", hidden: true },
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [agents, now],
  );

  return (
    <div className="orc-tab-col orc-requests">
      <div className={cx("orc-pending", pending.length === 0 && "empty")}>
        {pending.length === 0 ? (
          <div className="orc-pending-none">
            <CheckCheck size={18} />
            <span>Nothing is waiting for you.</span>
            <span className="sm-dim">Permission prompts and workers' questions show up here (and in the agent's pane) when they come.</span>
          </div>
        ) : (
          <Section title={`Waiting (${pending.length})`} className="orc-pending-section">
            {pending.map((q) => (
              <RequestCard key={q.id} req={q} agent={agents.find((a) => a.id === q.agentId)} canAnswer={canManage && run.status === "active"} now={now} />
            ))}
          </Section>
        )}
      </div>
      <Toolbar className="orc-subhead">
        <span className="orc-subhead-title">History</span>
        <span className="sm-dim">{history.length ? `${history.length} answered or closed` : "None yet"}</span>
      </Toolbar>
      <Table
        columns={columns}
        rows={history}
        rowKey={(q) => q.id}
        columnState={cols}
        onColumnState={setCols}
        defaultSort={{ id: "when", desc: true }}
        empty="Answered requests are listed here"
      />
    </div>
  );
}

/** The tool input, shown the way it reads best for that tool. */
function Detail({ req }: { req: AgentRequest }) {
  const d = (req.detail ?? {}) as Record<string, unknown>;
  const s = (k: string) => (typeof d[k] === "string" ? (d[k] as string) : "");
  if (req.kind === "question") return <div className="orc-prose sm-selectable orc-question">{req.summary}</div>;
  if ((req.tool === "Bash" || req.tool === "PowerShell") && s("command")) {
    return (
      <>
        {s("description") && <div className="sm-dim orc-req-desc">{s("description")}</div>}
        <pre className="orc-code sm-selectable">{s("command")}</pre>
      </>
    );
  }
  if (req.tool === "Write" && s("file_path")) {
    const lines = s("content").split("\n");
    return (
      <>
        <div className="mono orc-req-path sm-selectable">{s("file_path")}</div>
        <pre className="orc-code sm-selectable">
          {lines.slice(0, 30).join("\n")}
          {lines.length > 30 ? `\n… ${lines.length - 30} more lines` : ""}
        </pre>
      </>
    );
  }
  if (req.tool === "WebFetch" && s("url")) {
    return (
      <>
        <div className="mono orc-req-path sm-selectable">{s("url")}</div>
        {s("prompt") && <div className="sm-dim orc-req-desc">{s("prompt")}</div>}
      </>
    );
  }
  if (req.tool === "WebSearch" && s("query")) return <div className="orc-req-path sm-selectable">{s("query")}</div>;
  if ((req.tool === "Edit" || req.tool === "MultiEdit") && s("file_path")) {
    return (
      <>
        <div className="mono orc-req-path sm-selectable">{s("file_path")}</div>
        {(s("old_string") || s("new_string")) && (
          <pre className="orc-code orc-code-diff sm-selectable">
            {s("old_string")
              .split("\n")
              .slice(0, 15)
              .map((l, i) => (
                <div key={`o${i}`} className="orc-dl del">
                  -{l}
                </div>
              ))}
            {s("new_string")
              .split("\n")
              .slice(0, 15)
              .map((l, i) => (
                <div key={`n${i}`} className="orc-dl add">
                  +{l}
                </div>
              ))}
          </pre>
        )}
      </>
    );
  }
  if (req.detail === null || req.detail === undefined) return null;
  return <pre className="orc-code sm-selectable">{JSON.stringify(req.detail, null, 2)}</pre>;
}

function RequestCard({ req: q, agent, canAnswer, now }: { req: AgentRequest; agent: Agent | undefined; canAnswer: boolean; now: number }) {
  const [answer, setAnswer] = useState("");
  const [denying, setDenying] = useState(false);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const hasSuggestions = Array.isArray(q.suggestions) && q.suggestions.length > 0;
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    await act(fn);
    setBusy(false);
  };
  const permission = q.kind === "permission";
  return (
    <div className={cx("orc-req", permission ? "permission" : "question")}>
      <div className="orc-req-head">
        {permission ? <ShieldQuestion size={15} className="orc-req-icon" /> : <CircleHelp size={15} className="orc-req-icon" />}
        {agent ? <AgentName agent={agent} /> : <span>A removed agent</span>}
        <span className="sm-dim">{permission ? "asks to" : "asks the lead"}</span>
        {permission && (
          <span className="orc-req-summary sm-ellipsis" title={q.summary}>
            {q.summary}
          </span>
        )}
        <span className="sm-grow" />
        {q.tool && <Chip>{q.tool}</Chip>}
        <span className="sm-dim orc-req-when" title={formatDateTime(q.createdAt)}>
          {formatAgo(q.createdAt, now)}
        </span>
        <span className="orc-task-id">{q.id}</span>
      </div>
      <Detail req={q} />
      {permission ? (
        canAnswer ? (
          denying ? (
            <div className="orc-req-actions">
              <input
                className="sm-input orc-req-note"
                autoFocus
                value={note}
                placeholder="Why not (optional, the agent reads it)"
                onChange={(e) => setNote(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") run(() => sm.agents.answer(q.id, { allow: false, text: note.trim() || undefined }));
                  if (e.key === "Escape") setDenying(false);
                }}
              />
              <Button small kind="danger" disabled={busy} onClick={() => run(() => sm.agents.answer(q.id, { allow: false, text: note.trim() || undefined }))}>
                <X size={13} /> Deny
              </Button>
              <Button small kind="subtle" onClick={() => setDenying(false)}>
                Back
              </Button>
            </div>
          ) : (
            <div className="orc-req-actions">
              <Button small kind="primary" disabled={busy} onClick={() => run(() => sm.agents.answer(q.id, { allow: true }))}>
                <Check size={13} /> Allow
              </Button>
              {hasSuggestions && (
                <Button small disabled={busy} onClick={() => run(() => sm.agents.answer(q.id, { allow: true, always: true }))} title="Allow, and let it do the same kind of thing for the rest of its session without asking (Claude Code's own suggestion)">
                  <CheckCheck size={13} /> Allow always
                </Button>
              )}
              <Button small disabled={busy} onClick={() => setDenying(true)}>
                <X size={13} /> Deny…
              </Button>
              <span className="sm-grow" />
              {agent && (
                <Button small kind="subtle" onClick={() => revealAgent(agent)} title="Its pane shows the same prompt: answering there works too">
                  <Eye size={13} /> Show pane
                </Button>
              )}
            </div>
          )
        ) : (
          <p className="sm-dim orc-req-ro">Answer it in {agent?.name ?? "the agent"}'s pane.</p>
        )
      ) : canAnswer ? (
        <div className="orc-req-answer">
          <textarea
            className="sm-input wide orc-textarea"
            rows={2}
            value={answer}
            placeholder="Your answer (the lead may answer first)"
            onChange={(e) => setAnswer(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && answer.trim()) run(() => sm.agents.answer(q.id, { text: answer.trim() }));
            }}
          />
          <Button small kind="primary" disabled={busy || !answer.trim()} onClick={() => run(() => sm.agents.answer(q.id, { text: answer.trim() }))} title="Ctrl+Enter">
            Answer
          </Button>
        </div>
      ) : null}
    </div>
  );
}
