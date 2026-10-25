// Theme editor: a drawer on the right that edits a draft copy of a theme and
// previews it live across the whole app (useThemes.preview) until it's saved
// or discarded. Editing a built-in theme saves a user copy ("<id>-custom").
import { save as saveDialog } from "@tauri-apps/plugin-dialog";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Icon } from "../lib/icons";
import { errorText, ipc } from "../lib/ipc";
import { cx, parseColor, toHex6 } from "../lib/util";
import { setSetting, settings, useSettings } from "../state/settings";
import { allThemes, completeTheme, findTheme, useThemes, type TermColors, type Theme, type UiColors } from "../state/themes";
import { ui, useUi } from "../state/ui";
import "./theme-editor.css";

const UI_TOKENS: { key: keyof UiColors; label: string; hint: string }[] = [
  { key: "bg", label: "Background", hint: "App background behind panes" },
  { key: "surface", label: "Surface", hint: "Panes, panels and dialogs" },
  { key: "surface2", label: "Raised surface", hint: "Buttons, menus, active controls" },
  { key: "border", label: "Border", hint: "Pane, input and divider lines" },
  { key: "text", label: "Text", hint: "Primary text" },
  { key: "textDim", label: "Dim text", hint: "Secondary text and icons" },
  { key: "accent", label: "Accent", hint: "Focus, highlights and primary buttons" },
  { key: "accentText", label: "Text on accent", hint: "Text drawn on the accent color" },
  { key: "danger", label: "Danger", hint: "Errors and destructive actions" },
  { key: "warning", label: "Warning", hint: "Warnings and bells" },
  { key: "success", label: "Success", hint: "Success states" },
  { key: "rail", label: "Workspace rail", hint: "The workspace sidebar" },
  { key: "titlebar", label: "Title bar", hint: "Tab strip and window controls" },
  { key: "tabActive", label: "Active tab", hint: "Background of the selected tab" },
  { key: "paneHeader", label: "Pane header", hint: "Header bar of each pane" },
  { key: "selection", label: "Selection", hint: "Selected text in the interface" },
];

const TERM_TOKENS: { key: keyof TermColors; label: string; hint: string }[] = [
  { key: "background", label: "Background", hint: "Terminal background" },
  { key: "foreground", label: "Foreground", hint: "Default text color" },
  { key: "cursor", label: "Cursor", hint: "Cursor color" },
  { key: "cursorAccent", label: "Cursor text", hint: "Character under a block cursor" },
  { key: "selectionBackground", label: "Selection", hint: "Selected text in terminals" },
];

const ANSI_NAMES = ["black", "red", "green", "yellow", "blue", "magenta", "cyan", "white"] as const;
const ANSI_SHORT = ["BLK", "RED", "GRN", "YEL", "BLU", "MAG", "CYN", "WHT"];
type AnsiKey = Extract<keyof TermColors, (typeof ANSI_NAMES)[number] | `bright${Capitalize<(typeof ANSI_NAMES)[number]>}`>;
const ansiKey = (i: number, bright: boolean): AnsiKey =>
  (bright ? `bright${ANSI_NAMES[i][0].toUpperCase()}${ANSI_NAMES[i].slice(1)}` : ANSI_NAMES[i]) as AnsiKey;
const ansiLabel = (i: number, bright: boolean) => `${bright ? "Bright " : ""}${ANSI_NAMES[i]}`.replace(/^./, (c) => c.toUpperCase());
const ALL_ANSI: AnsiKey[] = [...ANSI_NAMES.map((_, i) => ansiKey(i, false)), ...ANSI_NAMES.map((_, i) => ansiKey(i, true))];

/** #rgb, #rgba, #rrggbb, #rrggbbaa, rgb(…) or rgba(…) with sane components. */
export function isThemeColor(input: string): boolean {
  const v = input.trim();
  const p = parseColor(v);
  if (!p) return false;
  if (v.startsWith("#")) return /^#([0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(v);
  if (!/^rgba?\([^()]*\)$/i.test(v)) return false;
  const [r, g, b, a] = p;
  const ok = [r, g, b].every((n) => Number.isFinite(n) && n >= 0 && n <= 255) && Number.isFinite(a) && a >= 0 && a <= 1;
  return ok && (typeof CSS === "undefined" || CSS.supports("color", v));
}

/** A color from the native picker (no alpha), keeping the previous value's alpha. */
function keepAlpha(hex6: string, prev: string): string {
  const a = parseColor(prev)?.[3] ?? 1;
  if (a >= 1) return hex6;
  return hex6 + Math.round(a * 255).toString(16).padStart(2, "0");
}

