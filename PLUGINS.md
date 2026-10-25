# Writing Shellmosaic plugins

A plugin is a **module**: a pane type that can sit next to terminals, be dragged around,
saved with the layout, and added from the module bar or the command palette (`Ctrl+Shift+X`).

Plugins are plain web pages (HTML/CSS/JS, any framework you like) that run in a **sandboxed
iframe**. They talk to Shellmosaic through a small SDK, and every capability is gated by
permissions that the user approves.

## Quick start

1. Open Settings → Plugins → **Open plugins folder** (`%APPDATA%\com.shellmosaic.app\plugins`).
2. Copy the bundled `command-board` folder and rename the copy to your plugin id, e.g. `my-tool`.
3. Edit `manifest.json` (the `id` must equal the folder name), then build your UI in `index.html`.
4. Settings → Plugins → **Reload**. Your module appears in the module bar.

## manifest.json

```json
{
  "id": "my-tool",
  "name": "My Tool",
  "version": "1.0.0",
  "author": "you",
  "description": "What it does, shown in tooltips and Settings",
  "icon": "wrench",
  "entry": "index.html",
  "permissions": ["terminal.write"]
}
```

- `id`: lowercase letters, digits, `-`, `_` or `.`; must match the folder name.
- `icon`: any icon name Shellmosaic knows (`wrench`, `rocket`, `bug`, `globe`, `database`, …).
  Unknown names show a puzzle piece.
- `entry`: the HTML file to load (default `index.html`).

## Permissions

| Permission | Allows |
|---|---|
| `terminal.write` | `shellmosaic.terminal.write(text)`: type into the tab's terminal |
| `terminal.run` | `shellmosaic.terminal.run(command, {cwd})`: open a new terminal pane running a command |
| `terminal.read` | `shellmosaic.terminal.read({maxBytes})`: recent terminal output as plain text |
| `fs.read` | `shellmosaic.fs.list(path)`, `shellmosaic.fs.readText(path)` |
| `fs.write` | `shellmosaic.fs.writeText(path, text)` |
| `shell.exec` | `shellmosaic.shell.exec(program, args, {cwd, timeoutMs})` → `{code, stdout, stderr}` |
| `system.read` | `shellmosaic.system.stats()`: CPU, memory, network, uptime |
| `clipboard` | `shellmosaic.clipboard.readText()` / `writeText(text)` |
| `net` | `fetch`/WebSocket to `https:`/`wss:` URLs, and remote images |
| `claude.usage` | `shellmosaic.claude.usage()`: Claude plan limits of the account Claude Code is signed in with |
| `process.inspect` | `shellmosaic.process.*`: a process's overview, modules, threads, handles, token, memory map; file signatures |
| `process.control` | `process.suspend/resume/setPriority/setAffinity`, `thread.suspend/resume/terminate` |
| `eventlog.read` | `shellmosaic.eventlog.*`: Windows event logs (queries, paging, live subscriptions) |
| `sqlite` | `shellmosaic.sqlite.*`: open local SQLite databases, read-only unless the plugin asks to write |

Without `net`, a plugin can't use `fetch`, XHR or WebSockets (the CSP sets `connect-src 'none'`)
and can't load remote images. That is not a complete offline sandbox, though: a page can still
send data out by navigating its own frame, for example. Only install plugins you trust.
Users approve permissions the first time the plugin opens and can revoke them in Settings.
Reinstalling a plugin (even the same id) asks for its permissions again.

## SDK

