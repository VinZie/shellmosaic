//! Third-party modules ("plugins"): a folder with `manifest.json` + web files.
//!
//! Plugins are served from the `smplugin` scheme into a sandboxed iframe (opaque
//! origin, no IPC). Everything they can do goes through the host page's
//! permission-checked postMessage broker; the CSP sent here keeps them from
//! talking to the network unless the user granted the `net` permission.

use std::fs;
use std::path::{Path, PathBuf};

use serde::Serialize;
use serde_json::Value;
use tauri::http::{header, Request, Response, StatusCode};
use tauri::{AppHandle, Manager, Runtime, UriSchemeContext, UriSchemeResponder};

use crate::paths::{blocking, safe_key, ErrStr, Paths};
use crate::vt::percent_decode;

const SDK: &str = include_str!("../plugin-sdk/shellmosaic.js");

/// Bundled plugins, by id: (file name, contents). Claude Usage, bundled in 0.2.1, is an optional
/// module now (modules/claude-usage): existing installs keep it, new ones get it from the store.
const EXAMPLES: &[(&str, &[(&str, &str)])] = &[
    (
        "command-board",
        &[
            ("manifest.json", include_str!("../plugin-sdk/examples/command-board/manifest.json")),
            ("index.html", include_str!("../plugin-sdk/examples/command-board/index.html")),
        ],
    ),

];

pub const KNOWN_PERMISSIONS: &[&str] = &[
    "terminal.write",
    "terminal.read",
    "terminal.run",
    "fs.read",
    "fs.write",
    "shell.exec",
    "system.read",
    "clipboard",
    "net",
    "claude.usage",
    "process.inspect",
    "process.control",
    "eventlog.read",
    "sqlite",
    "agents.read",
    "agents.manage",
];

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginInfo {
    id: String,
    dir: String,
    manifest: Option<Value>,
    error: Option<String>,
}

fn read_manifest(dir: &Path, id: &str) -> Result<Value, String> {
    let bytes = fs::read(dir.join("manifest.json")).map_err(|_| "missing manifest.json".to_string())?;
    let v: Value = serde_json::from_slice(&bytes).map_err(|e| format!("manifest.json is not valid JSON: {e}"))?;
    let mid = v.get("id").and_then(Value::as_str).unwrap_or("");
    if mid != id {
        return Err(format!("manifest id {mid:?} must match folder name {id:?}"));
    }
    if v.get("name").and_then(Value::as_str).is_none() {
        return Err("manifest needs a \"name\"".into());
    }
    let entry = v.get("entry").and_then(Value::as_str).unwrap_or("index.html");
    // "../other/index.html" would load another plugin's page (and CSP) under this plugin's session
    if !Path::new(entry).components().all(|c| matches!(c, std::path::Component::Normal(_))) {
        return Err(format!("entry {entry:?} must be a path inside the plugin folder"));
    }
    if !dir.join(entry).is_file() {
        return Err(format!("entry file {entry:?} not found"));
    }
    match v.get("permissions") {
        None | Some(Value::Null) => {}
        Some(Value::Array(perms)) => {
            for p in perms {
                let p = p.as_str().unwrap_or("");
                if !KNOWN_PERMISSIONS.contains(&p) {
                    return Err(format!("unknown permission {p:?}"));
                }
            }
        }
        Some(_) => return Err("\"permissions\" must be a list".into()),
    }
    Ok(v)
}

/// The checks a plugin folder must pass to load (for the module store's downloads).
pub fn check_manifest(dir: &Path, id: &str) -> Result<(), String> {
    read_manifest(dir, id).map(|_| ())
}

#[tauri::command]
pub fn plugins_list(paths: tauri::State<'_, Paths>) -> Vec<PluginInfo> {
    let mut out = Vec::new();
    if let Ok(rd) = fs::read_dir(paths.plugins()) {
        for e in rd.flatten() {
            if !e.path().is_dir() {
                continue;
            }
            let id = e.file_name().to_string_lossy().into_owned();
            let (manifest, error) = match safe_key(&id).and_then(|_| read_manifest(&e.path(), &id)) {
                Ok(m) => (Some(m), None),
                Err(err) => (None, Some(err)),
            };
            out.push(PluginInfo { id, dir: e.path().to_string_lossy().into_owned(), manifest, error });
        }
    }
    out.sort_by(|a, b| a.id.cmp(&b.id));
    out
}

fn copy_dir(src: &Path, dst: &Path, depth: usize) -> std::io::Result<()> {
    if depth > 16 {
        return Ok(());
    }
    fs::create_dir_all(dst)?;
    for e in fs::read_dir(src)?.flatten() {
        let ft = e.file_type()?;
        let to = dst.join(e.file_name());
        if ft.is_dir() {
            copy_dir(&e.path(), &to, depth + 1)?;
        } else if ft.is_file() {
            fs::copy(e.path(), to)?;
        }
    }
    Ok(())
}

