// What can be done with events: copying, filtering by them, inspecting their process.
import { Ban, Braces, Copy, Cpu, FileCode, Funnel, Rows3, ScrollText, Tag } from "lucide-react";
import { copy, errorText, sm, type MenuItem } from "../../shared";
import { LevelIcon } from "./levels";
import { eventJson, eventPid, type Ev } from "./parse";
import { prettyXml } from "./xml";

export interface FilterActions {
  filterId(id: number): void;
  excludeId(id: number): void;
  filterSource(provider: string): void;
  filterLevel(level: number): void;
}

export async function inspectProcess(pid: number) {
  try {
    const ok = await sm.ui.openModule({ module: "plugin:process-inspector", args: { pid } });
    if (!ok) sm.ui.notify("Couldn't open Process Inspector: is the module installed?", "error");
  } catch (e) {
    sm.ui.notify(`Couldn't open Process Inspector: ${errorText(e)}`, "error");
  }
}

export function copyMessages(evs: Ev[]) {
  copy(evs.map((e) => e.message).join("\n\n"), evs.length === 1 ? "message" : `${evs.length} messages`);
}

export function copyXml(evs: Ev[]) {
  copy(evs.map((e) => prettyXml(e.xml)).join("\n"), evs.length === 1 ? "XML" : `${evs.length} events as XML`);
}

export function copyJson(evs: Ev[]) {
  const v = evs.length === 1 ? eventJson(evs[0]) : evs.map(eventJson);
  copy(JSON.stringify(v, null, 2), evs.length === 1 ? "JSON" : `${evs.length} events as JSON`);
}

const uniq = <T,>(xs: T[]) => [...new Set(xs)];

/** The rows' context menu. */
export function rowMenu(evs: Ev[], f: FilterActions, tsv: () => string): MenuItem[] {
  const e = evs[0];
  const ids = uniq(evs.map((x) => x.eventId));
  const providers = uniq(evs.map((x) => x.provider));
  const levels = uniq(evs.map((x) => (x.level === 0 ? 4 : x.level)));
  const pid = evs.length === 1 ? eventPid(e) : null;
  const items: MenuItem[] = [
    { label: evs.length === 1 ? "Copy message" : `Copy ${evs.length} messages`, icon: <ScrollText size={14} />, onSelect: () => copyMessages(evs) },
    {
      label: "Copy",
      icon: <Copy size={14} />,
      submenu: [
        { label: evs.length === 1 ? "Row" : `${evs.length} rows`, hint: "Ctrl+C", icon: <Rows3 size={14} />, onSelect: () => copy(tsv(), evs.length === 1 ? "row" : `${evs.length} rows`) },
        { label: "XML", icon: <FileCode size={14} />, onSelect: () => copyXml(evs) },
        { label: "JSON", icon: <Braces size={14} />, onSelect: () => copyJson(evs) },
      ],
    },
    { separator: true },
  ];
  if (ids.length === 1) {
    items.push(
      { label: `Filter: event ID ${ids[0]}`, icon: <Funnel size={14} />, onSelect: () => f.filterId(ids[0]) },
      { label: `Exclude event ID ${ids[0]}`, icon: <Ban size={14} />, onSelect: () => f.excludeId(ids[0]) },
    );
  }
  if (providers.length === 1 && providers[0]) items.push({ label: `Filter: source ${providers[0]}`, icon: <Tag size={14} />, onSelect: () => f.filterSource(providers[0]) });
  if (levels.length === 1) items.push({ label: `Filter: level ${e.level === 0 ? "Information" : e.levelName}`, icon: <LevelIcon kind={e.kind === "auditSuccess" || e.kind === "auditFailure" ? "info" : e.kind} />, onSelect: () => f.filterLevel(levels[0]) });
  if (pid) {
    items.push({ separator: true }, { label: `Inspect process ${pid}`, icon: <Cpu size={14} />, onSelect: () => inspectProcess(pid) });
  }
  return items;
}
