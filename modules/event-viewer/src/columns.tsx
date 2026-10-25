// The events table's columns: the usual Event Viewer set, and the Sysmon view.
import { formatDateTime, type Column, type ColumnState } from "../../shared";
import { LevelCell, levelLabel } from "./levels";
import { KIND_RANK, type Ev } from "./parse";
import { baseName, dirName, sysmonFamily } from "./sysmon";

const pad = (n: number) => String(n).padStart(2, "0");

/** "14:03:07" today, "10-24 14:03" before. */
export function shortTime(ms: number): string {
  if (!ms) return "";
  const d = new Date(ms);
  const now = new Date();
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  if (d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate()) return `${time}:${pad(d.getSeconds())}`;
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${time}`;
}

const numText = (n: number | null | undefined) => (n === null || n === undefined ? "" : String(n));

function timeColumn(narrow: boolean): Column<Ev> {
  return {
    id: "time",
    label: narrow ? "Time" : "Date and time",
    width: narrow ? 78 : 150,
    minWidth: 60,
    sort: (e) => e.time,
    text: (e) => formatDateTime(e.time),
    render: (e) => <span className="ev-num">{narrow ? shortTime(e.time) : formatDateTime(e.time)}</span>,
  };
}

const common: Column<Ev>[] = [
  { id: "computer", label: "Computer", width: 150, hidden: true, sort: (e) => e.computer, text: (e) => e.computer },
  { id: "record", label: "Record ID", width: 96, hidden: true, align: "right", sort: (e) => e.recordId, text: (e) => numText(e.recordId) },
  { id: "channel", label: "Channel", width: 180, hidden: true, sort: (e) => e.channel, text: (e) => e.channel },
];

export function eventColumns(narrow: boolean): Column<Ev>[] {
  return [
    {
      id: "level",
      label: narrow ? "" : "Level",
      title: "Level",
      width: narrow ? 36 : 112,
      minWidth: 34,
      sort: (e) => KIND_RANK[e.kind],
      text: levelLabel,
      render: (e) => <LevelCell e={e} iconOnly={narrow} />,
    },
    timeColumn(narrow),
    {
      id: "source",
      label: "Source",
      width: narrow ? 112 : 170,
      sort: (e) => e.source,
      text: (e) => e.provider,
      render: (e) => <span className="sm-cell-text">{e.source}</span>,
    },
    { id: "id", label: narrow ? "ID" : "Event ID", title: "Event ID", width: narrow ? 56 : 72, align: "right", sort: (e) => e.eventId, text: (e) => String(e.eventId) },
    { id: "task", label: "Task category", width: 132, hidden: narrow, sort: (e) => e.taskName, text: (e) => e.taskName },
    {
      id: "message",
      label: "Message",
      width: 440,
      sort: (e) => e.firstLine,
      text: (e) => e.firstLine,
      render: (e) => <span className={e.rendered ? "sm-cell-text" : "sm-cell-text ev-unrendered"}>{e.firstLine}</span>,
    },
    ...common,
    { id: "user", label: "User", width: 160, hidden: true, sort: (e) => e.user, text: (e) => e.user },
    { id: "pid", label: "Process ID", width: 84, hidden: true, align: "right", sort: (e) => e.pid ?? -1, text: (e) => numText(e.pid) },
    { id: "tid", label: "Thread ID", width: 84, hidden: true, align: "right", sort: (e) => e.tid ?? -1, text: (e) => numText(e.tid) },
    { id: "keywords", label: "Keywords", width: 150, hidden: true, sort: (e) => e.keywordNames, text: (e) => e.keywordNames },
    { id: "opcode", label: "Opcode", width: 100, hidden: true, sort: (e) => e.opcodeName, text: (e) => e.opcodeName },
  ];
}

export function SysmonEvent({ e }: { e: Ev }) {
  return (
    <span className="ev-sysev">
      <span className={`ev-sysid ev-fam-${sysmonFamily(e.eventId)}`}>{e.eventId}</span>
      <span className="sm-cell-text">{e.sys?.name ?? e.taskName}</span>
    </span>
  );
}

export function PathCell({ path }: { path: string }) {
  if (!path) return null;
  const base = baseName(path);
  const dir = dirName(path);
  return (
    <span className="ev-path sm-cell-text">
      <span className="ev-path-base">{base}</span>
      {dir && <span className="ev-path-dir">{dir}</span>}
    </span>
  );
}

export function sysmonColumns(narrow: boolean): Column<Ev>[] {
  return [
    timeColumn(narrow),
    {
      id: "event",
      label: "Event",
      width: narrow ? 150 : 200,
      sort: (e) => e.eventId,
      text: (e) => `${e.eventId} ${e.sys?.name ?? e.taskName}`,
      render: (e) => <SysmonEvent e={e} />,
    },
    {
      id: "image",
      label: "Image",
      width: narrow ? 150 : 240,
      sort: (e) => baseName(e.sys?.image ?? "").toLowerCase(),
      text: (e) => e.sys?.image ?? "",
      render: (e) => <PathCell path={e.sys?.image ?? ""} />,
    },
    {
      id: "details",
      label: "Details",
      width: narrow ? 320 : 480,
      mono: true,
      sort: (e) => e.sys?.details ?? e.firstLine,
      text: (e) => (e.sys ? e.sys.details : e.firstLine),
    },
    { id: "user", label: "User", width: 180, hidden: narrow, sort: (e) => e.sys?.user || e.user, text: (e) => e.sys?.user || e.user },
    { id: "pid", label: "PID", width: 70, hidden: narrow, align: "right", sort: (e) => e.sys?.pid ?? -1, text: (e) => numText(e.sys?.pid) },
    { id: "parentImage", label: "ParentImage", width: 240, hidden: true, sort: (e) => e.sys?.parentImage ?? "", text: (e) => e.sys?.parentImage ?? "", render: (e) => <PathCell path={e.sys?.parentImage ?? ""} /> },
    { id: "parentCommandLine", label: "ParentCommandLine", width: 360, hidden: true, mono: true, sort: (e) => e.sys?.parentCommandLine ?? "", text: (e) => e.sys?.parentCommandLine ?? "" },
    { id: "hashes", label: "Hashes", width: 360, hidden: true, mono: true, sort: (e) => e.sys?.hashes ?? "", text: (e) => e.sys?.hashes ?? "" },
    { id: "processGuid", label: "ProcessGuid", width: 300, hidden: true, mono: true, sort: (e) => e.sys?.processGuid ?? "", text: (e) => e.sys?.processGuid ?? "" },
    { id: "ruleName", label: "RuleName", width: 160, hidden: true, sort: (e) => e.sys?.ruleName ?? "", text: (e) => e.sys?.ruleName ?? "" },
    ...common,
  ];
}

/** The columns the table shows, in its order (the same rules as the kit's Table). */
export function shownColumns<T>(columns: Column<T>[], layout: ColumnState): Column<T>[] {
  const byId = new Map(columns.map((c) => [c.id, c]));
  const ordered = [...layout.order.filter((id) => byId.has(id)).map((id) => byId.get(id)!), ...columns.filter((c) => !layout.order.includes(c.id))];
  const vis = ordered.filter((c) => layout.visible[c.id] ?? !c.hidden);
  return vis.length ? vis : ordered.slice(0, 1);
}

/** Tab-separated rows of the shown columns. */
export function rowsTsv(rows: Ev[], cols: Column<Ev>[]): string {
  return rows.map((r) => cols.map((c) => (c.text ? c.text(r) : "").replace(/[\t\r\n]+/g, " ")).join("\t")).join("\n");
}
