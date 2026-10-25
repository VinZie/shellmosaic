// The log list: Favorites, Windows Logs, and Applications and Services Logs grouped by provider.
import { useMemo, useRef, useState, type ReactNode } from "react";
import { ChevronDown, ChevronRight, Copy, ExternalLink, Pin, PinOff, ScrollText, Star } from "lucide-react";
import { copy, cx, formatNumber, natural, openMenu, SearchBox, Switch, type EventChannel } from "../../shared";

export const WINDOWS_LOGS = ["Application", "Security", "Setup", "System", "ForwardedEvents"];
const WINDOWS_LABELS: Record<string, string> = { ForwardedEvents: "Forwarded Events" };

export const DEFAULT_FAVORITES = [
  "Application",
  "System",
  "Security",
  "Microsoft-Windows-Sysmon/Operational",
  "Microsoft-Windows-PowerShell/Operational",
  "Windows PowerShell",
  "Microsoft-Windows-Windows Defender/Operational",
  "Microsoft-Windows-TaskScheduler/Operational",
];

export const DEFAULT_EXPANDED = ["§fav", "§win", "§apps"];

/** "Microsoft-Windows-Sysmon/Operational" → "Sysmon/Operational" */
export function shortLogName(name: string): string {
  if (WINDOWS_LABELS[name]) return WINDOWS_LABELS[name];
  return name.startsWith("Microsoft-Windows-") ? name.slice(18) : name;
}

export function isListed(ch: EventChannel, showAll: boolean): boolean {
  return showAll || (ch.enabled && ch.kind !== "analytic" && ch.kind !== "debug");
}

type Node = { type: "folder"; id: string; label: string; title: string; children: Node[] } | { type: "log"; ch: EventChannel; label: string };

function sortNodes(nodes: Node[]) {
  nodes.sort((a, b) => natural(a.label, b.label));
  for (const n of nodes) if (n.type === "folder") sortNodes(n.children);
}

function buildApps(chs: EventChannel[]): Node[] {
  const top: Node[] = [];
  const msw: Node & { type: "folder" } = { type: "folder", id: "p:Microsoft-Windows", label: "Microsoft-Windows", title: "Microsoft-Windows-*", children: [] };
  const groups = new Map<string, Node & { type: "folder" }>();
  for (const ch of chs) {
    const slash = ch.name.indexOf("/");
    const isMsw = ch.name.startsWith("Microsoft-Windows-");
    if (slash < 0) {
      (isMsw ? msw.children : top).push({ type: "log", ch, label: isMsw ? ch.name.slice(18) : ch.name });
      continue;
    }
    const provider = ch.name.slice(0, slash);
    let g = groups.get(provider);
    if (!g) {
      g = { type: "folder", id: `p:${provider}`, label: isMsw ? provider.slice(18) : provider, title: provider, children: [] };
      groups.set(provider, g);
      (isMsw ? msw.children : top).push(g);
    }
    g.children.push({ type: "log", ch, label: ch.name.slice(slash + 1) });
  }
  if (msw.children.length) top.push(msw);
  sortNodes(top);
  return top;
}

type Row =
  | { type: "section"; id: string; label: string; count: number; open: boolean }
  | { type: "folder"; id: string; label: string; title: string; depth: number; open: boolean; count: number }
  | { type: "log"; ch: EventChannel; label: string; depth: number; fav?: boolean };

function countLogs(n: Node): number {
  return n.type === "log" ? 1 : n.children.reduce((a, c) => a + countLogs(c), 0);
}

export interface LogListProps {
  channels: EventChannel[] | null;
  error: string | null;
  selected: string;
  onSelect: (name: string) => void;
  favorites: string[];
  onTogglePin: (name: string) => void;
  showAll: boolean;
  onShowAll: (v: boolean) => void;
  expanded: string[];
  onExpanded: (ids: string[]) => void;
  /** the selected log's record count */
  records: number | null;
  onOpenInPane: (name: string) => void;
  autoFocus?: boolean;
  className?: string;
}

