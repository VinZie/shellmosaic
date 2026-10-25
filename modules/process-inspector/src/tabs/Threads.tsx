// Threads: start addresses (flagging ones outside every module), state, CPU, context
// switches since the last refresh, and suspend / resume / terminate.
import { useMemo, useRef, useState } from "react";
import { Copy, Hash, Pause, Play, TriangleAlert, X } from "lucide-react";
import {
  copy,
  errorText,
  Footer,
  formatDateTime,
  formatDuration,
  formatNumber,
  openMenu,
  pluralize,
  SearchBox,
  sm,
  Table,
  toBig,
  Toolbar,
  useColumnState,
  useStored,
  type Column,
  type MenuItem,
  type ProcThread,
  type SortState,
} from "../../../shared";
import { Addr, ResourceView } from "../components/common";
import type { TabProps } from "../lib/prefs";
import { useResource } from "../lib/resource";

interface ThreadRow extends ProcThread {
  cpu: number;
  /** context switches since the previous refresh (null on the first) */
  delta: number | null;
  /** the Win32 start address isn't inside any loaded module */
  foreign: boolean;
}

const rowKey = (t: ThreadRow) => t.tid;
const loadThreads = (pid: number) => sm.process.threads(pid);


/** Kernel start addresses read as 0 without admin rights. */
const unknownStart = (a: string) => /^0x0*$/i.test(a);

export function ThreadsTab(p: TabProps) {
  const res = useResource(p.pid, loadThreads, { ...p.live, active: p.active, onExited: p.onExited });
  return (
    <ResourceView res={res} ctx={p.ctx} what="threads" name={p.name}>
      {(threads) => <ThreadsTable threads={threads} {...p} />}
    </ResourceView>
  );
}

type Kind = "suspend" | "resume" | "terminate";
const VERB: Record<Kind, [string, string]> = { suspend: ["suspend", "Suspended"], resume: ["resume", "Resumed"], terminate: ["terminate", "Terminated"] };

