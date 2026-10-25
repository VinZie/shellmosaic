import { getVersion } from "@tauri-apps/api/app";
import { useContext, useEffect, useState } from "react";
import { Icon } from "../../lib/icons";
import { DEFAULT_KEYBINDINGS, formatCombo } from "../../state/commands";
import { setSetting } from "../../state/settings";
import { BUILTIN_THEMES } from "../../state/themes";
import { ui } from "../../state/ui";
import { checkForUpdates } from "../../state/updater";
import { Group, Keys, NavCtx, Row, Searchable, Section, Segmented, ToggleSetting, useSetting } from "./controls";
import { openInDataDir } from "./helpers";

function useVersion(): string {
  const [v, setV] = useState("");
  useEffect(() => {
    getVersion().then(setV, () => {});
  }, []);
  return v;
}

function UpdateControls() {
  const skipped = useSetting<string | null>("updates.skipped");
  const [checking, setChecking] = useState(false);
  const check = async () => {
    setChecking(true);
    await checkForUpdates({ manual: true });
    setChecking(false);
  };
  return (
    <>
      <div className="row about-links">
        <button className="btn small" onClick={check} disabled={checking}>
          <Icon name={checking ? "loader" : "refresh"} size={13} className={checking ? "spin" : undefined} /> Check for updates
        </button>
        {skipped && (
          <button className="btn small subtle" title="Offer this version again at the next check" onClick={() => setSetting("updates.skipped", null)}>
            Skipped v{skipped} · undo
          </button>
        )}
      </div>
      <ToggleSetting
        path="updates.autoCheck"
        label="Check for updates automatically"
        desc="Looks for new releases on GitHub at start and every few hours. You're always asked before anything is installed."
        keywords="update upgrade release github version auto"
      />
      <UpdateChannel />
    </>
  );
}

function UpdateChannel() {
  const channel = useSetting<"stable" | "test">("updates.channel");
  const choose = async (next: "stable" | "test") => {
    if (next === channel) return;
    if (next === "test") {
      const ok = await ui.confirm(
        "Switch to test builds?",
        "Test builds come from the test branch: new features arrive there first, but they may be unstable, lose settings or break things. Optional modules also come from the test branch. You can switch back at any time.",
        { okLabel: "Use test builds", danger: true },
      );
      if (!ok) return;
    }
    setSetting("updates.channel", next);
    // the Updates check below and Optional modules now read the other channel
    if (next === "test") checkForUpdates({ manual: true });
  };
  return (
    <>
      <Row
        label="Update channel"
        desc="Stable gets releases from the main branch. Test gets pre-release builds and optional modules from the test branch."
        keywords="beta test branch main stable preview insider pre-release channel unstable"
      >
        <Segmented
          value={channel}
          options={[
            { value: "stable", label: "Stable" },
            { value: "test", label: "Test" },
          ]}
          onChange={choose}
        />
      </Row>
      {channel === "test" && (
        <div className="update-channel-warning">
          <Icon name="warning" size={14} />
          <span>
            You're on the test channel. Test builds can be unstable or have bugs that cost you data. Switch back to Stable any time; you return to stable versions
            with the next stable release newer than the build you have.
          </span>
        </div>
      )}
    </>
  );
}

const STACK = ["Tauri 2", "Rust", "React 19", "TypeScript", "zustand", "xterm.js"];

const SHORTCUTS: [string, string][] = [
  ["palette.open", "Command palette — run anything by name"],
  ["settings.open", "Settings"],
  ["tab.new", "New tab"],
  ["pane.splitRight", "Split right"],
  ["pane.splitDown", "Split down"],
  ["pane.zoom", "Magnify the focused pane"],
  ["palette.modules", "Add a module"],
  ["term.find", "Find in terminal"],
];

function ShortcutList() {
  const kb = useSetting<Record<string, string>>("keybindings");
  return (
    <div className="about-shortcuts">
      {SHORTCUTS.map(([id, text]) => {
        const o = kb[id];
        const combo = o !== undefined ? o || undefined : DEFAULT_KEYBINDINGS[id];
        return (
          <div key={id} className="about-shortcut">
            <span>{text}</span>
            {combo ? <Keys combo={formatCombo(combo)} /> : <span className="dim">not set</span>}
          </div>
        );
      })}
    </div>
  );
}

export function AboutSection() {
  const go = useContext(NavCtx);
  const version = useVersion();
  const credits = BUILTIN_THEMES.filter((t) => t.author && /MIT/.test(t.author));
  return (
    <Section id="about" title="About" icon="info">
      <Searchable label="Version" keywords="about shellmosaic release build stack">
        <div className="about-hero card">
          <div className="about-logo">
            <Icon name="layout-grid" size={28} />
          </div>
          <div className="grow">
            <h2>Shellmosaic</h2>
            <p className="dim">A modular, workspace-based terminal for Windows.</p>
            <div className="about-stack">
              {version && <span className="chip accent">v{version}</span>}
              {STACK.map((s) => (
                <span key={s} className="chip">
                  {s}
                </span>
              ))}
            </div>
          </div>
        </div>
      </Searchable>

      <Group title="Updates">
        <Searchable label="Updates" keywords="update upgrade release github version new">
          <UpdateControls />
        </Searchable>
      </Group>

      <Group
        title="Handy shortcuts"
        actions={
          <button className="btn small subtle" onClick={() => go("keybindings")}>
            All shortcuts <Icon name="arrow-right" size={13} />
          </button>
        }
      >
        <Searchable label="Shortcuts" keywords="keyboard palette hotkeys tips help">
          <ShortcutList />
          <p className="about-tip dim">
            Tip: almost everything — tabs, panes, modules, themes, settings — is reachable from the command palette. Right-click tabs, panes and workspaces for
            more options.
          </p>
        </Searchable>
      </Group>

      <Group title="Credits">
        <Searchable label="Credits" keywords="license mit themes open source thanks">
          <div className="about-credits">
            <p>Built-in color themes adapted from their MIT-licensed originals:</p>
            <ul>
              {credits.map((t) => (
                <li key={t.id}>
                  <b>{t.name}</b> <span className="dim">— {t.author!.replace(/\s*\(MIT\)\s*$/, "")}</span>
                </li>
              ))}
            </ul>
            <p className="dim">
              Terminal rendering by xterm.js (MIT). Icons by Lucide (ISC). Desktop shell by Tauri (MIT / Apache-2.0).
            </p>
          </div>
        </Searchable>
      </Group>

      <Group title="Support">
        <Searchable label="Data folder logs troubleshooting" keywords="help support bug report">
          <div className="row about-links">
            <button className="btn small" onClick={() => openInDataDir()}>
              <Icon name="folder-open" size={13} /> Open data folder
            </button>
            <button
              className="btn small"
              onClick={() => {
                ui.closeSettings();
                ui.openPalette("all");
              }}
            >
              <Icon name="command" size={13} /> Command palette
            </button>
          </div>
        </Searchable>
      </Group>
    </Section>
  );
}
