import { open, save } from "@tauri-apps/plugin-dialog";
import { useMemo, useState, type MouseEvent } from "react";
import { Icon } from "../../lib/icons";
import { ipc } from "../../lib/ipc";
import { basename, cx, isPlainObject } from "../../lib/util";
import { WORKSPACE_COLORS } from "../../state/model";
import { DEFAULT_SETTINGS, resetSettings, setSetting, settings, useSettings } from "../../state/settings";
import { allThemes, BUILTIN_THEMES, completeTheme, findTheme, useThemes, type Theme } from "../../state/themes";
import { ui, useUi, type MenuItem } from "../../state/ui";
import { isThemeColor } from "../ThemeEditor";
import {
  ColorSetting,
  FontField,
  Group,
  Hl,
  px,
  Row,
  Section,
  Segmented,
  SegmentedSetting,
  SliderSetting,
  ToggleSetting,
  useMatch,
  useSearch,
  useSetting,
} from "./controls";
import { attempt, openInDataDir, refreshThemes, slug, uniqueId } from "./helpers";

// ── theme actions ─────────────────────────────────────────────────────────

export function openThemeEditor(themeId: string) {
  useUi.setState({ themeEditor: { open: true, themeId } });
}

/** Theme as stored on disk (no runtime-only fields). */
function themeJson(t: Theme): Theme {
  const out = structuredClone(t);
  delete out.source;
  return out;
}

async function duplicateTheme(t: Theme, name = `${t.name} copy`): Promise<Theme | undefined> {
  const taken = new Set(allThemes().map((x) => x.id));
  const copy: Theme = { ...structuredClone(t), id: uniqueId(slug(name), taken), name, author: undefined, source: "user" };
  return attempt(async () => {
    await ipc.themeSave(themeJson(copy));
    await refreshThemes();
    return copy;
  });
}

async function exportTheme(t: Theme) {
  const path = await save({
    title: `Export “${t.name}”`,
    defaultPath: `${t.id}.json`,
    filters: [{ name: "Shellmosaic theme", extensions: ["json"] }],
  });
  if (!path) return;
  const ok = await attempt(() => ipc.fsWriteText(path, JSON.stringify(themeJson(t), null, 2) + "\n"));
  if (ok !== undefined) ui.toast(`Exported “${t.name}”`, "success");
}

async function deleteTheme(t: Theme) {
  const builtin = BUILTIN_THEMES.find((b) => b.id === t.id);
  const ok = await ui.confirm(
    builtin ? `Revert “${t.name}”?` : `Delete “${t.name}”?`,
    builtin
      ? "Your customized copy is removed and the built-in version comes back."
      : "The theme file is removed from your themes folder. This can't be undone (export it first if you might want it back).",
    { okLabel: builtin ? "Revert" : "Delete", danger: true },
  );
  if (!ok) return;
  const done = await attempt(async () => {
    await ipc.themeDelete(t.id);
    await refreshThemes();
    return true;
  });
  if (!done) return;
  if (settings().theme === t.id && !builtin) setSetting("theme", t.type === "light" ? "mosaic-day" : "mosaic-night");
  ui.toast(builtin ? `Reverted “${t.name}”` : `Deleted “${t.name}”`, "success");
}

/** Known keys with valid color values only (a non-string color breaks terminals and the editor); the rest comes from the default theme. */
function pickColors(raw: unknown, base: object, bad: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  if (!isPlainObject(raw)) return out;
  for (const [k, v] of Object.entries(raw)) {
    if (!(k in base)) continue;
    if (typeof v === "string" && isThemeColor(v)) out[k] = v.trim();
    else bad.push(k);
  }
  return out;
}

