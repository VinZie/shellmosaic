//! settings.json, user themes, notes, backgrounds and per-plugin storage.
//!
//! The frontend owns the settings schema and defaults; this module only stores
//! JSON and notices external edits (polling mtimes keeps us dependency-free).

use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use parking_lot::Mutex;
use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::paths::{blocking, safe_key, write_atomic, ErrStr, Paths};

pub struct ConfigWatch {
    settings_mtime: Mutex<Option<SystemTime>>,
    themes_mtime: Mutex<Option<SystemTime>>,
}

fn mtime(p: &Path) -> Option<SystemTime> {
    fs::metadata(p).and_then(|m| m.modified()).ok()
}

fn dir_mtime(dir: &Path) -> Option<SystemTime> {
    let mut latest = mtime(dir);
    if let Ok(rd) = fs::read_dir(dir) {
        for e in rd.flatten() {
            let m = mtime(&e.path());
            if m > latest {
                latest = m;
            }
        }
    }
    latest
}

impl ConfigWatch {
    pub fn new(paths: &Paths) -> Self {
        Self {
            settings_mtime: Mutex::new(mtime(&paths.settings())),
            themes_mtime: Mutex::new(dir_mtime(&paths.themes())),
        }
    }

    /// Spawn a background poller that emits `config://settings` / `config://themes`
    /// when files are changed by something other than us.
    pub fn start(app: AppHandle, paths: Paths) {
        std::thread::spawn(move || loop {
            std::thread::sleep(Duration::from_millis(1200));
            let Some(watch) = tauri::Manager::try_state::<ConfigWatch>(&app) else { continue };
            let s = mtime(&paths.settings());
            {
                let mut last = watch.settings_mtime.lock();
                if s != *last {
                    *last = s;
                    let _ = app.emit("config://settings", ());
                }
            }
            let t = dir_mtime(&paths.themes());
            {
                let mut last = watch.themes_mtime.lock();
                if t != *last {
                    *last = t;
                    let _ = app.emit("config://themes", ());
                }
            }
        });
    }
}

#[tauri::command]
pub fn settings_read(paths: State<'_, Paths>) -> Value {
    fs::read(paths.settings())
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or(Value::Object(Default::default()))
}

/// Saves settings and tells the *other* windows (the payload is the writer's label).
#[tauri::command]
pub fn settings_write(
    app: AppHandle,
    window: tauri::Window,
    paths: State<'_, Paths>,
    watch: State<'_, ConfigWatch>,
    settings: Value,
) -> Result<(), String> {
    let data = serde_json::to_vec_pretty(&settings).s()?;
    write_atomic(&paths.settings(), &data).s()?;
    *watch.settings_mtime.lock() = mtime(&paths.settings());
    let _ = app.emit("config://settings", window.label());
    Ok(())
}

#[tauri::command]
pub fn themes_list(paths: State<'_, Paths>) -> Vec<Value> {
    let mut out = Vec::new();
    if let Ok(rd) = fs::read_dir(paths.themes()) {
        for e in rd.flatten() {
            let p = e.path();
            if p.extension().and_then(|x| x.to_str()) != Some("json") {
                continue;
            }
            if let Some(mut v) = fs::read(&p).ok().and_then(|b| serde_json::from_slice::<Value>(&b).ok()) {
                if v.is_object() {
                    if v.get("id").and_then(Value::as_str).is_none() {
                        let stem = p.file_stem().and_then(|s| s.to_str()).unwrap_or("theme").to_string();
                        v["id"] = Value::String(stem);
                    }
                    v["source"] = Value::String("user".into());
                    out.push(v);
                }
            }
        }
    }
    out
}

fn theme_path(paths: &Paths, id: &str) -> Result<PathBuf, String> {
    Ok(paths.themes().join(format!("{}.json", safe_key(id)?)))
}

#[tauri::command]
pub fn theme_save(app: AppHandle, paths: State<'_, Paths>, watch: State<'_, ConfigWatch>, theme: Value) -> Result<(), String> {
    let id = theme.get("id").and_then(Value::as_str).ok_or("theme needs an id")?;
    let path = theme_path(&paths, id)?;
    let mut theme = theme.clone();
    if let Some(o) = theme.as_object_mut() {
        o.remove("source");
    }
    write_atomic(&path, &serde_json::to_vec_pretty(&theme).s()?).s()?;
    *watch.themes_mtime.lock() = dir_mtime(&paths.themes());
    let _ = app.emit("config://themes", ());
    Ok(())
}

