// Small building blocks that look like the app's own modules (styles in ui.css).
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Copy, LoaderCircle, Search, ShieldAlert, X } from "lucide-react";
import type { PaneContext } from "./api";
import { copy, errorText, sm } from "./sdk";

export function cx(...parts: unknown[]): string {
  return parts.filter((p) => typeof p === "string" && p).join(" ");
}

export function Toolbar({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cx("sm-toolbar", className)}>{children}</div>;
}

export const Grow = () => <div className="sm-grow" />;
export const Sep = () => <div className="sm-toolbar-sep" />;

export function IconButton({
  title,
  onClick,
  on,
  disabled,
  danger,
  children,
}: {
  title: string;
  onClick?: (e: React.MouseEvent<HTMLButtonElement>) => void;
  on?: boolean;
  disabled?: boolean;
  danger?: boolean;
  children: ReactNode;
}) {
  return (
    <button type="button" className={cx("sm-icon-btn", on && "on", danger && "danger")} title={title} aria-label={title} aria-pressed={on} disabled={disabled} onClick={onClick}>
      {children}
    </button>
  );
}

export function Button({
  children,
  onClick,
  kind,
  small,
  disabled,
  title,
  type = "button",
}: {
  children: ReactNode;
  onClick?: (e: React.MouseEvent<HTMLButtonElement>) => void;
  kind?: "primary" | "danger" | "subtle";
  small?: boolean;
  disabled?: boolean;
  title?: string;
  type?: "button" | "submit";
}) {
  return (
    <button type={type} className={cx("sm-btn", kind, small && "small")} disabled={disabled} title={title} onClick={onClick}>
      {children}
    </button>
  );
}

export function SearchBox({
  value,
  onChange,
  placeholder = "Filter",
  width,
  autoFocus,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  width?: number | string;
  autoFocus?: boolean;
}) {
  return (
    <div className="sm-search" style={width !== undefined ? { width } : undefined}>
      <Search size={13} />
      <input value={value} placeholder={placeholder} spellCheck={false} autoFocus={autoFocus} onChange={(e) => onChange(e.target.value)} onKeyDown={(e) => e.key === "Escape" && value && (e.stopPropagation(), onChange(""))} />
      {value && (
        <button type="button" className="sm-search-clear" title="Clear" onClick={() => onChange("")}>
          <X size={12} />
        </button>
      )}
    </div>
  );
}

export function Select<T extends string>({
  value,
  onChange,
  options,
  title,
}: {
  value: T;
  onChange: (v: T) => void;
  options: { value: T; label: string }[];
  title?: string;
}) {
  return (
    <select className="sm-input sm-select" value={value} title={title} onChange={(e) => onChange(e.target.value as T)}>
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

export function Switch({ value, onChange, title, disabled }: { value: boolean; onChange: (v: boolean) => void; title?: string; disabled?: boolean }) {
  return <button type="button" role="switch" aria-checked={value} title={title} disabled={disabled} className={cx("sm-switch", value && "on")} onClick={() => onChange(!value)} />;
}

export type Tone = "accent" | "danger" | "warning" | "success" | "dim";

export function Chip({ children, tone, title, icon }: { children: ReactNode; tone?: Tone; title?: string; icon?: ReactNode }) {
  return (
    <span className={cx("sm-chip", tone)} title={title}>
      {icon}
      {children}
    </span>
  );
}

export interface TabItem {
  id: string;
  label: string;
  icon?: ReactNode;
  /** small count after the label */
  badge?: ReactNode;
}

export function Tabs({ items, active, onChange, right }: { items: TabItem[]; active: string; onChange: (id: string) => void; right?: ReactNode }) {
  return (
    <div className="sm-tabs" role="tablist">
      {items.map((t) => (
        <button key={t.id} type="button" role="tab" aria-selected={t.id === active} className={cx("sm-tab", t.id === active && "active")} onClick={() => onChange(t.id)}>
          {t.icon}
          <span>{t.label}</span>
          {t.badge !== undefined && t.badge !== null && <span className="sm-tab-badge">{t.badge}</span>}
        </button>
      ))}
      {right && (
        <>
          <div className="sm-grow" />
          {right}
        </>
      )}
    </div>
  );
}

/** Centered empty / error / loading state. */
export function Message({ icon, title, children, actions, tone }: { icon?: ReactNode; title: string; children?: ReactNode; actions?: ReactNode; tone?: "danger" | "warning" }) {
  return (
    <div className={cx("sm-message", tone)}>
      {icon && <div className="sm-message-icon">{icon}</div>}
      <h2>{title}</h2>
      {children && <div className="sm-message-body">{children}</div>}
      {actions && <div className="sm-row sm-message-actions">{actions}</div>}
    </div>
  );
}

export function Loading({ label = "Loading…" }: { label?: string }) {
  return <Message icon={<LoaderCircle size={22} className="sm-spin" />} title={label} />;
}

/** A strip above content: a warning, an error, a notice. */
export function Banner({ tone = "warning", icon, children, actions, onClose }: { tone?: "warning" | "danger" | "info" | "success"; icon?: ReactNode; children: ReactNode; actions?: ReactNode; onClose?: () => void }) {
  return (
    <div className={cx("sm-banner", tone)} role="status">
      {icon}
      <div className="sm-grow sm-banner-text">{children}</div>
      {actions}
      {onClose && (
        <button type="button" className="sm-icon-btn" title="Dismiss" onClick={onClose}>
          <X size={13} />
        </button>
      )}
    </div>
  );
}

/**
 * "Some of this needs administrator rights" with a Restart-as-administrator button.
 * Renders nothing when Shellmosaic already runs elevated.
 */
export function AdminBanner({ ctx, children, onClose }: { ctx: PaneContext | null; children?: ReactNode; onClose?: () => void }) {
  const [busy, setBusy] = useState(false);
  if (!ctx || ctx.elevated) return null;
  return (
    <Banner
      tone="warning"
      icon={<ShieldAlert size={15} />}
      onClose={onClose}
      actions={
        <Button
          small
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              await sm.app.restartAsAdmin();
            } catch (e) {
              sm.ui.notify(errorText(e), "error");
            } finally {
              setBusy(false);
            }
          }}
        >
          Restart as administrator
        </Button>
      }
    >
      {children ?? "Some details need administrator rights."}
    </Banner>
  );
}

