// The schema tree: tables (with lazily counted rows), views, indexes and triggers.
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ChevronDown, ChevronRight, Code, Copy, Eye, Hash, KeyRound, ListTree, Rows3, Sheet, Table2, Zap, type LucideIcon } from "lucide-react";
import { SearchBox, copy, cx, openMenu, useStored, type DbColumn, type MenuItem, type SchemaObject } from "../../shared";
import { isSystem, qi } from "./sql";
import { countShort, countText, useDb } from "./state";

type Group = SchemaObject["type"];
const GROUPS: { type: Group; label: string; icon: LucideIcon }[] = [
  { type: "table", label: "Tables", icon: Table2 },
  { type: "view", label: "Views", icon: Eye },
  { type: "index", label: "Indexes", icon: ListTree },
  { type: "trigger", label: "Triggers", icon: Zap },
];
const ICON: Record<Group, LucideIcon> = { table: Table2, view: Eye, index: ListTree, trigger: Zap };

type Entry =
  | { kind: "group"; key: string; type: Group; label: string; count: number; open: boolean }
  | { kind: "obj"; key: string; obj: SchemaObject; open: boolean; expandable: boolean }
  | { kind: "col"; key: string; obj: SchemaObject; col: DbColumn; hit: boolean };

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

export function Sidebar() {
  const { schema, selected, select, counts, wantCount, sendToSql } = useDb();
  const [filter, setFilter] = useState("");
  const [closedGroups, setClosedGroups] = useStored<Group[]>("closedGroups", ["index", "trigger"]);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [cursor, setCursor] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const q = filter.trim().toLowerCase();
  const entries = useMemo(() => {
    const out: Entry[] = [];
    for (const g of GROUPS) {
      const all = schema.filter((o) => o.type === g.type).sort((a, b) => Number(isSystem(a.name)) - Number(isSystem(b.name)) || collator.compare(a.name, b.name));
      const items = all
        .map((obj) => {
          const nameHit = !q || obj.name.toLowerCase().includes(q) || (obj.tblName && obj.type !== "table" && obj.tblName.toLowerCase().includes(q));
          const colHits = q ? obj.columns.filter((c) => c.name.toLowerCase().includes(q)) : [];
          return { obj, nameHit, colHits };
        })
        .filter((x) => x.nameHit || x.colHits.length);
      if (!all.length) continue;
      const open = q ? items.length > 0 : !closedGroups.includes(g.type);
      if (q && !items.length) continue;
      out.push({ kind: "group", key: `g:${g.type}`, type: g.type, label: g.label, count: q ? items.length : all.length, open });
      if (!open) continue;
      for (const { obj, colHits } of items) {
        const expandable = obj.columns.length > 0 && (obj.type === "table" || obj.type === "view");
        const isOpen = expandable && (expanded.has(obj.name) || colHits.length > 0);
        out.push({ kind: "obj", key: `o:${obj.type}:${obj.name}`, obj, open: isOpen, expandable });
        if (isOpen) {
          const hitSet = new Set(colHits);
          for (const col of obj.columns) out.push({ kind: "col", key: `c:${obj.name}:${col.name}`, obj, col, hit: hitSet.has(col) });
        }
      }
    }
    return out;
  }, [schema, q, closedGroups, expanded]);

  // count rows of the tables that scroll into view
  const visible = useRef(new Set<string>());
  const wantRef = useRef(wantCount);
  wantRef.current = wantCount;
  const io = useMemo(
    () =>
      new IntersectionObserver(
        (list) => {
          for (const e of list) {
            const name = (e.target as HTMLElement).dataset.count;
            if (!name) continue;
            if (e.isIntersecting) {
              visible.current.add(name);
              wantRef.current(name);
            } else visible.current.delete(name);
          }
        },
        { rootMargin: "100px" },
      ),
    [],
  );
  useEffect(() => () => io.disconnect(), [io]);
  const observeRef = useMemo(() => {
    const fns = new Map<string, (el: HTMLElement | null) => (() => void) | undefined>();
    return (name: string) => {
      let fn = fns.get(name);
      if (!fn) {
        fn = (el) => {
          if (!el) return;
          io.observe(el);
          return () => {
            io.unobserve(el);
            visible.current.delete(name);
          };
        };
        fns.set(name, fn);
      }
      return fn;
    };
  }, [io]);
  // counts dropped after changes: ask again for those on screen
  useEffect(() => {
    for (const name of visible.current) if (!counts[name]) wantCount(name);
  }, [counts, wantCount]);

  const toggleGroup = (type: Group) => setClosedGroups((list) => (list.includes(type) ? list.filter((t) => t !== type) : [...list, type]));
  const toggleExpand = (name: string, open?: boolean) =>
    setExpanded((s) => {
      const n = new Set(s);
      if (open ?? !n.has(name)) n.add(name);
      else n.delete(name);
      return n;
    });

  const activate = (obj: SchemaObject) => {
    if (obj.type === "index" || obj.type === "trigger") select(obj.name, "structure");
    else select(obj.name);
  };

  const objMenu = (obj: SchemaObject): MenuItem[] => {
    const rows = obj.type === "table" || obj.type === "view";
    const items: MenuItem[] = [];
    if (rows) {
      items.push(
        { label: "Browse data", icon: <Rows3 size={14} />, onSelect: () => select(obj.name, "data") },
        { label: "Structure", icon: <ListTree size={14} />, onSelect: () => select(obj.name, "structure") },
        { label: "Query in SQL tab", icon: <Code size={14} />, onSelect: () => sendToSql(`SELECT * FROM ${qi(obj.name)} LIMIT 100;`, true) },
      );
    } else {
      items.push({ label: "Structure", icon: <ListTree size={14} />, onSelect: () => select(obj.name, "structure") });
      if (obj.tblName) items.push({ label: `Browse ${obj.tblName}`, icon: <Rows3 size={14} />, onSelect: () => select(obj.tblName, "data") });
    }
    items.push(
      { separator: true },
      { label: "Copy name", icon: <Copy size={14} />, onSelect: () => copy(obj.name, "name") },
      { label: "Copy CREATE statement", disabled: !obj.sql, hint: obj.sql ? undefined : "automatic", onSelect: () => obj.sql && copy(obj.sql, "CREATE statement") },
    );
    if (rows) items.push({ separator: true }, { label: "Count rows", icon: <Hash size={14} />, onSelect: () => wantCount(obj.name, true) });
    return items;
  };

  const colMenu = (obj: SchemaObject, col: DbColumn): MenuItem[] => [
    { label: "Copy name", icon: <Copy size={14} />, onSelect: () => copy(col.name, "name") },
    { label: "Copy qualified name", onSelect: () => copy(`${qi(obj.name)}.${qi(col.name)}`, "name") },
    { separator: true },
    { label: "Browse data", icon: <Rows3 size={14} />, onSelect: () => select(obj.name, "data") },
  ];

  // ── keyboard: ↑↓ move, → open, ← close, Enter browse ──
  const index = entries.findIndex((e) => e.key === cursor);
  const move = (to: number) => {
    const e = entries[Math.max(0, Math.min(entries.length - 1, to))];
    if (!e) return;
    setCursor(e.key);
    listRef.current?.querySelector(`[data-key="${CSS.escape(e.key)}"]`)?.scrollIntoView({ block: "nearest" });
  };
  const onKeyDown = (ev: React.KeyboardEvent) => {
    if ((ev.target as HTMLElement).closest("input")) {
      if (ev.key === "ArrowDown") {
        ev.preventDefault();
        listRef.current?.focus();
        move(entries.findIndex((e) => e.kind === "obj"));
      }
      return;
    }
    const e = entries[index];
    switch (ev.key) {
      case "ArrowDown":
        move(index + 1);
        break;
      case "ArrowUp":
        move(index - 1);
        break;
      case "Home":
        move(0);
        break;
      case "End":
        move(entries.length - 1);
        break;
      case "ArrowRight":
        if (e?.kind === "group" && !e.open) toggleGroup(e.type);
        else if (e?.kind === "obj" && e.expandable && !e.open) toggleExpand(e.obj.name, true);
        else move(index + 1);
        break;
      case "ArrowLeft":
        if (e?.kind === "group" && e.open) toggleGroup(e.type);
        else if (e?.kind === "obj" && e.open) toggleExpand(e.obj.name, false);
        else if (e?.kind === "col") move(entries.findIndex((x) => x.kind === "obj" && x.obj === e.obj));
        else if (e?.kind === "obj") move(entries.findIndex((x) => x.kind === "group" && x.type === e.obj.type));
        break;
      case "Enter":
      case " ":
        if (e?.kind === "group") toggleGroup(e.type);
        else if (e?.kind === "obj") activate(e.obj);
        else if (e?.kind === "col") select(e.obj.name, "structure");
        break;
      case "ContextMenu": {
        const el = listRef.current?.querySelector(`[data-key="${CSS.escape(e?.key ?? "")}"]`);
        if (!el || !e || e.kind === "group") return;
        const r = el.getBoundingClientRect();
        openMenu({ clientX: r.left + 24, clientY: r.bottom }, e.kind === "obj" ? objMenu(e.obj) : colMenu(e.obj, e.col));
        break;
      }
      default:
        return;
    }
    ev.preventDefault();
  };

  const rows: ReactNode[] = entries.map((e) => {
    const isCursor = e.key === cursor;
    if (e.kind === "group") {
      const G = GROUPS.find((g) => g.type === e.type)!;
      return (
        <div
          key={e.key}
          data-key={e.key}
          className={cx("sqlb-tree-group", isCursor && "cursor")}
          onClick={() => {
            setCursor(e.key);
            toggleGroup(e.type);
          }}
        >
          {e.open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
          <span>{G.label}</span>
          <span className="sqlb-tree-n">{e.count}</span>
        </div>
      );
    }
    if (e.kind === "obj") {
      const { obj } = e;
      const Icon = obj.virtual ? Sheet : ICON[obj.type];
      const c = counts[obj.name];
      const countable = obj.type === "table";
      return (
        <div
          key={e.key}
          data-key={e.key}
          ref={countable ? observeRef(obj.name) : undefined}
          data-count={countable ? obj.name : undefined}
          className={cx("sqlb-tree-item", selected === obj && "selected", isCursor && "cursor", isSystem(obj.name) && "system")}
          title={obj.type === "index" || obj.type === "trigger" ? `${obj.name} on ${obj.tblName}` : obj.name}
          onMouseDown={() => setCursor(e.key)}
          onClick={() => activate(obj)}
          onDoubleClick={() => e.expandable && toggleExpand(obj.name)}
          onContextMenu={(ev) => {
            ev.preventDefault();
            setCursor(e.key);
            openMenu(ev, objMenu(obj));
          }}
        >
          <span
            className={cx("sqlb-tree-twisty", !e.expandable && "none")}
            onClick={(ev) => {
              ev.stopPropagation();
              if (e.expandable) toggleExpand(obj.name);
            }}
          >
            {e.expandable && (e.open ? <ChevronDown size={12} /> : <ChevronRight size={12} />)}
          </span>
          <Icon size={13} className="sqlb-tree-icon" />
          <span className="sqlb-tree-name">{obj.name}</span>
          {(obj.type === "index" || obj.type === "trigger") && <span className="sqlb-tree-on">{obj.tblName}</span>}
          {countable && (
            <span className="sqlb-tree-count" title={c && "n" in c ? `${countText(c)} rows` : c && "error" in c ? c.error : undefined}>
              {c && "n" in c ? countShort(c.n) : c && "loading" in c ? "…" : c && "error" in c ? "?" : ""}
            </span>
          )}
        </div>
      );
    }
    const { col, obj } = e;
    return (
      <div
        key={e.key}
        data-key={e.key}
        className={cx("sqlb-tree-col", isCursor && "cursor", e.hit && "hit")}
        title={`${col.name}${col.type ? ` ${col.type}` : ""}${col.pk ? " · primary key" : ""}${col.notNull ? " · NOT NULL" : ""}${col.default !== null ? ` · default ${col.default}` : ""}`}
        onMouseDown={() => setCursor(e.key)}
        onContextMenu={(ev) => {
          ev.preventDefault();
          openMenu(ev, colMenu(obj, col));
        }}
      >
        <span className="sqlb-tree-pk">{col.pk > 0 && <KeyRound size={11} />}</span>
        <span className="sqlb-tree-name">{col.name}</span>
        {col.notNull && !col.pk && <span className="sqlb-nn" title="NOT NULL">NN</span>}
        <span className="sqlb-tree-type">{col.type || "any"}</span>
      </div>
    );
  });

  return (
    <div className="sqlb-side" onKeyDown={onKeyDown}>
      <div className="sqlb-side-search">
        <SearchBox value={filter} onChange={setFilter} placeholder="Filter tables and columns" />
      </div>
      <div className="sqlb-tree" ref={listRef} tabIndex={0} role="tree" onFocus={() => cursor === null && entries[0] && setCursor(entries[0].key)}>
        {rows}
        {!entries.length && <div className="sqlb-tree-empty">{q ? "Nothing matches" : "This database has no tables"}</div>}
      </div>
    </div>
  );
}
