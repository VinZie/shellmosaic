import { convertFileSrc } from "@tauri-apps/api/core";
import { Component, Fragment, useRef, type CSSProperties, type ReactNode } from "react";
import { beginDrag } from "../lib/dnd";
import { Icon } from "../lib/icons";
import { basename, cx } from "../lib/util";
import { useModules } from "../modules/registry";
import * as A from "../state/actions";
import { shortcutLabel } from "../state/commands";
import { leaves, setSizes, type LayoutNode } from "../state/layout";
import { paneMenu } from "../state/menus";
import { setTabRoot, type Background } from "../state/model";
import { useSettings } from "../state/settings";
import { commit, useCurrentWorkspace, useModel } from "../state/store";
import { ui, useUi } from "../state/ui";

export function BackgroundLayer({ bg, className }: { bg?: Background | null; className?: string }) {
  if (!bg) return null;
  const style: CSSProperties = { opacity: bg.opacity, filter: bg.blur ? `blur(${bg.blur}px)` : undefined };
  if (bg.kind === "image") {
    // served by name only from the backgrounds folder (smbg protocol), never by path
    style.backgroundImage = `url("${convertFileSrc(basename(bg.value), "smbg")}")`;
    style.backgroundSize = bg.fit === "tile" ? "auto" : bg.fit ?? "cover";
    style.backgroundRepeat = bg.fit === "tile" ? "repeat" : "no-repeat";
    style.backgroundPosition = "center";
  } else {
    style.background = bg.value;
  }
  return <div className={cx("bg-layer", className)} style={style} />;
}

/**
 * A crashing module only takes down its own pane, never the whole app (also used
 * around the settings screen and the app itself, with their own `fallback`).
 */
export class ErrorBoundary extends Component<
  { children: ReactNode; name: string; fallback?: (error: Error, retry: () => void) => ReactNode },
  { error: Error | null; attempt: number }
> {
  state = { error: null as Error | null, attempt: 0 };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  componentDidCatch(error: Error) {
    console.error(`"${this.props.name}" crashed`, error);
  }
  retry = () => this.setState((s) => ({ error: null, attempt: s.attempt + 1 }));
  render() {
    if (!this.state.error) return <Fragment key={this.state.attempt}>{this.props.children}</Fragment>;
    if (this.props.fallback) return this.props.fallback(this.state.error, this.retry);
    return (
      <div className="empty-state">
        <Icon name="warning" size={26} />
        <h2 style={{ fontSize: 14 }}>{this.props.name} stopped working</h2>
        <p className="dim selectable" style={{ maxWidth: 420 }}>{this.state.error.message}</p>
        <button className="btn" onClick={this.retry}>
          <Icon name="rotate-cw" size={14} /> Reload pane
        </button>
      </div>
    );
  }
}

