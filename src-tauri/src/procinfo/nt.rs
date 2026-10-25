//! ntdll declarations and the raw structures behind the process inspector: the system
//! process snapshot, NtQuery* wrappers, opening processes and bounds-checked memory reads.

use std::ffi::c_void;
use std::mem::size_of;
use std::ptr::{null_mut, read_unaligned};

use windows_sys::Win32::Foundation::{ERROR_ACCESS_DENIED, ERROR_INVALID_PARAMETER, HANDLE};
use windows_sys::Win32::System::Diagnostics::Debug::ReadProcessMemory;
use windows_sys::Win32::System::Threading::{GetExitCodeProcess, OpenProcess, OpenThread};

use crate::winutil::{self, Handle};

windows_link::link!("ntdll.dll" "system" fn NtQuerySystemInformation(class: i32, info: *mut c_void, len: u32, ret_len: *mut u32) -> i32);
windows_link::link!("ntdll.dll" "system" fn NtQueryInformationProcess(process: HANDLE, class: i32, info: *mut c_void, len: u32, ret_len: *mut u32) -> i32);
windows_link::link!("ntdll.dll" "system" fn NtQueryInformationThread(thread: HANDLE, class: i32, info: *mut c_void, len: u32, ret_len: *mut u32) -> i32);
windows_link::link!("ntdll.dll" "system" fn NtQueryObject(handle: HANDLE, class: i32, info: *mut c_void, len: u32, ret_len: *mut u32) -> i32);
windows_link::link!("ntdll.dll" "system" fn NtSuspendProcess(process: HANDLE) -> i32);
windows_link::link!("ntdll.dll" "system" fn NtResumeProcess(process: HANDLE) -> i32);
windows_link::link!("ntdll.dll" "system" fn RtlNtStatusToDosError(status: i32) -> u32);

/// NtQuery* information classes used here.
pub mod class {
    pub const SYSTEM_PROCESSES: i32 = 5;
    pub const SYSTEM_PROCESS_ID: i32 = 88;
    pub const PROCESS_BASIC: i32 = 0;
    pub const PROCESS_WOW64: i32 = 26;
    pub const PROCESS_BREAK_ON_TERMINATION: i32 = 29;
    pub const PROCESS_HANDLES: i32 = 51;
    pub const PROCESS_COMMAND_LINE: i32 = 60;
    pub const PROCESS_PROTECTION: i32 = 61;
    pub const THREAD_BASIC: i32 = 0;
    pub const THREAD_WIN32_START: i32 = 9;
    pub const THREAD_SUSPEND_COUNT: i32 = 35;
    pub const OBJECT_NAME: i32 = 1;
    pub const OBJECT_TYPES: i32 = 3;
}

pub const STATUS_BUFFER_OVERFLOW: i32 = 0x8000_0005_u32 as i32;
pub const STATUS_INFO_LENGTH_MISMATCH: i32 = 0xC000_0004_u32 as i32;
pub const STATUS_BUFFER_TOO_SMALL: i32 = 0xC000_0023_u32 as i32;

/// Largest buffer any NtQuery* call may grow to.
pub const MAX_INFO: usize = 64 << 20;

pub const EXITED: &str = "The process has exited.";

/// The Win32 error code for an NTSTATUS (5 for STATUS_ACCESS_DENIED, …).
pub fn status_error(status: i32) -> u32 {
    unsafe { RtlNtStatusToDosError(status) }
}

pub fn access_denied() -> String {
    denied_to("inspect")
}

/// "Access denied — run Shellmosaic as administrator to `verb` this process."
pub fn denied_to(verb: &str) -> String {
    if winutil::is_elevated() {
        "Access denied — Windows protects this process, even from administrators.".into()
    } else {
        format!("Access denied — run Shellmosaic as administrator to {verb} this process.")
    }
}

/// The message for a failed OpenProcess (or a call that needed more access).
pub fn open_error(err: u32) -> String {
    match err {
        ERROR_ACCESS_DENIED => access_denied(),
        ERROR_INVALID_PARAMETER => EXITED.into(),
        e => format!("Couldn't open the process: {}.", winutil::describe(e)),
    }
}

