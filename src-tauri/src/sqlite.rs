//! SQLite databases for the SQLite Browser module (plugin permission `sqlite`).
//! Result shapes: modules/shared/api.ts (DbInfo, SchemaObject, QueryResult, Cell).
//!
//! Connections belong to an `owner` (the plugin pane's id, passed by the broker,
//! never by the plugin) and are closed with it. The submodules don't use Tauri, so
//! they can be tested on their own.

mod db;
mod query;
mod schema;

use serde_json::Value;
use tauri::{AppHandle, Manager};

pub use db::{sweep_temp, Sqlite};
use db::DbInfo;
use query::QueryResult;
use schema::SchemaObject;

use crate::paths::blocking;

/// Open a local database file, read-only unless `writable`; from a temporary copy when
/// `copy` is set or the file is locked by another program.
#[tauri::command]
pub async fn sqlite_open(app: AppHandle, owner: String, path: String, writable: Option<bool>, copy: Option<bool>) -> Result<DbInfo, String> {
    blocking(move || app.state::<Sqlite>().open(&owner, &path, writable.unwrap_or(false), copy.unwrap_or(false))).await?
}

#[tauri::command]
pub async fn sqlite_schema(app: AppHandle, owner: String, id: u32) -> Result<Vec<SchemaObject>, String> {
    blocking(move || app.state::<Sqlite>().schema(&owner, id)).await?
}

#[tauri::command]
pub async fn sqlite_count(app: AppHandle, owner: String, id: u32, table: String) -> Result<u64, String> {
    blocking(move || app.state::<Sqlite>().count(&owner, id, &table)).await?
}

/// Run every statement in `sql`; `params` bind to the last one.
#[tauri::command]
pub async fn sqlite_query(
    app: AppHandle,
    owner: String,
    id: u32,
    sql: String,
    params: Option<Vec<Value>>,
    max_rows: Option<u32>,
) -> Result<QueryResult, String> {
    blocking(move || app.state::<Sqlite>().query(&owner, id, &sql, params.as_deref().unwrap_or_default(), max_rows)).await?
}

#[tauri::command]
pub async fn sqlite_set_writable(app: AppHandle, owner: String, id: u32, writable: bool) -> Result<DbInfo, String> {
    blocking(move || app.state::<Sqlite>().set_writable(&owner, id, writable)).await?
}

/// Stop the running query (without waiting for it).
#[tauri::command]
pub async fn sqlite_interrupt(app: AppHandle, owner: String, id: u32) -> Result<(), String> {
    blocking(move || app.state::<Sqlite>().interrupt(&owner, id)).await?
}

#[tauri::command]
pub async fn sqlite_close(app: AppHandle, owner: String, id: u32) -> Result<(), String> {
    blocking(move || app.state::<Sqlite>().close(&owner, id)).await?
}
