//! The named pipe agents reach Shellmosaic through (Claude Code → the shellmosaic-agent
//! shim → here).
//!
//! Every connection starts with one line: `SMAGENT1 <mode> <agent id> <token> [arg]`.
//! - `mcp`: the rest is the MCP stream (newline-delimited JSON-RPC both ways, see mcp.rs);
//! - `hook <Event>` and `status`: `<length>\n` and that much JSON; the answer comes back
//!   framed the same way.
//!
//! Only the user's own medium-integrity processes on this machine can open the pipe, and a
//! valid token isn't enough on its own (any process of the same user can read another's
//! environment): the caller must also run under that agent's Claude Code process.

use std::ffi::c_void;
use std::os::windows::io::AsRawHandle;
use std::sync::Arc;
use std::time::Duration;

use serde_json::Value;
use tokio::io::{AsyncBufRead, AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt, BufReader};
use tokio::net::windows::named_pipe::{NamedPipeServer, PipeMode, ServerOptions};
use windows_sys::Win32::Foundation::{LocalFree, HANDLE};
use windows_sys::Win32::Security::Authorization::ConvertStringSecurityDescriptorToSecurityDescriptorW;
use windows_sys::Win32::Security::{GetTokenInformation, TokenUser, SECURITY_ATTRIBUTES, TOKEN_QUERY, TOKEN_USER};
use windows_sys::Win32::System::Pipes::GetNamedPipeClientProcessId;
use windows_sys::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};

use super::mcp::{self, BoxFut, ToolHost};
use crate::winutil::{sid_string, wide, Handle};

pub const HELLO: &str = "SMAGENT1";
/// Largest hook or statusLine payload accepted.
const MAX_BODY: usize = 4 << 20;

/// What the pipe needs from the Orchestrator.
pub trait Gate: Send + Sync + 'static {
    /// The token belongs to the agent and the caller runs under the agent's process.
    fn authenticate(&self, agent: &str, token: &str, client_pid: u32) -> Result<(), String>;
    fn tool_host(&self, agent: &str) -> Option<Arc<dyn ToolHost>>;
    /// A hook's answer (`Value::Null`: no output).
    fn hook(&self, agent: &str, event: &str, input: Value) -> BoxFut<Value>;
    /// The statusLine text.
    fn status(&self, agent: &str, input: Value) -> String;
}

/// Start listening on `name` (`\\.\pipe\…`). Fails if the pipe can't be created at all.
pub fn start(name: String, rt: &tokio::runtime::Handle, gate: Arc<dyn Gate>) -> Result<(), String> {
    let _guard = rt.enter();
    let first = create(&name, true).map_err(|e| format!("Couldn't open the agents' pipe: {e}"))?;
    rt.spawn(accept_loop(name, first, gate));
    Ok(())
}

async fn accept_loop(name: String, mut server: NamedPipeServer, gate: Arc<dyn Gate>) {
    loop {
        let ok = server.connect().await.is_ok();
        // a new instance before handling this one: one is always waiting for the next client
        let next = loop {
            match create(&name, false) {
                Ok(s) => break s,
                Err(e) => {
                    eprintln!("[agents] pipe instance: {e}");
                    tokio::time::sleep(Duration::from_secs(1)).await;
                }
            }
        };
        let connected = std::mem::replace(&mut server, next);
        if ok {
            let gate = gate.clone();
            tokio::spawn(async move {
                if let Err(e) = handle(connected, gate).await {
                    eprintln!("[agents] pipe client: {e}");
                }
            });
        }
    }
}

/// The current user's SID ("S-1-5-21-…").
fn user_sid() -> Option<String> {
    unsafe {
        let mut tok: HANDLE = std::ptr::null_mut();
        if OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut tok) == 0 {
            return None;
        }
        let tok = Handle(tok);
        let mut buf = vec![0u8; 256];
        let mut len = 0u32;
        if GetTokenInformation(tok.0, TokenUser, buf.as_mut_ptr() as _, buf.len() as u32, &mut len) == 0 {
            return None;
        }
        let user = &*(buf.as_ptr() as *const TOKEN_USER);
        Some(sid_string(user.User.Sid)).filter(|s| !s.is_empty())
    }
}

fn create(name: &str, first: bool) -> std::io::Result<NamedPipeServer> {
    let sid = user_sid().ok_or_else(|| std::io::Error::other("couldn't read the user's SID"))?;
    // only this user (no inherited ACEs); low-integrity processes can't write to it
    match create_with(name, first, &format!("D:P(A;;GA;;;{sid})S:(ML;;NW;;;ME)")) {
        Ok(s) => Ok(s),
        // (a label we may not set: the DACL alone still keeps other users out)
        Err(_) => create_with(name, first, &format!("D:P(A;;GA;;;{sid})")),
    }
}

