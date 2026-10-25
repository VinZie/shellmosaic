//! Open databases: read-only unless asked otherwise, from a temporary copy when the
//! file is locked by another program (or a copy is asked for).

use std::collections::HashMap;
use std::fs;
use std::io::{self, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::Arc;
use std::time::Duration;

use parking_lot::Mutex;
use rusqlite::hooks::{AuthAction, AuthContext, Authorization};
use rusqlite::{ffi, Connection, ErrorCode, InterruptHandle, OpenFlags};
use serde::Serialize;
use serde_json::Value;

use super::query::{self, QueryResult};
use super::schema::{self, SchemaObject};
use crate::winutil::is_local_path;

/// Databases one pane may have open at once.
const MAX_PER_OWNER: usize = 8;
const NOT_OPEN: &str = "This database isn't open.";
const NOT_LOCAL: &str = "Only files on this computer can be opened.";
const NOT_A_DB: &str = "This isn't a SQLite database (or it's encrypted).";
const IN_USE: &str = "The database is in use by another program, so a copy is open.";
const ASKED: &str = "Opened a copy as asked; the original isn't touched.";
const LOCKED: &str = "The database is locked by another program and can't be copied either.";
const READ_ONLY_FILE: &str = "Windows doesn't allow changes to this file (it's read-only, or you lack permission).";
pub(super) const CANCELLED: &str = "Query cancelled.";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DbInfo {
    id: u32,
    path: String,
    file: String,
    copied: bool,
    copy_reason: Option<&'static str>,
    writable: bool,
    size: u64,
    sqlite_version: &'static str,
    page_size: i64,
    page_count: i64,
    encoding: String,
    journal_mode: String,
    user_version: i64,
    application_id: i64,
    freelist_count: i64,
}

/// A connection and the mode it was opened in.
struct Conn {
    db: Connection,
    writable: bool,
}

struct Db {
    owner: String,
    /// what the user opened
    path: String,
    /// what is actually open: the copy, when it's a copy
    opened: PathBuf,
    copy_reason: Option<&'static str>,
    conn: Mutex<Conn>,
    /// stops the running statement without waiting for `conn`, which it holds
    interrupt: Mutex<InterruptHandle>,
    /// set by an interrupt, checked between statements (an interrupt only stops a running one)
    cancelled: AtomicBool,
    // after `conn`: fields drop in order, and Windows can't delete files that are still open
    temp: Option<TempDir>,
}

/// The databases open in every pane.
#[derive(Default)]
pub struct Sqlite {
    dbs: Mutex<HashMap<u32, Arc<Db>>>,
    next: AtomicU32,
}

impl Sqlite {
    fn get(&self, owner: &str, id: u32) -> Result<Arc<Db>, String> {
        self.dbs.lock().get(&id).filter(|d| d.owner == owner).cloned().ok_or_else(|| NOT_OPEN.to_string())
    }

    fn open_count(&self, owner: &str) -> usize {
        self.dbs.lock().values().filter(|d| d.owner == owner).count()
    }

    pub fn open(&self, owner: &str, path: &str, writable: bool, copy: bool) -> Result<DbInfo, String> {
        if !is_local_path(path) {
            return Err(NOT_LOCAL.into());
        }
        match fs::metadata(path) {
            Ok(m) if m.is_dir() => return Err("That's a folder, not a database file.".into()),
            Ok(_) => {}
            Err(e) if e.kind() == io::ErrorKind::NotFound => return Err("The file doesn't exist.".into()),
            Err(e) => return Err(format!("Couldn't read the file: {}", io_text(&e))),
        }
        let too_many = || format!("A pane can have at most {MAX_PER_OWNER} databases open. Close one first.");
        if self.open_count(owner) >= MAX_PER_OWNER {
            return Err(too_many());
        }

        let original = Path::new(path);
        let (conn, opened, temp, copy_reason) = if copy {
            open_copy(original, writable, ASKED)?
        } else {
            match connect(original, writable) {
                Ok(c) => (c, original.to_path_buf(), None, None),
                Err(e) if in_use(&e, writable) => open_copy(original, writable, IN_USE)?,
                Err(e) => return Err(describe(&e, writable)),
            }
        };
        let db = Arc::new(Db {
            owner: owner.to_string(),
            path: path.to_string(),
            opened,
            copy_reason,
            interrupt: Mutex::new(conn.get_interrupt_handle()),
            conn: Mutex::new(Conn { db: conn, writable }),
            cancelled: AtomicBool::new(false),
            temp,
        });

        let id = self.next.fetch_add(1, Ordering::Relaxed) + 1;
        let info = db.info(id, &db.conn.lock())?;
        {
            let mut dbs = self.dbs.lock();
            // checked again: another open of the same pane may have finished meanwhile
            if dbs.values().filter(|d| d.owner == owner).count() >= MAX_PER_OWNER {
                return Err(too_many());
            }
            dbs.insert(id, db);
        }
        Ok(info)
    }

    pub fn schema(&self, owner: &str, id: u32) -> Result<Vec<SchemaObject>, String> {
        let db = self.get(owner, id)?;
        let c = db.conn.lock();
        schema::read(&c.db).map_err(|e| describe(&e, c.writable))
    }

    pub fn count(&self, owner: &str, id: u32, table: &str) -> Result<u64, String> {
        let db = self.get(owner, id)?;
        let c = db.conn.lock();
        match schema::count(&c.db, table) {
            Ok(Some(n)) => Ok(n),
            Ok(None) => Err(format!("There's no table named \"{table}\".")),
            Err(e) => Err(describe(&e, c.writable)),
        }
    }

    pub fn query(&self, owner: &str, id: u32, sql: &str, params: &[Value], max_rows: Option<u32>) -> Result<QueryResult, String> {
        let db = self.get(owner, id)?;
        let params = query::params(params)?;
        // before waiting for the connection: a cancel sent meanwhile is for this query
        db.cancelled.store(false, Ordering::Relaxed);
        let c = db.conn.lock();
        query::run(&c.db, sql, &params, max_rows, &db.cancelled, c.writable)
    }

    /// Reopen the database (the copy, if it's a copy) read-write or read-only.
    pub fn set_writable(&self, owner: &str, id: u32, writable: bool) -> Result<DbInfo, String> {
        let db = self.get(owner, id)?;
        let mut c = db.conn.lock();
        if c.writable != writable {
            if !c.db.is_autocommit() {
                return Err("A transaction is still open. COMMIT or ROLLBACK it first.".into());
            }
            let fresh = connect(&db.opened, writable).map_err(|e| describe(&e, writable))?;
            *db.interrupt.lock() = fresh.get_interrupt_handle();
            *c = Conn { db: fresh, writable };
        }
        db.info(id, &c)
    }

    pub fn interrupt(&self, owner: &str, id: u32) -> Result<(), String> {
        let db = self.get(owner, id)?;
        db.cancelled.store(true, Ordering::Relaxed);
        db.interrupt.lock().interrupt();
        Ok(())
    }

    pub fn close(&self, owner: &str, id: u32) -> Result<(), String> {
        let db = self.get(owner, id)?;
        self.dbs.lock().remove(&id);
        // a running query keeps its Arc: it stops now, and the last one out closes the file
        db.cancelled.store(true, Ordering::Relaxed);
        db.interrupt.lock().interrupt();
        Ok(())
    }

    /// Close every database of a pane (closed, reloaded or moved).
    pub fn release(&self, owner: &str) {
        let mut gone = Vec::new();
        self.dbs.lock().retain(|_, d| {
            if d.owner == owner {
                gone.push(d.clone());
            }
            d.owner != owner
        });
        for db in gone {
            db.cancelled.store(true, Ordering::Relaxed);
            db.interrupt.lock().interrupt();
        }
    }
}

impl Db {
    fn info(&self, id: u32, c: &Conn) -> Result<DbInfo, String> {
        let int = |sql: &str| c.db.query_row(sql, [], |r| r.get::<_, i64>(0)).map_err(|e| describe(&e, c.writable));
        let text = |sql: &str| c.db.query_row(sql, [], |r| r.get::<_, String>(0)).map_err(|e| describe(&e, c.writable));
        Ok(DbInfo {
            id,
            path: self.path.clone(),
            file: Path::new(&self.path).file_name().map(|f| f.to_string_lossy().into_owned()).unwrap_or_default(),
            copied: self.temp.is_some(),
            copy_reason: self.copy_reason,
            writable: c.writable,
            size: fs::metadata(&self.opened).map(|m| m.len()).unwrap_or(0),
            sqlite_version: rusqlite::version(),
            page_size: int("PRAGMA main.page_size")?,
            page_count: int("PRAGMA main.page_count")?,
            encoding: text("PRAGMA encoding")?,
            journal_mode: text("PRAGMA main.journal_mode")?,
            user_version: int("PRAGMA main.user_version")?,
            application_id: int("PRAGMA main.application_id")?,
            freelist_count: int("PRAGMA main.freelist_count")?,
        })
    }
}

/// Open `path` and read from it once: locks, damaged files and files that aren't
/// databases only show up on the first read.
fn connect(path: &Path, writable: bool) -> rusqlite::Result<Connection> {
    // no SQLITE_OPEN_CREATE (a missing file is an error) and no URI filenames
    let mode = if writable { OpenFlags::SQLITE_OPEN_READ_WRITE } else { OpenFlags::SQLITE_OPEN_READ_ONLY };
    let mut c = Connection::open_with_flags(path, mode | OpenFlags::SQLITE_OPEN_NO_MUTEX)?;
    c.busy_timeout(Duration::from_millis(if writable { 3000 } else { 1500 }))?;
    c.execute_batch(if writable { "PRAGMA query_only = OFF" } else { "PRAGMA query_only = ON" })?;
    c.authorizer(Some(move |ctx: AuthContext<'_>| authorize(ctx, writable)))?;
    c.query_row("SELECT count(*) FROM main.sqlite_master", [], |_| Ok(()))?;
    // SQLite quietly falls back to read-only when the file can't be written
    // (SQLITE_PERM rather than READONLY: a copy wouldn't help, see `in_use`)
    if writable && c.is_readonly("main")? {
        return Err(rusqlite::Error::SqliteFailure(ffi::Error::new(ffi::SQLITE_PERM), Some(READ_ONLY_FILE.into())));
    }
    Ok(c)
}

/// SQL may attach (and VACUUM INTO, which attaches its output) only local files: a
/// `\\host\share` path would make Windows log in to that host, as opening one would.
fn authorize(ctx: AuthContext<'_>, writable: bool) -> Authorization {
    match ctx.action {
        AuthAction::Attach { filename } if filename.is_empty() || filename == ":memory:" => Authorization::Allow,
        // read-only, only existing files: VACUUM INTO would create its output before
        // query_only stops it from filling it
        AuthAction::Attach { filename } if is_local_path(filename) && (writable || Path::new(filename).is_file()) => {
            Authorization::Allow
        }
        AuthAction::Attach { .. } => Authorization::Deny,
        // ATTACH of a computed file name: nothing to check
        AuthAction::Unknown { code: ffi::SQLITE_ATTACH, .. } => Authorization::Deny,
        AuthAction::Pragma { pragma_name, .. }
            if pragma_name.eq_ignore_ascii_case("temp_store_directory") || pragma_name.eq_ignore_ascii_case("data_store_directory") =>
        {
            Authorization::Deny
        }
        _ => Authorization::Allow,
    }
}

/// The file is held by another program, or (read-only) SQLite can't set up its WAL
/// files next to it: a copy can still be read.
fn in_use(e: &rusqlite::Error, writable: bool) -> bool {
    let Some(err) = e.sqlite_error() else { return false };
    match err.code {
        ErrorCode::DatabaseBusy | ErrorCode::DatabaseLocked | ErrorCode::CannotOpen => true,
        ErrorCode::ReadOnly => !writable,
        ErrorCode::SystemIoFailure => matches!(
            err.extended_code,
            ffi::SQLITE_IOERR_SHMOPEN | ffi::SQLITE_IOERR_SHMSIZE | ffi::SQLITE_IOERR_SHMLOCK | ffi::SQLITE_IOERR_SHMMAP
        ),
        _ => false,
    }
}

type Opened = (Connection, PathBuf, Option<TempDir>, Option<&'static str>);

fn open_copy(original: &Path, writable: bool, reason: &'static str) -> Result<Opened, String> {
    let (temp, copy) = copy_to_temp(original)?;
    // on failure `temp` goes, and the copy with it
    let conn = connect(&copy, writable).map_err(|e| describe(&e, writable))?;
    Ok((conn, copy, Some(temp), Some(reason)))
}

/// A user-facing sentence for a SQLite error.
pub(super) fn describe(e: &rusqlite::Error, writable: bool) -> String {
    let code = match e {
        rusqlite::Error::SqlInputError { error, .. } => Some(error.code),
        _ => e.sqlite_error_code(),
    };
    match code {
        Some(ErrorCode::OperationInterrupted) => CANCELLED.into(),
        Some(ErrorCode::NotADatabase) => NOT_A_DB.into(),
        Some(ErrorCode::ReadOnly) if !writable => "The database is open read-only. Allow changes to edit it.".into(),
        Some(ErrorCode::DatabaseBusy) => "The database is busy: another program is using it. Try again in a moment.".into(),
        Some(ErrorCode::AuthorizationForStatementDenied) if writable => {
            "Not allowed here: SQL can only attach files on this computer (C:\\…).".into()
        }
        Some(ErrorCode::AuthorizationForStatementDenied) => {
            "Not allowed here: SQL can only attach existing files on this computer (C:\\…) while the database is read-only.".into()
        }
        _ => match e {
            // its Display appends the whole SQL text
            rusqlite::Error::SqlInputError { msg, .. } => msg.clone(),
            _ => e.to_string(),
        },
    }
}

// ── temporary copies ────────────────────────────────────────────────────

/// `%TEMP%\shellmosaic-sqlite`, one folder per copy.
fn temp_root() -> PathBuf {
    std::env::temp_dir().join("shellmosaic-sqlite")
}

/// A folder deleted with everything in it when dropped.
struct TempDir(PathBuf);

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

/// Copy the database and its `-wal` file (the `-shm` index is rebuilt from the WAL).
fn copy_to_temp(original: &Path) -> Result<(TempDir, PathBuf), String> {
    let dir = temp_root().join(uuid::Uuid::new_v4().to_string());
    fs::create_dir_all(&dir).map_err(|e| format!("Couldn't create a folder for the copy: {}", io_text(&e)))?;
    let temp = TempDir(dir);
    let copy = temp.0.join(original.file_name().unwrap_or("database".as_ref()));
    copy_file(original, &copy, true).map_err(copy_error)?;
    let wal = with_suffix(original, "-wal");
    if wal.is_file() {
        copy_file(&wal, &with_suffix(&copy, "-wal"), false).map_err(copy_error)?;
    }
    Ok((temp, copy))
}

fn with_suffix(p: &Path, suffix: &str) -> PathBuf {
    let mut s = p.as_os_str().to_owned();
    s.push(suffix);
    PathBuf::from(s)
}

/// The bytes SQLite locks on Windows (PENDING_BYTE up to the end of the SHARED range).
/// Another program's lock there makes reading them fail; SQLite never stores data there.
const LOCK_BYTES: std::ops::Range<u64> = 0x4000_0000..0x4000_0200;

fn copy_file(from: &Path, to: &Path, skip_lock_bytes: bool) -> io::Result<()> {
    // (std opens with read, write and delete sharing: whatever another program allows)
    let mut src = fs::File::open(from)?;
    let mut dst = fs::File::create_new(to)?;
    let len = src.metadata()?.len();
    let mut buf = vec![0u8; 1 << 20];
    let mut pos = 0u64;
    while pos < len {
        if skip_lock_bytes && LOCK_BYTES.contains(&pos) {
            let n = (LOCK_BYTES.end.min(len) - pos) as usize;
            buf[..n].fill(0);
            dst.write_all(&buf[..n])?;
            pos += n as u64;
            src.seek(SeekFrom::Start(pos))?;
            continue;
        }
        let mut want = (len - pos).min(buf.len() as u64);
        if skip_lock_bytes && pos < LOCK_BYTES.start {
            want = want.min(LOCK_BYTES.start - pos);
        }
        let n = src.read(&mut buf[..want as usize])?;
        if n == 0 {
            break; // truncated meanwhile
        }
        dst.write_all(&buf[..n])?;
        pos += n as u64;
    }
    Ok(())
}

fn copy_error(e: io::Error) -> String {
    match e.raw_os_error() {
        // ERROR_SHARING_VIOLATION, ERROR_LOCK_VIOLATION
        Some(32 | 33) => LOCKED.into(),
        Some(5) => "Windows doesn't allow reading this file.".into(),
        // ERROR_HANDLE_DISK_FULL, ERROR_DISK_FULL
        Some(39 | 112) => "There isn't enough free space for a copy of the database.".into(),
        _ => format!("Couldn't copy the database: {}", io_text(&e)),
    }
}

/// "Access is denied. (os error 5)" → "Access is denied."
fn io_text(e: &io::Error) -> String {
    let text = e.to_string();
    match text.rfind(" (os error") {
        Some(i) => text[..i].to_string(),
        None => text,
    }
}

/// Remove copies left behind by a crash (every copy is deleted when its database closes).
pub fn sweep_temp() {
    let Ok(entries) = fs::read_dir(temp_root()) else { return };
    for e in entries.flatten() {
        let old = e
            .metadata()
            .and_then(|m| m.modified())
            .ok()
            .and_then(|t| t.elapsed().ok())
            .is_some_and(|age| age > Duration::from_secs(24 * 3600));
        if old && e.file_type().is_ok_and(|t| t.is_dir()) {
            let _ = fs::remove_dir_all(e.path());
        }
    }
}
