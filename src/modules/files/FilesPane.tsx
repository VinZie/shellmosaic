// Files: a folder browser that can follow the tab's terminal, with an inline
// preview (text with line numbers, rendered markdown, images, hex) and the usual
// file operations. Rows are virtualized so huge folders stay fast.
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { openPath, revealItemInDir } from "@tauri-apps/plugin-opener";
import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Icon } from "../../lib/icons";
import { errorText, ipc, type FsEntry, type Preview, type SysSnapshot } from "../../lib/ipc";
import { basename, clamp, cx, dirname, formatBytes, joinPath, shellQuote } from "../../lib/util";
import { addModule, openFilesAt, sendToTerminal, setPaneMeta, terminalTarget } from "../../state/actions";
import type { Pane } from "../../state/model";
import { findProfile } from "../../state/profiles";
import { settings, useSettings } from "../../state/settings";
import { getState } from "../../state/store";
import { ui, type MenuItem } from "../../state/ui";
import { ModuleMessage, SearchBox, useInterval, useModuleDir } from "../common";
import { handleMarkdownClick, renderMarkdown } from "../notes/markdown";
import type { ModuleDef, ModuleProps } from "../registry";
import "./files.css";

const ROW_H = 26;
const HEADER_H = 28;
const OVERSCAN = 8;
const DRIVES = "::this-pc";

// ── paths ───────────────────────────────────────────────────────────────

let homePromise: Promise<string> | null = null;
function useHome(): string | undefined {
  const [home, setHome] = useState<string>();
  useEffect(() => {
    let alive = true;
    (homePromise ??= ipc.fsHome().catch(() => "C:\\")).then((h) => alive && setHome(h));
    return () => {
      alive = false;
    };
  }, []);
  return home;
}

const isAbsolute = (p: string) => /^[a-zA-Z]:([\\/]|$)/.test(p) || /^[\\/]{2}/.test(p) || p.startsWith("/");
const isRoot = (p: string) => /^[a-zA-Z]:[\\/]?$/.test(p) || /^\\\\[^\\/]+[\\/][^\\/]+[\\/]?$/.test(p) || p === "/";
const samePath = (a?: string | null, b?: string | null) =>
  !!a && !!b && a.replace(/[\\/]+$/, "").toLowerCase() === b.replace(/[\\/]+$/, "").toLowerCase();

/** MSYS (/c/x) and WSL (/mnt/c/x) paths → Windows paths. */
function toWinPath(p: string): string {
  const m = p.match(/^\/(?:mnt\/)?([a-zA-Z])(\/.*)?$/);
  if (!m) return p;
  return `${m[1].toUpperCase()}:\\${(m[2] ?? "").replace(/^\/+/, "").replace(/\//g, "\\")}`;
}

/** Resolve `.` and `..` and collapse separators. */
function normalizePath(p: string): string {
  let root = "";
  let rest = p;
  let m: RegExpMatchArray | null;
  if ((m = p.match(/^([a-zA-Z]:)[\\/]*(.*)$/))) {
    root = m[1].toUpperCase() + "\\";
    rest = m[2];
  } else if ((m = p.match(/^[\\/]{2}([^\\/]+)[\\/]+([^\\/]+)[\\/]*(.*)$/))) {
    root = `\\\\${m[1]}\\${m[2]}\\`;
    rest = m[3];
  } else if (p.startsWith("/")) {
    root = "/";
    rest = p.slice(1);
  }
  const sep = root === "/" ? "/" : "\\";
  const out: string[] = [];
  for (const part of rest.split(/[\\/]+/)) {
    if (!part || part === ".") continue;
    if (part === "..") out.pop();
    else out.push(part);
  }
  return root + out.join(sep);
}

function crumbs(p: string): { label: string; path: string }[] {
  let m: RegExpMatchArray | null;
  let root: { label: string; path: string };
  let rest: string;
  let sep = "\\";
  if ((m = p.match(/^([a-zA-Z]:)[\\/]*(.*)$/))) {
    root = { label: m[1].toUpperCase(), path: m[1] + "\\" };
    rest = m[2];
  } else if ((m = p.match(/^([\\/]{2}[^\\/]+[\\/][^\\/]+)[\\/]*(.*)$/))) {
    root = { label: m[1], path: m[1] + "\\" };
    rest = m[2];
  } else if (p.startsWith("/")) {
    root = { label: "/", path: "/" };
    rest = p.slice(1);
    sep = "/";
  } else return [{ label: p, path: p }];
  const out = [root];
  let acc = root.path;
  for (const part of rest.split(/[\\/]+/).filter(Boolean)) {
    acc = acc.endsWith(sep) ? acc + part : acc + sep + part;
    out.push({ label: part, path: acc });
  }
  return out;
}

