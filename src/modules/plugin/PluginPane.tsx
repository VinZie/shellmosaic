// A plugin module pane: the plugin's page in a sandboxed iframe, wired to the
// permission-checked broker. The frame never gets allow-same-origin, popups or
// top navigation, so its only way out is postMessage to the broker.
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Icon } from "../../lib/icons";
import { uid } from "../../lib/util";
import { focusPane } from "../../state/actions";
import { useSettings } from "../../state/settings";
import { ui, type MenuItem } from "../../state/ui";
import { ModuleMessage, useTabCwd } from "../common";
import { useModules, type ModuleProps } from "../registry";
import { attachFrame, isPrompting, requestPermissions, type Session } from "./broker";
import "./plugin.css";

export const PLUGIN_ORIGIN = "http://smplugin.localhost";

/** URL of a plugin file as served by the `smplugin` protocol. */
export function pluginUrl(pluginId: string, entry: string): string {
  const path = entry
    .replace(/\\/g, "/")
    .replace(/^(\.\/|\/)+/, "")
    .split("/")
    .map(encodeURIComponent)
    .join("/");
  return `${PLUGIN_ORIGIN}/${encodeURIComponent(pluginId)}/${path || "index.html"}`;
}

const reloaders = new Map<string, () => void>();
/** plugins whose `net` prompt was shown automatically this run */
const netAsked = new Set<string>();

/** Reload the plugin page shown in a pane. */
export function reloadPluginPane(paneId: string) {
  reloaders.get(paneId)?.();
}

export function pluginMenu(paneId: string): MenuItem[] {
  return [
    { label: "Reload plugin", icon: "refresh", onSelect: () => reloadPluginPane(paneId) },
    { label: "Plugin settings…", icon: "puzzle", onSelect: () => ui.openSettings("plugins") },
  ];
}

export function PluginHeaderActions({ pane }: ModuleProps) {
  return (
    <button className="icon-btn" title="Reload plugin" onClick={() => reloadPluginPane(pane.id)}>
      <Icon name="refresh" size={13} />
    </button>
  );
}

export function PluginPane(props: ModuleProps) {
  const def = useModules((s) => s.modules[props.pane.module]);
  if (!def?.plugin) {
    return (
      <div className="module">
        <ModuleMessage icon="puzzle" title="Plugin not available">
          <p className="dim">It may have been removed or disabled.</p>
        </ModuleMessage>
      </div>
    );
  }
  return (
    <PluginHost
      {...props}
      pluginId={def.plugin.id}
      name={def.name}
      entry={def.plugin.entry}
      permissions={def.plugin.permissions}
    />
  );
}

/** loading → loaded (document load event) / connected (first SDK message); silent/failed when neither happens in time */
type Status = "loading" | "loaded" | "connected" | "silent" | "failed";

const LOAD_TIMEOUT = 15_000;
const CONNECT_TIMEOUT = 5_000;