function uniqueThemeId(seed: string): string {
  const ids = new Set(allThemes().map((t) => t.id));
  if (!ids.has(seed)) return seed;
  for (let i = 2; ; i++) if (!ids.has(`${seed}-${i}`)) return `${seed}-${i}`;
}

function makeDraft(themeId: string | null) {
  const base = findTheme(themeId ?? settings().theme);
  const builtin = base.source === "builtin";
  const draft: Theme = structuredClone({ ...completeTheme(base), source: "user" as const });
  if (builtin) {
    draft.id = uniqueThemeId(`${base.id}-custom`);
    draft.name = `${base.name} (custom)`;
  }
  return { base, builtin, draft };
}

/** What gets written to disk / exported. */
function serializable(t: Theme) {
  const out: Record<string, unknown> = { id: t.id, name: t.name.trim() || t.id };
  if (t.author?.trim()) out.author = t.author.trim();
  out.type = t.type;
  out.ui = t.ui;
  out.terminal = t.terminal;
  return out;
}

const close = () => useUi.setState({ themeEditor: { open: false, themeId: null } });

export function ThemeEditor() {
  const open = useUi((s) => s.themeEditor.open);
  const themeId = useUi((s) => s.themeEditor.themeId);
  if (!open) return null;
  return <Drawer key={themeId ?? ""} themeId={themeId} />;
}

