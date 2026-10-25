import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { open, save } from "@tauri-apps/plugin-dialog";
import { openPath } from "@tauri-apps/plugin-opener";
import { Icon } from "../../lib/icons";
import { ipc } from "../../lib/ipc";
import { basename, deepDiff, isPlainObject } from "../../lib/util";
import { cleanMaps, DEFAULT_SETTINGS, mergeChecked, resetSettings, settings, updateSettings, type Settings } from "../../state/settings";
import { ui } from "../../state/ui";
import { Group, Row, Section, SliderSetting, ToggleSetting, useSetting } from "./controls";
import { attempt, dataPath, openInDataDir, useDataDir } from "./helpers";

/** Only what differs from the defaults: small, readable and future-proof. */
const changedSettings = () => deepDiff(DEFAULT_SETTINGS, settings()) ?? {};

async function openSettingsFile() {
  await attempt(async () => {
    // make sure the file exists (it is only written once something changes)
    await ipc.settingsWrite(changedSettings());
    await openPath(await dataPath("settings.json"));
  });
}

async function exportSettings() {
  const stamp = new Date().toISOString().slice(0, 10);
  const path = await save({
    title: "Export settings",
    defaultPath: `shellmosaic-settings-${stamp}.json`,
    filters: [{ name: "JSON", extensions: ["json"] }],
  });
  if (!path) return;
  const ok = await attempt(async () => {
    await ipc.fsWriteText(path, JSON.stringify(changedSettings(), null, 2) + "\n");
    return true;
  });
  if (ok) ui.toast(`Settings exported to ${basename(path)}`, "success");
}

async function importSettings() {
  const file = await open({ multiple: false, title: "Import settings", filters: [{ name: "JSON", extensions: ["json"] }] });
  if (typeof file !== "string") return;
  const text = await attempt(() => ipc.fsReadText(file));
  if (text === undefined) return;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    ui.toast(`${basename(file)} is not valid JSON`, "error");
    return;
  }
  if (!isPlainObject(parsed)) {
    ui.toast(`${basename(file)} doesn't look like Shellmosaic settings`, "error");
    return;
  }
  const data: Record<string, unknown> = structuredClone(parsed);
  // permissions are granted by the user, per plugin; a settings file never carries them over
  if (isPlainObject(data.plugins)) delete data.plugins.grants;
  const known = Object.keys(data).filter((k) => k in DEFAULT_SETTINGS) as (keyof Settings)[];
  if (!known.length) {
    ui.toast(`${basename(file)} doesn't contain any Shellmosaic settings`, "error");
    return;
  }
  // shell profiles are commands Shellmosaic will run: show them before they're accepted
  const profiles = isPlainObject(data.profiles) ? data.profiles : {};
  const commands = [
    ...(Array.isArray(profiles.custom) ? profiles.custom : []),
    ...(isPlainObject(profiles.overrides) ? Object.values(profiles.overrides) : []),
  ]
    .filter(isPlainObject)
    .filter((p) => typeof p.command === "string" || Array.isArray(p.args))
    .map((p) => `• ${String(p.name ?? p.id ?? "profile")}: ${String(p.command ?? "")} ${Array.isArray(p.args) ? p.args.join(" ") : ""}`.trim());
  const ok = await ui.confirm(
    "Import settings?",
    `Settings from ${basename(file)} (${known.join(", ")}) are applied on top of your current ones. Anything the file doesn't mention stays as it is.` +
      (commands.length ? `\n\nIt also sets these shell commands, which new terminals will run:\n${commands.slice(0, 12).join("\n")}${commands.length > 12 ? "\n…" : ""}` : ""),
    { okLabel: "Import", danger: commands.length > 0 },
  );
  if (!ok) return;
  updateSettings((s) => {
    for (const k of known) (s as unknown as Record<string, unknown>)[k] = mergeChecked(s[k], data[k]);
    cleanMaps(s);
  });
  ui.toast("Settings imported", "success");
}

async function resetEverything() {
  const ok = await ui.confirm(
    "Reset all settings?",
    "Every setting goes back to its default: theme, fonts, profiles, keybindings, module and plugin settings. Your themes, plugins, notes and sessions are kept.\n\nTip: export your settings first if you might want them back.",
    { okLabel: "Reset everything", danger: true },
  );
  if (!ok) return;
  resetSettings();
  ui.toast("All settings reset", "success");
}

function DataFolderRow() {
  const dir = useDataDir();
  return (
    <Row label="Data folder" desc={dir ? <code className="path-code">{dir}</code> : "Where settings, themes, plugins and sessions live."} keywords="appdata location path files folder">
      {dir && (
        <button
          className="icon-btn"
          title="Copy path"
          onClick={() =>
            writeText(dir)
              .then(() => ui.toast("Path copied", "success", 1200))
              .catch(() => {})
          }
        >
          <Icon name="copy" size={14} />
        </button>
      )}
      <button className="btn small" onClick={() => openInDataDir()}>
        <Icon name="folder-open" size={13} /> Open
      </button>
    </Row>
  );
}

export function DataSection() {
  const persist = useSetting<boolean>("restore.scrollback");
  return (
    <Section id="data" title="Data & restore" icon="database" desc="What's remembered between sessions, and your settings files." onReset={() => resetSettings("restore")} resetHint="Session and scrollback restore options go back to their defaults.">
      <Group title="Restore">
        <ToggleSetting path="restore.session" label="Restore workspaces on start" desc="Reopen your workspaces, tabs and panes where you left them." keywords="session startup remember reopen" />
        <ToggleSetting path="restore.scrollback" label="Restore terminal output" desc="Save each terminal's recent output and show it again after a restart." keywords="scrollback history persist" />
        <SliderSetting
          path="restore.scrollbackMB"
          label="Output buffer per terminal"
          desc={persist ? "How much recent output each terminal keeps in memory and saves for restoring." : "How much recent output each terminal keeps in memory (used when re-attaching panes)."}
          min={0.5}
          max={16}
          step={0.5}
          format={(v) => `${v} MB`}
          keywords="scrollback memory size buffer"
        />
      </Group>

      <Group title="Files">
        <DataFolderRow />
        <Row label="settings.json" desc="Holds only the settings you changed. Edits made in an editor are picked up automatically." keywords="json config file edit">
          <button className="btn small" onClick={openSettingsFile}>
            <Icon name="file-code" size={13} /> Open settings.json
          </button>
        </Row>
      </Group>

      <Group title="Backup">
        <Row label="Export settings" desc="Save the settings you changed to a JSON file, e.g. to move them to another PC." keywords="backup save copy transfer">
          <button className="btn small" onClick={exportSettings}>
            <Icon name="upload" size={13} /> Export…
          </button>
        </Row>
        <Row label="Import settings" desc="Apply settings from an exported file on top of your current ones." keywords="restore load backup transfer">
          <button className="btn small" onClick={importSettings}>
            <Icon name="download" size={13} /> Import…
          </button>
        </Row>
        <Row label="Reset all settings" desc="Start over with the defaults. Themes, plugins and sessions are kept." keywords="factory defaults clear wipe">
          <button className="btn small danger" onClick={resetEverything}>
            <Icon name="undo" size={13} /> Reset everything…
          </button>
        </Row>
      </Group>
    </Section>
  );
}
