//! Loaded modules (Toolhelp) with their version resources, and addresses named as
//! "module.dll+0x1a2b" against them.

use std::collections::{HashMap, HashSet};
use std::ffi::c_void;
use std::mem::{size_of, zeroed};
use std::ptr::null_mut;
use std::sync::OnceLock;
use std::time::{Duration, UNIX_EPOCH};

use parking_lot::Mutex;
use serde::Serialize;
use windows_sys::Win32::Foundation::{ERROR_ACCESS_DENIED, ERROR_BAD_LENGTH, ERROR_PARTIAL_COPY, HANDLE, HMODULE};
use windows_sys::Win32::Storage::FileSystem::{GetFileVersionInfoSizeW, GetFileVersionInfoW, VerQueryValueW};
use windows_sys::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, Module32FirstW, Module32NextW, MODULEENTRY32W, TH32CS_SNAPMODULE, TH32CS_SNAPMODULE32,
};
use windows_sys::Win32::System::Threading::{QueryFullProcessImageNameW, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION};

use super::nt::{self, hex, EXITED};
use crate::winutil::{self, from_wide, is_local_path, wide, Handle};

// windows-sys has these behind the System_LibraryLoader feature
windows_link::link!("kernel32.dll" "system" fn LoadLibraryExW(name: *const u16, file: HANDLE, flags: u32) -> HMODULE);
windows_link::link!("kernel32.dll" "system" fn FreeLibrary(module: HMODULE) -> i32);
windows_link::link!("kernel32.dll" "system" fn FindResourceW(module: HMODULE, name: *const u16, kind: *const u16) -> *mut c_void);
windows_link::link!("kernel32.dll" "system" fn SizeofResource(module: HMODULE, res: *mut c_void) -> u32);
windows_link::link!("kernel32.dll" "system" fn LoadResource(module: HMODULE, res: *mut c_void) -> *mut c_void);
windows_link::link!("kernel32.dll" "system" fn LockResource(data: *mut c_void) -> *mut c_void);

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcModule {
    name: String,
    path: String,
    base: String,
    size: u64,
    is_main: bool,
    description: Option<String>,
    company: Option<String>,
    version: Option<String>,
}

/// A module from the Toolhelp snapshot.
pub struct ModEntry {
    pub name: String,
    pub path: String,
    pub base: u64,
    pub size: u64,
}

/// The modules loaded in `pid` (native and, for WOW64 processes, 32-bit), in load order.
/// Err is the Win32 error.
pub fn list(pid: u32) -> Result<Vec<ModEntry>, u32> {
    let mut snap = None;
    // the snapshot fails transiently while the process loads or unloads modules
    for attempt in 0..6 {
        match Handle::new(unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPMODULE | TH32CS_SNAPMODULE32, pid) }) {
            Some(h) => {
                snap = Some(h);
                break;
            }
            None => {
                let e = winutil::last_error();
                if (e != ERROR_BAD_LENGTH && e != ERROR_PARTIAL_COPY) || attempt == 5 {
                    return Err(e);
                }
                std::thread::sleep(Duration::from_millis(15));
            }
        }
    }
    let Some(snap) = snap else { return Err(ERROR_PARTIAL_COPY) };
    let mut e: MODULEENTRY32W = unsafe { zeroed() };
    e.dwSize = size_of::<MODULEENTRY32W>() as u32;
    let mut out = Vec::new();
    let mut seen = HashSet::new();
    let mut more = unsafe { Module32FirstW(snap.0, &mut e) } != 0;
    while more && out.len() < 65_536 {
        let m = ModEntry {
            name: from_wide(&e.szModule),
            path: from_wide(&e.szExePath),
            base: e.modBaseAddr as u64,
            size: e.modBaseSize as u64,
        };
        // a WOW64 process's executable is in both the native and the 32-bit list
        if seen.insert((m.base, m.size)) {
            out.push(m);
        }
        more = unsafe { Module32NextW(snap.0, &mut e) } != 0;
    }
    Ok(out)
}

/// The full Win32 path of a process's executable.
pub fn image_path(h: HANDLE) -> Result<String, u32> {
    let mut buf = vec![0u16; 32_768];
    let mut len = buf.len() as u32;
    if unsafe { QueryFullProcessImageNameW(h, PROCESS_NAME_WIN32, buf.as_mut_ptr(), &mut len) } == 0 {
        return Err(winutil::last_error());
    }
    Ok(String::from_utf16_lossy(&buf[..(len as usize).min(buf.len())]))
}

/// Names addresses as "module+0x…".
pub struct Symbols(Vec<ModEntry>);

