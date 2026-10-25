import { useMemo, useState, type ReactNode } from "react";
import { Icon } from "../../lib/icons";
import { cx, toHex6 } from "../../lib/util";
import { ChangePasswordForm } from "../../modules/hosts/VaultForms";
import { lockVault, resetVault, useVault, useVaultStatus } from "../../modules/hosts/vault";
import { useModules } from "../../modules/registry";
import { WORKSPACE_COLORS } from "../../state/model";
import { DEFAULT_SETTINGS, resetSettings, setSetting, updateSettings, type HighlightRule } from "../../state/settings";
import {
  Group,
  Hl,
  NumberSetting,
  Row,
  Section,
  SegmentedSetting,
  SelectSetting,
  Switch,
  TextSetting,
  ToggleSetting,
  useMatch,
  useSetting,
  type Opt,
} from "./controls";
import { escapeRe } from "./helpers";

const INTERVALS: Opt<number>[] = [250, 500, 1000, 2000, 3000, 5000, 10000, 30000].map((v) => ({
  value: v,
  label: v < 1000 ? `Every ${v} ms` : `Every ${v / 1000} s`,
}));

// ── module bar ────────────────────────────────────────────────────────────

function ModuleBarList() {
  const modules = useModules((s) => s.modules);
  const bar = useSetting<string[]>("modules.bar");
  const hidden = useSetting<string[]>("modules.barHidden");
  const order = useMemo(() => [...bar.filter((id) => modules[id]), ...Object.keys(modules).filter((id) => !bar.includes(id))], [bar, modules]);
  // non-plugin modules missing from `bar` aren't shown by the module bar
  const shown = (id: string) => (bar.includes(id) || !!modules[id]?.plugin) && !hidden.includes(id);

  const write = (nextOrder: string[], vis: Record<string, boolean>) =>
    updateSettings((s) => {
      const unknown = s.modules.bar.filter((id) => !modules[id]);
      const unknownHidden = s.modules.barHidden.filter((id) => !modules[id]);
      s.modules.bar = [...nextOrder, ...unknown];
      s.modules.barHidden = [...nextOrder.filter((id) => !vis[id]), ...unknownHidden];
    });
  const visMap = () => Object.fromEntries(order.map((id) => [id, shown(id)]));
  const move = (i: number, d: number) => {
    const next = [...order];
    const j = i + d;
    if (j < 0 || j >= next.length) return;
    [next[i], next[j]] = [next[j], next[i]];
    write(next, visMap());
  };
  const toggle = (id: string) => write(order, { ...visMap(), [id]: !shown(id) });

  return (
    <>
      {order.map((id, i) => {
        const m = modules[id];
        return <ModuleRow key={id} id={id} name={m.name} icon={m.icon} description={m.description} plugin={!!m.plugin} index={i} last={order.length - 1} shown={shown(id)} onMove={move} onToggle={toggle} />;
      })}
      {order.length === 0 && <div className="settings-empty small">No modules registered yet.</div>}
    </>
  );
}

function ModuleRow(props: {
  id: string;
  name: string;
  icon: string;
  description: string;
  plugin: boolean;
  index: number;
  last: number;
  shown: boolean;
  onMove: (i: number, d: number) => void;
  onToggle: (id: string) => void;
}) {
  const { id, name, icon, description, plugin, index, last, shown, onMove, onToggle } = props;
  const match = useMatch(name, description, id, plugin ? "plugin" : "");
  if (!match) return null;
  return (
    <div className={cx("module-row setting-hit", !shown && "off")}>
      <span className="module-pos">{index + 1}</span>
      <span className="module-icon">
        <Icon name={icon} size={16} />
      </span>
      <div className="module-info">
        <div className="module-name">
          <Hl text={name} />
          {plugin && <span className="chip accent">plugin</span>}
        </div>
        <div className="setting-desc ellipsis">{description}</div>
      </div>
      <button className="icon-btn" disabled={index === 0} onClick={() => onMove(index, -1)} title="Move up">
        <Icon name="chevron-up" size={15} />
      </button>
      <button className="icon-btn" disabled={index === last} onClick={() => onMove(index, 1)} title="Move down">
        <Icon name="chevron-down" size={15} />
      </button>
      <Switch value={shown} onChange={() => onToggle(id)} title={shown ? "Shown in the module bar" : "Hidden from the module bar (still available from Add module…)"} />
    </div>
  );
}

// ── log highlight rules ───────────────────────────────────────────────────

const SAMPLE_LOG = `2026-10-24 09:14:02 INFO  server listening on :8080
2026-10-24 09:14:05 WARN  config value "timeout" is deprecated
2026-10-24 09:14:09 ERROR request failed: connection refused
2026-10-24 09:14:10 DEBUG retrying in 500ms… done`;

