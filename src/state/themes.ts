// Themes: built-ins plus user themes from <data>/themes/*.json, applied as CSS
// variables for the UI and an xterm.js ITheme for terminals.
import { listen } from "@tauri-apps/api/event";
import type { ITheme } from "@xterm/xterm";
import { create } from "zustand";
import { ipc } from "../lib/ipc";
import { isPlainObject, luminance, withAlpha } from "../lib/util";
import type { Settings } from "./settings";

export interface UiColors {
  bg: string;
  surface: string;
  surface2: string;
  border: string;
  text: string;
  textDim: string;
  accent: string;
  accentText: string;
  danger: string;
  warning: string;
  success: string;
  rail: string;
  titlebar: string;
  tabActive: string;
  paneHeader: string;
  selection: string;
}

export interface TermColors {
  background: string;
  foreground: string;
  cursor: string;
  cursorAccent: string;
  selectionBackground: string;
  black: string;
  red: string;
  green: string;
  yellow: string;
  blue: string;
  magenta: string;
  cyan: string;
  white: string;
  brightBlack: string;
  brightRed: string;
  brightGreen: string;
  brightYellow: string;
  brightBlue: string;
  brightMagenta: string;
  brightCyan: string;
  brightWhite: string;
}

export interface Theme {
  id: string;
  name: string;
  author?: string;
  type: "dark" | "light";
  source?: "builtin" | "user";
  ui: UiColors;
  terminal: TermColors;
}

type CoreUi = Pick<UiColors, "bg" | "surface" | "surface2" | "border" | "text" | "textDim" | "accent" | "danger" | "warning" | "success"> &
  Partial<UiColors>;
type Ansi = string; // "black red green yellow blue magenta cyan white" then bright variants

/** Build a full theme from core colors; derived tokens can still be overridden. */
export function makeTheme(
  id: string,
  name: string,
  type: "dark" | "light",
  ui: CoreUi,
  term: { background?: string; foreground: string; cursor?: string; selection?: string; ansi: Ansi },
  author?: string,
): Theme {
  const a = term.ansi.trim().split(/\s+/);
  const full: UiColors = {
    accentText: luminance(ui.accent) > 0.45 ? "#0b0d12" : "#ffffff",
    rail: ui.bg,
    titlebar: ui.bg,
    tabActive: ui.surface2,
    paneHeader: ui.surface,
    selection: withAlpha(ui.accent, 0.28),
    ...ui,
  };
  return {
    id,
    name,
    author,
    type,
    source: "builtin",
    ui: full,
    terminal: {
      background: term.background ?? ui.bg,
      foreground: term.foreground,
      cursor: term.cursor ?? ui.accent,
      cursorAccent: term.background ?? ui.bg,
      selectionBackground: term.selection ?? withAlpha(ui.accent, 0.3),
      black: a[0], red: a[1], green: a[2], yellow: a[3], blue: a[4], magenta: a[5], cyan: a[6], white: a[7],
      brightBlack: a[8], brightRed: a[9], brightGreen: a[10], brightYellow: a[11],
      brightBlue: a[12], brightMagenta: a[13], brightCyan: a[14], brightWhite: a[15],
    },
  };
}

