// Memory map: every region with its protection; executable memory that isn't backed
// by an image, and RWX above all, is highlighted (the classic injected-code tells).
import { useMemo, useState } from "react";
import { Copy, FolderOpen, Hash, TriangleAlert } from "lucide-react";
import {
  copy,
  cx,
  Footer,
  formatBytes,
  formatNumber,
  hex,
  openMenu,
  SearchBox,
  Select,
  sm,
  Table,
  toBig,
  Toolbar,
  useColumnState,
  useStored,
  type Column,
  type MemRegion,
  type MenuItem,
  type SortState,
} from "../../../shared";
import { reveal } from "../components/actions";
import { Addr, ResourceView, Toggle } from "../components/common";
import type { TabProps } from "../lib/prefs";
import { useResource } from "../lib/resource";
import { isLocalPath } from "../lib/util";

interface RegionRow extends MemRegion {
  /** read-write-execute */
  rwx: boolean;
  /** executable and not an image */
  unbacked: boolean;
  risk: 0 | 1 | 2;
}

type TypeFilter = "all" | "image" | "mapped" | "private";

const rowKey = (r: RegionRow) => r.base;
const loadMemory = (pid: number) => sm.process.memory(pid);

const STATE_LABEL: Record<string, string> = { commit: "Commit", reserve: "Reserve", free: "Free" };
const TYPE_LABEL: Record<string, string> = { image: "Image", mapped: "Mapped", private: "Private" };

function classify(r: MemRegion): RegionRow {
  const prot = r.protect.split("+")[0];
  const committed = r.state === "commit";
  const exec = committed && prot.includes("X");
  const rwx = committed && (prot === "RWX" || (prot === "WCX" && r.type !== "image"));
  const unbacked = exec && r.type !== "image";
  return { ...r, rwx, unbacked, risk: rwx ? 2 : unbacked ? 1 : 0 };
}

export function MemoryTab(p: TabProps) {
  const res = useResource(p.pid, loadMemory, { ...p.live, active: p.active, onExited: p.onExited });
  return (
    <ResourceView res={res} ctx={p.ctx} what="memory map" name={p.name}>
      {(regions) => <MemoryTable regions={regions} />}
    </ResourceView>
  );
}

