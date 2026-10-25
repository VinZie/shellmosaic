// Settings: a full-window overlay with a section nav, a search that shows the
// matching (live) controls from every section, and per-section pages.
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ComponentType } from "react";
import { Icon } from "../lib/icons";
import { cx } from "../lib/util";
import { ui, useUi } from "../state/ui";
import { AboutSection } from "./sections/About";
import { AppearanceSection } from "./sections/Appearance";
import { NavCtx, SearchCtx } from "./sections/controls";
import { DataSection } from "./sections/Data";
import { KeybindingsSection } from "./sections/Keybindings";
import { ModulesSection } from "./sections/Modules";
import { PluginsSection } from "./sections/Plugins";
import { ProfilesSection } from "./sections/Profiles";
import { TerminalSection } from "./sections/Terminal";
import { WindowSection } from "./sections/Window";
import "./settings.css";

interface SectionDef {
  id: string;
  title: string;
  icon: string;
  C: ComponentType;
}

/** Section ids are used elsewhere: ui.openSettings("profiles"), menus, commands. */
const SECTIONS: SectionDef[] = [
  { id: "appearance", title: "Appearance", icon: "palette", C: AppearanceSection },
  { id: "window", title: "Window", icon: "app-window", C: WindowSection },
  { id: "terminal", title: "Terminal", icon: "square-terminal", C: TerminalSection },
  { id: "profiles", title: "Profiles", icon: "layers", C: ProfilesSection },
  { id: "modules", title: "Modules", icon: "layout-grid", C: ModulesSection },
  { id: "keybindings", title: "Keybindings", icon: "keyboard", C: KeybindingsSection },
  { id: "plugins", title: "Plugins", icon: "puzzle", C: PluginsSection },
  { id: "data", title: "Data & restore", icon: "database", C: DataSection },
  { id: "about", title: "About", icon: "info", C: AboutSection },
];

function sameCounts(a: Record<string, number> | null, b: Record<string, number>) {
  if (!a) return false;
  const ka = Object.keys(a);
  return ka.length === Object.keys(b).length && ka.every((k) => a[k] === b[k]);
}

