//! System statistics, process list and network sockets.

use std::collections::HashMap;
use std::time::Instant;

use parking_lot::Mutex;
use serde::Serialize;
use sysinfo::{Disks, Networks, Pid, ProcessesToUpdate, System};
use tauri::{AppHandle, Manager};

use crate::paths::{blocking, hidden_command, ErrStr};

pub struct SysMon {
    inner: Mutex<Inner>,
}

struct Inner {
    sys: System,
    nets: Networks,
    disks: Disks,
    last_net: Instant,
    last_procs: Option<Instant>,
}

impl SysMon {
    pub fn new() -> Self {
        let mut sys = System::new();
        sys.refresh_cpu_usage();
        sys.refresh_memory();
        Self {
            inner: Mutex::new(Inner {
                sys,
                nets: Networks::new_with_refreshed_list(),
                disks: Disks::new_with_refreshed_list(),
                last_net: Instant::now(),
                last_procs: None,
            }),
        }
    }
}

impl Inner {
    /// Refresh processes at most every 500 ms (CPU% needs two samples anyway).
    fn refresh_procs(&mut self) {
        let due = self.last_procs.map_or(true, |t| t.elapsed().as_millis() >= 500);
        if due {
            self.sys.refresh_processes(ProcessesToUpdate::All, true);
            self.last_procs = Some(Instant::now());
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiskInfo {
    name: String,
    mount: String,
    total: u64,
    available: u64,
    fs: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    cpu: f32,
    cores: Vec<f32>,
    cpu_brand: String,
    mem_used: u64,
    mem_total: u64,
    swap_used: u64,
    swap_total: u64,
    net_rx: f64,
    net_tx: f64,
    disks: Vec<DiskInfo>,
    uptime: u64,
    host: String,
    os: String,
    process_count: usize,
}

#[tauri::command]
pub async fn sys_snapshot(app: AppHandle, with_disks: Option<bool>) -> Result<Snapshot, String> {
    blocking(move || snapshot(&app.state::<SysMon>(), with_disks)).await
}

fn snapshot(mon: &SysMon, with_disks: Option<bool>) -> Snapshot {
    let mut g = mon.inner.lock();
    g.sys.refresh_cpu_usage();
    g.sys.refresh_memory();

    let elapsed = g.last_net.elapsed().as_secs_f64().max(0.001);
    g.nets.refresh(true);
    g.last_net = Instant::now();
    let (mut rx, mut tx) = (0u64, 0u64);
    for (_, data) in g.nets.iter() {
        rx += data.received();
        tx += data.transmitted();
    }

    let disks = if with_disks.unwrap_or(false) {
        g.disks.refresh(true);
        g.disks
            .iter()
            .map(|d| DiskInfo {
                name: d.name().to_string_lossy().into_owned(),
                mount: d.mount_point().to_string_lossy().into_owned(),
                total: d.total_space(),
                available: d.available_space(),
                fs: d.file_system().to_string_lossy().into_owned(),
            })
            .collect()
    } else {
        Vec::new()
    };

    Snapshot {
        cpu: g.sys.global_cpu_usage(),
        cores: g.sys.cpus().iter().map(|c| c.cpu_usage()).collect(),
        cpu_brand: g.sys.cpus().first().map(|c| c.brand().trim().to_string()).unwrap_or_default(),
        mem_used: g.sys.used_memory(),
        mem_total: g.sys.total_memory(),
        swap_used: g.sys.used_swap(),
        swap_total: g.sys.total_swap(),
        net_rx: rx as f64 / elapsed,
        net_tx: tx as f64 / elapsed,
        disks,
        uptime: System::uptime(),
        host: System::host_name().unwrap_or_default(),
        os: System::long_os_version().unwrap_or_default(),
        process_count: g.sys.processes().len(),
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcInfo {
    pid: u32,
    ppid: Option<u32>,
    name: String,
    cpu: f32,
    mem: u64,
    exe: Option<String>,
    status: String,
    run_time: u64,
}

#[tauri::command]
pub async fn proc_list(app: AppHandle) -> Result<Vec<ProcInfo>, String> {
    blocking(move || processes(&app.state::<SysMon>())).await
}

fn processes(mon: &SysMon) -> Vec<ProcInfo> {
    let mut g = mon.inner.lock();
    g.refresh_procs();
    let cores = g.sys.cpus().len().max(1) as f32;
    g.sys
        .processes()
        .values()
        .map(|p| ProcInfo {
            pid: p.pid().as_u32(),
            ppid: p.parent().map(|x| x.as_u32()),
            name: p.name().to_string_lossy().into_owned(),
            cpu: p.cpu_usage() / cores,
            mem: p.memory(),
            exe: p.exe().map(|e| e.to_string_lossy().into_owned()),
            status: p.status().to_string(),
            run_time: p.run_time(),
        })
        .collect()
}

/// Whether `pid` is one of Shellmosaic's ancestors (e.g. explorer.exe), so ending its tree would end us.
fn is_own_ancestor(sys: &System, pid: u32) -> bool {
    let mut cur = sys.process(Pid::from_u32(std::process::id()));
    for _ in 0..64 {
        let Some(child) = cur else { return false };
        let Some(parent) = child.parent().and_then(|p| sys.process(p)) else { return false };
        // Windows reuses PIDs: a "parent" that started after its child is a stranger
        if parent.start_time() > child.start_time() {
            return false;
        }
        if parent.pid().as_u32() == pid {
            return true;
        }
        cur = Some(parent);
    }
    false
}

#[tauri::command]
pub async fn proc_kill(app: AppHandle, pid: u32, tree: Option<bool>) -> Result<(), String> {
    blocking(move || kill(&app.state::<SysMon>(), pid, tree)).await?
}

fn kill(mon: &SysMon, pid: u32, tree: Option<bool>) -> Result<(), String> {
    if pid == std::process::id() {
        return Err("refusing to kill Shellmosaic itself".into());
    }
    if tree.unwrap_or(false) {
        let mut g = mon.inner.lock();
        g.refresh_procs();
        if is_own_ancestor(&g.sys, pid) {
            return Err("refusing to end this tree: Shellmosaic runs inside it".into());
        }
        drop(g);
        let out = hidden_command("taskkill")
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .output()
            .s()?;
        if !out.status.success() {
            return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
        }
        return Ok(());
    }
    let mut g = mon.inner.lock();
    g.sys.refresh_processes(ProcessesToUpdate::Some(&[Pid::from_u32(pid)]), true);
    match g.sys.process(Pid::from_u32(pid)) {
        Some(p) if p.kill() => Ok(()),
        Some(_) => Err("access denied (try running Shellmosaic as administrator)".into()),
        None => Err("process not found".into()),
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SocketInfo {
    proto: &'static str,
    local_addr: String,
    local_port: u16,
    remote_addr: Option<String>,
    remote_port: Option<u16>,
    state: String,
    pid: Option<u32>,
    process: Option<String>,
}

#[tauri::command]
pub async fn net_sockets(app: AppHandle) -> Result<Vec<SocketInfo>, String> {
    blocking(move || sockets(&app.state::<SysMon>())).await?
}

fn sockets(mon: &SysMon) -> Result<Vec<SocketInfo>, String> {
    use netstat2::{get_sockets_info, AddressFamilyFlags, ProtocolFlags, ProtocolSocketInfo};
    let sockets = get_sockets_info(
        AddressFamilyFlags::IPV4 | AddressFamilyFlags::IPV6,
        ProtocolFlags::TCP | ProtocolFlags::UDP,
    )
    .s()?;

    let names: HashMap<u32, String> = {
        let mut g = mon.inner.lock();
        g.refresh_procs();
        g.sys
            .processes()
            .values()
            .map(|p| (p.pid().as_u32(), p.name().to_string_lossy().into_owned()))
            .collect()
    };

    Ok(sockets
        .into_iter()
        .map(|s| {
            let pid = s.associated_pids.first().copied();
            let process = pid.and_then(|p| names.get(&p).cloned());
            match s.protocol_socket_info {
                ProtocolSocketInfo::Tcp(t) => SocketInfo {
                    proto: "TCP",
                    local_addr: t.local_addr.to_string(),
                    local_port: t.local_port,
                    remote_addr: Some(t.remote_addr.to_string()),
                    remote_port: Some(t.remote_port),
                    state: format!("{:?}", t.state),
                    pid,
                    process,
                },
                ProtocolSocketInfo::Udp(u) => SocketInfo {
                    proto: "UDP",
                    local_addr: u.local_addr.to_string(),
                    local_port: u.local_port,
                    remote_addr: None,
                    remote_port: None,
                    state: String::new(),
                    pid,
                    process,
                },
            }
        })
        .collect())
}
