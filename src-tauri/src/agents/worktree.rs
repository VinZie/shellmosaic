//! The git side of a run: the integration branch, one worktree per worker slot next to
//! the repository (`<parent>\<repo>.wt\w1`), a branch per task, and merging finished work
//! into the integration branch (in its own worktree, `…\_int`) — the user's own working
//! tree and branch are never touched here.
//!
//! Git runs here with the repository's hooks and fsmonitor switched off: these are
//! Shellmosaic's own bookkeeping commands, not the agents' (theirs run as usual).

use std::path::{Path, PathBuf};
use std::process::Stdio;

use crate::paths::hidden_command;

pub const INTEGRATION: &str = "orch/integration";

fn git_out(dir: &Path, args: &[&str]) -> Result<std::process::Output, String> {
    hidden_command("git")
        .args(["-c", "core.longpaths=true", "-c", "core.quotepath=off", "-c", "core.hooksPath=NUL", "-c", "core.fsmonitor=false"])
        .args(["-c", "safe.bareRepository=explicit", "--no-optional-locks"])
        .args(args)
        .current_dir(dir)
        .stdin(Stdio::null())
        .env("GIT_TERMINAL_PROMPT", "0")
        .output()
        .map_err(|e| format!("git isn't available: {e}"))
}

fn git(dir: &Path, args: &[&str]) -> Result<String, String> {
    let out = git_out(dir, args)?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).trim_end().to_string())
    } else {
        let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
        Err(if err.is_empty() { format!("git {} failed", args.first().unwrap_or(&"")) } else { err })
    }
}

fn win_path(p: &str) -> PathBuf {
    PathBuf::from(p.trim().replace('/', "\\"))
}

pub struct Repo {
    /// the main worktree's root (also when `cwd` is inside a linked worktree)
    pub root: PathBuf,
    /// checked-out branch (None: detached HEAD)
    pub branch: Option<String>,
}

/// The repository `cwd` belongs to. `Err("not-a-repo: …")` when it isn't one.
pub fn repo(cwd: &Path) -> Result<Repo, String> {
    let common = git(cwd, &["rev-parse", "--path-format=absolute", "--git-common-dir"])
        .map_err(|_| format!("not-a-repo: {} isn't in a git repository", cwd.display()))?;
    let common = win_path(&common);
    let root = if common.file_name().is_some_and(|n| n.eq_ignore_ascii_case(".git")) {
        common.parent().map(Path::to_path_buf).unwrap_or(common.clone())
    } else {
        // a bare repository: no main worktree to work next to
        return Err(format!("{} is a bare repository", common.display()));
    };
    if git(&root, &["rev-parse", "--verify", "--quiet", "HEAD"]).is_err() {
        return Err("no-commits: the repository has no commits yet; commit something first".into());
    }
    let branch = git(&root, &["symbolic-ref", "--short", "-q", "HEAD"]).ok().filter(|b| !b.is_empty());
    Ok(Repo { root, branch })
}

/// `git init` with everything in the folder as the first commit (the "Offer git init" path).
pub fn init(dir: &Path) -> Result<(), String> {
    git(dir, &["init"])?;
    git(dir, &["add", "-A"])?;
    git(dir, &["commit", "--allow-empty", "-m", "Initial commit"]).map_err(|e| {
        if e.contains("user.email") || e.contains("user.name") || e.contains("identity") {
            "Git doesn't know who you are yet: run `git config --global user.name \"Your Name\"` and \
             `git config --global user.email you@example.com`, then try again."
                .to_string()
        } else {
            e
        }
    })?;
    Ok(())
}

/// Create the integration branch at the current HEAD unless it exists.
pub fn ensure_integration(root: &Path) -> Result<(), String> {
    if git(root, &["rev-parse", "--verify", "--quiet", &format!("refs/heads/{INTEGRATION}")]).is_err() {
        git(root, &["branch", INTEGRATION, "HEAD"])?;
    }
    Ok(())
}

