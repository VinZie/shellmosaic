//! A process's threads: the system snapshot's view (state, wait reason, times), plus
//! what opening each thread adds (Win32 start address, suspend count, description).

use std::ptr::null_mut;

use serde::Serialize;
use windows_sys::Win32::Foundation::LocalFree;
use windows_sys::Win32::System::Threading::{GetThreadDescription, THREAD_QUERY_INFORMATION, THREAD_QUERY_LIMITED_INFORMATION};

use super::modules::Symbols;
use super::nt::{self, class, hex, Snapshot, ThreadEntry, EXITED, THREAD_WAITING};
use crate::winutil::{filetime_ms, from_pwstr, ticks_ms};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcThread {
    tid: u32,
    start_address: String,
    start_symbol: Option<String>,
    win32_start_address: Option<String>,
    win32_start_symbol: Option<String>,
    state: String,
    wait_reason: Option<String>,
    priority: i32,
    base_priority: i32,
    context_switches: u32,
    kernel_ms: u64,
    user_ms: u64,
    create_time: Option<i64>,
    description: Option<String>,
    suspend_count: Option<u32>,
    suspended: bool,
}

pub fn threads(pid: u32) -> Result<Vec<ProcThread>, String> {
    let snap = Snapshot::take()?;
    let entry = snap.find(pid).ok_or(EXITED)?;
    let symbols = Symbols::load(pid);
    Ok(entry.threads.iter().map(|t| thread(t, &symbols)).collect())
}

fn thread(t: &ThreadEntry, symbols: &Symbols) -> ProcThread {
    let mut win32_start = None;
    let mut suspend_count = None;
    let mut description = None;
    // the Idle process's threads all have ID 0
    let opened = if t.tid == 0 { None } else { nt::open_thread(t.tid, &[THREAD_QUERY_INFORMATION, THREAD_QUERY_LIMITED_INFORMATION]) };
    if let Some((h, _)) = opened {
        win32_start = nt::query_thread::<usize>(h.0, class::THREAD_WIN32_START).ok().map(|a| a as u64);
        suspend_count = nt::query_thread::<u32>(h.0, class::THREAD_SUSPEND_COUNT).ok();
        description = thread_description(h.0);
    }
    let waiting = t.state == THREAD_WAITING;
    ProcThread {
        tid: t.tid,
        start_address: hex(t.start_address),
        start_symbol: symbols.name(t.start_address),
        win32_start_address: win32_start.map(hex),
        win32_start_symbol: win32_start.and_then(|a| symbols.name(a)),
        state: thread_state(t.state),
        wait_reason: waiting.then(|| wait_reason(t.wait_reason)),
        priority: t.priority,
        base_priority: t.base_priority,
        context_switches: t.context_switches,
        kernel_ms: ticks_ms(t.kernel_time),
        user_ms: ticks_ms(t.user_time),
        create_time: (t.create_time > 0).then(|| filetime_ms(t.create_time)),
        description,
        suspend_count,
        suspended: t.is_suspended() || suspend_count.is_some_and(|n| n > 0),
    }
}

fn thread_description(h: windows_sys::Win32::Foundation::HANDLE) -> Option<String> {
    let mut p: *mut u16 = null_mut();
    let hr = unsafe { GetThreadDescription(h, &mut p) };
    if hr < 0 || p.is_null() {
        return None;
    }
    let s = unsafe { from_pwstr(p) };
    unsafe { LocalFree(p.cast()) };
    Some(s).filter(|s| !s.is_empty())
}

/// KTHREAD_STATE
fn thread_state(s: u32) -> String {
    const NAMES: [&str; 10] = [
        "Initialized",
        "Ready",
        "Running",
        "Standby",
        "Terminated",
        "Waiting",
        "Transition",
        "DeferredReady",
        "GateWaitObsolete",
        "WaitingForProcessInSwap",
    ];
    NAMES.get(s as usize).map_or_else(|| s.to_string(), |n| n.to_string())
}

/// KWAIT_REASON
fn wait_reason(r: u32) -> String {
    const NAMES: [&str; 42] = [
        "Executive",
        "FreePage",
        "PageIn",
        "PoolAllocation",
        "DelayExecution",
        "Suspended",
        "UserRequest",
        "WrExecutive",
        "WrFreePage",
        "WrPageIn",
        "WrPoolAllocation",
        "WrDelayExecution",
        "WrSuspended",
        "WrUserRequest",
        "WrSpare0",
        "WrQueue",
        "WrLpcReceive",
        "WrLpcReply",
        "WrVirtualMemory",
        "WrPageOut",
        "WrRendezvous",
        "WrKeyedEvent",
        "WrTerminated",
        "WrProcessInSwap",
        "WrCpuRateControl",
        "WrCalloutStack",
        "WrKernel",
        "WrResource",
        "WrPushLock",
        "WrMutex",
        "WrQuantumEnd",
        "WrDispatchInt",
        "WrPreempted",
        "WrYieldExecution",
        "WrFastMutex",
        "WrGuardedMutex",
        "WrRundown",
        "WrAlertByThreadId",
        "WrDeferredPreempt",
        "WrPhysicalFault",
        "WrIoRing",
        "WrMdlCache",
    ];
    NAMES.get(r as usize).map_or_else(|| r.to_string(), |n| n.to_string())
}
