//! Window creation (main + pop-outs) and native window effects.

use tauri::utils::config::WindowEffectsConfig;
use tauri::webview::PageLoadEvent;
use tauri::window::{Effect, EffectsBuilder};
use tauri::{AppHandle, Manager, Theme, Url, WebviewUrl, WebviewWindow, WebviewWindowBuilder, Window};

use crate::paths::ErrStr;

fn effects_for(name: &str) -> Option<WindowEffectsConfig> {
    let effect = match name {
        "mica" => Effect::Mica,
        "acrylic" => Effect::Acrylic,
        "tabbed" => Effect::Tabbed,
        "blur" => Effect::Blur,
        _ => return None,
    };
    Some(EffectsBuilder::new().effect(effect).build())
}

/// The app's own pages. Anything else must never replace the UI of a window that has IPC.
fn is_app_url(app: &AppHandle, url: &Url) -> bool {
    match url.scheme() {
        "tauri" => true,
        "http" | "https" => {
            url.host_str() == Some("tauri.localhost")
                || (cfg!(debug_assertions)
                    && app.config().build.dev_url.as_ref().is_some_and(|dev| dev.origin() == url.origin()))
        }
        _ => false,
    }
}

pub fn build_window(app: &AppHandle, label: &str, effect: &str, title: &str) -> Result<WebviewWindow, String> {
    let nav_app = app.clone();
    let mut b = WebviewWindowBuilder::new(app, label, WebviewUrl::App("index.html".into()))
        // links are opened in the browser by the UI; a navigation that slips through is refused
        .on_navigation(move |url| is_app_url(&nav_app, url))
        .on_page_load(|wv, payload| {
            // a reload drops the old page without cleanup: end the log tails it left behind
            if matches!(payload.event(), PageLoadEvent::Started) {
                if let Some(tails) = wv.try_state::<crate::logs::LogTails>() {
                    tails.close_webview(wv.label());
                }
            }
        })
        .title(title)
        .inner_size(1280.0, 800.0)
        .min_inner_size(640.0, 400.0)
        .decorations(false)
        .transparent(true)
        .shadow(true)
        .visible(false);
    if let Some(e) = effects_for(effect) {
        b = b.effects(e);
    }
    b.build().s()
}

/// Create a pop-out window. The frontend records which workspace it shows in the
/// model before calling this, keyed by the label.
#[tauri::command]
pub async fn window_create(app: AppHandle, label: String, effect: String, title: Option<String>) -> Result<(), String> {
    let ok = label.starts_with("win-")
        && label.len() <= 40
        && label.chars().all(|c| c.is_ascii_alphanumeric() || c == '-');
    if !ok {
        return Err("invalid window label".into());
    }
    // (plain Window lookups: a window hosting web-pane child webviews is no longer
    // a "WebviewWindow" in Tauri's eyes)
    if let Some(w) = app.get_window(&label) {
        return w.set_focus().s();
    }
    build_window(&app, &label, &effect, title.as_deref().unwrap_or("Shellmosaic"))?;
    Ok(())
}

#[tauri::command]
pub fn window_focus(app: AppHandle, label: String) -> Result<(), String> {
    match app.get_window(&label) {
        Some(w) => {
            let _ = w.unminimize();
            w.set_focus().s()
        }
        None => Err("window not found".into()),
    }
}

#[tauri::command]
pub fn window_labels(app: AppHandle) -> Vec<String> {
    app.windows().keys().cloned().collect()
}

#[tauri::command]
pub fn window_set_effect(window: Window, effect: String, dark: bool) -> Result<(), String> {
    window.set_effects(effects_for(&effect)).s()?;
    window
        .set_theme(Some(if dark { Theme::Dark } else { Theme::Light }))
        .s()
}