Include it from your HTML (it's served by Shellmosaic):

```html
<script src="/__sdk/shellmosaic.js"></script>
<script>
  window.addEventListener("shellmosaic:ready", async (e) => {
    const { cwd, paneId, tabId } = e.detail;
    await shellmosaic.terminal.write("git status\r");
    await shellmosaic.storage.set("lastRun", Date.now());
    shellmosaic.on("cwd", (dir) => console.log("terminal moved to", dir));
  });
</script>
```

| API | Notes |
|---|---|
| `shellmosaic.context()` | `{pluginId, paneId, tabId, workspaceId, cwd, grantedPermissions}` |
| `shellmosaic.on(event, fn)` | Events: `theme` (CSS variables), `cwd` (tab's terminal folder), `visible` |
| `shellmosaic.storage.get(key)` / `.set(key, value)` / `.all()` | Per-plugin JSON storage (5 MB), no permission needed |
| `shellmosaic.ui.notify(message, kind)` | Toast: `info`, `success`, `warning`, `error` |
| `shellmosaic.ui.setTitle(title)` | Sets the pane header text |
| `shellmosaic.ui.setState(obj)` | Saved with the pane (64 KB of JSON) and handed back as `context().state`, also after a restart |
| `shellmosaic.ui.confirm(title, message, {okLabel, danger})` | The app's confirmation dialog → `true`/`false` |
| `shellmosaic.ui.pickFile({title, filters})` | The Open dialog → a path or `null` |
| `shellmosaic.ui.openModule(target)` | Open `{module: "processes"\|"ports", filter}`, `{module: "files", path}` or `{module: "plugin:<id>", args}` next to the pane |
| `shellmosaic.ui.reveal(path)` | Show a local file selected in Explorer |
| `shellmosaic.app.info()` | `{version, elevated}` |
| `shellmosaic.app.restartAsAdmin()` | Asks the user, then relaunches Shellmosaic as administrator (`false` when declined) |
| `shellmosaic.ready` | A Promise of the same info as the `shellmosaic:ready` event |
All calls return Promises and reject with an `Error` when not permitted.

### Claude usage

`shellmosaic.claude.usage()` resolves to `{fetchedAt, plan: {subscription, tier}, usage}`.
Shellmosaic reads the sign-in Claude Code saved (`~/.claude/.credentials.json`, or
`%CLAUDE_CONFIG_DIR%`) and asks Anthropic for the numbers `/usage` shows; the token never
reaches the plugin. `usage` is Anthropic's answer as is. It's undocumented and can change, so
read it leniently: `usage.limits` lists each limit as `{kind, group, percent, severity,
resets_at, scope}`. Answers are shared between panes for 25 seconds. When the sign-in has
expired the call rejects with a message saying so; running `claude` once refreshes it.
The bundled **Claude Usage** plugin uses it.

### Arguments and pane state

A pane opened by another module carries arguments: Processes → **Inspect** opens the Process
Inspector with `context().args = {pid}`, Files → **Open in SQLite Browser** with `{path}`. Anything
a plugin saves with `ui.setState` comes back as `context().state` when the layout is restored.

### Processes, event logs and SQLite

The exact result types are in [`modules/shared/api.ts`](modules/shared/api.ts). In short:

- `process.list()`, `process.overview(pid)`, `.modules(pid)`, `.threads(pid)`, `.handles(pid)`,
  `.token(pid)`, `.memory(pid)`, `.signature(path)`. Addresses are hex strings. Fields that need
  more rights are listed in `overview().denied`; errors for lack of rights say "access denied".
- `eventlog.channels()`, `.info(channel)`, `.query({channel, xpath, reverse, text, max})` →
  `{cursor, events, done, scanned}` where `events` are event XML strings; `.more(cursor)`,
  `.close(cursor)`, `.subscribe({channel, xpath, text})` + `.poll(id)` for new events.
- `sqlite.open(path, {writable, copy})` (local paths only; a locked file opens from a copy),
  `.schema(db)`, `.count(db, table)`, `.query(db, sql, params, {maxRows})`, `.setWritable(db, on)`,
  `.interrupt(db)`, `.close(db)`.

Queries and databases belong to the pane: they're closed when it's closed or reloaded.

### Matching the user's theme

The SDK sets CSS variables on your `<html>` and keeps them updated: `--sm-bg`, `--sm-surface`,
`--sm-surface-2`, `--sm-border`, `--sm-text`, `--sm-text-dim`, `--sm-accent`, `--sm-accent-text`,
`--sm-danger`, `--sm-warning`, `--sm-success`, `--sm-radius`, `--sm-font`, `--sm-font-size`,
`--sm-mono`. It also injects light base styles for `body`, `button` and `input`. Opt out with
`<html data-sm-nostyle>`.

## Optional modules

The modules in [`modules/`](modules) (Process Inspector, Event Viewer, SQLite Browser, Claude
Usage) are plugins too, built with React and a shared kit, and installed from Settings →
Optional modules. See [modules/README.md](modules/README.md).

## Sandbox rules

- No `allow-same-origin`, popups, modal dialogs (`alert`/`confirm`/`prompt`) or top navigation.
  You can't reach the app's DOM or its IPC. Use `shellmosaic.ui.notify` instead of `alert`.
- **Single page.** The plugin is loaded with a one-time token (in the URL's `#smt=…`, which the
  SDK picks up and removes), and the host only answers messages that carry it. If the frame
  navigates to another page — a link, even to another file of your plugin — that page gets no
  answers; reloading the pane reconnects. Use the SDK rather than posting messages yourself.
- Inline scripts and styles are allowed; external scripts are not. Bundle your dependencies
  into the plugin folder.
- Files are served from your plugin folder only: path traversal, absolute and network paths are
  blocked, and `entry` must be a path inside the folder.
