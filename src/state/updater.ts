// Updates from the GitHub releases (tauri-plugin-updater: packages are signed with the
// release key and verified before anything is installed). The user is always asked
// first: update now, skip this version, or decide later.
import { getCurrentWindow } from "@tauri-apps/api/window";
import { relaunch } from "@tauri-apps/plugin-process";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { errorText, ipc } from "../lib/ipc";
import { flushSettings, setSetting, settings } from "./settings";
import { ui } from "./ui";

let busy = false;

export async function checkForUpdates(opts: { manual?: boolean } = {}): Promise<void> {
  if (busy) return;
  busy = true;
  try {
    const update = await check({ timeout: 30_000 });
    if (!update) {
      if (opts.manual) ui.toast("Shellmosaic is up to date", "success");
      return;
    }
    // a skipped version only comes back when the user checks by hand
    if (!opts.manual && settings().updates.skipped === update.version) return;
    const choice = await ui.askUpdate({ current: update.currentVersion, version: update.version, notes: update.body ?? "" });
    if (choice === "skip") setSetting("updates.skipped", update.version);
    else if (choice === "update") await install(update);
  } catch (e) {
    if (opts.manual) ui.toast(`Couldn't check for updates: ${errorText(e)}`, "error", 6000);
    else console.warn("update check failed", e);
  } finally {
    busy = false;
  }
}

async function install(update: Update) {
  let total = 0;
  let done = 0;
  let shown = 0;
  try {
    // the installer ends the app without the usual exit: save everything first
    flushSettings();
    await ipc.appPersist();
    ui.toast(`Downloading Shellmosaic ${update.version}…`, "info", 4000);
    await update.downloadAndInstall((ev) => {
      if (ev.event === "Started") total = ev.data.contentLength ?? 0;
      else if (ev.event === "Progress") {
        done += ev.data.chunkLength;
        if (total && done / total - shown >= 0.25) {
          shown = done / total;
          ui.toast(`Downloading update… ${Math.round(shown * 100)}%`, "info", 2500);
        }
      } else if (ev.event === "Finished") ui.toast("Installing the update…", "info", 8000);
    });
    // Windows: the installer has closed the app and starts the new version itself
    await relaunch();
  } catch (e) {
    ui.toast(`The update failed: ${errorText(e)}`, "error", 8000);
  }
}

/** Check shortly after start, then every 6 hours (from the main window only). */
export function startUpdateChecks() {
  if (getCurrentWindow().label !== "main") return;
  const run = () => {
    if (settings().updates.autoCheck) checkForUpdates();
  };
  setTimeout(run, 15_000);
  setInterval(run, 6 * 60 * 60 * 1000);
}