/// Whether the process behind `h` has ended. Its object outlives it while handles to it
/// are open, and calls on it then fail with "access denied" (STATUS_PROCESS_IS_TERMINATING).
pub fn has_exited(h: HANDLE) -> bool {
    const STILL_ACTIVE: u32 = 259;
    let mut code = 0u32;
    unsafe { GetExitCodeProcess(h, &mut code) != 0 && code != STILL_ACTIVE }
}

/// The message for a call on an opened process that failed with Win32 error `err`.
pub fn call_error(h: HANDLE, err: u32) -> String {
    if has_exited(h) {
        EXITED.into()
    } else {
        open_error(err)
    }
}

/// "0x00007ff6a1b20000"
pub fn hex(v: u64) -> String {
    format!("0x{v:016x}")
}

/// Plain-old-data: any bit pattern is a valid value, so it may be copied out of a raw buffer.
///
/// # Safety
/// Only for `Copy` types made of integers (no references, bools or enums).
pub unsafe trait Plain: Copy + Default {}

unsafe impl Plain for u8 {}
unsafe impl Plain for u16 {}
unsafe impl Plain for u32 {}
unsafe impl Plain for u64 {}
unsafe impl Plain for usize {}
unsafe impl Plain for i32 {}
unsafe impl Plain for i64 {}

/// UNICODE_STRING (the buffer kept as an address).
#[repr(C)]
#[derive(Clone, Copy, Default)]
pub struct UnicodeString {
    pub length: u16,
    pub maximum_length: u16,
    pub buffer: usize,
}
unsafe impl Plain for UnicodeString {}

/// SYSTEM_PROCESS_INFORMATION (256 bytes on x64); its threads follow it.
#[repr(C)]
#[derive(Clone, Copy, Default)]
pub struct SystemProcessInfo {
    pub next_entry_offset: u32,
    pub number_of_threads: u32,
    pub working_set_private_size: i64,
    pub hard_fault_count: u32,
    pub number_of_threads_high_watermark: u32,
    pub cycle_time: u64,
    pub create_time: i64,
    pub user_time: i64,
    pub kernel_time: i64,
    pub image_name: UnicodeString,
    pub base_priority: i32,
    pub unique_process_id: usize,
    pub inherited_from_unique_process_id: usize,
    pub handle_count: u32,
    pub session_id: u32,
    pub unique_process_key: usize,
    pub peak_virtual_size: usize,
    pub virtual_size: usize,
    pub page_fault_count: u32,
    pub peak_working_set_size: usize,
    pub working_set_size: usize,
    pub quota_peak_paged_pool_usage: usize,
    pub quota_paged_pool_usage: usize,
    pub quota_peak_non_paged_pool_usage: usize,
    pub quota_non_paged_pool_usage: usize,
    pub pagefile_usage: usize,
    pub peak_pagefile_usage: usize,
    pub private_page_count: usize,
    pub read_operation_count: i64,
    pub write_operation_count: i64,
    pub other_operation_count: i64,
    pub read_transfer_count: i64,
    pub write_transfer_count: i64,
    pub other_transfer_count: i64,
}
unsafe impl Plain for SystemProcessInfo {}

/// SYSTEM_THREAD_INFORMATION (80 bytes on x64).
#[repr(C)]
#[derive(Clone, Copy, Default)]
pub struct SystemThreadInfo {
    pub kernel_time: i64,
    pub user_time: i64,
    pub create_time: i64,
    pub wait_time: u32,
    pub start_address: usize,
    pub unique_process: usize,
    pub unique_thread: usize,
    pub priority: i32,
    pub base_priority: i32,
    pub context_switches: u32,
    pub thread_state: u32,
    pub wait_reason: u32,
}
unsafe impl Plain for SystemThreadInfo {}

#[cfg(target_pointer_width = "64")]
const _: () = assert!(size_of::<SystemProcessInfo>() == 256 && size_of::<SystemThreadInfo>() == 80);

/// PROCESS_BASIC_INFORMATION
#[repr(C)]
#[derive(Clone, Copy, Default)]
pub struct ProcessBasicInfo {
    pub exit_status: i32,
    pub peb_base_address: usize,
    pub affinity_mask: usize,
    pub base_priority: i32,
    pub unique_process_id: usize,
    pub inherited_from_unique_process_id: usize,
}
unsafe impl Plain for ProcessBasicInfo {}

