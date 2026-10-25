//! A process's access token: user, integrity, elevation, groups, privileges, capabilities.

use std::mem::{align_of, size_of};
use std::ptr::null_mut;

use serde::Serialize;
use windows_sys::Win32::Foundation::{HANDLE, LUID};
use windows_sys::Win32::Security::{
    GetTokenInformation, LookupPrivilegeDisplayNameW, LookupPrivilegeNameW, TokenAppContainerSid, TokenCapabilities,
    TokenElevation, TokenElevationType, TokenGroups, TokenImpersonationLevel, TokenIntegrityLevel, TokenIsAppContainer,
    TokenOwner, TokenPrimaryGroup, TokenPrivileges, TokenSessionId, TokenSource, TokenStatistics, TokenType, TokenUIAccess,
    TokenUser, TokenVirtualizationAllowed, TokenVirtualizationEnabled, PSID, SE_PRIVILEGE_ENABLED,
    SE_PRIVILEGE_ENABLED_BY_DEFAULT, SE_PRIVILEGE_REMOVED, TOKEN_INFORMATION_CLASS, TOKEN_QUERY, TOKEN_QUERY_SOURCE,
};
use windows_sys::Win32::System::Threading::{OpenProcessToken, PROCESS_QUERY_LIMITED_INFORMATION};

use super::nt::{self, Buf, Plain};
use crate::winutil::{self, from_wide, sid_name, sid_string, Handle};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TokenGroup {
    name: Option<String>,
    sid: String,
    attributes: u32,
    flags: Vec<&'static str>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TokenPrivilege {
    name: String,
    description: Option<String>,
    enabled: bool,
    enabled_by_default: bool,
    removed: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Capability {
    name: Option<String>,
    sid: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcToken {
    user: Option<String>,
    user_sid: String,
    owner: Option<String>,
    primary_group: Option<String>,
    integrity: Option<String>,
    integrity_rid: Option<u32>,
    session_id: u32,
    elevated: bool,
    elevation_type: &'static str,
    token_type: &'static str,
    impersonation_level: Option<&'static str>,
    logon_id: String,
    token_id: String,
    source: Option<String>,
    virtualization_allowed: bool,
    virtualization_enabled: bool,
    ui_access: bool,
    app_container: bool,
    app_container_sid: Option<String>,
    groups: Vec<TokenGroup>,
    privileges: Vec<TokenPrivilege>,
    capabilities: Vec<Capability>,
}

#[repr(C)]
#[derive(Clone, Copy, Default)]
struct SidAndAttributes {
    sid: usize,
    attributes: u32,
}
unsafe impl Plain for SidAndAttributes {}

#[repr(C)]
#[derive(Clone, Copy, Default)]
struct LuidAndAttributes {
    low: u32,
    high: i32,
    attributes: u32,
}
unsafe impl Plain for LuidAndAttributes {}

/// TOKEN_STATISTICS
#[repr(C)]
#[derive(Clone, Copy, Default)]
struct Statistics {
    token_id: [u32; 2],
    authentication_id: [u32; 2],
    expiration_time: i64,
    token_type: i32,
    impersonation_level: i32,
    dynamic_charged: u32,
    dynamic_available: u32,
    group_count: u32,
    privilege_count: u32,
    modified_id: [u32; 2],
}
unsafe impl Plain for Statistics {}

/// TOKEN_SOURCE
#[repr(C)]
#[derive(Clone, Copy, Default)]
struct Source {
    name: [u8; 8],
    identifier: [u32; 2],
}
unsafe impl Plain for Source {}

/// Open the token of a process (`process` needs PROCESS_QUERY_LIMITED_INFORMATION);
/// with TOKEN_QUERY_SOURCE when allowed. Err is the Win32 error.
pub fn open(process: HANDLE) -> Result<(Handle, bool), u32> {
    for (access, source) in [(TOKEN_QUERY | TOKEN_QUERY_SOURCE, true), (TOKEN_QUERY, false)] {
        let mut tok: HANDLE = null_mut();
        if unsafe { OpenProcessToken(process, access, &mut tok) } != 0 {
            if let Some(h) = Handle::new(tok) {
                return Ok((h, source));
            }
        }
    }
    Err(winutil::last_error())
}

/// A GetTokenInformation answer.
fn info(tok: HANDLE, class: TOKEN_INFORMATION_CLASS) -> Option<Buf> {
    let mut need = 0u32;
    unsafe { GetTokenInformation(tok, class, null_mut(), 0, &mut need) };
    if need == 0 || need > 1 << 20 {
        return None;
    }
    let mut buf = Buf::new(need as usize);
    let mut got = 0u32;
    if unsafe { GetTokenInformation(tok, class, buf.ptr(), buf.capacity() as u32, &mut got) } == 0 {
        return None;
    }
    buf.len = (got as usize).min(buf.capacity());
    Some(buf)
}

fn info_value<T: Plain>(tok: HANDLE, class: TOKEN_INFORMATION_CLASS) -> Option<T> {
    let mut v = T::default();
    let mut got = 0u32;
    let ok = unsafe { GetTokenInformation(tok, class, (&mut v as *mut T).cast(), size_of::<T>() as u32, &mut got) };
    (ok != 0).then_some(v)
}

/// The SID at address `p` if all of it lies inside `buf`.
fn sid_in(buf: &Buf, p: usize) -> Option<PSID> {
    let b = buf.bytes();
    let off = p.checked_sub(b.as_ptr() as usize)?;
    let sub_authorities = *b.get(off.checked_add(1)?)? as usize;
    if off.checked_add(8 + 4 * sub_authorities)? > b.len() {
        return None;
    }
    Some(p as PSID)
}

/// (name, SID string) of the SID at `p` in `buf`.
fn account(buf: &Buf, p: usize) -> Option<(Option<String>, String)> {
    let sid = sid_in(buf, p)?;
    unsafe { Some((sid_name(sid), sid_string(sid))) }
}

/// The SID that a structure starting with a SID pointer (TOKEN_USER, TOKEN_OWNER, …) names.
fn first_account(tok: HANDLE, class: TOKEN_INFORMATION_CLASS) -> Option<(Option<String>, String)> {
    let buf = info(tok, class)?;
    account(&buf, buf.read::<usize>(0)?)
}

/// (name, SID string) of a token's user; `tok` needs TOKEN_QUERY.
pub fn user(tok: HANDLE) -> Option<(Option<String>, String)> {
    first_account(tok, TokenUser)
}

/// The entries of a TOKEN_GROUPS answer.
fn groups(tok: HANDLE, class: TOKEN_INFORMATION_CLASS) -> Vec<(Option<String>, String, u32)> {
    let Some(buf) = info(tok, class) else { return Vec::new() };
    let count = buf.read::<u32>(0).unwrap_or(0) as usize;
    let first = 4usize.next_multiple_of(align_of::<SidAndAttributes>());
    (0..count.min(4096))
        .map_while(|i| buf.read::<SidAndAttributes>(first + i * size_of::<SidAndAttributes>()))
        .filter_map(|g| account(&buf, g.sid).map(|(name, sid)| (name, sid, g.attributes)))
        .collect()
}

pub fn integrity_name(rid: u32) -> &'static str {
    match rid {
        0..0x1000 => "Untrusted",
        0x1000..0x2000 => "Low",
        0x2000..0x2100 => "Medium",
        0x2100..0x3000 => "Medium Plus",
        0x3000..0x4000 => "High",
        0x4000..0x5000 => "System",
        _ => "Protected",
    }
}

fn integrity(tok: HANDLE) -> Option<u32> {
    let buf = info(tok, TokenIntegrityLevel)?;
    let sid = buf.read::<usize>(0)?;
    sid_in(&buf, sid)?;
    // the RID is the last sub-authority
    let off = sid - buf.bytes().as_ptr() as usize;
    let n = *buf.bytes().get(off + 1)? as usize;
    if n == 0 {
        return None;
    }
    buf.read::<u32>(off + 8 + 4 * (n - 1))
}

fn elevation_type(tok: HANDLE) -> Option<&'static str> {
    Some(match info_value::<i32>(tok, TokenElevationType)? {
        2 => "full",
        3 => "limited",
        _ => "default",
    })
}

