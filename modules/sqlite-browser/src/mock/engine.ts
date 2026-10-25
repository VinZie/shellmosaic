// Dev only: a tiny in-memory SQL engine for the mock. It understands the SQL the UI
// generates (SELECT … WHERE … ORDER BY … LIMIT/OFFSET, COUNT(*), UPDATE, INSERT,
// DELETE, PRAGMA quick_check) and a useful subset of what people type: expressions,
// common functions, GROUP BY with aggregates. Joins and subqueries aren't supported.
import type { Cell, DbForeignKey, Param, QueryResult, SchemaObject } from "../../../shared";
import { affinity, tokenize, unquote, type Tok } from "../sql";

export interface MCol {
  name: string;
  type: string;
  notNull?: boolean;
  /** SQL text shown in the schema */
  default?: string | null;
  /** the value a default produces */
  dflt?: () => Cell;
  pk?: number;
  hidden?: number;
}
export interface MRow {
  rowid: number;
  v: Cell[];
}
export interface MTable {
  name: string;
  kind: "table" | "view" | "virtual";
  sql: string | null;
  columns: MCol[];
  withoutRowid?: boolean;
  autoincrement?: boolean;
  rows: MRow[];
  compute?: () => MRow[];
  fks?: DbForeignKey[];
  afterUpdate?: (row: MRow, changed: Set<string>) => void;
}
export interface MIndex {
  name: string;
  tbl: string;
  sql: string | null;
  unique: boolean;
  origin: string;
  partial: boolean;
  columns: string[];
}
export interface MDb {
  tables: MTable[];
  indexes: MIndex[];
  triggers: { name: string; tbl: string; sql: string }[];
  info: { pageSize: number; journalMode: string; userVersion: number; applicationId: number; freelistCount: number; sqliteVersion: string };
}

// ── values ──────────────────────────────────────────────────────────────

type V = Cell;
const isObj = (v: V): v is Exclude<V, null | number | string> => !!v && typeof v === "object";

