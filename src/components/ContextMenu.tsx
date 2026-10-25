import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Icon } from "../lib/icons";
import { cx } from "../lib/util";
import { ui, useUi, type MenuItem } from "../state/ui";

type Actionable = Extract<MenuItem, { label: string; type?: "item" }>;
const isActionable = (i: MenuItem): i is Actionable => (i.type === undefined || i.type === "item") && !i.disabled;

function MenuList({ items, x, y, depth, flip = false, onClose }: { items: MenuItem[]; x: number; y: number; depth: number; flip?: boolean; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x, y, ready: false });
  const [active, setActive] = useState<number>(-1);
  const [sub, setSub] = useState<{ index: number; x: number; y: number; flip: boolean } | null>(null);
  const subTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    // submenus that don't fit on the right open to the left of their parent item
    let nx = flip ? x - r.width : x;
    let ny = y;
    if (nx + r.width > window.innerWidth - 6) nx = window.innerWidth - r.width - 6;
    if (ny + r.height > window.innerHeight - 6) ny = Math.max(6, window.innerHeight - r.height - 6);
    setPos({ x: Math.max(6, nx), y: ny, ready: true });
  }, [x, y, flip]);

  const openSub = (index: number, el: HTMLElement) => {
    const r = el.getBoundingClientRect();
    const fits = r.right + 240 < window.innerWidth;
    setSub({ index, x: fits ? r.right + 2 : r.left - 2, y: r.top - 5, flip: !fits });
  };

  useEffect(() => {
    if (depth !== 0) return;
    const onKey = (e: KeyboardEvent) => {
      const list = items;
      // the menu doesn't take focus: keys it handles must not also reach the terminal under it
      // (Enter would run the shell's current line)
      if (["Escape", "Enter", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(e.key)) {
        e.preventDefault();
        e.stopPropagation();
      }
      if (e.key === "Escape") return onClose();
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const dir = e.key === "ArrowDown" ? 1 : -1;
        // nothing selected yet: Up starts from the last item, Down from the first
        let i = active < 0 && dir < 0 ? list.length : active;
        for (let n = 0; n < list.length; n++) {
          i = (i + dir + list.length) % list.length;
          if (isActionable(list[i])) break;
        }
        setActive(i);
      }
      if (e.key === "Enter" && active >= 0) {
        const it = list[active];
        if (isActionable(it) && it.onSelect) {
          onClose();
          it.onSelect();
        }
      }
      if (e.key === "ArrowRight" && active >= 0) {
        const it = list[active];
        const el = ref.current?.querySelectorAll<HTMLElement>(".menu-item")[active];
        if (isActionable(it) && it.submenu && el) openSub(active, el);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [items, active, depth, onClose]);

  return (
    <>
      <div
        ref={ref}
        className="menu"
        style={{ left: pos.x, top: pos.y, visibility: pos.ready ? "visible" : "hidden" }}
        onContextMenu={(e) => e.preventDefault()}
      >
        {items.map((it, i) => {
          if (it.type === "separator") return <div key={i} className="menu-sep" />;
          if (it.type === "header") return <div key={i} className="menu-header">{it.label}</div>;
          if (it.type === "swatches")
            return (
              <div key={i} className="menu-swatches">
                {it.colors.map((c) => (
                  <button
                    key={c ?? "none"}
                    className={cx("swatch", c === (it.value ?? null) && "selected", !c && "none")}
                    style={c ? { background: c } : undefined}
                    title={c ?? "No color"}
                    onClick={() => {
                      onClose();
                      it.onSelect(c);
                    }}
                  >
                    {!c && <Icon name="x" size={11} />}
                  </button>
                ))}
              </div>
            );
          const hasSub = !!it.submenu?.length;
          return (
            <div
              key={i}
              className={cx("menu-item", it.disabled && "disabled", it.danger && "danger", (active === i || sub?.index === i) && "active")}
              onMouseEnter={(e) => {
                setActive(i);
                clearTimeout(subTimer.current);
                const el = e.currentTarget;
                if (hasSub && !it.disabled) subTimer.current = setTimeout(() => openSub(i, el), 120);
                else subTimer.current = setTimeout(() => setSub(null), 150);
              }}
              onClick={(e) => {
                if (it.disabled) return;
                if (hasSub) return openSub(i, e.currentTarget);
                onClose();
                it.onSelect?.();
              }}
            >
              <span className="menu-icon" style={it.iconColor ? { color: it.iconColor } : undefined}>
                {it.checked ? <Icon name="check" size={14} /> : it.icon ? <Icon name={it.icon} size={14} /> : null}
              </span>
              <span className="menu-label">{it.label}</span>
              {it.hint && <span className="menu-hint">{it.hint}</span>}
              {it.shortcut && <span className="menu-shortcut">{it.shortcut}</span>}
              {hasSub && <Icon name="chevron-right" size={13} className="menu-caret" />}
            </div>
          );
        })}
      </div>
      {sub && (() => {
        const it = items[sub.index];
        return isActionable(it) && it.submenu ? <MenuList items={it.submenu} x={sub.x} y={sub.y} depth={depth + 1} flip={sub.flip} onClose={onClose} /> : null;
      })()}
    </>
  );
}

export function ContextMenu() {
  const menu = useUi((s) => s.menu);
  useEffect(() => {
    if (!menu) return;
    const close = () => ui.closeMenu();
    window.addEventListener("blur", close);
    window.addEventListener("resize", close);
    return () => {
      window.removeEventListener("blur", close);
      window.removeEventListener("resize", close);
    };
  }, [menu]);
  if (!menu) return null;
  return (
    <div
      className="menu-backdrop"
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) ui.closeMenu();
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        ui.closeMenu();
      }}
    >
      <MenuList items={menu.items} x={menu.x} y={menu.y} depth={0} onClose={ui.closeMenu} />
    </div>
  );
}
