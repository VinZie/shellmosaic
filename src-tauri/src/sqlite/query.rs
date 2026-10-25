//! Running the SQL a user typed: every statement in order, reporting the rows of the
//! last one that returns rows, as api.ts's `Cell`s.

use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Instant;

use rusqlite::fallible_iterator::FallibleIterator;
use rusqlite::types::{Value as SqlValue, ValueRef};
use rusqlite::{Batch, Connection, Statement};
use serde::Serialize;
use serde_json::Value;

use super::db::{describe, CANCELLED};

const MAX_SQL: usize = 1 << 20;
const DEFAULT_ROWS: u32 = 1000;
const MAX_ROWS: u32 = 50_000;
/// Stop collecting rows past roughly this much JSON.
const MAX_JSON: usize = 64 << 20;
/// Longer text is cut (in characters).
const MAX_TEXT: usize = 100_000;
/// Bytes of a blob shown (as hex).
const BLOB_HEAD: usize = 256;
/// Integers beyond ±2^53 lose precision as JS numbers.
const MAX_SAFE: i64 = 1 << 53;

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct QueryResult {
    columns: Vec<ResultColumn>,
    rows: Vec<Vec<Cell>>,
    truncated: bool,
    changes: u64,
    last_insert_rowid: i64,
    elapsed_ms: f64,
    statements: u32,
    returned_rows: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ResultColumn {
    name: String,
    decl_type: Option<String>,
}

/// Plain JSON where it fits, tagged otherwise (see api.ts).
#[derive(Serialize)]
#[serde(untagged)]
enum Cell {
    Null,
    Int(i64),
    Real(f64),
    Text(String),
    BigInt {
        #[serde(rename = "$int")]
        int: String,
    },
    NonFinite {
        #[serde(rename = "$real")]
        real: &'static str,
    },
    LongText {
        #[serde(rename = "$text")]
        text: String,
        length: usize,
    },
    Blob {
        #[serde(rename = "$blob")]
        blob: String,
        length: usize,
    },
}

/// Parameters as api.ts's `Param`: null, booleans (0/1), numbers, text or `{$blob: hex}`.
pub fn params(values: &[Value]) -> Result<Vec<SqlValue>, String> {
    const BAD: &str = "Parameters must be null, true/false, numbers, text or {$blob: \"hex\"}.";
    values
        .iter()
        .map(|v| {
            Ok(match v {
                Value::Null => SqlValue::Null,
                Value::Bool(b) => SqlValue::Integer(i64::from(*b)),
                Value::Number(n) => match n.as_i64() {
                    Some(i) => SqlValue::Integer(i),
                    None => SqlValue::Real(n.as_f64().ok_or(BAD)?),
                },
                Value::String(s) => SqlValue::Text(s.clone()),
                Value::Object(o) if o.len() == 1 => match o.get("$blob") {
                    Some(Value::String(h)) => SqlValue::Blob(unhex(h).ok_or("A {$blob} parameter must be hexadecimal text.")?),
                    _ => return Err(BAD.to_string()),
                },
                _ => return Err(BAD.to_string()),
            })
        })
        .collect()
}

/// Run every statement of `sql` in order. `params` bind to the last statement only.
pub fn run(
    conn: &Connection,
    sql: &str,
    params: &[SqlValue],
    max_rows: Option<u32>,
    cancelled: &AtomicBool,
    writable: bool,
) -> Result<QueryResult, String> {
    if sql.len() > MAX_SQL {
        return Err("The SQL is longer than 1 MB.".into());
    }
    let max_rows = max_rows.unwrap_or(DEFAULT_ROWS).min(MAX_ROWS) as usize;
    let fail = |e: rusqlite::Error| with_position(&e, sql, writable);
    let started = Instant::now();
    let changes_before = conn.total_changes();
    let mut out = QueryResult::default();

    let mut batch = Batch::new(conn, sql);
    // the statement after the current one, prepared early to learn whether the current one is the last
    let mut ahead: Option<rusqlite::Result<Option<Statement<'_>>>> = None;
    loop {
        let next = match ahead.take() {
            Some(Ok(s)) => s,
            // it couldn't be prepared before the one in front of it ran (that may create its
            // table): the batch hasn't moved past it, so this prepares it again
            Some(Err(_)) | None => batch.next().map_err(fail)?,
        };
        let Some(mut stmt) = next else { break };
        if cancelled.load(Ordering::Relaxed) {
            return Err(CANCELLED.into());
        }
        if !params.is_empty() || stmt.parameter_count() > 0 {
            let peek = batch.next();
            // an error means there is a statement, just not one that can be prepared yet
            let last = matches!(peek, Ok(None));
            ahead = Some(peek);
            if last {
                bind(&mut stmt, params)?;
            } else if stmt.parameter_count() > 0 {
                return Err("Only the last statement can use parameters.".into());
            }
        }
        out.statements += 1;
        if stmt.column_count() == 0 {
            let mut rows = stmt.raw_query();
            rows.next().map_err(fail)?;
            continue;
        }
        let (rows, truncated) = collect(&mut stmt, max_rows).map_err(fail)?;
        // read after running: a statement prepared early is re-prepared if the schema changed
        out.columns = stmt
            .columns()
            .map(|c| ResultColumn { name: c.name().to_string(), decl_type: c.decl_type().map(str::to_string) })
            .collect();
        out.rows = rows;
        out.truncated = truncated;
        out.returned_rows = true;
    }

    out.changes = conn.total_changes().saturating_sub(changes_before);
    out.last_insert_rowid = conn.last_insert_rowid();
    out.elapsed_ms = (started.elapsed().as_secs_f64() * 100_000.0).round() / 100.0;
    Ok(out)
}

fn bind(stmt: &mut Statement<'_>, params: &[SqlValue]) -> Result<(), String> {
    let n = stmt.parameter_count();
    if params.len() != n {
        let has = match n {
            0 => "has no parameters".to_string(),
            1 => "has 1 parameter".to_string(),
            _ => format!("has {n} parameters"),
        };
        let given = if params.len() == 1 { "1 value was".to_string() } else { format!("{} values were", params.len()) };
        return Err(format!("The statement {has}, but {given} given."));
    }
    for (i, v) in params.iter().enumerate() {
        stmt.raw_bind_parameter(i + 1, v).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Up to `max_rows` rows (and ~MAX_JSON of them), and whether more were left.
fn collect(stmt: &mut Statement<'_>, max_rows: usize) -> rusqlite::Result<(Vec<Vec<Cell>>, bool)> {
    let mut out = Vec::new();
    let mut size = 0;
    let mut rows = stmt.raw_query();
    while let Some(row) = rows.next()? {
        if out.len() >= max_rows || size > MAX_JSON {
            return Ok((out, true));
        }
        let n = row.as_ref().column_count();
        let mut cells = Vec::with_capacity(n);
        for i in 0..n {
            let (c, bytes) = cell(row.get_ref(i)?);
            size += bytes + 1;
            cells.push(c);
        }
        out.push(cells);
    }
    Ok((out, false))
}

/// A cell and roughly how much JSON it makes.
fn cell(v: ValueRef<'_>) -> (Cell, usize) {
    match v {
        ValueRef::Null => (Cell::Null, 4),
        ValueRef::Integer(i) if (-MAX_SAFE..=MAX_SAFE).contains(&i) => (Cell::Int(i), 20),
        ValueRef::Integer(i) => (Cell::BigInt { int: i.to_string() }, 32),
        ValueRef::Real(f) if f.is_finite() => (Cell::Real(f), 24),
        ValueRef::Real(f) => {
            let real = if f.is_nan() { "NaN" } else if f > 0.0 { "inf" } else { "-inf" };
            (Cell::NonFinite { real }, 16)
        }
        ValueRef::Text(b) => {
            // SQLite doesn't check that text is valid UTF-8
            let s = String::from_utf8_lossy(b);
            // fewer bytes than MAX_TEXT can't be more characters
            let cut = if s.len() > MAX_TEXT { s.char_indices().nth(MAX_TEXT).map(|(i, _)| i) } else { None };
            match cut {
                None => (Cell::Text(s.into_owned()), b.len() + 2),
                Some(i) => {
                    let length = MAX_TEXT + s[i..].chars().count();
                    (Cell::LongText { text: s[..i].to_string(), length }, i + 32)
                }
            }
        }
        ValueRef::Blob(b) => {
            let head = &b[..b.len().min(BLOB_HEAD)];
            (Cell::Blob { blob: hex(head), length: b.len() }, head.len() * 2 + 32)
        }
    }
}

fn hex(bytes: &[u8]) -> String {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        s.push(DIGITS[(b >> 4) as usize] as char);
        s.push(DIGITS[(b & 15) as usize] as char);
    }
    s
}

fn unhex(s: &str) -> Option<Vec<u8>> {
    if s.len() % 2 != 0 {
        return None;
    }
    let digit = |c: u8| (c as char).to_digit(16).map(|d| d as u8);
    s.as_bytes().chunks(2).map(|p| Some((digit(p[0])? << 4) | digit(p[1])?)).collect()
}

/// `describe`, plus where in the SQL a syntax error (or unknown name) is.
fn with_position(e: &rusqlite::Error, sql: &str, writable: bool) -> String {
    let text = describe(e, writable);
    let rusqlite::Error::SqlInputError { sql: rest, offset, .. } = e else { return text };
    // the batch prepares the rest of `sql`, so the offset counts from there
    let at = sql.len().saturating_sub(rest.len()) + usize::try_from(*offset).unwrap_or(0);
    let Some(before) = sql.get(..at) else { return text };
    let line = before.matches('\n').count() + 1;
    let column = before.rsplit('\n').next().map_or(0, |l| l.chars().count()) + 1;
    format!("{text} (line {line}, column {column})")
}