function num(v: V): number | null {
  if (v === null) return null;
  if (typeof v === "number") return v;
  if (typeof v === "string") {
    const m = /^\s*[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?/.exec(v);
    return m ? Number(m[0]) : 0;
  }
  if ("$int" in v) return Number(v.$int);
  if ("$real" in v) return /nan/i.test(v.$real) ? NaN : v.$real.startsWith("-") ? -Infinity : Infinity;
  if ("$text" in v) return num(v.$text);
  return 0;
}
function str(v: V): string | null {
  if (v === null) return null;
  if (typeof v === "string") return v;
  if (typeof v === "number") return Number.isInteger(v) ? String(v) : String(v);
  if ("$int" in v) return v.$int;
  if ("$real" in v) return v.$real;
  if ("$text" in v) return v.$text;
  return v.$blob;
}
const cls = (v: V) => (v === null ? 0 : typeof v === "number" || (isObj(v) && ("$int" in v || "$real" in v)) ? 1 : typeof v === "string" || (isObj(v) && "$text" in v) ? 2 : 3);
const looksNumeric = (s: string) => /^\s*[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?\s*$/.test(s);

function cmp(a: V, b: V): number | null {
  if (a === null || b === null) return null;
  let ca = cls(a);
  let cb = cls(b);
  if (ca === 1 && cb === 2 && looksNumeric(str(b)!)) cb = 1;
  if (cb === 1 && ca === 2 && looksNumeric(str(a)!)) ca = 1;
  if (ca !== cb) return ca - cb;
  if (ca === 1) {
    const ai = isObj(a) && "$int" in a;
    const bi = isObj(b) && "$int" in b;
    if (ai || bi) {
      const x = ai ? BigInt((a as { $int: string }).$int) : Number.isInteger(num(a)) ? BigInt(num(a)!) : null;
      const y = bi ? BigInt((b as { $int: string }).$int) : Number.isInteger(num(b)) ? BigInt(num(b)!) : null;
      if (x !== null && y !== null) return x < y ? -1 : x > y ? 1 : 0;
    }
    const x = num(a)!;
    const y = num(b)!;
    return x < y ? -1 : x > y ? 1 : 0;
  }
  const x = str(a)!;
  const y = str(b)!;
  return x < y ? -1 : x > y ? 1 : 0;
}
const truth = (v: V): boolean | null => (v === null ? null : num(v) !== 0);
const bool = (b: boolean | null): V => (b === null ? null : b ? 1 : 0);

/** A number as a cell: big integers keep every digit. */
function intCell(s: string): V {
  const n = Number(s);
  return Number.isSafeInteger(n) ? n : { $int: BigInt(s).toString() };
}

/** Column affinity applied to a stored value. */
function withAffinity(type: string, v: V): V {
  const a = affinity(type);
  if (typeof v !== "string") {
    if (a === "TEXT" && typeof v === "number") return String(v);
    return v;
  }
  if ((a === "INTEGER" || a === "NUMERIC" || a === "REAL") && looksNumeric(v)) {
    const t = v.trim();
    if (/^[+-]?\d+$/.test(t) && a !== "REAL") return intCell(t);
    return Number(t);
  }
  return v;
}

function likeRe(pattern: string, esc: string | null): RegExp {
  let re = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (esc && c === esc && i + 1 < pattern.length) re += pattern[++i].replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    else if (c === "%") re += "[\\s\\S]*";
    else if (c === "_") re += "[\\s\\S]";
    else re += c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`, "i");
}

// ── parsing ─────────────────────────────────────────────────────────────

type Expr =
  | { k: "lit"; v: V }
  | { k: "param"; i: number }
  | { k: "col"; name: string; text: string }
  | { k: "un"; op: string; e: Expr }
  | { k: "bin"; op: string; l: Expr; r: Expr }
  | { k: "like"; not: boolean; glob: boolean; l: Expr; r: Expr; esc: Expr | null }
  | { k: "isnull"; not: boolean; e: Expr }
  | { k: "in"; not: boolean; e: Expr; list: Expr[] }
  | { k: "between"; not: boolean; e: Expr; lo: Expr; hi: Expr }
  | { k: "fn"; name: string; args: Expr[]; star: boolean }
  | { k: "cast"; e: Expr; type: string }
  | { k: "case"; base: Expr | null; whens: [Expr, Expr][]; els: Expr | null };

interface ResultCol {
  e: Expr | null;
  star: boolean;
  alias: string | null;
  text: string;
}
type Stmt =
  | { kind: "select"; cols: ResultCol[]; from: string | null; where: Expr | null; group: Expr[]; having: Expr | null; order: { e: Expr; desc: boolean }[]; limit: Expr | null; offset: Expr | null }
  | { kind: "insert"; table: string; cols: string[] | null; rows: Expr[][] | null; or: string | null }
  | { kind: "update"; table: string; sets: [string, Expr][]; where: Expr | null }
  | { kind: "delete"; table: string; where: Expr | null }
  | { kind: "pragma"; name: string; arg: string | null }
  | { kind: "other"; word: string; writes: boolean }
  | { kind: "unsupported"; why: string };

const AGG = new Set(["COUNT", "SUM", "TOTAL", "AVG", "MIN", "MAX", "GROUP_CONCAT"]);
class Unsupported extends Error {}

class Parser {
  i = 0;
  params = 0;
  constructor(private t: Tok[]) {}
  peek(o = 0): Tok | undefined {
    return this.t[this.i + o];
  }
  fail(): never {
    const t = this.peek();
    throw new Error(t ? `near "${t.text}": syntax error` : "incomplete input");
  }
  isW(w: string, o = 0) {
    const t = this.peek(o);
    return !!t && (t.kind === "kw" || t.kind === "id") && t.text.toUpperCase() === w;
  }
  eatW(...ws: string[]) {
    for (let k = 0; k < ws.length; k++) if (!this.isW(ws[k], k)) return false;
    this.i += ws.length;
    return true;
  }
  needW(w: string) {
    if (!this.eatW(w)) this.fail();
  }
  isOp(op: string, o = 0) {
    const t = this.peek(o);
    return !!t && t.kind === "op" && t.text === op;
  }
  eatOp(op: string) {
    if (!this.isOp(op)) return false;
    this.i++;
    return true;
  }
  needOp(op: string) {
    if (!this.eatOp(op)) this.fail();
  }
  ident(): string {
    const t = this.peek();
    if (!t) this.fail();
    if (t.kind === "qid") {
      this.i++;
      return unquote(t.text);
    }
    if (t.kind === "id" || t.kind === "kw") {
      this.i++;
      return t.text;
    }
    if (t.kind === "str") {
      this.i++;
      return t.text.slice(1, -1).replaceAll("''", "'");
    }
    this.fail();
  }
  /** a name possibly qualified ("main"."t" or t.col): the last part */
  qname(): string {
    let n = this.ident();
    while (this.isOp(".")) {
      this.i++;
      n = this.ident();
    }
    return n;
  }
  get done() {
    return this.i >= this.t.length;
  }
  textFrom(start: number): string {
    return this.t
      .slice(start, this.i)
      .map((x) => x.text)
      .join(" ")
      .replace(/ ?([(),.]) ?/g, "$1")
      .replace(/,/g, ", ");
  }

  statement(): Stmt {
    const t = this.peek();
    if (!t) this.fail();
    const w = t.text.toUpperCase();
    let s: Stmt;
    if (w === "SELECT") s = this.select();
    else if (w === "INSERT" || w === "REPLACE") s = this.insert();
    else if (w === "UPDATE") s = this.update();
    else if (w === "DELETE") s = this.del();
    else if (w === "PRAGMA") s = this.pragma();
    else if (["WITH", "EXPLAIN", "VALUES"].includes(w)) {
      this.i = this.t.length;
      return { kind: "unsupported", why: w };
    } else if (["CREATE", "DROP", "ALTER", "VACUUM", "REINDEX", "ANALYZE"].includes(w)) {
      this.i = this.t.length;
      return { kind: "other", word: w, writes: true };
    } else if (["BEGIN", "COMMIT", "END", "ROLLBACK", "SAVEPOINT", "RELEASE", "ATTACH", "DETACH"].includes(w)) {
      this.i = this.t.length;
      return { kind: "other", word: w, writes: false };
    } else this.fail();
    if (!this.done) this.fail();
    return s;
  }

  select(): Stmt {
    this.needW("SELECT");
    this.eatW("DISTINCT") || this.eatW("ALL");
    const cols: ResultCol[] = [];
    do {
      const start = this.i;
      if (this.isOp("*")) {
        this.i++;
        cols.push({ e: null, star: true, alias: null, text: "*" });
        continue;
      }
      const t0 = this.peek();
      if (t0 && (t0.kind === "id" || t0.kind === "qid") && this.isOp(".", 1) && this.isOp("*", 2)) {
        this.i += 3;
        cols.push({ e: null, star: true, alias: null, text: "*" });
        continue;
      }
      const e = this.expr();
      const text = this.textFrom(start);
      let alias: string | null = null;
      if (this.eatW("AS")) alias = this.ident();
      else {
        const t = this.peek();
        if (t && (t.kind === "id" || t.kind === "qid")) alias = this.ident();
      }
      cols.push({ e, star: false, alias, text });
    } while (this.eatOp(","));
    let from: string | null = null;
    if (this.eatW("FROM")) {
      if (this.isOp("(")) throw new Unsupported("subquery");
      from = this.qname();
      if (this.eatW("AS")) this.ident();
      else if (this.peek()?.kind === "id" && !["WHERE", "GROUP", "ORDER", "LIMIT"].includes(this.peek()!.text.toUpperCase())) this.ident();
      if (this.isOp(",") || this.isW("JOIN") || this.isW("LEFT") || this.isW("INNER") || this.isW("CROSS") || this.isW("NATURAL")) throw new Unsupported("join");
    }
    const where = this.eatW("WHERE") ? this.expr() : null;
    const group: Expr[] = [];
    let having: Expr | null = null;
    if (this.eatW("GROUP", "BY")) {
      do group.push(this.expr());
      while (this.eatOp(","));
      if (this.eatW("HAVING")) having = this.expr();
    }
    const order: { e: Expr; desc: boolean }[] = [];
    if (this.eatW("ORDER", "BY")) {
      do {
        const e = this.expr();
        if (this.eatW("COLLATE")) this.ident();
        const desc = this.eatW("DESC");
        if (!desc) this.eatW("ASC");
        if (this.eatW("NULLS")) this.eatW("FIRST") || this.eatW("LAST");
        order.push({ e, desc });
      } while (this.eatOp(","));
    }
    let limit: Expr | null = null;
    let offset: Expr | null = null;
    if (this.eatW("LIMIT")) {
      limit = this.expr();
      if (this.eatW("OFFSET")) offset = this.expr();
      else if (this.eatOp(",")) {
        offset = limit;
        limit = this.expr();
      }
    }
    if (this.isW("UNION") || this.isW("EXCEPT") || this.isW("INTERSECT")) throw new Unsupported("compound");
    return { kind: "select", cols, from, where, group, having, order, limit, offset };
  }

  insert(): Stmt {
    let or: string | null = null;
    if (this.eatW("REPLACE")) or = "REPLACE";
    else {
      this.needW("INSERT");
      if (this.eatW("OR")) or = this.ident().toUpperCase();
    }
    this.needW("INTO");
    const table = this.qname();
    if (this.eatW("AS")) this.ident();
    if (this.eatW("DEFAULT", "VALUES")) return { kind: "insert", table, cols: null, rows: null, or };
    let cols: string[] | null = null;
    if (this.eatOp("(")) {
      cols = [];
      do cols.push(this.ident());
      while (this.eatOp(","));
      this.needOp(")");
    }
    if (this.isW("SELECT")) throw new Unsupported("INSERT … SELECT");
    this.needW("VALUES");
    const rows: Expr[][] = [];
    do {
      this.needOp("(");
      const r: Expr[] = [];
      do r.push(this.expr());
      while (this.eatOp(","));
      this.needOp(")");
      rows.push(r);
    } while (this.eatOp(","));
    return { kind: "insert", table, cols, rows, or };
  }

  update(): Stmt {
    this.needW("UPDATE");
    if (this.eatW("OR")) this.ident();
    const table = this.qname();
    this.needW("SET");
    const sets: [string, Expr][] = [];
    do {
      const c = this.ident();
      this.needOp("=");
      sets.push([c, this.expr()]);
    } while (this.eatOp(","));
    const where = this.eatW("WHERE") ? this.expr() : null;
    return { kind: "update", table, sets, where };
  }

  del(): Stmt {
    this.needW("DELETE");
    this.needW("FROM");
    const table = this.qname();
    const where = this.eatW("WHERE") ? this.expr() : null;
    return { kind: "delete", table, where };
  }

  pragma(): Stmt {
    this.needW("PRAGMA");
    const name = this.qname().toLowerCase();
    let arg: string | null = null;
    if (this.eatOp("=")) arg = this.peek() ? (this.i++, unquote(this.t[this.i - 1].text)) : this.fail();
    else if (this.eatOp("(")) {
      arg = this.ident();
      this.needOp(")");
    }
    return { kind: "pragma", name, arg };
  }

  // expressions, lowest precedence first
  expr(): Expr {
    return this.or();
  }
  or(): Expr {
    let l = this.and();
    while (this.eatW("OR")) l = { k: "bin", op: "OR", l, r: this.and() };
    return l;
  }
  and(): Expr {
    let l = this.not();
    while (this.eatW("AND")) l = { k: "bin", op: "AND", l, r: this.not() };
    return l;
  }
  not(): Expr {
    if (this.eatW("NOT")) return { k: "un", op: "NOT", e: this.not() };
    return this.cmp();
  }
  cmp(): Expr {
    let l = this.add();
    for (;;) {
      const t = this.peek();
      if (t?.kind === "op" && ["=", "==", "!=", "<>", "<", "<=", ">", ">="].includes(t.text)) {
        this.i++;
        l = { k: "bin", op: t.text === "==" ? "=" : t.text === "<>" ? "!=" : t.text, l, r: this.add() };
      } else if (this.eatW("ISNULL")) l = { k: "isnull", not: false, e: l };
      else if (this.eatW("NOTNULL") || this.eatW("NOT", "NULL")) l = { k: "isnull", not: true, e: l };
      else if (this.isW("IS")) {
        this.i++;
        const not = this.eatW("NOT");
        if (this.eatW("NULL")) l = { k: "isnull", not, e: l };
        else l = { k: "bin", op: not ? "IS NOT" : "IS", l, r: this.add() };
      } else {
        const not = this.isW("NOT") && (this.isW("LIKE", 1) || this.isW("GLOB", 1) || this.isW("IN", 1) || this.isW("BETWEEN", 1));
        if (not) this.i++;
        if (this.eatW("LIKE") || this.eatW("GLOB")) {
          const glob = this.t[this.i - 1].text.toUpperCase() === "GLOB";
          const r = this.add();
          const esc = this.eatW("ESCAPE") ? this.add() : null;
          l = { k: "like", not, glob, l, r, esc };
        } else if (this.eatW("IN")) {
          this.needOp("(");
          if (this.isW("SELECT")) throw new Unsupported("subquery");
          const list: Expr[] = [];
          if (!this.isOp(")")) {
            do list.push(this.expr());
            while (this.eatOp(","));
          }
          this.needOp(")");
          l = { k: "in", not, e: l, list };
        } else if (this.eatW("BETWEEN")) {
          const lo = this.add();
          this.needW("AND");
          l = { k: "between", not, e: l, lo, hi: this.add() };
        } else return l;
      }
    }
  }
  add(): Expr {
    let l = this.mul();
    for (;;) {
      const t = this.peek();
      if (t?.kind === "op" && ["+", "-", "||"].includes(t.text)) {
        this.i++;
        l = { k: "bin", op: t.text, l, r: this.mul() };
      } else return l;
    }
  }
  mul(): Expr {
    let l = this.unary();
    for (;;) {
      const t = this.peek();
      if (t?.kind === "op" && ["*", "/", "%"].includes(t.text)) {
        this.i++;
        l = { k: "bin", op: t.text, l, r: this.unary() };
      } else return l;
    }
  }
  unary(): Expr {
    const t = this.peek();
    if (t?.kind === "op" && (t.text === "-" || t.text === "+" || t.text === "~")) {
      this.i++;
      return { k: "un", op: t.text, e: this.unary() };
    }
    const e = this.primary();
    if (this.eatW("COLLATE")) this.ident();
    return e;
  }
  primary(): Expr {
    const t = this.peek();
    if (!t) this.fail();
    const start = this.i;
    switch (t.kind) {
      case "num":
        this.i++;
        return { k: "lit", v: /^0x/i.test(t.text) ? Number(t.text) : /[.eE]/.test(t.text) ? Number(t.text) : intCell(t.text) };
      case "str":
        this.i++;
        return { k: "lit", v: t.text.slice(1, -1).replaceAll("''", "'") };
      case "blob":
        this.i++;
        return { k: "lit", v: { $blob: t.text.slice(2, -1).toLowerCase(), length: (t.text.length - 3) / 2 } };
      case "param": {
        this.i++;
        const m = /^\?(\d+)$/.exec(t.text);
        return { k: "param", i: m ? Number(m[1]) - 1 : this.params++ };
      }
      case "op":
        if (t.text === "(") {
          this.i++;
          if (this.isW("SELECT")) throw new Unsupported("subquery");
          const e = this.expr();
          this.needOp(")");
          return e;
        }
        this.fail();
    }
    const w = t.text.toUpperCase();
    if (t.kind !== "qid") {
      if (w === "NULL") return (this.i++, { k: "lit", v: null });
      if (w === "TRUE" || w === "FALSE") return (this.i++, { k: "lit", v: w === "TRUE" ? 1 : 0 });
      if (w === "CURRENT_TIMESTAMP") return (this.i++, { k: "fn", name: "DATETIME", args: [{ k: "lit", v: "now" }], star: false });
      if (w === "CAST") {
        this.i++;
        this.needOp("(");
        const e = this.expr();
        this.needW("AS");
        let type = this.ident();
        while (!this.isOp(")") && !this.done) type += " " + this.ident();
        this.needOp(")");
        return { k: "cast", e, type };
      }
      if (w === "CASE") {
        this.i++;
        const base = this.isW("WHEN") ? null : this.expr();
        const whens: [Expr, Expr][] = [];
        while (this.eatW("WHEN")) {
          const c = this.expr();
          this.needW("THEN");
          whens.push([c, this.expr()]);
        }
        const els = this.eatW("ELSE") ? this.expr() : null;
        this.needW("END");
        return { k: "case", base, whens, els };
      }
      if (w === "EXISTS" || w === "SELECT") throw new Unsupported("subquery");
      if (this.isOp("(", 1)) {
        this.i += 2;
        const args: Expr[] = [];
        let star = false;
        if (this.eatOp("*")) star = true;
        else if (!this.isOp(")")) {
          this.eatW("DISTINCT");
          do args.push(this.expr());
          while (this.eatOp(","));
        }
        this.needOp(")");
        return { k: "fn", name: w, args, star };
      }
    }
    const name = this.qname();
    return { k: "col", name, text: this.textFrom(start) };
  }
}

function hasAgg(e: Expr | null): boolean {
  if (!e) return false;
  switch (e.k) {
    case "fn":
      return (AGG.has(e.name) && (e.star || e.args.length <= 1 || e.name === "GROUP_CONCAT")) || e.args.some(hasAgg);
    case "un":
    case "cast":
    case "isnull":
      return hasAgg(e.e);
    case "bin":
    case "like":
      return hasAgg(e.l) || hasAgg(e.r);
    case "in":
      return hasAgg(e.e) || e.list.some(hasAgg);
    case "between":
      return hasAgg(e.e) || hasAgg(e.lo) || hasAgg(e.hi);
    case "case":
      return hasAgg(e.base) || e.whens.some(([a, b]) => hasAgg(a) || hasAgg(b)) || hasAgg(e.els);
    default:
      return false;
  }
}

// ── evaluation ──────────────────────────────────────────────────────────

interface Ctx {
  table: MTable | null;
  row: MRow | null;
  group: MRow[] | null;
  params: Param[];
  /** output columns by lower-case name (ORDER BY can name them) */
  out?: Map<string, V>;
}

function paramValue(p: Param | undefined): V {
  if (p === undefined || p === null) return null;
  if (typeof p === "boolean") return p ? 1 : 0;
  if (typeof p === "object") return { $blob: p.$blob, length: p.$blob.length / 2 };
  return p;
}

function colIndex(t: MTable | null, name: string): number {
  if (!t) throw new Error(`no such column: ${name}`);
  const i = t.columns.findIndex((c) => c.name.toLowerCase() === name.toLowerCase());
  if (i >= 0) return i;
  if (["rowid", "_rowid_", "oid"].includes(name.toLowerCase()) && t.kind !== "view") return -1;
  throw new Error(`no such column: ${name}`);
}

function evalExpr(e: Expr, c: Ctx): V {
  switch (e.k) {
    case "lit":
      return e.v;
    case "param":
      return paramValue(c.params[e.i]);
    case "col": {
      const o = c.out?.get(e.name.toLowerCase());
      if (o !== undefined) return o;
      const i = colIndex(c.table, e.name);
      if (!c.row) return null;
      if (i === -1) return c.row.rowid;
      return c.row.v[i] ?? null;
    }
    case "un": {
      const v = evalExpr(e.e, c);
      if (e.op === "NOT") return bool(truth(v) === null ? null : !truth(v));
      if (v === null) return null;
      if (e.op === "-") {
        if (isObj(v) && "$int" in v) return intCell((-BigInt(v.$int)).toString());
        return -num(v)!;
      }
      if (e.op === "~") return ~num(v)!;
      return v;
    }
    case "bin": {
      if (e.op === "AND") {
        const a = truth(evalExpr(e.l, c));
        if (a === false) return 0;
        const b = truth(evalExpr(e.r, c));
        return b === false ? 0 : a === null || b === null ? null : 1;
      }
      if (e.op === "OR") {
        const a = truth(evalExpr(e.l, c));
        if (a === true) return 1;
        const b = truth(evalExpr(e.r, c));
        return b === true ? 1 : a === null || b === null ? null : 0;
      }
      const a = evalExpr(e.l, c);
      const b = evalExpr(e.r, c);
      if (e.op === "IS") return bool(a === null || b === null ? a === b : cmp(a, b) === 0);
      if (e.op === "IS NOT") return bool(a === null || b === null ? a !== b : cmp(a, b) !== 0);
      if (e.op === "||") return a === null || b === null ? null : str(a)! + str(b)!;
      if (["=", "!=", "<", "<=", ">", ">="].includes(e.op)) {
        const r = cmp(a, b);
        if (r === null) return null;
        return bool(e.op === "=" ? r === 0 : e.op === "!=" ? r !== 0 : e.op === "<" ? r < 0 : e.op === "<=" ? r <= 0 : e.op === ">" ? r > 0 : r >= 0);
      }
      const x = num(a);
      const y = num(b);
      if (x === null || y === null) return null;
      const ints = Number.isInteger(x) && Number.isInteger(y);
      switch (e.op) {
        case "+":
          return x + y;
        case "-":
          return x - y;
        case "*":
          return x * y;
        case "/":
          return y === 0 ? null : ints ? Math.trunc(x / y) : x / y;
        case "%":
          return y === 0 ? null : ints ? x % y : x % y;
      }
      return null;
    }
    case "like": {
      const a = evalExpr(e.l, c);
      const p = evalExpr(e.r, c);
      if (a === null || p === null) return null;
      const esc = e.esc ? str(evalExpr(e.esc, c)) : null;
      let ok: boolean;
      if (e.glob) {
        const re = new RegExp("^" + str(p)!.replace(/[.+^${}()|\\]/g, "\\$&").replace(/\*/g, "[\\s\\S]*").replace(/\?/g, "[\\s\\S]") + "$");
        ok = re.test(str(a)!);
      } else ok = likeRe(str(p)!, esc).test(str(a)!);
      return bool(e.not ? !ok : ok);
    }
    case "isnull": {
      const v = evalExpr(e.e, c);
      return bool(e.not ? v !== null : v === null);
    }
    case "in": {
      const v = evalExpr(e.e, c);
      if (v === null) return null;
      const hit = e.list.some((x) => cmp(v, evalExpr(x, c)) === 0);
      return bool(e.not ? !hit : hit);
    }
    case "between": {
      const v = evalExpr(e.e, c);
      const lo = cmp(v, evalExpr(e.lo, c));
      const hi = cmp(v, evalExpr(e.hi, c));
      if (lo === null || hi === null) return null;
      const ok = lo >= 0 && hi <= 0;
      return bool(e.not ? !ok : ok);
    }
    case "cast": {
      const v = evalExpr(e.e, c);
      if (v === null) return null;
      const a = affinity(e.type);
      if (a === "INTEGER") {
        const s = str(v)!.trim();
        if (/^[+-]?\d+$/.test(s)) return intCell(s);
        return Math.trunc(num(v) ?? 0);
      }
      if (a === "REAL") return num(v);
      if (a === "TEXT") return str(v);
      if (a === "NUMERIC") return withAffinity("NUMERIC", str(v));
      return v;
    }
    case "case": {
      const base = e.base ? evalExpr(e.base, c) : null;
      for (const [w, t] of e.whens) {
        const v = evalExpr(w, c);
        if (e.base ? cmp(base, v) === 0 : truth(v)) return evalExpr(t, c);
      }
      return e.els ? evalExpr(e.els, c) : null;
    }
    case "fn":
      return callFn(e, c);
  }
}

function fmtDate(ms: number, what: string): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  const date = `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
  const time = `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
  return what === "DATE" ? date : what === "TIME" ? time : `${date} ${time}`;
}

function timeArg(args: V[]): number | null {
  const v = args[0];
  if (v === null || v === undefined) return null;
  const mods = args.slice(1).map((m) => (str(m) ?? "").toLowerCase());
  if (typeof v === "string" && v.toLowerCase() === "now") return Date.now();
  if (mods.includes("unixepoch") || typeof v === "number") {
    const n = num(v)!;
    return mods.includes("unixepoch") ? n * 1000 : (n - 2440587.5) * 86400000;
  }
  const t = Date.parse(str(v)!.replace(" ", "T") + (str(v)!.length <= 10 ? "" : "Z"));
  return Number.isNaN(t) ? null : t;
}

function callFn(e: Extract<Expr, { k: "fn" }>, c: Ctx): V {
  const { name } = e;
  if (AGG.has(name) && c.group && (e.star || e.args.length <= 1 || name === "GROUP_CONCAT")) {
    const vals = e.star ? c.group.map(() => 1 as V) : c.group.map((row) => evalExpr(e.args[0], { ...c, row, group: null })).filter((v) => v !== null);
    switch (name) {
      case "COUNT":
        return vals.length;
      case "SUM":
        return vals.length ? vals.reduce<number>((a, v) => a + (num(v) ?? 0), 0) : null;
      case "TOTAL":
        return vals.reduce<number>((a, v) => a + (num(v) ?? 0), 0);
      case "AVG":
        return vals.length ? vals.reduce<number>((a, v) => a + (num(v) ?? 0), 0) / vals.length : null;
      case "MIN":
      case "MAX":
        return vals.reduce<V>((a, v) => (a === null ? v : (cmp(v, a) ?? 0) * (name === "MIN" ? -1 : 1) > 0 ? v : a), null);
      case "GROUP_CONCAT": {
        const sep = e.args[1] ? str(evalExpr(e.args[1], c)) ?? "," : ",";
        return vals.length ? vals.map((v) => str(v)).join(sep) : null;
      }
    }
  }
  const a = e.args.map((x) => evalExpr(x, c));
  const s0 = a.length ? str(a[0]) : null;
  switch (name) {
    case "LOWER":
      return s0 === null ? null : s0.toLowerCase();
    case "UPPER":
      return s0 === null ? null : s0.toUpperCase();
    case "LENGTH": {
      const v = a[0];
      if (v === null) return null;
      if (isObj(v) && "$blob" in v) return v.length;
      if (isObj(v) && "$text" in v) return v.length;
      return s0!.length;
    }
    case "ABS":
      return a[0] === null ? null : Math.abs(num(a[0])!);
    case "TYPEOF": {
      const v = a[0];
      if (v === null) return "null";
      if (typeof v === "number") return Number.isInteger(v) ? "integer" : "real";
      if (typeof v === "string") return "text";
      return "$int" in v ? "integer" : "$real" in v ? "real" : "$text" in v ? "text" : "blob";
    }
    case "COALESCE":
    case "IFNULL":
      return a.find((v) => v !== null) ?? null;
    case "NULLIF":
      return cmp(a[0], a[1]) === 0 ? null : a[0];
    case "IIF":
      return truth(a[0]) ? a[1] : a[2];
    case "SUBSTR":
    case "SUBSTRING": {
      if (s0 === null) return null;
      const st = num(a[1]) ?? 1;
      const len = a[2] !== undefined ? num(a[2])! : undefined;
      const from = st > 0 ? st - 1 : Math.max(0, s0.length + st);
      return len === undefined ? s0.slice(from) : s0.slice(from, from + len);
    }
    case "INSTR":
      return s0 === null || a[1] === null ? null : s0.indexOf(str(a[1])!) + 1;
    case "REPLACE":
      return s0 === null ? null : s0.split(str(a[1]) ?? "").join(str(a[2]) ?? "");
    case "TRIM":
      return s0?.trim() ?? null;
    case "LTRIM":
      return s0?.trimStart() ?? null;
    case "RTRIM":
      return s0?.trimEnd() ?? null;
    case "ROUND": {
      const n = num(a[0]);
      const d = num(a[1] ?? 0) ?? 0;
      return n === null ? null : Math.round(n * 10 ** d) / 10 ** d;
    }
    case "HEX": {
      const v = a[0];
      if (v === null) return "";
      if (isObj(v) && "$blob" in v) return v.$blob.toUpperCase();
      return Array.from(new TextEncoder().encode(str(v)!))
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("")
        .toUpperCase();
    }
    case "QUOTE":
      return a[0] === null ? "NULL" : typeof a[0] === "string" ? `'${a[0].replaceAll("'", "''")}'` : str(a[0]);
    case "MAX":
    case "MIN":
      return a.some((v) => v === null) ? null : a.reduce<V>((x, v) => ((cmp(v, x) ?? 0) * (name === "MIN" ? -1 : 1) > 0 ? v : x), a[0]);
    case "SQLITE_VERSION":
      return "3.50.4";
    case "RANDOM":
      return Math.floor(Math.random() * 2 ** 52) - 2 ** 51;
    case "UNIXEPOCH": {
      const t = a.length ? timeArg(a) : Date.now();
      return t === null ? null : Math.floor(t / 1000);
    }
    case "DATETIME":
    case "DATE":
    case "TIME": {
      const t = timeArg(a.length ? a : ["now"]);
      return t === null ? null : fmtDate(t, name);
    }
    case "STRFTIME": {
      const t = timeArg(a.slice(1));
      if (t === null || s0 === null) return null;
      const iso = fmtDate(t, "DATETIME");
      return s0
        .replace("%Y", iso.slice(0, 4))
        .replace("%m", iso.slice(5, 7))
        .replace("%d", iso.slice(8, 10))
        .replace("%H", iso.slice(11, 13))
        .replace("%M", iso.slice(14, 16))
        .replace("%S", iso.slice(17, 19))
        .replace("%s", String(Math.floor(t / 1000)));
    }
    case "JSON_EXTRACT": {
      if (s0 === null) return null;
      try {
        let v: unknown = JSON.parse(s0);
        for (const part of (str(a[1]) ?? "$").replace(/^\$\.?/, "").split(".").filter(Boolean)) v = (v as Record<string, unknown>)?.[part];
        if (v === undefined || v === null) return null;
        return typeof v === "object" ? JSON.stringify(v) : typeof v === "boolean" ? Number(v) : (v as V);
      } catch {
        throw new Error("malformed JSON");
      }
    }
    case "COUNT":
    case "SUM":
    case "TOTAL":
    case "AVG":
    case "GROUP_CONCAT":
      throw new Error(`misuse of aggregate function ${name.toLowerCase()}()`);
  }
  throw new Error(`no such function: ${name}`);
}

// ── running statements ──────────────────────────────────────────────────

export interface RunResult {
  columns: { name: string; declType: string | null }[];
  rows: Cell[][];
  returnedRows: boolean;
  changes: number;
  lastInsertRowid: number;
}

export class Engine {
  lastInsertRowid = 0;
  constructor(public db: MDb) {}

  table(name: string): MTable {
    const t = this.db.tables.find((x) => x.name.toLowerCase() === name.toLowerCase());
    if (!t) throw new Error(`no such table: ${name}`);
    return t;
  }
  rowsOf(t: MTable): MRow[] {
    return t.compute ? t.compute() : t.rows;
  }

  /** Every statement in `sql`; the last one returning rows is the result. */
  run(sql: string, params: Param[], writable: boolean): RunResult & { statements: number } {
    const toks = tokenize(sql).filter((t) => t.kind !== "ws" && t.kind !== "com");
    const parts: Tok[][] = [[]];
    for (const t of toks) {
      if (t.kind === "op" && t.text === ";") parts.push([]);
      else parts[parts.length - 1].push(t);
    }
    let out: RunResult = { columns: [], rows: [], returnedRows: false, changes: 0, lastInsertRowid: this.lastInsertRowid };
    let changes = 0;
    let statements = 0;
    for (const p of parts) {
      if (!p.length) continue;
      statements++;
      let stmt: Stmt;
      try {
        stmt = new Parser(p).statement();
      } catch (e) {
        if (e instanceof Unsupported) stmt = { kind: "unsupported", why: e.message };
        else throw e;
      }
      const r = this.exec(stmt, params, writable);
      changes += r.changes;
      if (r.returnedRows) out = r;
    }
    return { ...out, changes, lastInsertRowid: this.lastInsertRowid, statements };
  }

  private exec(s: Stmt, params: Param[], writable: boolean): RunResult {
    const none = (changes = 0): RunResult => ({ columns: [], rows: [], returnedRows: false, changes, lastInsertRowid: this.lastInsertRowid });
    const write = (t?: MTable) => {
      if (!writable) throw new Error("attempt to write a readonly database");
      if (t?.kind === "view") throw new Error(`cannot modify ${t.name} because it is a view`);
      if (t?.kind === "virtual") throw new Error(`table ${t.name} may not be modified`);
    };
    switch (s.kind) {
      case "unsupported":
        return {
          columns: [
            { name: "note", declType: null },
            { name: "value", declType: null },
          ],
          rows: [
            ["The dev mock can't run this kind of statement", s.why],
            ["It would run against the real database in Shellmosaic", 42],
          ],
          returnedRows: true,
          changes: 0,
          lastInsertRowid: this.lastInsertRowid,
        };
      case "other":
        if (s.writes) write();
        return none();
      case "pragma":
        return this.pragma(s.name, s.arg, writable);
      case "select":
        return this.select(s, params);
      case "insert": {
        const t = this.table(s.table);
        write(t);
        return none(this.insert(t, s, params));
      }
      case "update": {
        const t = this.table(s.table);
        write(t);
        let n = 0;
        const idx = s.sets.map(([c]) => colIndex(t, c));
        for (const row of t.rows) {
          const ctx: Ctx = { table: t, row, group: null, params };
          if (s.where && !truth(evalExpr(s.where, ctx))) continue;
          const vals = s.sets.map(([, e]) => evalExpr(e, ctx));
          const changed = new Set<string>();
          idx.forEach((ci, k) => {
            if (ci === -1) {
              row.rowid = num(vals[k]) ?? row.rowid;
              return;
            }
            const col = t.columns[ci];
            const v = withAffinity(col.type, vals[k]);
            if (v === null && col.notNull) throw new Error(`NOT NULL constraint failed: ${t.name}.${col.name}`);
            row.v[ci] = v;
            changed.add(col.name);
            if (col.pk && !t.withoutRowid && affinity(col.type) === "INTEGER" && t.columns.filter((x) => x.pk).length === 1) row.rowid = num(v) ?? row.rowid;
          });
          t.afterUpdate?.(row, changed);
          n++;
        }
        return none(n);
      }
      case "delete": {
        const t = this.table(s.table);
        write(t);
        const before = t.rows.length;
        t.rows = t.rows.filter((row) => !(s.where ? truth(evalExpr(s.where, { table: t, row, group: null, params })) : true));
        return none(before - t.rows.length);
      }
    }
  }

  private insert(t: MTable, s: Extract<Stmt, { kind: "insert" }>, params: Param[]): number {
    const pkCols = t.columns.filter((c) => c.pk);
    const alias = !t.withoutRowid && pkCols.length === 1 && pkCols[0].type.toUpperCase() === "INTEGER" ? t.columns.indexOf(pkCols[0]) : -1;
    const targets = s.cols ? s.cols.map((c) => colIndex(t, c)) : t.columns.map((_, i) => i).filter((i) => !t.columns[i].hidden);
    const rows = s.rows ?? [[]];
    let n = 0;
    for (const exprs of rows) {
      if (s.rows && exprs.length !== targets.length) throw new Error(`${targets.length} columns but ${exprs.length} values were supplied`);
      const v: Cell[] = t.columns.map((c) => (c.dflt ? c.dflt() : null));
      let rowid: number | null = null;
      exprs.forEach((e, k) => {
        const ci = targets[k];
        const val = evalExpr(e, { table: null, row: null, group: null, params });
        if (ci === -1) rowid = num(val);
        else v[ci] = withAffinity(t.columns[ci].type, val);
      });
      if (alias >= 0 && v[alias] !== null) rowid = num(v[alias]);
      const maxId = t.rows.reduce((m, r) => Math.max(m, r.rowid), 0);
      if (rowid === null) rowid = maxId + 1;
      if (alias >= 0) v[alias] = rowid;
      t.columns.forEach((c, i) => {
        if (c.notNull && v[i] === null) throw new Error(`NOT NULL constraint failed: ${t.name}.${c.name}`);
      });
      const clash = t.withoutRowid
        ? t.rows.findIndex((r) => pkCols.every((c) => cmp(r.v[t.columns.indexOf(c)], v[t.columns.indexOf(c)]) === 0))
        : t.rows.findIndex((r) => r.rowid === rowid);
      if (clash >= 0) {
        if (s.or === "REPLACE") t.rows.splice(clash, 1);
        else if (s.or === "IGNORE") continue;
        else throw new Error(`UNIQUE constraint failed: ${t.withoutRowid || alias >= 0 ? pkCols.map((c) => `${t.name}.${c.name}`).join(", ") : `${t.name}.rowid`}`);
      }
      t.rows.push({ rowid, v });
      if (!t.withoutRowid) this.lastInsertRowid = rowid;
      if (t.autoincrement) {
        const seq = this.db.tables.find((x) => x.name === "sqlite_sequence");
        const r = seq?.rows.find((x) => x.v[0] === t.name);
        if (r) r.v[1] = Math.max(num(r.v[1]) ?? 0, rowid);
      }
      n++;
    }
    return n;
  }

  private select(s: Extract<Stmt, { kind: "select" }>, params: Param[]): RunResult {
    const t = s.from ? this.table(s.from) : null;
    let src: MRow[] = t ? this.rowsOf(t) : [{ rowid: 0, v: [] }];
    const base: Ctx = { table: t, row: null, group: null, params };
    if (s.where) src = src.filter((row) => truth(evalExpr(s.where!, { ...base, row })));

    // output columns
    const columns: { name: string; declType: string | null }[] = [];
    const getters: ((c: Ctx) => V)[] = [];
    for (const rc of s.cols) {
      if (rc.star) {
        if (!t) throw new Error("no tables specified");
        t.columns.forEach((col, i) => {
          if (col.hidden === 1) return;
          columns.push({ name: col.name, declType: col.type || null });
          getters.push((c) => c.row?.v[i] ?? null);
        });
      } else {
        const e = rc.e!;
        let declType: string | null = null;
        if (e.k === "col" && t) {
          const ci = t.columns.findIndex((x) => x.name.toLowerCase() === e.name.toLowerCase());
          declType = ci >= 0 ? t.columns[ci].type || null : ["rowid", "_rowid_", "oid"].includes(e.name.toLowerCase()) ? "INTEGER" : null;
        }
        columns.push({ name: rc.alias ?? (e.k === "col" ? e.name : rc.text), declType: rc.alias && e.k !== "col" ? null : declType });
        getters.push((c) => evalExpr(e, c));
      }
    }

    // rows (grouped when there are aggregates)
    const aggregate = s.group.length > 0 || s.cols.some((c) => hasAgg(c.e));
    let units: { row: MRow | null; group: MRow[] | null }[];
    if (aggregate) {
      const groups = new Map<string, MRow[]>();
      if (!s.group.length) groups.set("", src);
      else
        for (const row of src) {
          const k = JSON.stringify(s.group.map((g) => evalExpr(g, { ...base, row })));
          const list = groups.get(k);
          if (list) list.push(row);
          else groups.set(k, [row]);
        }
      units = [...groups.values()].map((g) => ({ row: g[0] ?? null, group: g }));
      if (s.having) units = units.filter((u) => truth(evalExpr(s.having!, { ...base, ...u })));
    } else units = src.map((row) => ({ row, group: null }));

    let out = units.map((u) => {
      const c: Ctx = { ...base, ...u };
      const vals = getters.map((g) => g(c));
      return { u, vals };
    });

    if (s.order.length) {
      const keyed = out.map((o) => {
        const names = new Map<string, V>();
        columns.forEach((col, i) => names.set(col.name.toLowerCase(), o.vals[i]));
        const keys = s.order.map(({ e }) => {
          if (e.k === "lit" && typeof e.v === "number") return o.vals[e.v - 1] ?? null;
          return evalExpr(e, { ...base, ...o.u, out: names });
        });
        return { o, keys };
      });
      keyed.sort((a, b) => {
        for (let i = 0; i < s.order.length; i++) {
          const x = a.keys[i];
          const y = b.keys[i];
          const r = x === null || y === null ? (x === y ? 0 : x === null ? -1 : 1) : cmp(x, y)!;
          if (r) return s.order[i].desc ? -r : r;
        }
        return 0;
      });
      out = keyed.map((k) => k.o);
    }
    const off = s.offset ? (num(evalExpr(s.offset, base)) ?? 0) : 0;
    const lim = s.limit ? (num(evalExpr(s.limit, base)) ?? -1) : -1;
    out = out.slice(off, lim < 0 ? undefined : off + lim);
    return { columns, rows: out.map((o) => o.vals), returnedRows: true, changes: 0, lastInsertRowid: this.lastInsertRowid };
  }

  private pragma(name: string, arg: string | null, writable: boolean): RunResult {
    const one = (col: string, v: V): RunResult => ({ columns: [{ name: col, declType: null }], rows: [[v]], returnedRows: true, changes: 0, lastInsertRowid: this.lastInsertRowid });
    const info = this.db.info;
    switch (name) {
      case "quick_check":
      case "integrity_check":
        return one(name, "ok");
      case "user_version":
        if (arg !== null) {
          if (!writable) throw new Error("attempt to write a readonly database");
          info.userVersion = Number(arg);
          return one(name, info.userVersion);
        }
        return one(name, info.userVersion);
      case "application_id":
        return one(name, info.applicationId);
      case "page_size":
        return one(name, info.pageSize);
      case "journal_mode":
        return one(name, info.journalMode);
      case "freelist_count":
        return one(name, info.freelistCount);
      case "encoding":
        return one(name, "UTF-8");
      case "foreign_keys":
        return one(name, 0);
      case "table_info":
      case "table_xinfo": {
        const t = this.table(arg ?? "");
        return {
          columns: ["cid", "name", "type", "notnull", "dflt_value", "pk"].map((n) => ({ name: n, declType: null })),
          rows: t.columns.map((c, i) => [i, c.name, c.type, c.notNull ? 1 : 0, c.default ?? null, c.pk ?? 0]),
          returnedRows: true,
          changes: 0,
          lastInsertRowid: this.lastInsertRowid,
        };
      }
      case "table_list":
        return {
          columns: ["schema", "name", "type", "ncol", "wr", "strict"].map((n) => ({ name: n, declType: null })),
          rows: this.db.tables.map((t) => ["main", t.name, t.kind === "view" ? "view" : t.kind === "virtual" ? "virtual" : "table", t.columns.length, t.withoutRowid ? 1 : 0, 0]),
          returnedRows: true,
          changes: 0,
          lastInsertRowid: this.lastInsertRowid,
        };
      default:
        return { columns: [], rows: [], returnedRows: false, changes: 0, lastInsertRowid: this.lastInsertRowid };
    }
  }

  /** The schema as sqlite.schema() returns it. */
  schema(): SchemaObject[] {
    const out: SchemaObject[] = [];
    for (const t of this.db.tables) {
      const cols = t.columns.map((c, cid) => ({ cid, name: c.name, type: c.type, notNull: !!c.notNull, default: c.default ?? null, pk: c.pk ?? 0, hidden: c.hidden ?? 0 }));
      const ix = this.db.indexes.filter((i) => i.tbl === t.name).map((i) => ({ name: i.name, unique: i.unique, origin: i.origin, partial: i.partial, columns: i.columns }));
      out.push({
        type: t.kind === "view" ? "view" : "table",
        name: t.name,
        tblName: t.name,
        sql: t.sql,
        withoutRowid: !!t.withoutRowid,
        virtual: t.kind === "virtual",
        columns: cols,
        indexes: t.kind === "view" ? [] : ix,
        foreignKeys: t.fks ?? [],
      });
    }
    for (const i of this.db.indexes)
      out.push({ type: "index", name: i.name, tblName: i.tbl, sql: i.sql, withoutRowid: false, virtual: false, columns: [], indexes: [], foreignKeys: [] });
    for (const tr of this.db.triggers)
      out.push({ type: "trigger", name: tr.name, tblName: tr.tbl, sql: tr.sql, withoutRowid: false, virtual: false, columns: [], indexes: [], foreignKeys: [] });
    return out;
  }
}

export type { QueryResult };
