// Handles: type filter with counts, decoded access masks, and the handles that reach
// into other processes' memory highlighted (what anti-cheat people hunt for).
import { useMemo, useState } from "react";
import { Copy, Crosshair, ExternalLink, FolderOpen, Hash, KeyRound, TriangleAlert } from "lucide-react";
import {
  copy,
  cx,
  Footer,
  formatNumber,
  hex,
  natural,
  openMenu,
  pluralize,
  SearchBox,
  Select,
  sm,
  Table,
  toBig,
  Toolbar,
  useColumnState,
  useStored,
  type Column,
  type MenuItem,
  type ProcHandle,
  type SortState,
} from "../../../shared";
import { openModule, reveal } from "../components/actions";
import { ResourceView, Toggle } from "../components/common";
import { accessNames, accessTooltip, attributeNames, handleRisk, riskText } from "../lib/access";
import type { TabProps } from "../lib/prefs";
import { useResource } from "../lib/resource";
import { isLocalPath } from "../lib/util";

interface HandleRow extends ProcHandle {
  risk: 0 | 1 | 2;
}

const rowKey = (h: HandleRow) => h.handle;
const loadHandles = (pid: number) => sm.process.handles(pid);

export function HandlesTab(p: TabProps) {
  const res = useResource(p.pid, loadHandles, { ...p.live, active: p.active, onExited: p.onExited });
  return (
    <ResourceView res={res} ctx={p.ctx} what="handles" name={p.name}>
      {(handles) => <HandlesTable handles={handles} pid={p.pid} inspect={p.inspect} />}
    </ResourceView>
  );
}

