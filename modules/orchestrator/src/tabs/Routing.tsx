// Which model runs what: the lead, each task difficulty, the team's size and the plan
// usage limits. Saved with the routing it was edited from, so two editors can't
// silently overwrite each other.
import { useEffect, useState } from "react";
import { RotateCcw, Save } from "lucide-react";
import { Banner, Button, errorText, Grow, Section, Select, sm, Toolbar, type ModelChoice, type Routing } from "../../../shared";
import { DIFFICULTY_LABEL, EFFORTS, MODEL_ALIASES, modelLabel, type Usage } from "../lib";

const DEFAULT: Routing = {
  lead: { model: "opus", effort: "high" },
  levels: [
    { model: "haiku", effort: "medium" },
    { model: "sonnet", effort: "medium" },
    { model: "sonnet", effort: "high" },
    { model: "opus", effort: "high" },
    { model: "opus", effort: "xhigh" },
  ],
  maxWorkers: 3,
  maxOpusWorkers: 1,
  sonnetAbove: 80,
  noHireAbove: 95,
};

const EXAMPLES = ["", "renames, typos, small mechanical fixes", "a small feature or a contained bug fix", "normal feature work across a few files", "tricky bugs, design work, many files", "hard problems where quality matters most"];

const same = (a: Routing, b: Routing) => JSON.stringify(a) === JSON.stringify(b);

function ModelPicker({ value, onChange, disabled }: { value: ModelChoice; onChange: (v: ModelChoice) => void; disabled?: boolean }) {
  const alias = MODEL_ALIASES.includes(value.model.toLowerCase());
  const [custom, setCustom] = useState(!alias);
  return (
    <span className="orc-model-picker">
      <select
        className="sm-input sm-select"
        disabled={disabled}
        value={custom ? "custom" : value.model.toLowerCase()}
        onChange={(e) => {
          if (e.target.value === "custom") setCustom(true);
          else {
            setCustom(false);
            onChange({ ...value, model: e.target.value });
          }
        }}
        title="Model"
      >
        <option value="haiku">Haiku</option>
        <option value="sonnet">Sonnet</option>
        <option value="opus">Opus</option>
        <option value="custom">Another model…</option>
      </select>
      {custom && (
        <input className="sm-input mono orc-model-id" disabled={disabled} value={value.model} placeholder="claude-…" onChange={(e) => onChange({ ...value, model: e.target.value.trim() })} title="A full model id (as `claude --model` takes it)" />
      )}
      <select className="sm-input sm-select" disabled={disabled} value={value.effort} onChange={(e) => onChange({ ...value, effort: e.target.value })} title="Effort">
        {EFFORTS.map((e) => (
          <option key={e} value={e}>
            {e} effort
          </option>
        ))}
      </select>
    </span>
  );
}

function Percent({ value, onChange, disabled }: { value: number; onChange: (n: number) => void; disabled?: boolean }) {
  return (
    <span className="orc-percent">
      <input
        className="sm-input"
        type="number"
        min={1}
        max={100}
        disabled={disabled}
        value={value}
        onChange={(e) => {
          const n = Math.round(Number(e.target.value));
          if (Number.isFinite(n)) onChange(Math.min(100, Math.max(1, n)));
        }}
      />
      %
    </span>
  );
}

