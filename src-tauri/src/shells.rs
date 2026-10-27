//! Shell profile detection and per-shell integration (working-directory reporting).

use std::collections::HashMap;
use std::env;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::Duration;

use base64::Engine;
use parking_lot::Mutex;
use portable_pty::CommandBuilder;
use serde::{Deserialize, Serialize};

use crate::paths::hidden_command;

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Profile {
    pub id: String,
    pub name: String,
    pub command: String,
    #[serde(default)]
    pub args: Vec<String>,
    /// pwsh | powershell | cmd | bash | wsl | custom
    pub kind: String,
    #[serde(default)]
    pub icon: Option<String>,
    #[serde(default)]
    pub color: Option<String>,
}

/// What the frontend asks us to launch (a resolved profile plus overrides).
#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SpawnSpec {
    pub profile_id: String,
    pub command: String,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default = "default_kind")]
    pub kind: String,
    #[serde(default)]
    pub env: HashMap<String, String>,
    #[serde(default)]
    pub cwd: Option<String>,
    #[serde(default = "yes")]
    pub shell_integration: bool,
    #[serde(default = "yes")]
    pub restore: bool,
    /// start from the user's default environment instead of Shellmosaic's own
    #[serde(default = "yes")]
    pub fresh_env: bool,
    /// a saved SSH host's id: a remote shell instead of a local one (see ssh.rs)
    #[serde(default)]
    pub ssh: Option<String>,
    /// an Orchestrator agent's pane: its terminal is started by the Orchestrator, not the view
    #[serde(default)]
    pub agent: Option<String>,
}

fn default_kind() -> String {
    "custom".into()
}
fn yes() -> bool {
    true
}

static DETECTED: OnceLock<Mutex<Option<Vec<Profile>>>> = OnceLock::new();

#[tauri::command]
pub async fn shells_list(refresh: Option<bool>) -> Vec<Profile> {
    let cell = DETECTED.get_or_init(|| Mutex::new(None));
    if !refresh.unwrap_or(false) {
        if let Some(list) = cell.lock().clone() {
            return list;
        }
    }
    let list = tauri::async_runtime::spawn_blocking(detect)
        .await
        .unwrap_or_default();
    *cell.lock() = Some(list.clone());
    list
}

fn detect() -> Vec<Profile> {
    let mut out = Vec::new();
    let sysroot = env::var("SystemRoot").unwrap_or_else(|_| "C:\\Windows".into());

    if let Some(pwsh) = find_pwsh() {
        out.push(profile("pwsh", "PowerShell", &pwsh, &[], "pwsh", "#5c8dff"));
    }
    let winps = format!("{sysroot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
    if Path::new(&winps).exists() {
        out.push(profile(
            "powershell",
            "Windows PowerShell",
            &winps,
            &[],
            "powershell",
            "#3a7bd5",
        ));
    }
    let cmd = format!("{sysroot}\\System32\\cmd.exe");
    if Path::new(&cmd).exists() {
        out.push(profile("cmd", "Command Prompt", &cmd, &[], "cmd", "#9aa4b2"));
    }
    if let Some(bash) = find_git_bash() {
        out.push(profile(
            "git-bash",
            "Git Bash",
            &bash,
            &["--login", "-i"],
            "bash",
            "#f05133",
        ));
    }
    for distro in wsl_distros() {
        let id = format!(
            "wsl-{}",
            distro
                .chars()
                .map(|c| if c.is_ascii_alphanumeric() { c.to_ascii_lowercase() } else { '-' })
                .collect::<String>()
        );
        out.push(profile(
            &id,
            &format!("{distro} (WSL)"),
            "wsl.exe",
            &["-d", &distro],
            "wsl",
            "#e95420",
        ));
    }
    out
}

fn profile(id: &str, name: &str, cmd: &str, args: &[&str], kind: &str, color: &str) -> Profile {
    Profile {
        id: id.into(),
        name: name.into(),
        command: cmd.into(),
        args: args.iter().map(|s| s.to_string()).collect(),
        kind: kind.into(),
        icon: None,
        color: Some(color.into()),
    }
}

fn find_in_path(exe: &str) -> Option<PathBuf> {
    env::var_os("PATH").and_then(|paths| {
        env::split_paths(&paths)
            .map(|p| p.join(exe))
            .find(|p| p.is_file())
    })
}

fn find_pwsh() -> Option<String> {
    let pf = env::var("ProgramFiles").unwrap_or_else(|_| "C:\\Program Files".into());
    [
        PathBuf::from(format!("{pf}\\PowerShell\\7\\pwsh.exe")),
        PathBuf::from(format!("{pf}\\PowerShell\\7-preview\\pwsh.exe")),
    ]
    .into_iter()
    .find(|p| p.is_file())
    .or_else(|| find_in_path("pwsh.exe"))
    .map(|p| p.to_string_lossy().into_owned())
}

fn find_git_bash() -> Option<String> {
    let mut candidates = Vec::new();
    for var in ["ProgramFiles", "ProgramW6432", "ProgramFiles(x86)"] {
        if let Ok(pf) = env::var(var) {
            candidates.push(PathBuf::from(format!("{pf}\\Git\\bin\\bash.exe")));
        }
    }
    if let Ok(local) = env::var("LOCALAPPDATA") {
        candidates.push(PathBuf::from(format!("{local}\\Programs\\Git\\bin\\bash.exe")));
    }
    if let Some(git) = find_in_path("git.exe") {
        // ...\Git\cmd\git.exe -> ...\Git\bin\bash.exe
        if let Some(root) = git.parent().and_then(Path::parent) {
            candidates.push(root.join("bin").join("bash.exe"));
        }
    }
    candidates
        .into_iter()
        .find(|p| p.is_file())
        .map(|p| p.to_string_lossy().into_owned())
}

/// `wsl.exe -l -q` prints UTF-16LE. It can hang when WSL is broken, so bound it.
fn wsl_distros() -> Vec<String> {
    let sysroot = env::var("SystemRoot").unwrap_or_else(|_| "C:\\Windows".into());
    if !Path::new(&format!("{sysroot}\\System32\\wsl.exe")).exists() {
        return Vec::new();
    }
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let out = hidden_command("wsl.exe").args(["-l", "-q"]).output();
        let _ = tx.send(out);
    });
    let Ok(Ok(out)) = rx.recv_timeout(Duration::from_secs(4)) else {
        return Vec::new();
    };
    if !out.status.success() {
        return Vec::new();
    }
    let units: Vec<u16> = out
        .stdout
        .chunks_exact(2)
        .map(|c| u16::from_le_bytes([c[0], c[1]]))
        .collect();
    String::from_utf16_lossy(&units)
        .lines()
        .map(|l| l.trim().trim_matches('\u{feff}').to_string())
        .filter(|l| !l.is_empty() && !l.starts_with("docker-desktop"))
        .collect()
}

