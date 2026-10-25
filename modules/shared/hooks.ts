import { useCallback, useEffect, useRef, useState } from "react";
import type { PaneContext } from "./api";
import { ready, sm } from "./sdk";

/** The pane context once the host is ready (null before); `visible` stays current. */
export function usePane(): PaneContext | null {
  const [ctx, setCtx] = useState<PaneContext | null>(null);
  useEffect(() => {
    let alive = true;
    let off: (() => void) | undefined;
    ready().then((info) => {
      if (!alive) return;
      setCtx(info);
      off = sm.on("visible", (v: boolean) => setCtx((c) => (c ? { ...c, visible: !!v } : c)));
    });
    return () => {
      alive = false;
      off?.();
    };
  }, []);
  return ctx;
}

/**
 * setInterval that runs only while `enabled` (e.g. the pane is visible), once right away,
 * and skips ticks while a previous async run is still going.
 */
export function useInterval(fn: () => unknown, ms: number, enabled = true) {
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(() => {
    if (!enabled) return;
    let busy = false;
    const run = async () => {
      if (busy || document.hidden) return;
      busy = true;
      try {
        await ref.current();
      } finally {
        busy = false;
      }
    };
    run();
    const t = setInterval(run, Math.max(250, ms));
    return () => clearInterval(t);
  }, [ms, enabled]);
}

/**
 * A value kept in the module's storage (shared by all its panes, survives restarts).
 * `loaded` turns true once the saved value (if any) has been read.
 */
export function useStored<T>(key: string, initial: T): [T, (v: T | ((prev: T) => T)) => void, boolean] {
  const [value, setValue] = useState<T>(initial);
  const [loaded, setLoaded] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const latest = useRef(value);
  latest.current = value;

  useEffect(() => {
    let alive = true;
    ready()
      .then(() => sm.storage.get<T>(key))
      .then((v) => {
        if (alive && v !== null && v !== undefined) setValue(mergeDefaults(initial, v));
      })
      .catch(() => {})
      .finally(() => alive && setLoaded(true));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const set = useCallback(
    (v: T | ((prev: T) => T)) => {
      setValue((prev) => {
        const next = typeof v === "function" ? (v as (p: T) => T)(prev) : v;
        clearTimeout(timer.current);
        timer.current = setTimeout(() => sm.storage.set(key, next).catch(() => {}), 300);
        return next;
      });
    },
    [key],
  );
  return [value, set, loaded];
}

/** Saved objects get new default keys added in later versions. */
function mergeDefaults<T>(initial: T, saved: unknown): T {
  if (initial && typeof initial === "object" && !Array.isArray(initial) && saved && typeof saved === "object" && !Array.isArray(saved)) {
    return { ...initial, ...(saved as object) } as T;
  }
  return saved as T;
}

/**
 * State saved with the pane itself (ui.setState): restored when the layout comes back
 * after a restart, unlike useStored which every pane of the module shares.
 */
export function usePaneState<T extends Record<string, unknown>>(ctx: PaneContext | null, initial: T): [T, (patch: Partial<T>) => void] {
  const [state, setState] = useState<T>(initial);
  const seeded = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => {
    if (!ctx || seeded.current) return;
    seeded.current = true;
    if (ctx.state) setState((s) => ({ ...s, ...(ctx.state as Partial<T>) }));
  }, [ctx]);
  const update = useCallback((patch: Partial<T>) => {
    setState((prev) => {
      const next = { ...prev, ...patch };
      clearTimeout(timer.current);
      timer.current = setTimeout(() => sm.ui.setState(next).catch(() => {}), 400);
      return next;
    });
  }, []);
  return [state, update];
}

/** Debounced copy of a value. */
export function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}
