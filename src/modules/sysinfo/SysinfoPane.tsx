// System overview: CPU, memory, network, disks and host info as live cards.
import { useRef, useState, type ReactNode } from "react";
import { Icon } from "../../lib/icons";
import { errorText, ipc, type SysSnapshot } from "../../lib/ipc";
import { clamp, cx, formatBytes, formatDuration } from "../../lib/util";
import { setPaneMeta } from "../../state/actions";
import { paneMenu } from "../../state/menus";
import type { Pane } from "../../state/model";
import { useSettings } from "../../state/settings";
import { ui, type MenuItem } from "../../state/ui";
import { ModuleMessage, useInterval } from "../common";
import type { ModuleDef, ModuleProps } from "../registry";
import { Chart } from "./Chart";
import "./sysinfo.css";

const HISTORY = 120;
const DISKS_EVERY_MS = 10_000;

const CARDS = [
  { id: "cpu", name: "CPU" },
  { id: "memory", name: "Memory" },
  { id: "network", name: "Network" },
  { id: "disks", name: "Disks" },
  { id: "system", name: "System" },
] as const;

type Disk = SysSnapshot["disks"][number];

interface History {
  cpu: number[];
  mem: number[];
  rx: number[];
  tx: number[];
  snap: SysSnapshot | null;
  disks: Disk[] | null;
  disksAt: number;
}

/** Samples per pane, kept outside React so graphs survive tab switches and remounts. */
const histories = new Map<string, History>();

function historyFor(paneId: string): History {
  let h = histories.get(paneId);
  if (!h) {
    h = { cpu: [], mem: [], rx: [], tx: [], snap: null, disks: null, disksAt: 0 };
    histories.set(paneId, h);
  }
  return h;
}

function push(arr: number[], v: number) {
  arr.push(Number.isFinite(v) ? v : 0);
  if (arr.length > HISTORY) arr.splice(0, arr.length - HISTORY);
}

function record(h: History, s: SysSnapshot, withDisks: boolean) {
  h.snap = s;
  push(h.cpu, s.cpu);
  push(h.mem, s.memTotal ? (s.memUsed / s.memTotal) * 100 : 0);
  push(h.rx, s.netRx);
  push(h.tx, s.netTx);
  if (withDisks) {
    h.disks = [...s.disks].sort((a, b) => a.mount.localeCompare(b.mount));
    h.disksAt = Date.now();
  }
}

/** Round a byte rate up to 1/2/5 × 1024ⁿ so the axis label reads cleanly. */
function niceRate(v: number): number {
  const floor = 1024;
  if (v <= floor) return floor;
  let unit = 1;
  while (v / unit >= 1024) unit *= 1024;
  for (const m of [1, 2, 5, 10, 20, 50, 100, 200, 500, 1024]) if (m * unit >= v) return m * unit;
  return v;
}

const pct = (v: number) => `${Math.round(clamp(v, 0, 100))}%`;
const rate = (v: number) => `${formatBytes(v)}/s`;

function usageLevel(p: number): string | undefined {
  if (p >= 90) return "danger";
  if (p >= 75) return "warning";
  return undefined;
}

function Card({ icon, title, value, sub, children }: { icon: string; title: string; value?: ReactNode; sub?: ReactNode; children?: ReactNode }) {
  return (
    <section className="card sysinfo-card">
      <header className="sysinfo-card-head">
        <Icon name={icon} size={14} className="sysinfo-card-icon" />
        <span className="sysinfo-card-title">{title}</span>
        {sub && <span className="sysinfo-card-sub dim ellipsis">{sub}</span>}
        {value !== undefined && <span className="sysinfo-big">{value}</span>}
      </header>
      {children}
    </section>
  );
}

function Meter({ value, level }: { value: number; level?: string }) {
  return (
    <div className="sysinfo-meter">
      <div className={cx("sysinfo-meter-fill", level)} style={{ width: `${clamp(value, 0, 100)}%` }} />
    </div>
  );
}

