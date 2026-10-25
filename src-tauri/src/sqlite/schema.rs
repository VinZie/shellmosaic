//! What a database contains: the objects in sqlite_master with their columns, indexes
//! and foreign keys. Names are always bound as parameters, never spliced into SQL
//! (except the quoted identifier of `count`).

use rusqlite::types::ValueRef;
use rusqlite::{Connection, Row};
use serde::Serialize;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SchemaObject {
    #[serde(rename = "type")]
    kind: String,
    name: String,
    tbl_name: String,
    sql: Option<String>,
    without_rowid: bool,
    #[serde(rename = "virtual")]
    is_virtual: bool,
    columns: Vec<DbColumn>,
    indexes: Vec<DbIndex>,
    foreign_keys: Vec<DbForeignKey>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DbColumn {
    cid: i64,
    name: String,
    #[serde(rename = "type")]
    decl_type: String,
    not_null: bool,
    default: Option<String>,
    pk: i64,
    hidden: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DbIndex {
    name: String,
    unique: bool,
    origin: String,
    partial: bool,
    columns: Vec<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DbForeignKey {
    id: i64,
    table: String,
    from: String,
    to: Option<String>,
    on_update: String,
    on_delete: String,
}

pub fn read(conn: &Connection) -> rusqlite::Result<Vec<SchemaObject>> {
    let mut stmt = conn.prepare(
        "SELECT type, name, tbl_name, sql FROM main.sqlite_master
         WHERE type IN ('table', 'view', 'index', 'trigger')
         ORDER BY CASE type WHEN 'table' THEN 0 WHEN 'view' THEN 1 WHEN 'index' THEN 2 ELSE 3 END, name COLLATE NOCASE",
    )?;
    let entries = stmt
        .query_map([], |r| Ok((text(r, 0)?.unwrap_or_default(), text(r, 1)?.unwrap_or_default(), text(r, 2)?, text(r, 3)?)))?
        .collect::<rusqlite::Result<Vec<_>>>()?;

    let mut out = Vec::new();
    for (kind, name, tbl_name, sql) in entries {
        if internal(&name) {
            continue;
        }
        let table = kind == "table";
        let is_virtual = table && sql.as_deref().is_some_and(creates_virtual);
        // a failure here (a virtual table whose module isn't available, a view over a
        // missing table) leaves that object's lists empty instead of failing the schema
        let columns = if table || kind == "view" { columns(conn, &name).unwrap_or_default() } else { Vec::new() };
        let (indexes, foreign_keys) = if table {
            (indexes(conn, &name).unwrap_or_default(), foreign_keys(conn, &name).unwrap_or_default())
        } else {
            (Vec::new(), Vec::new())
        };
        out.push(SchemaObject {
            without_rowid: table && !is_virtual && sql.as_deref().is_some_and(without_rowid),
            is_virtual,
            tbl_name: tbl_name.unwrap_or_else(|| name.clone()),
            kind,
            name,
            sql,
            columns,
            indexes,
            foreign_keys,
        });
    }
    Ok(out)
}

/// Rows in a table or view; `None` when there is no such table or view.
pub fn count(conn: &Connection, table: &str) -> rusqlite::Result<Option<u64>> {
    let exists: bool = conn.query_row(
        "SELECT EXISTS (SELECT 1 FROM main.sqlite_master WHERE type IN ('table', 'view') AND name = ?1)",
        [table],
        |r| r.get(0),
    )?;
    if !exists {
        return Ok(None);
    }
    let n: i64 = conn.query_row(&format!("SELECT count(*) FROM main.{}", quote(table)), [], |r| r.get(0))?;
    Ok(Some(n.max(0) as u64))
}

/// `"name"` with inner quotes doubled.
fn quote(name: &str) -> String {
    format!("\"{}\"", name.replace('"', "\"\""))
}

/// SQLite's own objects, except the two worth seeing: AUTOINCREMENT counters and ANALYZE statistics.
fn internal(name: &str) -> bool {
    name.get(..7).is_some_and(|p| p.eq_ignore_ascii_case("sqlite_"))
        && !name.eq_ignore_ascii_case("sqlite_sequence")
        && !name.eq_ignore_ascii_case("sqlite_stat1")
}

fn creates_virtual(sql: &str) -> bool {
    let mut words = sql.split_whitespace();
    ["create", "virtual", "table"].iter().all(|w| words.next().is_some_and(|x| x.eq_ignore_ascii_case(w)))
}

/// `WITHOUT ROWID` among the table options after the column list's closing parenthesis.
fn without_rowid(sql: &str) -> bool {
    let Some(close) = sql.rfind(')') else { return false };
    let words: Vec<&str> = sql[close + 1..].split(|c: char| !c.is_ascii_alphanumeric() && c != '_').filter(|w| !w.is_empty()).collect();
    words.windows(2).any(|w| w[0].eq_ignore_ascii_case("without") && w[1].eq_ignore_ascii_case("rowid"))
}

fn columns(conn: &Connection, table: &str) -> rusqlite::Result<Vec<DbColumn>> {
    let mut stmt = conn.prepare_cached(
        r#"SELECT cid, name, type, "notnull", dflt_value, pk, hidden FROM pragma_table_xinfo(?1, 'main') ORDER BY cid"#,
    )?;
    let rows = stmt.query_map([table], |r| {
        Ok(DbColumn {
            cid: r.get(0)?,
            name: text(r, 1)?.unwrap_or_default(),
            decl_type: text(r, 2)?.unwrap_or_default(),
            not_null: r.get::<_, i64>(3)? != 0,
            default: text(r, 4)?,
            pk: r.get(5)?,
            hidden: r.get(6)?,
        })
    })?;
    rows.collect()
}

fn indexes(conn: &Connection, table: &str) -> rusqlite::Result<Vec<DbIndex>> {
    let mut list =
        conn.prepare_cached(r#"SELECT name, "unique", origin, partial FROM pragma_index_list(?1, 'main') ORDER BY seq"#)?;
    let found = list
        .query_map([table], |r| {
            Ok(DbIndex {
                name: text(r, 0)?.unwrap_or_default(),
                unique: r.get::<_, i64>(1)? != 0,
                origin: text(r, 2)?.unwrap_or_default(),
                partial: r.get::<_, i64>(3)? != 0,
                columns: Vec::new(),
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let mut info = conn.prepare_cached("SELECT cid, name FROM pragma_index_info(?1, 'main') ORDER BY seqno")?;
    found
        .into_iter()
        .map(|mut idx| {
            idx.columns = info
                .query_map([&idx.name], |r| {
                    Ok(match (r.get::<_, i64>(0)?, text(r, 1)?) {
                        (_, Some(name)) => name,
                        (-1, None) => "rowid".to_string(),
                        _ => "(expression)".to_string(),
                    })
                })?
                .collect::<rusqlite::Result<_>>()?;
            Ok(idx)
        })
        .collect()
}

fn foreign_keys(conn: &Connection, table: &str) -> rusqlite::Result<Vec<DbForeignKey>> {
    let mut stmt = conn.prepare_cached(
        r#"SELECT id, "table", "from", "to", on_update, on_delete FROM pragma_foreign_key_list(?1, 'main') ORDER BY id, seq"#,
    )?;
    let rows = stmt.query_map([table], |r| {
        Ok(DbForeignKey {
            id: r.get(0)?,
            table: text(r, 1)?.unwrap_or_default(),
            from: text(r, 2)?.unwrap_or_default(),
            to: text(r, 3)?,
            on_update: text(r, 4)?.unwrap_or_default(),
            on_delete: text(r, 5)?.unwrap_or_default(),
        })
    })?;
    rows.collect()
}

/// A column as text, whatever its type (SQLite doesn't check that text is valid UTF-8).
fn text(r: &Row<'_>, i: usize) -> rusqlite::Result<Option<String>> {
    Ok(match r.get_ref(i)? {
        ValueRef::Null => None,
        ValueRef::Integer(n) => Some(n.to_string()),
        ValueRef::Real(f) => Some(f.to_string()),
        ValueRef::Text(b) | ValueRef::Blob(b) => Some(String::from_utf8_lossy(b).into_owned()),
    })
}
