import { useEffect, useMemo, useState } from "react";
import { Icon } from "../../lib/icons";
import { cx } from "../../lib/util";
import { COMMANDS, DEFAULT_KEYBINDINGS, eventToCombo, formatCombo, type Command } from "../../state/commands";
import { resetSettings, settings, updateSettings } from "../../state/settings";
import { ui } from "../../state/ui";
import { Group, Hl, Keys, matchText, Section, Segmented, useMatch, useSearch, useSetting } from "./controls";

/** Same rule as keybinding() in state/commands, but from a given map so it is reactive. */
function effective(kb: Record<string, string>, id: string): string | undefined {
  const o = kb[id];
  if (o !== undefined) return o || undefined;
  return DEFAULT_KEYBINDINGS[id];
}

function setBinding(id: string, combo: string) {
  updateSettings((s) => {
    if (combo === (DEFAULT_KEYBINDINGS[id] ?? "")) delete s.keybindings[id];
    else s.keybindings[id] = combo;
  });
}

function resetBinding(id: string) {
  updateSettings((s) => void delete s.keybindings[id]);
}

const titleOf = (id: string) => COMMANDS.find((c) => c.id === id)?.title ?? id;

/** Plain keys (no Ctrl/Alt/Win) never trigger commands, except F-keys — mirrors commandForEvent. */
function usable(e: KeyboardEvent, combo: string): boolean {
  if (e.ctrlKey || e.altKey || e.metaKey) return true;
  return /^f\d+$/.test(combo.replace("shift+", ""));
}

function modsOf(e: KeyboardEvent): string {
  return [e.ctrlKey && "Ctrl", e.altKey && "Alt", e.shiftKey && "Shift", e.metaKey && "Win"].filter(Boolean).join("+");
}

/** Lives inside a confirm dialog (which also pauses the app's global shortcuts) and captures the next key combo. */
function KeyRecorder({ cmd }: { cmd: Command }) {
  const [held, setHeld] = useState("");
  const [hint, setHint] = useState("");
  const [pending, setPending] = useState<{ combo: string; others: string[] } | null>(null);
  const current = effective(settings().keybindings, cmd.id);
  const def = DEFAULT_KEYBINDINGS[cmd.id];

  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopImmediatePropagation();
      if (e.repeat) return;
      if (e.key === "Escape" && !modsOf(e)) {
        ui.closeDialog();
        return;
      }
      const combo = eventToCombo(e);
      if (!combo) {
        setHeld(modsOf(e));
        return;
      }
      setHeld("");
      if (!usable(e, combo)) {
        setPending(null);
        setHint(`${formatCombo(combo)} alone would get in the way of typing. Add Ctrl or Alt (F1–F12 work on their own).`);
        return;
      }
      const kb = settings().keybindings;
      const others = COMMANDS.filter((c) => c.id !== cmd.id && effective(kb, c.id) === combo).map((c) => c.id);
      if (others.length) {
        setHint("");
        setPending({ combo, others });
        return;
      }
      setBinding(cmd.id, combo);
      ui.closeDialog();
      ui.toast(`${cmd.title}: ${formatCombo(combo)}`, "success", 1800);
    };
    const up = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopImmediatePropagation();
      setHeld(modsOf(e));
    };
    window.addEventListener("keydown", down, true);
    window.addEventListener("keyup", up, true);
    return () => {
      window.removeEventListener("keydown", down, true);
      window.removeEventListener("keyup", up, true);
    };
  }, [cmd.id, cmd.title]);

  const replace = () => {
    if (!pending) return;
    updateSettings((s) => {
      for (const id of pending.others) s.keybindings[id] = "";
      if (pending.combo === (DEFAULT_KEYBINDINGS[cmd.id] ?? "")) delete s.keybindings[cmd.id];
      else s.keybindings[cmd.id] = pending.combo;
    });
    ui.closeDialog();
    ui.toast(`${cmd.title}: ${formatCombo(pending.combo)}`, "success", 1800);
  };

  return (
    <div className="key-recorder">
      <div className={cx("key-recorder-keys", pending && "conflict")}>
        {pending ? (
          <Keys combo={formatCombo(pending.combo)} />
        ) : held ? (
          <>
            <Keys combo={held} />
            <span className="dim">+ …</span>
          </>
        ) : (
          <span className="key-recorder-wait">Press the new shortcut…</span>
        )}
      </div>
      {pending ? (
        <div className="key-recorder-conflict">
          <p>
            <Icon name="warning" size={14} /> Already used by <b>{pending.others.map(titleOf).join(", ")}</b>.
          </p>
          <div className="row">
            <button className="btn small primary" onClick={replace}>
              Use it here instead
            </button>
            <button className="btn small subtle" onClick={() => setPending(null)}>
              Try another
            </button>
          </div>
        </div>
      ) : (
        <p className={cx("key-recorder-hint", hint && "warn-text")}>{hint || "Hold Ctrl, Alt or Shift and press a key. Esc cancels."}</p>
      )}
      <p className="key-recorder-meta">
        Now: {current ? <Keys combo={formatCombo(current)} /> : <span>none</span>}
        {def && def !== current && (
          <>
            {" "}
            · Default: <Keys combo={formatCombo(def)} />
          </>
        )}
      </p>
    </div>
  );
}

