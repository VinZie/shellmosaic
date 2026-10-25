//! File-system access for the Files, Notes and Log modules (and plugins via the broker).

use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use base64::Engine;
use serde::Serialize;

use crate::paths::{blocking, ErrStr};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    name: String,
    path: String,
    is_dir: bool,
    is_link: bool,
    hidden: bool,
    size: u64,
    modified: u64,
}

fn is_hidden(name: &str, meta: &fs::Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        const HIDDEN: u32 = 0x2;
        const SYSTEM: u32 = 0x4;
        if meta.file_attributes() & (HIDDEN | SYSTEM) != 0 {
            return true;
        }
    }
    let _ = meta;
    name.starts_with('.')
}

#[tauri::command]
pub async fn fs_list(path: String, show_hidden: Option<bool>) -> Result<Vec<Entry>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let show_hidden = show_hidden.unwrap_or(false);
        let mut out = Vec::new();
        for e in fs::read_dir(&path).s()?.flatten() {
            let name = e.file_name().to_string_lossy().into_owned();
            let Ok(lmeta) = e.metadata() else { continue };
            let is_link = lmeta.file_type().is_symlink();
            let meta = if is_link { fs::metadata(e.path()).unwrap_or(lmeta) } else { lmeta };
            let hidden = is_hidden(&name, &meta);
            if hidden && !show_hidden {
                continue;
            }
            out.push(Entry {
                path: e.path().to_string_lossy().into_owned(),
                is_dir: meta.is_dir(),
                is_link,
                hidden,
                size: if meta.is_dir() { 0 } else { meta.len() },
                modified: meta
                    .modified()
                    .ok()
                    .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                    .map(|d| d.as_millis() as u64)
                    .unwrap_or(0),
                name,
            });
        }
        out.sort_by(|a, b| {
            b.is_dir
                .cmp(&a.is_dir)
                .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
        });
        Ok(out)
    })
    .await
    .s()?
}

#[derive(Serialize)]
// rename_all only renames the variants; the fields need rename_all_fields (data_url -> dataUrl)
#[serde(rename_all = "camelCase", rename_all_fields = "camelCase", tag = "kind")]
pub enum Preview {
    Text { text: String, size: u64, truncated: bool },
    Image { data_url: String, size: u64 },
    Binary { size: u64, head: String },
    Directory,
}

fn image_mime(ext: &str) -> Option<&'static str> {
    Some(match ext {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "bmp" => "image/bmp",
        "svg" => "image/svg+xml",
        "ico" => "image/x-icon",
        "avif" => "image/avif",
        _ => return None,
    })
}

#[tauri::command]
pub async fn fs_preview(path: String, max_bytes: Option<u64>) -> Result<Preview, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let p = PathBuf::from(&path);
        let meta = fs::metadata(&p).s()?;
        if meta.is_dir() {
            return Ok(Preview::Directory);
        }
        let size = meta.len();
        let ext = p
            .extension()
            .and_then(|e| e.to_str())
            .map(|e| e.to_ascii_lowercase())
            .unwrap_or_default();
        // SVG is rendered as an <img>, so scripts inside it never run.
        if let Some(mime) = image_mime(&ext) {
            if size <= 25 * 1024 * 1024 {
                let bytes = fs::read(&p).s()?;
                let b64 = base64::engine::general_purpose::STANDARD.encode(bytes);
                return Ok(Preview::Image { data_url: format!("data:{mime};base64,{b64}"), size });
            }
        }
        let max = max_bytes.unwrap_or(512 * 1024).min(8 * 1024 * 1024);
        let mut buf = Vec::new();
        fs::File::open(&p).s()?.take(max).read_to_end(&mut buf).s()?;
        // UTF-16 with a BOM (PowerShell 5 redirection, .reg exports) is text despite all its NULs
        let utf16 = match buf.get(..2) {
            Some(&[0xFF, 0xFE]) => Some(u16::from_le_bytes as fn([u8; 2]) -> u16),
            Some(&[0xFE, 0xFF]) => Some(u16::from_be_bytes as fn([u8; 2]) -> u16),
            _ => None,
        };
        if let Some(unit) = utf16 {
            let units: Vec<u16> = buf[2..].chunks_exact(2).map(|c| unit([c[0], c[1]])).collect();
            return Ok(Preview::Text { text: String::from_utf16_lossy(&units), size, truncated: size > max });
        }
        let sniff = &buf[..buf.len().min(8192)];
        if sniff.contains(&0) {
            let head = buf
                .iter()
                .take(512)
                .map(|b| format!("{b:02x}"))
                .collect::<Vec<_>>()
                .chunks(16)
                .map(|c| c.join(" "))
                .collect::<Vec<_>>()
                .join("\n");
            return Ok(Preview::Binary { size, head });
        }
        Ok(Preview::Text {
            text: String::from_utf8_lossy(&buf).into_owned(),
            size,
            truncated: size > max,
        })
    })
    .await
    .s()?
}

#[tauri::command]
pub fn fs_home() -> String {
    std::env::var("USERPROFILE").unwrap_or_else(|_| "C:\\".into())
}

#[tauri::command]
pub async fn fs_drives() -> Result<Vec<String>, String> {
    blocking(|| {
        (b'A'..=b'Z')
            .map(|c| format!("{}:\\", c as char))
            .filter(|d| Path::new(d).exists())
            .collect()
    })
    .await
}

#[tauri::command]
pub async fn fs_is_dir(path: String) -> Result<bool, String> {
    blocking(move || Path::new(&path).is_dir()).await
}

#[tauri::command]
pub async fn fs_read_text(path: String) -> Result<String, String> {
    blocking(move || {
        let meta = fs::metadata(&path).s()?;
        if meta.len() > 10 * 1024 * 1024 {
            return Err("file is larger than 10 MB".into());
        }
        let bytes = fs::read(&path).s()?;
        Ok(String::from_utf8_lossy(&bytes).into_owned())
    })
    .await?
}

#[tauri::command]
pub async fn fs_write_text(path: String, text: String) -> Result<(), String> {
    blocking(move || fs::write(&path, text).s()).await?
}

#[tauri::command]
pub async fn fs_rename(from: String, to: String) -> Result<(), String> {
    blocking(move || {
        // NTFS ignores case, so "a.txt" -> "A.txt" finds itself; that's not a clash
        let same_file = fs::canonicalize(&from).ok().is_some_and(|f| fs::canonicalize(&to).ok() == Some(f));
        if Path::new(&to).exists() && !same_file {
            return Err("a file with that name already exists".into());
        }
        fs::rename(from, to).s()
    })
    .await?
}

#[tauri::command]
pub async fn fs_mkdir(path: String) -> Result<(), String> {
    blocking(move || fs::create_dir(path).s()).await?
}

#[tauri::command]
pub async fn fs_new_file(path: String) -> Result<(), String> {
    blocking(move || fs::OpenOptions::new().write(true).create_new(true).open(path).map(|_| ()).s()).await?
}

/// Delete to the Recycle Bin (never a hard delete).
#[tauri::command]
pub async fn fs_trash(path: String) -> Result<(), String> {
    blocking(move || trash::delete(path).s()).await?
}
