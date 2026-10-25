// SQL text and cell helpers: identifier quoting, affinities, literals, copy formats.
import type { Cell, DbColumn, Param, SchemaObject } from "../../shared";

/** "name" with embedded quotes doubled. */
export const qi = (name: string) => `"${name.replaceAll('"', '""')}"`;
/** 'text' with embedded quotes doubled. */
export const qs = (s: string) => `'${s.replaceAll("'", "''")}'`;

export type Affinity = "INTEGER" | "TEXT" | "BLOB" | "REAL" | "NUMERIC";

/** SQLite's column affinity rules (datatype3.html §3.1). */
export function affinity(declType: string | null | undefined): Affinity {
  const t = (declType ?? "").toUpperCase();
  if (t.includes("INT")) return "INTEGER";
  if (t.includes("CHAR") || t.includes("CLOB") || t.includes("TEXT")) return "TEXT";
  if (t.includes("BLOB") || !t) return "BLOB";
  if (t.includes("REAL") || t.includes("FLOA") || t.includes("DOUB")) return "REAL";
  return "NUMERIC";
}
export const isNumeric = (a: Affinity) => a === "INTEGER" || a === "REAL" || a === "NUMERIC";

/** Escape % _ and \ for `LIKE ? ESCAPE '\'`. */
export const escapeLike = (s: string) => s.replace(/[\\%_]/g, (c) => "\\" + c);

// ── cells ───────────────────────────────────────────────────────────────

export type BlobCell = { $blob: string; length: number };
export type LongText = { $text: string; length: number };

export const isBlob = (c: Cell): c is BlobCell => !!c && typeof c === "object" && "$blob" in c;
export const isLongText = (c: Cell): c is LongText => !!c && typeof c === "object" && "$text" in c;
export const isBigInt = (c: Cell): c is { $int: string } => !!c && typeof c === "object" && "$int" in c;
export const isOddReal = (c: Cell): c is { $real: string } => !!c && typeof c === "object" && "$real" in c;
export const isNumberCell = (c: Cell) => typeof c === "number" || isBigInt(c) || isOddReal(c);

/** The cell as plain text (copying, tooltips); NULL is "". Long text and blobs are partial. */
export function cellText(c: Cell): string {
  if (c === null) return "";
  if (typeof c === "number") return String(c);
  if (typeof c === "string") return c;
  if ("$int" in c) return c.$int;
  if ("$real" in c) return c.$real;
  if ("$text" in c) return c.$text;
  return c.$blob;
}

/** The cell as an SQL literal. */
export function cellLiteral(c: Cell): string {
  if (c === null) return "NULL";
  if (typeof c === "number") return Number.isFinite(c) ? String(c) : "NULL";
  if (typeof c === "string") return qs(c);
  if ("$int" in c) return c.$int;
  if ("$real" in c) return /nan/i.test(c.$real) ? "NULL" : c.$real.startsWith("-") ? "-9e999" : "9e999";
  if ("$text" in c) return qs(c.$text);
  return `X'${c.$blob}'`;
}

/** The cell as a JSON value (big integers stay exact; blobs become "0x…" hex). */
export function cellJson(c: Cell): string {
  if (c === null) return "null";
  if (typeof c === "number") return Number.isFinite(c) ? String(c) : "null";
  if (typeof c === "string") return JSON.stringify(c);
  if ("$int" in c) return c.$int;
  if ("$real" in c) return JSON.stringify(c.$real);
  if ("$text" in c) return JSON.stringify(c.$text);
  return JSON.stringify("0x" + c.$blob);
}

/** Some values in these cells were cut short (long text or blobs over 256 bytes). */
export const hasPartial = (cells: Cell[]) => cells.some((c) => isLongText(c) || (isBlob(c) && c.length > c.$blob.length / 2));

/** Value for a table row key. */
export function cellKey(c: Cell): string | number {
  if (c === null) return "null";
  if (typeof c === "number" || typeof c === "string") return c;
  return cellText(c);
}

/**
 * The cell as a query parameter that matches it exactly in a WHERE clause.
 * Integers beyond ±2^53 can't be passed as numbers: they go as text with `CAST(? AS INTEGER)`.
 */
