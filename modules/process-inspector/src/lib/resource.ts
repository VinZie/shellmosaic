// One backend call per tab (overview, modules, …), kept fresh while the tab is on
// screen. Previous data stays while a refresh runs, so nothing flashes.
import { useCallback, useEffect, useRef, useState } from "react";
import { errorText, isAccessDenied } from "../../../shared";
import { isExited } from "./util";

/** How every tab polls: pane visibility, the interval from the prefs, and a counter bumped by "refresh now". */
export interface Live {
  visible: boolean;
  /** ms; 0 = only on demand */
  interval: number;
  tick: number;
}

export interface Resource<T> {
  data: T | null;
  /** the last call's error (data, if any, is from an earlier call) */
  error: string | null;
  /** the error says "access denied" */
  denied: boolean;
  /** nothing to show yet */
  loading: boolean;
  /** Unix ms of the last successful load */
  updatedAt: number;
  refresh: () => Promise<void>;
}

interface Snapshot<T> {
  pid: number | null;
  data: T | null;
  error: string | null;
  at: number;
}

interface Job {
  pid: number;
  p: Promise<void>;
  /** asked for again while running (e.g. right after an action): its answer may predate the change */
  again: boolean;
}

export function useResource<T>(
  pid: number | null,
  load: (pid: number) => Promise<T>,
  opts: Live & {
    /** the tab is on screen: poll it */
    active: boolean;
    /** load once even while not active (the overview feeds the header) and refresh on every tick */
    eager?: boolean;
    /** the call said the process exited */
    onExited?: () => void;
  },
): Resource<T> {
  const [snap, setSnap] = useState<Snapshot<T>>({ pid, data: null, error: null, at: 0 });
  const pidRef = useRef(pid);
  pidRef.current = pid;
  const loadRef = useRef(load);
  loadRef.current = load;
  const exitRef = useRef(opts.onExited);
  exitRef.current = opts.onExited;
  const snapRef = useRef(snap);
  snapRef.current = snap;
  const inflight = useRef<Job | null>(null);
  /** a refresh was asked for while the tab was hidden: do it when it shows */
  const stale = useRef(false);

  /** `force`: a deliberate refresh (not a poll) must see state from after it was asked for */
  const run = useCallback((force: boolean): Promise<void> => {
    const p = pidRef.current;
    if (p === null) return Promise.resolve();
    const cur = inflight.current;
    if (cur?.pid === p) {
      if (force) cur.again = true;
      return cur.p;
    }
    const job: Job = { pid: p, p: Promise.resolve(), again: false };
    inflight.current = job;
    job.p = (async () => {
      try {
        const data = await loadRef.current(p);
        if (pidRef.current !== p) return;
        stale.current = false;
        setSnap({ pid: p, data, error: null, at: Date.now() });
      } catch (e) {
        if (pidRef.current !== p) return;
        const msg = errorText(e) || "Unknown error";
        setSnap((s) => (s.pid === p ? { ...s, error: msg } : { pid: p, data: null, error: msg, at: 0 }));
        if (isExited(msg)) exitRef.current?.();
      } finally {
        if (inflight.current === job) inflight.current = null;
      }
      if (job.again && pidRef.current === p) await run(false);
    })();
    return job.p;
  }, []);
  const refresh = useCallback(() => run(true), [run]);

  const { active, visible, interval, tick, eager } = opts;
  const mine = snap.pid === pid;
  const error = mine ? snap.error : null;
  const denied = !!error && isAccessDenied(error);
  // these don't fix themselves: stop polling until asked to refresh
  const stuck = denied || isExited(error);

  useEffect(() => {
    if (pid === null || !visible) return;
    const s = snapRef.current;
    const have = s.pid === pid && (s.data !== null || s.error !== null);
    if (!active) {
      if (eager && !have) run(false);
      return;
    }
    if (stuck && have) return;
    let stop = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const loop = async () => {
      if (stop) return;
      if (!document.hidden) await run(false);
      if (!stop && interval > 0) timer = setTimeout(loop, interval);
    };
    const age = Date.now() - (s.pid === pid ? s.at : 0);
    if (!have || stale.current || (interval > 0 && age >= interval)) loop();
    else if (interval > 0) timer = setTimeout(loop, interval - age);
    return () => {
      stop = true;
      clearTimeout(timer);
    };
  }, [pid, active, visible, interval, eager, stuck, run]);

  const lastTick = useRef(tick);
  useEffect(() => {
    if (tick === lastTick.current) return;
    lastTick.current = tick;
    if (pid === null) return;
    if (active || eager) refresh();
    else stale.current = true;
  }, [tick, pid, active, eager, refresh]);

  return {
    data: mine ? snap.data : null,
    error,
    denied,
    loading: pid !== null && (!mine || (snap.data === null && snap.error === null)),
    updatedAt: mine ? snap.at : 0,
    refresh,
  };
}
