//! A process's handle table, with object type names and readable object names.

use std::collections::{HashMap, HashSet};
use std::mem::size_of;
use std::ptr::null_mut;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::sync::{Arc, OnceLock};
use std::time::Duration;

use parking_lot::Mutex;
use serde::Serialize;
use windows_sys::Win32::Foundation::{DuplicateHandle, DUPLICATE_SAME_ACCESS, HANDLE};
use windows_sys::Win32::Security::TOKEN_QUERY;
use windows_sys::Win32::System::Threading::{
    GetCurrentProcess, GetProcessId, GetProcessIdOfThread, GetThreadId, OpenProcessToken, PROCESS_DUP_HANDLE,
    PROCESS_QUERY_INFORMATION, PROCESS_QUERY_LIMITED_INFORMATION, THREAD_QUERY_LIMITED_INFORMATION,
};

use super::nt::{self, class, Plain, Snapshot, UnicodeString, MAX_INFO};
use super::token;
use crate::winutil::{strip_prefix_ci, DosPaths, Handle};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcHandle {
    handle: String,
    #[serde(rename = "type")]
    kind: String,
    name: Option<String>,
    access: u32,
    attributes: u32,
    handle_count: u64,
    pointer_count: u64,
    target_pid: Option<u32>,
}

/// PROCESS_HANDLE_TABLE_ENTRY_INFO
#[repr(C)]
#[derive(Clone, Copy, Default)]
struct HandleEntry {
    handle_value: usize,
    handle_count: usize,
    pointer_count: usize,
    granted_access: u32,
    object_type_index: u32,
    handle_attributes: u32,
    reserved: u32,
}
unsafe impl Plain for HandleEntry {}

/// OBJECT_TYPE_INFORMATION (104 bytes on x64); its name's characters follow it.
#[repr(C)]
#[derive(Clone, Copy, Default)]
struct ObjectTypeInfo {
    type_name: UnicodeString,
    counters: [u32; 12],
    invalid_attributes: u32,
    generic_mapping: [u32; 4],
    valid_access_mask: u32,
    security_required: u8,
    maintain_handle_count: u8,
    type_index: u8,
    reserved_byte: u8,
    pool_type: u32,
    default_paged_pool_charge: u32,
    default_non_paged_pool_charge: u32,
}
unsafe impl Plain for ObjectTypeInfo {}

#[cfg(target_pointer_width = "64")]
const _: () = assert!(size_of::<HandleEntry>() == 40 && size_of::<ObjectTypeInfo>() == 104);

/// How long a File handle's name may take before it counts as hung.
const FILE_NAME_TIMEOUT: Duration = Duration::from_millis(300);
/// Hung name queries leak their thread; past this many, File handles stay unnamed.
const MAX_STUCK: usize = 32;
static STUCK: AtomicUsize = AtomicUsize::new(0);

pub fn handles(pid: u32) -> Result<Vec<ProcHandle>, String> {
    if pid == 0 {
        return Ok(Vec::new());
    }
    let (process, rights) = nt::open_process(
        pid,
        &[
            PROCESS_QUERY_INFORMATION | PROCESS_DUP_HANDLE,
            PROCESS_QUERY_INFORMATION,
            PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_DUP_HANDLE,
            PROCESS_QUERY_LIMITED_INFORMATION,
        ],
    )
    .map_err(nt::open_error)?;
    let buf = nt::query_var(64 * 1024, MAX_INFO, |p, n, r| unsafe {
        nt::NtQueryInformationProcess(process.0, class::PROCESS_HANDLES, p, n, r)
    })
    .map_err(|st| nt::call_error(process.0, nt::status_error(st)))?;

    let count = buf.read::<usize>(0).unwrap_or(0);
    let first = 2 * size_of::<usize>();
    let entries: Vec<HandleEntry> = (0..count.min(1 << 20))
        .map_while(|i| buf.read::<HandleEntry>(first + i * size_of::<HandleEntry>()))
        .collect();

    let types = type_names(entries.iter().map(|e| e.object_type_index));
    let mut namer = (rights & PROCESS_DUP_HANDLE != 0).then(|| Namer::new(pid, process.0));
    Ok(entries
        .iter()
        .map(|e| {
            let kind = types.get(&e.object_type_index).cloned().unwrap_or_else(|| format!("Type {}", e.object_type_index));
            let (name, target_pid) = match namer.as_mut() {
                Some(n) => n.name(e.handle_value, &kind),
                None => (None, None),
            };
            ProcHandle {
                handle: format!("0x{:x}", e.handle_value),
                kind,
                name,
                access: e.granted_access,
                attributes: e.handle_attributes,
                handle_count: e.handle_count as u64,
                pointer_count: e.pointer_count as u64,
                target_pid,
            }
        })
        .collect())
}