/// THREAD_BASIC_INFORMATION
#[repr(C)]
#[derive(Clone, Copy, Default)]
pub struct ThreadBasicInfo {
    pub exit_status: i32,
    pub teb_base_address: usize,
    pub unique_process: usize,
    pub unique_thread: usize,
    pub affinity_mask: usize,
    pub priority: i32,
    pub base_priority: i32,
}
unsafe impl Plain for ThreadBasicInfo {}

/// A zeroed, 8-byte aligned buffer for NtQuery* results; `len` is the part the call filled.
pub struct Buf {
    words: Vec<u64>,
    pub len: usize,
}

impl Buf {
    pub fn new(bytes: usize) -> Self {
        Self { words: vec![0; bytes.div_ceil(8).max(1)], len: 0 }
    }

    pub fn capacity(&self) -> usize {
        self.words.len() * 8
    }

    pub fn ptr(&mut self) -> *mut c_void {
        self.words.as_mut_ptr().cast()
    }

    pub fn bytes(&self) -> &[u8] {
        // u64 → u8 view of the same allocation
        unsafe { std::slice::from_raw_parts(self.words.as_ptr().cast::<u8>(), self.len.min(self.capacity())) }
    }

    /// A copy of the `T` at byte offset `off`, if it lies inside the filled part.
    pub fn read<T: Plain>(&self, off: usize) -> Option<T> {
        let b = self.bytes();
        let end = off.checked_add(size_of::<T>())?;
        if end > b.len() {
            return None;
        }
        Some(unsafe { read_unaligned(b.as_ptr().add(off).cast::<T>()) })
    }

    /// Text of a UNICODE_STRING whose characters the kernel placed inside this buffer.
    pub fn ustr(&self, s: &UnicodeString) -> Option<String> {
        if s.length == 0 {
            return Some(String::new());
        }
        let b = self.bytes();
        let start = s.buffer.checked_sub(b.as_ptr() as usize)?;
        let end = start.checked_add(s.length as usize)?;
        Some(utf16_bytes(b.get(start..end)?))
    }
}

/// UTF-16LE bytes → text (up to the first NUL).
pub fn utf16_bytes(b: &[u8]) -> String {
    let units: Vec<u16> = b.chunks_exact(2).map(|c| u16::from_le_bytes([c[0], c[1]])).collect();
    winutil::from_wide(&units)
}

/// Run an NtQuery* call that reports the size it needs, growing the buffer (up to `max`)
/// until the answer fits. Err is the final NTSTATUS.
pub fn query_var(initial: usize, max: usize, mut call: impl FnMut(*mut c_void, u32, &mut u32) -> i32) -> Result<Buf, i32> {
    let mut size = initial.min(max);
    for _ in 0..12 {
        let mut buf = Buf::new(size);
        let mut ret = 0u32;
        let cap = buf.capacity().min(u32::MAX as usize) as u32;
        let st = call(buf.ptr(), cap, &mut ret);
        if st == STATUS_INFO_LENGTH_MISMATCH || st == STATUS_BUFFER_TOO_SMALL || st == STATUS_BUFFER_OVERFLOW {
            if size >= max {
                return Err(st);
            }
            // the answer can grow between calls (new processes, new handles): leave some room
            let need = ret as usize;
            size = if need > size { need + need / 8 + 4096 } else { size * 2 }.min(max);
            continue;
        }
        if st < 0 {
            return Err(st);
        }
        buf.len = if ret == 0 { buf.capacity() } else { (ret as usize).min(buf.capacity()) };
        return Ok(buf);
    }
    Err(STATUS_INFO_LENGTH_MISMATCH)
}

/// A fixed-size NtQueryInformationProcess answer.
pub fn query_process<T: Plain>(h: HANDLE, class: i32) -> Result<T, i32> {
    let mut v = T::default();
    let st = unsafe { NtQueryInformationProcess(h, class, (&mut v as *mut T).cast(), size_of::<T>() as u32, null_mut()) };
    if st < 0 {
        Err(st)
    } else {
        Ok(v)
    }
}

/// A fixed-size NtQueryInformationThread answer.
pub fn query_thread<T: Plain>(h: HANDLE, class: i32) -> Result<T, i32> {
    let mut v = T::default();
    let st = unsafe { NtQueryInformationThread(h, class, (&mut v as *mut T).cast(), size_of::<T>() as u32, null_mut()) };
    if st < 0 {
        Err(st)
    } else {
        Ok(v)
    }
}

