# Changelog

All notable changes to the `monitor` extension. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and versions follow [Semantic Versioning](https://semver.org/); releases are tagged `monitor@<version>`.

## [Unreleased]

### Changed
- **Save** is enabled with open panes and no layout chosen too: it asks for a name and creates the layout. With a layout chosen it saves its changes, and it is disabled only when there is nothing to save (the tooltip says why).

### Fixed
- **Automatic scroll of the panes.** A pane at the bottom follows the output, also after switching section, maximizing a pane or changing the grid (the panes were moved in the page at every refresh, every 3 seconds, and came back scrolled to the top). Scrolled up, it stays where it was left, also across section switches, and follows again as soon as it is brought back to the bottom.

## [1.1.0] - 2026-11-09

### Added
- **Saved layouts.** The grid and its panes, each with its script (project, npm script or script with its arguments), saved by name in `config.json` (`monitorLayouts`, validated, Export/Import checkbox *Layout del Monitor*), so they travel with the export. Pick one from the toolbar to bring back its panes; **Start** runs the scripts of the panes that are not running. *Save* updates the chosen layout (a • marks unsaved changes), *save as* creates a new one, the bin deletes it.

### Changed
- **Grid: 1, 2 or 3 columns, or 2×2** (two columns and two rows, beyond the fourth pane it scrolls) instead of the automatic layout.
- Panes without a process show the project name, not its id.

## [1.0.0] - 2026-11-09

### Added
- **Output side by side.** The sidebar lists the processes of the NPM section and of the Scripts extension, grouped by project; ticking one opens its pane, *show every running process* opens them all. Each pane follows the live output (ANSI colours, history first), shows status, uptime and ports, and has **restart**, **stop**, **run again** (after it exited or was stopped), clear, maximize and close. Layout: automatic or one, two, three columns.
- A pane is tied to *source + project + script*, not to one process: running the same script again shows the new process in the same pane. The chosen panes and the layout are remembered by the browser.
- Frontend only: it uses the APIs the `npm` and `script` extensions already have, and works with either of them. Requires Kelbo 2.28.1 or later.
