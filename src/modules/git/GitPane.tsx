// Git: status, staging, history and diffs for the folder the tab's terminal is in.
// Read-only and local operations go through the backend (git_status/log/diff/op);
// anything that may need credentials or rewrites history is typed into the tab's
// terminal so the user sees it and can answer prompts.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { errorText, ipc, type GitCommit, type GitFile, type GitStatus } from "../../lib/ipc";
import { Icon } from "../../lib/icons";
import { basename, clamp, cx, joinPath } from "../../lib/util";
import { knownCwd, openFilesAt, openPreview, sendToTerminal, setPaneMeta, terminalTarget } from "../../state/actions";
import { findProfile } from "../../state/profiles";
import { getState } from "../../state/store";
import { ui, type MenuItem } from "../../state/ui";
import { ModuleMessage, SearchBox, useInterval, useModuleDir } from "../common";
import type { ModuleDef, ModuleProps } from "../registry";
import "./git.css";

// ── shell helpers ───────────────────────────────────────────────────────

/** Shell kind and folder of the terminal `sendToTerminal` will type into for this tab (mirrors its target choice). */
function targetTerminal(tabId: string): { shell: string; cwd: string | undefined } {
  // (local terminals only: git runs on this machine, not in an SSH session)
  const id = terminalTarget(tabId, { local: true });
  return { shell: findProfile(id ? getState().model.panes[id]?.meta.profile : undefined)?.kind ?? "cmd", cwd: knownCwd(id) };
}

