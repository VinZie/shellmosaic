// Loading a query page by page, and the live tail on top of it.
import { useCallback, useEffect, useRef, useState } from "react";
import { errorText, sm, useInterval } from "../../shared";
import { parseEvent, type Ev } from "./parse";

export interface FeedQuery {
  channel: string;
  xpath: string | null;
  text: string;
  /** bumped by Refresh */
  nonce: number;
}

export interface FeedState {
  status: "idle" | "loading" | "ready" | "error";
  error: string | null;
  events: Ev[];
  /** no more pages */
  done: boolean;
  loadingMore: boolean;
  /** events the backend looked at so far (more than events.length with a text filter) */
  scanned: number;
  pages: number;
  /** events the last page added (0: keep scanning, the table won't ask again for the same row count) */
  lastAdded: number;
  /** the user stopped the automatic scan */
  stopped: boolean;
  refreshedAt: number | null;
  /** the query these events answer */
  loaded: FeedQuery | null;
}

const FIRST_PAGE = 200;
const PAGE = 400;
/** keep scanning on our own until this many matches are loaded */
const AUTO_FILL = 80;

const IDLE: FeedState = { status: "idle", error: null, events: [], done: true, loadingMore: false, scanned: 0, pages: 0, lastAdded: 0, stopped: false, refreshedAt: null, loaded: null };

