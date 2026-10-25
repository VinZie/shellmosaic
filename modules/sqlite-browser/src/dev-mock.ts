// Dev only (`node modules/build.mjs --dev sqlite-browser`): a fake host with two
// in-memory databases. Paths decide what happens:
//   …History…  a Chrome-style history database, opened from a copy ("locked")
//   …notadb…   "This isn't a SQLite database (or it's encrypted)."
//   …missing…  the file doesn't exist
//   …nocopy…   locked and can't be copied
//   \\server\… only local paths
//   anything else: a chat app's database
import { createElement } from "react";
import { openModal, type DbInfo, type Param, type QueryResult } from "../../shared";
import { installMock } from "../../shared/mock";
import { chatDb, historyDb } from "./mock/data";
import { Engine } from "./mock/engine";

interface Conn {
  id: number;
  path: string;
  engine: Engine;
  writable: boolean;
  copied: boolean;
  copyReason: string | null;
  busy: number;
  interrupt: boolean;
}

const SAMPLE_PATHS = [
  "C:\\Users\\dev\\AppData\\Roaming\\Chatter\\chat.db",
  "C:\\Users\\dev\\AppData\\Local\\Google\\Chrome\\User Data\\Default\\History",
  "C:\\Users\\dev\\Downloads\\backup-notadb.sqlite",
  "D:\\old\\missing.db",
];

function seed(key: string, value: unknown) {
  const k = `mock:sqlite-browser:storage:${key}`;
  if (localStorage.getItem(k) === null) localStorage.setItem(k, JSON.stringify(value));
}

/** The app's own dialogs, drawn in the page. */
function dialog(title: string, message: string, ok: string, danger: boolean, cancel: string | null): Promise<boolean> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v: boolean) => {
      if (!done) resolve(v);
      done = true;
    };
    openModal(
      (close) =>
        createElement(
          "div",
          { className: "sm-dialog" },
          createElement("h3", null, title),
          createElement("p", { style: { margin: 0, color: "var(--dim)", lineHeight: 1.5 } }, message),
          createElement(
            "div",
            { className: "sm-dialog-buttons" },
            cancel && createElement("button", { type: "button", className: "sm-btn subtle", onClick: () => (finish(false), close()) }, cancel),
            createElement("button", { type: "button", className: `sm-btn ${danger ? "danger" : "primary"}`, autoFocus: true, onClick: () => (finish(true), close()) }, ok),
          ),
        ),
      () => finish(false),
    );
  });
}

function pickDialog(): Promise<string | null> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v: string | null) => {
      if (!done) resolve(v);
      done = true;
    };
    openModal(
      (close) =>
        createElement(
          "div",
          { className: "sm-dialog", style: { width: 460 } },
          createElement("h3", null, "Open (dev mock)"),
          ...SAMPLE_PATHS.map((p) =>
            createElement(
              "button",
              { key: p, type: "button", className: "sm-btn subtle", style: { width: "100%", justifyContent: "flex-start", fontFamily: "var(--mono)", fontSize: 11.5 }, onClick: () => (finish(p), close()) },
              p,
            ),
          ),
        ),
      () => finish(null),
    );
  });
}

