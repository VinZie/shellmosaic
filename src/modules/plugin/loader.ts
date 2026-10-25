// Discovers plugins (<data>/plugins/<id>/manifest.json) and registers each
// enabled, valid one as a module named "plugin:<id>".
import { create } from "zustand";
import { ICONS } from "../../lib/icons";
import { ipc, type PluginInfo, type PluginManifest } from "../../lib/ipc";
import { settings, useSettings, type Settings } from "../../state/settings";
import { ui } from "../../state/ui";
import { replacePluginModules, type ModuleDef } from "../registry";
import { PluginHeaderActions, PluginPane, pluginMenu } from "./PluginPane";

/** Result of the last scan, valid or not (Settings → Plugins can show it). */
export const usePlugins = create<{ list: PluginInfo[]; loaded: boolean }>(() => ({ list: [], loaded: false }));

const str = (v: unknown, max: number): string | undefined => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : undefined);

export function pluginModuleDef(m: PluginManifest): ModuleDef {
  const name = str(m.name, 60) ?? m.id;
  const icon = typeof m.icon === "string" && Object.prototype.hasOwnProperty.call(ICONS, m.icon) ? m.icon : "puzzle";
  const author = str(m.author, 80);
  const permissions = Array.isArray(m.permissions) ? [...new Set(m.permissions.filter((p): p is string => typeof p === "string"))] : [];
  return {
    id: `plugin:${m.id}`,
    name,
    icon,
    description: str(m.description, 300) ?? (author ? `Plugin by ${author}` : "Plugin"),
    component: PluginPane,
    headerActions: PluginHeaderActions,
    menu: (pane) => pluginMenu(pane.id),
    title: (_pane, rt) => rt.title || name,
    // ui.setTitle from the plugin would otherwise stick to the pane after "change module"
    onRemove: (paneId) => ui.setTitle(paneId, ""),
    plugin: { id: m.id, permissions, entry: str(m.entry, 512) ?? "index.html" },
  };
}

async function scan() {
  const list = await ipc.pluginsList();
  const disabled = new Set(settings().plugins.disabled);
  const defs: ModuleDef[] = [];
  for (const p of list) {
    if (!p.manifest || p.error) {
      console.warn(`[plugins] skipped "${p.id}": ${p.error ?? "invalid manifest"}`);
      continue;
    }
    if (disabled.has(p.id)) continue;
    defs.push(pluginModuleDef(p.manifest));
  }
  replacePluginModules(defs);
  usePlugins.setState({ list, loaded: true });
}

let chain: Promise<void> = Promise.resolve();
let watching = false;

const disabledKey = (s: Settings) => [...s.plugins.disabled].sort().join("\n");

/** Re-scan whenever the set of disabled plugins changes (Settings, another window). */
function watchDisabled() {
  if (watching) return;
  watching = true;
  let last = disabledKey(settings());
  useSettings.subscribe((s) => {
    const key = disabledKey(s.settings);
    if (key === last) return;
    last = key;
    loadPlugins().catch((e) => console.error("[plugins] reload failed", e));
  });
}

/** Discover plugins and register them as modules. Calls are serialized. */
export function loadPlugins(): Promise<void> {
  watchDisabled();
  const p = chain.then(scan, scan);
  chain = p.catch(() => {});
  return p;
}

/** Re-scan the plugins folder (after install/remove/enable/disable). */
export function reloadPlugins(): Promise<void> {
  return loadPlugins();
}
