# Changelog

All notable changes to the `ports` extension. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and versions follow [Semantic Versioning](https://semver.org/); releases are tagged `ports@<version>`.

## [Unreleased]

## [1.2.0] - 2026-11-06

### Changed
- **Lucide icons instead of emoji** (Kelbo 2.25): the tab, the buttons, menus, badges and the dashboard widget use the icons bundled in the Kelbo core, coloured like the text around them; the manifest `icon` is a Lucide name. Requires Kelbo 2.25 or later.

## [1.1.0] - 2026-11-01

### Added
- **Dashboard widget** (Kelbo 2.17): *Ports in use* of the project's npm processes, with stop; the npm owner of a port carries the project id (`owner.projectId`) when Kelbo gives it.

## [1.0.1] - 2026-10-28

### Changed
- Kelbo, the new name of DevDock: texts and MCP description say Kelbo; the owner type of Kelbo's own process is `kelbo` (was `devdock`) in the API and in the `ports_list` MCP tool; manifest field `"kelbo"` next to `"devdock"`.

## [1.0.0] - 2026-10-24

### Changed
- Moved out of DevDock, where it was a built-in extension up to 1.23: same features (listening TCP ports with their process, links to npm scripts, PM2 processes and SSH tunnels, stop and force stop, MCP tool `ports_list`).
- Requires DevDock 2.0 or later (`"devdock": "^2.0"`); install it from the DevDock Extensions panel (🧩) or with `npm run ext -- install ports`.
