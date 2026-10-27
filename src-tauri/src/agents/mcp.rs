//! A small MCP server for one connection (Claude Code's stdio stream, relayed over the
//! pipe by the shim). It serves tools only and speaks both protocol eras Claude Code uses:
//! - modern (2026-07-28): no handshake; every request carries its version in `_meta`,
//!   `server/discover` describes the server, results carry `resultType`;
//! - legacy (2025-11-25 and earlier): `initialize` first.
//!
//! Claude Code probes with `server/discover` and falls back to `initialize` when the
//! answer isn't a modern one, so answering both is all it takes. Tool calls run
//! concurrently, can report progress and are cancelled by `notifications/cancelled`
//! (Esc in the pane) or when the connection closes.

use std::collections::HashMap;
use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;

use parking_lot::Mutex;
use serde_json::{json, Map, Value};
use tokio::io::{AsyncBufRead, AsyncBufReadExt, AsyncWrite, AsyncWriteExt};
use tokio::sync::{mpsc, watch};

pub const MODERN: &str = "2026-07-28";
/// Handshake versions we answer `initialize` with (the first is the newest).
pub const LEGACY: &[&str] = &["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
const VERSION_KEY: &str = "io.modelcontextprotocol/protocolVersion";
/// Longest JSON-RPC message we read.
pub const MAX_LINE: usize = 4 << 20;

pub type BoxFut<T> = Pin<Box<dyn Future<Output = T> + Send>>;

#[derive(Clone, Debug)]
pub struct Tool {
    pub name: &'static str,
    pub description: String,
    pub input_schema: Value,
}

#[derive(Debug)]
pub struct ToolOutput {
    pub text: String,
    pub is_error: bool,
}

impl ToolOutput {
    pub fn ok(text: impl Into<String>) -> Self {
        Self { text: text.into(), is_error: false }
    }
    pub fn err(text: impl Into<String>) -> Self {
        Self { text: text.into(), is_error: true }
    }
}

/// What a running tool call can do besides returning: report progress, notice cancellation.
#[derive(Clone)]
pub struct CallCtx {
    progress: Option<(Value, mpsc::UnboundedSender<String>)>,
    cancelled: watch::Receiver<bool>,
}

impl CallCtx {
    /// `notifications/progress` for this call (only when the client asked for progress).
    pub fn progress(&self, progress: f64, total: Option<f64>, message: Option<&str>) {
        let Some((token, tx)) = &self.progress else { return };
        let mut params = json!({ "progressToken": token, "progress": progress });
        if let Some(t) = total {
            params["total"] = json!(t);
        }
        if let Some(m) = message {
            params["message"] = json!(m);
        }
        let _ = tx.send(json!({ "jsonrpc": "2.0", "method": "notifications/progress", "params": params }).to_string());
    }

    /// Resolves once the client cancels the call or goes away.
    pub async fn cancelled(&self) {
        let mut rx = self.cancelled.clone();
        while !*rx.borrow_and_update() {
            if rx.changed().await.is_err() {
                return;
            }
        }
    }
}

pub trait ToolHost: Send + Sync + 'static {
    fn server_name(&self) -> &'static str;
    fn instructions(&self) -> Option<String>;
    fn tools(&self) -> Vec<Tool>;
    fn call(self: Arc<Self>, name: String, args: Value, ctx: CallCtx) -> BoxFut<ToolOutput>;
}

type Calls = Arc<Mutex<HashMap<String, watch::Sender<bool>>>>;

/// Serve one connection until the client closes it.
pub async fn serve<R, W>(mut reader: R, mut writer: W, host: Arc<dyn ToolHost>)
where
    R: AsyncBufRead + Unpin,
    W: AsyncWrite + Unpin + Send + 'static,
{
    let (tx, mut rx) = mpsc::unbounded_channel::<String>();
    // one writer: replies and notifications from concurrent calls never interleave mid-line
    tokio::spawn(async move {
        while let Some(line) = rx.recv().await {
            let mut bytes = line.into_bytes();
            bytes.push(b'\n');
            if writer.write_all(&bytes).await.is_err() || writer.flush().await.is_err() {
                break;
            }
        }
    });
    let calls: Calls = Arc::default();
    loop {
        let line = match read_line(&mut reader, MAX_LINE).await {
            Ok(Some(l)) => l,
            Ok(None) | Err(_) => break,
        };
        if line.iter().all(u8::is_ascii_whitespace) {
            continue;
        }
        match serde_json::from_slice::<Value>(&line) {
            Ok(msg) => handle(msg, &tx, &host, &calls),
            Err(_) => {
                let _ = tx.send(error(Value::Null, -32700, "Parse error", None));
            }
        }
    }
    // the client is gone: nobody will read the answers of calls still running
    for (_, c) in calls.lock().drain() {
        let _ = c.send(true);
    }
}

