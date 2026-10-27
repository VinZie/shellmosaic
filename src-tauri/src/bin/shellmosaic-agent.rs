//! shellmosaic-agent: how the Claude Code sessions that Shellmosaic's Orchestrator starts
//! talk to it. Claude Code runs it as
//!   shellmosaic-agent mcp            the agent's MCP server (relayed to Shellmosaic)
//!   shellmosaic-agent hook <Event>   a hook: the event's JSON in, Shellmosaic's answer out
//!   shellmosaic-agent status         the statusLine command
//! and it finds Shellmosaic through SHELLMOSAIC_PIPE, _AGENT_ID and _AGENT_TOKEN, which
//! Shellmosaic put in the agent's environment.
//!
//! It never exits with code 2 (a blocking hook error): when Shellmosaic can't be reached a
//! hook answers nothing and Claude Code carries on as if there were no hook.

use std::io::{Read, Write};
use std::time::{Duration, Instant};

use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::net::windows::named_pipe::{ClientOptions, NamedPipeClient};

const HELLO: &str = "SMAGENT1";
const ERROR_PIPE_BUSY: i32 = 231;

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().expect("tokio runtime");
    let code = rt.block_on(run(args));
    std::process::exit(code);
}

async fn run(args: Vec<String>) -> i32 {
    match args.first().map(String::as_str) {
        Some("mcp") => {
            mcp().await;
            0
        }
        Some("hook") => {
            let event = args.get(1).map(String::as_str).unwrap_or("");
            if let Ok(answer) = request("hook", event).await {
                let _ = std::io::stdout().write_all(&answer);
            }
            0
        }
        Some("status") => {
            match request("status", "").await {
                Ok(text) => {
                    let _ = std::io::stdout().write_all(&text);
                }
                Err(e) => print!("Shellmosaic: {e}"),
            }
            0
        }
        _ => {
            eprintln!("shellmosaic-agent is started by Claude Code for Shellmosaic's Orchestrator: mcp | hook <Event> | status");
            1
        }
    }
}

fn var(name: &str) -> Result<String, String> {
    std::env::var(name).ok().filter(|v| !v.is_empty()).ok_or_else(|| format!("{name} isn't set: this session wasn't started by Shellmosaic"))
}

fn hello(mode: &str, arg: &str) -> Result<String, String> {
    let (agent, token) = (var("SHELLMOSAIC_AGENT_ID")?, var("SHELLMOSAIC_AGENT_TOKEN")?);
    let arg = if arg.is_empty() { String::new() } else { format!(" {arg}") };
    Ok(format!("{HELLO} {mode} {agent} {token}{arg}\n"))
}

async fn connect() -> Result<NamedPipeClient, String> {
    let name = var("SHELLMOSAIC_PIPE")?;
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        match ClientOptions::new().open(&name) {
            Ok(c) => return Ok(c),
            Err(e) if e.raw_os_error() == Some(ERROR_PIPE_BUSY) && Instant::now() < deadline => {
                tokio::time::sleep(Duration::from_millis(20)).await
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                return Err("Shellmosaic isn't running, or this agent belongs to an earlier run of it".into())
            }
            Err(e) => return Err(format!("couldn't reach Shellmosaic: {e}")),
        }
    }
}

/// One framed request (`hook`, `status`): stdin's JSON goes up, the answer comes back.
async fn request(mode: &str, arg: &str) -> Result<Vec<u8>, String> {
    let mut input = Vec::new();
    std::io::stdin().read_to_end(&mut input).map_err(|e| e.to_string())?;
    let hello = hello(mode, arg)?;
    let pipe = connect().await?;
    let (rd, mut wr) = tokio::io::split(pipe);
    let mut out = hello.into_bytes();
    out.extend_from_slice(format!("{}\n", input.len()).as_bytes());
    out.extend_from_slice(&input);
    wr.write_all(&out).await.map_err(|e| e.to_string())?;
    wr.flush().await.map_err(|e| e.to_string())?;
    let mut rd = BufReader::new(rd);
    let mut len = String::new();
    rd.read_line(&mut len).await.map_err(|e| e.to_string())?;
    let len: usize = len.trim().parse().map_err(|_| "Shellmosaic closed the connection".to_string())?;
    let mut answer = vec![0u8; len];
    rd.read_exact(&mut answer).await.map_err(|e| e.to_string())?;
    Ok(answer)
}

/// Relay the MCP stream both ways until either side closes it.
async fn mcp() {
    let connected = match (hello("mcp", ""), connect().await) {
        (Ok(h), Ok(p)) => Ok((h, p)),
        (Err(e), _) | (_, Err(e)) => Err(e),
    };
    let (hello, pipe) = match connected {
        Ok(c) => c,
        Err(e) => return unreachable(&e).await,
    };
    let (mut prd, mut pwr) = tokio::io::split(pipe);
    if pwr.write_all(hello.as_bytes()).await.is_err() {
        return unreachable("Shellmosaic closed the connection").await;
    }
    let up = async {
        let _ = tokio::io::copy(&mut tokio::io::stdin(), &mut pwr).await;
    };
    let down = async {
        let mut stdout = tokio::io::stdout();
        let _ = tokio::io::copy(&mut prd, &mut stdout).await;
        let _ = stdout.flush().await;
    };
    tokio::select! {
        _ = up => {}
        _ = down => {}
    }
}

/// Shellmosaic can't be reached: answer every request with an error that says why, so
/// `/mcp` in the pane shows the reason instead of a bare "failed".
async fn unreachable(why: &str) {
    let mut lines = BufReader::new(tokio::io::stdin()).lines();
    let mut stdout = tokio::io::stdout();
    while let Ok(Some(line)) = lines.next_line().await {
        let Ok(msg) = serde_json::from_str::<serde_json::Value>(&line) else { continue };
        let Some(id) = msg.get("id").filter(|id| !id.is_null()) else { continue };
        let reply = serde_json::json!({ "jsonrpc": "2.0", "id": id, "error": { "code": -32603, "message": format!("Shellmosaic: {why}") } });
        if stdout.write_all(format!("{reply}\n").as_bytes()).await.is_err() || stdout.flush().await.is_err() {
            break;
        }
    }
}
