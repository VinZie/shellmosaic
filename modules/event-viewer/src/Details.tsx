// The selected event: General (message and properties), Data (EventData/UserData), XML.
import { forwardRef, useMemo } from "react";
import { Ban, Braces, Copy, Cpu, FileCode, Funnel, PanelBottom, PanelRight, ScrollText, Tag, X } from "lucide-react";
import { Button, copy, formatDateTime, IconButton, KeyValues, Message, openMenu, Tabs, type KV, type MenuItem } from "../../shared";
import { copyJson, copyMessages, copyXml, inspectProcess, type FilterActions } from "./actions";
import { SysmonEvent } from "./columns";
import { LevelIcon, levelLabel } from "./levels";
import { eventPid, type Ev } from "./parse";
import { XmlView } from "./xml";

export type DetailsTab = "general" | "data" | "xml";
export type DetailsMode = "auto" | "bottom" | "right";

export interface DetailsProps {
  ev: Ev | null;
  selectedCount: number;
  tab: DetailsTab;
  onTab: (t: DetailsTab) => void;
  /** the layout in use, and the user's choice */
  side: "bottom" | "right";
  mode: DetailsMode;
  onMode: (m: DetailsMode) => void;
  onClose: () => void;
  actions: FilterActions;
  onEscape: () => void;
}

function General({ e }: { e: Ev }) {
  const rows: (KV | null)[] = [
    { label: "Log name", value: e.channel },
    { label: "Source", value: e.provider },
    { label: "Event ID", value: String(e.eventId), copyText: String(e.eventId) },
    { label: "Level", value: levelLabel(e) },
    { label: "User", value: e.user || "N/A", copyText: e.userSid || null, title: e.userSid || undefined, muted: !e.user },
    { label: "OpCode", value: e.opcodeName },
    { label: "Logged", value: formatDateTime(e.time, true), copyText: e.timeRaw, title: e.timeRaw },
    { label: "Task category", value: e.taskName },
    { label: "Keywords", value: e.keywordNames || "None", muted: !e.keywordNames, title: e.keywords || undefined },
    { label: "Computer", value: e.computer },
    { label: "Process ID", value: e.pid === null ? "" : String(e.pid), mono: true },
    { label: "Thread ID", value: e.tid === null ? "" : String(e.tid), mono: true },
    { label: "Record ID", value: String(e.recordId), mono: true },
    e.activityId || e.relatedActivityId
      ? { label: "Correlation", value: [e.activityId, e.relatedActivityId && `related ${e.relatedActivityId}`].filter(Boolean).join(" · "), mono: true, copyText: e.activityId || e.relatedActivityId }
      : { label: "Correlation", value: "None", muted: true },
  ];
  return (
    <div className="ev-gen">
      <div className="ev-gen-body">
        <pre className={e.rendered ? "ev-message sm-selectable" : "ev-message sm-selectable unrendered"}>{e.message}</pre>
        <div className="ev-gen-props">
          <KeyValues rows={rows} labelWidth={104} />
        </div>
      </div>
    </div>
  );
}

function DataTab({ e }: { e: Ev }) {
  const rows = useMemo(() => {
    const seen = new Map<string, number>();
    return e.data.map(([k, v]): KV => {
      const n = (seen.get(k) ?? 0) + 1;
      seen.set(k, n);
      return { label: n > 1 ? `${k || "Data"} #${n}` : k || "Data", value: v, mono: true, copyText: v };
    });
  }, [e]);
  if (!rows.length) return <Message title="No event data" icon={<Braces size={20} />} />;
  const width = Math.min(190, Math.max(90, ...e.data.map(([k]) => k.length * 7 + 12)));
  return (
    <div className="ev-data">
      <div className="ev-data-head">
        <span className="sm-dim">
          {e.dataKind}
          {rows.length > 1 ? ` · ${rows.length} fields` : ""}
        </span>
        <div className="sm-grow" />
        <Button small kind="subtle" onClick={() => copy(e.data.map(([k, v]) => `${k}\t${v}`).join("\n"), "event data")}>
          <Copy size={12} /> Copy all
        </Button>
      </div>
      <KeyValues rows={rows} labelWidth={width} />
    </div>
  );
}

