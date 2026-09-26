# ryten-plugins

Standalone plugins for [RytenBench](https://github.com/Aitenry/RytenBench), an Electron + React AI workbench.

These plugins are **not bundled with the app**. They are distributed as GitHub Release assets and installed
from inside RytenBench via **Settings → Plugins → Install from repository** — or **from a local file** with the
single **Install from local…** entry next to it: pick a `.zip` of a built plugin package, or step into a build
output directory (such as `dist/<id>`) and pick the `plugin.json` inside it. (One dialog, because a native file
dialog on Windows/Linux cannot select files and folders at the same time.)

| Plugin | Directory | id | Description |
| --- | --- | --- | --- |
| Task Planner | `plugins/task-planner` | `task-planner` | Task tree, Gantt chart and list view with dependencies, plus a `manage_planner` tool for the AI assistant |
| Music Player | `plugins/music-player` | `music-player` | Playlists, tracks, cover art, mini player and a bottom-bar entry, plus a `manage_music` tool for the AI assistant |

## What a plugin package looks like

Every plugin is built into a small directory (`dist/<id>/`) plus a zip that is uploaded as a Release asset:

```
plugin.json      manifest (generated from manifest.ts: id, name, version, routes, menu, entry)
main.cjs         main-process entry (CJS, exports install(ctx))
renderer.mjs     renderer entry (ESM, loaded by the host through a blob import)
chunk-*.mjs      on-demand renderer chunks (lazily loaded views, etc.)
```

**A plugin package never contains a second copy of React / PGlite / antd.** At build time the `@host/**`
specifiers in the source are rewritten into host runtime calls (main process: `globalThis.__RB_HOST_RESOLVE__`;
renderer: the `plugin://host/ui.js` bridge), so at runtime RytenBench injects its own instances — a single
copy of every dependency, and the host's theme and i18n stay in sync.

The exact contract surface is documented in RytenBench's `src/plugins/PACKAGING.md`; this repository declares
those APIs in `host.d.ts`.

## Development

```bash
npm install
npm run build        # writes dist/<id>/ and dist/<id>-<version>.zip, then refreshes plugins.json
npm run build:dev    # unminified + inline sourcemaps (local debugging, much larger output)
npm run typecheck    # tsc --noEmit (host.d.ts declares the host API)
```

To debug the whole download → install → load chain without touching GitHub, serve the same layout locally:

```bash
npm run build
npm run fixture      # http://127.0.0.1:8799 serves plugins.json and the zips
# then point RytenBench at it (app-side env: RB_PLUGINS_REPO=http://127.0.0.1:8799)
```

## Releasing

Push a tag (see `.github/workflows/release.yml`):

```bash
git tag v0.1.0 && git push origin v0.1.0
```

CI runs `npm install` → `node scripts/build.mjs --tag v0.1.0` → creates the Release and uploads `dist/*.zip`
→ commits the tag-aware `plugins.json` back to `main`.

**How the index and the app relate.** The app only reads `plugins.json` from the `main` branch (no GitHub API,
no token). It downloads each plugin from `releases/download/<tag>/<asset>` and verifies the `sha256` from the
index. When the index has **no** `tag`, the app falls back to `releases/latest/download/<asset>` — GitHub's
"latest release" path, not `releases/download/latest/<asset>`, which would 404 — so a locally built untagged
index still works.

The index and the Release must always be in sync (that is exactly what CI does); when you publish by hand,
remember to update `plugins.json` too.

Two footnotes that follow from that:

- **Builds are not byte-reproducible.** The zip embeds entry timestamps, so two builds of the same source
  produce the same file sizes but different `sha256` values. Never commit a `plugins.json` that came from a
  different build than the assets you uploaded — otherwise the app will reject the download as a checksum
  mismatch. If a local `npm run build` rewrites `plugins.json`, discard that change (`git restore plugins.json`)
  unless you are publishing exactly those local zips.
- **The fixture server recomputes `size`/`sha256`** from your local `dist/` zips, precisely so that offline
  testing keeps working while `plugins.json` in the repository stays the CI-generated, Release-matching one.
  It also drops `tag`, because in fixture mode the index and the assets are served from the same origin.

## Repository layout

```
plugins/<id>/manifest.ts          manifest (single source of truth: id, name, version, routes, menu)
plugins/<id>/main/index.ts        main-process entry: install(ctx) (IPC handlers, AI tool contributions, purge)
plugins/<id>/main/db/             plugin-owned tables: schema.ts (drizzle table objects) + ddl.ts (idempotent DDL)
plugins/<id>/main/ipc.ts          this plugin's IPC channels (`plugin:<id>:*`)
plugins/<id>/renderer/plugin.tsx  renderer entry: routes / menu / settings page / providers / bottom bar
plugins/<id>/locales/             the plugin's own strings (including its sidebar caption — the host shell.* keys are not reused)
plugins/<id>/types/               local copies of the host contract types (plugin contract + the settings fields used)
```

Two hard rules:

1. **The plugin owns its tables.** `main/db/ddl.ts` creates them idempotently at load time
   (`CREATE TABLE IF NOT EXISTS`); the host's drizzle migrations do not contain them, and both the mapper and
   the purge routine `await schemaReady` first. Uninstalling a plugin therefore never drops tables, and
   reinstalling keeps the data (upgrades and pre-existing databases are just as safe).
2. **Touch only your own data.** User data lives in the host database; a plugin only deletes the rows it
   created and the directories it manages. Its `plugin.purge` contribution spells out what will be removed,
   and the host renders that text in the uninstall confirmation dialog.

## License

MIT — see [LICENSE](./LICENSE).
