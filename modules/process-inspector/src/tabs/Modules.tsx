// Modules: every loaded DLL with its signature (checked in the background) and the
// ones loaded from user-writable folders called out.
import { useEffect, useMemo, useState } from "react";
import { Copy, FileCheck2, FolderOpen, Hash, TriangleAlert } from "lucide-react";
import {
  compareHex,
  copy,
  errorText,
  formatBytes,
  formatNumber,
  Footer,
  openMenu,
  SearchBox,
  sm,
  Table,
  toBig,
  Toolbar,
  useColumnState,
  useStored,
  type Column,
  type ProcModule,
  type SortState,
} from "../../../shared";
import { reveal } from "../components/actions";
import { Addr, ResourceView } from "../components/common";
import type { TabProps } from "../lib/prefs";
import { useResource } from "../lib/resource";
import { checkSignatureNow, getSignature, requestSignature, SigChip, sigRank, sigText, useSignatureVersion } from "../lib/signatures";
import { isUserWritable } from "../lib/util";

const rowKey = (m: ProcModule) => `${m.base}|${m.path}`;
const loadModules = (pid: number) => sm.process.modules(pid);

export function ModulesTab(p: TabProps) {
  const res = useResource(p.pid, loadModules, { ...p.live, active: p.active, onExited: p.onExited });
  return (
    <ResourceView res={res} ctx={p.ctx} what="modules" name={p.name}>
      {(mods) => <ModulesTable mods={mods} />}
    </ResourceView>
  );
}