function MemoryTable({ regions }: { regions: MemRegion[] }) {
  const [cols, setCols] = useColumnState("memory");
  const [sort, setSort] = useStored<SortState | null>("sort:memory", { id: "base", desc: false });
  const [hideFree, setHideFree] = useStored("memory:hideFree", true);
  const [type, setType] = useState<TypeFilter>("all");
  const [execOnly, setExecOnly] = useState(false);
  const [q, setQ] = useState("");

  const all = useMemo(() => regions.map(classify), [regions]);

  const totals = useMemo(() => {
    const t = { image: 0, mapped: 0, private: 0, rwx: 0, unbacked: 0, free: 0 };
    for (const r of all) {
      if (r.state === "free") t.free++;
      if (r.state === "commit" && r.type) t[r.type] += r.size;
      if (r.rwx) t.rwx++;
      if (r.unbacked) t.unbacked++;
    }
    return t;
  }, [all]);

  const rows = useMemo(() => {
    const s = q.trim().toLowerCase();
    return all.filter(
      (r) =>
        (!hideFree || r.state !== "free") &&
        (type === "all" || r.type === type) &&
        (!execOnly || r.unbacked) &&
        (!s || r.usage?.toLowerCase().includes(s) || r.base.toLowerCase().includes(s) || r.allocationBase.toLowerCase().includes(s) || r.protect.toLowerCase() === s),
    );
  }, [all, hideFree, type, execOnly, q]);

  const columns = useMemo<Column<RegionRow>[]>(
    () => [
      { id: "base", label: "Base", width: 146, mono: true, sort: (r) => toBig(r.base), text: (r) => r.base, render: (r) => <Addr value={r.base} /> },
      { id: "allocationBase", label: "Allocation base", width: 150, mono: true, hidden: true, sort: (r) => toBig(r.allocationBase), text: (r) => r.allocationBase, render: (r) => <Addr value={r.allocationBase} /> },
      { id: "size", label: "Size", width: 78, align: "right", sort: (r) => r.size, text: (r) => formatBytes(r.size) },
      {
        id: "protect",
        label: "Protection",
        width: 96,
        mono: true,
        title: "R read, W write, X execute, WC write-copy, NA no access; +G guard page",
        sort: (r) => r.protect,
        text: (r) => r.protect,
        render: (r) =>
          r.risk ? (
            <span
              className={cx("pi-cell-flag pi-strong", r.risk === 2 ? "sm-danger-text" : "sm-warning-text")}
              title={r.rwx ? "Writable and executable: a classic sign of injected or unpacked code" : "Executable memory not backed by an image file"}
            >
              <TriangleAlert size={12} />
              {r.protect}
            </span>
          ) : (
            r.protect || <span className="sm-dim">—</span>
          ),
      },
      { id: "type", label: "Type", width: 70, sort: (r) => r.type, text: (r) => (r.type ? (TYPE_LABEL[r.type] ?? r.type) : "") },
      { id: "state", label: "State", width: 70, sort: (r) => r.state, text: (r) => STATE_LABEL[r.state] ?? r.state },
      { id: "allocationProtect", label: "Alloc. protection", width: 118, title: "Protection the allocation was created with", mono: true, sort: (r) => r.allocationProtect, text: (r) => r.allocationProtect },
      { id: "usage", label: "Usage", width: 380, sort: (r) => r.usage, text: (r) => r.usage ?? "" },
      { id: "protectRaw", label: "Protection (raw)", width: 110, mono: true, hidden: true, sort: (r) => r.protectRaw, text: (r) => hex(r.protectRaw) },
    ],
    [],
  );

  const menu = (at: { clientX: number; clientY: number }, sel: RegionRow[]) => {
    const r = sel[0];
    if (!r) return;
    const items: MenuItem[] = [
      { label: "Copy base address", icon: <Hash size={14} />, onSelect: () => copy(sel.map((x) => x.base).join("\n"), "base address") },
      { label: "Copy size", icon: <Copy size={14} />, onSelect: () => copy(sel.map((x) => `0x${x.size.toString(16)}`).join("\n"), "size") },
      { label: "Copy usage", icon: <Copy size={14} />, disabled: !sel.some((x) => x.usage), onSelect: () => copy(sel.map((x) => x.usage ?? "").join("\n"), "usage") },
    ];
    if (sel.length === 1 && (r.type === "image" || r.type === "mapped") && isLocalPath(r.usage)) {
      const path = r.usage;
      items.push({ separator: true }, { label: "Open file location", icon: <FolderOpen size={14} />, onSelect: () => reveal(path) });
    }
    openMenu(at, items);
  };

  const shownNote = rows.length === all.length ? `${formatNumber(all.length)} regions` : `${formatNumber(rows.length)} of ${formatNumber(all.length)} regions`;

  return (
    <>
      <Toolbar className="pi-subbar">
        <Select<TypeFilter>
          value={type}
          onChange={setType}
          options={[
            { value: "all", label: "All types" },
            { value: "image", label: "Image" },
            { value: "mapped", label: "Mapped" },
            { value: "private", label: "Private" },
          ]}
          title="Region type"
        />
        <Toggle label="Hide free" value={hideFree} onChange={setHideFree} />
        <Toggle
          label="Executable non-image only"
          value={execOnly}
          onChange={setExecOnly}
          title="Private or mapped memory that can execute without being backed by an image file: where injected code usually lives"
        />
        <span className="sm-grow" />
        <SearchBox value={q} onChange={setQ} placeholder="Filter by usage or address" width={220} />
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
        rowClass={(r) => (r.risk === 2 ? "pi-danger" : r.risk === 1 ? "pi-warn" : r.state === "free" ? "pi-muted" : null)}
        empty={execOnly ? "No executable memory outside images. Nothing injected here, as far as the memory map can tell." : "No regions match the filter"}
      />
      <Footer>
        <span>{shownNote}</span>
        <span>·</span>
        <span title="Committed memory by type">
          Committed: image {formatBytes(totals.image)} · mapped {formatBytes(totals.mapped)} · private {formatBytes(totals.private)}
        </span>
        <span>·</span>
        <span className={totals.rwx ? "sm-danger-text" : undefined}>{totals.rwx === 1 ? "1 RWX region" : `${formatNumber(totals.rwx)} RWX regions`}</span>
        {totals.unbacked > totals.rwx && (
          <>
            <span>·</span>
            <span className="sm-warning-text">{formatNumber(totals.unbacked)} executable non-image</span>
          </>
        )}
      </Footer>
    </>
  );
}
