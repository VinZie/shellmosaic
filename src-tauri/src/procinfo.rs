//! Process Inspector backend (plugin permissions `process.inspect` / `process.control`).
//! Result shapes: modules/shared/api.ts (ProcOverview, ProcModule, ProcThread, …).
//!
//! The Win32 work lives in the submodules, which don't depend on Tauri (so they can be
//! exercised against real processes on their own); this file only exposes it as commands.

mod control;
mod handles;
mod memory;
mod modules;
mod nt;
mod overview;
mod signature;
mod threads;
mod token;

use crate::paths::blocking;
use crate::winutil::DebugPrivilege;

/// Run `work` on the blocking pool, with SeDebugPrivilege enabled on that thread while it
/// runs (when Shellmosaic is elevated).
async fn run<T: Send + 'static>(work: impl FnOnce() -> Result<T, String> + Send + 'static) -> Result<T, String> {
    blocking(move || {
        let _debug = DebugPrivilege::acquire();
        work()
    })
    .await?
}

#[tauri::command]
pub async fn process_overview(pid: u32) -> Result<overview::ProcOverview, String> {
    run(move || overview::overview(pid)).await
}

#[tauri::command]
pub async fn process_modules(pid: u32) -> Result<Vec<modules::ProcModule>, String> {
    run(move || modules::modules(pid)).await
}

#[tauri::command]
pub async fn process_threads(pid: u32) -> Result<Vec<threads::ProcThread>, String> {
    run(move || threads::threads(pid)).await
}

#[tauri::command]
pub async fn process_handles(pid: u32) -> Result<Vec<handles::ProcHandle>, String> {
    run(move || handles::handles(pid)).await
}

#[tauri::command]
pub async fn process_token(pid: u32) -> Result<token::ProcToken, String> {
    run(move || token::token(pid)).await
}

#[tauri::command]
pub async fn process_memory(pid: u32) -> Result<Vec<memory::MemRegion>, String> {
    run(move || memory::memory(pid)).await
}

#[tauri::command]
pub async fn process_signature(path: String) -> Result<signature::Signature, String> {
    run(move || signature::signature(&path)).await
}

/// `action`: "suspend" | "resume" | "priority" (value: PriorityClass) | "affinity" (value: decimal mask)
#[tauri::command]
pub async fn process_control(pid: u32, action: String, value: Option<String>) -> Result<(), String> {
    run(move || control::process_control(pid, &action, value.as_deref())).await
}

/// `action`: "suspend" | "resume" | "terminate"; the thread must belong to `pid`
#[tauri::command]
pub async fn thread_control(pid: u32, tid: u32, action: String) -> Result<(), String> {
    run(move || control::thread_control(pid, tid, &action)).await
}