function HandlesTable({ handles, pid, inspect }: { handles: ProcHandle[]; pid: number; inspect: (pid: number) => void }) {
  const [cols, setCols] = useColumnState("handles");
  const [sort, setSort] = useStored<SortState | null>("sort:handles", { id: "type", desc: false });
  const [hideUnnamed, setHideUnnamed] = useStored("handles:hideUnnamed", true);
  const [type, setType] = useState("");
  const [onlyRisky, setOnlyRisky] = useState(false);
  const [q, setQ] = useState("");

  const all = useMemo<HandleRow[]>(() => handles.map((h) => ({ ...h, risk: handleRisk(h, pid) })), [handles, pid]);
  const named = useMemo(() => (hideUnnamed ? all.filter((h) => h.name) : all), [all, hideUnnamed]);
  const risky = useMemo(() => all.filter((h) => h.risk > 0), [all]);
  const counts = useMemo(() => {
    const m = new Map<string, number>();
    for (const h of named) m.set(h.type, (m.get(h.type) ?? 0) + 1);
    return [...m].sort((a, b) => b[1] - a[1] || natural(a[0], b[0]));
  }, [named]);

  const rows = useMemo(() => {
    const s = q.trim().toLowerCase();
    let list = onlyRisky ? risky : named;
    if (type) list = list.filter((h) => h.type === type);
    if (s) list = list.filter((h) => h.name?.toLowerCase().includes(s) || h.handle.toLowerCase().includes(s) || h.type.toLowerCase().includes(s));
    return list;
  }, [named, risky, onlyRisky, type, q]);

  const typeOptions = useMemo(() => {
    const opts = [{ value: "", label: `All types (${formatNumber(named.length)})` }, ...counts.map(([t, n]) => ({ value: t, label: `${t} (${formatNumber(n)})` }))];
    if (type && !counts.some(([t]) => t === type)) opts.push({ value: type, label: `${type} (0)` });
    return opts;
  }, [counts, named.length, type]);

  const columns = useMemo<Column<HandleRow>[]>(
    () => [
      { id: "type", label: "Type", width: 100, sort: (h) => h.type, text: (h) => h.type },
      {
        id: "name",
        label: "Name",
        width: 380,
        sort: (h) => h.name,
        text: (h) => h.name ?? "",
        render: (h) =>
          h.risk ? (
            <span className={cx("pi-cell-flag", h.risk === 2 ? "sm-danger-text" : "sm-warning-text")} title={riskText(h, h.risk)}>
              <TriangleAlert size={12} />
              <span className="sm-cell-text">{h.name}</span>
            </span>
          ) : h.name ? (
            <span className="sm-cell-text">{h.name}</span>
          ) : (
            <span className="sm-dim">unnamed</span>
          ),
      },
      { id: "handle", label: "Handle", width: 84, mono: true, sort: (h) => toBig(h.handle), text: (h) => h.handle },
      {
        id: "access",
        label: "Access",
        width: 96,
        mono: true,
        title: "Granted access mask; hover a value to decode it",
        sort: (h) => h.access,
        text: (h) => hex(h.access),
        render: (h) => (
          <span className="pi-fill" title={accessTooltip(h.type, h.access)}>
            {hex(h.access)}
          </span>
        ),
      },
      { id: "granted", label: "Granted access", width: 280, hidden: true, sort: (h) => accessNames(h.type, h.access), text: (h) => accessNames(h.type, h.access) },
      { id: "attributes", label: "Attributes", width: 130, sort: (h) => h.attributes, text: (h) => attributeNames(h.attributes) },
      { id: "targetPid", label: "Target PID", width: 86, align: "right", hidden: true, sort: (h) => h.targetPid, text: (h) => (h.targetPid === null ? "" : String(h.targetPid)) },
      { id: "handleCount", label: "Handles", width: 74, align: "right", hidden: true, title: "Open handles to the object", sort: (h) => h.handleCount, text: (h) => formatNumber(h.handleCount) },
      { id: "pointerCount", label: "Pointers", width: 74, align: "right", hidden: true, title: "References to the object", sort: (h) => h.pointerCount, text: (h) => formatNumber(h.pointerCount) },
    ],
    [],
  );

  const menu = (at: { clientX: number; clientY: number }, sel: HandleRow[]) => {
    const h = sel[0];
    if (!h) return;
    const items: MenuItem[] = [
      { label: "Copy name", icon: <Copy size={14} />, disabled: !sel.some((x) => x.name), onSelect: () => copy(sel.map((x) => x.name ?? "").join("\n"), "name") },
      { label: "Copy handle", icon: <Hash size={14} />, onSelect: () => copy(sel.map((x) => x.handle).join("\n"), "handle") },
      { label: "Copy access", icon: <KeyRound size={14} />, onSelect: () => copy(sel.map((x) => `${hex(x.access)} ${accessNames(x.type, x.access)}`).join("\n"), "access") },
    ];
    if (sel.length === 1 && (h.type === "Process" || h.type === "Thread") && h.targetPid !== null && h.targetPid !== pid) {
      const target = h.targetPid;
      items.push(
        { separator: true },
        { label: "Inspect target process", icon: <Crosshair size={14} />, onSelect: () => inspect(target) },
        { label: "Open in a new inspector", icon: <ExternalLink size={14} />, onSelect: () => openModule({ module: "plugin:process-inspector", args: { pid: target } }) },
      );
    }
    if (sel.length === 1 && h.type === "File" && isLocalPath(h.name)) {
      const path = h.name;
      items.push({ separator: true }, { label: "Open file location", icon: <FolderOpen size={14} />, onSelect: () => reveal(path) });
    }
    openMenu(at, items);
  };

  return (
    <>
      <Toolbar className="pi-subbar">
        <Select value={type} onChange={setType} options={typeOptions} title="Show one type of handle" />
        <Toggle label="Hide unnamed" value={hideUnnamed} onChange={setHideUnnamed} />
        {risky.length > 0 && (
          <button
            type="button"
            className={cx("pi-alert-btn", onlyRisky && "on", risky.some((h) => h.risk === 2) ? "danger" : "warning")}
            title="Process and thread handles that can read or write another process's memory or hijack its threads"
            onClick={() => setOnlyRisky((v) => !v)}
          >
            <TriangleAlert size={12} />
            {risky.length} cross-process
          </button>
        )}
        <span className="sm-grow" />
        <SearchBox value={q} onChange={setQ} placeholder="Filter handles" width={220} />
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
        rowClass={(h) => (h.risk === 2 ? "pi-danger" : h.risk === 1 ? "pi-warn" : null)}
        empty={onlyRisky ? "No cross-process handles match" : q || type ? "No handles match the filter" : "No handles"}
      />
      <Footer>
        <span>{rows.length === all.length ? pluralize(all.length, "handle") : `${formatNumber(rows.length)} of ${pluralize(all.length, "handle")}`}</span>
        {hideUnnamed && all.length > named.length && (
          <>
            <span>·</span>
            <span>{formatNumber(all.length - named.length)} unnamed hidden</span>
          </>
        )}
        {risky.length > 0 && (
          <>
            <span>·</span>
            <span className={risky.some((h) => h.risk === 2) ? "sm-danger-text" : "sm-warning-text"}>
              {pluralize(risky.length, "handle")} into other processes
            </span>
          </>
        )}
      </Footer>
    </>
  );
}