/// Object type index → name ("File", "Key", …), cached; reloaded when an index is missing.
fn type_names(wanted: impl Iterator<Item = u32>) -> Arc<HashMap<u32, String>> {
    static CACHE: OnceLock<Mutex<Arc<HashMap<u32, String>>>> = OnceLock::new();
    let cache = CACHE.get_or_init(Default::default);
    let mut current = cache.lock().clone();
    let missing = wanted.collect::<HashSet<_>>().into_iter().any(|i| !current.contains_key(&i));
    if missing || current.is_empty() {
        if let Some(fresh) = load_type_names() {
            current = Arc::new(fresh);
            *cache.lock() = current.clone();
        }
    }
    current
}

fn load_type_names() -> Option<HashMap<u32, String>> {
    let buf = nt::query_var(32 * 1024, 4 << 20, |p, n, r| unsafe { nt::NtQueryObject(null_mut(), class::OBJECT_TYPES, p, n, r) }).ok()?;
    let count = buf.read::<u32>(0)? as usize;
    let align = size_of::<usize>();
    let mut off = align;
    let mut map = HashMap::new();
    for i in 0..count.min(1024) {
        let Some(t) = buf.read::<ObjectTypeInfo>(off) else { break };
        let name = buf.ustr(&t.type_name).unwrap_or_default();
        // TypeIndex exists since Windows 8.1; before, types were numbered from 2
        let index = if t.type_index != 0 { t.type_index as u32 } else { i as u32 + 2 };
        map.insert(index, name);
        off += size_of::<ObjectTypeInfo>() + (t.type_name.maximum_length as usize).next_multiple_of(align);
    }
    Some(map)
}

/// Names the handles of one process by duplicating them into Shellmosaic.
struct Namer {
    pid: u32,
    process: HANDLE,
    snapshot: Option<Snapshot>,
    user_sid: String,
    dos: Arc<DosPaths>,
    files: Option<FileNamer>,
}

impl Namer {
    fn new(pid: u32, process: HANDLE) -> Self {
        Self { pid, process, snapshot: Snapshot::take().ok(), user_sid: current_user_sid(), dos: DosPaths::get(), files: None }
    }

    /// A duplicate of the target's handle `value` in this process.
    fn dup(&self, value: usize, access: Option<u32>) -> Option<Handle> {
        let mut out: HANDLE = null_mut();
        let (desired, options) = match access {
            Some(a) => (a, 0),
            None => (0, DUPLICATE_SAME_ACCESS),
        };
        let ok = unsafe { DuplicateHandle(self.process, value as HANDLE, GetCurrentProcess(), &mut out, desired, 0, options) };
        if ok == 0 {
            return None;
        }
        Handle::new(out)
    }

    fn process_name(&self, pid: u32) -> String {
        let name = self.snapshot.as_ref().and_then(|s| s.name(pid)).unwrap_or("Exited process");
        format!("{name} ({pid})")
    }

