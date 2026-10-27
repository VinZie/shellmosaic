// The team at a glance: name, repository and branch, plan usage, merge and stop, and the
// box where you tell the lead what to do.
import { useRef, useState } from "react";
import { Bot, CircleStop, Copy, Ellipsis, FolderOpen, GitBranch, GitMerge, Play, Send, Trash2 } from "lucide-react";
import { Button, Chip, copy, cx, IconButton, openMenu, sm, type Agent, type AgentRun, type MenuItem, type Routing } from "../../shared";
import { act, forgetTeam, resumeAgent, stopTeam } from "./actions";
import { isBusy, isLive, TRUST_HINT, type Usage } from "./lib";
import { openMerge } from "./Merge";
import { UsageMeter } from "./parts";

export function RunHeader({
  run,
  lead,
  routing,
  usage,
  leadTrusting,
  canManage,
  now,
  onBack,
}: {
  run: AgentRun;
  lead: Agent | undefined;
  /** the lead's trust prompt waits for an answer: nothing can be typed to it yet */
  leadTrusting: boolean;
  routing: Routing;
  usage: Usage | null;
  canManage: boolean;
  now: number;
  onBack?: () => void;
}) {
  const active = run.status === "active";
  const more = (): MenuItem[] => [
    { label: "Copy repository path", icon: <Copy size={14} />, onSelect: () => copy(run.root, "path") },
    { label: "Open the repository in Files", icon: <FolderOpen size={14} />, onSelect: () => act(() => sm.ui.openModule({ module: "files", path: run.root })) },
    ...(canManage && !active ? [{ separator: true as const }, { label: "Forget this team…", icon: <Trash2 size={14} />, danger: true, onSelect: () => forgetTeam(run).then((ok) => ok && onBack?.()) }] : []),
  ];
  return (
    <div className="orc-head">
      <div className="orc-head-line">
        <Bot size={18} className="orc-head-icon" />
        <span className="orc-head-name" title={run.name}>
          {run.name}
        </span>
        {active ? <Chip tone="success">Running</Chip> : <Chip>Stopped</Chip>}
        <span className="orc-head-repo sm-ellipsis" title={run.root}>
          {run.root}
        </span>
        {run.baseBranch && (
          <Chip icon={<GitBranch size={11} />} title={`Your branch when the team started: approved work is merged into it`}>
            {run.baseBranch}
          </Chip>
        )}
        <span className="sm-grow" />
        <UsageMeter usage={usage} routing={routing} now={now} />
        <Button small onClick={() => openMerge(run, canManage)} disabled={!run.baseBranch} title={run.baseBranch ? `See what orch/integration would bring into ${run.baseBranch}` : "The repository was on a detached HEAD"}>
          <GitMerge size={13} /> Merge into {run.baseBranch ?? "branch"}…
        </Button>
        {active && canManage && (
          <Button small kind="subtle" onClick={() => stopTeam(run)}>
            <CircleStop size={13} /> Stop team
          </Button>
        )}
        {!active && onBack && (
          <Button small kind="subtle" onClick={onBack}>
            Back
          </Button>
        )}
        <IconButton title="More" onClick={(e) => openMenu(e.currentTarget, more())}>
          <Ellipsis size={15} />
        </IconButton>
      </div>
      {active && <Composer lead={lead} trusting={leadTrusting} canManage={canManage} />}
    </div>
  );
}

/** Tell the lead what to do: the goal, a change of plan, an answer. */
function Composer({ lead, trusting, canManage }: { lead: Agent | undefined; trusting: boolean; canManage: boolean }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);
  const live = !!lead && isLive(lead);
  const send = async () => {
    if (!lead || !text.trim() || busy || trusting) return;
    setBusy(true);
    if (await act(() => sm.agents.send(lead.id, text.trim()), "Sent to the lead")) setText("");
    setBusy(false);
    ref.current?.focus();
  };
  if (!canManage) return null;
  if (!live) {
    return (
      <div className="orc-composer stopped">
        <span className="sm-dim">The lead isn't running{lead?.state === "exited" ? " (Claude Code ended)" : ""}. Resume it to continue its conversation.</span>
        {lead && (
          <Button small kind="primary" onClick={() => resumeAgent(lead)}>
            <Play size={13} /> Resume the lead
          </Button>
        )}
      </div>
    );
  }
  const rows = Math.min(8, Math.max(2, text.split("\n").length));
  return (
    <div className="orc-composer">
      <textarea
        ref={ref}
        className="sm-input orc-composer-input"
        rows={rows}
        value={text}
        placeholder="Tell the lead what you want done: the goal, constraints, how to check it. It plans the tasks and starts workers."
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            send();
          }
        }}
      />
      <div className="orc-composer-side">
        <Button small kind="primary" disabled={!text.trim() || busy || trusting} onClick={send} title="Ctrl+Enter">
          <Send size={13} /> Send
        </Button>
        <span className={cx("orc-composer-hint", isBusy(lead!) && "busy")} title={trusting ? TRUST_HINT : undefined}>
          {trusting ? "Trust its folder first" : isBusy(lead!) ? "Working: it reads it next" : "Ctrl+Enter"}
        </span>
      </div>
    </div>
  );
}