export function LogList(p: LogListProps) {
  const [search, setSearch] = useState("");
  const listRef = useRef<HTMLDivElement>(null);
  /** position of the row the keyboard moves from (a log can be listed twice: Favorites and its own place) */
  const [at, setAt] = useState(-1);
  const q = search.trim().toLowerCase();
  const searching = !!q;

  const { rows, logs, hidden } = useMemo(() => {
    const all = p.channels ?? [];
    const byName = new Map(all.map((c) => [c.name, c]));
    const match = (c: EventChannel) => !q || c.name.toLowerCase().includes(q) || shortLogName(c.name).toLowerCase().includes(q);
    const open = new Set(p.expanded);
    const isOpen = (id: string) => searching || open.has(id);
    const out: Row[] = [];

    const favs = p.favorites.map((n) => byName.get(n)).filter((c): c is EventChannel => !!c && match(c));
    if (favs.length || !searching) {
      out.push({ type: "section", id: "§fav", label: "Favorites", count: favs.length, open: isOpen("§fav") });
      if (isOpen("§fav")) for (const ch of favs) out.push({ type: "log", ch, label: shortLogName(ch.name), depth: 0, fav: true });
    }

    const win = WINDOWS_LOGS.map((n) => byName.get(n)).filter((c): c is EventChannel => !!c && match(c));
    if (win.length) {
      out.push({ type: "section", id: "§win", label: "Windows Logs", count: win.length, open: isOpen("§win") });
      if (isOpen("§win")) for (const ch of win) out.push({ type: "log", ch, label: shortLogName(ch.name), depth: 0 });
    }

    const listed = all.filter((c) => !WINDOWS_LOGS.includes(c.name) && isListed(c, p.showAll));
    const apps = buildApps(listed.filter(match));
    const appCount = apps.reduce((a, n) => a + countLogs(n), 0);
    if (appCount || !searching) {
      out.push({ type: "section", id: "§apps", label: "Applications and Services Logs", count: appCount, open: isOpen("§apps") });
      const walk = (nodes: Node[], depth: number) => {
        for (const n of nodes) {
          if (n.type === "log") out.push({ type: "log", ch: n.ch, label: n.label, depth });
          else {
            const o = isOpen(n.id);
            out.push({ type: "folder", id: n.id, label: n.label, title: n.title, depth, open: o, count: countLogs(n) });
            if (o) walk(n.children, depth + 1);
          }
        }
      };
      if (isOpen("§apps")) walk(apps, 0);
    }
    const shownCount = WINDOWS_LOGS.filter((n) => byName.has(n)).length + listed.length;
    return { rows: out, logs: out.filter((r): r is Row & { type: "log" } => r.type === "log"), hidden: all.length - shownCount };
  }, [p.channels, p.favorites, p.expanded, p.showAll, q, searching]);

  const toggle = (id: string) => {
    if (searching) return;
    p.onExpanded(p.expanded.includes(id) ? p.expanded.filter((x) => x !== id) : [...p.expanded, id]);
  };

  const menu = (e: React.MouseEvent, ch: EventChannel) => {
    e.preventDefault();
    const pinned = p.favorites.includes(ch.name);
    openMenu(e, [
      { label: pinned ? "Unpin from Favorites" : "Pin to Favorites", icon: pinned ? <PinOff size={14} /> : <Pin size={14} />, onSelect: () => p.onTogglePin(ch.name) },
      { label: "Copy name", icon: <Copy size={14} />, onSelect: () => copy(ch.name, "log name") },
      { label: "Open in a new pane", icon: <ExternalLink size={14} />, onSelect: () => p.onOpenInPane(ch.name) },
    ]);
  };

  const onKey = (e: React.KeyboardEvent) => {
    if ((e.target as HTMLElement).closest("input")) {
      if (e.key === "ArrowDown" && logs.length) {
        e.preventDefault();
        listRef.current?.focus();
        setAt(0);
        p.onSelect(logs[0].ch.name);
      }
      return;
    }
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    const i = logs[at]?.ch.name === p.selected ? at : logs.findIndex((r) => r.ch.name === p.selected);
    const next = e.key === "ArrowDown" ? Math.min(logs.length - 1, i + 1) : Math.max(0, i - 1);
    if (logs[next]) {
      setAt(next);
      p.onSelect(logs[next].ch.name);
      requestAnimationFrame(() => listRef.current?.querySelector(".ev-log.selected")?.scrollIntoView({ block: "nearest" }));
    }
  };

  let body: ReactNode;
  if (p.error) body = <div className="ev-side-note sm-danger-text">{p.error}</div>;
  else if (!p.channels) body = <div className="ev-side-note">Loading logs…</div>;
  else if (!rows.length || (searching && !logs.length)) body = <div className="ev-side-note">No log matches “{search}”.</div>;
  else
    body = rows.map((r) => {
      if (r.type === "section")
        return (
          <div key={r.id} className="ev-side-section" onClick={() => toggle(r.id)}>
            {r.open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
            <span className="sm-grow sm-ellipsis">{r.label}</span>
            {searching && <span className="ev-side-count">{r.count}</span>}
          </div>
        );
      if (r.type === "folder")
        return (
          <div key={r.id} className="ev-side-row ev-folder" style={{ paddingLeft: 8 + r.depth * 14 }} title={r.title} onClick={() => toggle(r.id)}>
            {r.open ? <ChevronDown size={13} className="ev-side-chev" /> : <ChevronRight size={13} className="ev-side-chev" />}
            <span className="sm-grow sm-ellipsis">{r.label}</span>
            <span className="ev-side-count">{r.count}</span>
          </div>
        );
      const ch = r.ch;
      const sel = ch.name === p.selected;
      return (
        <div
          key={(r.fav ? "f:" : "l:") + ch.name}
          className={cx("ev-side-row ev-log", sel && "selected", !ch.enabled && "disabled")}
          style={{ paddingLeft: 8 + r.depth * 14 }}
          title={ch.name + (!ch.enabled ? " (disabled)" : "")}
          onClick={() => {
            setAt(logs.indexOf(r));
            p.onSelect(ch.name);
          }}
          onContextMenu={(e) => menu(e, ch)}
        >
          {r.fav ? <Star size={13} className="ev-side-star" /> : <ScrollText size={13} className="ev-side-icon" />}
          <span className="sm-grow sm-ellipsis">{r.label}</span>
          {(ch.kind === "analytic" || ch.kind === "debug") && <span className="ev-side-tag">{ch.kind}</span>}
          {!ch.enabled && <span className="ev-side-tag">off</span>}
          {sel && p.records !== null && <span className="ev-side-count">{formatNumber(p.records)}</span>}
        </div>
      );
    });

  return (
    <div className={cx("ev-side", p.className)} onKeyDown={onKey}>
      <div className="ev-side-head">
        <SearchBox value={search} onChange={setSearch} placeholder="Find a log" autoFocus={p.autoFocus} />
      </div>
      <div className="ev-side-list" ref={listRef} tabIndex={0}>
        {body}
      </div>
      <label className="ev-side-foot">
        <Switch value={p.showAll} onChange={p.onShowAll} title="Also list analytic, debug and disabled logs" />
        <span className="sm-grow">Show all logs</span>
        {!p.showAll && hidden > 0 && <span className="ev-side-count" title="Analytic, debug and disabled logs">{formatNumber(hidden)} hidden</span>}
      </label>
    </div>
  );
}
