// Non-visual helpers shared by the settings sections.
import { openPath } from "@tauri-apps/plugin-opener";
import { useEffect, useState } from "react";
import { errorText, ipc } from "../../lib/ipc";
import { joinPath } from "../../lib/util";
import { completeTheme, useThemes } from "../../state/themes";
import { ui } from "../../state/ui";

let dataDirPromise: Promise<string> | null = null;

/** The app's data folder (settings.json, themes, plugins…), cached. */
export function getDataDir(): Promise<string> {
  dataDirPromise ??= ipc.dataDir().catch((e) => {
    dataDirPromise = null;
    throw e;
  });
  return dataDirPromise;
}

export function useDataDir(): string | null {
  const [dir, setDir] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    getDataDir()
      .then((d) => alive && setDir(d))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);
  return dir;
}

export async function dataPath(...parts: string[]): Promise<string> {
  let p = await getDataDir();
  for (const part of parts) p = joinPath(p, part);
  return p;
}

/** Open a file or folder inside the data folder with the system default app (Explorer for folders). */
export async function openInDataDir(...parts: string[]) {
  try {
    await openPath(await dataPath(...parts));
  } catch (e) {
    ui.toast(errorText(e), "error");
  }
}

/** Run an async action, turning failures into an error toast. */
export async function attempt<T>(fn: () => Promise<T>): Promise<T | undefined> {
  try {
    return await fn();
  } catch (e) {
    ui.toast(errorText(e), "error");
    return undefined;
  }
}

/** Re-read user themes from disk (our own writes don't trigger the file watcher). */
export async function refreshThemes() {
  const list = await ipc.themesList();
  useThemes.setState({ user: list.map(completeTheme) });
}

/** File-name-safe id: lowercase letters, digits and dashes. */
export function slug(s: string, fallback = "theme"): string {
  const out = s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return out || fallback;
}

export function uniqueId(base: string, taken: Set<string>): string {
  if (!taken.has(base)) return base;
  for (let i = 2; ; i++) {
    const id = `${base}-${i}`;
    if (!taken.has(id)) return id;
  }
}

/** Split a command line into arguments. Double quotes group words (Windows style, backslashes are literal). */
export function parseArgs(s: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  let has = false;
  for (const ch of s) {
    if (ch === '"') {
      quoted = !quoted;
      has = true;
    } else if (!quoted && /\s/.test(ch)) {
      if (has) out.push(cur);
      cur = "";
      has = false;
    } else {
      cur += ch;
      has = true;
    }
  }
  if (has) out.push(cur);
  return out;
}

export function formatArgs(args: string[] | undefined | null): string {
  return (args ?? []).map((a) => (a === "" ? '""' : /\s/.test(a) ? `"${a}"` : a)).join(" ");
}

/** KEY=VALUE per line; blank lines and lines starting with # are ignored. */
export function parseEnv(s: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const raw of s.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const i = line.indexOf("=");
    if (i <= 0) continue;
    env[line.slice(0, i).trim()] = line.slice(i + 1);
  }
  return env;
}

export function formatEnv(env: Record<string, string> | undefined | null): string {
  return Object.entries(env ?? {})
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");
}

export function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Current value of a theme CSS variable (e.g. "--accent"). */
export function cssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

/** Guess the shell kind from a program path, for shell integration. */
export function guessKind(command: string): string {
  const c = command.toLowerCase();
  if (/pwsh(\.exe)?$/.test(c)) return "pwsh";
  if (/powershell(\.exe)?$/.test(c)) return "powershell";
  if (/(^|[\\/])cmd(\.exe)?$/.test(c)) return "cmd";
  if (/wsl(\.exe)?$/.test(c)) return "wsl";
  if (/(bash|sh|zsh|fish)(\.exe)?$/.test(c)) return "bash";
  return "custom";
}