/// `<parent>\<repo>.wt`: the run's worktrees live next to the repository, never inside it.
pub fn base(root: &Path) -> PathBuf {
    let name = root.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| "repo".into());
    root.with_file_name(format!("{name}.wt"))
}

fn is_worktree_root(path: &Path) -> bool {
    path.is_dir() && git(path, &["rev-parse", "--show-toplevel"]).is_ok_and(|t| win_path(&t) == path)
}

/// A worker slot's worktree (created detached at the integration branch; every task gets
/// its own branch, see [`start_task`]).
pub fn ensure_slot(root: &Path, slot: &str) -> Result<PathBuf, String> {
    let path = base(root).join(slot);
    if is_worktree_root(&path) {
        return Ok(path);
    }
    // a folder git forgot about (deleted by hand, or left by a crash) would block `add`
    let _ = git(root, &["worktree", "prune"]);
    if path.exists() && std::fs::read_dir(&path).map(|mut d| d.next().is_some()).unwrap_or(true) {
        return Err(format!("{} already exists and isn't one of this repository's worktrees", path.display()));
    }
    let p = path.to_string_lossy().into_owned();
    let reason = format!("Shellmosaic agent {slot}");
    git(root, &["worktree", "add", "--lock", "--reason", &reason, "--detach", &p, INTEGRATION])?;
    Ok(path)
}

/// `git status --porcelain` lines (empty: clean).
pub fn changes(wt: &Path) -> Result<Vec<String>, String> {
    Ok(git(wt, &["status", "--porcelain"])?.lines().map(str::to_string).filter(|l| !l.trim().is_empty()).collect())
}

/// Uncommitted changes in a worktree, committed as `message` (false: nothing to commit).
pub fn commit_all(wt: &Path, message: &str) -> Result<bool, String> {
    if git(wt, &["status", "--porcelain"])?.trim().is_empty() {
        return Ok(false);
    }
    git(wt, &["add", "-A"])?;
    git(wt, &["commit", "-m", message])?;
    Ok(true)
}

/// The branch a run's task is done on. (Flat per run: git can't have both `orch/w1` and
/// `orch/w1/t1`, a ref can't be a file and a folder at once.)
pub fn task_branch(run: &str, task: &str) -> String {
    format!("orch/{run}/{task}")
}

/// Put a slot's worktree on a fresh branch for a task, starting from the integration branch.
/// Whatever the previous task left uncommitted is committed on its branch first.
pub fn start_task(wt: &Path, branch: &str) -> Result<(), String> {
    if let Ok(current) = git(wt, &["symbolic-ref", "--short", "-q", "HEAD"]) {
        commit_all(wt, &format!("Uncommitted work left on {current} (saved by Shellmosaic)"))?;
    } else {
        // detached (a new slot): nothing of a task's can be here, don't commit onto nothing
        git(wt, &["reset", "--hard", "-q"])?;
        git(wt, &["clean", "-fdq"])?;
    }
    git(wt, &["switch", "-C", branch, INTEGRATION])?;
    Ok(())
}

pub struct Stats {
    pub commits: u32,
    pub files: u32,
    pub added: u64,
    pub removed: u64,
}

/// How far `branch` is ahead of the integration branch.
pub fn stats(root: &Path, branch: &str) -> Result<Stats, String> {
    let commits = git(root, &["rev-list", "--count", &format!("{INTEGRATION}..{branch}")])?.trim().parse().unwrap_or(0);
    let numstat = git(root, &["diff", "--numstat", &format!("{INTEGRATION}...{branch}")])?;
    let (mut files, mut added, mut removed) = (0, 0, 0);
    for line in numstat.lines() {
        let mut it = line.split('\t');
        let (a, r) = (it.next().unwrap_or("0"), it.next().unwrap_or("0"));
        files += 1;
        added += a.parse::<u64>().unwrap_or(0);
        removed += r.parse::<u64>().unwrap_or(0);
    }
    Ok(Stats { commits, files, added, removed })
}

