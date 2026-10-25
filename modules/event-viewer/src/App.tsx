import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from "react";
import { ArrowUp, ChevronDown, CircleX, LoaderCircle, PanelBottom, PanelLeftClose, PanelLeftOpen, PanelRight, Play, Radar, RefreshCw, ScrollText, SearchX, ShieldAlert } from "lucide-react";
import {
  Button,
  cx,
  errorText,
  Footer,
  formatDateTime,
  formatNumber,
  IconButton,
  isAccessDenied,
  Loading,
  Message,
  natural,
  openMenu,
  Popover,
  sm,
  Split,
  Switch,
  Table,
  useColumnState,
  useDebounced,
  useInterval,
  usePane,
  usePaneState,
  useStored,
  type EventChannel,
  type EventLogInfo,
  type Key,
  type PaneContext,
  type SortState,
} from "../../shared";
import { rowMenu, type FilterActions } from "./actions";
import { eventColumns, rowsTsv, shownColumns, sysmonColumns } from "./columns";
import { Details, type DetailsMode, type DetailsTab } from "./Details";
import { useEventFeed, useLiveTail, type FeedQuery } from "./feed";
import { FilterBar, XPathEditor, type BarMode } from "./FilterBar";
import { DEFAULT_EXPANDED, DEFAULT_FAVORITES, LogList, shortLogName, WINDOWS_LOGS } from "./LogList";
import type { Ev } from "./parse";
import { buildXPath, excludeId, filterCount, NO_FILTERS, parseIds, type Audit, type Filters, type IdSpec, type RangeId } from "./query";
import { SYSMON_CHANNEL } from "./sysmon";
import "./app.css";

type PaneState = {
  channel: string;
  levels: number[];
  audit: Audit;
  ids: string;
  providers: string[];
  range: RangeId;
  text: string;
  /** a hand-edited XPath query (replaces the structured filters) */
  xpath: string | null;
  /** Sysmon view on/off; null = automatic */
  sysmon: boolean | null;
  live: boolean;
  /** the pane args already applied (so a restored pane keeps the user's later choices) */
  fromArgs: string;
};

const INITIAL: PaneState = { channel: "", ...NO_FILTERS, text: "", xpath: null, sysmon: null, live: false, fromArgs: "" };

type Layout = {
  sidebar: number;
  sidebarHidden: boolean;
  details: DetailsMode;
  detailsHidden: boolean;
  detailsH: number;
  detailsW: number;
  tab: DetailsTab;
};

const LAYOUT: Layout = { sidebar: 250, sidebarHidden: false, details: "auto", detailsHidden: false, detailsH: 280, detailsW: 430, tab: "general" };

const ROW_H = 24;
const rowKey = (e: Ev) => e.key;

const isInvalidQuery = (e: string) => /valid event query|invalid query|query is invalid|15001|EVT_INVALID_QUERY/i.test(e);
const isNoSuchLog = (e: string) => /no such log|could not be found|couldn't be found|not found|15007/i.test(e);

export function App() {
  const ctx = usePane();
  return <div className="sm-app ev-app">{ctx ? <Viewer ctx={ctx} /> : <Loading />}</div>;
}

function useSize(ref: RefObject<HTMLElement | null>) {
  const [s, setS] = useState({ w: window.innerWidth, h: window.innerHeight });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      const w = Math.round(el.clientWidth);
      const h = Math.round(el.clientHeight);
      setS((p) => (p.w === w && p.h === h ? p : { w, h }));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return s;
}

/** A debounced copy while the user types; the value itself right away otherwise (restores, menu actions). */
function useTyped(value: string, ms: number): [string, () => void] {
  const [typing, setTyping] = useState(false);
  const deb = useDebounced(value, ms);
  useEffect(() => {
    if (typing && deb === value) setTyping(false);
  }, [typing, deb, value]);
  return [typing ? deb : value, useCallback(() => setTyping(true), [])];
}