function PluginHost({
  pane,
  tabId,
  visible,
  pluginId,
  name,
  entry,
  permissions,
}: ModuleProps & { pluginId: string; name: string; entry: string; permissions: string[] }) {
  const frameRef = useRef<HTMLIFrameElement>(null);
  const sessionRef = useRef<Session | null>(null);
  const [nonce, setNonce] = useState(0);
  const [status, setStatus] = useState<Status>("loading");
  const [bannerHidden, setBannerHidden] = useState(false);
  const [gate, setGate] = useState<"asking" | "denied">("asking");
  const cwd = useTabCwd(tabId);
  const grants = useSettings((s) => s.settings.plugins.grants[pluginId]);
  const permKey = permissions.join(",");
  // the frame's CSP allows network access whenever the manifest declares
  // `net`, so a plugin that wants it only loads once the user granted it
  const needsNet = permissions.includes("net") && !(grants ?? []).includes("net");
  // reload the page when what it was loaded with changes
  const frameKey = `${nonce}|${entry}|${permKey}`;
  // a fresh secret per load, handed only to the page we load (see broker)
  const token = useMemo(() => uid(24), [frameKey]);

  const live = useRef({ tabId, cwd, visible, name, permissions });
  live.current = { tabId, cwd, visible, name, permissions };

  useEffect(() => {
    reloaders.set(pane.id, () => setNonce((n) => n + 1));
    return () => {
      reloaders.delete(pane.id);
    };
  }, [pane.id]);

  // ask for permissions up front when the plugin can't load without them —
  // automatically only the first time this run (not again right after the
  // user revoked `net` in Settings), or when a prompt is already showing
  useEffect(() => {
    if (!needsNet) return;
    if (netAsked.has(pluginId) && !isPrompting(pluginId)) {
      setGate("denied");
      return;
    }
    netAsked.add(pluginId);
    let alive = true;
    setGate("asking");
    requestPermissions(pluginId, live.current.name, live.current.permissions).then((ok) => {
      if (alive && !ok) setGate("denied");
    });
    return () => {
      alive = false;
    };
  }, [needsNet, pluginId, permKey]);

  // broker session for the current frame (layout effect: attached before the page can post)
  useLayoutEffect(() => {
    if (needsNet) return;
    setStatus("loading");
    setBannerHidden(false);
    const l = live.current;
    const s = attachFrame(
      () => frameRef.current,
      { pluginId, name: l.name, paneId: pane.id, tabId: l.tabId, permissions: l.permissions, cwd: l.cwd, visible: l.visible, token },
      { onConnect: () => setStatus("connected") },
    );
    sessionRef.current = s;
    return () => {
      s.dispose();
      sessionRef.current = null;
    };
  }, [pane.id, pluginId, frameKey, needsNet]);

  useEffect(() => {
    sessionRef.current?.update({ tabId, cwd, visible, name, permissions: live.current.permissions });
  }, [tabId, cwd, visible, name, permKey]);

  // notice pages that never load or never talk to us
  useEffect(() => {
    if (needsNet) return;
    if (status === "loading") {
      const t = setTimeout(() => setStatus((s) => (s === "loading" ? "failed" : s)), LOAD_TIMEOUT);
      return () => clearTimeout(t);
    }
    if (status === "loaded") {
      const t = setTimeout(() => setStatus((s) => (s === "loaded" ? "silent" : s)), CONNECT_TIMEOUT);
      return () => clearTimeout(t);
    }
  }, [status, needsNet, frameKey]);

  // clicks inside the iframe never reach the app; focus tells us instead
  useEffect(() => {
    const onBlur = () =>
      setTimeout(() => {
        if (frameRef.current && document.activeElement === frameRef.current) focusPane(pane.id);
      }, 0);
    window.addEventListener("blur", onBlur);
    return () => window.removeEventListener("blur", onBlur);
  }, [pane.id]);

  const reload = () => setNonce((n) => n + 1);

  if (needsNet) {
    return (
      <div className="module plugin-pane">
        {gate === "asking" ? (
          <ModuleMessage icon="shield" title={`${name} is waiting for permission`}>
            <p className="dim">Answer the permission prompt to start the plugin.</p>
          </ModuleMessage>
        ) : (
          <ModuleMessage icon="shield" title={`${name} needs internet access`}>
            <p className="dim">The plugin won't start until you allow the permissions it asks for.</p>
            <div className="row">
              <button
                className="btn primary"
                onClick={() => {
                  setGate("asking");
                  requestPermissions(pluginId, name, permissions, { force: true }).then((ok) => !ok && setGate("denied"));
                }}
              >
                <Icon name="shield" size={14} /> Review permissions…
              </button>
            </div>
          </ModuleMessage>
        )}
      </div>
    );
  }

  return (
    <div className="module plugin-pane">
      <iframe
        key={frameKey}
        ref={frameRef}
        className="plugin-frame"
        title={name}
        src={`${pluginUrl(pluginId, entry)}#smt=${token}`}
        // no allow-modals: an alert() loop would freeze the whole app, and the pane comes back on restart
        sandbox="allow-scripts allow-forms"
        referrerPolicy="no-referrer"
        onLoad={() => setStatus((s) => (s === "connected" ? s : "loaded"))}
      />
      {status === "loading" && (
        <div className="plugin-loading">
          <Icon name="loader" size={20} />
        </div>
      )}
      {status === "failed" && (
        <div className="plugin-overlay">
          <ModuleMessage icon="warning" title={`${name} didn't load`}>
            <p className="dim">The plugin page took too long to load or couldn't be found.</p>
            <div className="row">
              <button className="btn" onClick={reload}>
                <Icon name="refresh" size={14} /> Try again
              </button>
              <button className="btn subtle" onClick={() => ui.openSettings("plugins")}>
                Plugin settings…
              </button>
            </div>
          </ModuleMessage>
        </div>
      )}
      {status === "silent" && !bannerHidden && (
        <div className="plugin-banner" role="status">
          <Icon name="warning" size={14} className="plugin-banner-icon" />
          <span className="grow">This plugin hasn't connected to Shellmosaic. It may have failed to load.</span>
          <button className="btn small" onClick={reload}>
            Reload
          </button>
          <button className="icon-btn" title="Dismiss" onClick={() => setBannerHidden(true)}>
            <Icon name="x" size={13} />
          </button>
        </div>
      )}
    </div>
  );
}
