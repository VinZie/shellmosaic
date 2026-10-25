// SFTP: browse a saved host's files and move files both ways. One SSH connection
// per pane (sftp.rs keys it by pane id); questions while connecting (host key,
// passwords, 2FA codes) come as "ssh://prompt" events and are asked as dialogs.
// Connections and transfers live outside React so they survive re-mounts.
import { Channel } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { openPath } from "@tauri-apps/plugin-opener";
import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { create } from "zustand";
import { errorText, ipc, type HostView, type RemoteEntry, type SshPrompt, type TransferEvent } from "../../lib/ipc";
import { Icon } from "../../lib/icons";
import { basename, clamp, cx, formatBytes, joinPath, uid } from "../../lib/util";
import { setPaneMeta } from "../../state/actions";
import type { Id, Pane } from "../../state/model";
import { getState, useModel } from "../../state/store";
import { ui, type MenuItem } from "../../state/ui";
import { ModuleMessage, SearchBox } from "../common";
import { HostAvatar } from "../hosts/HostsPane";
import { connectHost, hostAddress, openHosts } from "../hosts/open";
import { UnlockVaultForm } from "../hosts/VaultForms";
import { useVault, useVaultStatus } from "../hosts/vault";
import type { ModuleDef, ModuleProps } from "../registry";
import "./sftp.css";

const ROW_H = 26;
const HEADER_H = 28;
const OVERSCAN = 8;

// ── remote (POSIX) paths ────────────────────────────────────────────────

const rjoin = (dir: string, name: string) => (dir.endsWith("/") ? dir + name : `${dir}/${name}`);

function rdirname(p: string): string {
  const t = p.length > 1 ? p.replace(/\/+$/, "") : p;
  const i = t.lastIndexOf("/");
  return i <= 0 ? "/" : t.slice(0, i);
}

/** Resolve `.` and `..` and collapse slashes. */
function rnormalize(p: string): string {
  const abs = p.startsWith("/");
  const out: string[] = [];
  for (const part of p.split("/")) {
    if (!part || part === ".") continue;
    if (part === ".." && out.length && out[out.length - 1] !== "..") out.pop();
    else if (part !== ".." || !abs) out.push(part);
  }
  return abs ? `/${out.join("/")}` : out.join("/") || ".";
}

function rcrumbs(p: string): { label: string; path: string }[] {
  const out = [{ label: "/", path: "/" }];
  let acc = "";
  for (const part of p.split("/").filter(Boolean)) {
    acc += `/${part}`;
    out.push({ label: part, path: acc });
  }
  return out;
}

function badName(n: string): string | null {
  if (!n) return "Enter a name";
  if (n.includes("/") || n.includes("\0")) return "Names can't contain /";
  if (n === "." || n === "..") return "That name is reserved";
  return null;
}

// ── entries ─────────────────────────────────────────────────────────────

const IMG_EXT = new Set("png jpg jpeg gif webp bmp svg ico avif tif tiff".split(" "));
const CODE_EXT = new Set(
  "js jsx ts tsx mjs cjs py rb go rs java kt c h cpp hpp cs php sh bash zsh fish ps1 lua pl sql json yaml yml toml xml html htm css scss ini conf cfg env service".split(" "),
);
const TEXT_EXT = new Set("txt md log csv tsv rst".split(" "));

function entryIcon(e: RemoteEntry): string {
  if (e.isDir) return "folder";
  const i = e.name.lastIndexOf(".");
  const x = i > 0 ? e.name.slice(i + 1).toLowerCase() : "";
  if (IMG_EXT.has(x)) return "image";
  if (CODE_EXT.has(x)) return "file-code";
  if (TEXT_EXT.has(x) || /^(readme|license|changelog)/i.test(e.name)) return "file-text";
  return "file";
}

const dateFmt = new Intl.DateTimeFormat(undefined, { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
const timeFmt = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" });
function formatDate(ms: number): string {
  if (!ms) return "";
  const d = new Date(ms);
  return d.toDateString() === new Date().toDateString() ? `Today ${timeFmt.format(d)}` : dateFmt.format(d);
}

type SortKey = "name" | "size" | "modified";
interface Sort {
  key: SortKey;
  desc: boolean;
}

const nameCmp = (a: RemoteEntry, b: RemoteEntry) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });

function sortEntries(list: RemoteEntry[], sort: Sort): RemoteEntry[] {
  const by =
    sort.key === "size"
      ? (a: RemoteEntry, b: RemoteEntry) => a.size - b.size || nameCmp(a, b)
      : sort.key === "modified"
        ? (a: RemoteEntry, b: RemoteEntry) => a.modified - b.modified || nameCmp(a, b)
        : nameCmp;
  return [...list].sort((a, b) => Number(b.isDir) - Number(a.isDir) || (sort.desc ? -by(a, b) : by(a, b)));
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
const toastErr = (e: unknown) => ui.toast(errorText(e), "error");

function copyText(text: string, what = "Path") {
  writeText(text).then(
    () => ui.toast(`${what} copied`, "success", 1500),
    toastErr,
  );
}

// ── connections (per pane, outside React) ───────────────────────────────

type Phase = "connecting" | "locked" | "error" | "ready";

interface Session {
  hostId: string;
  phase: Phase;
  error?: string;
  home?: string;
  hostName?: string;
  /** the folder on screen (where dropped files go) */
  dir?: string;
  /** bumped when the folder should be listed again (an upload finished) */
  rev: number;
}

const useSessions = create<Record<Id, Session>>(() => ({}));

function patchSession(paneId: Id, patch: Partial<Session> | ((s: Session) => Partial<Session>)) {
  useSessions.setState((all) => {
    const s = all[paneId];
    if (!s) return all;
    return { [paneId]: { ...s, ...(typeof patch === "function" ? patch(s) : patch) } };
  });
}

function dropSession(paneId: Id) {
  if (!useSessions.getState()[paneId]) return;
  useSessions.setState((all) => {
    const next = { ...all };
    delete next[paneId];
    return next;
  }, true);
}

/** The host a pane is set to (undefined: not an SFTP pane any more, or no host). */
function paneHost(paneId: Id): string | undefined {
  const p = getState().model.panes[paneId];
  return p?.module === "sftp" && typeof p.meta.hostId === "string" && p.meta.hostId ? p.meta.hostId : undefined;
}

const connecting = new Map<Id, Promise<void>>();

/** Connect a pane to a host (one attempt at a time per pane). `fresh` drops an existing connection first. */
function connect(paneId: Id, hostId: string, fresh = false): Promise<void> {
  const running = connecting.get(paneId);
  if (running) return running;
  const run = async () => {
    await listenForPrompts();
    const prev = useSessions.getState()[paneId];
    const same = prev?.hostId === hostId;
    // sftp_connect hands back a pane's open connection whatever host is asked for
    if (fresh || (prev && !same)) await ipc.sftpClose(paneId).catch(() => {});
    useSessions.setState({
      [paneId]: { hostId, phase: "connecting", rev: prev?.rev ?? 0, hostName: same ? prev?.hostName : undefined, home: same ? prev?.home : undefined },
    });
    const vault = await ipc.vaultStatus().catch(() => null);
    if (vault && !vault.unlocked) {
      // still connected (the pane came from another window)? then the vault isn't needed
      const open = !fresh && (await ipc.sftpList(paneId, ".").then(() => true, () => false));
      if (!open) return patchSession(paneId, { phase: "locked" });
    }
    try {
      const info = await ipc.sftpConnect(paneId, hostId);
      // closed, turned into another module, or pointed at another host meanwhile
      if (paneHost(paneId) !== hostId) return void ipc.sftpClose(paneId).catch(() => {});
      patchSession(paneId, { phase: "ready", home: info.home || "/", hostName: info.hostName || undefined, error: undefined });
    } catch (e) {
      patchSession(paneId, { phase: "error", error: errorText(e) });
    }
  };
  const p = run().finally(() => {
    connecting.delete(paneId);
    const s = useSessions.getState()[paneId];
    if (s && paneHost(paneId) !== s.hostId) dropSession(paneId);
  });
  connecting.set(paneId, p);
  return p;
}

/** Disconnect and show the host picker. */
function chooseAnotherHost(paneId: Id) {
  ipc.sftpClose(paneId).catch(() => {});
  dropSession(paneId);
  setPaneMeta(paneId, { hostId: null, hostName: null, path: null });
}

/** A pane closed for good (or turned into another module): stop everything it started. */
function forgetPane(paneId: Id) {
  for (const t of useTransfers.getState()[paneId] ?? []) if (t.id !== null && isRunning(t)) ipc.sftpCancel(t.id).catch(() => {});
  dropTransfers(paneId);
  dropSession(paneId);
  ipc.sftpClose(paneId).catch(() => {});
  if (activePrompt === paneId) ui.closeDialog();
  ui.setTitle(paneId, "");
}

// ── questions while connecting ──────────────────────────────────────────

/** Panes mounted in this window: only the window showing a pane answers its questions. */
const mounted = new Map<Id, number>();
let activePrompt: Id | null = null;
let promptQueue: Promise<void> = Promise.resolve();
let promptListener: Promise<unknown> | null = null;

function listenForPrompts(): Promise<unknown> {
  promptListener ??= Promise.all([
    listen<SshPrompt>("ssh://prompt", (e) => {
      const q = e.payload;
      if (!mounted.has(q.paneId)) return;
      // one dialog at a time: a second pane's question waits for the first
      promptQueue = promptQueue.then(() => askPrompt(q)).catch(() => {});
    }),
    // what a terminal would print while connecting: banners, "saved password was rejected"…
    listen<{ paneId: string; kind: "info" | "warning"; message: string }>("ssh://notice", (e) => {
      if (mounted.has(e.payload.paneId)) ui.toast(e.payload.message, e.payload.kind, e.payload.kind === "warning" ? 6000 : 4000);
    }),
  ]).catch((err) => console.error("ssh prompts unavailable", err));
  return promptListener;
}

async function askPrompt(q: SshPrompt) {
  let value: string | null = null;
  const pane = getState().model.panes[q.paneId];
  // (closed while an earlier question was open: decline)
  if (pane?.module === "sftp") {
    const name = useSessions.getState()[q.paneId]?.hostName || pane.meta.hostName || "the server";
    activePrompt = q.paneId;
    try {
      if (q.kind === "confirm") {
        value = (await ui.confirm(`${name} — SFTP`, `${q.message.trim()}?`, { okLabel: "Yes" })) ? "yes" : null;
      } else {
        value = await ui.prompt(q.message.replace(/[\s:]+$/, "") || "Answer", "", { label: `SFTP · ${name}`, secret: q.kind === "secret", okLabel: "OK" });
      }
    } finally {
      activePrompt = null;
    }
  }
  await ipc.sshPromptAnswer(q.id, value).catch(() => {});
}

// ── transfers ───────────────────────────────────────────────────────────

interface Transfer {
  key: string;
  /** backend id, once sftp_upload/sftp_download answered */
  id: number | null;
  kind: "upload" | "download";
  /** items picked */
  count: number;
  /** the folder they go to (remote for uploads, local for downloads) */
  target: string;
  state: "starting" | "running" | "done" | "cancelled" | "error";
  total: number;
  done: number;
  files: number;
  file: string;
  skipped: number;
  message?: string;
  cancelRequested?: boolean;
}

const useTransfers = create<Record<Id, Transfer[]>>(() => ({}));
const isRunning = (t: Transfer) => t.state === "starting" || t.state === "running";
const findTransfer = (paneId: Id, key: string) => useTransfers.getState()[paneId]?.find((t) => t.key === key);

// panes closed from another window (onRemove only runs in the window that closed it)
useModel.subscribe((s) => {
  const ids = new Set([...Object.keys(useSessions.getState()), ...Object.keys(useTransfers.getState())]);
  for (const id of ids) if (s.model.panes[id]?.module !== "sftp") forgetPane(id);
});

function patchTransfer(paneId: Id, key: string, patch: Partial<Transfer> | ((t: Transfer) => Partial<Transfer>)) {
  useTransfers.setState((all) => {
    const list = all[paneId];
    if (!list?.some((t) => t.key === key)) return all;
    return { [paneId]: list.map((t) => (t.key === key ? { ...t, ...(typeof patch === "function" ? patch(t) : patch) } : t)) };
  });
}

function removeTransfer(paneId: Id, key: string) {
  useTransfers.setState((all) => (all[paneId] ? { [paneId]: all[paneId].filter((t) => t.key !== key) } : all));
}

function dropTransfers(paneId: Id) {
  if (!useTransfers.getState()[paneId]) return;
  useTransfers.setState((all) => {
    const next = { ...all };
    delete next[paneId];
    return next;
  }, true);
}

function cancelTransfer(paneId: Id, t: Transfer) {
  patchTransfer(paneId, t.key, { cancelRequested: true });
  // (no id yet: it's cancelled as soon as it has one)
  if (t.id !== null) ipc.sftpCancel(t.id).catch(toastErr);
}

function startTransfer(paneId: Id, kind: Transfer["kind"], count: number, target: string, begin: (ch: Channel<TransferEvent>) => Promise<number>) {
  const key = uid();
  const t: Transfer = { key, id: null, kind, count, target, state: "starting", total: 0, done: 0, files: 0, file: "", skipped: 0 };
  useTransfers.setState((all) => ({ [paneId]: [...(all[paneId] ?? []), t] }));
  const relist = () => kind === "upload" && patchSession(paneId, (s) => ({ rev: s.rev + 1 }));
  const ch = new Channel<TransferEvent>();
  ch.onmessage = (ev) => {
    switch (ev.t) {
      case "start":
        patchTransfer(paneId, key, { state: "running", total: ev.total, files: ev.files });
        break;
      case "progress":
        patchTransfer(paneId, key, { done: ev.done, total: ev.total, file: ev.file });
        break;
      case "done": {
        patchTransfer(paneId, key, (x) => ({ state: "done", files: ev.files, skipped: ev.skipped, done: x.total }));
        const skipped = ev.skipped ? ` (${ev.skipped} skipped)` : "";
        ui.toast(`${kind === "upload" ? "Uploaded" : "Downloaded"} ${plural(ev.files, "file")} to ${target}${skipped}`, "success");
        relist();
        setTimeout(() => removeTransfer(paneId, key), 10_000);
        break;
      }
      case "cancelled":
        patchTransfer(paneId, key, { state: "cancelled" });
        relist();
        setTimeout(() => removeTransfer(paneId, key), 4000);
        break;
      case "error":
        patchTransfer(paneId, key, { state: "error", message: ev.message });
        relist();
        break;
    }
  };
  begin(ch).then(
    (id) => {
      const cur = findTransfer(paneId, key);
      // the pane was closed before the transfer got its id
      if (!cur) return void ipc.sftpCancel(id).catch(() => {});
      patchTransfer(paneId, key, { id });
      if (cur.cancelRequested && isRunning(cur)) ipc.sftpCancel(id).catch(() => {});
    },
    (e) => patchTransfer(paneId, key, { state: "error", message: errorText(e) }),
  );
}

/** The folder the last download went to (offered first next time). */
let lastLocalDir: string | undefined;

async function downloadStart(): Promise<string | undefined> {
  if (lastLocalDir) return lastLocalDir;
  const home = await ipc.fsHome().catch(() => "");
  return home ? joinPath(home, "Downloads") : undefined;
}

async function downloadTo(paneId: Id, entries: RemoteEntry[]) {
  if (!entries.length) return;
  const picked = await openDialog({
    directory: true,
    multiple: false,
    defaultPath: await downloadStart(),
    title: entries.length === 1 ? `Download "${entries[0].name}" to…` : `Download ${entries.length} items to…`,
  }).catch(() => null);
  if (typeof picked !== "string") return;
  lastLocalDir = picked;
  startTransfer(paneId, "download", entries.length, picked, (ch) =>
    ipc.sftpDownload(
      paneId,
      entries.map((e) => e.path),
      picked,
      ch,
    ),
  );
}

/** Upload local files/folders into `dir`, asking before anything already there is replaced. */
async function uploadInto(paneId: Id, dir: string, paths: string[]) {
  if (!paths.length) return;
  let existing: Set<string>;
  try {
    existing = new Set((await ipc.sftpList(paneId, dir)).map((e) => e.name));
  } catch (e) {
    return toastErr(e);
  }
  const clash = paths.map((p) => basename(p)).filter((n) => existing.has(n));
  let overwrite = false;
  if (clash.length) {
    const names = clash.slice(0, 10).map((n) => `  ${n}`).join("\n") + (clash.length > 10 ? `\n  …and ${clash.length - 10} more` : "");
    overwrite = await ui.confirm(
      clash.length === 1 ? `"${clash[0]}" already exists` : `${clash.length} items already exist`,
      `In ${dir}:\n${names}\n\nReplace them? Files inside folders that already exist are replaced too.`,
      { okLabel: "Replace", danger: true },
    );
    if (!overwrite) {
      const skip = await ui.confirm("Upload without replacing?", "Files that already exist are skipped; everything else is uploaded (into existing folders too).", {
        okLabel: "Skip existing",
      });
      if (!skip) return;
    }
  }
  startTransfer(paneId, "upload", paths.length, dir, (ch) => ipc.sftpUpload(paneId, paths, dir, overwrite, ch));
}

/**
 * Upload local files or folders (e.g. dropped from Explorer) into an SFTP pane's
 * current folder. Asks before replacing anything that already exists there.
 */
export async function sftpUploadPaths(paneId: string, localPaths: string[]): Promise<void> {
  const s = useSessions.getState()[paneId];
  if (!s || s.phase !== "ready" || !s.dir) {
    ui.toast("This SFTP pane isn't connected", "warning");
    return;
  }
  await uploadInto(paneId, s.dir, localPaths);
}

// ── pane ────────────────────────────────────────────────────────────────

function useMountedPane(paneId: Id) {
  useEffect(() => {
    mounted.set(paneId, (mounted.get(paneId) ?? 0) + 1);
    void listenForPrompts();
    return () => {
      const n = (mounted.get(paneId) ?? 1) - 1;
      if (n > 0) mounted.set(paneId, n);
      else mounted.delete(paneId);
    };
  }, [paneId]);
}

function SftpPane({ pane, tabId, visible, focused }: ModuleProps) {
  const hostId = typeof pane.meta.hostId === "string" && pane.meta.hostId ? pane.meta.hostId : undefined;
  const session = useSessions((s) => s[pane.id]);
  const vault = useVaultStatus();
  const active = focused && visible;
  useMountedPane(pane.id);

  // connect once on screen: restored panes in background tabs wait until they're looked at
  const stale = !session || session.hostId !== hostId;
  useEffect(() => {
    if (hostId && visible && stale) void connect(pane.id, hostId);
  }, [hostId, visible, stale, pane.id]);

  // waiting for the vault: carry on once it's unlocked (here, in Hosts, anywhere)
  const waiting = !stale && session.phase === "locked";
  useEffect(() => {
    if (waiting && vault?.unlocked && hostId) void connect(pane.id, hostId);
  }, [waiting, vault?.unlocked, hostId, pane.id]);

  const hostName = session?.hostName || (pane.meta.hostName as string | undefined) || "the server";

  let body: React.ReactNode;
  if (!hostId) {
    body = <HostPicker pane={pane} tabId={tabId} active={active} />;
  } else if (stale || session.phase === "connecting") {
    body = (
      <div className="empty-state">
        <Icon name="loader" size={22} className="sftp-spin" />
        <h2 style={{ fontSize: 14 }}>Connecting to {hostName}…</h2>
        <p className="dim sftp-detail">Questions from the server (its host key, passwords, codes) open as dialogs.</p>
      </div>
    );
  } else if (session.phase === "locked") {
    body =
      vault && !vault.exists ? (
        <ModuleMessage icon="key-round" title="There's no vault">
          <p className="dim">This pane's host was saved in a vault that no longer exists.</p>
          <div className="row">
            <button className="btn" onClick={() => chooseAnotherHost(pane.id)}>
              Choose another host
            </button>
          </div>
        </ModuleMessage>
      ) : (
        <UnlockVaultForm autoFocus={active} message={`Unlock the vault to connect to ${hostName}.`} />
      );
  } else if (session.phase === "error") {
    body = (
      <ModuleMessage icon="warning" title={`Couldn't connect to ${hostName}`}>
        <p className="sftp-error selectable">{session.error}</p>
        <div className="row">
          <button className="btn" onClick={() => void connect(pane.id, hostId, true)}>
            <Icon name="refresh" size={13} /> Retry
          </button>
          <button className="btn subtle" onClick={() => chooseAnotherHost(pane.id)}>
            Choose another host
          </button>
        </div>
      </ModuleMessage>
    );
  } else {
    return <Browser pane={pane} tabId={tabId} session={session} hostId={hostId} visible={visible} active={active} />;
  }
  return <div className="module sftp">{body}</div>;
}

// ── host picker (an SFTP pane added without a host) ─────────────────────

function HostPicker({ pane, tabId, active }: { pane: Pane; tabId: Id; active: boolean }) {
  const vault = useVaultStatus();
  const hosts = useVault((s) => s.hosts);
  const [query, setQuery] = useState("");
  const [sel, setSel] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const rows = useMemo(() => {
    const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    return (hosts ?? [])
      .filter((h) => {
        const hay = `${h.name} ${hostAddress(h)} ${h.group} ${h.tags.join(" ")}`.toLowerCase();
        return words.every((w) => hay.includes(w));
      })
      .sort((a, b) => (a.group || "￿").localeCompare(b.group || "￿") || a.name.localeCompare(b.name, undefined, { numeric: true }));
  }, [hosts, query]);
  const i = rows.findIndex((h) => h.id === sel);
  const hasRows = rows.length > 0;

  useEffect(() => {
    if (active && hasRows && !ui.get().dialog && !ui.get().palette.open) listRef.current?.focus({ preventScroll: true });
  }, [active, hasRows]);

  const pick = (h: HostView) => setPaneMeta(pane.id, { hostId: h.id, hostName: h.name, path: null });
  const manage = () => openHosts({ tabId, near: pane.id });

  if (!vault) return <div className="sftp-loading dim">Opening the vault…</div>;
  if (!vault.exists || (vault.unlocked && !hosts?.length)) {
    return (
      <ModuleMessage icon="folder-sync" title="No saved hosts yet">
        <p className="dim sftp-detail">SFTP connects to the hosts you save in the Hosts module.</p>
        <div className="row">
          <button className="btn primary" onClick={manage}>
            <Icon name="server" size={14} /> Open Hosts
          </button>
        </div>
      </ModuleMessage>
    );
  }
  if (!vault.unlocked) return <UnlockVaultForm autoFocus={active} message="Unlock the vault to pick one of your saved hosts." />;

  const onKeyDown = (e: React.KeyboardEvent) => {
    const move = (to: number) => rows.length && setSel(rows[clamp(to, 0, rows.length - 1)].id);
    if (e.key === "ArrowDown") move(i < 0 ? 0 : i + 1);
    else if (e.key === "ArrowUp") move(i < 0 ? 0 : i - 1);
    else if (e.key === "Enter" && rows[i]) pick(rows[i]);
    else return;
    e.preventDefault();
  };

  return (
    <>
      <div className="toolbar">
        <span className="sftp-pick-title">Connect to…</span>
        <span className="grow" />
        <SearchBox value={query} onChange={setQuery} placeholder="Search hosts" />
        <button className="icon-btn" title="Manage hosts" onClick={manage}>
          <Icon name="server" size={14} />
        </button>
      </div>
      <div ref={listRef} className="module-scroll sftp-picker" tabIndex={0} role="listbox" aria-label="Saved hosts" onKeyDown={onKeyDown}>
        {rows.map((h) => (
          <div
            key={h.id}
            role="option"
            aria-selected={sel === h.id}
            className={cx("list-row sftp-pick", sel === h.id && "selected")}
            onClick={() => setSel(h.id)}
            onDoubleClick={() => pick(h)}
            title={`Double-click (or Enter) to connect to ${hostAddress(h)}`}
          >
            <HostAvatar host={h} size={22} />
            <span className="sftp-pick-name ellipsis">{h.name}</span>
            <span className="sftp-pick-addr ellipsis">{hostAddress(h)}</span>
            {h.group && <span className="chip">{h.group}</span>}
            <button
              className="btn small"
              onClick={(e) => {
                e.stopPropagation();
                pick(h);
              }}
            >
              Connect
            </button>
          </div>
        ))}
        {!rows.length && <div className="sftp-empty dim">No hosts match “{query}”.</div>}
      </div>
    </>
  );
}

// ── browser ─────────────────────────────────────────────────────────────

function Browser({ pane, tabId, session, hostId, visible, active }: { pane: Pane; tabId: Id; session: Session; hostId: string; visible: boolean; active: boolean }) {
  const home = session.home || "/";
  const dir: string = typeof pane.meta.path === "string" && pane.meta.path ? pane.meta.path : home;
  const hostName = session.hostName || (pane.meta.hostName as string | undefined) || "server";

  const rootRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [listing, setListing] = useState<{ dir: string; entries: RemoteEntry[] } | null>(null);
  const [error, setError] = useState<{ dir: string; message: string } | null>(null);
  const [loading, setLoading] = useState(false);
  const [sort, setSort] = useState<Sort>({ key: "name", desc: false });
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [cursor, setCursor] = useState<string | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewH, setViewH] = useState(400);
  const anchor = useRef<string | null>(null);
  const pendingSelect = useRef<string | null>(null);
  const reqId = useRef(0);
  const dirRef = useRef(dir);
  dirRef.current = dir;

  // ── loading ──
  const load = useCallback(
    async (quiet = false) => {
      const d = dirRef.current;
      const id = ++reqId.current;
      if (!quiet) setLoading(true);
      try {
        const entries = await ipc.sftpList(pane.id, d);
        if (id !== reqId.current) return;
        setListing({ dir: d, entries });
        setError(null);
      } catch (e) {
        if (id !== reqId.current) return;
        setError({ dir: d, message: errorText(e) });
      } finally {
        if (id === reqId.current) setLoading(false);
      }
    },
    [pane.id],
  );

  // (again when the pane comes back on screen, and after uploads)
  useEffect(() => {
    if (visible) void load();
  }, [dir, visible, session.rev, load]);

  useEffect(() => {
    patchSession(pane.id, { dir });
    ui.setTitle(pane.id, dir);
  }, [pane.id, dir]);

  // a new folder: fresh selection and scroll
  useEffect(() => {
    setSelected(new Set());
    setCursor(null);
    anchor.current = null;
    setScrollTop(0);
    if (listRef.current) listRef.current.scrollTop = 0;
  }, [dir]);

  const entries = listing && listing.dir === dir ? listing.entries : null;
  const listError = error && error.dir === dir ? error.message : null;
  const rows = useMemo(() => (entries ? sortEntries(entries, sort) : []), [entries, sort]);
  const selectedRows = useMemo(() => rows.filter((r) => selected.has(r.path)), [rows, selected]);
  const cursorIndex = rows.findIndex((r) => r.path === cursor);

  const ensureVisible = useCallback((i: number) => {
    const el = listRef.current;
    if (!el || i < 0) return;
    const top = i * ROW_H;
    if (top < el.scrollTop) el.scrollTop = top;
    else if (HEADER_H + top + ROW_H > el.scrollTop + el.clientHeight) el.scrollTop = HEADER_H + top + ROW_H - el.clientHeight;
  }, []);

  // select a remembered entry once it shows up (the folder we came from, a new folder…)
  useEffect(() => {
    const want = pendingSelect.current;
    if (!want || !entries) return;
    const i = rows.findIndex((r) => r.path === want);
    if (i < 0) return;
    pendingSelect.current = null;
    setSelected(new Set([want]));
    setCursor(want);
    anchor.current = want;
    requestAnimationFrame(() => ensureVisible(i));
  }, [rows, entries, ensureVisible]);

  // track the list viewport for virtualization (the element comes and goes)
  const observer = useRef<ResizeObserver | null>(null);
  const setListEl = useCallback((el: HTMLDivElement | null) => {
    listRef.current = el;
    observer.current?.disconnect();
    observer.current = null;
    if (!el) return;
    const ro = new ResizeObserver(() => el.clientHeight && setViewH(el.clientHeight));
    ro.observe(el);
    observer.current = ro;
    if (el.clientHeight) setViewH(el.clientHeight);
    setScrollTop(el.scrollTop);
  }, []);
  useEffect(() => () => observer.current?.disconnect(), []);

  // focus the list when the pane gets focus (and once it's there)
  const listed = !!entries;
  useEffect(() => {
    if (!active) return;
    const el = document.activeElement;
    if (el && rootRef.current?.contains(el)) return;
    if (ui.get().dialog || ui.get().palette.open) return;
    listRef.current?.focus({ preventScroll: true });
  }, [active, listed]);

  // ── navigation ──
  const navigate = (path: string, select?: string) => {
    pendingSelect.current = select ?? null;
    if (path !== dir) setPaneMeta(pane.id, { path });
    else void load();
  };
  const goUp = () => dir !== "/" && navigate(rdirname(dir), dir);
  const open = (r: RemoteEntry) => (r.isDir ? navigate(r.path) : void downloadTo(pane.id, [r]));

  const submitPath = async (raw: string): Promise<boolean> => {
    let p = raw.trim();
    if (!p) return false;
    if (p === "~" || p.startsWith("~/")) p = home + p.slice(1);
    else if (!p.startsWith("/")) p = rjoin(dir, p);
    p = rnormalize(p);
    try {
      await ipc.sftpList(pane.id, p);
      navigate(p);
      return true;
    } catch (e) {
      ui.toast(`${p}: ${errorText(e)}`, "error");
      return false;
    }
  };

  // ── selection ──
  const selectOnly = (path: string) => {
    setSelected(new Set([path]));
    setCursor(path);
    anchor.current = path;
  };
  const selectRange = (from: string, to: string, add: boolean) => {
    const a = rows.findIndex((x) => x.path === from);
    const b = rows.findIndex((x) => x.path === to);
    if (a < 0 || b < 0) return selectOnly(to);
    const [lo, hi] = a < b ? [a, b] : [b, a];
    const next = new Set(add ? selected : []);
    rows.slice(lo, hi + 1).forEach((x) => next.add(x.path));
    setSelected(next);
    setCursor(to);
  };
  const clickRow = (e: React.MouseEvent, r: RemoteEntry) => {
    if (e.shiftKey && anchor.current) selectRange(anchor.current, r.path, e.ctrlKey || e.metaKey);
    else if (e.ctrlKey || e.metaKey) {
      const next = new Set(selected);
      if (next.has(r.path)) next.delete(r.path);
      else next.add(r.path);
      setSelected(next);
      setCursor(r.path);
      anchor.current = r.path;
    } else selectOnly(r.path);
  };
  /** What an action on `r` applies to: the selection if `r` is in it, else just `r`. */
  const targetsOf = (r: RemoteEntry) => (selected.has(r.path) ? selectedRows : [r]);

  // ── operations ──
  const refocus = () => requestAnimationFrame(() => listRef.current?.focus({ preventScroll: true }));

  const newFolder = async () => {
    const name = await ui.prompt("New folder", "", { label: "Name", okLabel: "Create" });
    refocus();
    const n = name?.trim();
    if (!n) return;
    const bad = badName(n);
    if (bad) return ui.toast(bad, "error");
    const p = rjoin(dir, n);
    try {
      await ipc.sftpMkdir(pane.id, p);
      pendingSelect.current = p;
      await load(true);
    } catch (e) {
      toastErr(e);
    }
  };

  const rename = async (r: RemoteEntry) => {
    const name = await ui.prompt(`Rename "${r.name}"`, r.name, { label: "New name", okLabel: "Rename" });
    refocus();
    const n = name?.trim();
    if (!n || n === r.name) return;
    const bad = badName(n);
    if (bad) return ui.toast(bad, "error");
    const to = rjoin(rdirname(r.path), n);
    try {
      await ipc.sftpRename(pane.id, r.path, to);
      pendingSelect.current = to;
      await load(true);
    } catch (e) {
      toastErr(e);
    }
  };

  const remove = async (list: RemoteEntry[]) => {
    if (!list.length) return;
    const folders = list.some((x) => x.isDir && !x.isLink);
    const names = list
      .slice(0, 12)
      .map((x) => `  ${x.name}${x.isDir ? "/" : ""}`)
      .join("\n");
    const more = list.length > 12 ? `\n  …and ${list.length - 12} more` : "";
    const ok = await ui.confirm(
      list.length === 1 ? `Delete "${list[0].name}"?` : `Delete ${list.length} items?`,
      `${names}${more}\n\n${folders ? "Folders are deleted with everything in them. " : ""}This deletes them on ${hostName} for good: there's no Recycle Bin there.`,
      { okLabel: "Delete", danger: true },
    );
    refocus();
    if (!ok) return;
    const gone = new Set(list.map((x) => x.path));
    const at = rows.findIndex((x) => gone.has(x.path));
    const next = rows.slice(at).find((x) => !gone.has(x.path)) ?? rows.slice(0, Math.max(0, at)).reverse().find((x) => !gone.has(x.path));
    try {
      await ipc.sftpDelete(pane.id, [...gone]);
      if (next) pendingSelect.current = next.path;
      ui.toast(list.length === 1 ? `Deleted "${list[0].name}"` : `Deleted ${list.length} items`, "success", 2200);
    } catch (e) {
      toastErr(e);
    }
    // (also after a partial failure: some may be gone)
    await load(true);
  };

  const upload = async (folders: boolean) => {
    const picked = await openDialog({ multiple: true, directory: folders, title: `Upload ${folders ? "folders" : "files"} to ${dir}` }).catch(() => null);
    refocus();
    const paths = Array.isArray(picked) ? picked : typeof picked === "string" ? [picked] : [];
    if (paths.length) await uploadInto(pane.id, dir, paths);
  };

  const openTerminal = () => connectHost({ id: hostId, name: hostName }, { tabId, near: pane.id });

  // ── menus ──
  const rowMenu = (ev: React.MouseEvent, r: RemoteEntry) => {
    ev.preventDefault();
    ev.stopPropagation();
    if (!selected.has(r.path)) selectOnly(r.path);
    else setCursor(r.path);
    const list = targetsOf(r);
    const many = list.length > 1;
    const items: MenuItem[] = [
      ...(r.isDir && !many ? [{ label: "Open", icon: "folder-open", shortcut: "Enter", onSelect: () => navigate(r.path) }] : []),
      { label: many ? `Download ${list.length} items…` : "Download…", icon: "download", shortcut: r.isDir ? undefined : "Enter", onSelect: () => void downloadTo(pane.id, list) },
      { type: "separator" },
      { label: "Rename…", icon: "pencil", disabled: many, onSelect: () => rename(r) },
      { label: many ? `Delete ${list.length} items…` : "Delete…", icon: "trash", shortcut: "Del", danger: true, onSelect: () => remove(list) },
      { type: "separator" },
      { label: many ? "Copy paths" : "Copy path", icon: "copy", shortcut: "Ctrl+C", onSelect: () => copyText(list.map((x) => x.path).join("\n"), many ? "Paths" : "Path") },
      { label: "Copy name", icon: "clipboard-copy", disabled: many, onSelect: () => copyText(r.name, "Name") },
      { type: "separator" },
      { label: "New folder…", icon: "folder-plus", onSelect: newFolder },
      { label: "Upload files…", icon: "file-up", onSelect: () => upload(false) },
      { label: "Upload folder…", icon: "folder-up", onSelect: () => upload(true) },
    ];
    ui.openMenu(ev, items);
  };

  const areaMenu = (ev: React.MouseEvent) => {
    ev.preventDefault();
    ui.openMenu(ev, [
      { label: "New folder…", icon: "folder-plus", onSelect: newFolder },
      { label: "Upload files…", icon: "file-up", onSelect: () => upload(false) },
      { label: "Upload folder…", icon: "folder-up", onSelect: () => upload(true) },
      { type: "separator" },
      { label: "Refresh", icon: "refresh", shortcut: "F5", onSelect: () => load() },
      { label: "Copy path", icon: "copy", onSelect: () => copyText(dir) },
      { label: "Open SSH terminal", icon: "square-terminal", onSelect: openTerminal },
    ]);
  };

  const hostMenu = (ev: React.MouseEvent) => {
    const r = (ev.currentTarget as HTMLElement).getBoundingClientRect();
    ui.openMenu({ x: r.left, y: r.bottom + 4 }, [
      { type: "header", label: hostName },
      { label: "Open SSH terminal", icon: "square-terminal", onSelect: openTerminal },
      { label: "Reconnect", icon: "rotate-cw", onSelect: () => void connect(pane.id, hostId, true) },
      { label: "Choose another host…", icon: "server", onSelect: () => chooseAnotherHost(pane.id) },
    ]);
  };

  const uploadMenu = (ev: React.MouseEvent) => {
    const r = (ev.currentTarget as HTMLElement).getBoundingClientRect();
    ui.openMenu({ x: r.left, y: r.bottom + 4 }, [
      { label: "Upload files…", icon: "file-up", onSelect: () => upload(false) },
      { label: "Upload folder…", icon: "folder-up", onSelect: () => upload(true) },
    ]);
  };

  // ── keyboard ──
  const typeahead = useRef({ text: "", at: 0 });
  const onListKey = (e: React.KeyboardEvent) => {
    const mod = e.ctrlKey || e.metaKey;
    const page = Math.max(1, Math.floor((viewH - HEADER_H) / ROW_H) - 1);
    const move = (to: number) => {
      if (!rows.length) return;
      const i = clamp(to, 0, rows.length - 1);
      const p = rows[i].path;
      if (e.shiftKey && anchor.current) selectRange(anchor.current, p, false);
      else selectOnly(p);
      ensureVisible(i);
    };
    const cur = cursorIndex >= 0 ? rows[cursorIndex] : undefined;
    switch (e.key) {
      case "ArrowDown":
        move(cursorIndex < 0 ? 0 : cursorIndex + 1);
        break;
      case "ArrowUp":
        move(cursorIndex < 0 ? 0 : cursorIndex - 1);
        break;
      case "PageDown":
        move(cursorIndex + page);
        break;
      case "PageUp":
        move(cursorIndex - page);
        break;
      case "Home":
        move(0);
        break;
      case "End":
        move(rows.length - 1);
        break;
      case "Enter":
        if (!cur) return;
        if (selectedRows.length > 1 && selected.has(cur.path)) void downloadTo(pane.id, selectedRows);
        else open(cur);
        break;
      case "Backspace":
        goUp();
        break;
      case "Delete":
        if (!selectedRows.length) return;
        remove(selectedRows);
        break;
      case "F5":
        load();
        break;
      case "Escape":
        if (!selected.size) return;
        setSelected(new Set());
        break;
      default: {
        const k = e.key.toLowerCase();
        if (mod && k === "a") {
          setSelected(new Set(rows.map((r) => r.path)));
          break;
        }
        if (mod && k === "c" && selectedRows.length) {
          copyText(selectedRows.map((r) => r.path).join("\n"), selectedRows.length > 1 ? "Paths" : "Path");
          break;
        }
        if (e.key.length !== 1 || mod || e.altKey) return;
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

  const toggleSort = (key: SortKey) => setSort((s) => (s.key === key ? { key, desc: !s.desc } : { key, desc: key !== "name" }));

  // ── render ──
  const first = Math.max(0, Math.floor(scrollTop / ROW_H) - OVERSCAN);
  const last = Math.min(rows.length, Math.ceil((scrollTop + viewH - HEADER_H) / ROW_H) + OVERSCAN);
  const selSize = selectedRows.reduce((n, r) => n + (r.isDir ? 0 : r.size), 0);

  let listBody: React.ReactNode;
  if (listError) {
    listBody = (
      <ModuleMessage icon="warning" title="Can't open this folder">
        <p className="sftp-error selectable">{listError}</p>
        <p className="dim mono sftp-detail">{dir}</p>
        <div className="row">
          <button className="btn" onClick={() => load()}>
            <Icon name="refresh" size={13} /> Retry
          </button>
          {dir !== home && (
            <button className="btn subtle" onClick={() => navigate(home)}>
              <Icon name="home" size={13} /> Home
            </button>
          )}
          <button className="btn subtle" onClick={() => void connect(pane.id, hostId, true)}>
            <Icon name="plug" size={13} /> Reconnect
          </button>
        </div>
      </ModuleMessage>
    );
  } else if (!entries) {
    listBody = (
      <div className="empty-state">
        <Icon name="loader" size={20} className="sftp-spin" />
      </div>
    );
  } else {
    listBody = (
      <div
        ref={setListEl}
        className="sftp-list"
        tabIndex={0}
        role="listbox"
        aria-label={`Files in ${dir}`}
        aria-multiselectable
        onKeyDown={onListKey}
        onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
        onContextMenu={areaMenu}
        onClick={(e) => e.target === e.currentTarget && setSelected(new Set())}
      >
        <div className="sftp-row sftp-head" style={{ height: HEADER_H }} role="presentation">
          {(
            [
              ["name", "Name"],
              ["size", "Size"],
              ["modified", "Modified"],
            ] as [SortKey, string][]
          ).map(([k, label]) => (
            <button key={k} className={cx("sftp-cell", `sftp-col-${k}`, sort.key === k && "sorted")} onClick={() => toggleSort(k)} title={`Sort by ${label.toLowerCase()}`}>
              {label}
              {sort.key === k && <Icon name={sort.desc ? "chevron-down" : "chevron-up"} size={11} />}
            </button>
          ))}
          <span className="sftp-cell sftp-col-mode">Permissions</span>
        </div>
        <div className="sftp-rows" style={{ height: rows.length * ROW_H }} onClick={(e) => e.target === e.currentTarget && setSelected(new Set())}>
          {rows.slice(first, last).map((r, k) => {
            const i = first + k;
            return (
              <div
                key={r.path}
                role="option"
                aria-selected={selected.has(r.path)}
                className={cx("sftp-row", selected.has(r.path) && "selected", cursor === r.path && "cursor")}
                style={{ top: i * ROW_H, height: ROW_H }}
                onClick={(e) => clickRow(e, r)}
                onDoubleClick={() => open(r)}
                onContextMenu={(e) => rowMenu(e, r)}
                title={r.isLink ? `${r.name} (link)` : r.name}
              >
                <span className="sftp-cell sftp-col-name">
                  <Icon name={entryIcon(r)} size={15} className={cx("sftp-icon", r.isDir && "dir")} />
                  <span className="ellipsis">{r.name}</span>
                  {r.isLink && <Icon name="share" size={10} className="dim" />}
                </span>
                <span className="sftp-cell sftp-col-size">{r.isDir ? "" : formatBytes(r.size)}</span>
                <span className="sftp-cell sftp-col-modified">{formatDate(r.modified)}</span>
                <span className="sftp-cell sftp-col-mode">{r.mode}</span>
              </div>
            );
          })}
        </div>
        {rows.length === 0 && <div className="sftp-empty dim">This folder is empty. Upload files with the upload button, or drop them here.</div>}
      </div>
    );
  }

  return (
    <div className="module sftp" ref={rootRef}>
      <div className="toolbar sftp-toolbar">
        <button className="sftp-host" title={`${hostName} — connection options`} onClick={hostMenu}>
          <Icon name="server" size={13} />
          <span>{hostName}</span>
          <Icon name="chevron-down" size={12} className="dim" />
        </button>
        <button className="icon-btn" title="Up (Backspace)" disabled={dir === "/"} onClick={goUp}>
          <Icon name="arrow-up" size={15} />
        </button>
        <button className="icon-btn" title={`Home (${home})`} disabled={dir === home} onClick={() => navigate(home)}>
          <Icon name="home" size={14} />
        </button>
        <button className="icon-btn" title="Refresh (F5)" onClick={() => load()}>
          <Icon name="refresh" size={14} className={cx(loading && "sftp-spin")} />
        </button>
        <PathBar dir={dir} onNavigate={(p) => navigate(p)} onSubmit={submitPath} />
        <button className="icon-btn" title="New folder" onClick={newFolder}>
          <Icon name="folder-plus" size={15} />
        </button>
        <button className="icon-btn" title="Upload files or a folder here" onClick={uploadMenu}>
          <Icon name="upload" size={15} />
        </button>
        <button
          className="icon-btn"
          title={selectedRows.length ? `Download ${selectedRows.length === 1 ? `"${selectedRows[0].name}"` : plural(selectedRows.length, "item")}…` : "Download (select files first)"}
          disabled={!selectedRows.length}
          onClick={() => void downloadTo(pane.id, selectedRows)}
        >
          <Icon name="download" size={15} />
        </button>
        <button className="icon-btn close" title="Delete (Del)" disabled={!selectedRows.length} onClick={() => remove(selectedRows)}>
          <Icon name="trash" size={14} />
        </button>
      </div>

      <div className="sftp-main">{listBody}</div>

      <Transfers paneId={pane.id} />

      <div className="module-footer">
        {entries ? (
          <>
            <span>{plural(entries.length, "item")}</span>
            {selectedRows.length > 0 && (
              <span className="sftp-footer-sel">
                {selectedRows.length} selected{selSize ? ` · ${formatBytes(selSize)}` : ""}
              </span>
            )}
          </>
        ) : (
          <span>{listError ? "Error" : "Loading…"}</span>
        )}
        <span className="grow" />
        <span className="ellipsis mono" title={dir}>
          {hostName}:{dir}
        </span>
      </div>
    </div>
  );
}

// ── path bar ────────────────────────────────────────────────────────────

function PathBar({ dir, onNavigate, onSubmit }: { dir: string; onNavigate: (p: string) => void; onSubmit: (p: string) => Promise<boolean> }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    if (ref.current) ref.current.scrollLeft = ref.current.scrollWidth;
  }, [dir, editing]);

  const startEdit = () => {
    setValue(dir);
    setEditing(true);
  };

  if (editing) {
    return (
      <input
        className="input mono sftp-path-input"
        autoFocus
        spellCheck={false}
        value={value}
        disabled={busy}
        placeholder="Type a folder path (~ is home) and press Enter"
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

  const parts = rcrumbs(dir);
  return (
    <div className="sftp-path" ref={ref} onClick={(e) => e.target === e.currentTarget && startEdit()} title="Click an empty spot to type a path">
      {parts.map((c, i) => (
        <Fragment key={c.path}>
          {i > 0 && <Icon name="chevron-right" size={12} className="sftp-crumb-sep" />}
          <button className={cx("sftp-crumb", i === parts.length - 1 && "current")} onClick={() => onNavigate(c.path)} title={c.path}>
            {c.label}
          </button>
        </Fragment>
      ))}
      <span className="sftp-path-fill" onClick={startEdit} />
    </div>
  );
}

// ── transfers ───────────────────────────────────────────────────────────

function Transfers({ paneId }: { paneId: Id }) {
  const list = useTransfers((s) => s[paneId]);
  if (!list?.length) return null;
  const finished = list.filter((t) => !isRunning(t));
  return (
    <div className="sftp-transfers" aria-label="Transfers">
      {list.map((t) => {
        const running = isRunning(t);
        const pct = t.state === "done" ? 100 : t.total ? Math.min(100, (t.done / t.total) * 100) : 0;
        const what = t.kind === "upload" ? `Upload ${plural(t.count, "item")} to ${t.target}` : `Download ${plural(t.count, "item")} to ${t.target}`;
        let status: string;
        if (t.state === "starting") status = "Preparing…";
        else if (t.state === "running") status = `${formatBytes(t.done)} of ${formatBytes(t.total)}${t.file ? ` · ${t.file}` : ""}`;
        else if (t.state === "done") status = `Done · ${plural(t.files, "file")}${t.skipped ? `, ${t.skipped} skipped` : ""}`;
        else if (t.state === "cancelled") status = t.kind === "upload" ? "Cancelled (a file being sent may be incomplete)" : "Cancelled";
        else status = t.message ?? "Failed";
        return (
          <div key={t.key} className={cx("sftp-transfer", t.state)}>
            <Icon name={t.kind === "upload" ? "upload" : "download"} size={14} className="sftp-transfer-icon" />
            <div className="sftp-transfer-main">
              <div className="sftp-transfer-line">
                <span className="ellipsis" title={what}>
                  {what}
                </span>
                <span className="sftp-transfer-status ellipsis" title={status}>
                  {status}
                </span>
              </div>
              <div className={cx("sftp-progress", t.state === "starting" && "indeterminate")}>
                <span style={{ width: `${pct}%` }} />
              </div>
            </div>
            {t.kind === "download" && t.state === "done" && (
              <button className="icon-btn" title="Open the folder" onClick={() => openPath(t.target).catch(toastErr)}>
                <Icon name="folder-open" size={13} />
              </button>
            )}
            {running ? (
              <button className="icon-btn close" title={t.cancelRequested ? "Cancelling…" : "Cancel"} disabled={t.cancelRequested} onClick={() => cancelTransfer(paneId, t)}>
                <Icon name="x" size={13} />
              </button>
            ) : (
              <button className="icon-btn" title="Dismiss" onClick={() => removeTransfer(paneId, t.key)}>
                <Icon name="x" size={13} />
              </button>
            )}
          </div>
        );
      })}
      {finished.length > 1 && (
        <div className="sftp-transfers-foot">
          <button className="btn small subtle" onClick={() => finished.forEach((t) => removeTransfer(paneId, t.key))}>
            Clear finished
          </button>
        </div>
      )}
    </div>
  );
}

// ── module ──────────────────────────────────────────────────────────────

export const sftpModule: ModuleDef = {
  id: "sftp",
  name: "SFTP",
  icon: "folder-sync",
  description: "Browse and transfer files on a saved SSH host",
  component: SftpPane,
  title: (pane, rt) => {
    const name = typeof pane.meta.hostName === "string" ? pane.meta.hostName : "";
    if (!pane.meta.hostId || !name) return "SFTP";
    return rt.title ? `${name} (sftp) — ${rt.title}` : `${name} (sftp)`;
  },
  menu: (pane, tabId) => {
    const hostId = typeof pane.meta.hostId === "string" ? pane.meta.hostId : "";
    if (!hostId) return [];
    return [
      { label: "Reconnect", icon: "rotate-cw", onSelect: () => void connect(pane.id, hostId, true) },
      { label: "Open SSH terminal", icon: "square-terminal", onSelect: () => connectHost({ id: hostId, name: pane.meta.hostName ?? "" }, { tabId, near: pane.id }) },
      { label: "Choose another host…", icon: "server", onSelect: () => chooseAnotherHost(pane.id) },
    ];
  },
  onRemove: (paneId) => forgetPane(paneId),
};
