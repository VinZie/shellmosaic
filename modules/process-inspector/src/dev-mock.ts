// Sample data for `node modules/build.mjs --dev process-inspector`, in exactly the
// shapes of shared/api.ts. Three processes are modelled in depth:
//   explorer.exe (4812)   x64, Medium, signed; ~120 modules, ~80 threads (2 suspended),
//                         ~600 handles (one Process handle with VM_READ into game.exe)
//   game.exe (7340)       32-bit (WOW64), unsigned, an injected DLL from %TEMP%,
//                         private RWX regions and a thread starting inside one
//   MsMpEng.exe (3120)    PPL (Antimalware): partial overview; modules, handles,
//                         memory and token are denied unless ?admin
// Every other process gets plausible generated data. updater_helper.exe (9460) has
// exited by the time you inspect it; Spotify.exe (9700) is big (~3 000 handles, ~1 500
// memory regions) to check the tables stay smooth; Notepad.exe (9620) exits 20 s after
// you first inspect it. URL: ?admin, ?light, ?args={"pid":7340},
// ?deny=process.control (pretend the user didn't grant it).
import type {
  MemRegion,
  Mitigation,
  PaneContext,
  PriorityClass,
  ProcHandle,
  ProcListItem,
  ProcModule,
  ProcOverview,
  ProcThread,
  ProcToken,
  Signature,
  TokenGroup,
  TokenPrivilege,
} from "../../shared/api";
import { installMock } from "../../shared/mock";

// ── basics ──────────────────────────────────────────────────────────────

function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
type Rand = () => number;
const int = (r: Rand, lo: number, hi: number) => lo + Math.floor(r() * (hi - lo + 1));
const pick = <T>(r: Rand, a: readonly T[]): T => a[Math.floor(r() * a.length)];
const hash = (s: string) => {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
};
const hx = (n: bigint | number) => "0x" + BigInt(n).toString(16).padStart(16, "0");
const page = (n: number) => Math.max(0x1000, Math.ceil(n / 0x1000) * 0x1000);

const params = new URLSearchParams(location.search);
const ADMIN = params.has("admin");
const NOW = Date.now();
const MIN = 60_000;
const HOUR = 60 * MIN;
const USER = "DESKTOP-K7Q2M\\alex";
const USER_SID = "S-1-5-21-3623811015-3361044348-30300820-1001";
const DENIED = "Access denied — run Shellmosaic as administrator to inspect this process";
const later = <T>(v: T, ms = 80) => new Promise<T>((res) => setTimeout(() => res(structuredClone(v)), ms));
const fail = (msg: string, ms = 60) => new Promise<never>((_, rej) => setTimeout(() => rej(new Error(msg)), ms));

const SYS32 = "C:\\Windows\\System32\\";
const WOW = "C:\\Windows\\SysWOW64\\";
const MS = "Microsoft Corporation";
const WINVER = "10.0.26100.2454";

// ── the process list ────────────────────────────────────────────────────

type Kind = "user" | "elevated" | "system" | "service";
interface Def {
  pid: number;
  ppid: number;
  name: string;
  exe: string | null;
  kind: Kind;
  mem: number;
  cpu?: number;
  up?: number;
  arch?: string;
  protection?: string;
  cmd?: string;
  pkg?: string;
  appContainer?: boolean;
  /** modelled in depth */
  special?: "explorer" | "game" | "msmpeng" | "exited";
}

const svchost = (pid: number, group: string, kind: Kind = "system"): Def => ({
  pid,
  ppid: 880,
  name: "svchost.exe",
  exe: SYS32 + "svchost.exe",
  kind,
  mem: 6e6 + (hash(group) % 40) * 1e6,
  cmd: `C:\\Windows\\system32\\svchost.exe -k ${group} -p`,
  up: 26 * HOUR,
});

const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const CODE = "C:\\Users\\alex\\AppData\\Local\\Programs\\Microsoft VS Code\\Code.exe";
const DISCORD = "C:\\Users\\alex\\AppData\\Local\\Discord\\app-1.0.9175\\Discord.exe";
const DEFENDER = "C:\\ProgramData\\Microsoft\\Windows Defender\\Platform\\4.18.24090.11-0\\";
const GAME_DIR = "C:\\Games\\Shadowfall\\bin\\";

const DEFS: Def[] = [
  { pid: 4, ppid: 0, name: "System", exe: null, kind: "system", mem: 144e3, cpu: 0.4, up: 26.2 * HOUR },
  { pid: 140, ppid: 4, name: "Registry", exe: null, kind: "system", mem: 61e6, up: 26.2 * HOUR },
  { pid: 512, ppid: 4, name: "smss.exe", exe: SYS32 + "smss.exe", kind: "system", mem: 1.2e6, protection: "PP (WinTcb)", up: 26.2 * HOUR },
  { pid: 704, ppid: 692, name: "csrss.exe", exe: SYS32 + "csrss.exe", kind: "system", mem: 5.8e6, protection: "PPL (WinTcb)", up: 26.1 * HOUR },
  { pid: 788, ppid: 692, name: "wininit.exe", exe: SYS32 + "wininit.exe", kind: "system", mem: 6.9e6, protection: "PPL (WinTcb)", up: 26.1 * HOUR },
  { pid: 796, ppid: 780, name: "csrss.exe", exe: SYS32 + "csrss.exe", kind: "system", mem: 6.2e6, protection: "PPL (WinTcb)", cpu: 0.2, up: 26.1 * HOUR },
  { pid: 880, ppid: 788, name: "services.exe", exe: SYS32 + "services.exe", kind: "system", mem: 11e6, protection: "PPL (WinTcb)", up: 26.1 * HOUR },
  { pid: 900, ppid: 788, name: "lsass.exe", exe: SYS32 + "lsass.exe", kind: "system", mem: 24e6, protection: "PPL (Lsa)", up: 26.1 * HOUR },
  { pid: 1012, ppid: 780, name: "winlogon.exe", exe: SYS32 + "winlogon.exe", kind: "system", mem: 9.6e6, up: 26.1 * HOUR },
  svchost(1080, "DcomLaunch"),
  svchost(1136, "RPCSS", "service"),
  svchost(1240, "LocalServiceNetworkRestricted", "service"),
  svchost(1312, "netsvcs"),
  svchost(1460, "LocalService", "service"),
  svchost(1588, "NetworkService", "service"),
  svchost(1720, "LocalSystemNetworkRestricted"),
  svchost(1844, "appmodel"),
  svchost(2040, "LocalServiceNoNetworkFirewall", "service"),
  svchost(2216, "utcsvc"),
  svchost(2380, "UnistackSvcGroup", "user"),
  svchost(2604, "wsappx"),
  { pid: 1168, ppid: 1012, name: "fontdrvhost.exe", exe: SYS32 + "fontdrvhost.exe", kind: "service", mem: 4.1e6, up: 26 * HOUR },
  { pid: 1380, ppid: 1012, name: "dwm.exe", exe: SYS32 + "dwm.exe", kind: "service", mem: 92e6, cpu: 1.6, up: 26 * HOUR },
  { pid: 2788, ppid: 880, name: "spoolsv.exe", exe: SYS32 + "spoolsv.exe", kind: "system", mem: 8.4e6, up: 26 * HOUR },
  { pid: 3120, ppid: 880, name: "MsMpEng.exe", exe: DEFENDER + "MsMpEng.exe", kind: "system", mem: 212e6, cpu: 0.8, protection: "PPL (Antimalware)", special: "msmpeng", up: 26 * HOUR },
  { pid: 3388, ppid: 880, name: "NisSrv.exe", exe: DEFENDER + "NisSrv.exe", kind: "service", mem: 9e6, up: 26 * HOUR },
  { pid: 3504, ppid: 880, name: "SecurityHealthService.exe", exe: SYS32 + "SecurityHealthService.exe", kind: "system", mem: 7.2e6, up: 26 * HOUR },
  { pid: 3660, ppid: 880, name: "SgrmBroker.exe", exe: SYS32 + "SgrmBroker.exe", kind: "system", mem: 5e6, protection: "PPL (WinTcb)", up: 26 * HOUR },
  { pid: 4812, ppid: 4790, name: "explorer.exe", exe: "C:\\Windows\\explorer.exe", kind: "user", mem: 168e6, cpu: 0.6, special: "explorer", cmd: "C:\\Windows\\Explorer.EXE", up: 25.9 * HOUR },
  { pid: 5020, ppid: 1312, name: "sihost.exe", exe: SYS32 + "sihost.exe", kind: "user", mem: 28e6, up: 25.9 * HOUR },
  { pid: 5068, ppid: 1312, name: "taskhostw.exe", exe: SYS32 + "taskhostw.exe", kind: "user", mem: 14e6, cmd: "taskhostw.exe {222A245B-E637-4AE9-A93F-A59CA119A75E}", up: 25.9 * HOUR },
  { pid: 5240, ppid: 1240, name: "ctfmon.exe", exe: SYS32 + "ctfmon.exe", kind: "user", mem: 18e6, up: 25.9 * HOUR },
  {
    pid: 5432,
    ppid: 1080,
    name: "StartMenuExperienceHost.exe",
    exe: "C:\\Windows\\SystemApps\\Microsoft.Windows.StartMenuExperienceHost_cw5n1h2txyewy\\StartMenuExperienceHost.exe",
    kind: "user",
    mem: 74e6,
    pkg: "Microsoft.Windows.StartMenuExperienceHost_10.0.26100.2454_neutral_neutral_cw5n1h2txyewy",
    appContainer: true,
    up: 25.9 * HOUR,
  },
  { pid: 5560, ppid: 1080, name: "RuntimeBroker.exe", exe: SYS32 + "RuntimeBroker.exe", kind: "user", mem: 21e6, cmd: "C:\\Windows\\System32\\RuntimeBroker.exe -Embedding", up: 25.9 * HOUR },
  { pid: 5580, ppid: 1080, name: "RuntimeBroker.exe", exe: SYS32 + "RuntimeBroker.exe", kind: "user", mem: 9e6, cmd: "C:\\Windows\\System32\\RuntimeBroker.exe -Embedding", up: 25.8 * HOUR },
  { pid: 5600, ppid: 1080, name: "RuntimeBroker.exe", exe: SYS32 + "RuntimeBroker.exe", kind: "user", mem: 7e6, cmd: "C:\\Windows\\System32\\RuntimeBroker.exe -Embedding", up: 3 * HOUR },
  {
    pid: 5712,
    ppid: 1080,
    name: "SearchHost.exe",
    exe: "C:\\Windows\\SystemApps\\MicrosoftWindows.Client.CBS_cw5n1h2txyewy\\SearchHost.exe",
    kind: "user",
    mem: 132e6,
    pkg: "MicrosoftWindows.Client.CBS_1000.26100.27.0_x64__cw5n1h2txyewy",
    appContainer: true,
    cmd: '"C:\\Windows\\SystemApps\\MicrosoftWindows.Client.CBS_cw5n1h2txyewy\\SearchHost.exe" -ServerName:CortanaUI.AppX8z9r6jm96hw4bsbneegw0kyxx296wr9t.mca',
    up: 25.9 * HOUR,
  },
  { pid: 5904, ppid: 1080, name: "ShellExperienceHost.exe", exe: "C:\\Windows\\SystemApps\\ShellExperienceHost_cw5n1h2txyewy\\ShellExperienceHost.exe", kind: "user", mem: 48e6, appContainer: true, up: 25.9 * HOUR },
  { pid: 6120, ppid: 4812, name: "SecurityHealthSystray.exe", exe: SYS32 + "SecurityHealthSystray.exe", kind: "user", mem: 6e6, up: 25.9 * HOUR },
  { pid: 6244, ppid: 4812, name: "OneDrive.exe", exe: "C:\\Users\\alex\\AppData\\Local\\Microsoft\\OneDrive\\OneDrive.exe", kind: "user", mem: 64e6, cmd: '"C:\\Users\\alex\\AppData\\Local\\Microsoft\\OneDrive\\OneDrive.exe" /background', up: 25.9 * HOUR },
  { pid: 6388, ppid: 4812, name: "msedge.exe", exe: EDGE, kind: "user", mem: 188e6, cpu: 1.1, cmd: `"${EDGE}" --no-startup-window --win-session-start`, up: 25.8 * HOUR },
  ...[6420, 6512, 6604, 6720, 6888].map(
    (pid, i): Def => ({ pid, ppid: 6388, name: "msedge.exe", exe: EDGE, kind: "user", mem: (40 + i * 23) * 1e6, cpu: i === 2 ? 2.4 : 0.1, cmd: `"${EDGE}" --type=${i === 0 ? "gpu-process" : i === 1 ? "utility --utility-sub-type=network.mojom.NetworkService" : "renderer"} --lang=en-US`, up: 25.8 * HOUR - i * HOUR }),
  ),
  { pid: 7012, ppid: 4812, name: "Code.exe", exe: CODE, kind: "user", mem: 156e6, cpu: 0.9, up: 6 * HOUR },
  ...[7056, 7120, 7188].map((pid, i): Def => ({ pid, ppid: 7012, name: "Code.exe", exe: CODE, kind: "user", mem: (90 + i * 60) * 1e6, cpu: 0.3, cmd: `"${CODE}" --type=${["gpu-process", "renderer", "utility"][i]}`, up: 6 * HOUR })),
  { pid: 7240, ppid: 4812, name: "steam.exe", exe: "C:\\Program Files (x86)\\Steam\\steam.exe", kind: "user", mem: 96e6, cpu: 0.4, arch: "x86 (WOW64)", cmd: '"C:\\Program Files (x86)\\Steam\\steam.exe" -silent', up: 25.8 * HOUR },
  {
    pid: 7340,
    ppid: 7240,
    name: "game.exe",
    exe: GAME_DIR + "game.exe",
    kind: "user",
    mem: 1.62e9,
    cpu: 14.2,
    arch: "x86 (WOW64)",
    special: "game",
    cmd: `"${GAME_DIR}game.exe" -steam -novid -dx9 +connect 185.25.182.77:27015`,
    up: 47 * MIN,
  },
  { pid: 7488, ppid: 7240, name: "steamwebhelper.exe", exe: "C:\\Program Files (x86)\\Steam\\bin\\cef\\cef.win64\\steamwebhelper.exe", kind: "user", mem: 82e6, up: 25.8 * HOUR },
  ...[7612, 7660, 7704].map((pid, i): Def => ({ pid, ppid: i ? 7612 : 4812, name: "Discord.exe", exe: DISCORD, kind: "user", mem: (70 + i * 45) * 1e6, cpu: 0.2, up: 25.7 * HOUR })),
  { pid: 8020, ppid: 4812, name: "shellmosaic.exe", exe: "C:\\Program Files\\Shellmosaic\\shellmosaic.exe", kind: "user", mem: 118e6, cpu: 1.4, up: 2 * HOUR },
  { pid: 8104, ppid: 8020, name: "pwsh.exe", exe: "C:\\Program Files\\PowerShell\\7\\pwsh.exe", kind: "user", mem: 86e6, cmd: '"C:\\Program Files\\PowerShell\\7\\pwsh.exe" -NoLogo', up: 2 * HOUR },
  { pid: 8150, ppid: 8104, name: "conhost.exe", exe: SYS32 + "conhost.exe", kind: "user", mem: 7e6, cmd: "\\??\\C:\\Windows\\system32\\conhost.exe 0x4", up: 2 * HOUR },
  {
    pid: 8812,
    ppid: 4812,
    name: "cheatengine-x86_64.exe",
    exe: "C:\\Users\\alex\\Downloads\\CheatEngine75\\cheatengine-x86_64.exe",
    kind: "elevated",
    mem: 58e6,
    cpu: 3.1,
    up: 31 * MIN,
  },
  { pid: 9120, ppid: 1080, name: "WmiPrvSE.exe", exe: SYS32 + "wbem\\WmiPrvSE.exe", kind: "service", mem: 12e6, up: 5 * MIN },
  { pid: 9244, ppid: 1080, name: "dllhost.exe", exe: SYS32 + "dllhost.exe", kind: "user", mem: 9e6, cmd: "C:\\Windows\\system32\\DllHost.exe /Processid:{AB8902B4-09CA-4BB6-B78D-A8F59079A8D5}", up: 12 * MIN },
  { pid: 9388, ppid: 2040, name: "audiodg.exe", exe: SYS32 + "audiodg.exe", kind: "service", mem: 15e6, cpu: 0.3, up: 47 * MIN },
  { pid: 9460, ppid: 4812, name: "updater_helper.exe", exe: "C:\\Users\\alex\\AppData\\Local\\Temp\\updater_helper.exe", kind: "user", mem: 3e6, special: "exited", up: 20_000 },
  {
    pid: 9620,
    ppid: 4812,
    name: "Notepad.exe",
    exe: "C:\\Program Files\\WindowsApps\\Microsoft.WindowsNotepad_11.2409.9.0_x64__8wekyb3d8bbwe\\Notepad\\Notepad.exe",
    kind: "user",
    mem: 41e6,
    pkg: "Microsoft.WindowsNotepad_11.2409.9.0_x64__8wekyb3d8bbwe",
    up: 40 * MIN,
  },
  { pid: 9700, ppid: 4812, name: "Spotify.exe", exe: "C:\\Users\\alex\\AppData\\Roaming\\Spotify\\Spotify.exe", kind: "user", mem: 210e6, cpu: 0.7, up: 25.7 * HOUR },
];
const byPid = new Map(DEFS.map((d) => [d.pid, d]));

