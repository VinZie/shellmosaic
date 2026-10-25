//! A fresh per-user environment for new shells — what Explorer would give a new
//! process (system + user variables from the registry). Like Windows Terminal,
//! this keeps variables from whatever launched Shellmosaic (NO_COLOR, tokens,
//! tool markers…) out of terminals, and picks up PATH changes without a restart.

/// The user's default environment, or `None` if Windows won't build one.
#[cfg(windows)]
pub fn fresh_environment() -> Option<Vec<(String, String)>> {
    use core::ffi::c_void;
    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
    use windows_sys::Win32::Security::TOKEN_QUERY;
    use windows_sys::Win32::System::Environment::{CreateEnvironmentBlock, DestroyEnvironmentBlock};
    use windows_sys::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};

    // SAFETY: plain Win32 calls; the block is a sequence of NUL-terminated UTF-16
    // "KEY=VALUE" strings ending with an empty string, freed with DestroyEnvironmentBlock.
    unsafe {
        let mut token: HANDLE = std::ptr::null_mut();
        if OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) == 0 {
            return None;
        }
        let mut block: *mut c_void = std::ptr::null_mut();
        let ok = CreateEnvironmentBlock(&mut block, token, 0);
        CloseHandle(token);
        if ok == 0 || block.is_null() {
            return None;
        }
        let mut vars = Vec::new();
        let mut p = block as *const u16;
        loop {
            let mut len = 0usize;
            while *p.add(len) != 0 {
                len += 1;
            }
            if len == 0 {
                break;
            }
            let entry = String::from_utf16_lossy(std::slice::from_raw_parts(p, len));
            if let Some(kv) = split_entry(&entry) {
                vars.push(kv);
            }
            p = p.add(len + 1);
        }
        DestroyEnvironmentBlock(block);
        Some(vars)
    }
}

#[cfg(not(windows))]
pub fn fresh_environment() -> Option<Vec<(String, String)>> {
    None
}

/// "KEY=VALUE" → (KEY, VALUE). Hidden per-drive entries like "=C:=C:\x" are skipped.
fn split_entry(entry: &str) -> Option<(String, String)> {
    if entry.starts_with('=') {
        return None;
    }
    let (k, v) = entry.split_once('=')?;
    Some((k.to_string(), v.to_string()))
}

/// Case-insensitive lookup (Windows variable names ignore case).
pub fn lookup<'a>(vars: &'a [(String, String)], key: &str) -> Option<&'a str> {
    vars.iter().find(|(k, _)| k.eq_ignore_ascii_case(key)).map(|(_, v)| v.as_str())
}
