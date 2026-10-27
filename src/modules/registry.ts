// Module registry: built-in modules register at startup, plugins register when
// discovered. A pane's `module` field is a key into this registry.
import type { ComponentType } from "react";
import { create } from "zustand";
import type { Id, Pane } from "../state/model";
import type { MenuItem } from "../state/ui";

export interface ModuleProps {
  pane: Pane;
  tabId: Id;
  /** the pane is on screen (its tab is active in this window) */
  visible: boolean;
  focused: boolean;
}

export interface ModuleDef {
  id: string;
  name: string;
  icon: string;
  description: string;
  component: ComponentType<ModuleProps>;
  /** initial pane meta; `cwd` is the focused terminal's directory when known */
  defaultMeta?: (ctx: { cwd?: string }) => Record<string, any>;
  /** text in the pane header */
  title?: (pane: Pane, rt: { cwd?: string; title?: string }) => string;
  /** module-specific entries for the pane's context menu */
  menu?: (pane: Pane, tabId: Id) => MenuItem[];
  /** extra buttons rendered in the pane header */
  headerActions?: ComponentType<ModuleProps>;
  /** free resources when the pane is closed for good */
  onRemove?: (paneId: Id, pane: Pane) => void;
  /** set for plugin modules */
  plugin?: { id: string; permissions: string[]; entry: string };
  /** never offered to add (Orchestrator agent panes: only the Orchestrator creates them) */
  hidden?: boolean;
}

interface Registry {
  modules: Record<string, ModuleDef>;
}

export const useModules = create<Registry>(() => ({ modules: {} }));

export function registerModule(def: ModuleDef) {
  useModules.setState((s) => ({ modules: { ...s.modules, [def.id]: def } }));
}

export function replacePluginModules(defs: ModuleDef[]) {
  useModules.setState((s) => {
    const modules = Object.fromEntries(Object.entries(s.modules).filter(([, d]) => !d.plugin));
    defs.forEach((d) => (modules[d.id] = d));
    return { modules };
  });
}

export function getModule(id: string): ModuleDef | undefined {
  return useModules.getState().modules[id];
}

/** The modules a user can add (hidden ones left out). */
export function allModules(): ModuleDef[] {
  return Object.values(useModules.getState().modules).filter((m) => !m.hidden);
}
