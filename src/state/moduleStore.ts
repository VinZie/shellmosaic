// Optional modules: the signed catalog in the Shellmosaic repository, what's installed,
// and the installs/removals queued for the next start (they apply when the app restarts,
// so several can be lined up and applied together).
import { getCurrentWindow } from "@tauri-apps/api/window";
import { create } from "zustand";
import { errorText, ipc, type Catalog, type CatalogEntry, type StoreState } from "../lib/ipc";
import { useModules } from "../modules/registry";
import { addModule } from "./actions";
import { saveSettingsNow, settings, updateSettings, useSettings } from "./settings";
import { ui } from "./ui";

interface ModuleStore {
  state: StoreState | null;
  catalog: Catalog | null;
  catalogError: string | null;
  loading: boolean;
  /** module ids with a download or queue change in progress */
  busy: Record<string, boolean>;
}

export const useModuleStore = create<ModuleStore>(() => ({ state: null, catalog: null, catalogError: null, loading: false, busy: {} }));

const set = (patch: Partial<ModuleStore>) => useModuleStore.setState(patch);

/** "0.10.0" > "0.9.3"; pre-release suffixes are ignored. */
export function versionAtLeast(have: string, need: string): boolean {
  const parse = (v: string) => v.split(/[-+]/)[0].split(".").map((n) => parseInt(n, 10) || 0);
  const a = parse(have);
  const b = parse(need);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) return x > y;
  }
  return true;
}

export const isNewer = (candidate: string, current: string) => candidate !== current && versionAtLeast(candidate, current);

/** Installed modules the catalog has a newer (and compatible) version of. */
export function availableUpdates(state: StoreState | null, catalog: Catalog | null): CatalogEntry[] {
  if (!state || !catalog) return [];
  return catalog.modules.filter((m) => {
    const have = state.installed[m.id];
    return have && isNewer(m.version, have.version) && versionAtLeast(state.appVersion, m.minAppVersion) && !state.pending.some((p) => p.id === m.id);
  });
}

export async function refreshStoreState() {
  try {
    set({ state: await ipc.storeState() });
  } catch (e) {
    console.warn("optional modules: couldn't read the store state", e);
  }
}

export async function loadCatalog(refresh = false) {
  set({ loading: true });
  try {
    set({ catalog: await ipc.storeCatalog(settings().updates.channel, refresh), catalogError: null });
  } catch (e) {
    set({ catalogError: errorText(e) });
  } finally {
    set({ loading: false });
  }
}

async function withBusy(id: string, fn: () => Promise<StoreState>) {
  set({ busy: { ...useModuleStore.getState().busy, [id]: true } });
  try {
    set({ state: await fn() });
    return true;
  } catch (e) {
    ui.toast(errorText(e), "error", 7000);
    return false;
  } finally {
    const busy = { ...useModuleStore.getState().busy };
    delete busy[id];
    set({ busy });
  }
}

/** Download and verify now; it's installed (or updated) at the next start. */
export async function queueInstall(m: CatalogEntry, update = false) {
  const ok = await withBusy(m.id, () => ipc.storeQueueInstall(settings().updates.channel, m.id));
  if (ok) ui.toast(`${m.name} will be ${update ? "updated" : "installed"} when Shellmosaic restarts`, "success", 4500);
}

export async function queueRemove(id: string, name: string) {
  const ok = await withBusy(id, () => ipc.storeQueueRemove(id, name));
  if (ok) ui.toast(`${name} will be removed when Shellmosaic restarts`, "info", 4500);
}

export async function cancelQueued(id?: string) {
  await withBusy(id ?? "*", () => ipc.storeCancel(id));
}

/**
 * Save everything and start Shellmosaic again (asking first). With `elevated`, Windows asks
 * for administrator rights; declining leaves the app running. Resolves false when nothing happened.
 */