function ThreadsTable({ threads, pid, name, canControl, afterAction }: TabProps & { threads: ProcThread[] }) {
  const [cols, setCols] = useColumnState("threads");
  const [sort, setSort] = useStored<SortState | null>("sort:threads", { id: "tid", desc: false });
  const [q, setQ] = useState("");

  // context switches of the previous snapshot, to show the change
  const snaps = useRef<{ cur: ProcThread[] | null; prev: Map<number, number> | null }>({ cur: null, prev: null });
  if (snaps.current.cur !== threads) {
    const old = snaps.current.cur;
    snaps.current = { cur: threads, prev: old ? new Map(old.map((t) => [t.tid, t.contextSwitches])) : null };
  }
  const prev = snaps.current.prev;

  const all = useMemo<ThreadRow[]>(
    () =>
      threads.map((t) => {
        const before = prev?.get(t.tid);
        return { ...t, cpu: t.kernelMs + t.userMs, delta: before === undefined ? null : Math.max(0, t.contextSwitches - before), foreign: !!t.win32StartAddress && !t.win32StartSymbol };
      }),
    [threads, prev],
  );

  const rows = useMemo(() => {
    const s = q.trim().toLowerCase();
    if (!s) return all;
    return all.filter(
      (t) =>
        String(t.tid).includes(s) ||
        t.startSymbol?.toLowerCase().includes(s) ||
        t.startAddress.toLowerCase().includes(s) ||
        t.win32StartSymbol?.toLowerCase().includes(s) ||
        t.win32StartAddress?.toLowerCase().includes(s) ||
        t.description?.toLowerCase().includes(s) ||
        t.state.toLowerCase().includes(s) ||
        t.waitReason?.toLowerCase().includes(s),
    );
  }, [all, q]);

  const stats = useMemo(() => ({ suspended: all.filter((t) => t.suspended).length, foreign: all.filter((t) => t.foreign).length }), [all]);

  const columns = useMemo<Column<ThreadRow>[]>(
    () => [
      { id: "tid", label: "TID", width: 70, align: "right", sort: (t) => t.tid, text: (t) => String(t.tid) },
      {
        id: "start",
        label: "Start",
        width: 160,
        mono: true,
        title: "Kernel start address (usually RtlUserThreadStart). Windows reports it to administrators only.",
        sort: (t) => t.startSymbol ?? t.startAddress,
        text: (t) => t.startSymbol ?? (unknownStart(t.startAddress) ? "" : t.startAddress),
        render: (t) =>
          t.startSymbol ? (
            <span className="sm-cell-text">{t.startSymbol}</span>
          ) : unknownStart(t.startAddress) ? (
            // without admin rights Windows reports 0 for every thread
            <span className="sm-dim" title="Windows reports this to administrators only">
              —
            </span>
          ) : (
            <Addr value={t.startAddress} />
          ),
      },
      {
        id: "win32",
        label: "Win32 start",
        width: 230,
        mono: true,
        title: "The start address passed to CreateThread",
        sort: (t) => t.win32StartSymbol ?? t.win32StartAddress,
        text: (t) => t.win32StartSymbol ?? t.win32StartAddress ?? "",
        render: (t) =>
          t.foreign ? (
            <span className="pi-cell-flag sm-danger-text" title="Not inside any loaded module: typical of injected or manually mapped code">
              <TriangleAlert size={12} />
              <Addr value={t.win32StartAddress} />
            </span>
          ) : t.win32StartSymbol ? (
            <span className="sm-cell-text">{t.win32StartSymbol}</span>
          ) : t.win32StartAddress ? (
            <Addr value={t.win32StartAddress} />
          ) : (
            <span className="sm-dim">—</span>
          ),
      },
      {
        id: "state",
        label: "State",
        width: 100,
        sort: (t) => (t.suspended ? "Suspended" : t.state),
        text: (t) => (t.suspended ? "Suspended" : t.state),
        render: (t) =>
          t.suspended ? (
            <span className="pi-cell-flag sm-warning-text">
              <Pause size={11} />
              Suspended
            </span>
          ) : (
            t.state
          ),
      },
      { id: "wait", label: "Wait reason", width: 120, sort: (t) => t.waitReason, text: (t) => t.waitReason ?? "" },
      { id: "priority", label: "Priority", width: 70, align: "right", sort: (t) => t.priority, text: (t) => String(t.priority) },
      { id: "basePriority", label: "Base priority", width: 90, align: "right", hidden: true, sort: (t) => t.basePriority, text: (t) => String(t.basePriority) },
      { id: "cpu", label: "CPU time", width: 90, align: "right", sort: (t) => t.cpu, text: (t) => formatDuration(t.cpu) },
      { id: "kernel", label: "Kernel time", width: 90, align: "right", hidden: true, sort: (t) => t.kernelMs, text: (t) => formatDuration(t.kernelMs) },
      { id: "user", label: "User time", width: 90, align: "right", hidden: true, sort: (t) => t.userMs, text: (t) => formatDuration(t.userMs) },
      {
        id: "delta",
        label: "Switches Δ",
        width: 86,
        align: "right",
        title: "Context switches since the previous refresh",
        sort: (t) => t.delta,
        text: (t) => (t.delta === null ? "" : formatNumber(t.delta)),
        render: (t) => (t.delta ? formatNumber(t.delta) : <span className="sm-dim">{t.delta === null ? "" : "0"}</span>),
      },
      { id: "switches", label: "Context switches", width: 120, align: "right", hidden: true, sort: (t) => t.contextSwitches, text: (t) => formatNumber(t.contextSwitches) },
      { id: "created", label: "Created", width: 150, hidden: true, sort: (t) => t.createTime, text: (t) => formatDateTime(t.createTime) },
      { id: "description", label: "Description", width: 200, sort: (t) => t.description, text: (t) => t.description ?? "" },
      { id: "suspendCount", label: "Suspend count", width: 100, align: "right", hidden: true, sort: (t) => t.suspendCount, text: (t) => (t.suspendCount === null ? "" : String(t.suspendCount)) },
      { id: "startAddr", label: "Start address", width: 150, mono: true, hidden: true, sort: (t) => toBig(t.startAddress), text: (t) => t.startAddress, render: (t) => <Addr value={t.startAddress} /> },
    ],
    [],
  );

  const run = async (kind: Kind, sel: ThreadRow[]) => {
    const [verb, done] = VERB[kind];
    const what = sel.length === 1 ? `thread ${sel[0].tid}` : `${sel.length} threads`;
    if (kind === "terminate") {
      const ok = await sm.ui.confirm(
        `Terminate ${what}?`,
        `Ending a thread of ${name} from outside skips its cleanup: locks it holds stay held, and the process can hang, corrupt its data or crash.`,
        { okLabel: "Terminate", danger: true },
      );
      if (!ok) return;
    }
    let failed = 0;
    let firstError = "";
    for (const t of sel) {
      try {
        const r = await sm.thread[kind](pid, t.tid);
        if (r === false) throw new Error("Windows refused");
      } catch (e) {
        failed++;
        firstError ||= errorText(e);
      }
    }
    if (!failed) sm.ui.notify(`${done} ${what}`, "success");
    else sm.ui.notify(`Couldn't ${verb} ${failed === sel.length ? what : `${failed} of ${sel.length} threads`}: ${firstError}`, "error");
    afterAction();
  };

  const menu = (at: { clientX: number; clientY: number }, sel: ThreadRow[]) => {
    const t = sel[0];
    if (!t) return;
    const n = sel.length > 1 ? ` ${sel.length} threads` : "";
    const items: MenuItem[] = [];
    if (canControl) {
      items.push(
        { label: `Suspend${n}`, icon: <Pause size={14} />, onSelect: () => run("suspend", sel) },
        { label: `Resume${n}`, icon: <Play size={14} />, disabled: !sel.some((x) => x.suspended || (x.suspendCount ?? 0) > 0), onSelect: () => run("resume", sel) },
        { label: `Terminate${n}…`, icon: <X size={14} />, danger: true, onSelect: () => run("terminate", sel) },
        { separator: true },
      );
    }
    const start = (x: ThreadRow) => x.win32StartAddress ?? x.startAddress;
    items.push(
      { label: sel.length > 1 ? "Copy TIDs" : "Copy TID", icon: <Hash size={14} />, onSelect: () => copy(sel.map((x) => x.tid).join("\n"), sel.length > 1 ? "TIDs" : "TID") },
      { label: "Copy start address", icon: <Copy size={14} />, onSelect: () => copy(sel.map(start).join("\n"), "start address") },
    );
    if (sel.some((x) => x.win32StartSymbol || x.startSymbol))
      items.push({ label: "Copy start symbol", icon: <Copy size={14} />, onSelect: () => copy(sel.map((x) => x.win32StartSymbol ?? x.startSymbol ?? start(x)).join("\n"), "start symbol") });
    openMenu(at, items);
  };

  return (
    <>
      <Toolbar className="pi-subbar">
        <SearchBox value={q} onChange={setQ} placeholder="Filter by TID, start, state…" width={240} />
      </Toolbar>
      <Table
        columns={columns}
        rows={rows}
        rowKey={rowKey}
        columnState={cols}
        onColumnState={setCols}
        sort={sort}
        onSort={setSort}
        multi
        onContextMenu={menu}
        rowClass={(t) => (t.foreign ? "pi-danger" : t.suspended ? "pi-suspended" : null)}
        empty={q ? `No thread matches “${q}”` : "No threads"}
      />
      <Footer>
        <span>{rows.length === all.length ? pluralize(all.length, "thread") : `${formatNumber(rows.length)} of ${pluralize(all.length, "thread")}`}</span>
        {stats.suspended > 0 && (
          <>
            <span>·</span>
            <span className="sm-warning-text">{stats.suspended} suspended</span>
          </>
        )}
        {stats.foreign > 0 && (
          <>
            <span>·</span>
            <span className="sm-danger-text" title="Their Win32 start address isn't inside any loaded module">
              {pluralize(stats.foreign, "thread")} starting outside any module
            </span>
          </>
        )}
      </Footer>
    </>
  );
}
