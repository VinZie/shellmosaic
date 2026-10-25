//! One process at a glance: the system snapshot's numbers (available for every process,
//! protected ones included) plus whatever opening the process allows.

use serde::Serialize;
use windows_sys::Win32::Foundation::{ERROR_ACCESS_DENIED, ERROR_INSUFFICIENT_BUFFER, HANDLE};
use windows_sys::Win32::Storage::Packaging::Appx::GetPackageFullName;
use windows_sys::Win32::System::Diagnostics::Debug::CheckRemoteDebuggerPresent;
use windows_sys::Win32::System::SystemInformation::{
    IMAGE_FILE_MACHINE_AMD64, IMAGE_FILE_MACHINE_ARM64, IMAGE_FILE_MACHINE_ARMNT, IMAGE_FILE_MACHINE_I386,
    IMAGE_FILE_MACHINE_UNKNOWN,
};
use windows_sys::Win32::System::Threading::{
    GetPriorityClass, GetProcessAffinityMask, GetProcessMitigationPolicy, IsWow64Process2, ProcessASLRPolicy,
    ProcessChildProcessPolicy, ProcessControlFlowGuardPolicy, ProcessDEPPolicy, ProcessDynamicCodePolicy,
    ProcessExtensionPointDisablePolicy, ProcessFontDisablePolicy, ProcessImageLoadPolicy, ProcessSignaturePolicy,
    ProcessStrictHandleCheckPolicy, ProcessSystemCallDisablePolicy, ProcessUserShadowStackPolicy, ABOVE_NORMAL_PRIORITY_CLASS,
    BELOW_NORMAL_PRIORITY_CLASS, HIGH_PRIORITY_CLASS, IDLE_PRIORITY_CLASS, NORMAL_PRIORITY_CLASS, PROCESS_MITIGATION_POLICY,
    PROCESS_QUERY_INFORMATION, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_VM_READ, REALTIME_PRIORITY_CLASS,
};

use super::modules::image_path;
use super::nt::{self, class, Pebs, Snapshot, UnicodeString, EXITED};
use super::token;
use crate::winutil::{self, filetime_ms, ticks_ms, DosPaths};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Mitigation {
    id: &'static str,
    name: &'static str,
    enabled: bool,
    details: Vec<&'static str>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcOverview {
    pid: u32,
    ppid: Option<u32>,
    parent_name: Option<String>,
    name: String,
    path: Option<String>,
    command_line: Option<String>,
    current_directory: Option<String>,
    user: Option<String>,
    user_sid: Option<String>,
    session_id: Option<u32>,
    integrity: Option<String>,
    elevated: Option<bool>,
    elevation_type: Option<&'static str>,
    virtualization: Option<&'static str>,
    protection: Option<String>,
    architecture: Option<String>,
    start_time: Option<i64>,
    cpu_kernel_ms: u64,
    cpu_user_ms: u64,
    working_set: u64,
    peak_working_set: u64,
    private_bytes: u64,
    virtual_size: u64,
    io_read_bytes: u64,
    io_write_bytes: u64,
    io_other_bytes: u64,
    handle_count: u32,
    thread_count: u32,
    priority_class: Option<&'static str>,
    base_priority: i32,
    affinity: Option<String>,
    system_affinity: Option<String>,
    debugged: Option<bool>,
    package_name: Option<String>,
    suspended: bool,
    mitigations: Vec<Mitigation>,
    denied: Vec<&'static str>,
}

/// Every field that opening the process could fill.
const ALL_FIELDS: [&str; 13] = [
    "path",
    "commandLine",
    "currentDirectory",
    "user",
    "integrity",
    "elevation",
    "protection",
    "architecture",
    "priority",
    "affinity",
    "debugged",
    "mitigations",
    "package",
];

