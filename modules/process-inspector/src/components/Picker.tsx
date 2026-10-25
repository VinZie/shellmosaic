// Choosing the process: a searchable list (name, PID, CPU, memory), recent picks
// first, arrow keys + Enter, and "Enter a PID…" for anything not listed.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Check, Hash, LoaderCircle } from "lucide-react";
import { Button, cx, errorText, formatBytes, natural, prompt, SearchBox, sm, useInterval, type ProcListItem } from "../../../shared";
import type { Recent } from "../lib/util";

interface Entry {
  p: ProcListItem;
  recent: boolean;
}

export function askForPid(): Promise<number | null> {
  return prompt({
    title: "Inspect a process by PID",
    label: "Process ID",
    mono: true,
    okLabel: "Inspect",
    validate: (v) => (!v.trim() ? "" : /^\d{1,10}$/.test(v.trim()) ? null : "A PID is a whole number, like 4812"),
  }).then((v) => (v && /^\d+$/.test(v.trim()) ? Number(v.trim()) : null));
}

export function ProcessPicker({
  currentPid,
  recent,
  onPick,
  inline,
  poll,
}: {
  currentPid: number | null;
  recent: Recent[];
  onPick: (pid: number, name?: string) => void;
  /** fills the pane (nothing chosen yet) instead of sitting in a popover */
  inline?: boolean;
  /** keep the inline list current (while the pane is visible) */
  poll?: boolean;
}) {
  const [procs, setProcs] = useState<ProcListItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [hi, setHi] = useState(0);
  const rowsRef = useRef<HTMLDivElement>(null);

  const load = useCallback(
    () =>
      sm.process.list().then(
        (p) => {
          setProcs(p);
          setError(null);
        },
        (e) => setError(errorText(e)),
      ),
    [],
  );
  // a popover lives for seconds: one list is enough; the inline list stays current
  // (useInterval loads right away when it polls)
  useEffect(() => {
    if (!(inline && poll)) load();
    // once, on open
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useInterval(load, 3000, !!inline && !!poll);

  const entries = useMemo<Entry[]>(() => {
    const list = procs ?? [];
    const s = q.trim().toLowerCase();
    const pidQ = /^(?:pid:\s*)?(\d+)$/.exec(s)?.[1];
    // best first: the exact PID, names starting with the text, names containing it, PIDs, then paths
    const rank = (p: ProcListItem): number => {
      if (!s) return 0;
      const n = p.name.toLowerCase();
      if (pidQ && String(p.pid) === pidQ) return 0;
      if (n.startsWith(s)) return 1;
      if (n.includes(s)) return 2;
      if (pidQ && String(p.pid).startsWith(pidQ)) return 3;
      if (s.length > 2 && p.exe?.toLowerCase().includes(s)) return 4;
      return -1;
    };
    const out: Entry[] = [];
    if (!s) {
      for (const r of recent.slice(0, 5)) {
        const p = list.find((x) => x.pid === r.pid && x.name === r.name);
        if (p) out.push({ p, recent: true });
      }
    }
    const ranked = list.map((p) => [rank(p), p] as const).filter(([r]) => r >= 0);
    ranked.sort((a, b) => a[0] - b[0] || natural(a[1].name, b[1].name) || a[1].pid - b[1].pid);
    for (const [, p] of ranked) out.push({ p, recent: false });
    return out;
  }, [procs, q, recent]);

  useEffect(() => setHi(0), [q]);
  const recentCount = entries.findIndex((e) => !e.recent);
  const firstAll = recentCount < 0 ? entries.length : recentCount;

  const scrollTo = (i: number) => rowsRef.current?.querySelector<HTMLElement>(`[data-i="${i}"]`)?.scrollIntoView({ block: "nearest" });
  const move = (i: number) => {
    const n = Math.max(0, Math.min(entries.length - 1, i));
    setHi(n);
    scrollTo(n);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    const page = 10;
    if (e.key === "ArrowDown") move(hi + 1);
    else if (e.key === "ArrowUp") move(hi - 1);
    else if (e.key === "PageDown") move(hi + page);
    else if (e.key === "PageUp") move(hi - page);
    else if (e.key === "Enter") {
      const it = entries[hi];
      if (it) onPick(it.p.pid, it.p.name);
      else if (/^\d+$/.test(q.trim())) onPick(Number(q.trim()));
    } else return;
    e.preventDefault();
  };

  const enterPid = async () => {
    const pid = await askForPid();
    if (pid !== null) onPick(pid);
  };

  const row = (it: Entry, i: number) => (
    <div
      key={`${it.recent ? "r" : "a"}${it.p.pid}`}
      data-i={i}
      className={cx("pi-prow", i === hi && "hi", it.p.pid === currentPid && "current")}
      onMouseMove={() => hi !== i && setHi(i)}
      onClick={() => onPick(it.p.pid, it.p.name)}
      title={it.p.exe ?? it.p.name}
    >
      <span className="pi-prow-name">
        {it.p.pid === currentPid ? <Check size={12} /> : null}
        <span className="sm-ellipsis">{it.p.name}</span>
      </span>
      <span className="pi-prow-num mono">{it.p.pid}</span>
      <span className="pi-prow-num">{it.p.cpu >= 0.05 ? `${it.p.cpu.toFixed(1)}%` : ""}</span>
      <span className="pi-prow-num">{formatBytes(it.p.mem)}</span>
    </div>
  );

  return (
    <div className={cx("pi-picker", inline && "inline")} onKeyDown={onKeyDown}>
      {inline && <h4>Choose a process to inspect</h4>}
      <SearchBox value={q} onChange={setQ} placeholder="Filter by name, PID or path" autoFocus />
      <div className="pi-prow pi-prow-head">
        <span>Name</span>
        <span className="pi-prow-num">PID</span>
        <span className="pi-prow-num">CPU</span>
        <span className="pi-prow-num">Memory</span>
      </div>
      <div className="pi-picker-rows" ref={rowsRef}>
        {!procs && !error && (
          <div className="pi-picker-note">
            <LoaderCircle size={14} className="sm-spin" /> Listing processes…
          </div>
        )}
        {error && !procs && <div className="pi-picker-note sm-danger-text">Couldn't list processes: {error}</div>}
        {recentCount > 0 && <div className="pi-picker-group">Recent</div>}
        {entries.slice(0, firstAll).map((it, i) => row(it, i))}
        {recentCount > 0 && <div className="pi-picker-group">All processes</div>}
        {entries.slice(firstAll).map((it, i) => row(it, firstAll + i))}
        {procs && entries.length === 0 && (
          <div className="pi-picker-note">
            No process matches “{q}”.
            {/^\d+$/.test(q.trim()) && (
              <Button small onClick={() => onPick(Number(q.trim()))}>
                Inspect PID {q.trim()}
              </Button>
            )}
          </div>
        )}
      </div>
      <div className="pi-picker-foot">
        <Button small kind="subtle" onClick={enterPid}>
          <Hash size={13} /> Enter a PID…
        </Button>
        <span className="sm-grow" />
        {procs && <span className="sm-dim">{q ? `${entries.length - Math.max(0, recentCount)} of ${procs.length}` : `${procs.length} processes`}</span>}
      </div>
    </div>
  );
}
