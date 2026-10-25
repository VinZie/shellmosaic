// Things you can do to the process: suspend/resume, priority, affinity, and the
// links to other modules. Every action refreshes the inspector and says how it went.
import { useState } from "react";
import { Copy, Cpu, FolderOpen, Gauge, Hash, ListTree, Network, Pause, Play, RefreshCw, Terminal } from "lucide-react";
import { Button, copy, errorText, openModal, sm, type MenuItem, type PriorityClass, type ProcOverview } from "../../../shared";
import { maskBits, PRIORITIES, priorityLabel } from "../lib/util";

/** Run an action, toast the outcome, then refresh. */
export async function act(failed: string, done: string, fn: () => Promise<unknown>, after?: () => void): Promise<boolean> {
  let ok = false;
  try {
    const r = await fn();
    if (r === false) throw new Error("Windows refused");
    ok = true;
    sm.ui.notify(done, "success");
  } catch (e) {
    sm.ui.notify(`${failed}: ${errorText(e)}`, "error");
  }
  after?.();
  return ok;
}

export async function reveal(path: string | null | undefined) {
  if (!path) return;
  try {
    await sm.ui.reveal(path);
  } catch (e) {
    sm.ui.notify(`Couldn't open the file location: ${errorText(e)}`, "error");
  }
}

export async function openModule(target: Parameters<typeof sm.ui.openModule>[0]) {
  try {
    await sm.ui.openModule(target);
  } catch (e) {
    sm.ui.notify(errorText(e), "error");
  }
}

export async function suspendProcess(pid: number, name: string, after: () => void) {
  const ok = await sm.ui.confirm(`Suspend ${name} (${pid})?`, "Suspending a process freezes it and anything waiting on it. Resume it from here when you're done.", { okLabel: "Suspend" });
  if (ok) await act(`Couldn't suspend ${name}`, `Suspended ${name} (${pid})`, () => sm.process.suspend(pid), after);
}

export function resumeProcess(pid: number, name: string, after: () => void) {
  return act(`Couldn't resume ${name}`, `Resumed ${name} (${pid})`, () => sm.process.resume(pid), after);
}

async function setPriority(pid: number, name: string, p: PriorityClass, after: () => void) {
  if (p === "realtime") {
    const ok = await sm.ui.confirm(
      "Use realtime priority?",
      `${name} would run ahead of the system's own threads, including input and disk I/O; a busy process at realtime priority can make Windows unresponsive.`,
      { okLabel: "Set realtime", danger: true },
    );
    if (!ok) return;
  }
  await act(`Couldn't change the priority of ${name}`, `${name}: priority ${priorityLabel(p).toLowerCase()}`, () => sm.process.setPriority(pid, p), after);
}

function AffinityDialog({ pid, name, ov, close, after }: { pid: number; name: string; ov: ProcOverview; close: () => void; after: () => void }) {
  const fallback = Array.from({ length: Math.max(1, navigator.hardwareConcurrency || 1) }, (_, i) => i);
  const cpus = ov.systemAffinity ? maskBits(ov.systemAffinity) : fallback;
  const [sel, setSel] = useState<Set<number>>(() => new Set(ov.affinity ? maskBits(ov.affinity) : cpus));
  const [busy, setBusy] = useState(false);
  const mask = [...sel].reduce((m, b) => m | (1n << BigInt(b)), 0n);
  const flip = (b: number) =>
    setSel((s) => {
      const n = new Set(s);
      if (n.has(b)) n.delete(b);
      else n.add(b);
      return n;
    });
  return (
    <form
      className="sm-dialog pi-affinity"
      onSubmit={async (e) => {
        e.preventDefault();
        if (!sel.size || busy) return;
        setBusy(true);
        const ok = await act(`Couldn't change the affinity of ${name}`, `${name} may now run on ${sel.size} of ${cpus.length} CPUs`, () => sm.process.setAffinity(pid, mask.toString()), after);
        setBusy(false);
        if (ok) close();
      }}
    >
      <h3>
        Affinity of {name} <span className="sm-dim">({pid})</span>
      </h3>
      <p className="pi-dialog-text">The processors its threads may run on.</p>
      <div className="pi-affinity-grid">
        {cpus.map((b) => (
          <label key={b} className="pi-affinity-cpu">
            <input type="checkbox" checked={sel.has(b)} onChange={() => flip(b)} />
            <span>CPU {b}</span>
          </label>
        ))}
      </div>
      <div className="sm-row pi-affinity-bulk">
        <Button small kind="subtle" onClick={() => setSel(new Set(cpus))}>
          Select all
        </Button>
        <Button small kind="subtle" onClick={() => setSel(new Set())}>
          Select none
        </Button>
        <span className="sm-grow" />
        <span className="sm-dim mono" title="The mask passed to SetProcessAffinityMask">
          0x{mask.toString(16)}
        </span>
      </div>
      {!sel.size && <div className="sm-dialog-error">Choose at least one CPU.</div>}
      <div className="sm-dialog-buttons">
        <Button kind="subtle" onClick={close}>
          Cancel
        </Button>
        <Button type="submit" kind="primary" disabled={!sel.size || busy}>
          Apply
        </Button>
      </div>
    </form>
  );
}

export function openAffinity(pid: number, name: string, ov: ProcOverview, after: () => void) {
  openModal((close) => <AffinityDialog pid={pid} name={name} ov={ov} close={close} after={after} />);
}

/** The toolbar's "…" menu. */
export function processMenu(a: { pid: number; name: string; ov: ProcOverview | null; canControl: boolean; refresh: () => void; after: () => void }): MenuItem[] {
  const { pid, name, ov, after } = a;
  const items: MenuItem[] = [{ label: "Refresh", icon: <RefreshCw size={14} />, hint: "F5", onSelect: a.refresh }];
  if (a.canControl) {
    items.push(
      { separator: true },
      ov?.suspended
        ? { label: "Resume", icon: <Play size={14} />, onSelect: () => resumeProcess(pid, name, after) }
        : { label: "Suspend…", icon: <Pause size={14} />, onSelect: () => suspendProcess(pid, name, after) },
      {
        label: "Priority",
        icon: <Gauge size={14} />,
        submenu: PRIORITIES.map((p) => ({ label: p.label, checked: ov?.priorityClass === p.id, onSelect: () => setPriority(pid, name, p.id, after) })),
      },
      { label: "Affinity…", icon: <Cpu size={14} />, disabled: !ov, onSelect: () => ov && openAffinity(pid, name, ov, after) },
    );
  }
  items.push(
    { separator: true },
    { label: "Open file location", icon: <FolderOpen size={14} />, disabled: !ov?.path, onSelect: () => reveal(ov?.path) },
    { label: "Show in Processes", icon: <ListTree size={14} />, onSelect: () => openModule({ module: "processes", filter: `pid:${pid}` }) },
    { label: "Show its ports", icon: <Network size={14} />, onSelect: () => openModule({ module: "ports", filter: `pid:${pid}` }) },
    { separator: true },
    { label: "Copy PID", icon: <Hash size={14} />, onSelect: () => copy(String(pid), "PID") },
    { label: "Copy path", icon: <Copy size={14} />, disabled: !ov?.path, onSelect: () => ov?.path && copy(ov.path, "path") },
    { label: "Copy command line", icon: <Terminal size={14} />, disabled: !ov?.commandLine, onSelect: () => ov?.commandLine && copy(ov.commandLine, "command line") },
  );
  return items;
}
