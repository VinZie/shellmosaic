// Hosts: saved SSH hosts in an encrypted vault. Connect opens a terminal on the
// host (the terminal module with meta.ssh), SFTP opens a file browser on it.
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { useEffect, useMemo, useRef, useState } from "react";
import { errorText, ipc, type HostView } from "../../lib/ipc";
import { Icon } from "../../lib/icons";
import { clamp, cx } from "../../lib/util";
import { setPaneMeta } from "../../state/actions";
import { useSettings } from "../../state/settings";
import { ui, type MenuItem } from "../../state/ui";
import { ModuleMessage, SearchBox, useInterval } from "../common";
import type { ModuleDef, ModuleProps } from "../registry";
import { HostEditor, type EditTarget } from "./HostEditor";
import { connectHost, hostAddress, openSftp, userAtHost } from "./open";
import { ChangePasswordForm, CreateVaultForm, UnlockVaultForm } from "./VaultForms";
import { lockVault, resetVault, useVault, useVaultStatus } from "./vault";
import "./hosts.css";

type View = { kind: "list" } | { kind: "edit"; target: EditTarget } | { kind: "password" };

interface Group {
  /** "" = ungrouped */
  name: string;
  hosts: HostView[];
}

const byName = (a: HostView, b: HostView) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });

const dateFmt = new Intl.DateTimeFormat(undefined, { year: "numeric", month: "short", day: "numeric" });
const fullFmt = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });

function lastUsedText(ms: number | null, now: number): string {
  if (!ms) return "never";
  const s = Math.max(0, (now - ms) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  if (s < 2 * 86400) return "yesterday";
  if (s < 7 * 86400) return `${Math.floor(s / 86400)} days ago`;
  return dateFmt.format(new Date(ms));
}

function matches(h: HostView, words: string[]): boolean {
  if (!words.length) return true;
  const hay = `${h.name} ${h.host} ${userAtHost(h)} ${h.group} ${h.tags.join(" ")} ${h.notes}`.toLowerCase();
  return words.every((w) => hay.includes(w));
}

function copyAddress(h: HostView) {
  const text = userAtHost(h);
  writeText(text).then(
    () => ui.toast(`Copied ${text}`, "success", 1500),
    (e) => ui.toast(errorText(e), "error"),
  );
}

/** A host's icon on its color. */
export function HostAvatar({ host, size = 26 }: { host: Pick<HostView, "icon" | "color">; size?: number }) {
  return (
    <span className="hosts-avatar" style={{ width: size, height: size, "--host-color": host.color ?? undefined } as React.CSSProperties}>
      <Icon name={host.icon || "server"} size={Math.round(size * 0.55)} />
    </span>
  );
}

function HostsPane({ pane, tabId, visible, focused }: ModuleProps) {
  const status = useVaultStatus();
  const hosts = useVault((s) => s.hosts);
  const autoLock = useSettings((s) => s.settings.modules.hosts?.autoLockMinutes ?? 15);
  const [view, setView] = useState<View>({ kind: "list" });
  const [query, setQuery] = useState("");
  const [tag, setTag] = useState<string | null>(null);
  const [sel, setSel] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const rootRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const active = focused && visible;
  const unlocked = !!status?.unlocked;
  const collapsedMeta = pane.meta.collapsed;
  const collapsed = useMemo<string[]>(() => (Array.isArray(collapsedMeta) ? collapsedMeta : []), [collapsedMeta]);

  // "x min ago" stays current
  useInterval(() => setNow(Date.now()), 60_000, visible && view.kind === "list");

  // locked (auto-lock, another window): forms that need the vault are gone
  useEffect(() => {
    if (!unlocked) setView({ kind: "list" });
  }, [unlocked]);

  // ── rows ──
  const allGroups = useMemo(() => [...new Set((hosts ?? []).map((h) => h.group).filter(Boolean))].sort((a, b) => a.localeCompare(b)), [hosts]);
  const allTags = useMemo(() => [...new Set((hosts ?? []).flatMap((h) => h.tags))].sort((a, b) => a.localeCompare(b)), [hosts]);

  const groups = useMemo<Group[]>(() => {
    if (!hosts) return [];
    const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean).map((w) => w.replace(/^#/, ""));
    const shown = hosts.filter((h) => (!tag || h.tags.includes(tag)) && matches(h, words));
    const map = new Map<string, HostView[]>();
    for (const h of shown) map.set(h.group, [...(map.get(h.group) ?? []), h]);
    const names = [...map.keys()].sort((a, b) => (!a ? 1 : !b ? -1 : a.localeCompare(b)));
    return names.map((name) => ({ name, hosts: map.get(name)!.sort(byName) }));
  }, [hosts, query, tag]);

  // with no groups at all there's no need for an "Ungrouped" header
  const headers = groups.length > 1 || (groups.length === 1 && groups[0].name !== "");
  const isCollapsed = (g: string) => headers && collapsed.includes(g);
  const flat = useMemo(() => groups.flatMap((g) => (headers && collapsed.includes(g.name) ? [] : g.hosts)), [groups, collapsed, headers]);
  const selIndex = flat.findIndex((h) => h.id === sel);
  const current = selIndex >= 0 ? flat[selIndex] : undefined;

  useEffect(() => {
    if (!sel) return;
    listRef.current?.querySelector<HTMLElement>(`[data-id="${CSS.escape(sel)}"]`)?.scrollIntoView({ block: "nearest" });
  }, [sel]);

  // focus the list when the pane gets focus
  useEffect(() => {
    if (!active || view.kind !== "list") return;
    const el = document.activeElement;
    if (el && rootRef.current?.contains(el)) return;
    if (ui.get().dialog || ui.get().palette.open) return;
    listRef.current?.focus({ preventScroll: true });
  }, [active, view.kind, unlocked]);

  const toggleGroup = (g: string) => {
    const next = collapsed.includes(g) ? collapsed.filter((x) => x !== g) : [...collapsed, g];
    setPaneMeta(pane.id, { collapsed: next.length ? next : null });
  };

  // ── actions ──
  const refocus = () => requestAnimationFrame(() => listRef.current?.focus({ preventScroll: true }));
  const connect = (h: HostView, newTab = false) => connectHost(h, { tabId, near: pane.id, newTab });
  const sftp = (h: HostView) => openSftp(h.id, h.name, { tabId, near: pane.id });
  const edit = (target: EditTarget) => setView({ kind: "edit", target });

  const remove = async (h: HostView) => {
    const ok = await ui.confirm(
      `Delete "${h.name}"?`,
      "Its saved password, private key and trusted host keys are deleted with it. Terminals and SFTP panes that are connected to it stay connected.",
      { okLabel: "Delete host", danger: true },
    );
    if (!ok) return refocus();
    const i = flat.findIndex((x) => x.id === h.id);
    try {
      await ipc.hostDelete(h.id);
      const next = flat[i + 1] ?? flat[i - 1];
      setSel(next && next.id !== h.id ? next.id : null);
      setView({ kind: "list" });
      ui.toast(`Deleted "${h.name}"`, "success", 2200);
    } catch (e) {
      ui.toast(errorText(e), "error");
    }
    refocus();
  };

  const rowMenu = (e: React.MouseEvent | { x: number; y: number }, h: HostView) => {
    if ("preventDefault" in e) {
      e.preventDefault();
      e.stopPropagation();
    }
    setSel(h.id);
    const items: MenuItem[] = [
      { label: "Connect", icon: "square-terminal", shortcut: "Enter", onSelect: () => connect(h) },
      { label: "Connect in new tab", icon: "plus", shortcut: "Ctrl+Enter", onSelect: () => connect(h, true) },
      { label: "Open SFTP", icon: "folder-sync", onSelect: () => sftp(h) },
      { type: "separator" },
      { label: "Edit…", icon: "pencil", onSelect: () => edit({ host: h }) },
      { label: "Duplicate…", icon: "copy", onSelect: () => edit({ host: h, duplicate: true }) },
      { label: `Copy "${userAtHost(h)}"`, icon: "clipboard-copy", shortcut: "Ctrl+C", onSelect: () => copyAddress(h) },
      { type: "separator" },
      { label: "Delete…", icon: "trash", shortcut: "Del", danger: true, onSelect: () => remove(h) },
    ];
    ui.openMenu(e, items);
  };

  const vaultMenu = (e: React.MouseEvent) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    ui.openMenu({ x: r.left, y: r.bottom + 4 }, [
      { label: "Add host…", icon: "plus", onSelect: () => edit({}) },
      { type: "separator" },
      { label: "Change master password…", icon: "key-round", onSelect: () => setView({ kind: "password" }) },
      { label: "Lock vault", icon: "lock", onSelect: lockVault },
      { label: "Auto-lock settings…", icon: "settings", onSelect: () => ui.openSettings("modules") },
      { type: "separator" },
      { label: "Reset vault…", icon: "trash", danger: true, onSelect: () => void resetVault() },
    ]);
  };

  const onListKey = (e: React.KeyboardEvent) => {
    if ((e.target as HTMLElement).closest("button,input")) return;
    const mod = e.ctrlKey || e.metaKey;
    const move = (to: number) => flat.length && setSel(flat[clamp(to, 0, flat.length - 1)].id);
    switch (e.key) {
      case "ArrowDown":
        move(selIndex < 0 ? 0 : selIndex + 1);
        break;
      case "ArrowUp":
        move(selIndex < 0 ? 0 : selIndex - 1);
        break;
      case "PageDown":
        move(selIndex + 10);
        break;
      case "PageUp":
        move(selIndex - 10);
        break;
      case "Home":
        move(0);
        break;
      case "End":
        move(flat.length - 1);
        break;
      case "Enter":
        if (!current) return;
        connect(current, mod);
        break;
      case "Delete":
        if (!current) return;
        remove(current);
        break;
      case "ContextMenu": {
        if (!current) return;
        const r = listRef.current?.querySelector<HTMLElement>(`[data-id="${CSS.escape(current.id)}"]`)?.getBoundingClientRect();
        if (r) rowMenu({ x: r.left + 24, y: r.bottom }, current);
        break;
      }
      default:
        if (mod && e.key.toLowerCase() === "c" && current) {
          copyAddress(current);
          break;
        }
        return;
    }
    e.preventDefault();
  };

  // ── render ──
  let body: React.ReactNode;
  if (!status) {
    body = <div className="hosts-loading dim">Opening the vault…</div>;
  } else if (!status.exists) {
    body = <CreateVaultForm autoFocus={active} />;
  } else if (!unlocked) {
    body = <UnlockVaultForm autoFocus={active} />;
  } else if (view.kind === "edit") {
    return (
      <div className="module hosts" ref={rootRef}>
        <HostEditor
          key={view.target.host?.id ?? "new"}
          target={view.target}
          groups={allGroups}
          tags={allTags}
          autoFocus={active}
          onClose={(saved) => {
            setView({ kind: "list" });
            if (saved) {
              setSel(saved.id);
              // a filter that hides the saved host would make it look lost
              if (tag && !saved.tags.includes(tag)) setTag(null);
              if (query) setQuery("");
            }
            refocus();
          }}
          onDelete={remove}
        />
      </div>
    );
  } else if (view.kind === "password") {
    body = (
      <ChangePasswordForm
        autoFocus={active}
        onDone={() => {
          setView({ kind: "list" });
          refocus();
        }}
      />
    );
  } else if (!hosts?.length) {
    body = (
      <ModuleMessage icon="server" title="No saved hosts yet">
        <p className="dim hosts-intro">Save the servers you SSH into: one click opens a terminal on them, or an SFTP file browser. Passwords and keys are kept encrypted in the vault.</p>
        <div className="row">
          <button className="btn primary" onClick={() => edit({})}>
            <Icon name="plus" size={14} /> Add host
          </button>
        </div>
      </ModuleMessage>
    );
  } else if (!groups.length) {
    body = (
      <div className="empty-state">
        <Icon name="search" size={22} />
        <p>No hosts match{query ? ` “${query}”` : ""}{tag ? ` with the tag “${tag}”` : ""}.</p>
        <div className="row">
          <button
            className="btn subtle"
            onClick={() => {
              setQuery("");
              setTag(null);
            }}
          >
            Clear filter
          </button>
        </div>
      </div>
    );
  } else {
    body = (
      <div
        ref={listRef}
        className="module-scroll hosts-list"
        tabIndex={0}
        role="listbox"
        aria-label="Saved hosts"
        aria-activedescendant={current ? `host-${pane.id}-${current.id}` : undefined}
        onKeyDown={onListKey}
        onContextMenu={(e) => {
          e.preventDefault();
          ui.openMenu(e, [
            { label: "Add host…", icon: "plus", onSelect: () => edit({}) },
            { label: "Lock vault", icon: "lock", onSelect: lockVault },
          ]);
        }}
      >
        {groups.map((g) => (
          <div key={g.name || "\u0000"} className="hosts-group" role="group" aria-label={g.name || "Ungrouped"}>
            {headers && (
              <div className="hosts-group-head" onClick={() => toggleGroup(g.name)} title={isCollapsed(g.name) ? "Expand" : "Collapse"}>
                <Icon name={isCollapsed(g.name) ? "chevron-right" : "chevron-down"} size={13} className="dim" />
                <span className="hosts-group-title">{g.name || "Ungrouped"}</span>
                <span className="hosts-count">{g.hosts.length}</span>
              </div>
            )}
            {!isCollapsed(g.name) &&
              g.hosts.map((h) => (
                <div
                  key={h.id}
                  id={`host-${pane.id}-${h.id}`}
                  data-id={h.id}
                  role="option"
                  aria-selected={sel === h.id}
                  className={cx("list-row hosts-row", sel === h.id && "selected")}
                  title={h.notes ? `${hostAddress(h)}\n\n${h.notes}` : hostAddress(h)}
                  onClick={() => setSel(h.id)}
                  onDoubleClick={() => connect(h)}
                  onContextMenu={(e) => rowMenu(e, h)}
                >
                  <HostAvatar host={h} />
                  <span className="hosts-main">
                    <span className="hosts-name">{h.name}</span>
                    <span className="hosts-addr">{hostAddress(h)}</span>
                  </span>
                  {h.tags.length > 0 && (
                    <span className="hosts-tags" onDoubleClick={(e) => e.stopPropagation()}>
                      {h.tags.map((t) => (
                        <button
                          key={t}
                          className={cx("chip hosts-tag", tag === t && "accent")}
                          title={tag === t ? "Show all hosts" : `Only hosts tagged “${t}”`}
                          onClick={(e) => {
                            e.stopPropagation();
                            setTag(tag === t ? null : t);
                          }}
                        >
                          {t}
                        </button>
                      ))}
                    </span>
                  )}
                  <span className="hosts-used" title={h.lastUsed ? `Last connected ${fullFmt.format(new Date(h.lastUsed))}` : "Never connected"}>
                    {lastUsedText(h.lastUsed, now)}
                  </span>
                  <span className="hosts-actions" onClick={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()}>
                    <button className="icon-btn" title="Connect (Enter)" onClick={() => connect(h)}>
                      <Icon name="square-terminal" size={14} />
                    </button>
                    <button className="icon-btn" title="Open SFTP" onClick={() => sftp(h)}>
                      <Icon name="folder-sync" size={14} />
                    </button>
                    <button className="icon-btn" title="Edit" onClick={() => edit({ host: h })}>
                      <Icon name="pencil" size={13} />
                    </button>
                    <button className="icon-btn" title="More" onClick={(e) => rowMenu({ x: e.clientX, y: e.clientY }, h)}>
                      <Icon name="ellipsis" size={14} />
                    </button>
                  </span>
                </div>
              ))}
          </div>
        ))}
      </div>
    );
  }

  const showList = unlocked && view.kind === "list";
  const groupCount = allGroups.length;

  return (
    <div className="module hosts" ref={rootRef}>
      {showList && (
        <div className="toolbar hosts-toolbar">
          <SearchBox value={query} onChange={setQuery} placeholder="Search hosts" />
          {tag && (
            <button className="chip accent hosts-filter" title="Show all hosts" onClick={() => setTag(null)}>
              <Icon name="tag" size={11} />
              {tag}
              <Icon name="x" size={11} />
            </button>
          )}
          <span className="grow" />
          <button className="btn small" title="Add a host" onClick={() => edit({})}>
            <Icon name="plus" size={13} /> <span className="hosts-btn-label">Add host</span>
          </button>
          <button className="icon-btn" title="Lock the vault" onClick={lockVault}>
            <Icon name="lock" size={14} />
          </button>
          <button className="icon-btn" title="Vault" onClick={vaultMenu}>
            <Icon name="ellipsis" size={15} />
          </button>
        </div>
      )}
      {body}
      {showList && !!hosts?.length && (
        <div className="module-footer">
          <span>
            {hosts.length} host{hosts.length === 1 ? "" : "s"}
            {groupCount > 0 && ` · ${groupCount} group${groupCount === 1 ? "" : "s"}`}
          </span>
          <span className="grow" />
          <span className="hosts-lockstate" title="Locks itself after this long without using saved hosts (Settings → Modules → Hosts)">
            <Icon name="lock-open" size={11} />
            {autoLock > 0 ? `locks after ${autoLock} min idle` : "auto-lock off"}
          </span>
        </div>
      )}
    </div>
  );
}

export const hostsModule: ModuleDef = {
  id: "hosts",
  name: "Hosts",
  icon: "server",
  description: "Saved SSH hosts: terminals, SFTP, encrypted passwords and keys",
  component: HostsPane,
  menu: () => {
    const unlocked = !!useVault.getState().status?.unlocked;
    return [
      { label: "Lock vault", icon: "lock", disabled: !unlocked, onSelect: lockVault },
      { label: "Auto-lock settings…", icon: "settings", onSelect: () => ui.openSettings("modules") },
    ];
  },
};