export const BUILTIN_THEMES: Theme[] = [
  makeTheme("mosaic-night", "Mosaic Night", "dark",
    { bg: "#0e1116", surface: "#151a21", surface2: "#1d232c", border: "#262e3a", text: "#e6eaf2", textDim: "#8892a3",
      accent: "#7c9cff", danger: "#ef6b7b", warning: "#f6b958", success: "#3fd39a", rail: "#0b0e12", titlebar: "#0b0e12" },
    { foreground: "#d6deeb", ansi: "#1b2029 #ef6b7b #3fd39a #f6b958 #6c8cff #c38bff #4cc9f0 #c8d0dc #4b5566 #ff8a96 #6ee7b7 #ffd28a #9db3ff #dcb0ff #7fdcff #f4f7fb" },
    "Shellmosaic"),
  makeTheme("mosaic-day", "Mosaic Day", "light",
    { bg: "#f3f4f8", surface: "#ffffff", surface2: "#e9ecf2", border: "#d9dde5", text: "#1d2330", textDim: "#667085",
      accent: "#4a66e8", danger: "#d63a4f", warning: "#b9770e", success: "#13925f", rail: "#e8eaf0", titlebar: "#e8eaf0", paneHeader: "#f7f8fb" },
    { background: "#ffffff", foreground: "#2a3140", ansi: "#2a3140 #c8364a #13925f #a96c00 #3a5ad9 #8f45d0 #0f8aa8 #8b93a3 #5d6677 #e04a5f #1fae74 #c98500 #5a78f0 #a764e6 #1aa5c6 #c9ced8" },
    "Shellmosaic"),
  makeTheme("ember", "Ember", "dark",
    { bg: "#15110f", surface: "#1d1714", surface2: "#271f1b", border: "#372b25", text: "#f1e6dc", textDim: "#a8968a",
      accent: "#ff8c42", danger: "#ff5f56", warning: "#ffbd2e", success: "#8fd16a", rail: "#110d0b", titlebar: "#110d0b" },
    { foreground: "#ecdccf", ansi: "#2a211c #ff6b5b #9ccf6e #ffbe5c #79a7d9 #e08ec1 #6fc7b8 #d8c8bb #6b5a4f #ff8f80 #b7e48e #ffd38a #9cc2ec #f1aed6 #93dccf #fff4ea" },
    "Shellmosaic"),
  makeTheme("deep-sea", "Deep Sea", "dark",
    { bg: "#0a1419", surface: "#0f1c23", surface2: "#16272f", border: "#1e3440", text: "#dcecf2", textDim: "#7f9aa6",
      accent: "#2ed3c6", danger: "#ff6b81", warning: "#f7c86b", success: "#4fe0a0", rail: "#071014", titlebar: "#071014" },
    { foreground: "#cfe6ee", ansi: "#12232b #ff6b81 #4fe0a0 #f7c86b #5aa9ff #b58cff #2ed3c6 #b7ccd4 #3d5764 #ff94a6 #7ef0bd #ffdc94 #87c2ff #cfb0ff #6be8de #eef8fb" },
    "Shellmosaic"),
  makeTheme("phosphor", "Phosphor", "dark",
    { bg: "#050a06", surface: "#0a120b", surface2: "#101b11", border: "#1a2e1c", text: "#b6f5bf", textDim: "#5f9a68",
      accent: "#39ff6a", danger: "#ff5c5c", warning: "#e6d35a", success: "#39ff6a" },
    { foreground: "#8dfc9f", ansi: "#0a140b #ff6b6b #39ff6a #d9f25a #4fd1a5 #9be37a #5af2c4 #a6f0b2 #2f5a35 #ff9393 #7dff9d #eeff8a #7fe8c5 #c0f59f #8dfbe0 #e2ffe7" },
    "Shellmosaic"),
  makeTheme("dracula", "Dracula", "dark",
    { bg: "#282a36", surface: "#2d2f3d", surface2: "#363949", border: "#44475a", text: "#f8f8f2", textDim: "#9aa0c3",
      accent: "#bd93f9", danger: "#ff5555", warning: "#ffb86c", success: "#50fa7b", rail: "#21222c", titlebar: "#21222c" },
    { foreground: "#f8f8f2", cursor: "#f8f8f2", selection: "#44475a", ansi: "#21222c #ff5555 #50fa7b #f1fa8c #bd93f9 #ff79c6 #8be9fd #f8f8f2 #6272a4 #ff6e6e #69ff94 #ffffa5 #d6acff #ff92df #a4ffff #ffffff" },
    "Dracula Theme (MIT)"),
  makeTheme("nord", "Nord", "dark",
    { bg: "#2e3440", surface: "#333a47", surface2: "#3b4252", border: "#4c566a", text: "#eceff4", textDim: "#9aa5b8",
      accent: "#88c0d0", danger: "#bf616a", warning: "#ebcb8b", success: "#a3be8c", rail: "#272c36", titlebar: "#272c36" },
    { foreground: "#d8dee9", cursor: "#d8dee9", selection: "#434c5ecc", ansi: "#3b4252 #bf616a #a3be8c #ebcb8b #81a1c1 #b48ead #88c0d0 #e5e9f0 #4c566a #bf616a #a3be8c #ebcb8b #81a1c1 #b48ead #8fbcbb #eceff4" },
    "Arctic Ice Studio (MIT)"),
  makeTheme("catppuccin-mocha", "Catppuccin Mocha", "dark",
    { bg: "#1e1e2e", surface: "#181825", surface2: "#313244", border: "#45475a", text: "#cdd6f4", textDim: "#a6adc8",
      accent: "#cba6f7", danger: "#f38ba8", warning: "#fab387", success: "#a6e3a1", rail: "#11111b", titlebar: "#11111b" },
    { foreground: "#cdd6f4", cursor: "#f5e0dc", selection: "#585b7099", ansi: "#45475a #f38ba8 #a6e3a1 #f9e2af #89b4fa #f5c2e7 #94e2d5 #bac2de #585b70 #f38ba8 #a6e3a1 #f9e2af #89b4fa #f5c2e7 #94e2d5 #a6adc8" },
    "Catppuccin (MIT)"),
  makeTheme("tokyo-night", "Tokyo Night", "dark",
    { bg: "#1a1b26", surface: "#16161e", surface2: "#24283b", border: "#292e42", text: "#c0caf5", textDim: "#737aa2",
      accent: "#7aa2f7", danger: "#f7768e", warning: "#e0af68", success: "#9ece6a", rail: "#13131a", titlebar: "#13131a" },
    { foreground: "#c0caf5", cursor: "#c0caf5", selection: "#33467c", ansi: "#15161e #f7768e #9ece6a #e0af68 #7aa2f7 #bb9af7 #7dcfff #a9b1d6 #414868 #f7768e #9ece6a #e0af68 #7aa2f7 #bb9af7 #7dcfff #c0caf5" },
    "enkia (MIT)"),
  makeTheme("gruvbox-dark", "Gruvbox Dark", "dark",
    { bg: "#282828", surface: "#2f2d2c", surface2: "#3c3836", border: "#504945", text: "#ebdbb2", textDim: "#a89984",
      accent: "#fe8019", danger: "#fb4934", warning: "#fabd2f", success: "#b8bb26", rail: "#1d2021", titlebar: "#1d2021" },
    { foreground: "#ebdbb2", cursor: "#ebdbb2", selection: "#504945", ansi: "#282828 #cc241d #98971a #d79921 #458588 #b16286 #689d6a #a89984 #928374 #fb4934 #b8bb26 #fabd2f #83a598 #d3869b #8ec07c #ebdbb2" },
    "morhetz (MIT)"),
  makeTheme("solarized-light", "Solarized Light", "light",
    { bg: "#fdf6e3", surface: "#fffaeb", surface2: "#eee8d5", border: "#e0d9c3", text: "#3c4d55", textDim: "#7b8c8f",
      accent: "#268bd2", danger: "#dc322f", warning: "#b58900", success: "#859900", rail: "#f3ecd7", titlebar: "#f3ecd7" },
    { foreground: "#586e75", cursor: "#586e75", selection: "#eee8d5", ansi: "#073642 #dc322f #859900 #b58900 #268bd2 #d33682 #2aa198 #eee8d5 #002b36 #cb4b16 #586e75 #657b83 #839496 #6c71c4 #93a1a1 #fdf6e3" },
    "Ethan Schoonover (MIT)"),
];

