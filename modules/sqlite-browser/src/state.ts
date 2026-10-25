// What every part of an open database view shares.
import { createContext, useContext, useLayoutEffect, useState, type RefObject } from "react";
import { errorText, sm, type DbInfo, type SchemaObject } from "../../shared";

export type TabId = "data" | "structure" | "sql" | "info";

export type CountState = { n: number } | { loading: true } | { error: string };

/** Saved with the pane: the database comes back (read-only) after a restart. */
export type PaneState = {
  path: string | null;
  copy: boolean;
  table: string | null;
  tab: TabId;
  sql: string;
};

export interface Recent {
  path: string;
  file: string;
  at: number;
}

export interface SqlRequest {
  text: string;
  run: boolean;
  /** changes every request, so the same text can be sent twice */
  n: number;
}

export interface DbApi {
  db: DbInfo;
  schema: SchemaObject[];
  /** by lower-case name */
  byName: Map<string, SchemaObject>;
  counts: Record<string, CountState>;
  /** count a table's rows (once, unless forced); results land in `counts` */
  wantCount(name: string, force?: boolean): void;
  /** drop cached counts (all when no names), e.g. after rows were added or deleted */
  forgetCounts(names?: string[]): void;
  /** bumped after anything may have changed the data */
  version: number;
  bump(): void;
  reloadSchema(): Promise<void>;
  /** turn "Allow changes" on (asks first) or off; true when it happened */
  setWritable(on: boolean): Promise<boolean>;
  narrow: boolean;
  selected: SchemaObject | null;
  select(name: string, tab?: TabId): void;
  tab: TabId;
  /** put SQL in the SQL tab (appended to what's there) and optionally run it */
  sendToSql(text: string, run?: boolean): void;
}

export const DbContext = createContext<DbApi | null>(null);

export function useDb(): DbApi {
  const v = useContext(DbContext);
  if (!v) throw new Error("useDb outside a database view");
  return v;
}

/** An element's width, kept current. */
export function useWidth(ref: RefObject<HTMLElement | null>, initial = window.innerWidth): number {
  const [w, setW] = useState(initial);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setW(el.clientWidth));
    ro.observe(el);
    setW(el.clientWidth);
    return () => ro.disconnect();
  }, [ref]);
  return w;
}

export const countText = (c: CountState | undefined): string | null => (c && "n" in c ? c.n.toLocaleString() : null);

const compact = new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 });
export const countShort = (n: number) => (n < 100_000 ? n.toLocaleString() : compact.format(n));

export function dirOf(path: string): string {
  const i = Math.max(path.lastIndexOf("\\"), path.lastIndexOf("/"));
  return i > 0 ? path.slice(0, i) : "";
}

export function fileOf(path: string): string {
  const i = Math.max(path.lastIndexOf("\\"), path.lastIndexOf("/"));
  return i >= 0 ? path.slice(i + 1) : path;
}

/** Put text on the clipboard and say so (warning when values were cut short). */
export async function copyOut(text: string, what: string, partial = false) {
  try {
    await sm.clipboard.writeText(text);
    sm.ui.notify(partial ? `Copied ${what}; long text and blobs over 256 bytes are cut short` : `Copied ${what}`, partial ? "warning" : "success");
  } catch (e) {
    sm.ui.notify(`Couldn't copy: ${errorText(e)}`, "error");
  }
}