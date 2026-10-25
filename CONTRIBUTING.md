# Contributing

Thanks for helping! Open an issue first for anything large, so we can agree on the approach.

## Building

You need Rust (stable), Node.js 20+ with pnpm, and WebView2.

```powershell
pnpm install
pnpm tauri dev        # the app, with hot reload for the UI
pnpm typecheck        # TypeScript (strict)
pnpm build            # typecheck + production frontend build
cd src-tauri
cargo check
```

Both the MSVC and the GNU (MinGW) Rust toolchains work. With MinGW the library is built as an
`rlib` only (the linker can't export a `cdylib` this large), which is already set in
`Cargo.toml`.

## Tests

Logic that touches untrusted input lives in modules without Tauri types so it can be tested on
its own (test binaries that link Tauri don't start under MinGW):

```powershell
cd src-tauri
rustc --edition 2021 --test src/vt.rs -o target/vt-tests.exe; ./target/vt-tests.exe              # terminal stream parsing
rustc --edition 2021 --test src/sanitize.rs -o target/sanitize-tests.exe; ./target/sanitize-tests.exe  # names from remote servers
```

CI runs the typecheck, the frontend build, `cargo check` and these tests on every push.

## Project layout

```
src-tauri/src/
  pty.rs       terminal sessions (ConPTY or SSH), scrollback ring buffer, replay and restore
  ssh.rs       SSH client (russh): host-key trust, authentication, terminal sessions, prompts
  sftp.rs      SFTP panes: listing and transfers
  vault.rs     encrypted store for saved hosts and secrets
  shells.rs    shell detection and shell integration (working folder reporting)
  vt.rs        pure terminal-stream helpers (OSC parsing, ANSI stripping) — unit tested
  sanitize.rs  pure helpers for untrusted names — unit tested
  state.rs     the workspace model store (versioned commits from every window, state.json)
  config.rs    settings, themes, notes, backgrounds, plugin storage
  plugins.rs   plugin discovery and the smplugin:// / smbg:// protocols
  git.rs, tasks.rs, logs.rs, fsops.rs, sysmon.rs, web.rs, windows.rs
src/
  state/       model + layout tree, stores, actions, commands/keybindings, menus, themes, settings, updater
  components/  rail, title bar and tabs, tiling workspace, menus, dialogs, palette, drag and drop
  modules/     one folder per module; registry.ts is the module contract
  settings/    the settings screen and theme editor
```

## Guidelines

- Keep the style of the surrounding code: naming, structure and comment density. Comments say
  *why*, briefly.
- Treat everything outside the app as hostile: files, repositories, terminal output, web pages,
  plugins and SSH servers. Never build shell commands from them without quoting for the target
  shell, never touch a path from them before checking it's local, and never pass them to
  `innerHTML` unsanitized.
- Slow or blocking work (file system, processes, network) never runs on the main thread: use an
  `async` command and `paths::blocking`.

## Releases

Releases are signed so the built-in updater can verify them. The signing key lives outside the
repository (`%USERPROFILE%\.tauri\shellmosaic-updater.key`) — **back it up**: without it, existing
installs can't accept new updates.

1. Bump the version in `package.json`, `src-tauri/Cargo.toml` and `src-tauri/tauri.conf.json`,
   and add a section to `CHANGELOG.md`.
2. Commit and push.
3. Run `pwsh scripts/release.ps1`. It builds the signed installer, writes the updater's
   `latest.json` and publishes a GitHub release with both (add `-Draft` to review first).

The updater reads `https://github.com/VinZie/shellmosaic/releases/latest/download/latest.json`,
so it only works while releases are publicly downloadable.
