// No team in this workspace yet: start one in a repository, or look at an earlier one.
import { useState } from "react";
import { Bot, FolderGit2, FolderOpen, GitBranch, History, LoaderCircle, ShieldAlert, Trash2 } from "lucide-react";
import { Banner, Button, errorText, formatDateTime, sm, type AgentRun, type AgentSnapshot, type PaneContext } from "../../shared";
import { act, forgetTeam } from "./actions";
import { errorKind, errorMessage, modelLabel, runTasks, type ErrorKind } from "./lib";

export function StartScreen({ ctx, snap, canManage, onOpen }: { ctx: PaneContext; snap: AgentSnapshot; canManage: boolean; onOpen: (runId: string) => void }) {
  const [cwd, setCwd] = useState(ctx.cwd ?? "");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState<"start" | "init" | null>(null);
  const [failure, setFailure] = useState<{ kind: ErrorKind; text: string } | null>(null);
  const earlier = snap.runs.filter((r) => r.workspaceId === ctx.workspaceId && r.status === "stopped").sort((a, b) => b.createdAt - a.createdAt);
  const r = snap.routing;
  const blocked = snap.elevated || !canManage;

  const start = async () => {
    setBusy("start");
    setFailure(null);
    try {
      await sm.agents.start({ cwd: cwd.trim() || undefined, name: name.trim() || undefined });
      // the snapshot brings the running team (this pane switches to it)
    } catch (e) {
      setFailure({ kind: errorKind(e), text: errorMessage(e) });
    } finally {
      setBusy(null);
    }
  };

  const browse = async () => {
    try {
      const picked = await sm.ui.pickFolder({ title: "The repository the team works in" });
      if (picked) {
        setCwd(picked);
        setFailure(null);
      }
    } catch (e) {
      sm.ui.notify(errorText(e), "error");
    }
  };

  const initAndStart = async () => {
    setBusy("init");
    try {
      await sm.agents.gitInit(cwd.trim());
    } catch (e) {
      setFailure({ kind: "other", text: errorText(e) });
      setBusy(null);
      return;
    }
    await start();
  };

  return (
    <div className="sm-scroll orc-start">
      {snap.elevated && (
        <Banner tone="warning" icon={<ShieldAlert size={15} />}>
          Shellmosaic is running as administrator, and agents would get administrator rights too. Close it and start it normally to use the Orchestrator.
        </Banner>
      )}
      {!canManage && (
        <Banner tone="info" icon={<ShieldAlert size={15} />}>
          This pane can only watch teams. To start one, allow “Start, stop and instruct Claude Code agents” for Orchestrator in Settings → Plugins.
        </Banner>
      )}
      <div className="orc-start-card">
        <div className="orc-start-title">
          <Bot size={22} />
          <h2>Start a team</h2>
        </div>
        <p className="orc-start-lead">
          A lead Claude Code agent turns what you want into tasks and hands them to up to {r.maxWorkers} worker{r.maxWorkers === 1 ? "" : "s"}. Each worker is its own Claude Code session in a pane of
          this workspace, working in its own git worktree next to the repository. Accepted work collects on <code>orch/integration</code>; you decide what reaches your branch.
        </p>
        <label className="sm-field-label">Repository folder</label>
        <div className="orc-start-folder">
          <input
            className="sm-input wide mono"
            value={cwd}
            placeholder="C:\path\to\your\repository"
            spellCheck={false}
            onChange={(e) => {
              setCwd(e.target.value);
              setFailure(null);
            }}
            onKeyDown={(e) => e.key === "Enter" && !blocked && !busy && start()}
          />
          <Button onClick={browse}>
            <FolderOpen size={14} /> Browse…
          </Button>
        </div>
        {ctx.cwd && cwd !== ctx.cwd && (
          <button type="button" className="orc-link orc-start-reset" onClick={() => setCwd(ctx.cwd!)}>
            Use this tab's folder ({ctx.cwd})
          </button>
        )}
        <label className="sm-field-label">Team name (optional)</label>
        <input className="sm-input wide" value={name} placeholder="The repository's name" maxLength={80} onChange={(e) => setName(e.target.value)} />
        {failure && <StartFailure failure={failure} busy={busy} onInit={initAndStart} cwd={cwd.trim()} />}
        <div className="orc-start-actions">
          <Button kind="primary" disabled={blocked || !!busy || !cwd.trim()} onClick={start}>
            {busy === "start" ? <LoaderCircle size={14} className="sm-spin" /> : <Bot size={14} />} Start the team
          </Button>
          <span className="sm-dim">
            Lead on {modelLabel(r.lead.model)} ({r.lead.effort} effort) · workers by task difficulty, see Routing once it runs
          </span>
        </div>
        <ul className="orc-start-notes">
          <li>Agents run on your Claude account and use your plan's limits; above {r.sonnetAbove}% workers get at most Sonnet, above {r.noHireAbove}% no new ones start.</li>
          <li>They edit files in their own worktrees without asking; anything else (commands, files elsewhere) asks you first, in Requests or in the agent's pane.</li>
          <li>Nothing is pushed: agents can't push, and merging into your branch is your call.</li>
        </ul>
      </div>
      {earlier.length > 0 && (
        <div className="orc-start-card orc-earlier">
          <div className="orc-start-title small">
            <History size={16} />
            <h3>Earlier teams in this workspace</h3>
          </div>
          {earlier.map((run) => (
            <EarlierRun key={run.id} run={run} snap={snap} canManage={canManage} onOpen={() => onOpen(run.id)} />
          ))}
        </div>
      )}
    </div>
  );
}

