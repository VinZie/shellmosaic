// Browse a table or view a page at a time: server-side sort, quick search, a WHERE
// box, an inspector, and (once changes are allowed) inline editing.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight, CircleSlash, Copy, Eye, Funnel, ListTree, Lock, PanelRight, Pencil, Plus, RefreshCw, Rows3, Sheet, Table2, Trash, X } from "lucide-react";
import {
  Button,
  Chip,
  IconButton,
  Message,
  SearchBox,
  Split,
  Table,
  Toolbar,
  cx,
  errorText,
  formatNumber,
  openMenu,
  pluralize,
  prompt,
  sm,
  useColumnState,
  useDebounced,
  useStored,
  type Cell,
  type Column,
  type DbColumn,
  type Key,
  type MenuItem,
  type Param,
  type QueryResult,
  type SchemaObject,
  type SortState,
} from "../../shared";
import { CellView, cellTitle } from "./cells";
import { CellEditor, openNewRow, openValueEditor, rowidAlias } from "./editors";
import { Inspector } from "./Inspector";
import {
  affinity,
  cellKey,
  cellLiteral,
  cellParam,
  cellText,
  escapeLike,
  hasPartial,
  hasStatementBreak,
  inputValue,
  isBigInt,
  isInterrupted,
  isBlob,
  isLongText,
  isNumeric,
  isReadOnlyError,
  qi,
  rowIdentity,
  searchColumns,
  toInserts,
  toJson,
  toTsv,
  type Affinity,
} from "./sql";
import { copyOut, useDb, type CountState } from "./state";

interface GridCol {
  index: number;
  id: string;
  name: string;
  label: string;
  declType: string | null;
  aff: Affinity;
  schemaCol: DbColumn | null;
  isRowid: boolean;
  right: boolean;
}

interface Row {
  key: Key;
  cells: Cell[];
}

interface Editing {
  key: Key;
  ci: number;
  value: string;
  original: string;
  wasNull: boolean;
  saving: boolean;
  error: string | null;
}

interface ViewMemo {
  page: number;
  sort: SortState | null;
  search: string;
  where: string;
  whereOpen: boolean;
}
/** Paging, sort and filters of each table this session, restored when you come back to it. */
const memory = new Map<string, ViewMemo>();
let hintedReadOnly = false;

const PAGE_SIZES = [100, 500, 1000];

export function DataTab() {
  const { selected, select, narrow, schema } = useDb();
  if (!selected)
    return (
      <Message icon={<Table2 size={22} />} title={schema.length ? "Nothing to browse" : "This database is empty"}>
        {schema.length ? "It has no tables or views." : "It has no tables, views, indexes or triggers yet."}
      </Message>
    );
  if (selected.type === "index" || selected.type === "trigger")
    return (
      <div className="sqlb-col">
        {narrow && (
          <Toolbar>
            <TablePicker />
          </Toolbar>
        )}
        <Message
          icon={<ListTree size={22} />}
          title={`${selected.name} is ${selected.type === "index" ? "an index" : "a trigger"}`}
          actions={
            <>
              <Button onClick={() => select(selected.tblName, "data")}>Browse {selected.tblName}</Button>
              <Button kind="subtle" onClick={() => select(selected.name, "structure")}>
                Show its structure
              </Button>
            </>
          }
        >
          {selected.type === "index" ? "Indexes" : "Triggers"} have no rows of their own.
        </Message>
      </div>
    );
  return <DataGrid key={`${selected.type}:${selected.name}`} obj={selected} />;
}

/** In a narrow pane the sidebar is gone: pick the table here. */
export function TablePicker({ all }: { all?: boolean }) {
  const { schema, selected, select } = useDb();
  const groups: [string, SchemaObject["type"]][] = [
    ["Tables", "table"],
    ["Views", "view"],
  ];
  if (all)
    groups.push(
      ["Indexes", "index"],
      ["Triggers", "trigger"],
    );
  return (
    <select className="sm-input sm-select sqlb-picker" value={selected?.name ?? ""} title="Table or view" onChange={(e) => select(e.target.value)}>
      {!selected && <option value="">Pick a table</option>}
      {groups.map(([label, type]) => {
        const objs = schema.filter((o) => o.type === type);
        return objs.length ? (
          <optgroup key={type} label={label}>
            {objs.map((o) => (
              <option key={o.name} value={o.name}>
                {o.name}
              </option>
            ))}
          </optgroup>
        ) : null;
      })}
    </select>
  );
}

function defaultWidth(col: GridCol, rows: Cell[][] | undefined): number {
  let chars = col.label.length + 3;
  if (rows)
    for (const r of rows.slice(0, 50)) {
      const c = r[col.index];
      const len = c === null ? 4 : typeof c === "number" ? String(c).length : typeof c === "string" ? Math.min(c.length, 48) : isBlob(c) ? 22 : isBigInt(c) ? c.$int.length : 40;
      if (len > chars) chars = len;
    }
  return Math.max(64, Math.min(340, Math.round(chars * 7.2 + 24)));
}