interface ThemeState {
  user: Theme[];
  /** a theme being edited live in the theme editor (not yet saved) */
  preview: Theme | null;
}

export const useThemes = create<ThemeState>(() => ({ user: [], preview: null }));

export function allThemes(): Theme[] {
  const user = useThemes.getState().user;
  const ids = new Set(user.map((t) => t.id));
  return [...BUILTIN_THEMES.filter((t) => !ids.has(t.id)), ...user];
}

export function findTheme(id: string): Theme {
  return allThemes().find((t) => t.id === id) ?? BUILTIN_THEMES[0];
}

/** `base` with the known keys of `raw` that hold a CSS color (a hand-edited null or number would crash xterm and the editor). */
function colorsOver<T extends object>(base: T, raw: unknown): T {
  const out: Record<string, string> = { ...(base as Record<string, string>) };
  if (isPlainObject(raw)) {
    for (const [k, v] of Object.entries(raw)) {
      // (var() passes CSS.supports but means nothing to xterm)
      if (k in base && typeof v === "string" && CSS.supports("color", v.trim()) && !/\b(var|env|attr)\(/i.test(v)) out[k] = v.trim();
    }
  }
  return out as T;
}

/** Fill gaps in a user/imported theme from the closest built-in so it always renders. */
export function completeTheme(raw: any): Theme {
  const base = raw?.type === "light" ? BUILTIN_THEMES[1] : BUILTIN_THEMES[0];
  return {
    id: String(raw?.id ?? "custom"),
    name: String(raw?.name ?? raw?.id ?? "Custom"),
    author: typeof raw?.author === "string" ? raw.author : undefined,
    type: raw?.type === "light" ? "light" : "dark",
    source: raw?.source ?? "user",
    ui: colorsOver(base.ui, raw?.ui),
    terminal: colorsOver(base.terminal, raw?.terminal),
  };
}

export async function loadThemes() {
  const refresh = async () => {
    const list = await ipc.themesList();
    useThemes.setState({ user: list.map(completeTheme) });
  };
  await refresh();
  await listen("config://themes", () => {
    refresh().catch(console.error);
  });
}

export function activeTheme(s: Settings): Theme {
  return useThemes.getState().preview ?? findTheme(s.theme);
}

const DENSITY = {
  compact: { row: 26, pad: 6, tab: 28, rail: 44 },
  comfortable: { row: 30, pad: 8, tab: 32, rail: 52 },
  spacious: { row: 34, pad: 10, tab: 36, rail: 58 },
};

/** Push theme + appearance settings into CSS variables on <html>. */
export function applyTheme(theme: Theme, s: Settings) {
  const root = document.documentElement;
  const set = (k: string, v: string | number) => root.style.setProperty(k, String(v));
  const ui = { ...theme.ui };
  if (s.appearance.accent) {
    ui.accent = s.appearance.accent;
    ui.accentText = luminance(ui.accent) > 0.45 ? "#0b0d12" : "#ffffff";
    ui.selection = withAlpha(ui.accent, 0.28);
  }
  const map: Record<string, string> = {
    "--bg": ui.bg,
    "--surface": ui.surface,
    "--surface-2": ui.surface2,
    "--border": ui.border,
    "--text": ui.text,
    "--text-dim": ui.textDim,
    "--accent": ui.accent,
    "--accent-text": ui.accentText,
    "--danger": ui.danger,
    "--warning": ui.warning,
    "--success": ui.success,
    "--rail": ui.rail,
    "--titlebar": ui.titlebar,
    "--tab-active": ui.tabActive,
    "--pane-header": ui.paneHeader,
    "--selection": ui.selection,
  };
  for (const [k, v] of Object.entries(map)) set(k, v);
  const translucent = s.window.effect !== "none" || !!s.window.background || s.window.opacity < 1;
  set("--alpha", translucent ? s.window.opacity : 1);
  const d = DENSITY[s.appearance.density] ?? DENSITY.comfortable;
  set("--row-h", `${d.row}px`);
  set("--pad", `${d.pad}px`);
  set("--tab-h", `${d.tab}px`);
  set("--rail-w", `${d.rail}px`);
  set("--radius", `${s.appearance.radius}px`);
  set("--gap", `${s.appearance.paneGap}px`);
  set("--font-ui", s.appearance.uiFont);
  set("--font-ui-size", `${s.appearance.uiFontSize}px`);
  set("--font-mono", s.terminal.fontFamily);
  set("--term-pad", `${s.terminal.padding}px`);
  root.dataset.themeType = theme.type;
  root.dataset.animations = s.appearance.animations ? "on" : "off";
  root.style.colorScheme = theme.type;
}

/** The xterm.js theme for a terminal (optionally overridden per pane). */
export function xtermTheme(theme: Theme, s: Settings): ITheme {
  const t = theme.terminal;
  const translucent = s.window.effect !== "none" || !!s.window.background || s.window.opacity < 1;
  return {
    ...t,
    background: translucent ? withAlpha(t.background, s.window.opacity) : t.background,
    scrollbarSliderBackground: withAlpha(t.foreground, 0.1),
    scrollbarSliderHoverBackground: withAlpha(t.foreground, 0.2),
    scrollbarSliderActiveBackground: withAlpha(t.foreground, 0.28),
  };
}

/** CSS variables handed to plugins so they can match the app's look. */
export function pluginThemeVars(theme: Theme, s: Settings): Record<string, string> {
  const ui = theme.ui;
  return {
    "--sm-bg": ui.surface,
    "--sm-surface": ui.bg,
    "--sm-surface-2": ui.surface2,
    "--sm-border": ui.border,
    "--sm-text": ui.text,
    "--sm-text-dim": ui.textDim,
    "--sm-accent": s.appearance.accent ?? ui.accent,
    "--sm-accent-text": ui.accentText,
    "--sm-danger": ui.danger,
    "--sm-warning": ui.warning,
    "--sm-success": ui.success,
    "--sm-radius": `${s.appearance.radius}px`,
    "--sm-font": s.appearance.uiFont,
    "--sm-font-size": `${s.appearance.uiFontSize}px`,
    "--sm-mono": s.terminal.fontFamily,
  };
}
