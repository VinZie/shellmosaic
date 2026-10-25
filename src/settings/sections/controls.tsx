// Building blocks for settings pages: sections, groups, rows and controls that
// read/write a settings path live. Rows filter themselves against the search
// query (SearchCtx) so a search shows the real, working controls.
import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Icon } from "../../lib/icons";
import { clamp, cx, getPath, toHex6 } from "../../lib/util";
import { setSetting, useSettings } from "../../state/settings";
import { ui } from "../../state/ui";
import { cssVar, escapeRe } from "./helpers";

// ── search ────────────────────────────────────────────────────────────────

/** The trimmed search query ("" when not searching). */
export const SearchCtx = createContext("");
/** Section + group titles, so searching "cursor" finds every row in the Cursor group. */
const ScopeCtx = createContext("");
/** Navigate to a section (clears the search). */
export const NavCtx = createContext<(section: string) => void>(() => {});

export function tokens(q: string): string[] {
  return q.toLowerCase().split(/\s+/).filter(Boolean);
}

export function matchText(q: string, ...texts: unknown[]): boolean {
  const t = tokens(q);
  if (!t.length) return true;
  const hay = texts
    .filter((x): x is string => typeof x === "string")
    .join(" ")
    .toLowerCase();
  return t.every((k) => hay.includes(k));
}

export function useSearch(): string {
  return useContext(SearchCtx);
}

/** True when there is no query, or every query word appears in the texts (or the enclosing section/group titles). */
export function useMatch(...texts: unknown[]): boolean {
  const q = useContext(SearchCtx);
  const scope = useContext(ScopeCtx);
  return matchText(q, scope, ...texts);
}

/** Text with the search words highlighted. */
export function Hl({ text }: { text: string }) {
  const q = useContext(SearchCtx);
  const parts = useMemo(() => {
    const t = tokens(q);
    if (!t.length) return null;
    return text.split(new RegExp(`(${t.map(escapeRe).join("|")})`, "gi"));
  }, [q, text]);
  if (!parts) return <>{text}</>;
  return <>{parts.map((p, i) => (i % 2 ? <mark key={i} className="hl">{p}</mark> : p))}</>;
}

// ── layout ────────────────────────────────────────────────────────────────

export function Section({
  id,
  title,
  icon,
  desc,
  actions,
  onReset,
  resetHint,
  children,
}: {
  id: string;
  title: string;
  icon: string;
  desc?: string;
  actions?: ReactNode;
  onReset?: () => void;
  resetHint?: string;
  children: ReactNode;
}) {
  const q = useSearch();
  const go = useContext(NavCtx);
  const reset = async () => {
    if (!onReset) return;
    const ok = await ui.confirm(`Reset ${title.toLowerCase()} settings?`, resetHint ?? `Everything in ${title} goes back to its default.`, {
      okLabel: "Reset",
      danger: true,
    });
    if (!ok) return;
    onReset();
    ui.toast(`${title} settings reset`, "success", 2200);
  };
  return (
    <ScopeCtx.Provider value={title}>
      <section className="settings-section" data-section={id}>
        <header className="section-head">
          <div className="section-title">
            <h1>
              <Icon name={icon} size={q ? 16 : 20} />
              {title}
            </h1>
            {desc && !q && <p>{desc}</p>}
          </div>
          <div className="section-actions">
            {q ? (
              <button className="btn small subtle" onClick={() => go(id)}>
                Open {title} <Icon name="arrow-right" size={13} />
              </button>
            ) : (
              <>
                {actions}
                {onReset && (
                  <button className="btn small subtle" onClick={reset} title="Restore this section's defaults">
                    <Icon name="undo" size={13} /> Reset section
                  </button>
                )}
              </>
            )}
          </div>
        </header>
        {children}
      </section>
    </ScopeCtx.Provider>
  );
}

