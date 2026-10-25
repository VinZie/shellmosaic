// Process Inspector: one process, looked at closely. The pane remembers which process
// and tab it shows; the tabs (and their order, refresh rate) are the user's to arrange.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, CircleX, Ellipsis, Pause, Play, RefreshCw, Settings2 } from "lucide-react";
import {
  Banner,
  Button,
  cx,
  formatNumber,
  IconButton,
  Loading,
  Message,
  openMenu,
  Popover,
  sm,
  Tabs,
  Toolbar,
  usePane,
  usePaneState,
  useStored,
  type PaneContext,
  type ProcOverview,
  type TabItem,
} from "../../shared";
import { processMenu, resumeProcess, suspendProcess } from "./components/actions";
import { Header } from "./components/Header";
import { ProcessPicker } from "./components/Picker";
import { TabSettings } from "./components/TabSettings";
import { ALL_TABS, DEFAULT_PREFS, normalizePrefs, TAB_LABELS, type Prefs, type TabId, type TabProps } from "./lib/prefs";
import { useResource, type Live } from "./lib/resource";
import { isExited, type Recent } from "./lib/util";
import { HandlesTab } from "./tabs/Handles";
import { MemoryTab } from "./tabs/Memory";
import { ModulesTab } from "./tabs/Modules";
import { OverviewTab } from "./tabs/Overview";
import { ThreadsTab } from "./tabs/Threads";
import { TokenTab } from "./tabs/Token";
import "./style.css";

/** What the pane saves with the layout. */
type Saved = {
  pid: number | null;
  name: string | null;
  /** the PID the pane was opened with, to tell a restored pane from a fresh "Inspect" */
  argsPid: number | null;
  tab: TabId | null;
};

const loadOverview = (pid: number) => sm.process.overview(pid);

function asPid(v: unknown): number | null {
  if (typeof v === "number" && Number.isInteger(v) && v >= 0) return v;
  if (typeof v === "string" && /^\d+$/.test(v)) return Number(v);
  return null;
}

/** Which process to show first: the "Inspect" argument, else what the pane showed last. */
function initialTarget(ctx: PaneContext) {
  const st = (ctx.state ?? {}) as Partial<Saved>;
  const argPid = asPid(ctx.args?.pid);
  const statePid = asPid(st.pid);
  const tab = st.tab && ALL_TABS.includes(st.tab) ? st.tab : null;
  // saved by this same pane (opened with these args): the user may have switched process since
  const restored = statePid !== null && (argPid === null || st.argsPid === argPid);
  if (restored) return { pid: statePid, argsPid: argPid, restoredName: typeof st.name === "string" ? st.name : null, tab };
  return { pid: argPid, argsPid: argPid, restoredName: null, tab: argPid !== null ? null : tab };
}

export function App() {
  const ctx = usePane();
  return <div className="sm-app pi-app">{ctx ? <Inspector ctx={ctx} /> : <Loading />}</div>;
}