pub enum Merge {
    Merged,
    /// nothing to merge (no commits ahead)
    Empty,
    Conflict(Vec<String>),
}

/// Merge `branch` into the integration branch, in the integration worktree. Conflicts are
/// found first without touching any files (`git merge-tree`); then nothing is merged.
pub fn merge_into_integration(root: &Path, branch: &str, message: &str) -> Result<Merge, String> {
    if stats(root, branch)?.commits == 0 {
        return Ok(Merge::Empty);
    }
    let out = git_out(root, &["merge-tree", "--write-tree", "--name-only", "--no-messages", "-z", INTEGRATION, branch])?;
    match out.status.code() {
        Some(0) => {}
        Some(1) => {
            // tree id, then the conflicted paths, NUL-separated
            let text = String::from_utf8_lossy(&out.stdout);
            let files = text.split('\0').skip(1).filter(|s| !s.is_empty()).map(str::to_string).collect();
            return Ok(Merge::Conflict(files));
        }
        _ => return Err(String::from_utf8_lossy(&out.stderr).trim().to_string()),
    }
    let int = base(root).join("_int");
    if !is_worktree_root(&int) {
        let _ = git(root, &["worktree", "prune"]);
        let p = int.to_string_lossy().into_owned();
        git(root, &["worktree", "add", "--lock", "--reason", "Shellmosaic integration", &p, INTEGRATION])?;
    }
    git(&int, &["merge", "--no-ff", "--no-edit", "-m", message, branch])?;
    Ok(Merge::Merged)
}

/// A branch's changes against the integration branch, as a unified diff (cut at `max` bytes).
pub fn diff(root: &Path, branch: &str, max: usize) -> Result<(String, bool), String> {
    let mut d = git(root, &["diff", "--no-color", "--no-ext-diff", &format!("{INTEGRATION}...{branch}")])?;
    let cut = d.len() > max;
    if cut {
        let mut i = max;
        while !d.is_char_boundary(i) {
            i -= 1;
        }
        d.truncate(i);
    }
    Ok((d, cut))
}

/// What merging the integration branch into the user's branch would do.
pub struct BasePreview {
    pub commits: u32,
    pub files: Vec<String>,
    pub added: u64,
    pub removed: u64,
    pub conflicts: Vec<String>,
    /// files the merge changes that have uncommitted changes in the user's working tree
    pub dirty_overlap: Vec<String>,
    /// the branch the user's working tree is on now
    pub current: Option<String>,
}

pub fn base_preview(root: &Path, base: &str) -> Result<BasePreview, String> {
    let range = format!("{base}..{INTEGRATION}");
    let commits = git(root, &["rev-list", "--count", &range])?.trim().parse().unwrap_or(0);
    let numstat = git(root, &["diff", "--numstat", &format!("{base}...{INTEGRATION}")])?;
    let (mut files, mut added, mut removed) = (Vec::new(), 0, 0);
    for line in numstat.lines() {
        let mut it = line.splitn(3, '\t');
        let (a, r, f) = (it.next().unwrap_or("0"), it.next().unwrap_or("0"), it.next().unwrap_or(""));
        added += a.parse::<u64>().unwrap_or(0);
        removed += r.parse::<u64>().unwrap_or(0);
        files.push(f.to_string());
    }
    let out = git_out(root, &["merge-tree", "--write-tree", "--name-only", "--no-messages", "-z", base, INTEGRATION])?;
    let conflicts = match out.status.code() {
        Some(1) => String::from_utf8_lossy(&out.stdout).split('\0').skip(1).filter(|s| !s.is_empty()).map(str::to_string).collect(),
        Some(0) => Vec::new(),
        _ => return Err(String::from_utf8_lossy(&out.stderr).trim().to_string()),
    };
    let dirty: Vec<String> = changes(root)?.iter().map(|l| l.get(3..).unwrap_or("").trim_matches('"').replace('\\', "/")).collect();
    let dirty_overlap = files.iter().filter(|f| dirty.iter().any(|d| d == *f)).cloned().collect();
    let current = git(root, &["symbolic-ref", "--short", "-q", "HEAD"]).ok().filter(|b| !b.is_empty());
    Ok(BasePreview { commits, files, added, removed, conflicts, dirty_overlap, current })
}