export function Group({
  title,
  desc,
  actions,
  plain,
  children,
}: {
  title?: string;
  desc?: ReactNode;
  actions?: ReactNode;
  /** no card around the children (galleries, lists of cards) */
  plain?: boolean;
  children: ReactNode;
}) {
  const scope = useContext(ScopeCtx);
  const q = useSearch();
  return (
    <ScopeCtx.Provider value={title ? `${scope} ${title}` : scope}>
      <div className="settings-group">
        {(title || actions) && (
          <div className="group-head">
            <div className="group-title">
              {title && <h3>{title}</h3>}
              {desc && !q && <p>{desc}</p>}
            </div>
            {actions && <div className="group-actions">{actions}</div>}
          </div>
        )}
        <div className={cx("group-body", plain && "plain")}>{children}</div>
      </div>
    </ScopeCtx.Provider>
  );
}

export interface RowProps {
  label: string;
  desc?: ReactNode;
  /** extra words that should find this row in search */
  keywords?: string;
  /** put the control under the label (wide controls) */
  stack?: boolean;
  disabled?: boolean;
}

/** label + description on the left, control on the right. Hidden when it doesn't match the search. */
export function Row({ label, desc, keywords, stack, disabled, children, onLabelClick }: RowProps & { children?: ReactNode; onLabelClick?: () => void }) {
  const match = useMatch(label, typeof desc === "string" ? desc : undefined, keywords);
  if (!match) return null;
  return (
    <div className={cx("setting-row setting-hit", stack && "stack", disabled && "disabled")}>
      <div className={cx("setting-text", onLabelClick && !disabled && "clickable")} onClick={disabled ? undefined : onLabelClick}>
        <div className="setting-label">
          <Hl text={label} />
        </div>
        {desc && <div className="setting-desc">{desc}</div>}
      </div>
      {children !== undefined && <div className="setting-control">{children}</div>}
    </div>
  );
}

/** Free-form block that takes part in search like a row. */
export function Searchable({ label, keywords, className, children }: { label: string; keywords?: string; className?: string; children: ReactNode }) {
  const match = useMatch(label, keywords);
  if (!match) return null;
  return <div className={cx("setting-block setting-hit", className)}>{children}</div>;
}

// ── primitive controls ───────────────────────────────────────────────────

export interface Opt<T> {
  value: T;
  label: string;
  icon?: string;
  title?: string;
}

export function Switch({ value, onChange, disabled, title }: { value: boolean; onChange: (v: boolean) => void; disabled?: boolean; title?: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={value}
      className={cx("switch", value && "on")}
      disabled={disabled}
      title={title}
      onClick={() => onChange(!value)}
    />
  );
}

