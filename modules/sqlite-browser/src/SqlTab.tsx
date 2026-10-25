// Run SQL: an editor with highlighting above the results, a cancel button, history.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { CircleAlert, CircleCheck, Clock, Copy, LoaderCircle, LockOpen, Play, Square, Trash, TriangleAlert, X } from "lucide-react";
import {
  Button,
  IconButton,
  Message,
  Popover,
  Select,
  Split,
  Table,
  Toolbar,
  cx,
  errorText,
  formatNumber,
  openMenu,
  pluralize,
  sm,
  useStored,
  type Cell,
  type Column,
  type QueryResult,
} from "../../shared";
import { CellView, cellTitle, highlightSql } from "./cells";
import { affinity, guessTable, hasPartial, isBigInt, isBlob, isInterrupted, isNumeric, isReadOnlyError, mayChangeSchema, toInserts, toJson, toTsv, stripComments } from "./sql";
import { copyOut, useDb, type SqlRequest } from "./state";

interface HistoryEntry {
  sql: string;
  at: number;
  file: string;
  ok: boolean;
  rows?: number;
  changes?: number;
}

type Outcome =
  | { kind: "ok"; res: QueryResult; sql: string; n: number }
  | { kind: "error"; message: string; sql: string; n: number }
  | { kind: "cancelled"; sql: string; n: number; ms: number };

const MAX_ROWS = [
  { value: "1000", label: "1,000 rows" },
  { value: "10000", label: "10,000 rows" },
  { value: "50000", label: "50,000 rows" },
];
const MAX_HISTORY = 50;
const WRITES = /\b(insert|update|delete|replace|create|drop|alter|vacuum|reindex|analyze)\b/i;

