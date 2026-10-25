// Editing values: the inline cell editor, a larger editor in a dialog, and the new-row form.
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { KeyRound } from "lucide-react";
import { cx, errorText, openModal, type DbColumn, type Param, type SchemaObject } from "../../shared";
import { highlightJson, prettyJson } from "./cells";
import { affinity, inputValue, qi } from "./sql";

const lineCount = (s: string) => s.split("\n").length;

/**
 * Floats over its grid cell (positioned against the row, so the cell's clipping
 * doesn't cut it). Enter saves, Shift+Enter adds a line, Esc cancels; clicking
 * elsewhere saves a changed value.
 */
export function CellEditor({
  value,
  changed,
  mono,
  saving,
  error,
  onChange,
  onSave,
  onNull,
  onCancel,
}: {
  value: string;
  changed: boolean;
  mono: boolean;
  saving: boolean;
  error: string | null;
  onChange: (v: string) => void;
  onSave: () => void;
  onNull: () => void;
  onCancel: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const [pos, setPos] = useState<{ left: number; width: number } | null>(null);
  useLayoutEffect(() => {
    const td = ref.current?.closest(".sm-td") as HTMLElement | null;
    if (td) setPos({ left: td.offsetLeft - 1, width: Math.max(td.offsetWidth + 2, 260) });
  }, []);
  // focus once it's placed (a hidden element can't take focus)
  const placed = pos !== null;
  useEffect(() => {
    if (!placed) return;
    taRef.current?.focus();
    taRef.current?.select();
  }, [placed]);
  const latest = useRef({ changed, onSave, onCancel, saving });
  latest.current = { changed, onSave, onCancel, saving };
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (ref.current?.contains(e.target as Node) || (e.target as HTMLElement).closest?.(".sm-menu, .sm-modal-backdrop")) return;
      const l = latest.current;
      if (l.saving) return;
      if (l.changed) l.onSave();
      else l.onCancel();
    };
    window.addEventListener("mousedown", onDown, true);
    return () => window.removeEventListener("mousedown", onDown, true);
  }, []);

  return (
    <div
      ref={ref}
      className={cx("sqlb-editor", error && "has-error")}
      title=""
      style={pos ? { left: pos.left, width: pos.width } : { visibility: "hidden" }}
      onMouseDown={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.stopPropagation()}
    >
      <div className="sqlb-editor-row">
        <textarea
          ref={taRef}
          className={cx("sqlb-editor-input", mono && "mono")}
          spellCheck={false}
          rows={Math.min(6, lineCount(value))}
          value={value}
          readOnly={saving}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              onSave();
            } else if (e.key === "Escape") {
              e.preventDefault();
              onCancel();
            } else if (e.key === "Tab") {
              e.preventDefault();
              onSave();
            }
          }}
        />
        <button type="button" className="sqlb-editor-btn" title="Set to NULL" disabled={saving} onClick={onNull}>
          NULL
        </button>
      </div>
      <div className="sqlb-editor-hint">{error ? <span className="sm-danger-text">{error}</span> : <>Enter saves · Shift+Enter new line · Esc cancels</>}</div>
    </div>
  );
}

/** A dialog for longer values (multi-line text, JSON). `save` returns an error message or null. */
export function openValueEditor(opts: { title: string; subtitle?: string; initial: string; isNull: boolean; mono?: boolean; save: (text: string | null) => Promise<string | null> }) {
  openModal((close) => <ValueEditor {...opts} close={close} />);
}

function ValueEditor({ title, subtitle, initial, isNull, mono, save, close }: Parameters<typeof openValueEditor>[0] & { close: () => void }) {
  const [text, setText] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const json = prettyJson(text);
  const run = async (v: string | null) => {
    setBusy(true);
    const err = await save(v);
    setBusy(false);
    if (err) setError(err);
    else close();
  };
  return (
    <form
      className="sm-dialog sqlb-value-dialog"
      onSubmit={(e) => {
        e.preventDefault();
        run(text);
      }}
    >
      <h3>{title}</h3>
      {subtitle && <div className="sqlb-dialog-sub">{subtitle}</div>}
      <textarea
        className={cx("sm-input wide sqlb-value-text", (mono || json) && "mono")}
        autoFocus
        spellCheck={false}
        rows={14}
        value={text}
        placeholder={isNull ? "NULL" : ""}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            run(text);
          }
        }}
      />
      {error && <div className="sm-dialog-error">{error}</div>}
      <div className="sm-dialog-buttons">
        <button type="button" className="sm-btn small subtle" disabled={busy} onClick={() => run(null)} title="Store NULL instead of a value">
          Set NULL
        </button>
        {json && json !== text && (
          <button type="button" className="sm-btn small subtle" onClick={() => setText(json)}>
            Format JSON
          </button>
        )}
        <div className="sm-grow" />
        <button type="button" className="sm-btn subtle" onClick={close}>
          Cancel
        </button>
        <button type="submit" className="sm-btn primary" disabled={busy} title="Ctrl+Enter">
          Save
        </button>
      </div>
    </form>
  );
}

