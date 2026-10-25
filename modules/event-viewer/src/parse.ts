// Event XML → a compact object. Each event is parsed once, when its page arrives;
// the raw string is kept for the XML tab and for copying.
import { SYSMON_PROVIDER, sysmonInfo, type SysmonInfo } from "./sysmon";

export type LevelKind = "critical" | "error" | "warning" | "info" | "verbose" | "auditSuccess" | "auditFailure";

export interface Ev {
  /** unique in the list: the record ID (or a negative counter when there is none) */
  key: number;
  xml: string;
  provider: string;
  /** provider without the "Microsoft-Windows-" prefix, as Event Viewer shows it */
  source: string;
  eventId: number;
  version: number;
  level: number;
  levelName: string;
  kind: LevelKind;
  task: number;
  taskName: string;
  opcode: number;
  opcodeName: string;
  /** hex mask */
  keywords: string;
  keywordNames: string;
  /** Unix ms */
  time: number;
  /** SystemTime as written (100 ns precision) */
  timeRaw: string;
  recordId: number;
  activityId: string;
  relatedActivityId: string;
  pid: number | null;
  tid: number | null;
  channel: string;
  computer: string;
  userSid: string;
  /** SYSTEM, LOCAL SERVICE … for well-known SIDs, else the SID ("" when there is none) */
  user: string;
  message: string;
  firstLine: string;
  /** the provider's message was available */
  rendered: boolean;
  /** EventData (or flattened UserData) name/value pairs */
  data: [string, string][];
  dataKind: "EventData" | "UserData" | null;
  sys: SysmonInfo | null;
}

const LEVEL_NAMES = ["Information", "Critical", "Error", "Warning", "Information", "Verbose"];

export const KIND_LABEL: Record<LevelKind, string> = {
  critical: "Critical",
  error: "Error",
  warning: "Warning",
  info: "Information",
  verbose: "Verbose",
  auditSuccess: "Audit Success",
  auditFailure: "Audit Failure",
};

/** Sort order: most severe first. */
export const KIND_RANK: Record<LevelKind, number> = {
  critical: 1,
  error: 2,
  auditFailure: 2.5,
  warning: 3,
  info: 4,
  auditSuccess: 4.5,
  verbose: 5,
};

const SIDS: Record<string, string> = {
  "S-1-5-18": "SYSTEM",
  "S-1-5-19": "LOCAL SERVICE",
  "S-1-5-20": "NETWORK SERVICE",
  "S-1-5-7": "ANONYMOUS LOGON",
  "S-1-1-0": "Everyone",
  "S-1-5-32-544": "Administrators",
  "S-1-5-32-545": "Users",
  "S-1-5-11": "Authenticated Users",
  "S-1-5-4": "INTERACTIVE",
  "S-1-5-6": "SERVICE",
};

export function friendlySid(sid: string): string {
  return SIDS[sid] ?? sid;
}

export function shortProvider(p: string): string {
  return p.startsWith("Microsoft-Windows-") ? p.slice(18) : p;
}

let parser: DOMParser | null = null;
let fallbackKey = 0;

/** "2026-10-25T12:00:00.1234567Z" → ms (Date.parse wants at most 3 fraction digits). */
function parseTime(s: string): number {
  if (!s) return 0;
  const t = Date.parse(s.replace(/(\.\d{3})\d+/, "$1"));
  return Number.isNaN(t) ? 0 : t;
}

function num(s: string | null | undefined): number {
  if (!s) return 0;
  const n = Number(s);
  return Number.isFinite(n) ? n : 0;
}