// ── signatures ──────────────────────────────────────────────────────────

function signatureOf(path: string): Signature {
  const p = path.toLowerCase();
  const valid = (signer: string, catalog = false): Signature => ({ status: "valid", detail: "Signed", signer, catalog });
  if (p.includes("\\temp\\") || p.endsWith("game.exe") || p.includes("binkw32") || p.includes("7-zip") || p.includes("shellmosaic")) return { status: "unsigned", detail: "Not signed", signer: null, catalog: false };
  if (p.endsWith("fmod.dll")) return { status: "invalid", detail: "The file was changed after it was signed", signer: "Firelight Technologies Pty Ltd", catalog: false };
  if (p.includes("steam")) return valid("Valve Corp.");
  if (p.includes("physx")) return valid("NVIDIA Corporation");
  if (p.includes("driverstore") && (p.includes("nv") || p.includes("nvidia"))) return valid("NVIDIA Corporation");
  if (p.includes("windows defender")) return valid("Microsoft Windows Publisher");
  if (p.includes("onedrive") || p.includes("edge") || p.includes("vs code") || p.includes("windowsapps") || p.includes("d3dx9") || p.includes("powershell")) return valid(MS);
  if (p.includes("discord")) return valid("Discord Inc.");
  if (p.includes("spotify")) return valid("Spotify AB");
  if (p.includes("cheatengine")) return valid("Cheat Engine");
  if (p.startsWith("c:\\windows\\")) return valid("Microsoft Windows", !p.endsWith(".exe") && hash(p) % 3 === 0);
  return { status: "unknown", detail: "No signature information", signer: null, catalog: false };
}

// ── modules ─────────────────────────────────────────────────────────────

