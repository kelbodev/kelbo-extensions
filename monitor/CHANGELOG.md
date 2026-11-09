# Changelog

All notable changes to the `monitor` extension. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and versions follow [Semantic Versioning](https://semver.org/); releases are tagged `monitor@<version>`.

## [Unreleased]

## [1.0.0] - 2026-11-09

### Added
- **Output side by side.** The sidebar lists the processes of the NPM section and of the Scripts extension, grouped by project; ticking one opens its pane, *show every running process* opens them all. Each pane follows the live output (ANSI colours, history first), shows status, uptime and ports, and has **restart**, **stop**, **run again** (after it exited or was stopped), clear, maximize and close. Layout: automatic or one, two, three columns.
- A pane is tied to *source + project + script*, not to one process: running the same script again shows the new process in the same pane. The chosen panes and the layout are remembered by the browser.
- Frontend only: it uses the APIs the `npm` and `script` extensions already have, and works with either of them. Requires Kelbo 2.28.1 or later.
