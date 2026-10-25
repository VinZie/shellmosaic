//! Filesystem locations and small IO helpers shared by every backend module.

use std::fs;
use std::io::{self, Write};
use std::path::{Path, PathBuf};

use tauri::{AppHandle, Manager};

/// Root data directory (`%APPDATA%\com.shellmosaic.app`) and its sub-folders.
#[derive(Clone)]
pub struct Paths {
    pub root: PathBuf,
}

impl Paths {
    pub fn new(app: &AppHandle) -> Self {
        let root = app
            .path()
            .app_data_dir()
            .expect("Shellmosaic needs an app data directory");
        for dir in [
            "themes",
            "plugins",
            "sessions",
            "notes",
            "backgrounds",
            "plugin-data",
        ] {
            let _ = fs::create_dir_all(root.join(dir));
        }
        Self { root }
    }

    pub fn settings(&self) -> PathBuf {
        self.root.join("settings.json")
    }
    pub fn state(&self) -> PathBuf {
        self.root.join("state.json")
    }
    pub fn themes(&self) -> PathBuf {
        self.root.join("themes")
    }
    pub fn plugins(&self) -> PathBuf {
        self.root.join("plugins")
    }
    pub fn sessions(&self) -> PathBuf {
        self.root.join("sessions")
    }
    pub fn notes(&self) -> PathBuf {
        self.root.join("notes")
    }
    pub fn backgrounds(&self) -> PathBuf {
        self.root.join("backgrounds")
    }
    pub fn plugin_data(&self) -> PathBuf {
        self.root.join("plugin-data")
    }
}

/// Write via a temp file + rename so a crash never leaves a half-written file.
pub fn write_atomic(path: &Path, data: &[u8]) -> io::Result<()> {
    use std::sync::atomic::{AtomicU64, Ordering};
    // unique per call: two threads saving the same file (periodic flush + exit) must not share a temp file
    static SEQ: AtomicU64 = AtomicU64::new(0);
    let tmp = path.with_extension(format!("{}.tmp~", SEQ.fetch_add(1, Ordering::Relaxed)));
    let write = || -> io::Result<()> {
        let mut f = fs::File::create(&tmp)?;
        f.write_all(data)?;
        // on disk before the rename: after a power cut NTFS can keep the (journaled) rename
        // but not the cached data, leaving a zero-filled file in place of the old one.
        // Best effort: a filesystem that can't flush must not stop the save itself.
        let _ = f.sync_all();
        Ok(())
    };
    if let Err(e) = write().and_then(|_| fs::rename(&tmp, path)) {
        let _ = fs::remove_file(&tmp);
        return Err(e);
    }
    Ok(())
}

/// Run blocking work (file system, process tables, shell operations) on the blocking
/// pool: off the main thread, and off the async workers that SSH sessions and every
/// async command share — a dead network share must not stall those.
pub async fn blocking<T: Send + 'static>(f: impl FnOnce() -> T + Send + 'static) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(f).await.map_err(|e| e.to_string())
}

/// Accept only simple identifiers (used for file names derived from user/plugin input).
pub fn safe_key(s: &str) -> Result<String, String> {
    let ok = !s.is_empty()
        && s.len() <= 120
        && s
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.')
        && !s.starts_with('.');
    if ok {
        Ok(s.to_string())
    } else {
        Err(format!("invalid identifier: {s:?}"))
    }
}

pub trait ErrStr<T> {
    fn s(self) -> Result<T, String>;
}

impl<T, E: std::fmt::Display> ErrStr<T> for Result<T, E> {
    fn s(self) -> Result<T, String> {
        self.map_err(|e| e.to_string())
    }
}

/// `std::process::Command` that never flashes a console window.
pub fn hidden_command(program: &str) -> std::process::Command {
    let mut cmd = std::process::Command::new(program);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd
}
