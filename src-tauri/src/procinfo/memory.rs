//! A process's address space (VirtualQueryEx) and what each region is: the mapped file,
//! or for private memory the thread stacks, TEBs, PEBs and heaps.

use std::collections::HashMap;
use std::ffi::c_void;
use std::mem::{size_of, zeroed};

use serde::Serialize;
use windows_sys::Win32::Foundation::{ERROR_ACCESS_DENIED, HANDLE};
use windows_sys::Win32::System::Memory::{
    VirtualQueryEx, MEMORY_BASIC_INFORMATION, MEM_COMMIT, MEM_FREE, MEM_IMAGE, MEM_MAPPED, MEM_PRIVATE, MEM_RESERVE,
};
use windows_sys::Win32::System::ProcessStatus::K32GetMappedFileNameW;
use windows_sys::Win32::System::Threading::{
    PROCESS_QUERY_INFORMATION, PROCESS_VM_READ, THREAD_QUERY_INFORMATION, THREAD_QUERY_LIMITED_INFORMATION,
};

use super::nt::{self, class, hex, Pebs, Snapshot, ThreadBasicInfo, EXITED};
use crate::winutil::{self, DosPaths};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemRegion {
    base: String,
    allocation_base: String,
    size: u64,
    state: &'static str,
    #[serde(rename = "type")]
    kind: Option<&'static str>,
    protect: String,
    protect_raw: u32,
    allocation_protect: String,
    usage: Option<String>,
}

/// More regions than any real process has; stops a runaway walk.
const MAX_REGIONS: usize = 200_000;

struct Region {
    base: u64,
    alloc_base: u64,
    alloc_protect: u32,
    size: u64,
    state: u32,
    protect: u32,
    kind: u32,
}

pub fn memory(pid: u32) -> Result<Vec<MemRegion>, String> {
    if pid == 0 {
        return Ok(Vec::new());
    }
    let (process, rights) =
        nt::open_process(pid, &[PROCESS_QUERY_INFORMATION | PROCESS_VM_READ, PROCESS_QUERY_INFORMATION]).map_err(nt::open_error)?;
    let h = process.0;
    let regions = walk(h);
    if regions.is_empty() {
        return Err(match winutil::last_error() {
            _ if nt::has_exited(h) || !nt::exists(pid) => EXITED.into(),
            ERROR_ACCESS_DENIED => nt::access_denied(),
            e => format!("Couldn't read the process's memory map: {}.", winutil::describe(e)),
        });
    }
    let labels = if rights & PROCESS_VM_READ != 0 { Labels::collect(pid, h, &regions) } else { Labels::default() };
    let dos = DosPaths::get();
    let mut files: HashMap<u64, Option<String>> = HashMap::new();
    Ok(regions
        .iter()
        .map(|r| {
            let usage = match r.kind {
                MEM_IMAGE | MEM_MAPPED => files
                    .entry(r.alloc_base)
                    .or_insert_with(|| mapped_file(h, r.alloc_base).map(|p| dos.convert(&p)))
                    .clone(),
                MEM_PRIVATE => labels.of(r),
                _ => None,
            };
            MemRegion {
                base: hex(r.base),
                allocation_base: hex(r.alloc_base),
                size: r.size,
                state: match r.state {
                    MEM_COMMIT => "commit",
                    MEM_RESERVE => "reserve",
                    _ => "free",
                },
                kind: match r.kind {
                    MEM_IMAGE => Some("image"),
                    MEM_MAPPED => Some("mapped"),
                    MEM_PRIVATE => Some("private"),
                    _ => None,
                },
                protect: if r.state == MEM_COMMIT { protect_text(r.protect) } else { String::new() },
                protect_raw: r.protect,
                allocation_protect: if r.state == MEM_FREE { String::new() } else { protect_text(r.alloc_protect) },
                usage,
            }
        })
        .collect())
}