const SYSTEM_DLLS: [string, string][] = [
  ["ntdll.dll", "NT Layer DLL"],
  ["KERNEL32.DLL", "Windows NT BASE API Client DLL"],
  ["KERNELBASE.dll", "Windows NT BASE API Client DLL"],
  ["msvcrt.dll", "Windows NT CRT DLL"],
  ["ucrtbase.dll", "Microsoft® C Runtime Library"],
  ["combase.dll", "Microsoft COM for Windows"],
  ["RPCRT4.dll", "Remote Procedure Call Runtime"],
  ["sechost.dll", "Host for SCM/SDDL/LSA Lookup APIs"],
  ["ADVAPI32.dll", "Advanced Windows 32 Base API"],
  ["USER32.dll", "Multi-User Windows USER API Client DLL"],
  ["win32u.dll", "Win32u"],
  ["GDI32.dll", "GDI Client DLL"],
  ["gdi32full.dll", "GDI Client DLL"],
  ["msvcp_win.dll", "Microsoft® C Runtime Library"],
  ["OLEAUT32.dll", "OLEAUT32.DLL"],
  ["SHCORE.dll", "SHCORE"],
  ["SHLWAPI.dll", "Shell Light-weight Utility Library"],
  ["SHELL32.dll", "Windows Shell Common Dll"],
  ["windows.storage.dll", "Microsoft WinRT Storage API"],
  ["wintypes.dll", "Windows Base Types DLL"],
  ["ole32.dll", "Microsoft OLE for Windows"],
  ["IMM32.DLL", "Multi-User Windows IMM32 API Client DLL"],
  ["uxtheme.dll", "Microsoft UxTheme Library"],
  ["propsys.dll", "Microsoft Property System"],
  ["twinapi.appcore.dll", "twinapi.appcore"],
  ["CFGMGR32.dll", "Configuration Manager DLL"],
  ["bcryptPrimitives.dll", "Windows Cryptographic Primitives Library"],
  ["powrprof.dll", "Power Profile Helper DLL"],
  ["UMPDC.dll", "User Mode Power Dependency Coordinator"],
  ["kernel.appcore.dll", "AppModel API Host"],
  ["dwmapi.dll", "Microsoft Desktop Window Manager API"],
  ["Windows.UI.dll", "Windows Runtime UI Foundation DLL"],
  ["TextInputFramework.dll", "TextInputFramework.DYNLINK"],
  ["CoreMessaging.dll", "Microsoft CoreMessaging Dll"],
  ["CoreUIComponents.dll", "Microsoft Core UI Components Dll"],
  ["ntmarta.dll", "Windows NT MARTA provider"],
  ["bcrypt.dll", "Windows Cryptographic Primitives Library"],
  ["CRYPTBASE.DLL", "Base cryptographic API DLL"],
  ["CRYPT32.dll", "Crypto API32"],
  ["MSASN1.dll", "ASN.1 Runtime APIs"],
  ["WINTRUST.dll", "Microsoft Trust Verification APIs"],
  ["sspicli.dll", "Security Support Provider Interface"],
  ["profapi.dll", "User Profile Basic API"],
  ["WTSAPI32.dll", "Windows Remote Desktop Session Host Server SDK APIs"],
  ["WINSTA.dll", "Winstation Library"],
  ["ExplorerFrame.dll", "ExplorerFrame"],
  ["DUser.dll", "Windows DirectUser Engine"],
  ["DUI70.dll", "Windows DirectUI Engine"],
  ["thumbcache.dll", "Microsoft Thumbnail Cache"],
  ["edputil.dll", "EDP util"],
  ["StateRepository.Core.dll", "Windows StateRepository API Core"],
  ["Windows.StateRepositoryPS.dll", "Windows StateRepository API Server file"],
  ["OneCoreUAPCommonProxyStub.dll", "OneCoreUAP Common Proxy Stub"],
  ["actxprxy.dll", "ActiveX Interface Marshaling Library"],
  ["twinui.dll", "TWINUI"],
  ["twinui.appcore.dll", "TWINUI.APPCORE"],
  ["twinui.pcshell.dll", "twinui.pcshell"],
  ["Windows.UI.Immersive.dll", "Windows.UI.Immersive"],
  ["MrmCoreR.dll", "Microsoft Windows MRM"],
  ["cldapi.dll", "Windows Cloud API"],
  ["FirewallAPI.dll", "Windows Defender Firewall API"],
  ["fwbase.dll", "Firewall Base DLL"],
  ["dxgi.dll", "DirectX Graphics Infrastructure"],
  ["d3d11.dll", "Direct3D 11 Runtime"],
  ["d2d1.dll", "Microsoft D2D Library"],
  ["DWrite.dll", "Microsoft DirectX Typography Services"],
  ["dcomp.dll", "Microsoft DirectComposition Library"],
  ["d3d10warp.dll", "Direct3D Rasterizer"],
  ["MSCTF.dll", "MSCTF Server DLL"],
  ["WindowsCodecs.dll", "Microsoft Windows Codecs Library"],
  ["Windows.Storage.Search.dll", "Windows.Storage.Search"],
  ["StructuredQuery.dll", "Structured Query"],
  ["SearchFolder.dll", "SearchFolder"],
  ["ntshrui.dll", "Shell extensions for sharing"],
  ["srvcli.dll", "Server Service Client DLL"],
  ["cscapi.dll", "Offline Files Win32 API"],
  ["LINKINFO.dll", "Windows Volume Tracking"],
  ["mpr.dll", "Multiple Provider Router DLL"],
  ["netutils.dll", "Net Win32 API Helpers DLL"],
  ["Windows.FileExplorer.Common.dll", "Windows.FileExplorer.Common"],
  ["Windows.CloudStore.Schema.Shell.dll", "Windows.CloudStore.Schema.Shell"],
  ["Windows.Internal.Shell.Broker.dll", "Windows.Internal.Shell.Broker"],
  ["AppResolver.dll", "App Resolver"],
  ["Bcp47Langs.dll", "BCP47 Language Classes"],
  ["TileDataRepository.dll", "Tile Data Repository"],
  ["AppExtension.dll", "AppExtension"],
  ["usermgrcli.dll", "UserMgr API DLL"],
  ["sxs.dll", "Fusion 2.5"],
  ["iertutil.dll", "Run time utility for Internet Explorer"],
  ["urlmon.dll", "OLE32 Extensions for Win32"],
  ["netprofm.dll", "Network List Manager"],
  ["npmproxy.dll", "Network List Manager Proxy"],
  ["NotificationController.dll", "NotificationController.dll"],
  ["wpnapps.dll", "Windows Push Notification Apps"],
  ["ninput.dll", "Microsoft Pen and Touch Input Component"],
  ["InputHost.dll", "InputHost"],
  ["MMDevApi.dll", "MMDevice API"],
  ["AudioSes.DLL", "Audio Session"],
  ["avrt.dll", "Multimedia Realtime Runtime"],
  ["dbghelp.dll", "Windows Image Helper"],
  ["dbgcore.DLL", "Windows Core Debugging Helpers"],
  ["PhotoMetadataHandler.dll", "Photo Metadata Handler"],
  ["WININET.dll", "Internet Extensions for Win32"],
  ["NSI.dll", "NSI User-mode interface DLL"],
  ["IPHLPAPI.DLL", "IP Helper API"],
  ["WINHTTP.dll", "Windows HTTP Services"],
  ["dhcpcsvc.DLL", "DHCP Client Service"],
  ["Secur32.dll", "Security Support Provider Interface"],
  ["USERENV.dll", "Userenv"],
  ["VERSION.dll", "Version Checking and File Installation Libraries"],
  ["SETUPAPI.dll", "Windows Setup API"],
  ["DEVOBJ.dll", "Device Information Set DLL"],
  ["HID.DLL", "Hid User Library"],
  ["WINMM.dll", "MCI API DLL"],
  ["oleacc.dll", "Active Accessibility Core Component"],
  ["UIAutomationCore.DLL", "Microsoft UI Automation Core"],
  ["IconCodecService.dll", "Converts a PNG part of the icon to a legacy bmp icon"],
  ["Windows.System.Launcher.dll", "Windows.System.Launcher"],
];

interface ModSpec {
  name: string;
  path: string;
  description: string | null;
  company: string | null;
  version: string | null;
}

const sysMod = ([name, description]: [string, string], dir = SYS32): ModSpec => ({ name, path: dir + name, description, company: MS, version: WINVER });

function layoutModules(specs: ModSpec[], mainBase: bigint, dllBase: bigint, r: Rand): ProcModule[] {
  let next = dllBase;
  return specs.map((s, i) => {
    const size = page(0x9000 + (hash(s.name) % 0x1f0) * 0x1000 + (s.name.toLowerCase().startsWith("ntdll") ? 0x150000 : 0));
    let base: bigint;
    if (i === 0) base = mainBase;
    else {
      base = next;
      next += BigInt(Math.ceil(size / 0x10000) * 0x10000 + int(r, 1, 6) * 0x10000);
    }
    return { name: s.name, path: s.path, base: hx(base), size, isMain: i === 0, description: s.description, company: s.company, version: s.version };
  });
}

// ── threads ─────────────────────────────────────────────────────────────

function symbolAt(mods: ProcModule[], name: string, off: number): { addr: string; sym: string } {
  const m = mods.find((x) => x.name.toLowerCase() === name.toLowerCase()) ?? mods[0];
  const o = off % Math.max(0x1000, m.size - 0x100);
  return { addr: hx(BigInt(m.base) + BigInt(o)), sym: `${m.name}+0x${o.toString(16)}` };
}

const WAITS = ["WrQueue", "WrQueue", "WrQueue", "UserRequest", "UserRequest", "UserRequest", "WrUserRequest", "WrUserRequest", "WrAlertByThreadId", "DelayExecution", "Executive"];

interface ThreadSpec {
  win32?: [string, number];
  win32Raw?: string;
  description?: string | null;
  priority?: number;
}

function makeThreads(r: Rand, mods: ProcModule[], start: number, specs: ThreadSpec[], suspendedCount = 0, wow = false): ProcThread[] {
  const tids = new Set<number>();
  const rtl = symbolAt(mods, "ntdll.dll", wow ? 0x7a2e0 : 0x5af28);
  return specs.map((s, i) => {
    let tid: number;
    do tid = int(r, 250, 9000) * 4;
    while (tids.has(tid));
    tids.add(tid);
    const w = s.win32Raw ? { addr: s.win32Raw, sym: null } : s.win32 ? symbolAt(mods, s.win32[0], s.win32[1]) : null;
    const running = i === 1 && !suspendedCount;
    const ready = i === 5;
    const susp = i >= specs.length - suspendedCount;
    const base = s.priority ?? 8;
    return {
      tid,
      startAddress: rtl.addr,
      startSymbol: rtl.sym,
      win32StartAddress: w?.addr ?? null,
      win32StartSymbol: w?.sym ?? null,
      state: susp ? "Waiting" : running ? "Running" : ready ? "Ready" : "Waiting",
      waitReason: susp ? "Suspended" : running || ready ? null : pick(r, WAITS),
      priority: base + (r() < 0.2 ? int(r, 1, 2) : 0),
      basePriority: base,
      contextSwitches: int(r, 12, i < 4 ? 900_000 : 60_000),
      kernelMs: int(r, 0, i < 4 ? 40_000 : 900),
      userMs: int(r, 0, i < 4 ? 160_000 : 2400),
      createTime: start + (i === 0 ? 40 : int(r, 500, Math.max(1000, NOW - start - 5000))),
      description: s.description ?? null,
      suspendCount: susp ? 1 : 0,
      suspended: susp,
    };
  });
}

// ── handles ─────────────────────────────────────────────────────────────

type HandleSeed = Omit<ProcHandle, "handle" | "handleCount" | "pointerCount" | "attributes"> & { attributes?: number };

function finishHandles(r: Rand, seeds: HandleSeed[]): ProcHandle[] {
  // the handle table isn't grouped by type: shuffle, then number them in order
  const list = [...seeds];
  for (let i = list.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [list[i], list[j]] = [list[j], list[i]];
  }
  let h = 4;
  return list.map((s) => {
    h += 4 * (r() < 0.12 ? int(r, 2, 6) : 1);
    return {
      ...s,
      handle: "0x" + h.toString(16),
      attributes: s.attributes ?? (r() < 0.04 ? 0x2 : 0),
      handleCount: int(r, 1, s.type === "Key" || s.type === "Directory" ? 60 : 8),
      pointerCount: int(r, 1, 32_000),
    };
  });
}

const REG_KEYS = [
  "HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Explorer\\FolderDescriptions",
  "HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Image File Execution Options",
  "HKLM\\SYSTEM\\ControlSet001\\Control\\Nls\\Sorting\\Versions",
  "HKLM\\SYSTEM\\ControlSet001\\Control\\Session Manager",
  "HKLM\\SOFTWARE\\Microsoft\\Ole",
  "HKLM\\SOFTWARE\\Classes",
  "HKLM\\SOFTWARE\\Policies\\Microsoft\\Windows",
  "HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Explorer\\ShellIconOverlayIdentifiers",
  "HKCU",
  "HKCU\\Software\\Classes",
  "HKCU\\Software\\Classes\\Local Settings\\Software\\Microsoft\\Windows\\Shell\\BagMRU",
  "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer",
  "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\Advanced",
  "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StuckRects3",
  "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\RecentDocs",
  "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\SessionInfo\\1",
  "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Notifications\\Settings",
  "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize",
  "HKCU\\Control Panel\\Desktop",
  "HKCU\\Control Panel\\International",
  "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings",
  "HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Explorer\\Desktop\\NameSpace",
  "HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Explorer\\MyComputer\\NameSpace",
  "HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion",
  "HKLM\\SYSTEM\\ControlSet001\\Services\\WinSock2\\Parameters\\Protocol_Catalog9",
  "HKLM\\SYSTEM\\ControlSet001\\Services\\Tcpip\\Parameters",
];
const KEY_ACCESS = [0x20019, 0x20019, 0x20019, 0x1, 0x9, 0xf003f, 0x2001f];
const FILE_ACCESS = [0x100001, 0x120089, 0x120089, 0x100020, 0x12019f, 0x100080];

