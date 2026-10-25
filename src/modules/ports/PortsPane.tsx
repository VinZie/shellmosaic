// Network sockets: listening ports and connections with their owning process.
import { openUrl } from "@tauri-apps/plugin-opener";
import { useMemo, useRef, useState, type ReactNode } from "react";
import { Icon } from "../../lib/icons";
import { errorText, ipc, type SocketInfo } from "../../lib/ipc";
import { cx } from "../../lib/util";
import { addModule, openWebPane, setPaneMeta } from "../../state/actions";
import type { Pane } from "../../state/model";
import { settings, useSettings } from "../../state/settings";
import { ui, type MenuItem } from "../../state/ui";
import { DataTable, ModuleMessage, SearchBox, useInterval, type Column } from "../common";
import { confirmEndProcess, copyText, usePaneFilter } from "../processes/procActions";
import type { ModuleDef, ModuleProps } from "../registry";
import "./ports.css";

interface Row extends SocketInfo {
  key: string;
}

type Proto = "all" | "tcp" | "udp";
const PROTOS: Proto[] = ["all", "tcp", "udp"];

const isListening = (s: SocketInfo) => s.proto === "UDP" || s.state === "Listen";
const isWildcard = (a?: string | null) => !a || a === "0.0.0.0" || a === "::";

/** `addr:port`, bracketing IPv6 addresses. */
function hostPort(addr: string, port: number | null | undefined): string {
  const host = addr.includes(":") ? `[${addr}]` : addr;
  return port == null ? host : `${host}:${port}`;
}

/** URL to open a local port in a browser. */
function localUrl(s: SocketInfo): string {
  const a = s.localAddr;
  const local = isWildcard(a) || a.startsWith("127.") || a === "::1";
  return `http://${local ? "localhost" : hostPort(a, null)}:${s.localPort}`;
}

function remoteText(s: SocketInfo): string | null {
  if (s.proto === "UDP" || !s.remoteAddr) return null;
  if (isWildcard(s.remoteAddr) && !s.remotePort) return null;
  return hostPort(s.remoteAddr, s.remotePort);
}

/** "TimeWait" → "Time Wait" */
const prettyState = (s: string) => s.replace(/([a-z])([A-Z0-9])/g, "$1 $2");

function stateClass(state: string): string {
  if (state === "Listen") return "chip accent";
  if (state === "Established") return "chip ports-chip-ok";
  if (state === "CloseWait") return "chip ports-chip-warn";
  return "chip";
}

function dedupe(list: SocketInfo[]): Row[] {
  const out = new Map<string, Row>();
  for (const s of list) {
    const key = [s.proto, s.localAddr, s.localPort, s.remoteAddr ?? "", s.remotePort ?? "", s.state, s.pid ?? ""].join("|");
    if (!out.has(key)) out.set(key, { ...s, key });
  }
  return [...out.values()];
}

function matcher(q: string): ((r: Row) => boolean) | null {
  const s = q.trim().toLowerCase();
  if (!s) return null;
  // "pid:1234" matches only that process (used by Processes → "Show its ports")
  const pid = s.match(/^pid:\s*(\d+)$/);
  if (pid) return (r) => String(r.pid ?? "") === pid[1];
  const port = s.match(/^port:\s*(\d+)$/);
  if (port) return (r) => String(r.localPort) === port[1] || String(r.remotePort ?? "") === port[1];
  if (/^\d+$/.test(s)) {
    return (r) =>
      String(r.localPort).startsWith(s) ||
      String(r.pid ?? "") === s ||
      String(r.remotePort ?? "") === s ||
      r.localAddr.startsWith(s) ||
      (r.remoteAddr ?? "").startsWith(s);
  }
  return (r) =>
    hostPort(r.localAddr, r.localPort).toLowerCase().includes(s) ||
    (remoteText(r) ?? "").toLowerCase().includes(s) ||
    (r.process ?? "").toLowerCase().includes(s) ||
    r.state.toLowerCase().includes(s) ||
    r.proto.toLowerCase() === s;
}

