# Changelog

All notable changes to the `swagger` extension. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and versions follow [Semantic Versioning](https://semver.org/); releases are tagged `swagger@<version>`.

## [Unreleased]

## [1.1.0] - 2026-11-06

### Changed
- **Lucide icons instead of emoji** (Kelbo 2.25): the tab, the buttons, menus, badges and the dashboard widget use the icons bundled in the Kelbo core, coloured like the text around them; the manifest `icon` is a Lucide name. Requires Kelbo 2.25 or later.

### Changed
- Manifest field `"kelbo"` (the new name of DevDock) next to `"devdock"`, with the same range.

## [1.0.0] - 2026-10-24

### Changed
- Moved out of DevDock, where it was a built-in extension up to 2.0: same features (preview of an OpenAPI `.yaml`/`.json` file loaded from disk, with Swagger UI from the CDN).
- Requires DevDock 2.0 or later (`"devdock": "^2.0"`); install it from the DevDock Extensions panel (🧩) or with `npm run ext -- install swagger`.