/** The single INTEGER PRIMARY KEY column that is the rowid, if any. */
export function rowidAlias(obj: SchemaObject): DbColumn | null {
  if (obj.withoutRowid) return null;
  const pk = obj.columns.filter((c) => c.pk > 0);
  return pk.length === 1 && pk[0].type.toUpperCase() === "INTEGER" ? pk[0] : null;
}

/**
 * A form for a new row when `DEFAULT VALUES` isn't enough (NOT NULL columns without
 * defaults, WITHOUT ROWID keys). Empty fields get their default (or NULL).
 */
export function openNewRow(opts: {
  obj: SchemaObject;
  reason: string;
  insert: (sql: string, params: Param[]) => Promise<{ lastInsertRowid: number }>;
  done: (rowid: number, values: Record<string, Param>) => void;
}) {
  openModal((close) => <NewRowForm {...opts} close={close} />);
}

function NewRowForm({ obj, reason, insert, done, close }: Parameters<typeof openNewRow>[0] & { close: () => void }) {
  const alias = rowidAlias(obj);
  const cols = obj.columns.filter((c) => c.hidden === 0);
  const [values, setValues] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const required = (c: DbColumn) => c.notNull && c.default === null && c !== alias;
  const missing = cols.filter((c) => required(c) && !(values[c.name] ?? "").length);

  const submit = async () => {
    const used = cols.filter((c) => (values[c.name] ?? "") !== "");
    const params: Param[] = [];
    const exprs = used.map((c) => {
      const v = inputValue(values[c.name], affinity(c.type), null);
      params.push(v.param);
      return v.sql;
    });
    const sql = used.length ? `INSERT INTO ${qi(obj.name)} (${used.map((c) => qi(c.name)).join(", ")}) VALUES (${exprs.join(", ")})` : `INSERT INTO ${qi(obj.name)} DEFAULT VALUES`;
    setBusy(true);
    try {
      const r = await insert(sql, params);
      const out: Record<string, Param> = {};
      used.forEach((c, i) => (out[c.name] = params[i]));
      close();
      done(r.lastInsertRowid, out);
    } catch (e) {
      setError(errorText(e));
      setBusy(false);
    }
  };

  return (
    <form
      className="sm-dialog sqlb-newrow"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <h3>New row in {obj.name}</h3>
      <div className="sqlb-dialog-sub">{reason}</div>
      <div className="sqlb-newrow-fields">
        {cols.map((c, i) => (
          <label key={c.name} className="sqlb-newrow-field">
            <span className="sqlb-newrow-name">
              {c.pk > 0 && <KeyRound size={11} />}
              {c.name}
              {required(c) && <span className="sqlb-req">*</span>}
            </span>
            <input
              className="sm-input wide"
              autoFocus={i === cols.findIndex((x) => x !== alias)}
              spellCheck={false}
              value={values[c.name] ?? ""}
              placeholder={c === alias ? "automatic" : c.default !== null ? `default: ${c.default}` : required(c) ? "required" : "NULL"}
              onChange={(e) => setValues((v) => ({ ...v, [c.name]: e.target.value }))}
            />
            <span className="sqlb-newrow-type">{c.type || "any"}</span>
          </label>
        ))}
      </div>
      {error && <div className="sm-dialog-error">{error}</div>}
      <div className="sm-dialog-buttons">
        <button type="button" className="sm-btn subtle" onClick={close}>
          Cancel
        </button>
        <button type="submit" className="sm-btn primary" disabled={busy || missing.length > 0} title={missing.length ? `Needs ${missing.map((c) => c.name).join(", ")}` : undefined}>
          Add row
        </button>
      </div>
    </form>
  );
}

/** Read-only pretty JSON (used by the inspector). */
export function JsonView({ text }: { text: string }) {
  return <pre className="sm-code sqlb-json">{highlightJson(text)}</pre>;
}