export const Details = forwardRef<HTMLDivElement, DetailsProps>(function Details(p, ref) {
  const e = p.ev;
  const pid = e ? eventPid(e) : null;

  const copyMenu = (el: HTMLElement) =>
    e &&
    openMenu(el, [
      { label: "Copy message", icon: <ScrollText size={14} />, onSelect: () => copyMessages([e]) },
      { label: "Copy XML", icon: <FileCode size={14} />, onSelect: () => copyXml([e]) },
      { label: "Copy as JSON", icon: <Braces size={14} />, onSelect: () => copyJson([e]) },
    ]);
  const filterMenu = (el: HTMLElement) =>
    e &&
    openMenu(el, [
      { label: `Filter: this event ID (${e.eventId})`, icon: <Funnel size={14} />, onSelect: () => p.actions.filterId(e.eventId) },
      { label: `Exclude this event ID`, icon: <Ban size={14} />, onSelect: () => p.actions.excludeId(e.eventId) },
      { label: `Filter: this source`, hint: e.source, icon: <Tag size={14} />, onSelect: () => p.actions.filterSource(e.provider) },
      { label: `Filter: this level`, hint: e.level === 0 ? "Information" : e.levelName, icon: <LevelIcon kind={e.kind === "auditFailure" || e.kind === "auditSuccess" ? "info" : e.kind} />, onSelect: () => p.actions.filterLevel(e.level === 0 ? 4 : e.level) },
    ]);
  const layoutMenu = (el: HTMLElement) => {
    const items: MenuItem[] = [
      { header: "Details" },
      { label: "Automatic", checked: p.mode === "auto", onSelect: () => p.onMode("auto") },
      { label: "Below the list", checked: p.mode === "bottom", icon: <PanelBottom size={14} />, onSelect: () => p.onMode("bottom") },
      { label: "Right of the list", checked: p.mode === "right", icon: <PanelRight size={14} />, onSelect: () => p.onMode("right") },
      { separator: true },
      { label: "Hide details", icon: <X size={14} />, onSelect: p.onClose },
    ];
    openMenu(el, items);
  };

  const right = (
    <div className="ev-details-actions">
      {p.selectedCount > 1 && <span className="ev-sel-note">{p.selectedCount} selected</span>}
      {e && (
        <>
          <IconButton title="Copy…" onClick={(ev) => copyMenu(ev.currentTarget)}>
            <Copy size={14} />
          </IconButton>
          <IconButton title="Filter by this event…" onClick={(ev) => filterMenu(ev.currentTarget)}>
            <Funnel size={14} />
          </IconButton>
          {pid !== null && (
            <IconButton title={`Inspect process ${pid}`} onClick={() => inspectProcess(pid)}>
              <Cpu size={14} />
            </IconButton>
          )}
        </>
      )}
      <IconButton title="Details layout" onClick={(ev) => layoutMenu(ev.currentTarget)}>
        {p.side === "right" ? <PanelRight size={14} /> : <PanelBottom size={14} />}
      </IconButton>
      <IconButton title="Hide details" onClick={p.onClose}>
        <X size={14} />
      </IconButton>
    </div>
  );

  return (
    <div
      className="ev-details"
      ref={ref}
      tabIndex={-1}
      onKeyDown={(ev) => {
        if (ev.key === "Escape" && !(ev.target as HTMLElement).closest("input, textarea")) {
          ev.preventDefault();
          p.onEscape();
        }
      }}
    >
      <Tabs
        items={[
          { id: "general", label: "General" },
          { id: "data", label: "Data", badge: e && e.data.length ? e.data.length : undefined },
          { id: "xml", label: "XML" },
        ]}
        active={p.tab}
        onChange={(t) => p.onTab(t as DetailsTab)}
        right={right}
      />
      {e && (
        <div className="ev-details-title">
          {e.sys ? <SysmonEvent e={e} /> : <LevelIcon kind={e.kind} size={14} />}
          <span className="ev-details-name sm-ellipsis">
            {e.sys ? (
              <span className="sm-dim">Sysmon</span>
            ) : (
              <>
                <b>Event {e.eventId}</b>
                <span className="sm-dim">, {e.provider}</span>
              </>
            )}
          </span>
          <div className="sm-grow" />
          <span className="sm-dim ev-num">{formatDateTime(e.time)}</span>
        </div>
      )}
      <div className="ev-details-body">
        {!e ? (
          <Message title="No event selected" icon={<ScrollText size={20} />}>
            Select an event to see its message, data and XML.
          </Message>
        ) : p.tab === "general" ? (
          <General e={e} />
        ) : p.tab === "data" ? (
          <DataTab e={e} />
        ) : (
          <XmlView xml={e.xml} />
        )}
      </div>
    </div>
  );
});
