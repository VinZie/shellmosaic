//! Suspending, resuming and re-prioritizing processes, and suspending, resuming or
//! ending threads (`process.control`), with guards against freezing Windows or Shellmosaic.

use windows_sys::Win32::Foundation::{ERROR_ACCESS_DENIED, ERROR_INVALID_PARAMETER};
use windows_sys::Win32::System::Threading::{
    GetProcessAffinityMask, GetProcessIdOfThread, OpenThread, ResumeThread, SetPriorityClass, SetProcessAffinityMask,
    SuspendThread, TerminateThread, ABOVE_NORMAL_PRIORITY_CLASS, BELOW_NORMAL_PRIORITY_CLASS, HIGH_PRIORITY_CLASS,
    IDLE_PRIORITY_CLASS, NORMAL_PRIORITY_CLASS, PROCESS_QUERY_INFORMATION, PROCESS_QUERY_LIMITED_INFORMATION,
    PROCESS_SET_INFORMATION, PROCESS_SUSPEND_RESUME, REALTIME_PRIORITY_CLASS, THREAD_QUERY_LIMITED_INFORMATION,
    THREAD_SUSPEND_RESUME, THREAD_TERMINATE,
};

use super::nt::{self, class, Snapshot, EXITED};
use crate::winutil::{self, Handle};

fn error(err: u32) -> String {
    match err {
        ERROR_ACCESS_DENIED => nt::denied_to("control"),
        ERROR_INVALID_PARAMETER => EXITED.into(),
        e => format!("Windows refused: {}.", winutil::describe(e)),
    }
}

/// Open `pid` for `rights`, plus querying (to tell an ended process from a refusal).
fn open(pid: u32, rights: u32) -> Result<Handle, String> {
    nt::open_process(pid, &[rights | PROCESS_QUERY_LIMITED_INFORMATION]).map(|(h, _)| h).map_err(error)
}

/// The message for a failed call on an opened process.
fn failed(h: &Handle, err: u32) -> String {
    if nt::has_exited(h.0) {
        EXITED.into()
    } else {
        error(err)
    }
}

/// No changes to the kernel's pseudo-processes or to Shellmosaic itself.
fn refuse_special(pid: u32) -> Result<(), String> {
    match pid {
        0 => Err("The System Idle Process can't be changed.".into()),
        4 => Err("The System process is the Windows kernel and can't be changed.".into()),
        p if p == std::process::id() => Err("That's Shellmosaic itself.".into()),
        _ => Ok(()),
    }
}

/// Refuse to stop a critical process (csrss, wininit, …): Windows bugchecks when one
/// ends, and freezes when one stops running. Also refuses when that can't be checked.
fn refuse_critical(pid: u32, verb: &str) -> Result<(), String> {
    let name = Snapshot::take().ok().and_then(|s| s.name(pid).map(str::to_string)).unwrap_or_else(|| format!("Process {pid}"));
    let (h, _) = nt::open_process(pid, &[PROCESS_QUERY_INFORMATION, PROCESS_QUERY_LIMITED_INFORMATION]).map_err(error)?;
    match nt::query_process::<u32>(h.0, class::PROCESS_BREAK_ON_TERMINATION) {
        Ok(0) => Ok(()),
        Ok(_) => Err(format!("{name} is critical to Windows: {verb} it would freeze or crash the system.")),
        Err(_) => Err(format!("Couldn't check whether {name} is critical to Windows, so it was left alone.")),
    }
}

/// `action`: "suspend" | "resume" | "priority" (value: PriorityClass) | "affinity" (value: decimal mask)
pub fn process_control(pid: u32, action: &str, value: Option<&str>) -> Result<(), String> {
    refuse_special(pid)?;
    match action {
        "suspend" => {
            refuse_critical(pid, "suspending")?;
            let h = open(pid, PROCESS_SUSPEND_RESUME)?;
            nt_result(&h, unsafe { nt::NtSuspendProcess(h.0) })
        }
        "resume" => {
            let h = open(pid, PROCESS_SUSPEND_RESUME)?;
            nt_result(&h, unsafe { nt::NtResumeProcess(h.0) })
        }
        "priority" => {
            let class = priority_class(value.unwrap_or_default())?;
            let h = open(pid, PROCESS_SET_INFORMATION)?;
            win_result(&h, unsafe { SetPriorityClass(h.0, class) })
        }
        "affinity" => {
            let mask: usize = value
                .and_then(|v| v.trim().parse().ok())
                .ok_or("The affinity must be a decimal processor mask.")?;
            if mask == 0 {
                return Err("Choose at least one processor.".into());
            }
            let h = open(pid, PROCESS_SET_INFORMATION)?;
            let (mut current, mut system) = (0usize, 0usize);
            if unsafe { GetProcessAffinityMask(h.0, &mut current, &mut system) } == 0 {
                return Err(failed(&h, winutil::last_error()));
            }
            if mask & !system != 0 {
                return Err("The mask includes processors this computer doesn't have.".into());
            }
            win_result(&h, unsafe { SetProcessAffinityMask(h.0, mask) })
        }
        _ => Err(format!("Unknown process action \"{action}\".")),
    }
}

/// `action`: "suspend" | "resume" | "terminate"; the thread must belong to `pid`.
pub fn thread_control(pid: u32, tid: u32, action: &str) -> Result<(), String> {
    refuse_special(pid)?;
    let access = match action {
        "suspend" | "resume" => THREAD_SUSPEND_RESUME,
        "terminate" => THREAD_TERMINATE,
        _ => return Err(format!("Unknown thread action \"{action}\".")),
    };
    let Some(h) = Handle::new(unsafe { OpenThread(access | THREAD_QUERY_LIMITED_INFORMATION, 0, tid) }) else {
        return Err(match winutil::last_error() {
            ERROR_INVALID_PARAMETER => "The thread has exited.".into(),
            e => error(e),
        });
    };
    let owner = unsafe { GetProcessIdOfThread(h.0) };
    if owner != pid {
        return Err(format!("Thread {tid} doesn't belong to process {pid}."));
    }
    match action {
        "suspend" => {
            refuse_critical(pid, "suspending a thread of")?;
            thread_result(unsafe { SuspendThread(h.0) } != u32::MAX)
        }
        "resume" => thread_result(unsafe { ResumeThread(h.0) } != u32::MAX),
        _ => {
            refuse_critical(pid, "ending a thread of")?;
            thread_result(unsafe { TerminateThread(h.0, 1) } != 0)
        }
    }
}

fn priority_class(name: &str) -> Result<u32, String> {
    Ok(match name {
        "idle" => IDLE_PRIORITY_CLASS,
        "belowNormal" => BELOW_NORMAL_PRIORITY_CLASS,
        "normal" => NORMAL_PRIORITY_CLASS,
        "aboveNormal" => ABOVE_NORMAL_PRIORITY_CLASS,
        "high" => HIGH_PRIORITY_CLASS,
        "realtime" => REALTIME_PRIORITY_CLASS,
        _ => return Err(format!("Unknown priority \"{name}\".")),
    })
}

fn nt_result(h: &Handle, status: i32) -> Result<(), String> {
    if status < 0 {
        Err(failed(h, nt::status_error(status)))
    } else {
        Ok(())
    }
}

fn win_result(h: &Handle, ok: i32) -> Result<(), String> {
    if ok == 0 {
        Err(failed(h, winutil::last_error()))
    } else {
        Ok(())
    }
}

fn thread_result(ok: bool) -> Result<(), String> {
    if ok {
        Ok(())
    } else {
        Err(error(winutil::last_error()))
    }
}