async function importTheme() {
  const file = await open({ multiple: false, title: "Import theme", filters: [{ name: "Theme (JSON)", extensions: ["json"] }] });
  if (!file || Array.isArray(file)) return;
  const raw = (await attempt(() => ipc.themeReadFile(file))) as Record<string, unknown> | undefined;
  if (!raw) return;
  let id = slug(String(raw.id ?? raw.name ?? basename(file).replace(/\.json$/i, "")));
  const existing = useThemes.getState().user.find((t) => t.id === id);
  if (existing) {
    const replace = await ui.confirm(`Replace “${existing.name}”?`, `You already have a theme with the id “${id}”. Importing replaces it.`, { okLabel: "Replace" });
    if (!replace) return;
  } else if (BUILTIN_THEMES.some((t) => t.id === id)) {
    id = uniqueId(`${id}-imported`, new Set(allThemes().map((t) => t.id)));
  }
  const base = raw.type === "light" ? BUILTIN_THEMES[1] : BUILTIN_THEMES[0];
  const bad: string[] = [];
  const theme = completeTheme({
    ...raw,
    id,
    name: typeof raw.name === "string" && raw.name.trim() ? raw.name : id,
    author: typeof raw.author === "string" ? raw.author : undefined,
    source: "user",
    ui: pickColors(raw.ui, base.ui, bad),
    terminal: pickColors(raw.terminal, base.terminal, bad),
  });
  const ok = await attempt(async () => {
    await ipc.themeSave(themeJson(theme));
    await refreshThemes();
    return true;
  });
  if (!ok) return;
  setSetting("theme", id);
  if (bad.length) ui.toast(`Imported “${theme.name}”. ${bad.length} invalid color${bad.length === 1 ? "" : "s"} (${bad.join(", ")}) use the defaults.`, "warning", 6000);
  else ui.toast(`Imported and applied “${theme.name}”`, "success");
}

async function newTheme() {
  const base = findTheme(settings().theme);
  const taken = new Set(allThemes().map((t) => t.name));
  let name = `My ${base.name.replace(/^My /, "")}`;
  for (let i = 2; taken.has(name); i++) name = `My ${base.name.replace(/^My /, "")} ${i}`;
  const copy = await duplicateTheme(base, name);
  if (!copy) return;
  setSetting("theme", copy.id);
  openThemeEditor(copy.id);
}

function themeMenu(t: Theme): MenuItem[] {
  const user = t.source === "user";
  const overridesBuiltin = user && BUILTIN_THEMES.some((b) => b.id === t.id);
  return [
    { label: "Use this theme", icon: "check", onSelect: () => setSetting("theme", t.id) },
    { label: "Edit…", icon: "pencil", onSelect: () => openThemeEditor(t.id) },
    {
      label: "Duplicate",
      icon: "copy",
      onSelect: async () => {
        const c = await duplicateTheme(t);
        if (c) ui.toast(`Created “${c.name}”`, "success");
      },
    },
    { label: "Export…", icon: "download", onSelect: () => exportTheme(t) },
    { type: "separator" },
    {
      label: overridesBuiltin ? "Revert to built-in" : "Delete",
      icon: overridesBuiltin ? "undo" : "trash",
      danger: true,
      disabled: !user,
      hint: user ? undefined : "built-in",
      onSelect: () => deleteTheme(t),
    },
  ];
}

// ── gallery ───────────────────────────────────────────────────────────────