function Inspector({ ctx }: { ctx: PaneContext }) {
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const init = useMemo(() => initialTarget(ctx), []);
  const [storedPrefs, setPrefs, prefsLoaded] = useStored<Prefs>("prefs", DEFAULT_PREFS);
  const prefs = useMemo(() => normalizePrefs(storedPrefs), [storedPrefs]);
  const [recent, setRecent] = useStored<Recent[]>("recent", []);
  const [, savePane] = usePaneState<Saved>(ctx, { pid: init.pid, name: init.restoredName, argsPid: init.argsPid, tab: init.tab });

  const [pid, setPid] = useState<number | null>(init.pid);
  const [tabChoice, setTabChoice] = useState<TabId | null>(init.tab);
  const [tick, setTick] = useState(0);
  const [pickerAt, setPickerAt] = useState<HTMLElement | null>(null);
  const [settingsAt, setSettingsAt] = useState<HTMLElement | null>(null);
  const [reuseDismissed, setReuseDismissed] = useState(false);
  const pickerBtn = useRef<HTMLButtonElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);

  const visibleTabs = prefs.tabs.filter((t) => t.visible).map((t) => t.id);
  const tab: TabId = tabChoice && visibleTabs.includes(tabChoice) ? tabChoice : visibleTabs.includes(prefs.defaultTab) ? prefs.defaultTab : visibleTabs[0];
  // tabs stay mounted once opened (hidden), so switching back keeps filters, scroll and data
  const visited = useRef(new Set<TabId>());
  visited.current.add(tab);

  const canControl = ctx.grantedPermissions.includes("process.control");
  const refreshAll = useCallback(() => setTick((t) => t + 1), []);

  const overview = useResource<ProcOverview>(pid, loadOverview, { visible: ctx.visible, interval: prefs.interval, tick, active: tab === "overview", eager: true });
  const ov = overview.data;
  const exited = pid !== null && isExited(overview.error);
  const restoredName = pid === init.pid ? init.restoredName : null;
  const knownName = ov?.name ?? restoredName ?? recent.find((r) => r.pid === pid)?.name ?? null;
  const name = knownName ?? `PID ${pid}`;
  /** "explorer.exe (4812)", or "PID 4812" while the name is unknown */
  const label = knownName ? `${knownName} (${pid})` : name;
  const live: Live = useMemo(() => ({ visible: ctx.visible && !exited, interval: prefs.interval, tick }), [ctx.visible, exited, prefs.interval, tick]);

  const inspect = useCallback(
    (next: number) => {
      setPickerAt(null);
      setReuseDismissed(true);
      if (next === pid) refreshAll();
      else setPid(next);
    },
    [pid, refreshAll],
  );
  const openPicker = useCallback(() => setPickerAt(pickerBtn.current), []);
  const closePicker = useCallback(() => setPickerAt(null), []);
  const closeSettings = useCallback(() => setSettingsAt(null), []);

  // pane title, saved state, recent list
  const title = pid === null ? "Process Inspector" : `Inspect: ${label}${exited ? " (exited)" : ""}`;
  useEffect(() => {
    sm.ui.setTitle(title).catch(() => {});
  }, [title]);
  useEffect(() => {
    savePane({ pid, name: ov?.name ?? restoredName, argsPid: init.argsPid, tab: tabChoice });
  }, [pid, ov?.name, restoredName, tabChoice, init.argsPid, savePane]);
  useEffect(() => {
    if (!ov || ov.pid !== pid) return;
    if (recent[0]?.pid === ov.pid && recent[0]?.name === ov.name) return;
    setRecent((r) => [{ pid: ov.pid, name: ov.name }, ...r.filter((x) => x.pid !== ov.pid)].slice(0, 8));
    // only when the process shown changes
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ov?.pid, ov?.name]);

  // F5 / Ctrl+R refresh, Ctrl+F focuses the tab's filter
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const k = e.key.toLowerCase();
      if (e.key === "F5" || (e.ctrlKey && !e.shiftKey && !e.altKey && k === "r")) {
        e.preventDefault();
        refreshAll();
      } else if (e.ctrlKey && !e.shiftKey && !e.altKey && k === "f") {
        const scope = document.querySelector(".sm-popover") ?? bodyRef.current?.querySelector(".pi-tabpane:not([hidden])") ?? bodyRef.current;
        const input = scope?.querySelector<HTMLInputElement>(".sm-search input");
        if (input) {
          e.preventDefault();
          input.focus();
          input.select();
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [refreshAll]);

  const reused = !reuseDismissed && !!ov && !!restoredName && ov.name.toLowerCase() !== restoredName.toLowerCase();

  const tabItems: TabItem[] = visibleTabs.map((id) => ({
    id,
    label: TAB_LABELS[id],
    badge: id === "threads" && ov ? formatNumber(ov.threadCount) : id === "handles" && ov ? formatNumber(ov.handleCount) : undefined,
  }));

  const renderTab = (id: TabId, p: TabProps) => {
    switch (id) {
      case "overview":
        return <OverviewTab {...p} res={overview} />;
      case "modules":
        return <ModulesTab {...p} />;
      case "threads":
        return <ThreadsTab {...p} />;
      case "handles":
        return <HandlesTab {...p} />;
      case "token":
        return <TokenTab {...p} />;
      case "memory":
        return <MemoryTab {...p} />;
    }
  };

  let body;
  if (pid === null) {
    body = <ProcessPicker inline poll={ctx.visible} currentPid={null} recent={recent} onPick={inspect} />;
  } else if (exited) {
    body = (
      <Message
        icon={<CircleX size={28} />}
        title="This process has exited"
        actions={
          <>
            <Button kind="primary" onClick={openPicker}>
              Pick another process
            </Button>
            {ov?.ppid != null && ov.parentName && (
              <Button onClick={() => inspect(ov.ppid!)}>
                Inspect its parent, {ov.parentName}
              </Button>
            )}
          </>
        }
      >
        <p>{label} is no longer running.</p>
      </Message>
    );
  } else if (!prefsLoaded) {
    body = <Loading />;
  } else {
    const common = { ctx, pid, name, live, canControl, onExited: overview.refresh, inspect, afterAction: refreshAll };
    body = (
      <>
        <div className="pi-tabbar">
          <Tabs items={tabItems} active={tab} onChange={(id) => setTabChoice(id as TabId)} />
          <div className="pi-tabbar-end">
            <IconButton title="Tabs and refresh" on={!!settingsAt} onClick={(e) => setSettingsAt(settingsAt ? null : e.currentTarget)}>
              <Settings2 size={15} />
            </IconButton>
          </div>
        </div>
        <div className="pi-body" ref={bodyRef}>
          {ALL_TABS.filter((id) => visited.current.has(id)).map((id) => (
            <div key={id} className="pi-tabpane" hidden={id !== tab} role="tabpanel">
              {renderTab(id, { ...common, active: id === tab })}
            </div>
          ))}
        </div>
      </>
    );
  }

  return (
    <>
      <div className="pi-top">
        <Toolbar className="pi-toolbar">
          <button
            ref={pickerBtn}
            type="button"
            className={cx("pi-picker-btn", pickerAt && "open")}
            title={pid === null ? "Choose a process" : "Inspect another process"}
            onClick={(e) => setPickerAt(pickerAt ? null : e.currentTarget)}
          >
            {pid === null ? (
              <span className="pi-picker-name">Choose a process</span>
            ) : (
              <>
                <span className="pi-picker-name">{name}</span>
                {knownName && <span className="pi-picker-pid">({pid})</span>}
              </>
            )}
            <ChevronDown size={14} className="pi-picker-chevron" />
          </button>
          <span className="sm-grow" />
          {pid !== null && !exited && (
            <>
              <IconButton title="Refresh (F5)" onClick={refreshAll}>
                <RefreshCw size={15} />
              </IconButton>
              {canControl &&
                ov &&
                (ov.suspended ? (
                  <IconButton title="Resume process" on onClick={() => resumeProcess(pid, name, refreshAll)}>
                    <Play size={15} />
                  </IconButton>
                ) : (
                  <IconButton title="Suspend process…" onClick={() => suspendProcess(pid, name, refreshAll)}>
                    <Pause size={15} />
                  </IconButton>
                ))}
              <IconButton title="More actions" onClick={(e) => openMenu(e.currentTarget, processMenu({ pid, name, ov, canControl, refresh: refreshAll, after: refreshAll }))}>
                <Ellipsis size={16} />
              </IconButton>
            </>
          )}
        </Toolbar>
        {pid !== null && !exited && <Header ov={ov} error={ov ? null : overview.error} onInspect={inspect} />}
      </div>
      {reused && ov && (
        <Banner
          tone="info"
          onClose={() => setReuseDismissed(true)}
          actions={
            <Button small onClick={openPicker}>
              Pick another process
            </Button>
          }
        >
          PID {pid} now belongs to {ov.name}; the {restoredName} this pane showed before has exited.
        </Banner>
      )}
      {body}
      <Popover anchor={pickerAt} onClose={closePicker} width={Math.min(420, window.innerWidth - 8)} align="left">
        <ProcessPicker currentPid={pid} recent={recent} onPick={inspect} />
      </Popover>
      <Popover anchor={settingsAt} onClose={closeSettings} width={Math.min(290, window.innerWidth - 8)}>
        <TabSettings prefs={prefs} onChange={setPrefs} />
      </Popover>
    </>
  );
}