export function cellParam(c: Cell): { param: Param; sql: string } {
  if (isBigInt(c)) return { param: c.$int, sql: "CAST(? AS INTEGER)" };
  if (isBlob(c)) return { param: { $blob: c.$blob }, sql: "?" };
  if (isOddReal(c)) return { param: null, sql: c.$real.startsWith("-") ? "-9e999" : "9e999" };
  if (isLongText(c)) return { param: c.$text, sql: "?" };
  return { param: c, sql: "?" };
}

const INT_RE = /^[+-]?\d+$/;
const REAL_RE = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;

/**
 * What the user typed in an editor, as the value to store: numbers in numeric (and
 * untyped) columns, text otherwise — like SQLite's own affinity would.
 */
export function inputValue(text: string, aff: Affinity, original: Cell): { param: Param; sql: string } {
  const numericish = isNumeric(aff) || isNumberCell(original) || (aff === "BLOB" && !(typeof original === "string"));
  const t = text.trim();
  if (numericish && INT_RE.test(t)) {
    const n = Number(t);
    if (Number.isSafeInteger(n)) return { param: n, sql: "?" };
    const big = BigInt(t);
    if (big >= -(2n ** 63n) && big < 2n ** 63n) return { param: big.toString(), sql: "CAST(? AS INTEGER)" };
  }
  if (numericish && REAL_RE.test(t) && Number.isFinite(Number(t))) return { param: Number(t), sql: "?" };
  return { param: text, sql: "?" };
}

// ── rows as text ────────────────────────────────────────────────────────