function Drawer({ themeId }: { themeId: string | null }) {
  const [initial] = useState(() => makeDraft(themeId));
  const [draft, setDraft] = useState<Theme>(initial.draft);
  const [busy, setBusy] = useState(false);
  const [openGroups, setOpenGroups] = useState({ ui: true, term: true });
  const [ansi, setAnsi] = useState<AnsiKey>("red");
  const rootRef = useRef<HTMLElement>(null);
  const accentOverride = useSettings((s) => s.settings.appearance.accent);
  const dirty = useMemo(() => JSON.stringify(draft) !== JSON.stringify(initial.draft), [draft, initial]);
  const nameOk = draft.name.trim().length > 0;

  // live preview, coalesced to one update per frame while dragging a picker
  useEffect(() => {
    const raf = requestAnimationFrame(() => useThemes.setState({ preview: draft }));
    return () => cancelAnimationFrame(raf);
  }, [draft]);
  useEffect(() => () => useThemes.setState({ preview: null }), []);
  // take focus so Esc and Tab work right away (focus is still on whatever opened the editor)
  useEffect(() => rootRef.current?.focus({ preventScroll: true }), []);

  const setUi = (key: keyof UiColors, v: string) => setDraft((d) => ({ ...d, ui: { ...d.ui, [key]: v } }));
  const setTerm = (key: keyof TermColors, v: string) => setDraft((d) => ({ ...d, terminal: { ...d.terminal, [key]: v } }));

  const cancel = async () => {
    if (busy) return;
    if (dirty && !(await ui.confirm("Discard changes?", "Your edits to this theme haven't been saved.", { okLabel: "Discard", danger: true }))) return;
    close();
  };

  const onSave = async () => {
    if (!nameOk || busy) return;
    setBusy(true);
    try {
      const out = serializable(draft);
      await ipc.themeSave(out);
      // the backend doesn't notify the window that saved, so update the list here
      const saved = completeTheme(out);
      useThemes.setState((s) => ({ user: [...s.user.filter((t) => t.id !== saved.id), saved] }));
      setSetting("theme", saved.id);
      ui.toast(`Saved theme "${saved.name}"`, "success");
      close();
    } catch (e) {
      ui.toast(`Couldn't save the theme: ${errorText(e)}`, "error");
      setBusy(false);
    }
  };

  const onExport = async () => {
    try {
      const path = await saveDialog({
        title: "Export theme",
        defaultPath: `${draft.id}.json`,
        filters: [{ name: "Shellmosaic theme", extensions: ["json"] }],
      });
      if (!path) return;
      await ipc.fsWriteText(path, JSON.stringify(serializable(draft), null, 2) + "\n");
      ui.toast(`Exported "${draft.name.trim() || draft.id}"`, "success");
    } catch (e) {
      ui.toast(`Export failed: ${errorText(e)}`, "error");
    }
  };

  const ansiBright = ansi.startsWith("bright");
  const ansiIndex = Math.max(0, ALL_ANSI.indexOf(ansi)) % 8;

  return (
    <aside
      ref={rootRef}
      tabIndex={-1}
      className="theme-editor"
      role="dialog"
      aria-label="Theme editor"
      onKeyDown={(e) => {
        if (e.key === "Escape" && !e.defaultPrevented) {
          e.stopPropagation();
          cancel();
        }
      }}
    >
      <header className="te-head">
        <div className="te-head-icon">
          <Icon name="palette" size={16} />
        </div>
        <div className="grow te-head-text">
          <h3>Theme editor</h3>
          <div className="te-sub ellipsis" title={`themes/${draft.id}.json`}>
            {initial.builtin ? `Based on ${initial.base.name}` : `Editing ${initial.base.name}`} · <span className="mono">{draft.id}</span>
          </div>
        </div>
        {dirty && <span className="chip accent">Unsaved</span>}
        <button className="icon-btn" title="Close (Esc)" onClick={cancel}>
          <Icon name="x" size={16} />
        </button>
      </header>

      <div className="te-body">
        {initial.builtin && (
          <div className="te-note">
            <Icon name="info" size={14} />
            <span>
              {initial.base.name} is built in. Saving creates your own copy, <b>{draft.name.trim() || draft.id}</b>.
            </span>
          </div>
        )}
        {accentOverride && (
          <div className="te-note warn">
            <Icon name="warning" size={14} />
            <span className="grow">Your accent color in Appearance settings overrides this theme's accent.</span>
            <button className="btn small" onClick={() => setSetting("appearance.accent", null)}>
              Use theme accent
            </button>
          </div>
        )}

        <TerminalPreview t={draft.terminal} />

        <label className="field-label">Name</label>
        <input
          className={cx("input wide", !nameOk && "te-invalid")}
          value={draft.name}
          placeholder="Theme name"
          onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
        />
        <div className="te-meta">
          <div>
            <label className="field-label">Type</label>
            <div className="segmented">
              {(["dark", "light"] as const).map((t) => (
                <button key={t} className={cx(draft.type === t && "on")} onClick={() => setDraft((d) => ({ ...d, type: t }))}>
                  <Icon name={t === "dark" ? "moon" : "sun"} size={12} style={{ marginRight: 5, verticalAlign: -2 }} />
                  {t}
                </button>
              ))}
            </div>
          </div>
          <div className="grow">
            <label className="field-label">Author</label>
            <input
              className="input wide"
              value={draft.author ?? ""}
              placeholder="Optional"
              onChange={(e) => setDraft((d) => ({ ...d, author: e.target.value }))}
            />
          </div>
        </div>

        <Group title="Interface" icon="layout-grid" open={openGroups.ui} onToggle={() => setOpenGroups((g) => ({ ...g, ui: !g.ui }))}>
          {UI_TOKENS.map((tok) => (
            <ColorRow key={tok.key} label={tok.label} hint={tok.hint} value={draft.ui[tok.key]} onChange={(v) => setUi(tok.key, v)} />
          ))}
        </Group>

        <Group title="Terminal" icon="square-terminal" open={openGroups.term} onToggle={() => setOpenGroups((g) => ({ ...g, term: !g.term }))}>
          {TERM_TOKENS.map((tok) => (
            <ColorRow key={tok.key} label={tok.label} hint={tok.hint} value={draft.terminal[tok.key]} onChange={(v) => setTerm(tok.key, v)} />
          ))}
          <div className="te-subhead">ANSI colors</div>
          <div className="te-ansi">
            <span />
            {ANSI_SHORT.map((s, i) => (
              <span key={s} className="te-ansi-head" title={ansiLabel(i, false)}>
                {s}
              </span>
            ))}
            {[false, true].map((bright) => (
              <AnsiRow key={String(bright)} bright={bright} t={draft.terminal} selected={ansi} onSelect={setAnsi} />
            ))}
          </div>
          <ColorRow
            label={ansiLabel(ansiIndex, ansiBright)}
            hint="Click a swatch above to pick which ANSI color to edit"
            value={draft.terminal[ansi]}
            onChange={(v) => setTerm(ansi, v)}
          />
        </Group>
      </div>

      <footer className="te-foot">
        <button className="btn subtle" onClick={cancel} disabled={busy}>
          Cancel
        </button>
        <button className="btn subtle" title="Undo all changes since the editor opened" disabled={!dirty || busy} onClick={() => setDraft(initial.draft)}>
          <Icon name="undo" size={14} /> Reset
        </button>
        <span className="grow" />
        <button className="btn" title="Save a copy as a .json file" onClick={onExport} disabled={busy}>
          <Icon name="share" size={14} /> Export…
        </button>
        <button className="btn primary" onClick={onSave} disabled={!nameOk || busy} title={nameOk ? "Save and use this theme" : "Give the theme a name first"}>
          <Icon name="save" size={14} /> Save
        </button>
      </footer>
    </aside>
  );
}

