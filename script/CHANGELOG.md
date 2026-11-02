# Changelog

All notable changes to the `script` extension. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and versions follow [Semantic Versioning](https://semver.org/); releases are tagged `script@<version>`.

## [Unreleased]

### Added
- **Scripts section**: the projects with a scripts folder — `bin`, `script`, `scripts`, `local-scripts`, `local_scripts`, `dev-scripts`, `tools`, `tasks`, `.scripts` (project trait `scripts`, Kelbo 2.18) — and their scripts, grouped by folder (two levels deep), with filter.
- **Interpreter by file type and operating system**: `.js`/`.mjs`/`.cjs` with Kelbo's Node; `.ts`/`.mts`/`.cts` with the project's `tsx` when installed, otherwise Node with the types stripped; `.sh`/`.bash` with bash, `.zsh` with zsh; `.ps1` with PowerShell (`pwsh` on macOS/Linux); `.bat`/`.cmd` on Windows only; files without extension through their `#!` line (macOS/Linux). Files that can't run on this system are not listed; those whose interpreter is missing are shown disabled with the reason.
- **Run like npm scripts**: tracked processes in their own process group, started in the project folder; output live in the bottom panel; stop (the whole process tree), restart with the same arguments, remove from the list once exited; header pills for the running ones and a badge on the tab.
- **Arguments**: ▶… runs a script with arguments (quotes for arguments with spaces), remembered per script in the browser; they are passed as they are, without a shell.
- Only scripts found in the scripts folders can run, and a symbolic link pointing outside the project is refused.
- MCP tools: `script_list`, `script_processes`, `script_output` (read-only), `script_run`, `script_stop`.
