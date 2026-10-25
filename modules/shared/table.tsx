// A virtualized data table: only the rows on screen are rendered, so 100 000 rows
// scroll as smoothly as 100. Columns can be sorted, resized, reordered (drag a
// header) and shown or hidden (right-click a header); that layout is kept per table
// with useColumnState.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ChevronDown, ChevronUp } from "lucide-react";
import { cx } from "./components";
import { useStored } from "./hooks";
import { openMenu, type MenuItem } from "./overlays";
import { copy } from "./sdk";

export type Key = string | number;
type SortValue = string | number | bigint | boolean | null | undefined;

export interface Column<T> {
  id: string;
  label: string;
  /** default width in px */
  width?: number;
  minWidth?: number;
  align?: "left" | "right";
  mono?: boolean;
  /** value to sort by; columns without it can't be sorted */
  sort?: (row: T) => SortValue;
  /** cell content; defaults to text(row) */
  render?: (row: T) => ReactNode;
  /** plain text: tooltips, copying, and the default content */
  text?: (row: T) => string;
  /** hidden until the user shows it */
  hidden?: boolean;
  /** header tooltip */
  title?: string;
}

export interface ColumnState {
  /** user order (ids); columns missing from it follow in definition order */
  order: string[];
  /** shown/hidden overrides of each column's default */
  visible: Record<string, boolean>;
  widths: Record<string, number>;
}

export interface SortState {
  id: string;
  desc: boolean;
}

const EMPTY_STATE: ColumnState = { order: [], visible: {}, widths: {} };

/** Column layout of one table, saved in the module's storage under `key`. */
export function useColumnState(key: string): [ColumnState, (s: ColumnState) => void] {
  const [s, set] = useStored<ColumnState>(`columns:${key}`, EMPTY_STATE);
  return [s, set];
}

function compareValues(a: SortValue, b: SortValue): number {
  const an = a === null || a === undefined || a === "";
  const bn = b === null || b === undefined || b === "";
  if (an || bn) return an && bn ? 0 : an ? 1 : -1; // empty last
  if (typeof a === "bigint" || typeof b === "bigint") {
    const x = BigInt(a as never);
    const y = BigInt(b as never);
    return x < y ? -1 : x > y ? 1 : 0;
  }
  if (typeof a === "number" && typeof b === "number") return a - b;
  if (typeof a === "boolean" && typeof b === "boolean") return Number(a) - Number(b);
  return collator.compare(String(a), String(b));
}
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

export interface TableProps<T> {
  columns: Column<T>[];
  rows: T[];
  rowKey: (row: T) => Key;
  columnState?: ColumnState;
  onColumnState?: (s: ColumnState) => void;
  /** controlled sort (with onSort) */
  sort?: SortState | null;
  onSort?: (s: SortState | null) => void;
  defaultSort?: SortState | null;
  /** false when rows come sorted already (e.g. by a database query) */
  sortRows?: boolean;
  /** controlled selection (with onSelect) */
  selected?: Key[];
  onSelect?: (keys: Key[], rows: T[]) => void;
  multi?: boolean;
  /** double-click or Enter */
  onOpen?: (row: T) => void;
  /** right-click or the context-menu key; `rows` is the selection (the clicked row gets selected) */
  onContextMenu?: (at: { clientX: number; clientY: number }, rows: T[]) => void;
  rowClass?: (row: T) => string | false | null | undefined;
  rowHeight?: number;
  empty?: ReactNode;
  /** called when the user scrolls near the end (load the next page) */
  onEndReached?: () => void;
  /** text for Ctrl+C; default: tab-separated visible columns */
  copyText?: (rows: T[]) => string;
  /** scroll this row into view whenever the value changes */
  scrollTo?: Key | null;
  /** more items for the header's right-click menu */
  headerMenu?: MenuItem[];
  className?: string;
}