export function useEventFeed(q: FeedQuery | null, visible: boolean) {
  const [st, setSt] = useState<FeedState>(IDLE);
  const gen = useRef(0);
  const cursor = useRef<number | null>(null);
  const busy = useRef(false);
  const seen = useRef(new Set<number>());
  const lastFilter = useRef("");
  const stopped = useRef(false);
  const key = q ? JSON.stringify(q) : "";

  /** parse and drop events already in the list (live tail and pages can overlap) */
  const accept = useCallback((xmls: string[], channel: string) => {
    const out: Ev[] = [];
    for (const x of xmls) {
      const e = parseEvent(x, channel);
      if (e.recordId > 0) {
        if (seen.current.has(e.recordId)) continue;
        seen.current.add(e.recordId);
      }
      out.push(e);
    }
    return out;
  }, []);

  useEffect(() => {
    if (!q) {
      lastFilter.current = "";
      setSt(IDLE);
      return;
    }
    const g = ++gen.current;
    seen.current = new Set();
    stopped.current = false;
    busy.current = true;
    // a refresh (same filter) keeps the old rows on screen until the new ones arrive
    const filter = JSON.stringify([q.channel, q.xpath, q.text]);
    const refresh = lastFilter.current === filter;
    lastFilter.current = filter;
    setSt((s) => (refresh ? { ...s, status: "loading", loadingMore: false, done: true } : { ...IDLE, status: "loading", done: false }));
    sm.eventlog
      .query({ channel: q.channel, xpath: q.xpath ?? undefined, text: q.text || undefined, reverse: true, max: FIRST_PAGE })
      .then((page) => {
        if (g !== gen.current) {
          if (page.cursor !== null && !page.done) sm.eventlog.close(page.cursor).catch(() => {});
          return;
        }
        busy.current = false;
        cursor.current = page.done ? null : page.cursor;
        const events = accept(page.events, q.channel);
        setSt({
          status: "ready",
          error: null,
          events,
          done: page.done || page.cursor === null,
          loadingMore: false,
          scanned: page.scanned,
          pages: 1,
          lastAdded: events.length,
          stopped: false,
          refreshedAt: Date.now(),
          loaded: q,
        });
      })
      .catch((e) => {
        if (g !== gen.current) return;
        busy.current = false;
        lastFilter.current = "";
        setSt({ ...IDLE, status: "error", error: errorText(e) });
      });
    return () => {
      gen.current++;
      busy.current = false;
      const c = cursor.current;
      cursor.current = null;
      if (c !== null) sm.eventlog.close(c).catch(() => {});
    };
    // the key stands for q
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const load = useCallback(async () => {
    const c = cursor.current;
    if (c === null || busy.current) return;
    busy.current = true;
    const g = gen.current;
    const channel = q?.channel ?? "";
    setSt((s) => ({ ...s, loadingMore: true }));
    try {
      const page = await sm.eventlog.more(c, PAGE);
      if (g !== gen.current) return;
      busy.current = false;
      const done = page.done || page.cursor === null;
      cursor.current = done ? null : page.cursor;
      const add = accept(page.events, channel);
      setSt((s) => ({ ...s, events: add.length ? s.events.concat(add) : s.events, done, loadingMore: false, scanned: s.scanned + page.scanned, pages: s.pages + 1, lastAdded: add.length }));
    } catch (e) {
      if (g !== gen.current) return;
      busy.current = false;
      cursor.current = null;
      setSt((s) => ({ ...s, done: true, loadingMore: false }));
      sm.ui.notify(`Couldn't load more events: ${errorText(e)}`, "error");
    }
    // q.channel is part of the key; a new query bumps gen
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, accept]);

  /**
   * Few matches so far (a text filter scanning a big log), or the last page found none:
   * keep asking while the pane is shown.
   */
  const autoScan = st.status === "ready" && !st.done && !st.stopped && (st.events.length < AUTO_FILL || (st.pages > 1 && st.lastAdded === 0));
  useEffect(() => {
    if (autoScan && visible) load();
  }, [autoScan, visible, st.pages, load]);

  /** the table asks for more near its end; not after the user stopped a scan */
  const loadMore = useCallback(() => {
    if (!stopped.current) load();
  }, [load]);
  const stop = useCallback(() => {
    stopped.current = true;
    setSt((s) => ({ ...s, stopped: true }));
  }, []);
  const resume = useCallback(() => {
    stopped.current = false;
    setSt((s) => ({ ...s, stopped: false }));
    load();
  }, [load]);

  /** live events (oldest first) go on top; returns the ones that were new */
  const prepend = useCallback(
    (xmls: string[]): Ev[] => {
      const evs = accept(xmls, q?.channel ?? "").reverse();
      if (evs.length) setSt((s) => ({ ...s, events: evs.concat(s.events) }));
      return evs;
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [key, accept],
  );

  return { ...st, autoScan: autoScan && visible, loadMore, stop, resume, prepend };
}

export type LiveState = "off" | "starting" | "on" | "error";

/** Subscribe while `on`; poll about once a second while the pane is visible. */
export function useLiveTail(q: FeedQuery | null, on: boolean, visible: boolean, onEvents: (xmls: string[]) => void): { state: LiveState; error: string | null } {
  const sub = useRef<number | null>(null);
  const [state, setState] = useState<LiveState>("off");
  const [error, setError] = useState<string | null>(null);
  const handler = useRef(onEvents);
  handler.current = onEvents;
  const key = q ? JSON.stringify(q) : "";

  useEffect(() => {
    if (!on || !q) {
      setState("off");
      return;
    }
    let alive = true;
    setState("starting");
    setError(null);
    sm.eventlog
      .subscribe({ channel: q.channel, xpath: q.xpath ?? undefined, text: q.text || undefined })
      .then((id) => {
        if (!alive) {
          sm.eventlog.unsubscribe(id).catch(() => {});
          return;
        }
        sub.current = id;
        setState("on");
      })
      .catch((e) => {
        if (!alive) return;
        setState("error");
        setError(errorText(e));
      });
    return () => {
      alive = false;
      const id = sub.current;
      sub.current = null;
      if (id !== null) sm.eventlog.unsubscribe(id).catch(() => {});
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [on, key]);

  useInterval(
    async () => {
      const id = sub.current;
      if (id === null) return;
      try {
        const xs = await sm.eventlog.poll(id, 500);
        if (xs.length && sub.current === id) handler.current(xs);
      } catch (e) {
        if (sub.current !== id) return;
        sub.current = null;
        setState("error");
        setError(errorText(e));
      }
    },
    1000,
    on && visible && state === "on",
  );

  return { state, error };
}