/// Every region from address 0 up to the end of user space, in address order.
fn walk(h: HANDLE) -> Vec<Region> {
    let mut out = Vec::new();
    let mut addr = 0usize;
    while out.len() < MAX_REGIONS {
        let mut m: MEMORY_BASIC_INFORMATION = unsafe { zeroed() };
        // fails past the last user-mode address (or once the process is gone)
        if unsafe { VirtualQueryEx(h, addr as *const c_void, &mut m, size_of::<MEMORY_BASIC_INFORMATION>()) } == 0 {
            break;
        }
        let base = m.BaseAddress as usize;
        out.push(Region {
            base: base as u64,
            alloc_base: m.AllocationBase as u64,
            alloc_protect: m.AllocationProtect,
            size: m.RegionSize as u64,
            state: m.State,
            protect: m.Protect,
            kind: m.Type,
        });
        match base.checked_add(m.RegionSize) {
            Some(next) if next > addr => addr = next,
            _ => break,
        }
    }
    out
}

fn region_at(regions: &[Region], addr: u64) -> Option<&Region> {
    let i = regions.partition_point(|r| r.base <= addr);
    let r = regions.get(i.checked_sub(1)?)?;
    (addr < r.base.saturating_add(r.size)).then_some(r)
}

fn mapped_file(h: HANDLE, addr: u64) -> Option<String> {
    let mut buf = vec![0u16; 1024];
    let n = unsafe { K32GetMappedFileNameW(h, addr as usize as *const c_void, buf.as_mut_ptr(), buf.len() as u32) } as usize;
    (n > 0).then(|| String::from_utf16_lossy(&buf[..n.min(buf.len())]))
}

/// A structure at a single address.
enum Point {
    Peb,
    Peb32,
    Teb(u32),
}

/// Names for private memory.
#[derive(Default)]
struct Labels {
    /// single addresses, sorted: the region holding one is named after it
    points: Vec<(u64, Point)>,
    /// whole allocations (stacks, heaps), by allocation base
    allocations: HashMap<u64, String>,
}

impl Labels {
    fn collect(pid: u32, h: HANDLE, regions: &[Region]) -> Self {
        let mut l = Self::default();
        let pebs = Pebs::of(h);
        if let Some(peb) = pebs.native {
            l.points.push((peb, Point::Peb));
            // PEB64: NumberOfHeaps +0xE8, ProcessHeaps +0xF0
            for (i, heap) in pointers(h, peb + 0xE8, peb + 0xF0, 8).into_iter().enumerate() {
                l.name_allocation(regions, heap, format!("Heap {}", i + 1));
            }
        }
        if let Some(peb) = pebs.wow64 {
            l.points.push((peb, Point::Peb32));
            // PEB32: NumberOfHeaps +0x88, ProcessHeaps +0x90
            for (i, heap) in pointers(h, peb + 0x88, peb + 0x90, 4).into_iter().enumerate() {
                l.name_allocation(regions, heap, format!("Heap {} (32-bit)", i + 1));
            }
        }
        l.add_threads(pid, h, regions, pebs.wow64.is_some());
        l.points.sort_by_key(|(a, _)| *a);
        l
    }

    /// Name the whole allocation that `addr` lies in (the first name given wins).
    fn name_allocation(&mut self, regions: &[Region], addr: u64, name: String) {
        if let Some(a) = region_at(regions, addr).map(|r| r.alloc_base).filter(|&a| a != 0) {
            self.allocations.entry(a).or_insert(name);
        }
    }

