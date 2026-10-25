// Pointer-based drag and drop (HTML5 DnD would fight Tauri's OS file-drop handler).
// Drop targets are plain elements tagged with data-drop="…" and found by hit-testing.
import { create } from "zustand";
import * as A from "../state/actions";
import * as M from "../state/model";
import type { Id, Side } from "../state/model";
import { commit, getState } from "../state/store";
import { useUi } from "../state/ui";

export type DragPayload =
  | { kind: "tab"; tabId: Id }
  | { kind: "pane"; paneId: Id }
  | { kind: "module"; moduleId: string }
  | { kind: "workspace"; wsId: Id };

export type DropTarget =
  | { kind: "pane"; tabId: Id; paneId: Id; zone: Side | "center"; rect: DOMRect }
  | { kind: "outer"; tabId: Id; side: Side; rect: DOMRect }
  | { kind: "tab"; tabId: Id; before: boolean; rect: DOMRect }
  | { kind: "tabbar"; rect: DOMRect }
  | { kind: "workspace"; wsId: Id; before: boolean; rect: DOMRect };

interface DragState {
  payload: DragPayload | null;
  label: string;
  icon: string;
  x: number;
  y: number;
  target: DropTarget | null;
}

export const useDrag = create<DragState>(() => ({ payload: null, label: "", icon: "", x: 0, y: 0, target: null }));

const OUTER_BAND = 22;

function accepts(kind: string, p: DragPayload): boolean {
  switch (kind) {
    case "pane":
    case "outer":
      return p.kind === "pane" || p.kind === "module";
    case "tab":
    case "tabbar":
      return p.kind !== "workspace";
    case "workspace":
      return true;
  }
  return false;
}

function hitTest(x: number, y: number, p: DragPayload): DropTarget | null {
  for (const el of document.elementsFromPoint(x, y) as HTMLElement[]) {
    const kind = el.dataset?.drop;
    if (!kind || !accepts(kind, p)) continue;
    const r = el.getBoundingClientRect();
    if (kind === "tab-content") continue;
    if (kind === "pane") {
      // near the tab's outer edge → span the whole tab
      const content = el.closest<HTMLElement>("[data-drop-outer]");
      if (content) {
        const cr = content.getBoundingClientRect();
        const d = { left: x - cr.left, right: cr.right - x, top: y - cr.top, bottom: cr.bottom - y };
        const [side, dist] = Object.entries(d).sort((a, b) => a[1] - b[1])[0] as [Side, number];
        if (dist < OUTER_BAND) return { kind: "outer", tabId: content.dataset.tabId!, side, rect: cr };
      }
      const rx = (x - r.left) / r.width;
      const ry = (y - r.top) / r.height;
      let zone: Side | "center";
      if (Math.abs(rx - 0.5) < 0.2 && Math.abs(ry - 0.5) < 0.2 && p.kind === "pane") zone = "center";
      else {
        const d = { left: rx, right: 1 - rx, top: ry, bottom: 1 - ry };
        zone = (Object.entries(d).sort((a, b) => a[1] - b[1])[0][0] as Side) ?? "right";
      }
      if (p.kind === "pane" && p.paneId === el.dataset.paneId) return null;
      return { kind: "pane", tabId: el.dataset.tabId!, paneId: el.dataset.paneId!, zone, rect: r };
    }
    if (kind === "tab") {
      if (p.kind === "tab" && p.tabId === el.dataset.tabId) return null;
      return { kind: "tab", tabId: el.dataset.tabId!, before: x < r.left + r.width / 2, rect: r };
    }
    if (kind === "tabbar") return { kind: "tabbar", rect: r };
    if (kind === "workspace") {
      if (p.kind === "workspace" && p.wsId === el.dataset.wsId) return null;
      return { kind: "workspace", wsId: el.dataset.wsId!, before: y < r.top + r.height / 2, rect: r };
    }
  }
  return null;
}

