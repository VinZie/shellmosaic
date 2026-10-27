// The Orchestrator's state, kept current: the snapshot (fetched again on the host's
// "agents" event, with a 1 s poll while visible as a fallback), a run's activity log
// (fetched incrementally), and the plan usage when no agent has reported it yet.
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { sm, useInterval, type AgentActivity, type AgentSnapshot } from "../../shared";
import { usageFromAccount, usageFromSnapshot, type Usage } from "./lib";

export function useSnapshot(visible: boolean) {
  const [snap, setSnap] = useState<AgentSnapshot | null>(null);
  const [error, setError] = useState<unknown>(null);
  const rev = useRef(-1);
  const busy = useRef(false);
  const again = useRef(false);

  const refresh = useCallback(async () => {
    if (busy.current) {
      again.current = true;
      return;
    }
    busy.current = true;
    try {
      do {
        again.current = false;
        try {
          const s = await sm.agents.snapshot();
          setError(null);
          // (a restarted Shellmosaic counts from 0 again: any other number is news)
          if (s.rev !== rev.current) {
            rev.current = s.rev;
            setSnap(s);
          }
        } catch (e) {
          setError(e);
        }
      } while (again.current);
    } finally {
      busy.current = false;
    }
  }, []);

  useEffect(() => {
    refresh();
    return sm.on("agents", () => refresh());
  }, [refresh]);
  useInterval(refresh, 1000, visible);
  return { snap, error, refresh };
}

const MAX_ACTIVITY = 5000;

/** A run's activity, oldest first: its newest 2000 events at first, then everything new. */
export function useActivity(runId: string | null, lastSeq: number): AgentActivity[] {
  const [items, setItems] = useState<AgentActivity[]>([]);
  const [tick, setTick] = useState(0);
  const seen = useRef(0);
  const current = useRef<string | null>(null);
  const loading = useRef(false);
  const pending = useRef(false);

  useLayoutEffect(() => {
    current.current = runId;
    seen.current = 0;
    setItems([]);
  }, [runId]);

  useEffect(() => {
    if (!runId || lastSeq <= seen.current) return;
    if (loading.current) {
      pending.current = true;
      return;
    }
    loading.current = true;
    const run = runId;
    (async () => {
      try {
        const first = seen.current === 0;
        let after = seen.current;
        for (let page = 0; page < 20; page++) {
          // the first page: the run's newest events; after that, everything newer than the last one
          const list = await sm.agents.activity(first && page === 0 ? { runId: run, limit: 2000, latest: true } : { runId: run, after, limit: 1000 });
          if (current.current !== run) return;
          if (list.length) {
            after = list[list.length - 1].seq;
            setItems((prev) => {
              const last = prev.length ? prev[prev.length - 1].seq : 0;
              const fresh = list.filter((a) => a.seq > last);
              const next = prev.concat(fresh);
              return next.length > MAX_ACTIVITY ? next.slice(-MAX_ACTIVITY) : next;
            });
          }
          if (list.length < (first && page === 0 ? 2000 : 1000)) break;
        }
        // (seq numbers are shared by every run: nothing of this run's is between here and lastSeq)
        if (current.current === run) seen.current = Math.max(after, lastSeq);
      } catch {
        // tried again with the next change
      } finally {
        loading.current = false;
        if (pending.current) {
          pending.current = false;
          setTick((t) => t + 1);
        }
      }
    })();
  }, [runId, lastSeq, tick]);

  return items;
}

/** The plan usage: the agents' statusLine when they reported it, else Claude's usage endpoint (once a minute). */
export function useUsage(snap: AgentSnapshot | null, canAsk: boolean, visible: boolean): Usage | null {
  const fromAgents = usageFromSnapshot(snap);
  const [account, setAccount] = useState<Usage | null>(null);
  useInterval(
    async () => {
      try {
        setAccount(usageFromAccount(await sm.claude.usage()));
      } catch {
        setAccount(null);
      }
    },
    60_000,
    canAsk && visible && !fromAgents,
  );
  return fromAgents ?? account;
}

/** The element's width, kept current. */
export function useWidth<T extends HTMLElement>(): [React.RefObject<T | null>, number] {
  const ref = useRef<T>(null);
  const [w, setW] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setW(el.clientWidth));
    ro.observe(el);
    setW(el.clientWidth);
    return () => ro.disconnect();
  }, []);
  return [ref, w];
}

/** Re-render every `ms` (for "3 min ago" texts) while visible. */
export function useNow(ms: number, visible: boolean): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!visible) return;
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms, visible]);
  return now;
}