function genericHandles(r: Rand, d: Def, threads: ProcThread[], files: string[], counts: Partial<Record<string, number>>, extra: HandleSeed[] = []): ProcHandle[] {
  const seeds: HandleSeed[] = [...extra];
  const add = (type: string, n: number, name: (i: number) => string | null, access: (i: number) => number) => {
    for (let i = 0; i < n; i++) seeds.push({ type, name: name(i), access: access(i), targetPid: null });
  };
  const sess = d.kind === "system" || d.kind === "service" ? "\\BaseNamedObjects" : "\\Sessions\\1\\BaseNamedObjects";
  const c = (k: string, def: number) => counts[k] ?? def;
  add("File", c("File", 30), (i) => (i < files.length ? files[i] : pick(r, ["\\Device\\DeviceApi", "\\Device\\CNG", "\\Device\\KsecDD", "\\Device\\ConDrv", "\\Device\\NamedPipe\\", `\\Device\\HarddiskVolume3\\Windows\\System32\\en-US\\${d.name}.mui`, null])), () => pick(r, FILE_ACCESS));
  add("Key", c("Key", 40), (i) => REG_KEYS[(i + hash(d.name)) % REG_KEYS.length] + (i >= REG_KEYS.length ? `\\${["Shell", "Defaults", "Cache", "Config"][i % 4]}` : ""), () => pick(r, KEY_ACCESS));
  add("Event", c("Event", 70), (i) => (i % 5 === 0 ? `${sess}\\${pick(r, ["ShellReadyEvent", "SM0:" + d.pid + ":120:WilStaging_02", "WinSta0_DesktopSwitch", "CTF.TimListCache.FMPDefault.SAMDefault"])}_${i}` : null), () => pick(r, [0x1f0003, 0x100002, 0x100003]));
  add("Mutant", c("Mutant", 8), (i) => (i % 2 ? `${sess}\\SM0:${d.pid}:${120 + i}:WilError_03` : null), () => 0x1f0001);
  add("Semaphore", c("Semaphore", 8), (i) => (i % 3 === 0 ? `${sess}\\SM0:${d.pid}:${64 + i}:WilError_03_p0` : null), () => 0x1f0003);
  add("Section", c("Section", 10), (i) => (i % 2 ? `${sess}\\${pick(r, ["windows_shell_global_counters", "__ComCatalogCache__", "Theme1984203", "C:*ProgramData*Microsoft*Windows*Caches*cversions.3.ro"])}` : null), () => pick(r, [0x4, 0x6, 0xf001f]));
  add("ALPC Port", c("ALPC Port", 6), () => null, () => 0x1f0001);
  add("Directory", c("Directory", 3), (i) => ["\\KnownDlls", sess, "\\Sessions\\1\\AppContainerNamedObjects", "\\KnownDlls32"][i % 4], () => pick(r, [0x3, 0xf000f]));
  add("Token", c("Token", 2), () => null, () => pick(r, [0x8, 0xf01ff, 0x2000e]));
  add("WindowStation", c("WindowStation", 2), () => "\\Sessions\\1\\Windows\\WindowStations\\WinSta0", () => 0xf037f);
  add("Desktop", c("Desktop", 1), () => "\\Default", () => 0xf01ff);
  add("IoCompletion", c("IoCompletion", 8), () => null, () => 0x1f0003);
  add("TpWorkerFactory", c("TpWorkerFactory", 3), () => null, () => 0xf00ff);
  add("IRTimer", c("IRTimer", 6), () => null, () => 0x100002);
  add("WaitCompletionPacket", c("WaitCompletionPacket", 14), () => null, () => 0x1);
  add("EtwRegistration", c("EtwRegistration", 30), () => null, () => 0x804);
  add("Timer", c("Timer", 2), () => null, () => 0x1f0003);
  // its own threads
  const own = Math.min(threads.length, c("Thread", 12));
  for (let i = 0; i < own; i++) seeds.push({ type: "Thread", name: `${d.name} (${d.pid}): ${threads[i].tid}`, access: pick(r, [0x1fffff, 0x101fff, 0x1fffff]), targetPid: d.pid });
  seeds.push({ type: "Process", name: `${d.name} (${d.pid})`, access: 0x1fffff, targetPid: d.pid });
  return finishHandles(r, seeds);
}

// ── memory ──────────────────────────────────────────────────────────────

const PROTECT: Record<string, number> = { NA: 0x1, R: 0x2, RW: 0x4, WC: 0x8, X: 0x10, RX: 0x20, RWX: 0x40, WCX: 0x80, "": 0 };
const protectRaw = (p: string) => p.split("+").reduce((acc, part, i) => acc | (i === 0 ? (PROTECT[part] ?? 0) : part === "G" ? 0x100 : part === "NC" ? 0x200 : 0x400), 0);

interface Part {
  size: number;
  state?: "commit" | "reserve";
  protect: string;
  usage?: string | null;
}

class Space {
  regions: MemRegion[] = [];
  alloc(base: bigint, type: MemRegion["type"], allocProtect: string, parts: Part[], usage: string | null = null) {
    let at = base;
    for (const p of parts) {
      const reserved = p.state === "reserve";
      this.regions.push({
        base: hx(at),
        allocationBase: hx(base),
        size: p.size,
        state: reserved ? "reserve" : "commit",
        type,
        protect: reserved ? "" : p.protect,
        protectRaw: reserved ? 0 : protectRaw(p.protect),
        allocationProtect: allocProtect,
        usage: p.usage !== undefined ? p.usage : usage,
      });
      at += BigInt(p.size);
    }
    return at;
  }
  image(m: ProcModule) {
    const total = m.size;
    const text = page(total * 0.58);
    const rdata = page(total * 0.24);
    const data = page(total * 0.06);
    const rest = Math.max(0x1000, total - 0x1000 - text - rdata - data);
    this.alloc(BigInt(m.base), "image", "WCX", [
      { size: 0x1000, protect: "R" },
      { size: text, protect: "RX" },
      { size: rdata, protect: "R" },
      { size: data, protect: hash(m.name) % 4 ? "RW" : "WC" },
      { size: rest, protect: "R" },
    ], m.path);
  }
  /** sorted, with the free gaps between allocations (up to the end of user space) */
  finish(top: bigint): MemRegion[] {
    const list = this.regions.sort((a, b) => (BigInt(a.base) < BigInt(b.base) ? -1 : 1));
    const out: MemRegion[] = [];
    let at = 0n;
    for (const r of list) {
      const b = BigInt(r.base);
      if (b > at) out.push({ base: hx(at), allocationBase: hx(0), size: Number(b - at), state: "free", type: null, protect: "", protectRaw: 0x1, allocationProtect: "", usage: null });
      out.push(r);
      at = b + BigInt(r.size);
    }
    if (top > at) out.push({ base: hx(at), allocationBase: hx(0), size: Number(top - at), state: "free", type: null, protect: "", protectRaw: 0x1, allocationProtect: "", usage: null });
    return out;
  }
}

function genericMemory(r: Rand, mods: ProcModule[], threads: ProcThread[], mapped: string[], wow: boolean, extra?: (s: Space) => void): MemRegion[] {
  const s = new Space();
  s.alloc(0x7ffe0000n, "private", "R", [{ size: 0x1000, protect: "R" }], "USER_SHARED_DATA");
  // PEB and TEBs
  let tebAt = wow ? 0x002d0000n : 0x0000006259000000n;
  tebAt = s.alloc(tebAt, "private", "RW", [{ size: 0x1000, protect: "RW" }], "PEB");
  for (const t of threads) tebAt = s.alloc(tebAt, "private", "RW", [{ size: wow ? 0x3000 : 0x2000, protect: "RW" }], `TEB (TID ${t.tid})`);
  // stacks
  let stackAt = wow ? 0x10000000n : 0x000000625a000000n;
  threads.forEach((t) => {
    const used = page(0x2000 + int(r, 0, 12) * 0x1000);
    const total = wow ? 0x100000 : 0x80000;
    s.alloc(stackAt, "private", "RW", [
      { size: total - used - 0x3000, state: "reserve", protect: "" },
      { size: 0x3000, protect: "RW+G" },
      { size: used, protect: "RW" },
    ], `Stack (TID ${t.tid})`);
    stackAt += BigInt(total) * 2n;
  });
  // heaps
  const heapBase = wow ? 0x00a00000n : 0x0000025f7c400000n;
  for (let i = 0; i < 6; i++) {
    const commit = page(int(r, 0x40, i === 0 ? 0x900 : 0x200) * 0x1000);
    s.alloc(heapBase + BigInt(i) * (wow ? 0x400000n : 0x2000000n), "private", "RW", [
      { size: commit, protect: "RW" },
      { size: 0x100000, state: "reserve", protect: "" },
    ], `Heap ${i}`);
  }
  // other private allocations
  const privBase = wow ? 0x08000000n : 0x0000025f90000000n;
  for (let i = 0; i < 24; i++) {
    s.alloc(privBase + BigInt(i) * 0x200000n, "private", "RW", [
      { size: page(int(r, 1, 0x80) * 0x1000), protect: r() < 0.1 ? "R" : "RW" },
      ...(r() < 0.4 ? [{ size: 0x40000, state: "reserve" as const, protect: "" }] : []),
    ], null);
  }
  // mapped files and sections
  const mapBase = wow ? 0x03000000n : 0x0000025f70000000n;
  [...mapped, null, null, null, null].forEach((path, i) => {
    s.alloc(mapBase + BigInt(i) * 0x100000n, "mapped", path ? "R" : "RW", [{ size: page(int(r, 1, 0xf0) * 0x1000), protect: path ? "R" : "RW" }], path);
  });
  for (const m of mods) s.image(m);
  extra?.(s);
  return s.finish(0x00007ffffffe0000n);
}

// ── token ───────────────────────────────────────────────────────────────

const PRIVS: [string, string][] = [
  ["SeIncreaseQuotaPrivilege", "Adjust memory quotas for a process"],
  ["SeSecurityPrivilege", "Manage auditing and security log"],
  ["SeTakeOwnershipPrivilege", "Take ownership of files or other objects"],
  ["SeLoadDriverPrivilege", "Load and unload device drivers"],
  ["SeSystemProfilePrivilege", "Profile system performance"],
  ["SeSystemtimePrivilege", "Change the system time"],
  ["SeProfileSingleProcessPrivilege", "Profile single process"],
  ["SeIncreaseBasePriorityPrivilege", "Increase scheduling priority"],
  ["SeCreatePagefilePrivilege", "Create a pagefile"],
  ["SeBackupPrivilege", "Back up files and directories"],
  ["SeRestorePrivilege", "Restore files and directories"],
  ["SeShutdownPrivilege", "Shut down the system"],
  ["SeDebugPrivilege", "Debug programs"],
  ["SeSystemEnvironmentPrivilege", "Modify firmware environment values"],
  ["SeChangeNotifyPrivilege", "Bypass traverse checking"],
  ["SeRemoteShutdownPrivilege", "Force shutdown from a remote system"],
  ["SeUndockPrivilege", "Remove computer from docking station"],
  ["SeManageVolumePrivilege", "Perform volume maintenance tasks"],
  ["SeImpersonatePrivilege", "Impersonate a client after authentication"],
  ["SeCreateGlobalPrivilege", "Create global objects"],
  ["SeIncreaseWorkingSetPrivilege", "Increase a process working set"],
  ["SeTimeZonePrivilege", "Change the time zone"],
  ["SeCreateSymbolicLinkPrivilege", "Create symbolic links"],
  ["SeDelegateSessionUserImpersonatePrivilege", "Obtain an impersonation token for another user in the same session"],
];
const SYSTEM_ONLY: [string, string][] = [
  ["SeAssignPrimaryTokenPrivilege", "Replace a process level token"],
  ["SeTcbPrivilege", "Act as part of the operating system"],
  ["SeLockMemoryPrivilege", "Lock pages in memory"],
  ["SeCreatePermanentPrivilege", "Create permanent shared objects"],
  ["SeAuditPrivilege", "Generate security audits"],
  ["SeTrustedCredManAccessPrivilege", "Access Credential Manager as a trusted caller"],
];
const STANDARD_USER = new Set(["SeShutdownPrivilege", "SeChangeNotifyPrivilege", "SeUndockPrivilege", "SeIncreaseWorkingSetPrivilege", "SeTimeZonePrivilege"]);

