// System overview: CPU, memory, network, disks and host info as live cards.
import { useRef, useState, type CSSProperties, type ReactNode } from "react";
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
/** sizes read better without a trailing ".0" ("32 GB", "14.6 GB") */
const size = (v: number) => formatBytes(v).replace(".0 ", " ");

/** "14.6 GB" → value and unit, so the unit can be set smaller than the number. */
function split(text: string): { value: string; unit: string } {
  const i = text.lastIndexOf(" ");
  return i < 0 ? { value: text, unit: "" } : { value: text.slice(0, i), unit: text.slice(i + 1) };
}

function usageLevel(p: number): string | undefined {
  if (p >= 90) return "danger";
  if (p >= 75) return "warning";
  return undefined;
}

function coresText(s: SysSnapshot): string {
  const n = s.cores.length;
  return s.physicalCores ? `${s.physicalCores} cores · ${n} logical` : `${n} logical cores`;
}

function Card({ icon, title, meta, className, children }: { icon: string; title: string; meta?: string; className?: string; children?: ReactNode }) {
  return (
    <section className={cx("card sysinfo-card", className)}>
      <header className="sysinfo-card-head">
        <Icon name={icon} size={14} className="sysinfo-card-icon" />
        <span className="sysinfo-card-title">{title}</span>
        {meta && (
          <span className="sysinfo-card-meta ellipsis" title={meta}>
            {meta}
          </span>
        )}
      </header>
      {children}
    </section>
  );
}

/** A number with a small unit over a dim label; `big` for the card's headline figure. */
function Stat({ value, unit, label, big, dot }: { value: ReactNode; unit?: string; label: string; big?: boolean; dot?: string }) {
  return (
    <div className={cx("sysinfo-stat", big && "big")}>
      <span className="sysinfo-stat-value">
        {value}
        {unit && <span className="sysinfo-stat-unit">{unit}</span>}
      </span>
      <span className="sysinfo-stat-label">
        {dot && <span className={cx("sysinfo-dot", dot)} />}
        {label}
      </span>
    </div>
  );
}

function Meter({ value, level }: { value: number; level?: string }) {
  return (
    <div className="sysinfo-meter">
      <div className={cx("sysinfo-meter-fill", level)} style={{ width: `${clamp(value, 0, 100)}%` }} />
    </div>
  );
}

/**
 * One bar per logical processor, in even rows of at most 32 (16 in a narrow card).
 * Only saturated cores stand out: one busy thread is normal, not an alarm.
 */
function Cores({ cores }: { cores: number[] }) {
  const n = cores.length;
  const cols = (max: number) => Math.ceil(n / Math.ceil(n / max));
  return (
    <div className="sysinfo-cores" style={{ "--cols": cols(32), "--cols-narrow": cols(16) } as CSSProperties}>
      {cores.map((c, i) => {
        const v = clamp(c, 0, 100);
        return (
          <div key={i} className="sysinfo-core" title={`CPU ${i}: ${Math.round(v)}%`}>
            <div className={cx("sysinfo-core-fill", v >= 90 && "warning")} style={{ transform: `scaleY(${v / 100})` }} />
          </div>
        );
      })}
    </div>
  );
}

function CpuCard({ h, perCore, stepMs }: { h: History; perCore: boolean; stepMs: number }) {
  const s = h.snap!;
  const busiest = s.cores.length ? Math.max(...s.cores) : 0;
  return (
    <Card icon="cpu" title="CPU" meta={coresText(s)} className="sysinfo-wide">
      <div className="sysinfo-stats">
        <Stat big value={Math.round(clamp(s.cpu, 0, 100))} unit="%" label="Utilization" />
        {!!s.cpuFreq && <Stat value={(s.cpuFreq / 1000).toFixed(2)} unit="GHz" label="Clock" />}
        {s.cores.length > 1 && <Stat value={Math.round(clamp(busiest, 0, 100))} unit="%" label="Busiest core" />}
      </div>
      <Chart series={[{ data: h.cpu, color: "--accent" }]} max={100} capacity={HISTORY} stepMs={stepMs} format={pct}>
        <span className="sysinfo-axis">100%</span>
      </Chart>
      {perCore && s.cores.length > 0 && <Cores cores={s.cores} />}
    </Card>
  );
}

function MemoryCard({ h, stepMs }: { h: History; stepMs: number }) {
  const s = h.snap!;
  const memPct = s.memTotal ? (s.memUsed / s.memTotal) * 100 : 0;
  const swapPct = s.swapTotal ? (s.swapUsed / s.swapTotal) * 100 : 0;
  return (
    <Card icon="memory" title="Memory" meta={`${size(s.memTotal)} total`}>
      <div className="sysinfo-stats">
        <Stat big value={Math.round(clamp(memPct, 0, 100))} unit="%" label="In use" />
        <Stat {...split(size(s.memUsed))} label="Used" />
        <Stat {...split(size(Math.max(0, s.memTotal - s.memUsed)))} label="Available" />
      </div>
      <Chart
        series={[{ data: h.mem, color: "--accent" }]}
        max={100}
        capacity={HISTORY}
        stepMs={stepMs}
        format={(v) => `${pct(v)} · ${size((v / 100) * s.memTotal)}`}
      >
        <span className="sysinfo-axis">100%</span>
      </Chart>
      <div className="sysinfo-row">
        <span className="sysinfo-label">Swap</span>
        {s.swapTotal ? (
          <>
            <Meter value={swapPct} level={usageLevel(swapPct)} />
            <span className="sysinfo-num">
              {size(s.swapUsed)} <span className="dim">/ {size(s.swapTotal)}</span>
            </span>
          </>
        ) : (
          <span className="dim">none</span>
        )}
      </div>
    </Card>
  );
}

