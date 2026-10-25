//! The workspace model (workspaces, tabs, layouts, panes, windows).
//!
//! The frontend owns the shape of the model and all mutation logic; the backend
//! is the single source of truth that serialises commits from every window,
//! broadcasts changes, and persists to `state.json`.

use std::collections::HashSet;
use std::fs;
use std::path::PathBuf;

use parking_lot::Mutex;
use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Emitter, State};

use crate::paths::write_atomic;

pub struct ModelStore {
    inner: Mutex<Inner>,
    path: PathBuf,
    /// held from snapshot to rename: the periodic flush and the exit flush run on
    /// different threads, and an older snapshot must not land after a newer one
    writing: Mutex<()>,
}

struct Inner {
    version: u64,
    model: Value,
    dirty: bool,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub version: u64,
    pub model: Value,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ChangeEvent {
    version: u64,
    model: Value,
    source: String,
}

#[derive(Serialize)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum CommitResult {
    Ok { version: u64 },
    Conflict { version: u64, model: Value },
}

impl ModelStore {
    pub fn load(path: PathBuf) -> Self {
        let bytes = fs::read(&path).ok();
        let mut model = bytes
            .as_deref()
            .and_then(|bytes| serde_json::from_slice::<Value>(bytes).ok())
            .unwrap_or(Value::Null);
        if model.is_null() && bytes.is_some_and(|b| !b.is_empty()) {
            // unreadable: the UI is about to replace it with a fresh model, so keep a copy
            let _ = fs::copy(&path, path.with_extension("json.bad"));
        }
        // pop-out windows don't survive a restart: their workspaces go back to main
        if let Some(windows) = model.get_mut("windows").and_then(Value::as_object_mut) {
            windows.retain(|label, _| label == "main");
        }
        Self {
            inner: Mutex::new(Inner {
                version: 1,
                model,
                dirty: false,
            }),
            path,
            writing: Mutex::new(()),
        }
    }

    pub fn flush(&self) {
        let _writing = self.writing.lock();
        let data = {
            let mut g = self.inner.lock();
            if !g.dirty {
                return;
            }
            g.dirty = false;
            serde_json::to_vec_pretty(&g.model)
        };
        if let Ok(data) = data {
            if write_atomic(&self.path, &data).is_err() {
                // e.g. a scanner holding state.json open: try again on the next tick
                self.inner.lock().dirty = true;
            }
        }
    }

    /// Every pane id currently referenced by the model, or `None` when there is no
    /// model (missing or unreadable state.json) to compare against.
    pub fn pane_ids(&self) -> Option<HashSet<String>> {
        let g = self.inner.lock();
        g.model
            .get("panes")
            .and_then(Value::as_object)
            .map(|m| m.keys().cloned().collect())
    }
}

#[tauri::command]
pub fn state_get(store: State<'_, ModelStore>) -> Snapshot {
    let g = store.inner.lock();
    Snapshot {
        version: g.version,
        model: g.model.clone(),
    }
}

#[tauri::command]
pub fn state_commit(
    app: AppHandle,
    store: State<'_, ModelStore>,
    base_version: u64,
    model: Value,
    source: String,
) -> CommitResult {
    let mut g = store.inner.lock();
    if base_version != g.version {
        return CommitResult::Conflict {
            version: g.version,
            model: g.model.clone(),
        };
    }
    g.version += 1;
    g.model = model;
    g.dirty = true;
    let version = g.version;
    let event = ChangeEvent {
        version,
        model: g.model.clone(),
        source,
    };
    drop(g);
    let _ = app.emit("model://changed", event);
    CommitResult::Ok { version }
}