function DataGrid({ obj }: { obj: SchemaObject }) {
  const { db, counts, wantCount, forgetCounts, version, narrow } = useDb();
  const ident = useMemo(() => rowIdentity(obj), [obj]);
  const memKey = `${db.id}:${obj.type}:${obj.name}`;
  const init = memory.get(memKey);

  const [page, setPage] = useState(init?.page ?? 0);
  const [sort, setSort] = useState<SortState | null>(init?.sort ?? null);
  const [search, setSearch] = useState(init?.search ?? "");
  const debSearch = useDebounced(search, 250);
  const [whereText, setWhereText] = useState(init?.where ?? "");
  const [where, setWhere] = useState(init?.where ?? "");
  const [whereOpen, setWhereOpen] = useState(init?.whereOpen ?? false);
  useEffect(() => {
    memory.set(memKey, { page, sort, search, where, whereOpen });
  }, [memKey, page, sort, search, where, whereOpen]);

  const [pageSize, setPageSize] = useStored<number>("pageSize", 100);
  const [inspOpen, setInspOpen] = useStored<boolean>("inspector", false);
  const [inspW, setInspW] = useStored<number>("inspectorWidth", 340);
  const [inspH, setInspH] = useStored<number>("inspectorHeight", 280);
  const [layout, setLayout] = useColumnState(`data:${db.file}:${obj.name}`);

  const [result, setResult] = useState<QueryResult | null>(null);
  const [error, setError] = useState<{ message: string; sql: string } | null>(null);
  const [loading, setLoading] = useState(true);
  const [slow, setSlow] = useState(false);
  const [tick, setTick] = useState(0);
  const reload = useCallback(() => setTick((t) => t + 1), []);
  const [selected, setSelected] = useState<Key[]>([]);
  const [active, setActive] = useState<{ key: Key | null; ci: number }>({ key: null, ci: -1 });
  const activeRef = useRef(active);
  activeRef.current = active;
  const [editing, setEditing] = useState<Editing | null>(null);
  const [scrollTo, setScrollTo] = useState<Key | null>(null);
  const pendingSelect = useRef<Key | null>(null);
  const [filteredCount, setFilteredCount] = useState<CountState | null>(null);
  const searchRef = useRef<HTMLDivElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const focusGrid = useCallback(() => requestAnimationFrame(() => gridRef.current?.querySelector<HTMLElement>(".sm-table")?.focus()), []);

  // ── the query ──
  const searchCols = useMemo(() => searchColumns(obj.columns.filter((c) => c.hidden !== 1).map((c) => ({ name: c.name, type: c.type }))), [obj]);
  const filter = useMemo(() => {
    const parts: string[] = [];
    const params: Param[] = [];
    const s = debSearch.trim();
    if (s && searchCols.length) {
      parts.push("(" + searchCols.map((c) => `${qi(c)} LIKE ?1 ESCAPE '\\'`).join(" OR ") + ")");
      params.push(`%${escapeLike(s)}%`);
    }
    if (where.trim()) parts.push(`(\n${where.trim()}\n)`);
    return { sql: parts.length ? `\nWHERE ${parts.join(" AND ")}` : "", params, active: parts.length > 0 };
  }, [debSearch, where, searchCols]);
  const filterKey = filter.sql + "\u0000" + JSON.stringify(filter.params);

  const gridCols = useMemo<GridCol[]>(() => {
    const src =
      result?.columns ??
      [...(ident.kind === "rowid" ? [{ name: "__rowid", declType: "INTEGER" }] : []), ...obj.columns.filter((c) => c.hidden !== 1).map((c) => ({ name: c.name, declType: c.type }))];
    const used = new Set<string>();
    return src.map((c, i) => {
      let id = c.name;
      for (let k = 2; used.has(id); k++) id = `${c.name}#${k}`;
      used.add(id);
      const isRowid = ident.kind === "rowid" && i === 0;
      const schemaCol = isRowid ? null : (obj.columns.find((x) => x.name === c.name) ?? null);
      const declType = c.declType ?? schemaCol?.type ?? null;
      const aff = affinity(declType);
      let right = isRowid || isNumeric(aff);
      if (!right && !declType && result?.rows.length) {
        const sample = result.rows.slice(0, 50).map((r) => r[i]).filter((v) => v !== null);
        right = sample.length > 0 && sample.every((v) => typeof v === "number" || isBigInt(v));
      }
      return { index: i, id, name: c.name, label: isRowid ? "rowid" : c.name, declType, aff, schemaCol, isRowid, right };
    });
  }, [result, obj, ident]);
  const colById = useMemo(() => new Map(gridCols.map((c) => [c.id, c])), [gridCols]);

  const sortCol = sort ? colById.get(sort.id) : undefined;
  const selectSql = useMemo(() => {
    const cols = ident.kind === "rowid" ? `${ident.expr} AS "__rowid", *` : "*";
    const order = sortCol ? `\nORDER BY ${qi(sortCol.isRowid ? "__rowid" : sortCol.name)} ${sort!.desc ? "DESC" : "ASC"}` : "";
    return `SELECT ${cols} FROM ${qi(obj.name)}${filter.sql}${order}\nLIMIT ${pageSize} OFFSET ${page * pageSize}`;
  }, [ident, obj.name, filter.sql, sortCol, sort, pageSize, page]);

  const gen = useRef(0);
  useEffect(() => {
    const my = ++gen.current;
    setLoading(true);
    const slowTimer = setTimeout(() => my === gen.current && setSlow(true), 700);
    sm.sqlite
      .query(db.id, selectSql, filter.params, { maxRows: pageSize })
      .then((res) => {
        if (my !== gen.current) return;
        setResult(res);
        setError(null);
      })
      .catch((e) => {
        if (my !== gen.current) return;
        setError({ message: errorText(e), sql: selectSql });
        setResult(null);
      })
      .finally(() => {
        clearTimeout(slowTimer);
        if (my === gen.current) {
          setLoading(false);
          setSlow(false);
        }
      });
    // filterKey covers the params
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [db.id, selectSql, filterKey, pageSize, version, tick]);

  // ── how many rows ──
  const countGen = useRef(0);
  const countMissing = !counts[obj.name];
  useEffect(() => {
    if (!filter.active) {
      wantCount(obj.name);
      return;
    }
    const my = ++countGen.current;
    setFilteredCount({ loading: true });
    sm.sqlite
      .query(db.id, `SELECT COUNT(*) FROM ${qi(obj.name)}${filter.sql}`, filter.params, { maxRows: 1 })
      .then((r) => my === countGen.current && setFilteredCount({ n: Number(cellText(r.rows[0]?.[0] ?? 0)) }))
      .catch((e) => my === countGen.current && setFilteredCount({ error: errorText(e) }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [db.id, obj.name, filterKey, version, tick, countMissing]);
  const total: CountState | undefined = filter.active ? (filteredCount ?? undefined) : counts[obj.name];
  const totalN = total && "n" in total ? total.n : null;
  const pages = totalN === null ? null : Math.max(1, Math.ceil(totalN / pageSize));
  useEffect(() => {
    if (pages !== null && page >= pages) setPage(pages - 1);
  }, [pages, page]);

  // ── rows ──
  const pkIdx = useMemo(() => (ident.kind === "pk" ? ident.cols.map((c) => gridCols.findIndex((g) => g.name === c.name && !g.isRowid)) : []), [ident, gridCols]);
  const identOk = ident.kind === "rowid" || (ident.kind === "pk" && pkIdx.every((x) => x >= 0));
  const rows = useMemo<Row[]>(
    () =>
      (result?.rows ?? []).map((cells, i) => ({
        key: ident.kind === "rowid" ? cellKey(cells[0]) : identOk ? JSON.stringify(pkIdx.map((x) => cellKey(cells[x]))) : page * pageSize + i,
        cells,
      })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [result],
  );
  const byKey = useMemo(() => new Map(rows.map((r) => [r.key, r])), [rows]);

  useEffect(() => {
    const p = pendingSelect.current;
    if (p !== null && byKey.has(p)) {
      pendingSelect.current = null;
      setSelected([p]);
      setActive((a) => ({ key: p, ci: a.ci }));
      setScrollTo(p);
      return;
    }
    setSelected((sel) => (sel.every((k) => byKey.has(k)) ? sel : sel.filter((k) => byKey.has(k))));
    setEditing((ed) => (ed && byKey.has(ed.key) ? ed : null));
  }, [byKey]);

  // visible columns in the user's order (for copying and ←/→)
  const visibleCols = useMemo(() => {
    const ordered = [...layout.order.filter((id) => colById.has(id)).map((id) => colById.get(id)!), ...gridCols.filter((c) => !layout.order.includes(c.id))];
    const vis = ordered.filter((c) => layout.visible[c.id] ?? !c.isRowid);
    return vis.length ? vis : ordered.slice(0, 1);
  }, [layout, gridCols, colById]);

  // ── editing ──
  const isTable = obj.type === "table" && !obj.virtual;
  const tableWhy = !identOk ? (ident.kind === "none" ? ident.why : "The primary key isn't in the result") : !db.writable ? "Read-only: turn on Allow changes to edit" : null;
  const cellWhy = useCallback(
    (row: Row | undefined, col: GridCol | undefined, forNull = false): string | null => {
      if (tableWhy) return tableWhy;
      if (!row || !col) return "Pick a cell";
      if (col.isRowid) return "The rowid can't be edited here";
      if (!col.schemaCol) return "This column isn't part of the table";
      if (col.schemaCol.hidden >= 2) return "Generated columns are computed, not stored";
      if (forNull) return null;
      const c = row.cells[col.index];
      if (isBlob(c)) return "Blobs can't be edited here; use the SQL tab with an X'…' literal";
      if (isLongText(c)) return `This text is too long to edit here (${formatNumber(c.length)} characters)`;
      return null;
    },
    [tableWhy],
  );

  const whereFor = useCallback(
    (row: Row): { sql: string; params: Param[] } => {
      const params: Param[] = [];
      const eq = (name: string, c: Cell) => {
        if (c === null) return `${name} IS NULL`;
        const p = cellParam(c);
        if (p.sql.includes("?")) params.push(p.param);
        return `${name} = ${p.sql}`;
      };
      if (ident.kind === "rowid") return { sql: eq(ident.expr, row.cells[0]), params };
      if (ident.kind === "pk") return { sql: ident.cols.map((c, i) => eq(qi(c.name), row.cells[pkIdx[i]])).join(" AND "), params };
      return { sql: "0", params };
    },
    [ident, pkIdx],
  );

  const rowLabel = useCallback(
    (row: Row) => (ident.kind === "rowid" ? `row ${cellText(row.cells[0])}` : ident.kind === "pk" ? `row (${pkIdx.map((x) => cellText(row.cells[x]) || "NULL").join(", ")})` : "the row"),
    [ident, pkIdx],
  );

  const saveCell = useCallback(
    async (row: Row, col: GridCol, text: string | null): Promise<string | null> => {
      const v = text === null ? { param: null, sql: "?" } : inputValue(text, col.aff, row.cells[col.index]);
      const w = whereFor(row);
      try {
        const r = await sm.sqlite.query(db.id, `UPDATE ${qi(obj.name)} SET ${qi(col.name)} = ${v.sql} WHERE ${w.sql}`, [v.param, ...w.params]);
        if (r.changes === 0) sm.ui.notify("No row was updated; it may have been changed or deleted meanwhile", "warning");
        else sm.ui.notify(`Updated ${col.name} of ${rowLabel(row)}`, "success");
        reload();
        return null;
      } catch (e) {
        const m = errorText(e);
        return isReadOnlyError(m) ? "The database is read-only; turn on Allow changes first" : m;
      }
    },
    [db.id, obj.name, whereFor, rowLabel, reload],
  );

  const startEdit = useCallback(
    (row: Row, col: GridCol) => {
      const why = cellWhy(row, col);
      if (why) {
        setInspOpen(true);
        if (!db.writable && identOk && isTable && !hintedReadOnly) {
          hintedReadOnly = true;
          sm.ui.notify("Read-only: turn on Allow changes (top right) to edit", "info");
        }
        return;
      }
      const c = row.cells[col.index];
      const text = c === null ? "" : cellText(c);
      setActive({ key: row.key, ci: col.index });
      if (typeof c === "string" && (c.includes("\n") || c.length > 160)) {
        openValueEditor({
          title: `Edit ${col.name}`,
          subtitle: `${obj.name} · ${rowLabel(row)}${col.declType ? ` · ${col.declType}` : ""}`,
          initial: text,
          isNull: false,
          save: async (v) => {
            const err = await saveCell(row, col, v);
            if (!err) focusGrid();
            return err;
          },
        });
        return;
      }
      setEditing({ key: row.key, ci: col.index, value: text, original: text, wasNull: c === null, saving: false, error: null });
    },
    [cellWhy, db.writable, identOk, isTable, obj.name, rowLabel, saveCell, setInspOpen, focusGrid],
  );

  const commitEdit = useCallback(
    async (asNull = false) => {
      const ed = editing;
      if (!ed || ed.saving) return;
      const row = byKey.get(ed.key);
      const col = gridCols[ed.ci];
      if (!row || !col) return setEditing(null);
      if (!asNull && ed.value === ed.original && !(ed.wasNull && ed.value !== "")) return setEditing(null);
      if (asNull && ed.wasNull) return setEditing(null);
      setEditing({ ...ed, saving: true, error: null });
      const err = await saveCell(row, col, asNull ? null : ed.value);
      setEditing((cur) => (cur && cur.key === ed.key && cur.ci === ed.ci ? (err ? { ...cur, saving: false, error: err } : null) : cur));
      if (!err) focusGrid();
    },
    [editing, byKey, gridCols, saveCell, focusGrid],
  );

  const deleteRows = useCallback(
    async (list: Row[]) => {
      if (!list.length || tableWhy || !isTable) return;
      const n = list.length;
      const where = db.copied ? "the temporary copy" : db.file;
      const ok = await sm.ui.confirm(n === 1 ? `Delete ${rowLabel(list[0])}?` : `Delete ${n} rows?`, `${n === 1 ? "It" : "They"} will be removed from ${obj.name} in ${where}. This can't be undone.`, {
        okLabel: n === 1 ? "Delete row" : `Delete ${n} rows`,
        danger: true,
      });
      if (!ok) return;
      let changes = 0;
      try {
        for (let i = 0; i < list.length; i += 400) {
          const chunk = list.slice(i, i + 400);
          const params: Param[] = [];
          let sql: string;
          if (ident.kind === "rowid") {
            const items = chunk.map((r) => {
              const p = cellParam(r.cells[0]);
              params.push(p.param);
              return p.sql;
            });
            sql = `DELETE FROM ${qi(obj.name)} WHERE ${ident.expr} IN (${items.join(", ")})`;
          } else {
            const conds = chunk.map((r) => {
              const w = whereFor(r);
              params.push(...w.params);
              return `(${w.sql})`;
            });
            sql = `DELETE FROM ${qi(obj.name)} WHERE ${conds.join(" OR ")}`;
          }
          changes += (await sm.sqlite.query(db.id, sql, params)).changes;
        }
        sm.ui.notify(`Deleted ${pluralize(changes, "row")} from ${obj.name}`, "success");
      } catch (e) {
        sm.ui.notify(`Couldn't delete: ${errorText(e)}`, "error");
      }
      setSelected([]);
      forgetCounts([obj.name]);
      reload();
      focusGrid();
    },
    [tableWhy, isTable, db, obj.name, ident, whereFor, rowLabel, forgetCounts, reload, focusGrid],
  );

  const afterInsert = useCallback(
    (rowid: number, values: Record<string, Param> | null) => {
      focusGrid();
      forgetCounts([obj.name]);
      let key: Key | null = null;
      if (ident.kind === "rowid") key = rowid;
      else if (ident.kind === "pk" && values) {
        const alias = rowidAlias(obj);
        key = JSON.stringify(ident.cols.map((c) => (c === alias ? rowid : cellKey((values[c.name] ?? null) as Cell))));
      }
      pendingSelect.current = key;
      sm.ui.notify(`Added ${ident.kind === "rowid" ? `row ${rowid}` : "a row"} to ${obj.name}`, "success");
      if (!sort && !filter.active && ident.kind === "rowid") {
        // in rowid order a new row is (almost always) the last one
        sm.sqlite
          .count(db.id, obj.name)
          .then((n) => {
            setPage(Math.max(0, Math.ceil(n / pageSize) - 1));
            reload();
          })
          .catch(reload);
      } else reload();
    },
    [focusGrid, forgetCounts, obj, ident, sort, filter.active, db.id, pageSize, reload],
  );

  const addRow = useCallback(async () => {
    if (tableWhy || !isTable) return;
    const formReason = (why: string) =>
      openNewRow({
        obj,
        reason: why,
        insert: (sql, params) => sm.sqlite.query(db.id, sql, params),
        done: (rowid, values) => afterInsert(rowid, values),
      });
    if (ident.kind === "pk") return formReason("A WITHOUT ROWID table needs its key. Empty fields get their default, or NULL.");
    try {
      const r = await sm.sqlite.query(db.id, `INSERT INTO ${qi(obj.name)} DEFAULT VALUES`);
      afterInsert(r.lastInsertRowid, null);
    } catch (e) {
      const m = errorText(e);
      if (/constraint|NOT NULL/i.test(m)) formReason(`A row with only default values isn't allowed (${m}). Fill in the required fields; empty ones get their default, or NULL.`);
      else sm.ui.notify(`Couldn't add a row: ${m}`, "error");
    }
  }, [tableWhy, isTable, obj, ident, db.id, afterInsert]);

  // ── filters ──
  const applyWhere = (expr: string) => {
    const t = expr.trim();
    if (hasStatementBreak(t)) {
      sm.ui.notify("The filter is one expression; it can't contain ';'", "error");
      return;
    }
    setWhere(t);
    setWhereText(t);
    setPage(0);
    if (t) setWhereOpen(true);
  };
  const addFilter = (expr: string) => applyWhere(where ? `${/\bor\b/i.test(where) ? `(${where})` : where} AND ${expr}` : expr);

  // ── copying ──
  const copyRows = (list: Row[], fmt: "tsv" | "tsvh" | "json" | "insert") => {
    const cols = fmt === "insert" ? visibleCols.filter((c) => !c.isRowid) : visibleCols;
    const names = cols.map((c) => (c.isRowid ? "rowid" : c.name));
    const data = list.map((r) => cols.map((c) => r.cells[c.index]));
    const text = fmt === "json" ? toJson(names, data) : fmt === "insert" ? toInserts(obj.name, names, data) : toTsv(names, data, fmt === "tsvh");
    copyOut(text, list.length === 1 ? "1 row" : `${formatNumber(list.length)} rows`, data.some(hasPartial));
  };

  // ── menus & keys ──
  const rowMenu = (at: { clientX: number; clientY: number }, list: Row[]) => {
    const a = activeRef.current;
    const row = (a.key !== null && byKey.get(a.key)) || list[0];
    const col = gridCols[a.ci];
    const n = list.length;
    const items: MenuItem[] = [];
    if (row && col) {
      const c = row.cells[col.index];
      const why = cellWhy(row, col);
      const whyNull = cellWhy(row, col, true);
      items.push(
        { header: col.label },
        { label: "Copy value", icon: <Copy size={14} />, onSelect: () => copyOut(cellText(c), "value", isLongText(c) || (isBlob(c) && c.length > 256)) },
        { label: "Edit value…", icon: <Pencil size={14} />, hint: why ? (db.writable ? "" : "read-only") : "F2", disabled: !!why, onSelect: () => startEdit(row, col) },
        {
          label: "Set to NULL",
          icon: <CircleSlash size={14} />,
          hint: whyNull && !db.writable ? "read-only" : undefined,
          disabled: !!whyNull || c === null,
          onSelect: () => void saveCell(row, col, null).then((err) => void (err && sm.ui.notify(err, "error"))),
        },
      );
      if (!isBlob(c) && !isLongText(c) && col.schemaCol !== null) {
        const lit = c === null ? "IS NULL" : `= ${cellLiteral(c)}`;
        const short = lit.length > 28 ? lit.slice(0, 27) + "…" : lit;
        items.push({ label: `Filter: ${col.name} ${short}`, icon: <Funnel size={14} />, onSelect: () => addFilter(`${qi(col.name)} ${lit}`) });
      }
      items.push({ separator: true });
    }
    const what = n === 1 ? "row" : `${formatNumber(n)} rows`;
    items.push(
      { label: `Copy ${what} (TSV)`, icon: <Copy size={14} />, hint: "Ctrl+C", onSelect: () => copyRows(list, "tsv") },
      {
        label: "Copy as",
        submenu: [
          { label: "TSV with header", onSelect: () => copyRows(list, "tsvh") },
          { label: "JSON", onSelect: () => copyRows(list, "json") },
          { label: "INSERT statements", onSelect: () => copyRows(list, "insert") },
        ],
      },
      { separator: true },
      { label: "Show in inspector", icon: <PanelRight size={14} />, onSelect: () => setInspOpen(true) },
    );
    if (isTable)
      items.push({
        label: n === 1 ? "Delete row" : `Delete ${formatNumber(n)} rows`,
        icon: <Trash size={14} />,
        danger: !tableWhy,
        disabled: !!tableWhy,
        hint: tableWhy ? (db.writable ? "" : "read-only") : "Del",
        onSelect: () => deleteRows(list),
      });
    openMenu(at, items);
  };

  const moveCol = (dir: number) => {
    if (!visibleCols.length) return;
    const pos = visibleCols.findIndex((c) => c.index === active.ci);
    const next = visibleCols[Math.max(0, Math.min(visibleCols.length - 1, pos < 0 ? 0 : pos + dir))];
    setActive((a) => ({ key: a.key ?? selected[selected.length - 1] ?? rows[0]?.key ?? null, ci: next.index }));
  };

  // bring the active cell into view horizontally
  useEffect(() => {
    const cell = gridRef.current?.querySelector<HTMLElement>(".sqlb-cell.active");
    const scroller = gridRef.current?.querySelector<HTMLElement>(".sm-table-scroll");
    const td = cell?.parentElement;
    if (!td || !scroller) return;
    const left = td.offsetLeft;
    const right = left + td.offsetWidth;
    if (left < scroller.scrollLeft) scroller.scrollLeft = left;
    else if (right > scroller.scrollLeft + scroller.clientWidth) scroller.scrollLeft = right - scroller.clientWidth;
  }, [active]);

  const firstEditable = () => visibleCols.find((c) => !c.isRowid) ?? visibleCols[0];
  const onOpen = (row: Row) => {
    const col = gridCols[activeRef.current.ci] ?? firstEditable();
    if (col) startEdit(row, col);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if ((e.target as HTMLElement).closest("input, textarea, select")) return;
    if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
      e.preventDefault();
      moveCol(e.key === "ArrowLeft" ? -1 : 1);
    } else if (e.key === "F2") {
      e.preventDefault();
      const row = active.key !== null ? byKey.get(active.key) : undefined;
      if (row) onOpen(row);
    } else if (e.key === "Delete" && selected.length && isTable) {
      e.preventDefault();
      if (tableWhy) sm.ui.notify(tableWhy, "info");
      else deleteRows(selected.map((k) => byKey.get(k)).filter((r): r is Row => !!r));
    }
  };
  // Ctrl+F from anywhere in the tab
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() === "f" && e.ctrlKey && gridRef.current?.offsetParent) {
        e.preventDefault();
        searchRef.current?.querySelector("input")?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // ── columns ──
  const widths = useRef(new Map<string, number>());
  const columns = useMemo<Column<Row>[]>(
    () =>
      gridCols.map((col) => {
        if (!widths.current.has(col.id) && result) widths.current.set(col.id, defaultWidth(col, result.rows));
        const sc = col.schemaCol;
        const title = col.isRowid
          ? "rowid: the row's built-in key"
          : [col.name, col.declType || "no declared type", sc?.pk ? "primary key" : "", sc?.notNull ? "NOT NULL" : "", sc && sc.hidden >= 2 ? "generated" : ""].filter(Boolean).join(" · ");
        return {
          id: col.id,
          label: col.label,
          width: widths.current.get(col.id) ?? defaultWidth(col, undefined),
          minWidth: 48,
          align: col.right ? "right" : undefined,
          hidden: col.isRowid,
          title,
          sort: () => 0,
          text: (row: Row) => cellTitle(row.cells[col.index]) ?? "",
          render: (row: Row) => {
            const isActive = active.ci === col.index && active.key === row.key;
            const ed = editing && editing.key === row.key && editing.ci === col.index ? editing : null;
            return (
              <div
                className={cx("sqlb-cell", col.right && "num", isActive && "active")}
                onMouseDown={() => {
                  const next = { key: row.key, ci: col.index };
                  activeRef.current = next;
                  setActive(next);
                }}
              >
                <CellView c={row.cells[col.index]} />
                {ed && (
                  <CellEditor
                    value={ed.value}
                    changed={ed.value !== ed.original || (ed.wasNull && ed.value !== "")}
                    mono={col.right}
                    saving={ed.saving}
                    error={ed.error}
                    onChange={(v) => setEditing((cur) => (cur ? { ...cur, value: v, error: null } : cur))}
                    onSave={() => commitEdit(false)}
                    onNull={() => commitEdit(true)}
                    onCancel={() => {
                      setEditing(null);
                      gridRef.current?.querySelector<HTMLElement>(".sm-table")?.focus();
                    }}
                  />
                )}
              </div>
            );
          },
        };
      }),
    [gridCols, result, active, editing, commitEdit],
  );

  const activeRow = (active.key !== null && byKey.get(active.key)) || (selected.length ? byKey.get(selected[selected.length - 1]) : undefined) || null;
  const inspectorCols = useMemo(
    () => gridCols.filter((c) => !c.isRowid).map((c) => ({ index: c.index, name: c.name, declType: c.declType, pk: !!c.schemaCol && c.schemaCol.pk > 0 })),
    [gridCols],
  );

  // ── render ──
  const from = page * pageSize + 1;
  const to = page * pageSize + rows.length;
  const kindChip = obj.type === "view" ? (
    <Chip tone="dim" icon={<Eye size={11} />} title="Views are read-only">
      view
    </Chip>
  ) : obj.virtual ? (
    <Chip tone="dim" icon={<Sheet size={11} />} title="A virtual table (browse only)">
      virtual
    </Chip>
  ) : obj.withoutRowid ? (
    <Chip tone="dim" title="Rows are identified by the primary key">
      without rowid
    </Chip>
  ) : null;

  const grid = (
    <div className="sqlb-col" ref={gridRef} onKeyDown={onKeyDown}>
      {loading && <div className="sqlb-progress" />}
      {error && isInterrupted(error.message) ? (
        <Message
          icon={<X size={22} />}
          title="Loading was cancelled"
          actions={
            <Button small onClick={reload}>
              Load again
            </Button>
          }
        />
      ) : error ? (
        <Message
          tone="danger"
          icon={<X size={22} />}
          title={where ? "The filter didn't work" : "Couldn't read the rows"}
          actions={
            <>
              {where && (
                <Button small onClick={() => applyWhere("")}>
                  Clear the WHERE filter
                </Button>
              )}
              <Button small kind="subtle" onClick={reload}>
                Try again
              </Button>
            </>
          }
        >
          <p className="sm-selectable sqlb-error-text">{error.message}</p>
          <pre className="sqlb-error-sql sm-code">{error.sql}</pre>
        </Message>
      ) : (
        <Table<Row>
          className={cx("sqlb-grid", loading && "loading")}
          columns={columns}
          rows={rows}
          rowKey={(r) => r.key}
          columnState={layout}
          onColumnState={setLayout}
          sortRows={false}
          sort={sort}
          onSort={(s) => {
            setSort(s);
            setPage(0);
          }}
          selected={selected}
          onSelect={(keys) => {
            setSelected(keys);
            if (keys.length === 1 && activeRef.current.key !== keys[0]) setActive((a) => ({ key: keys[0], ci: a.ci }));
          }}
          multi
          onOpen={onOpen}
          onContextMenu={rowMenu}
          copyText={(list) =>
            toTsv(
              visibleCols.map((c) => c.name),
              list.map((r) => visibleCols.map((c) => r.cells[c.index])),
              false,
            )
          }
          scrollTo={scrollTo}
          headerMenu={[{ label: "Copy column names", icon: <Copy size={14} />, onSelect: () => copyOut(visibleCols.map((c) => c.label).join("\t"), "column names") }]}
          empty={
            loading ? null : filter.active ? (
              <span>
                No rows match{" "}
                {where ? (
                  <>
                    the filter
                    {debSearch.trim() && <> and “{debSearch.trim()}”</>}
                  </>
                ) : (
                  <>“{debSearch.trim()}”</>
                )}
              </span>
            ) : page > 0 ? (
              "No rows on this page"
            ) : (
              `${obj.name} has no rows`
            )
          }
        />
      )}
    </div>
  );

  const inspector = (
    <Inspector
      columns={inspectorCols}
      row={activeRow?.cells ?? null}
      title={activeRow ? (ident.kind === "none" ? "Row" : rowLabel(activeRow).replace(/^row/, "Row")) : "Row"}
      selectedCount={selected.length}
      activeIndex={active.ci}
      onActivate={(ci) => setActive((a) => ({ key: a.key ?? activeRow?.key ?? null, ci }))}
      editWhy={(ci) => (activeRow ? cellWhy(activeRow, gridCols[ci]) : "No row")}
      onEdit={(ci) => {
        const col = gridCols[ci];
        if (!activeRow || !col) return;
        const c = activeRow.cells[ci];
        openValueEditor({
          title: `Edit ${col.name}`,
          subtitle: `${obj.name} · ${rowLabel(activeRow)}${col.declType ? ` · ${col.declType}` : ""}`,
          initial: c === null ? "" : cellText(c),
          isNull: c === null,
          mono: col.right,
          save: (v) => saveCell(activeRow, col, v),
        });
      }}
      onClose={() => setInspOpen(false)}
    />
  );

  const editTitle = (what: string) => tableWhy ?? what;

  return (
    <div className="sqlb-col">
      <Toolbar className="sqlb-data-toolbar">
        {narrow ? (
          <TablePicker />
        ) : (
          <div className="sqlb-objtitle" title={obj.name}>
            {obj.type === "view" ? <Eye size={14} /> : obj.virtual ? <Sheet size={14} /> : <Table2 size={14} />}
            <span className="sqlb-objtitle-name">{obj.name}</span>
            {kindChip}
          </div>
        )}
        <div ref={searchRef} className="sqlb-search">
          <SearchBox
            value={search}
            onChange={(v) => {
              setSearch(v);
              setPage(0);
            }}
            placeholder={searchCols.length ? (searchCols.length <= 2 ? `Search ${searchCols.join(", ")}` : "Search text columns") : "Nothing to search"}
          />
        </div>
        <IconButton title={whereOpen ? "Hide the WHERE filter" : "Filter with a WHERE expression"} on={whereOpen || !!where} onClick={() => setWhereOpen(!whereOpen)}>
          <Funnel size={14} />
        </IconButton>
        <div className="sm-grow" />
        {isTable && (
          <>
            {narrow ? (
              <IconButton title={editTitle("Add a row")} disabled={!!tableWhy} onClick={addRow}>
                <Plus size={15} />
              </IconButton>
            ) : (
              <Button small title={editTitle("Add a row (INSERT … DEFAULT VALUES)")} disabled={!!tableWhy} onClick={addRow}>
                <Plus size={13} /> Row
              </Button>
            )}
            <IconButton
              title={tableWhy ?? (selected.length ? `Delete ${pluralize(selected.length, "selected row")} (Del)` : "Delete the selected rows")}
              danger
              disabled={!!tableWhy || !selected.length}
              onClick={() => deleteRows(selected.map((k) => byKey.get(k)).filter((r): r is Row => !!r))}
            >
              <Trash size={14} />
            </IconButton>
          </>
        )}
        {!isTable && !narrow && (
          <span className="sqlb-readonly-note" title={ident.kind === "none" ? ident.why : undefined}>
            <Lock size={11} /> browse only
          </span>
        )}
        <div className="sm-toolbar-sep" />
        <IconButton
          title="Refresh (F5)"
          onClick={() => {
            wantCount(obj.name, true);
            reload();
          }}
        >
          <RefreshCw size={14} />
        </IconButton>
        <IconButton title={inspOpen ? "Hide the row inspector" : "Show the row inspector"} on={inspOpen} onClick={() => setInspOpen(!inspOpen)}>
          <PanelRight size={15} />
        </IconButton>
      </Toolbar>

      {(whereOpen || where) && (
        <form
          className="sqlb-wherebar"
          onSubmit={(e) => {
            e.preventDefault();
            applyWhere(whereText);
          }}
        >
          <span className="sqlb-where-kw">WHERE</span>
          <input
            className={cx("sm-input mono sqlb-where-input", whereText.trim() !== where && "dirty")}
            value={whereText}
            spellCheck={false}
            autoFocus={!where}
            placeholder={whereExample(obj)}
            onChange={(e) => setWhereText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.preventDefault();
                if (whereText !== where) setWhereText(where);
                else if (!where) setWhereOpen(false);
              }
            }}
          />
          <Button small type="submit" disabled={whereText.trim() === where}>
            Apply
          </Button>
          <IconButton
            title={where ? "Remove the filter" : "Close"}
            onClick={() => {
              applyWhere("");
              setWhereOpen(false);
            }}
          >
            <X size={14} />
          </IconButton>
        </form>
      )}


      {inspOpen ? (
        narrow ? (
          <Split direction="vertical" sizeOf="second" size={inspH} onSize={setInspH} min={120} first={grid} second={inspector} />
        ) : (
          <Split sizeOf="second" size={inspW} onSize={setInspW} min={220} first={grid} second={inspector} />
        )
      ) : (
        grid
      )}

      <div className="sm-footer sqlb-pager">
        <Rows3 size={12} />
        <button
          type="button"
          className="sqlb-range"
          title="Go to a page"
          disabled={!pages || pages <= 1}
          onClick={async () => {
            const v = await prompt({
              title: "Go to page",
              label: `Page (1–${pages})`,
              value: String(page + 1),
              validate: (s) => (/^\d+$/.test(s.trim()) && +s >= 1 && +s <= (pages ?? 1) ? null : `A number from 1 to ${pages}`),
            });
            if (v) setPage(+v - 1);
          }}
        >
          {rows.length ? (
            <>
              {narrow ? "" : "Rows "}
              {formatNumber(from)}–{formatNumber(to)} of {totalN !== null ? formatNumber(totalN) : total && "error" in total ? "?" : "…"}
            </>
          ) : loading ? (
            "Loading…"
          ) : totalN === 0 || !error ? (
            "No rows"
          ) : (
            ""
          )}
        </button>
        {filter.active && (
          <Chip tone="accent" icon={<Funnel size={10} />}>
            filtered
          </Chip>
        )}
        {selected.length > 1 && <span>· {formatNumber(selected.length)} selected</span>}
        <div className="sm-grow" />
        {slow && (
          <Button small kind="subtle" onClick={() => sm.sqlite.interrupt(db.id).catch(() => {})}>
            Cancel
          </Button>
        )}
        <IconButton title="First page" disabled={page === 0} onClick={() => setPage(0)}>
          <ChevronsLeft size={14} />
        </IconButton>
        <IconButton title="Previous page" disabled={page === 0} onClick={() => setPage(page - 1)}>
          <ChevronLeft size={14} />
        </IconButton>
        <span className="sqlb-pageno">
          {page + 1}
          {pages !== null && <> / {formatNumber(pages)}</>}
        </span>
        <IconButton title="Next page" disabled={pages !== null ? page >= pages - 1 : rows.length < pageSize} onClick={() => setPage(page + 1)}>
          <ChevronRight size={14} />
        </IconButton>
        <IconButton title="Last page" disabled={pages === null || page >= pages - 1} onClick={() => pages && setPage(pages - 1)}>
          <ChevronsRight size={14} />
        </IconButton>
        <select
          className="sqlb-mini-select"
          title="Rows per page"
          value={pageSize}
          onChange={(e) => {
            const n = +e.target.value;
            setPage(Math.floor((page * pageSize) / n));
            setPageSize(n);
          }}
        >
          {PAGE_SIZES.map((n) => (
            <option key={n} value={n}>
              {formatNumber(n)} / page
            </option>
          ))}
        </select>

      </div>
    </div>
  );
}


function whereExample(obj: SchemaObject): string {
  const num = obj.columns.find((c) => isNumeric(affinity(c.type)) && c.pk === 0);
  const text = obj.columns.find((c) => affinity(c.type) === "TEXT");
  if (num && text) return `e.g. ${qi(num.name)} > 100 AND ${qi(text.name)} IS NOT NULL`;
  if (num) return `e.g. ${qi(num.name)} > 100`;
  if (text) return `e.g. ${qi(text.name)} LIKE 'a%'`;
  return "an SQL expression, e.g. rowid > 100";
}
