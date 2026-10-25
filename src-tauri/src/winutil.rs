//! Small Win32 helpers for the process inspector, the event log and elevation:
//! wide strings, owned handles, SIDs, device paths and the debug privilege.

use std::collections::HashMap;
use std::mem::size_of;
use std::ptr::{null, null_mut};
use std::sync::OnceLock;
use std::time::{Duration, Instant};

use parking_lot::Mutex;
use windows_sys::Win32::Foundation::{CloseHandle, GetLastError, LocalFree, HANDLE, INVALID_HANDLE_VALUE, LUID};
use windows_sys::Win32::Security::Authorization::ConvertSidToStringSidW;
use windows_sys::Win32::Security::{
    AdjustTokenPrivileges, GetTokenInformation, ImpersonateSelf, LookupAccountSidW, LookupPrivilegeValueW, RevertToSelf,
    SecurityImpersonation, TokenElevation, LUID_AND_ATTRIBUTES, PSID, SE_PRIVILEGE_ENABLED, SID_NAME_USE, TOKEN_ADJUST_PRIVILEGES,
    TOKEN_ELEVATION, TOKEN_PRIVILEGES, TOKEN_QUERY,
};
use windows_sys::Win32::Storage::FileSystem::QueryDosDeviceW;
use windows_sys::Win32::System::Threading::{GetCurrentProcess, GetCurrentThread, OpenProcessToken, OpenThreadToken};

pub fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

/// Text of a NUL-terminated (or full) UTF-16 buffer.
pub fn from_wide(buf: &[u16]) -> String {
    let end = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
    String::from_utf16_lossy(&buf[..end])
}

/// # Safety
/// `p` must be null or point to a NUL-terminated UTF-16 string.
pub unsafe fn from_pwstr(p: *const u16) -> String {
    if p.is_null() {
        return String::new();
    }
    let mut n = 0;
    while *p.add(n) != 0 {
        n += 1;
    }
    String::from_utf16_lossy(std::slice::from_raw_parts(p, n))
}

/// A kernel handle closed on drop.
pub struct Handle(pub HANDLE);

impl Handle {
    pub fn new(h: HANDLE) -> Option<Self> {
        if h.is_null() || h == INVALID_HANDLE_VALUE {
            None
        } else {
            Some(Self(h))
        }
    }
}

impl Drop for Handle {
    fn drop(&mut self) {
        unsafe { CloseHandle(self.0) };
    }
}

// handles are process-wide; whoever owns this one closes it
unsafe impl Send for Handle {}

pub fn last_error() -> u32 {
    unsafe { GetLastError() }
}

/// A Windows error code as a short sentence.
pub fn describe(code: u32) -> String {
    match code {
        5 => "access denied".into(),
        87 => "the process has exited (or the ID isn't valid)".into(),
        299 => "only part of the request could be read (the process may be starting or exiting)".into(),
        1223 => "cancelled".into(),
        _ => {
            let text = std::io::Error::from_raw_os_error(code as i32).to_string();
            // "Access is denied. (os error 5)" → "Access is denied."
            match text.rfind(" (os error") {
                Some(i) => text[..i].trim_end_matches('.').to_string(),
                None => text,
            }
        }
    }
}

pub fn last_error_text() -> String {
    describe(last_error())
}

/// FILETIME / LARGE_INTEGER time (100 ns since 1601) → Unix milliseconds.
pub fn filetime_ms(t: i64) -> i64 {
    if t <= 0 {
        return 0;
    }
    (t - 116_444_736_000_000_000) / 10_000
}

/// 100 ns units → milliseconds.
pub fn ticks_ms(t: i64) -> u64 {
    (t.max(0) / 10_000) as u64
}

/// Whether Shellmosaic itself runs elevated (as administrator).
pub fn is_elevated() -> bool {
    static ELEVATED: OnceLock<bool> = OnceLock::new();
    *ELEVATED.get_or_init(|| unsafe {
        let mut tok: HANDLE = null_mut();
        if OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut tok) == 0 {
            return false;
        }
        let tok = Handle(tok);
        let mut e = TOKEN_ELEVATION { TokenIsElevated: 0 };
        let mut len = 0u32;
        GetTokenInformation(tok.0, TokenElevation, &mut e as *mut _ as _, size_of::<TOKEN_ELEVATION>() as u32, &mut len) != 0
            && e.TokenIsElevated != 0
    })
}

