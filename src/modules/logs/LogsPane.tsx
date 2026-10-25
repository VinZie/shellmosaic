// Log viewer: `tail -f` a file with filtering, highlight rules, pause/follow and
// a virtualized line list (fixed row height, or computed wrapped heights) so
// tens of thousands of lines stay smooth.
import { Channel } from "@tauri-apps/api/core";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { useCallback, useDeferredValue, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Icon } from "../../lib/icons";
import { errorText, ipc } from "../../lib/ipc";
import { basename, cx, dirname } from "../../lib/util";
import { setPaneMeta } from "../../state/actions";
import type { Pane } from "../../state/model";
import { settings, useSettings, type HighlightRule } from "../../state/settings";
import { ui, type MenuItem } from "../../state/ui";
import { ModuleMessage, SearchBox } from "../common";
import type { ModuleDef, ModuleProps } from "../registry";
import "./logs.css";

const ROW_H = 18;
const OVERSCAN = 24;
const TAIL_BYTES = 256 * 1024;
const MAX_HIGHLIGHT_LEN = 4000;
const RECENT_KEY = "shellmosaic.logs.recent";

type LogEvent = { t: string; lines?: string[] };
type FilterMode = "filter" | "highlight";

// ── helpers ─────────────────────────────────────────────────────────────

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g;
// eslint-disable-next-line no-control-regex
const CTRL_RE = /[\x00-\x08\x0b-\x1f\x7f]/g;
const cleanLine = (l: string) => l.replace(ANSI_RE, "").replace(/\t/g, "    ").replace(CTRL_RE, "");
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function recentFiles(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]");
    return Array.isArray(v) ? v.filter((x) => typeof x === "string").slice(0, 8) : [];
  } catch {
    return [];
  }
}
function rememberFile(p: string) {
  try {
    const list = [p, ...recentFiles().filter((x) => x.toLowerCase() !== p.toLowerCase())].slice(0, 8);
    localStorage.setItem(RECENT_KEY, JSON.stringify(list));
  } catch {
    /* storage unavailable */
  }
}

async function pickLogFile(current?: string): Promise<string | null> {
  const f = await openDialog({
    multiple: false,
    directory: false,
    title: "Open log file",
    defaultPath: current ? dirname(current) : undefined,
    filters: [
      { name: "Log files", extensions: ["log", "txt", "out", "err", "jsonl", "ndjson", "csv", "trace"] },
      { name: "All files", extensions: ["*"] },
    ],
  });
  if (!f || Array.isArray(f)) return null;
  return f;
}

/** Drop a leading timestamp / level bracket so "filter by this line" matches similar lines. */
function lineMessage(line: string): string {
  const rest = line
    .replace(/^[\s[(]*\d{2,4}[-/.]\d{1,2}[-/.]\d{1,4}[T\s]*[\d:.,]*\s*(Z|[+-]\d{2}:?\d{2})?[\])]?\s*/, "")
    .replace(/^[\s[(]*\d{1,2}:\d{2}:\d{2}[.,\d]*[\])]?\s*/, "")
    .trim();
  return (rest || line.trim()).slice(0, 120);
}

interface Rule {
  re: RegExp;
  color: string;
}

function compileRules(list: HighlightRule[]): Rule[] {
  return list.flatMap((h) => {
    if (!h?.pattern) return [];
    try {
      return [{ re: new RegExp(h.regex ? h.pattern : escapeRe(h.pattern), "gi"), color: h.color }];
    } catch {
      return [];
    }
  });
}