/// Install a plugin by copying a folder that contains a valid manifest.json.
#[tauri::command]
pub async fn plugin_install_folder(app: AppHandle, src: String) -> Result<String, String> {
    blocking(move || install_folder(&app.state::<Paths>(), PathBuf::from(src))).await?
}

fn install_folder(paths: &Paths, src: PathBuf) -> Result<String, String> {
    let v: Value = serde_json::from_slice(&fs::read(src.join("manifest.json")).map_err(|_| "folder has no manifest.json")?)
        .map_err(|e| format!("manifest.json is not valid JSON: {e}"))?;
    let id = safe_key(v.get("id").and_then(Value::as_str).ok_or("manifest needs an \"id\"")?)?;
    read_manifest(&src, &id).or_else(|e| {
        // folder name may differ from id when installing; only that check is relaxed
        if e.contains("must match folder name") { Ok(v.clone()) } else { Err(e) }
    })?;
    let dest = paths.plugins().join(&id);
    if let (Ok(a), Ok(b)) = (src.canonicalize(), dest.canonicalize()) {
        // picked the installed folder itself: trashing dest would throw away the source
        if a == b {
            return Ok(id);
        }
    }
    if dest.exists() {
        trash::delete(&dest).s()?;
    }
    copy_dir(&src, &dest, 0).s()?;
    crate::store::forget(paths, &id);
    Ok(id)
}

#[tauri::command]
pub async fn plugin_remove(app: AppHandle, id: String) -> Result<(), String> {
    let id = safe_key(&id)?;
    let paths = app.state::<Paths>().inner().clone();
    blocking(move || {
        trash::delete(paths.plugins().join(&id)).s()?;
        crate::store::forget(&paths, &id);
        Ok(())
    })
    .await?
}

/// Drop in the bundled plugins, each one once: one the user removed stays removed, and one
/// added in a later version still arrives. The marker lists the ids already installed.
pub fn install_examples(paths: &Paths) {
    const HEADER: &str = "# Bundled plugins already installed. To get one back, delete its folder and its line here.\n";
    let marker = paths.plugins().join(".examples-installed");
    let mut done: Vec<String> = match fs::read_to_string(&marker) {
        Ok(text) if text.starts_with('#') => text.lines().map(str::trim).filter(|l| safe_key(l).is_ok()).map(String::from).collect(),
        // 0.2's marker had no list: it only ever installed the command board
        Ok(_) => vec!["command-board".into()],
        Err(_) => Vec::new(),
    };
    let before = done.len();
    for (id, files) in EXAMPLES {
        if done.iter().any(|d| d == id) {
            continue;
        }
        let dir = paths.plugins().join(id);
        // a folder of that name is the user's own plugin: leave it alone
        if !dir.exists() && fs::create_dir_all(&dir).is_ok() {
            for (file, body) in *files {
                let _ = fs::write(dir.join(file), body);
            }
        }
        done.push(id.to_string());
    }
    if done.len() != before || !marker.exists() {
        let _ = fs::write(marker, format!("{HEADER}{}\n", done.join("\n")));
    }
}

fn mime(path: &Path) -> &'static str {
    match path.extension().and_then(|e| e.to_str()).map(|e| e.to_ascii_lowercase()).as_deref() {
        Some("html" | "htm") => "text/html; charset=utf-8",
        Some("js" | "mjs") => "text/javascript; charset=utf-8",
        Some("css") => "text/css; charset=utf-8",
        Some("json") => "application/json",
        Some("svg") => "image/svg+xml",
        Some("png") => "image/png",
        Some("jpg" | "jpeg") => "image/jpeg",
        Some("gif") => "image/gif",
        Some("webp") => "image/webp",
        Some("bmp") => "image/bmp",
        Some("avif") => "image/avif",
        Some("woff2") => "font/woff2",
        Some("woff") => "font/woff",
        Some("ttf") => "font/ttf",
        Some("wasm") => "application/wasm",
        Some("txt" | "md") => "text/plain; charset=utf-8",
        _ => "application/octet-stream",
    }
}

fn respond(status: StatusCode, content_type: &str, body: Vec<u8>, csp: Option<String>) -> Response<Vec<u8>> {
    let mut b = Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, content_type)
        .header(header::CACHE_CONTROL, "no-cache")
        .header("X-Content-Type-Options", "nosniff")
        // sandboxed (opaque-origin) frames load module scripts in CORS mode
        .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*");
    if let Some(csp) = csp {
        b = b.header(header::CONTENT_SECURITY_POLICY, csp);
    }
    b.body(body).unwrap_or_else(|_| Response::new(Vec::new()))
}

