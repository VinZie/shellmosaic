import { useState } from "react";
import { Copy, Database, FileX, FolderOpen, ShieldCheck, X } from "lucide-react";
import { Button, IconButton, Message, Section, copy, openMenu } from "../../shared";
import { dirOf, fileOf, type Recent } from "./state";

export interface OpenFailure {
  path: string;
  message: string;
  /** reopening the pane's last database after a restart */
  restoring: boolean;
}

function ago(ms: number): string {
  const s = (Date.now() - ms) / 1000;
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  if (s < 2 * 86400) return "yesterday";
  if (s < 7 * 86400) return `${Math.floor(s / 86400)} days ago`;
  return new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric", year: s > 300 * 86400 ? "numeric" : undefined });
}

export function StartScreen({
  recent,
  asCopy,
  setAsCopy,
  failure,
  onDismiss,
  onPick,
  onOpen,
  onForget,
}: {
  recent: Recent[];
  asCopy: boolean;
  setAsCopy: (v: boolean) => void;
  failure: OpenFailure | null;
  onDismiss: () => void;
  onPick: () => void;
  onOpen: (path: string, copy?: boolean) => void;
  onForget: (path: string) => void;
}) {
  const [path, setPath] = useState("");
  const failedRecent = failure && recent.some((r) => r.path === failure.path);
  const lockish = failure && /lock|in use|busy|being used|sharing|access|denied|permission/i.test(failure.message);

  const recentMenu = (e: React.MouseEvent, r: Recent) => {
    e.preventDefault();
    openMenu(e, [
      { label: "Open", icon: <FolderOpen size={14} />, onSelect: () => onOpen(r.path, false) },
      { label: "Open a copy", icon: <Copy size={14} />, onSelect: () => onOpen(r.path, true) },
      { separator: true },
      { label: "Copy path", onSelect: () => copy(r.path, "path") },
      { label: "Remove from the list", icon: <X size={14} />, onSelect: () => onForget(r.path) },
    ]);
  };

  return (
    <div className="sqlb-start">
      <div className="sqlb-start-card">
        <div className="sqlb-hero">
          <div className="sqlb-hero-icon">
            <Database size={24} />
          </div>
          <h1>SQLite Browser</h1>
          <p>Browse tables, look at values in full and run queries.</p>
          <p className="sqlb-hero-safe">
            <ShieldCheck size={13} /> Databases open read-only — nothing changes until you allow it.
          </p>
        </div>

        {failure && (
          <div className="sqlb-start-error">
            <Message
              tone="danger"
              icon={<FileX size={22} />}
              title={`Couldn't ${failure.restoring ? "reopen" : "open"} ${fileOf(failure.path)}`}
              actions={
                <>
                  {lockish && (
                    <Button small onClick={() => onOpen(failure.path, true)}>
                      Open a copy instead
                    </Button>
                  )}
                  {failedRecent && (
                    <Button small onClick={() => (onForget(failure.path), onDismiss())}>
                      Remove from recent
                    </Button>
                  )}
                  <Button small kind="subtle" onClick={onDismiss}>
                    Dismiss
                  </Button>
                </>
              }
            >
              <p className="sqlb-path mono">{failure.path}</p>
              <p>{failure.message}</p>
            </Message>
          </div>
        )}

        <div className="sqlb-start-actions">
          <Button kind="primary" onClick={onPick}>
            <FolderOpen size={14} /> Open a database…
          </Button>
          <label className="sqlb-checkbox" title="Shellmosaic copies the file to a temporary folder and opens the copy, so the original (and its -wal/-shm files) is never touched">
            <input type="checkbox" checked={asCopy} onChange={(e) => setAsCopy(e.target.checked)} />
            Open a copy (leave the original untouched)
          </label>
        </div>

        <form
          className="sqlb-start-path"
          onSubmit={(e) => {
            e.preventDefault();
            if (path.trim()) onOpen(path);
          }}
        >
          <input className="sm-input mono wide" placeholder="…or paste a path and press Enter" value={path} spellCheck={false} onChange={(e) => setPath(e.target.value)} />
          <Button type="submit" disabled={!path.trim()}>
            Open
          </Button>
        </form>

        {recent.length > 0 && (
          <Section title="Recent">
            <div className="sqlb-recent" role="list">
              {recent.map((r) => (
                <div
                  key={r.path}
                  role="listitem"
                  tabIndex={0}
                  className="sqlb-recent-item"
                  title={r.path}
                  onClick={() => onOpen(r.path)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") onOpen(r.path);
                    if (e.key === "Delete") onForget(r.path);
                  }}
                  onContextMenu={(e) => recentMenu(e, r)}
                >
                  <Database size={15} className="sqlb-recent-icon" />
                  <div className="sqlb-recent-text">
                    <div className="sqlb-recent-name">{r.file}</div>
                    <div className="sqlb-recent-dir">{dirOf(r.path)}</div>
                  </div>
                  <span className="sqlb-recent-when">{ago(r.at)}</span>
                  <span onClick={(e) => e.stopPropagation()} className="sqlb-recent-x">
                    <IconButton title="Remove from the list" onClick={() => onForget(r.path)}>
                      <X size={13} />
                    </IconButton>
                  </span>
                </div>
              ))}
            </div>
          </Section>
        )}
      </div>
    </div>
  );
}