impl Symbols {
    /// The modules of `pid`; empty (no names) when they can't be listed.
    pub fn load(pid: u32) -> Self {
        let mut mods = if pid == 0 || pid == 4 { Vec::new() } else { list(pid).unwrap_or_default() };
        mods.sort_by_key(|m| m.base);
        Self(mods)
    }

    pub fn name(&self, addr: u64) -> Option<String> {
        let i = self.0.partition_point(|m| m.base <= addr);
        let m = self.0.get(i.checked_sub(1)?)?;
        (addr < m.base.saturating_add(m.size)).then(|| format!("{}+0x{:x}", m.name, addr - m.base))
    }
}

pub fn modules(pid: u32) -> Result<Vec<ProcModule>, String> {
    // the Idle and System processes have no user-mode modules
    if pid == 0 || pid == 4 {
        return Ok(Vec::new());
    }
    let mods = match list(pid) {
        Ok(m) => m,
        Err(_) if !nt::exists(pid) => return Err(EXITED.into()),
        Err(ERROR_ACCESS_DENIED) => return Err(nt::access_denied()),
        Err(e) => return Err(format!("Couldn't list the modules: {}.", winutil::describe(e))),
    };
    let main = nt::open_process(pid, &[PROCESS_QUERY_LIMITED_INFORMATION])
        .ok()
        .and_then(|(h, _)| image_path(h.0).ok())
        .map(|p| p.to_lowercase());
    let mut any_main = false;
    let mut out: Vec<ProcModule> = mods
        .into_iter()
        .map(|m| {
            let is_main = main.as_deref().is_some_and(|p| p == m.path.to_lowercase());
            any_main |= is_main;
            let v = version_info(&m.path);
            ProcModule {
                name: m.name,
                path: m.path,
                base: hex(m.base),
                size: m.size,
                is_main,
                description: v.description,
                company: v.company,
                version: v.version,
            }
        })
        .collect();
    // Toolhelp lists the executable first
    if !any_main {
        if let Some(m) = out.first_mut() {
            m.is_main = true;
        }
    }
    Ok(out)
}

#[derive(Clone, Default)]
pub struct VersionInfo {
    pub description: Option<String>,
    pub company: Option<String>,
    pub version: Option<String>,
}

/// Answers about files, keyed by (path, size, modified time) so a changed file is
/// looked at again.
pub struct FileCache<V>(Mutex<HashMap<(String, u64, u128), V>>);

impl<V: Clone> FileCache<V> {
    pub fn new() -> Self {
        Self(Mutex::new(HashMap::new()))
    }

    /// The cached answer for `path`, else `compute`'s (computed without holding the lock).
    pub fn get(&self, path: &str, meta: &std::fs::Metadata, compute: impl FnOnce() -> V) -> V {
        let mtime = meta.modified().ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map_or(0, |d| d.as_nanos());
        let key = (path.to_lowercase(), meta.len(), mtime);
        if let Some(v) = self.0.lock().get(&key) {
            return v.clone();
        }
        let v = compute();
        let mut c = self.0.lock();
        if c.len() >= 4096 {
            c.clear();
        }
        c.insert(key, v.clone());
        v
    }
}

/// A file's version resource. Local files only: reading `\\host\…` would make Windows
/// log in to that host.
pub fn version_info(path: &str) -> VersionInfo {
    static CACHE: OnceLock<FileCache<VersionInfo>> = OnceLock::new();
    if !is_local_path(path) {
        return VersionInfo::default();
    }
    let Ok(meta) = std::fs::metadata(path) else { return VersionInfo::default() };
    CACHE.get_or_init(FileCache::new).get(path, &meta, || read_version(path))
}

/// Frees a library loaded as a data file.
struct DataFile(HMODULE);

impl Drop for DataFile {
    fn drop(&mut self) {
        unsafe { FreeLibrary(self.0) };
    }
}

