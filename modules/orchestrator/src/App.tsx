// Orchestrator: a team of Claude Code agents in this workspace. Without a running team the
// pane offers to start one (or shows an earlier one); with one, it shows the team, its
// tasks, what happened, what's waiting for you, and which model runs what.
//
// The pane remembers its tab and the earlier team it shows; `args` may ask for a tab
// ({ tab: "requests" }) or the merge dialog ({ open: "merge" }).
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Activity, Bot, Gauge, Inbox, ListTodo, Route, Settings2, ShieldAlert, Users } from "lucide-react";
import {
  Banner,
  Button,
  errorText,
  Footer,
  IconButton,
  Loading,
  Message,
  Popover,
  sm,
  Tabs,
  usePane,
  usePaneState,
  useStored,
  type AgentRun,
  type AgentSnapshot,
  type PaneContext,
  type Routing,
  type TabItem,
} from "../../shared";
import { useActivity, useNow, useSnapshot, useUsage } from "./data";
import { errorKind, isLive, runAgents, runRequests, runTasks, STATE_LABEL, trustPending, untilText, type Usage, type UsageWindow } from "./lib";
import { openMerge } from "./Merge";
import { ALL_TABS, DEFAULT_PREFS, normalizePrefs, TAB_LABELS, type Prefs, type TabId } from "./prefs";
import { RunHeader } from "./RunHeader";
import { StartScreen } from "./StartScreen";
import { ActivityTab } from "./tabs/Activity";
import { AgentsTab } from "./tabs/Agents";
import { RequestsTab } from "./tabs/Requests";
import { RoutingTab } from "./tabs/Routing";
import { TasksTab } from "./tabs/Tasks";
import { TabSettings } from "./TabSettings";
import "./style.css";

type PaneState = {
  /** an earlier (stopped) team the pane shows */
  runId: string | null;
  tab: TabId | null;
};

const TAB_ICONS: Record<TabId, React.ReactNode> = {
  agents: <Users size={14} />,
  tasks: <ListTodo size={14} />,
  activity: <Activity size={14} />,
  requests: <Inbox size={14} />,
  routing: <Route size={14} />,
};

export function App() {
  const ctx = usePane();
  return <div className="sm-app orc-app">{ctx ? <Orchestrator ctx={ctx} /> : <Loading />}</div>;
}

function Orchestrator({ ctx }: { ctx: PaneContext }) {
  const canRead = ctx.grantedPermissions.includes("agents.read");
  if (!canRead) {
    return (
      <Message icon={<ShieldAlert size={28} />} title="Orchestrator can't see your agents" tone="warning">
        <p>It needs “See your Claude Code agents”. Allow it for Orchestrator in Settings → Plugins, then reopen this pane.</p>
      </Message>
    );
  }
  return <Connected ctx={ctx} />;
}

function Connected({ ctx }: { ctx: PaneContext }) {
  const canManage = ctx.grantedPermissions.includes("agents.manage");
  const { snap, error, refresh } = useSnapshot(ctx.visible);
  const argTab = typeof ctx.args?.tab === "string" && ALL_TABS.includes(ctx.args.tab as TabId) ? (ctx.args.tab as TabId) : null;
  const [pane, savePane] = usePaneState<PaneState>(ctx, { runId: null, tab: argTab });

  if (!snap) {
    if (!error) return <Loading label="Looking for your team…" />;
    if (errorKind(error) === "unsupported") {
      return (
        <Message icon={<Bot size={28} />} title="This Shellmosaic can't run agents yet" tone="warning">
          <p>The Orchestrator needs Shellmosaic 0.4.0 or newer (this is {ctx.appVersion || "an older version"}). Update Shellmosaic, then reopen this pane.</p>
        </Message>
      );
    }
    return (
      <Message icon={<Bot size={28} />} title="Couldn't read the Orchestrator's state" tone="danger" actions={<Button onClick={refresh}>Try again</Button>}>
        <p className="sm-selectable">{errorText(error)}</p>
      </Message>
    );
  }

  const mine = snap.runs.filter((r) => r.workspaceId === ctx.workspaceId);
  const active = mine.find((r) => r.status === "active");
  const viewing = !active && pane.runId ? mine.find((r) => r.id === pane.runId) : undefined;
  const run = active ?? viewing;
  if (!run) return <StartScreen ctx={ctx} snap={snap} canManage={canManage} onOpen={(id) => savePane({ runId: id })} />;
  return (
    <RunView
      key={run.id}
      ctx={ctx}
      snap={snap}
      run={run}
      canManage={canManage}
      initialTab={pane.tab}
      onTab={(tab) => savePane({ tab })}
      onBack={viewing ? () => savePane({ runId: null }) : undefined}
    />
  );
}

