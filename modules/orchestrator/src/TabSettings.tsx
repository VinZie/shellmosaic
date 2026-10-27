// The gear popover: which tabs show and in what order, the tab a pane opens on, where details go.
import { ArrowDown, ArrowUp } from "lucide-react";
import { Button, IconButton, Select } from "../../shared";
import { DEFAULT_PREFS, TAB_LABELS, type DetailsSide, type Prefs, type TabId } from "./prefs";

export function TabSettings({ prefs, onChange }: { prefs: Prefs; onChange: (p: Prefs) => void }) {
  const tabs = prefs.tabs;
  const shown = tabs.filter((t) => t.visible).length;
  const move = (i: number, by: number) => {
    const j = i + by;
    if (j < 0 || j >= tabs.length) return;
    const next = [...tabs];
    [next[i], next[j]] = [next[j], next[i]];
    onChange({ ...prefs, tabs: next });
  };
  const toggle = (id: TabId) => {
    const next = tabs.map((t) => (t.id === id ? { ...t, visible: !t.visible } : t));
    if (!next.some((t) => t.visible)) return;
    const def = next.find((t) => t.id === prefs.defaultTab)?.visible ? prefs.defaultTab : next.find((t) => t.visible)!.id;
    onChange({ ...prefs, tabs: next, defaultTab: def });
  };
  return (
    <div className="orc-settings">
      <h4>Tabs</h4>
      {tabs.map((t, i) => (
        <div key={t.id} className="orc-settings-tab">
          <label className="orc-settings-check">
            <input type="checkbox" checked={t.visible} disabled={t.visible && shown <= 1} onChange={() => toggle(t.id)} />
            <span>{TAB_LABELS[t.id]}</span>
          </label>
          {t.id === prefs.defaultTab && <span className="orc-settings-default">default</span>}
          <IconButton title={`Move ${TAB_LABELS[t.id]} up`} disabled={i === 0} onClick={() => move(i, -1)}>
            <ArrowUp size={13} />
          </IconButton>
          <IconButton title={`Move ${TAB_LABELS[t.id]} down`} disabled={i === tabs.length - 1} onClick={() => move(i, 1)}>
            <ArrowDown size={13} />
          </IconButton>
        </div>
      ))}
      <div className="orc-settings-field">
        <span>Opens on</span>
        <Select<TabId> value={prefs.defaultTab} onChange={(v) => onChange({ ...prefs, defaultTab: v })} options={tabs.filter((t) => t.visible).map((t) => ({ value: t.id, label: TAB_LABELS[t.id] }))} />
      </div>
      <div className="orc-settings-field">
        <span>Details</span>
        <Select<DetailsSide>
          value={prefs.details}
          onChange={(v) => onChange({ ...prefs, details: v })}
          options={[
            { value: "auto", label: "Beside or below (by width)" },
            { value: "right", label: "Beside the list" },
            { value: "bottom", label: "Below the list" },
          ]}
          title="Where Agents and Tasks show the selected row"
        />
      </div>
      <div className="orc-settings-foot">
        <Button small kind="subtle" onClick={() => onChange(DEFAULT_PREFS)}>
          Reset to defaults
        </Button>
      </div>
    </div>
  );
}
