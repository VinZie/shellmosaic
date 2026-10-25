// Task runner: package scripts, cargo, go, make, just, compose and loose scripts
// found in the folder the tab's terminal is in. ▶ opens a terminal below that runs it.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { errorText, ipc, type TaskGroup } from "../../lib/ipc";
import { Icon, ICONS } from "../../lib/icons";
import { basename, clamp, cx, joinPath } from "../../lib/util";
import { openFilesAt, openPreview, runInNewTerminal, sendToTerminal, setPaneMeta, terminalTarget } from "../../state/actions";
import { findProfile } from "../../state/profiles";
import { getState } from "../../state/store";
import { ui, type MenuItem } from "../../state/ui";
import { ModuleMessage, SearchBox, useModuleDir } from "../common";
import type { ModuleDef, ModuleProps } from "../registry";
import "./tasks.css";

type Task = TaskGroup["tasks"][number];

interface Row {
  /** `${source}:${name}` — the favorites key */
  id: string;
  group: TaskGroup;
  task: Task;
}

interface Section {
  id: string;
  title: string;
  icon: string;
  file?: string;
  group?: TaskGroup;
  rows: Row[];
}

const SUPPORTED = ["package.json", "Cargo.toml", "go.mod", "Makefile", "justfile", "compose.yaml", "*.ps1", "*.bat", "*.cmd", "*.sh", "*.py"];

const taskId = (g: TaskGroup, t: Task) => `${g.source}:${t.name}`;
const groupIcon = (g: TaskGroup) => (ICONS[g.icon] ? g.icon : "list-checks");
const isFolderGroup = (g: TaskGroup) => g.source === "scripts";

/**
 * A loose script spelled for the shell that will run it (the detected command is
 * PowerShell's). `path` is the bare file name (run from its folder) or an absolute path.
 */
function scriptCommand(path: string, kind: string | undefined): string {
  const ext = path.slice(path.lastIndexOf(".")).toLowerCase();
  const relative = !/^([a-zA-Z]:)?[\\/]/.test(path);
  const sq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
  // bash (Git's or WSL's) wants forward slashes
  const slashed = relative ? `./${path}` : path.replace(/\\/g, "/");
  switch (kind) {
    case "cmd": {
      const q = `"${relative ? `.\\${path}` : path}"`; // (Windows file names can't contain ")
      if (ext === ".ps1") return `powershell -File ${q}`;
      if (ext === ".py") return `python ${q}`;
      if (ext === ".sh") return `bash "${slashed}"`;
      return q;
    }
    case "bash":
    case "wsl": {
      const wsl = kind === "wsl";
      // what bash opens itself; Windows programs (powershell, cmd) get the Windows spelling
      const p = wsl ? slashed.replace(/^([a-zA-Z]):/, (_, d: string) => `/mnt/${d.toLowerCase()}`) : slashed;
      if (ext === ".ps1") return `${wsl ? "powershell.exe" : "powershell"} -File ${sq(path)}`;
      if (ext === ".py") return `${wsl ? "python3" : "python"} ${sq(p)}`;
      if (ext === ".sh") return `bash ${sq(p)}`;
      return wsl ? `cmd.exe /c ${sq(path)}` : sq(p);
    }
    default: {
      // PowerShell: single quotes so $ and ` in a file name stay literal (it also ends '…' at ‘ ’ ‚ ‛)
      const psq = (s: string) => `'${s.replace(/['‘’‚‛]/g, "$&$&")}'`;
      const p = relative ? `.\\${path}` : path;
      if (ext === ".py") return `python ${psq(p)}`;
      if (ext === ".sh") return `bash ${psq(slashed)}`;
      return `& ${psq(p)}`;
    }
  }
}

function copyText(text: string) {
  writeText(text).then(
    () => ui.toast("Command copied", "success", 1500),
    (e) => ui.toast(errorText(e), "error"),
  );
}

