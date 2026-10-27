# Optional modules

Modules that don't ship inside Shellmosaic but can be installed from the app:
**Settings → Optional modules**. Each one is a regular sandboxed plugin
([PLUGINS.md](../PLUGINS.md)); the native work they need (reading processes, the event log,
SQLite files, running Claude Code agents) is done by Shellmosaic itself behind permissions you
approve.

| Module | What it does | Permissions |
|---|---|---|
| [Process Inspector](process-inspector) | One process in depth: modules, threads, handles, token, memory map, mitigations, signature; suspend/resume, priority, affinity, thread control | `process.inspect`, `process.control`, `clipboard` |
| [Event Viewer](event-viewer) | Windows event logs with filters, live tail and a Sysmon view | `eventlog.read`, `clipboard` |
| [SQLite Browser](sqlite-browser) | Browse and query SQLite databases; read-only unless you allow changes | `sqlite`, `clipboard` |
| [Claude Usage](claude-usage) | Your Claude plan's session and weekly limits with reset countdowns | `claude.usage` |
| [Orchestrator](orchestrator) | A lead Claude Code agent and up to three workers in their own worktrees: tasks, requests, activity, model routing, merging (Shellmosaic 0.4.0+) | `agents.read`, `agents.manage`, `claude.usage` |

## How installing works

- The app reads [`index.json`](index.json) from the branch of your update channel (`main` for
  Stable, `test` for Test), pinned to one commit, and checks `index.json.sig`: a minisign
  signature made with the same key as Shellmosaic's own updates. A catalog that isn't signed
  with that key is refused.
- `index.json` lists every file of every module with its SHA-256. Installing downloads a
  module's `dist/` files from the same commit and checks each hash before anything is kept.
- Installs, updates and removals are queued and applied the next time Shellmosaic starts, so
  you can line up several and restart once. The permissions you saw when you chose to install
  are granted then; anything else still has to be asked for.
- A module the store installed is kept up to date from here. If you replace or remove its folder
  by hand (Settings → Plugins), it's your own plugin from then on.

## Developing a module

```
modules/
  shared/            the kit every module uses: SDK typings (api.ts), table, menus, styles…
  <id>/
    manifest.json    id, name, version, minAppVersion, icon, permissions
    index.html       loads /__sdk/shellmosaic.js, then src/main.tsx
    src/             React + TypeScript
    src/dev-mock.ts  fake data for developing without the app
    dist/            the build: what the app downloads (committed)
```

- `pnpm modules:dev <id>` — a dev server with the module's mock data. `?light` for the light
  theme, `?admin` to pretend Shellmosaic runs elevated, `?args={...}` for pane arguments.
- `pnpm modules:build [<id>]` — builds into `<id>/dist` and rewrites `index.json`.
- `pnpm exec tsc --noEmit -p modules` — typecheck.
- To try a build in the app without publishing: set `SHELLMOSAIC_MODULES_SOURCE` to this folder
  before starting Shellmosaic; the store then reads the catalog and files from disk (the
  signature is still checked, so sign first).

## Publishing

1. Bump the module's `version` (and `minAppVersion` when it needs a newer app).
2. `node modules/build.mjs --sign` — builds every module, rewrites `index.json` and signs it
   with the release key (`%USERPROFILE%\.tauri\shellmosaic-updater.key`, never committed).
3. Commit `modules/` including `dist/`, `index.json` and `index.json.sig`, and push to `test`
   (testers get it) or `main` (everyone).