export async function restartApp(opts: { elevated?: boolean; reason?: string } = {}): Promise<boolean> {
  const pending = useModuleStore.getState().state?.pending.length ?? 0;
  const ok = await ui.confirm(
    opts.elevated ? "Restart as administrator?" : "Restart Shellmosaic?",
    [
      opts.reason,
      opts.elevated
        ? "Shellmosaic closes and starts again with administrator rights (Windows asks you first)."
        : pending
          ? `Shellmosaic closes and starts again to apply ${pending === 1 ? "1 change" : `${pending} changes`} to your optional modules.`
          : "Shellmosaic closes and starts again.",
      "Your workspaces, tabs and panes come back; programs running in terminals are started again.",
      opts.elevated ? "While elevated, files can't be dragged in from Explorer." : "",
    ]
      .filter(Boolean)
      .join(" "),
    { okLabel: opts.elevated ? "Restart as administrator" : "Restart now" },
  );
  if (!ok) return false;
  try {
    await saveSettingsNow();
    await ipc.appRestart(!!opts.elevated);
    return true;
  } catch (e) {
    ui.toast(errorText(e), "warning", 6000);
    return false;
  }
}

/**
 * Open an optional module next to a pane, with arguments (e.g. {pid}). When it isn't
 * installed, point the user to where it can be.
 */
export function openOptional(id: string, name: string, args: Record<string, unknown>, near: { tabId: string; paneId: string }) {
  if (useModules.getState().modules[`plugin:${id}`]) {
    addModule(`plugin:${id}`, { tabId: near.tabId, target: near.paneId, side: "right", meta: { args } });
    return;
  }
  const queued = useModuleStore.getState().state?.pending.some((p) => p.id === id && p.op === "install");
  ui.toast(queued ? `${name} is installed when Shellmosaic restarts` : `${name} is an optional module: install it here`, "info", 5000);
  ui.openSettings("optional-modules");
}

/** Whether an optional module is installed and enabled (to show its menu entries). */
export const hasOptional = (id: string) => !!useModules.getState().modules[`plugin:${id}`];

/**
 * At start (main window): report what the changes queued before the restart did, and give
 * installed modules the permissions the user saw when they chose to install them. Runs
 * before plugins load, so their panes don't ask again.
 */
export async function startModuleStore() {
  const main = getCurrentWindow().label === "main";
  let state: StoreState;
  try {
    state = await ipc.storeState();
  } catch (e) {
    console.warn("optional modules: couldn't read the store state", e);
    return;
  }
  set({ state });

  // another channel has another catalog
  let channel = settings().updates.channel;
  useSettings.subscribe((s) => {
    if (s.settings.updates.channel === channel) return;
    channel = s.settings.updates.channel;
    set({ catalog: null, catalogError: null });
  });
  if (!main) return;

  const done = state.lastApply;
  if (done.length) {
    updateSettings((s) => {
      for (const r of done) {
        if (!r.ok) continue;
        s.plugins.disabled = s.plugins.disabled.filter((x) => x !== r.id);
        if (r.op === "install") s.plugins.grants[r.id] = [...new Set(r.permissions)];
        else delete s.plugins.grants[r.id];
      }
    });
    const names = (op: string) => done.filter((r) => r.ok && r.op === op).map((r) => r.name);
    const installed = names("install");
    const removed = names("remove");
    const list = (xs: string[]) => (xs.length > 1 ? `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}` : xs[0]);
    if (installed.length) ui.toast(`Installed ${list(installed)}. Add ${installed.length > 1 ? "them" : "it"} from the module bar.`, "success", 6000);
    if (removed.length) ui.toast(`Removed ${list(removed)}`, "info", 4000);
    for (const r of done.filter((r) => !r.ok)) ui.toast(`Couldn't ${r.op} ${r.name}: ${r.error ?? "unknown error"}`, "error", 9000);
    ipc.storeAck().then(refreshStoreState, () => {});
  }

  // look for module updates a little after start, like app updates
  setTimeout(async () => {
    if (!settings().updates.autoCheck) return;
    await loadCatalog();
    const n = availableUpdates(useModuleStore.getState().state, useModuleStore.getState().catalog).length;
    if (n) ui.toast(`${n === 1 ? "An optional module has" : `${n} optional modules have`} an update: Settings → Optional modules`, "info", 8000);
  }, 25_000);
}