fn create_with(name: &str, first: bool, sddl: &str) -> std::io::Result<NamedPipeServer> {
    unsafe {
        let mut sd: *mut c_void = std::ptr::null_mut();
        if ConvertStringSecurityDescriptorToSecurityDescriptorW(wide(sddl).as_ptr(), 1, &mut sd, std::ptr::null_mut()) == 0 {
            return Err(std::io::Error::last_os_error());
        }
        let mut sa = SECURITY_ATTRIBUTES {
            nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
            lpSecurityDescriptor: sd,
            bInheritHandle: 0,
        };
        let r = ServerOptions::new()
            .first_pipe_instance(first)
            .reject_remote_clients(true)
            .pipe_mode(PipeMode::Byte)
            .create_with_security_attributes_raw(name, &mut sa as *mut _ as *mut c_void);
        LocalFree(sd as _);
        r
    }
}

fn client_pid(pipe: &NamedPipeServer) -> std::io::Result<u32> {
    let mut pid = 0u32;
    if unsafe { GetNamedPipeClientProcessId(pipe.as_raw_handle() as HANDLE, &mut pid) } == 0 {
        return Err(std::io::Error::last_os_error());
    }
    Ok(pid)
}

async fn read_framed<R: AsyncBufRead + Unpin>(r: &mut R) -> std::io::Result<Vec<u8>> {
    let line = mcp::read_line(r, 32).await?.ok_or_else(|| std::io::Error::other("no length"))?;
    let len: usize = std::str::from_utf8(&line).ok().and_then(|s| s.trim().parse().ok()).ok_or_else(|| std::io::Error::other("bad length"))?;
    if len > MAX_BODY {
        return Err(std::io::Error::other("payload too large"));
    }
    let mut body = vec![0u8; len];
    r.read_exact(&mut body).await?;
    Ok(body)
}

pub async fn write_framed<W: AsyncWrite + Unpin>(w: &mut W, data: &[u8]) -> std::io::Result<()> {
    w.write_all(format!("{}\n", data.len()).as_bytes()).await?;
    w.write_all(data).await?;
    w.flush().await
}

async fn handle(pipe: NamedPipeServer, gate: Arc<dyn Gate>) -> Result<(), String> {
    let pid = client_pid(&pipe).map_err(|e| e.to_string())?;
    let (rd, mut wr) = tokio::io::split(pipe);
    let mut rd = BufReader::new(rd);
    let hello = tokio::time::timeout(Duration::from_secs(10), mcp::read_line(&mut rd, 512))
        .await
        .map_err(|_| "no hello".to_string())?
        .map_err(|e| e.to_string())?
        .ok_or("no hello")?;
    let hello = String::from_utf8(hello).map_err(|_| "bad hello")?;
    let parts: Vec<&str> = hello.split(' ').collect();
    if parts.len() < 4 || parts[0] != HELLO {
        return Err(format!("unexpected hello from pid {pid}"));
    }
    let (mode, agent, token) = (parts[1], parts[2], parts[3]);
    let arg = parts.get(4).copied().unwrap_or("");
    gate.authenticate(agent, token, pid).map_err(|e| format!("pid {pid} as {agent}: {e}"))?;
    match mode {
        "mcp" => {
            let host = gate.tool_host(agent).ok_or("unknown agent")?;
            mcp::serve(rd, wr, host).await;
            Ok(())
        }
        "hook" | "status" => {
            let body = read_framed(&mut rd).await.map_err(|e| e.to_string())?;
            let input: Value = serde_json::from_slice(&body).unwrap_or(Value::Null);
            let out = if mode == "status" {
                gate.status(agent, input)
            } else {
                // Claude Code may stop waiting (the user answered in the pane, the hook timed
                // out): the shim is killed and the pipe closes. Dropping the hook's future then
                // tells the Orchestrator nobody is waiting for that answer any more.
                let answer = gate.hook(agent, arg, input);
                tokio::select! {
                    v = answer => if v.is_null() { String::new() } else { v.to_string() },
                    _ = closed(&mut rd) => return Ok(()),
                }
            };
            write_framed(&mut wr, out.as_bytes()).await.map_err(|e| e.to_string())
        }
        _ => Err(format!("unknown mode {mode:?}")),
    }
}

/// Resolves when the client closes its end (it sends nothing more after its request).
async fn closed<R: AsyncRead + Unpin>(r: &mut R) {
    let mut probe = [0u8; 64];
    loop {
        match r.read(&mut probe).await {
            Ok(0) | Err(_) => return,
            Ok(_) => continue,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn the_pipe_takes_the_integrity_label() {
        let sid = user_sid().expect("the user's SID");
        let name = format!(r"\\.\pipe\sm-test-{}", uuid::Uuid::new_v4().simple());
        // not the DACL-only fallback: the label (no write-up from low integrity) must be accepted
        let _first = create_with(&name, true, &format!("D:P(A;;GA;;;{sid})S:(ML;;NW;;;ME)")).expect("labelled pipe");
        // while it exists, nobody else can create that name as a first instance
        assert!(create(&name, true).is_err());
    }
}