    /// `query` on a duplicate with the handle's own access, else on one asking for just
    /// `access` (the handle may not allow queries itself).
    fn query_dup<T>(&self, value: usize, access: u32, query: impl Fn(HANDLE) -> Option<T>) -> Option<T> {
        [None, Some(access)].into_iter().find_map(|a| self.dup(value, a).and_then(|d| query(d.0)))
    }

    fn name(&mut self, value: usize, kind: &str) -> (Option<String>, Option<u32>) {
        match kind {
            "Process" => {
                let pid = self.query_dup(value, PROCESS_QUERY_LIMITED_INFORMATION, |h| {
                    Some(unsafe { GetProcessId(h) }).filter(|&p| p != 0)
                });
                match pid {
                    Some(pid) => (Some(self.process_name(pid)), Some(pid)),
                    None => (None, None),
                }
            }
            "Thread" => {
                let ids = self.query_dup(value, THREAD_QUERY_LIMITED_INFORMATION, |h| {
                    let tid = unsafe { GetThreadId(h) };
                    (tid != 0).then(|| (tid, unsafe { GetProcessIdOfThread(h) }))
                });
                match ids {
                    Some((tid, pid)) => (Some(format!("{}: {tid}", self.process_name(pid))), Some(pid)),
                    None => (None, None),
                }
            }
            "Token" => (self.query_dup(value, TOKEN_QUERY, token_user), None),
            _ => {
                let Some(dup) = self.dup(value, None) else { return (None, None) };
                match kind {
                    "File" => (self.file_name(value, dup), None),
                    "Key" => (object_name(dup.0).map(|n| key_name(&n, &self.user_sid)), None),
                    _ => (object_name(dup.0), None),
                }
            }
        }
    }

    /// A File handle's name, queried on a worker thread: the query waits for the file
    /// object's lock, which a synchronous read (a pipe, a console) can hold indefinitely.
    fn file_name(&mut self, value: usize, dup: Handle) -> Option<String> {
        static HUNG: OnceLock<Mutex<HashSet<(u32, usize)>>> = OnceLock::new();
        let hung = HUNG.get_or_init(Default::default);
        if hung.lock().contains(&(self.pid, value)) || STUCK.load(Ordering::Relaxed) >= MAX_STUCK {
            return None;
        }
        if self.files.is_none() {
            self.files = FileNamer::spawn();
        }
        let namer = self.files.as_ref()?;
        if namer.jobs.send(dup).is_err() {
            self.files = None;
            return None;
        }
        match namer.results.recv_timeout(FILE_NAME_TIMEOUT) {
            Ok(name) => name.map(|n| self.dos.convert(&n)),
            Err(RecvTimeoutError::Timeout) => {
                // abandon the stuck worker (it ends if the query ever returns) and remember the
                // handle, so refreshing the list doesn't strand another thread on it
                STUCK.fetch_add(1, Ordering::SeqCst);
                namer.abandoned.store(true, Ordering::SeqCst);
                self.files = None;
                let mut h = hung.lock();
                if h.len() > 4096 {
                    h.clear();
                }
                h.insert((self.pid, value));
                None
            }
            Err(RecvTimeoutError::Disconnected) => {
                self.files = None;
                None
            }
        }
    }
}

/// A worker thread that names the File handles it's handed (and closes them).
struct FileNamer {
    jobs: mpsc::Sender<Handle>,
    results: mpsc::Receiver<Option<String>>,
    /// set (after STUCK was counted up) when the caller gave up waiting on it
    abandoned: Arc<AtomicBool>,
}

