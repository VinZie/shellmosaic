// Context menus and modal dialogs drawn inside the module's own frame (a plugin
// can't use the app's). Mount <Overlays /> once; mount() in ./mount does it.
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Check, ChevronRight } from "lucide-react";
import { cx } from "./components";

export type MenuItem =
  | {
      label: string;
      icon?: ReactNode;
      onSelect?: () => void;
      danger?: boolean;
      disabled?: boolean;
      /** shows a check mark (toggles); the menu stays open when `keepOpen` */
      checked?: boolean;
      keepOpen?: boolean;
      /** right-aligned hint, e.g. a shortcut */
      hint?: string;
      submenu?: MenuItem[];
    }
  | { separator: true }
  | { header: string };

interface MenuState {
  x: number;
  y: number;
  items: MenuItem[];
}

type Listener = () => void;
const listeners = new Set<Listener>();
let menu: MenuState | null = null;
let modal: { render: (close: () => void) => ReactNode; onClose?: () => void } | null = null;
const emit = () => listeners.forEach((l) => l());

/** Open a context menu at the pointer (or below an element). */
export function openMenu(at: { clientX: number; clientY: number } | HTMLElement, items: MenuItem[]) {
  let x: number;
  let y: number;
  if (at instanceof HTMLElement) {
    const r = at.getBoundingClientRect();
    x = r.left;
    y = r.bottom + 2;
  } else {
    x = at.clientX;
    y = at.clientY;
  }
  menu = { x, y, items };
  emit();
}

export function closeMenu() {
  if (!menu) return;
  menu = null;
  emit();
}

/** Show a modal; `render` gets a `close` function. Esc and clicking outside close it. */
export function openModal(render: (close: () => void) => ReactNode, onClose?: () => void) {
  modal = { render, onClose };
  emit();
}

export function closeModal() {
  const m = modal;
  modal = null;
  emit();
  m?.onClose?.();
}

/** A modal asking for one line of text; resolves null when cancelled. */
export function prompt(opts: { title: string; label?: string; value?: string; okLabel?: string; mono?: boolean; validate?: (v: string) => string | null }): Promise<string | null> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v: string | null) => {
      if (done) return;
      done = true;
      resolve(v);
    };
    openModal(
      (close) => (
        <PromptBody
          {...opts}
          onCancel={() => {
            finish(null);
            close();
          }}
          onOk={(v) => {
            finish(v);
            close();
          }}
        />
      ),
      () => finish(null),
    );
  });
}

function PromptBody({
  title,
  label,
  value = "",
  okLabel = "OK",
  mono,
  validate,
  onOk,
  onCancel,
}: {
  title: string;
  label?: string;
  value?: string;
  okLabel?: string;
  mono?: boolean;
  validate?: (v: string) => string | null;
  onOk: (v: string) => void;
  onCancel: () => void;
}) {
  const [v, setV] = useState(value);
  const error = validate ? validate(v) : null;
  return (
    <form
      className="sm-dialog"
      onSubmit={(e) => {
        e.preventDefault();
        if (!error) onOk(v);
      }}
    >
      <h3>{title}</h3>
      {label && <label className="sm-field-label">{label}</label>}
      <input className={cx("sm-input wide", mono && "mono")} autoFocus value={v} onChange={(e) => setV(e.target.value)} spellCheck={false} />
      {error && <div className="sm-dialog-error">{error}</div>}
      <div className="sm-dialog-buttons">
        <button type="button" className="sm-btn subtle" onClick={onCancel}>
          Cancel
        </button>
        <button type="submit" className="sm-btn primary" disabled={!!error}>
          {okLabel}
        </button>
      </div>
    </form>
  );
}

function useOverlayState() {
  const [, setN] = useState(0);
  useEffect(() => {
    const l = () => setN((n) => n + 1);
    listeners.add(l);
    return () => {
      listeners.delete(l);
    };
  }, []);
}

export function Overlays() {
  useOverlayState();
  return (
    <>
      {menu && <Menu key={`${menu.x},${menu.y}`} state={menu} />}
      {modal && (
        <div className="sm-modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && closeModal()}>
          <div className="sm-modal" onKeyDown={(e) => e.key === "Escape" && (e.stopPropagation(), closeModal())}>
            {modal.render(closeModal)}
          </div>
        </div>
      )}
    </>
  );
}

function Menu({ state }: { state: MenuState }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x: state.x, y: state.y });

  // keep it inside the frame
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const x = Math.max(4, Math.min(state.x, window.innerWidth - r.width - 4));
    const y = state.y + r.height > window.innerHeight - 4 ? Math.max(4, state.y - r.height) : state.y;
    setPos({ x, y });
    el.focus();
  }, [state]);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (!(e.target as HTMLElement).closest(".sm-menu")) closeMenu();
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && closeMenu();
    const onBlur = () => closeMenu();
    window.addEventListener("mousedown", onDown, true);
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("blur", onBlur);
    window.addEventListener("resize", onBlur);
    return () => {
      window.removeEventListener("mousedown", onDown, true);
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("blur", onBlur);
      window.removeEventListener("resize", onBlur);
    };
  }, []);

  return (
    <div ref={ref} className="sm-menu" tabIndex={-1} style={{ left: pos.x, top: pos.y }} onContextMenu={(e) => e.preventDefault()}>
      <MenuItems items={state.items} />
    </div>
  );
}

/** Opens to the right of its item, or to the left when there's no room. */
function SubMenu({ items }: { items: MenuItem[] }) {
  const ref = useRef<HTMLDivElement>(null);
  const [style, setStyle] = useState<React.CSSProperties>({ left: "100%", top: -4, visibility: "hidden" });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const next: React.CSSProperties = r.right > window.innerWidth - 4 ? { right: "100%", top: -4 } : { left: "100%", top: -4 };
    if (r.bottom > window.innerHeight - 4) next.top = -4 - (r.bottom - window.innerHeight + 8);
    setStyle(next);
  }, []);
  return (
    <div ref={ref} className="sm-menu sm-submenu" style={style} onClick={(e) => e.stopPropagation()}>
      <MenuItems items={items} />
    </div>
  );
}

function MenuItems({ items }: { items: MenuItem[] }) {
  const [open, setOpen] = useState<number | null>(null);
  return (
    <>
      {items.map((it, i) => {
        if ("separator" in it) return <div key={i} className="sm-menu-sep" />;
        if ("header" in it) return <div key={i} className="sm-menu-header">{it.header}</div>;
        const sub = it.submenu?.length ? it.submenu : null;
        return (
          <div
            key={i}
            className={cx("sm-menu-item", it.danger && "danger", it.disabled && "disabled", open === i && "open")}
            onMouseEnter={() => setOpen(sub ? i : null)}
            onClick={(e) => {
              e.stopPropagation();
              if (it.disabled) return;
              if (sub) return setOpen(i);
              if (!it.keepOpen) closeMenu();
              it.onSelect?.();
            }}
          >
            <span className="sm-menu-icon">{it.checked ? <Check size={14} /> : it.icon}</span>
            <span className="sm-menu-label">{it.label}</span>
            {it.hint && <span className="sm-menu-hint">{it.hint}</span>}
            {sub && <ChevronRight size={13} className="sm-menu-arrow" />}
            {sub && open === i && <SubMenu items={sub} />}
          </div>
        );
      })}
    </>
  );
}