function listeningOnlyOf(pane: Pane): boolean {
  return typeof pane.meta.listeningOnly === "boolean" ? pane.meta.listeningOnly : settings().modules.ports.listeningOnly;
}

function PortsPane({ pane, tabId, visible }: ModuleProps) {
  const intervalMs = useSettings((s) => s.settings.modules.ports.intervalMs);
  const defaultListening = useSettings((s) => s.settings.modules.ports.listeningOnly);
  const [sockets, setSockets] = useState<Row[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = usePaneFilter(pane);
  const [selected, setSelected] = useState<string | null>(null);
  const busy = useRef(false);

  const listeningOnly = typeof pane.meta.listeningOnly === "boolean" ? pane.meta.listeningOnly : defaultListening;
  const proto: Proto = PROTOS.includes(pane.meta.proto) ? pane.meta.proto : "all";

  const load = async () => {
    if (busy.current) return;
    busy.current = true;
    try {
      setSockets(dedupe(await ipc.netSockets()));
      setError(null);
    } catch (e) {
      setError(errorText(e));
    } finally {
      busy.current = false;
    }
  };
  useInterval(load, intervalMs, visible);

  const match = useMemo(() => matcher(filter), [filter]);
  const { rows, hiddenByListening } = useMemo(() => {
    const all = sockets ?? [];
    const base = all.filter((s) => (proto === "all" || s.proto.toLowerCase() === proto) && (!match || match(s)));
    const rows = listeningOnly ? base.filter(isListening) : base;
    return { rows, hiddenByListening: base.length - rows.length };
  }, [sockets, proto, match, listeningOnly]);

  const counts = useMemo(() => {
    const all = sockets ?? [];
    return {
      listening: all.filter(isListening).length,
      established: all.filter((s) => s.state === "Established").length,
      total: all.length,
    };
  }, [sockets]);

  const setListening = (v: boolean) => setPaneMeta(pane.id, { listeningOnly: v });

  const rowMenu = (r: Row, e: React.MouseEvent) => {
    const url = localUrl(r);
    const tcp = r.proto === "TCP";
    const remote = remoteText(r);
    const canKill = !!r.pid && r.pid > 4;
    const items: MenuItem[] = [
      { label: "Open in web pane", icon: "panel-right", hint: url.replace("http://", ""), disabled: !tcp, onSelect: () => openWebPane(url, pane.id) },
      {
        label: "Open in browser",
        icon: "external-link",
        disabled: !tcp,
        onSelect: () => openUrl(url).catch((err) => ui.toast(errorText(err), "error")),
      },
      { type: "separator" },
      { label: `Copy ${hostPort(r.localAddr, r.localPort)}`, icon: "copy", onSelect: () => copyText(hostPort(r.localAddr, r.localPort), "address") },
      ...(remote ? [{ label: `Copy ${remote}`, icon: "clipboard-copy", onSelect: () => copyText(remote, "remote address") } as MenuItem] : []),
      { type: "separator" },
      {
        label: "Show in Processes",
        icon: "list-tree",
        disabled: !r.pid,
        onSelect: () => addModule("processes", { tabId, target: pane.id, side: "right", meta: { filter: `pid:${r.pid}` } }),
      },
      {
        label: "Kill owning process",
        icon: "skull",
        danger: true,
        disabled: !canKill,
        hint: r.pid ? `PID ${r.pid}` : undefined,
        onSelect: async () => {
          if (r.pid && (await confirmEndProcess({ pid: r.pid, name: r.process }))) load();
        },
      },
    ];
    ui.openMenu(e, items);
  };

  const columns: Column<Row>[] = [
    { key: "proto", label: "Proto", width: 58, render: (r) => <span className="dim">{r.proto}</span> },
    { key: "localAddr", label: "Local address", render: (r) => <span className="mono ports-addr">{r.localAddr}</span> },
    { key: "localPort", label: "Port", num: true, width: 64, render: (r) => <span className="ports-port">{r.localPort}</span> },
    {
      key: "remote",
      label: "Remote",
      value: (r) => remoteText(r) ?? "",
      render: (r) => {
        const t = remoteText(r);
        return t ? <span className="mono ports-addr">{t}</span> : <span className="dim">—</span>;
      },
    },
    {
      key: "state",
      label: "State",
      width: 104,
      value: (r) => (r.proto === "UDP" ? "~" : r.state),
      render: (r) => (r.state ? <span className={stateClass(r.state)}>{prettyState(r.state)}</span> : <span className="dim">—</span>),
    },
    { key: "pid", label: "PID", num: true, width: 70, value: (r) => r.pid ?? -1, render: (r) => <span className="dim">{r.pid ?? "—"}</span> },
    {
      key: "process",
      label: "Process",
      value: (r) => (r.process ?? "").toLowerCase(),
      render: (r) => (r.process ? <span>{r.process}</span> : <span className="dim">{r.pid === 4 ? "System" : "—"}</span>),
    },
  ];

  let empty: ReactNode = "No sockets";
  if (filter || proto !== "all" || listeningOnly) {
    empty = (
      <>
        <span>{filter ? `Nothing matches “${filter}”` : listeningOnly ? "No listening sockets" : "No sockets"}</span>
        {listeningOnly && hiddenByListening > 0 && (
          <button className="btn" onClick={() => setListening(false)}>
            Show {hiddenByListening} other connection{hiddenByListening === 1 ? "" : "s"}
          </button>
        )}
      </>
    );
  }

  let body: ReactNode;
  if (!sockets) {
    body = error ? (
      <ModuleMessage icon="warning" title="Couldn't read network sockets">
        <p className="dim">{error}</p>
        <div className="row">
          <button className="btn" onClick={load}>
            Retry
          </button>
        </div>
      </ModuleMessage>
    ) : (
      <ModuleMessage icon="loader" title="Reading sockets…" />
    );
  } else {
    body = (
      <DataTable
        columns={columns}
        rows={rows}
        rowKey={(r) => r.key}
        selected={selected}
        onSelect={(r) => setSelected(r.key)}
        onOpen={(r) => r.proto === "TCP" && r.state === "Listen" && openWebPane(localUrl(r), pane.id)}
        onRowMenu={rowMenu}
        initialSort={{ key: "localPort" }}
        empty={empty}
      />
    );
  }

  return (
    <div className="module ports">
      <div className="toolbar ports-toolbar">
        <SearchBox value={filter} onChange={setFilter} placeholder="Port, process, address or PID" />
        <div className="segmented">
          {PROTOS.map((p) => (
            <button key={p} className={cx(proto === p && "on")} onClick={() => setPaneMeta(pane.id, { proto: p === "all" ? null : p })}>
              {p === "all" ? "All" : p.toUpperCase()}
            </button>
          ))}
        </div>
        <label className="ports-toggle" title="Only TCP sockets in the Listen state, plus all UDP sockets">
          <button
            role="switch"
            aria-checked={listeningOnly}
            className={cx("switch", listeningOnly && "on")}
            onClick={() => setListening(!listeningOnly)}
          />
          <span>Listening only</span>
        </label>
        <div className="grow" />
        <button className="icon-btn" title="Refresh now" onClick={load}>
          <Icon name="refresh" size={14} />
        </button>
      </div>
      {body}
      <div className="module-footer">
        <span>
          <b className="ports-count accent">{counts.listening}</b> listening
        </span>
        <span>·</span>
        <span>
          <b className="ports-count ok">{counts.established}</b> established
        </span>
        <span>·</span>
        <span>{counts.total} total</span>
        {sockets && rows.length !== counts.total && (
          <>
            <span>·</span>
            <span>{rows.length} shown</span>
          </>
        )}
        <div className="grow" />
        {error && sockets && (
          <span className="danger-text ellipsis" title={error}>
            {error}
          </span>
        )}
      </div>
    </div>
  );
}

export const portsModule: ModuleDef = {
  id: "ports",
  name: "Ports",
  icon: "network",
  description: "Listening ports and connections",
  component: PortsPane,
  menu: (pane) => [
    {
      label: "Listening only",
      checked: listeningOnlyOf(pane),
      onSelect: () => setPaneMeta(pane.id, { listeningOnly: !listeningOnlyOf(pane) }),
    },
  ],
};