/// While alive, the current thread impersonates Shellmosaic with SeDebugPrivilege
/// enabled (only when elevated). Only this thread gets it: shells started by the app
/// keep the privilege disabled, as an elevated process normally has it.
pub struct DebugPrivilege {
    active: bool,
}

impl DebugPrivilege {
    pub fn acquire() -> Self {
        if !is_elevated() {
            return Self { active: false };
        }
        unsafe {
            if ImpersonateSelf(SecurityImpersonation) == 0 {
                return Self { active: false };
            }
            let me = Self { active: true };
            let mut tok: HANDLE = null_mut();
            if OpenThreadToken(GetCurrentThread(), TOKEN_ADJUST_PRIVILEGES | TOKEN_QUERY, 1, &mut tok) == 0 {
                return me;
            }
            let tok = Handle(tok);
            let mut luid = LUID { LowPart: 0, HighPart: 0 };
            let name = wide("SeDebugPrivilege");
            if LookupPrivilegeValueW(null(), name.as_ptr(), &mut luid) != 0 {
                let tp = TOKEN_PRIVILEGES {
                    PrivilegeCount: 1,
                    Privileges: [LUID_AND_ATTRIBUTES { Luid: luid, Attributes: SE_PRIVILEGE_ENABLED }],
                };
                AdjustTokenPrivileges(tok.0, 0, &tp, 0, null_mut(), null_mut());
            }
            me
        }
    }
}

impl Drop for DebugPrivilege {
    fn drop(&mut self) {
        // blocking-pool threads are reused: never leave one impersonating
        if self.active {
            unsafe { RevertToSelf() };
        }
    }
}

/// "S-1-5-18"
///
/// # Safety
/// `sid` must point to a valid SID.
pub unsafe fn sid_string(sid: PSID) -> String {
    let mut out: *mut u16 = null_mut();
    if ConvertSidToStringSidW(sid, &mut out) == 0 {
        return String::new();
    }
    let s = from_pwstr(out);
    LocalFree(out as _);
    s
}

/// "DOMAIN\name" for a SID, cached (lookups of domain accounts can be slow).
///
/// # Safety
/// `sid` must point to a valid SID.
pub unsafe fn sid_name(sid: PSID) -> Option<String> {
    static CACHE: OnceLock<Mutex<HashMap<String, Option<String>>>> = OnceLock::new();
    let key = sid_string(sid);
    let cache = CACHE.get_or_init(Default::default);
    if let Some(v) = cache.lock().get(&key) {
        return v.clone();
    }
    let mut name = [0u16; 256];
    let mut domain = [0u16; 256];
    let (mut nl, mut dl) = (name.len() as u32, domain.len() as u32);
    let mut use_: SID_NAME_USE = 0;
    let v = if LookupAccountSidW(null(), sid, name.as_mut_ptr(), &mut nl, domain.as_mut_ptr(), &mut dl, &mut use_) != 0 {
        let (n, d) = (from_wide(&name), from_wide(&domain));
        Some(if d.is_empty() { n } else { format!("{d}\\{n}") })
    } else {
        None
    };
    let mut c = cache.lock();
    if c.len() > 4096 {
        c.clear();
    }
    c.insert(key, v.clone());
    v
}

/// Kernel paths (`\Device\HarddiskVolume3\x`) → `C:\x`.
pub struct DosPaths {
    devices: Vec<(String, String)>,
}

impl DosPaths {
    /// The drive mapping, refreshed at most every 30 s.
    pub fn get() -> std::sync::Arc<DosPaths> {
        static CACHE: OnceLock<Mutex<Option<(Instant, std::sync::Arc<DosPaths>)>>> = OnceLock::new();
        let cache = CACHE.get_or_init(Default::default);
        let mut g = cache.lock();
        if let Some((t, d)) = g.as_ref() {
            if t.elapsed() < Duration::from_secs(30) {
                return d.clone();
            }
        }
        let d = std::sync::Arc::new(Self::load());
        *g = Some((Instant::now(), d.clone()));
        d
    }