export function RoutingTab({ routing, canManage, usage }: { routing: Routing; canManage: boolean; usage: Usage | null }) {
  const [base, setBase] = useState(routing);
  const [draft, setDraft] = useState(routing);
  const [busy, setBusy] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dirty = !same(draft, base);

  // someone else saved: follow it unless there are unsaved edits here
  useEffect(() => {
    if (same(routing, base)) return;
    if (!dirty) {
      setBase(routing);
      setDraft(routing);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [routing]);

  const invalid =
    draft.noHireAbove < draft.sonnetAbove
      ? "\"No new workers\" has to be at or above \"Sonnet at most\"."
      : [draft.lead, ...draft.levels].some((c) => !c.model.trim())
        ? "Every row needs a model."
        : null;

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const saved = await sm.agents.setRouting(draft, base);
      setBase(saved);
      setDraft(saved);
      setConflict(false);
      sm.ui.notify("Routing saved: it applies to tasks assigned from now on", "success");
    } catch (e) {
      const t = errorText(e);
      if (/changed meanwhile/i.test(t)) setConflict(true);
      else setError(t);
    } finally {
      setBusy(false);
    }
  };

  const set = (patch: Partial<Routing>) => setDraft((d) => ({ ...d, ...patch }));
  const setLevel = (i: number, c: ModelChoice) => setDraft((d) => ({ ...d, levels: d.levels.map((l, j) => (j === i ? c : l)) }));
  const ro = !canManage;
  const now5 = usage?.fiveHour ? `${Math.round(usage.fiveHour.pct)}%` : "—";
  const now7 = usage?.sevenDay ? `${Math.round(usage.sevenDay.pct)}%` : "—";

  return (
    <div className="orc-tab-col">
      <Toolbar>
        <Button small kind="primary" disabled={ro || !dirty || !!invalid || busy} onClick={save}>
          <Save size={13} /> Save
        </Button>
        <Button small kind="subtle" disabled={!dirty || busy} onClick={() => setDraft(base)}>
          Revert
        </Button>
        <Grow />
        <Button small kind="subtle" disabled={ro || same(draft, DEFAULT)} onClick={() => setDraft(DEFAULT)} title="The routing Shellmosaic starts with">
          <RotateCcw size={13} /> Defaults
        </Button>
      </Toolbar>
      {conflict && (
        <Banner
          tone="warning"
          actions={
            <Button
              small
              onClick={() => {
                setBase(routing);
                setDraft(routing);
                setConflict(false);
              }}
            >
              Load it (drop my edits)
            </Button>
          }
        >
          The routing was changed somewhere else while you edited it.
        </Banner>
      )}
      {error && <Banner tone="danger">{error}</Banner>}
      {invalid && dirty && <Banner tone="warning">{invalid}</Banner>}
      <div className="sm-scroll sm-pad orc-routing">
        <Section title="Lead">
          <div className="orc-route-row">
            <span className="orc-route-name">The lead</span>
            <ModelPicker value={draft.lead} onChange={(c) => set({ lead: c })} disabled={ro} />
            <span className="sm-dim orc-route-note">plans, assigns and reviews; applies to teams started from now on</span>
          </div>
        </Section>
        <Section title="Workers, by task difficulty">
          {draft.levels.map((l, i) => (
            <div key={i} className="orc-route-row">
              <span className="orc-route-name">
                <b>{i + 1}</b> · {DIFFICULTY_LABEL[i + 1]}
              </span>
              <ModelPicker value={l} onChange={(c) => setLevel(i, c)} disabled={ro} />
              <span className="sm-dim orc-route-note">{EXAMPLES[i + 1]}</span>
            </div>
          ))}
          <p className="sm-dim orc-route-foot">
            The lead rates each task when it creates it. A follow-up keeps the model of the conversation it continues. A task that has failed twice (failed, blocked or sent back) runs one level up when it's retried.
          </p>
        </Section>
        <Section title="Team">
          <div className="orc-route-row">
            <span className="orc-route-name">Workers at most</span>
            <Select
              value={String(draft.maxWorkers)}
              onChange={(v) => set({ maxWorkers: Number(v), maxOpusWorkers: Math.min(draft.maxOpusWorkers, Number(v)) })}
              options={[1, 2, 3].map((n) => ({ value: String(n), label: String(n) }))}
            />
            <span className="sm-dim orc-route-note">besides the lead</span>
          </div>
          <div className="orc-route-row">
            <span className="orc-route-name">On Opus at once</span>
            <Select
              value={String(draft.maxOpusWorkers)}
              onChange={(v) => set({ maxOpusWorkers: Number(v) })}
              options={Array.from({ length: draft.maxWorkers + 1 }, (_, n) => ({ value: String(n), label: n === 0 ? "None" : String(n) }))}
            />
            <span className="sm-dim orc-route-note">more Opus tasks run on Sonnet meanwhile</span>
          </div>
        </Section>
        <Section title="Plan usage">
          <div className="orc-route-row">
            <span className="orc-route-name">Sonnet at most from</span>
            <Percent value={draft.sonnetAbove} onChange={(n) => set({ sonnetAbove: n })} disabled={ro} />
            <span className="sm-dim orc-route-note">of the 5-hour or the weekly limit: Opus tasks run on Sonnet</span>
          </div>
          <div className="orc-route-row">
            <span className="orc-route-name">No new workers from</span>
            <Percent value={draft.noHireAbove} onChange={(n) => set({ noHireAbove: n })} disabled={ro} />
            <span className="sm-dim orc-route-note">tasks wait for an idle worker instead</span>
          </div>
          <p className="sm-dim orc-route-foot">
            Now: 5-hour {now5} · week {now7}
            {usage ? (usage.source === "agents" ? " (as the agents last reported it)" : " (from your Claude account)") : " (no agent has reported it yet)"}. The lead stays on {modelLabel(draft.lead.model)}.
          </p>
        </Section>
      </div>
    </div>
  );
}
