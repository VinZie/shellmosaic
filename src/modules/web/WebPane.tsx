// Web pane: a native child webview that Rust positions over our placeholder
// <div>, plus a compact browser toolbar. Native webviews paint above the app's
// HTML, so the view is hidden whenever its tab is inactive, another pane is
// magnified, or any overlay (menu, dialog, palette, settings, drag) is open.
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { openUrl } from "@tauri-apps/plugin-opener";
import { create } from "zustand";
import { errorText, ipc, type Rect } from "../../lib/ipc";
import { Icon } from "../../lib/icons";
import { clamp, cx } from "../../lib/util";
import { setPaneMeta } from "../../state/actions";
import { setSetting, settings } from "../../state/settings";
import { useModel } from "../../state/store";
import { ui, useOverlayOpen, type MenuItem } from "../../state/ui";
import { ModuleMessage } from "../common";
import type { ModuleDef, ModuleProps } from "../registry";
import "./web.css";

// ── live page state, fed by backend events (survives pane re-mounts) ─────

interface Live {
  url?: string;
  loading?: boolean;
}

const useLive = create<Record<string, Live>>(() => ({}));
const patchLive = (id: string, p: Live) => useLive.setState((s) => ({ [id]: { ...s[id], ...p } }));

let listening = false;
function ensureListeners() {
  if (listening) return;
  listening = true;
  Promise.all([
    listen<{ paneId: string; url: string }>("web://nav", (e) => patchLive(e.payload.paneId, { url: e.payload.url })),
    listen<{ paneId: string; url: string; loading: boolean }>("web://load", (e) =>
      patchLive(e.payload.paneId, { url: e.payload.url, loading: e.payload.loading }),
    ),
  ]).catch((e) => console.error("web pane events unavailable", e));
}

// ── helpers ──────────────────────────────────────────────────────────────

const ZOOMS = [0.25, 0.33, 0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 5];

/** Common dev-server ports offered in the localhost menu. */
const DEV_PORTS: [number, string][] = [
  [1313, "Hugo"],
  [3000, "React · Next · Rails"],
  [3001, ""],
  [4200, "Angular"],
  [4321, "Astro"],
  [5000, "Flask · ASP.NET"],
  [5173, "Vite"],
  [5174, "Vite"],
  [6006, "Storybook"],
  [8000, "Django · uvicorn"],
  [8080, "http-server"],
  [8888, "Jupyter"],
];

const SYSTEM_PROCESS = /^(system|idle|svchost|lsass|wininit|services|spoolsv|smss|csrss|winlogon|searchindexer|explorer|msedgewebview2|shellmosaic)(\.exe)?$/i;

const home = () => settings().modules.web.home;
const isWeb = (u: string) => /^https?:\/\//i.test(u);
const persistable = (u: string) => isWeb(u) || u === "about:blank";

function hostOf(url?: string | null): string {
  if (!url) return "";
  try {
    const u = new URL(url);
    return u.host.replace(/^www\./, "") || url;
  } catch {
    return url;
  }
}

function currentUrl(paneId: string, meta: Record<string, any>): string {
  return useLive.getState()[paneId]?.url ?? meta.url ?? home();
}

function copyUrl(url: string) {
  writeText(url).then(
    () => ui.toast("URL copied", "success", 1500),
    (e) => ui.toast(errorText(e), "error"),
  );
}

function openExternal(url: string) {
  openUrl(url).catch((e) => ui.toast(errorText(e), "error"));
}

const rectKey = (r: Rect) => `${r.x},${r.y},${r.width},${r.height}`;

/**
 * web_open calls in flight per pane. A pane that re-mounts (layout change) while
 * its first open is still running waits for it, then re-attaches to the view it
 * created instead of racing it for the webview label.
 */
const opening = new Map<string, Promise<unknown>>();

function openView(paneId: string, url: string, rect: Rect): Promise<string> {
  const before = opening.get(paneId);
  const p = (before ? before.catch(() => {}) : Promise.resolve()).then(() => ipc.webOpen(paneId, url, rect));
  opening.set(paneId, p);
  const done = () => opening.get(paneId) === p && opening.delete(paneId);
  p.then(done, done);
  return p;
}

