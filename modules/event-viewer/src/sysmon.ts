// What Sysmon's events mean, and the one-line summary the Sysmon view shows for each.

export const SYSMON_CHANNEL = "Microsoft-Windows-Sysmon/Operational";
export const SYSMON_PROVIDER = "Microsoft-Windows-Sysmon";

export const SYSMON_EVENTS: Record<number, string> = {
  1: "Process Create",
  2: "File creation time changed",
  3: "Network connection",
  4: "Sysmon state changed",
  5: "Process terminated",
  6: "Driver loaded",
  7: "Image loaded",
  8: "CreateRemoteThread",
  9: "RawAccessRead",
  10: "ProcessAccess",
  11: "FileCreate",
  12: "Registry object added/deleted",
  13: "Registry value set",
  14: "Registry object renamed",
  15: "FileCreateStreamHash",
  16: "Config change",
  17: "Pipe created",
  18: "Pipe connected",
  19: "WMI filter",
  20: "WMI consumer",
  21: "WMI binding",
  22: "DNS query",
  23: "File delete archived",
  24: "Clipboard change",
  25: "Process tampering",
  26: "File delete logged",
  27: "File block executable",
  28: "File block shredding",
  29: "File executable detected",
  255: "Error",
};

/** A rough family per event, for the colour of its ID badge. */
export function sysmonFamily(id: number): "process" | "network" | "file" | "registry" | "image" | "other" | "error" {
  switch (id) {
    case 1:
    case 5:
    case 8:
    case 10:
    case 25:
      return "process";
    case 3:
    case 22:
      return "network";
    case 2:
    case 11:
    case 15:
    case 23:
    case 26:
    case 27:
    case 28:
    case 29:
      return "file";
    case 12:
    case 13:
    case 14:
      return "registry";
    case 6:
    case 7:
      return "image";
    case 255:
      return "error";
    default:
      return "other";
  }
}

export interface SysmonInfo {
  name: string;
  image: string;
  details: string;
  user: string;
  pid: number | null;
  parentImage: string;
  parentCommandLine: string;
  hashes: string;
  processGuid: string;
  ruleName: string;
}

const dash = (v: string) => (v === "-" ? "" : v);

export function baseName(path: string): string {
  const i = Math.max(path.lastIndexOf("\\"), path.lastIndexOf("/"));
  return i >= 0 ? path.slice(i + 1) : path;
}

export function dirName(path: string): string {
  const i = Math.max(path.lastIndexOf("\\"), path.lastIndexOf("/"));
  return i >= 0 ? path.slice(0, i + 1) : "";
}

/** "type:  5 edge.net;::ffff:23.1.2.3;" → "edge.net, 23.1.2.3" */
function dnsResults(v: string): string {
  return v
    .split(";")
    .map((s) => s.trim().replace(/^type:\s*\d+\s*/, "").replace(/^::ffff:/, ""))
    .filter(Boolean)
    .join(", ");
}

function signed(get: (n: string) => string): string {
  const parts = [get("ImageLoaded")];
  const s = get("Signed");
  if (s) parts.push(s === "true" ? "Signed" : "Unsigned");
  const sig = dash(get("Signature"));
  const status = get("SignatureStatus");
  if (sig) parts.push(status && status !== "Valid" ? `${sig} (${status})` : sig);
  else if (status && status !== "Valid") parts.push(status);
  return parts.filter(Boolean).join(" · ");
}

function details(id: number, get: (n: string) => string): string {
  switch (id) {
    case 1:
      return get("CommandLine");
    case 2:
      return `${get("TargetFilename")} (${get("PreviousCreationUtcTime")} → ${get("CreationUtcTime")})`;
    case 3: {
      const host = dash(get("DestinationHostname"));
      return `${get("Protocol")} ${get("SourceIp")}:${get("SourcePort")} → ${get("DestinationIp")}:${get("DestinationPort")}${host ? ` (${host})` : ""}`;
    }
    case 4:
      return [get("State"), get("Version"), get("SchemaVersion") && `schema ${get("SchemaVersion")}`].filter(Boolean).join(" · ");
    case 6:
    case 7:
      return signed(get);
    case 8: {
      const fn = [dash(get("StartModule")) && baseName(get("StartModule")), dash(get("StartFunction"))].filter(Boolean).join("!");
      return `${baseName(get("SourceImage"))} → ${get("TargetImage")}${fn ? ` (${fn})` : get("StartAddress") ? ` (${get("StartAddress")})` : ""}`;
    }
    case 9:
      return get("Device");
    case 10:
      return `${baseName(get("SourceImage"))} → ${get("TargetImage")} (${get("GrantedAccess")})`;
    case 11:
    case 23:
    case 26:
    case 27:
    case 28:
    case 29:
      return get("TargetFilename");
    case 12:
      return `${get("EventType")}: ${get("TargetObject")}`;
    case 13:
      return `${get("TargetObject")} = ${get("Details")}`;
    case 14:
      return `${get("TargetObject")} → ${get("NewName")}`;
    case 15:
      return get("TargetFilename");
    case 16:
      return get("Configuration");
    case 17:
    case 18:
      return get("PipeName");
    case 19:
      return `${get("Name")}: ${get("Query")}`;
    case 20:
      return `${get("Name")} (${get("Type")}): ${get("Destination")}`;
    case 21:
      return `${get("Filter")} → ${get("Consumer")}`;
    case 22: {
      const r = dnsResults(get("QueryResults"));
      return `${get("QueryName")}${r ? ` → ${r}` : get("QueryStatus") && get("QueryStatus") !== "0" ? ` (status ${get("QueryStatus")})` : ""}`;
    }
    case 24:
      return [get("ClientInfo"), get("Hashes")].filter((v) => dash(v)).join(" · ");
    case 25:
      return get("Type");
    case 255:
      return `${get("ID")}: ${get("Description")}`;
    default:
      return "";
  }
}

/** The Sysmon view's columns for one event; `get` reads an EventData field ("" when missing). */
export function sysmonInfo(id: number, get: (n: string) => string): SysmonInfo {
  const viaSource = id === 8 || id === 10;
  const pid = Number(get(viaSource ? "SourceProcessId" : "ProcessId"));
  return {
    name: SYSMON_EVENTS[id] ?? `Event ${id}`,
    image: viaSource ? get("SourceImage") : get("Image"),
    details: details(id, get),
    user: get(viaSource ? "SourceUser" : "User") || get("User"),
    pid: get(viaSource ? "SourceProcessId" : "ProcessId") && Number.isFinite(pid) ? pid : null,
    parentImage: get("ParentImage"),
    parentCommandLine: get("ParentCommandLine"),
    hashes: get("Hashes") || get("Hash"),
    // event 10 spells it SourceProcessGUID
    processGuid: viaSource ? get("SourceProcessGuid") || get("SourceProcessGUID") : get("ProcessGuid"),
    ruleName: dash(get("RuleName")),
  };
}
