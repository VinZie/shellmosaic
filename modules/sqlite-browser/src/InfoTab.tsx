// The database file: where it is, how it's stored, and an integrity check.
import { useState } from "react";
import { CircleAlert, CircleCheck, Copy, FolderSearch, LoaderCircle, ShieldCheck } from "lucide-react";
import { Button, KeyValues, Section, copy, errorText, formatBytes, formatNumber, pluralize, sm } from "../../shared";
import { cellText } from "./sql";
import { useDb } from "./state";

/** application_id values with a known meaning (sqlite.org/src/artifact?name=magic.txt). */
const APP_IDS: Record<number, string> = {
  0x0f055112: "Fossil checkout",
  0x0f05511a: "Fossil global configuration",
  0x0f055113: "Fossil repository",
  0x42654462: "Bentley Systems DgnDb",
  0x42654c6e: "Bentley Systems localization",
  0x47504b47: "GeoPackage",
  0x47503130: "GeoPackage 1.0",
  0x47503131: "GeoPackage 1.1",
  0x4d504258: "MBTiles",
  0x5245424c: "Rebol",
  0x45584c4c: "EXLL",
};

function fourcc(n: number): string | null {
  const bytes = [24, 16, 8, 0].map((s) => (n >>> s) & 0xff);
  return bytes.every((b) => b >= 0x20 && b < 0x7f) ? String.fromCharCode(...bytes) : null;
}

type Check = { state: "running" } | { state: "ok"; ms: number } | { state: "problems"; lines: string[]; ms: number } | { state: "error"; message: string };

export function InfoTab() {
  const { db, schema } = useDb();
  const [check, setCheck] = useState<Check | null>(null);

  const runCheck = async () => {
    setCheck({ state: "running" });
    const t0 = performance.now();
    try {
      const r = await sm.sqlite.query(db.id, "PRAGMA quick_check;", [], { maxRows: 200 });
      const lines = r.rows.map((row) => cellText(row[0]));
      const ms = performance.now() - t0;
      setCheck(lines.length === 1 && lines[0] === "ok" ? { state: "ok", ms } : { state: "problems", lines, ms });
    } catch (e) {
      setCheck({ state: "error", message: errorText(e) });
    }
  };

  const n = (t: string) => schema.filter((o) => o.type === t).length;
  const appId = db.applicationId >>> 0;
  const appName = APP_IDS[appId] ?? (appId ? fourcc(appId) && `“${fourcc(appId)}”` : null);
  const wal = /wal/i.test(db.journalMode);

  return (
    <div className="sm-scroll">
      <div className="sqlb-info">
        <Section
          title="File"
          actions={
            <>
              <Button small kind="subtle" onClick={() => copy(db.path, "path")}>
                <Copy size={12} /> Copy path
              </Button>
              <Button small kind="subtle" onClick={() => sm.ui.reveal(db.path).catch((e) => sm.ui.notify(errorText(e), "error"))}>
                <FolderSearch size={12} /> Show in Explorer
              </Button>
            </>
          }
        >
          <KeyValues
            labelWidth={150}
            rows={[
              { label: "Path", value: db.path, mono: true },
              {
                label: "Opened from",
                value: db.copied ? `A temporary copy${db.copyReason ? ` — ${db.copyReason}` : ""}` : "The file itself",
                copyText: null,
              },
              { label: "Access", value: db.writable ? "Changes allowed (read-write)" : "Read-only", copyText: null },
              { label: "Size", value: `${formatBytes(db.size)} (${formatNumber(db.size)} bytes)`, copyText: String(db.size) },
            ]}
          />
        </Section>
        <Section title="Database">
          <KeyValues
            labelWidth={150}
            rows={[
              { label: "SQLite version", value: db.sqliteVersion, mono: true },
              {
                label: "Pages",
                value: `${formatNumber(db.pageCount)} × ${formatBytes(db.pageSize)} = ${formatBytes(db.pageCount * db.pageSize)}`,
                copyText: `${db.pageCount} × ${db.pageSize}`,
              },
              { label: "Encoding", value: db.encoding },
              {
                label: "Journal mode",
                value: wal ? `${db.journalMode} — recent changes may still be in ${db.file}-wal` : db.journalMode,
                copyText: db.journalMode,
              },
              { label: "user_version", value: String(db.userVersion), mono: true, title: "Set by the application, usually its schema version" },
              {
                label: "application_id",
                value: (
                  <>
                    <span className="mono">0x{appId.toString(16).padStart(8, "0")}</span>
                    {appName && <span className="sqlb-dim"> · {appName}</span>}
                    {!appId && <span className="sqlb-dim"> · not set</span>}
                  </>
                ),
                copyText: `0x${appId.toString(16).padStart(8, "0")}`,
              },
              {
                label: "Free pages",
                value: db.freelistCount ? `${formatNumber(db.freelistCount)} (${formatBytes(db.freelistCount * db.pageSize)}) — may still hold deleted data` : "0",
                copyText: String(db.freelistCount),
              },
              {
                label: "Objects",
                value: [pluralize(n("table"), "table"), pluralize(n("view"), "view"), pluralize(n("index"), "index", "indexes"), pluralize(n("trigger"), "trigger")].join(" · "),
                copyText: null,
              },
            ]}
          />
        </Section>
        <Section
          title="Integrity"
          actions={
            <Button small onClick={runCheck} disabled={check?.state === "running"}>
              <ShieldCheck size={13} /> Check integrity
            </Button>
          }
        >
          {!check && <div className="sqlb-note">Runs PRAGMA quick_check: reads every page and checks the b-trees (it doesn't change anything).</div>}
          {check?.state === "running" && (
            <div className="sqlb-check">
              <LoaderCircle size={14} className="sm-spin" /> Checking…
            </div>
          )}
          {check?.state === "ok" && (
            <div className="sqlb-check ok">
              <CircleCheck size={14} /> No problems found <span className="sqlb-dim">· {Math.round(check.ms)} ms</span>
            </div>
          )}
          {check?.state === "problems" && (
            <div className="sqlb-check bad">
              <div className="sqlb-check-title">
                <CircleAlert size={14} /> {check.lines.length} problem{check.lines.length === 1 ? "" : "s"} found
              </div>
              <pre className="sm-code">{check.lines.join("\n")}</pre>
            </div>
          )}
          {check?.state === "error" && (
            <div className="sqlb-check bad">
              <CircleAlert size={14} /> {check.message}
            </div>
          )}
        </Section>
      </div>
    </div>
  );
}