function tsvField(c: Cell): string {
  const s = cellText(c);
  return /[\t\n\r"]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}

export function toTsv(names: string[], rows: Cell[][], header: boolean): string {
  const lines = rows.map((r) => r.map(tsvField).join("\t"));
  if (header) lines.unshift(names.map((n) => tsvField(n)).join("\t"));
  return lines.join("\n");
}

export function toJson(names: string[], rows: Cell[][]): string {
  const body = rows.map((r) => "  {" + r.map((c, i) => `${JSON.stringify(names[i])}: ${cellJson(c)}`).join(", ") + "}");
  return `[\n${body.join(",\n")}\n]`;
}

export function toInserts(table: string, names: string[], rows: Cell[][]): string {
  const cols = names.map(qi).join(", ");
  return rows.map((r) => `INSERT INTO ${qi(table)} (${cols}) VALUES (${r.map(cellLiteral).join(", ")});`).join("\n");
}

// ── SQL text ────────────────────────────────────────────────────────────

export type TokKind = "kw" | "id" | "qid" | "str" | "num" | "blob" | "param" | "com" | "op" | "ws";
export interface Tok {
  kind: TokKind;
  text: string;
}

export const KEYWORDS = new Set(
  (
    "ABORT ACTION ADD AFTER ALL ALTER ALWAYS ANALYZE AND AS ASC ATTACH AUTOINCREMENT BEFORE BEGIN BETWEEN BY CASCADE CASE CAST CHECK " +
    "COLLATE COLUMN COMMIT CONFLICT CONSTRAINT CREATE CROSS CURRENT CURRENT_DATE CURRENT_TIME CURRENT_TIMESTAMP DATABASE DEFAULT " +
    "DEFERRABLE DEFERRED DELETE DESC DETACH DISTINCT DO DROP EACH ELSE END ESCAPE EXCEPT EXCLUSIVE EXISTS EXPLAIN FAIL FILTER FIRST " +
    "FOLLOWING FOR FOREIGN FROM FULL GENERATED GLOB GROUP GROUPS HAVING IF IGNORE IMMEDIATE IN INDEX INDEXED INITIALLY INNER INSERT " +
    "INSTEAD INTERSECT INTO IS ISNULL JOIN KEY LAST LEFT LIKE LIMIT MATCH MATERIALIZED NATURAL NO NOT NOTHING NOTNULL NULL NULLS OF " +
    "OFFSET ON OR ORDER OTHERS OUTER OVER PARTITION PLAN PRAGMA PRECEDING PRIMARY QUERY RAISE RANGE RECURSIVE REFERENCES REGEXP REINDEX " +
    "RELEASE RENAME REPLACE RESTRICT RETURNING RIGHT ROLLBACK ROW ROWS ROWID SAVEPOINT SELECT SET STORED STRICT TABLE TEMP TEMPORARY THEN TIES " +
    "TO TRANSACTION TRIGGER UNBOUNDED UNION UNIQUE UPDATE USING VACUUM VALUES VIEW VIRTUAL WHEN WHERE WINDOW WITH WITHOUT " +
    "INTEGER TEXT BLOB REAL NUMERIC VARCHAR BOOLEAN DATETIME"
  ).split(" "),
);

/** Split SQL into tokens (lossless: joining the texts gives the input back). */
export function tokenize(sql: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  const n = sql.length;
  const push = (kind: TokKind, end: number) => {
    out.push({ kind, text: sql.slice(i, end) });
    i = end;
  };
  const until = (close: string, from: number, doubled: boolean) => {
    let j = from;
    for (;;) {
      const k = sql.indexOf(close, j);
      if (k < 0) return n;
      if (doubled && sql[k + 1] === close) {
        j = k + 2;
        continue;
      }
      return k + close.length;
    }
  };
  while (i < n) {
    const c = sql[i];
    const d = sql[i + 1];
    if (/\s/.test(c)) {
      let j = i + 1;
      while (j < n && /\s/.test(sql[j])) j++;
      push("ws", j);
    } else if (c === "-" && d === "-") {
      const k = sql.indexOf("\n", i);
      push("com", k < 0 ? n : k);
    } else if (c === "/" && d === "*") {
      const k = sql.indexOf("*/", i + 2);
      push("com", k < 0 ? n : k + 2);
    } else if ((c === "x" || c === "X") && d === "'") {
      push("blob", until("'", i + 2, false));
    } else if (c === "'") {
      push("str", until("'", i + 1, true));
    } else if (c === '"' || c === "`") {
      push("qid", until(c, i + 1, true));
    } else if (c === "[") {
      push("qid", until("]", i + 1, false));
    } else if (/[0-9]/.test(c) || (c === "." && /[0-9]/.test(d ?? ""))) {
      const m = /^(0x[0-9a-f]+|\d*\.?\d+(e[+-]?\d+)?\.?)/i.exec(sql.slice(i));
      push("num", i + (m ? m[0].length : 1));
    } else if (c === "?" || ((c === ":" || c === "@" || c === "$") && /[A-Za-z_]/.test(d ?? ""))) {
      let j = i + 1;
      while (j < n && /[\w]/.test(sql[j])) j++;
      push("param", j);
    } else if (/[A-Za-z_\u0080-￿]/.test(c)) {
      let j = i + 1;
      while (j < n && /[\w$\u0080-￿]/.test(sql[j])) j++;
      push(KEYWORDS.has(sql.slice(i, j).toUpperCase()) ? "kw" : "id", j);
    } else {
      const two = sql.slice(i, i + 2);
      push("op", ["<=", ">=", "<>", "!=", "==", "||", "<<", ">>", "->"].includes(two) ? i + 2 : i + 1);
    }
  }
  return out;
}

/** The SQL without comments, for keyword checks. */
export const stripComments = (sql: string) =>
  tokenize(sql)
    .filter((t) => t.kind !== "com")
    .map((t) => (t.kind === "str" || t.kind === "qid" ? " x " : t.text))
    .join("");

/** It may have created, dropped or altered schema objects. */
export const mayChangeSchema = (sql: string) => /\b(create|drop|alter)\b/i.test(stripComments(sql));

/** Any semicolon outside strings, identifiers and comments. */
export const hasStatementBreak = (sql: string) => tokenize(sql).some((t) => t.kind === "op" && t.text === ";");

/** "users" from `SELECT … FROM users …`, for INSERT statements copied from a result. */
export function guessTable(sql: string): string | null {
  const toks = tokenize(sql).filter((t) => t.kind !== "ws" && t.kind !== "com");
  for (let i = 0; i < toks.length - 1; i++) {
    if (toks[i].kind === "kw" && toks[i].text.toUpperCase() === "FROM") {
      const t = toks[i + 1];
      if (t.kind === "id") return t.text;
      if (t.kind === "qid") return unquote(t.text);
    }
  }
  return null;
}

export function unquote(s: string): string {
  const c = s[0];
  if (c === "[") return s.slice(1, -1);
  if (c === '"' || c === "`") return s.slice(1, -1).replaceAll(c + c, c);
  return s;
}

/** Errors that mean "the database is open read-only". */
export const isReadOnlyError = (msg: string) => /read-?only|readonly|attempt to write/i.test(msg);
// (the backend says "Query cancelled."; SQLite itself "interrupted")
export const isInterrupted = (msg: string) => /interrupt|cancell?ed/i.test(msg);

// ── schema ──────────────────────────────────────────────────────────────

export const isSystem = (name: string) => /^sqlite_/i.test(name);

/** How rows of this object are identified for edits. */
export type RowIdentity = { kind: "rowid"; expr: string } | { kind: "pk"; cols: DbColumn[] } | { kind: "none"; why: string };

export function rowIdentity(obj: SchemaObject): RowIdentity {
  if (obj.type === "view") return { kind: "none", why: "Views are read-only" };
  if (obj.virtual) return { kind: "none", why: "Virtual tables are browse-only here" };
  const names = new Set(obj.columns.map((c) => c.name.toLowerCase()));
  if (!obj.withoutRowid) {
    const expr = ["rowid", "_rowid_", "oid"].find((n) => !names.has(n));
    if (expr) return { kind: "rowid", expr };
  }
  const pk = obj.columns.filter((c) => c.pk > 0).sort((a, b) => a.pk - b.pk);
  if (pk.length) return { kind: "pk", cols: pk };
  return { kind: "none", why: "This table has no rowid or primary key to identify rows by" };
}

/** Text-like columns for the quick search (untyped ones too); all of them when there are none. */
export function searchColumns(cols: { name: string; type: string | null }[]): string[] {
  const text = cols.filter((c) => {
    const a = affinity(c.type);
    return a === "TEXT" || (a === "BLOB" && !c.type);
  });
  return (text.length ? text : cols).map((c) => c.name);
}

/** Seconds/ms/µs since 1970, or Chrome's µs since 1601, for columns named like times. */
export function timeHint(name: string, v: number): string | null {
  if (!/time|date|_at$|_on$|ts$|stamp|created|modified|updated|expir|seen|last|visit|when/i.test(name)) return null;
  let ms: number | null = null;
  let what = "";
  if (v >= 1e8 && v < 1e10) [ms, what] = [v * 1000, "Unix seconds"];
  else if (v >= 1e11 && v < 1e13) [ms, what] = [v, "Unix milliseconds"];
  else if (v >= 1e15 && v < 1e16) [ms, what] = [v / 1000, "Unix microseconds"];
  else if (v >= 1.1e16 && v < 1.4e16) [ms, what] = [v / 1000 - 11644473600000, "Chrome/WebKit time (µs since 1601)"];
  if (ms === null) return null;
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return null;
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())} · ${what}`;
}

/** File type from a blob's first bytes. */
export function blobKind(hex: string): string | null {
  const h = hex.toLowerCase();
  const sig: [string, string][] = [
    ["89504e470d0a1a0a", "PNG"],
    ["ffd8ff", "JPEG"],
    ["47494638", "GIF"],
    ["25504446", "PDF"],
    ["504b0304", "ZIP"],
    ["1f8b", "gzip"],
    ["53514c69746520666f726d6174203300", "SQLite"],
    ["62706c697374", "plist"],
    ["4d5a", "PE"],
    ["28b52ffd", "zstd"],
    ["377abcaf271c", "7z"],
    ["0061736d", "wasm"],
  ];
  for (const [s, k] of sig) if (h.startsWith(s)) return k;
  if (h.startsWith("52494646") && h.slice(16, 24) === "57454250") return "WebP";
  return null;
}