function Resizer({ split, index, containerRef }: { split: Extract<LayoutNode, { kind: "split" }>; index: number; containerRef: React.RefObject<HTMLDivElement | null> }) {
  const tabId = useRef<string | null>(null);
  const onPointerDown = (e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const container = containerRef.current;
    if (!container) return;
    tabId.current = container.closest<HTMLElement>("[data-tab-id]")?.dataset.tabId ?? null;
    const kids = [...container.children].filter((c) => c.classList.contains("split-child")) as HTMLElement[];
    const horizontal = split.dir === "row";
    const total = kids.reduce((a, k) => a + (horizontal ? k.offsetWidth : k.offsetHeight), 0);
    // start from what's on screen: a pane held at its CSS min size has a smaller stored fraction,
    // which would make the drag jump and could push its neighbour's size below zero
    const sizes = kids.map((k) => (horizontal ? k.offsetWidth : k.offsetHeight) / total);
    kids.forEach((k, i) => (k.style.flexGrow = String(sizes[i])));
    const start = horizontal ? e.clientX : e.clientY;
    const a0 = sizes[index];
    const b0 = sizes[index + 1];
    const min = 60 / total;
    document.body.classList.add(horizontal ? "resizing-col" : "resizing-row");
    const move = (ev: PointerEvent) => {
      const delta = ((horizontal ? ev.clientX : ev.clientY) - start) / total;
      const a = Math.max(min, Math.min(a0 + b0 - min, a0 + delta));
      sizes[index] = a;
      sizes[index + 1] = a0 + b0 - a;
      kids[index].style.flexGrow = String(sizes[index]);
      kids[index + 1].style.flexGrow = String(sizes[index + 1]);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      document.body.classList.remove("resizing-col", "resizing-row");
      const id = tabId.current;
      if (id) commit((m) => m.tabs[id]?.root && setTabRoot(m, id, setSizes(m.tabs[id].root!, split.id, sizes)));
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };
  return (
    <div
      className={cx("resizer", split.dir === "row" ? "resizer-col" : "resizer-row")}
      onPointerDown={onPointerDown}
      onDoubleClick={() => {
        const id = containerRef.current?.closest<HTMLElement>("[data-tab-id]")?.dataset.tabId;
        if (id) commit((m) => m.tabs[id]?.root && setTabRoot(m, id, setSizes(m.tabs[id].root!, split.id, split.sizes.map(() => 1))));
      }}
    />
  );
}

function LayoutView({ node, tabId, visible }: { node: LayoutNode; tabId: string; visible: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  if (node.kind === "leaf") return <PaneFrame paneId={node.pane} tabId={tabId} visible={visible} />;
  return (
    <div ref={ref} className={cx("split", node.dir === "row" ? "split-row" : "split-col")}>
      {node.children.map((child, i) => (
        <Fragment key={child.kind === "leaf" ? child.pane : child.id}>
          {i > 0 && <Resizer split={node} index={i - 1} containerRef={ref} />}
          <div className="split-child" style={{ flexGrow: node.sizes[i] }}>
            <LayoutView node={child} tabId={tabId} visible={visible} />
          </div>
        </Fragment>
      ))}
    </div>
  );
}

function PaneFrame({ paneId, tabId, visible }: { paneId: string; tabId: string; visible: boolean }) {
  const pane = useModel((s) => s.model.panes[paneId]);
  const focused = useModel((s) => s.model.tabs[tabId]?.focused === paneId);
  const zoomed = useModel((s) => s.model.tabs[tabId]?.zoomed === paneId);
  const multi = useModel((s) => leaves(s.model.tabs[tabId]?.root ?? null).length > 1);
  const def = useModules((s) => (pane ? s.modules[pane.module] : undefined));
  const rtTitle = useUi((s) => s.titles[paneId]);
  const cwd = useUi((s) => s.cwds[paneId]);
  const badge = useUi((s) => s.badges[paneId]);
  const headers = useSettings((s) => s.settings.appearance.paneHeaders);
  if (!pane) return null;

  const Cmp = def?.component;
  const title = pane.title || (def?.title ? def.title(pane, { cwd, title: rtTitle }) : def?.name ?? pane.module);
  const headerMode = pane.module === "terminal" ? headers : "always";
  const Actions = def?.headerActions;

  const openMenu = async (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    ui.openMenu(e, paneMenu(paneId));
  };

  return (
    <div
      className={cx("pane", focused && multi && "focused", zoomed && "zoomed", `headers-${headerMode}`, badge && `has-${badge}`)}
      data-pane-id={paneId}
      onPointerDownCapture={() => {
        if (!focused) A.focusPane(paneId);
        else if (pane.module === "terminal") ui.setLastTerminal(tabId, paneId);
        if (badge) ui.setBadge(paneId, null);
      }}
    >
      {headerMode !== "never" && (
        <div
          className="pane-header"
          onPointerDown={(e) => {
            if ((e.target as HTMLElement).closest("button,input,select")) return;
            beginDrag(e, { kind: "pane", paneId }, title, def?.icon ?? "square");
          }}
          onDoubleClick={(e) => {
            if (!(e.target as HTMLElement).closest("button,input,select") && multi) A.toggleZoom(tabId, paneId);
          }}
          onContextMenu={openMenu}
        >
          <Icon name={def?.icon ?? "square"} size={13} className="pane-icon" />
          <span className="pane-title" title={title}>
            {title}
          </span>
          {badge && <span className={cx("badge", `badge-${badge}`)} />}
          <div className="pane-actions">
            {Actions && <Actions pane={pane} tabId={tabId} visible={visible} focused={focused} />}
            <button className="icon-btn" title={`Split right (${shortcutLabel("pane.splitRight")})`} onClick={() => A.splitPane(paneId, "right")}>
              <Icon name="columns-2" size={13} />
            </button>
            <button className="icon-btn" title={`Split down (${shortcutLabel("pane.splitDown")})`} onClick={() => A.splitPane(paneId, "bottom")}>
              <Icon name="rows-2" size={13} />
            </button>
            {multi && (
              <button className="icon-btn" title={`${zoomed ? "Restore" : "Magnify"} (${shortcutLabel("pane.zoom")})`} onClick={() => A.toggleZoom(tabId, paneId)}>
                <Icon name={zoomed ? "minimize" : "maximize"} size={13} />
              </button>
            )}
            <button className="icon-btn" title="More" onClick={openMenu}>
              <Icon name="ellipsis" size={14} />
            </button>
            <button className="icon-btn close" title={`Close pane (${shortcutLabel("pane.close")})`} onClick={() => A.closePane(paneId)}>
              <Icon name="x" size={14} />
            </button>
          </div>
        </div>
      )}
      <div className="pane-body" data-drop="pane" data-pane-id={paneId} data-tab-id={tabId}>
        {Cmp ? (
          <ErrorBoundary name={def?.name ?? pane.module}>
            <Cmp pane={pane} tabId={tabId} visible={visible} focused={focused} />
          </ErrorBoundary>
        ) : (
          <div className="empty-state">
            <Icon name="puzzle" size={28} />
            <p>
              Module <code>{pane.module}</code> isn't available.
            </p>
            <p className="dim">If it's a plugin, it may have been removed or disabled.</p>
            <button className="btn" onClick={() => A.changeModule(paneId, "terminal")}>
              Turn into a terminal
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function TabContent({ tabId, active }: { tabId: string; active: boolean }) {
  const tab = useModel((s) => s.model.tabs[tabId]);
  const zoomStyle = useSettings((s) => s.settings.appearance.zoomStyle);
  if (!tab) return null;
  return (
    <div
      className={cx("tab-content", active && "active", tab.zoomed && `has-zoom zoom-${zoomStyle}`)}
      data-tab-id={tabId}
      data-drop-outer
      aria-hidden={!active}
    >
      <BackgroundLayer bg={tab.background} />
      {tab.root ? (
        <LayoutView node={tab.root} tabId={tabId} visible={active} />
      ) : (
        <EmptyWorkspace />
      )}
      {tab.zoomed && <div className="zoom-scrim" onClick={() => A.toggleZoom(tabId)} />}
    </div>
  );
}

function EmptyWorkspace() {
  return (
    <div className="empty-state big">
      <Icon name="layout-grid" size={36} />
      <h2>Nothing open here</h2>
      <p className="dim">Start a shell, or add any module from the bar on the right.</p>
      <div className="row">
        <button className="btn primary" onClick={() => A.newTab()}>
          <Icon name="terminal" size={15} /> New terminal <kbd>{shortcutLabel("tab.new")}</kbd>
        </button>
        <button className="btn" onClick={() => ui.openPalette("modules")}>
          <Icon name="layout-grid" size={15} /> Add module <kbd>{shortcutLabel("palette.modules")}</kbd>
        </button>
      </div>
    </div>
  );
}

export function WorkspaceView() {
  const ws = useCurrentWorkspace();
  if (!ws) return <div className="workspace" />;
  return (
    <div className="workspace">
      <BackgroundLayer bg={ws.background} />
      {ws.tabs.length === 0 && <EmptyWorkspace />}
      {ws.tabs.map((t) => (
        <TabContent key={t} tabId={t} active={t === ws.activeTab} />
      ))}
    </div>
  );
}
