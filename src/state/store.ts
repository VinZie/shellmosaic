// Model store: a local mirror of the backend's model with optimistic commits.
// Mutations are pure functions of a draft, so a conflicting commit (another
// window committed first) is simply re-applied on top of the newer model.
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { create } from "zustand";
import { ipc } from "../lib/ipc";
import { leaves } from "./layout";
import { emptyModel, sanitize, type Id, type Model, type Tab, type Workspace } from "./model";

interface ModelState {
  model: Model;
  version: number;
  label: string;
  ready: boolean;
}

export const useModel = create<ModelState>(() => ({
  model: emptyModel(),
  version: 0,
  label: "main",
  ready: false,
}));

type Mutation<R> = (draft: Model) => R;
type RemovedHook = (paneIds: Id[], prev: Model) => void;

let queue: Promise<unknown> = Promise.resolve();
const removedHooks: RemovedHook[] = [];

/** Called with pane ids that a local commit removed, so modules can free resources. */
export function onPanesRemoved(hook: RemovedHook) {
  removedHooks.push(hook);
}

export async function initModel(seed: (m: Model) => void): Promise<void> {
  const label = getCurrentWindow().label;
  const snap = await ipc.stateGet();
  useModel.setState({ model: sanitize(snap.model), version: snap.version, label });
  await listen<{ version: number; model: unknown; source: string }>("model://changed", (e) => {
    const { version } = useModel.getState();
    if (e.payload.source !== label && e.payload.version > version) {
      useModel.setState({ model: sanitize(e.payload.model), version: e.payload.version });
    }
  });
  // first run, or this window has no workspace yet
  await commit((m) => seed(m));
  useModel.setState({ ready: true });
}

export function commit<R>(fn: Mutation<R>): Promise<R> {
  const run = async (): Promise<R> => {
    for (let attempt = 0; attempt < 8; attempt++) {
      const { model, version, label } = useModel.getState();
      const draft = structuredClone(model);
      const result = fn(draft);
      useModel.setState({ model: draft });
      const res = await ipc.stateCommit(version, draft, label);
      if (res.status === "ok") {
        useModel.setState({ version: res.version });
        const before = new Set(Object.keys(model.panes));
        Object.keys(draft.panes).forEach((p) => before.delete(p));
        if (before.size) removedHooks.forEach((h) => h([...before], model));
        return result;
      }
      useModel.setState({ model: sanitize(res.model), version: res.version });
    }
    throw new Error("could not save changes (too many conflicts)");
  };
  const p = queue.then(run, run);
  queue = p.catch(() => undefined);
  return p;
}

// ── selectors ───────────────────────────────────────────────────────────

export const windowWorkspaceId = (s: ModelState): Id | undefined => s.model.windows[s.label]?.workspace;

export function useCurrentWorkspace(): Workspace | undefined {
  return useModel((s) => {
    const id = windowWorkspaceId(s);
    return id ? s.model.workspaces[id] : undefined;
  });
}

export function useActiveTab(): Tab | undefined {
  return useModel((s) => {
    const id = windowWorkspaceId(s);
    const ws = id ? s.model.workspaces[id] : undefined;
    return ws?.activeTab ? s.model.tabs[ws.activeTab] : undefined;
  });
}

export function getState() {
  return useModel.getState();
}

export function currentWorkspace(): Workspace | undefined {
  const s = useModel.getState();
  const id = windowWorkspaceId(s);
  return id ? s.model.workspaces[id] : undefined;
}

export function activeTab(): Tab | undefined {
  const s = useModel.getState();
  const ws = currentWorkspace();
  return ws?.activeTab ? s.model.tabs[ws.activeTab] : undefined;
}

/** Pane ids that belong to the workspace shown in this window. */
export function panesInThisWindow(): Set<Id> {
  const s = useModel.getState();
  const ws = currentWorkspace();
  const out = new Set<Id>();
  ws?.tabs.forEach((t) => leaves(s.model.tabs[t]?.root ?? null).forEach((p) => out.add(p)));
  return out;
}