type Phase = "idle" | "opening" | "open" | "error";

// ── the pane ─────────────────────────────────────────────────────────────

function WebPane({ pane, tabId, visible }: ModuleProps) {
  const id = pane.id;
  const hostRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const overlay = useOverlayOpen();
  // a magnified sibling pane must not be covered by this native view
  const otherZoomed = useModel((s) => {
    const z = s.model.tabs[tabId]?.zoomed;
    return !!z && z !== id;
  });
  const want = visible && !overlay && !otherZoomed;

  const live = useLive((s) => s[id]);
  const savedUrl: string = pane.meta.url || home();
  const url = live?.url ?? savedUrl;
  const loading = !!live?.loading;
  const zoom = typeof pane.meta.zoom === "number" ? clamp(pane.meta.zoom, 0.25, 5) : 1;

  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState("");
  const [draft, setDraft] = useState<string | null>(null); // non-null while editing the URL bar
  const [narrow, setNarrow] = useState(false);
  const [layoutTick, setLayoutTick] = useState(0);

  const phaseRef = useRef<Phase>(phase);
  const wantRef = useRef(want);
  const mounted = useRef(true);
  const openTarget = useRef<string | null>(null);
  const lastRect = useRef("");
  const boundsBusy = useRef(false);
  phaseRef.current = phase;
  wantRef.current = want;

  const setPhaseNow = (p: Phase) => {
    phaseRef.current = p;
    setPhase(p);
  };

  /** The placeholder's rectangle in window (logical) pixels, or null while it isn't laid out. */
  const rectOf = useCallback((): Rect | null => {
    const el = hostRef.current;
    if (!el) return null;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return null;
    const x = Math.round(r.left);
    const y = Math.round(r.top);
    return { x, y, width: Math.round(r.right) - x, height: Math.round(r.bottom) - y };
  }, []);

  /** Move the native view onto the placeholder if it moved or resized. */
  const syncBounds = useCallback(
    (force = false) => {
      if (phaseRef.current !== "open") return;
      const r = rectOf();
      if (!r) return;
      const k = rectKey(r);
      if (!force && (k === lastRect.current || boundsBusy.current)) return;
      lastRect.current = k;
      boundsBusy.current = true;
      ipc
        .webBounds(id, r)
        .catch(() => {})
        .finally(() => (boundsBusy.current = false));
    },
    [id, rectOf],
  );

  // mount / unmount: unmount only hides (the pane may just be re-parented by a layout change)
  useEffect(() => {
    mounted.current = true;
    ensureListeners();
    return () => {
      mounted.current = false;
      ipc.webVisible(id, false).catch(() => {});
    };
  }, [id]);

  // create (or re-attach to) the native view the first time we're on screen
  useEffect(() => {
    if (!want || phaseRef.current !== "idle") return;
    const rect = rectOf();
    if (!rect) return;
    setPhaseNow("opening");
    const explicit = openTarget.current;
    openTarget.current = null;
    openView(id, explicit ?? savedUrl, rect).then(
      (final) => {
        lastRect.current = rectKey(rect);
        phaseRef.current = "open";
        if (explicit || !useLive.getState()[id]?.url) patchLive(id, { url: final });
        // web_open shows the view; correct that if things changed meanwhile
        ipc.webVisible(id, mounted.current && wantRef.current).catch(() => {});
        if (!mounted.current) return;
        setPhase("open");
        const queued = openTarget.current;
        openTarget.current = null;
        if (queued) ipc.webNavigate(id, queued).then((u) => patchLive(id, { url: u }), (e) => ui.toast(errorText(e), "error"));
      },
      (e) => {
        phaseRef.current = "error";
        if (!mounted.current) return;
        setError(errorText(e));
        setPhase("error");
      },
    );
    // savedUrl is deliberately read only at open time: later changes come from the view itself
  }, [want, phase, layoutTick, id, rectOf]);

  // show / hide
  useEffect(() => {
    if (phase !== "open") return;
    if (want) {
      syncBounds(true);
      ipc.webVisible(id, true).catch(() => {});
    } else ipc.webVisible(id, false).catch(() => {});
  }, [want, phase, id, syncBounds]);

  // follow the placeholder while on screen: layouts can move it without resizing it
  useEffect(() => {
    if (phase !== "open" || !want) return;
    let raf = 0;
    const loop = () => {
      syncBounds();
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    const onResize = () => syncBounds();
    window.addEventListener("resize", onResize);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", onResize);
    };
  }, [phase, want, syncBounds]);

  // size changes: compact toolbar, immediate re-sync, and a nudge to open once laid out
  useLayoutEffect(() => {
    const el = hostRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      if (width > 0) setNarrow(width < 560);
      if (phaseRef.current === "idle" && width > 1 && height > 1) setLayoutTick((t) => t + 1);
      else syncBounds();
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [syncBounds]);

  useEffect(() => {
    if (phase === "open") ipc.webZoom(id, zoom).catch(() => {});
  }, [zoom, phase, id]);

  // persist the page (debounced) so restarts reopen it
  const liveUrl = live?.url;
  useEffect(() => {
    if (!liveUrl || liveUrl === pane.meta.url || !persistable(liveUrl)) return;
    const t = setTimeout(() => setPaneMeta(id, { url: liveUrl }), 700);
    return () => clearTimeout(t);
  }, [liveUrl, pane.meta.url, id]);

  useEffect(() => {
    ui.setTitle(id, hostOf(url));
  }, [url, id]);

  // ── actions ──
  const retry = () => {
    setError("");
    setPhaseNow("idle");
    setLayoutTick((t) => t + 1);
  };

  const go = async (raw: string) => {
    const text = raw.trim();
    setDraft(null);
    inputRef.current?.blur();
    if (!text) return;
    if (phaseRef.current !== "open") {
      openTarget.current = text;
      if (phaseRef.current !== "opening") retry();
      return;
    }
    try {
      patchLive(id, { url: await ipc.webNavigate(id, text) });
    } catch (e) {
      ui.toast(errorText(e), "error");
    }
  };

  const act = (a: "back" | "forward" | "reload" | "stop") => {
    if (phaseRef.current !== "open") {
      if (a === "reload" && phaseRef.current === "error") retry();
      return;
    }
    if (a === "stop") patchLive(id, { loading: false });
    ipc.webAction(id, a).catch((e) => ui.toast(errorText(e), "error"));
  };

  const setZoom = (z: number) => setPaneMeta(id, { zoom: Math.abs(z - 1) < 0.001 ? null : clamp(z, 0.25, 5) });
  const stepZoom = (dir: 1 | -1) =>
    setZoom(dir > 0 ? ZOOMS.find((z) => z > zoom + 0.001) ?? 5 : [...ZOOMS].reverse().find((z) => z < zoom - 0.001) ?? 0.25);
  const zoomLabel = `${Math.round(zoom * 100)}%`;

  const anchorOf = (e: React.MouseEvent) => {
    const r = e.currentTarget.getBoundingClientRect();
    return { x: r.left, y: r.bottom + 4 };
  };

  const openLocalMenu = (e: React.MouseEvent) => {
    const at = anchorOf(e);
    const build = (open: Map<number, string> | null): MenuItem[] => {
      const known = new Set(DEV_PORTS.map(([p]) => p));
      const extra = open ? [...open.keys()].filter((p) => !known.has(p)).sort((a, b) => a - b).slice(0, 10) : [];
      const item = (port: number, hint: string): MenuItem => {
        const proc = open?.get(port);
        const up = proc !== undefined;
        return {
          label: `localhost:${port}`,
          icon: up ? "circle-dot" : "circle",
          iconColor: up ? "var(--success)" : undefined,
          hint: (up && proc) || hint || undefined,
          onSelect: () => go(`http://localhost:${port}`),
        };
      };
      return [
        { type: "header", label: open ? "Localhost" : "Localhost · checking ports…" },
        ...DEV_PORTS.map(([p, h]) => item(p, h)),
        ...(extra.length ? [{ type: "header", label: "Also listening" } as MenuItem, ...extra.map((p) => item(p, ""))] : []),
        { type: "separator" },
        {
          label: "Other port…",
          icon: "plus",
          onSelect: async () => {
            const v = await ui.prompt("Open localhost", "", { placeholder: "Port, e.g. 5173 or 5173/docs", okLabel: "Open" });
            const t = v?.trim().replace(/^:/, "");
            if (t) go(/^\d/.test(t) ? `http://localhost:${t}` : t);
          },
        },
      ];
    };
    const first = build(null);
    ui.openMenu(at, first);
    const update = (open: Map<number, string>) => ui.get().menu?.items === first && ui.openMenu(at, build(open));
    ipc.netSockets().then(
      (socks) => {
        const open = new Map<number, string>();
        for (const s of socks) {
          if (s.proto !== "TCP" || s.state !== "Listen" || s.localPort < 1024 || s.localPort >= 49152) continue;
          if (import.meta.env.DEV && s.localPort === 1420) continue; // the app's own dev server
          if (!/^(127\.0\.0\.1|0\.0\.0\.0|::1?)$/.test(s.localAddr)) continue;
          if (s.process && SYSTEM_PROCESS.test(s.process)) continue;
          if (!open.has(s.localPort)) open.set(s.localPort, (s.process ?? "").replace(/\.exe$/i, ""));
        }
        update(open);
      },
      () => update(new Map()),
    );
  };

  const openMoreMenu = (e: React.MouseEvent) => {
    ui.openMenu(anchorOf(e), [
      { label: "Zoom in", icon: "zoom-in", disabled: zoom >= 5, onSelect: () => stepZoom(1) },
      { label: "Zoom out", icon: "zoom-out", disabled: zoom <= 0.25, onSelect: () => stepZoom(-1) },
      { label: "Reset zoom", icon: "search", hint: zoomLabel, disabled: zoom === 1, onSelect: () => setZoom(1) },
      { type: "separator" },
      { label: "Home", icon: "home", onSelect: () => go(home()) },
      { label: "Copy URL", icon: "copy", onSelect: () => copyUrl(url) },
      { label: "Open in browser", icon: "external-link", onSelect: () => openExternal(url) },
      { label: "Set as home page", icon: "pin", onSelect: () => setHome(url) },
    ]);
  };

  // ── render ──
  const editing = draft !== null;
  const secure = url.startsWith("https://");
  const host = hostOf(url);

  let placeholder: React.ReactNode;
  if (phase === "error") {
    placeholder = (
      <ModuleMessage icon="warning" title="Couldn't open this page">
        <p className="dim selectable web-error">{error}</p>
        <p className="dim mono web-error">{url}</p>
        <div className="row">
          <button className="btn primary" onClick={retry}>
            <Icon name="refresh" size={14} /> Retry
          </button>
          <button className="btn" onClick={() => go(home())}>
            <Icon name="home" size={14} /> Go home
          </button>
          {isWeb(url) && (
            <button className="btn subtle" onClick={() => openExternal(url)}>
              <Icon name="external-link" size={14} /> Open in browser
            </button>
          )}
        </div>
      </ModuleMessage>
    );
  } else {
    placeholder = (
      <div className="web-placeholder">
        <Icon name={phase === "open" ? "globe" : "loader"} size={22} className={cx(phase !== "open" && "web-spin")} />
        <span>{phase === "open" ? host : `Opening ${host}…`}</span>
      </div>
    );
  }

  return (
    <div className={cx("module web", narrow && "narrow")}>
      <div className="toolbar web-toolbar">
        <button className="icon-btn" title="Back" disabled={phase !== "open"} onClick={() => act("back")}>
          <Icon name="arrow-left" size={15} />
        </button>
        <button className="icon-btn" title="Forward" disabled={phase !== "open"} onClick={() => act("forward")}>
          <Icon name="arrow-right" size={15} />
        </button>
        <button className="icon-btn" title={loading ? "Stop" : "Reload"} onClick={() => act(loading ? "stop" : "reload")}>
          <Icon name={loading ? "x" : "rotate-cw"} size={14} />
        </button>
        {!narrow && (
          <button className="icon-btn" title={`Home (${hostOf(home())})`} onClick={() => go(home())}>
            <Icon name="home" size={14} />
          </button>
        )}
        <form
          className="web-url"
          onSubmit={(e) => {
            e.preventDefault();
            go(draft ?? url);
          }}
        >
          <Icon name={secure ? "lock" : "globe"} size={12} className={cx("web-url-icon", secure && "secure")} />
          <input
            ref={inputRef}
            value={editing ? draft : url}
            spellCheck={false}
            autoComplete="off"
            placeholder="Search or enter address"
            onFocus={(e) => {
              setDraft(url);
              const el = e.currentTarget;
              requestAnimationFrame(() => el.select());
            }}
            onBlur={() => setDraft(null)}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                setDraft(null);
                e.currentTarget.blur();
              }
            }}
          />
        </form>
        <button className="icon-btn" title="Localhost dev servers" onClick={openLocalMenu}>
          <Icon name="server" size={14} />
        </button>
        {!narrow && (
          <div className="web-zoom">
            <button className="icon-btn" title="Zoom out" disabled={zoom <= 0.25} onClick={() => stepZoom(-1)}>
              <Icon name="zoom-out" size={14} />
            </button>
            <button className={cx("web-zoom-label", zoom !== 1 && "changed")} title="Reset zoom" onClick={() => setZoom(1)}>
              {zoomLabel}
            </button>
            <button className="icon-btn" title="Zoom in" disabled={zoom >= 5} onClick={() => stepZoom(1)}>
              <Icon name="zoom-in" size={14} />
            </button>
          </div>
        )}
        {!narrow && (
          <button className="icon-btn" title="Copy URL" onClick={() => copyUrl(url)}>
            <Icon name="copy" size={14} />
          </button>
        )}
        <button className="icon-btn" title="Open in browser" disabled={!isWeb(url)} onClick={() => openExternal(url)}>
          <Icon name="external-link" size={14} />
        </button>
        {narrow && (
          <button className="icon-btn" title="More" onClick={openMoreMenu}>
            <Icon name="ellipsis" size={14} />
          </button>
        )}
        {loading && <div className="web-progress" />}
      </div>
      <div ref={hostRef} className="web-host">
        {placeholder}
      </div>
    </div>
  );
}

