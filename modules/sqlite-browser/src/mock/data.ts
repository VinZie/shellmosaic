// Dev only: two made-up databases for the mock — a chat app and a browser history.
import type { Cell } from "../../../shared";
import type { MCol, MDb, MRow, MTable } from "./engine";

function rng(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const asciiHex = (s: string) => Array.from(new TextEncoder().encode(s), (b) => b.toString(16).padStart(2, "0")).join("");

function blob(header: string, length: number, r: () => number): Cell {
  let hex = header;
  const want = Math.min(256, length) * 2;
  while (hex.length < want) hex += Math.floor(r() * 256).toString(16).padStart(2, "0");
  return { $blob: hex.slice(0, want), length };
}

const PNG = "89504e470d0a1a0a0000000d49484452000000800000008008060000003e61cbc1";
const JPEG = "ffd8ffe000104a46494600010101004800480000ffdb004300";
const PDF = asciiHex("%PDF-1.7\n%âã\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n");
const ZIP = "504b0304140000000800";

function table(name: string, sql: string, columns: MCol[], rows: MRow[], extra: Partial<MTable> = {}): MTable {
  return { name, kind: "table", sql, columns, rows, ...extra };
}

// ── chat.db ─────────────────────────────────────────────────────────────

const PEOPLE = [
  "alice", "bob", "carol", "dave", "erin", "frank", "grace", "heidi", "ivan", "judy", "mallory", "niaj", "olivia", "peggy", "rupert", "sybil",
  "trent", "victor", "walter", "wendy", "xavier", "yasmin", "zoe", "arthur", "beatrice", "cedric", "delia", "emil", "fatima", "gustav", "hana",
  "igor", "jonas", "kira", "leon", "mila", "noah", "oscar",
];
const SURNAMES = ["Nguyen", "Okafor", "Lindqvist", "Moreau", "Kowalski", "Tanaka", "Haddad", "Silva", "Novak", "Fischer", "Rossi", "Byrne"];
const LINES = [
  "Morning! Did the nightly build go through?",
  "Pushed a fix for the flaky login test, can someone review?",
  "I think the migration is missing an index on sent_at",
  "lunch at 12:30?",
  "Can you send me the invoice from March",
  "The staging DB is read-only until the backup finishes",
  "ok 👍",
  "Looks good to me, merging",
  "Has anyone seen the crash in the export dialog? Stack trace attached",
  "Reminder: retro at 4pm",
  "I'll take the on-call shift this weekend",
  "We should rotate that API key, it was in a screenshot",
  "Can't reproduce on Windows 11, only on 10",
  "Sharing the slides from today",
  "The new onboarding flow is live 🎉",
  "brb",
  "Who owns the billing service now?",
  "Customer reports emails arriving twice since yesterday",
  "Let's move this to a thread",
  "Sounds good",
  "Rolling back 2.14.2, error rate is up",
  "Updated the runbook with the new failover steps",
  "Can we pair on this tomorrow?",
  "The password reset link expires too fast (5 min)",
  "thanks!",
  "Quick question about the SQLite schema: is user_version bumped on every release?",
];
const LONG_PARAGRAPH =
  "Post-incident summary: at 02:14 UTC the primary database ran out of disk because WAL checkpoints were starved by a long-running read transaction from the analytics exporter. " +
  "Writes started failing with SQLITE_FULL, the API returned 500s for 11 minutes, and the on-call engineer freed space by moving old backups. Follow-ups: cap the exporter's transaction time, " +
  "alert on WAL size, and run PRAGMA wal_checkpoint(TRUNCATE) after the nightly job. ";

export function chatDb(): MDb {
  const r = rng(7);
  const pick = <T>(a: T[]) => a[Math.floor(r() * a.length)];

  const users: MRow[] = [];
  const names = [...PEOPLE, "deploy-bot", "standup-bot"];
  names.forEach((name, i) => {
    const bot = name.endsWith("-bot");
    const display = bot ? null : r() < 0.85 ? `${name[0].toUpperCase()}${name.slice(1)} ${pick(SURNAMES)}` : null;
    const settings =
      r() < 0.7 ? JSON.stringify({ theme: pick(["dark", "light", "system"]), notifications: { mentions: true, sounds: r() < 0.5 }, locale: pick(["en-US", "de-DE", "fr-FR", "ja-JP"]), sidebarWidth: 240 + Math.floor(r() * 80) }) : null;
    users.push({
      rowid: i + 1,
      v: [i + 1, name, display, bot || r() < 0.2 ? null : `${name}@example.com`, r() < 0.6 && !bot ? blob(PNG, 1200 + Math.floor(r() * 8000), r) : null, 1704067200 + Math.floor(r() * 300 * 86400), bot ? 1 : 0, settings],
    });
  });

  const convs: MRow[] = [];
  const groups = ["general", "random", "release-planning", "design-review", "oncall", "book-club"];
  for (let i = 1; i <= 24; i++) convs.push({ rowid: i, v: [i, i <= groups.length ? "group" : "dm", i <= groups.length ? groups[i - 1] : null, 1704067200 + i * 86400 * 3, r() < 0.15 ? 1 : 0] });

  const messages: MRow[] = [];
  let t = 1735689600;
  let snow = 1290000000000000000n;
  for (let id = 1; id <= 5000; id++) {
    t += 60 + Math.floor(r() * 9000);
    snow += BigInt(Math.floor(r() * 4194304 * 1000));
    const sender = r() < 0.02 ? null : 1 + Math.floor(r() * names.length);
    const bot = sender !== null && sender > PEOPLE.length;
    let body: Cell;
    if (id === 1234) body = { $text: (LONG_PARAGRAPH + "\n").repeat(12).slice(0, 4000), length: 184_322 };
    else if (r() < 0.03) body = null;
    else if (bot)
      body = JSON.stringify(
        names[sender! - 1] === "deploy-bot"
          ? { event: "deploy", service: pick(["api", "web", "billing", "search"]), version: `2.${10 + Math.floor(r() * 6)}.${Math.floor(r() * 9)}`, status: pick(["succeeded", "succeeded", "failed"]), duration_ms: Math.floor(r() * 90000) }
          : { event: "standup", day: new Date(t * 1000).toISOString().slice(0, 10), done: [pick(LINES)], blocked: r() < 0.2 },
      );
    else if (r() < 0.02) body = LONG_PARAGRAPH.repeat(1 + Math.floor(r() * 4)).trim();
    else if (r() < 0.08) body = `${pick(LINES)}\n${pick(LINES)}`;
    else body = pick(LINES);
    const reactions = r() < 0.15 ? JSON.stringify({ [pick(["👍", "🎉", "❤️", "😂", "👀"])]: [pick(PEOPLE), pick(PEOPLE)].filter((v, i, a) => a.indexOf(v) === i) }) : null;
    const flags = r() < 0.02 ? 1 : r() < 0.01 ? 4 : 0;
    messages.push({
      rowid: id,
      v: [id, 1 + Math.floor(r() ** 1.6 * 24), sender, body, t, r() < 0.05 ? t + Math.floor(r() * 3600) : null, { $int: snow.toString() }, reactions, flags],
    });
  }

  const attachments: MRow[] = [];
  const kinds: [string, string, string][] = [
    ["screenshot-{d}.png", "image/png", PNG],
    ["photo_{n}.jpg", "image/jpeg", JPEG],
    ["invoice-{n}.pdf", "application/pdf", PDF],
    ["logs-{d}.zip", "application/zip", ZIP],
    ["notes.txt", "text/plain", asciiHex("TODO\n- rotate the API key\n- check the backups\n- reply to the customer about duplicate emails\n")],
  ];
  let k = 0;
  for (let mid = 3; mid <= 5000 && attachments.length < 320; mid += 1 + Math.floor(r() * 30)) {
    const n = 1 + Math.floor(r() * (r() < 0.2 ? 3 : 1));
    for (let idx = 0; idx < n; idx++) {
      const [tpl, mime, header] = pick(kinds);
      const size = mime === "text/plain" ? 96 : 20_000 + Math.floor(r() * 2_400_000);
      const day = new Date((1735689600 + mid * 4000) * 1000).toISOString().slice(0, 10);
      attachments.push({ rowid: ++k, v: [mid, idx, tpl.replace("{d}", day).replace("{n}", String(1000 + mid)), mime, size, r() < 0.05 ? null : blob(header, size, r)] });
    }
  }

  const userCols: MCol[] = [
    { name: "id", type: "INTEGER", pk: 1 },
    { name: "username", type: "TEXT", notNull: true },
    { name: "display_name", type: "TEXT" },
    { name: "email", type: "TEXT" },
    { name: "avatar", type: "BLOB" },
    { name: "created_at", type: "INTEGER", notNull: true, default: "strftime('%s','now')", dflt: () => Math.floor(Date.now() / 1000) },
    { name: "is_bot", type: "INTEGER", notNull: true, default: "0", dflt: () => 0 },
    { name: "settings", type: "TEXT" },
  ];
  const msgCols: MCol[] = [
    { name: "id", type: "INTEGER", pk: 1 },
    { name: "conversation_id", type: "INTEGER", notNull: true },
    { name: "sender_id", type: "INTEGER" },
    { name: "body", type: "TEXT" },
    { name: "sent_at", type: "INTEGER", notNull: true, default: "strftime('%s','now')", dflt: () => Math.floor(Date.now() / 1000) },
    { name: "edited_at", type: "INTEGER" },
    { name: "snowflake", type: "INTEGER", notNull: true, default: "0", dflt: () => 0 },
    { name: "reactions", type: "TEXT" },
    { name: "flags", type: "INTEGER", notNull: true, default: "0", dflt: () => 0 },
  ];

  const tables: MTable[] = [
    table(
      "users",
      "CREATE TABLE users (\n  id INTEGER PRIMARY KEY,\n  username TEXT NOT NULL UNIQUE,\n  display_name TEXT,\n  email TEXT,\n  avatar BLOB,\n  created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),\n  is_bot INTEGER NOT NULL DEFAULT 0,\n  settings TEXT -- JSON\n)",
      userCols,
      users,
    ),
    table(
      "conversations",
      "CREATE TABLE conversations (\n  id INTEGER PRIMARY KEY,\n  kind TEXT NOT NULL CHECK (kind IN ('dm', 'group')),\n  title TEXT,\n  created_at INTEGER NOT NULL,\n  muted INTEGER NOT NULL DEFAULT 0\n)",
      [
        { name: "id", type: "INTEGER", pk: 1 },
        { name: "kind", type: "TEXT", notNull: true },
        { name: "title", type: "TEXT" },
        { name: "created_at", type: "INTEGER", notNull: true },
        { name: "muted", type: "INTEGER", notNull: true, default: "0", dflt: () => 0 },
      ],
      convs,
    ),
    table(
      "messages",
      "CREATE TABLE messages (\n  id INTEGER PRIMARY KEY AUTOINCREMENT,\n  conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,\n  sender_id INTEGER REFERENCES users(id) ON DELETE SET NULL,\n  body TEXT,\n  sent_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),\n  edited_at INTEGER,\n  snowflake INTEGER NOT NULL DEFAULT 0,\n  reactions TEXT, -- JSON\n  flags INTEGER NOT NULL DEFAULT 0\n)",
      msgCols,
      messages,
      {
        autoincrement: true,
        fks: [
          { id: 0, table: "users", from: "sender_id", to: "id", onUpdate: "NO ACTION", onDelete: "SET NULL" },
          { id: 1, table: "conversations", from: "conversation_id", to: "id", onUpdate: "NO ACTION", onDelete: "CASCADE" },
        ],
        afterUpdate: (row, changed) => {
          if (changed.has("body")) row.v[5] = Math.floor(Date.now() / 1000);
        },
      },
    ),
    table(
      "attachments",
      "CREATE TABLE attachments (\n  message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,\n  idx INTEGER NOT NULL,\n  file_name TEXT NOT NULL,\n  mime TEXT,\n  size INTEGER,\n  data BLOB,\n  PRIMARY KEY (message_id, idx)\n) WITHOUT ROWID",
      [
        { name: "message_id", type: "INTEGER", notNull: true, pk: 1 },
        { name: "idx", type: "INTEGER", notNull: true, pk: 2 },
        { name: "file_name", type: "TEXT", notNull: true },
        { name: "mime", type: "TEXT" },
        { name: "size", type: "INTEGER" },
        { name: "data", type: "BLOB" },
      ],
      attachments,
      { withoutRowid: true, fks: [{ id: 0, table: "messages", from: "message_id", to: "id", onUpdate: "NO ACTION", onDelete: "CASCADE" }] },
    ),
    table("sqlite_sequence", "CREATE TABLE sqlite_sequence(name,seq)", [{ name: "name", type: "" }, { name: "seq", type: "" }], [{ rowid: 1, v: ["messages", 5000] }]),
  ];
  const byId = new Map(users.map((u) => [u.rowid, u.v[1]]));
  tables.push({
    name: "recent_messages",
    kind: "view",
    sql: "CREATE VIEW recent_messages AS\nSELECT m.id, u.username AS sender, m.body, datetime(m.sent_at, 'unixepoch') AS sent\nFROM messages m LEFT JOIN users u ON u.id = m.sender_id\nORDER BY m.sent_at DESC\nLIMIT 200",
    columns: [
      { name: "id", type: "INTEGER" },
      { name: "sender", type: "TEXT" },
      { name: "body", type: "TEXT" },
      { name: "sent", type: "" },
    ],
    rows: [],
    compute: () =>
      tables[2].rows
        .slice()
        .sort((a, b) => (b.v[4] as number) - (a.v[4] as number))
        .slice(0, 200)
        .map((m, i) => ({ rowid: i + 1, v: [m.v[0], byId.get(m.v[2] as number) ?? null, m.v[3], new Date((m.v[4] as number) * 1000).toISOString().slice(0, 19).replace("T", " ")] })),
  });
  tables.push({
    name: "messages_fts",
    kind: "virtual",
    sql: "CREATE VIRTUAL TABLE messages_fts USING fts5(body, content='messages', content_rowid='id')",
    columns: [{ name: "body", type: "" }],
    rows: [],
    compute: () => tables[2].rows.map((m) => ({ rowid: m.rowid, v: [m.v[3]] })),
  });

  return {
    tables,
    indexes: [
      { name: "sqlite_autoindex_users_1", tbl: "users", sql: null, unique: true, origin: "u", partial: false, columns: ["username"] },
      { name: "idx_users_email", tbl: "users", sql: "CREATE UNIQUE INDEX idx_users_email ON users(email) WHERE email IS NOT NULL", unique: true, origin: "c", partial: true, columns: ["email"] },
      { name: "idx_messages_conv", tbl: "messages", sql: "CREATE INDEX idx_messages_conv ON messages(conversation_id, sent_at)", unique: false, origin: "c", partial: false, columns: ["conversation_id", "sent_at"] },
      { name: "idx_messages_sender", tbl: "messages", sql: "CREATE INDEX idx_messages_sender ON messages(sender_id)", unique: false, origin: "c", partial: false, columns: ["sender_id"] },
      { name: "sqlite_autoindex_attachments_1", tbl: "attachments", sql: null, unique: true, origin: "pk", partial: false, columns: ["message_id", "idx"] },
    ],
    triggers: [
      {
        name: "messages_edited",
        tbl: "messages",
        sql: "CREATE TRIGGER messages_edited AFTER UPDATE OF body ON messages\nBEGIN\n  UPDATE messages SET edited_at = strftime('%s','now') WHERE id = NEW.id;\nEND",
      },
      {
        name: "messages_fts_insert",
        tbl: "messages",
        sql: "CREATE TRIGGER messages_fts_insert AFTER INSERT ON messages\nBEGIN\n  INSERT INTO messages_fts(rowid, body) VALUES (new.id, new.body);\nEND",
      },
    ],
    info: { pageSize: 4096, journalMode: "wal", userVersion: 42, applicationId: 0, freelistCount: 37, sqliteVersion: "3.50.4" },
  };
}

// ── History (Chrome-style) ──────────────────────────────────────────────

const SITES: [string, string][] = [
  ["https://github.com/rusqlite/rusqlite", "rusqlite/rusqlite: Ergonomic bindings to SQLite for Rust"],
  ["https://www.sqlite.org/lang_select.html", "SELECT"],
  ["https://www.sqlite.org/pragma.html", "Pragma statements supported by SQLite"],
  ["https://stackoverflow.com/questions/1601151/how-do-i-check-in-sqlite-whether-a-table-exists", "How do I check in SQLite whether a table exists? - Stack Overflow"],
  ["https://news.ycombinator.com/", "Hacker News"],
  ["https://learn.microsoft.com/en-us/windows/win32/fileio/locking-and-unlocking-byte-ranges-in-files", "Locking and Unlocking Byte Ranges in Files - Win32 apps"],
  ["https://developer.mozilla.org/en-US/docs/Web/HTML/Element/iframe", "<iframe>: The Inline Frame element - HTML | MDN"],
  ["https://tauri.app/develop/calling-rust/", "Calling Rust from the Frontend | Tauri"],
  ["https://en.wikipedia.org/wiki/Write-ahead_logging", "Write-ahead logging - Wikipedia"],
  ["https://mail.google.com/mail/u/0/#inbox", "Inbox (3) - mail"],
  ["https://www.youtube.com/watch?v=Jib2AmRb_rk", "SQLite: How it works - YouTube"],
  ["https://crates.io/crates/rusqlite", "rusqlite - crates.io: Rust Package Registry"],
  ["https://react.dev/reference/react/useSyncExternalStore", "useSyncExternalStore – React"],
  ["https://www.google.com/search?q=sqlite+wal+checkpoint+starvation", "sqlite wal checkpoint starvation - Google Search"],
  ["https://docs.rs/rusqlite/latest/rusqlite/struct.Connection.html", "Connection in rusqlite - Rust"],
];

export function historyDb(): MDb {
  const r = rng(11);
  const chrome = (unixMs: number) => (unixMs + 11644473600000) * 1000;
  const urls: MRow[] = [];
  for (let id = 1; id <= 600; id++) {
    const [base, title] = SITES[Math.floor(r() * SITES.length)];
    const url = id <= SITES.length ? base : `${base}${base.includes("?") ? "&" : "?"}utm=${Math.floor(r() * 1e6).toString(36)}`;
    const visits = 1 + Math.floor(r() ** 3 * 60);
    urls.push({ rowid: id, v: [id, url, r() < 0.04 ? "" : title, visits, r() < 0.2 ? Math.floor(r() * 5) : 0, chrome(1748736000000 + Math.floor(r() * 140 * 86400000)), r() < 0.03 ? 1 : 0] });
  }
  const visits: MRow[] = [];
  let tm = 1748736000000;
  for (let id = 1; id <= 2500; id++) {
    tm += Math.floor(r() * 5_000_000);
    visits.push({ rowid: id, v: [id, 1 + Math.floor(r() * 600), chrome(tm), r() < 0.4 ? Math.max(0, id - 1 - Math.floor(r() * 4)) : 0, [805306368, 805306369, 838860801, 268435457][Math.floor(r() * 4)], r() < 0.5 ? Math.floor(r() * 40) : 0, Math.floor(r() * 600_000_000)] });
  }
  const terms = ["sqlite wal checkpoint starvation", "rusqlite interrupt", "tauri iframe sandbox", "windows file locking sqlite", "chrome history schema", "virtualized table react"];
  const kst: MRow[] = terms.map((t, i) => ({ rowid: i + 1, v: [2, 14 + i, t, t.toLowerCase()] }));
  const meta: MRow[] = [
    ["mmap_status", "-1"],
    ["version", "67"],
    ["last_compatible_version", "16"],
    ["early_expiration_threshold", "13370000000000000"],
  ].map((v, i) => ({ rowid: i + 1, v }));
  return {
    tables: [
      table(
        "meta",
        "CREATE TABLE meta(key LONGVARCHAR NOT NULL UNIQUE PRIMARY KEY, value LONGVARCHAR)",
        [
          { name: "key", type: "LONGVARCHAR", notNull: true, pk: 1 },
          { name: "value", type: "LONGVARCHAR" },
        ],
        meta,
      ),
      table(
        "urls",
        "CREATE TABLE urls(id INTEGER PRIMARY KEY AUTOINCREMENT,url LONGVARCHAR,title LONGVARCHAR,visit_count INTEGER DEFAULT 0 NOT NULL,typed_count INTEGER DEFAULT 0 NOT NULL,last_visit_time INTEGER NOT NULL,hidden INTEGER DEFAULT 0 NOT NULL)",
        [
          { name: "id", type: "INTEGER", pk: 1 },
          { name: "url", type: "LONGVARCHAR" },
          { name: "title", type: "LONGVARCHAR" },
          { name: "visit_count", type: "INTEGER", notNull: true, default: "0", dflt: () => 0 },
          { name: "typed_count", type: "INTEGER", notNull: true, default: "0", dflt: () => 0 },
          { name: "last_visit_time", type: "INTEGER", notNull: true },
          { name: "hidden", type: "INTEGER", notNull: true, default: "0", dflt: () => 0 },
        ],
        urls,
        { autoincrement: true },
      ),
      table(
        "visits",
        "CREATE TABLE visits(id INTEGER PRIMARY KEY AUTOINCREMENT,url INTEGER NOT NULL,visit_time INTEGER NOT NULL,from_visit INTEGER,transition INTEGER DEFAULT 0 NOT NULL,segment_id INTEGER,visit_duration INTEGER DEFAULT 0 NOT NULL)",
        [
          { name: "id", type: "INTEGER", pk: 1 },
          { name: "url", type: "INTEGER", notNull: true },
          { name: "visit_time", type: "INTEGER", notNull: true },
          { name: "from_visit", type: "INTEGER" },
          { name: "transition", type: "INTEGER", notNull: true, default: "0", dflt: () => 0 },
          { name: "segment_id", type: "INTEGER" },
          { name: "visit_duration", type: "INTEGER", notNull: true, default: "0", dflt: () => 0 },
        ],
        visits,
        { autoincrement: true, fks: [] },
      ),
      table(
        "keyword_search_terms",
        "CREATE TABLE keyword_search_terms (keyword_id INTEGER NOT NULL,url_id INTEGER NOT NULL,term LONGVARCHAR NOT NULL,normalized_term LONGVARCHAR NOT NULL)",
        [
          { name: "keyword_id", type: "INTEGER", notNull: true },
          { name: "url_id", type: "INTEGER", notNull: true },
          { name: "term", type: "LONGVARCHAR", notNull: true },
          { name: "normalized_term", type: "LONGVARCHAR", notNull: true },
        ],
        kst,
      ),
      table("sqlite_sequence", "CREATE TABLE sqlite_sequence(name,seq)", [{ name: "name", type: "" }, { name: "seq", type: "" }], [
        { rowid: 1, v: ["urls", 600] },
        { rowid: 2, v: ["visits", 2500] },
      ]),
    ],
    indexes: [
      { name: "sqlite_autoindex_meta_1", tbl: "meta", sql: null, unique: true, origin: "pk", partial: false, columns: ["key"] },
      { name: "urls_url_index", tbl: "urls", sql: "CREATE INDEX urls_url_index ON urls (url)", unique: false, origin: "c", partial: false, columns: ["url"] },
      { name: "visits_url_index", tbl: "visits", sql: "CREATE INDEX visits_url_index ON visits (url)", unique: false, origin: "c", partial: false, columns: ["url"] },
      { name: "visits_time_index", tbl: "visits", sql: "CREATE INDEX visits_time_index ON visits (visit_time)", unique: false, origin: "c", partial: false, columns: ["visit_time"] },
      {
        name: "keyword_search_terms_index1",
        tbl: "keyword_search_terms",
        sql: "CREATE INDEX keyword_search_terms_index1 ON keyword_search_terms (keyword_id, normalized_term)",
        unique: false,
        origin: "c",
        partial: false,
        columns: ["keyword_id", "normalized_term"],
      },
    ],
    triggers: [],
    info: { pageSize: 4096, journalMode: "truncate", userVersion: 0, applicationId: 0, freelistCount: 112, sqliteVersion: "3.50.4" },
  };
}
