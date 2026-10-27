//! Process ancestry for the pipe's caller check (is this hook or MCP shim running under
//! the agent's own Claude Code process?) and whole-tree kills.

use std::collections::HashMap;
use std::mem::size_of;

use windows_sys::Win32::Foundation::FILETIME;
use windows_sys::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS,
};
use windows_sys::Win32::System::Threading::{GetProcessTimes, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION};

use crate::paths::hidden_command;
use crate::winutil::Handle;

/// When a process started (100 ns units since 1601), or `None` if it's gone or not ours.
pub fn created(pid: u32) -> Option<u64> {
    unsafe {
        let h = Handle::new(OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid))?;
        let zero = FILETIME { dwLowDateTime: 0, dwHighDateTime: 0 };
        let (mut c, mut e, mut k, mut u) = (zero, zero, zero, zero);
        if GetProcessTimes(h.0, &mut c, &mut e, &mut k, &mut u) == 0 {
            return None;
        }
        Some(((c.dwHighDateTime as u64) << 32) | c.dwLowDateTime as u64)
    }
}

/// pid → parent pid for every process right now.
fn parents() -> HashMap<u32, u32> {
    let mut map = HashMap::new();
    unsafe {
        let Some(snap) = Handle::new(CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0)) else { return map };
        let mut e: PROCESSENTRY32W = std::mem::zeroed();
        e.dwSize = size_of::<PROCESSENTRY32W>() as u32;
        if Process32FirstW(snap.0, &mut e) != 0 {
            loop {
                map.insert(e.th32ProcessID, e.th32ParentProcessID);
                if Process32NextW(snap.0, &mut e) == 0 {
                    break;
                }
            }
        }
    }
    map
}

/// Whether `pid` runs under `ancestor` (started at `ancestor_created`), at most `depth`
/// levels down. A parent id can belong to a newer process that reused it after the real
/// parent exited, so every link must have started no later than its child.
pub fn descends_from(pid: u32, ancestor: u32, ancestor_created: u64, depth: usize) -> bool {
    let map = parents();
    let mut cur = pid;
    let Some(mut cur_created) = created(cur) else { return false };
    for _ in 0..=depth {
        if cur == ancestor {
            return cur_created == ancestor_created;
        }
        let Some(&parent) = map.get(&cur) else { return false };
        if parent == 0 || parent == cur {
            return false;
        }
        let Some(parent_created) = created(parent) else { return false };
        if parent_created > cur_created {
            return false;
        }
        cur = parent;
        cur_created = parent_created;
    }
    false
}

/// End a process and everything it started (builds, dev servers, language servers…).
pub fn kill_tree(pid: u32) {
    let _ = hidden_command("taskkill").args(["/PID", &pid.to_string(), "/T", "/F"]).output();
}