const F: Record<string, number> = { Mandatory: 0x1, EnabledByDefault: 0x2, Enabled: 0x4, Owner: 0x8, DenyOnly: 0x10, Integrity: 0x20, IntegrityEnabled: 0x40, Resource: 0x20000000, LogonId: 0xc0000000 };
const group = (name: string | null, sid: string, flags: string[]): TokenGroup => ({ name, sid, flags, attributes: flags.reduce((a, f) => (a | F[f]) >>> 0, 0) });
const ON = ["Mandatory", "EnabledByDefault", "Enabled"];

function makeToken(d: Def): ProcToken {
  const r = rng(d.pid * 31);
  const sys = d.kind === "system";
  const svc = d.kind === "service";
  const high = d.kind === "elevated";
  const logon = `0x${(0x2c0000 + (hash(d.name) % 0xffff)).toString(16)}`;
  const integrity = sys || svc ? ["System", 0x4000, "S-1-16-16384"] : high ? ["High", 0x3000, "S-1-16-12288"] : d.appContainer ? ["Low", 0x1000, "S-1-16-4096"] : ["Medium", 0x2000, "S-1-16-8192"];
  const user = sys ? "NT AUTHORITY\\SYSTEM" : svc ? (hash(d.name) % 2 ? "NT AUTHORITY\\LOCAL SERVICE" : "NT AUTHORITY\\NETWORK SERVICE") : USER;
  const userSid = sys ? "S-1-5-18" : svc ? (user.endsWith("LOCAL SERVICE") ? "S-1-5-19" : "S-1-5-20") : USER_SID;
  const groups: TokenGroup[] = sys
    ? [
        group("BUILTIN\\Administrators", "S-1-5-32-544", ["EnabledByDefault", "Enabled", "Owner"]),
        group("Everyone", "S-1-1-0", ON),
        group("NT AUTHORITY\\Authenticated Users", "S-1-5-11", ON),
        group(`Mandatory Label\\System Mandatory Level`, "S-1-16-16384", ["Integrity", "IntegrityEnabled"]),
      ]
    : [
        group("DESKTOP-K7Q2M\\None", `${USER_SID.slice(0, -5)}-513`, ON),
        group("Everyone", "S-1-1-0", ON),
        group("NT AUTHORITY\\Local account and member of Administrators group", "S-1-5-114", high ? ON : ["DenyOnly"]),
        group("BUILTIN\\Administrators", "S-1-5-32-544", high ? [...ON, "Owner"] : ["DenyOnly"]),
        group("BUILTIN\\Users", "S-1-5-32-545", ON),
        group("BUILTIN\\Performance Log Users", "S-1-5-32-559", ON),
        group("NT AUTHORITY\\INTERACTIVE", "S-1-5-4", ON),
        group("CONSOLE LOGON", "S-1-2-1", ON),
        group("NT AUTHORITY\\Authenticated Users", "S-1-5-11", ON),
        group("NT AUTHORITY\\This Organization", "S-1-5-15", ON),
        group("MicrosoftAccount\\alex@outlook.com", "S-1-11-96-3623454863-58364-18864-2661722203-1597581903-1225312835-2511459453-1556397606-2735945305-1404291241", ON),
        group("NT AUTHORITY\\Local account", "S-1-5-113", ON),
        group(`NT AUTHORITY\\LogonSessionId_0_${parseInt(logon, 16)}`, `S-1-5-5-0-${parseInt(logon, 16)}`, [...ON, "LogonId"]),
        group("LOCAL", "S-1-2-0", ON),
        group("NT AUTHORITY\\Cloud Account Authentication", "S-1-5-64-36", ON),
        group(`Mandatory Label\\${integrity[0]} Mandatory Level`, integrity[2] as string, ["Integrity", "IntegrityEnabled"]),
      ];
  const privileges: TokenPrivilege[] = (sys ? [...SYSTEM_ONLY, ...PRIVS] : PRIVS).map(([name, description]) => {
    if (sys) return { name, description, enabled: r() < 0.7 || name === "SeDebugPrivilege", enabledByDefault: true, removed: false };
    const std = STANDARD_USER.has(name);
    if (!high) return { name, description, enabled: name === "SeChangeNotifyPrivilege", enabledByDefault: name === "SeChangeNotifyPrivilege", removed: !std };
    const def = ["SeChangeNotifyPrivilege", "SeCreateGlobalPrivilege", "SeImpersonatePrivilege"].includes(name);
    return { name, description, enabled: def || (d.name.startsWith("cheatengine") && name === "SeDebugPrivilege"), enabledByDefault: def, removed: false };
  });
  const caps = d.appContainer
    ? [
        { name: "APPLICATION PACKAGE AUTHORITY\\Your Internet connection", sid: "S-1-15-3-1" },
        { name: "APPLICATION PACKAGE AUTHORITY\\Your home or work networks", sid: "S-1-15-3-3" },
        { name: null, sid: "S-1-15-3-1024-1065365936-1281604716-3511738428-1654721687-432734479-3232135806-4053264122-3456934681" },
        { name: "NAMED CAPABILITIES\\Packaged Services", sid: "S-1-15-3-1024-2405443489-874036122-4286035555-1823921565-1746547431-2453885448-3625952902-991631256" },
      ]
    : [];
  return {
    user,
    userSid,
    owner: high || sys ? "BUILTIN\\Administrators" : user,
    primaryGroup: sys ? "NT AUTHORITY\\SYSTEM" : "DESKTOP-K7Q2M\\None",
    integrity: integrity[0] as string,
    integrityRid: integrity[1] as number,
    sessionId: sys || svc ? 0 : 1,
    elevated: sys || svc || high,
    elevationType: sys || svc ? "default" : high ? "full" : "limited",
    tokenType: "primary",
    impersonationLevel: null,
    logonId: sys ? "0x3e7" : svc ? "0x3e5" : logon,
    tokenId: `0x${(0x9a00000 + (hash(d.name + d.pid) % 0xfffff)).toString(16)}`,
    source: sys || svc ? "*SYSTEM*" : "User32",
    virtualizationAllowed: !sys && !svc && !high,
    virtualizationEnabled: false,
    uiAccess: d.name === "ctfmon.exe",
    appContainer: !!d.appContainer,
    appContainerSid: d.appContainer ? "S-1-15-2-1861897761-1695161497-2927542615-642690995-327840285-2659745135-2630312742" : null,
    groups: d.appContainer ? groups.filter((g) => !g.flags.includes("Integrity")).concat(group("Mandatory Label\\Low Mandatory Level", "S-1-16-4096", ["Integrity", "IntegrityEnabled"])) : groups,
    privileges: privileges.map(({ name, description, enabled, enabledByDefault, removed }) => ({ name, description, enabled, enabledByDefault, removed })),
    capabilities: caps,
  };
}

// ── mitigations ─────────────────────────────────────────────────────────

function mitigations(kind: "normal" | "legacy" | "hardened"): Mitigation[] {
  const m = (id: string, name: string, enabled: boolean, details: string[] = []): Mitigation => ({ id, name, enabled, details: enabled ? details : [] });
  const hard = kind === "hardened";
  const legacy = kind === "legacy";
  return [
    m("dep", "DEP", true, legacy ? ["ATL thunk emulation"] : ["Permanent"]),
    m("aslr", "ASLR", true, legacy ? ["Bottom-up"] : ["Bottom-up", "High entropy", ...(hard ? ["Force relocate images"] : [])]),
    m("cfg", "Control Flow Guard", !legacy, hard ? ["Strict mode", "Export suppression"] : []),
    m("dynamicCode", "Dynamic code", hard, ["Prohibit dynamic code"]),
    m("strictHandles", "Strict handle checks", hard || kind === "normal", ["Raise exception on invalid handle"]),
    m("systemCalls", "System call filter", hard, ["Disallow Win32k system calls"]),
    m("extensionPoints", "Extension points", hard, ["Disable legacy extension points"]),
    m("signature", "Signature policy", hard, ["Microsoft signed only"]),
    m("fonts", "Font loading", hard, ["Disable non-system fonts"]),
    m("imageLoad", "Image load", hard, ["No remote images", "No low mandatory label images", "Prefer System32"]),
    m("childProcess", "Child process", false),
    m("shadowStack", "Hardware stack protection", !legacy && kind !== "normal", ["Strict mode"]),
  ];
}

// ── building one process ────────────────────────────────────────────────

interface ProcState {
  def: Def;
  ov: ProcOverview;
  modules: ProcModule[];
  threads: ProcThread[];
  handles: ProcHandle[];
  token: ProcToken;
  memory: MemRegion[];
  /** what a non-elevated caller can't read */
  restricted: boolean;
}

const states = new Map<number, ProcState>();
const SYSTEM_AFFINITY = "65535"; // 16 logical CPUs