export function ThemePreview({ t }: { t: Theme }) {
  const u = t.ui;
  const c = t.terminal;
  return (
    <div className="theme-preview" style={{ background: u.bg }}>
      <div className="tp-rail" style={{ background: u.rail }}>
        <i style={{ background: u.accent }} />
        <i style={{ background: u.surface2 }} />
        <i style={{ background: u.surface2 }} />
      </div>
      <div className="tp-main">
        <div className="tp-title" style={{ background: u.titlebar }}>
          <span className="tp-tab" style={{ background: u.tabActive, boxShadow: `inset 0 -2px 0 ${u.accent}` }} />
          <span className="tp-tab" style={{ background: u.surface }} />
          <span className="tp-dot" style={{ background: u.accent }} />
        </div>
        <div className="tp-term" style={{ background: c.background, color: c.foreground, borderColor: u.border }}>
          <div>
            <span style={{ color: c.green }}>$</span> <span style={{ color: c.blue }}>~/code</span> <span style={{ color: c.magenta }}>git</span> status
          </div>
          <div>
            <span style={{ color: c.red }}>modified:</span> <span style={{ color: c.yellow }}>app.ts</span>
          </div>
          <div>
            <span style={{ color: c.cyan }}>ready</span> in 1.2s<span className="tp-cursor" style={{ background: c.cursor }} />
          </div>
          <div className="tp-ansi">
            {[c.red, c.green, c.yellow, c.blue, c.magenta, c.cyan, c.white, c.brightBlack].map((x, i) => (
              <i key={i} style={{ background: x }} />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function ThemeCard({ t, active }: { t: Theme; active: boolean }) {
  const match = useMatch(t.name, t.author, t.type, t.source === "user" ? "custom mine user" : "built-in builtin");
  if (!match) return null;
  const apply = () => setSetting("theme", t.id);
  const menuAt = (e: MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    ui.openMenu(e, themeMenu(t));
  };
  return (
    <div
      className={cx("theme-card setting-hit", active && "active")}
      role="button"
      tabIndex={0}
      aria-pressed={active}
      onClick={apply}
      onKeyDown={(e) => {
        // not for the edit/menu buttons inside the card (preventDefault would also cancel their click)
        if (e.target !== e.currentTarget) return;
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          apply();
        }
      }}
      onContextMenu={menuAt}
      title={active ? `${t.name} (current theme)` : `Use ${t.name}`}
    >
      <ThemePreview t={t} />
      <div className="theme-meta">
        <span className="theme-name">
          <Hl text={t.name} />
        </span>
        <button
          className="icon-btn"
          title="Edit theme"
          onClick={(e) => {
            e.stopPropagation();
            openThemeEditor(t.id);
          }}
        >
          <Icon name="pencil" size={13} />
        </button>
        <button
          className="icon-btn"
          title="More…"
          onClick={(e) => {
            e.stopPropagation();
            const r = e.currentTarget.getBoundingClientRect();
            ui.openMenu({ x: r.left, y: r.bottom + 4 }, themeMenu(t));
          }}
        >
          <Icon name="ellipsis" size={14} />
        </button>
      </div>
      <div className="theme-sub">
        {t.type === "light" ? "Light" : "Dark"}
        {t.source === "user" ? " · yours" : t.author ? ` · ${t.author}` : ""}
      </div>
      {active && (
        <span className="theme-check" title="Current theme">
          <Icon name="check" size={12} />
        </span>
      )}
    </div>
  );
}

type ThemeFilter = "all" | "dark" | "light" | "mine";

function ThemeGallery() {
  const current = useSettings((s) => s.settings.theme);
  const user = useThemes((s) => s.user);
  const q = useSearch();
  const [filter, setFilter] = useState<ThemeFilter>("all");
  // allThemes() reads the theme store; `user` is the part that changes
  const themes = useMemo(() => allThemes(), [user]);
  const shown = q ? themes : themes.filter((t) => filter === "all" || (filter === "mine" ? t.source === "user" : t.type === filter));
  return (
    <>
      {!q && (
        <div className="theme-toolbar">
          <Segmented<ThemeFilter>
            value={filter}
            onChange={setFilter}
            options={[
              { value: "all", label: "All" },
              { value: "dark", label: "Dark", icon: "moon" },
              { value: "light", label: "Light", icon: "sun" },
              { value: "mine", label: "Mine", icon: "star" },
            ]}
          />
          <span className="grow" />
          <span className="dim small-text">
            {shown.length} theme{shown.length === 1 ? "" : "s"} · right-click a theme for more
          </span>
        </div>
      )}
      <div className="theme-grid">
        {shown.map((t) => (
          <ThemeCard key={t.id} t={t} active={t.id === current} />
        ))}
        {!q && shown.length === 0 && (
          <div className="settings-empty small">
            {filter === "mine" ? "No themes of your own yet. Use “New theme” or duplicate one you like." : "No themes here."}
          </div>
        )}
      </div>
    </>
  );
}

// ── section ───────────────────────────────────────────────────────────────

const UI_FONTS = [
  { label: "Segoe UI Variable", value: DEFAULT_SETTINGS.appearance.uiFont },
  { label: "Segoe UI", value: '"Segoe UI", system-ui, sans-serif' },
  { label: "Inter", value: 'Inter, "Segoe UI", system-ui, sans-serif' },
  { label: "System", value: "system-ui, sans-serif" },
  { label: "Cascadia Mono", value: '"Cascadia Mono", Consolas, monospace' },
];

function AccentRow() {
  const accent = useSetting<string | null>("appearance.accent");
  return (
    <ColorSetting
      path="appearance.accent"
      label="Accent color"
      desc={accent ? "Overrides the theme's accent for buttons, focus rings and active items. ✕ goes back to the theme's." : "Using the theme's own accent. Pick a color to override it."}
      keywords="highlight color tint override"
      swatches={WORKSPACE_COLORS}
      allowNone
      noneLabel="Use the theme's accent"
    />
  );
}

function UiFontRow() {
  const v = useSetting<string>("appearance.uiFont");
  return (
    <Row label="Interface font" desc="Font for menus, tabs and panels. Any installed font works; list fallbacks with commas." keywords="typeface ui font family" stack>
      <FontField value={v} onChange={(x) => setSetting("appearance.uiFont", x)} picks={UI_FONTS} />
    </Row>
  );
}

export function AppearanceSection() {
  const moduleBar = useSetting<string>("appearance.moduleBar");
  return (
    <Section
      id="appearance"
      title="Appearance"
      icon="palette"
      desc="Themes, colors, fonts and the layout of the interface."
      onReset={() => {
        resetSettings("appearance");
        setSetting("theme", DEFAULT_SETTINGS.theme);
      }}
      resetHint="The theme, accent, fonts, density and layout go back to their defaults. Your saved themes are kept."
    >
      <Group
        title="Theme"
        plain
        actions={
          <>
            <button className="btn small primary" onClick={newTheme} title="Copy the current theme and open it in the editor">
              <Icon name="plus" size={13} /> New theme
            </button>
            <button className="btn small" onClick={importTheme}>
              <Icon name="import" size={13} /> Import…
            </button>
            <button className="btn small subtle" onClick={() => openInDataDir("themes")} title="Theme files are plain JSON — edit them in any editor">
              <Icon name="folder-open" size={13} /> Themes folder
            </button>
          </>
        }
      >
        <ThemeGallery />
      </Group>

      <Group title="Colors">
        <AccentRow />
      </Group>

      <Group title="Interface">
        <UiFontRow />
        <SliderSetting path="appearance.uiFontSize" label="Interface font size" min={11} max={17} step={1} format={px} keywords="text size zoom" />
        <SegmentedSetting
          path="appearance.density"
          label="Density"
          desc="How much breathing room rows, tabs and bars get."
          keywords="compact spacious padding size"
          options={[
            { value: "compact", label: "Compact" },
            { value: "comfortable", label: "Comfortable" },
            { value: "spacious", label: "Spacious" },
          ]}
        />
        <SliderSetting path="appearance.radius" label="Corner roundness" desc="Radius of panes, buttons and menus." min={0} max={16} step={1} format={px} keywords="radius rounded corners" />
        <SliderSetting path="appearance.paneGap" label="Gap between panes" min={0} max={20} step={1} format={px} keywords="spacing gutter split" />
        <ToggleSetting path="appearance.animations" label="Animations" desc="Subtle motion for menus, magnify and hover effects." keywords="motion transitions reduce" />
      </Group>

      <Group title="Tabs & panes">
        <SegmentedSetting
          path="appearance.tabStyle"
          label="Tab style"
          keywords="tabs look"
          options={[
            { value: "pill", label: "Pill" },
            { value: "underline", label: "Underline" },
            { value: "block", label: "Block" },
          ]}
        />
        <ToggleSetting path="appearance.showTabIcons" label="Show tab icons" desc="The module or custom icon next to each tab name." keywords="tabs icons" />
        <SegmentedSetting
          path="appearance.paneHeaders"
          label="Terminal pane headers"
          desc="The title strip above each terminal. “On hover” shows it when the mouse is over the pane; pane actions stay on right-click."
          keywords="title bar header strip pane"
          options={[
            { value: "always", label: "Always" },
            { value: "hover", label: "On hover" },
            { value: "never", label: "Never" },
          ]}
        />
        <SegmentedSetting
          path="appearance.zoomStyle"
          label="Magnified pane"
          desc="How a magnified pane (Ctrl+Shift+M) is shown."
          keywords="zoom maximize focus"
          options={[
            { value: "magnify", label: "Floating", title: "Floats above the other panes with a dimmed backdrop" },
            { value: "fill", label: "Fill the tab", title: "Covers the whole tab" },
          ]}
        />
      </Group>

      <Group title="Layout">
        <SegmentedSetting
          path="appearance.railPosition"
          label="Workspace rail"
          desc="Side of the window for the workspace switcher."
          keywords="sidebar workspaces left right"
          options={[
            { value: "left", label: "Left" },
            { value: "right", label: "Right" },
          ]}
        />
        <SegmentedSetting
          path="appearance.moduleBar"
          label="Module bar"
          desc="The strip of modules you can click or drag into a tab."
          keywords="modules sidebar hide"
          options={[
            { value: "left", label: "Left" },
            { value: "right", label: "Right" },
            { value: "hidden", label: "Hidden" },
          ]}
        />
        <ToggleSetting path="appearance.moduleBarLabels" label="Module bar labels" desc="Show names under the module icons." keywords="text names" disabled={moduleBar === "hidden"} />
      </Group>
    </Section>
  );
}
