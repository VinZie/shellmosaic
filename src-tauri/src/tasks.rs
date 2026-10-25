//! Detect runnable tasks in a folder: package scripts, cargo, make, just, compose, scripts.

use std::fs;
use std::path::Path;

use serde::Serialize;
use serde_json::Value;

use crate::paths::ErrStr;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Task {
    name: String,
    command: String,
    detail: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskGroup {
    source: String,
    file: String,
    icon: String,
    tasks: Vec<Task>,
}

/// Task names come from files in the folder (package.json keys, make targets) and are
/// typed into a shell as part of the command: a name like "test\rcalc" would run calc.
fn safe_name(name: &str) -> bool {
    !name.is_empty() && name.len() <= 100 && name.chars().all(|c| c.is_ascii_alphanumeric() || "-_.:@/+=".contains(c))
}

fn task(name: &str, command: String, detail: Option<String>) -> Task {
    Task { name: name.to_string(), command, detail }
}

fn node_runner(dir: &Path) -> &'static str {
    if dir.join("pnpm-lock.yaml").exists() {
        "pnpm"
    } else if dir.join("yarn.lock").exists() {
        "yarn"
    } else if dir.join("bun.lockb").exists() || dir.join("bun.lock").exists() {
        "bun"
    } else {
        "npm"
    }
}

fn package_json(dir: &Path) -> Option<TaskGroup> {
    let path = dir.join("package.json");
    let v: Value = serde_json::from_slice(&fs::read(&path).ok()?).ok()?;
    let runner = node_runner(dir);
    let mut tasks = vec![task("install", format!("{runner} install"), None)];
    if let Some(scripts) = v.get("scripts").and_then(Value::as_object) {
        for (name, cmd) in scripts.iter().filter(|(n, _)| safe_name(n)) {
            tasks.push(task(name, format!("{runner} run {name}"), cmd.as_str().map(str::to_string)));
        }
    }
    Some(TaskGroup { source: format!("{runner} scripts"), file: path.to_string_lossy().into(), icon: "package".into(), tasks })
}

fn cargo(dir: &Path) -> Option<TaskGroup> {
    let path = dir.join("Cargo.toml");
    if !path.exists() {
        return None;
    }
    let tasks = [
        ("build", "cargo build"),
        ("run", "cargo run"),
        ("test", "cargo test"),
        ("check", "cargo check"),
        ("clippy", "cargo clippy"),
        ("fmt", "cargo fmt"),
        ("build --release", "cargo build --release"),
    ]
    .iter()
    .map(|(n, c)| task(n, c.to_string(), None))
    .collect();
    Some(TaskGroup { source: "cargo".into(), file: path.to_string_lossy().into(), icon: "box".into(), tasks })
}

fn makefile(dir: &Path) -> Option<TaskGroup> {
    let path = ["Makefile", "makefile", "GNUmakefile"].iter().map(|f| dir.join(f)).find(|p| p.exists())?;
    let text = fs::read_to_string(&path).ok()?;
    let mut seen = std::collections::HashSet::new();
    let tasks = text
        .lines()
        .filter(|l| !l.starts_with(['\t', ' ', '#', '.']))
        .filter_map(|l| {
            let (name, rest) = l.split_once(':')?;
            if rest.starts_with('=') || name.contains(['$', '%', '=', ' ']) || name.is_empty() {
                return None;
            }
            Some(name.trim().to_string())
        })
        .filter(|n| seen.insert(n.clone()))
        .filter(|n| safe_name(n))
        .map(|n| task(&n, format!("make {n}"), None))
        .collect::<Vec<_>>();
    (!tasks.is_empty()).then(|| TaskGroup { source: "make".into(), file: path.to_string_lossy().into(), icon: "hammer".into(), tasks })
}

fn justfile(dir: &Path) -> Option<TaskGroup> {
    let path = ["justfile", "Justfile", ".justfile"].iter().map(|f| dir.join(f)).find(|p| p.exists())?;
    let text = fs::read_to_string(&path).ok()?;
    let tasks = text
        .lines()
        .filter(|l| !l.starts_with([' ', '\t', '#', '[']) && !l.starts_with("set ") && !l.starts_with("alias ") && !l.starts_with("import ") && !l.starts_with("mod "))
        .filter_map(|l| {
            let (head, rest) = l.split_once(':')?;
            if rest.starts_with('=') {
                return None;
            }
            let name = head.split_whitespace().next()?.trim_start_matches('@');
            name.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_').then(|| name.to_string())
        })
        .map(|n| task(&n, format!("just {n}"), None))
        .collect::<Vec<_>>();
    (!tasks.is_empty()).then(|| TaskGroup { source: "just".into(), file: path.to_string_lossy().into(), icon: "list-checks".into(), tasks })
}

fn compose(dir: &Path) -> Option<TaskGroup> {
    let path = ["compose.yaml", "compose.yml", "docker-compose.yml", "docker-compose.yaml"]
        .iter()
        .map(|f| dir.join(f))
        .find(|p| p.exists())?;
    let tasks = [
        ("up", "docker compose up -d"),
        ("down", "docker compose down"),
        ("logs", "docker compose logs -f --tail=200"),
        ("ps", "docker compose ps"),
        ("build", "docker compose build"),
    ]
    .iter()
    .map(|(n, c)| task(n, c.to_string(), None))
    .collect();
    Some(TaskGroup { source: "docker compose".into(), file: path.to_string_lossy().into(), icon: "container".into(), tasks })
}

fn gomod(dir: &Path) -> Option<TaskGroup> {
    let path = dir.join("go.mod");
    if !path.exists() {
        return None;
    }
    let tasks = [("build", "go build ./..."), ("run", "go run ."), ("test", "go test ./..."), ("vet", "go vet ./..."), ("tidy", "go mod tidy")]
        .iter()
        .map(|(n, c)| task(n, c.to_string(), None))
        .collect();
    Some(TaskGroup { source: "go".into(), file: path.to_string_lossy().into(), icon: "box".into(), tasks })
}

fn scripts(dir: &Path) -> Option<TaskGroup> {
    let mut tasks = Vec::new();
    for e in fs::read_dir(dir).ok()?.flatten() {
        let name = e.file_name().to_string_lossy().into_owned();
        let lower = name.to_ascii_lowercase();
        if e.path().is_file() && [".ps1", ".bat", ".cmd", ".sh", ".py"].iter().any(|x| lower.ends_with(x)) {
            // PowerShell spelling, shown in the list (the pane re-spells it for the shell that runs it);
            // single quotes keep $ and ` in a file name literal
            let q = name.replace('\'', "''");
            let cmd = if lower.ends_with(".py") {
                format!("python '{q}'")
            } else if lower.ends_with(".sh") {
                format!("bash './{q}'")
            } else {
                format!("& '.\\{q}'")
            };
            tasks.push(task(&name, cmd, None));
        }
    }
    tasks.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    (!tasks.is_empty()).then(|| TaskGroup { source: "scripts".into(), file: dir.to_string_lossy().into(), icon: "file-code".into(), tasks })
}

#[tauri::command]
pub async fn tasks_detect(cwd: String) -> Result<Vec<TaskGroup>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let dir = Path::new(&cwd);
        if !dir.is_dir() {
            return Err("not a directory".to_string());
        }
        Ok([package_json(dir), cargo(dir), gomod(dir), makefile(dir), justfile(dir), compose(dir), scripts(dir)]
            .into_iter()
            .flatten()
            .collect())
    })
    .await
    .s()?
}