export function SqlTab({ initial, onText, request }: { initial: string; onText: (s: string) => void; request: SqlRequest | null }) {
  const { db, bump, forgetCounts, reloadSchema, setWritable, narrow } = useDb();
  const [text, setText] = useState(initial);
  const textRef = useRef(text);
  textRef.current = text;
  // saved with the pane (debounced), only when it changed
  const saved = useRef(initial);
  const onTextRef = useRef(onText);
  onTextRef.current = onText;
  useEffect(() => {
    if (text === saved.current) return;
    const t = setTimeout(() => {
      saved.current = text;
      onTextRef.current(text);
    }, 600);
    return () => clearTimeout(t);
  }, [text]);

  const [maxRows, setMaxRows] = useStored<string>("maxRows", "1000");
  const [editorH, setEditorH] = useStored<number>("sqlEditorHeight", 170);
  const [history, setHistory] = useStored<HistoryEntry[]>("history", []);
  const [running, setRunning] = useState<number | null>(null);
  const runningRef = useRef(false);
  const [now, setNow] = useState(0);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const runN = useRef(0);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const [histAnchor, setHistAnchor] = useState<HTMLElement | null>(null);

  useEffect(() => {
    if (running === null) return;
    const t = setInterval(() => setNow(performance.now()), 100);
    return () => clearInterval(t);
  }, [running]);

  const run = useCallback(
    async (given?: string) => {
      const ta = taRef.current;
      const sel = ta && ta.selectionStart !== ta.selectionEnd ? ta.value.slice(ta.selectionStart, ta.selectionEnd) : null;
      const sql = given ?? sel ?? textRef.current;
      if (!stripComments(sql).trim() || runningRef.current) return;
      runningRef.current = true;
      const started = performance.now();
      setRunning(started);
      setNow(started);
      const n = ++runN.current;
      const remember = (e: Omit<HistoryEntry, "sql" | "at" | "file">) =>
        setHistory((list) => {
          const s = sql.trim();
          return [{ sql: s, at: Date.now(), file: db.file, ...e }, ...list.filter((h) => h.sql !== s)].slice(0, MAX_HISTORY);
        });
      try {
        const res = await sm.sqlite.query(db.id, sql, [], { maxRows: +maxRows });
        setOutcome({ kind: "ok", res, sql, n });
        remember({ ok: true, rows: res.returnedRows ? res.rows.length : undefined, changes: res.changes || undefined });
        if (res.changes > 0) {
          forgetCounts();
          bump();
        }
        if (mayChangeSchema(sql)) reloadSchema();
      } catch (e) {
        const m = errorText(e);
        if (isInterrupted(m)) setOutcome({ kind: "cancelled", sql, n, ms: performance.now() - started });
        else setOutcome({ kind: "error", message: m, sql, n });
        remember({ ok: false });
        // statements before the failing one did run
        if (db.writable && WRITES.test(stripComments(sql))) {
          forgetCounts();
          bump();
          if (mayChangeSchema(sql)) reloadSchema();
        }
      } finally {
        runningRef.current = false;
        setRunning(null);
      }
    },
    [db.id, db.file, db.writable, maxRows, setHistory, forgetCounts, bump, reloadSchema],
  );

  const cancel = () => sm.sqlite.interrupt(db.id).catch(() => {});

  // F5 runs too (the editor handles it itself while focused)
  const rootRef = useRef<HTMLDivElement>(null);
  const runRef = useRef(run);
  runRef.current = run;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "F5" || !rootRef.current?.offsetParent || (e.target as HTMLElement).closest?.(".sqlb-ta")) return;
      e.preventDefault();
      runRef.current();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // "Query in SQL tab" from elsewhere: append the statement, select it, maybe run it
  const lastReq = useRef(0);
  useEffect(() => {
    if (!request || request.n === lastReq.current) return;
    lastReq.current = request.n;
    const cur = textRef.current;
    let start: number;
    let next: string;
    if (cur.trimEnd().endsWith(request.text)) {
      next = cur;
      start = cur.trimEnd().length - request.text.length;
    } else {
      const base = cur.trim() ? cur.replace(/\s*$/, "") + "\n\n" : "";
      next = base + request.text;
      start = base.length;
    }
    setText(next);
    requestAnimationFrame(() => {
      const ta = taRef.current;
      if (!ta) return;
      ta.focus();
      ta.setSelectionRange(start, start + request.text.length);
      ta.scrollTop = ta.scrollHeight;
      ta.dispatchEvent(new Event("scroll"));
      if (request.run) run(request.text);
    });
  }, [request, run]);

  const loadSql = (sql: string) => {
    const ta = taRef.current;
    setHistAnchor(null);
    if (!ta) return setText(sql);
    ta.focus();
    ta.select();
    // through the edit history, so Ctrl+Z brings the previous text back
    if (!document.execCommand("insertText", false, sql)) setText(sql);
  };

  const elapsed = running !== null ? now - running : 0;

  return (
    <div className="sqlb-col" ref={rootRef}>
      <Toolbar>
        {running !== null ? (
          <Button small kind="danger" onClick={cancel} title="Stop the query (interrupt)">
            <Square size={11} /> Cancel
          </Button>
        ) : (
          <Button small kind="primary" onClick={() => run()} title="Run the selection, or everything (Ctrl+Enter)">
            <Play size={11} /> Run
          </Button>
        )}
        {!narrow && <span className="sqlb-hint">Ctrl+Enter runs the selection, or everything</span>}
        <div className="sm-grow" />
        <Select value={maxRows} onChange={setMaxRows} options={MAX_ROWS} title="Show at most this many rows" />
        <IconButton title="History" on={!!histAnchor} onClick={(e) => setHistAnchor(histAnchor ? null : e.currentTarget)}>
          <Clock size={14} />
        </IconButton>
      </Toolbar>
      {histAnchor && (
        <Popover anchor={histAnchor} onClose={() => setHistAnchor(null)} width={Math.min(420, window.innerWidth - 16)}>
          <div className="sqlb-hist-head">
            <h4>Recent queries</h4>
            <div className="sm-grow" />
            {history.length > 0 && (
              <Button small kind="subtle" onClick={() => setHistory([])}>
                <Trash size={12} /> Clear
              </Button>
            )}
          </div>
          {history.length ? (
            <div className="sqlb-hist">
              {history.map((h) => (
                <button key={h.at + h.sql} type="button" className="sqlb-hist-item" onClick={() => loadSql(h.sql)} title={h.sql}>
                  <code className="sqlb-hist-sql">{h.sql}</code>
                  <span className="sqlb-hist-meta">
                    {h.ok ? <CircleCheck size={11} className="sqlb-ok" /> : <CircleAlert size={11} className="sm-danger-text" />}
                    {h.file} · {new Date(h.at).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}
                    {h.rows !== undefined && ` · ${pluralize(h.rows, "row")}`}
                    {h.changes ? ` · ${formatNumber(h.changes)} changed` : ""}
                  </span>
                </button>
              ))}
            </div>
          ) : (
            <div className="sqlb-note">Queries you run show up here.</div>
          )}
        </Popover>
      )}
      <Split
        direction="vertical"
        size={editorH}
        onSize={setEditorH}
        min={70}
        first={<SqlEditor value={text} onChange={setText} onRun={() => run()} taRef={taRef} />}
        second={<Results outcome={outcome} running={running !== null} elapsed={elapsed} onAllow={() => setWritable(true)} writable={db.writable} copied={db.copied} />}
      />
      <div className="sm-footer">
        <Status outcome={outcome} running={running !== null} elapsed={elapsed} />
      </div>
    </div>
  );
}

