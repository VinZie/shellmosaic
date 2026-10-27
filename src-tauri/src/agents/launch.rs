//! How an agent's Claude Code session starts: the command line, the environment, and the
//! files Claude Code reads — the MCP config (the shim), the settings (hooks, statusLine,
//! deny rules, quiet UI) and the role prompt.
//!
//! No secret is written to disk: the files only name the shim, which finds Shellmosaic
//! through the environment the session was started with.

use std::path::{Path, PathBuf};

use serde_json::{json, Map, Value};

use super::proto::{Agent, Role};
use crate::paths::write_atomic;

/// What to run in the agent's terminal.
#[derive(Clone, Debug)]
pub struct Launch {
    pub program: String,
    pub args: Vec<String>,
    pub env: Vec<(String, String)>,
    pub cwd: String,
    pub cols: u16,
    pub rows: u16,
}

pub struct Files {
    pub mcp: PathBuf,
    pub settings: PathBuf,
    pub role: PathBuf,
}

/// Hook events and their timeouts in seconds. A permission request waits for the user
/// (here or in the pane), so its hook may take long; the pane's own dialog stays usable.
const HOOKS: &[(&str, u32)] = &[
    ("SessionStart", 15),
    ("SessionEnd", 5),
    ("UserPromptSubmit", 10),
    ("Stop", 15),
    ("Notification", 10),
    ("PermissionRequest", 3600),
    ("PostToolUse", 10),
];

/// Never allowed, whatever the agent or the user's own rules say (deny rules win in every mode).
const DENY: &[&str] = &[
    "Bash(git push)",
    "Bash(git push *)",
    "PowerShell(git push*)",
    "Read(~/.claude/.credentials.json)",
    "Edit(~/.claude/**)",
    "Edit(~/.claude.json)",
    "Read(~/.ssh/**)",
    "Edit(~/.ssh/**)",
];

/// Push URLs git rewrites to a scheme that doesn't exist, so a push fails even when it
/// slips past the deny rules (a script, an alias). Best effort.
const NO_PUSH_PREFIXES: &[&str] = &["https://", "http://", "ssh://", "git://", "git@", "file://"];

fn settings(shim: &Path) -> Value {
    let shim = shim.to_string_lossy();
    let mut hooks = Map::new();
    for (event, timeout) in HOOKS {
        // exec form (args set): no shell in between, nothing for it to reinterpret
        hooks.insert(
            (*event).into(),
            json!([{ "hooks": [{ "type": "command", "command": shim, "args": ["hook", event], "timeout": timeout }] }]),
        );
    }
    json!({
        "hooks": hooks,
        // statusLine has no exec form: a quoted path with forward slashes reads the same in every shell
        "statusLine": { "type": "command", "command": format!("\"{}\" status", shim.replace('\\', "/")), "padding": 0 },
        "permissions": { "allow": ["mcp__shellmosaic"], "deny": DENY },
        // an agent's pane is read by the user and by the lead: no ghost text, tips or recaps
        "promptSuggestionEnabled": false,
        "spinnerTipsEnabled": false,
        "awaySummaryEnabled": false,
        "feedbackSurveyRate": 0,
        // other Claude Code sessions don't get to message an agent
        "crossSessionInbound": "refuse",
    })
}

fn mcp_config(shim: &Path) -> Value {
    json!({ "mcpServers": { "shellmosaic": { "type": "stdio", "command": shim.to_string_lossy(), "args": ["mcp"] } } })
}

/// Write the agent's files into `dir` (its own folder under the app's data).
pub fn write_files(dir: &Path, shim: &Path, role_text: &str) -> Result<Files, String> {
    std::fs::create_dir_all(dir).map_err(|e| format!("Couldn't create {}: {e}", dir.display()))?;
    let files = Files { mcp: dir.join("mcp.json"), settings: dir.join("settings.json"), role: dir.join("role.md") };
    let write = |p: &Path, data: &[u8]| write_atomic(p, data).map_err(|e| format!("Couldn't write {}: {e}", p.display()));
    write(&files.mcp, serde_json::to_string_pretty(&mcp_config(shim)).unwrap_or_default().as_bytes())?;
    write(&files.settings, serde_json::to_string_pretty(&settings(shim)).unwrap_or_default().as_bytes())?;
    write(&files.role, role_text.as_bytes())?;
    Ok(files)
}

/// Claude Code's command line. `resume`: continue the agent's session (its transcript exists).
pub fn args(agent: &Agent, files: &Files, resume: bool) -> Vec<String> {
    let mut a: Vec<String> = vec!["--model".into(), agent.model.clone(), "--effort".into(), agent.effort.clone()];
    if resume {
        a.extend(["--resume".into(), agent.session_id.clone()]);
    } else {
        a.extend(["--session-id".into(), agent.session_id.clone()]);
    }
    let path = |p: &Path| p.to_string_lossy().into_owned();
    a.extend([
        "--mcp-config".into(),
        path(&files.mcp),
        "--strict-mcp-config".into(),
        "--settings".into(),
        path(&files.settings),
        "--append-system-prompt-file".into(),
        path(&files.role),
        "--permission-mode".into(),
        "acceptEdits".into(),
        "-n".into(),
        agent.name.clone(),
    ]);
    if agent.role == Role::Worker {
        // a worker asks the lead (ask_lead), not the user in a dialog nobody may be watching
        a.extend(["--disallowedTools".into(), "AskUserQuestion".into()]);
    }
    a
}