export function install() {
  seed("recent", [
    { path: SAMPLE_PATHS[0], file: "chat.db", at: Date.now() - 4 * 60_000 },
    { path: SAMPLE_PATHS[1], file: "History", at: Date.now() - 26 * 3600_000 },
    { path: "C:\\Users\\dev\\Saved Games\\Stardew\\save-backup.db", file: "save-backup.db", at: Date.now() - 4 * 86400_000 },
    { path: "D:\\old\\missing.db", file: "missing.db", at: Date.now() - 40 * 86400_000 },
  ]);
  seed("history", [
    { sql: "SELECT sender_id, COUNT(*) AS n FROM messages GROUP BY sender_id ORDER BY n DESC LIMIT 10", at: Date.now() - 3 * 60_000, file: "chat.db", ok: true, rows: 10 },
    { sql: "SELECT * FROM users WHERE email IS NULL", at: Date.now() - 50 * 60_000, file: "chat.db", ok: true, rows: 9 },
    { sql: "UPDATE users SET is_bot = 1 WHERE username LIKE '%-bot'", at: Date.now() - 2 * 3600_000, file: "chat.db", ok: false },
    { sql: "SELECT url, title, visit_count FROM urls ORDER BY visit_count DESC LIMIT 50", at: Date.now() - 26 * 3600_000, file: "History", ok: true, rows: 50 },
  ]);

  const engines = new Map<string, Engine>();
  const conns = new Map<number, Conn>();
  let nextId = 1;

  const conn = (id: number) => {
    const c = conns.get(id);
    if (!c) throw new Error("this database was closed");
    return c;
  };
  const wait = (ms: number, c?: Conn) =>
    new Promise<void>((resolve, reject) => {
      const end = Date.now() + ms;
      const tick = () => {
        if (c?.interrupt) {
          c.interrupt = false;
          return reject(new Error("interrupted"));
        }
        if (Date.now() >= end) resolve();
        else setTimeout(tick, Math.min(40, ms));
      };
      tick();
    });
  const busy = async <T>(c: Conn, ms: number, fn: () => T): Promise<T> => {
    c.busy++;
    try {
      await wait(ms, c);
      return fn();
    } finally {
      c.busy--;
    }
  };
  const info = (c: Conn): DbInfo => {
    const db = c.engine.db;
    const rows = db.tables.reduce((n, t) => n + t.rows.length, 0);
    const pageCount = 48 + Math.ceil(rows * 0.39);
    return {
      id: c.id,
      path: c.path,
      file: c.path.split(/[\\/]/).pop() ?? c.path,
      copied: c.copied,
      copyReason: c.copyReason,
      writable: c.writable,
      size: pageCount * db.info.pageSize,
      sqliteVersion: db.info.sqliteVersion,
      pageSize: db.info.pageSize,
      pageCount,
      encoding: "UTF-8",
      journalMode: db.info.journalMode,
      userVersion: db.info.userVersion,
      applicationId: db.info.applicationId,
      freelistCount: db.info.freelistCount,
    };
  };

  installMock(
    {
      ui: {
        confirm: (title: string, message: string, opts?: { okLabel?: string; danger?: boolean }) => dialog(title, message, opts?.okLabel ?? "OK", !!opts?.danger, "Cancel"),
        pickFile: () => pickDialog(),
      },
      sqlite: {
        open: async (path: string, opts?: { writable?: boolean; copy?: boolean }) => {
          await new Promise((r) => setTimeout(r, 260));
          if (/notadb/i.test(path)) throw new Error("This isn't a SQLite database (or it's encrypted).");
          if (/missing/i.test(path)) throw new Error("The system cannot find the file specified. (os error 2)");
          if (/nocopy/i.test(path))
            throw new Error("The file is locked by another program and couldn't be copied: The process cannot access the file because it is being used by another process. (os error 32)");
          if (/^(\\\\|\/\/|[a-z]+:\/\/)/i.test(path)) throw new Error("Only local files can be opened.");
          const history = /history/i.test(path);
          const copied = history || !!opts?.copy;
          const key = path.toLowerCase() + (copied ? `#copy${nextId}` : "");
          let engine = engines.get(key);
          if (!engine) engines.set(key, (engine = new Engine(history ? historyDb() : chatDb())));
          const c: Conn = {
            id: nextId++,
            path,
            engine,
            writable: !!opts?.writable,
            copied,
            copyReason: history ? "The file is locked by another program (probably the browser), so a temporary copy was opened." : copied ? "You asked to open a copy." : null,
            busy: 0,
            interrupt: false,
          };
          conns.set(c.id, c);
          return info(c);
        },
        schema: async (id: number) => {
          const c = conn(id);
          return busy(c, 120, () => c.engine.schema());
        },
        count: async (id: number, table: string) => {
          const c = conn(id);
          const t = c.engine.table(table);
          const n = c.engine.rowsOf(t).length;
          return busy(c, 90 + n / 25, () => c.engine.rowsOf(c.engine.table(table)).length);
        },
        query: async (id: number, sql: string, params?: Param[], opts?: { maxRows?: number }): Promise<QueryResult> => {
          const c = conn(id);
          const slow = /\bslow\b|randomblob|recursive/i.test(sql);
          const ms = slow ? 6000 : 50 + Math.random() * 90;
          const t0 = performance.now();
          return busy(c, ms, () => {
            const r = c.engine.run(sql, params ?? [], c.writable);
            const max = opts?.maxRows ?? 10_000;
            return {
              columns: r.columns,
              rows: r.rows.slice(0, max),
              truncated: r.rows.length > max,
              changes: r.changes,
              lastInsertRowid: r.lastInsertRowid,
              elapsedMs: performance.now() - t0,
              statements: r.statements,
              returnedRows: r.returnedRows,
            };
          });
        },
        setWritable: async (id: number, writable: boolean) => {
          const c = conn(id);
          await new Promise((r) => setTimeout(r, 150));
          c.writable = writable;
          return info(c);
        },
        interrupt: async (id: number) => {
          const c = conns.get(id);
          if (c && c.busy > 0) c.interrupt = true;
          return true;
        },
        close: async (id: number) => {
          conns.delete(id);
          return true;
        },
      },
    },
    "sqlite-browser",
  );
}
