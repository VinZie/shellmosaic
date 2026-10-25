// Shared building blocks for module panes. Keep modules visually consistent by
// using these together with the primitives in styles/app.css (.toolbar, .btn,
// .icon-btn, .input, .table, .empty-state, .module, .module-scroll, …).
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Icon } from "../lib/icons";
import { cx } from "../lib/util";
import { leaves } from "../state/layout";
import { useModel } from "../state/store";
import { useUi } from "../state/ui";
import type { Pane } from "../state/model";

/**
 * setInterval that only runs while `enabled` (e.g. the pane is visible). Runs once immediately.
 * Ticks are skipped while the window is hidden (minimized), with one catch-up run when it's back.
 */
export function useInterval(fn: () => void, ms: number, enabled = true) {
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(() => {
    if (!enabled) return;
    ref.current();
    const t = setInterval(() => !document.hidden && ref.current(), Math.max(250, ms));
    const onVisible = () => !document.hidden && ref.current();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(t);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [ms, enabled]);
}

/**
 * The live working directory of the terminal the user is using in this tab
 * (last focused terminal, else the first terminal). Updates as they `cd`.
 */
export function useTabCwd(tabId: string): string | undefined {
  const root = useModel((s) => s.model.tabs[tabId]?.root ?? null);
  const panes = useModel((s) => s.model.panes);
  const last = useUi((s) => s.lastTerminal[tabId]);
  const cwds = useUi((s) => s.cwds);
  return useMemo(() => {
    const ids = [last, ...leaves(root)].filter((id): id is string => !!id && panes[id]?.module === "terminal");
    for (const id of ids) if (cwds[id] ?? panes[id]?.meta.cwd) return cwds[id] ?? panes[id]?.meta.cwd;
    return undefined;
  }, [root, panes, last, cwds]);
}

/**
 * Directory a folder-based module (files, git, tasks) should show: follows the
 * tab's terminal when `pane.meta.follow !== false`, else `pane.meta.path`.
 */
export function useModuleDir(pane: Pane, tabId: string, fallback?: string): { dir: string | undefined; following: boolean } {
  const cwd = useTabCwd(tabId);
  const following = pane.meta.follow !== false;
  const dir = following ? cwd ?? pane.meta.path ?? fallback : pane.meta.path ?? cwd ?? fallback;
  return { dir, following };
}

export interface Column<T> {
  key: string;
  label: string;
  width?: number | string;
  num?: boolean;
  render?: (row: T) => ReactNode;
  /** value used for sorting (defaults to row[key]) */
  value?: (row: T) => string | number;
}

/** Sortable table using the `.table` styles. Click a header to sort, again to reverse. */
export function DataTable<T>({
  columns,
  rows,
  rowKey,
  selected,
  onSelect,
  onOpen,
  onRowMenu,
  initialSort,
  empty,
}: {
  columns: Column<T>[];
  rows: T[];
  rowKey: (row: T) => string | number;
  selected?: string | number | null;
  onSelect?: (row: T) => void;
  onOpen?: (row: T) => void;
  onRowMenu?: (row: T, e: React.MouseEvent) => void;
  initialSort?: { key: string; desc?: boolean };
  empty?: ReactNode;
}) {
  const [sort, setSort] = useState(initialSort ?? null);
  const sorted = useMemo(() => {
    if (!sort) return rows;
    const col = columns.find((c) => c.key === sort.key);
    if (!col) return rows;
    const val = col.value ?? ((r: T) => (r as Record<string, unknown>)[col.key] as string | number);
    return [...rows].sort((a, b) => {
      const va = val(a);
      const vb = val(b);
      const c = typeof va === "number" && typeof vb === "number" ? va - vb : String(va ?? "").localeCompare(String(vb ?? ""), undefined, { numeric: true });
      return sort.desc ? -c : c;
    });
  }, [rows, sort, columns]);
  return (
    <div className="module-scroll">
      <table className="table">
        <thead>
          <tr>
            {columns.map((c) => (
              <th
                key={c.key}
                className={cx(c.num && "num")}
                style={c.width !== undefined ? { width: c.width } : undefined}
                onClick={() => setSort((s) => (s?.key === c.key ? { key: c.key, desc: !s.desc } : { key: c.key, desc: !!c.num }))}
              >
                {c.label}
                {sort?.key === c.key && <Icon name={sort.desc ? "chevron-down" : "chevron-up"} size={11} style={{ marginLeft: 3, verticalAlign: -1 }} />}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {sorted.map((r) => {
            const k = rowKey(r);
            return (
              <tr
                key={k}
                className={cx(selected === k && "selected")}
                onClick={() => onSelect?.(r)}
                onDoubleClick={() => onOpen?.(r)}
                onContextMenu={(e) => {
                  if (!onRowMenu) return;
                  e.preventDefault();
                  e.stopPropagation();
                  onSelect?.(r);
                  onRowMenu(r, e);
                }}
              >
                {columns.map((c) => (
                  <td key={c.key} className={cx(c.num && "num")}>
                    {c.render ? c.render(r) : String((r as Record<string, unknown>)[c.key] ?? "")}
                  </td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
      {rows.length === 0 && empty && <div className="empty-state">{empty}</div>}
    </div>
  );
}

/** Inline error/empty message for a module. */
export function ModuleMessage({ icon = "info", title, children }: { icon?: string; title: string; children?: ReactNode }) {
  return (
    <div className="empty-state">
      <Icon name={icon} size={26} />
      <h2 style={{ fontSize: 14 }}>{title}</h2>
      {children}
    </div>
  );
}

/** Toolbar search box with an icon. */
export function SearchBox({ value, onChange, placeholder = "Filter" }: { value: string; onChange: (v: string) => void; placeholder?: string }) {
  return (
    <div className="search-box">
      <Icon name="search" size={13} />
      <input value={value} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} onKeyDown={(e) => e.key === "Escape" && onChange("")} />
    </div>
  );
}