function Group({ title, icon, open, onToggle, children }: { title: string; icon: string; open: boolean; onToggle: () => void; children: ReactNode }) {
  return (
    <section className="te-group">
      <button className="te-group-head" onClick={onToggle} aria-expanded={open}>
        <Icon name={icon} size={14} />
        <span className="grow">{title}</span>
        <Icon name={open ? "chevron-up" : "chevron-down"} size={14} className="dim" />
      </button>
      {open && <div className="te-group-body">{children}</div>}
    </section>
  );
}

function ColorRow({ label, hint, value, onChange }: { label: string; hint?: string; value: string; onChange: (v: string) => void }) {
  const [text, setText] = useState(value);
  const [editing, setEditing] = useState(false);
  useEffect(() => {
    if (!editing) setText(value);
  }, [value, editing]);
  const valid = isThemeColor(text);
  return (
    <div className="te-row">
      <span className="te-label" title={hint}>
        {label}
      </span>
      <label className="te-swatch" title="Pick a color">
        <span style={{ background: value }} />
        <input type="color" value={toHex6(value)} onChange={(e) => onChange(keepAlpha(e.target.value, value))} />
      </label>
      <input
        className={cx("input mono te-hex", !valid && "te-invalid")}
        value={text}
        spellCheck={false}
        title={valid ? hint : "Use #rgb, #rrggbb, #rrggbbaa or rgba(r, g, b, a)"}
        onFocus={() => setEditing(true)}
        onBlur={() => {
          setEditing(false);
          setText(value);
        }}
        onChange={(e) => {
          setText(e.target.value);
          if (isThemeColor(e.target.value)) onChange(e.target.value.trim());
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
          if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            setText(value);
            e.currentTarget.blur();
          }
        }}
      />
    </div>
  );
}

function AnsiRow({ bright, t, selected, onSelect }: { bright: boolean; t: TermColors; selected: AnsiKey; onSelect: (k: AnsiKey) => void }) {
  return (
    <>
      <span className="te-ansi-row-label">{bright ? "Bright" : "Normal"}</span>
      {ANSI_NAMES.map((_, i) => {
        const key = ansiKey(i, bright);
        return (
          <button
            key={key}
            className={cx("te-ansi-cell", selected === key && "selected")}
            title={`${ansiLabel(i, bright)} · ${t[key]}`}
            onClick={() => onSelect(key)}
          >
            <span style={{ background: t[key] }} />
          </button>
        );
      })}
    </>
  );
}

/** A few lines of fake shell output drawn with the draft's terminal colors. */
function TerminalPreview({ t }: { t: TermColors }) {
  const c = (color: string, text: string, bg?: string) => <span style={{ color, background: bg }}>{text}</span>;
  return (
    <div className="te-term" style={{ background: t.background, color: t.foreground }} aria-hidden>
      <div>
        {c(t.green, "dev@mosaic")} {c(t.blue, "~/projects/app")} {c(t.magenta, "(main)")} {c(t.brightBlack, "$")} git status
      </div>
      <div>
        On branch {c(t.cyan, "main")}, ahead by {c(t.yellow, "2")} commits
      </div>
      <div>{c(t.red, "  modified:   src/server.ts")}</div>
      <div>{c(t.green, "  new file:   docs/README.md")}</div>
      <div>
        {c(t.brightRed, "× 1 error")}  {c(t.brightYellow, "! 3 warnings")}  {c(t.brightGreen, "✓ built in 1.2s")}
      </div>
      <div>
        {c(t.brightBlue, "→")} {c(t.brightCyan, "http://localhost:5173")} {c(t.brightMagenta, "[vite]")} {c(t.white, "ready")}
      </div>
      <div>
        {c(t.brightBlack, "$")} <span style={{ background: t.selectionBackground }}>npm run</span> buil
        <span className="te-cursor" style={{ background: t.cursor, color: t.cursorAccent }}>
          d
        </span>
      </div>
      <div className="te-ansi-strip">
        {ALL_ANSI.map((k) => (
          <span key={k} style={{ background: t[k] }} title={k} />
        ))}
      </div>
    </div>
  );
}