function ModulesTable({ mods }: { mods: ProcModule[] }) {
  const [cols, setCols] = useColumnState("modules");
  const [sort, setSort] = useStored<SortState | null>("sort:modules", { id: "base", desc: false });
  const [q, setQ] = useState("");
  const sigv = useSignatureVersion();

  // the main image first, then in address order
  useEffect(() => {
    const ordered = [...mods].sort((a, b) => Number(b.isMain) - Number(a.isMain) || compareHex(a.base, b.base));
    for (const m of ordered) requestSignature(m.path);
  }, [mods]);

  const rows = useMemo(() => {
    const s = q.trim().toLowerCase();
    if (!s) return mods;
    return mods.filter((m) => m.name.toLowerCase().includes(s) || m.path.toLowerCase().includes(s) || m.base.toLowerCase().includes(s) || m.description?.toLowerCase().includes(s) || m.company?.toLowerCase().includes(s));
  }, [mods, q]);

  const stats = useMemo(() => {
    let size = 0;
    let pending = 0;
    let unsigned = 0;
    let invalid = 0;
    let writable = 0;
    for (const m of mods) {
      size += m.size;
      const e = getSignature(m.path);
      if (!e || e.state === "pending") pending++;
      else if (e.state === "done" && e.sig.status === "unsigned") unsigned++;
      else if (e.state === "done" && e.sig.status === "invalid") invalid++;
      if (isUserWritable(m.path)) writable++;
    }
    return { size, pending, unsigned, invalid, writable };
    // sigv: recount as signatures arrive
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mods, sigv]);

  const columns = useMemo<Column<ProcModule>[]>(
    () => [
      {
        id: "name",
        label: "Name",
        width: 190,
        sort: (m) => m.name,
        text: (m) => m.name,
        render: (m) => (
          <>
            {isUserWritable(m.path) && (
              <span className="pi-flag-icon warning" title="Loaded from a folder any user can write to">
                <TriangleAlert size={12} />
              </span>
            )}
            <span className={m.isMain ? "pi-strong sm-cell-text" : "sm-cell-text"}>{m.name}</span>
          </>
        ),
      },
      { id: "base", label: "Base", width: 150, mono: true, sort: (m) => toBig(m.base), text: (m) => m.base, render: (m) => <Addr value={m.base} /> },
      { id: "size", label: "Size", width: 80, align: "right", sort: (m) => m.size, text: (m) => formatBytes(m.size) },
      {
        id: "signature",
        label: "Signature",
        width: 200,
        sort: (m) => sigRank(getSignature(m.path)),
        text: (m) => sigText(getSignature(m.path)),
        render: (m) => <SigChip entry={getSignature(m.path)} />,
      },
      { id: "description", label: "Description", width: 220, sort: (m) => m.description, text: (m) => m.description ?? "" },
      { id: "company", label: "Company", width: 170, sort: (m) => m.company, text: (m) => m.company ?? "" },
      { id: "version", label: "Version", width: 120, hidden: true, sort: (m) => m.version, text: (m) => m.version ?? "" },
      { id: "path", label: "Path", width: 380, sort: (m) => m.path, text: (m) => m.path },
      { id: "end", label: "End address", width: 150, mono: true, hidden: true, sort: (m) => toBig(m.base) + BigInt(m.size), text: (m) => "0x" + (toBig(m.base) + BigInt(m.size)).toString(16).padStart(16, "0") },
    ],
    // getSignature is read at render time; sigv makes the table re-sort when results arrive
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sigv],
  );

  const menu = (at: { clientX: number; clientY: number }, sel: ProcModule[]) => {
    const m = sel[0];
    if (!m) return;
    openMenu(at, [
      { label: "Copy name", icon: <Copy size={14} />, onSelect: () => copy(sel.map((x) => x.name).join("\n"), sel.length > 1 ? "names" : "name") },
      { label: "Copy path", icon: <Copy size={14} />, onSelect: () => copy(sel.map((x) => x.path).join("\n"), sel.length > 1 ? "paths" : "path") },
      { label: "Copy base address", icon: <Hash size={14} />, onSelect: () => copy(sel.map((x) => x.base).join("\n"), "base address") },
      { separator: true },
      { label: "Open file location", icon: <FolderOpen size={14} />, onSelect: () => reveal(m.path) },
      {
        label: sel.length > 1 ? `Check ${sel.length} signatures` : "Check signature",
        icon: <FileCheck2 size={14} />,
        onSelect: () => {
          if (sel.length > 1) {
            sel.forEach((x) => checkSignatureNow(x.path).catch(() => {}));
            return;
          }
          checkSignatureNow(m.path).then(
            (sig) => sm.ui.notify(`${m.name}: ${sigText({ state: "done", sig })}`, sig.status === "valid" ? "success" : sig.status === "invalid" ? "error" : "warning"),
            (e) => sm.ui.notify(`Couldn't check ${m.name}: ${errorText(e)}`, "error"),
          );
        },
      },
    ]);
  };

  return (
    <>
      <Toolbar className="pi-subbar">
        <SearchBox value={q} onChange={setQ} placeholder="Filter modules" width={240} />
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
        onOpen={(m) => reveal(m.path)}
        onContextMenu={menu}
        rowClass={(m) => {
          const e = getSignature(m.path);
          if (e?.state === "done" && e.sig.status === "invalid") return "pi-danger";
          return isUserWritable(m.path) ? "pi-warn" : null;
        }}
        empty={q ? `No module matches “${q}”` : "No modules"}
      />
      <Footer>
        <span>{rows.length === mods.length ? `${formatNumber(mods.length)} modules` : `${formatNumber(rows.length)} of ${formatNumber(mods.length)} modules`}</span>
        <span>·</span>
        <span>{formatBytes(stats.size)}</span>
        {stats.pending > 0 && (
          <>
            <span>·</span>
            <span>
              Checking signatures {mods.length - stats.pending}/{mods.length}
            </span>
          </>
        )}
        {stats.unsigned > 0 && (
          <>
            <span>·</span>
            <span className="sm-warning-text">{stats.unsigned} not signed</span>
          </>
        )}
        {stats.invalid > 0 && (
          <>
            <span>·</span>
            <span className="sm-danger-text">{stats.invalid} invalid</span>
          </>
        )}
        {stats.writable > 0 && (
          <>
            <span>·</span>
            <span className="sm-warning-text" title="Loaded from AppData, Temp, Downloads, Desktop or Public">
              {stats.writable} from user-writable folders
            </span>
          </>
        )}
      </Footer>
    </>
  );
}
