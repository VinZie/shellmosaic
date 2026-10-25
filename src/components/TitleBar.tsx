import { getCurrentWindow } from "@tauri-apps/api/window";
import { useEffect, useRef, useState } from "react";
import { beginDrag, useDrag } from "../lib/dnd";
import { Icon } from "../lib/icons";
import { ipc } from "../lib/ipc";
import { cx } from "../lib/util";
import { getModule } from "../modules/registry";
import * as A from "../state/actions";
import { shortcutLabel } from "../state/commands";
import { leaves } from "../state/layout";
import { newTabMenu, tabMenu } from "../state/menus";
import { useSettings } from "../state/settings";
import { commit, useCurrentWorkspace, useModel } from "../state/store";
import { ui, useUi, type BadgeKind } from "../state/ui";
import * as M from "../state/model";

const BADGE_RANK: Record<BadgeKind, number> = { activity: 1, done: 2, bell: 3, error: 4 };

function useTabBadge(tabId: string): BadgeKind | null {
  const root = useModel((s) => s.model.tabs[tabId]?.root ?? null);
  return useUi((s) => {
    let best: BadgeKind | null = null;
    for (const p of leaves(root)) {
      const b = s.badges[p];
      if (b && (!best || BADGE_RANK[b] > BADGE_RANK[best])) best = b;
    }
    return best;
  });
}

function TabChip({ tabId, active }: { tabId: string; active: boolean }) {
  const tab = useModel((s) => s.model.tabs[tabId]);
  const focusedPane = useModel((s) => (tab?.focused ? s.model.panes[tab.focused] : undefined));
  // re-render when the label's inputs change (cwd/title of the focused pane)
  useUi((s) => (tab?.focused ? `${s.cwds[tab.focused] ?? ""}|${s.titles[tab.focused] ?? ""}` : ""));
  const label = useModel(() => A.tabLabel(tabId));
  const badge = useTabBadge(tabId);
  const broadcast = useUi((s) => !!s.broadcast[tabId]);
  const showIcons = useSettings((s) => s.settings.appearance.showTabIcons);
  const drop = useDrag((s) => (s.target?.kind === "tab" && s.target.tabId === tabId ? (s.target.before ? "before" : "after") : null));
  const [editing, setEditing] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing) inputRef.current?.select();
  }, [editing]);

  if (!tab) return null;
  const icon = tab.icon ?? (focusedPane ? getModule(focusedPane.module)?.icon : undefined) ?? "terminal";
  const paneCount = leaves(tab.root).length;

  const finish = (value: string | null) => {
    setEditing(false);
    if (value === null) return;
    const name = value.trim();
    commit((m) => M.updateTab(m, tabId, { name, userNamed: !!name }));
  };

  return (
    <div
      className={cx("tab", active && "active", tab.pinned && "pinned", drop && `drop-${drop}`)}
      data-drop="tab"
      data-tab-id={tabId}
      style={tab.color ? ({ "--tab-color": tab.color } as React.CSSProperties) : undefined}
      onPointerDown={(e) => {
        if (editing) return;
        beginDrag(e, { kind: "tab", tabId }, label, icon);
      }}
      onClick={() => A.switchTab(tabId)}
      onDoubleClick={() => setEditing(true)}
      onAuxClick={(e) => {
        if (e.button === 1 && !tab.pinned) A.closeTab(tabId);
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        ui.openMenu(e, tabMenu(tabId));
      }}
      title={`${label}${paneCount > 1 ? ` · ${paneCount} panes` : ""}`}
    >
      {tab.color && <span className="tab-flag" />}
      {tab.pinned ? <Icon name="pin" size={13} className="tab-icon" /> : showIcons && <Icon name={icon} size={14} className="tab-icon" />}
      {editing ? (
        <input
          ref={inputRef}
          className="tab-rename"
          defaultValue={tab.userNamed ? tab.name : label}
          onPointerDown={(e) => e.stopPropagation()}
          onKeyDown={(e) => {
            if (e.key === "Enter") finish(e.currentTarget.value);
            if (e.key === "Escape") finish(null);
            e.stopPropagation();
          }}
          onBlur={(e) => finish(e.currentTarget.value)}
        />
      ) : (
        !tab.pinned && <span className="tab-label">{label}</span>
      )}
      {paneCount > 1 && !tab.pinned && <span className="tab-count">{paneCount}</span>}
      {broadcast && <Icon name="radio" size={12} className="tab-broadcast" />}
      {badge && !active && <span className={cx("badge", `badge-${badge}`)} />}
      {!tab.pinned && (
        <button
          className="tab-close"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            A.closeTab(tabId);
          }}
          title="Close tab"
        >
          <Icon name="x" size={13} />
        </button>
      )}
    </div>
  );
}