function setHome(url: string) {
  if (!isWeb(url)) return ui.toast("Only web pages can be the home page", "warning");
  setSetting("modules.web.home", url);
  ui.toast(`Home page set to ${hostOf(url)}`, "success", 2000);
}

export const webModule: ModuleDef = {
  id: "web",
  name: "Web",
  icon: "globe",
  description: "Browse the web, docs or localhost",
  component: WebPane,
  defaultMeta: () => ({ url: settings().modules.web.home }),
  title: (pane, rt) => rt.title || hostOf(pane.meta.url) || "Web",
  menu: (pane) => {
    const url = currentUrl(pane.id, pane.meta);
    return [
      { label: "Reload", icon: "rotate-cw", onSelect: () => ipc.webAction(pane.id, "reload").catch(() => {}) },
      { label: "Open in browser", icon: "external-link", disabled: !isWeb(url), onSelect: () => openExternal(url) },
      { label: "Copy URL", icon: "copy", onSelect: () => copyUrl(url) },
      { label: "Set as home page", icon: "home", onSelect: () => setHome(url) },
      { label: "Reset zoom", icon: "search", disabled: !pane.meta.zoom, onSelect: () => setPaneMeta(pane.id, { zoom: null }) },
    ];
  },
  onRemove: (paneId) => {
    const close = () => ipc.webClose(paneId).catch(() => {});
    (opening.get(paneId) ?? Promise.resolve()).then(close, close);
    ui.setTitle(paneId, "");
    useLive.setState((s) => {
      const next = { ...s };
      delete next[paneId];
      return next;
    }, true);
  },
};