#[tauri::command]
pub fn theme_delete(app: AppHandle, paths: State<'_, Paths>, id: String) -> Result<(), String> {
    let mut path = theme_path(&paths, &id)?;
    if !path.exists() {
        // a hand-made file whose name differs from the id inside it
        let found = fs::read_dir(paths.themes()).ok().and_then(|rd| {
            rd.flatten().map(|e| e.path()).find(|p| {
                p.extension().and_then(|x| x.to_str()) == Some("json")
                    && fs::read(p)
                        .ok()
                        .and_then(|b| serde_json::from_slice::<Value>(&b).ok())
                        .is_some_and(|v| v.get("id").and_then(Value::as_str) == Some(id.as_str()))
            })
        });
        if let Some(p) = found {
            path = p;
        }
    }
    fs::remove_file(path).s()?;
    let _ = app.emit("config://themes", ());
    Ok(())
}

/// Read a theme JSON from anywhere (import). Validates it is an object with colors.
#[tauri::command]
pub async fn theme_read_file(path: String) -> Result<Value, String> {
    blocking(move || read_theme_file(&path)).await?
}

fn read_theme_file(path: &str) -> Result<Value, String> {
    let bytes = fs::read(path).s()?;
    if bytes.len() > 1024 * 1024 {
        return Err("theme file is too large".into());
    }
    let v: Value = serde_json::from_slice(&bytes).map_err(|e| format!("not valid JSON: {e}"))?;
    if !v.is_object() || (v.get("ui").is_none() && v.get("terminal").is_none()) {
        return Err("not a Shellmosaic theme (needs \"ui\" and/or \"terminal\" colors)".into());
    }
    Ok(v)
}

#[tauri::command]
pub fn notes_read(paths: State<'_, Paths>, key: String) -> Result<String, String> {
    let p = paths.notes().join(format!("{}.md", safe_key(&key)?));
    Ok(fs::read_to_string(p).unwrap_or_default())
}

#[tauri::command]
pub fn notes_write(paths: State<'_, Paths>, key: String, text: String) -> Result<(), String> {
    let p = paths.notes().join(format!("{}.md", safe_key(&key)?));
    write_atomic(&p, text.as_bytes()).s()
}

/// Copy an image into the app's backgrounds folder (the only place the asset
/// protocol may read from) and return its new absolute path.
#[tauri::command]
pub async fn background_import(app: AppHandle, path: String) -> Result<String, String> {
    blocking(move || import_background(&app.state::<Paths>(), &path)).await?
}

fn import_background(paths: &Paths, path: &str) -> Result<String, String> {
    let src = PathBuf::from(path);
    let ext = src
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .unwrap_or_default();
    if !["png", "jpg", "jpeg", "gif", "webp", "bmp", "avif"].contains(&ext.as_str()) {
        return Err("unsupported image type".into());
    }
    let meta = fs::metadata(&src).s()?;
    if meta.len() > 40 * 1024 * 1024 {
        return Err("image is larger than 40 MB".into());
    }
    let name = format!("{}.{ext}", uuid::Uuid::new_v4().simple());
    let dest = paths.backgrounds().join(name);
    fs::copy(&src, &dest).s()?;
    Ok(dest.to_string_lossy().into_owned())
}

#[tauri::command]
pub fn data_dir(paths: State<'_, Paths>) -> String {
    paths.root.to_string_lossy().into_owned()
}

#[tauri::command]
pub fn plugin_storage_get(paths: State<'_, Paths>, plugin_id: String) -> Result<Value, String> {
    let p = paths.plugin_data().join(format!("{}.json", safe_key(&plugin_id)?));
    Ok(fs::read(p)
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or(Value::Object(Default::default())))
}

#[tauri::command]
pub fn plugin_storage_set(paths: State<'_, Paths>, plugin_id: String, data: Value) -> Result<(), String> {
    let bytes = serde_json::to_vec(&data).s()?;
    if bytes.len() > 5 * 1024 * 1024 {
        return Err("plugin storage is limited to 5 MB".into());
    }
    let p = paths.plugin_data().join(format!("{}.json", safe_key(&plugin_id)?));
    write_atomic(&p, &bytes).s()
}