function ruleRegex(r: HighlightRule): RegExp | string | null {
  if (!r.pattern) return null;
  try {
    return new RegExp(r.regex ? r.pattern : escapeRe(r.pattern), "gi");
  } catch (e) {
    return e instanceof Error ? e.message.replace(/^Invalid regular expression: /, "") : "invalid pattern";
  }
}

function highlightLine(line: string, rules: HighlightRule[]): ReactNode[] {
  const marks: { s: number; e: number; color: string }[] = [];
  for (const r of rules) {
    const re = ruleRegex(r);
    if (!(re instanceof RegExp)) continue;
    for (const m of line.matchAll(re)) {
      if (!m[0]) continue;
      const s = m.index ?? 0;
      const e = s + m[0].length;
      if (!marks.some((x) => s < x.e && e > x.s)) marks.push({ s, e, color: r.color });
    }
  }
  marks.sort((a, b) => a.s - b.s);
  const out: ReactNode[] = [];
  let pos = 0;
  marks.forEach((m, i) => {
    if (m.s > pos) out.push(line.slice(pos, m.s));
    out.push(
      <span key={i} className="log-hit" style={{ color: m.color }}>
        {line.slice(m.s, m.e)}
      </span>,
    );
    pos = m.e;
  });
  if (pos < line.length) out.push(line.slice(pos));
  return out;
}

function HighlightRules() {
  const rules = useSetting<HighlightRule[]>("modules.logs.highlights");
  const [sample, setSample] = useState(SAMPLE_LOG);
  const edit = (fn: (r: HighlightRule[]) => void) => updateSettings((s) => fn(s.modules.logs.highlights));
  const move = (i: number, d: number) =>
    edit((r) => {
      const j = i + d;
      if (j >= 0 && j < r.length) [r[i], r[j]] = [r[j], r[i]];
    });
  return (
    <Row
      label="Highlight rules"
      desc="Words or patterns colored in log panes. When two rules match the same text, the higher one wins."
      keywords="log colors regex pattern highlight error warning"
      stack
    >
      <div className="rules">
        {rules.map((r, i) => {
          const re = ruleRegex(r);
          const error = typeof re === "string" ? re : null;
          return (
            <div key={i} className="rule-item">
              <div className={cx("rule-row", error && "invalid")}>
                <label className="swatch big custom filled" style={{ background: r.color }} title="Color">
                  <input type="color" value={toHex6(r.color)} onChange={(e) => edit((x) => void (x[i].color = e.target.value))} />
                </label>
                <input
                  className="input mono"
                  value={r.pattern}
                  spellCheck={false}
                  placeholder={r.regex ? "regular expression, e.g. \\berror\\b" : "text to match"}
                  onChange={(e) => edit((x) => void (x[i].pattern = e.target.value))}
                />
                <button className={cx("icon-btn", r.regex && "on")} title={r.regex ? "Regular expression (click for plain text)" : "Plain text (click for regular expression)"} onClick={() => edit((x) => void (x[i].regex = !x[i].regex))}>
                  <Icon name="regex" size={15} />
                </button>
                <button className="icon-btn" disabled={i === 0} onClick={() => move(i, -1)} title="Move up">
                  <Icon name="chevron-up" size={15} />
                </button>
                <button className="icon-btn" disabled={i === rules.length - 1} onClick={() => move(i, 1)} title="Move down">
                  <Icon name="chevron-down" size={15} />
                </button>
                <button className="icon-btn close" onClick={() => edit((x) => void x.splice(i, 1))} title="Remove rule">
                  <Icon name="trash" size={14} />
                </button>
              </div>
              {error && <div className="rule-error">{error}</div>}
            </div>
          );
        })}
        <div className="row rules-foot">
          <button className="btn small" onClick={() => edit((r) => void r.push({ pattern: "", color: WORKSPACE_COLORS[r.length % WORKSPACE_COLORS.length], regex: false }))}>
            <Icon name="plus" size={13} /> Add rule
          </button>
          <span className="grow" />
          <button className="btn small subtle" onClick={() => setSetting("modules.logs.highlights", structuredClone(DEFAULT_SETTINGS.modules.logs.highlights))}>
            <Icon name="undo" size={13} /> Default rules
          </button>
        </div>
        <label className="field-label">Try it</label>
        <textarea className="input mono wide rules-sample" rows={4} value={sample} spellCheck={false} onChange={(e) => setSample(e.target.value)} />
        <div className="log-preview">
          {sample.split(/\r?\n/).map((line, i) => (
            <div key={i}>{line ? highlightLine(line, rules) : " "}</div>
          ))}
        </div>
      </div>
    </Row>
  );
}

// ── saved hosts vault ─────────────────────────────────────────────────────