/// Open `pid` with the first of `rights` Windows grants. Err is the Win32 error; anything
/// but "access denied" ends the attempts (a missing process won't appear on retry).
pub fn open_process(pid: u32, rights: &[u32]) -> Result<(Handle, u32), u32> {
    let mut err = ERROR_ACCESS_DENIED;
    for &r in rights {
        if let Some(h) = Handle::new(unsafe { OpenProcess(r, 0, pid) }) {
            return Ok((h, r));
        }
        err = winutil::last_error();
        if err != ERROR_ACCESS_DENIED {
            break;
        }
    }
    Err(err)
}

/// Open thread `tid` with the first of `rights` Windows grants.
pub fn open_thread(tid: u32, rights: &[u32]) -> Option<(Handle, u32)> {
    rights
        .iter()
        .find_map(|&r| Handle::new(unsafe { OpenThread(r, 0, tid) }).map(|h| (h, r)))
}

/// Up to 1 MB of another process's memory; None unless all of it could be read.
pub fn read_mem(h: HANDLE, addr: u64, len: usize) -> Option<Vec<u8>> {
    if addr == 0 || len == 0 || len > 1 << 20 || addr.checked_add(len as u64).is_none() {
        return None;
    }
    let addr = usize::try_from(addr).ok()?;
    let mut buf = vec![0u8; len];
    let mut got = 0usize;
    let ok = unsafe { ReadProcessMemory(h, addr as *const c_void, buf.as_mut_ptr().cast(), len, &mut got) };
    (ok != 0 && got == len).then_some(buf)
}

pub fn read_u32(h: HANDLE, addr: u64) -> Option<u32> {
    let b = read_mem(h, addr, 4)?;
    Some(u32::from_le_bytes(b.try_into().ok()?))
}

pub fn read_u64(h: HANDLE, addr: u64) -> Option<u64> {
    let b = read_mem(h, addr, 8)?;
    Some(u64::from_le_bytes(b.try_into().ok()?))
}

/// `bytes` bytes of UTF-16 text at `addr` (capped at 32 KB).
pub fn read_utf16(h: HANDLE, addr: u64, bytes: usize) -> Option<String> {
    if bytes == 0 {
        return Some(String::new());
    }
    let b = read_mem(h, addr, (bytes & !1).min(32 * 1024))?;
    Some(utf16_bytes(&b))
}

/// Where a process's PEBs are: the native one, and the 32-bit one of a WOW64 process.
pub struct Pebs {
    pub native: Option<u64>,
    pub wow64: Option<u64>,
}

impl Pebs {
    pub fn of(h: HANDLE) -> Self {
        let native = query_process::<ProcessBasicInfo>(h, class::PROCESS_BASIC)
            .ok()
            .map(|b| b.peb_base_address as u64)
            .filter(|&p| p != 0);
        let wow64 = query_process::<usize>(h, class::PROCESS_WOW64)
            .ok()
            .map(|p| p as u64)
            .filter(|&p| p != 0);
        Self { native, wow64 }
    }
}

/// A process from the system snapshot.
pub struct ProcEntry {
    pub pid: u32,
    pub ppid: u32,
    pub name: String,
    pub create_time: i64,
    pub user_time: i64,
    pub kernel_time: i64,
    pub base_priority: i32,
    pub handle_count: u32,
    pub session_id: u32,
    pub virtual_size: u64,
    pub peak_working_set: u64,
    pub working_set: u64,
    pub private_bytes: u64,
    pub read_bytes: u64,
    pub write_bytes: u64,
    pub other_bytes: u64,
    pub threads: Vec<ThreadEntry>,
}

/// A thread from the system snapshot.
pub struct ThreadEntry {
    pub tid: u32,
    pub kernel_time: i64,
    pub user_time: i64,
    pub create_time: i64,
    pub start_address: u64,
    pub priority: i32,
    pub base_priority: i32,
    pub context_switches: u32,
    pub state: u32,
    pub wait_reason: u32,
}

pub const THREAD_WAITING: u32 = 5;
const WAIT_SUSPENDED: u32 = 5;
const WAIT_WR_SUSPENDED: u32 = 12;

