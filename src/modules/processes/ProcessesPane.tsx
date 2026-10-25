// Running processes: sortable table or parent/child tree, with kill and friends.
import { useMemo, useRef, useState, type ReactNode } from "react";
import { Icon } from "../../lib/icons";
import { errorText, ipc, type ProcInfo } from "../../lib/ipc";
import { clamp, cx, formatBytes, formatDuration } from "../../lib/util";
import { addModule, setPaneMeta } from "../../state/actions";
import { useSettings } from "../../state/settings";
import { ui, type MenuItem } from "../../state/ui";
import { DataTable, ModuleMessage, SearchBox, useInterval, type Column } from "../common";
import type { ModuleDef, ModuleProps } from "../registry";
import { confirmEndProcess, copyText, revealPath, usePaneFilter } from "./procActions";
import "./processes.css";

interface Row extends ProcInfo {
  depth: number;
  /** visible children in tree mode */
  kids: number;
  collapsed: boolean;
  /** subtree totals (self + descendants), tree mode only */
  treeCpu: number;
  treeMem: number;
}

type SortKey = "name" | "pid" | "cpu" | "mem" | "status";
interface Sort {
  key: SortKey;
  desc: boolean;
}

const sortValue: Record<SortKey, (p: ProcInfo) => string | number> = {
  name: (p) => p.name.toLowerCase(),
  pid: (p) => p.pid,
  cpu: (p) => p.cpu,
  mem: (p) => p.mem,
  status: (p) => p.status,
};

function comparator(sort: Sort) {
  const val = sortValue[sort.key];
  return (a: ProcInfo, b: ProcInfo) => {
    const va = val(a);
    const vb = val(b);
    const c = typeof va === "number" && typeof vb === "number" ? va - vb : String(va).localeCompare(String(vb), undefined, { numeric: true });
    return sort.desc ? -c : c;
  };
}

function matcher(q: string): ((p: ProcInfo) => boolean) | null {
  const s = q.trim().toLowerCase();
  if (!s) return null;
  // "pid:1234" matches only that process (used by Ports → "Show in Processes")
  const pid = s.match(/^pid:\s*(\d+)$/);
  if (pid) return (p) => String(p.pid) === pid[1];
  const numeric = /^\d+$/.test(s);
  return (p) =>
    (numeric && String(p.pid).startsWith(s)) || p.name.toLowerCase().includes(s) || (!!p.exe && p.exe.toLowerCase().includes(s));
}

const flatRow = (p: ProcInfo): Row => ({ ...p, depth: 0, kids: 0, collapsed: false, treeCpu: p.cpu, treeMem: p.mem });

/** Order processes as a parent/child tree; siblings sorted by `sort`. */
function buildTree(procs: ProcInfo[], sort: Sort, collapsed: Set<number>, match: ((p: ProcInfo) => boolean) | null): Row[] {
  const byPid = new Map(procs.map((p) => [p.pid, p]));
  const parentOf = (p: ProcInfo) => (p.ppid != null && p.ppid !== p.pid ? byPid.get(p.ppid) : undefined);

  // while filtering, keep matches plus their ancestors so the context stays visible
  let keep: Set<number> | null = null;
  if (match) {
    keep = new Set();
    for (const p of procs) {
      if (!match(p)) continue;
      for (let cur: ProcInfo | undefined = p; cur && !keep.has(cur.pid); cur = parentOf(cur)) keep.add(cur.pid);
    }
  }
  const kept = keep ? procs.filter((p) => keep!.has(p.pid)) : procs;

  const children = new Map<number, ProcInfo[]>();
  const roots: ProcInfo[] = [];
  for (const p of kept) {
    const parent = parentOf(p);
    if (parent && (!keep || keep.has(parent.pid))) {
      const list = children.get(parent.pid);
      if (list) list.push(p);
      else children.set(parent.pid, [p]);
    } else roots.push(p);
  }

  const cmp = comparator(sort);
  const out: Row[] = [];
  const seen = new Set<number>();
  // returns subtree totals; emits rows unless an ancestor is collapsed
  const walk = (p: ProcInfo, depth: number, hidden: boolean): [number, number] => {
    seen.add(p.pid);
    const kids = (children.get(p.pid) ?? []).filter((c) => !seen.has(c.pid)).sort(cmp);
    const isCollapsed = !match && kids.length > 0 && collapsed.has(p.pid);
    const row: Row = { ...p, depth, kids: kids.length, collapsed: isCollapsed, treeCpu: p.cpu, treeMem: p.mem };
    if (!hidden) out.push(row);
    for (const k of kids) {
      if (seen.has(k.pid)) continue;
      const [c, m] = walk(k, depth + 1, hidden || isCollapsed);
      row.treeCpu += c;
      row.treeMem += m;
    }
    return [row.treeCpu, row.treeMem];
  };
  for (const r of roots.sort(cmp)) walk(r, 0, false);
  // PIDs get reused, so parent links can form cycles; show anything unreached at the top level
  for (const p of [...kept].sort(cmp)) if (!seen.has(p.pid)) walk(p, 0, false);
  return out;
}

