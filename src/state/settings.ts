// User settings: defaults live here; settings.json stores only what the user changed.
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { create } from "zustand";
import { ipc, type Profile } from "../lib/ipc";
import { debounce, deepDiff, isPlainObject, setPath } from "../lib/util";
import type { Background } from "./model";

export interface HighlightRule {
  pattern: string;
  color: string;
  regex?: boolean;
}

export interface Settings {
  theme: string;
  appearance: {
    uiFont: string;
    uiFontSize: number;
    density: "compact" | "comfortable" | "spacious";
    radius: number;
    accent: string | null;
    animations: boolean;
    railPosition: "left" | "right";
    moduleBar: "right" | "left" | "hidden";
    moduleBarLabels: boolean;
    tabStyle: "pill" | "underline" | "block";
    paneGap: number;
    paneHeaders: "always" | "hover" | "never";
    zoomStyle: "magnify" | "fill";
    showTabIcons: boolean;
  };
  window: {
    effect: "none" | "mica" | "acrylic" | "tabbed" | "blur";
    opacity: number;
    background: Background | null;
    confirmQuit: boolean;
  };
  terminal: {
    fontFamily: string;
    fontSize: number;
    lineHeight: number;
    letterSpacing: number;
    fontWeight: string;
    fontWeightBold: string;
    cursorStyle: "block" | "bar" | "underline";
    cursorBlink: boolean;
    scrollback: number;
    copyOnSelect: boolean;
    trimSelection: boolean;
    ctrlCCopies: boolean;
    ctrlVPastes: boolean;
    /** what Ctrl+V sends when the clipboard holds an image instead of text (programs like Claude Code paste it themselves) */
    imagePaste: "altV" | "ctrlV" | "none";
    /** what Shift+Enter sends: "newline" = ESC CR, which Claude Code reads as a new line; "enter" = a plain Enter */
    shiftEnter: "newline" | "enter";
    rightClick: "menu" | "paste" | "copyPaste";
    confirmMultilinePaste: boolean;
    bell: "none" | "visual" | "sound" | "both";
    padding: number;
    webgl: boolean;
    minimumContrastRatio: number;
    drawBoldTextInBrightColors: boolean;
    defaultProfile: string;
    shellIntegration: boolean;
    links: "browser" | "webPane";
    inheritCwd: boolean;
    /** new shells get the user's default environment, not Shellmosaic's own */
    freshEnvironment: boolean;
  };
  profiles: {
    custom: Profile[];
    hidden: string[];
    overrides: Record<string, Partial<Profile>>;
  };
  modules: {
    bar: string[];
    barHidden: string[];
    files: { showHidden: boolean; followTerminal: boolean };
    web: { home: string };
    sysinfo: { intervalMs: number };
    processes: { intervalMs: number };
    ports: { intervalMs: number; listeningOnly: boolean };
    logs: { highlights: HighlightRule[]; maxLines: number };
    /** saved SSH hosts: lock the vault after this many idle minutes (0 = never) */
    hosts: { autoLockMinutes: number };
  };
  keybindings: Record<string, string>;
  restore: { session: boolean; scrollback: boolean; scrollbackMB: number };
  plugins: { grants: Record<string, string[]>; disabled: string[] };
  /**
   * checks GitHub releases; `skipped` is a version the user chose to skip. `channel`: Stable
   * (main) or Test (pre-release builds and the test branch's optional modules)
   */
  updates: { autoCheck: boolean; skipped: string | null; channel: "stable" | "test" };
}

export const DEFAULT_SETTINGS: Settings = {
  theme: "mosaic-night",
  appearance: {
    uiFont: '"Segoe UI Variable Text", "Segoe UI", system-ui, sans-serif',
    uiFontSize: 13,
    density: "comfortable",
    radius: 8,
    accent: null,
    animations: true,
    railPosition: "left",
    moduleBar: "right",
    moduleBarLabels: true,
    tabStyle: "pill",
    paneGap: 6,
    paneHeaders: "always",
    zoomStyle: "magnify",
    showTabIcons: true,
  },
  window: {
    effect: "mica",
    opacity: 0.9,
    background: null,
    confirmQuit: false,
  },
  terminal: {
    fontFamily: '"Cascadia Code", "Cascadia Mono", Consolas, "Courier New", monospace',
    fontSize: 14,
    lineHeight: 1.2,
    letterSpacing: 0,
    fontWeight: "normal",
    fontWeightBold: "bold",
    cursorStyle: "bar",
    cursorBlink: true,
    scrollback: 10000,
    copyOnSelect: false,
    trimSelection: true,
    ctrlCCopies: true,
    ctrlVPastes: true,
    imagePaste: "altV",
    shiftEnter: "newline",
    rightClick: "menu",
    confirmMultilinePaste: true,
    bell: "visual",
    padding: 8,
    webgl: true,
    minimumContrastRatio: 1,
    drawBoldTextInBrightColors: true,
    defaultProfile: "auto",
    shellIntegration: true,
    links: "browser",
    inheritCwd: true,
    freshEnvironment: true,
  },
  profiles: { custom: [], hidden: [], overrides: {} },
  modules: {
    bar: ["terminal", "hosts", "files", "web", "sysinfo", "processes", "notes", "git", "ports", "tasks", "logs"],
    barHidden: [],
    files: { showHidden: false, followTerminal: true },
    web: { home: "https://duckduckgo.com" },
    sysinfo: { intervalMs: 1000 },
    processes: { intervalMs: 2000 },
    ports: { intervalMs: 3000, listeningOnly: true },
    logs: {
      highlights: [
        { pattern: "\\b(error|fatal|fail(ed|ure)?|panic|exception)\\b", color: "#ef6b7b", regex: true },
        { pattern: "\\b(warn(ing)?|deprecated)\\b", color: "#f6b958", regex: true },
        { pattern: "\\b(info|notice)\\b", color: "#6c8cff", regex: true },
        { pattern: "\\b(debug|trace)\\b", color: "#8892a3", regex: true },
        { pattern: "\\b(success|ok|done|ready|listening)\\b", color: "#3fd39a", regex: true },
      ],
      maxLines: 20000,
    },
    hosts: { autoLockMinutes: 15 },
  },
  keybindings: {},
  restore: { session: true, scrollback: true, scrollbackMB: 2 },
  plugins: { grants: {}, disabled: [] },
  updates: { autoCheck: true, skipped: null, channel: "stable" },
};