/// Merge the integration branch into the user's branch, in their own working tree — only
/// when it's on that branch, nothing conflicts and none of their uncommitted changes are in
/// the way. Nothing is checked out, stashed or reset there.
pub fn merge_into_base(root: &Path, base: &str) -> Result<u32, String> {
    let p = base_preview(root, base)?;
    if p.current.as_deref() != Some(base) {
        return Err(format!(
            "Your repository is on {} now; switch it back to {base} to merge the team's work into it.",
            p.current.as_deref().unwrap_or("a detached HEAD")
        ));
    }
    if p.commits == 0 {
        return Ok(0);
    }
    if !p.conflicts.is_empty() {
        return Err(format!("{INTEGRATION} conflicts with {base} in: {}. Resolve it in the team (a task to merge {base} in) first.", p.conflicts.join(", ")));
    }
    if !p.dirty_overlap.is_empty() {
        return Err(format!("You have uncommitted changes in files the merge changes: {}. Commit or stash them first.", p.dirty_overlap.join(", ")));
    }
    git(root, &["merge", "--no-ff", "--no-edit", "-m", &format!("Merge {INTEGRATION} (Shellmosaic Orchestrator)"), INTEGRATION])?;
    Ok(p.commits)
}

/// Remove a slot's worktree. Its branches stay (they hold the work).
pub fn remove_slot(root: &Path, slot: &str) -> Result<(), String> {
    let path = base(root).join(slot);
    if !path.exists() {
        let _ = git(root, &["worktree", "prune"]);
        return Ok(());
    }
    let p = path.to_string_lossy().into_owned();
    let _ = git(root, &["worktree", "unlock", &p]);
    git(root, &["worktree", "remove", "--force", &p])?;
    let _ = git(root, &["worktree", "prune"]);
    Ok(())
}