function baseOverview(d: Def, threads: number, handles: number): ProcOverview {
  const r = rng(d.pid * 17);
  const sys = d.kind === "system";
  const svc = d.kind === "service";
  const high = d.kind === "elevated";
  const parent = byPid.get(d.ppid);
  const start = NOW - (d.up ?? 3 * HOUR);
  const cpuTotal = ((d.cpu ?? 0.05) / 100) * (NOW - start) * 2;
  return {
    pid: d.pid,
    ppid: d.ppid || null,
    parentName: parent && parent.pid !== d.pid ? parent.name : null,
    name: d.name,
    path: d.exe,
    commandLine: d.cmd ?? (d.exe ? `"${d.exe}"` : null),
    currentDirectory: sys || svc ? "C:\\Windows\\system32\\" : d.exe?.startsWith(GAME_DIR) ? GAME_DIR : "C:\\Users\\alex\\",
    user: sys ? "NT AUTHORITY\\SYSTEM" : svc ? "NT AUTHORITY\\LOCAL SERVICE" : USER,
    userSid: sys ? "S-1-5-18" : svc ? "S-1-5-19" : USER_SID,
    sessionId: sys || svc ? 0 : 1,
    integrity: sys || svc ? "System" : high ? "High" : d.appContainer ? "Low" : "Medium",
    elevated: sys || svc || high,
    elevationType: sys || svc ? "default" : high ? "full" : "limited",
    virtualization: sys || svc || high ? "notAllowed" : d.arch?.includes("x86") ? "disabled" : "disabled",
    protection: d.protection ?? "None",
    architecture: d.arch ?? (d.exe ? "x64" : null),
    startTime: start,
    cpuKernelMs: Math.round(cpuTotal * 0.3),
    cpuUserMs: Math.round(cpuTotal * 0.7),
    workingSet: Math.round(d.mem),
    peakWorkingSet: Math.round(d.mem * (1.2 + r() * 0.5)),
    privateBytes: Math.round(d.mem * (0.6 + r() * 0.5)),
    virtualSize: d.arch?.includes("x86") ? Math.round(1.9e9 + r() * 1e9) : Math.round(2.2e12 + r() * 2e11),
    ioReadBytes: Math.round(d.mem * (2 + r() * 40)),
    ioWriteBytes: Math.round(d.mem * r() * 3),
    ioOtherBytes: Math.round(d.mem * r() * 0.5),
    handleCount: handles,
    threadCount: threads,
    priorityClass: d.name === "dwm.exe" || d.name === "csrss.exe" ? "high" : "normal",
    basePriority: d.name === "dwm.exe" || d.name === "csrss.exe" ? 13 : 8,
    affinity: SYSTEM_AFFINITY,
    systemAffinity: SYSTEM_AFFINITY,
    debugged: false,
    packageName: d.pkg ?? null,
    suspended: false,
    mitigations: mitigations(sys || d.protection ? "hardened" : d.arch?.includes("x86") ? "legacy" : "normal"),
    denied: [],
  };
}

function deny(ov: ProcOverview, fields: string[]) {
  for (const f of fields) {
    if (f === "commandLine") ov.commandLine = null;
    else if (f === "currentDirectory") ov.currentDirectory = null;
    else if (f === "user") (ov.user = null), (ov.userSid = null);
    else if (f === "integrity") ov.integrity = null;
    else if (f === "elevation") (ov.elevated = null), (ov.elevationType = null);
    else if (f === "virtualization") ov.virtualization = null;
    else if (f === "mitigations") ov.mitigations = [];
    else if (f === "debugged") ov.debugged = null;
    else if (f === "affinity") ov.affinity = null;
    else if (f === "io") (ov.ioReadBytes = 0), (ov.ioWriteBytes = 0), (ov.ioOtherBytes = 0);
  }
  ov.denied = fields;
}

const EXPLORER_EXTRA: ModSpec[] = [
  { name: "COMCTL32.dll", path: "C:\\Windows\\WinSxS\\amd64_microsoft.windows.common-controls_6595b64144ccf1df_6.0.26100.2454_none_3e0ee9e2e88dc4b9\\COMCTL32.dll", description: "User Experience Controls Library", company: MS, version: "6.10.26100.2454" },
  { name: "nvldumdx.dll", path: "C:\\Windows\\System32\\DriverStore\\FileRepository\\nv_dispui.inf_amd64_8b1a0c3f6d2e9f71\\nvldumdx.dll", description: "NVIDIA Driver Loader", company: "NVIDIA Corporation", version: "32.0.15.6614" },
  { name: "FileSyncShell64.dll", path: "C:\\Users\\alex\\AppData\\Local\\Microsoft\\OneDrive\\25.170.0831.0002\\FileSyncShell64.dll", description: "Microsoft OneDrive Shell Extension", company: MS, version: "25.170.0831.0002" },
  { name: "7-zip.dll", path: "C:\\Program Files\\7-Zip\\7-zip.dll", description: "7-Zip Shell Extension", company: "Igor Pavlov", version: "24.08" },
];

const EXPLORER_THREAD_STARTS: [string, number, string | null][] = [
  ["explorer.exe", 0x9c2f0, null],
  ["SHCORE.dll", 0x3a830, "ShellTaskScheduler"],
  ["twinui.pcshell.dll", 0x1a3c40, null],
  ["windows.storage.dll", 0x2b11c0, null],
  ["combase.dll", 0x8d1f0, null],
  ["CoreMessaging.dll", 0x45a90, null],
  ["ExplorerFrame.dll", 0x83c10, "DesktopWatcher"],
  ["RPCRT4.dll", 0x5c3a0, null],
  ["ucrtbase.dll", 0x27c40, null],
  ["Windows.UI.Immersive.dll", 0x5e0d0, "WinRT STA (tray)"],
  ["FileSyncShell64.dll", 0x13a20, null],
  ["thumbcache.dll", 0x21c10, "Thumbnail extraction"],
];

function buildExplorer(d: Def): ProcState {
  const r = rng(4812);
  const specs = [
    { name: "explorer.exe", path: d.exe!, description: "Windows Explorer", company: MS, version: WINVER },
    ...SYSTEM_DLLS.map((x) => sysMod(x)),
    ...EXPLORER_EXTRA,
  ];
  const modules = layoutModules(specs, 0x00007ff6a1b20000n, 0x00007ffc6a210000n, r);
  const ov = baseOverview(d, 0, 0);
  const tspecs: ThreadSpec[] = Array.from({ length: 82 }, (_, i) => {
    if (i < EXPLORER_THREAD_STARTS.length) {
      const [m, off, desc] = EXPLORER_THREAD_STARTS[i];
      return { win32: [m, off], description: desc, priority: i === 0 ? 9 : 8 };
    }
    return r() < 0.7 ? { win32: ["ntdll.dll", 0x2c4a0] } : { win32: [pick(r, ["combase.dll", "SHCORE.dll", "RPCRT4.dll", "twinui.dll", "windows.storage.dll"]), int(r, 0x1000, 0x90000)] };
  });
  const threads = makeThreads(r, modules, ov.startTime!, tspecs, 2);
  const files = [
    "C:\\Windows\\System32\\en-US\\explorer.exe.mui",
    "C:\\Windows\\Fonts\\StaticCache.dat",
    "C:\\Users\\alex\\AppData\\Local\\Microsoft\\Windows\\Explorer\\iconcache_16.db",
    "C:\\Users\\alex\\AppData\\Local\\Microsoft\\Windows\\Explorer\\iconcache_32.db",
    "C:\\Users\\alex\\AppData\\Local\\Microsoft\\Windows\\Explorer\\iconcache_48.db",
    "C:\\Users\\alex\\AppData\\Local\\Microsoft\\Windows\\Explorer\\thumbcache_96.db",
    "C:\\Users\\alex\\AppData\\Local\\Microsoft\\Windows\\Explorer\\thumbcache_256.db",
    "C:\\Users\\alex\\AppData\\Local\\Microsoft\\Windows\\Caches\\cversions.3.db",
    "C:\\Users\\alex\\AppData\\Local\\Microsoft\\Windows\\Caches\\{3DA71D5A-20CC-432F-A115-DFE92379E91F}.3.ver0x0000000000000016.db",
    "C:\\Users\\alex\\Desktop",
    "C:\\Users\\alex\\Documents",
    "C:\\Users\\alex\\Downloads",
    "C:\\Users\\alex\\Pictures\\Screenshots",
    "C:\\Users\\alex\\OneDrive",
    "C:\\Windows\\System32",
    "C:\\Windows\\WinSxS\\amd64_microsoft.windows.common-controls_6595b64144ccf1df_6.0.26100.2454_none_3e0ee9e2e88dc4b9",
    "C:\\Windows\\Registration\\R00000000000d.clb",
    "C:\\Windows\\Globalization\\Sorting\\SortDefault.nls",
    "C:\\ProgramData\\Microsoft\\Windows\\Start Menu\\Programs",
    "C:\\Users\\alex\\AppData\\Roaming\\Microsoft\\Windows\\Recent\\AutomaticDestinations",
    "C:\\Users\\alex\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs",
    "C:\\Windows\\System32\\en-US\\shell32.dll.mui",
    "C:\\Windows\\System32\\en-US\\twinui.pcshell.dll.mui",
    "C:\\Windows\\SystemResources\\explorer.exe.mun",
  ];
  const self = (tid: number) => ({ type: "Thread", name: `explorer.exe (4812): ${tid}`, access: 0x1fffff, targetPid: 4812 });
  const extra: HandleSeed[] = [
    { type: "Process", name: "game.exe (7340)", access: 0x1410, targetPid: 7340 },
    { type: "Process", name: "SearchHost.exe (5712)", access: 0x1fffff, targetPid: 5712 },
    { type: "Process", name: "msedge.exe (6388)", access: 0x101000, targetPid: 6388 },
    { type: "Process", name: "OneDrive.exe (6244)", access: 0x101000, targetPid: 6244 },
    { type: "Process", name: "sihost.exe (5020)", access: 0x1000, targetPid: 5020 },
    { type: "Process", name: "dllhost.exe (9244)", access: 0x100000, targetPid: 9244 },
    { type: "Process", name: "cheatengine-x86_64.exe (8812)", access: 0x101000, targetPid: 8812 },
    { type: "Process", name: "Code.exe (7012)", access: 0x101000, targetPid: 7012 },
    { type: "Process", name: "Spotify.exe (9700)", access: 0x100000, targetPid: 9700 },
    { type: "Thread", name: "sihost.exe (5020): 5084", access: 0x1fffff, targetPid: 5020 },
    { type: "Job", name: null, access: 0x1f001f, targetPid: null },
    { type: "Job", name: "\\Sessions\\1\\BaseNamedObjects\\ShellExperienceHostJob", access: 0x1f001f, targetPid: null },
    { type: "Partition", name: null, access: 0x20019, targetPid: null },
    { type: "Composition", name: null, access: 0x3, targetPid: null },
    { type: "DxgkCompositionObject", name: null, access: 0x1f0001, targetPid: null },
    { type: "DxgkSharedResource", name: null, access: 0x1f0001, targetPid: null },
    { type: "Session", name: "\\Sessions\\1", access: 0x1, targetPid: null, attributes: 0x1 },
    ...threads.slice(12, 40).map((t) => self(t.tid)),
  ];
  const handles = genericHandles(r, d, threads, files, { File: 96, Key: 118, Event: 150, Mutant: 22, Semaphore: 16, Section: 26, "ALPC Port": 16, Directory: 6, Token: 4, IoCompletion: 20, TpWorkerFactory: 6, IRTimer: 14, WaitCompletionPacket: 38, EtwRegistration: 58, Timer: 6, Thread: 12 }, extra);
  const memory = genericMemory(r, modules, threads, [
    "C:\\Windows\\System32\\locale.nls",
    "C:\\Windows\\Globalization\\Sorting\\SortDefault.nls",
    "C:\\Windows\\System32\\C_1252.NLS",
    "C:\\Windows\\Fonts\\StaticCache.dat",
    "C:\\Windows\\System32\\en-US\\explorer.exe.mui",
    "C:\\Windows\\System32\\en-US\\shell32.dll.mui",
    "C:\\Windows\\System32\\en-US\\twinui.pcshell.dll.mui",
    "C:\\Windows\\SystemResources\\explorer.exe.mun",
    "C:\\Windows\\Registration\\R00000000000d.clb",
    "C:\\Users\\alex\\AppData\\Local\\Microsoft\\Windows\\Explorer\\iconcache_32.db",
    "C:\\Users\\alex\\AppData\\Local\\Microsoft\\Windows\\Explorer\\iconcache_48.db",
    "C:\\Users\\alex\\AppData\\Local\\Microsoft\\Windows\\Explorer\\thumbcache_96.db",
    "C:\\Users\\alex\\AppData\\Local\\Microsoft\\Windows\\Caches\\cversions.3.db",
    "C:\\Windows\\System32\\imageres.dll.mun",
  ], false);
  return { def: d, ov, modules, threads, handles, token: makeToken(d), memory, restricted: false };
}

