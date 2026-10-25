import { beginDrag, useDrag } from "../lib/dnd";
import { Icon } from "../lib/icons";
import { cx, luminance, withAlpha } from "../lib/util";
import * as A from "../state/actions";
import { shortcutLabel } from "../state/commands";
import { leaves } from "../state/layout";
import { workspaceMenu } from "../state/menus";
import { windowOfWorkspace } from "../state/model";
import { useModel } from "../state/store";
import { ui, useUi } from "../state/ui";

function RailItem({ wsId, index }: { wsId: string; index: number }) {
  const ws = useModel((s) => s.model.workspaces[wsId]);
  const label = useModel((s) => s.label);
  const owner = useModel((s) => windowOfWorkspace(s.model, wsId));
  const paneIds = useModel((s) =>
    (s.model.workspaces[wsId]?.tabs ?? []).flatMap((t) => leaves(s.model.tabs[t]?.root ?? null)).join(","),
  );
  const alert = useUi((s) => paneIds.split(",").some((p) => s.badges[p] === "bell" || s.badges[p] === "error"));
  const dragTarget = useDrag((s) => (s.target?.kind === "workspace" && s.target.wsId === wsId ? s : null));
  if (!ws) return null;
  const active = owner === label;
  const elsewhere = !!owner && owner !== label;
  const dropMode =
    dragTarget?.payload?.kind === "workspace" ? (dragTarget.target?.kind === "workspace" && dragTarget.target.before ? "before" : "after") : dragTarget ? "into" : null;
  const shortcut = index < 9 ? shortcutLabel(`workspace.goto.${index + 1}`) : "";

  return (
    <div
      className={cx("rail-item", active && "active", elsewhere && "elsewhere", dropMode && `drop-${dropMode}`)}
      data-drop="workspace"
      data-ws-id={wsId}
      style={{ "--ws-color": ws.color, "--ws-soft": withAlpha(ws.color, 0.16) } as React.CSSProperties}
      onPointerDown={(e) => beginDrag(e, { kind: "workspace", wsId }, ws.name, ws.icon)}
      onClick={() => A.switchWorkspace(wsId)}
      onDoubleClick={() => ui.openDialog({ kind: "workspace", workspaceId: wsId })}
      onContextMenu={(e) => {
        e.preventDefault();
        ui.openMenu(e, workspaceMenu(wsId));
      }}
    >
      <span className="rail-indicator" />
      <span className="rail-icon" style={{ color: luminance(ws.color) < 0.05 ? "var(--text)" : ws.color }}>
        <Icon name={ws.icon} size={20} />
      </span>
      {elsewhere && (
        <span className="rail-window" title="Open in another window">
          <Icon name="app-window" size={10} />
        </span>
      )}
      {alert && <span className="badge badge-bell rail-badge" />}
      <span className="rail-tip">
        <b>{ws.name}</b>
        <span>
          {ws.tabs.length} tab{ws.tabs.length === 1 ? "" : "s"}
          {elsewhere ? " · in another window" : ""}
          {shortcut ? ` · ${shortcut}` : ""}
        </span>
      </span>
    </div>
  );
}

export function Rail() {
  const order = useModel((s) => s.model.order);
  return (
    <nav className="rail" data-tauri-drag-region>
      <button className="rail-logo" onClick={() => ui.openPalette()} title="Shellmosaic — command palette">
        <svg viewBox="0 0 1024 1024" width="22" height="22" aria-hidden>
          <rect x="136" y="136" width="440" height="440" rx="72" fill="var(--accent)" />
          <rect x="616" y="136" width="272" height="200" rx="60" fill="#3fd39a" />
          <rect x="616" y="376" width="272" height="200" rx="60" fill="#f6b958" />
          <rect x="136" y="616" width="752" height="272" rx="72" fill="var(--text-dim)" opacity="0.55" />
        </svg>
      </button>
      <div className="rail-list">
        {order.map((id, i) => (
          <RailItem key={id} wsId={id} index={i} />
        ))}
        <button className="rail-add" onClick={() => A.newWorkspace({ edit: true })} title={`New workspace (${shortcutLabel("workspace.new")})`}>
          <Icon name="plus" size={18} />
        </button>
      </div>
      <div className="rail-spacer" data-tauri-drag-region />
      <button className="rail-btn" onClick={() => ui.openSettings()} title={`Settings (${shortcutLabel("settings.open")})`}>
        <Icon name="settings" size={18} />
      </button>
    </nav>
  );
}
