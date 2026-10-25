//! Windows event logs for the Event Viewer module (plugin permission `eventlog.read`).
//! Result shapes: modules/shared/api.ts (EventChannel, EventLogInfo, EventPage).
//!
//! Query cursors and subscriptions belong to an `owner` (the plugin pane's id, passed
//! by the broker, never by the plugin) and are released with it.

mod registry;
mod wevt;

use tauri::{AppHandle, Manager};

pub use registry::{EventLogs, EventPage};
pub use wevt::{EventChannel, EventLogInfo};

use crate::paths::blocking;

#[tauri::command]
pub async fn eventlog_channels() -> Result<Vec<EventChannel>, String> {
    blocking(wevt::channels).await?
}

#[tauri::command]
pub async fn eventlog_info(channel: String) -> Result<EventLogInfo, String> {
    blocking(move || wevt::log_info(&channel)).await?
}

/// The first page; `reverse` (newest first) defaults to true.
#[tauri::command]
pub async fn eventlog_query(
    app: AppHandle,
    owner: String,
    channel: String,
    xpath: Option<String>,
    reverse: Option<bool>,
    text: Option<String>,
    max: Option<u32>,
) -> Result<EventPage, String> {
    blocking(move || {
        let logs = app.state::<EventLogs>();
        logs.query(&owner, &channel, xpath.as_deref(), reverse.unwrap_or(true), text.as_deref(), max)
    })
    .await?
}

#[tauri::command]
pub async fn eventlog_more(app: AppHandle, owner: String, cursor: u32, max: Option<u32>) -> Result<EventPage, String> {
    blocking(move || app.state::<EventLogs>().more(&owner, cursor, max)).await?
}

#[tauri::command]
pub async fn eventlog_close(app: AppHandle, owner: String, cursor: u32) -> Result<(), String> {
    blocking(move || app.state::<EventLogs>().close(&owner, cursor)).await?
}

#[tauri::command]
pub async fn eventlog_subscribe(
    app: AppHandle,
    owner: String,
    channel: String,
    xpath: Option<String>,
    text: Option<String>,
) -> Result<u32, String> {
    blocking(move || app.state::<EventLogs>().subscribe(&owner, &channel, xpath.as_deref(), text.as_deref())).await?
}

/// Events written since the last poll, oldest first.
#[tauri::command]
pub async fn eventlog_poll(app: AppHandle, owner: String, subscription: u32, max: Option<u32>) -> Result<Vec<String>, String> {
    blocking(move || app.state::<EventLogs>().poll(&owner, subscription, max)).await?
}

#[tauri::command]
pub async fn eventlog_unsubscribe(app: AppHandle, owner: String, subscription: u32) -> Result<(), String> {
    blocking(move || app.state::<EventLogs>().unsubscribe(&owner, subscription)).await?
}