interface SettingsState {
  settings: Settings;
  loaded: boolean;
}

export const useSettings = create<SettingsState>(() => ({
  settings: structuredClone(DEFAULT_SETTINGS),
  loaded: false,
}));

const save = debounce(() => {
  const diff = deepDiff(DEFAULT_SETTINGS, useSettings.getState().settings) ?? {};
  ipc.settingsWrite(diff).catch((e) => console.error("saving settings failed", e));
}, 400);

/**
 * Deep merge that keeps the base value wherever `over` has a different type (an
 * object where a list belongs, text for a number…): settings.json is meant to be
 * edited by hand, and one bad value would otherwise break the app on every start.
 */
export function mergeChecked(base: unknown, over: unknown): unknown {
  if (isPlainObject(base)) {
    if (!isPlainObject(over)) return base;
    const out: Record<string, unknown> = { ...base };
    for (const [k, v] of Object.entries(over)) out[k] = k in base ? mergeChecked(base[k], v) : structuredClone(v);
    return out;
  }
  // nullable settings (accent color, background) hold text or an object
  if (base === null || base === undefined) return over === null || typeof over === "string" || isPlainObject(over) ? structuredClone(over) : base;
  if (Array.isArray(base)) return Array.isArray(over) ? structuredClone(over) : base;
  return typeof over === typeof base && (typeof over !== "number" || Number.isFinite(over)) ? over : base;
}

/**
 * mergeChecked can't type-check the open-ended maps (their keys aren't in the
 * defaults): drop entries of the wrong shape, e.g. a numeric keybinding would crash
 * every pane header.
 */
export function cleanMaps(s: Settings): Settings {
  const keep = <T,>(rec: unknown, ok: (v: unknown) => v is T): Record<string, T> =>
    isPlainObject(rec) ? (Object.fromEntries(Object.entries(rec).filter(([, v]) => ok(v))) as Record<string, T>) : {};
  s.keybindings = keep(s.keybindings, (v): v is string => typeof v === "string");
  s.plugins.grants = keep(s.plugins.grants, (v): v is string[] => Array.isArray(v) && v.every((p) => typeof p === "string"));
  s.profiles.overrides = keep(s.profiles.overrides, isPlainObject);
  s.profiles.custom = s.profiles.custom.filter((p) => isPlainObject(p) && typeof p.id === "string" && typeof p.command === "string");
  return s;
}

async function reload() {
  const raw = await ipc.settingsRead();
  useSettings.setState({ settings: cleanMaps(structuredClone(mergeChecked(DEFAULT_SETTINGS, raw)) as Settings), loaded: true });
}

export async function loadSettings() {
  await reload();
  const me = getCurrentWindow().label;
  // payload = label of the window that saved (null when edited outside the app)
  await listen<string | null>("config://settings", (e) => {
    if (e.payload !== me) reload().catch(console.error);
  });
}

export function settings(): Settings {
  return useSettings.getState().settings;
}

export function updateSettings(fn: (s: Settings) => void) {
  const next = structuredClone(useSettings.getState().settings);
  fn(next);
  useSettings.setState({ settings: next });
  save();
}

export function setSetting(path: string, value: unknown) {
  useSettings.setState({ settings: setPath(useSettings.getState().settings, path, value) });
  save();
}

export function resetSettings(section?: keyof Settings) {
  updateSettings((s) => {
    if (section) (s as any)[section] = structuredClone(DEFAULT_SETTINGS[section]);
    else Object.assign(s, structuredClone(DEFAULT_SETTINGS));
  });
}

export function flushSettings() {
  save.flush();
}

/** Write settings.json now and wait for it (before the app restarts). */
export async function saveSettingsNow() {
  const diff = deepDiff(DEFAULT_SETTINGS, useSettings.getState().settings) ?? {};
  await ipc.settingsWrite(diff);
}