/** The plan limits are changing what the team does: say so. */
function UsageBanner({ usage, routing, now }: { usage: Usage | null; routing: Routing; now: number }) {
  const windows = [
    { name: "5-hour", w: usage?.fiveHour },
    { name: "weekly", w: usage?.sevenDay },
  ].filter((x): x is { name: string; w: UsageWindow } => !!x.w);
  const worst = windows.sort((a, b) => b.w.pct - a.w.pct)[0];
  if (!worst || worst.w.pct < routing.sonnetAbove) return null;
  const hard = worst.w.pct >= routing.noHireAbove;
  const resets = worst.w.resetsAt ? ` It resets ${untilText(worst.w.resetsAt, now)}.` : "";
  return (
    <Banner tone={hard ? "danger" : "warning"} icon={<Gauge size={15} />}>
      {Math.round(worst.w.pct)}% of the {worst.name} plan limit is used:{" "}
      {hard ? "no new workers start; tasks wait for an idle one." : "workers get at most Sonnet (Opus tasks run on Sonnet)."}
      {resets}
    </Banner>
  );
}

function RunView({
  ctx,
  snap,
  run,
  canManage,
  initialTab,
  onTab,
  onBack,
}: {
  ctx: PaneContext;
  snap: AgentSnapshot;
  run: AgentRun;
  canManage: boolean;
  initialTab: TabId | null;
  onTab: (t: TabId) => void;
  onBack?: () => void;
}) {
  const [stored, setPrefs] = useStored<Prefs>("prefs", DEFAULT_PREFS);
  const prefs = useMemo(() => normalizePrefs(stored), [stored]);
  const [choice, setChoice] = useState<TabId | null>(initialTab);
  const [settingsAt, setSettingsAt] = useState<HTMLElement | null>(null);
  const closeSettings = useCallback(() => setSettingsAt(null), []);
  const [agentSel, setAgentSel] = useState<string | null>(run.leadId);
  const [taskSel, setTaskSel] = useState<string | null>(null);
  const now = useNow(15_000, ctx.visible);
  const usage = useUsage(snap, ctx.grantedPermissions.includes("claude.usage"), ctx.visible);
  const activity = useActivity(run.id, snap.lastSeq);

  const visible = prefs.tabs.filter((t) => t.visible).map((t) => t.id);
  const tab: TabId = choice && visible.includes(choice) ? choice : prefs.defaultTab;
  const visited = useRef(new Set<TabId>());
  visited.current.add(tab);
  const go = useCallback(
    (t: TabId) => {
      setChoice(t);
      onTab(t);
    },
    [onTab],
  );

  const agents = runAgents(snap, run);
  const lead = agents.find((a) => a.role === "lead");
  const workers = agents.filter((a) => a.role === "worker");
  const tasks = runTasks(snap, run);
  const pending = runRequests(snap, run).filter((q) => q.status === "pending").length;
  const review = tasks.filter((t) => t.status === "review").length;
  const cost = agents.reduce((a, x) => a + (x.costUsd ?? 0), 0);

  useEffect(() => {
    sm.ui.setTitle(`Orchestrator — ${run.name}`).catch(() => {});
  }, [run.name]);

  // opened to merge (another module, a notice)
  const askedMerge = useRef(false);
  useEffect(() => {
    if (!askedMerge.current && ctx.args?.open === "merge") {
      askedMerge.current = true;
      openMerge(run, canManage);
    }
  }, [ctx.args, run, canManage]);

  const showTask = useCallback((id: string) => (setTaskSel(id), go("tasks")), [go]);
  const showAgent = useCallback((a: { id: string }) => (setAgentSel(a.id), go("agents")), [go]);

  const items: TabItem[] = visible.map((id) => ({
    id,
    label: TAB_LABELS[id],
    icon: TAB_ICONS[id],
    badge:
      id === "requests" && pending ? (
        <span className="orc-pending-badge">{pending}</span>
      ) : id === "tasks" && review ? (
        <span className="orc-review-badge" title={`${review} to review`}>
          {review}
        </span>
      ) : id === "agents" ? (
        agents.filter(isLive).length
      ) : undefined,
  }));

  const render = (id: TabId) => {
    switch (id) {
      case "agents":
        return <AgentsTab snap={snap} run={run} canManage={canManage} side={prefs.details} selected={agentSel} onSelect={setAgentSel} onShowTask={showTask} now={now} />;
      case "tasks":
        return <TasksTab snap={snap} run={run} canManage={canManage} side={prefs.details} selected={taskSel} onSelect={setTaskSel} onShowAgent={showAgent} now={now} />;
      case "activity":
        return <ActivityTab snap={snap} run={run} items={activity} active={tab === "activity"} />;
      case "requests":
        return <RequestsTab snap={snap} run={run} canManage={canManage} now={now} />;
      case "routing":
        return <RoutingTab routing={snap.routing} canManage={canManage} usage={usage} />;
    }
  };

  const stopped = run.status === "stopped";
  return (
    <>
      <RunHeader run={run} lead={lead} leadTrusting={!!lead && trustPending(snap, lead)} routing={snap.routing} usage={usage} canManage={canManage} now={now} onBack={onBack} />
      {stopped && (
        <Banner tone="info">
          This team was stopped{agents.length ? "" : " and its agents are gone"}. Its tasks, activity and branches are kept: merge what's on orch/integration, or start a new team to continue.
        </Banner>
      )}
      {!stopped && <UsageBanner usage={usage} routing={snap.routing} now={now} />}
      {!canManage && !stopped && (
        <Banner tone="info" icon={<ShieldAlert size={15} />}>
          Read-only: to give the team work, answer requests or change routing, allow “Start, stop and instruct Claude Code agents” in Settings → Plugins.
        </Banner>
      )}
      <div className="orc-tabbar">
        <Tabs items={items} active={tab} onChange={(id) => go(id as TabId)} />
        <div className="orc-tabbar-end">
          <IconButton title="Tabs and layout" on={!!settingsAt} onClick={(e) => setSettingsAt(settingsAt ? null : e.currentTarget)}>
            <Settings2 size={15} />
          </IconButton>
        </div>
      </div>
      <div className="orc-body">
        {ALL_TABS.filter((id) => visited.current.has(id)).map((id) => (
          <div key={id} className="orc-tabpane" hidden={id !== tab} role="tabpanel">
            {render(id)}
          </div>
        ))}
      </div>
      <Footer>
        {lead && (
          <span>
            Lead: <span className={`orc-foot-state ${lead.state}`}>{STATE_LABEL[lead.state].toLowerCase()}</span>
          </span>
        )}
        <span>
          · {workers.filter(isLive).length} of {snap.routing.maxWorkers} workers
        </span>
        <span>
          · {tasks.filter((t) => t.status === "done").length}/{tasks.length} tasks done
        </span>
        {pending > 0 && <span className="sm-warning-text">· {pending} waiting for you</span>}
        <span className="sm-grow" />
        {cost > 0 && <span title="What the sessions would cost at API prices (Claude Code's own estimate); your plan's usage is the meter above">≈ ${cost.toFixed(2)} at API prices</span>}
      </Footer>
      <Popover anchor={settingsAt} onClose={closeSettings} width={Math.min(300, window.innerWidth - 8)}>
        <TabSettings prefs={prefs} onChange={setPrefs} />
      </Popover>
    </>
  );
}
