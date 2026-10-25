// The gear popover: which tabs show and in what order, the default tab, the refresh interval.
import { ArrowDown, ArrowUp } from "lucide-react";
import { Button, IconButton, Select } from "../../../shared";
import { DEFAULT_PREFS, INTERVALS, TAB_LABELS, type Prefs, type TabId } from "../lib/prefs";

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
    // the default tab must stay visible
    const def = next.find((t) => t.id === prefs.defaultTab)?.visible ? prefs.defaultTab : next.find((t) => t.visible)!.id;
    onChange({ ...prefs, tabs: next, defaultTab: def });
  };

  return (
    <div className="pi-settings">
      <h4>Tabs</h4>
      <div className="pi-settings-tabs">
        {tabs.map((t, i) => (
          <div key={t.id} className="pi-settings-tab">
            <label className="pi-settings-check">
              <input type="checkbox" checked={t.visible} disabled={t.visible && shown <= 1} onChange={() => toggle(t.id)} />
              <span>{TAB_LABELS[t.id]}</span>
            </label>
            {t.id === prefs.defaultTab && <span className="pi-settings-default">default</span>}
            <IconButton title={`Move ${TAB_LABELS[t.id]} up`} disabled={i === 0} onClick={() => move(i, -1)}>
              <ArrowUp size={13} />
            </IconButton>
            <IconButton title={`Move ${TAB_LABELS[t.id]} down`} disabled={i === tabs.length - 1} onClick={() => move(i, 1)}>
              <ArrowDown size={13} />
            </IconButton>
          </div>
        ))}
      </div>
      <div className="pi-settings-field">
        <span>Opens on</span>
        <Select<TabId>
          value={prefs.defaultTab}
          onChange={(v) => onChange({ ...prefs, defaultTab: v })}
          options={tabs.filter((t) => t.visible).map((t) => ({ value: t.id, label: TAB_LABELS[t.id] }))}
          title="The tab a new inspector opens on"
        />
      </div>
      <div className="pi-settings-field">
        <span>Refresh</span>
        <Select
          value={String(prefs.interval)}
          onChange={(v) => onChange({ ...prefs, interval: Number(v) })}
          options={INTERVALS}
          title="How often the tab on screen is refreshed (only while the pane is visible)"
        />
      </div>
      <p className="pi-settings-note">Only the tab on screen refreshes, and only while the pane is visible. F5 refreshes now.</p>
      <div className="pi-settings-foot">
        <Button small kind="subtle" onClick={() => onChange(DEFAULT_PREFS)}>
          Reset to defaults
        </Button>
      </div>
    </div>
  );
}