function TasksPane({ pane, tabId, visible }: ModuleProps) {
  const { dir, following } = useModuleDir(pane, tabId);
  const [groups, setGroups] = useState<TaskGroup[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loadedDir, setLoadedDir] = useState<string | undefined>(undefined);
  const [query, setQuery] = useState("");
  const [sel, setSel] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [ran, setRan] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const favMeta = pane.meta.favorites;
  const favorites = useMemo<string[]>(() => (Array.isArray(favMeta) ? favMeta : []), [favMeta]);

  const dirRef = useRef(dir);
  dirRef.current = dir;
  const load = useCallback(() => {
    const d = dirRef.current;
    if (!d) return;
    ipc.tasksDetect(d).then(
      (g) => {
        if (dirRef.current !== d) return;
        setGroups((prev) => (prev && JSON.stringify(prev) === JSON.stringify(g) ? prev : g));
        setErr(null);
        setLoadedDir(d);
      },
      (e) => {
        if (dirRef.current !== d) return;
        setErr(errorText(e));
        setGroups(null);
        setLoadedDir(d);
      },
    );
  }, []);

  useEffect(() => {
    if (dir && visible) load();
  }, [dir, visible, load]);

  useEffect(() => {
    ui.setTitle(pane.id, dir ? basename(dir) || dir : "");
  }, [dir, pane.id]);

  // ── rows ──
  const sections = useMemo<Section[]>(() => {
    if (!groups) return [];
    const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const match = (g: TaskGroup, t: Task) => {
      if (!words.length) return true;
      const hay = `${t.name} ${t.command} ${t.detail ?? ""} ${g.source}`.toLowerCase();
      return words.every((w) => hay.includes(w));
    };
    const all = new Map<string, Row>();
    for (const g of groups) for (const t of g.tasks) all.set(taskId(g, t), { id: taskId(g, t), group: g, task: t });
    const out: Section[] = [];
    const pinned = favorites.map((id) => all.get(id)).filter((r): r is Row => !!r && match(r.group, r.task));
    if (pinned.length) out.push({ id: "pinned", title: "Pinned", icon: "star", rows: pinned });
    for (const g of groups) {
      const rows = g.tasks.filter((t) => match(g, t)).map((t) => all.get(taskId(g, t))!);
      if (rows.length) out.push({ id: `${g.source}|${g.file}`, title: g.source, icon: groupIcon(g), file: g.file, group: g, rows });
    }
    return out;
  }, [groups, query, favorites]);

  const flat = useMemo(() => sections.flatMap((s) => (collapsed[s.id] ? [] : s.rows.map((r) => ({ key: `${s.id}::${r.id}`, row: r })))), [sections, collapsed]);
  const taskCount = groups?.reduce((n, g) => n + g.tasks.length, 0) ?? 0;

  useEffect(() => {
    if (!sel) return;
    listRef.current?.querySelector<HTMLElement>(`[data-key="${CSS.escape(sel)}"]`)?.scrollIntoView({ block: "nearest" });
  }, [sel]);

  // ── actions ──
  const flash = (key: string) => {
    setRan(key);
    setTimeout(() => setRan((k) => (k === key ? null : k)), 900);
  };
  // loose scripts depend on the receiving shell's syntax; other tasks are plain commands
  const commandFor = (r: Row, kind: string | undefined, absolute = false) =>
    isFolderGroup(r.group) ? scriptCommand(absolute ? joinPath(r.group.file, r.task.name) : r.task.name, kind) : r.task.command;
  const runNew = (r: Row, key?: string) => {
    if (key) flash(key);
    // a new terminal gets the default profile (findProfile with no id); it starts in the folder the
    // list was scanned from (right after a cd the old list is still shown until the rescan lands)
    runInNewTerminal(commandFor(r, findProfile()?.kind), { tabId, cwd: loadedDir ?? dir });
  };
  const runHere = (r: Row, key?: string) => {
    if (key) flash(key);
    // that terminal may be in another folder: give scripts their full path
    const target = terminalTarget(tabId, { local: true });
    sendToTerminal(commandFor(r, findProfile(target ? getState().model.panes[target]?.meta.profile : undefined)?.kind, true), { tabId, enter: true, local: true });
  };
  const toggleFav = (id: string) => {
    const next = favorites.includes(id) ? favorites.filter((f) => f !== id) : [...favorites, id];
    setPaneMeta(pane.id, { favorites: next.length ? next : null });
  };
  const openSource = (g: TaskGroup) => (isFolderGroup(g) ? openFilesAt(g.file, pane.id) : openPreview(g.file, pane.id));
  const chooseFolder = async () => {
    const picked = await openDialog({ directory: true, multiple: false, defaultPath: dir }).catch(() => null);
    if (typeof picked === "string") setPaneMeta(pane.id, { follow: false, path: picked });
  };
  const toggleFollow = () => setPaneMeta(pane.id, following ? { follow: false, path: dir ?? null } : { follow: true });

  const rowMenu = (e: React.MouseEvent, r: Row, key: string) => {
    e.preventDefault();
    e.stopPropagation();
    setSel(key);
    const fav = favorites.includes(r.id);
    const items: MenuItem[] = [
      { label: "Run in new terminal", icon: "play", onSelect: () => runNew(r, key) },
      { label: "Run in current terminal", icon: "square-terminal", onSelect: () => runHere(r, key) },
      { label: "Copy command", icon: "copy", onSelect: () => copyText(commandFor(r, findProfile()?.kind)) },
      { label: fav ? "Unpin" : "Pin to top", icon: fav ? "pin-off" : "pin", onSelect: () => toggleFav(r.id) },
      { type: "separator" },
      {
        label: isFolderGroup(r.group) ? "Show folder" : `Open ${basename(r.group.file)}`,
        icon: isFolderGroup(r.group) ? "folder-open" : "file-text",
        onSelect: () => openSource(r.group),
      },
    ];
    ui.openMenu(e, items);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if ((e.target as HTMLElement).closest("button,input")) return;
    const step = e.key === "ArrowDown" ? 1 : e.key === "ArrowUp" ? -1 : 0;
    const i = flat.findIndex((f) => f.key === sel);
    if (step && flat.length) {
      e.preventDefault();
      setSel(flat[i < 0 ? 0 : clamp(i + step, 0, flat.length - 1)].key);
    } else if (e.key === "Enter" && i >= 0) {
      e.preventDefault();
      if (e.shiftKey) runHere(flat[i].row, flat[i].key);
      else runNew(flat[i].row, flat[i].key);
    }
  };

  // ── render ──
  const toolbar = (
    <div className="toolbar tasks-toolbar">
      <button
        className={cx("icon-btn", following && "on")}
        title={following ? "Following the terminal's folder (click to pin this folder)" : "Pinned to this folder (click to follow the terminal)"}
        onClick={toggleFollow}
      >
        <Icon name="crosshair" size={14} />
      </button>
      <button className="tasks-path" title={dir ? `${dir}\nClick to choose another folder` : "Choose a folder"} onClick={chooseFolder}>
        <Icon name="folder" size={13} />
        <span>{dir ? basename(dir) || dir : "No folder"}</span>
      </button>
      <span className="grow" />
      <SearchBox value={query} onChange={setQuery} placeholder="Filter tasks" />
      <button className="icon-btn" title="Rescan folder" disabled={!dir} onClick={load}>
        <Icon name="refresh" size={14} />
      </button>
    </div>
  );

  let body: React.ReactNode;
  if (!dir) {
    body = (
      <ModuleMessage icon="list-checks" title="No folder">
        <p className="dim">Open a terminal in this tab, or choose a project folder.</p>
        <div className="row">
          <button className="btn" onClick={chooseFolder}>
            <Icon name="folder-open" size={14} /> Choose folder…
          </button>
        </div>
      </ModuleMessage>
    );
  } else if (err && loadedDir === dir) {
    body = (
      <ModuleMessage icon="warning" title="Couldn't scan this folder">
        <p className="dim selectable tasks-detail">{err}</p>
        <p className="dim mono tasks-detail">{dir}</p>
        <div className="row">
          <button className="btn" onClick={load}>
            <Icon name="refresh" size={14} /> Retry
          </button>
          <button className="btn subtle" onClick={chooseFolder}>
            Choose folder…
          </button>
        </div>
      </ModuleMessage>
    );
  } else if (!groups) {
    body = <div className="tasks-loading dim">Scanning…</div>;
  } else if (!groups.length) {
    body = (
      <ModuleMessage icon="list-checks" title={`No tasks found in ${basename(dir) || dir}`}>
        <p className="dim mono tasks-detail">{dir}</p>
        <p className="dim">Shellmosaic picks up tasks from:</p>
        <div className="tasks-supported">
          {SUPPORTED.map((f) => (
            <span key={f} className="chip mono">
              {f}
            </span>
          ))}
        </div>
        <div className="row">
          <button className="btn" onClick={chooseFolder}>
            <Icon name="folder-open" size={14} /> Choose folder…
          </button>
          <button className="btn subtle" onClick={load}>
            <Icon name="refresh" size={14} /> Rescan
          </button>
        </div>
      </ModuleMessage>
    );
  } else if (!sections.length) {
    body = (
      <div className="empty-state">
        <Icon name="search" size={22} />
        <p>No tasks match “{query}”.</p>
      </div>
    );
  } else {
    body = (
      <div ref={listRef} className="module-scroll tasks-list" tabIndex={0} onKeyDown={onKeyDown}>
        {sections.map((s) => (
          <div key={s.id} className="tasks-group">
            <div className="tasks-group-head" onClick={() => setCollapsed((c) => ({ ...c, [s.id]: !c[s.id] }))} title={s.file}>
              <Icon name={collapsed[s.id] ? "chevron-right" : "chevron-down"} size={13} className="dim" />
              <Icon name={s.icon} size={14} className={cx("tasks-group-icon", s.id === "pinned" && "pinned")} />
              <span className="tasks-group-title">{s.title}</span>
              {s.group && <span className="tasks-group-file">{isFolderGroup(s.group) ? "folder" : basename(s.group.file)}</span>}
              <span className="tasks-count">{s.rows.length}</span>
              <span className="grow" />
              {s.group && (
                <button
                  className="icon-btn tasks-group-open"
                  title={isFolderGroup(s.group) ? "Show folder" : `Open ${basename(s.group.file)}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    openSource(s.group!);
                  }}
                >
                  <Icon name={isFolderGroup(s.group) ? "folder-open" : "file-text"} size={13} />
                </button>
              )}
            </div>
            {!collapsed[s.id] &&
              s.rows.map((r) => {
                const key = `${s.id}::${r.id}`;
                const fav = favorites.includes(r.id);
                const tip = r.task.detail ? `${r.task.detail}\n\n› ${r.task.command}` : r.task.command;
                return (
                  <div
                    key={key}
                    data-key={key}
                    className={cx("list-row tasks-row", sel === key && "selected", ran === key && "ran")}
                    title={tip}
                    onClick={() => setSel(key)}
                    onDoubleClick={() => runNew(r, key)}
                    onContextMenu={(e) => rowMenu(e, r, key)}
                  >
                    <button
                      className="tasks-play"
                      title="Run in a new terminal (Enter)"
                      onClick={(e) => {
                        e.stopPropagation();
                        setSel(key);
                        runNew(r, key);
                      }}
                      onDoubleClick={(e) => e.stopPropagation()}
                    >
                      <Icon name="play" size={11} fill="currentColor" />
                    </button>
                    <span className="tasks-name">{r.task.name}</span>
                    {s.id === "pinned" && <span className="chip tasks-source">{r.group.source}</span>}
                    <span className="tasks-cmd">{r.task.command}</span>
                    <span className="tasks-actions" onClick={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()}>
                      <button className="icon-btn" title="Run in current terminal (Shift+Enter)" onClick={() => runHere(r, key)}>
                        <Icon name="square-terminal" size={13} />
                      </button>
                      <button className="icon-btn" title="Copy command" onClick={() => copyText(commandFor(r, findProfile()?.kind))}>
                        <Icon name="copy" size={13} />
                      </button>
                      <button className={cx("icon-btn tasks-star", fav && "on")} title={fav ? "Unpin" : "Pin to top"} onClick={() => toggleFav(r.id)}>
                        <Icon name="star" size={13} fill={fav ? "currentColor" : "none"} />
                      </button>
                    </span>
                  </div>
                );
              })}
          </div>
        ))}
      </div>
    );
  }

  return (
    <div className="module tasks">
      {toolbar}
      {body}
      {dir && groups && groups.length > 0 && (
        <div className="module-footer">
          <span>
            {taskCount} task{taskCount === 1 ? "" : "s"} · {groups.length} source{groups.length === 1 ? "" : "s"}
          </span>
          <span className="grow" />
          <span className="ellipsis mono" title={dir}>
            {dir}
          </span>
        </div>
      )}
    </div>
  );
}

export const tasksModule: ModuleDef = {
  id: "tasks",
  name: "Tasks",
  icon: "list-checks",
  description: "Run project scripts",
  component: TasksPane,
  defaultMeta: ({ cwd }) => (cwd ? { path: cwd } : {}),
  title: (_pane, rt) => (rt.title ? `Tasks — ${rt.title}` : "Tasks"),
  onRemove: (paneId) => ui.setTitle(paneId, ""),
};
