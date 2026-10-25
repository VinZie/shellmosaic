import { openUrl } from "@tauri-apps/plugin-opener";
import { useEffect, type ReactNode } from "react";
import { Icon, ICONS } from "../../lib/icons";
import type { CatalogEntry, StoreState } from "../../lib/ipc";
import { cx, formatBytes } from "../../lib/util";
import {
  availableUpdates,
  cancelQueued,
  isNewer,
  loadCatalog,
  queueInstall,
  queueRemove,
  refreshStoreState,
  restartApp,
  useModuleStore,
  versionAtLeast,
} from "../../state/moduleStore";
import { updateSettings, useSettings } from "../../state/settings";
import { ui } from "../../state/ui";
import { Group, Hl, Section, Switch, useMatch, useSearch } from "./controls";
import { permInfo } from "./Plugins";

const REPO_URL = "https://github.com/VinZie/shellmosaic/tree";

type Status =
  | { kind: "available" }
  | { kind: "installed"; version: string }
  | { kind: "update"; version: string }
  | { kind: "queued-install"; update: boolean }
  | { kind: "queued-remove" }
  | { kind: "incompatible" };

function statusOf(m: CatalogEntry, state: StoreState | null): Status {
  const queued = state?.pending.find((p) => p.id === m.id);
  const have = state?.installed[m.id];
  if (queued) return queued.op === "remove" ? { kind: "queued-remove" } : { kind: "queued-install", update: !!have };
  if (state && !versionAtLeast(state.appVersion, m.minAppVersion)) return { kind: "incompatible" };
  if (!have) return { kind: "available" };
  return isNewer(m.version, have.version) ? { kind: "update", version: have.version } : { kind: "installed", version: have.version };
}

function permissionList(perms: string[]): string {
  return perms.length ? perms.map((p) => `• ${permInfo(p)?.text ?? p}`).join("\n") : "It needs no special permissions.";
}

async function install(m: CatalogEntry, update: boolean) {
  const ok = await ui.confirm(
    update ? `Update ${m.name} to ${m.version}?` : `Install ${m.name}?`,
    <>
      <p>It will be allowed to:</p>
      <p className="selectable" style={{ whiteSpace: "pre-line" }}>
        {permissionList(m.permissions)}
      </p>
      <p className="dim">It's downloaded and checked now, and {update ? "updated" : "installed"} the next time Shellmosaic starts. You can queue more modules and restart once.</p>
    </>,
    { okLabel: update ? "Update" : "Install" },
  );
  if (ok) queueInstall(m, update);
}