fn csp_for(manifest: &Value) -> String {
    let net = manifest
        .get("permissions")
        .and_then(Value::as_array)
        .map(|a| a.iter().any(|p| p.as_str() == Some("net")))
        .unwrap_or(false);
    let me = "http://smplugin.localhost smplugin:";
    let (connect, img) = if net { ("https: wss:", "https:") } else { ("'none'", "") };
    format!(
        "default-src 'none'; script-src 'self' 'unsafe-inline' {me}; style-src 'self' 'unsafe-inline' {me}; \
         img-src 'self' data: blob: {me} {img}; font-src 'self' data: {me}; media-src 'self' data: blob: {me}; \
         connect-src {connect}; frame-src 'none'; form-action 'none'; base-uri 'none'"
    )
}

fn serve(paths: &Paths, req: &Request<Vec<u8>>) -> Response<Vec<u8>> {
    let not_found = || respond(StatusCode::NOT_FOUND, "text/plain", b"not found".to_vec(), None);
    let path = percent_decode(req.uri().path());
    let path = path.trim_start_matches('/');
    let Some((id, rest)) = path.split_once('/') else { return not_found() };

    if id == "__sdk" {
        return respond(StatusCode::OK, "text/javascript; charset=utf-8", SDK.as_bytes().to_vec(), None);
    }
    if safe_key(id).is_err() {
        return not_found();
    }
    // plain names only, checked before touching the disk: joining an absolute or
    // \\host\share path would replace the plugin folder, and even canonicalize() on
    // a network path makes Windows log in to that host
    if !Path::new(rest).components().all(|c| matches!(c, std::path::Component::Normal(_))) {
        return respond(StatusCode::FORBIDDEN, "text/plain", b"forbidden".to_vec(), None);
    }
    let dir = paths.plugins().join(id);
    let Ok(manifest) = read_manifest(&dir, id) else { return not_found() };
    let (Ok(base), Ok(target)) = (dir.canonicalize(), dir.join(if rest.is_empty() { "index.html" } else { rest }).canonicalize()) else {
        return not_found();
    };
    if !target.starts_with(&base) || !target.is_file() {
        return respond(StatusCode::FORBIDDEN, "text/plain", b"forbidden".to_vec(), None);
    }
    match fs::read(&target) {
        Ok(body) => respond(StatusCode::OK, mime(&target), body, Some(csp_for(&manifest))),
        Err(_) => not_found(),
    }
}

/// Custom protocols are reachable from every webview, web panes included: serve only
/// the app's own windows (plugin frames live inside them).
pub fn from_app_window(label: &str) -> bool {
    label == "main" || label.starts_with("win-")
}

pub fn forbidden() -> Response<Vec<u8>> {
    respond(StatusCode::FORBIDDEN, "text/plain", b"forbidden".to_vec(), None)
}

pub fn protocol<R: Runtime>(ctx: UriSchemeContext<'_, R>, req: Request<Vec<u8>>, responder: UriSchemeResponder) {
    if !from_app_window(ctx.webview_label()) {
        return responder.respond(forbidden());
    }
    let paths = ctx.app_handle().state::<Paths>().inner().clone();
    std::thread::spawn(move || responder.respond(serve(&paths, &req)));
}

/// `smbg`: the images in the backgrounds folder, by the random names `background_import`
/// gives them — nothing else. (Replaces Tauri's asset protocol, which resolves any path,
/// network shares included, before checking whether it's allowed.)
pub fn background_protocol<R: Runtime>(ctx: UriSchemeContext<'_, R>, req: Request<Vec<u8>>, responder: UriSchemeResponder) {
    if !from_app_window(ctx.webview_label()) {
        return responder.respond(forbidden());
    }
    let name = req.uri().path().trim_start_matches('/').to_string();
    let valid = name.split_once('.').is_some_and(|(id, ext)| {
        id.len() == 32
            && id.bytes().all(|b| b.is_ascii_hexdigit())
            && ["png", "jpg", "jpeg", "gif", "webp", "bmp", "avif"].contains(&ext)
    });
    if !valid {
        return responder.respond(forbidden());
    }
    let path = ctx.app_handle().state::<Paths>().backgrounds().join(&name);
    std::thread::spawn(move || {
        responder.respond(match fs::read(&path) {
            Ok(body) => respond(StatusCode::OK, mime(&path), body, None),
            Err(_) => respond(StatusCode::NOT_FOUND, "text/plain", b"not found".to_vec(), None),
        })
    });
}