export function Select<T extends string | number>({
  value,
  options,
  onChange,
  width,
  disabled,
}: {
  value: T;
  options: Opt<T>[];
  onChange: (v: T) => void;
  width?: number;
  disabled?: boolean;
}) {
  const opts = options.some((o) => o.value === value) ? options : [...options, { value, label: String(value) }];
  return (
    <select
      className="input settings-select"
      style={width ? { width } : undefined}
      value={String(value)}
      disabled={disabled}
      onChange={(e) => {
        const o = opts.find((x) => String(x.value) === e.target.value);
        if (o) onChange(o.value);
      }}
    >
      {opts.map((o) => (
        <option key={String(o.value)} value={String(o.value)}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

export function Segmented<T extends string | number>({
  value,
  options,
  onChange,
  disabled,
}: {
  value: T;
  options: Opt<T>[];
  onChange: (v: T) => void;
  disabled?: boolean;
}) {
  return (
    <div className={cx("segmented", disabled && "disabled")}>
      {options.map((o) => (
        <button type="button" key={String(o.value)} className={cx(o.value === value && "on")} title={o.title} disabled={disabled} onClick={() => onChange(o.value)}>
          {o.icon && <Icon name={o.icon} size={13} />}
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Slider({
  value,
  min,
  max,
  step = 1,
  onChange,
  format,
  width = 230,
  disabled,
}: {
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange: (v: number) => void;
  format?: (v: number) => string;
  width?: number;
  disabled?: boolean;
}) {
  return (
    <div className="slider-control" style={{ width }}>
      <input type="range" min={min} max={max} step={step} value={value} disabled={disabled} onChange={(e) => onChange(Number(e.target.value))} />
      <output>{format ? format(value) : value}</output>
    </div>
  );
}

export function NumberInput({
  value,
  min,
  max,
  step = 1,
  onChange,
  suffix,
  width = 96,
}: {
  value: number;
  min?: number;
  max?: number;
  step?: number;
  onChange: (v: number) => void;
  suffix?: string;
  width?: number;
}) {
  const [draft, setDraft] = useState(String(value));
  const focused = useRef(false);
  useEffect(() => {
    if (!focused.current) setDraft(String(value));
  }, [value]);
  const valid = (s: string) => {
    const n = Number(s);
    return s.trim() !== "" && Number.isFinite(n) && (min === undefined || n >= min) && (max === undefined || n <= max);
  };
  /** The typed text as a value in range (`value` when it isn't a number). */
  const settle = (s: string) => {
    const n = Number(s);
    return s.trim() !== "" && Number.isFinite(n) ? clamp(n, min ?? -Infinity, max ?? Infinity) : value;
  };
  const live = useRef({ draft, value, settle, onChange });
  live.current = { draft, value, settle, onChange };
  // removed while still focused (Esc closes Settings, clearing the search re-renders the page):
  // there's no blur then, so keep what was typed
  useEffect(
    () => () => {
      if (!focused.current) return;
      const { draft, value, settle, onChange } = live.current;
      const next = settle(draft);
      if (next !== value) onChange(next);
    },
    [],
  );
  return (
    <div className="number-input">
      <input
        className={cx("input", !valid(draft) && "invalid")}
        type="number"
        style={{ width }}
        min={min}
        max={max}
        step={step}
        value={draft}
        onFocus={() => (focused.current = true)}
        onChange={(e) => {
          setDraft(e.target.value);
          // typed text applies on blur/Enter: a half-typed "5" of "50000" would trim every
          // terminal's scrollback. Spinner, arrow-key and wheel steps (not InputEvents) apply now.
          if (!(e.nativeEvent instanceof InputEvent) && valid(e.target.value)) onChange(Number(e.target.value));
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
        }}
        onBlur={(e) => {
          focused.current = false;
          const next = settle(e.target.value);
          setDraft(String(next));
          if (next !== value) onChange(next);
        }}
      />
      {suffix && <span className="dim">{suffix}</span>}
    </div>
  );
}

export function TextInput({
  value,
  onChange,
  placeholder,
  mono,
  width = 280,
  disabled,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  mono?: boolean;
  width?: number | string;
  disabled?: boolean;
}) {
  return (
    <input
      className={cx("input", mono && "mono")}
      style={{ width }}
      value={value}
      placeholder={placeholder}
      spellCheck={false}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}

/** Swatches + custom picker; `allowNone` adds a "default" choice that yields null. */
export function ColorInput({
  value,
  onChange,
  swatches = [],
  allowNone,
  noneLabel = "Default",
}: {
  value: string | null | undefined;
  onChange: (v: string | null) => void;
  swatches?: string[];
  allowNone?: boolean;
  noneLabel?: string;
}) {
  const v = value?.toLowerCase() ?? null;
  const inSwatches = !!v && swatches.some((c) => c.toLowerCase() === v);
  const custom = !!value && !inSwatches;
  return (
    <div className="swatch-row color-input">
      {allowNone && (
        <button type="button" className={cx("swatch big none", !value && "selected")} title={noneLabel} onClick={() => onChange(null)}>
          <Icon name="x" size={12} />
        </button>
      )}
      {swatches.map((c) => (
        <button type="button" key={c} className={cx("swatch big", v === c.toLowerCase() && "selected")} style={{ background: c }} title={c} onClick={() => onChange(c)} />
      ))}
      <label className={cx("swatch big custom", custom && "selected filled")} title="Custom color…" style={custom ? { background: value! } : undefined}>
        <input type="color" value={toHex6(value || cssVar("--accent") || "#808080")} onChange={(e) => onChange(e.target.value)} />
        {!custom && <Icon name="palette" size={13} />}
      </label>
      {value && <code className="color-code">{value}</code>}
    </div>
  );
}

/** Text field with quick-pick chips underneath (fonts). */
export function FontField({ value, onChange, picks }: { value: string; onChange: (v: string) => void; picks: { label: string; value: string }[] }) {
  const first = firstFamily(value);
  return (
    <div className="font-field">
      <input className="input wide" value={value} spellCheck={false} onChange={(e) => onChange(e.target.value)} />
      <div className="font-picks">
        {picks.map((p) => (
          <button
            key={p.label}
            type="button"
            className={cx("chip pick", firstFamily(p.value) === first && "accent")}
            style={{ fontFamily: p.value }}
            onClick={() => onChange(p.value)}
            title={p.value}
          >
            {p.label}
          </button>
        ))}
      </div>
    </div>
  );
}

export function firstFamily(s: string): string {
  return (s.split(",")[0] ?? "").trim().replace(/^["']|["']$/g, "").toLowerCase();
}

/** Key combo rendered as <kbd> parts. */
export function Keys({ combo }: { combo: string }) {
  return (
    <span className="keys">
      {combo.split("+").map((k, i) => (
        <kbd key={i}>{k}</kbd>
      ))}
    </span>
  );
}

// ── controls bound to a settings path ─────────────────────────────────────

export function useSetting<T>(path: string): T {
  return useSettings((s) => getPath(s.settings, path) as T);
}

type Bound = RowProps & { path: string };

export function ToggleSetting({ path, ...row }: Bound) {
  const v = !!useSetting<boolean>(path);
  return (
    <Row {...row} onLabelClick={() => setSetting(path, !v)}>
      <Switch value={v} onChange={(x) => setSetting(path, x)} disabled={row.disabled} />
    </Row>
  );
}

export function SelectSetting<T extends string | number>({ path, options, width, ...row }: Bound & { options: Opt<T>[]; width?: number }) {
  const v = useSetting<T>(path);
  return (
    <Row {...row}>
      <Select value={v} options={options} width={width} disabled={row.disabled} onChange={(x) => setSetting(path, x)} />
    </Row>
  );
}

export function SegmentedSetting<T extends string | number>({ path, options, ...row }: Bound & { options: Opt<T>[] }) {
  const v = useSetting<T>(path);
  return (
    <Row {...row}>
      <Segmented value={v} options={options} disabled={row.disabled} onChange={(x) => setSetting(path, x)} />
    </Row>
  );
}

export function SliderSetting({
  path,
  min,
  max,
  step,
  format,
  ...row
}: Bound & { min: number; max: number; step?: number; format?: (v: number) => string }) {
  const v = useSetting<number>(path);
  return (
    <Row {...row}>
      <Slider value={v} min={min} max={max} step={step} format={format} disabled={row.disabled} onChange={(x) => setSetting(path, x)} />
    </Row>
  );
}

export function NumberSetting({ path, min, max, step, suffix, width, ...row }: Bound & { min?: number; max?: number; step?: number; suffix?: string; width?: number }) {
  const v = useSetting<number>(path);
  return (
    <Row {...row}>
      <NumberInput value={v} min={min} max={max} step={step} suffix={suffix} width={width} onChange={(x) => setSetting(path, x)} />
    </Row>
  );
}

export function TextSetting({ path, placeholder, mono, width, ...row }: Bound & { placeholder?: string; mono?: boolean; width?: number | string }) {
  const v = useSetting<string>(path);
  return (
    <Row {...row}>
      <TextInput value={v ?? ""} placeholder={placeholder} mono={mono} width={width} disabled={row.disabled} onChange={(x) => setSetting(path, x)} />
    </Row>
  );
}

export function ColorSetting({ path, swatches, allowNone, noneLabel, ...row }: Bound & { swatches?: string[]; allowNone?: boolean; noneLabel?: string }) {
  const v = useSetting<string | null>(path);
  return (
    <Row {...row}>
      <ColorInput value={v} swatches={swatches} allowNone={allowNone} noneLabel={noneLabel} onChange={(x) => setSetting(path, x)} />
    </Row>
  );
}

export const pct = (v: number) => `${Math.round(v * 100)}%`;
export const px = (v: number) => `${v}px`;