export function SettingsView() {
  const sectionId = useUi((s) => s.settings.section);
  const [query, setQuery] = useState("");
  const [counts, setCounts] = useState<Record<string, number> | null>(null);
  const queryRef = useRef(query);
  queryRef.current = query;
  const searchRef = useRef<HTMLInputElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);

  const q = query.trim();
  const current = SECTIONS.find((s) => s.id === sectionId) ?? SECTIONS[0];

  const go = useCallback((id: string) => {
    setQuery("");
    useUi.setState((s) => ({ settings: { ...s.settings, section: id } }));
    scrollRef.current?.scrollTo({ top: 0 });
  }, []);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: 0 });
  }, [sectionId]);

  // Esc closes (or clears the search) unless a dialog, menu, palette or the theme
  // editor is up. Registered once, early, so it runs before their own handlers;
  // the subscription catches overlays that closed earlier in this same keypress.
  useEffect(() => {
    let overlayClosedAt = 0;
    const unsub = useUi.subscribe((s, prev) => {
      if ((prev.dialog && !s.dialog) || (prev.menu && !s.menu) || (prev.palette.open && !s.palette.open) || (prev.themeEditor.open && !s.themeEditor.open)) {
        overlayClosedAt = performance.now();
      }
    });
    const onKey = (e: KeyboardEvent) => {
      const s = ui.get();
      if (s.dialog || s.menu || s.palette.open || s.themeEditor.open) return;
      if (e.ctrlKey && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "f") {
        e.preventDefault();
        e.stopPropagation();
        searchRef.current?.focus();
        searchRef.current?.select();
        return;
      }
      if (e.key !== "Escape" || e.defaultPrevented) return;
      if (performance.now() - overlayClosedAt < 100) return;
      e.preventDefault();
      e.stopPropagation();
      if (queryRef.current) setQuery("");
      else ui.closeSettings();
    };
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      unsub();
    };
  }, []);

  // while searching, count matching rows per section (sections render their own
  // rows, some asynchronously, so observe the DOM rather than keep an index)
  useLayoutEffect(() => {
    if (!q) {
      setCounts(null);
      return;
    }
    const root = contentRef.current;
    if (!root) return;
    let frame = 0;
    const count = () => {
      frame = 0;
      const next: Record<string, number> = {};
      root.querySelectorAll<HTMLElement>("[data-section]").forEach((el) => {
        next[el.dataset.section!] = el.querySelectorAll(".setting-hit").length;
      });
      setCounts((prev) => (sameCounts(prev, next) ? prev : next));
    };
    count();
    const mo = new MutationObserver(() => {
      if (!frame) frame = requestAnimationFrame(count);
    });
    mo.observe(root, { childList: true, subtree: true });
    return () => {
      mo.disconnect();
      if (frame) cancelAnimationFrame(frame);
    };
  }, [q]);

  const total = counts ? Object.values(counts).reduce((a, b) => a + b, 0) : 0;

  return (
    <NavCtx.Provider value={go}>
      <div className="settings-overlay" role="dialog" aria-modal="true" aria-label="Settings">
        <aside className="settings-nav">
          <div className="settings-nav-head" data-tauri-drag-region>
            <Icon name="settings" size={17} />
            <h2 data-tauri-drag-region>Settings</h2>
          </div>
          <div className="search-box settings-search">
            <Icon name="search" size={14} />
            <input
              ref={searchRef}
              autoFocus
              value={query}
              placeholder="Search settings  (Ctrl+F)"
              spellCheck={false}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && counts) {
                  const first = SECTIONS.find((s) => counts[s.id]);
                  if (first) contentRef.current?.querySelector(`[data-section="${first.id}"] .setting-hit`)?.scrollIntoView({ block: "center", behavior: "smooth" });
                }
              }}
            />
            {query && (
              <button className="icon-btn" onClick={() => setQuery("")} title="Clear search (Esc)">
                <Icon name="x" size={12} />
              </button>
            )}
          </div>
          <nav className="settings-nav-list">
            {SECTIONS.map((s) => {
              const n = counts?.[s.id] ?? 0;
              return (
                <button
                  key={s.id}
                  className={cx("settings-nav-item", !q && s.id === current.id && "active", q && n === 0 && "no-hits")}
                  onClick={() => {
                    if (q && n > 0) contentRef.current?.querySelector(`[data-section="${s.id}"]`)?.scrollIntoView({ block: "start", behavior: "smooth" });
                    else go(s.id);
                  }}
                  title={q && n > 0 ? `Jump to ${s.title} results` : s.title}
                >
                  <Icon name={s.icon} size={16} />
                  <span className="grow">{s.title}</span>
                  {q && n > 0 && <span className="settings-nav-count">{n}</span>}
                </button>
              );
            })}
          </nav>
          <div className="settings-nav-foot">
            <Icon name="check" size={12} />
            <span>Changes apply and save instantly</span>
          </div>
        </aside>

        <main className="settings-main">
          <div className="settings-topbar" data-tauri-drag-region>
            {q && (
              <span className="settings-results" data-tauri-drag-region>
                {counts ? (total ? `${total} result${total === 1 ? "" : "s"} for “${q}”` : `No results for “${q}”`) : ""}
              </span>
            )}
            <span className="grow" data-tauri-drag-region />
            <button className="icon-btn settings-close" onClick={ui.closeSettings} title="Close settings (Esc)">
              <Icon name="x" size={18} />
            </button>
          </div>
          <div className="settings-scroll" ref={scrollRef}>
            <SearchCtx.Provider value={q}>
              <div className={cx("settings-content", q && "searching")} ref={contentRef}>
                {q ? SECTIONS.map(({ id, C }) => <C key={id} />) : <current.C key={current.id} />}
                {q && counts && total === 0 && (
                  <div className="settings-empty big">
                    <Icon name="search" size={26} />
                    <p>No settings match “{q}”.</p>
                    <p className="dim">Try a different word, like “font”, “opacity”, “paste” or “shortcut”.</p>
                  </div>
                )}
              </div>
            </SearchCtx.Provider>
          </div>
        </main>
      </div>
    </NavCtx.Provider>
  );
}
