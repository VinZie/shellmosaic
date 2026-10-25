import { beginDrag } from "../lib/dnd";
import { Icon } from "../lib/icons";
import { cx } from "../lib/util";
import { useModules } from "../modules/registry";
import * as A from "../state/actions";
import { moduleBarMenu } from "../state/menus";
import { useSettings } from "../state/settings";
import { ui } from "../state/ui";

export function ModuleBar() {
  const modules = useModules((s) => s.modules);
  const bar = useSettings((s) => s.settings.modules.bar);
  const hidden = useSettings((s) => s.settings.modules.barHidden);
  const labels = useSettings((s) => s.settings.appearance.moduleBarLabels);
  const ids = [
    ...bar.filter((id) => modules[id] && !hidden.includes(id)),
    ...Object.values(modules)
      .filter((m) => m.plugin && !bar.includes(m.id) && !hidden.includes(m.id))
      .map((m) => m.id),
  ];

  return (
    <aside
      className={cx("modbar", labels && "with-labels")}
      onContextMenu={(e) => {
        e.preventDefault();
        ui.openMenu(e, moduleBarMenu());
      }}
    >
      {ids.map((id) => {
        const m = modules[id];
        return (
          <button
            key={id}
            className={cx("mod-btn", m.plugin && "plugin")}
            onPointerDown={(e) => beginDrag(e, { kind: "module", moduleId: id }, m.name, m.icon)}
            onClick={() => A.addModule(id)}
            title={`${m.name} — ${m.description}\nClick to add next to the focused pane · drag onto a pane to place it`}
          >
            <Icon name={m.icon} size={18} />
            {labels && <span>{m.name.toLowerCase()}</span>}
          </button>
        );
      })}
      <div className="modbar-spacer" />
      <button className="mod-btn" onClick={() => ui.openPalette("modules")} title="All modules">
        <Icon name="layout-grid" size={17} />
        {labels && <span>more</span>}
      </button>
    </aside>
  );
}
