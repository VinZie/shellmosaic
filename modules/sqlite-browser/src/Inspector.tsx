// The row inspector: every column of the selected row with its full value.
import { useEffect, useMemo, useRef, useState } from "react";
import { Braces, Clock, Copy, KeyRound, Pencil, PanelRight, X } from "lucide-react";
import { IconButton, Message, cx, formatBytes, formatNumber, type Cell } from "../../shared";
import { HexDump, prettyJson } from "./cells";
import { JsonView } from "./editors";
import { blobKind, cellText, isBigInt, isBlob, isLongText, isOddReal, timeHint, toJson, type BlobCell } from "./sql";
import { copyOut, useWidth } from "./state";

export interface InspectorColumn {
  index: number;
  name: string;
  declType: string | null;
  pk: boolean;
}

const TEXT_LIMIT = 20_000;

function storageClass(c: Cell): string {
  if (c === null) return "null";
  if (typeof c === "number") return Number.isInteger(c) ? "integer" : "real";
  if (typeof c === "string") return `text · ${formatNumber(c.length)} chars`;
  if ("$int" in c) return "integer · 64-bit";
  if ("$real" in c) return "real";
  if ("$text" in c) return `text · ${formatNumber(c.length)} chars`;
  return `blob · ${formatBytes(c.length)}`;
}

export function Inspector({
  columns,
  row,
  title,
  selectedCount,
  activeIndex,
  onActivate,
  editWhy,
  onEdit,
  onClose,
}: {
  columns: InspectorColumn[];
  row: Cell[] | null;
  title: string;
  selectedCount: number;
  activeIndex: number;
  onActivate: (index: number) => void;
  /** why a value can't be edited (null: it can) */
  editWhy: (index: number) => string | null;
  onEdit: (index: number) => void;
  onClose: () => void;
}) {
  const bodyRef = useRef<HTMLDivElement>(null);
  const width = useWidth(bodyRef, 320);

  // keep the active column's field in view
  useEffect(() => {
    bodyRef.current?.querySelector(".sqlb-field.active")?.scrollIntoView({ block: "nearest" });
  }, [activeIndex, row]);

  return (
    <div className="sqlb-insp">
      <div className="sqlb-insp-head">
        <PanelRight size={14} className="sqlb-dim" />
        <span className="sqlb-insp-title">{row ? title : "Inspector"}</span>
        {selectedCount > 1 && <span className="sqlb-dim">· {selectedCount} selected</span>}
        <div className="sm-grow" />
        {row && (
          <IconButton
            title="Copy the row as JSON"
            onClick={() =>
              copyOut(
                toJson(
                  columns.map((c) => c.name),
                  [columns.map((c) => row[c.index])],
                ),
                "row as JSON",
              )
            }
          >
            <Braces size={14} />
          </IconButton>
        )}
        <IconButton title="Close the inspector" onClick={onClose}>
          <X size={14} />
        </IconButton>
      </div>
      <div className="sqlb-insp-body" ref={bodyRef}>
        {!row ? (
          <Message icon={<PanelRight size={20} />} title="No row selected">
            Select a row to see all of its values in full.
          </Message>
        ) : (
          columns.map((col) => {
            const c = row[col.index];
            const why = editWhy(col.index);
            return (
              <div key={col.index} className={cx("sqlb-field", col.index === activeIndex && "active")} onMouseDown={() => onActivate(col.index)}>
                <div className="sqlb-field-head">
                  {col.pk && <KeyRound size={11} className="sqlb-key" />}
                  <span className="sqlb-field-name">{col.name}</span>
                  {col.declType && <span className="sqlb-field-type">{col.declType}</span>}
                  <div className="sm-grow" />
                  <span className="sqlb-field-class">{storageClass(c)}</span>
                  <span className="sqlb-field-actions">
                    <IconButton title={why ?? "Edit the value"} disabled={!!why} onClick={() => onEdit(col.index)}>
                      <Pencil size={12} />
                    </IconButton>
                    <IconButton title={isBlob(c) ? "Copy the hex shown" : "Copy the value"} onClick={() => copyOut(cellText(c), isBlob(c) ? "hex" : "value", isLongText(c) || (isBlob(c) && c.length > 256))}>
                      <Copy size={12} />
                    </IconButton>
                  </span>
                </div>
                <FieldValue c={c} name={col.name} wide={width >= 520} />
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}

function FieldValue({ c, name, wide }: { c: Cell; name: string; wide: boolean }) {
  const [all, setAll] = useState(false);
  const json = useMemo(() => (typeof c === "string" ? prettyJson(c) : null), [c]);
  if (c === null) return <div className="sqlb-fv sqlb-null">NULL</div>;
  if (typeof c === "number" || isBigInt(c) || isOddReal(c)) {
    const hint = typeof c === "number" ? timeHint(name, c) : null;
    return (
      <div className="sqlb-fv mono sm-selectable">
        {cellText(c)}
        {hint && (
          <div className="sqlb-fv-hint">
            <Clock size={11} /> {hint}
          </div>
        )}
      </div>
    );
  }
  if (isBlob(c)) return <BlobValue c={c} wide={wide} />;
  if (json) return <JsonView text={json} />;
  const s = typeof c === "string" ? c : c.$text;
  if (!s.length) return <div className="sqlb-fv sqlb-dim">(empty text)</div>;
  const cut = !all && s.length > TEXT_LIMIT;
  return (
    <div className="sqlb-fv text sm-selectable">
      {cut ? s.slice(0, TEXT_LIMIT) : s}
      {cut && (
        <button type="button" className="sqlb-link" onClick={() => setAll(true)}>
          … show all {formatNumber(s.length)} characters
        </button>
      )}
      {isLongText(c) && <div className="sqlb-fv-hint">The first {formatNumber(s.length)} of {formatNumber(c.length)} characters (the rest isn't loaded)</div>}
    </div>
  );
}

function BlobValue({ c, wide }: { c: BlobCell; wide: boolean }) {
  const kind = blobKind(c.$blob);
  const shown = c.$blob.length / 2;
  return (
    <div className="sqlb-fv">
      <div className="sqlb-fv-hint top">
        {kind ? `${kind} · ` : ""}
        {formatNumber(c.length)} bytes{shown < c.length ? ` · first ${shown} shown` : ""}
      </div>
      <HexDump hex={c.$blob} perLine={wide ? 16 : 8} />
    </div>
  );
}
