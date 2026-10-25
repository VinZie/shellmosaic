import { useDrag } from "../lib/dnd";
import { Icon } from "../lib/icons";
import { cx } from "../lib/util";
import { useUi } from "../state/ui";

export function Toasts() {
  const toasts = useUi((s) => s.toasts);
  return (
    <div className="toasts">
      {toasts.map((t) => (
        <div key={t.id} className={cx("toast", `toast-${t.kind}`)}>
          <Icon name={t.kind === "error" ? "warning" : t.kind === "success" ? "check" : t.kind === "warning" ? "warning" : "info"} size={15} />
          <span>{t.message}</span>
        </div>
      ))}
    </div>
  );
}

/** Ghost that follows the pointer while dragging, plus a preview of where it lands. */
export function DragLayer() {
  const { payload, label, icon, x, y, target } = useDrag();
  if (!payload) return null;
  let indicator: React.CSSProperties | null = null;
  let hint = "";
  if (target?.kind === "pane") {
    const r = target.rect;
    const z = target.zone;
    indicator =
      z === "center"
        ? { left: r.left + 4, top: r.top + 4, width: r.width - 8, height: r.height - 8 }
        : z === "left"
          ? { left: r.left, top: r.top, width: r.width / 2, height: r.height }
          : z === "right"
            ? { left: r.left + r.width / 2, top: r.top, width: r.width / 2, height: r.height }
            : z === "top"
              ? { left: r.left, top: r.top, width: r.width, height: r.height / 2 }
              : { left: r.left, top: r.top + r.height / 2, width: r.width, height: r.height / 2 };
    hint = z === "center" ? "Swap" : `Split ${z}`;
  } else if (target?.kind === "outer") {
    const r = target.rect;
    const s = target.side;
    const t = 0.3;
    indicator =
      s === "left"
        ? { left: r.left, top: r.top, width: r.width * t, height: r.height }
        : s === "right"
          ? { left: r.right - r.width * t, top: r.top, width: r.width * t, height: r.height }
          : s === "top"
            ? { left: r.left, top: r.top, width: r.width, height: r.height * t }
            : { left: r.left, top: r.bottom - r.height * t, width: r.width, height: r.height * t };
    hint = `Full ${s === "left" || s === "right" ? "height" : "width"}`;
  } else if (target?.kind === "workspace") {
    hint = payload.kind === "workspace" ? "Reorder" : payload.kind === "tab" ? "Move tab here" : payload.kind === "pane" ? "Move to new tab here" : "Open here";
  } else if (target?.kind === "tab") {
    hint = payload.kind === "tab" ? "Reorder" : payload.kind === "pane" ? "Move into this tab" : "Add to this tab";
  } else if (target?.kind === "tabbar") {
    hint = payload.kind === "tab" ? "Move to end" : "New tab";
  }
  return (
    <div className="drag-layer">
      {indicator && <div className={cx("drop-indicator", target?.kind === "outer" && "outer")} style={indicator} />}
      <div className="drag-ghost" style={{ left: x + 14, top: y + 10 }}>
        <Icon name={icon} size={14} />
        <span>{label}</span>
        {hint && <em>{hint}</em>}
      </div>
    </div>
  );
}