export function Table<T>(props: TableProps<T>) {
  const { columns, rows, rowKey, rowHeight = 24, multi, onOpen, onContextMenu, rowClass, empty, onEndReached, scrollTo, headerMenu, className } = props;

  // ── column layout ──
  const [ownLayout, setOwnLayout] = useState<ColumnState>(EMPTY_STATE);
  const layout = props.columnState ?? ownLayout;
  const setLayout = props.onColumnState ?? setOwnLayout;
  const [dragWidth, setDragWidth] = useState<{ id: string; w: number } | null>(null);
  const shown = useMemo(() => {
    const byId = new Map(columns.map((c) => [c.id, c]));
    const ordered = [...layout.order.filter((id) => byId.has(id)).map((id) => byId.get(id)!), ...columns.filter((c) => !layout.order.includes(c.id))];
    const vis = ordered.filter((c) => layout.visible[c.id] ?? !c.hidden);
    return (vis.length ? vis : ordered.slice(0, 1)).map((c) => ({
      col: c,
      width: dragWidth?.id === c.id ? dragWidth.w : (layout.widths[c.id] ?? c.width ?? 120),
    }));
  }, [columns, layout, dragWidth]);
  const totalWidth = shown.reduce((a, s) => a + s.width, 0);

  // ── sorting ──
  const [ownSort, setOwnSort] = useState<SortState | null>(props.defaultSort ?? null);
  const sort = props.onSort ? (props.sort ?? null) : ownSort;
  const setSort = props.onSort ?? setOwnSort;
  const sorted = useMemo(() => {
    if (props.sortRows === false || !sort) return rows;
    const col = columns.find((c) => c.id === sort.id);
    if (!col?.sort) return rows;
    const get = col.sort;
    const keyed = rows.map((r) => [get(r), r] as const);
    keyed.sort((a, b) => (sort.desc ? -1 : 1) * compareValues(a[0], b[0]));
    return keyed.map((k) => k[1]);
  }, [rows, sort, columns, props.sortRows]);

  // ── selection ──
  const [ownSel, setOwnSel] = useState<Key[]>([]);
  const selKeys = props.selected ?? ownSel;
  const selSet = useMemo(() => new Set(selKeys), [selKeys]);
  const anchor = useRef<Key | null>(null);
  const [focus, setFocus] = useState<Key | null>(null);
  const indexOf = useMemo(() => {
    const m = new Map<Key, number>();
    sorted.forEach((r, i) => m.set(rowKey(r), i));
    return m;
  }, [sorted, rowKey]);
  const select = useCallback(
    (keys: Key[]) => {
      const set = new Set(keys);
      const selRows = sorted.filter((r) => set.has(rowKey(r)));
      if (!props.selected) setOwnSel(keys);
      props.onSelect?.(keys, selRows);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sorted, rowKey, props.selected, props.onSelect],
  );
  const selectedRows = () => sorted.filter((r) => selSet.has(rowKey(r)));

  // ── virtualization ──
  const scrollRef = useRef<HTMLDivElement>(null);
  const [view, setView] = useState({ top: 0, height: 400 });
  const HEADER = 28;
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setView({ top: el.scrollTop, height: el.clientHeight }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const frame = useRef(0);
  const onScroll = () => {
    if (frame.current) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = 0;
      const el = scrollRef.current;
      if (el) setView({ top: el.scrollTop, height: el.clientHeight });
    });
  };
  const first = Math.max(0, Math.floor(view.top / rowHeight) - 8);
  const last = Math.min(sorted.length, Math.ceil((view.top + view.height) / rowHeight) + 8);

  // near the end: ask for more (once per row count)
  const askedAt = useRef(-1);
  useEffect(() => {
    if (!onEndReached || !sorted.length) return;
    if (last >= sorted.length - 20 && askedAt.current !== sorted.length) {
      askedAt.current = sorted.length;
      onEndReached();
    }
  }, [last, sorted.length, onEndReached]);

  const scrollIntoView = useCallback(
    (i: number) => {
      const el = scrollRef.current;
      if (!el || i < 0) return;
      const y = i * rowHeight;
      const visibleH = el.clientHeight - HEADER;
      if (y < el.scrollTop) el.scrollTop = y;
      else if (y + rowHeight > el.scrollTop + visibleH) el.scrollTop = y + rowHeight - visibleH;
    },
    [rowHeight],
  );

  useEffect(() => {
    if (scrollTo === null || scrollTo === undefined) return;
    const i = indexOf.get(scrollTo);
    if (i !== undefined) scrollIntoView(i);
    // only when the requested key changes
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scrollTo]);

  // ── interaction ──
  const clickRow = (e: React.MouseEvent, row: T) => {
    const k = rowKey(row);
    setFocus(k);
    if (multi && e.shiftKey && anchor.current !== null && indexOf.has(anchor.current)) {
      const a = indexOf.get(anchor.current)!;
      const b = indexOf.get(k)!;
      const [lo, hi] = a < b ? [a, b] : [b, a];
      select(sorted.slice(lo, hi + 1).map(rowKey));
      return;
    }
    anchor.current = k;
    if (multi && (e.ctrlKey || e.metaKey)) select(selSet.has(k) ? selKeys.filter((x) => x !== k) : [...selKeys, k]);
    else select([k]);
  };

  const menuAt = (at: { clientX: number; clientY: number }, row: T) => {
    const k = rowKey(row);
    let rowsForMenu: T[];
    if (selSet.has(k)) rowsForMenu = selectedRows();
    else {
      anchor.current = k;
      setFocus(k);
      select([k]);
      rowsForMenu = [row];
    }
    onContextMenu?.(at, rowsForMenu);
  };

  const defaultCopy = (list: T[]) =>
    list.map((r) => shown.map(({ col }) => (col.text ? col.text(r) : "")).join("\t")).join("\n");

  const onKeyDown = (e: React.KeyboardEvent) => {
    if ((e.target as HTMLElement).closest("input, textarea, select")) return;
    const cur = focus !== null && indexOf.has(focus) ? indexOf.get(focus)! : -1;
    const page = Math.max(1, Math.floor((view.height - HEADER) / rowHeight) - 1);
    let next: number | null = null;
    if (e.key === "ArrowDown") next = Math.min(sorted.length - 1, cur + 1);
    else if (e.key === "ArrowUp") next = Math.max(0, cur - 1);
    else if (e.key === "PageDown") next = Math.min(sorted.length - 1, cur + page);
    else if (e.key === "PageUp") next = Math.max(0, cur - page);
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = sorted.length - 1;
    else if (e.key === "Enter" && cur >= 0) {
      e.preventDefault();
      onOpen?.(sorted[cur]);
      return;
    } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "a" && multi) {
      e.preventDefault();
      select(sorted.map(rowKey));
      return;
    } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "c") {
      const list = selectedRows();
      if (list.length) {
        e.preventDefault();
        copy((props.copyText ?? defaultCopy)(list), list.length === 1 ? "row" : `${list.length} rows`);
      }
      return;
    } else if ((e.key === "ContextMenu" || (e.shiftKey && e.key === "F10")) && cur >= 0) {
      e.preventDefault();
      const el = scrollRef.current;
      const box = el?.getBoundingClientRect();
      const y = (box?.top ?? 0) + HEADER + cur * rowHeight - (el?.scrollTop ?? 0) + rowHeight;
      menuAt({ clientX: (box?.left ?? 0) + 40, clientY: y }, sorted[cur]);
      return;
    }
    if (next === null || next < 0 || !sorted.length) return;
    e.preventDefault();
    const k = rowKey(sorted[next]);
    setFocus(k);
    if (multi && e.shiftKey && anchor.current !== null && indexOf.has(anchor.current)) {
      const a = indexOf.get(anchor.current)!;
      const [lo, hi] = a < next ? [a, next] : [next, a];
      select(sorted.slice(lo, hi + 1).map(rowKey));
    } else {
      anchor.current = k;
      select([k]);
    }
    scrollIntoView(next);
  };

  // ── header: sort, resize, reorder, show/hide ──
  const resizing = useRef(false);
  const startResize = (e: React.PointerEvent, id: string, width: number, min: number) => {
    e.preventDefault();
    e.stopPropagation();
    resizing.current = true;
    const x0 = e.clientX;
    const target = e.currentTarget as HTMLElement;
    target.setPointerCapture(e.pointerId);
    let w = width;
    const move = (ev: PointerEvent) => {
      w = Math.max(min, Math.round(width + ev.clientX - x0));
      setDragWidth({ id, w });
    };
    const up = () => {
      target.removeEventListener("pointermove", move);
      target.removeEventListener("pointerup", up);
      resizing.current = false;
      setDragWidth(null);
      setLayout({ ...layout, widths: { ...layout.widths, [id]: w } });
    };
    target.addEventListener("pointermove", move);
    target.addEventListener("pointerup", up);
  };

  const [dropAt, setDropAt] = useState<{ id: string; after: boolean } | null>(null);
  const allIds = () => {
    const known = layout.order.filter((id) => columns.some((c) => c.id === id));
    return [...known, ...columns.map((c) => c.id).filter((id) => !known.includes(id))];
  };
  const move = (from: string, to: string, after: boolean) => {
    if (from === to) return;
    const ids = allIds().filter((id) => id !== from);
    const at = ids.indexOf(to) + (after ? 1 : 0);
    ids.splice(at, 0, from);
    setLayout({ ...layout, order: ids });
  };

  const headerMenuItems = (): MenuItem[] => [
    { header: "Columns" },
    ...allIds()
      .map((id) => columns.find((c) => c.id === id)!)
      .map(
        (c): MenuItem => ({
          label: c.label || c.id,
          checked: layout.visible[c.id] ?? !c.hidden,
          keepOpen: false,
          onSelect: () => {
            const on = layout.visible[c.id] ?? !c.hidden;
            if (on && shown.length <= 1) return;
            setLayout({ ...layout, visible: { ...layout.visible, [c.id]: !on } });
          },
        }),
      ),
    { separator: true },
    { label: "Reset columns", onSelect: () => setLayout(EMPTY_STATE) },
    ...(headerMenu?.length ? [{ separator: true } as MenuItem, ...headerMenu] : []),
  ];

  const clickHeader = (c: Column<T>) => {
    if (!c.sort) return;
    if (sort?.id !== c.id) setSort({ id: c.id, desc: c.align === "right" });
    else if (sort.desc === (c.align === "right")) setSort({ id: c.id, desc: !sort.desc });
    else setSort(null);
  };

  const cellStyle = (i: number, width: number) => (i === shown.length - 1 ? { flex: "1 0 auto", width, minWidth: width } : { width, flex: "none" as const });

  const body: ReactNode[] = [];
  for (let i = first; i < last; i++) {
    const row = sorted[i];
    const k = rowKey(row);
    body.push(
      <div
        key={k}
        className={cx("sm-tr", selSet.has(k) && "selected", focus === k && "focused", i % 2 === 1 && "odd", rowClass?.(row))}
        style={{ top: i * rowHeight, height: rowHeight }}
        onMouseDown={(e) => e.button === 0 && clickRow(e, row)}
        onDoubleClick={() => onOpen?.(row)}
        onContextMenu={(e) => {
          if (!onContextMenu) return;
          e.preventDefault();
          menuAt(e, row);
        }}
      >
        {shown.map(({ col, width }, ci) => (
          <div key={col.id} className={cx("sm-td", col.align === "right" && "num", col.mono && "mono")} style={cellStyle(ci, width)} title={col.text?.(row)}>
            {col.render ? col.render(row) : col.text?.(row)}
          </div>
        ))}
      </div>,
    );
  }

  return (
    <div className={cx("sm-table", className)} tabIndex={0} onKeyDown={onKeyDown}>
      <div className="sm-table-scroll" ref={scrollRef} onScroll={onScroll}>
        <div className="sm-table-inner" style={{ width: totalWidth }}>
          <div
            className="sm-thead"
            onContextMenu={(e) => {
              e.preventDefault();
              openMenu(e, headerMenuItems());
            }}
          >
            {shown.map(({ col, width }, ci) => (
              <div
                key={col.id}
                className={cx(
                  "sm-th",
                  col.align === "right" && "num",
                  !!col.sort && "sortable",
                  dropAt?.id === col.id && (dropAt.after ? "drop-after" : "drop-before"),
                )}
                style={cellStyle(ci, width)}
                title={col.title ?? col.label}
                draggable
                onDragStart={(e) => {
                  if (resizing.current) return e.preventDefault();
                  e.dataTransfer.setData("text/x-sm-column", col.id);
                  e.dataTransfer.effectAllowed = "move";
                }}
                onDragOver={(e) => {
                  if (!e.dataTransfer.types.includes("text/x-sm-column")) return;
                  e.preventDefault();
                  const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
                  const after = e.clientX > r.left + r.width / 2;
                  if (dropAt?.id !== col.id || dropAt.after !== after) setDropAt({ id: col.id, after });
                }}
                onDragLeave={() => setDropAt((d) => (d?.id === col.id ? null : d))}
                onDrop={(e) => {
                  e.preventDefault();
                  const from = e.dataTransfer.getData("text/x-sm-column");
                  setDropAt(null);
                  if (from) move(from, col.id, dropAt?.after ?? false);
                }}
                onDragEnd={() => setDropAt(null)}
                onClick={() => clickHeader(col)}
              >
                <span className="sm-th-label">{col.label}</span>
                {sort?.id === col.id && (sort.desc ? <ChevronDown size={12} /> : <ChevronUp size={12} />)}
                <span className="sm-th-resize" onPointerDown={(e) => startResize(e, col.id, width, col.minWidth ?? 40)} onClick={(e) => e.stopPropagation()} draggable={false} onDragStart={(e) => e.preventDefault()} />
              </div>
            ))}
          </div>
          <div className="sm-tbody" style={{ height: sorted.length * rowHeight }}>
            {body}
          </div>
        </div>
      </div>
      {sorted.length === 0 && empty && <div className="sm-table-empty">{empty}</div>}
    </div>
  );
}