async function record(cmd: Command) {
  const clear = await ui.confirm(`Shortcut for “${cmd.title}”`, <KeyRecorder cmd={cmd} />, { okLabel: "Clear shortcut" });
  if (clear) setBinding(cmd.id, "");
}

function KbRow({ cmd, combo, overridden, conflicts }: { cmd: Command; combo?: string; overridden: boolean; conflicts: string[] }) {
  const pretty = combo ? formatCombo(combo) : "";
  const match = useMatch(cmd.title, cmd.category, cmd.id, pretty, "shortcut keybinding hotkey");
  if (!match) return null;
  const def = DEFAULT_KEYBINDINGS[cmd.id];
  return (
    <div className={cx("kb-row setting-hit", conflicts.length > 0 && "conflict")}>
      <div className="kb-text">
        <div className="kb-title">
          {cmd.icon && <Icon name={cmd.icon} size={13} className="kb-icon" />}
          <span className="ellipsis">
            <Hl text={cmd.title} />
          </span>
          {overridden && <span className="kb-modified" title={`Changed (default: ${def ? formatCombo(def) : "none"})`} />}
        </div>
        {conflicts.length > 0 && (
          <div className="kb-conflict">
            <Icon name="warning" size={12} /> Also used by {conflicts.map(titleOf).join(", ")} — only the first one runs.
          </div>
        )}
      </div>
      <button className="kb-combo" onClick={() => record(cmd)} title="Click to record a new shortcut">
        {combo ? <Keys combo={pretty} /> : <span className="kb-none">Add shortcut</span>}
      </button>
      <div className="kb-actions">
        <button className="icon-btn" title={`Reset to default (${def ? formatCombo(def) : "none"})`} disabled={!overridden} onClick={() => resetBinding(cmd.id)}>
          <Icon name="undo" size={14} />
        </button>
        <button className="icon-btn" title="Remove shortcut" disabled={!combo} onClick={() => setBinding(cmd.id, "")}>
          <Icon name="x" size={14} />
        </button>
      </div>
    </div>
  );
}

type KbFilter = "all" | "changed" | "conflicts";

export function KeybindingsSection() {
  const kb = useSetting<Record<string, string>>("keybindings");
  const globalQ = useSearch();
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState<KbFilter>("all");

  const eff = useMemo(() => Object.fromEntries(COMMANDS.map((c) => [c.id, effective(kb, c.id)])), [kb]);
  const byCombo = useMemo(() => {
    const m = new Map<string, string[]>();
    for (const c of COMMANDS) {
      const combo = eff[c.id];
      if (combo) m.set(combo, [...(m.get(combo) ?? []), c.id]);
    }
    return m;
  }, [eff]);
  const conflictsOf = (id: string) => (eff[id] ? (byCombo.get(eff[id]!) ?? []).filter((x) => x !== id) : []);
  const conflictCount = COMMANDS.filter((c) => conflictsOf(c.id).length > 0).length;
  const changedCount = COMMANDS.filter((c) => kb[c.id] !== undefined).length;

  const visible = COMMANDS.filter((c) => {
    if (filter === "changed" && kb[c.id] === undefined) return false;
    if (filter === "conflicts" && conflictsOf(c.id).length === 0) return false;
    return matchText(q, c.title, c.category, c.id, eff[c.id] ? formatCombo(eff[c.id]) : "");
  });
  const categories = [...new Set(visible.map((c) => c.category))];

  return (
    <Section
      id="keybindings"
      title="Keybindings"
      icon="keyboard"
      desc="Every command and its shortcut. Click a shortcut to record a new one."
      onReset={() => resetSettings("keybindings")}
      resetHint="Every shortcut goes back to its default."
    >
      {!globalQ && (
        <div className="kb-toolbar">
          <div className="search-box kb-search">
            <Icon name="search" size={13} />
            <input value={q} placeholder="Filter commands or keys" spellCheck={false} onChange={(e) => setQ(e.target.value)} />
            {q && (
              <button className="icon-btn" onClick={() => setQ("")} title="Clear">
                <Icon name="x" size={12} />
              </button>
            )}
          </div>
          <Segmented<KbFilter>
            value={filter}
            onChange={setFilter}
            options={[
              { value: "all", label: "All" },
              { value: "changed", label: `Changed${changedCount ? ` (${changedCount})` : ""}` },
              { value: "conflicts", label: `Conflicts${conflictCount ? ` (${conflictCount})` : ""}`, icon: conflictCount ? "warning" : undefined },
            ]}
          />
        </div>
      )}
      {categories.map((cat) => (
        <Group key={cat} title={cat}>
          {visible
            .filter((c) => c.category === cat)
            .map((c) => (
              <KbRow key={c.id} cmd={c} combo={eff[c.id]} overridden={kb[c.id] !== undefined} conflicts={conflictsOf(c.id)} />
            ))}
        </Group>
      ))}
      {!globalQ && visible.length === 0 && <div className="settings-empty">No commands match.</div>}
      {!globalQ && (
        <p className="settings-footnote">
          Shortcuts with Ctrl or Alt work everywhere, even while a terminal has focus. Typing keys alone (letters, Shift+letter) can't be bound, but F1–F12 can.
        </p>
      )}
    </Section>
  );
}
