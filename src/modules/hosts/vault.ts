// The saved-hosts vault as the UI sees it: whether it exists / is unlocked, and the
// host list (secrets stay in the backend). Refreshed on "vault://changed", which
// any window, the auto-lock and connections (last used, pinned host keys) emit.
import { listen } from "@tauri-apps/api/event";
import { useEffect } from "react";
import { create } from "zustand";
import { errorText, ipc, type HostView, type VaultStatus } from "../../lib/ipc";
import { clamp } from "../../lib/util";
import { setPaneMeta } from "../../state/model";
import { settings, useSettings } from "../../state/settings";
import { commit, getState } from "../../state/store";
import { ui } from "../../state/ui";

export const MIN_MASTER_PASSWORD = 8;

interface VaultState {
  /** null until the first answer */
  status: VaultStatus | null;
  /** null while locked */
  hosts: HostView[] | null;
}

export const useVault = create<VaultState>(() => ({ status: null, hosts: null }));

let seq = 0;

export async function refreshVault() {
  const id = ++seq;
  try {
    let status = await ipc.vaultStatus();
    let hosts: HostView[] | null = null;
    if (status.unlocked) {
      // (it can lock in between, and then the list fails)
      hosts = await ipc.hostsList().catch(() => null);
      if (!hosts) status = { ...status, unlocked: false };
    }
    if (id === seq) useVault.setState({ status, hosts });
  } catch (e) {
    console.error("vault status unavailable", e);
  }
}

let watching = false;
/** Start following the vault (once per window). */
export function watchVault() {
  if (watching) return;
  watching = true;
  listen("vault://changed", () => void refreshVault()).catch((e) => console.error("vault events unavailable", e));
  void refreshVault();
}

/** Vault status, following changes while mounted. */
export function useVaultStatus(): VaultStatus | null {
  useEffect(() => watchVault(), []);
  return useVault((s) => s.status);
}

/** Backend messages are lowercase fragments ("wrong master password"). */
export const sentence = (e: unknown) => {
  const t = errorText(e);
  return t ? t[0].toUpperCase() + t.slice(1) + (/[.!?]$/.test(t) ? "" : ".") : "Something went wrong.";
};

// ── actions (also used by Settings → Modules) ───────────────────────────

export async function lockVault() {
  try {
    await ipc.vaultLock();
  } catch (e) {
    ui.toast(errorText(e), "error");
  }
}

export async function resetVault(): Promise<boolean> {
  const ok = await ui.confirm(
    "Reset the vault?",
    "Every saved host, password and private key in it will be lost — use this only if you forgot the master password.\n\n" +
      "The old vault file goes to the Recycle Bin (still encrypted). Terminals and SFTP panes that are connected stay connected.",
    { okLabel: "Reset vault", danger: true },
  );
  if (!ok) return false;
  try {
    await ipc.vaultReset();
    ui.toast("Vault reset. Create a new one to save hosts again.", "success");
    return true;
  } catch (e) {
    ui.toast(errorText(e), "error");
    return false;
  }
}

/** Open SSH terminals and SFTP panes show the host's name: keep it current after an edit. */
export function syncPaneNames(host: HostView) {
  const stale = Object.values(getState().model.panes).filter(
    (p) =>
      (p.module === "terminal" && p.meta.ssh === host.id && p.meta.sshName !== host.name) ||
      (p.module === "sftp" && p.meta.hostId === host.id && p.meta.hostName !== host.name),
  );
  if (!stale.length) return;
  commit((m) => stale.forEach((p) => setPaneMeta(m, p.id, p.module === "terminal" ? { sshName: host.name } : { hostName: host.name })));
}

// ── auto-lock ───────────────────────────────────────────────────────────

let sentAutoLock: number | null = null;

function syncAutoLock() {
  // (before settings.json is read these are the defaults, not the user's choice)
  if (!useSettings.getState().loaded) return;
  const raw = settings().modules.hosts?.autoLockMinutes;
  const mins = typeof raw === "number" && Number.isFinite(raw) ? clamp(Math.round(raw), 0, 24 * 60) : 15;
  if (mins === sentAutoLock) return;
  sentAutoLock = mins;
  ipc.vaultConfigure(mins).catch((e) => {
    sentAutoLock = null;
    console.error("vault auto-lock not applied", e);
  });
}

useSettings.subscribe(syncAutoLock);
syncAutoLock();