/// The agent's environment: `base` (the user's fresh environment) minus anything from a
/// Claude Code session Shellmosaic itself may have been started from, plus what the shim
/// and the guards need.
pub fn env(base: Vec<(String, String)>, agent: &Agent, pipe: &str, token: &str, target_dir: Option<&Path>) -> Vec<(String, String)> {
    let mut env: Vec<(String, String)> = base
        .into_iter()
        .filter(|(k, _)| {
            let k = k.to_ascii_uppercase();
            !(k == "CLAUDECODE" || k.starts_with("CLAUDE_CODE_") || k == "CLAUDE_PID" || k.starts_with("SHELLMOSAIC_") || k.starts_with("GIT_CONFIG_"))
        })
        .collect();
    let mut set = |k: &str, v: String| env.push((k.to_string(), v));
    set("SHELLMOSAIC_PIPE", pipe.to_string());
    set("SHELLMOSAIC_AGENT_ID", agent.id.clone());
    set("SHELLMOSAIC_AGENT_TOKEN", token.to_string());
    set("GIT_TERMINAL_PROMPT", "0".into());
    set("GIT_CONFIG_COUNT", NO_PUSH_PREFIXES.len().to_string());
    for (i, prefix) in NO_PUSH_PREFIXES.iter().enumerate() {
        set(&format!("GIT_CONFIG_KEY_{i}"), "url.shellmosaic-no-push:/.pushInsteadOf".into());
        set(&format!("GIT_CONFIG_VALUE_{i}"), prefix.to_string());
    }
    if agent.role == Role::Lead {
        // `wait` can take minutes: keep it in the foreground instead of Claude Code's background tasks
        set("CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS", "0".into());
    }
    if let Some(dir) = target_dir {
        // a worker's builds go to its own folder, never the repo's target (exes may run from there)
        set("CARGO_TARGET_DIR", dir.to_string_lossy().into_owned());
    }
    env
}

/// The native Claude Code (`claude.exe`) on PATH or where its installer puts it.
pub fn find_claude(env: &[(String, String)], home: Option<&Path>) -> Result<String, String> {
    let lookup = |key: &str| env.iter().find(|(k, _)| k.eq_ignore_ascii_case(key)).map(|(_, v)| v.as_str());
    let mut candidates: Vec<PathBuf> = lookup("PATH")
        .unwrap_or("")
        .split(';')
        .filter(|d| !d.trim().is_empty())
        .map(|d| Path::new(d.trim().trim_matches('"')).join("claude.exe"))
        .collect();
    if let Some(h) = home {
        candidates.push(h.join(".local").join("bin").join("claude.exe"));
    }
    if let Some(p) = candidates.into_iter().find(|p| p.is_file()) {
        return Ok(p.to_string_lossy().into_owned());
    }
    Err("Claude Code isn't installed (no claude.exe on PATH or in ~/.local/bin). Install the native build \
         (`irm https://claude.ai/install.ps1 | iex`, or `claude install` from an npm install), sign in once, then try again."
        .into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agents::proto::AgentState;

    fn agent(role: Role) -> Agent {
        Agent {
            id: "a1".into(),
            run_id: "r".into(),
            role,
            slot: "w1".into(),
            name: "Worker 1".into(),
            pane_id: "p".into(),
            model: "sonnet".into(),
            model_id: None,
            effort: "medium".into(),
            session_id: "00000000-0000-4000-8000-000000000000".into(),
            transcript: None,
            state: AgentState::Starting,
            state_since: 0,
            task_id: None,
            last_task_id: None,
            used: false,
            cwd: "C:\\r".into(),
            branch: None,
            context_pct: None,
            cost_usd: None,
            pid: None,
            last_message: None,
            created_at: 0,
        }
    }

    #[test]
    fn worker_args_and_env() {
        let f = Files { mcp: "m.json".into(), settings: "s.json".into(), role: "r.md".into() };
        let a = args(&agent(Role::Worker), &f, false);
        assert!(a.windows(2).any(|w| w[0] == "--session-id"));
        assert!(a.contains(&"AskUserQuestion".to_string()));
        let a = args(&agent(Role::Lead), &f, true);
        assert!(a.windows(2).any(|w| w[0] == "--resume"));
        assert!(!a.contains(&"AskUserQuestion".to_string()));

        let base = vec![("PATH".into(), "x".into()), ("CLAUDECODE".into(), "1".into()), ("CLAUDE_CODE_SESSION_ID".into(), "s".into())];
        let e = env(base, &agent(Role::Lead), "pipe", "tok", None);
        assert!(!e.iter().any(|(k, _)| k == "CLAUDECODE" || k == "CLAUDE_CODE_SESSION_ID"));
        assert!(e.iter().any(|(k, v)| k == "CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS" && v == "0"));
        assert!(e.iter().any(|(k, v)| k == "GIT_CONFIG_VALUE_0" && v == "https://"));
    }

    #[test]
    fn settings_use_exec_form_hooks() {
        let s = settings(Path::new("C:\\Program Files\\Shellmosaic\\shellmosaic-agent.exe"));
        let h = &s["hooks"]["PermissionRequest"][0]["hooks"][0];
        assert_eq!(h["args"][1], "PermissionRequest");
        assert_eq!(s["statusLine"]["command"], "\"C:/Program Files/Shellmosaic/shellmosaic-agent.exe\" status");
    }
}