function NetworkCard({ h, stepMs }: { h: History; stepMs: number }) {
  const s = h.snap!;
  const peakRx = Math.max(0, ...h.rx);
  const peakTx = Math.max(0, ...h.tx);
  const top = niceRate(Math.max(peakRx, peakTx) * 1.1);
  const hasTotals = s.netRxTotal != null && s.netTxTotal != null;
  return (
    <Card icon="network" title="Network">
      <div className="sysinfo-stats">
        <Stat big {...split(rate(s.netRx))} label="Download" dot="rx" />
        <Stat big {...split(rate(s.netTx))} label="Upload" dot="tx" />
      </div>
      <Chart
        series={[
          { data: h.rx, color: "--accent" },
          { data: h.tx, color: "--success" },
        ]}
        max={top}
        capacity={HISTORY}
        stepMs={stepMs}
        format={rate}
        fillAlpha={0.22}
      >
        <span className="sysinfo-axis">{formatBytes(top, 0)}/s</span>
      </Chart>
      <dl className="sysinfo-net-table">
        <dt title="Highest rate in the graph">Peak</dt>
        <dd>
          <span className="sysinfo-arrow rx">↓</span>
          {rate(peakRx)}
        </dd>
        <dd>
          <span className="sysinfo-arrow tx">↑</span>
          {rate(peakTx)}
        </dd>
        {hasTotals && (
          <>
            <dt title="Since the network adapters came up">Total</dt>
            <dd>
              <span className="sysinfo-arrow rx">↓</span>
              {size(s.netRxTotal!)}
            </dd>
            <dd>
              <span className="sysinfo-arrow tx">↑</span>
              {size(s.netTxTotal!)}
            </dd>
          </>
        )}
      </dl>
    </Card>
  );
}

/** "C:\" → "C:" (other mount points stay as they are) */
const driveLabel = (mount: string) => mount.replace(/^([a-z]:)\\$/i, "$1");

function DisksCard({ h }: { h: History }) {
  const disks = h.disks;
  return (
    <Card icon="hard-drive" title="Disks" meta={disks ? `${disks.length} volume${disks.length === 1 ? "" : "s"}` : undefined}>
      {!disks ? (
        <div className="dim">Reading drives…</div>
      ) : !disks.length ? (
        <div className="dim">No drives reported</div>
      ) : (
        <div className="sysinfo-disks">
          {disks.map((d) => {
            const used = d.total - d.available;
            const p = d.total ? (used / d.total) * 100 : 0;
            const level = usageLevel(p);
            return (
              <div key={d.mount + d.name} className="sysinfo-disk" title={`${d.name || d.mount} — ${size(used)} used of ${size(d.total)}`}>
                <div className="sysinfo-disk-head">
                  <span className="sysinfo-disk-mount">{driveLabel(d.mount)}</span>
                  {d.name && <span className="dim ellipsis">{d.name}</span>}
                  {d.fs && <span className="sysinfo-disk-fs">{d.fs}</span>}
                  <span className={cx("sysinfo-disk-pct", level)}>{pct(p)}</span>
                </div>
                <Meter value={p} level={level} />
                <div className="sysinfo-disk-foot">
                  <span>{size(d.available)} free</span>
                  <span>{size(d.total)}</span>
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
  const booted = new Date(Date.now() - s.uptime * 1000).toLocaleString();
  const rows: { icon: string; label: string; value: string; title?: string; extra?: string }[] = [
    { icon: "server", label: "Host", value: s.host || "—" },
    { icon: "app-window", label: "OS", value: s.os || "—" },
    { icon: "cpu", label: "CPU", value: s.cpuBrand || "—" },
    { icon: "layers", label: "Cores", value: coresText(s) },
    { icon: "clock", label: "Uptime", value: formatDuration(s.uptime), title: `Booted ${booted}` },
    {
      icon: "list-tree",
      label: "Processes",
      value: s.processCount.toLocaleString(),
      extra: s.threadCount ? `${s.threadCount.toLocaleString()} threads` : undefined,
    },
  ];
  return (
    <Card icon="monitor" title="System">
      <dl className="sysinfo-kv">
        {rows.map((r) => (
          <div key={r.label}>
            <Icon name={r.icon} size={13} />
            <dt>{r.label}</dt>
            <dd className="ellipsis selectable" title={r.title ?? r.value}>
              {r.value}
              {r.extra && <span className="dim"> · {r.extra}</span>}
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
  // (useInterval never ticks faster than 250 ms)
  const stepMs = Math.max(250, intervalMs);

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
      <>
        {error && (
          <div className="sysinfo-error" title={error}>
            <Icon name="warning" size={12} />
            <span className="ellipsis">{error}</span>
            <span className="sysinfo-error-note">showing the last reading</span>
          </div>
        )}
        <div className="module-scroll">
          <div className="sysinfo-grid">
            {show("cpu") && <CpuCard h={h} perCore={perCore} stepMs={stepMs} />}
            {show("memory") && <MemoryCard h={h} stepMs={stepMs} />}
            {show("network") && <NetworkCard h={h} stepMs={stepMs} />}
            {show("disks") && <DisksCard h={h} />}
            {show("system") && <SystemCard h={h} />}
          </div>
        </div>
      </>
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
  icon: "activity",
  description: "CPU, memory, network and disk",
  component: SysinfoPane,
  menu: (pane) => sysinfoMenu(pane),
  onRemove: (paneId) => {
    histories.delete(paneId);
  },
};
