import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Code, Copy, Database, Ellipsis, FolderOpen, Info, ListTree, LoaderCircle, Lock, LockOpen, PanelLeftClose, PanelLeftOpen, RefreshCw, Rows3, X } from "lucide-react";
import { Chip, IconButton, Sep, Split, Switch, Tabs, cx, errorText, formatBytes, openMenu, sm, useStored, type DbInfo, type SchemaObject } from "../../shared";
import { DataTab } from "./DataTab";
import { InfoTab } from "./InfoTab";
import { Sidebar } from "./Sidebar";
import { SqlTab } from "./SqlTab";
import { StructureTab } from "./StructureTab";
import { isSystem } from "./sql";
import { DbContext, dirOf, type CountState, type DbApi, type PaneState, type SqlRequest, type TabId } from "./state";

export function DbView({
  db,
  schema,
  onDb,
  onSchema,
  pane,
  setPane,
  narrow,
  width,
  busy,
  onClose,
  onOpenMenu,
}: {
  db: DbInfo;
  schema: SchemaObject[];
  onDb: (db: DbInfo) => void;
  onSchema: (s: SchemaObject[]) => void;
  pane: PaneState;
  setPane: (p: Partial<PaneState>) => void;
  narrow: boolean;
  width: number;
  /** another database is being opened */
  busy: string | null;
  onClose: () => void;
  onOpenMenu: (anchor: HTMLElement) => void;
}) {
  const [sideW, setSideW] = useStored<number>("sidebarWidth", 250);
  const [sideHidden, setSideHidden] = useStored<boolean>("sidebarHidden", false);
  const [version, setVersion] = useState(0);
  const [sqlRequest, setSqlRequest] = useState<SqlRequest | null>(null);
  const [toggling, setToggling] = useState(false);

  // ── row counts: one at a time, so they never crowd out the user's own queries ──
  const [counts, setCounts] = useState<Record<string, CountState>>({});
  const countsRef = useRef(counts);
  const queue = useRef<string[]>([]);
  const pumping = useRef(false);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const putCount = (name: string, c: CountState | undefined) => {
    const next = { ...countsRef.current };
    if (c) next[name] = c;
    else delete next[name];
    countsRef.current = next;
    setCounts(next);
  };
  const pump = useCallback(async () => {
    if (pumping.current) return;
    pumping.current = true;
    try {
      while (queue.current.length && alive.current) {
        const name = queue.current.shift()!;
        let c: CountState;
        try {
          c = { n: await sm.sqlite.count(db.id, name) };
        } catch (e) {
          c = { error: errorText(e) };
        }
        if (alive.current) putCount(name, c);
      }
    } finally {
      pumping.current = false;
    }
  }, [db.id]);
  const wantCount = useCallback(
    (name: string, force = false) => {
      const cur = countsRef.current[name];
      if (cur && ("loading" in cur || !force)) return;
      putCount(name, { loading: true });
      queue.current.push(name);
      pump();
    },
    [pump],
  );
  const forgetCounts = useCallback((names?: string[]) => {
    if (!names) {
      countsRef.current = {};
      queue.current = [];
      setCounts({});
      return;
    }
    for (const n of names) if (countsRef.current[n] && !("loading" in countsRef.current[n])) putCount(n, undefined);
  }, []);

  const byName = useMemo(() => new Map(schema.map((o) => [o.name.toLowerCase(), o])), [schema]);
  const selected = useMemo(() => {
    const want = pane.table ? byName.get(pane.table.toLowerCase()) : undefined;
    if (want) return want;
    // the first table in the sidebar
    const browsable = schema.filter((o) => o.type === "table" || o.type === "view").sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }));
    return browsable.find((o) => o.type === "table" && !isSystem(o.name)) ?? browsable[0] ?? null;
  }, [pane.table, byName, schema]);

  const tab = pane.tab;
  const [visited, setVisited] = useState<Set<TabId>>(() => new Set([tab]));
  const setTab = useCallback(
    (t: TabId) => {
      setVisited((v) => (v.has(t) ? v : new Set([...v, t])));
      setPane({ tab: t });
    },
    [setPane],
  );
  useEffect(() => setVisited((v) => (v.has(tab) ? v : new Set([...v, tab]))), [tab]);

  const select = useCallback(
    (name: string, t?: TabId) => {
      setPane({ table: name });
      if (t) setTab(t);
      else if (tab !== "data" && tab !== "structure") setTab("data");
    },
    [setPane, setTab, tab],
  );

  const reloadSchema = useCallback(async () => {
    try {
      onSchema(await sm.sqlite.schema(db.id));
      forgetCounts();
      setVersion((v) => v + 1);
    } catch (e) {
      sm.ui.notify(`Couldn't read the schema: ${errorText(e)}`, "error");
    }
  }, [db.id, onSchema, forgetCounts]);

  const setWritable = useCallback(
    async (on: boolean) => {
      if (on) {
        const where = db.copied
          ? `This is a temporary copy${db.copyReason ? ` (${db.copyReason.replace(/\.$/, "")})` : ""}: changes go to the copy only and are gone when you close it. The original file stays untouched.`
          : `Edits, new rows, deletions and SQL statements will change ${db.file} on disk right away. There is no undo — keep a backup if the data matters, and close programs that use this file first.`;
        const ok = await sm.ui.confirm(`Allow changes to ${db.file}?`, `The database is reopened read-write. ${where}`, { okLabel: "Allow changes", danger: true });
        if (!ok) return false;
      }
      setToggling(true);
      try {
        onDb(await sm.sqlite.setWritable(db.id, on));
        sm.ui.notify(on ? `Changes to ${db.file} are allowed` : `${db.file} is read-only again`, on ? "warning" : "info");
        return true;
      } catch (e) {
        sm.ui.notify(`Couldn't ${on ? "allow changes" : "go back to read-only"}: ${errorText(e)}`, "error");
        return false;
      } finally {
        setToggling(false);
      }
    },
    [db, onDb],
  );

  const saveSql = useCallback((sql: string) => setPane({ sql: sql.length < 40_000 ? sql : "" }), [setPane]);

  const sendToSql = useCallback(
    (text: string, run = false) => {
      setTab("sql");
      setSqlRequest((r) => ({ text, run, n: (r?.n ?? 0) + 1 }));
    },
    [setTab],
  );

  const api: DbApi = useMemo(
    () => ({
      db,
      schema,
      byName,
      counts,
      wantCount,
      forgetCounts,
      version,
      bump: () => setVersion((v) => v + 1),
      reloadSchema,
      setWritable,
      narrow,
      selected,
      select,
      tab,
      sendToSql,
    }),
    [db, schema, byName, counts, wantCount, forgetCounts, version, reloadSchema, setWritable, narrow, selected, select, tab, sendToSql],
  );

  // F5 refreshes (the SQL tab runs its query instead); Ctrl+R too
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "F5" || (e.ctrlKey && !e.shiftKey && e.key.toLowerCase() === "r")) {
        if (tab === "sql" && e.key === "F5") return; // the SQL tab's own handler runs the query
        e.preventDefault();
        if (tab === "data") setVersion((v) => v + 1);
        else reloadSchema();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [tab, reloadSchema]);

  const sideCollapsed = narrow || sideHidden;
  const tiny = width < 470;


  const tabs = [
    { id: "data", label: "Data", icon: <Rows3 size={14} /> },
    { id: "structure", label: "Structure", icon: <ListTree size={14} /> },
    { id: "sql", label: "SQL", icon: <Code size={14} /> },
    { id: "info", label: "Info", icon: <Info size={14} /> },
  ];

  return (
    <DbContext.Provider value={api}>
      <div className={cx("sqlb-header", db.writable && "writable")}>
        {!narrow && (
          <IconButton title={sideHidden ? "Show the schema" : "Hide the schema"} onClick={() => setSideHidden(!sideHidden)}>
            {sideHidden ? <PanelLeftOpen size={15} /> : <PanelLeftClose size={15} />}
          </IconButton>
        )}
        <span className={cx("sqlb-header-icon", db.writable && "writable")}>
          <Database size={15} />
        </span>
        <div className="sqlb-title" title={db.path}>
          <span className="sqlb-file">{db.file}</span>
          {!narrow && <span className="sqlb-dir">{dirOf(db.path)}</span>}
        </div>
        {db.writable ? (
          <Chip tone="warning" icon={<LockOpen size={11} />} title="Changes are written to the file">
            {tiny ? "Writable" : "Changes allowed"}
          </Chip>
        ) : (
          <Chip icon={<Lock size={11} />} title="Opened read-only: nothing can change the file">
            Read-only
          </Chip>
        )}
        {db.copied && (
          <Chip tone="accent" icon={<Copy size={11} />} title={db.copyReason ?? "Opened from a temporary copy; the original file is untouched"}>
            Copy
          </Chip>
        )}
        {!tiny && <Chip tone="dim">{formatBytes(db.size)}</Chip>}
        {busy && <LoaderCircle size={14} className="sm-spin sqlb-dim" />}
        <div className="sm-grow" />
        <label className="sqlb-allow" title={db.writable ? "Go back to read-only" : "Reopen the database read-write so it can be edited (asks first)"}>
          {!tiny && <span>Allow changes</span>}
          <Switch value={db.writable} disabled={toggling} onChange={(v) => setWritable(v)} />
        </label>
        <Sep />
        {narrow ? (
          <IconButton
            title="More"
            onClick={(e) => {
              const anchor = e.currentTarget;
              openMenu(anchor, [
                { label: "Reload schema", icon: <RefreshCw size={14} />, onSelect: reloadSchema },
                { label: "Open another database…", icon: <FolderOpen size={14} />, onSelect: () => onOpenMenu(anchor) },
                { separator: true },
                { label: "Close database", icon: <X size={14} />, onSelect: onClose },
              ]);
            }}
          >
            <Ellipsis size={16} />
          </IconButton>
        ) : (
          <>
            <IconButton title="Reload schema" onClick={reloadSchema}>
              <RefreshCw size={14} />
            </IconButton>
            <IconButton title="Open another database" onClick={(e) => onOpenMenu(e.currentTarget)}>
              <FolderOpen size={15} />
            </IconButton>
            <IconButton title="Close database" onClick={onClose}>
              <X size={15} />
            </IconButton>
          </>
        )}
      </div>
      <Split
        size={Math.min(sideW, Math.max(180, width * 0.45))}
        onSize={setSideW}
        min={170}
        collapsed={sideCollapsed}
        first={<Sidebar />}
        second={
          <div className="sqlb-main">
            <Tabs items={tabs} active={tab} onChange={(t) => setTab(t as TabId)} />
            <div className="sqlb-panels">
              {visited.has("data") && (
                <div className={cx("sqlb-panel", tab !== "data" && "off")}>
                  <DataTab />
                </div>
              )}
              {visited.has("structure") && (
                <div className={cx("sqlb-panel", tab !== "structure" && "off")}>
                  <StructureTab />
                </div>
              )}
              {visited.has("sql") && (
                <div className={cx("sqlb-panel", tab !== "sql" && "off")}>
                  <SqlTab initial={pane.sql} onText={saveSql} request={sqlRequest} />
                </div>
              )}
              {visited.has("info") && (
                <div className={cx("sqlb-panel", tab !== "info" && "off")}>
                  <InfoTab />
                </div>
              )}
            </div>
          </div>
        }
      />
    </DbContext.Provider>
  );
}