/// The fields a call couldn't fill for lack of access.
#[derive(Default)]
struct Denied(Vec<&'static str>);

impl Denied {
    fn check(&mut self, err: u32, fields: &[&'static str]) {
        if err == ERROR_ACCESS_DENIED {
            self.0.extend(fields);
        }
    }

    fn status(&mut self, status: i32, field: &'static str) {
        self.check(nt::status_error(status), &[field]);
    }
}

pub fn overview(pid: u32) -> Result<ProcOverview, String> {
    let snap = Snapshot::take()?;
    let p = snap.find(pid).ok_or(EXITED)?;
    // PIDs are reused: a "parent" younger than its child is a stranger
    let parent = snap.find(p.ppid).filter(|q| q.pid != pid && q.create_time <= p.create_time);
    let mut o = ProcOverview {
        pid,
        ppid: (pid != 0).then_some(p.ppid),
        parent_name: parent.map(|q| q.name.clone()),
        name: p.name.clone(),
        path: None,
        command_line: None,
        current_directory: None,
        user: None,
        user_sid: None,
        session_id: Some(p.session_id),
        integrity: None,
        elevated: None,
        elevation_type: None,
        virtualization: None,
        protection: None,
        architecture: None,
        start_time: (p.create_time > 0).then(|| filetime_ms(p.create_time)),
        cpu_kernel_ms: ticks_ms(p.kernel_time),
        cpu_user_ms: ticks_ms(p.user_time),
        working_set: p.working_set,
        peak_working_set: p.peak_working_set,
        private_bytes: p.private_bytes,
        virtual_size: p.virtual_size,
        io_read_bytes: p.read_bytes,
        io_write_bytes: p.write_bytes,
        io_other_bytes: p.other_bytes,
        handle_count: p.handle_count,
        thread_count: p.threads.len() as u32,
        priority_class: None,
        base_priority: p.base_priority,
        affinity: None,
        system_affinity: None,
        debugged: None,
        package_name: None,
        suspended: !p.threads.is_empty() && p.threads.iter().all(|t| t.is_suspended()),
        mitigations: Vec::new(),
        denied: Vec::new(),
    };
    // the Idle process isn't a process object that can be opened
    if pid == 0 {
        return Ok(o);
    }
    let opened = nt::open_process(
        pid,
        &[
            PROCESS_QUERY_INFORMATION | PROCESS_VM_READ,
            PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_VM_READ,
            PROCESS_QUERY_LIMITED_INFORMATION,
        ],
    );
    let (process, rights) = match opened {
        Ok(x) => x,
        Err(ERROR_ACCESS_DENIED) => {
            let listed = listed_path(pid);
            o.path = listed.clone().flatten();
            o.denied = ALL_FIELDS.iter().copied().filter(|&f| f != "path" || listed.is_none()).collect();
            return Ok(o);
        }
        // it exited after the snapshot: what the snapshot had is all there is
        Err(_) => return Ok(o),
    };
    let h = process.0;
    let mut denied = Denied::default();

    match image_path(h) {
        Ok(path) => o.path = Some(path),
        Err(e) => match listed_path(pid) {
            Some(path) => o.path = path,
            None => denied.check(e, &["path"]),
        },
    }
    match command_line(h) {
        Ok(c) => o.command_line = c,
        Err(st) => denied.status(st, "commandLine"),
    }
    if rights & PROCESS_VM_READ == 0 {
        denied.0.push("currentDirectory");
    } else {
        o.current_directory = current_directory(h);
    }
    match token::open(h) {
        Ok((tok, _)) => {
            let s = token::summary(tok.0);
            o.user = s.user;
            o.user_sid = s.user_sid;
            o.integrity = s.integrity;
            o.elevated = s.elevated;
            o.elevation_type = s.elevation_type;
            o.virtualization = s.virtualization;
        }
        Err(e) => denied.check(e, &["user", "integrity", "elevation"]),
    }
    match nt::query_process::<u8>(h, class::PROCESS_PROTECTION) {
        Ok(b) => o.protection = Some(protection_text(b)),
        Err(st) => denied.status(st, "protection"),
    }
    match architecture(h) {
        Ok(a) => o.architecture = Some(a),
        Err(e) => denied.check(e, &["architecture"]),
    }
    match unsafe { GetPriorityClass(h) } {
        0 => denied.check(winutil::last_error(), &["priority"]),
        c => o.priority_class = priority_name(c),
    }
    let (mut mask, mut system) = (0usize, 0usize);
    if unsafe { GetProcessAffinityMask(h, &mut mask, &mut system) } != 0 {
        o.affinity = Some(mask.to_string());
        o.system_affinity = Some(system.to_string());
    } else {
        denied.check(winutil::last_error(), &["affinity"]);
    }
    let mut debugged = 0;
    if unsafe { CheckRemoteDebuggerPresent(h, &mut debugged) } != 0 {
        o.debugged = Some(debugged != 0);
    } else {
        denied.check(winutil::last_error(), &["debugged"]);
    }
    match package_name(h) {
        Ok(p) => o.package_name = p,
        Err(e) => denied.check(e, &["package"]),
    }
    match mitigations(h) {
        Ok(m) => o.mitigations = m,
        Err(e) => denied.check(e, &["mitigations"]),
    }
    // an ended process answers "access denied" to most of the above
    if nt::has_exited(h) {
        return Err(EXITED.into());
    }
    o.denied = denied.0;
    Ok(o)
}

/// The executable's path from the kernel's process list, which needs no access to the
/// process: Some(None) for kernel processes (System, Registry, …) that have no file.
fn listed_path(pid: u32) -> Option<Option<String>> {
    let name = nt::image_nt_path(pid)?;
    Some(name.contains('\\').then(|| DosPaths::get().convert(&name)))
}

/// Err is the NTSTATUS.
fn command_line(h: HANDLE) -> Result<Option<String>, i32> {
    let buf = nt::query_var(4096, 1 << 20, |p, n, r| unsafe { nt::NtQueryInformationProcess(h, class::PROCESS_COMMAND_LINE, p, n, r) })?;
    Ok(buf.read::<UnicodeString>(0).and_then(|s| buf.ustr(&s)).filter(|c| !c.is_empty()))
}

/// RTL_USER_PROCESS_PARAMETERS.CurrentDirectory, read through the PEB (the 32-bit one
/// for WOW64 processes: that's the one their code changes).
fn current_directory(h: HANDLE) -> Option<String> {
    const NORMALIZED: u32 = 1;
    let pebs = Pebs::of(h);
    let (params, flags, len, mut buffer) = if let Some(peb) = pebs.wow64 {
        // PEB32.ProcessParameters +0x10; Flags +0x8, CurrentDirectory.DosPath +0x24
        let params = nt::read_u32(h, peb + 0x10)? as u64;
        let s = nt::read_mem(h, params + 0x24, 8)?;
        let buffer = u32::from_le_bytes([s[4], s[5], s[6], s[7]]) as u64;
        (params, nt::read_u32(h, params + 0x8)?, u16::from_le_bytes([s[0], s[1]]), buffer)
    } else {
        // PEB.ProcessParameters +0x20; Flags +0x8, CurrentDirectory.DosPath +0x38
        let params = nt::read_u64(h, pebs.native? + 0x20)?;
        let s = nt::read_mem(h, params.checked_add(0x38)?, 16)?;
        let buffer = u64::from_le_bytes([s[8], s[9], s[10], s[11], s[12], s[13], s[14], s[15]]);
        (params, nt::read_u32(h, params.checked_add(0x8)?)?, u16::from_le_bytes([s[0], s[1]]), buffer)
    };
    // until the loader normalizes them, the strings' addresses are offsets from the block
    if flags & NORMALIZED == 0 {
        buffer = buffer.checked_add(params)?;
    }
    let dir = nt::read_utf16(h, buffer, len as usize)?;
    let trimmed = if dir.len() > 3 { dir.trim_end_matches('\\') } else { dir.as_str() };
    Some(trimmed.to_string()).filter(|d| !d.is_empty())
}

/// PS_PROTECTION → "None", "PPL (Antimalware)", "PP (WinTcb)", …
fn protection_text(b: u8) -> String {
    let kind = match b & 7 {
        0 => return "None".into(),
        1 => "PPL",
        2 => "PP",
        n => return format!("Unknown ({n})"),
    };
    let signer = match b >> 4 {
        0 => return kind.into(),
        1 => "Authenticode",
        2 => "CodeGen",
        3 => "Antimalware",
        4 => "Lsa",
        5 => "Windows",
        6 => "WinTcb",
        7 => "WinSystem",
        8 => "App",
        n => return format!("{kind} (signer {n})"),
    };
    format!("{kind} ({signer})")
}

/// "x64", "ARM64", "x86 (WOW64)", …; Err is the Win32 error.
fn architecture(h: HANDLE) -> Result<String, u32> {
    let (mut process, mut native) = (0u16, 0u16);
    if unsafe { IsWow64Process2(h, &mut process, &mut native) } == 0 {
        return Err(winutil::last_error());
    }
    let name = |m: u16| match m {
        IMAGE_FILE_MACHINE_AMD64 => "x64".to_string(),
        IMAGE_FILE_MACHINE_ARM64 => "ARM64".to_string(),
        IMAGE_FILE_MACHINE_I386 => "x86".to_string(),
        IMAGE_FILE_MACHINE_ARMNT => "ARM".to_string(),
        m => format!("machine 0x{m:04x}"),
    };
    Ok(if process == IMAGE_FILE_MACHINE_UNKNOWN { name(native) } else { format!("{} (WOW64)", name(process)) })
}

pub fn priority_name(class: u32) -> Option<&'static str> {
    Some(match class {
        IDLE_PRIORITY_CLASS => "idle",
        BELOW_NORMAL_PRIORITY_CLASS => "belowNormal",
        NORMAL_PRIORITY_CLASS => "normal",
        ABOVE_NORMAL_PRIORITY_CLASS => "aboveNormal",
        HIGH_PRIORITY_CLASS => "high",
        REALTIME_PRIORITY_CLASS => "realtime",
        _ => return None,
    })
}

/// The AppX/MSIX package full name; Ok(None) for unpackaged processes.
fn package_name(h: HANDLE) -> Result<Option<String>, u32> {
    const APPMODEL_ERROR_NO_PACKAGE: u32 = 15700;
    let mut buf = vec![0u16; 256];
    for _ in 0..2 {
        let mut len = buf.len() as u32;
        match unsafe { GetPackageFullName(h, &mut len, buf.as_mut_ptr()) } {
            0 => return Ok(Some(winutil::from_wide(&buf)).filter(|n| !n.is_empty())),
            APPMODEL_ERROR_NO_PACKAGE => return Ok(None),
            ERROR_INSUFFICIENT_BUFFER if (len as usize) > buf.len() && len <= 4096 => buf = vec![0u16; len as usize],
            e => return Err(e),
        }
    }
    Ok(None)
}

struct Policy {
    id: &'static str,
    name: &'static str,
    class: PROCESS_MITIGATION_POLICY,
    /// the flag bits that mean it's on
    on: u32,
    /// names of the flag bits listed as details
    flags: &'static [(u32, &'static str)],
}

