//! `tail -f` for the Log viewer module: polls a file and streams appended lines.

use std::collections::HashMap;
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use parking_lot::Mutex;
use serde_json::json;
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager, State};

use crate::paths::{blocking, ErrStr};

#[derive(Default)]
pub struct LogTails {
    next: AtomicU64,
    /// stop flag per tail, with the label of the webview that opened it
    stops: Mutex<HashMap<u64, (String, Arc<AtomicBool>)>>,
}

impl LogTails {
    /// Stop every tail a webview opened. Called when its page (re)loads or its window is
    /// destroyed: the old page never sends log_close, and a channel to it never fails.
    pub fn close_webview(&self, label: &str) {
        self.stops.lock().retain(|_, (owner, stop)| {
            if owner == label {
                stop.store(true, Ordering::Relaxed);
            }
            owner != label
        });
    }
}

#[tauri::command]
pub async fn log_open(
    webview: tauri::Webview,
    app: AppHandle,
    path: String,
    tail_bytes: Option<u64>,
    on_event: Channel<serde_json::Value>,
) -> Result<u64, String> {
    let label = webview.label().to_string();
    blocking(move || open_tail(&app.state::<LogTails>(), label, path, tail_bytes, on_event)).await?
}

fn open_tail(tails: &LogTails, label: String, path: String, tail_bytes: Option<u64>, on_event: Channel<serde_json::Value>) -> Result<u64, String> {
    let mut file = File::open(&path).s()?;
    let len = file.metadata().s()?.len();
    let start = len.saturating_sub(tail_bytes.unwrap_or(256 * 1024));
    file.seek(SeekFrom::Start(start)).s()?;

    let id = tails.next.fetch_add(1, Ordering::Relaxed) + 1;
    let stop = Arc::new(AtomicBool::new(false));
    tails.stops.lock().insert(id, (label, stop.clone()));

    std::thread::spawn(move || {
        let mut pos = start;
        // raw bytes, decoded per line: a UTF-8 character can straddle two reads
        let mut carry: Vec<u8> = Vec::new();
        let mut first = start > 0; // drop the partial first line when starting mid-file
        let mut buf = vec![0u8; 256 * 1024];
        while !stop.load(Ordering::Relaxed) {
            let size = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(pos);
            if size < pos {
                // truncated or rotated: start over
                pos = 0;
                carry.clear();
                if on_event.send(json!({ "t": "reset" })).is_err() {
                    break;
                }
                if let Ok(f) = File::open(&path) {
                    file = f;
                }
            }
            if size > pos {
                let _ = file.seek(SeekFrom::Start(pos));
                let mut lines = Vec::new();
                while let Ok(n) = file.read(&mut buf) {
                    if n == 0 {
                        break;
                    }
                    pos += n as u64;
                    carry.extend_from_slice(&buf[..n]);
                    let mut from = 0;
                    while let Some(i) = carry[from..].iter().position(|&b| b == b'\n') {
                        let line = String::from_utf8_lossy(&carry[from..from + i]).trim_end_matches('\r').to_string();
                        from += i + 1;
                        if first {
                            first = false;
                            continue;
                        }
                        lines.push(line);
                    }
                    // one drain per read; draining per line is quadratic on a 256 KB chunk
                    carry.drain(..from);
                    if carry.len() > 1024 * 1024 {
                        // no newline in sight (binary file?): don't buffer it forever
                        lines.push(String::from_utf8_lossy(&carry).into_owned());
                        carry.clear();
                    }
                    if lines.len() > 5000 {
                        break;
                    }
                }
                if !lines.is_empty() && on_event.send(json!({ "t": "lines", "lines": lines })).is_err() {
                    break;
                }
            }
            std::thread::sleep(Duration::from_millis(300));
        }
    });
    Ok(id)
}

#[tauri::command]
pub fn log_close(tails: State<'_, LogTails>, id: u64) {
    if let Some((_, stop)) = tails.stops.lock().remove(&id) {
        stop.store(true, Ordering::Relaxed);
    }
}