function optNum(s: string | null | undefined): number | null {
  if (s === null || s === undefined || s === "") return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function clean(s: string): string {
  return s.replace(/\r\n?/g, "\n");
}

function firstLineOf(s: string): string {
  let start = 0;
  while (start < s.length) {
    let end = s.indexOf("\n", start);
    if (end < 0) end = s.length;
    const line = s.slice(start, end).trim();
    if (line) return line.length > 400 ? line.slice(0, 400) : line.replace(/\t/g, " ");
    start = end + 1;
  }
  return "";
}

/** UserData holds one element with arbitrary children: flatten them to name/value pairs. */
function flatten(el: Element, prefix: string, out: [string, string][]) {
  for (const a of Array.from(el.attributes)) if (a.name !== "xmlns" && !a.name.startsWith("xmlns:")) out.push([`${prefix}@${a.name}`, a.value]);
  for (const c of Array.from(el.children)) {
    const name = prefix ? `${prefix}/${c.localName}` : c.localName;
    if (c.childElementCount) flatten(c, name, out);
    else {
      out.push([name, c.textContent ?? ""]);
      for (const a of Array.from(c.attributes)) if (a.name !== "xmlns" && !a.name.startsWith("xmlns:")) out.push([`${name}@${a.name}`, a.value]);
    }
  }
}

function hiKeywords(hex: string): number {
  if (!hex) return 0;
  const h = hex.replace(/^0x/i, "").padStart(16, "0");
  return parseInt(h.slice(0, 4), 16) || 0;
}

export function parseEvent(xml: string, fallbackChannel = ""): Ev {
  parser ??= new DOMParser();
  const doc = parser.parseFromString(xml, "application/xml");
  const root = doc.documentElement;
  let system: Element | null = null;
  let eventData: Element | null = null;
  let userData: Element | null = null;
  let rendering: Element | null = null;
  if (root && root.localName === "Event") {
    for (const c of Array.from(root.children)) {
      switch (c.localName) {
        case "System":
          system = c;
          break;
        case "EventData":
          eventData = c;
          break;
        case "UserData":
          userData = c;
          break;
        case "RenderingInfo":
          rendering = c;
          break;
      }
    }
  }

  const sys: Record<string, Element> = {};
  if (system) for (const c of Array.from(system.children)) sys[c.localName] = c;
  const t = (name: string) => sys[name]?.textContent?.trim() ?? "";
  const a = (name: string, attr: string) => sys[name]?.getAttribute(attr) ?? "";

  const r: Record<string, Element> = {};
  if (rendering) for (const c of Array.from(rendering.children)) r[c.localName] = c;
  const rt = (name: string) => r[name]?.textContent?.trim() ?? "";

  const provider = a("Provider", "Name") || a("Provider", "EventSourceName");
  const eventId = num(t("EventID"));
  const level = num(t("Level"));
  const task = num(t("Task"));
  const opcode = num(t("Opcode"));
  const keywords = t("Keywords");
  const recordId = num(t("EventRecordID"));
  const userSid = a("Security", "UserID");

  // EventData / UserData
  const data: [string, string][] = [];
  let dataKind: Ev["dataKind"] = null;
  if (eventData) {
    dataKind = "EventData";
    const unnamed: number[] = [];
    for (const d of Array.from(eventData.children)) {
      if (d.localName === "Data") {
        const n = d.getAttribute("Name");
        if (!n) unnamed.push(data.length);
        data.push([n ?? "", d.textContent ?? ""]);
      } else data.push([d.localName, d.textContent ?? ""]);
    }
    if (unnamed.length === 1) data[unnamed[0]][0] = "Data";
    else unnamed.forEach((i, k) => (data[i][0] = `Data ${k + 1}`));
  } else if (userData?.firstElementChild) {
    dataKind = "UserData";
    flatten(userData.firstElementChild, "", data);
  }

  // message
  let message = rendering ? clean(rt("Message")) : "";
  const rendered = !!message;
  let firstLine: string;
  if (rendered) {
    message = message.replace(/\s+$/, "");
    firstLine = firstLineOf(message);
  } else {
    const values = data.map((d) => d[1].trim()).filter(Boolean);
    message =
      `The description for Event ID ${eventId} from source ${provider || "(unknown)"} cannot be found. ` +
      "Either the component that raises this event isn't installed on this computer or the installation is corrupted." +
      (values.length ? `\n\nThe following information was included with the event:\n\n${values.join("\n")}` : "");
    firstLine = data
      .slice(0, 6)
      .map(([k, v]) => (k && !k.startsWith("Data") ? `${k}: ${v.trim()}` : v.trim()))
      .filter(Boolean)
      .join(" · ")
      .slice(0, 400);
  }

  // level, audit
  let kind: LevelKind;
  const hi = hiKeywords(keywords);
  if ((level === 0 || level === 4) && hi & 0x0010) kind = "auditFailure";
  else if ((level === 0 || level === 4) && hi & 0x0020) kind = "auditSuccess";
  else kind = level === 1 ? "critical" : level === 2 ? "error" : level === 3 ? "warning" : level === 5 ? "verbose" : "info";
  const levelName = rt("Level") || LEVEL_NAMES[level] || `Level ${level}`;

  const kwNames = r.Keywords
    ? Array.from(r.Keywords.children)
        .map((k) => k.textContent?.trim() ?? "")
        .filter(Boolean)
        .join(", ")
    : "";

  const ev: Ev = {
    key: recordId > 0 ? recordId : --fallbackKey,
    xml,
    provider,
    source: shortProvider(provider),
    eventId,
    version: num(t("Version")),
    level,
    levelName,
    kind,
    task,
    taskName: rt("Task") || (task ? `(${task})` : "None"),
    opcode,
    opcodeName: rt("Opcode") || (opcode ? String(opcode) : "Info"),
    keywords,
    keywordNames: kwNames || (hi & 0x0080 ? "Classic" : keywords && /^0x0*$/i.test(keywords) ? "" : keywords),
    time: parseTime(a("TimeCreated", "SystemTime")),
    timeRaw: a("TimeCreated", "SystemTime"),
    recordId,
    activityId: a("Correlation", "ActivityID"),
    relatedActivityId: a("Correlation", "RelatedActivityID"),
    pid: optNum(a("Execution", "ProcessID")),
    tid: optNum(a("Execution", "ThreadID")),
    channel: t("Channel") || fallbackChannel,
    computer: t("Computer"),
    userSid,
    user: userSid ? friendlySid(userSid) : "",
    message,
    firstLine,
    rendered,
    data,
    dataKind,
    sys: null,
  };
  if (!system) {
    ev.message = "This event couldn't be read (its XML isn't valid).";
    ev.firstLine = ev.message;
  }
  if (provider === SYSMON_PROVIDER && dataKind === "EventData") {
    const map = new Map(data);
    ev.sys = sysmonInfo(eventId, (n) => map.get(n)?.trim() ?? "");
  }
  return ev;
}

/**
 * The process an event is about: Sysmon's ProcessId (SourceProcessId for 8/10), a
 * ProcessId / NewProcessId data field (Security 4688/4689 …), else the writer's
 * (System/Execution ProcessID).
 */
export function eventPid(e: Ev): number | null {
  if (e.sys?.pid) return e.sys.pid;
  const p = e.data.find(([k]) => k === "ProcessId" || k === "NewProcessId");
  if (p) {
    const v = p[1].trim();
    const n = /^0x/i.test(v) ? parseInt(v, 16) : Number(v);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return e.pid && e.pid > 0 ? e.pid : null;
}

/** A plain object for "Copy as JSON". */
export function eventJson(e: Ev): Record<string, unknown> {
  const data: Record<string, string> = {};
  for (const [k, v] of e.data) data[k] = v;
  return {
    channel: e.channel,
    recordId: e.recordId,
    provider: e.provider,
    eventId: e.eventId,
    version: e.version,
    level: e.level,
    levelName: e.levelName,
    task: e.task,
    taskName: e.taskName,
    opcode: e.opcode,
    opcodeName: e.opcodeName,
    keywords: e.keywords,
    keywordNames: e.keywordNames,
    timeCreated: e.timeRaw,
    computer: e.computer,
    userSid: e.userSid || null,
    processId: e.pid,
    threadId: e.tid,
    activityId: e.activityId || null,
    relatedActivityId: e.relatedActivityId || null,
    message: e.message,
    [e.dataKind ?? "EventData"]: data,
  };
}