/// One `\n`-terminated line (without the `\r\n`/`\n`), `None` at the end of the stream.
pub async fn read_line<R: AsyncBufRead + Unpin>(r: &mut R, max: usize) -> std::io::Result<Option<Vec<u8>>> {
    let mut buf = Vec::new();
    loop {
        let available = r.fill_buf().await?;
        if available.is_empty() {
            return Ok(if buf.is_empty() { None } else { Some(buf) });
        }
        if let Some(i) = available.iter().position(|&b| b == b'\n') {
            buf.extend_from_slice(&available[..i]);
            r.consume(i + 1);
            if buf.last() == Some(&b'\r') {
                buf.pop();
            }
            return Ok(Some(buf));
        }
        let n = available.len();
        buf.extend_from_slice(available);
        r.consume(n);
        if buf.len() > max {
            return Err(std::io::Error::new(std::io::ErrorKind::InvalidData, "message too long"));
        }
    }
}

fn reply(id: Value, result: Value) -> String {
    json!({ "jsonrpc": "2.0", "id": id, "result": result }).to_string()
}

fn error(id: Value, code: i64, message: &str, data: Option<Value>) -> String {
    let mut e = json!({ "code": code, "message": message });
    if let Some(d) = data {
        e["data"] = d;
    }
    json!({ "jsonrpc": "2.0", "id": id, "error": e }).to_string()
}

fn server_info(host: &dyn ToolHost) -> Value {
    json!({ "name": host.server_name(), "version": env!("CARGO_PKG_VERSION") })
}

fn tool_list(host: &dyn ToolHost) -> Vec<Value> {
    host.tools()
        .into_iter()
        .map(|t| json!({ "name": t.name, "description": t.description, "inputSchema": t.input_schema }))
        .collect()
}