const INVALID_NAME = /[<>:"/\\|?*\u0000-\u001f]/;
function validName(n: string): string | null {
  if (!n) return "Enter a name";
  if (INVALID_NAME.test(n)) return 'Names can\'t contain  < > : " / \\ | ? *';
  if (n === "." || n === ".." || /[. ]$/.test(n)) return "Names can't end with a dot or a space";
  return null;
}

// ── entry types ─────────────────────────────────────────────────────────

const CODE_EXT = new Set(
  ("js jsx ts tsx mjs cjs mts cts py pyw rs go java kt kts c h cpp cc cxx hpp hh cs fs fsx vb rb php swift scala lua pl pm r dart " +
    "vue svelte astro html htm xhtml css scss sass less styl json jsonc json5 yaml yml toml xml xaml ini cfg conf properties sh bash zsh " +
    "fish ps1 psm1 psd1 bat cmd sql graphql gql proto gradle cmake tf hcl nix zig ex exs erl hs ml clj cljs elm sol wat ipynb lock " +
    "csproj sln vcxproj props targets mk").split(" "),
);
const CODE_NAMES = new Set(["dockerfile", "makefile", "rakefile", "gemfile", "procfile", "justfile", "cmakelists.txt"]);
const IMG_EXT = new Set("png jpg jpeg gif webp bmp svg ico avif tif tiff heic".split(" "));
const TEXT_EXT = new Set("txt md markdown mdx log csv tsv rst adoc org rtf env gitignore gitattributes gitmodules editorconfig npmrc nvmrc".split(" "));
const MD_EXT = new Set(["md", "markdown", "mdx"]);

function extOf(name: string): string {
  const i = name.lastIndexOf(".");
  return i >= 0 ? name.slice(i + 1).toLowerCase() : "";
}

function entryIcon(e: { name: string; isDir: boolean }): string {
  if (e.isDir) return "folder";
  const x = extOf(e.name);
  const lower = e.name.toLowerCase();
  if (IMG_EXT.has(x)) return "image";
  if (CODE_EXT.has(x) || CODE_NAMES.has(lower)) return "file-code";
  if (TEXT_EXT.has(x) || /^(readme|license|licence|changelog|authors|notice|copying)\b/.test(lower)) return "file-text";
  return "file";
}

const dateFmt = new Intl.DateTimeFormat(undefined, { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
const timeFmt = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" });
function formatDate(ms: number): string {
  if (!ms) return "";
  const d = new Date(ms);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return `Today ${timeFmt.format(d)}`;
  return dateFmt.format(d);
}

type SortKey = "name" | "size" | "modified";
interface Sort {
  key: SortKey;
  desc: boolean;
}

const nameCmp = (a: FsEntry, b: FsEntry) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });

function sortEntries(list: FsEntry[], sort: Sort): FsEntry[] {
  const by =
    sort.key === "size"
      ? (a: FsEntry, b: FsEntry) => a.size - b.size || nameCmp(a, b)
      : sort.key === "modified"
        ? (a: FsEntry, b: FsEntry) => a.modified - b.modified || nameCmp(a, b)
        : nameCmp;
  return [...list].sort((a, b) => Number(b.isDir) - Number(a.isDir) || (sort.desc ? -by(a, b) : by(a, b)));
}

function nameMatcher(q: string): ((name: string) => boolean) | null {
  const s = q.trim();
  if (!s) return null;
  if (/[*?]/.test(s)) {
    const src = [...s].map((c) => (c === "*" ? ".*" : c === "?" ? "." : c.replace(/[.+^${}()|[\]\\]/g, "\\$&"))).join("");
    const re = new RegExp(`^${src}$`, "i");
    return (n) => re.test(n);
  }
  const low = s.toLowerCase();
  return (n) => n.toLowerCase().includes(low);
}

const sameEntries = (a: FsEntry[], b: FsEntry[]) =>
  a.length === b.length && a.every((e, i) => e.path === b[i].path && e.size === b[i].size && e.modified === b[i].modified && e.isDir === b[i].isDir);

// ── terminal helpers ────────────────────────────────────────────────────

/** Profile kind of the terminal `sendToTerminal` will type into for this tab. */
function targetKind(tabId: string): string | undefined {
  const target = terminalTarget(tabId, { local: true });
  // no terminal: sendToTerminal opens one with the default profile (findProfile with no id),
  // which must get its own quoting (pwsh would run a "$(…)" in a folder name)
  return findProfile(target ? getState().model.panes[target]?.meta.profile : undefined)?.kind;
}

/** `cd` in the syntax of the shell that will receive it. */
function cdCommand(dir: string, tabId: string): string {
  const kind = targetKind(tabId);
  const sq = (s: string) => s.replace(/'/g, "'\\''");
  // PowerShell also closes a '…' string at ‘ ’ ‚ ‛
  const psq = (s: string) => s.replace(/['‘’‚‛]/g, "$&$&");
  switch (kind) {
    case "cmd":
      return `cd /d "${dir}"`;
    case "bash":
      return `cd '${sq(dir.replace(/\\/g, "/"))}'`;
    case "wsl":
      return `cd "$(wslpath '${sq(dir)}')"`;
    case "pwsh":
    case "powershell":
      return /[[\]`]/.test(dir) ? `cd -LiteralPath '${psq(dir)}'` : `cd '${psq(dir)}'`;
    default:
      return `cd "${dir}"`;
  }
}

function cdInTerminal(dir: string, tabId: string) {
  sendToTerminal(cdCommand(dir, tabId), { tabId, enter: true, local: true }).catch((e) => ui.toast(errorText(e), "error"));
}

function openTerminalAt(dir: string, tabId: string, paneId: string) {
  addModule("terminal", { tabId, target: paneId, side: "bottom", meta: { cwd: dir } });
}

const toastErr = (e: unknown) => ui.toast(errorText(e), "error");

/** Server name of a UNC path (`\\host\share\…`), lowercased. */
const uncHost = (p: string) => /^[\\/]{2}([^\\/]+)/.exec(p)?.[1]?.toLowerCase();

function copyText(text: string, what = "Path") {
  writeText(text)
    .then(() => ui.toast(`${what} copied`, "success", 1500))
    .catch(toastErr);
}

function useWidth(ref: React.RefObject<HTMLElement | null>): number {
  const [w, setW] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => {
      const width = Math.round(e.contentRect.width);
      if (width > 0) setW(width);
    });
    ro.observe(el);
    if (el.clientWidth) setW(el.clientWidth);
    return () => ro.disconnect();
  }, [ref]);
  return w;
}

// ── pane ────────────────────────────────────────────────────────────────

function FilesPane({ pane, tabId, visible, focused }: ModuleProps) {
  const home = useHome();
  const { dir: rawDir, following } = useModuleDir(pane, tabId, home);
  const dir = rawDir ? toWinPath(rawDir) : undefined;
  const defaultHidden = useSettings((s) => s.settings.modules.files.showHidden);
  const showHidden: boolean = pane.meta.showHidden ?? defaultHidden;
  const sort: Sort = pane.meta.sort?.key ? pane.meta.sort : { key: "name", desc: false };
  const sortKey = sort.key;
  const sortDesc = !!sort.desc;

  const rootRef = useRef<HTMLDivElement>(null);
  const mainRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const width = useWidth(rootRef);
  const narrow = width > 0 && width < 540;
  const stacked = width > 0 && width < 680;

  const [drives, setDrives] = useState(false);
  const [listing, setListing] = useState<{ dir: string; hidden: boolean; entries: FsEntry[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [filter, setFilter] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewH, setViewH] = useState(400);
  const [split, setSplit] = useState<number>(typeof pane.meta.split === "number" ? pane.meta.split : 0.5);
  const splitRef = useRef(split);
  splitRef.current = split;
  const pendingSelect = useRef<string | null>(null);
  const histNav = useRef<"back" | "fwd" | "replace" | null>(null);
  const reqId = useRef(0);
  const inflight = useRef(false);

  // ── preview path (local for instant feedback, mirrored into pane.meta) ──
  const [previewPath, setPreviewPathState] = useState<string | null>(pane.meta.preview ?? null);
  useEffect(() => setPreviewPathState(pane.meta.preview ?? null), [pane.meta.preview]);
  const metaTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const setPreview = useCallback(
    (p: string | null, immediate = false) => {
      setPreviewPathState(p);
      clearTimeout(metaTimer.current);
      const save = () => {
        if ((getState().model.panes[pane.id]?.meta.preview ?? null) !== p) setPaneMeta(pane.id, { preview: p });
      };
      if (immediate) save();
      else metaTimer.current = setTimeout(save, 350);
    },
    [pane.id],
  );
  useEffect(() => () => clearTimeout(metaTimer.current), []);

  // ── loading ──
  const load = useCallback(
    async (quiet = false) => {
      if (!dir) return;
      if (quiet && inflight.current) return;
      const id = ++reqId.current;
      inflight.current = true;
      if (!quiet) setLoading(true);
      try {
        const list = await ipc.fsList(dir, showHidden);
        if (id !== reqId.current) return;
        setListing((prev) =>
          prev && prev.dir === dir && prev.hidden === showHidden && sameEntries(prev.entries, list) ? prev : { dir, hidden: showHidden, entries: list },
        );
        setError(null);
      } catch (e) {
        if (id !== reqId.current) return;
        // a file path (e.g. dropped from Explorer): show its folder and preview it.
        // Not while following the terminal: its "folder" comes from terminal output,
        // and printing a file's path must not open that file here.
        if (!quiet && !following && !(await ipc.fsIsDir(dir).catch(() => true))) {
          const isFile = await ipc
            .fsPreview(dir, 1)
            .then((p) => p.kind !== "directory")
            .catch(() => false);
          if (isFile && id === reqId.current) {
            pendingSelect.current = dir;
            histNav.current = "replace";
            setPreviewPathState(dir);
            setPaneMeta(pane.id, { path: dirname(dir), follow: false, preview: dir });
            return;
          }
        }
        // the checks above awaited: a newer load may have taken over meanwhile
        if (id !== reqId.current) return;
        setError(errorText(e));
        setListing({ dir, hidden: showHidden, entries: [] });
      } finally {
        if (id === reqId.current) {
          inflight.current = false;
          setLoading(false);
        }
      }
    },
    [dir, showHidden, pane.id, following],
  );

  useEffect(() => {
    if (!dir) return;
    load();
  }, [load, dir]);
  // light polling while on screen (and an immediate refresh when it comes back)
  useInterval(() => load(true), 4000, visible && !drives && !!dir);
  useEffect(() => {
    const onFocus = () => visible && !drives && load(true);
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [visible, drives, load]);

  // expose the folder as this pane's cwd: header title, and new panes split from here start in it
  useEffect(() => {
    if (dir && !drives) ui.setCwd(pane.id, dir);
    ui.setTitle(pane.id, drives ? "This PC" : "");
  }, [dir, drives, pane.id]);

  // ── history ──
  const viewKey = drives ? DRIVES : dir ?? "";
  const [back, setBack] = useState<string[]>([]);
  const [fwd, setFwd] = useState<string[]>([]);
  const prevView = useRef<string>("");
  useEffect(() => {
    const prev = prevView.current;
    prevView.current = viewKey;
    if (!prev || !viewKey || samePath(prev, viewKey)) return;
    if (histNav.current === "back") setFwd((f) => [prev, ...f].slice(0, 50));
    else if (histNav.current === "fwd") setBack((b) => [...b, prev].slice(-50));
    else if (histNav.current !== "replace") {
      setBack((b) => [...b, prev].slice(-50));
      setFwd([]);
    }
    histNav.current = null;
    // new folder: reset scroll, selection and any stale error
    setSelected(null);
    setError(null);
    setFilter("");
    setScrollTop(0);
    if (listRef.current) listRef.current.scrollTop = 0;
  }, [viewKey]);

  const navigate = useCallback(
    (path: string, opts: { select?: string; hist?: "back" | "fwd" } = {}) => {
      histNav.current = opts.hist ?? null;
      pendingSelect.current = opts.select ?? null;
      if (path === DRIVES) {
        setDrives(true);
        return;
      }
      setDrives(false);
      const cur = getState().model.panes[pane.id]?.meta;
      if (cur?.follow !== false || cur?.path !== path) setPaneMeta(pane.id, { path, follow: false });
    },
    [pane.id],
  );

  const goBack = () => {
    const target = back[back.length - 1];
    if (target === undefined) return;
    setBack((b) => b.slice(0, -1));
    navigate(target, { hist: "back" });
  };
  const goForward = () => {
    const target = fwd[0];
    if (target === undefined) return;
    setFwd((f) => f.slice(1));
    navigate(target, { hist: "fwd" });
  };
  const goUp = () => {
    if (drives || !dir) return;
    if (isRoot(dir)) return navigate(DRIVES, { select: dir });
    navigate(dirname(dir), { select: dir });
  };

  const toggleFollow = () => {
    if (following) setPaneMeta(pane.id, { follow: false, path: dir });
    else {
      setDrives(false);
      setPaneMeta(pane.id, { follow: true });
    }
  };
  const toggleHidden = () => setPaneMeta(pane.id, { showHidden: !showHidden });

  // ── rows ──
  // (while a show-hidden toggle reloads, keep showing the old listing instead of flashing)
  const entries = listing && listing.dir === dir ? listing.entries : null;
  const rows = useMemo(() => {
    if (!entries) return [];
    const match = nameMatcher(filter);
    return sortEntries(match ? entries.filter((e) => match(e.name)) : entries, { key: sortKey, desc: sortDesc });
  }, [entries, filter, sortKey, sortDesc]);

  const selIndex = useMemo(() => rows.findIndex((r) => r.path === selected), [rows, selected]);
  const current = selIndex >= 0 ? rows[selIndex] : undefined;

  const ensureVisible = useCallback((i: number) => {
    const el = listRef.current;
    if (!el || i < 0) return;
    const top = i * ROW_H;
    if (top < el.scrollTop) el.scrollTop = top;
    else if (HEADER_H + top + ROW_H > el.scrollTop + el.clientHeight) el.scrollTop = HEADER_H + top + ROW_H - el.clientHeight;
  }, []);

  // select a remembered entry once it shows up (the folder we came from, a new file…)
  useEffect(() => {
    const want = pendingSelect.current;
    if (!want || !entries) return;
    const i = rows.findIndex((r) => samePath(r.path, want));
    if (i >= 0) {
      pendingSelect.current = null;
      setSelected(rows[i].path);
      requestAnimationFrame(() => ensureVisible(i));
    }
  }, [rows, entries, ensureVisible]);

  // track the list viewport for virtualization (the list element comes and goes)
  const listObserver = useRef<ResizeObserver | null>(null);
  const setListEl = useCallback((el: HTMLDivElement | null) => {
    listRef.current = el;
    listObserver.current?.disconnect();
    listObserver.current = null;
    if (!el) return;
    const ro = new ResizeObserver(() => el.clientHeight && setViewH(el.clientHeight));
    ro.observe(el);
    listObserver.current = ro;
    if (el.clientHeight) setViewH(el.clientHeight);
    setScrollTop(el.scrollTop);
  }, []);
  useEffect(() => () => listObserver.current?.disconnect(), []);

  // focus the list when the pane gets focus
  useEffect(() => {
    if (!focused || !visible) return;
    const active = document.activeElement;
    if (active && rootRef.current?.contains(active)) return;
    if (ui.get().dialog || ui.get().palette.open) return;
    listRef.current?.focus({ preventScroll: true });
  }, [focused, visible]);

  const select = (e: FsEntry) => {
    setSelected(e.path);
    if (previewPath && !e.isDir) setPreview(e.path);
  };

  const open = (e: FsEntry) => {
    if (e.isDir) navigate(e.path);
    else setPreview(e.path, true);
  };

  const setSort = (key: SortKey) =>
    setPaneMeta(pane.id, { sort: sort.key === key ? { key, desc: !sort.desc } : { key, desc: key !== "name" } });

  // ── operations ──
  const refocus = () => requestAnimationFrame(() => listRef.current?.focus({ preventScroll: true }));

  const newItem = async (kind: "folder" | "file") => {
    if (!dir) return;
    const name = await ui.prompt(kind === "folder" ? "New folder" : "New file", kind === "folder" ? "New folder" : "", {
      label: "Name",
      placeholder: kind === "file" ? "e.g. notes.md" : undefined,
      okLabel: "Create",
    });
    refocus();
    const n = name?.trim();
    if (!n) return;
    const bad = validName(n);
    if (bad) return ui.toast(bad, "error");
    const p = joinPath(dir, n);
    try {
      await (kind === "folder" ? ipc.fsMkdir(p) : ipc.fsNewFile(p));
      pendingSelect.current = p;
      setFilter("");
      await load();
    } catch (e) {
      toastErr(e);
    }
  };

  const rename = async (e: FsEntry) => {
    const name = await ui.prompt(`Rename "${e.name}"`, e.name, { label: "New name", okLabel: "Rename" });
    refocus();
    const n = name?.trim();
    if (!n || n === e.name) return;
    const bad = validName(n);
    if (bad) return ui.toast(bad, "error");
    const to = joinPath(dirname(e.path), n);
    try {
      if (n.toLowerCase() === e.name.toLowerCase()) {
        // case-only rename: go through a temporary name (Windows paths are case-insensitive)
        const tmp = joinPath(dirname(e.path), `${n}.${Date.now()}.tmp`);
        await ipc.fsRename(e.path, tmp);
        await ipc.fsRename(tmp, to);
      } else await ipc.fsRename(e.path, to);
      pendingSelect.current = to;
      if (previewPath && samePath(previewPath, e.path)) setPreview(to, true);
      await load();
    } catch (err) {
      toastErr(err);
    }
  };

  const trash = async (e: FsEntry) => {
    const ok = await ui.confirm(
      `Move "${e.name}" to the Recycle Bin?`,
      e.isDir ? "The folder and everything in it can be restored from the Recycle Bin." : "You can restore it from the Recycle Bin.",
      { okLabel: "Move to Recycle Bin", danger: true },
    );
    refocus();
    if (!ok) return;
    try {
      const idx = rows.findIndex((r) => r.path === e.path);
      await ipc.fsTrash(e.path);
      if (previewPath && samePath(previewPath, e.path)) setPreview(null, true);
      const next = rows[idx + 1] ?? rows[idx - 1];
      if (next) pendingSelect.current = next.path;
      await load();
      ui.toast(`Moved "${e.name}" to the Recycle Bin`, "success", 2200);
    } catch (err) {
      toastErr(err);
    }
  };

  // ── menus ──
  const rowMenu = (ev: React.MouseEvent, e: FsEntry) => {
    ev.preventDefault();
    ev.stopPropagation();
    setSelected(e.path);
    const here = e.isDir ? e.path : dirname(e.path);
    const items: MenuItem[] = [
      ...(e.isDir
        ? [
            { label: "Open", icon: "folder-open", shortcut: "Enter", onSelect: () => navigate(e.path) },
            { label: "Open in Explorer", icon: "external-link", onSelect: () => openPath(e.path).catch(toastErr) },
            { label: "Open in new Files pane", icon: "columns-2", onSelect: () => openFilesAt(e.path, pane.id) },
          ]
        : [
            { label: "Open with default app", icon: "external-link", shortcut: "Ctrl+Enter", onSelect: () => openPath(e.path).catch(toastErr) },
            { label: "Preview", icon: "eye", shortcut: "Enter", onSelect: () => setPreview(e.path, true) },
          ]),
      { label: "Reveal in Explorer", icon: "folder", onSelect: () => revealItemInDir(e.path).catch(toastErr) },
      { type: "separator" },
      { label: "Copy path", icon: "copy", shortcut: "Ctrl+C", onSelect: () => copyText(e.path) },
      { label: "Copy name", icon: "clipboard-copy", onSelect: () => copyText(e.name, "Name") },
      { label: "Insert path into terminal", icon: "terminal", onSelect: () => sendToTerminal(shellQuote(e.path, targetKind(tabId)) + " ", { tabId, local: true }) },
      { type: "separator" },
      { label: "cd here in terminal", icon: "enter", hint: basename(here), onSelect: () => cdInTerminal(here, tabId) },
      { label: "Open terminal here", icon: "square-terminal", onSelect: () => openTerminalAt(here, tabId, pane.id) },
      { type: "separator" },
      { label: "New folder…", icon: "folder-plus", onSelect: () => newItem("folder") },
      { label: "New file…", icon: "file-plus", onSelect: () => newItem("file") },
      { label: "Rename…", icon: "pencil", shortcut: "F2", onSelect: () => rename(e) },
      { type: "separator" },
      { label: "Move to Recycle Bin", icon: "trash", shortcut: "Del", danger: true, onSelect: () => trash(e) },
    ];
    ui.openMenu(ev, items);
  };

  const areaMenu = (ev: React.MouseEvent) => {
    ev.preventDefault();
    if (!dir) return;
    ui.openMenu(ev, [
      { label: "New folder…", icon: "folder-plus", onSelect: () => newItem("folder") },
      { label: "New file…", icon: "file-plus", onSelect: () => newItem("file") },
      { type: "separator" },
      { label: "Refresh", icon: "refresh", shortcut: "F5", onSelect: () => load() },
      { label: "Show hidden files", icon: showHidden ? "eye" : "eye-off", checked: showHidden, onSelect: toggleHidden },
      { type: "separator" },
      { label: "Open in Explorer", icon: "external-link", onSelect: () => openPath(dir).catch(toastErr) },
      { label: "Copy path", icon: "copy", onSelect: () => copyText(dir) },
      { label: "cd here in terminal", icon: "enter", onSelect: () => cdInTerminal(dir, tabId) },
      { label: "Open terminal here", icon: "square-terminal", onSelect: () => openTerminalAt(dir, tabId, pane.id) },
    ]);
  };

  // ── keyboard ──
  const typeahead = useRef({ text: "", at: 0 });
  const onListKey = (e: React.KeyboardEvent) => {
    const move = (to: number) => {
      if (!rows.length) return;
      const i = clamp(to, 0, rows.length - 1);
      select(rows[i]);
      ensureVisible(i);
    };
    const page = Math.max(1, Math.floor((viewH - HEADER_H) / ROW_H) - 1);
    const mod = e.ctrlKey || e.metaKey;
    if (e.altKey) {
      if (e.key === "ArrowLeft") goBack();
      else if (e.key === "ArrowRight") goForward();
      else if (e.key === "ArrowUp") goUp();
      else return;
      e.preventDefault();
      return;
    }
    switch (e.key) {
      case "ArrowDown":
        move(selIndex < 0 ? 0 : selIndex + 1);
        break;
      case "ArrowUp":
        move(selIndex < 0 ? 0 : selIndex - 1);
        break;
      case "PageDown":
        move(selIndex + page);
        break;
      case "PageUp":
        move(selIndex - page);
        break;
      case "Home":
        move(0);
        break;
      case "End":
        move(rows.length - 1);
        break;
      case "Enter":
        if (!current) return;
        if (mod) openPath(current.path).catch(toastErr);
        else open(current);
        break;
      case "Backspace":
        goUp();
        break;
      case "Delete":
        if (current) trash(current);
        break;
      case "F2":
        if (current) rename(current);
        break;
      case "F5":
        load();
        break;
      case " ":
        if (!current || current.isDir) return;
        setPreview(previewPath && samePath(previewPath, current.path) ? null : current.path, true);
        break;
      case "Escape":
        if (filter) setFilter("");
        else if (previewPath) setPreview(null, true);
        else return;
        break;
      default: {
        if (mod && e.key.toLowerCase() === "c" && current) {
          copyText(current.path);
          break;
        }
        if (e.key.length !== 1 || mod) return;
        // type-ahead: jump to the first name starting with what was typed
        const now = Date.now();
        const t = typeahead.current;
        t.text = now - t.at > 800 ? e.key : t.text + e.key;
        t.at = now;
        const q = t.text.toLowerCase();
        const i = rows.findIndex((r) => r.name.toLowerCase().startsWith(q));
        if (i >= 0) move(i);
      }
    }
    e.preventDefault();
  };

  const onMouseUp = (e: React.MouseEvent) => {
    if (e.button === 3) {
      e.preventDefault();
      goBack();
    } else if (e.button === 4) {
      e.preventDefault();
      goForward();
    }
  };

  // ── path bar ──
  const submitPath = async (raw: string): Promise<boolean> => {
    let p = raw.trim().replace(/^"(.*)"$/, "$1");
    if (!p) return false;
    if (home && (p === "~" || /^~[\\/]/.test(p))) p = home + p.slice(1);
    p = toWinPath(p);
    if (!isAbsolute(p)) {
      if (!dir || drives) return false;
      p = joinPath(dir, p);
    }
    p = normalizePath(p);
    if (await ipc.fsIsDir(p).catch(() => false)) {
      navigate(p);
      return true;
    }
    const parent = dirname(p);
    if (parent !== p && (await ipc.fsIsDir(parent).catch(() => false))) {
      const isFile = await ipc
        .fsPreview(p, 1)
        .then((r) => r.kind !== "directory")
        .catch(() => false);
      if (isFile) {
        navigate(parent, { select: p });
        setPreview(p, true);
        return true;
      }
    }
    ui.toast(`Not found: ${p}`, "error");
    return false;
  };

  // ── splitter between list and preview ──
  const onSplitDown = (e: React.PointerEvent) => {
    e.preventDefault();
    const box = mainRef.current?.getBoundingClientRect();
    if (!box) return;
    const cls = stacked ? "resizing-row" : "resizing-col";
    document.body.classList.add(cls);
    const move = (ev: PointerEvent) => {
      const frac = stacked ? (box.bottom - ev.clientY) / box.height : (box.right - ev.clientX) / box.width;
      setSplit(clamp(frac, 0.2, 0.8));
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      document.body.classList.remove(cls);
      setPaneMeta(pane.id, { split: Math.round(splitRef.current * 1000) / 1000 });
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  // ── render ──
  const first = Math.max(0, Math.floor(scrollTop / ROW_H) - OVERSCAN);
  const last = Math.min(rows.length, Math.ceil((scrollTop + viewH - HEADER_H) / ROW_H) + OVERSCAN);
  // memoized: every scroll event re-renders the pane, and these walk the whole folder
  const previewEntry = useMemo(() => (previewPath ? entries?.find((e) => samePath(e.path, previewPath)) : undefined), [entries, previewPath]);
  const folders = useMemo(() => rows.filter((r) => r.isDir).length, [rows]);

  let listBody: React.ReactNode;
  if (drives) {
    listBody = <ThisPC home={home} selectPath={pendingSelect.current} onOpen={(p) => navigate(p)} />;
  } else if (!dir || (!entries && !error)) {
    listBody = (
      <div className="empty-state">
        <Icon name="loader" size={20} className="files-spin" />
      </div>
    );
  } else if (error) {
    listBody = (
      <ModuleMessage icon="warning" title="Can't open this folder">
        <p className="files-error selectable">{error}</p>
        <div className="row">
          <button className="btn" onClick={() => load()}>
            <Icon name="refresh" size={13} /> Retry
          </button>
          {home && (
            <button className="btn subtle" onClick={() => navigate(home)}>
              <Icon name="home" size={13} /> Home
            </button>
          )}
        </div>
      </ModuleMessage>
    );
  } else {
    listBody = (
      <div
        ref={setListEl}
        className="files-list"
        tabIndex={0}
        // keys this list handles itself, which the app's own shortcuts would otherwise take
        data-own-keys="f2 alt+left alt+right alt+up"
        onKeyDown={onListKey}
        onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
        onContextMenu={areaMenu}
        onClick={(e) => e.target === e.currentTarget && setSelected(null)}
      >
        <div className="files-row files-head" style={{ height: HEADER_H }}>
          {(
            [
              ["name", "Name"],
              ["size", "Size"],
              ["modified", "Modified"],
            ] as [SortKey, string][]
          ).map(([k, label]) => (
            <button key={k} className={cx("files-cell", `files-col-${k}`, sort.key === k && "sorted")} onClick={() => setSort(k)}>
              {label}
              {sort.key === k && <Icon name={sort.desc ? "chevron-down" : "chevron-up"} size={11} />}
            </button>
          ))}
        </div>
        <div className="files-rows" style={{ height: rows.length * ROW_H }} onClick={(e) => e.target === e.currentTarget && setSelected(null)}>
          {rows.slice(first, last).map((r, k) => {
            const i = first + k;
            return (
              <div
                key={r.path}
                className={cx("files-row", r.path === selected && "selected", r.hidden && "files-hidden", previewPath === r.path && "previewing")}
                style={{ top: i * ROW_H, height: ROW_H }}
                onClick={() => select(r)}
                onDoubleClick={() => open(r)}
                onContextMenu={(ev) => rowMenu(ev, r)}
                title={r.name}
              >
                <span className="files-cell files-col-name">
                  <Icon name={entryIcon(r)} size={15} className={cx("files-icon", r.isDir && "files-icon-dir")} />
                  <span className="ellipsis">{r.name}</span>
                  {r.isLink && <Icon name="share" size={10} className="dim" />}
                </span>
                <span className="files-cell files-col-size">{r.isDir ? "" : formatBytes(r.size)}</span>
                <span className="files-cell files-col-modified">{formatDate(r.modified)}</span>
              </div>
            );
          })}
        </div>
        {rows.length === 0 && (
          <div className="files-empty dim">{filter ? `Nothing matches "${filter}"` : "This folder is empty"}</div>
        )}
      </div>
    );
  }

  const previewOpen = !!previewPath;

  return (
    <div className={cx("module files", narrow && "files-narrow")} ref={rootRef} onMouseUp={onMouseUp}>
      <div className="toolbar files-toolbar">
        <button className="icon-btn" title="Back (Alt+Left)" disabled={!back.length} onClick={goBack}>
          <Icon name="arrow-left" size={15} />
        </button>
        <button className="icon-btn" title="Forward (Alt+Right)" disabled={!fwd.length} onClick={goForward}>
          <Icon name="arrow-right" size={15} />
        </button>
        <button className="icon-btn" title="Up (Backspace)" disabled={drives || !dir} onClick={goUp}>
          <Icon name="arrow-up" size={15} />
        </button>
        <button className="icon-btn" title="Refresh (F5)" disabled={drives} onClick={() => load()}>
          <Icon name="refresh" size={14} className={cx(loading && "files-spin")} />
        </button>
        <PathBar dir={dir ?? ""} drives={drives} onNavigate={(p) => navigate(p)} onSubmit={submitPath} />
        {!narrow && (
          <button className={cx("icon-btn", drives && "on")} title="This PC — drives and quick access" onClick={() => (drives ? dir && navigate(dir) : navigate(DRIVES))}>
            <Icon name="hard-drive" size={15} />
          </button>
        )}
        <button className={cx("icon-btn", following && "on")} title={following ? "Following the terminal's folder (click to stop)" : "Follow the terminal's folder"} onClick={toggleFollow}>
          <Icon name={following ? "plug" : "unplug"} size={15} />
        </button>
        <button className={cx("icon-btn", showHidden && "on")} title={showHidden ? "Hide hidden files" : "Show hidden files"} onClick={toggleHidden}>
          <Icon name={showHidden ? "eye" : "eye-off"} size={15} />
        </button>
        {!drives && (
          <div
            className="files-filter"
            onKeyDown={(e) => {
              // jump from the filter into the list
              if ((e.key === "ArrowDown" || e.key === "Enter") && rows.length) {
                e.preventDefault();
                if (e.key === "Enter" && rows.length === 1) open(rows[0]);
                else {
                  select(rows[0]);
                  ensureVisible(0);
                  listRef.current?.focus();
                }
              }
            }}
          >
            <SearchBox value={filter} onChange={setFilter} placeholder={narrow ? "Filter" : "Filter (*.ts)"} />
          </div>
        )}
      </div>

      <div ref={mainRef} className={cx("files-main", previewOpen && (stacked ? "files-stacked" : "files-side"))}>
        <div className="files-listwrap" style={previewOpen ? { flexBasis: `${(1 - split) * 100}%` } : undefined}>
          {listBody}
        </div>
        {previewOpen && (
          <>
            <div className="files-splitter" onPointerDown={onSplitDown} />
            <PreviewPanel
              path={previewPath!}
              version={previewEntry ? `${previewEntry.modified}:${previewEntry.size}` : ""}
              tabId={tabId}
              style={{ flexBasis: `${split * 100}%` }}
              onClose={() => {
                setPreview(null, true);
                refocus();
              }}
              onNavigate={(p) => navigate(p)}
              onPreview={(p) => setPreview(p, true)}
            />
          </>
        )}
      </div>

      <div className="module-footer files-footer">
        {drives ? (
          <span>This PC</span>
        ) : entries ? (
          <>
            <span>
              {filter ? `${rows.length} of ${entries.length}` : rows.length} {rows.length === 1 ? "item" : "items"}
            </span>
            {folders > 0 && folders < rows.length && (
              <span className="dim">
                {folders} {folders === 1 ? "folder" : "folders"}, {rows.length - folders} {rows.length - folders === 1 ? "file" : "files"}
              </span>
            )}
            {current && !current.isDir && (
              <span className="ellipsis files-footer-sel">
                {current.name} · {formatBytes(current.size)}
              </span>
            )}
          </>
        ) : (
          <span>Loading…</span>
        )}
        <span className="grow" />
        {following && (
          <span className="files-follow-chip" title="This pane follows the terminal's working directory">
            <Icon name="plug" size={11} /> following terminal
          </span>
        )}
      </div>
    </div>
  );
}

// ── path bar ────────────────────────────────────────────────────────────

function PathBar({
  dir,
  drives,
  onNavigate,
  onSubmit,
}: {
  dir: string;
  drives: boolean;
  onNavigate: (p: string) => void;
  onSubmit: (p: string) => Promise<boolean>;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    if (ref.current) ref.current.scrollLeft = ref.current.scrollWidth;
  }, [dir, drives, editing]);

  const startEdit = () => {
    setValue(drives ? "" : dir);
    setEditing(true);
  };

  if (editing) {
    return (
      <input
        className="input mono files-path-input"
        autoFocus
        spellCheck={false}
        value={value}
        disabled={busy}
        placeholder="Type a folder path and press Enter"
        onFocus={(e) => e.currentTarget.select()}
        onChange={(e) => setValue(e.target.value)}
        onBlur={() => !busy && setEditing(false)}
        onKeyDown={async (e) => {
          e.stopPropagation();
          if (e.key === "Escape") setEditing(false);
          if (e.key === "Enter") {
            setBusy(true);
            const ok = await onSubmit(value);
            setBusy(false);
            if (ok) setEditing(false);
          }
        }}
      />
    );
  }

  const parts = drives ? [] : crumbs(dir);
  return (
    <div className="files-path" ref={ref} onClick={(e) => e.target === e.currentTarget && startEdit()} title="Click an empty spot to type a path">
      <button className={cx("files-crumb files-crumb-pc", drives && "current")} title="This PC" onClick={() => onNavigate(DRIVES)}>
        <Icon name="monitor" size={13} />
        {drives && <span>This PC</span>}
      </button>
      {parts.map((c, i) => (
        <Fragment key={c.path}>
          <Icon name="chevron-right" size={12} className="files-crumb-sep" />
          <button className={cx("files-crumb", i === parts.length - 1 && "current")} onClick={() => onNavigate(c.path)} title={c.path}>
            {c.label}
          </button>
        </Fragment>
      ))}
      <span className="files-path-fill" onClick={startEdit} />
    </div>
  );
}

// ── This PC ─────────────────────────────────────────────────────────────

function ThisPC({ home, selectPath, onOpen }: { home?: string; selectPath: string | null; onOpen: (p: string) => void }) {
  const [drives, setDrives] = useState<string[] | null>(null);
  const [disks, setDisks] = useState<SysSnapshot["disks"]>([]);
  const [quick, setQuick] = useState<{ label: string; path: string; icon: string }[]>([]);

  useEffect(() => {
    let alive = true;
    ipc
      .fsDrives()
      .then((d) => alive && setDrives(d))
      .catch(() => alive && setDrives([]));
    ipc
      .sysSnapshot(true)
      .then((s) => alive && setDisks(s.disks))
      .catch(() => {});
    if (home) {
      const cands = [
        { label: "Home", path: home, icon: "home" },
        { label: "Desktop", path: joinPath(home, "Desktop"), icon: "monitor" },
        { label: "Documents", path: joinPath(home, "Documents"), icon: "file-text" },
        { label: "Downloads", path: joinPath(home, "Downloads"), icon: "download" },
      ];
      Promise.all(cands.map((c) => ipc.fsIsDir(c.path).catch(() => false))).then((ok) => alive && setQuick(cands.filter((_, i) => ok[i])));
    }
    return () => {
      alive = false;
    };
  }, [home]);

  const diskFor = (d: string) => disks.find((k) => k.mount.toUpperCase().startsWith(d.slice(0, 2).toUpperCase()));

  return (
    <div className="module-scroll files-pc">
      {quick.length > 0 && (
        <>
          <div className="field-label">Quick access</div>
          <div className="files-pc-grid">
            {quick.map((q) => (
              <button key={q.path} className="files-pc-item" onClick={() => onOpen(q.path)} title={q.path}>
                <Icon name={q.icon} size={18} className="files-icon-dir" />
                <span className="files-pc-text">
                  <span className="ellipsis">{q.label}</span>
                  <span className="dim ellipsis files-pc-sub">{q.path}</span>
                </span>
              </button>
            ))}
          </div>
        </>
      )}
      <div className="field-label">Drives</div>
      {drives === null ? (
        <Icon name="loader" size={16} className="files-spin dim" />
      ) : (
        <div className="files-pc-grid">
          {drives.map((d) => {
            const disk = diskFor(d);
            const used = disk && disk.total ? 1 - disk.available / disk.total : null;
            return (
              <button key={d} className={cx("files-pc-item", samePath(selectPath, d) && "selected")} onClick={() => onOpen(d)}>
                <Icon name="hard-drive" size={18} />
                <span className="files-pc-text">
                  <span className="ellipsis">
                    {disk?.name ? `${disk.name} ` : "Drive "}({d.slice(0, 2)})
                  </span>
                  {disk && used !== null ? (
                    <>
                      <span className="files-pc-bar">
                        <span className={cx(used > 0.9 && "full")} style={{ width: `${Math.round(used * 100)}%` }} />
                      </span>
                      <span className="dim files-pc-sub">
                        {formatBytes(disk.available)} free of {formatBytes(disk.total)}
                      </span>
                    </>
                  ) : (
                    <span className="dim files-pc-sub">{d}</span>
                  )}
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ── preview ─────────────────────────────────────────────────────────────

function PreviewPanel({
  path,
  version,
  tabId,
  style,
  onClose,
  onNavigate,
  onPreview,
}: {
  path: string;
  version: string;
  tabId: string;
  style: React.CSSProperties;
  onClose: () => void;
  onNavigate: (dir: string) => void;
  onPreview: (file: string) => void;
}) {
  const [st, setSt] = useState<{ path: string; data?: Preview; error?: string }>({ path });
  const [source, setSource] = useState(false);

  useEffect(() => {
    let stale = false;
    setSt((s) => (s.path === path ? s : { path }));
    ipc.fsPreview(path).then(
      (data) => !stale && setSt({ path, data }),
      (e) => !stale && setSt({ path, error: errorText(e) }),
    );
    return () => {
      stale = true;
    };
  }, [path, version]);

  const data = st.path === path ? st.data : undefined;
  const error = st.path === path ? st.error : undefined;
  const name = basename(path);
  const isMd = MD_EXT.has(extOf(name));
  const size = data && "size" in data ? data.size : undefined;

  const openDefault = () => openPath(path).catch(toastErr);

  // relative links inside a markdown preview: folders open in the list, files preview
  const followLink = async (href: string) => {
    const target = href.split("#")[0];
    if (!target) return;
    const p = normalizePath(isAbsolute(target) ? target : joinPath(dirname(path), target));
    // merely touching \\host\share makes Windows log in to that host with the user's credentials (NTLM)
    const host = uncHost(p);
    if (host && host !== uncHost(path)) {
      ui.toast(`Not following a link to the network share \\\\${host}`, "warning");
      return;
    }
    if (await ipc.fsIsDir(p).catch(() => false)) onNavigate(p);
    else onPreview(p);
  };

  let body: React.ReactNode;
  if (error) {
    body = (
      <ModuleMessage icon="warning" title="Can't preview this file">
        <p className="files-error selectable">{error}</p>
      </ModuleMessage>
    );
  } else if (!data) {
    body = (
      <div className="empty-state">
        <Icon name="loader" size={18} className="files-spin" />
      </div>
    );
  } else if (data.kind === "directory") {
    body = (
      <ModuleMessage icon="folder" title={name}>
        <div className="row">
          <button className="btn" onClick={() => onNavigate(path)}>
            Open folder
          </button>
        </div>
      </ModuleMessage>
    );
  } else if (data.kind === "image") {
    body = <ImageView src={data.dataUrl} />;
  } else if (data.kind === "binary") {
    body = (
      <div className="module-scroll files-hex-wrap">
        <div className="files-preview-note">
          <Icon name="binary" size={13} /> Binary file — first {Math.min(512, data.size)} bytes
        </div>
        <pre className="files-hex selectable">{hexDump(data.head)}</pre>
      </div>
    );
  } else {
    body = (
      <>
        {data.truncated && (
          <div className="files-preview-note">
            <Icon name="info" size={13} />
            <span className="grow">Showing the beginning of this {formatBytes(data.size)} file.</span>
            <button className="btn small subtle" onClick={openDefault}>
              Open in default app
            </button>
          </div>
        )}
        {isMd && !source ? (
          <MarkdownView text={data.text} tabId={tabId} onLink={followLink} />
        ) : (
          <TextView text={data.text} />
        )}
      </>
    );
  }

  return (
    <div className="files-preview" style={style}>
      <div className="files-preview-head">
        <Icon name={entryIcon({ name, isDir: data?.kind === "directory" })} size={14} className="dim" />
        <span className="files-preview-name ellipsis" title={path}>
          {name}
        </span>
        {size !== undefined && <span className="dim files-preview-size">{formatBytes(size)}</span>}
        <span className="grow" />
        {isMd && data?.kind === "text" && (
          <button className={cx("icon-btn", source && "on")} title={source ? "Show rendered" : "Show source"} onClick={() => setSource((s) => !s)}>
            <Icon name="code" size={14} />
          </button>
        )}
        <button className="icon-btn" title="Open with default app" onClick={openDefault}>
          <Icon name="external-link" size={14} />
        </button>
        <button className="icon-btn" title="Reveal in Explorer" onClick={() => revealItemInDir(path).catch(toastErr)}>
          <Icon name="folder-open" size={14} />
        </button>
        <button className="icon-btn" title="Copy path" onClick={() => copyText(path)}>
          <Icon name="copy" size={14} />
        </button>
        <button className="icon-btn close" title="Close preview (Esc)" onClick={onClose}>
          <Icon name="x" size={14} />
        </button>
      </div>
      <div className="files-preview-body">{body}</div>
    </div>
  );
}

function TextView({ text }: { text: string }) {
  const clean = useMemo(() => text.replace(/\r\n?/g, "\n"), [text]);
  const gutter = useMemo(() => {
    let n = 1;
    for (let i = 0; i < clean.length; i++) if (clean.charCodeAt(i) === 10) n++;
    if (clean.endsWith("\n") && n > 1) n--;
    let s = "";
    for (let i = 1; i <= n; i++) s += i === n ? `${i}` : `${i}\n`;
    return s;
  }, [clean]);
  if (!clean) return <div className="files-empty dim">Empty file</div>;
  return (
    <div className="module-scroll files-code">
      <pre className="files-gutter" aria-hidden>
        {gutter}
      </pre>
      <pre className="files-text selectable">{clean}</pre>
    </div>
  );
}

function MarkdownView({ text, tabId, onLink }: { text: string; tabId: string; onLink: (href: string) => void }) {
  // no ▶ Run buttons: any file on disk can be previewed here (a cloned repo's README…)
  const rendered = useMemo(() => renderMarkdown(text, { tasks: false, run: false }), [text]);
  return (
    <div className="module-scroll">
      <div
        className="notes-md"
        onClick={(e) => handleMarkdownClick(e, { codes: rendered.codes, tabId, onRelativeLink: onLink })}
        dangerouslySetInnerHTML={{ __html: rendered.html }}
      />
    </div>
  );
}

function ImageView({ src }: { src: string }) {
  const [dim, setDim] = useState<[number, number] | null>(null);
  const [actual, setActual] = useState(false);
  useEffect(() => {
    setDim(null);
    setActual(false);
  }, [src]);
  return (
    <div className={cx("module-scroll files-image", actual && "actual")} onClick={() => setActual((a) => !a)} title={actual ? "Click to fit" : "Click for actual size"}>
      <img src={src} alt="" draggable={false} onLoad={(e) => setDim([e.currentTarget.naturalWidth, e.currentTarget.naturalHeight])} />
      {dim && (
        <span className="files-image-dim">
          {dim[0]} × {dim[1]}
        </span>
      )}
    </div>
  );
}

function hexDump(head: string): string {
  return head
    .split("\n")
    .filter((l) => l.trim())
    .map((line, i) => {
      const bytes = line.trim().split(/\s+/);
      const left = bytes.slice(0, 8).join(" ");
      const right = bytes.slice(8, 16).join(" ");
      const ascii = bytes
        .map((b) => {
          const c = parseInt(b, 16);
          return c >= 32 && c < 127 ? String.fromCharCode(c) : "·";
        })
        .join("");
      return `${(i * 16).toString(16).padStart(8, "0")}  ${left.padEnd(23)}  ${right.padEnd(23)}  ${ascii}`;
    })
    .join("\n");
}

// ── module ──────────────────────────────────────────────────────────────

export const filesModule: ModuleDef = {
  id: "files",
  name: "Files",
  icon: "folder",
  description: "Browse and preview files; follows your terminal's folder",
  component: FilesPane,
  defaultMeta: ({ cwd }) => ({ path: cwd, follow: settings().modules.files.followTerminal }),
  title: (pane, rt) => {
    if (rt.title) return rt.title;
    const p = rt.cwd ?? (pane.meta.path as string | undefined);
    return p ? basename(p) || p : "Files";
  },
  menu: (pane: Pane): MenuItem[] => {
    const hidden = pane.meta.showHidden ?? settings().modules.files.showHidden;
    const following = pane.meta.follow !== false;
    return [
      {
        label: "Follow terminal folder",
        icon: "plug",
        checked: following,
        onSelect: () => setPaneMeta(pane.id, following ? { follow: false, path: ui.get().cwds[pane.id] ?? pane.meta.path } : { follow: true }),
      },
      { label: "Show hidden files", icon: "eye", checked: hidden, onSelect: () => setPaneMeta(pane.id, { showHidden: !hidden }) },
    ];
  },
};