/** Split a line into colored spans: highlight rules color text, search hits get a background. */
function renderSegments(text: string, rules: Rule[], search: RegExp | null): ReactNode {
  const n = text.length;
  if (!n || n > MAX_HIGHLIGHT_LEN || (!rules.length && !search)) return text;
  const color = new Int16Array(n).fill(-1);
  // earlier rules win, so paint them last
  for (let r = rules.length - 1; r >= 0; r--) {
    const re = rules[r].re;
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      if (!m[0]) {
        re.lastIndex++;
        continue;
      }
      color.fill(r, m.index, m.index + m[0].length);
    }
  }
  let hit: Uint8Array | null = null;
  if (search) {
    hit = new Uint8Array(n);
    search.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = search.exec(text))) {
      if (!m[0]) {
        search.lastIndex++;
        continue;
      }
      hit.fill(1, m.index, m.index + m[0].length);
    }
  }
  const out: ReactNode[] = [];
  let start = 0;
  for (let i = 1; i <= n; i++) {
    if (i < n && color[i] === color[start] && (!hit || hit[i] === hit[start])) continue;
    const seg = text.slice(start, i);
    const c = color[start];
    const h = hit?.[start];
    if (c < 0 && !h) out.push(seg);
    else
      out.push(
        <span key={start} className={h ? "logs-hit" : undefined} style={c >= 0 ? { color: rules[c].color } : undefined}>
          {seg}
        </span>,
      );
    start = i;
  }
  return out;
}

/** Visual rows a line of `len` characters takes when wrapped at `cols`. */
const rowsFor = (len: number, cols: number) => Math.max(1, Math.ceil(len / cols));