function ModuleCard({ m, state }: { m: CatalogEntry; state: StoreState | null }) {
  const busy = useModuleStore((s) => !!s.busy[m.id]);
  const disabled = useSettings((s) => s.settings.plugins.disabled.includes(m.id));
  const match = useMatch(m.name, m.id, m.description, "optional module");
  if (!match) return null;
  const st = statusOf(m, state);
  const icon = Object.prototype.hasOwnProperty.call(ICONS, m.icon) ? m.icon : "puzzle";
  const installed = st.kind === "installed" || st.kind === "update";
  const replacesLocal = state?.local.includes(m.id) && !state.installed[m.id];
  const size = m.files.reduce((a, f) => a + f.size, 0);

  const chip: ReactNode = {
    available: null,
    installed: <span className="chip granted">Installed</span>,
    update: <span className="chip accent">Update available</span>,
    "queued-install": <span className="chip accent">{st.kind === "queued-install" && st.update ? "Updates" : "Installs"} at restart</span>,
    "queued-remove": <span className="chip risky">Removed at restart</span>,
    incompatible: <span className="chip risky">Needs Shellmosaic {m.minAppVersion}</span>,
  }[st.kind];

  return (
    <div className={cx("plugin-card setting-hit", installed && disabled && "disabled")}>
      <span className="plugin-icon">
        <Icon name={icon} size={18} />
      </span>
      <div className="plugin-body">
        <div className="plugin-title">
          <strong>
            <Hl text={m.name} />
          </strong>
          <span className="chip">v{st.kind === "update" ? `${st.version} → ${m.version}` : m.version}</span>
          {chip}
          <span className="grow" />
          {installed && (
            <>
              <span className="plugin-state dim">{disabled ? "Disabled" : "Enabled"}</span>
              <Switch
                value={!disabled}
                title={disabled ? "Enable" : "Disable"}
                onChange={(on) =>
                  updateSettings((s) => {
                    s.plugins.disabled = on ? s.plugins.disabled.filter((x) => x !== m.id) : [...new Set([...s.plugins.disabled, m.id])];
                  })
                }
              />
            </>
          )}
        </div>
        {m.description && <p className="plugin-desc">{m.description}</p>}
        <div className="perm-chips">
          {m.permissions.length === 0 && <span className="dim small-text">Needs no special permissions.</span>}
          {m.permissions.map((p) => {
            const info = permInfo(p);
            return (
              <span key={p} className={cx("chip", info?.risky && "risky")} title={info?.text ?? p}>
                <Icon name={info?.icon ?? "shield"} size={11} />
                {p}
              </span>
            );
          })}
        </div>
        {replacesLocal && st.kind === "available" && (
          <p className="optmod-note warn-text">
            <Icon name="warning" size={12} /> You have your own plugin named “{m.id}”. Installing this replaces it (your copy is kept in the data folder under store\replaced).
          </p>
        )}
        <div className="plugin-foot">
          <code className="plugin-id">{m.id}</code>
          <span className="dim small-text">· {formatBytes(size)}</span>
          <span className="grow" />
          {busy && <Icon name="loader" size={14} className="spin" />}
          {st.kind === "available" && (
            <button className="btn small primary" disabled={busy} onClick={() => install(m, false)}>
              <Icon name="download" size={13} /> Install
            </button>
          )}
          {st.kind === "update" && (
            <button className="btn small primary" disabled={busy} onClick={() => install(m, true)}>
              <Icon name="download" size={13} /> Update
            </button>
          )}
          {installed && (
            <button className="btn small danger subtle" disabled={busy} onClick={() => queueRemove(m.id, m.name)}>
              <Icon name="trash" size={13} /> Remove
            </button>
          )}
          {(st.kind === "queued-install" || st.kind === "queued-remove") && (
            <button className="btn small subtle" disabled={busy} onClick={() => cancelQueued(m.id)}>
              <Icon name="undo" size={13} /> Undo
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

/** Installed modules the catalog doesn't list (any more, or on this channel). */
function OrphanCard({ id, version, state }: { id: string; version: string; state: StoreState }) {
  const busy = useModuleStore((s) => !!s.busy[id]);
  const match = useMatch(id, "optional module");
  if (!match) return null;
  const queued = state.pending.some((p) => p.id === id && p.op === "remove");
  return (
    <div className="plugin-card setting-hit">
      <span className="plugin-icon">
        <Icon name="puzzle" size={18} />
      </span>
      <div className="plugin-body">
        <div className="plugin-title">
          <strong>
            <Hl text={id} />
          </strong>
          <span className="chip">v{version}</span>
          {queued ? <span className="chip risky">Removed at restart</span> : <span className="chip granted">Installed</span>}
        </div>
        <p className="plugin-desc">Not in the catalog for this update channel. It keeps working; remove it if you don't use it.</p>
        <div className="plugin-foot">
          <code className="plugin-id">{id}</code>
          <span className="grow" />
          {queued ? (
            <button className="btn small subtle" disabled={busy} onClick={() => cancelQueued(id)}>
              <Icon name="undo" size={13} /> Undo
            </button>
          ) : (
            <button className="btn small danger subtle" disabled={busy} onClick={() => queueRemove(id, id)}>
              <Icon name="trash" size={13} /> Remove
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function PendingBanner({ state }: { state: StoreState }) {
  const busy = useModuleStore((s) => Object.keys(s.busy).length > 0);
  if (!state.pending.length) return null;
  const describe = state.pending.map((p) => `${p.op === "remove" ? "remove" : state.installed[p.id] ? "update" : "install"} ${p.name}`).join(" · ");
  return (
    <div className="optmod-pending setting-hit">
      <Icon name="rotate-cw" size={16} />
      <div className="grow">
        <b>
          {state.pending.length === 1 ? "1 change" : `${state.pending.length} changes`} will apply when Shellmosaic restarts
        </b>
        <div className="dim">{describe}</div>
      </div>
      <button className="btn small subtle" disabled={busy} onClick={() => cancelQueued()}>
        Undo all
      </button>
      <button className="btn small primary" disabled={busy} onClick={() => restartApp()}>
        <Icon name="rotate-cw" size={13} /> Restart now
      </button>
    </div>
  );
}

export function OptionalModulesSection() {
  const { state, catalog, catalogError, loading } = useModuleStore();
  const channel = useSettings((s) => s.settings.updates.channel);
  const q = useSearch();

  useEffect(() => {
    refreshStoreState();
    if (!useModuleStore.getState().catalog) loadCatalog();
  }, [channel]);

  const listed = new Set(catalog?.modules.map((m) => m.id) ?? []);
  const orphans = state && catalog ? Object.entries(state.installed).filter(([id]) => !listed.has(id)) : [];
  const updates = availableUpdates(state, catalog);
  const branch = channel === "test" ? "test" : "main";

  return (
    <Section
      id="optional-modules"
      title="Optional modules"
      icon="blocks"
      desc="Extra modules made for Shellmosaic and published in its GitHub repository. Each download is checked against Shellmosaic's release signature before it's installed."
    >
      {state && <PendingBanner state={state} />}
      <Group
        title={updates.length ? `Modules · ${updates.length} update${updates.length === 1 ? "" : "s"}` : "Modules"}
        plain
        actions={
          <>
            {updates.length > 0 && (
              <button className="btn small" onClick={() => updates.forEach((m) => queueInstall(m, true))}>
                <Icon name="download" size={13} /> Update all
              </button>
            )}
            <button className="btn small subtle" disabled={loading} onClick={() => loadCatalog(true)} title="Look for new modules and updates">
              <Icon name="refresh" size={13} className={loading ? "spin" : undefined} /> Check for updates
            </button>
          </>
        }
      >
        {catalogError && (
          <div className="settings-empty small danger-text">
            {catalogError}{" "}
            <button className="btn small subtle" onClick={() => loadCatalog(true)}>
              Try again
            </button>
          </div>
        )}
        {!catalog && !catalogError && <div className="settings-empty small">Loading the module catalog…</div>}
        <div className="plugin-list">
          {catalog?.modules.map((m) => <ModuleCard key={m.id} m={m} state={state} />)}
          {state && orphans.map(([id, info]) => <OrphanCard key={id} id={id} version={info.version} state={state} />)}
        </div>
        {catalog && !q && (
          <p className="optmod-foot dim small-text">
            {channel === "test" ? "Test channel: modules from the " : "From the "}
            <button className="link-btn" onClick={() => openUrl(`${REPO_URL}/${branch}/modules`).catch(() => {})}>
              {branch} branch
            </button>
            {/^[0-9a-f]{40}$/.test(catalog.source) && <> at {catalog.source.slice(0, 7)}</>}. Installs and removals apply after a restart: queue as many as you like, then restart once.
          </p>
        )}
      </Group>
    </Section>
  );
}