function buildGame(d: Def): ProcState {
  const r = rng(7340);
  const wowSys = ["ntdll.dll", "wow64.dll", "wow64base.dll", "wow64con.dll", "wow64cpu.dll", "wow64win.dll"];
  const wowDlls = ["ntdll.dll", "KERNEL32.DLL", "KERNELBASE.dll", "USER32.dll", "win32u.dll", "GDI32.dll", "gdi32full.dll", "msvcp_win.dll", "ucrtbase.dll", "ADVAPI32.dll", "msvcrt.dll", "sechost.dll", "RPCRT4.dll", "combase.dll", "ole32.dll", "OLEAUT32.dll", "SHELL32.dll", "SHLWAPI.dll", "IMM32.DLL", "WINMM.dll", "VERSION.dll", "dwmapi.dll", "uxtheme.dll", "CRYPTBASE.DLL", "bcryptPrimitives.dll", "MSCTF.dll", "kernel.appcore.dll", "windows.storage.dll", "wintypes.dll", "IPHLPAPI.DLL", "WINHTTP.dll"];
  const desc = new Map(SYSTEM_DLLS.map(([n, ds]) => [n.toLowerCase(), ds]));
  const sys64: ProcModule[] = layoutModules(
    wowSys.map((n) => ({ name: n, path: SYS32 + n, description: desc.get(n.toLowerCase()) ?? "Win32 Emulation on NT64", company: MS, version: WINVER })),
    0x00007ffcf0e10000n,
    0x00007ffcee800000n,
    r,
  );
  const specs: ModSpec[] = [
    { name: "game.exe", path: d.exe!, description: "Shadowfall", company: "Ironbark Interactive", version: "1.14.2.0" },
    ...wowDlls.map((n) => ({ name: n, path: WOW + n, description: desc.get(n.toLowerCase()) ?? null, company: MS, version: WINVER })),
    { name: "d3d9.dll", path: WOW + "d3d9.dll", description: "Direct3D 9 Runtime", company: MS, version: WINVER },
    { name: "d3dx9_43.dll", path: WOW + "d3dx9_43.dll", description: "Direct3D 9 Extensions", company: MS, version: "9.29.952.3111" },
    { name: "dinput8.dll", path: WOW + "dinput8.dll", description: "Microsoft DirectInput", company: MS, version: WINVER },
    { name: "XInput1_4.dll", path: WOW + "XInput1_4.dll", description: "Microsoft Common Controller API", company: MS, version: WINVER },
    { name: "dsound.dll", path: WOW + "dsound.dll", description: "DirectSound", company: MS, version: WINVER },
    { name: "WS2_32.dll", path: WOW + "WS2_32.dll", description: "Windows Socket 2.0 32-Bit DLL", company: MS, version: WINVER },
    { name: "nvd3dum.dll", path: "C:\\Windows\\System32\\DriverStore\\FileRepository\\nv_dispui.inf_amd64_8b1a0c3f6d2e9f71\\nvd3dum.dll", description: "NVIDIA Compatible D3D Driver", company: "NVIDIA Corporation", version: "32.0.15.6614" },
    { name: "steam_api.dll", path: GAME_DIR + "steam_api.dll", description: "Steam Client API", company: "Valve Corporation", version: "8.43.51.79" },
    { name: "GameOverlayRenderer.dll", path: "C:\\Program Files (x86)\\Steam\\GameOverlayRenderer.dll", description: "Steam Game Overlay Renderer", company: "Valve Corporation", version: "9.48.71.13" },
    { name: "fmod.dll", path: GAME_DIR + "fmod.dll", description: "FMOD Studio API", company: "Firelight Technologies Pty Ltd", version: "2.02.21" },
    { name: "PhysX3_x86.dll", path: GAME_DIR + "PhysX3_x86.dll", description: "PhysX 3.4 x86 runtime", company: "NVIDIA Corporation", version: "3.4.2.25354" },
    { name: "PhysX3Common_x86.dll", path: GAME_DIR + "PhysX3Common_x86.dll", description: "PhysX 3.4 x86 common runtime", company: "NVIDIA Corporation", version: "3.4.2.25354" },
    { name: "binkw32.dll", path: GAME_DIR + "binkw32.dll", description: "Bink Video", company: "RAD Game Tools, Inc.", version: "1.99.1.0" },
    { name: "hk_8f3a.dll", path: "C:\\Users\\alex\\AppData\\Local\\Temp\\hk_8f3a.dll", description: null, company: null, version: null },
  ];
  const mods32 = layoutModules(specs, 0x00400000n, 0x6a2c0000n, r);
  // the system DLLs live high in the 32-bit space
  let hi = 0x74a10000n;
  for (const m of mods32) {
    if (m.path.startsWith(WOW)) {
      m.base = hx(hi);
      hi += BigInt(Math.ceil(m.size / 0x10000) * 0x10000 + 0x10000);
    }
  }
  for (const m of sys64) m.isMain = false;
  const modules = [...mods32, ...sys64];
  const ov = baseOverview(d, 0, 0);
  ov.debugged = true;
  const shell = "0x0000000002a11240";
  const tspecs: ThreadSpec[] = [
    { win32: ["game.exe", 0x1c2a40], description: "MainThread", priority: 10 },
    { win32: ["game.exe", 0x2b1f0], description: "RenderThread", priority: 10 },
    { win32: ["game.exe", 0x2b5c0], description: "AudioMixer", priority: 15 },
    { win32: ["fmod.dll", 0x4e1a0], description: "FMOD stream thread" },
    { win32: ["fmod.dll", 0x4e8b0], description: "FMOD mixer thread", priority: 15 },
    { win32: ["steam_api.dll", 0x13c40] },
    { win32: ["GameOverlayRenderer.dll", 0x6f300] },
    { win32: ["PhysX3_x86.dll", 0x91a30], description: "PxWorker00" },
    { win32: ["PhysX3_x86.dll", 0x91a30], description: "PxWorker01" },
    { win32: ["PhysX3_x86.dll", 0x91a30], description: "PxWorker02" },
    { win32: ["hk_8f3a.dll", 0x1a20] },
    { win32Raw: shell },
    ...Array.from({ length: 16 }, (): ThreadSpec => ({ win32: ["ntdll.dll", 0x6f2e0] })),
    { win32: ["nvd3dum.dll", 0x3c11a0] },
    { win32: ["nvd3dum.dll", 0x3c11a0] },
  ];
  const threads = makeThreads(r, mods32, ov.startTime!, tspecs, 0, true);
  const files = [
    "C:\\Games\\Shadowfall\\data\\pak01_dir.vpk",
    "C:\\Games\\Shadowfall\\data\\pak01_003.vpk",
    "C:\\Games\\Shadowfall\\data\\pak01_017.vpk",
    "C:\\Games\\Shadowfall\\data\\maps\\harbor_night.bsp",
    "C:\\Games\\Shadowfall\\logs\\console.log",
    "C:\\Games\\Shadowfall\\cfg\\config.cfg",
    "C:\\Users\\alex\\AppData\\Local\\Temp\\hk_8f3a.dll",
    "C:\\Program Files (x86)\\Steam\\logs\\gameoverlayrenderer.log",
    "\\Device\\Afd",
    "\\Device\\Afd",
    "\\Device\\Nsi",
  ];
  const handles = genericHandles(r, d, threads, files, { File: 34, Key: 40, Event: 60, EtwRegistration: 20 }, [
    { type: "Process", name: "steam.exe (7240)", access: 0x101000, targetPid: 7240 },
    { type: "Section", name: "\\Sessions\\1\\BaseNamedObjects\\SteamOverlayFrameBuffer_7340", access: 0xf001f, targetPid: null },
    { type: "Mutant", name: "\\Sessions\\1\\BaseNamedObjects\\hk_8f3a_ready", access: 0x1f0001, targetPid: null },
  ]);
  const memory = genericMemory(r, modules, threads, ["C:\\Windows\\SysWOW64\\locale.nls", "C:\\Windows\\Globalization\\Sorting\\SortDefault.nls", "C:\\Games\\Shadowfall\\data\\pak01_dir.vpk", "C:\\Windows\\Fonts\\StaticCache.dat"], true, (s) => {
    // manually mapped payload and its scratch buffer: private, read-write-execute
    s.alloc(0x02a10000n, "private", "RWX", [{ size: 0x5000, protect: "RWX" }], null);
    s.alloc(0x1f3c0000n, "private", "RWX", [
      { size: 0x20000, protect: "RWX" },
      { size: 0x10000, state: "reserve", protect: "" },
    ], null);
    // a JIT-style executable page: private but not writable
    s.alloc(0x05e00000n, "private", "RW", [{ size: 0x1000, protect: "RX" }], null);
  });
  return { def: d, ov, modules, threads, handles, token: makeToken(d), memory, restricted: false };
}