/// "enabled" | "disabled" | "notAllowed"
fn virtualization(tok: HANDLE) -> Option<&'static str> {
    let allowed = info_value::<u32>(tok, TokenVirtualizationAllowed)?;
    let enabled = info_value::<u32>(tok, TokenVirtualizationEnabled)?;
    Some(match (allowed != 0, enabled != 0) {
        (false, _) => "notAllowed",
        (true, true) => "enabled",
        (true, false) => "disabled",
    })
}

/// What the overview shows of a token.
pub struct Summary {
    pub user: Option<String>,
    pub user_sid: Option<String>,
    pub integrity: Option<String>,
    pub elevated: Option<bool>,
    pub elevation_type: Option<&'static str>,
    pub virtualization: Option<&'static str>,
}

pub fn summary(tok: HANDLE) -> Summary {
    let user = first_account(tok, TokenUser);
    Summary {
        user: user.as_ref().map(|(n, s)| n.clone().unwrap_or_else(|| s.clone())),
        user_sid: user.map(|(_, s)| s),
        integrity: integrity(tok).map(|r| integrity_name(r).to_string()),
        elevated: info_value::<u32>(tok, TokenElevation).map(|e| e != 0),
        elevation_type: elevation_type(tok),
        virtualization: virtualization(tok),
    }
}

fn luid_hex(l: [u32; 2]) -> String {
    format!("0x{:x}", ((l[1] as u64) << 32) | l[0] as u64)
}

fn group_flags(a: u32) -> Vec<&'static str> {
    const FLAGS: [(u32, &str); 9] = [
        (0x1, "Mandatory"),
        (0x2, "EnabledByDefault"),
        (0x4, "Enabled"),
        (0x8, "Owner"),
        (0x10, "DenyOnly"),
        (0x20, "Integrity"),
        (0x40, "IntegrityEnabled"),
        (0xC000_0000, "LogonId"),
        (0x2000_0000, "Resource"),
    ];
    FLAGS.iter().filter(|(bit, _)| a & bit == *bit).map(|(_, n)| *n).collect()
}

