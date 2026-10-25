// The filter toolbar: levels, event IDs, source, time range, text, and the XPath editor.
import { useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import { Check, CodeXml, Copy, FunnelX, KeyRound, LockKeyhole, Plus, SlidersHorizontal, Tag, X } from "lucide-react";
import { Button, Chip, copy, cx, formatNumber, IconButton, Popover, SearchBox, Select } from "../../shared";
import { LEVELS, LevelIcon } from "./levels";
import { shortProvider } from "./parse";
import { RANGES, type Audit, type Filters, type RangeId } from "./query";

export type BarMode = "full" | "icons" | "compact";

function LevelChips({ f, onChange, labels, security, disabled }: { f: Filters; onChange: (p: Partial<Filters>) => void; labels: boolean; security: boolean; disabled?: boolean }) {
  const toggle = (l: number) => onChange({ levels: f.levels.includes(l) ? f.levels.filter((x) => x !== l) : [...f.levels, l].sort() });
  const audit = (a: Audit) => onChange({ audit: f.audit === a ? "" : a });
  return (
    <div className={cx("ev-seg", disabled && "disabled")} role="group" aria-label="Levels">
      {LEVELS.map((l) => {
        const on = f.levels.includes(l.level);
        return (
          <button
            key={l.level}
            type="button"
            className={cx("ev-seg-btn", on && "on", `ev-lv-${l.kind}`)}
            aria-pressed={on}
            title={`${l.label}${l.level === 4 ? " (and Level 0)" : ""}${on ? "" : " — show only these"}`}
            disabled={disabled}
            onClick={() => toggle(l.level)}
          >
            <LevelIcon kind={l.kind} size={13} />
            {labels && <span>{l.level === 4 ? "Info" : l.label}</span>}
          </button>
        );
      })}
      {security && (
        <>
          <span className="ev-seg-sep" />
          <button type="button" className={cx("ev-seg-btn", f.audit === "success" && "on", "ev-lv-auditSuccess")} aria-pressed={f.audit === "success"} title="Audit Success" disabled={disabled} onClick={() => audit("success")}>
            <KeyRound size={13} className="ev-lv-icon" />
            {labels && <span>Success</span>}
          </button>
          <button type="button" className={cx("ev-seg-btn", f.audit === "failure" && "on", "ev-lv-auditFailure")} aria-pressed={f.audit === "failure"} title="Audit Failure" disabled={disabled} onClick={() => audit("failure")}>
            <LockKeyhole size={13} className="ev-lv-icon" />
            {labels && <span>Failure</span>}
          </button>
        </>
      )}
    </div>
  );
}

function IdsInput({ value, onChange, error, wide, disabled }: { value: string; onChange: (v: string) => void; error: string | null; wide?: boolean; disabled?: boolean }) {
  return (
    <input
      className={cx("sm-input mono ev-ids", wide && "wide", error && "invalid")}
      value={value}
      placeholder="Event IDs: 4624, 4700-4710, -4672"
      title={error ?? "Event IDs and ranges; a leading - excludes (4624, 4700-4710, -4672)"}
      spellCheck={false}
      disabled={disabled}
      aria-invalid={!!error}
      onChange={(e) => onChange(e.target.value)}
      onKeyDown={(e) => e.key === "Escape" && value && (e.stopPropagation(), onChange(""))}
    />
  );
}

/** Providers seen in the loaded events, plus typing any name. */
function SourceList({ value, onChange, seen, autoFocus }: { value: string[]; onChange: (v: string[]) => void; seen: [string, number][]; autoFocus?: boolean }) {
  const [q, setQ] = useState("");
  const typed = q.trim();
  const list = useMemo(() => {
    const counts = new Map(seen);
    const names = [...value.filter((v) => !counts.has(v)), ...seen.map(([n]) => n)];
    const ql = typed.toLowerCase();
    return names.filter((n) => !ql || n.toLowerCase().includes(ql)).slice(0, 300).map((n) => [n, counts.get(n) ?? null] as const);
  }, [seen, value, typed]);
  const toggle = (n: string) => onChange(value.includes(n) ? value.filter((x) => x !== n) : [...value, n]);
  const exact = list.some(([n]) => n.toLowerCase() === typed.toLowerCase());
  return (
    <div className="ev-sources">
      <SearchBox value={q} onChange={setQ} placeholder="Find or type a source" autoFocus={autoFocus} />
      <div className="ev-sources-list">
        {typed && !exact && (
          <div
            className="ev-source-row"
            onClick={() => {
              onChange([...value, typed]);
              setQ("");
            }}
          >
            <Plus size={13} />
            <span className="sm-grow sm-ellipsis">
              Filter by “<b>{typed}</b>”
            </span>
          </div>
        )}
        {list.map(([n, count]) => (
          <div key={n} className={cx("ev-source-row", value.includes(n) && "on")} title={n} onClick={() => toggle(n)}>
            <span className="ev-check">{value.includes(n) && <Check size={12} />}</span>
            <span className="sm-grow sm-ellipsis">{n}</span>
            {count !== null && <span className="ev-side-count">{formatNumber(count)}</span>}
          </div>
        ))}
        {!list.length && !typed && <div className="ev-side-note">Sources appear here as events load; type a provider name to filter by it.</div>}
      </div>
      {value.length > 0 && (
        <div className="ev-sources-foot">
          <span className="sm-grow sm-dim">{value.length} selected</span>
          <Button small kind="subtle" onClick={() => onChange([])}>
            Any source
          </Button>
        </div>
      )}
    </div>
  );
}

function SourceButton({ value, onChange, seen, disabled }: { value: string[]; onChange: (v: string[]) => void; seen: [string, number][]; disabled?: boolean }) {
  const ref = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const label = value.length === 0 ? "Any source" : value.length === 1 ? shortProvider(value[0]) : `${value.length} sources`;
  return (
    <>
      <button ref={ref} type="button" className={cx("ev-pick", value.length > 0 && "on")} disabled={disabled} title={value.length ? value.join("\n") : "Source (provider)"} onClick={() => setOpen((o) => !o)}>
        <Tag size={13} />
        <span className="sm-ellipsis">{label}</span>
      </button>
      {open && (
        <Popover anchor={ref.current} onClose={() => setOpen(false)} width={300} align="left">
          <SourceList value={value} onChange={onChange} seen={seen} autoFocus />
        </Popover>
      )}
    </>
  );
}

export interface FilterBarProps {
  mode: BarMode;
  filters: Filters;
  onFilters: (p: Partial<Filters>) => void;
  text: string;
  onText: (t: string) => void;
  idsError: string | null;
  seen: [string, number][];
  security: boolean;
  /** a hand-edited XPath replaces the structured filters */
  custom: boolean;
  xpathOpen: boolean;
  onXpathOpen: (v: boolean) => void;
  active: number;
  onClear: () => void;
  searchRef: RefObject<HTMLDivElement | null>;
  left?: ReactNode;
  right?: ReactNode;
  /** extra rows at the top of the compact Filters popover (view toggles) */
  popoverExtra?: ReactNode;
}

export function FilterBar(p: FilterBarProps) {
  const filtersBtn = useRef<HTMLButtonElement>(null);
  const [popover, setPopover] = useState(false);
  const range = (
    <Select<RangeId>
      value={p.filters.range}
      onChange={(v) => p.onFilters({ range: v })}
      options={RANGES.map((r) => ({ value: r.value, label: r.label }))}
      title="Time range"
    />
  );
  const anything = p.active > 0 || p.custom || !!p.text;
  const clear = anything && (
    <IconButton title="Clear filters" onClick={p.onClear}>
      <FunnelX size={15} />
    </IconButton>
  );
  const xpathBtn = (
    <IconButton title={p.custom ? "XPath query (custom)" : "XPath query"} on={p.xpathOpen || p.custom} onClick={() => p.onXpathOpen(!p.xpathOpen)}>
      <CodeXml size={15} />
    </IconButton>
  );
  const search = (
    <div className="ev-search" ref={p.searchRef}>
      <SearchBox value={p.text} onChange={p.onText} placeholder={p.mode === "compact" ? "Search" : "Search text  (Ctrl+F)"} />
    </div>
  );

  if (p.mode === "compact") {
    const n = p.active + (p.custom ? 1 : 0);
    return (
      <div className="ev-toolbar compact">
        {p.left}
        {search}
        <button ref={filtersBtn} type="button" className={cx("ev-pick", n > 0 && "on")} onClick={() => setPopover((o) => !o)} title="Filters">
          <SlidersHorizontal size={13} />
          <span>Filters</span>
          {n > 0 && <span className="ev-pick-badge">{n}</span>}
        </button>
        <div className="ev-toolbar-right">{p.right}</div>
        {popover && (
          <Popover anchor={filtersBtn.current} onClose={() => setPopover(false)} width={Math.min(340, window.innerWidth - 8)} align="right">
            <div className="ev-filter-pop">
              {p.custom && (
                <div className="ev-pop-note">
                  A custom XPath query is active; these filters apply again after <a onClick={() => p.onFilters({})}>Reset to filters</a> in the XPath editor.
                </div>
              )}
              {p.popoverExtra}
              <h4>Levels</h4>
              <LevelChips f={p.filters} onChange={p.onFilters} labels security={p.security} disabled={p.custom} />
              <h4>Event IDs</h4>
              <IdsInput value={p.filters.ids} onChange={(ids) => p.onFilters({ ids })} error={p.idsError} wide disabled={p.custom} />
              {p.idsError && <div className="ev-field-error">{p.idsError}</div>}
              <h4>Source</h4>
              {p.custom ? <div className="ev-side-note">—</div> : <SourceList value={p.filters.providers} onChange={(providers) => p.onFilters({ providers })} seen={p.seen} />}
              <h4>Time</h4>
              <div className="ev-range-row">{range}</div>
              <div className="ev-pop-actions">
                <Button
                  small
                  onClick={() => {
                    setPopover(false);
                    p.onXpathOpen(true);
                  }}
                >
                  <CodeXml size={13} /> XPath…
                </Button>
                <div className="sm-grow" />
                <Button small kind="subtle" disabled={!anything} onClick={p.onClear}>
                  <FunnelX size={13} /> Clear filters
                </Button>
              </div>
            </div>
          </Popover>
        )}
      </div>
    );
  }

  return (
    <div className="ev-toolbar">
      {p.left}
      <div className={cx("ev-filters", p.custom && "custom")} title={p.custom ? "A custom XPath query replaces these filters" : undefined}>
        <LevelChips f={p.filters} onChange={p.onFilters} labels={p.mode === "full"} security={p.security} disabled={p.custom} />
        <IdsInput value={p.filters.ids} onChange={(ids) => p.onFilters({ ids })} error={p.idsError} disabled={p.custom} />
        <SourceButton value={p.filters.providers} onChange={(providers) => p.onFilters({ providers })} seen={p.seen} disabled={p.custom} />
        <div className={cx("ev-range", p.filters.range !== "any" && "on")}>{range}</div>
      </div>
      {search}
      {p.custom && (
        <Chip tone="accent" title="A hand-edited XPath query is in use">
          XPath
        </Chip>
      )}
      {xpathBtn}
      {clear}
      <div className="ev-toolbar-right">{p.right}</div>
    </div>
  );
}

/** Shows the generated query and lets the user edit it. */
export function XPathEditor({
  generated,
  custom,
  onApply,
  onClose,
  error,
}: {
  generated: string | null;
  custom: string | null;
  onApply: (xpath: string | null) => void;
  onClose: () => void;
  error: string | null;
}) {
  const effective = custom ?? generated ?? "*";
  const [draft, setDraft] = useState(effective);
  const [dirty, setDirty] = useState(false);
  useEffect(() => {
    if (!dirty) setDraft(effective);
  }, [effective, dirty]);
  const apply = () => {
    const v = draft.trim();
    setDirty(false);
    onApply(!v || v === "*" || v === (generated ?? "*") ? null : v);
  };
  return (
    <div className="ev-xpath">
      <div className="ev-xpath-head">
        <CodeXml size={14} />
        <span className="ev-xpath-title">XPath query</span>
        <span className="sm-dim sm-ellipsis">{custom ? "custom — the filters above are off" : "generated from the filters; edit to use your own"}</span>
        <div className="sm-grow" />
        <IconButton title="Copy query" onClick={() => copy(draft, "query")}>
          <Copy size={13} />
        </IconButton>
        <IconButton title="Close" onClick={onClose}>
          <X size={14} />
        </IconButton>
      </div>
      <textarea
        className={cx("sm-input mono ev-xpath-input", error && "invalid")}
        value={draft}
        rows={Math.min(5, Math.max(2, Math.ceil(draft.length / 110)))}
        spellCheck={false}
        onChange={(e) => {
          setDraft(e.target.value);
          setDirty(true);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            apply();
          } else if (e.key === "Escape") {
            e.stopPropagation();
            if (dirty) {
              setDirty(false);
              setDraft(effective);
            } else onClose();
          }
        }}
      />
      <div className="ev-xpath-actions">
        <Button small kind="primary" disabled={!dirty} onClick={apply}>
          Apply
        </Button>
        <span className="sm-dim ev-hint">Ctrl+Enter</span>
        <div className="sm-grow" />
        {(custom || dirty) && (
          <Button
            small
            kind="subtle"
            onClick={() => {
              setDirty(false);
              setDraft(generated ?? "*");
              onApply(null);
            }}
          >
            Reset to filters
          </Button>
        )}
      </div>
    </div>
  );
}