/** Begin tracking a possible drag from a pointerdown. Clicks (no movement) pass through. */
export function beginDrag(e: React.PointerEvent | PointerEvent, payload: DragPayload, label: string, icon: string) {
  if (e.button !== 0) return;
  const startX = e.clientX;
  const startY = e.clientY;
  let active = false;

  const move = (ev: PointerEvent) => {
    if (!active) {
      if (Math.hypot(ev.clientX - startX, ev.clientY - startY) < 6) return;
      active = true;
      document.body.classList.add("dragging");
      useUi.setState({ dragging: true });
    }
    useDrag.setState({ payload, label, icon, x: ev.clientX, y: ev.clientY, target: hitTest(ev.clientX, ev.clientY, payload) });
  };
  const end = (ev: PointerEvent) => {
    cleanup();
    if (!active) return;
    const target = hitTest(ev.clientX, ev.clientY, payload);
    // a click after a drag must not activate whatever is under the pointer
    window.addEventListener("click", swallow, { capture: true, once: true });
    setTimeout(() => window.removeEventListener("click", swallow, { capture: true }), 50);
    if (target) performDrop(payload, target);
  };
  const key = (ev: KeyboardEvent) => {
    if (ev.key === "Escape") cleanup();
  };
  const swallow = (ev: Event) => {
    ev.stopPropagation();
    ev.preventDefault();
  };
  const cleanup = () => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", end);
    window.removeEventListener("keydown", key, true);
    document.body.classList.remove("dragging");
    useDrag.setState({ payload: null, target: null });
    useUi.setState({ dragging: false });
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", end);
  window.addEventListener("keydown", key, true);
}

function performDrop(p: DragPayload, t: DropTarget) {
  const m = getState().model;
  switch (p.kind) {
    case "tab": {
      if (t.kind === "workspace") return A.moveTabToWorkspace(p.tabId, t.wsId);
      if (t.kind === "tab") {
        const ws = M.workspaceOfTab(m, t.tabId);
        if (!ws) return;
        const without = ws.tabs.filter((x) => x !== p.tabId);
        const idx = without.indexOf(t.tabId) + (t.before ? 0 : 1);
        return commit((d) => M.moveTab(d, p.tabId, ws.id, idx));
      }
      if (t.kind === "tabbar") {
        const ws = M.workspaceOfTab(m, p.tabId);
        return ws && commit((d) => M.reorderTab(d, p.tabId, ws.tabs.length));
      }
      return;
    }
    case "pane": {
      if (t.kind === "pane") return commit((d) => M.movePane(d, p.paneId, { tab: t.tabId, target: t.paneId, side: t.zone }));
      if (t.kind === "outer") return commit((d) => M.movePane(d, p.paneId, { tab: t.tabId, side: t.side, outer: true }));
      if (t.kind === "tab") return A.movePaneToTab(p.paneId, t.tabId);
      if (t.kind === "tabbar") return A.movePaneToNewTab(p.paneId);
      if (t.kind === "workspace") return A.movePaneToNewTab(p.paneId, t.wsId);
      return;
    }
    case "module": {
      if (t.kind === "pane") {
        const side = t.zone === "center" ? "right" : t.zone;
        return A.addModule(p.moduleId, { tabId: t.tabId, target: t.paneId, side });
      }
      if (t.kind === "outer") return A.addModule(p.moduleId, { tabId: t.tabId, side: t.side, outer: true });
      if (t.kind === "tab") return A.addModule(p.moduleId, { tabId: t.tabId });
      if (t.kind === "tabbar") return A.newTab(p.moduleId);
      if (t.kind === "workspace") return A.newTab(p.moduleId, {}, t.wsId);
      return;
    }
    case "workspace": {
      if (t.kind !== "workspace") return;
      const without = m.order.filter((x) => x !== p.wsId);
      const idx = without.indexOf(t.wsId) + (t.before ? 0 : 1);
      return commit((d) => M.reorderWorkspace(d, p.wsId, idx));
    }
  }
}