fn privileges(tok: HANDLE) -> Vec<TokenPrivilege> {
    let Some(buf) = info(tok, TokenPrivileges) else { return Vec::new() };
    let count = buf.read::<u32>(0).unwrap_or(0) as usize;
    (0..count.min(256))
        .map_while(|i| buf.read::<LuidAndAttributes>(4 + i * size_of::<LuidAndAttributes>()))
        .filter_map(|p| {
            let luid = LUID { LowPart: p.low, HighPart: p.high };
            let mut name = [0u16; 128];
            let mut len = name.len() as u32;
            if unsafe { LookupPrivilegeNameW(std::ptr::null(), &luid, name.as_mut_ptr(), &mut len) } == 0 {
                return None;
            }
            let mut desc = [0u16; 256];
            let mut dlen = desc.len() as u32;
            let mut lang = 0u32;
            let described =
                unsafe { LookupPrivilegeDisplayNameW(std::ptr::null(), name.as_ptr(), desc.as_mut_ptr(), &mut dlen, &mut lang) } != 0;
            Some(TokenPrivilege {
                name: from_wide(&name),
                description: described.then(|| from_wide(&desc)).filter(|d| !d.is_empty()),
                enabled: p.attributes & SE_PRIVILEGE_ENABLED != 0,
                enabled_by_default: p.attributes & SE_PRIVILEGE_ENABLED_BY_DEFAULT != 0,
                removed: p.attributes & SE_PRIVILEGE_REMOVED != 0,
            })
        })
        .collect()
}

pub fn token(pid: u32) -> Result<ProcToken, String> {
    if pid == 0 {
        return Err("The System Idle Process has no access token.".into());
    }
    let (process, _) = nt::open_process(pid, &[PROCESS_QUERY_LIMITED_INFORMATION]).map_err(nt::open_error)?;
    if nt::has_exited(process.0) {
        return Err(nt::EXITED.into());
    }
    let (tok, with_source) = open(process.0).map_err(|e| nt::call_error(process.0, e))?;
    let t = tok.0;
    let (user, user_sid) = first_account(t, TokenUser).ok_or("Couldn't read the process's token.")?;
    let name = |a: Option<(Option<String>, String)>| a.map(|(n, s)| n.unwrap_or(s));
    let rid = integrity(t);
    let stats = info_value::<Statistics>(t, TokenStatistics).unwrap_or_default();
    let primary = info_value::<i32>(t, TokenType).unwrap_or(1) != 2;
    let impersonation_level = if primary {
        None
    } else {
        info_value::<i32>(t, TokenImpersonationLevel).map(|l| match l {
            0 => "anonymous",
            1 => "identification",
            2 => "impersonation",
            _ => "delegation",
        })
    };
    let source = if with_source {
        info_value::<Source>(t, TokenSource).map(|s| {
            let end = s.name.iter().position(|&c| c == 0).unwrap_or(s.name.len());
            String::from_utf8_lossy(&s.name[..end]).trim().to_string()
        })
    } else {
        None
    };
    let app_container = info_value::<u32>(t, TokenIsAppContainer).unwrap_or(0) != 0;
    let app_container_sid = if app_container {
        info(t, TokenAppContainerSid).and_then(|b| account(&b, b.read::<usize>(0)?)).map(|(_, s)| s)
    } else {
        None
    };
    Ok(ProcToken {
        user,
        user_sid,
        owner: name(first_account(t, TokenOwner)),
        primary_group: name(first_account(t, TokenPrimaryGroup)),
        integrity: rid.map(|r| integrity_name(r).to_string()),
        integrity_rid: rid,
        session_id: info_value::<u32>(t, TokenSessionId).unwrap_or(0),
        elevated: info_value::<u32>(t, TokenElevation).is_some_and(|e| e != 0),
        elevation_type: elevation_type(t).unwrap_or("default"),
        token_type: if primary { "primary" } else { "impersonation" },
        impersonation_level,
        logon_id: luid_hex(stats.authentication_id),
        token_id: luid_hex(stats.token_id),
        source: source.filter(|s| !s.is_empty()),
        virtualization_allowed: info_value::<u32>(t, TokenVirtualizationAllowed).unwrap_or(0) != 0,
        virtualization_enabled: info_value::<u32>(t, TokenVirtualizationEnabled).unwrap_or(0) != 0,
        ui_access: info_value::<u32>(t, TokenUIAccess).unwrap_or(0) != 0,
        app_container,
        app_container_sid,
        groups: groups(t, TokenGroups)
            .into_iter()
            .map(|(name, sid, attributes)| TokenGroup { name, sid, attributes, flags: group_flags(attributes) })
            .collect(),
        privileges: privileges(t),
        capabilities: groups(t, TokenCapabilities).into_iter().map(|(name, sid, _)| Capability { name, sid }).collect(),
    })
}
