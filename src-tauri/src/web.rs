//! Web panes: native child webviews positioned over a pane's rectangle.
//!
//! Child webviews only ever load http(s) pages and never get IPC access: the
//! capability file grants commands to the app's own webviews only, and the
//! navigation guard below refuses the app's internal origins and non-web schemes.

use serde_json::json;
use tauri::webview::{PageLoadEvent, WebviewBuilder};
use tauri::{AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, Url, WebviewUrl, Window};

use crate::paths::ErrStr;

fn label_for(pane_id: &str) -> Result<String, String> {
    if pane_id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') && !pane_id.is_empty() {
        Ok(format!("web-{pane_id}"))
    } else {
        Err("invalid pane id".into())
    }
}

const BLOCKED_HOSTS: &[&str] = &["tauri.localhost", "ipc.localhost", "asset.localhost", "smplugin.localhost", "smbg.localhost"];

fn allowed(url: &Url) -> bool {
    match url.scheme() {
        "http" | "https" => {
            let host = url.host_str().unwrap_or("");
            if BLOCKED_HOSTS.contains(&host) {
                return false;
            }
            // the dev server serves the app itself
            if cfg!(debug_assertions) && (host == "localhost" || host == "127.0.0.1") && url.port() == Some(1420) {
                return false;
            }
            true
        }
        "about" => url.as_str() == "about:blank",
        _ => false,
    }
}

pub fn normalize_url(input: &str) -> Result<Url, String> {
    let t = input.trim();
    let candidate = if t.contains("://") || t.starts_with("about:") {
        t.to_string()
    } else if t.starts_with("localhost") || t.starts_with("127.0.0.1") {
        format!("http://{t}")
    } else if t.contains('.') && !t.contains(' ') {
        format!("https://{t}")
    } else {
        // let Url encode the query: "c++ & rust" must not turn into extra parameters
        let mut search = Url::parse("https://duckduckgo.com/").s()?;
        search.query_pairs_mut().append_pair("q", t);
        search.to_string()
    };
    let url = Url::parse(&candidate).s()?;
    if !allowed(&url) {
        return Err("only http(s) pages can be opened in a web pane".into());
    }
    Ok(url)
}

#[tauri::command]
pub async fn web_open(
    app: AppHandle,
    window: Window,
    pane_id: String,
    url: String,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> Result<String, String> {
    let label = label_for(&pane_id)?;
    let url = normalize_url(&url)?;
    if let Some(wv) = app.get_webview(&label) {
        if wv.window().label() != window.label() {
            let _ = wv.close();
        } else {
            let _ = wv.set_position(LogicalPosition::new(x, y));
            let _ = wv.set_size(LogicalSize::new(width.max(1.0), height.max(1.0)));
            let _ = wv.show();
            return Ok(url.to_string());
        }
    }

    let nav_app = app.clone();
    let nav_pane = pane_id.clone();
    let load_app = app.clone();
    let load_pane = pane_id.clone();
    let builder = WebviewBuilder::new(&label, WebviewUrl::External(url.clone()))
        .on_navigation(move |u| {
            let ok = allowed(u);
            if ok {
                let _ = nav_app.emit("web://nav", json!({ "paneId": nav_pane, "url": u.as_str() }));
            }
            ok
        })
        .on_page_load(move |_wv, payload| {
            let loading = matches!(payload.event(), PageLoadEvent::Started);
            let _ = load_app.emit(
                "web://load",
                json!({ "paneId": load_pane, "url": payload.url().as_str(), "loading": loading }),
            );
        });
    window
        .add_child(builder, LogicalPosition::new(x, y), LogicalSize::new(width.max(1.0), height.max(1.0)))
        .s()?;
    Ok(url.to_string())
}

#[tauri::command]
pub fn web_bounds(app: AppHandle, pane_id: String, x: f64, y: f64, width: f64, height: f64) -> Result<(), String> {
    if let Some(wv) = app.get_webview(&label_for(&pane_id)?) {
        wv.set_position(LogicalPosition::new(x, y)).s()?;
        wv.set_size(LogicalSize::new(width.max(1.0), height.max(1.0))).s()?;
    }
    Ok(())
}

#[tauri::command]
pub fn web_visible(app: AppHandle, pane_id: String, visible: bool) -> Result<(), String> {
    if let Some(wv) = app.get_webview(&label_for(&pane_id)?) {
        if visible { wv.show().s()? } else { wv.hide().s()? }
    }
    Ok(())
}

#[tauri::command]
pub fn web_navigate(app: AppHandle, pane_id: String, url: String) -> Result<String, String> {
    let url = normalize_url(&url)?;
    if let Some(wv) = app.get_webview(&label_for(&pane_id)?) {
        wv.navigate(url.clone()).s()?;
    }
    Ok(url.to_string())
}

#[tauri::command]
pub fn web_action(app: AppHandle, pane_id: String, action: String) -> Result<(), String> {
    let Some(wv) = app.get_webview(&label_for(&pane_id)?) else { return Ok(()) };
    let js = match action.as_str() {
        "back" => "history.back()",
        "forward" => "history.forward()",
        "reload" => "location.reload()",
        "stop" => "window.stop()",
        _ => return Err("unknown action".into()),
    };
    wv.eval(js).s()
}

#[tauri::command]
pub fn web_zoom(app: AppHandle, pane_id: String, factor: f64) -> Result<(), String> {
    if let Some(wv) = app.get_webview(&label_for(&pane_id)?) {
        wv.set_zoom(factor.clamp(0.25, 5.0)).s()?;
    }
    Ok(())
}

#[tauri::command]
pub fn web_close(app: AppHandle, pane_id: String) -> Result<(), String> {
    if let Some(wv) = app.get_webview(&label_for(&pane_id)?) {
        wv.close().s()?;
    }
    Ok(())
}

/// Hide every web pane in a window (used while menus or dialogs are open, since
/// native child webviews always paint above the app's HTML). The frontend shows
/// the ones that should be visible again with `web_visible`.
#[tauri::command]
pub fn web_hide_all(app: AppHandle, window: Window) {
    for (label, wv) in app.webviews() {
        if label.starts_with("web-") && wv.window().label() == window.label() {
            let _ = wv.hide();
        }
    }
}
