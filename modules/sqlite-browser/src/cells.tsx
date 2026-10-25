// How values look: grid cells, hex dumps, highlighted SQL and JSON.
import { Fragment, type ReactNode } from "react";
import { formatBytes, formatNumber, type Cell } from "../../shared";
import { blobKind, tokenize } from "./sql";

const CELL_CHARS = 300;

/** Text on one line: newlines become a dim ↵. */
function oneLine(s: string): ReactNode {
  const t = s.length > CELL_CHARS ? s.slice(0, CELL_CHARS) : s;
  if (!/[\r\n]/.test(t)) return t;
  const parts = t.split(/\r?\n/);
  return parts.map((p, i) => (
    <Fragment key={i}>
      {i > 0 && <span className="sqlb-nl">↵</span>}
      {p}
    </Fragment>
  ));
}

/** A grid cell's content. */
export function CellView({ c }: { c: Cell }) {
  if (c === null) return <span className="sqlb-null">NULL</span>;
  if (typeof c === "number") return <span className="sqlb-num">{String(c)}</span>;
  if (typeof c === "string") return <span className="sqlb-text">{oneLine(c)}</span>;
  if ("$int" in c) return <span className="sqlb-num">{c.$int}</span>;
  if ("$real" in c) return <span className="sqlb-num">{c.$real}</span>;
  if ("$text" in c)
    return (
      <>
        <span className="sqlb-text">{oneLine(c.$text)}</span>
        <span className="sqlb-more">… {formatNumber(c.length)} chars</span>
      </>
    );
  const kind = blobKind(c.$blob);
  return (
    <span className="sqlb-blob">
      BLOB{kind && <> · {kind}</>} · {formatBytes(c.length)}
    </span>
  );
}

/** Short plain text for a cell's tooltip. */
export function cellTitle(c: Cell): string | undefined {
  if (c === null) return "NULL";
  if (typeof c === "number") return String(c);
  if (typeof c === "string") return c.length > 600 ? c.slice(0, 600) + "…" : c;
  if ("$int" in c) return c.$int;
  if ("$real" in c) return c.$real;
  if ("$text" in c) return `${c.$text.slice(0, 600)}… (${formatNumber(c.length)} characters)`;
  return `BLOB, ${formatNumber(c.length)} bytes`;
}

/** Offset, hex and ASCII columns. */
export function HexDump({ hex, perLine = 16 }: { hex: string; perLine?: number }) {
  const bytes = hex.match(/../g) ?? [];
  const lines: ReactNode[] = [];
  for (let off = 0; off < bytes.length; off += perLine) {
    const chunk = bytes.slice(off, off + perLine);
    const hexPart = chunk.map((b, i) => (i === 8 ? " " : "") + b).join(" ");
    const pad = perLine * 3 - 1 + (perLine > 8 ? 1 : 0);
    const ascii = chunk
      .map((b) => {
        const v = parseInt(b, 16);
        return v >= 0x20 && v < 0x7f ? String.fromCharCode(v) : "·";
      })
      .join("");
    lines.push(
      <div key={off}>
        <span className="sqlb-hex-off">{off.toString(16).padStart(8, "0")}</span>
        {"  "}
        {hexPart.padEnd(pad, " ")}
        {"  "}
        <span className="sqlb-hex-ascii">{ascii}</span>
      </div>,
    );
  }
  return <div className="sqlb-hex">{lines}</div>;
}

const SQL_CLASS: Partial<Record<string, string>> = {
  kw: "tk-kw",
  str: "tk-str",
  blob: "tk-str",
  num: "tk-num",
  com: "tk-com",
  qid: "tk-id",
  param: "tk-param",
};

/** SQL with keywords, strings, numbers and comments colored. */
export function highlightSql(sql: string): ReactNode[] {
  return tokenize(sql).map((t, i) => {
    const cls = SQL_CLASS[t.kind];
    return cls ? (
      <span key={i} className={cls}>
        {t.text}
      </span>
    ) : (
      t.text
    );
  });
}

/** Pretty-printed JSON with keys, strings, numbers and literals colored. */
export function highlightJson(json: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /("(?:\\.|[^"\\])*")(\s*:)?|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)|\b(true|false|null)\b/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let k = 0;
  while ((m = re.exec(json))) {
    if (m.index > last) out.push(json.slice(last, m.index));
    if (m[1]) {
      out.push(
        <span key={k++} className={m[2] ? "tk-key" : "tk-str"}>
          {m[1]}
        </span>,
      );
      if (m[2]) out.push(m[2]);
    } else if (m[3]) out.push(<span key={k++} className="tk-num">{m[3]}</span>);
    else out.push(<span key={k++} className="tk-kw">{m[4]}</span>);
    last = re.lastIndex;
  }
  if (last < json.length) out.push(json.slice(last));
  return out;
}

/** The text pretty-printed when it's a JSON object or array. */
export function prettyJson(s: string): string | null {
  const t = s.trim();
  if (!(t.startsWith("{") && t.endsWith("}")) && !(t.startsWith("[") && t.endsWith("]"))) return null;
  try {
    return JSON.stringify(JSON.parse(t), null, 2);
  } catch {
    return null;
  }
}
