mod claude;
mod config;
mod env;
mod fsops;
mod git;
mod logs;
mod paths;
mod plugins;
mod pty;
mod sanitize;
mod sftp;
mod shells;
mod ssh;
mod state;
mod sysmon;
mod tasks;
mod vault;
mod vt;
mod web;
mod windows;

use std::time::Duration;

use tauri::{Emitter, Manager, RunEvent, WindowEvent};
use tauri_plugin_window_state::StateFlags;

use crate::paths::Paths;
use crate::pty::PtyManager;
use crate::state::ModelStore;

fn startup_effect(paths: &Paths) -> String {
    std::fs::read(paths.settings())
        .ok()
        .and_then(|b| serde_json::from_slice::<serde_json::Value>(&b).ok())
        .and_then(|v| v.pointer("/window/effect").and_then(|e| e.as_str()).map(str::to_string))
        .unwrap_or_else(|| "mica".into())
}

fn persist_all(app: &tauri::AppHandle) {
    if let Some(store) = app.try_state::<ModelStore>() {
        store.flush();
    }
    if let Some(ptys) = app.try_state::<PtyManager>() {
        ptys.persist();
    }
}

pub fn run() {
    tauri::Builder::default()
        // first: a second launch would start the same panes' shells again and both
        // instances would overwrite each other's state.json — bring this one forward instead
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(w) = app.get_window("main") {
                let _ = w.unminimize();
                let _ = w.set_focus();
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(
            tauri_plugin_window_state::Builder::new()
                .with_state_flags(StateFlags::SIZE | StateFlags::POSITION | StateFlags::MAXIMIZED)
                .build(),
        )
        .register_asynchronous_uri_scheme_protocol("smplugin", plugins::protocol)
        .register_asynchronous_uri_scheme_protocol("smbg", plugins::background_protocol)
        .setup(|app| {
            let handle = app.handle().clone();
            let paths = Paths::new(&handle);
            let store = ModelStore::load(paths.state());
            let ptys = PtyManager::new(handle.clone(), paths.sessions());
            // without a model every saved session would look orphaned
            if let Some(live) = store.pane_ids() {
                ptys.gc(&live);
            }
            plugins::install_examples(&paths);
            let effect = startup_effect(&paths);

            app.manage(config::ConfigWatch::new(&paths));
            config::ConfigWatch::start(handle.clone(), paths.clone());
            app.manage(vault::Vault::new(handle.clone(), &paths));
            vault::Vault::start_auto_lock(handle.clone());
            app.manage(ssh::Prompts::default());
            app.manage(sftp::SftpConns::default());
            app.manage(git::GitTrust::load(paths.root.join("trusted-repos.json")));
            app.manage(paths);
            app.manage(store);
            app.manage(ptys);
            app.manage(sysmon::SysMon::new());
            app.manage(logs::LogTails::default());
            app.manage(claude::ClaudeUsage::default());

            // Debounced persistence: model every second, scrollback every 30 s.
            let h = handle.clone();
            std::thread::spawn(move || {
                let mut tick = 0u32;
                loop {
                    std::thread::sleep(Duration::from_secs(1));
                    tick = tick.wrapping_add(1);
                    h.state::<ModelStore>().flush();
                    if tick % 30 == 0 {
                        h.state::<PtyManager>().persist();
                    }
                }
            });

            windows::build_window(&handle, "main", &effect, "Shellmosaic")?;
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::Destroyed = event {
                let app = window.app_handle();
                if let Some(tails) = app.try_state::<logs::LogTails>() {
                    tails.close_webview(window.label());
                }
                if window.label() == "main" {
                    persist_all(app);
                    app.exit(0);
                } else if window.label().starts_with("win-") {
                    let _ = app.emit("window://closed", window.label());
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            state::state_get,
            state::state_commit,
            pty::pty_attach,
            pty::pty_detach,
            pty::pty_write,
            pty::pty_resize,
            pty::pty_kill,
            pty::pty_info,
            pty::pty_text,
            pty::pty_configure,
            shells::shells_list,
            config::settings_read,
            config::settings_write,
            config::themes_list,
            config::theme_save,
            config::theme_delete,
            config::theme_read_file,
            config::notes_read,
            config::notes_write,
            config::background_import,
            config::data_dir,
            config::plugin_storage_get,
            config::plugin_storage_set,
            fsops::fs_list,
            fsops::fs_preview,
            fsops::fs_home,
            fsops::fs_drives,
            fsops::fs_is_dir,
            fsops::fs_read_text,
            fsops::fs_write_text,
            fsops::fs_rename,
            fsops::fs_mkdir,
            fsops::fs_new_file,
            fsops::fs_trash,
            sysmon::sys_snapshot,
            sysmon::proc_list,
            sysmon::proc_kill,
            sysmon::net_sockets,
            git::git_status,
            git::git_log,
            git::git_diff,
            git::git_op,
            git::git_trust,
            tasks::tasks_detect,
            logs::log_open,
            logs::log_close,
            web::web_open,
            web::web_bounds,
            web::web_visible,
            web::web_navigate,
            web::web_action,
            web::web_zoom,
            web::web_close,
            web::web_hide_all,
            windows::window_create,
            windows::window_focus,
            windows::window_labels,
            windows::window_set_effect,
            plugins::plugins_list,
            plugins::plugin_install_folder,
            plugins::plugin_remove,
            claude::claude_usage,
            vault::vault_status,
            vault::vault_create,
            vault::vault_unlock,
            vault::vault_lock,
            vault::vault_change_password,
            vault::vault_reset,
            vault::vault_configure,
            vault::hosts_list,
            vault::host_save,
            vault::host_delete,
            vault::host_forget_keys,
            ssh::ssh_prompt_answer,
            sftp::sftp_connect,
            sftp::sftp_close,
            sftp::sftp_list,
            sftp::sftp_mkdir,
            sftp::sftp_rename,
            sftp::sftp_delete,
            sftp::sftp_download,
            sftp::sftp_upload,
            sftp::sftp_cancel,
            run_command,
            app_persist,
        ])
        .build(tauri::generate_context!())
        .expect("error while building Shellmosaic")
        .run(|app, event| {
            if let RunEvent::Exit = event {
                persist_all(app);
            }
        });
}

/// Save the layout and scrollback now: the updater's installer ends the app without
/// going through the normal exit.
#[tauri::command]
async fn app_persist(app: tauri::AppHandle) -> Result<(), String> {
    paths::blocking(move || persist_all(&app)).await
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ExecResult {
    code: Option<i32>,
    stdout: String,
    stderr: String,
    timed_out: bool,
}

/// Run a program to completion (no shell) — used by plugins with `shell.exec`.
#[tauri::command]
async fn run_command(program: String, args: Vec<String>, cwd: Option<String>, timeout_ms: Option<u64>) -> Result<ExecResult, String> {
    use std::io::Read;
    use std::process::Stdio;
    use std::sync::{mpsc, Arc};
    const CAP: usize = 4 * 1024 * 1024;
    tauri::async_runtime::spawn_blocking(move || {
        let mut cmd = paths::hidden_command(&program);
        cmd.args(&args).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
        if let Some(dir) = cwd.filter(|d| std::path::Path::new(d).is_dir()) {
            cmd.current_dir(dir);
        }
        let mut child = cmd.spawn().map_err(|e| format!("failed to start {program}: {e}"))?;
        // Keep at most CAP bytes per stream but drain everything, so a chatty child never
        // blocks on a full pipe. Readers report back over `done` instead of being joined:
        // a grandchild that inherited the pipes can hold them open long after the child exits.
        let (done_tx, done) = mpsc::channel::<()>();
        let read_capped = |mut r: Box<dyn Read + Send>| {
            let buf = Arc::new(parking_lot::Mutex::new(Vec::new()));
            let (b, tx) = (buf.clone(), done_tx.clone());
            std::thread::spawn(move || {
                let mut chunk = vec![0u8; 64 * 1024];
                while let Ok(n) = r.read(&mut chunk) {
                    if n == 0 {
                        break;
                    }
                    let mut b = b.lock();
                    let room = CAP.saturating_sub(b.len());
                    b.extend_from_slice(&chunk[..n.min(room)]);
                }
                let _ = tx.send(());
            });
            buf
        };
        let stdout = read_capped(Box::new(child.stdout.take().unwrap()));
        let stderr = read_capped(Box::new(child.stderr.take().unwrap()));
        drop(done_tx);
        let deadline = std::time::Instant::now() + Duration::from_millis(timeout_ms.unwrap_or(30_000).min(600_000));
        let mut timed_out = false;
        let code = loop {
            if let Some(st) = child.try_wait().map_err(|e| e.to_string())? {
                break st.code();
            }
            if std::time::Instant::now() > deadline {
                // the whole tree: a killed `cmd /c npm run x` would otherwise leave node running, unseen
                let _ = paths::hidden_command("taskkill").args(["/PID", &child.id().to_string(), "/T", "/F"]).output();
                let _ = child.kill();
                timed_out = true;
                break None;
            }
            std::thread::sleep(Duration::from_millis(20));
        };
        let grace = std::time::Instant::now() + Duration::from_secs(2);
        for _ in 0..2 {
            if done.recv_timeout(grace.saturating_duration_since(std::time::Instant::now())).is_err() {
                break;
            }
        }
        let text = |b: &parking_lot::Mutex<Vec<u8>>| String::from_utf8_lossy(&b.lock()).into_owned();
        Ok(ExecResult { code, stdout: text(&stdout), stderr: text(&stderr), timed_out })
    })
    .await
    .map_err(|e| e.to_string())?
}