const POLICIES: [Policy; 12] = [
    Policy { id: "dep", name: "DEP", class: ProcessDEPPolicy, on: 0x1, flags: &[(0x2, "ATL thunk emulation disabled")] },
    Policy {
        id: "aslr",
        name: "ASLR",
        class: ProcessASLRPolicy,
        on: 0x7,
        flags: &[(0x1, "Bottom-up"), (0x2, "Force relocate images"), (0x4, "High entropy"), (0x8, "Disallow stripped images")],
    },
    Policy {
        id: "dynamicCode",
        name: "Arbitrary Code Guard",
        class: ProcessDynamicCodePolicy,
        on: 0x1,
        flags: &[(0x2, "Thread opt-out allowed"), (0x4, "Remote downgrade allowed"), (0x8, "Audit")],
    },
    Policy {
        id: "strictHandles",
        name: "Strict Handle Checks",
        class: ProcessStrictHandleCheckPolicy,
        on: 0x1,
        flags: &[(0x2, "Permanent")],
    },
    Policy {
        id: "systemCalls",
        name: "System Call Disable",
        class: ProcessSystemCallDisablePolicy,
        on: 0x5,
        flags: &[(0x1, "Win32k calls blocked"), (0x2, "Audit Win32k calls"), (0x4, "FSCTL calls blocked"), (0x8, "Audit FSCTL calls")],
    },
    Policy { id: "extensionPoints", name: "Extension Point Disable", class: ProcessExtensionPointDisablePolicy, on: 0x1, flags: &[] },
    Policy {
        id: "cfg",
        name: "Control Flow Guard",
        class: ProcessControlFlowGuardPolicy,
        on: 0x1,
        flags: &[(0x2, "Export suppression"), (0x4, "Strict"), (0x8, "XFG"), (0x10, "XFG audit")],
    },
    Policy {
        id: "signature",
        name: "Signature Restriction",
        class: ProcessSignaturePolicy,
        on: 0x3,
        flags: &[
            (0x1, "Microsoft signed only"),
            (0x2, "Store signed only"),
            (0x4, "Opt-in"),
            (0x8, "Audit Microsoft signed only"),
            (0x10, "Audit store signed only"),
        ],
    },
    Policy { id: "fonts", name: "Non-System Font Block", class: ProcessFontDisablePolicy, on: 0x1, flags: &[(0x2, "Audit")] },
    Policy {
        id: "imageLoad",
        name: "Image Load Restriction",
        class: ProcessImageLoadPolicy,
        on: 0x7,
        flags: &[
            (0x1, "No remote images"),
            (0x2, "No low-label images"),
            (0x4, "Prefer System32"),
            (0x8, "Audit remote images"),
            (0x10, "Audit low-label images"),
        ],
    },
    Policy {
        id: "childProcess",
        name: "Child Process Restriction",
        class: ProcessChildProcessPolicy,
        on: 0x1,
        flags: &[(0x2, "Audit"), (0x4, "Secure process creation allowed")],
    },
    Policy {
        id: "shadowStack",
        name: "Hardware Stack Protection",
        class: ProcessUserShadowStackPolicy,
        on: 0x1,
        flags: &[
            (0x2, "Audit"),
            (0x4, "SetContext IP validation"),
            (0x8, "Audit SetContext IP validation"),
            (0x10, "Strict"),
            (0x20, "Block non-CET binaries"),
            (0x40, "Block non-CET binaries (non-EHCONT)"),
            (0x80, "Audit non-CET binaries"),
            (0x100, "Dynamic APIs out of process only"),
            (0x200, "SetContext IP validation relaxed"),
        ],
    },
];

/// The mitigation policies Windows reports (ones this Windows doesn't know are left out).
/// Err (the Win32 error) only when none could be read.
fn mitigations(h: HANDLE) -> Result<Vec<Mitigation>, u32> {
    let mut out = Vec::new();
    let mut err = 0;
    for p in &POLICIES {
        // PROCESS_MITIGATION_DEP_POLICY is {Flags, Permanent}; the others are one DWORD of flags
        let mut v = [0u32; 2];
        let size = if p.class == ProcessDEPPolicy { 8 } else { 4 };
        if unsafe { GetProcessMitigationPolicy(h, p.class, v.as_mut_ptr().cast(), size) } == 0 {
            err = winutil::last_error();
            continue;
        }
        let flags = v[0];
        let mut details: Vec<&'static str> = p.flags.iter().filter(|(bit, _)| flags & bit != 0).map(|(_, n)| *n).collect();
        if p.class == ProcessDEPPolicy && v[1] & 0xFF != 0 {
            details.push("Permanent");
        }
        out.push(Mitigation { id: p.id, name: p.name, enabled: flags & p.on != 0, details });
    }
    if out.is_empty() && err != 0 {
        return Err(err);
    }
    Ok(out)
}