impl FileNamer {
    fn spawn() -> Option<Self> {
        let (jobs, job_rx) = mpsc::channel::<Handle>();
        let (result_tx, results) = mpsc::channel();
        let abandoned = Arc::new(AtomicBool::new(false));
        let flag = abandoned.clone();
        std::thread::Builder::new()
            .name("procinfo-file-names".into())
            .stack_size(64 * 1024)
            .spawn(move || {
                for h in job_rx {
                    let name = object_name(h.0);
                    drop(h);
                    if result_tx.send(name).is_err() {
                        break;
                    }
                }
                // the caller only drops the channels after flagging an abandoned worker
                if flag.load(Ordering::SeqCst) {
                    STUCK.fetch_sub(1, Ordering::SeqCst);
                }
            })
            .ok()?;
        Some(Self { jobs, results, abandoned })
    }
}

/// NtQueryObject(ObjectNameInformation); None for unnamed objects.
fn object_name(h: HANDLE) -> Option<String> {
    let buf = nt::query_var(1024, 64 * 1024, |p, n, r| unsafe { nt::NtQueryObject(h, class::OBJECT_NAME, p, n, r) }).ok()?;
    let s = buf.read::<UnicodeString>(0)?;
    buf.ustr(&s).filter(|n| !n.is_empty())
}

/// A token's user, "DOMAIN\name" (or the SID).
fn token_user(tok: HANDLE) -> Option<String> {
    token::user(tok).map(|(name, sid)| name.unwrap_or(sid))
}

/// Shellmosaic's own user SID, to show its registry hive as HKCU.
fn current_user_sid() -> String {
    static SID: OnceLock<String> = OnceLock::new();
    SID.get_or_init(|| {
        let mut tok: HANDLE = null_mut();
        if unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut tok) } == 0 {
            return String::new();
        }
        Handle::new(tok).and_then(|t| token::user(t.0)).map(|(_, sid)| sid).unwrap_or_default()
    })
    .clone()
}

/// `\REGISTRY\MACHINE\…` → `HKLM\…`, `\REGISTRY\USER\<sid>\…` → `HKU\<sid>\…`
/// (HKCU for the current user, whose `<sid>_Classes` is `HKCU\Software\Classes`).
fn key_name(raw: &str, user_sid: &str) -> String {
    let under = |prefix: &str| strip_prefix_ci(raw, prefix).filter(|rest| rest.is_empty() || rest.starts_with('\\'));
    if let Some(rest) = under(r"\REGISTRY\MACHINE") {
        return format!("HKLM{rest}");
    }
    if let Some(rest) = under(r"\REGISTRY\USER") {
        let rest = rest.trim_start_matches('\\');
        let (hive, tail) = rest.find('\\').map_or((rest, ""), |i| (&rest[..i], &rest[i..]));
        if !user_sid.is_empty() {
            if hive.eq_ignore_ascii_case(user_sid) {
                return format!("HKCU{tail}");
            }
            if strip_prefix_ci(hive, user_sid).is_some_and(|s| s.eq_ignore_ascii_case("_Classes")) {
                return format!(r"HKCU\Software\Classes{tail}");
            }
        }
        return if rest.is_empty() { "HKU".into() } else { format!(r"HKU\{rest}") };
    }
    raw.to_string()
}

#[cfg(test)]
mod tests {
    use super::key_name;

    #[test]
    fn registry_paths_become_hive_names() {
        let me = "S-1-5-21-1-2-3-1001";
        assert_eq!(key_name(r"\REGISTRY\MACHINE\SOFTWARE\x", me), r"HKLM\SOFTWARE\x");
        assert_eq!(key_name(r"\REGISTRY\MACHINE", me), "HKLM");
        assert_eq!(key_name(r"\REGISTRY\USER\S-1-5-21-1-2-3-1001\Console", me), r"HKCU\Console");
        assert_eq!(key_name(r"\REGISTRY\USER\S-1-5-21-1-2-3-1001_Classes\.txt", me), r"HKCU\Software\Classes\.txt");
        assert_eq!(key_name(r"\REGISTRY\USER\S-1-5-18\Software", me), r"HKU\S-1-5-18\Software");
        assert_eq!(key_name(r"\REGISTRY\MACHINEX", me), r"\REGISTRY\MACHINEX");
    }
}