impl ThreadEntry {
    /// Waiting because it's suspended.
    pub fn is_suspended(&self) -> bool {
        self.state == THREAD_WAITING && matches!(self.wait_reason, WAIT_SUSPENDED | WAIT_WR_SUSPENDED)
    }
}

/// Every process and thread, from one NtQuerySystemInformation(SystemProcessInformation)
/// call: works for protected processes too, without opening them.
pub struct Snapshot {
    pub procs: Vec<ProcEntry>,
}

impl Snapshot {
    pub fn take() -> Result<Self, String> {
        let buf = query_var(1 << 20, MAX_INFO, |p, n, r| unsafe {
            NtQuerySystemInformation(class::SYSTEM_PROCESSES, p, n, r)
        })
        .map_err(|st| format!("Couldn't list the processes: {}.", winutil::describe(status_error(st))))?;

        let mut procs = Vec::new();
        let mut off = 0usize;
        while let Some(p) = buf.read::<SystemProcessInfo>(off) {
            let first = off + size_of::<SystemProcessInfo>();
            let mut threads = Vec::new();
            for i in 0..p.number_of_threads as usize {
                let Some(t) = buf.read::<SystemThreadInfo>(first + i * size_of::<SystemThreadInfo>()) else { break };
                threads.push(ThreadEntry {
                    tid: t.unique_thread as u32,
                    kernel_time: t.kernel_time,
                    user_time: t.user_time,
                    create_time: t.create_time,
                    start_address: t.start_address as u64,
                    priority: t.priority,
                    base_priority: t.base_priority,
                    context_switches: t.context_switches,
                    state: t.thread_state,
                    wait_reason: t.wait_reason,
                });
            }
            let pid = p.unique_process_id as u32;
            let name = match pid {
                0 => "System Idle Process".to_string(),
                _ => buf.ustr(&p.image_name).unwrap_or_default(),
            };
            procs.push(ProcEntry {
                pid,
                ppid: p.inherited_from_unique_process_id as u32,
                name,
                create_time: p.create_time,
                user_time: p.user_time,
                kernel_time: p.kernel_time,
                base_priority: p.base_priority,
                handle_count: p.handle_count,
                session_id: p.session_id,
                virtual_size: p.virtual_size as u64,
                peak_working_set: p.peak_working_set_size as u64,
                working_set: p.working_set_size as u64,
                private_bytes: p.private_page_count as u64,
                read_bytes: p.read_transfer_count.max(0) as u64,
                write_bytes: p.write_transfer_count.max(0) as u64,
                other_bytes: p.other_transfer_count.max(0) as u64,
                threads,
            });
            if p.next_entry_offset == 0 {
                break;
            }
            off += p.next_entry_offset as usize;
        }
        Ok(Self { procs })
    }

    pub fn find(&self, pid: u32) -> Option<&ProcEntry> {
        self.procs.iter().find(|p| p.pid == pid)
    }

    pub fn name(&self, pid: u32) -> Option<&str> {
        self.find(pid).map(|p| p.name.as_str())
    }
}

/// SYSTEM_PROCESS_ID_INFORMATION
#[repr(C)]
struct ProcessIdInfo {
    process_id: usize,
    image_name: UnicodeString,
}

/// The NT path of a process's executable (`\Device\HarddiskVolume3\…`), from the kernel's
/// process list: needs no access to the process itself. Kernel processes without an
/// executable get just a name ("Registry") or nothing.
pub fn image_nt_path(pid: u32) -> Option<String> {
    let mut buf = vec![0u16; 32_767];
    let mut info = ProcessIdInfo {
        process_id: pid as usize,
        image_name: UnicodeString { length: 0, maximum_length: (buf.len() * 2) as u16, buffer: buf.as_mut_ptr() as usize },
    };
    let st = unsafe {
        let len = size_of::<ProcessIdInfo>() as u32;
        NtQuerySystemInformation(class::SYSTEM_PROCESS_ID, (&mut info as *mut ProcessIdInfo).cast(), len, null_mut())
    };
    if st < 0 {
        return None;
    }
    let n = (info.image_name.length as usize / 2).min(buf.len());
    Some(String::from_utf16_lossy(&buf[..n]))
}

/// Whether `pid` still runs (true when the snapshot itself fails, so callers don't
/// claim an exit they couldn't check).
pub fn exists(pid: u32) -> bool {
    Snapshot::take().map_or(true, |s| s.find(pid).is_some())
}