function CpuCell({ value, title }: { value: number; title?: string }) {
  const v = clamp(value, 0, 100);
  return (
    <span className="processes-cpu" title={title}>
      <span className="processes-cpu-track">
        <span className={cx("processes-cpu-fill", v >= 80 ? "danger" : v >= 50 && "warning")} style={{ width: `${v}%` }} />
      </span>
      <span className="processes-cpu-val">{value.toFixed(1)}</span>
    </span>
  );
}

function ProcessesPane({ pane, tabId, visible }: ModuleProps) {
  const intervalMs = useSettings((s) => s.settings.modules.processes.intervalMs);
  const [procs, setProcs] = useState<ProcInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [paused, setPaused] = useState(false);
  const [filter, setFilter] = usePaneFilter(pane);
  const [selected, setSelected] = useState<number | null>(null);
  const [collapsed, setCollapsed] = useState<Set<number>>(() => new Set());
  const [sort, setSort] = useState<Sort>({ key: "cpu", desc: true });
  const busy = useRef(false);
  const tree = !!pane.meta.tree;

  const load = async () => {
    if (busy.current) return;
    busy.current = true;
    try {
      setProcs(await ipc.procList());
      setError(null);
    } catch (e) {
      setError(errorText(e));
    } finally {
      busy.current = false;
    }
  };
  useInterval(load, intervalMs, visible && !paused);

  const match = useMemo(() => matcher(filter), [filter]);
  const flat = useMemo(() => {
    const list = procs ?? [];
    return (match ? list.filter(match) : list).map(flatRow);
  }, [procs, match]);
  const rows = useMemo(() => (tree ? buildTree(procs ?? [], sort, collapsed, match) : flat), [tree, procs, sort, collapsed, match, flat]);

  const byPid = useMemo(() => new Map((procs ?? []).map((p) => [p.pid, p])), [procs]);

  const end = async (p: ProcInfo, wholeTree = false) => {
    if (await confirmEndProcess(p, wholeTree)) load();
  };

  const toggle = (pid: number) =>
    setCollapsed((s) => {
      const next = new Set(s);
      if (next.has(pid)) next.delete(pid);
      else next.add(pid);
      return next;
    });

  const collapseAll = () => {
    const parents = new Set<number>();
    for (const p of procs ?? []) if (p.ppid != null && p.ppid !== p.pid && byPid.has(p.ppid)) parents.add(p.ppid);
    setCollapsed(parents);
  };

  const rowMenu = (p: Row, e: React.MouseEvent) => {
    const items: MenuItem[] = [
      { label: "End process", icon: "x", danger: true, shortcut: "Del", onSelect: () => end(p) },
      { label: "End process tree", icon: "skull", danger: true, onSelect: () => end(p, true) },
      { type: "separator" },
      { label: "Copy PID", icon: "hash", onSelect: () => copyText(String(p.pid), "PID") },
      { label: "Copy name", icon: "copy", onSelect: () => copyText(p.name, "name") },
      { label: "Copy path", icon: "clipboard-copy", disabled: !p.exe, onSelect: () => p.exe && copyText(p.exe, "path") },
      { type: "separator" },
      { label: "Open file location", icon: "folder-open", disabled: !p.exe, onSelect: () => p.exe && revealPath(p.exe) },
      {
        label: "Show its ports",
        icon: "network",
        onSelect: () => addModule("ports", { tabId, target: pane.id, side: "right", meta: { filter: `pid:${p.pid}` } }),
      },
    ];
    if (tree && p.kids > 0) {
      items.push(
        { type: "separator" },
        { label: p.collapsed ? "Expand" : "Collapse", icon: p.collapsed ? "chevron-right" : "chevron-down", onSelect: () => toggle(p.pid) },
      );
    }
    ui.openMenu(e, items);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key !== "Delete" || selected == null) return;
    if ((e.target as HTMLElement).closest("input, textarea")) return;
    const p = byPid.get(selected);
    if (!p) return;
    e.preventDefault();
    end(p, e.shiftKey);
  };

  const arrow = (key: SortKey) => (tree && sort.key === key ? (sort.desc ? " ▾" : " ▴") : "");
  const columns: Column<Row>[] = [
    {
      key: "name",
      label: `Name${arrow("name")}`,
      value: sortValue.name,
      render: (p) => (
        <span className="processes-name" style={tree ? { paddingLeft: p.depth * 14 } : undefined} title={p.exe ?? p.name}>
          {tree &&
            (p.kids > 0 ? (
              <button
                className="processes-twisty"
                title={p.collapsed ? "Expand" : "Collapse"}
                onClick={(e) => {
                  e.stopPropagation();
                  toggle(p.pid);
                }}
                onDoubleClick={(e) => e.stopPropagation()}
              >
                <Icon name={p.collapsed ? "chevron-right" : "chevron-down"} size={12} />
              </button>
            ) : (
              <span className="processes-twisty-gap" />
            ))}
          <span className="ellipsis">{p.name}</span>
          {tree && p.collapsed && <span className="processes-count">{p.kids}</span>}
        </span>
      ),
    },
    { key: "pid", label: `PID${arrow("pid")}`, num: true, width: 72, value: sortValue.pid, render: (p) => <span className="dim">{p.pid}</span> },
    {
      key: "cpu",
      label: `CPU %${arrow("cpu")}`,
      num: true,
      width: 112,
      value: sortValue.cpu,
      render: (p) =>
        p.collapsed ? <CpuCell value={p.treeCpu} title="Including child processes" /> : <CpuCell value={p.cpu} />,
    },
    {
      key: "mem",
      label: `Memory${arrow("mem")}`,
      num: true,
      width: 92,
      value: sortValue.mem,
      render: (p) => (
        <span title={p.collapsed ? "Including child processes" : undefined}>{formatBytes(p.collapsed ? p.treeMem : p.mem)}</span>
      ),
    },
    {
      key: "status",
      label: `Status${arrow("status")}`,
      width: 96,
      value: sortValue.status,
      render: (p) => (
        <span className="dim" title={`Running for ${formatDuration(p.runTime)}`}>
          {p.status}
        </span>
      ),
    },
  ];

  // In tree mode the table must keep our tree order, so we own sorting there:
  // header clicks are intercepted before DataTable sees them.
  const onHeaderClickCapture = (e: React.MouseEvent) => {
    if (!tree) return;
    const th = (e.target as HTMLElement).closest("th");
    if (!th) return;
    e.stopPropagation();
    const idx = Array.from(th.parentElement?.children ?? []).indexOf(th);
    const col = columns[idx];
    if (!col) return;
    const key = col.key as SortKey;
    setSort((s) => (s.key === key ? { key, desc: !s.desc } : { key, desc: !!col.num }));
  };

  const totalCpu = flat.reduce((a, p) => a + p.cpu, 0);
  const totalMem = flat.reduce((a, p) => a + p.mem, 0);
  const total = procs?.length ?? 0;

  let body: ReactNode;
  if (!procs) {
    body = error ? (
      <ModuleMessage icon="warning" title="Couldn't list processes">
        <p className="dim">{error}</p>
        <div className="row">
          <button className="btn" onClick={load}>
            Retry
          </button>
        </div>
      </ModuleMessage>
    ) : (
      <ModuleMessage icon="loader" title="Listing processes…" />
    );
  } else {
    body = (
      <div className="processes-table" onClickCapture={onHeaderClickCapture}>
        <DataTable
          key={tree ? "tree" : "flat"}
          columns={columns}
          rows={rows}
          rowKey={(p) => p.pid}
          selected={selected}
          onSelect={(p) => setSelected(p.pid)}
          onOpen={(p) => tree && p.kids > 0 && toggle(p.pid)}
          onRowMenu={rowMenu}
          initialSort={tree ? undefined : sort}
          empty={filter ? `No processes match “${filter}”` : "No processes"}
        />
      </div>
    );
  }

  return (
    <div className="module processes" tabIndex={-1} onKeyDown={onKeyDown}>
      <div className="toolbar">
        <SearchBox value={filter} onChange={setFilter} placeholder="Filter by name or PID" />
        <div className="grow" />
        <button
          className={cx("icon-btn", tree && "on")}
          title={tree ? "Flat list" : "Tree view"}
          onClick={() => setPaneMeta(pane.id, { tree: tree ? null : true })}
        >
          <Icon name="list-tree" size={14} />
        </button>
        {tree && (
          <>
            <button className="icon-btn" title="Expand all" onClick={() => setCollapsed(new Set())}>
              <Icon name="expand" size={14} />
            </button>
            <button className="icon-btn" title="Collapse all" onClick={collapseAll}>
              <Icon name="shrink" size={14} />
            </button>
          </>
        )}
        <div className="toolbar-sep" />
        <button className={cx("icon-btn", paused && "on")} title={paused ? "Resume updates" : "Pause updates"} onClick={() => setPaused((p) => !p)}>
          <Icon name={paused ? "play" : "pause"} size={14} />
        </button>
        <button className="icon-btn" title="Refresh now" onClick={load}>
          <Icon name="refresh" size={14} />
        </button>
      </div>
      {body}
      <div className="module-footer">
        <span>{match ? `${flat.length} of ${total} processes` : `${total} processes`}</span>
        <span>·</span>
        <span>CPU {totalCpu.toFixed(1)}%</span>
        <span>·</span>
        <span>Memory {formatBytes(totalMem)}</span>
        <div className="grow" />
        {error && procs && (
          <span className="danger-text ellipsis" title={error}>
            {error}
          </span>
        )}
        {paused && <span className="chip">Paused</span>}
      </div>
    </div>
  );
}

export const processesModule: ModuleDef = {
  id: "processes",
  name: "Processes",
  icon: "list-tree",
  description: "Running processes",
  component: ProcessesPane,
  menu: (pane) => [
    {
      label: "Tree view",
      checked: !!pane.meta.tree,
      onSelect: () => setPaneMeta(pane.id, { tree: pane.meta.tree ? null : true }),
    },
  ],
};