function WindowControls() {
  const [maximized, setMaximized] = useState(false);
  useEffect(() => {
    const w = getCurrentWindow();
    w.isMaximized().then(setMaximized);
    const un = w.onResized(() => w.isMaximized().then(setMaximized));
    return () => {
      un.then((f) => f());
    };
  }, []);
  const w = getCurrentWindow();
  return (
    <div className="window-controls">
      <button onClick={() => w.minimize()} title="Minimize">
        <Icon name="minus" size={15} />
      </button>
      <button onClick={() => w.toggleMaximize()} title={maximized ? "Restore" : "Maximize"}>
        <Icon name={maximized ? "minimize" : "square"} size={maximized ? 14 : 12} />
      </button>
      <button className="close" onClick={() => w.close()} title="Close">
        <Icon name="x" size={16} />
      </button>
    </div>
  );
}

/** "Administrator" while Shellmosaic runs elevated (after Restart as administrator). */
function AdminBadge() {
  const [elevated, setElevated] = useState(false);
  useEffect(() => {
    ipc.appElevated().then(setElevated, () => {});
  }, []);
  if (!elevated) return null;
  return (
    <span className="chip titlebar-admin" title="Shellmosaic runs as administrator: shells and modules have full rights. Restart it normally to drop them." data-tauri-drag-region>
      <Icon name="shield" size={12} /> Administrator
    </span>
  );
}

export function TitleBar() {
  const ws = useCurrentWorkspace();
  const tabbarDrop = useDrag((s) => s.target?.kind === "tabbar");
  const style = useSettings((s) => s.settings.appearance.tabStyle);
  const scroller = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = scroller.current?.querySelector<HTMLElement>(".tab.active");
    el?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [ws?.activeTab]);

  return (
    <header className={cx("titlebar", `tabs-${style}`)} data-tauri-drag-region>
      {ws && (
        <div className="ws-title" data-tauri-drag-region onContextMenu={(e) => e.preventDefault()}>
          <span className="ws-dot" style={{ background: ws.color }} />
          <span className="ws-name" data-tauri-drag-region>{ws.name}</span>
        </div>
      )}
      <div
        className={cx("tabs", tabbarDrop && "drop-target")}
        data-drop="tabbar"
        ref={scroller}
        onWheel={(e) => {
          if (scroller.current && Math.abs(e.deltaY) > Math.abs(e.deltaX)) scroller.current.scrollLeft += e.deltaY;
        }}
        onDoubleClick={(e) => {
          if (e.target === e.currentTarget) A.newTab();
        }}
      >
        {ws?.tabs.map((t) => <TabChip key={t} tabId={t} active={t === ws.activeTab} />)}
        <div className="new-tab-group">
          <button
            className="icon-btn new-tab"
            onClick={() => A.newTab()}
            onContextMenu={(e) => {
              e.preventDefault();
              ui.openMenu(e, newTabMenu());
            }}
            title={`New tab (${shortcutLabel("tab.new")}) · right-click for shells & modules`}
          >
            <Icon name="plus" size={16} />
          </button>
          <button
            className="icon-btn new-tab-more"
            onClick={(e) => {
              const r = e.currentTarget.getBoundingClientRect();
              ui.openMenu({ x: r.left, y: r.bottom + 4 }, newTabMenu());
            }}
            title="Choose shell or module"
          >
            <Icon name="chevron-down" size={14} />
          </button>
        </div>
      </div>
      <div className="titlebar-spacer" data-tauri-drag-region />
      <AdminBadge />
      <button className="icon-btn titlebar-btn" onClick={() => ui.openPalette()} title={`Command palette (${shortcutLabel("palette.open")})`}>
        <Icon name="command" size={15} />
      </button>
      <WindowControls />
    </header>
  );
}