/// The file's VS_VERSION_INFO resource, read straight from the file (mapped as data, not
/// loaded as code): GetFileVersionInfoW reports Windows' own files as version 6.2 to
/// programs whose manifest doesn't declare Windows 10 support, and Tauri's doesn't.
/// u32-backed so the UTF-16 inside is aligned, with spare room after it as
/// GetFileVersionInfoW leaves.
fn raw_version_block(path: &str) -> Option<Vec<u32>> {
    const LOAD_LIBRARY_AS_DATAFILE: u32 = 0x2;
    const LOAD_LIBRARY_AS_IMAGE_RESOURCE: u32 = 0x20;
    const VS_VERSION_INFO: usize = 1;
    const RT_VERSION: usize = 16;
    let wpath = wide(path);
    let module = unsafe { LoadLibraryExW(wpath.as_ptr(), null_mut(), LOAD_LIBRARY_AS_DATAFILE | LOAD_LIBRARY_AS_IMAGE_RESOURCE) };
    if module.is_null() {
        return None;
    }
    let module = DataFile(module);
    unsafe {
        // integer resource IDs are passed as pointers (MAKEINTRESOURCE)
        let res = FindResourceW(module.0, VS_VERSION_INFO as *const u16, RT_VERSION as *const u16);
        if res.is_null() {
            return None;
        }
        let size = SizeofResource(module.0, res) as usize;
        let data = LoadResource(module.0, res);
        if size == 0 || size > 1 << 20 || data.is_null() {
            return None;
        }
        let p = LockResource(data).cast::<u8>();
        if p.is_null() {
            return None;
        }
        let mut block = vec![0u32; size.div_ceil(4) * 2 + 16];
        std::ptr::copy_nonoverlapping(p, block.as_mut_ptr().cast::<u8>(), size);
        Some(block)
    }
}

/// GetFileVersionInfoW's copy, for files whose version resource has an unusual ID.
fn api_version_block(path: &str) -> Option<Vec<u32>> {
    let wpath = wide(path);
    let mut ignored = 0u32;
    let size = unsafe { GetFileVersionInfoSizeW(wpath.as_ptr(), &mut ignored) } as usize;
    if size == 0 || size > 4 << 20 {
        return None;
    }
    let mut block = vec![0u32; size.div_ceil(4)];
    let bytes = block.len() * 4;
    (unsafe { GetFileVersionInfoW(wpath.as_ptr(), 0, bytes as u32, block.as_mut_ptr().cast()) } != 0).then_some(block)
}

fn read_version(path: &str) -> VersionInfo {
    let Some(block) = raw_version_block(path).or_else(|| api_version_block(path)) else { return VersionInfo::default() };
    let res = Resource { block: &block };

    let mut translations: Vec<(u16, u16)> = Vec::new();
    if let Some(t) = res.query(r"\VarFileInfo\Translation") {
        if t.len() >= 4 {
            translations.push((u16::from_le_bytes([t[0], t[1]]), u16::from_le_bytes([t[2], t[3]])));
        }
    }
    translations.extend([(0x0409, 0x04B0), (0x0409, 0x04E4), (0x0409, 0x0000)]);

    let mut v = VersionInfo::default();
    for (lang, cp) in translations {
        let get = |name: &str| {
            res.query(&format!(r"\StringFileInfo\{lang:04x}{cp:04x}\{name}"))
                .map(nt::utf16_bytes)
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
        };
        v.description = get("FileDescription");
        v.company = get("CompanyName");
        v.version = get("FileVersion");
        if v.description.is_some() || v.company.is_some() || v.version.is_some() {
            break;
        }
    }
    // Windows' own FileVersion strings aren't updated by patches; the fixed info is
    if let Some(fixed) = res.fixed_version() {
        v.version = Some(fixed);
    }
    v
}

/// A loaded version resource.
struct Resource<'a> {
    block: &'a [u32],
}

impl Resource<'_> {
    /// The bytes VerQueryValueW finds for `sub_block`, checked to lie inside the resource.
    fn query(&self, sub_block: &str) -> Option<&[u8]> {
        let mut p: *mut c_void = null_mut();
        let mut len = 0u32;
        let w = wide(sub_block);
        if unsafe { VerQueryValueW(self.block.as_ptr().cast(), w.as_ptr(), &mut p, &mut len) } == 0 || p.is_null() {
            return None;
        }
        let all = unsafe { std::slice::from_raw_parts(self.block.as_ptr().cast::<u8>(), self.block.len() * 4) };
        let start = (p as usize).checked_sub(all.as_ptr() as usize)?;
        // strings report characters (with the NUL), binary values bytes
        let n = if sub_block.starts_with(r"\StringFileInfo") { len as usize * 2 } else { len as usize };
        let end = start.checked_add(n)?.min(all.len());
        all.get(start..end)
    }

    /// "10.0.26100.1" from VS_FIXEDFILEINFO, read from the block itself: it follows the
    /// header (3 WORDs and L"VS_VERSION_INFO\0", padded to 40 bytes).
    fn fixed_version(&self) -> Option<String> {
        let word = |i: usize| self.block.get(i / 4).copied();
        let (signature, ms, ls) = (word(40)?, word(48)?, word(52)?);
        (signature == 0xFEEF_04BD && (ms | ls) != 0).then(|| format!("{}.{}.{}.{}", ms >> 16, ms & 0xFFFF, ls >> 16, ls & 0xFFFF))
    }
}