function StartFailure({ failure, busy, onInit, cwd }: { failure: { kind: ErrorKind; text: string }; busy: "start" | "init" | null; onInit: () => void; cwd: string }) {
  switch (failure.kind) {
    case "not-a-repo":
      return (
        <Banner
          tone="warning"
          icon={<FolderGit2 size={15} />}
          actions={
            <Button small kind="primary" disabled={!!busy} onClick={onInit}>
              {busy === "init" ? <LoaderCircle size={13} className="sm-spin" /> : null} Make it a git repository
            </Button>
          }
        >
          {failure.text}. The team works in git worktrees and branches; Shellmosaic can run <code>git init</code> and commit what's there as the first commit.
        </Banner>
      );
    case "no-commits":
      return (
        <Banner tone="warning" icon={<FolderGit2 size={15} />}>
          The repository has no commits yet. Commit something first: the team branches off your latest commit.
        </Banner>
      );
    case "untrusted":
      return (
        <Banner
          tone="warning"
          icon={<ShieldAlert size={15} />}
          actions={
            <Button small onClick={() => act(() => sm.ui.openModule({ module: "git", path: cwd }))}>
              <GitBranch size={13} /> Open a Git pane to trust it
            </Button>
          }
        >
          This repository's own git settings can run programs. Look at them in a Git pane and trust the repository there, then start the team again.
        </Banner>
      );
    case "elevated":
      return (
        <Banner tone="warning" icon={<ShieldAlert size={15} />}>
          {failure.text}
        </Banner>
      );
    default:
      return <Banner tone="danger">{failure.text}</Banner>;
  }
}

function EarlierRun({ run, snap, canManage, onOpen }: { run: AgentRun; snap: AgentSnapshot; canManage: boolean; onOpen: () => void }) {
  const tasks = runTasks(snap, run);
  const done = tasks.filter((t) => t.status === "done").length;
  return (
    <div className="orc-earlier-row">
      <div className="orc-earlier-main">
        <div className="orc-earlier-name">{run.name}</div>
        <div className="sm-dim orc-earlier-meta">
          <span className="mono sm-ellipsis" title={run.root}>
            {run.root}
          </span>
          <span>
            started {formatDateTime(run.createdAt)} · {done} of {tasks.length} tasks done
          </span>
        </div>
      </div>
      <Button small onClick={onOpen}>
        Open
      </Button>
      {canManage && (
        <Button small kind="subtle" onClick={() => forgetTeam(run)} title="Remove it from this list (its branches stay)">
          <Trash2 size={13} />
        </Button>
      )}
    </div>
  );
}