function CpuCard({ h, perCore }: { h: History; perCore: boolean }) {
  const s = h.snap!;
  return (
    <Card icon="cpu" title="CPU" sub={`${s.cores.length} logical cores`} value={pct(s.cpu)}>
      <Chart series={[{ data: h.cpu, color: "--accent" }]} max={100} capacity={HISTORY}>
        <span className="sysinfo-axis">100%</span>
      </Chart>
      {perCore && s.cores.length > 0 && (
        <div className="sysinfo-cores" style={{ gridTemplateColumns: `repeat(${Math.min(s.cores.length, 32)}, minmax(0, 1fr))` }}>
          {s.cores.map((c, i) => (
            <div key={i} className="sysinfo-core" title={`Core ${i}: ${c.toFixed(0)}%`}>
              <div className={cx("sysinfo-core-fill", usageLevel(c))} style={{ height: `${clamp(c, 0, 100)}%` }} />
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

function MemoryCard({ h }: { h: History }) {
  const s = h.snap!;
  const memPct = s.memTotal ? (s.memUsed / s.memTotal) * 100 : 0;
  const swapPct = s.swapTotal ? (s.swapUsed / s.swapTotal) * 100 : 0;
  return (
    <Card icon="memory" title="Memory" sub={`${formatBytes(s.memUsed)} of ${formatBytes(s.memTotal)}`} value={pct(memPct)}>
      <Chart series={[{ data: h.mem, color: "--accent" }]} max={100} capacity={HISTORY}>
        <span className="sysinfo-axis">100%</span>
      </Chart>
      <div className="sysinfo-row">
        <span className="sysinfo-label">Swap</span>
        {s.swapTotal ? (
          <>
            <Meter value={swapPct} level={usageLevel(swapPct)} />
            <span className="sysinfo-num">
              {formatBytes(s.swapUsed)} / {formatBytes(s.swapTotal)}
            </span>
          </>
        ) : (
          <span className="dim">none</span>
        )}
      </div>
    </Card>
  );
}

function NetworkCard({ h }: { h: History }) {
  const s = h.snap!;
  const top = niceRate(Math.max(0, ...h.rx, ...h.tx) * 1.1);
  return (
    <Card icon="network" title="Network">
      <div className="sysinfo-net-rates">
        <span className="sysinfo-net-rate">
          <span className="sysinfo-dot rx" />
          <Icon name="download" size={12} className="dim" />
          <span className="sysinfo-num">{rate(s.netRx)}</span>
        </span>
        <span className="sysinfo-net-rate">
          <span className="sysinfo-dot tx" />
          <Icon name="upload" size={12} className="dim" />
          <span className="sysinfo-num">{rate(s.netTx)}</span>
        </span>
      </div>
      <Chart
        series={[
          { data: h.rx, color: "--accent" },
          { data: h.tx, color: "--success" },
        ]}
        max={top}
        capacity={HISTORY}
        fillAlpha={0.24}
      >
        <span className="sysinfo-axis">{formatBytes(top, 0)}/s</span>
      </Chart>
    </Card>
  );
}

function DisksCard({ h }: { h: History }) {
  const disks = h.disks;
  return (
    <Card icon="hard-drive" title="Disks" sub={disks ? `${disks.length} volume${disks.length === 1 ? "" : "s"}` : undefined}>
      {!disks ? (
        <div className="dim">Reading drives…</div>
      ) : !disks.length ? (
        <div className="dim">No drives reported</div>
      ) : (
        <div className="sysinfo-disks">
          {disks.map((d) => {
            const used = d.total - d.available;
            const p = d.total ? (used / d.total) * 100 : 0;
            return (
              <div key={d.mount + d.name} className="sysinfo-disk" title={`${d.name || d.mount} — ${formatBytes(used)} used`}>
                <div className="sysinfo-disk-head">
                  <span className="sysinfo-disk-mount">{d.mount}</span>
                  {d.name && <span className="dim ellipsis">{d.name}</span>}
                  {d.fs && <span className="chip">{d.fs}</span>}
                  <span className="sysinfo-num sysinfo-push">{pct(p)}</span>
                </div>
                <Meter value={p} level={usageLevel(p)} />
                <div className="sysinfo-disk-foot dim">
                  {formatBytes(d.available)} free of {formatBytes(d.total)}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </Card>
  );
}

function SystemCard({ h }: { h: History }) {
  const s = h.snap!;
  const rows: [string, string][] = [
    ["Host", s.host || "—"],
    ["OS", s.os || "—"],
    ["CPU", s.cpuBrand || "—"],
    ["Cores", String(s.cores.length)],
    ["Uptime", formatDuration(s.uptime)],
    ["Processes", String(s.processCount)],
  ];
  return (
    <Card icon="monitor" title="System">
      <dl className="sysinfo-kv">
        {rows.map(([k, v]) => (
          <div key={k}>
            <dt className="dim">{k}</dt>
            <dd className="ellipsis selectable" title={v}>
              {v}
            </dd>
          </div>
        ))}
      </dl>
    </Card>
  );
}

function SysinfoPane({ pane, visible }: ModuleProps) {
  const intervalMs = useSettings((s) => s.settings.modules.sysinfo.intervalMs);
  const h = historyFor(pane.id);
  const [, setTick] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const busy = useRef(false);

  useInterval(
    async () => {
      if (busy.current) return;
      busy.current = true;
      const withDisks = !h.disks || Date.now() - h.disksAt >= DISKS_EVERY_MS;
      try {
        const snap = await ipc.sysSnapshot(withDisks);
        record(h, snap, withDisks);
        setError(null);
        setTick((t) => t + 1);
      } catch (e) {
        setError(errorText(e));
      } finally {
        busy.current = false;
      }
    },
    intervalMs,
    visible,
  );

  const hidden: string[] = Array.isArray(pane.meta.hidden) ? pane.meta.hidden : [];
  const perCore = pane.meta.perCore !== false;
  const show = (id: string) => !hidden.includes(id);

  const onContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    ui.openMenu(e, paneMenu(pane.id));
  };

  let body: ReactNode;
  if (!h.snap) {
    body = error ? (
      <ModuleMessage icon="warning" title="Couldn't read system stats">
        <p className="dim">{error}</p>
      </ModuleMessage>
    ) : (
      <ModuleMessage icon="loader" title="Reading system stats…" />
    );
  } else if (CARDS.every((c) => !show(c.id))) {
    body = (
      <ModuleMessage icon="eye-off" title="All cards are hidden">
        <button className="btn" onClick={() => setPaneMeta(pane.id, { hidden: [] })}>
          Show all cards
        </button>
      </ModuleMessage>
    );
  } else {
    body = (
      <div className="module-scroll">
        <div className="sysinfo-grid">
          {show("cpu") && <CpuCard h={h} perCore={perCore} />}
          {show("memory") && <MemoryCard h={h} />}
          {show("network") && <NetworkCard h={h} />}
          {show("disks") && <DisksCard h={h} />}
          {show("system") && <SystemCard h={h} />}
        </div>
        {error && (
          <div className="sysinfo-error">
            <Icon name="warning" size={12} /> {error}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="module sysinfo" onContextMenu={onContextMenu}>
      {body}
    </div>
  );
}

function sysinfoMenu(pane: Pane): MenuItem[] {
  const hidden: string[] = Array.isArray(pane.meta.hidden) ? pane.meta.hidden : [];
  const toggle = (id: string) =>
    setPaneMeta(pane.id, { hidden: hidden.includes(id) ? hidden.filter((x) => x !== id) : [...hidden, id] });
  return [
    {
      label: "Per-core bars",
      checked: pane.meta.perCore !== false,
      onSelect: () => setPaneMeta(pane.id, { perCore: pane.meta.perCore === false }),
    },
    {
      label: "Cards",
      icon: "layout-grid",
      submenu: [
        ...CARDS.map<MenuItem>((c) => ({ label: c.name, checked: !hidden.includes(c.id), onSelect: () => toggle(c.id) })),
        { type: "separator" },
        { label: "Show all", icon: "eye", disabled: !hidden.length, onSelect: () => setPaneMeta(pane.id, { hidden: [] }) },
      ],
    },
  ];
}

export const sysinfoModule: ModuleDef = {
  id: "sysinfo",
  name: "Sysinfo",
  icon: "chart-line",
  description: "CPU, memory, network and disk",
  component: SysinfoPane,
  menu: (pane) => sysinfoMenu(pane),
  onRemove: (paneId) => {
    histories.delete(paneId);
  },
};