    /// TEBs and stacks.
    fn add_threads(&mut self, pid: u32, h: HANDLE, regions: &[Region], wow64: bool) {
        let Ok(snap) = Snapshot::take() else { return };
        let Some(entry) = snap.find(pid) else { return };
        for t in &entry.threads {
            let Some((th, _)) = nt::open_thread(t.tid, &[THREAD_QUERY_LIMITED_INFORMATION, THREAD_QUERY_INFORMATION]) else { continue };
            let Ok(basic) = nt::query_thread::<ThreadBasicInfo>(th.0, class::THREAD_BASIC) else { continue };
            let teb = basic.teb_base_address as u64;
            if teb == 0 {
                continue;
            }
            self.points.push((teb, Point::Teb(t.tid)));
            // NT_TIB64: StackBase +0x8, StackLimit +0x10
            if let (Some(base), Some(limit)) = (nt::read_u64(h, teb + 0x8), nt::read_u64(h, teb + 0x10)) {
                if stack_ok(base, limit) {
                    self.name_allocation(regions, limit, format!("Stack (TID {})", t.tid));
                }
            }
            if wow64 {
                // the 32-bit TEB follows the 64-bit one; NT_TIB32: StackBase +0x4, StackLimit +0x8
                let teb32 = teb + 0x2000;
                if let (Some(base), Some(limit)) = (nt::read_u32(h, teb32 + 0x4), nt::read_u32(h, teb32 + 0x8)) {
                    if stack_ok(base as u64, limit as u64) {
                        self.name_allocation(regions, limit as u64, format!("Stack (TID {}, 32-bit)", t.tid));
                    }
                }
            }
        }
    }

    /// "PEB", "TEB (TID 12)", "PEB, TEBs (TID 12, 34)", a stack, a heap, or None.
    fn of(&self, r: &Region) -> Option<String> {
        let end = r.base.saturating_add(r.size);
        let first = self.points.partition_point(|(a, _)| *a < r.base);
        let mut parts: Vec<String> = Vec::new();
        let mut tebs: Vec<String> = Vec::new();
        for (_, p) in self.points[first..].iter().take_while(|(a, _)| *a < end) {
            match p {
                Point::Peb => parts.push("PEB".into()),
                Point::Peb32 => parts.push("PEB (32-bit)".into()),
                Point::Teb(tid) => tebs.push(tid.to_string()),
            }
        }
        // threads' TEBs often share one region
        match tebs.len() {
            0 => {}
            1 => parts.push(format!("TEB (TID {})", tebs[0])),
            _ => parts.push(format!("TEBs (TID {})", tebs.join(", "))),
        }
        if !parts.is_empty() {
            return Some(parts.join(", "));
        }
        self.allocations.get(&r.alloc_base).cloned()
    }
}

fn stack_ok(base: u64, limit: u64) -> bool {
    limit != 0 && base > limit && base - limit <= 1 << 32
}

/// The array of `width`-byte pointers whose count (u32) is at `count_at` and whose
/// address is at `array_at`.
fn pointers(h: HANDLE, count_at: u64, array_at: u64, width: usize) -> Vec<u64> {
    let Some(n) = nt::read_u32(h, count_at) else { return Vec::new() };
    let n = (n as usize).min(1024);
    let array = if width == 8 { nt::read_u64(h, array_at) } else { nt::read_u32(h, array_at).map(u64::from) };
    let Some(array) = array.filter(|&a| a != 0 && n > 0) else { return Vec::new() };
    let Some(bytes) = nt::read_mem(h, array, n * width) else { return Vec::new() };
    bytes
        .chunks_exact(width)
        .map(|c| c.iter().rev().fold(0u64, |v, &b| (v << 8) | b as u64))
        .filter(|&p| p != 0)
        .collect()
}

/// "R", "RW", "RX", "RWX", "WC", "WCX", "NA", "X", with "+G" (guard), "+NC" (no-cache),
/// "+WCB" (write-combine).
fn protect_text(p: u32) -> String {
    let base = match p & 0xFF {
        0 => return String::new(),
        0x01 => "NA",
        0x02 => "R",
        0x04 => "RW",
        0x08 => "WC",
        0x10 => "X",
        0x20 => "RX",
        0x40 => "RWX",
        0x80 => "WCX",
        _ => return format!("0x{p:x}"),
    };
    let mut s = base.to_string();
    for (bit, suffix) in [(0x100, "+G"), (0x200, "+NC"), (0x400, "+WCB")] {
        if p & bit != 0 {
            s.push_str(suffix);
        }
    }
    s
}
