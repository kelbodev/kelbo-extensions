# Changelog

All notable changes to the `pm2` extension. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and versions follow [Semantic Versioning](https://semver.org/); releases are tagged `pm2@<version>`.

## [Unreleased]

## [1.1.0] - 2026-11-06

### Changed
- **Lucide icons instead of emoji** (Kelbo 2.25): the tab, the buttons, menus, badges and the dashboard widget use the icons bundled in the Kelbo core, coloured like the text around them; the manifest `icon` is a Lucide name. Requires Kelbo 2.25 or later.

### Changed
- Manifest field `"kelbo"` (the new name of DevDock) next to `"devdock"`, with the same range.

## [1.0.0] - 2026-10-24

### Changed
- Moved out of DevDock, where it was a built-in extension up to 1.23: same features (PM2 process list, start/stop/restart/delete, streaming logs, npm scripts started under PM2 from the NPM section, MCP tools `pm2_list` and `pm2_logs`).
- Requires DevDock 2.0 or later (`"devdock": "^2.0"`); install it from the DevDock Extensions panel (🧩) or with `npm run ext -- install pm2`.