/** First index i with offs[i + 1] > y (offs is a prefix sum in rows). */
function findRow(offs: Int32Array, count: number, yRows: number): number {
  let lo = 0;
  let hi = count;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (offs[mid + 1] > yRows) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

// ── buffer ──────────────────────────────────────────────────────────────

interface Buffer {
  lines: string[];
  /** lines removed from the front (cleared or over maxLines); keeps line numbers stable */
  dropped: number;
  /** lines that arrived while paused */
  pending: string[];
  /** paused lines discarded (over maxLines) before they were shown; they still count for numbering */
  pendingDropped: number;
}

interface MatchCache {
  key: string;
  /** absolute line numbers (dropped + index) of matching lines */
  abs: number[];
  /** how many buffered lines have been tested (absolute end) */
  end: number;
}

// ── pane ────────────────────────────────────────────────────────────────

function LogsPane({ pane, visible, focused }: ModuleProps) {
  const path: string | undefined = pane.meta.path || undefined;
  const wrap = !!pane.meta.wrap;
  const lineNumbers = pane.meta.lineNumbers !== false;
  const filterMode: FilterMode = pane.meta.filterMode === "highlight" ? "highlight" : "filter";
  const highlightSettings = useSettings((s) => s.settings.modules.logs.highlights);
  const rules = useMemo(() => compileRules(highlightSettings), [highlightSettings]);

  const rootRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const buf = useRef<Buffer>({ lines: [], dropped: 0, pending: [], pendingDropped: 0 }).current;
  const matchCache = useRef<MatchCache | null>(null);

  const [version, setVersion] = useState(0);
  const [status, setStatus] = useState<"idle" | "opening" | "live" | "error">("idle");
  const [error, setError] = useState<string | null>(null);
  const [reopen, setReopen] = useState(0);
  const [paused, setPaused] = useState(false);
  const [pendingCount, setPendingCount] = useState(0);
  const [follow, setFollow] = useState(true);
  const [atBottom, setAtBottom] = useState(true);
  const [query, setQuery] = useState("");
  const [regex, setRegex] = useState(false);
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [scrollTop, setScrollTop] = useState(0);
  const [box, setBox] = useState({ w: 600, h: 300 });
  const [charW, setCharW] = useState(7.2);

  const visibleRef = useRef(visible);
  visibleRef.current = visible;
  const pausedRef = useRef(paused);
  pausedRef.current = paused;
  const followRef = useRef(follow);
  followRef.current = follow;
  const lastTop = useRef(0);
  const lastScrollH = useRef(0);
  const anchorAdjust = useRef(0);
  const stale = useRef(false);
  const frame = useRef(0);

  // ── re-render scheduling: at most once per frame, and only while on screen ──
  const bump = useCallback(() => {
    if (!visibleRef.current) {
      stale.current = true;
      return;
    }
    if (frame.current) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = 0;
      setVersion((v) => v + 1);
    });
  }, []);
  useEffect(() => () => cancelAnimationFrame(frame.current), []);
  useEffect(() => {
    if (visible && stale.current) {
      stale.current = false;
      setVersion((v) => v + 1);
    }
  }, [visible]);

  // ── filter ──
  const deferredQuery = useDeferredValue(query);
  const matcher = useMemo(() => {
    if (!deferredQuery) return null;
    try {
      const src = regex ? deferredQuery : escapeRe(deferredQuery);
      const flags = caseSensitive ? "" : "i";
      return { test: new RegExp(src, flags), global: new RegExp(src, flags + "g"), key: `${regex}|${caseSensitive}|${deferredQuery}`, error: null };
    } catch (e) {
      return { test: null, global: null, key: "", error: errorText(e) };
    }
  }, [deferredQuery, regex, caseSensitive]);
  const activeMatcher = matcher?.test ? matcher : null;

  // ── layout metrics (elements mount only once a file is open, hence callback refs) ──
  const setMeasureEl = useCallback((el: HTMLSpanElement | null) => {
    if (!el) return;
    const measure = () => {
      const w = el.getBoundingClientRect().width;
      if (w) setCharW(w / 20);
    };
    measure();
    document.fonts?.ready.then(measure).catch(() => {});
  }, []);
  const scrollObserver = useRef<ResizeObserver | null>(null);
  const setScrollEl = useCallback((el: HTMLDivElement | null) => {
    scrollRef.current = el;
    scrollObserver.current?.disconnect();
    scrollObserver.current = null;
    if (!el) return;
    const update = () => {
      if (el.clientWidth && el.clientHeight) setBox((b) => (b.w === el.clientWidth && b.h === el.clientHeight ? b : { w: el.clientWidth, h: el.clientHeight }));
    };
    const ro = new ResizeObserver(update);
    ro.observe(el);
    scrollObserver.current = ro;
    update();
  }, []);
  useEffect(() => () => scrollObserver.current?.disconnect(), []);

  const digits = String(Math.max(1, buf.dropped + buf.lines.length)).length;
  const gutterW = lineNumbers ? Math.ceil(Math.max(3, digits) * charW + 18) : 0;
  const TEXT_PAD = 10 + 12; // .logs-text left + right padding
  const cols = Math.max(8, Math.floor((box.w - gutterW - TEXT_PAD - 0.5) / charW));
  const metrics = useRef({ cols, wrap });
  metrics.current = { cols, wrap };

  // ── appending ──
  const matcherRef = useRef(activeMatcher);
  matcherRef.current = activeMatcher;
  const modeRef = useRef(filterMode);
  modeRef.current = filterMode;

  const append = useCallback(
    (incoming: string[]) => {
      if (!incoming.length) return;
      for (const l of incoming) buf.lines.push(l);
      const max = Math.max(1000, settings().modules.logs.maxLines || 20000);
      const over = buf.lines.length - max;
      if (over > 0) {
        const removed = buf.lines.splice(0, over);
        buf.dropped += over;
        // keep the viewport steady when old lines fall off the top
        if (!followRef.current) {
          const m = matcherRef.current;
          const shown = m && modeRef.current === "filter" ? removed.filter((l) => m.test.test(l)) : removed;
          const { cols: c, wrap: w } = metrics.current;
          anchorAdjust.current += (w ? shown.reduce((h, l) => h + rowsFor(l.length, c), 0) : shown.length) * ROW_H;
        }
      }
      bump();
    },
    [buf, bump],
  );

  // ── streaming ──
  useEffect(() => {
    if (!path) {
      setStatus("idle");
      return;
    }
    buf.lines = [];
    buf.dropped = 0;
    buf.pending = [];
    buf.pendingDropped = 0;
    matchCache.current = null;
    setPendingCount(0);
    setError(null);
    setStatus("opening");
    setFollow(true);
    lastTop.current = 0;
    bump();

    let id: number | null = null;
    let closed = false;
    const channel = new Channel<LogEvent>();
    channel.onmessage = (msg) => {
      if (closed) return;
      if (msg.t === "reset") {
        // truncated or rotated: the file starts over, and so does the numbering
        buf.dropped = 0;
        buf.lines = [];
        matchCache.current = null;
        buf.pending = [];
        buf.pendingDropped = 0;
        setPendingCount(0);
        lastTop.current = 0;
        bump();
        return;
      }
      if (msg.t !== "lines" || !msg.lines?.length) return;
      const incoming = msg.lines.map(cleanLine);
      if (pausedRef.current) {
        for (const l of incoming) buf.pending.push(l);
        const max = Math.max(1000, settings().modules.logs.maxLines || 20000);
        const over = buf.pending.length - max;
        if (over > 0) {
          buf.pending.splice(0, over);
          buf.pendingDropped += over;
        }
        setPendingCount(buf.pending.length);
      } else append(incoming);
    };
    ipc
      .logOpen(path, channel, TAIL_BYTES)
      .then((i) => {
        if (closed) ipc.logClose(i).catch(() => {});
        else {
          id = i;
          setStatus("live");
          rememberFile(path);
        }
      })
      .catch((e) => {
        if (closed) return;
        setError(errorText(e));
        setStatus("error");
      });
    return () => {
      closed = true;
      channel.onmessage = () => {};
      if (id !== null) ipc.logClose(id).catch(() => {});
    };
  }, [path, reopen, buf, append, bump]);

  // ── matching (incremental: only new lines are tested while tailing) ──
  // `version` stands in for the mutable buffer in the deps below.
  const view = useMemo(() => {
    const lines = buf.lines;
    const total = lines.length;
    let abs: number[] | null = null;
    if (activeMatcher) {
      const key = activeMatcher.key;
      let cache = matchCache.current;
      const firstAbs = buf.dropped;
      const endAbs = buf.dropped + total;
      if (!cache || cache.key !== key || cache.end > endAbs || cache.end < firstAbs) {
        cache = { key, abs: [], end: firstAbs };
      }
      // forget matches that fell off the front
      let cut = 0;
      while (cut < cache.abs.length && cache.abs[cut] < firstAbs) cut++;
      if (cut) cache.abs = cache.abs.slice(cut);
      const re = activeMatcher.test;
      for (let a = Math.max(cache.end, firstAbs); a < endAbs; a++) if (re.test(lines[a - firstAbs])) cache.abs.push(a);
      cache.end = endAbs;
      matchCache.current = cache;
      abs = cache.abs;
    } else matchCache.current = null;
    const filtering = !!abs && filterMode === "filter";
    const count = filtering ? abs!.length : total;
    const lineAt = (i: number) => (filtering ? abs![i] - buf.dropped : i);

    let offs: Int32Array | null = null;
    let maxLen = 0;
    if (wrap) {
      offs = new Int32Array(count + 1);
      for (let i = 0; i < count; i++) offs[i + 1] = offs[i] + rowsFor(lines[lineAt(i)].length, cols);
    } else {
      for (let i = 0; i < count; i++) {
        const len = lines[lineAt(i)].length;
        if (len > maxLen) maxLen = len;
      }
    }
    return { version, total, count, matches: abs ? abs.length : 0, lineAt, offs, maxLen, filtering };
  }, [version, activeMatcher, filterMode, wrap, cols, buf]);

  const totalH = view.offs ? view.offs[view.count] * ROW_H : view.count * ROW_H;

  // ── scrolling ──
  const scrollToBottom = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    lastTop.current = el.scrollTop;
  }, []);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (followRef.current) {
      anchorAdjust.current = 0;
      scrollToBottom();
    } else if (anchorAdjust.current) {
      el.scrollTop = Math.max(0, el.scrollTop - anchorAdjust.current);
      anchorAdjust.current = 0;
      lastTop.current = el.scrollTop;
    }
    lastScrollH.current = el.scrollHeight;
    setScrollTop(el.scrollTop);
    setAtBottom(el.scrollHeight - el.scrollTop - el.clientHeight < ROW_H);
  }, [view, follow, box.h, scrollToBottom]);

  const onScroll = (e: React.UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    setScrollTop(el.scrollTop);
    const bottom = el.scrollHeight - el.scrollTop - el.clientHeight < ROW_H;
    setAtBottom(bottom);
    // scrolled up by the user (not because the content changed) → stop following
    if (el.scrollHeight === lastScrollH.current && el.scrollTop < lastTop.current - 1 && followRef.current && !bottom) setFollow(false);
    lastScrollH.current = el.scrollHeight;
    lastTop.current = el.scrollTop;
  };

  const jumpToBottom = () => {
    setFollow(true);
    requestAnimationFrame(scrollToBottom);
  };

  // ── pause / resume ──
  const togglePause = () => {
    if (paused) {
      const pending = buf.pending;
      buf.pending = [];
      if (buf.pendingDropped) {
        // lines were lost between the shown ones and `pending`: drop the old ones so numbering stays true
        buf.dropped += buf.lines.length + buf.pendingDropped;
        buf.lines = [];
        buf.pendingDropped = 0;
      }
      setPendingCount(0);
      setPaused(false);
      pausedRef.current = false;
      append(pending);
    } else setPaused(true);
  };

  const clear = () => {
    // lines waiting while paused are cleared too, but still count for numbering
    buf.dropped += buf.lines.length + buf.pending.length + buf.pendingDropped;
    buf.lines = [];
    buf.pending = [];
    buf.pendingDropped = 0;
    setPendingCount(0);
    lastTop.current = 0;
    setFollow(true);
    bump();
  };

  const openFile = (p: string) => {
    if (p === path) setReopen((n) => n + 1);
    else setPaneMeta(pane.id, { path: p });
  };
  const pickAndOpen = async () => {
    try {
      const p = await pickLogFile(path);
      if (p) openFile(p);
    } catch (e) {
      ui.toast(errorText(e), "error");
    }
  };

  const setMeta = (patch: Record<string, unknown>) => setPaneMeta(pane.id, patch);
  const toggleWrap = () => setMeta({ wrap: !wrap });
  const toggleLineNumbers = () => setMeta({ lineNumbers: !lineNumbers });
  const setFilterMode = (m: FilterMode) => setMeta({ filterMode: m });

  const applyFilter = (text: string, mode: FilterMode = "filter") => {
    setRegex(false);
    setQuery(text);
    if (mode !== filterMode) setFilterMode(mode);
  };

  const shownLines = (): string[] => {
    const out: string[] = [];
    for (let i = 0; i < view.count; i++) out.push(buf.lines[view.lineAt(i)]);
    return out;
  };

  const copy = (text: string, what = "Copied") =>
    writeText(text)
      .then(() => ui.toast(what, "success", 1500))
      .catch((e) => ui.toast(errorText(e), "error"));

  /** `line`: the row's text as rendered (by now the buffer may have shifted under it) */
  const onRowMenu = (e: React.MouseEvent, line: string) => {
    e.preventDefault();
    e.stopPropagation();
    const sel = (window.getSelection()?.toString() ?? "").trim();
    const short = (s: string) => (s.length > 32 ? s.slice(0, 31) + "…" : s);
    const msg = lineMessage(line);
    const items: MenuItem[] = [
      ...(sel ? [{ label: "Copy selection", icon: "copy", onSelect: () => copy(sel) } as MenuItem] : []),
      { label: "Copy line", icon: "copy", onSelect: () => copy(line, "Line copied") },
      {
        label: `Copy all shown lines`,
        icon: "clipboard-copy",
        hint: view.count.toLocaleString(),
        onSelect: () => copy(shownLines().join("\n"), `${view.count.toLocaleString()} lines copied`),
      },
      { type: "separator" },
      ...(sel
        ? [
            { label: `Filter by “${short(sel)}”`, icon: "filter", onSelect: () => applyFilter(sel, "filter") } as MenuItem,
            { label: `Highlight “${short(sel)}”`, icon: "search", onSelect: () => applyFilter(sel, "highlight") } as MenuItem,
          ]
        : []),
      ...(msg ? [{ label: `Filter by this line's text`, icon: "filter", hint: short(msg), onSelect: () => applyFilter(msg, "filter") } as MenuItem] : []),
      ...(query ? [{ label: "Clear filter", icon: "x", onSelect: () => setQuery("") } as MenuItem] : []),
    ];
    ui.openMenu(e, items);
  };

  const focusFilter = () => rootRef.current?.querySelector<HTMLInputElement>(".logs-filter input")?.focus();

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.defaultPrevented) return;
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "f") {
      e.preventDefault();
      focusFilter();
      return;
    }
    // the rest only applies while the log itself has focus (not buttons or the filter box)
    if (e.target !== scrollRef.current) return;
    if (e.key === "End" && (e.ctrlKey || !e.shiftKey)) {
      e.preventDefault();
      jumpToBottom();
    } else if (e.key === "Home") {
      e.preventDefault();
      setFollow(false);
      if (scrollRef.current) scrollRef.current.scrollTop = 0;
    } else if (e.key === "PageUp" || e.key === "ArrowUp") {
      setFollow(false);
    } else if (e.key === " " && !e.ctrlKey && !e.altKey) {
      e.preventDefault();
      togglePause();
    }
  };

  // focus the log when the pane is focused, so keys work right away
  useEffect(() => {
    if (!focused || !visible) return;
    const active = document.activeElement;
    if (active && rootRef.current?.contains(active)) return;
    if (ui.get().dialog || ui.get().palette.open) return;
    scrollRef.current?.focus({ preventScroll: true });
  }, [focused, visible]);

  // ── render ──
  const width = box.w;
  const compact = width < 640;

  if (!path) return <EmptyState onPick={pickAndOpen} onOpen={openFile} />;

  const name = basename(path);
  // matches are marked in both modes ("only matching" shows where the line matched)
  const search = activeMatcher?.global ?? null;

  // visible window
  let first: number;
  let last: number;
  if (view.offs) {
    first = Math.max(0, findRow(view.offs, view.count, scrollTop / ROW_H) - OVERSCAN);
    last = Math.min(view.count, findRow(view.offs, view.count, (scrollTop + box.h) / ROW_H) + 1 + OVERSCAN);
  } else {
    first = Math.max(0, Math.floor(scrollTop / ROW_H) - OVERSCAN);
    last = Math.min(view.count, Math.ceil((scrollTop + box.h) / ROW_H) + OVERSCAN);
  }
  const sizerW = view.offs ? undefined : Math.ceil(gutterW + view.maxLen * charW + TEXT_PAD + 4);

  const rowsOut: ReactNode[] = [];
  for (let i = first; i < last; i++) {
    const li = view.lineAt(i);
    const text = buf.lines[li];
    if (text === undefined) continue;
    const top = view.offs ? view.offs[i] * ROW_H : i * ROW_H;
    const h = view.offs ? (view.offs[i + 1] - view.offs[i]) * ROW_H : ROW_H;
    rowsOut.push(
      <div key={buf.dropped + li} className="logs-row" style={{ top, height: h }} onContextMenu={(e) => onRowMenu(e, text)}>
        {lineNumbers && (
          <span className="logs-ln" style={{ width: gutterW }}>
            {buf.dropped + li + 1}
          </span>
        )}
        <span className="logs-text">{renderSegments(text, rules, search)}</span>
      </div>,
    );
  }

  const fileMenu: MenuItem[] = [
    { label: "Open another file…", icon: "folder-open", onSelect: pickAndOpen },
    { label: "Reopen", icon: "refresh", hint: "re-read the tail", onSelect: () => setReopen((n) => n + 1) },
    { label: "Reveal in Explorer", icon: "external-link", onSelect: () => revealItemInDir(path).catch((e) => ui.toast(errorText(e), "error")) },
    { label: "Copy file path", icon: "copy", onSelect: () => copy(path, "Path copied") },
  ];
  const secondary: MenuItem[] = [
    { label: "Wrap long lines", icon: "wrap", checked: wrap, onSelect: toggleWrap },
    { label: "Line numbers", icon: "hash", checked: lineNumbers, onSelect: toggleLineNumbers },
    { type: "separator" },
    { label: "Clear", icon: "eraser", onSelect: clear },
    { type: "separator" },
    ...fileMenu,
  ];

  return (
    <div className={cx("module logs", wrap && "logs-wrap")} ref={rootRef} onKeyDown={onKeyDown}>
      <span className="logs-measure" ref={setMeasureEl} aria-hidden>
        MMMMMMMMMMMMMMMMMMMM
      </span>
      <div className="toolbar logs-toolbar">
        <button
          className="logs-file"
          title={`${path}\nClick for file actions`}
          onClick={(e) => {
            const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
            ui.openMenu({ x: r.left, y: r.bottom + 4 }, fileMenu);
          }}
        >
          <Icon name="scroll" size={13} />
          <span className="ellipsis">{name}</span>
          <span className={cx("logs-dot", status === "live" && !paused && "live", paused && "paused", status === "error" && "error")} />
        </button>
        <button className={cx("icon-btn", paused && "on")} title={paused ? "Resume (Space)" : "Pause (Space)"} onClick={togglePause}>
          <Icon name={paused ? "play" : "pause"} size={14} />
        </button>
        {paused && pendingCount > 0 && (
          <button className="chip accent logs-new" title="Resume to show them" onClick={togglePause}>
            {pendingCount.toLocaleString()} new
          </button>
        )}
        <button
          className={cx("icon-btn", follow && "on")}
          title={follow ? "Following the end of the file (scroll up to stop)" : "Follow the end of the file (End)"}
          onClick={() => (follow ? setFollow(false) : jumpToBottom())}
        >
          <Icon name="scroll-bottom" size={14} />
        </button>
        <div className="toolbar-sep" />
        <div className={cx("logs-filter", matcher?.error && "invalid")} title={matcher?.error ?? undefined}>
          <SearchBox value={query} onChange={setQuery} placeholder={regex ? "Regex filter" : "Filter"} />
        </div>
        <button className={cx("icon-btn", regex && "on")} title="Regular expression" onClick={() => setRegex((r) => !r)}>
          <Icon name="regex" size={14} />
        </button>
        <button className={cx("icon-btn", caseSensitive && "on")} title="Match case" onClick={() => setCaseSensitive((c) => !c)}>
          <Icon name="case-sensitive" size={14} />
        </button>
        {compact ? (
          <button
            className={cx("icon-btn", filterMode === "filter" && "on")}
            title={filterMode === "filter" ? "Showing only matching lines (click to highlight instead)" : "Highlighting matches (click to show only matching lines)"}
            onClick={() => setFilterMode(filterMode === "filter" ? "highlight" : "filter")}
          >
            <Icon name="filter" size={14} />
          </button>
        ) : (
          <div className="segmented logs-mode">
            <button className={cx(filterMode === "filter" && "on")} title="Show only matching lines" onClick={() => setFilterMode("filter")}>
              Only matching
            </button>
            <button className={cx(filterMode === "highlight" && "on")} title="Show every line, highlight matches" onClick={() => setFilterMode("highlight")}>
              Highlight
            </button>
          </div>
        )}
        <div className="grow" />
        {compact ? (
          <button
            className="icon-btn"
            title="More"
            onClick={(e) => {
              const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
              ui.openMenu({ x: r.left, y: r.bottom + 4 }, secondary);
            }}
          >
            <Icon name="ellipsis" size={15} />
          </button>
        ) : (
          <>
            <button className={cx("icon-btn", wrap && "on")} title="Wrap long lines" onClick={toggleWrap}>
              <Icon name="wrap" size={14} />
            </button>
            <button className={cx("icon-btn", lineNumbers && "on")} title="Line numbers" onClick={toggleLineNumbers}>
              <Icon name="hash" size={14} />
            </button>
            <button className="icon-btn" title="Clear the view (the file is untouched)" onClick={clear}>
              <Icon name="eraser" size={14} />
            </button>
            <div className="toolbar-sep" />
            <button className="icon-btn" title="Open another file…" onClick={pickAndOpen}>
              <Icon name="folder-open" size={14} />
            </button>
            <button className="icon-btn" title="Reveal in Explorer" onClick={() => revealItemInDir(path).catch((e) => ui.toast(errorText(e), "error"))}>
              <Icon name="external-link" size={14} />
            </button>
          </>
        )}
      </div>

      {status === "error" ? (
        <ModuleMessage icon="warning" title={`Can't open ${name}`}>
          <p className="logs-error selectable">{error}</p>
          <div className="row">
            <button className="btn" onClick={() => setReopen((n) => n + 1)}>
              <Icon name="refresh" size={13} /> Retry
            </button>
            <button className="btn subtle" onClick={pickAndOpen}>
              <Icon name="folder-open" size={13} /> Open another file…
            </button>
          </div>
        </ModuleMessage>
      ) : (
        <div className="logs-body">
          <div
            ref={setScrollEl}
            className="logs-scroll"
            tabIndex={0}
            onScroll={onScroll}
            onWheel={(e) => {
              const el = e.currentTarget;
              if (e.deltaY < 0 && followRef.current && el.scrollHeight > el.clientHeight && el.scrollTop > 0) setFollow(false);
            }}
          >
            <div className="logs-sizer" style={{ height: Math.max(totalH, 1), width: sizerW, minWidth: "100%" }}>
              {rowsOut}
            </div>
            {view.count === 0 && (
              <div className="logs-empty dim">
                {status === "opening"
                  ? "Opening…"
                  : view.filtering
                    ? `No lines match “${deferredQuery}”`
                    : view.total === 0 && buf.dropped === 0
                      ? "Waiting for lines…"
                      : "Cleared — new lines will appear here"}
              </div>
            )}
          </div>
          {!atBottom && view.count > 0 && (
            <button className="btn small logs-jump" onClick={jumpToBottom} title="Jump to the end and follow (End)">
              <Icon name="scroll-bottom" size={13} /> {follow ? "Bottom" : "Follow"}
            </button>
          )}
        </div>
      )}

      <div className="module-footer logs-footer">
        <span>
          {view.total.toLocaleString()} {view.total === 1 ? "line" : "lines"}
        </span>
        {activeMatcher && (
          <span className={cx(view.matches ? "logs-footer-match" : "dim")}>
            {view.matches.toLocaleString()} matching
          </span>
        )}
        {buf.dropped > 0 && (
          <span className="dim" title={`Only the last ${settings().modules.logs.maxLines.toLocaleString()} lines are kept (Settings → Modules)`}>
            {buf.dropped.toLocaleString()} earlier hidden
          </span>
        )}
        <span className="grow" />
        {paused ? (
          <span className="logs-footer-paused">
            <Icon name="pause" size={11} /> Paused{pendingCount ? ` · ${pendingCount.toLocaleString()} new` : ""}
          </span>
        ) : status === "live" ? (
          <span className={cx(follow ? "logs-footer-live" : "dim")}>{follow ? "Live · following" : "Live"}</span>
        ) : status === "opening" ? (
          <span className="dim">Opening…</span>
        ) : null}
      </div>
    </div>
  );
}