function buildGeneric(d: Def): ProcState {
  const r = rng(d.pid * 1009);
  const wow = !!d.arch?.includes("x86");
  const count = d.exe ? int(r, 22, 60) : 0;
  const chosen = SYSTEM_DLLS.slice(0, 12).concat(SYSTEM_DLLS.slice(12).filter(() => r() < count / SYSTEM_DLLS.length));
  const extraMods: ModSpec[] =
    d.special === "msmpeng"
      ? [
          { name: "MpSvc.dll", path: DEFENDER + "MpSvc.dll", description: "Microsoft Defender Antivirus Service", company: MS, version: "4.18.24090.11" },
          { name: "MpClient.dll", path: DEFENDER + "MpClient.dll", description: "Client Interface", company: MS, version: "4.18.24090.11" },
          { name: "MpRtp.dll", path: DEFENDER + "MpRtp.dll", description: "Real-time Protection component", company: MS, version: "4.18.24090.11" },
          { name: "mpengine.dll", path: "C:\\ProgramData\\Microsoft\\Windows Defender\\Definition Updates\\{9B1D5E2A-6C3F-4E8B-A1D7-0F2C3B4A5E6D}\\mpengine.dll", description: "Microsoft Malware Protection Engine", company: MS, version: "1.1.24090.11" },
        ]
      : [];
  const main: ModSpec | null = d.exe ? { name: d.exe.slice(d.exe.lastIndexOf("\\") + 1), path: d.exe, description: d.name.replace(/\.exe$/i, ""), company: d.exe.startsWith("C:\\Windows") ? MS : null, version: d.exe.startsWith("C:\\Windows") ? WINVER : "1.0.0.0" } : null;
  const modules = main ? layoutModules([main, ...chosen.map((x) => sysMod(x, wow ? WOW : SYS32)), ...extraMods], wow ? 0x00400000n : 0x00007ff6b0000000n + BigInt(hash(d.name) % 0x400) * 0x10000n, wow ? 0x74a10000n : 0x00007ffc6a210000n, r) : [];
  const ov = baseOverview(d, 0, 0);
  // Spotify is the big one: thousands of handles and memory regions, to keep the tables honest
  const big = d.name === "Spotify.exe";
  const n = d.exe ? (big ? 150 : int(r, 4, d.mem > 1e8 ? 64 : 24)) : 180;
  const tspecs: ThreadSpec[] = Array.from({ length: n }, (_, i) =>
    !d.exe ? { win32: undefined } : i === 0 ? { win32: [modules[0].name, 0x1a2b0] } : { win32: [pick(r, ["ntdll.dll", "ntdll.dll", "combase.dll", "RPCRT4.dll", "ucrtbase.dll"]), r() < 0.6 ? 0x2c4a0 : int(r, 0x1000, 0x80000)] },
  );
  const threads = d.exe
    ? makeThreads(r, modules, ov.startTime!, tspecs, 0, wow)
    : tspecs.map((_, i) => ({
        tid: 8 + i * 4,
        startAddress: hx(0xfffff8030ea00000n + BigInt(int(r, 0, 0x8fffff))),
        startSymbol: `ntoskrnl.exe+0x${int(r, 0x1000, 0x9fffff).toString(16)}`,
        win32StartAddress: null,
        win32StartSymbol: null,
        state: "Waiting",
        waitReason: pick(r, ["WrQueue", "Executive", "WrFreePage", "WrLpcReceive", "DelayExecution"]),
        priority: int(r, 8, 16),
        basePriority: 8,
        contextSwitches: int(r, 100, 2_000_000),
        kernelMs: int(r, 0, 90_000),
        userMs: 0,
        createTime: ov.startTime! + int(r, 0, 60_000),
        description: null,
        suspendCount: 0,
        suspended: false,
      }));
  let extra: HandleSeed[] = [];
  if (d.name.startsWith("cheatengine")) {
    const game = states.get(7340)?.threads ?? [];
    extra = [
      { type: "Process", name: "game.exe (7340)", access: 0x1fffff, targetPid: 7340 },
      ...game.slice(0, 3).map((t): HandleSeed => ({ type: "Thread", name: `game.exe (7340): ${t.tid}`, access: 0x1fffff, targetPid: 7340 })),
      { type: "File", name: "\\Device\\CEDRIVER73", access: 0x12019f, targetPid: null },
    ];
  } else if (d.special === "msmpeng") {
    extra = DEFS.filter((x) => x.exe && x.pid !== d.pid && x.pid % 3 === 0).map((x): HandleSeed => ({ type: "Process", name: `${x.name} (${x.pid})`, access: 0x1410, targetPid: x.pid }));
  }
  const counts = big ? { Event: 1700, Key: 340, File: 420, Section: 150, Mutant: 90, EtwRegistration: 240, WaitCompletionPacket: 160, IRTimer: 60, Thread: 80 } : { Event: int(r, 20, 90), Key: int(r, 10, 50) };
  const handles = genericHandles(r, d, threads, d.exe ? [d.exe.slice(0, d.exe.lastIndexOf("\\"))] : [], counts, extra);
  const memory = d.exe ? genericMemory(r, modules, threads.slice(0, big ? 150 : 40), ["C:\\Windows\\System32\\locale.nls", "C:\\Windows\\Globalization\\Sorting\\SortDefault.nls"], wow) : [];
  return { def: d, ov, modules, threads, handles, token: makeToken(d), memory, restricted: d.kind !== "user" };
}

/** Notepad exits 20 s after it is first inspected, to watch the inspector notice. */
let notepadSeen = 0;

function stateOf(pid: number): ProcState | string {
  const d = byPid.get(pid);
  if (!d) return `No process with PID ${pid}: it has exited (or never existed)`;
  if (d.special === "exited") return `${d.name} (${pid}) has exited`;
  if (pid === 9620) {
    notepadSeen ||= Date.now();
    if (Date.now() - notepadSeen > 20_000) {
      d.special = "exited";
      return `${d.name} (${pid}) has exited`;
    }
  }
  let s = states.get(pid);
  if (!s) {
    if (d.special === "explorer") s = buildExplorer(d);
    else if (d.special === "game") s = buildGame(d);
    else s = buildGeneric(d);
    s.ov.threadCount = s.threads.length;
    s.ov.handleCount = s.handles.length;
    states.set(pid, s);
  }
  return s;
}

/** Slight changes on every read, like a live process. */
function tickOverview(s: ProcState) {
  const r = Math.random;
  const busy = (s.def.cpu ?? 0.1) / 100;
  if (!s.threads.every((t) => t.suspended)) {
    s.ov.cpuUserMs += Math.round(busy * 2000 * (0.6 + r()) * 0.7);
    s.ov.cpuKernelMs += Math.round(busy * 2000 * (0.6 + r()) * 0.3);
    s.ov.ioReadBytes += Math.round(r() * busy * 4e6);
    s.ov.ioOtherBytes += Math.round(r() * 2e3);
  }
  s.ov.workingSet = Math.round(s.def.mem * (0.98 + r() * 0.04));
  s.ov.peakWorkingSet = Math.max(s.ov.peakWorkingSet, s.ov.workingSet);
}
function tickThreads(s: ProcState) {
  for (const t of s.threads) {
    if (t.suspended || Math.random() < 0.35) continue;
    t.contextSwitches += Math.floor(Math.random() * (t.priority > 9 ? 900 : 120));
    t.userMs += Math.floor(Math.random() * 6);
    t.kernelMs += Math.floor(Math.random() * 2);
  }
}

function overviewFor(s: ProcState): ProcOverview {
  tickOverview(s);
  const ov = structuredClone(s.ov);
  ov.threadCount = s.threads.length;
  ov.suspended = s.threads.length > 0 && s.threads.every((t) => t.suspended);
  if (s.def.special === "msmpeng") deny(ov, ADMIN ? ["commandLine", "currentDirectory"] : ["commandLine", "currentDirectory", "user", "integrity", "elevation", "virtualization", "mitigations", "debugged", "affinity", "io"]);
  else if (s.restricted && !ADMIN) deny(ov, ["commandLine", "currentDirectory", "user", "integrity", "elevation", "mitigations", "debugged"]);
  else if (s.def.protection && s.def.protection !== "None") deny(ov, ["commandLine", "currentDirectory"]);
  return ov;
}

const restricted = (s: ProcState) => !ADMIN && (s.restricted || s.def.special === "msmpeng");

async function withState<T>(pid: number, fn: (s: ProcState) => T, opts: { needsAccess?: boolean; ms?: number } = {}): Promise<T> {
  const s = stateOf(pid);
  if (typeof s === "string") return fail(s);
  if (opts.needsAccess && restricted(s)) return fail(DENIED);
  return later(fn(s), opts.ms ?? 60 + Math.random() * 90);
}

/** process.control on a protected process (or one we can't open). */
function control(pid: number, fn: (s: ProcState) => void): Promise<boolean> {
  const s = stateOf(pid);
  if (typeof s === "string") return fail(s);
  if (s.def.protection && s.def.protection !== "None") return fail("Access denied: the process is protected");
  if (restricted(s)) return fail(DENIED);
  fn(s);
  return later(true, 120);
}

function setSuspended(t: ProcThread, delta: 1 | -1, original: Map<number, [string, string | null]>) {
  const before = t.suspendCount ?? 0;
  const after = Math.max(0, before + delta);
  if (before === 0 && after > 0) original.set(t.tid, [t.state, t.waitReason]);
  t.suspendCount = after;
  t.suspended = after > 0;
  if (after > 0) {
    t.state = "Waiting";
    t.waitReason = "Suspended";
  } else if (before > 0) {
    const [state, reason] = original.get(t.tid) ?? ["Waiting", "UserRequest"];
    t.state = state === "Running" ? "Ready" : state;
    t.waitReason = state === "Waiting" ? (reason === "Suspended" ? "UserRequest" : reason) : null;
  }
}
const originalStates = new Map<number, [string, string | null]>();

const PRIORITY_BASE: Record<PriorityClass, number> = { idle: 4, belowNormal: 6, normal: 8, aboveNormal: 10, high: 13, realtime: 24 };

function processList(): ProcListItem[] {
  return DEFS.map((d) => {
    const s = states.get(d.pid);
    const suspended = !!s && s.threads.length > 0 && s.threads.every((t) => t.suspended);
    return {
      pid: d.pid,
      ppid: d.ppid || null,
      name: d.name,
      cpu: suspended ? 0 : Math.max(0, (d.cpu ?? 0) * (0.6 + Math.random() * 0.8)),
      mem: Math.round(d.mem),
      exe: d.exe,
      status: suspended ? "Suspended" : "Running",
      runTime: d.up ?? 3 * HOUR,
    };
  });
}

export function install() {
  installMock(
    {
      process: {
        list: () => later(processList(), 70),
        overview: (pid) => withState(pid, overviewFor),
        modules: (pid) => withState(pid, (s) => s.modules, { needsAccess: true }),
        threads: (pid) =>
          withState(pid, (s) => {
            tickThreads(s);
            const hide = restricted(s);
            return s.threads.map((t) => (hide ? { ...t, win32StartAddress: null, win32StartSymbol: null, description: null } : t));
          }),
        handles: (pid) => withState(pid, (s) => s.handles, { needsAccess: true, ms: 180 }),
        token: (pid) => withState(pid, (s) => s.token, { needsAccess: true }),
        memory: (pid) => withState(pid, (s) => s.memory, { needsAccess: true, ms: 160 }),
        signature: (path) => later(signatureOf(path), 40 + Math.random() * 260),
        suspend: (pid) => control(pid, (s) => s.threads.forEach((t) => setSuspended(t, 1, originalStates))),
        resume: (pid) => control(pid, (s) => s.threads.forEach((t) => setSuspended(t, -1, originalStates))),
        setPriority: (pid, p) =>
          control(pid, (s) => {
            s.ov.priorityClass = p;
            s.ov.basePriority = PRIORITY_BASE[p];
          }),
        setAffinity: (pid, mask) =>
          control(pid, (s) => {
            s.ov.affinity = mask;
          }),
      },
      thread: {
        suspend: (pid, tid) => control(pid, (s) => s.threads.filter((t) => t.tid === tid).forEach((t) => setSuspended(t, 1, originalStates))),
        resume: (pid, tid) => control(pid, (s) => s.threads.filter((t) => t.tid === tid).forEach((t) => setSuspended(t, -1, originalStates))),
        terminate: (pid, tid) =>
          control(pid, (s) => {
            s.threads = s.threads.filter((t) => t.tid !== tid);
          }),
      },
    },
    "process-inspector",
  );

  // the stand-in grants nothing by default; this module's manifest asks for these
  const deniedPerms = (params.get("deny") ?? "").split(",");
  const granted = ["process.inspect", "process.control", "clipboard"].filter((p) => !deniedPerms.includes(p));
  const sdk = window.shellmosaic as unknown as { ready: Promise<PaneContext>; context: () => Promise<PaneContext> };
  const withPerms = <T extends PaneContext>(c: T): T => ({ ...c, grantedPermissions: granted });
  sdk.ready = sdk.ready.then(withPerms);
  const context = sdk.context;
  sdk.context = () => context().then(withPerms);
}
