# Changelog

## 0.3.1 — 2026-10-25

### Fixed
- A terminal restored after a restart no longer prints "restored session" and the new prompt
  in the middle of the old output (for example inside Claude Code's last frame, which stayed
  drawn below it). The marker now goes below everything the old session drew, and whatever its
  program left switched on (mouse and focus reporting, bracketed paste, hidden cursor, scroll
  region and more) is reset first.
- Restored output is replayed at the size it was drawn at, so a pane that is now a different
  size (or sits in a background tab) no longer shows leftover copies of redrawn frames.

## 0.3.0 — 2026-10-25

### Added
- **Optional modules** (Settings → Optional modules): extra modules published in this
  repository's `modules/` folder, installed, updated and removed from the app. Downloads are
  checked against a catalog signed with the release key. Installs and removals apply at the next
  start: queue as many as you like, then restart once.
- **Process Inspector** (optional module): one process in depth: overview with signature,
  integrity, protection (PPL), mitigations and command line; loaded modules; threads with start
  addresses and wait reasons; handles with decoded access rights; token groups and privileges;
  the memory map with executable private memory highlighted. Suspend/resume, priority,
  affinity and thread actions. Tabs and columns are customizable. Processes and Ports panes get
  an **Inspect** item.
- **Event Viewer** (optional module): every Windows event log with level, event ID, source,
  time and text filters (or raw XPath), live tail, and a Sysmon view with per-event columns.
- **SQLite Browser** (optional module): browse tables, structure and run SQL. Databases open
  read-only; changes need an explicit switch; locked databases (a running browser's history)
  open from a copy. Files gets **Open in SQLite Browser**.
- **Update channel** (Settings → About): Stable, or Test for pre-release builds and the test
  branch's optional modules (with a warning that they may be unstable).
- **Restart as administrator** for modules that need it (asked first); while elevated the title
  bar says so, and the inspector reads protected details with SeDebugPrivilege on its own
  threads only.
- Ctrl+V with a picture on the clipboard sends the program's image-paste key (Alt+V by default,
  which Claude Code uses on Windows), configurable in Settings → Terminal.
- Shift+Enter starts a new line in Claude Code instead of sending the message (it sends what
  Claude Code reads as Alt+Enter). Settings → Terminal → Keyboard switches it back to a plain
  Enter.
- Plugin SDK v2: `process`, `thread`, `eventlog`, `sqlite`, `ui.confirm/pickFile/openModule/
  reveal/setState`, `app.info/restartAsAdmin`, pane arguments and saved pane state.

### Changed
- **Claude Usage** is an optional module now instead of being installed with the app (existing
  installs keep it and get its updates from Settings → Optional modules). It refreshes at most
  once a minute, and Shellmosaic shares one answer per minute between all panes and backs off
  when Claude says it's asking too often.
- **Sysinfo, redesigned**: clearer cards with big numbers, a layout that follows the pane
  (one to three columns, or a strip), charts with a hover readout, CPU clock and busiest core,
  memory available, network peaks and totals, disks colored by fullness, and a new icon.

### Fixed
- Sysinfo showed 0 processes unless a Processes or Ports pane was open.

## 0.2.1 — 2026-10-25

### Added
- **Claude Usage plugin** (bundled): your Claude plan's session and weekly limits, per-model
  weekly limits and reset countdowns, refreshed on an interval you pick (30 s to a day; paused
  while the pane is hidden).
- Plugin permission `claude.usage` and `shellmosaic.claude.usage()`: Shellmosaic reads Claude
  Code's sign-in and fetches the usage itself, so plugins never see the token.
- Bundled plugins added in later versions are installed on existing setups too (each once;
  one you removed stays removed).

## 0.2.0 — 2026-10-24

### Added
- **Hosts module**: saved SSH hosts with groups, tags and search, stored in a vault encrypted with
  a master password (Argon2id + XChaCha20-Poly1305), auto-lock after idle minutes.
- **SSH terminals** with a built-in client (russh): connections open in normal terminal panes
  with scrollback, find, broadcast and restore; host keys pinned on first use; passwords, key
  passphrases and 2FA prompts asked inline.
- **SFTP module**: browse, upload, download (files and folders), rename and delete on a saved host.
- **Updater**: checks this repository's GitHub releases, asks before installing (update now,
  skip this version, or later); packages are signature-checked.
- Only one Shellmosaic runs at a time; launching it again brings the open window forward.

### Security
- The Git pane runs nothing in a repository whose own config can start programs (filters,
  textconv, fsmonitor, gpg) until you trust it; implicit bare repositories are ignored.
- Folder reports from terminal output are accepted for local paths only (no network shares,
  no control characters).
- Background images are served by name from the app's folder only (Tauri's asset protocol is
  gone); plugin files can't be requested by absolute or network path; web panes can't load
  either protocol.
- Markdown previews in the Files pane have no Run buttons, inline styles or app CSS classes.
- Plugins get a one-time token per load: a page the plugin frame navigates to has no access.
  Plugins can no longer open blocking dialogs, and reinstalling a plugin resets its permissions.
- Script names that could smuggle commands are skipped by the Tasks pane; dropped file names are
  quoted per shell; app windows refuse to navigate away from the app.
- Importing settings never carries over plugin permissions and shows any shell commands first.

### Fixed
- Many reliability fixes: a crafted escape sequence could freeze a terminal; blocking work moved
  off the UI thread; large pastes no longer hang the app; safer saving of state and scrollback;
  image previews; Git Bash folder tracking; case-only renames; AltGr characters; and more.

## 0.1.0 — 2026-10-24

First version: workspaces, tabs and tiling panes; terminal, files, web, system, processes,
notes, git, network & ports, task runner and log viewer modules; plugins; themes and a theme
editor; session restore.