function Status({ outcome, running, elapsed }: { outcome: Outcome | null; running: boolean; elapsed: number }) {
  if (running)
    return (
      <>
        <LoaderCircle size={12} className="sm-spin" /> Running… {fmtMs(elapsed)}
      </>
    );
  if (!outcome) return <span>Ready</span>;
  if (outcome.kind === "cancelled")
    return (
      <>
        <X size={12} /> Cancelled after {fmtMs(outcome.ms)}
      </>
    );
  if (outcome.kind === "error")
    return (
      <span className="sm-danger-text sqlb-status-err">
        <CircleAlert size={12} /> Error
      </span>
    );
  const r = outcome.res;
  const parts: string[] = [];
  if (r.returnedRows) parts.push(r.truncated ? `first ${formatNumber(r.rows.length)} rows` : pluralize(r.rows.length, "row"));
  if (r.changes) parts.push(`${pluralize(r.changes, "row")} changed`);
  if (r.changes && r.lastInsertRowid) parts.push(`last insert rowid ${r.lastInsertRowid}`);
  if (r.statements > 1) parts.push(pluralize(r.statements, "statement"));
  parts.push(fmtMs(r.elapsedMs));
  return (
    <>
      {r.truncated ? <TriangleAlert size={12} className="sm-warning-text" /> : <CircleCheck size={12} className="sqlb-ok" />}
      <span className="sm-ellipsis">{parts.join(" · ")}</span>
    </>
  );
}

