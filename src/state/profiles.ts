// Shell profiles: auto-detected (PowerShell, cmd, Git Bash, WSL...) merged with
// the user's custom profiles, overrides and hidden list from settings.
import { create } from "zustand";
import { ipc, type Profile, type SpawnSpec } from "../lib/ipc";
import { settings, useSettings } from "./settings";

interface ProfileState {
  detected: Profile[];
}

export const useProfiles = create<ProfileState>(() => ({ detected: [] }));

export async function loadProfiles(refresh = false) {
  const detected = await ipc.shellsList(refresh);
  useProfiles.setState({ detected });
}

export function mergeProfiles(detected: Profile[], s = settings()): Profile[] {
  const custom = s.profiles.custom.map((p) => ({ ...p, custom: true }));
  const all = [...detected.map((p) => ({ ...p, ...(s.profiles.overrides[p.id] ?? {}) })), ...custom];
  return all.map((p) => ({ ...p, hidden: s.profiles.hidden.includes(p.id) }));
}

export function useAllProfiles(): Profile[] {
  const detected = useProfiles((s) => s.detected);
  const st = useSettings((s) => s.settings);
  return mergeProfiles(detected, st);
}

export function allProfiles(): Profile[] {
  return mergeProfiles(useProfiles.getState().detected);
}

export function defaultProfile(): Profile | undefined {
  const all = allProfiles();
  const want = settings().terminal.defaultProfile;
  return (want !== "auto" && all.find((p) => p.id === want)) || all.find((p) => !p.hidden) || all[0];
}

export function findProfile(id?: string | null): Profile | undefined {
  if (!id) return defaultProfile();
  return allProfiles().find((p) => p.id === id) ?? defaultProfile();
}

export function spawnSpec(profileId: string | undefined, cwd: string | undefined, restore: boolean): SpawnSpec {
  const p = findProfile(profileId);
  const s = settings();
  return {
    profileId: p?.id ?? "cmd",
    command: p?.command ?? "cmd.exe",
    args: p?.args ?? [],
    kind: p?.kind ?? "cmd",
    env: p?.env ?? {},
    cwd: cwd ?? p?.cwd ?? null,
    shellIntegration: s.terminal.shellIntegration,
    restore: restore && s.restore.scrollback,
    freshEnv: s.terminal.freshEnvironment,
  };
}