/// Every one of these branches (that still exists) is merged into the integration branch.
pub fn all_merged(root: &Path, branches: &[String]) -> bool {
    let Ok(unmerged) = git(root, &["branch", "--format=%(refname:short)", "--no-merged", INTEGRATION]) else {
        return false;
    };
    !unmerged.lines().any(|b| branches.iter().any(|x| x == b.trim()))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A fresh repository with one commit, in its own temp folder (its .wt sibling goes there too).
    fn repo_with(files: &[(&str, &str)]) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("sm-wt-test-{}", uuid::Uuid::new_v4().simple())).join("repo");
        std::fs::create_dir_all(&dir).unwrap();
        git(&dir, &["init", "-q", "-b", "main"]).unwrap();
        git(&dir, &["config", "user.name", "test"]).unwrap();
        git(&dir, &["config", "user.email", "test@local"]).unwrap();
        for (f, text) in files {
            std::fs::write(dir.join(f), text).unwrap();
        }
        git(&dir, &["add", "-A"]).unwrap();
        git(&dir, &["commit", "-q", "-m", "init"]).unwrap();
        dir
    }

    fn work(wt: &Path, branch: &str, file: &str, text: &str) {
        start_task(wt, branch).unwrap();
        std::fs::write(wt.join(file), text).unwrap();
        assert!(commit_all(wt, &format!("work on {branch}")).unwrap());
    }

    #[test]
    fn task_branches_merge_and_conflict() {
        let root = repo_with(&[("a.txt", "one\n"), ("b.txt", "two\n")]);
        let r = repo(&root).unwrap();
        assert_eq!(r.branch.as_deref(), Some("main"));
        ensure_integration(&root).unwrap();
        let w1 = ensure_slot(&root, "w1").unwrap();
        let w2 = ensure_slot(&root, "w2").unwrap();
        assert_eq!(w1, base(&root).join("w1"));
        // the same slot again is reused
        assert_eq!(ensure_slot(&root, "w1").unwrap(), w1);

        work(&w1, &task_branch("r", "t1"), "a.txt", "one changed by t1\n");
        work(&w2, &task_branch("r", "t2"), "a.txt", "one changed by t2\n");
        let s = stats(&root, &task_branch("r", "t1")).unwrap();
        assert_eq!((s.commits, s.files), (1, 1));

        assert!(matches!(merge_into_integration(&root, &task_branch("r", "t1"), "t1").unwrap(), Merge::Merged));
        assert!(matches!(merge_into_integration(&root, &task_branch("r", "t1"), "t1").unwrap(), Merge::Empty));
        match merge_into_integration(&root, &task_branch("r", "t2"), "t2").unwrap() {
            Merge::Conflict(files) => assert_eq!(files, vec!["a.txt".to_string()]),
            _ => panic!("expected a conflict"),
        }
        assert!(all_merged(&root, &[task_branch("r", "t1")]));
        assert!(!all_merged(&root, &[task_branch("r", "t1"), task_branch("r", "t2")]));

        // a done task leaves a clean tree; leftovers of an unfinished one are kept on its branch
        start_task(&w1, &task_branch("r", "t3")).unwrap();
        std::fs::write(w1.join("new.txt"), "unfinished\n").unwrap();
        assert_eq!(changes(&w1).unwrap().len(), 1);
        start_task(&w1, &task_branch("r", "t4")).unwrap();
        assert!(changes(&w1).unwrap().is_empty());
        assert_eq!(stats(&root, &task_branch("r", "t3")).unwrap().commits, 1);

        remove_slot(&root, "w2").unwrap();
        assert!(!w2.exists());
        let _ = std::fs::remove_dir_all(root.parent().unwrap());
    }

    #[test]
    fn merging_into_the_users_branch_is_guarded() {
        let root = repo_with(&[("a.txt", "one\n"), ("b.txt", "two\n")]);
        ensure_integration(&root).unwrap();
        let w1 = ensure_slot(&root, "w1").unwrap();
        work(&w1, &task_branch("r", "t1"), "a.txt", "changed\n");
        merge_into_integration(&root, &task_branch("r", "t1"), "t1").unwrap();

        let p = base_preview(&root, "main").unwrap();
        assert_eq!((p.commits > 0, p.files.clone(), p.current.as_deref()), (true, vec!["a.txt".to_string()], Some("main")));
        assert!(p.conflicts.is_empty() && p.dirty_overlap.is_empty());

        // the user's uncommitted change to a file the merge touches blocks it; others don't
        std::fs::write(root.join("a.txt"), "mine\n").unwrap();
        std::fs::write(root.join("b.txt"), "mine too\n").unwrap();
        assert_eq!(base_preview(&root, "main").unwrap().dirty_overlap, vec!["a.txt".to_string()]);
        assert!(merge_into_base(&root, "main").unwrap_err().contains("uncommitted"));
        git(&root, &["checkout", "-q", "--", "a.txt"]).unwrap();

        // never on another branch
        git(&root, &["switch", "-q", "-c", "elsewhere"]).unwrap();
        assert!(merge_into_base(&root, "main").unwrap_err().contains("switch it back"));
        git(&root, &["switch", "-q", "main"]).unwrap();

        assert!(merge_into_base(&root, "main").unwrap() > 0);
        assert_eq!(std::fs::read_to_string(root.join("a.txt")).unwrap().replace("\r\n", "\n"), "changed\n");
        // the user's own unrelated change is still there
        assert_eq!(std::fs::read_to_string(root.join("b.txt")).unwrap(), "mine too\n");
        let _ = std::fs::remove_dir_all(root.parent().unwrap());
    }
}
