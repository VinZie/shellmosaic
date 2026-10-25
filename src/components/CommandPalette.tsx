import { useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "../lib/icons";
import { cx, fuzzyScore } from "../lib/util";
import { useModules } from "../modules/registry";
import * as A from "../state/actions";
import { COMMANDS, shortcutLabel } from "../state/commands";
import { useAllProfiles } from "../state/profiles";
import { allThemes } from "../state/themes";
import { useModel } from "../state/store";
import { ui, useUi } from "../state/ui";

interface Item {
  id: string;
  title: string;
  category: string;
  icon?: string;
  iconColor?: string;
  shortcut?: string;
  run: () => unknown;
}

export function CommandPalette() {
  const { open, query: initialQuery, mode } = useUi((s) => s.palette);
  const [query, setQuery] = useState("");
  const [sel, setSel] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const model = useModel((s) => s.model);
  const modules = useModules((s) => s.modules);
  const profiles = useAllProfiles();

  useEffect(() => {
    if (open) {
      setQuery(initialQuery);
      setSel(0);
      setTimeout(() => inputRef.current?.focus(), 0);
    }
  }, [open, initialQuery]);

  const items = useMemo<Item[]>(() => {
    if (!open) return [];
    const moduleItems: Item[] = Object.values(modules).map((m) => ({
      id: `mod:${m.id}`,
      title: m.name,
      category: m.plugin ? "Plugin module" : "Module",
      icon: m.icon,
      run: () => A.addModule(m.id),
    }));
    const profileItems: Item[] = profiles
      .filter((p) => !p.hidden)
      .map((p) => ({
        id: `prof:${p.id}`,
        title: `New tab: ${p.name}`,
        category: "Shell",
        icon: p.icon ?? "terminal",
        iconColor: p.color ?? undefined,
        run: () => A.newTab("terminal", { profile: p.id }),
      }));
    if (mode === "modules") return moduleItems;
    if (mode === "profiles") return profileItems;
    const commands: Item[] = COMMANDS.filter((c) => !/\.goto\./.test(c.id)).map((c) => ({
      id: c.id,
      title: c.title,
      category: c.category,
      icon: c.icon,
      shortcut: shortcutLabel(c.id),
      run: c.run,
    }));
    const workspaces: Item[] = model.order.map((id) => ({
      id: `ws:${id}`,
      title: `Workspace: ${model.workspaces[id].name}`,
      category: "Switch",
      icon: model.workspaces[id].icon,
      iconColor: model.workspaces[id].color,
      run: () => A.switchWorkspace(id),
    }));
    const tabs: Item[] = model.order.flatMap((wsId) =>
      model.workspaces[wsId].tabs.map((t) => ({
        id: `tab:${t}`,
        title: `Tab: ${A.tabLabel(t)}`,
        category: model.workspaces[wsId].name,
        icon: "square",
        run: async () => {
          await A.switchWorkspace(wsId);
          A.switchTab(t);
        },
      })),
    );
    const themes: Item[] = allThemes().map((t) => ({
      id: `theme:${t.id}`,
      title: `Theme: ${t.name}`,
      category: "Appearance",
      icon: "palette",
      run: () => A.setTheme(t.id),
    }));
    const add = moduleItems.map((m) => ({ ...m, title: `Add ${m.title}` }));
    return [...commands, ...workspaces, ...tabs, ...add, ...profileItems, ...themes];
  }, [open, mode, model, modules, profiles]);

  const filtered = useMemo(() => {
    if (!query.trim()) return items;
    return items
      .map((it) => ({ it, s: Math.max(fuzzyScore(query, it.title), fuzzyScore(query, `${it.category} ${it.title}`) - 5) }))
      .filter((x) => x.s >= 0)
      .sort((a, b) => b.s - a.s)
      .map((x) => x.it);
  }, [items, query]);

  useEffect(() => setSel(0), [query]);
  useEffect(() => {
    listRef.current?.querySelector(".palette-item.selected")?.scrollIntoView({ block: "nearest" });
  }, [sel]);

  if (!open) return null;
  const run = (it?: Item) => {
    if (!it) return;
    ui.closePalette();
    setTimeout(() => it.run(), 0);
  };
  const placeholder = mode === "modules" ? "Add a module…" : mode === "profiles" ? "Open a shell…" : "Type a command, workspace, tab, module or theme…";

  return (
    <div className="palette-backdrop" onPointerDown={(e) => e.target === e.currentTarget && ui.closePalette()}>
      <div className="palette">
        <div className="palette-input">
          <Icon name={mode === "modules" ? "layout-grid" : "search"} size={16} />
          <input
            ref={inputRef}
            value={query}
            placeholder={placeholder}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") ui.closePalette();
              else if (e.key === "ArrowDown") {
                e.preventDefault();
                setSel((s) => Math.min(filtered.length - 1, s + 1));
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setSel((s) => Math.max(0, s - 1));
              } else if (e.key === "Enter") run(filtered[sel]);
            }}
          />
        </div>
        <div className="palette-list" ref={listRef}>
          {filtered.length === 0 && <div className="palette-empty">No matches</div>}
          {filtered.slice(0, 200).map((it, i) => (
            <div
              key={it.id}
              className={cx("palette-item", i === sel && "selected")}
              onMouseMove={() => i !== sel && setSel(i)}
              onClick={() => run(it)}
            >
              <span className="palette-icon" style={it.iconColor ? { color: it.iconColor } : undefined}>
                {it.icon && <Icon name={it.icon} size={15} />}
              </span>
              <span className="palette-title">{it.title}</span>
              <span className="palette-cat">{it.category}</span>
              {it.shortcut && <kbd>{it.shortcut}</kbd>}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