    fn load() -> Self {
        let mut devices = Vec::new();
        for letter in b'A'..=b'Z' {
            let drive = format!("{}:", letter as char);
            let mut buf = [0u16; 512];
            let n = unsafe { QueryDosDeviceW(wide(&drive).as_ptr(), buf.as_mut_ptr(), buf.len() as u32) };
            if n > 0 {
                // the first string of the (multi-string) answer is the current target
                let target = from_wide(&buf);
                if !target.is_empty() {
                    devices.push((target.to_ascii_lowercase(), drive));
                }
            }
        }
        // longest first: \Device\HarddiskVolume1 must not match \Device\HarddiskVolume10
        devices.sort_by(|a, b| b.0.len().cmp(&a.0.len()));
        Self { devices }
    }

    pub fn convert(&self, path: &str) -> String {
        let lower = path.to_ascii_lowercase();
        for (dev, drive) in &self.devices {
            if lower.starts_with(dev.as_str()) && (lower.len() == dev.len() || lower.as_bytes()[dev.len()] == b'\\') {
                return format!("{drive}{}", &path[dev.len()..]);
            }
        }
        if let Some(rest) = strip_prefix_ci(path, r"\??\") {
            return rest.to_string();
        }
        if let Some(rest) = strip_prefix_ci(path, r"\Device\Mup\") {
            return format!(r"\\{rest}");
        }
        if let Some(rest) = strip_prefix_ci(path, r"\SystemRoot\") {
            let root = std::env::var("SystemRoot").unwrap_or_else(|_| r"C:\Windows".into());
            return format!(r"{root}\{rest}");
        }
        path.to_string()
    }
}

pub fn strip_prefix_ci<'a>(s: &'a str, prefix: &str) -> Option<&'a str> {
    if s.len() >= prefix.len() && s.is_char_boundary(prefix.len()) && s[..prefix.len()].eq_ignore_ascii_case(prefix) {
        Some(&s[prefix.len()..])
    } else {
        None
    }
}

/// Wait (up to `timeout`) for a process to exit — a restarted Shellmosaic waits for the old
/// one, which still holds the single-instance lock and the state files.
pub fn wait_for_exit(pid: u32, timeout: Duration) {
    use windows_sys::Win32::System::Threading::{OpenProcess, WaitForSingleObject, PROCESS_SYNCHRONIZE};
    unsafe {
        if let Some(h) = Handle::new(OpenProcess(PROCESS_SYNCHRONIZE, 0, pid)) {
            WaitForSingleObject(h.0, timeout.as_millis().min(u32::MAX as u128 - 1) as u32);
        }
    }
}

/// Start `exe` as administrator (the UAC prompt). Returns once the user has answered.
pub fn run_elevated(exe: &std::path::Path, params: &str) -> Result<(), String> {
    use windows_sys::Win32::UI::Shell::{ShellExecuteExW, SEE_MASK_NOASYNC, SHELLEXECUTEINFOW};
    use windows_sys::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;
    let verb = wide("runas");
    let file = wide(&exe.to_string_lossy());
    let params = wide(params);
    unsafe {
        let mut info: SHELLEXECUTEINFOW = std::mem::zeroed();
        info.cbSize = size_of::<SHELLEXECUTEINFOW>() as u32;
        info.fMask = SEE_MASK_NOASYNC;
        info.lpVerb = verb.as_ptr();
        info.lpFile = file.as_ptr();
        info.lpParameters = params.as_ptr();
        info.nShow = SW_SHOWNORMAL;
        if ShellExecuteExW(&mut info) == 0 {
            return Err(match last_error() {
                1223 => "You didn't allow Shellmosaic to run as administrator.".into(),
                e => format!("Couldn't start Shellmosaic as administrator: {}", describe(e)),
            });
        }
    }
    Ok(())
}

/// A local, non-network path (`C:\…`): what Explorer may be pointed at without
/// connecting anywhere (a `\\host\share` path would make it log in to that host).
pub fn is_local_path(p: &str) -> bool {
    let b = p.as_bytes();
    b.len() >= 3 && b[0].is_ascii_alphabetic() && b[1] == b':' && (b[2] == b'\\' || b[2] == b'/') && !p.contains("..")
}