function Viewer({ ctx }: { ctx: PaneContext }) {
  const [ps, setPs] = usePaneState<PaneState>(ctx, INITIAL);
  const psRef = useRef(ps);
  psRef.current = ps;
  const [layout, setLayout] = useStored<Layout>("layout", LAYOUT);
  const [favorites, setFavorites] = useStored<string[] | null>("favorites", null);
  const [showAll, setShowAll] = useStored("showAll", false);
  const [expanded, setExpanded] = useStored<string[]>("tree", DEFAULT_EXPANDED);

  // ── pane args (Open in a new pane, other modules) ──
  useEffect(() => {
    const args = ctx.args ?? {};
    const channel = typeof args.channel === "string" ? args.channel : null;
    const xpath = typeof args.xpath === "string" && args.xpath.trim() ? args.xpath.trim() : null;
    if (!channel && !xpath) return;
    const tag = JSON.stringify([channel, xpath]);
    if ((ctx.state as Partial<PaneState> | null)?.fromArgs === tag) return;
    setPs({ ...(channel ? { channel } : {}), ...NO_FILTERS, text: "", xpath, sysmon: null, fromArgs: tag });
    // once, with the context the pane started with
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── logs ──
  const [channels, setChannels] = useState<EventChannel[] | null>(null);
  const [channelsError, setChannelsError] = useState<string | null>(null);
  useEffect(() => {
    sm.eventlog
      .channels()
      .then((list) => setChannels([...list].sort((a, b) => natural(a.name, b.name))))
      .catch((e) => setChannelsError(errorText(e)));
  }, []);
  useEffect(() => {
    if (!channels || psRef.current.channel) return;
    const pick = ["Application", ...DEFAULT_FAVORITES].find((n) => channels.some((c) => c.name === n)) ?? channels[0]?.name;
    if (pick) setPs({ channel: pick });
  }, [channels, setPs]);
  const favList = useMemo(() => favorites ?? DEFAULT_FAVORITES.filter((n) => !channels || channels.some((c) => c.name === n)), [favorites, channels]);
  const togglePin = (name: string) => setFavorites(() => (favList.includes(name) ? favList.filter((x) => x !== name) : [...favList, name]));
  const channel = ps.channel;
  const channelInfo = channels?.find((c) => c.name === channel) ?? null;

  useEffect(() => {
    if (channel) sm.ui.setTitle(`Events · ${shortLogName(channel)}`).catch(() => {});
  }, [channel]);

  // ── query ──
  const [idsQ, markIdsTyping] = useTyped(ps.ids, 450);
  const [textQ, markTextTyping] = useTyped(ps.text.trim(), 350);
  const idsParsed = useMemo(() => parseIds(idsQ), [idsQ]);
  const lastIds = useRef<IdSpec | null>(null);
  if (idsParsed.ok) lastIds.current = idsParsed.value;
  const idsError = idsParsed.ok ? null : idsParsed.error;
  const filters: Filters = { levels: ps.levels, audit: ps.audit, ids: ps.ids, providers: ps.providers, range: ps.range };
  let generated: string | null = null;
  let genError: string | null = null;
  try {
    generated = buildXPath(filters, lastIds.current);
  } catch (e) {
    genError = `Source: ${errorText(e)}`;
  }
  const xpath = ps.xpath ?? generated;
  const [nonce, setNonce] = useState(0);
  const q: FeedQuery | null = channel && !(genError && ps.xpath === null) ? { channel, xpath, text: textQ, nonce } : null;
  const feed = useEventFeed(q, ctx.visible);
  const refresh = useCallback(() => setNonce((n) => n + 1), []);

  // record count of the selected log
  const [info, setInfo] = useState<EventLogInfo | null>(null);
  const infoFor = useRef("");
  useEffect(() => {
    if (infoFor.current !== channel) {
      infoFor.current = channel;
      setInfo(null);
    }
    if (!channel) return;
    let alive = true;
    sm.eventlog
      .info(channel)
      .then((i) => alive && setInfo(i))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [channel, nonce]);

  // ── table ──
  const rootRef = useRef<HTMLDivElement>(null);
  const mainRef = useRef<HTMLDivElement>(null);
  const tableRef = useRef<HTMLDivElement>(null);
  const detailsRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLDivElement>(null);
  const root = useSize(rootRef);
  const main = useSize(mainRef);
  const sidebarForcedOff = root.w < 720;
  const sidebarShown = !sidebarForcedOff && !layout.sidebarHidden;
  const mainW = sidebarShown ? main.w : root.w;
  const isSysmonChannel = channel === SYSMON_CHANNEL;
  const active = filterCount(filters);
  const anyFilter = active > 0 || !!ps.xpath || !!ps.text.trim();
  // room for the level chips' labels on one line with everything else
  const labelsAt = 1190 + (channel === "Security" ? 150 : 0) + (isSysmonChannel ? 85 : 0) + (anyFilter ? 30 : 0) + (ps.xpath ? 50 : 0);
  const barMode: BarMode = mainW < 620 ? "compact" : mainW < labelsAt ? "icons" : "full";
  const narrow = mainW < 560;

  const sysmonView = isSysmonChannel && (ps.sysmon ?? true);
  const columns = useMemo(() => (sysmonView ? sysmonColumns(narrow) : eventColumns(narrow)), [sysmonView, narrow]);
  // one hook per layout (a stored value doesn't follow a changing key)
  const colEvents = useColumnState("events");
  const colEventsNarrow = useColumnState("events-narrow");
  const colSysmon = useColumnState("sysmon");
  const colSysmonNarrow = useColumnState("sysmon-narrow");
  const [colState, setColState] = sysmonView ? (narrow ? colSysmonNarrow : colSysmon) : narrow ? colEventsNarrow : colEvents;

  const [sort, setSort] = useState<SortState | null>(null);
  const [sel, setSel] = useState<Key[]>([]);
  const [current, setCurrent] = useState<Ev | null>(null);
  const onSelect = useCallback((keys: Key[], rows: Ev[]) => {
    setSel(keys);
    const last = keys[keys.length - 1];
    setCurrent(rows.find((r) => r.key === last) ?? rows[rows.length - 1] ?? null);
  }, []);
  // a new filter that leaves the selected event out deselects it (a plain refresh keeps it)
  const lq = feed.loaded;
  const filterKey = lq ? JSON.stringify([lq.channel, lq.xpath, lq.text]) : "";
  const loadedFor = useRef("");
  useEffect(() => {
    if (feed.status !== "ready" || !filterKey || loadedFor.current === filterKey) return;
    const changed = loadedFor.current !== "";
    loadedFor.current = filterKey;
    if (!changed) return;
    setCurrent((c) => (c && !feed.events.some((e) => e.key === c.key) ? null : c));
    setSel((s) => {
      const keep = new Set(feed.events.map((e) => e.key));
      const next = s.filter((k) => keep.has(k as number));
      return next.length === s.length ? s : next;
    });
  }, [feed.status, feed.events, filterKey]);

  const selectChannel = useCallback(
    (name: string) => {
      if (name === psRef.current.channel) return;
      setPs({ channel: name, ids: "", providers: [], xpath: null, sysmon: null });
      setSel([]);
      setCurrent(null);
      setPending(0);
    },
    [setPs],
  );

  // ── live tail ──
  const [fresh, setFresh] = useState<ReadonlySet<number>>(new Set());
  const [pending, setPending] = useState(0);
  const compensate = useRef(0);
  const scrollEl = () => tableRef.current?.querySelector<HTMLElement>(".sm-table-scroll") ?? null;
  const onLive = (xmls: string[]) => {
    const added = feed.prepend(xmls);
    if (!added.length) return;
    const keys = added.map((e) => e.key);
    setFresh((prev) => new Set([...prev, ...keys]));
    setTimeout(
      () =>
        setFresh((prev) => {
          const n = new Set(prev);
          for (const k of keys) n.delete(k);
          return n;
        }),
      2600,
    );
    const el = scrollEl();
    if (el && el.scrollTop > 4 && !sort) {
      compensate.current += added.length;
      setPending((p) => p + added.length);
    }
  };
  const live = useLiveTail(q, ps.live && feed.status === "ready", ctx.visible, onLive);
  useEffect(() => {
    if (live.state === "error" && live.error) {
      sm.ui.notify(`Live tail stopped: ${live.error}`, "error");
      setPs({ live: false });
    }
  }, [live.state, live.error, setPs]);
  useEffect(() => setPending(0), [q?.channel, q?.xpath, q?.text, q?.nonce]);
  // keep the rows in view where they were when new ones arrive above them
  useLayoutEffect(() => {
    const n = compensate.current;
    if (!n) return;
    compensate.current = 0;
    const el = scrollEl();
    if (el) el.scrollTop += n * ROW_H;
  }, [feed.events]);
  useInterval(
    () =>
      sm.eventlog
        .info(channel)
        .then(setInfo)
        .catch(() => {}),
    15000,
    ps.live && ctx.visible && !!channel,
  );
  const toTop = () => {
    const el = scrollEl();
    if (el) el.scrollTop = 0;
    setPending(0);
  };

  // ── filter actions ──
  const actions: FilterActions = useMemo(
    () => ({
      filterId: (id) => setPs({ ids: String(id), xpath: null }),
      excludeId: (id) => setPs({ ids: excludeId(psRef.current.ids, id), xpath: null }),
      filterSource: (p) => setPs({ providers: [p], xpath: null }),
      filterLevel: (l) => setPs({ levels: [l], audit: "", xpath: null }),
    }),
    [setPs],
  );
  const clearFilters = () => setPs({ ...NO_FILTERS, text: "", xpath: null });

  // sources: counts in the loaded events, plus every one seen in this log
  const seenAll = useRef(new Map<string, Set<string>>());
  const seen = useMemo(() => {
    const counts = new Map<string, number>();
    for (const e of feed.events) if (e.provider) counts.set(e.provider, (counts.get(e.provider) ?? 0) + 1);
    let all = seenAll.current.get(channel);
    if (!all) seenAll.current.set(channel, (all = new Set()));
    for (const p of counts.keys()) all.add(p);
    const list: [string, number][] = [...counts].sort((a, b) => b[1] - a[1] || natural(a[0], b[0]));
    for (const p of [...all].sort(natural)) if (!counts.has(p)) list.push([p, 0]);
    return list;
  }, [feed.events, channel]);

  // ── keyboard ──
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const k = e.key.toLowerCase();
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && k === "f") {
        e.preventDefault();
        const input = searchRef.current?.querySelector("input");
        input?.focus();
        input?.select();
      } else if (e.key === "F5" || ((e.ctrlKey || e.metaKey) && !e.shiftKey && k === "r")) {
        e.preventDefault();
        refresh();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [refresh]);

  // ── details ──
  const autoSide = mainW >= 1100 && mainW > main.h * 1.35 ? "right" : "bottom";
  const side = layout.details === "auto" ? autoSide : layout.details;
  const openDetails = () => {
    if (layout.detailsHidden) setLayout((l) => ({ ...l, detailsHidden: false }));
    requestAnimationFrame(() => detailsRef.current?.focus());
  };
  const focusTable = () => tableRef.current?.querySelector<HTMLElement>(".sm-table")?.focus();

  // ── UI ──
  const [xpathOpen, setXpathOpen] = useState(false);
  const [logPop, setLogPop] = useState(false);
  const logBtn = useRef<HTMLButtonElement>(null);
  const queryError = feed.status === "error" && feed.error && isInvalidQuery(feed.error) ? feed.error : null;

  const logList = (inPopover: boolean) => (
    <LogList
      channels={channels}
      error={channelsError}
      selected={channel}
      onSelect={(n) => {
        selectChannel(n);
        if (inPopover) setLogPop(false);
      }}
      favorites={favList}
      onTogglePin={togglePin}
      showAll={showAll}
      onShowAll={setShowAll}
      expanded={expanded}
      onExpanded={setExpanded}
      records={info?.records ?? null}
      onOpenInPane={(name) => {
        setLogPop(false);
        sm.ui.openModule({ module: "plugin:event-viewer", args: { channel: name } }).catch((e) => sm.ui.notify(errorText(e), "error"));
      }}
      autoFocus={inPopover}
      className={inPopover ? "in-popover" : undefined}
    />
  );

  const left = (
    <>
      {!sidebarForcedOff && (
        <IconButton title={sidebarShown ? "Hide the log list" : "Show the log list"} onClick={() => setLayout((l) => ({ ...l, sidebarHidden: !l.sidebarHidden }))}>
          {sidebarShown ? <PanelLeftClose size={15} /> : <PanelLeftOpen size={15} />}
        </IconButton>
      )}
      {!sidebarShown && (
        <button ref={logBtn} type="button" className="ev-pick ev-logpick" title={channel || "Choose a log"} onClick={() => setLogPop((o) => !o)}>
          <ScrollText size={13} />
          <span className="sm-ellipsis">{channel ? shortLogName(channel) : "Choose a log"}</span>
          <ChevronDown size={12} />
        </button>
      )}
    </>
  );

  const compact = barMode === "compact";
  const right = (
    <>
      {isSysmonChannel && !compact && (
        <button type="button" className={cx("ev-pick", sysmonView && "on")} title="Sysmon view: columns from Sysmon's event data" onClick={() => setPs({ sysmon: !sysmonView })}>
          <Radar size={13} />
          <span>Sysmon</span>
        </button>
      )}
      <button
        type="button"
        className={cx("ev-live", ps.live && "on")}
        title={ps.live ? "Pause the live tail" : "Live tail: show new events as they're written"}
        aria-pressed={ps.live}
        disabled={!channel}
        onClick={() => setPs({ live: !ps.live })}
      >
        {ps.live ? <span className="ev-live-dot" /> : <Play size={12} />}
        {!compact && <span>Live</span>}
      </button>
      <IconButton title="Refresh (F5)" onClick={refresh} disabled={!channel}>
        <RefreshCw size={14} className={feed.status === "loading" ? "sm-spin" : undefined} />
      </IconButton>
      <IconButton
        title={layout.detailsHidden ? "Show details" : "Hide details"}
        on={!layout.detailsHidden}
        onClick={() => setLayout((l) => ({ ...l, detailsHidden: !l.detailsHidden }))}
      >
        {side === "right" ? <PanelRight size={15} /> : <PanelBottom size={15} />}
      </IconButton>
    </>
  );

  const filterError = idsError ? `Event IDs: ${idsError}` : genError ?? queryError;

  let tableArea: React.ReactNode;
  if (!channel) tableArea = channelsError ? <Message tone="danger" icon={<CircleX size={22} />} title="Couldn't list the event logs">{channelsError}</Message> : <Loading label="Reading the event logs…" />;
  else if (feed.status === "error" && feed.error && !queryError) tableArea = <QueryError ctx={ctx} channel={channel} error={feed.error} onRetry={refresh} onPick={selectChannel} />;
  else if (queryError) tableArea = <Message icon={<SearchX size={22} />} title="No results">The filter isn't a valid event query; fix it above.</Message>;
  else if ((feed.status === "loading" && !feed.events.length) || feed.status === "idle") tableArea = <Loading label={`Reading ${shortLogName(channel)}…`} />;
  else
    tableArea = (
      <div
        className="ev-tablewrap"
        ref={tableRef}
        onScrollCapture={(e) => {
          const t = e.target as HTMLElement;
          if (pending && t.classList.contains("sm-table-scroll") && t.scrollTop < ROW_H) setPending(0);
        }}
      >
        <Table<Ev>
          columns={columns}
          rows={feed.events}
          rowKey={rowKey}
          columnState={colState}
          onColumnState={setColState}
          sort={sort}
          onSort={setSort}
          selected={sel}
          onSelect={onSelect}
          multi
          onOpen={openDetails}
          onContextMenu={(at, rows) => openMenu(at, rowMenu(rows, actions, () => rowsTsv(rows, shownColumns(columns, colState))))}
          rowClass={(e) => fresh.has(e.key) && "ev-fresh"}
          onEndReached={feed.loadMore}
          rowHeight={ROW_H}
          scrollTo={current?.key ?? null}
          empty={
            !feed.done ? (
              "Searching…"
            ) : anyFilter ? (
              "No events match the filters."
            ) : channelInfo && !channelInfo.enabled ? (
              "This log is disabled, and empty."
            ) : (
              "This log is empty."
            )
          }
        />
        {pending > 0 && (
          <button type="button" className="ev-newpill" onClick={toTop}>
            <ArrowUp size={13} /> {pending === 1 ? "1 new event" : `${formatNumber(pending)} new events`}
          </button>
        )}
        {feed.autoScan && feed.scanned > feed.events.length && (
          <div className="ev-scan">
            <LoaderCircle size={13} className="sm-spin" />
            <span>
              Scanned {formatNumber(feed.scanned)} events… <span className="sm-dim">{formatNumber(feed.events.length)} found</span>
            </span>
            <Button small kind="subtle" onClick={feed.stop}>
              Stop
            </Button>
          </div>
        )}
        {feed.stopped && !feed.done && (
          <div className="ev-scan">
            <span>
              Stopped after {formatNumber(feed.scanned)} events. <span className="sm-dim">{formatNumber(feed.events.length)} found</span>
            </span>
            <Button small kind="subtle" onClick={feed.resume}>
              Continue
            </Button>
          </div>
        )}
      </div>
    );

  const detailsPane = (
    <Details
      ref={detailsRef}
      ev={current}
      selectedCount={sel.length}
      tab={layout.tab}
      onTab={(tab) => setLayout((l) => ({ ...l, tab }))}
      side={side}
      mode={layout.details}
      onMode={(details) => setLayout((l) => ({ ...l, details, detailsHidden: false }))}
      onClose={() => {
        setLayout((l) => ({ ...l, detailsHidden: true }));
        focusTable();
      }}
      actions={actions}
      onEscape={focusTable}
    />
  );

  const mainPane = (
    <div className="ev-main" ref={mainRef}>
      <FilterBar
        mode={barMode}
        filters={filters}
        onFilters={(p) => {
          if (p.ids?.trim()) markIdsTyping();
          setPs({ ...p, xpath: null });
        }}
        text={ps.text}
        onText={(t) => {
          if (t.trim()) markTextTyping();
          setPs({ text: t });
        }}
        idsError={idsError}
        seen={seen}
        security={channel === "Security"}
        custom={ps.xpath !== null}
        xpathOpen={xpathOpen}
        onXpathOpen={setXpathOpen}
        active={active}
        onClear={clearFilters}
        searchRef={searchRef}
        left={left}
        right={right}
        popoverExtra={
          isSysmonChannel && (
            <>
              <h4>View</h4>
              <label className="ev-pop-switch">
                <Switch value={sysmonView} onChange={(v) => setPs({ sysmon: v })} />
                <span>Sysmon columns</span>
              </label>
            </>
          )
        }
      />
      {xpathOpen && <XPathEditor generated={generated} custom={ps.xpath} onApply={(x) => setPs({ xpath: x })} onClose={() => setXpathOpen(false)} error={queryError} />}
      {filterError && (
        <div className="ev-filter-error" role="alert">
          <CircleX size={14} />
          <span className="sm-grow sm-selectable">{filterError}</span>
          {queryError && !xpathOpen && (
            <Button small kind="subtle" onClick={() => setXpathOpen(true)}>
              Edit XPath
            </Button>
          )}
          {(queryError || genError) && (
            <Button small kind="subtle" onClick={clearFilters}>
              Clear filters
            </Button>
          )}
        </div>
      )}
      <Split
        direction={side === "right" ? "horizontal" : "vertical"}
        sizeOf="second"
        size={side === "right" ? Math.min(layout.detailsW, Math.max(260, mainW - 340)) : Math.min(layout.detailsH, Math.max(110, main.h - 230))}
        onSize={(px) => setLayout((l) => (side === "right" ? { ...l, detailsW: px } : { ...l, detailsH: px }))}
        min={side === "right" ? 260 : 110}
        collapsed={layout.detailsHidden || !current || feed.status === "error"}
        first={tableArea}
        second={detailsPane}
      />
      <Footer>
        {ps.live && <span className={cx("ev-foot-live", live.state === "on" && "on")}>{live.state === "on" ? (ctx.visible ? "Live" : "Live (paused while hidden)") : "Connecting…"}</span>}
        <span className="sm-ellipsis ev-foot-log" title={channel}>
          {channel ? shortLogName(channel) : "—"}
        </span>
        {info?.records !== null && info?.records !== undefined && <span>· {formatNumber(info.records)} records</span>}
        {feed.status === "ready" && (
          <span>
            · {formatNumber(feed.events.length)}
            {!feed.done ? "+" : ""} loaded
          </span>
        )}
        {(feed.loadingMore || feed.status === "loading") && <LoaderCircle size={11} className="sm-spin" />}
        <div className="sm-grow" />
        {sel.length > 1 && <span>{formatNumber(sel.length)} selected</span>}
        {feed.refreshedAt && <span title={formatDateTime(feed.refreshedAt)}>refreshed {formatDateTime(feed.refreshedAt).slice(11)}</span>}
      </Footer>
      {logPop && !sidebarShown && (
        <Popover anchor={logBtn.current} onClose={() => setLogPop(false)} width={Math.min(330, root.w - 8)} align="left">
          {logList(true)}
        </Popover>
      )}
    </div>
  );

  return (
    <div className="ev-root" ref={rootRef}>
      <Split
        direction="horizontal"
        size={Math.min(layout.sidebar, Math.max(180, root.w - 420))}
        onSize={(px) => setLayout((l) => ({ ...l, sidebar: Math.min(480, px) }))}
        min={170}
        collapsed={!sidebarShown}
        first={logList(false)}
        second={mainPane}
      />
    </div>
  );
}

function QueryError({ ctx, channel, error, onRetry, onPick }: { ctx: PaneContext; channel: string; error: string; onRetry: () => void; onPick: (c: string) => void }) {
  const [busy, setBusy] = useState(false);
  if (isAccessDenied(error)) {
    return (
      <Message
        tone="warning"
        icon={<ShieldAlert size={24} />}
        title={ctx.elevated ? `Access to “${shortLogName(channel)}” is denied` : "Administrator rights needed"}
        actions={
          !ctx.elevated ? (
            <Button
              kind="primary"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  await sm.app.restartAsAdmin();
                } catch (e) {
                  sm.ui.notify(errorText(e), "error");
                } finally {
                  setBusy(false);
                }
              }}
            >
              Restart as administrator
            </Button>
          ) : (
            <Button onClick={onRetry}>Try again</Button>
          )
        }
      >
        {ctx.elevated ? (
          <p>Windows refused to open this log even for an administrator. {error}</p>
        ) : (
          <p>
            Windows only lets administrators read the <b>{shortLogName(channel)}</b> log. Restart Shellmosaic as administrator to see its events.
          </p>
        )}
      </Message>
    );
  }
  if (isNoSuchLog(error)) {
    return (
      <Message
        icon={<SearchX size={22} />}
        title="No such log"
        actions={
          channel !== "Application" && (
            <Button onClick={() => onPick(WINDOWS_LOGS[0])}>
              Open Application
            </Button>
          )
        }
      >
        <p>
          There is no log named <b className="sm-selectable">{channel}</b> on this computer.
        </p>
      </Message>
    );
  }
  return (
    <Message tone="danger" icon={<CircleX size={22} />} title="Couldn't read the log" actions={<Button onClick={onRetry}>Try again</Button>}>
      <p className="sm-selectable">{error}</p>
    </Message>
  );
}
