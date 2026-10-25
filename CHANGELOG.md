# Changelog

## Unreleased

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