/// Prompt wrapper that reports the working directory via OSC 9;9 (Windows Terminal
/// convention) while keeping the user's own prompt (oh-my-posh, starship, ...).
const PS_INTEGRATION: &str = r#"
if (-not $global:__smInit) {
  $global:__smInit = $true
  $global:__smOrigPrompt = $function:prompt
  function global:prompt {
    $orig = if ($global:__smOrigPrompt) { & $global:__smOrigPrompt } else { "PS $($executionContext.SessionState.Path.CurrentLocation)$('>' * ($nestedPromptLevel + 1)) " }
    $loc = $executionContext.SessionState.Path.CurrentLocation
    $osc = ''
    if ($loc.Provider.Name -eq 'FileSystem') { $osc = "$([char]27)]9;9;`"$($loc.ProviderPath)`"$([char]27)\" }
    return "$osc$orig"
  }
}
"#;

// cygpath -m prints "C:/x" with no leading slash, so the URL supplies it: "file://host/C:/x"
// ("file://hostC:/x" would parse as host "hostC:" and lose the drive)
const BASH_PROMPT_COMMAND: &str = r#"printf '\033]7;file://%s/%s\033\\' "${HOSTNAME:-localhost}" "$(cygpath -m "$PWD" 2>/dev/null || printf %s "${PWD#/}")""#;

fn encode_ps(script: &str) -> String {
    let utf16: Vec<u8> = script
        .encode_utf16()
        .flat_map(|u| u.to_le_bytes())
        .collect();
    base64::engine::general_purpose::STANDARD.encode(utf16)
}

fn is_windows_path(p: &str) -> bool {
    let b = p.as_bytes();
    (b.len() >= 2 && b[0].is_ascii_alphabetic() && b[1] == b':') || p.starts_with("\\\\")
}

/// Build the command line for a spawn request, adding shell integration when possible.
pub fn build_command(spec: &SpawnSpec, cwd: Option<&str>) -> CommandBuilder {
    let mut cmd = CommandBuilder::new(&spec.command);
    let fresh = if spec.fresh_env { crate::env::fresh_environment() } else { None };
    if let Some(vars) = &fresh {
        cmd.env_clear();
        for (k, v) in vars {
            cmd.env(k, v);
        }
    }
    let base_var = |key: &str| -> Option<String> {
        match &fresh {
            Some(vars) => crate::env::lookup(vars, key).map(str::to_string),
            None => env::var(key).ok(),
        }
    };
    let integrate = spec.shell_integration;
    match spec.kind.as_str() {
        "pwsh" | "powershell" if integrate && spec.args.is_empty() => {
            cmd.args(["-NoLogo", "-NoExit", "-EncodedCommand", &encode_ps(PS_INTEGRATION)]);
        }
        "cmd" if integrate => {
            let prev = base_var("PROMPT").unwrap_or_else(|| "$P$G".into());
            cmd.env("PROMPT", format!("$e]9;9;$P$e\\{prev}"));
            cmd.args(&spec.args);
        }
        "bash" if integrate => {
            cmd.env("PROMPT_COMMAND", BASH_PROMPT_COMMAND);
            cmd.env("TERM", "xterm-256color");
            cmd.args(&spec.args);
        }
        "wsl" => {
            if let Some(dir) = cwd.filter(|d| d.starts_with('/')) {
                cmd.args(["--cd", dir]);
            }
            let wslenv = base_var("WSLENV").unwrap_or_default();
            let extra = "TERM_PROGRAM:COLORTERM";
            cmd.env(
                "WSLENV",
                if wslenv.is_empty() { extra.to_string() } else { format!("{wslenv}:{extra}") },
            );
            cmd.args(&spec.args);
        }
        _ => cmd.args(&spec.args),
    }
    cmd.env("TERM_PROGRAM", "Shellmosaic");
    cmd.env("TERM_PROGRAM_VERSION", env!("CARGO_PKG_VERSION"));
    cmd.env("COLORTERM", "truecolor");
    for (k, v) in &spec.env {
        cmd.env(k, v);
    }

    let dir = cwd
        // (the remembered folder came from terminal output: never a network path)
        .filter(|d| crate::vt::acceptable_cwd(d) && is_windows_path(d) && Path::new(d).is_dir())
        .map(PathBuf::from)
        .or_else(|| {
            spec.cwd
                .as_deref()
                .filter(|d| Path::new(d).is_dir())
                .map(PathBuf::from)
        })
        .or_else(|| base_var("USERPROFILE").map(PathBuf::from));
    if let Some(dir) = dir {
        cmd.cwd(dir);
    }
    cmd
}
