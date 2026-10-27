//! An agent's recent conversation, read from its Claude Code transcript (JSONL): what the
//! lead's `read_output` returns. The screen is no good for this (the TUI redraws in place).

use std::io::{Read, Seek, SeekFrom};
use std::path::Path;

use serde_json::Value;

/// Only the end of a long transcript is read.
const TAIL_BYTES: u64 = 512 * 1024;

fn clip(s: &str, max: usize) -> String {
    let s = s.trim();
    if s.chars().count() <= max {
        return s.to_string();
    }
    let mut out: String = s.chars().take(max).collect();
    out.push('…');
    out
}

fn tool_input(input: &Value) -> String {
    let pick = ["command", "file_path", "path", "pattern", "url", "query", "description"];
    for k in pick {
        if let Some(v) = input.get(k).and_then(Value::as_str) {
            return clip(v, 200);
        }
    }
    clip(&input.to_string(), 200)
}

fn result_text(content: &Value) -> String {
    match content {
        Value::String(s) => clip(s, 300),
        Value::Array(items) => {
            let text: Vec<&str> = items.iter().filter_map(|i| i.get("text").and_then(Value::as_str)).collect();
            clip(&text.join(" "), 300)
        }
        _ => String::new(),
    }
}

/// Readable lines for one transcript entry.
fn entry_lines(v: &Value) -> Vec<String> {
    let kind = v.get("type").and_then(Value::as_str).unwrap_or("");
    if kind != "user" && kind != "assistant" {
        return Vec::new();
    }
    let content = v.pointer("/message/content").cloned().unwrap_or(Value::Null);
    let who = if kind == "user" { "User" } else { "Assistant" };
    match content {
        Value::String(s) => vec![format!("{who}: {}", clip(&s, 1500))],
        Value::Array(items) => items
            .iter()
            .filter_map(|i| match i.get("type").and_then(Value::as_str) {
                Some("text") => i.get("text").and_then(Value::as_str).map(|t| format!("{who}: {}", clip(t, 1500))),
                Some("tool_use") => Some(format!(
                    "  → {} {}",
                    i.get("name").and_then(Value::as_str).unwrap_or("tool"),
                    tool_input(i.get("input").unwrap_or(&Value::Null))
                )),
                Some("tool_result") => {
                    let err = i.get("is_error").and_then(Value::as_bool).unwrap_or(false);
                    let t = result_text(i.get("content").unwrap_or(&Value::Null));
                    Some(format!("  ← {}{t}", if err { "error: " } else { "" }))
                }
                _ => None,
            })
            .collect(),
        _ => Vec::new(),
    }
}

/// The last `max_entries` readable lines, at most `max_chars` characters (newest kept).
pub fn recent(path: &Path, max_entries: usize, max_chars: usize) -> String {
    let Ok(mut f) = std::fs::File::open(path) else { return "(no transcript yet)".into() };
    let len = f.metadata().map(|m| m.len()).unwrap_or(0);
    let start = len.saturating_sub(TAIL_BYTES);
    let _ = f.seek(SeekFrom::Start(start));
    let mut buf = Vec::new();
    let _ = f.read_to_end(&mut buf);
    let text = String::from_utf8_lossy(&buf);
    let mut lines = text.lines();
    if start > 0 {
        lines.next(); // (cut in the middle)
    }
    let mut out: Vec<String> = lines.filter_map(|l| serde_json::from_str::<Value>(l).ok()).flat_map(|v| entry_lines(&v)).collect();
    if out.len() > max_entries {
        out.drain(..out.len() - max_entries);
    }
    let mut s = out.join("\n");
    if s.chars().count() > max_chars {
        let skip = s.chars().count() - max_chars;
        s = format!("…{}", s.chars().skip(skip).collect::<String>());
    }
    if s.is_empty() {
        "(nothing in the conversation yet)".into()
    } else {
        s
    }
}