fn handle(msg: Value, tx: &mpsc::UnboundedSender<String>, host: &Arc<dyn ToolHost>, calls: &Calls) {
    // (we send no requests, so anything without a method is noise)
    let Some(method) = msg.get("method").and_then(Value::as_str) else { return };
    let params = msg.get("params").cloned().unwrap_or(Value::Null);
    let id = match msg.get("id") {
        Some(id) if !id.is_null() => id.clone(),
        _ => {
            if method == "notifications/cancelled" {
                if let Some(rid) = params.get("requestId") {
                    if let Some(c) = calls.lock().remove(&rid.to_string()) {
                        let _ = c.send(true);
                    }
                }
            }
            return;
        }
    };
    // a modern request names its version; it has to be ours
    let requested = params.get("_meta").and_then(|m| m.get(VERSION_KEY)).and_then(Value::as_str);
    if let Some(v) = requested {
        if v != MODERN {
            let data = json!({ "supported": [MODERN], "requested": v });
            let _ = tx.send(error(id, -32022, "Unsupported protocol version", Some(data)));
            return;
        }
    }
    let modern = requested.is_some();
    let complete = move |mut v: Value| {
        if modern {
            v["resultType"] = json!("complete");
        }
        v
    };
    let out = match method {
        "server/discover" => {
            let mut r = Map::new();
            r.insert("resultType".into(), json!("complete"));
            r.insert("supportedVersions".into(), json!([MODERN]));
            r.insert("capabilities".into(), json!({ "tools": {} }));
            r.insert("_meta".into(), json!({ "io.modelcontextprotocol/serverInfo": server_info(host.as_ref()) }));
            if let Some(i) = host.instructions() {
                r.insert("instructions".into(), json!(i));
            }
            reply(id, Value::Object(r))
        }
        "initialize" => {
            let asked = params.get("protocolVersion").and_then(Value::as_str).unwrap_or(LEGACY[0]);
            let version = if LEGACY.contains(&asked) { asked } else { LEGACY[0] };
            let mut r = Map::new();
            r.insert("protocolVersion".into(), json!(version));
            r.insert("capabilities".into(), json!({ "tools": {} }));
            r.insert("serverInfo".into(), server_info(host.as_ref()));
            if let Some(i) = host.instructions() {
                r.insert("instructions".into(), json!(i));
            }
            reply(id, Value::Object(r))
        }
        "ping" => reply(id, complete(json!({}))),
        "tools/list" => reply(id, complete(json!({ "tools": tool_list(host.as_ref()) }))),
        "tools/call" => {
            let name = params.get("name").and_then(Value::as_str).unwrap_or("").to_string();
            if !host.tools().iter().any(|t| t.name == name) {
                let _ = tx.send(error(id, -32602, &format!("Unknown tool: {name}"), None));
                return;
            }
            let args = params.get("arguments").cloned().unwrap_or_else(|| json!({}));
            let token = params.get("_meta").and_then(|m| m.get("progressToken")).cloned();
            let (cancel, cancelled) = watch::channel(false);
            let key = id.to_string();
            calls.lock().insert(key.clone(), cancel);
            let ctx = CallCtx { progress: token.map(|t| (t, tx.clone())), cancelled };
            let (tx, host, calls) = (tx.clone(), host.clone(), calls.clone());
            tokio::spawn(async move {
                let out = host.call(name, args, ctx).await;
                // cancelled meanwhile: the client isn't waiting for an answer any more
                if calls.lock().remove(&key).is_none() {
                    return;
                }
                let result = complete(json!({ "content": [{ "type": "text", "text": out.text }], "isError": out.is_error }));
                let _ = tx.send(reply(id, result));
            });
            return;
        }
        _ => error(id, -32601, "Method not found", None),
    };
    let _ = tx.send(out);
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;
    use tokio::io::{duplex, AsyncReadExt, BufReader};

    struct Echo;

    impl ToolHost for Echo {
        fn server_name(&self) -> &'static str {
            "test"
        }
        fn instructions(&self) -> Option<String> {
            Some("hello".into())
        }
        fn tools(&self) -> Vec<Tool> {
            vec![
                Tool { name: "echo", description: "echo".into(), input_schema: json!({ "type": "object" }) },
                Tool { name: "slow", description: "slow".into(), input_schema: json!({ "type": "object" }) },
            ]
        }
        fn call(self: Arc<Self>, name: String, args: Value, ctx: CallCtx) -> BoxFut<ToolOutput> {
            Box::pin(async move {
                match name.as_str() {
                    "echo" => ToolOutput::ok(args["text"].as_str().unwrap_or("").to_string()),
                    _ => {
                        ctx.progress(1.0, Some(2.0), Some("half"));
                        tokio::select! {
                            _ = ctx.cancelled() => ToolOutput::err("cancelled"),
                            _ = tokio::time::sleep(Duration::from_secs(30)) => ToolOutput::ok("done"),
                        }
                    }
                }
            })
        }
    }

    /// Send lines, collect the server's lines until `want` of them arrived.
    async fn exchange(input: &[Value], want: usize) -> Vec<Value> {
        let (client, server) = duplex(1 << 16);
        let (sr, sw) = tokio::io::split(server);
        tokio::spawn(serve(BufReader::new(sr), sw, Arc::new(Echo) as Arc<dyn ToolHost>));
        let (mut cr, mut cw) = tokio::io::split(client);
        for m in input {
            cw.write_all(format!("{m}\n").as_bytes()).await.unwrap();
        }
        let mut out = Vec::new();
        let mut buf = Vec::new();
        while out.len() < want {
            let mut chunk = [0u8; 4096];
            let n = tokio::time::timeout(Duration::from_secs(5), cr.read(&mut chunk)).await.unwrap().unwrap();
            buf.extend_from_slice(&chunk[..n]);
            while let Some(i) = buf.iter().position(|&b| b == b'\n') {
                out.push(serde_json::from_slice(&buf[..i]).unwrap());
                buf.drain(..=i);
            }
        }
        out
    }

    fn modern_meta() -> Value {
        json!({ "_meta": { VERSION_KEY: MODERN } })
    }

    #[tokio::test]
    async fn discover_then_modern_calls() {
        let mut call = modern_meta();
        call["name"] = json!("echo");
        call["arguments"] = json!({ "text": "hi" });
        let out = exchange(
            &[
                json!({ "jsonrpc": "2.0", "id": "d", "method": "server/discover", "params": modern_meta() }),
                json!({ "jsonrpc": "2.0", "id": 1, "method": "tools/list", "params": modern_meta() }),
                json!({ "jsonrpc": "2.0", "id": 2, "method": "tools/call", "params": call }),
            ],
            3,
        )
        .await;
        let d = out.iter().find(|m| m["id"] == "d").unwrap();
        assert_eq!(d["result"]["supportedVersions"][0], MODERN);
        assert_eq!(d["result"]["instructions"], "hello");
        let l = out.iter().find(|m| m["id"] == 1).unwrap();
        assert_eq!(l["result"]["tools"].as_array().unwrap().len(), 2);
        assert_eq!(l["result"]["resultType"], "complete");
        let c = out.iter().find(|m| m["id"] == 2).unwrap();
        assert_eq!(c["result"]["content"][0]["text"], "hi");
        assert_eq!(c["result"]["isError"], false);
    }

    #[tokio::test]
    async fn legacy_handshake() {
        let out = exchange(
            &[
                json!({ "jsonrpc": "2.0", "id": 0, "method": "initialize", "params": { "protocolVersion": "2025-06-18", "capabilities": {} } }),
                json!({ "jsonrpc": "2.0", "method": "notifications/initialized" }),
                json!({ "jsonrpc": "2.0", "id": 1, "method": "tools/list" }),
            ],
            2,
        )
        .await;
        assert_eq!(out[0]["result"]["protocolVersion"], "2025-06-18");
        assert!(out[1]["result"].get("resultType").is_none());
    }

    #[tokio::test]
    async fn unknown_versions_and_methods() {
        let out = exchange(
            &[
                json!({ "jsonrpc": "2.0", "id": 1, "method": "tools/list", "params": { "_meta": { VERSION_KEY: "2099-01-01" } } }),
                json!({ "jsonrpc": "2.0", "id": 2, "method": "resources/list" }),
                json!({ "jsonrpc": "2.0", "id": 3, "method": "tools/call", "params": { "name": "nope" } }),
            ],
            3,
        )
        .await;
        assert_eq!(out[0]["error"]["code"], -32022);
        assert_eq!(out[0]["error"]["data"]["requested"], "2099-01-01");
        assert_eq!(out[1]["error"]["code"], -32601);
        assert_eq!(out[2]["error"]["code"], -32602);
    }

    #[tokio::test]
    async fn progress_and_cancel() {
        let (client, server) = duplex(1 << 16);
        let (sr, sw) = tokio::io::split(server);
        tokio::spawn(serve(BufReader::new(sr), sw, Arc::new(Echo) as Arc<dyn ToolHost>));
        let (cr, mut cw) = tokio::io::split(client);
        let mut cr = BufReader::new(cr);
        let call = json!({ "jsonrpc": "2.0", "id": 7, "method": "tools/call", "params": { "name": "slow", "_meta": { "progressToken": "p" } } });
        cw.write_all(format!("{call}\n").as_bytes()).await.unwrap();
        let line = read_line(&mut cr, MAX_LINE).await.unwrap().unwrap();
        let p: Value = serde_json::from_slice(&line).unwrap();
        assert_eq!(p["method"], "notifications/progress");
        assert_eq!(p["params"]["progressToken"], "p");
        let cancel = json!({ "jsonrpc": "2.0", "method": "notifications/cancelled", "params": { "requestId": 7 } });
        cw.write_all(format!("{cancel}\n").as_bytes()).await.unwrap();
        let ping = json!({ "jsonrpc": "2.0", "id": 8, "method": "ping" });
        cw.write_all(format!("{ping}\n").as_bytes()).await.unwrap();
        // the cancelled call never answers: the next line is the ping's
        let line = tokio::time::timeout(Duration::from_secs(5), read_line(&mut cr, MAX_LINE)).await.unwrap().unwrap().unwrap();
        let r: Value = serde_json::from_slice(&line).unwrap();
        assert_eq!(r["id"], 8);
    }
}