const fmtMs = (ms: number) => (ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)} s`);

// ── editor ──────────────────────────────────────────────────────────────

function SqlEditor({ value, onChange, onRun, taRef }: { value: string; onChange: (v: string) => void; onRun: () => void; taRef: React.RefObject<HTMLTextAreaElement | null> }) {
  const preRef = useRef<HTMLPreElement>(null);
  const gutterRef = useRef<HTMLDivElement>(null);
  const lines = useMemo(() => value.split("\n").length, [value]);
  const numbers = useMemo(() => Array.from({ length: lines }, (_, i) => i + 1).join("\n"), [lines]);
  const hl = useMemo(() => highlightSql(value), [value]);

  const sync = useCallback(() => {
    const ta = taRef.current;
    if (!ta) return;
    if (preRef.current) {
      preRef.current.scrollTop = ta.scrollTop;
      preRef.current.scrollLeft = ta.scrollLeft;
    }
    if (gutterRef.current) gutterRef.current.scrollTop = ta.scrollTop;
  }, [taRef]);
  useLayoutEffect(sync, [value, sync]);

  const insert = (s: string) => {
    if (!document.execCommand("insertText", false, s)) {
      const ta = taRef.current!;
      ta.setRangeText(s, ta.selectionStart, ta.selectionEnd, "end");
      onChange(ta.value);
    }
  };

  /** Replace whole lines of the selection with `fn(lines)`, keeping them selected. */
  const editLines = (fn: (lines: string[]) => string[]) => {
    const ta = taRef.current!;
    const v = ta.value;
    const s = ta.selectionStart;
    let e = ta.selectionEnd;
    if (e > s && v[e - 1] === "\n") e--;
    const ls = v.lastIndexOf("\n", s - 1) + 1;
    const nl = v.indexOf("\n", e);
    const le = nl < 0 ? v.length : nl;
    const out = fn(v.slice(ls, le).split("\n")).join("\n");
    ta.setSelectionRange(ls, le);
    insert(out);
    ta.setSelectionRange(ls, ls + out.length);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    const ta = e.currentTarget;
    if (((e.ctrlKey || e.metaKey) && e.key === "Enter") || e.key === "F5") {
      e.preventDefault();
      onRun();
    } else if (e.key === "Tab") {
      e.preventDefault();
      if (!e.shiftKey && ta.selectionStart === ta.selectionEnd) insert("  ");
      else editLines((ls) => ls.map((l) => (e.shiftKey ? l.replace(/^( {1,2}|\t)/, "") : "  " + l)));
    } else if (e.key === "Enter" && !e.shiftKey && !e.ctrlKey && !e.altKey) {
      const ls = ta.value.lastIndexOf("\n", ta.selectionStart - 1) + 1;
      const indent = /^[ \t]*/.exec(ta.value.slice(ls, ta.selectionStart))![0];
      if (indent) {
        e.preventDefault();
        insert("\n" + indent);
      }
    } else if ((e.ctrlKey || e.metaKey) && e.key === "/") {
      e.preventDefault();
      editLines((ls) => {
        const on = ls.filter((l) => l.trim()).every((l) => /^\s*--/.test(l));
        return ls.map((l) => (!l.trim() ? l : on ? l.replace(/^(\s*)-- ?/, "$1") : "-- " + l));
      });
    }
  };

  return (
    <div className="sqlb-sqled">
      <div className="sqlb-gutter" ref={gutterRef} aria-hidden>
        <pre>{numbers}</pre>
      </div>
      <div className="sqlb-code">
        <pre className="sqlb-hl" ref={preRef} aria-hidden>
          {hl}
          {"\n "}
        </pre>
        <textarea
          ref={taRef}
          className="sqlb-ta"
          wrap="off"
          spellCheck={false}
          autoCapitalize="off"
          autoComplete="off"
          value={value}
          placeholder={"SELECT * FROM …\n\nCtrl+Enter runs the selection, or everything. Ctrl+/ comments lines."}
          onChange={(e) => onChange(e.target.value)}
          onScroll={sync}
          onKeyDown={onKeyDown}
        />
      </div>
    </div>
  );
}

// ── results ─────────────────────────────────────────────────────────────

interface ResRow {
  i: number;
  cells: Cell[];
}

function Results({
  outcome,
  running,
  elapsed,
  onAllow,
  writable,
  copied,
}: {
  outcome: Outcome | null;
  running: boolean;
  elapsed: number;
  onAllow: () => void;
  writable: boolean;
  copied: boolean;
}) {
  if (!outcome)
    return running ? (
      <Message icon={<LoaderCircle size={20} className="sm-spin" />} title={`Running… ${fmtMs(elapsed)}`} />
    ) : (
      <Message icon={<Play size={20} />} title="Run a query to see its results here">
        Statements run one after another; the rows of the last one that returns rows are shown.
      </Message>
    );
  return (
    <div className={cx("sqlb-col", running && "sqlb-stale")}>
      {running && <div className="sqlb-progress" />}
      {outcome.kind === "error" ? (
        <SqlError message={outcome.message} onAllow={onAllow} writable={writable} copied={copied} />
      ) : outcome.kind === "cancelled" ? (
        <Message icon={<X size={20} />} title="Query cancelled" />
      ) : outcome.res.returnedRows ? (
        <ResultTable key={outcome.n} res={outcome.res} sql={outcome.sql} />
      ) : (
        <Message icon={<CircleCheck size={20} className="sqlb-ok" />} title="Done">
          {outcome.res.changes > 0
            ? `${pluralize(outcome.res.changes, "row")} changed${outcome.res.lastInsertRowid ? ` · last insert rowid ${outcome.res.lastInsertRowid}` : ""}`
            : `${pluralize(outcome.res.statements, "statement")} ran; no rows returned`}
        </Message>
      )}
    </div>
  );
}

function SqlError({ message, onAllow, writable, copied }: { message: string; onAllow: () => void; writable: boolean; copied: boolean }) {
  const ro = isReadOnlyError(message) && !writable;
  return (
    <div className="sm-scroll">
      <div className={cx("sqlb-sqlerr", ro && "ro")}>
        <div className="sqlb-sqlerr-title">
          {ro ? <LockOpen size={15} /> : <CircleAlert size={15} />}
          {ro ? "The database is open read-only" : "The query failed"}
        </div>
        <div className="sqlb-sqlerr-msg mono sm-selectable">{message}</div>
        {ro && (
          <>
            <p>
              This statement would change the database. To run it, turn on <b>Allow changes</b>
              {copied ? " (the changes go to the temporary copy, not the original file)" : " (the file on disk is changed right away; there is no undo)"}.
            </p>
            <Button small onClick={onAllow}>
              <LockOpen size={12} /> Allow changes…
            </Button>
          </>
        )}
      </div>
    </div>
  );
}

function ResultTable({ res, sql }: { res: QueryResult; sql: string }) {
  const rows = useMemo<ResRow[]>(() => res.rows.map((cells, i) => ({ i, cells })), [res]);
  const names = useMemo(() => res.columns.map((c) => c.name), [res]);
  const columns = useMemo<Column<ResRow>[]>(() => {
    return res.columns.map((c, ci) => {
      const sample = res.rows.slice(0, 50).map((r) => r[ci]);
      const nonNull = sample.filter((v) => v !== null);
      const right = (c.declType ? isNumeric(affinity(c.declType)) : false) || (nonNull.length > 0 && nonNull.every((v) => typeof v === "number" || isBigInt(v)));
      // a column of whole numbers sorts exactly (big integers too); anything else as numbers/text
      // (the table compares BigInts only with BigInts, so never mix them with other values)
      const integral = res.rows.every((r) => {
        const v = r[ci];
        return v === null || isBigInt(v) || (typeof v === "number" && Number.isSafeInteger(v));
      });
      let chars = c.name.length + 3;
      for (const v of sample) {
        const len = v === null ? 4 : typeof v === "number" ? String(v).length : typeof v === "string" ? Math.min(v.length, 48) : isBlob(v) ? 22 : isBigInt(v) ? v.$int.length : 40;
        if (len > chars) chars = len;
      }
      return {
        id: `c${ci}`,
        label: c.name,
        title: `${c.name}${c.declType ? ` · ${c.declType}` : ""}`,
        width: Math.max(64, Math.min(340, Math.round(chars * 7.2 + 24))),
        minWidth: 48,
        align: right ? "right" : undefined,
        sort: (r: ResRow) => {
          const v = r.cells[ci];
          if (v === null || typeof v === "string") return v;
          if (typeof v === "number") return integral && Number.isSafeInteger(v) ? BigInt(v) : v;
          if ("$int" in v) return integral ? BigInt(v.$int) : Number(v.$int);
          if ("$real" in v) return Number(v.$real.replace(/inf/i, "Infinity"));
          if ("$text" in v) return v.$text;
          return v.$blob;
        },
        text: (r: ResRow) => cellTitle(r.cells[ci]) ?? "",
        render: (r: ResRow) => (
          <div className={cx("sqlb-cell", right && "num")}>
            <CellView c={r.cells[ci]} />
          </div>
        ),
      };
    });
  }, [res]);

  const copyRows = (list: ResRow[], fmt: "tsv" | "tsvh" | "json" | "insert") => {
    const data = list.map((r) => r.cells);
    const text =
      fmt === "json" ? toJson(names, data) : fmt === "insert" ? toInserts(guessTable(sql) ?? "result", names, data) : toTsv(names, data, fmt === "tsvh");
    copyOut(text, list.length === 1 ? "1 row" : `${formatNumber(list.length)} rows`, data.some(hasPartial));
  };

  return (
    <>
      {res.truncated && (
        <div className="sqlb-truncated">
          <TriangleAlert size={13} /> Showing the first {formatNumber(res.rows.length)} rows. Raise the limit in the toolbar, or add a LIMIT / WHERE.
        </div>
      )}
      <Table<ResRow>
        className="sqlb-grid"
        columns={columns}
        rows={rows}
        rowKey={(r) => r.i}
        multi
        copyText={(list) =>
          toTsv(
            names,
            list.map((r) => r.cells),
            false,
          )
        }
        onContextMenu={(at, list) =>
          openMenu(at, [
            { label: list.length === 1 ? "Copy row (TSV)" : `Copy ${formatNumber(list.length)} rows (TSV)`, icon: <Copy size={14} />, hint: "Ctrl+C", onSelect: () => copyRows(list, "tsv") },
            { label: "Copy as TSV with header", onSelect: () => copyRows(list, "tsvh") },
            { label: "Copy as JSON", onSelect: () => copyRows(list, "json") },
            { label: "Copy as INSERT statements", onSelect: () => copyRows(list, "insert") },
            { separator: true },
            { label: "Copy all rows (TSV with header)", onSelect: () => copyRows(rows, "tsvh") },
          ])
        }
        empty="No rows"
      />
    </>
  );
}