const PS_SPECIAL = /[`$"“”„]/g;

/** Quote one argument for the given shell so git receives it verbatim. */
function quoteArg(s: string, shell: string, force = false): string {
  if (!force && /^[\w./:+-]+$/.test(s)) return s;
  if (shell === "bash" || shell === "wsl") return `'${s.replace(/'/g, `'\\''`)}'`;
  // the argv escaping git.exe's C runtime understands: \" is a quote, backslashes before it double
  const native = s.replace(/(\\*)"/g, '$1$1\\"');
  const trailing = (t: string) => t.replace(/(\\+)$/, "$1$1");
  if (shell === "pwsh") return `"${s.replace(PS_SPECIAL, "`$&")}"`; // pwsh 7.3+ escapes for native programs itself
  if (shell === "powershell") {
    // Windows PowerShell 5.1 passes embedded quotes to native programs as-is
    const t = /\s/.test(s) ? trailing(native) : native;
    return `"${t.replace(PS_SPECIAL, "`$&")}"`;
  }
  const quoted = `"${trailing(native)}"`;
  // cmd.exe toggles its own quoting at every ", so after a \" the rest would be live (& | > %…): caret-escape them all
  if (shell === "cmd") return quoted.replace(/[()%!^"<>&|]/g, "^$&");
  return quoted; // anything else
}

/** Windows path as the target shell spells it (WSL sees drives under /mnt). */
function shellPath(p: string, shell: string): string {
  if (shell !== "wsl") return p;
  const m = /^([a-zA-Z]):[\\/]?(.*)$/.exec(p);
  return m ? `/mnt/${m[1].toLowerCase()}/${m[2].replace(/\\/g, "/")}` : p;
}

const normPath = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
const winPath = (p: string) => (/^[a-zA-Z]:\//.test(p) ? p.replace(/\//g, "\\") : p);

function copyText(text: string, what = "Copied to clipboard") {
  writeText(text).then(
    () => ui.toast(what, "success", 1500),
    (e) => ui.toast(errorText(e), "error"),
  );
}

// ── status model ────────────────────────────────────────────────────────

type Area = "conflict" | "staged" | "unstaged" | "untracked";
type FileSel = { kind: "file"; path: string; area: Area };
type CommitSel = { kind: "commit"; hash: string; short: string; subject: string };
type Sel = FileSel | CommitSel;

const selKey = (s: Sel | null) => (!s ? "" : s.kind === "file" ? `f:${s.area}:${s.path}` : `c:${s.hash}`);

type Groups = Record<Area, GitFile[]>;

function groupFiles(files: GitFile[]): Groups {
  const g: Groups = { conflict: [], staged: [], unstaged: [], untracked: [] };
  for (const f of files) {
    if (f.kind === "conflict") g.conflict.push(f);
    else if (f.kind === "untracked") g.untracked.push(f);
    else {
      if (f.index !== "." && f.index !== "?") g.staged.push(f);
      if (f.worktree !== "." && f.worktree !== "?") g.unstaged.push(f);
    }
  }
  const byPath = (a: GitFile, b: GitFile) => a.path.localeCompare(b.path, undefined, { numeric: true });
  Object.values(g).forEach((list) => list.sort(byPath));
  return g;
}

const SECTIONS: { id: Area; title: string }[] = [
  { id: "conflict", title: "Merge conflicts" },
  { id: "staged", title: "Staged changes" },
  { id: "unstaged", title: "Changes" },
  { id: "untracked", title: "Untracked" },
];

function letterOf(f: GitFile, area: Area): string {
  if (area === "conflict") return "U";
  if (area === "untracked") return "?";
  return area === "staged" ? f.index : f.worktree;
}

function letterClass(ch: string): string {
  switch (ch) {
    case "M":
    case "T":
      return "warning";
    case "A":
      return "success";
    case "D":
    case "U":
      return "danger";
    case "R":
    case "C":
      return "accent";
    default:
      return "dim";
  }
}

const LETTER_NAMES: Record<string, string> = {
  M: "Modified",
  T: "Type changed",
  A: "Added",
  D: "Deleted",
  R: "Renamed",
  C: "Copied",
  U: "Conflict",
  "?": "Untracked",
};

function shortWhen(w: string): string {
  const m = /^(\d+) (second|minute|hour|day|week|month|year)s?/.exec(w);
  if (!m) return w;
  const unit: Record<string, string> = { second: "s", minute: "m", hour: "h", day: "d", week: "w", month: "mo", year: "y" };
  return `${m[1]}${unit[m[2]]}`;
}

type RefKind = "head" | "branch" | "remote" | "tag";

function parseRefs(refs: string): { label: string; kind: RefKind }[] {
  const out: { label: string; kind: RefKind }[] = [];
  for (const raw of refs.split(",")) {
    const r = raw.trim();
    if (!r || r.endsWith("/HEAD")) continue;
    if (r.startsWith("HEAD -> ")) out.push({ label: r.slice(8), kind: "head" });
    else if (r === "HEAD") out.push({ label: "HEAD", kind: "head" });
    else if (r.startsWith("tag: ")) out.push({ label: r.slice(5), kind: "tag" });
    else if (/^(origin|upstream)\//.test(r)) out.push({ label: r, kind: "remote" });
    else out.push({ label: r, kind: "branch" });
  }
  return out;
}

// ── diff parsing ────────────────────────────────────────────────────────

type LineKind = "add" | "del" | "ctx" | "hunk" | "file" | "meta" | "note" | "commit" | "msg" | "stat";
interface DiffLine {
  k: LineKind;
  s: string;
  o?: number;
  n?: number;
}

function parseDiff(text: string): { lines: DiffLine[]; adds: number; dels: number } {
  const lines: DiffLine[] = [];
  let adds = 0;
  let dels = 0;
  let o = 0;
  let n = 0;
  let cols = 0; // > 0 inside a hunk: number of +/- prefix columns (2 for combined diffs)
  let header = true; // before the first file (git show: commit header, message, stat)
  const src = text.endsWith("\n") ? text.slice(0, -1) : text;
  if (!src) return { lines, adds, dels };
  for (const raw of src.split("\n")) {
    const s = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    if (/^diff --(git|cc|combined) /.test(s)) {
      header = false;
      cols = 0;
      lines.push({ k: "file", s });
      continue;
    }
    if (s.startsWith("@@")) {
      const m = /^(@@+) -(\d+)(?:,\d+)? (?:-\d+(?:,\d+)? )*\+(\d+)/.exec(s);
      if (m) {
        cols = m[1].length - 1;
        o = Number(m[2]);
        n = Number(m[3]);
        header = false;
        lines.push({ k: "hunk", s });
        continue;
      }
    }
    if (cols) {
      const pre = s.slice(0, cols);
      if (pre.length === cols && /^[ +-]+$/.test(pre)) {
        if (pre.includes("+")) {
          lines.push({ k: "add", s, n: n++ });
          adds++;
        } else if (pre.includes("-")) {
          lines.push({ k: "del", s, o: cols === 1 ? o++ : undefined });
          dels++;
        } else {
          lines.push({ k: "ctx", s, o: cols === 1 ? o++ : undefined, n: n++ });
        }
        continue;
      }
      if (s.startsWith("\\")) {
        lines.push({ k: "note", s });
        continue;
      }
      cols = 0;
    }
    if (header) {
      const k: LineKind = s.startsWith("commit ") ? "commit" : s.startsWith("    ") ? "msg" : /^ .+ \| +(\d+|Bin)/.test(s) ? "stat" : "meta";
      lines.push({ k, s });
    } else lines.push({ k: "meta", s });
  }
  return { lines, adds, dels };
}

function StatText({ s }: { s: string }) {
  const i = s.lastIndexOf("|");
  const m = /^(\s*\d+\s*)(\+*)(-*)\s*$/.exec(s.slice(i + 1));
  if (i < 0 || !m) return <>{s}</>;
  return (
    <>
      {s.slice(0, i + 1)}
      {m[1]}
      <span className="git-stat-add">{m[2]}</span>
      <span className="git-stat-del">{m[3]}</span>
    </>
  );
}

// ── small building blocks ───────────────────────────────────────────────

function useSize(ref: React.RefObject<HTMLElement | null>) {
  const [size, setSize] = useState({ w: 0, h: 0 });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      setSize((s) => (Math.abs(s.w - width) < 1 && Math.abs(s.h - height) < 1 ? s : { w: width, h: height }));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return size;
}

function Splitter({ row, onRatio }: { row: boolean; onRatio: (r: number) => void }) {
  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const parent = e.currentTarget.parentElement;
    if (!parent) return;
    const rect = parent.getBoundingClientRect();
    const cls = row ? "resizing-col" : "resizing-row";
    document.body.classList.add(cls);
    const move = (ev: PointerEvent) =>
      onRatio(clamp(row ? (ev.clientX - rect.left) / rect.width : (ev.clientY - rect.top) / rect.height, 0.15, 0.85));
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      document.body.classList.remove(cls);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };
  return <div className={cx("git-splitter", row ? "row" : "col")} onPointerDown={onPointerDown} />;
}

interface DiffData {
  key: string;
  text?: string;
  image?: string;
  note?: string;
  error?: string;
}

const DIFF_PAGE = 3000;

function DiffView({
  data,
  wrap,
  head,
  actions,
  onToggleWrap,
  onClose,
}: {
  data: DiffData | null;
  wrap: boolean;
  head: ReactNode;
  actions?: ReactNode;
  onToggleWrap: () => void;
  onClose: () => void;
}) {
  const parsed = useMemo(() => (data?.text !== undefined ? parseDiff(data.text) : null), [data?.text]);
  const [limit, setLimit] = useState(DIFF_PAGE);
  const key = data?.key;
  useEffect(() => setLimit(DIFF_PAGE), [key]);

  let body: ReactNode;
  if (!data) body = <div className="git-diff-msg dim">Loading…</div>;
  else if (data.error) body = <div className="git-diff-msg danger-text selectable">{data.error}</div>;
  else if (data.image) body = <img className="git-diff-image" src={data.image} alt="" />;
  else if (data.note) body = <div className="git-diff-msg dim">{data.note}</div>;
  else if (!parsed?.lines.length) body = <div className="git-diff-msg dim">No textual changes (binary file or mode change).</div>;
  else {
    const rest = parsed.lines.length - limit;
    body = (
      <>
        <div className={cx("git-diff-lines", wrap && "wrap")}>
          {parsed.lines.slice(0, limit).map((l, i) => (
            <div key={i} className={`git-dl git-dl-${l.k}`}>
              <span className="git-dl-num">{l.o ?? ""}</span>
              <span className="git-dl-num">{l.n ?? ""}</span>
              <span className="git-dl-text">{l.k === "stat" ? <StatText s={l.s} /> : l.s || " "}</span>
            </div>
          ))}
        </div>
        {rest > 0 && (
          <div className="git-diff-more">
            <button className="btn small" onClick={() => setLimit((v) => v + DIFF_PAGE * 2)}>
              Show more ({rest.toLocaleString()} lines left)
            </button>
          </div>
        )}
      </>
    );
  }

  return (
    <>
      <div className="git-diff-head">
        <div className="git-diff-title">{head}</div>
        {parsed && (parsed.adds > 0 || parsed.dels > 0) && (
          <span className="git-diff-stats mono">
            <span className="success-text">+{parsed.adds}</span> <span className="danger-text">−{parsed.dels}</span>
          </span>
        )}
        {actions}
        <button className={cx("icon-btn", wrap && "on")} title="Wrap long lines" onClick={onToggleWrap}>
          <Icon name="wrap" size={14} />
        </button>
        <button className="icon-btn" title="Copy diff" disabled={!data?.text} onClick={() => data?.text && copyText(data.text, "Diff copied")}>
          <Icon name="copy" size={14} />
        </button>
        <button className="icon-btn" title="Close diff (Esc)" onClick={onClose}>
          <Icon name="x" size={14} />
        </button>
      </div>
      <div className="git-diff-body selectable">{body}</div>
    </>
  );
}

async function untrackedPreview(root: string, path: string, key: string): Promise<DiffData> {
  if (path.endsWith("/")) return { key, note: "Untracked folder. Stage it to add everything inside it." };
  const p = await ipc.fsPreview(joinPath(root, path), 512 * 1024);
  if (p.kind === "image") return { key, image: p.dataUrl };
  if (p.kind === "binary") return { key, note: "New binary file." };
  if (p.kind === "directory") return { key, note: "Untracked folder." };
  const body = p.text.endsWith("\n") ? p.text.slice(0, -1) : p.text;
  const rows = body ? body.split("\n") : [];
  const text =
    `diff --git a/${path} b/${path}\nnew file (untracked)\n@@ -0,0 +1,${rows.length} @@\n` +
    rows.map((l) => "+" + l).join("\n") +
    (p.truncated ? "\n\\ preview truncated" : "");
  return { key, text };
}

// ── the pane ────────────────────────────────────────────────────────────

/** Last known branch per pane, for the pane title. */
const branchByPane = new Map<string, string>();

function GitPane({ pane, tabId, visible }: ModuleProps) {
  const { dir, following } = useModuleDir(pane, tabId);
  const rootRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const size = useSize(rootRef);
  const compact = size.w > 0 && size.w < 560;
  const wide = size.w >= 780 && size.w > size.h * 1.25;
  const view: "changes" | "history" = pane.meta.view === "history" ? "history" : "changes";
  const wrap = !!pane.meta.wrap;

  const [st, setSt] = useState<GitStatus | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [spinning, setSpinning] = useState(false);
  const [log, setLog] = useState<GitCommit[] | null>(null);
  const [logErr, setLogErr] = useState<string | null>(null);
  const [logLimit, setLogLimit] = useState(50);
  const [filter, setFilter] = useState("");
  const [selFile, setSelFile] = useState<FileSel | null>(null);
  const [selCommit, setSelCommit] = useState<CommitSel | null>(null);
  const [diff, setDiff] = useState<DiffData | null>(null);
  const [collapsed, setCollapsed] = useState<Partial<Record<Area, boolean>>>({});
  const [ratio, setRatio] = useState(0.42);

  const root = st?.isRepo ? st.root : "";
  const sel: Sel | null = view === "changes" ? selFile : selCommit;
  const sk = selKey(sel);

  const dirRef = useRef(dir);
  const rootPathRef = useRef(root);
  const viewRef = useRef(view);
  const selRef = useRef<Sel | null>(sel);
  const logLimitRef = useRef(logLimit);
  dirRef.current = dir;
  rootPathRef.current = root;
  viewRef.current = view;
  selRef.current = sel;
  logLimitRef.current = logLimit;

  // ── loading ──
  const statusReq = useRef<{ dir: string; again: boolean } | null>(null);
  /** the folder `st` was read for */
  const stDir = useRef<string | null>(null);
  /** Re-read the status. `again`: if a read is already running, run once more after it (after actions). */
  const refresh = useCallback(function load(again = true): void {
    const d = dirRef.current;
    if (!d) return;
    if (statusReq.current?.dir === d) {
      if (again) statusReq.current.again = true;
      return;
    }
    const req = { dir: d, again: false };
    statusReq.current = req;
    ipc
      .gitStatus(d)
      .then(
        (s) => {
          if (dirRef.current !== d) return;
          stDir.current = d;
          setSt((prev) => (prev && JSON.stringify(prev) === JSON.stringify(s) ? prev : s));
          setErr(null);
        },
        (e) => {
          if (dirRef.current !== d) return;
          // still showing the previous folder's repository (e.g. a safe.directory refusal
          // after a cd): show the error instead of letting actions run on the old one
          if (stDir.current !== d) setSt(null);
          setErr(errorText(e));
        },
      )
      .finally(() => {
        if (statusReq.current === req) statusReq.current = null;
        if (req.again) load();
      });
  }, []);

  const logBusy = useRef(false);
  const loadLog = useCallback(() => {
    const d = dirRef.current;
    if (!d || logBusy.current) return;
    logBusy.current = true;
    ipc
      .gitLog(d, logLimitRef.current)
      .then(
        (l) => {
          if (dirRef.current !== d) return;
          setLog((prev) => (prev && JSON.stringify(prev) === JSON.stringify(l) ? prev : l));
          setLogErr(null);
        },
        (e) => {
          if (dirRef.current !== d) return;
          const msg = errorText(e);
          if (/does not have any commits|bad default revision/i.test(msg)) {
            setLog([]);
            setLogErr(null);
          } else setLogErr(msg);
        },
      )
      .finally(() => (logBusy.current = false));
  }, []);

  const loadDiff = useCallback(async (s: Sel) => {
    const key = selKey(s);
    const r = rootPathRef.current;
    const d = dirRef.current;
    if (!r || !d) return;
    let data: DiffData;
    try {
      if (s.kind === "commit") data = { key, text: await ipc.gitDiff(d, { commit: s.hash }) };
      else if (s.area === "untracked") data = await untrackedPreview(r, s.path, key);
      else data = { key, text: await ipc.gitDiff(r, { path: s.path, staged: s.area === "staged" }) };
    } catch (e) {
      data = { key, error: errorText(e) };
    }
    if (selKey(selRef.current) !== key) return;
    setDiff((prev) =>
      prev && prev.key === key && prev.text === data.text && prev.error === data.error && prev.note === data.note && prev.image === data.image
        ? prev
        : data,
    );
  }, []);

  useInterval(
    () => {
      refresh(false);
      if (viewRef.current === "history") loadLog();
      const s = selRef.current;
      if (s?.kind === "file") loadDiff(s);
    },
    3000,
    visible && !!dir,
  );

  useEffect(() => {
    if (dir) refresh(false);
    else {
      setSt(null);
      setErr(null);
    }
  }, [dir, refresh]);

  useEffect(() => {
    if (view === "history" && visible && root) loadLog();
  }, [view, visible, root, logLimit, loadLog]);

  // a different repository: forget selections and history
  const prevRoot = useRef(root);
  useEffect(() => {
    if (prevRoot.current === root) return;
    prevRoot.current = root;
    setSelFile(null);
    setSelCommit(null);
    setDiff(null);
    setLog(null);
    setLogLimit(50);
  }, [root]);

  useEffect(() => {
    // keyed on the selection's identity, not the object (it's rebuilt every render)
    if (selRef.current) loadDiff(selRef.current);
    else setDiff(null);
  }, [sk, loadDiff]);

  useEffect(() => {
    if (!sk) return;
    const el = listRef.current?.querySelector<HTMLElement>(`[data-key="${CSS.escape(sk)}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [sk]);

  const branch = st?.isRepo ? st.branch : "";
  useEffect(() => {
    if (branch) branchByPane.set(pane.id, branch);
    else branchByPane.delete(pane.id);
    ui.setTitle(pane.id, branch);
  }, [branch, pane.id]);

  const groups = useMemo(() => groupFiles(st?.files ?? []), [st]);

  // keep the selected file selected when it moves between staged / unstaged
  useEffect(() => {
    if (!selFile) return;
    const has = (a: Area) => groups[a].some((f) => f.path === selFile.path);
    if (has(selFile.area)) return;
    const other = (["unstaged", "staged", "untracked", "conflict"] as Area[]).find(has);
    setSelFile(other ? { ...selFile, area: other } : null);
  }, [groups]); // only when the status changes; selFile is read fresh

  // ── actions ──
  const later = () => {
    setTimeout(refresh, 1200);
    setTimeout(refresh, 4000);
  };

  /** Type a git command into the tab's terminal, targeting this repository. */
  const runGit = (build: (q: (s: string, force?: boolean) => string) => string, opts: { paths?: boolean } = {}) => {
    if (!root) return;
    // the folder of the terminal that will receive the command, not just any terminal in the tab
    const { shell, cwd: termCwd } = targetTerminal(tabId);
    const q = (s: string, force = false) => quoteArg(s, shell, force);
    const cwd = termCwd ? normPath(termCwd) : "";
    const r = normPath(root);
    const here = opts.paths ? cwd === r : cwd === r || cwd.startsWith(r + "/");
    const rootArg = shell === "bash" ? root : shellPath(winPath(root), shell);
    const prefix = here ? "git" : `git -C ${q(rootArg)}`;
    sendToTerminal(`${prefix} ${build(q)}`, { tabId, enter: true, local: true });
    later();
  };

  const confirmRun = async (title: string, args: string, okLabel: string, extra?: ReactNode) => {
    const ok = await ui.confirm(
      title,
      <>
        This runs <code>git {args}</code> in the terminal.
        {extra && <> {extra}</>}
      </>,
      { okLabel },
    );
    if (ok) runGit(() => args);
  };

  const op = async (name: string, paths?: string[]) => {
    if (!root) return;
    try {
      await ipc.gitOp(root, name, paths);
    } catch (e) {
      ui.toast(errorText(e), "error");
    }
    refresh();
  };

  const toggleStage = (f: FileSel) => (f.area === "staged" ? op("unstage", [f.path]) : op("stage", [f.path]));

  const absPath = (p: string) => joinPath(root, p.replace(/\/$/, ""));

  const openFile = (f: FileSel) => {
    if (f.path.endsWith("/")) openFilesAt(winPath(absPath(f.path)), pane.id);
    else openPreview(winPath(absPath(f.path)), pane.id);
  };

  const discard = async (f: FileSel) => {
    if (f.area === "untracked") {
      const ok = await ui.confirm(`Delete ${basename(f.path)}?`, "This untracked item is moved to the Recycle Bin.", {
        okLabel: "Move to Recycle Bin",
        danger: true,
      });
      if (!ok) return;
      try {
        await ipc.fsTrash(winPath(absPath(f.path)));
      } catch (e) {
        ui.toast(errorText(e), "error");
      }
      refresh();
      return;
    }
    const ok = await ui.confirm(
      `Discard changes to ${basename(f.path)}?`,
      <>
        Unstaged edits to <code>{f.path}</code> are lost. This runs <code>git restore</code> in the terminal and can't be undone.
      </>,
      { okLabel: "Discard changes", danger: true },
    );
    if (ok) runGit((q) => `restore -- ${q(f.path, true)}`, { paths: true });
  };

  const discardAll = async () => {
    const n = groups.unstaged.length;
    const ok = await ui.confirm(
      `Discard all ${n} unstaged change${n === 1 ? "" : "s"}?`,
      <>
        Every unstaged edit to tracked files is lost (untracked files are kept). This runs <code>git restore -- .</code> in the terminal and
        can't be undone.
      </>,
      { okLabel: "Discard all", danger: true },
    );
    if (ok) runGit(() => "restore -- .", { paths: true });
  };

  const ignoreFile = async (path: string) => {
    const file = winPath(joinPath(root, ".gitignore"));
    let text = "";
    try {
      text = await ipc.fsReadText(file);
    } catch {
      // no .gitignore yet
    }
    const line = "/" + path;
    if (!text.split(/\r?\n/).includes(line)) {
      try {
        await ipc.fsWriteText(file, text + (text && !text.endsWith("\n") ? "\n" : "") + line + "\n");
        ui.toast(`Added ${line} to .gitignore`, "success", 2000);
      } catch (e) {
        ui.toast(errorText(e), "error");
      }
    }
    refresh();
  };

  const commit = async (amend = false) => {
    if (!root) return;
    let staged = groups.staged.length;
    if (!amend && staged === 0) {
      const pending = groups.unstaged.length + groups.untracked.length;
      if (!pending) return ui.toast("Nothing to commit, working tree clean", "info");
      const ok = await ui.confirm("Nothing is staged", `Stage all ${pending} changed file${pending === 1 ? "" : "s"} and commit them?`, {
        okLabel: "Stage all & commit",
      });
      if (!ok) return;
      try {
        await ipc.gitOp(root, "stage-all");
      } catch (e) {
        return ui.toast(errorText(e), "error");
      }
      staged = pending;
      refresh();
    }
    let initial = "";
    if (amend) initial = await ipc.gitLog(root, 1).then((l) => l[0]?.subject ?? "", () => "");
    const msg = await ui.prompt(amend ? "Amend last commit" : `Commit ${staged} file${staged === 1 ? "" : "s"}`, initial, {
      label: "Commit message",
      placeholder: "Describe your changes",
      okLabel: amend ? "Amend" : "Commit",
    });
    if (msg === null) return;
    const text = msg.replace(/\s*\r?\n\s*/g, " ").trim();
    if (!text) return ui.toast("The commit message is empty", "warning");
    // only the subject was offered for editing: keep the whole message (body too) when it wasn't changed
    if (amend && text === initial.trim()) return runGit(() => "commit --amend --no-edit");
    runGit((q) => `commit ${amend ? "--amend " : ""}-m ${q(text, true)}`);
  };

  const push = () => {
    if (st?.upstream) return runGit(() => "push");
    if (!branch || branch === "(detached)") return ui.toast("Not on a branch: nothing to push", "warning");
    runGit((q) => `push -u origin ${q(branch)}`);
  };

  const gitInit = () => {
    if (!dir) return;
    const { shell, cwd: termCwd } = targetTerminal(tabId);
    const here = termCwd && normPath(termCwd) === normPath(dir);
    sendToTerminal(here ? "git init" : `git init ${quoteArg(shellPath(dir, shell), shell)}`, { tabId, enter: true, local: true });
    later();
  };

  const chooseFolder = async () => {
    const picked = await openDialog({ directory: true, multiple: false, defaultPath: dir }).catch(() => null);
    if (typeof picked === "string") setPaneMeta(pane.id, { follow: false, path: picked });
  };

  const toggleFollow = () => setPaneMeta(pane.id, following ? { follow: false, path: dir ?? null } : { follow: true });

  const manualRefresh = () => {
    setSpinning(true);
    refresh();
    if (view === "history") loadLog();
    if (sel) loadDiff(sel);
    setTimeout(() => setSpinning(false), 600);
  };

  const setView = (v: "changes" | "history") => setPaneMeta(pane.id, { view: v === "changes" ? null : v });

  const anchor = (e: React.MouseEvent) => {
    const r = e.currentTarget.getBoundingClientRect();
    return { x: r.left, y: r.bottom + 4 };
  };

  const openBranchMenu = (e: React.MouseEvent) => {
    if (!root) return;
    const at = anchor(e);
    const items = (list: string[] | null, error?: string): MenuItem[] => [
      { type: "header", label: "Switch branch" },
      ...(error
        ? [{ label: error, icon: "warning", disabled: true }]
        : list === null
          ? [{ label: "Loading branches…", icon: "loader", disabled: true }]
          : list.map<MenuItem>((b) => ({
              label: b,
              checked: b === branch,
              icon: "git-branch",
              onSelect: () => b !== branch && runGit((q) => `switch ${q(b)}`),
            }))),
      { type: "separator" },
      {
        label: "New branch…",
        icon: "plus",
        onSelect: async () => {
          const name = await ui.prompt("Create branch", "", { placeholder: "feature/my-change", okLabel: "Create & switch" });
          if (name?.trim()) runGit((q) => `switch -c ${q(name.trim())}`);
        },
      },
      { label: "Copy branch name", icon: "copy", disabled: !branch, onSelect: () => copyText(branch, "Branch name copied") },
    ];
    const first = items(null);
    ui.openMenu(at, first);
    ipc.gitOp(root, "branches").then(
      (out) => {
        if (ui.get().menu?.items !== first) return;
        // a detached HEAD / rebase lists as "(HEAD detached at …)", which isn't a branch to switch to
        ui.openMenu(at, items(out.split(/\r?\n/).map((s) => s.trim()).filter((s) => s && !s.startsWith("("))));
      },
      (err) => ui.get().menu?.items === first && ui.openMenu(at, items(null, errorText(err))),
    );
  };

  const openMoreMenu = (e: React.MouseEvent) => {
    const hasChanges = !!st?.files.length;
    ui.openMenu(anchor(e), [
      { label: "Stage all", icon: "plus", disabled: !hasChanges, onSelect: () => op("stage-all") },
      { label: "Unstage all", icon: "minus", disabled: !groups.staged.length, onSelect: () => op("unstage-all") },
      { type: "separator" },
      { label: "Amend last commit…", icon: "pencil", onSelect: () => commit(true) },
      { label: "Stash changes", icon: "download", disabled: !hasChanges, onSelect: () => runGit(() => "stash push") },
      { label: "Pop latest stash", icon: "upload", onSelect: () => runGit(() => "stash pop") },
      { type: "separator" },
      { label: "Fetch all remotes", icon: "arrow-down-up", onSelect: () => runGit(() => "fetch --all --prune") },
      { type: "separator" },
      { label: "Choose folder…", icon: "folder-open", onSelect: chooseFolder },
      { label: following ? "Stop following terminal" : "Follow terminal folder", icon: "crosshair", onSelect: toggleFollow },
      { label: "Open repository in Files", icon: "folder", disabled: !root, onSelect: () => openFilesAt(winPath(root), pane.id) },
      { label: "Copy repository path", icon: "copy", disabled: !root, onSelect: () => copyText(winPath(root), "Path copied") },
    ]);
  };

  const fileMenu = (e: React.MouseEvent, f: FileSel, letter: string) => {
    e.preventDefault();
    e.stopPropagation();
    setSelFile(f);
    const abs = winPath(absPath(f.path));
    const gone = letter === "D";
    const items: MenuItem[] = [
      { label: "Open", icon: "file-text", disabled: gone, onSelect: () => openFile(f) },
      { label: "Reveal in Explorer", icon: "folder-open", disabled: gone, onSelect: () => revealItemInDir(abs).catch((er) => ui.toast(errorText(er), "error")) },
      { label: "Copy path", icon: "copy", onSelect: () => copyText(abs, "Path copied") },
      { label: "Copy relative path", icon: "clipboard-copy", onSelect: () => copyText(f.path, "Path copied") },
      { type: "separator" },
      f.area === "staged"
        ? { label: "Unstage", icon: "minus", onSelect: () => toggleStage(f) }
        : { label: f.area === "conflict" ? "Mark resolved (stage)" : "Stage", icon: "plus", onSelect: () => toggleStage(f) },
    ];
    if (f.area === "conflict") {
      items.push(
        { label: "Resolve using ours", icon: "check", onSelect: () => runGit((q) => `checkout --ours -- ${q(f.path, true)}`, { paths: true }) },
        { label: "Resolve using theirs", icon: "check", onSelect: () => runGit((q) => `checkout --theirs -- ${q(f.path, true)}`, { paths: true }) },
      );
    }
    if (f.area === "untracked") items.push({ label: "Add to .gitignore", icon: "eye-off", onSelect: () => ignoreFile(f.path) });
    if (f.area === "unstaged" || f.area === "untracked") {
      items.push(
        { type: "separator" },
        { label: f.area === "untracked" ? "Delete…" : "Discard changes…", icon: f.area === "untracked" ? "trash" : "undo", danger: true, onSelect: () => discard(f) },
      );
    }
    ui.openMenu(e, items);
  };

  const commitMenu = (e: React.MouseEvent, c: GitCommit) => {
    e.preventDefault();
    e.stopPropagation();
    setSelCommit({ kind: "commit", hash: c.hash, short: c.short, subject: c.subject });
    ui.openMenu(e, [
      { label: "Copy hash", icon: "copy", onSelect: () => copyText(c.hash, "Commit hash copied") },
      { label: "Copy subject", icon: "clipboard-copy", onSelect: () => copyText(c.subject) },
      { type: "separator" },
      {
        label: "Checkout…",
        icon: "git-commit",
        onSelect: () => confirmRun(`Check out ${c.short}?`, `checkout ${c.hash}`, "Check out", "You'll be in a detached HEAD state."),
      },
      {
        label: "Create branch here…",
        icon: "git-branch",
        onSelect: async () => {
          const name = await ui.prompt(`New branch at ${c.short}`, "", { placeholder: "feature/my-change", okLabel: "Create & switch" });
          if (name?.trim()) runGit((q) => `switch -c ${q(name.trim())} ${c.hash}`);
        },
      },
      {
        label: "Cherry-pick…",
        icon: "check",
        onSelect: () => confirmRun(`Cherry-pick ${c.short}?`, `cherry-pick ${c.hash}`, "Cherry-pick", `Applies "${c.subject}" on top of ${branch || "HEAD"}.`),
      },
      {
        label: "Revert…",
        icon: "undo",
        onSelect: () => confirmRun(`Revert ${c.short}?`, `revert --no-edit ${c.hash}`, "Revert", `Creates a new commit undoing "${c.subject}".`),
      },
    ]);
  };

  // ── keyboard ──
  const sections = SECTIONS.map((s) => ({ ...s, files: groups[s.id] })).filter((s) => s.files.length);
  const flat: FileSel[] = sections.flatMap((s) => (collapsed[s.id] ? [] : s.files.map((f) => ({ kind: "file" as const, path: f.path, area: s.id }))));
  const shownLog = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!log || !q) return log ?? [];
    return log.filter((c) => `${c.subject} ${c.author} ${c.hash} ${c.refs}`.toLowerCase().includes(q));
  }, [log, filter]);

  const onListKey = (e: React.KeyboardEvent) => {
    if ((e.target as HTMLElement).closest("button,input")) return;
    const step = e.key === "ArrowDown" ? 1 : e.key === "ArrowUp" ? -1 : 0;
    if (view === "changes") {
      if (step && flat.length) {
        e.preventDefault();
        const i = selFile ? flat.findIndex((r) => r.path === selFile.path && r.area === selFile.area) : -1;
        setSelFile(flat[i < 0 ? 0 : clamp(i + step, 0, flat.length - 1)]);
      } else if (e.key === " " && selFile) {
        e.preventDefault();
        toggleStage(selFile);
      } else if (e.key === "Enter" && selFile) openFile(selFile);
      else if (e.key === "Escape") setSelFile(null);
    } else {
      if (step && shownLog.length) {
        e.preventDefault();
        const i = selCommit ? shownLog.findIndex((c) => c.hash === selCommit.hash) : -1;
        const c = shownLog[i < 0 ? 0 : clamp(i + step, 0, shownLog.length - 1)];
        setSelCommit({ kind: "commit", hash: c.hash, short: c.short, subject: c.subject });
      } else if (e.key === "Escape") setSelCommit(null);
    }
  };

  // ── render ──
  const shell = (content: ReactNode) => (
    <div ref={rootRef} className={cx("module git", compact && "compact")}>
      {content}
    </div>
  );

  if (!dir) {
    return shell(
      <ModuleMessage icon="folder-git" title="No folder to inspect">
        <p className="dim">Open a terminal in this tab, or choose a repository folder.</p>
        <div className="row">
          <button className="btn" onClick={chooseFolder}>
            <Icon name="folder-open" size={14} /> Choose folder…
          </button>
        </div>
      </ModuleMessage>,
    );
  }
  if (!st) {
    return shell(
      err ? (
        <ModuleMessage icon="warning" title="Couldn't read this folder">
          <p className="dim selectable git-msg-detail">{err}</p>
          <p className="dim mono git-msg-detail">{dir}</p>
          <div className="row">
            <button className="btn" onClick={() => refresh()}>
              <Icon name="refresh" size={14} /> Retry
            </button>
            <button className="btn subtle" onClick={chooseFolder}>
              Choose folder…
            </button>
          </div>
        </ModuleMessage>
      ) : (
        <ModuleMessage icon="loader" title="Reading repository…" />
      ),
    );
  }
  if (!st.isRepo) {
    return shell(
      <ModuleMessage icon="folder-git" title="Not a Git repository">
        <p className="dim mono git-msg-detail">{winPath(dir)}</p>
        <div className="row">
          <button className="btn primary" onClick={gitInit}>
            <Icon name="plus" size={14} /> Initialize repository
          </button>
          <button className="btn" onClick={chooseFolder}>
            <Icon name="folder-open" size={14} /> Choose folder…
          </button>
          {!following && (
            <button className="btn subtle" onClick={toggleFollow}>
              <Icon name="crosshair" size={14} /> Follow terminal
            </button>
          )}
        </div>
      </ModuleMessage>,
    );
  }
  if (st.untrusted?.length) {
    // nothing has run yet: git would run these the moment the pane reads the repo
    const trust = async () => {
      const ok = await ui.confirm(
        "Trust this repository?",
        `Git will run these from the repository's own settings every time the Git pane reads it:\n\n${st.untrusted.join("\n")}\n\nOnly trust repositories you know. You'll be asked again if these settings change.`,
        { okLabel: "Trust", danger: true },
      );
      if (!ok || !dir) return;
      ipc.gitTrust(dir).then(() => refresh(), (e) => ui.toast(errorText(e), "error"));
    };
    return shell(
      <ModuleMessage icon="shield" title="This repository's settings can run programs">
        <p className="dim">Its git configuration sets commands that git would run while reading the repository. Nothing has run.</p>
        <pre className="mono selectable git-msg-detail">{st.untrusted.join("\n")}</pre>
        <p className="dim mono git-msg-detail">{winPath(st.root)}</p>
        <div className="row">
          <button className="btn danger" onClick={trust}>
            <Icon name="shield" size={14} /> Trust repository…
          </button>
          <button className="btn" onClick={chooseFolder}>
            <Icon name="folder-open" size={14} /> Choose folder…
          </button>
        </div>
      </ModuleMessage>,
    );
  }

  const detached = branch === "(detached)";
  const total = st.files.length;

  const fileRow = (f: GitFile, area: Area) => {
    const fs: FileSel = { kind: "file", path: f.path, area };
    const key = selKey(fs);
    const letter = letterOf(f, area);
    const isDir = f.path.endsWith("/");
    const trimmed = f.path.replace(/\/$/, "");
    const name = basename(trimmed) + (isDir ? "/" : "");
    const parent = trimmed.includes("/") ? trimmed.slice(0, trimmed.lastIndexOf("/")) : "";
    const statusTip = area === "conflict" ? `Conflict (${f.index}${f.worktree})` : LETTER_NAMES[letter] ?? letter;
    return (
      <div
        key={key}
        data-key={key}
        className={cx("list-row git-row", sk === key && "selected", letter === "D" && "deleted")}
        title={`${f.path}\n${statusTip}`}
        onClick={() => setSelFile(fs)}
        onDoubleClick={() => letter !== "D" && openFile(fs)}
        onContextMenu={(e) => fileMenu(e, fs, letter)}
      >
        <span className={cx("git-letter", letterClass(letter))}>{letter}</span>
        <span className="git-name">{name}</span>
        <span className="git-dir">{parent}</span>
        <span className="git-row-actions" onClick={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()}>
          <button className="icon-btn" title={isDir ? "Open folder" : "Open file"} disabled={letter === "D"} onClick={() => openFile(fs)}>
            <Icon name="file-text" size={13} />
          </button>
          {(area === "unstaged" || area === "untracked") && (
            <button className="icon-btn" title={area === "untracked" ? "Delete…" : "Discard changes…"} onClick={() => discard(fs)}>
              <Icon name={area === "untracked" ? "trash" : "undo"} size={13} />
            </button>
          )}
          <button className="icon-btn" title={area === "staged" ? "Unstage" : area === "conflict" ? "Mark resolved (stage)" : "Stage"} onClick={() => toggleStage(fs)}>
            <Icon name={area === "staged" ? "minus" : "plus"} size={14} />
          </button>
        </span>
      </div>
    );
  };

  const changesList =
    total === 0 ? (
      <div className="empty-state">
        <Icon name="check" size={24} />
        <p>Working tree clean</p>
        {st.ahead > 0 && (
          <p className="dim">
            {st.ahead} commit{st.ahead === 1 ? "" : "s"} to push
          </p>
        )}
      </div>
    ) : (
      sections.map((s) => {
        const paths = s.files.map((f) => f.path);
        return (
          <div key={s.id} className="git-section">
            <div className="git-section-head" onClick={() => setCollapsed((c) => ({ ...c, [s.id]: !c[s.id] }))}>
              <Icon name={collapsed[s.id] ? "chevron-right" : "chevron-down"} size={13} />
              <span className={cx("git-section-title", s.id === "conflict" && "danger-text")}>{s.title}</span>
              <span className="git-count">{s.files.length}</span>
              <span className="grow" />
              <span className="git-section-actions" onClick={(e) => e.stopPropagation()}>
                {s.id === "unstaged" && (
                  <button className="icon-btn" title="Discard all changes…" onClick={discardAll}>
                    <Icon name="undo" size={13} />
                  </button>
                )}
                {s.id === "staged" ? (
                  <button className="icon-btn" title="Unstage all" onClick={() => op("unstage-all")}>
                    <Icon name="minus" size={14} />
                  </button>
                ) : (
                  <button className="icon-btn" title={s.id === "conflict" ? "Mark all resolved" : "Stage all in this section"} onClick={() => op("stage", paths)}>
                    <Icon name="plus" size={14} />
                  </button>
                )}
              </span>
            </div>
            {!collapsed[s.id] && s.files.map((f) => fileRow(f, s.id))}
          </div>
        );
      })
    );

  const historyList =
    log === null ? (
      logErr ? (
        <ModuleMessage icon="warning" title="Couldn't read history">
          <p className="dim selectable git-msg-detail">{logErr}</p>
        </ModuleMessage>
      ) : (
        <div className="git-diff-msg dim">Loading history…</div>
      )
    ) : log.length === 0 ? (
      <div className="empty-state">
        <Icon name="git-commit" size={24} />
        <p>No commits yet</p>
      </div>
    ) : (
      <>
        {shownLog.map((c) => {
          const key = `c:${c.hash}`;
          return (
            <div
              key={c.hash}
              data-key={key}
              className={cx("list-row git-commit", sk === key && "selected")}
              title={`${c.hash}\n${c.subject}\n${c.author} · ${c.when}`}
              onClick={() => setSelCommit({ kind: "commit", hash: c.hash, short: c.short, subject: c.subject })}
              onContextMenu={(e) => commitMenu(e, c)}
            >
              <span className="git-hash mono">{c.short}</span>
              <span className="git-subject">
                {parseRefs(c.refs).map((r) => (
                  <span key={r.kind + r.label} className={cx("chip git-ref", `git-ref-${r.kind}`, r.kind === "head" && "accent")} title={r.kind === "head" ? "HEAD" : r.label}>
                    {r.kind === "tag" && <Icon name="flag" size={9} />}
                    {r.kind === "remote" && <Icon name="cloud" size={10} />}
                    {r.label}
                  </span>
                ))}
                <span className="git-subject-text">{c.subject}</span>
              </span>
              <span className="git-author">{c.author}</span>
              <span className="git-when">{shortWhen(c.when)}</span>
            </div>
          );
        })}
        {shownLog.length === 0 && <div className="git-diff-msg dim">No commits match “{filter}”.</div>}
        {!filter && log.length >= logLimit && logLimit < 500 && (
          <div className="git-diff-more">
            <button className="btn small" onClick={() => setLogLimit((l) => Math.min(500, l + 100))}>
              Load more
            </button>
          </div>
        )}
      </>
    );

  let diffHead: ReactNode = null;
  let diffActions: ReactNode = null;
  if (sel?.kind === "file") {
    const trimmed = sel.path.replace(/\/$/, "");
    const areaLabel = { staged: "Staged", unstaged: "Working tree", untracked: "Untracked", conflict: "Conflict" }[sel.area];
    diffHead = (
      <>
        <Icon name="file" size={13} className="dim" />
        <span className="git-diff-name">{basename(trimmed)}</span>
        <span className="git-diff-path">{trimmed.includes("/") ? trimmed.slice(0, trimmed.lastIndexOf("/")) : ""}</span>
        <span className={cx("chip", sel.area === "staged" && "accent", sel.area === "conflict" && "git-chip-danger")}>{areaLabel}</span>
      </>
    );
    diffActions = (
      <>
        <button className="icon-btn" title={sel.area === "staged" ? "Unstage" : "Stage"} onClick={() => toggleStage(sel)}>
          <Icon name={sel.area === "staged" ? "minus" : "plus"} size={14} />
        </button>
        <button className="icon-btn" title="Open file" onClick={() => openFile(sel)}>
          <Icon name="file-text" size={14} />
        </button>
      </>
    );
  } else if (sel?.kind === "commit") {
    diffHead = (
      <>
        <span className="chip mono accent">{sel.short}</span>
        <span className="git-diff-name">{sel.subject}</span>
      </>
    );
    diffActions = (
      <button className="icon-btn" title="Copy commit hash" onClick={() => copyText(sel.hash, "Commit hash copied")}>
        <Icon name="hash" size={14} />
      </button>
    );
  }

  return shell(
    <>
      <div className="toolbar git-bar">
        <button className="git-branch" title={detached ? "Detached HEAD — click to switch branch" : `On ${branch} — click to switch branch`} onClick={openBranchMenu}>
          <Icon name="git-branch" size={13} />
          <span>{detached ? "detached HEAD" : branch || "…"}</span>
          <Icon name="chevron-down" size={11} />
        </button>
        {st.upstream && (
          <span className="git-upstream" title={`Tracking ${st.upstream}`}>
            {st.upstream}
          </span>
        )}
        {st.ahead > 0 && (
          <span className="chip git-ab" title={`${st.ahead} commit${st.ahead === 1 ? "" : "s"} to push`}>
            ↑{st.ahead}
          </span>
        )}
        {st.behind > 0 && (
          <span className="chip git-ab" title={`${st.behind} commit${st.behind === 1 ? "" : "s"} to pull`}>
            ↓{st.behind}
          </span>
        )}
        <span className="grow" />
        <button className="btn small subtle" title="git fetch" onClick={() => runGit(() => "fetch")}>
          <Icon name="arrow-down-up" size={13} />
          <span className="git-label">Fetch</span>
        </button>
        <button className={cx("btn small subtle", st.behind > 0 && "git-hot")} title="git pull" onClick={() => runGit(() => "pull")}>
          <Icon name="scroll-bottom" size={13} />
          <span className="git-label">Pull</span>
        </button>
        <button
          className={cx("btn small subtle", (st.ahead > 0 || (!st.upstream && !detached)) && "git-hot")}
          title={st.upstream ? "git push" : `git push -u origin ${branch}`}
          onClick={push}
        >
          <Icon name="upload" size={13} />
          <span className="git-label">{st.upstream ? "Push" : "Publish"}</span>
        </button>
        <div className="toolbar-sep" />
        <button className="icon-btn" title="Refresh" onClick={manualRefresh}>
          <Icon name="refresh" size={14} className={cx(spinning && "git-spin")} />
        </button>
        <button
          className={cx("icon-btn", following && "on")}
          title={following ? "Following the terminal's folder (click to pin this repository)" : "Pinned to this folder (click to follow the terminal)"}
          onClick={toggleFollow}
        >
          <Icon name="crosshair" size={14} />
        </button>
        <button className="icon-btn" title="More" onClick={openMoreMenu}>
          <Icon name="ellipsis" size={14} />
        </button>
      </div>
      <div className="toolbar git-bar">
        <div className="segmented">
          <button className={cx(view === "changes" && "on")} onClick={() => setView("changes")}>
            Changes{total > 0 && <span className="git-seg-count">{total}</span>}
          </button>
          <button className={cx(view === "history" && "on")} onClick={() => setView("history")}>
            History
          </button>
        </div>
        <span className="grow" />
        {view === "changes" ? (
          <>
            <button className="btn small subtle" title="Stage all changes" disabled={!total} onClick={() => op("stage-all")}>
              <Icon name="plus" size={13} />
              <span className="git-label">Stage all</span>
            </button>
            <button className="btn small subtle" title="Unstage all" disabled={!groups.staged.length} onClick={() => op("unstage-all")}>
              <Icon name="minus" size={13} />
              <span className="git-label">Unstage all</span>
            </button>
            <button className="btn small primary" title="Commit staged changes" disabled={!total} onClick={() => commit()}>
              <Icon name="check" size={13} />
              Commit…
            </button>
          </>
        ) : (
          <SearchBox value={filter} onChange={setFilter} placeholder="Filter commits" />
        )}
      </div>
      <div className={cx("git-main", wide ? "row" : "col")}>
        <div ref={listRef} className="git-list" tabIndex={0} style={sel ? { flex: `${ratio} 1 0` } : undefined} onKeyDown={onListKey}>
          {view === "changes" ? changesList : historyList}
        </div>
        {sel && <Splitter row={wide} onRatio={setRatio} />}
        {sel && (
          <div className="git-diff" style={{ flex: `${1 - ratio} 1 0` }} onKeyDown={(e) => e.key === "Escape" && (view === "changes" ? setSelFile(null) : setSelCommit(null))}>
            <DiffView
              data={diff && diff.key === sk ? diff : null}
              wrap={wrap}
              head={diffHead}
              actions={diffActions}
              onToggleWrap={() => setPaneMeta(pane.id, { wrap: wrap ? null : true })}
              onClose={() => (view === "changes" ? setSelFile(null) : setSelCommit(null))}
            />
          </div>
        )}
      </div>
      <div className="module-footer">
        <Icon name={following ? "crosshair" : "pin"} size={11} />
        <span className="ellipsis" title={winPath(root)}>
          {winPath(root)}
        </span>
        <span className="grow" />
        {err && (
          <span className="danger-text ellipsis" title={err}>
            {err}
          </span>
        )}
      </div>
    </>,
  );
}

export const gitModule: ModuleDef = {
  id: "git",
  name: "Git",
  icon: "git-branch",
  description: "Repository status and history",
  component: GitPane,
  defaultMeta: ({ cwd }) => (cwd ? { path: cwd } : {}),
  title: (pane, rt) => {
    const b = rt.title || branchByPane.get(pane.id);
    if (!b) return "Git";
    return `Git — ${b === "(detached)" ? "detached HEAD" : b}`;
  },
  onRemove: (paneId) => {
    branchByPane.delete(paneId);
    ui.setTitle(paneId, "");
  },
};
