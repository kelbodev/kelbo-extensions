# Kelbo extensions

Official extensions for [Kelbo](https://github.com/kelbodev/kelbo), the local developer dashboard. Each folder is one extension; `index.json` is the official catalog that the Kelbo **Extensions** panel (🧩) reads by default.

| Extension | Folder | What it does |
|---|---|---|
| ⚙️ PM2 | [`pm2`](pm2) | PM2 processes: list, start/stop/restart/delete, streaming logs; npm scripts started under PM2 from the NPM section |
| 🔌 Ports | [`ports`](ports) | Listening TCP ports with their process, linked to what Kelbo started (npm, PM2, tunnels); stop of the process that holds a port |
| 🍃 MongoDB | [`mongo-client`](mongo-client) | MongoDB client with the features of the Kelbo Database section: connections (host, URI or SSH tunnel) in folders with passwords in the Kelbo vault, mongosh editor with history, documents as JSON or table with inline edit, every change shown and confirmed, collections and indexes designer, structure, export as JSON/CSV/script, read-only MCP tools |
| 📜 Scripts | [`script`](script) | Scripts of the projects' `bin`, `scripts`, `tools`… folders (JavaScript, TypeScript, shell, PowerShell, `#!` files) run as tracked processes like npm scripts: live output in the bottom panel, stop, restart, arguments (Kelbo 2.18 or later) |
| 📝 Notes | [`notes`](notes) | To-do lists and sticky notes per project (plus *General*), encrypted with the master password, placed and resized freely on one board: lists of items to check, reorderable, with the open items on the tab; coloured notes saved automatically |
| 📄 Swagger | [`swagger`](swagger) | Preview of an OpenAPI `.yaml`/`.json` file loaded from disk (Swagger UI from CDN) |
| 🐘 PostgreSQL | [`db-postgres`](db-postgres) | PostgreSQL engine for the Database section: schemas, queries, data, table designer, migrations (Kelbo 2.30 or later) |
| 🗄️ SQL Server | [`db-mssql`](db-mssql) | Microsoft SQL Server engine for the Database section: schemas, queries, data, table designer, migrations (Kelbo 2.30 or later) |
| 🪶 SQLite | [`db-sqlite`](db-sqlite) | SQLite engine for the Database section: `.sqlite`/`.db` files of the projects, queries, data, table designer, migrations (Kelbo 2.30 and Node 22.13 or later) |
| 🏛️ Oracle | [`db-oracle`](db-oracle) | Oracle Database engine for the Database section: schemas, queries and PL/SQL blocks, data, table designer, migrations (Thin mode, no Instant Client; Kelbo 2.30 or later) |
| 🅰️ Angular CLI | [`angular-cli`](angular-cli) | Angular CLI generators of the Angular workspaces with a form from their options and a preview of the files before writing them; `ng add`, `ng update`, dashboard widget, MCP tools (Kelbo 2.31 or later) |
| 🖥️ Monitor | [`monitor`](monitor) | Output of several npm scripts and scripts of the Scripts extension side by side (1, 2, 3 columns or 2×2), each with restart, stop and run again; layouts saved with their scripts (Kelbo 2.28.1 or later) |
| ☀️ Light theme | [`theme-light`](theme-light) | *Kelbo Light*: light background and dark text for the whole interface, extensions included (Kelbo 2.26 or later) |
| 🌙 Dim theme | [`theme-dim`](theme-dim) | *Kelbo Dim*: a softer dark theme, slate grey instead of near-black, with less saturated colors (Kelbo 2.26 or later) |

PM2 and Ports were built into Kelbo up to 1.23, Swagger up to 2.0. All of them require Kelbo 2.25 or later (Lucide icons from the core); older Kelbo versions keep the previous releases.

## Install

From Kelbo: 🧩 **Extensions** → **Catalog** → *Install…*, or from the command line in the Kelbo folder:

```bash
npm run ext -- install pm2
npm run ext -- install ports
npm run ext -- install mongo-client
npm run ext -- install swagger
npm run ext -- install notes
npm run ext -- install script
```

Any extension can also be installed by URL (🧩 → **From URL**): `https://github.com/kelbodev/kelbo-extensions.git` with the folder of the extension (`pm2`, `ports`, `mongo-client`, `swagger`, `notes`, `script`).

## Versions

Every extension has its own version, in its `setting.json` and in its `CHANGELOG.md`, and its own git tags with the code as prefix: `pm2@1.0.0`, `ports@1.2.0`. Kelbo proposes the latest tag whose `devdock` range includes the running version, and checks for new tags once a day.

## Development

```bash
npm install          # installs Kelbo (devDependency) with its test kit, and the extensions' packages (npm workspaces)
npm test             # every extension's tests (Kelbo started with the extension installed)
npm run catalog      # rewrites index.json from the manifests
```

The `mongo-client` tests start a real MongoDB with [mongodb-memory-server](https://github.com/typegoose/mongodb-memory-server), which downloads the `mongod` binary on first use (cached in `~/.cache/mongodb-binaries`); without network access to `fastdl.mongodb.org` those tests are skipped.

To try an extension in a running Kelbo while developing it, link its folder into the installed extensions:

```bash
ln -s "$PWD/pm2" ~/.kelbo/extensions/pm2     # then restart Kelbo, or reload it from the 🧩 panel
```

The extension contract (manifest, backend and frontend `ctx`, configuration, translations, test kit) is in Kelbo's [docs/EXTENSIONS.md](https://github.com/kelbodev/kelbo/blob/main/docs/EXTENSIONS.md).

## Adding an extension

1. Create a folder named as the extension `code`, with `setting.json` (`version` and `devdock` are required), the backend and frontend files, `i18n/it.json` and `i18n/en.json`, `CHANGELOG.md` with an `## [Unreleased]` section, and `tests/` (they use `require('kelbo/testkit')`: `startServer(config, { install: [path.join(__dirname, '..')] })` starts Kelbo with the extension installed, `i18nProblems(dir)` checks its translations).
   A theme extension only needs `setting.json` with `themes` and the stylesheet (see *Themes* in Kelbo's docs/EXTENSIONS.md), plus a test that runs `themeProblems(css)` on it — `theme-light` is the example.
2. npm packages used by the extension go in its own `package.json` (`dependencies`), and the folder goes in the `workspaces` of the root `package.json` so that `npm install` makes them available to the tests: an installed extension doesn't see Kelbo's packages. They are installed with `--ignore-scripts`, so packages that need to compile native code at install time can't be used.
3. `npm run catalog` and commit `index.json` (the CI fails when it is out of date).

## Release

```bash
npm run release <code> <patch|minor|major>        # e.g. npm run release pm2 minor
git push origin HEAD <code>@<version>             # or add --push to the command above
```

The script refuses to run with uncommitted changes or an empty `[Unreleased]` section; it bumps the version in `setting.json` (and `package.json`), turns `[Unreleased]` into the new version in `CHANGELOG.md`, regenerates `index.json`, commits and creates the annotated tag `<code>@<version>`.

## License

Copyright 2026 The Kelbo authors. Licensed under the [Apache License, Version 2.0](LICENSE).