function VaultRows() {
  const status = useVaultStatus();
  const count = useVault((s) => s.hosts?.length ?? 0);
  const [changing, setChanging] = useState(false);
  const exists = !!status?.exists;
  const unlocked = !!status?.unlocked;
  const state = !status
    ? "Checking…"
    : !exists
      ? "Not created yet: the Hosts module sets it up with a master password."
      : unlocked
        ? `Unlocked · ${count} saved host${count === 1 ? "" : "s"}`
        : "Locked";
  return (
    <>
      <Row label="Vault" desc={state} keywords="ssh hosts master password lock encrypted secrets">
        <div className="row">
          <button className="btn small" disabled={!unlocked} onClick={lockVault}>
            <Icon name="lock" size={13} /> Lock now
          </button>
          <button className="btn small" disabled={!exists || changing} onClick={() => setChanging(true)}>
            Change master password…
          </button>
          <button className="btn small subtle danger" disabled={!exists} onClick={() => void resetVault()}>
            Reset vault…
          </button>
        </div>
      </Row>
      {changing && exists && (
        <Row label="Change master password" desc="Everything in the vault is re-encrypted with the new password." keywords="ssh hosts vault" stack>
          <ChangePasswordForm variant="inline" autoFocus onDone={() => setChanging(false)} />
        </Row>
      )}
    </>
  );
}

// ── section ───────────────────────────────────────────────────────────────

export function ModulesSection() {
  const moduleBar = useSetting<string>("appearance.moduleBar");
  return (
    <Section
      id="modules"
      title="Modules"
      icon="layout-grid"
      desc="What's in the module bar, and options for each built-in module."
      onReset={() => {
        resetSettings("modules");
        // shown here too, though stored under appearance
        setSetting("appearance.moduleBar", DEFAULT_SETTINGS.appearance.moduleBar);
        setSetting("appearance.moduleBarLabels", DEFAULT_SETTINGS.appearance.moduleBarLabels);
      }}
      resetHint="Module bar position, labels, order and visibility and every module option (including log highlight rules) go back to their defaults."
    >
      <Group
        title="Module bar"
        desc="Click a module to add it next to the focused pane, or drag it onto a pane. Hidden modules are still available from “Add module…”."
        actions={
          <button
            className="btn small subtle"
            onClick={() =>
              updateSettings((s) => {
                s.modules.bar = [...DEFAULT_SETTINGS.modules.bar];
                s.modules.barHidden = [];
              })
            }
          >
            <Icon name="undo" size={13} /> Reset order
          </button>
        }
      >
        <SegmentedSetting
          path="appearance.moduleBar"
          label="Position"
          keywords="module bar side hide"
          options={[
            { value: "left", label: "Left" },
            { value: "right", label: "Right" },
            { value: "hidden", label: "Hidden" },
          ]}
        />
        <ToggleSetting path="appearance.moduleBarLabels" label="Show labels" keywords="module bar names text" disabled={moduleBar === "hidden"} />
        <ModuleBarList />
      </Group>

      <Group title="Hosts" desc="Saved SSH hosts, and the encrypted vault that keeps their passwords and private keys.">
        <NumberSetting
          path="modules.hosts.autoLockMinutes"
          label="Lock the vault after"
          desc="Minutes without using saved hosts (0 = never). Terminals and SFTP panes that are connected stay connected."
          min={0}
          max={1440}
          suffix="min"
          width={90}
          keywords="ssh hosts auto-lock idle timeout vault"
        />
        <VaultRows />
      </Group>

      <Group title="Files">
        <ToggleSetting path="modules.files.showHidden" label="Show hidden files" desc="Include dot-files and files marked hidden." keywords="explorer dotfiles" />
        <ToggleSetting path="modules.files.followTerminal" label="Follow the terminal's folder" desc="New file panes open in, and follow, the folder of the terminal you're using." keywords="cwd sync directory" />
      </Group>

      <Group title="Web">
        <TextSetting path="modules.web.home" label="Home page" desc="Opened by new web panes." placeholder="https://…" mono width={300} keywords="browser url start page" />
      </Group>

      <Group title="System info">
        <SelectSetting path="modules.sysinfo.intervalMs" label="Refresh" options={INTERVALS} keywords="interval cpu memory update rate" />
      </Group>

      <Group title="Processes">
        <SelectSetting path="modules.processes.intervalMs" label="Refresh" options={INTERVALS} keywords="interval update rate task manager" />
      </Group>

      <Group title="Ports">
        <SelectSetting path="modules.ports.intervalMs" label="Refresh" options={INTERVALS} keywords="interval update rate network sockets" />
        <ToggleSetting path="modules.ports.listeningOnly" label="Only listening ports" desc="Default filter for new ports panes." keywords="network sockets listen tcp" />
      </Group>

      <Group title="Logs">
        <NumberSetting path="modules.logs.maxLines" label="Lines kept" desc="Older lines are dropped from log panes beyond this." min={1000} max={1000000} step={1000} suffix="lines" width={110} keywords="buffer limit tail" />
        <HighlightRules />
      </Group>
    </Section>
  );
}