function EmptyState({ onPick, onOpen }: { onPick: () => void; onOpen: (p: string) => void }) {
  const [recent] = useState(recentFiles);
  return (
    <div className="module logs">
      <ModuleMessage icon="scroll" title="Tail a log file">
        <p>Follow a file as it grows — filter, highlight and pause without losing lines.</p>
        <div className="row">
          <button className="btn primary" onClick={onPick}>
            <Icon name="folder-open" size={14} /> Open log file…
          </button>
        </div>
        {recent.length > 0 && (
          <div className="logs-recent">
            <div className="field-label">Recent</div>
            {recent.map((p) => (
              <button key={p} className="list-row logs-recent-row" title={p} onClick={() => onOpen(p)}>
                <Icon name="scroll" size={13} className="dim" />
                <span className="ellipsis">{basename(p)}</span>
                <span className="dim ellipsis logs-recent-dir">{dirname(p)}</span>
              </button>
            ))}
          </div>
        )}
      </ModuleMessage>
    </div>
  );
}

export const logsModule: ModuleDef = {
  id: "logs",
  name: "Logs",
  icon: "scroll",
  description: "Tail a log file live, with filters and highlighting",
  component: LogsPane,
  title: (pane: Pane) => (pane.meta.path ? basename(pane.meta.path) : "Logs"),
  menu: (pane: Pane): MenuItem[] => [
    {
      label: "Open log file…",
      icon: "folder-open",
      onSelect: async () => {
        try {
          const p = await pickLogFile(pane.meta.path);
          if (p) setPaneMeta(pane.id, { path: p });
        } catch (e) {
          ui.toast(errorText(e), "error");
        }
      },
    },
    {
      label: "Reveal in Explorer",
      icon: "external-link",
      disabled: !pane.meta.path,
      onSelect: () => pane.meta.path && revealItemInDir(pane.meta.path).catch((e) => ui.toast(errorText(e), "error")),
    },
  ],
};