export interface KV {
  label: string;
  value: ReactNode;
  /** copied by the copy button; defaults to the value when it's a string */
  copyText?: string | null;
  mono?: boolean;
  title?: string;
  /** dim the row (e.g. "unavailable") */
  muted?: boolean;
}

/** Label/value rows with a copy button on hover. */
export function KeyValues({ rows, labelWidth = 150 }: { rows: (KV | null | false | undefined)[]; labelWidth?: number }) {
  return (
    <div className="sm-kv" style={{ gridTemplateColumns: `${labelWidth}px minmax(0, 1fr)` }}>
      {rows.filter((r): r is KV => !!r).map((r) => {
        const text = r.copyText !== undefined ? r.copyText : typeof r.value === "string" || typeof r.value === "number" ? String(r.value) : null;
        return (
          <div key={r.label} className={cx("sm-kv-row", r.muted && "muted")}>
            <div className="sm-kv-label">{r.label}</div>
            <div className={cx("sm-kv-value", r.mono && "mono")} title={r.title}>
              <span className="sm-kv-text">{r.value}</span>
              {text && (
                <button type="button" className="sm-icon-btn sm-kv-copy" title={`Copy ${r.label.toLowerCase()}`} onClick={() => copy(text, r.label.toLowerCase())}>
                  <Copy size={12} />
                </button>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

/** A titled block with optional actions on the right. */
export function Section({ title, actions, children, className }: { title: ReactNode; actions?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={cx("sm-section", className)}>
      <div className="sm-section-head">
        <h3>{title}</h3>
        <div className="sm-grow" />
        {actions}
      </div>
      {children}
    </section>
  );
}

/**
 * Two panes with a draggable divider. `size` is the first pane's size in px (or the
 * second's when `sizeOf` is "second"), kept by the caller (e.g. in useStored).
 */
export function Split({
  direction = "horizontal",
  size,
  onSize,
  min = 120,
  sizeOf = "first",
  first,
  second,
  collapsed,
}: {
  direction?: "horizontal" | "vertical";
  size: number;
  onSize: (px: number) => void;
  min?: number;
  sizeOf?: "first" | "second";
  first: ReactNode;
  second: ReactNode;
  /** hide the sized pane */
  collapsed?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const horizontal = direction === "horizontal";
  const start = (e: React.PointerEvent) => {
    e.preventDefault();
    const box = ref.current?.getBoundingClientRect();
    if (!box) return;
    const target = e.currentTarget as HTMLElement;
    target.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => {
      const total = horizontal ? box.width : box.height;
      const pos = horizontal ? ev.clientX - box.left : ev.clientY - box.top;
      const px = sizeOf === "first" ? pos : total - pos;
      onSize(Math.round(Math.max(min, Math.min(total - min, px))));
    };
    const up = () => {
      target.removeEventListener("pointermove", move);
      target.removeEventListener("pointerup", up);
    };
    target.addEventListener("pointermove", move);
    target.addEventListener("pointerup", up);
  };
  const sized = { flex: `0 0 ${size}px` };
  return (
    <div ref={ref} className={cx("sm-split", horizontal ? "h" : "v")}>
      <div className="sm-split-pane" style={sizeOf === "first" ? (collapsed ? { display: "none" } : sized) : undefined}>
        {first}
      </div>
      {!collapsed && <div className="sm-split-handle" onPointerDown={start} />}
      <div className="sm-split-pane" style={sizeOf === "second" ? (collapsed ? { display: "none" } : sized) : undefined}>
        {second}
      </div>
    </div>
  );
}

/** A panel anchored under a button; closes on outside click or Esc. */
export function Popover({ anchor, onClose, children, width = 280, align = "right" }: { anchor: HTMLElement | null; onClose: () => void; children: ReactNode; width?: number; align?: "left" | "right" }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  useEffect(() => {
    if (!anchor) return;
    const r = anchor.getBoundingClientRect();
    const left = align === "right" ? r.right - width : r.left;
    setPos({ top: r.bottom + 4, left: Math.max(4, Math.min(left, window.innerWidth - width - 4)) });
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!ref.current?.contains(t) && !anchor.contains(t)) onClose();
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("mousedown", onDown, true);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown, true);
      window.removeEventListener("keydown", onKey);
    };
  }, [anchor, onClose, width, align]);
  if (!anchor || !pos) return null;
  return (
    <div ref={ref} className="sm-popover" style={{ top: pos.top, left: pos.left, width, maxHeight: `calc(100vh - ${pos.top + 8}px)` }}>
      {children}
    </div>
  );
}

/** Footer status line under a module's content. */
export function Footer({ children }: { children: ReactNode }) {
  return <div className="sm-footer">{children}</div>;
}
