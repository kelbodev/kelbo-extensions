# Changelog

All notable changes to the `script` extension. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and versions follow [Semantic Versioning](https://semver.org/); releases are tagged `script@<version>`.

## [Unreleased]

## [1.4.0] - 2026-11-09

### Changed
- **Follows the color theme** (Kelbo 2.26): the TypeScript/Node badge and the text of the Run button use the core's theme variables instead of fixed colors, so they read well with *Kelbo Light*, *Kelbo Dim* or any other theme. Requires Kelbo 2.26 or later.

## [1.3.0] - 2026-11-06

### Changed
- **Lucide icons instead of emoji** (Kelbo 2.25): the tab, the buttons, menus, badges and the dashboard widget use the icons bundled in the Kelbo core, coloured like the text around them; the manifest `icon` is a Lucide name. Requires Kelbo 2.25 or later.

## [1.2.0] - 2026-11-02

### Added
- **Prescripts in fish** when it is the user's shell (`$SHELL`): run with `fish -c`, which also loads `config.fish` (nvm.fish, fnm…); the script starts when the prescript's last command succeeds (fish has no `set -e`: chain with `and`), its arguments reach fish as `$argv`.

## [1.1.0] - 2026-11-02

### Added
- **Prescript**: shell commands run before a script (`$_` on its row) or before every script of the project (**$_ Prescript** in the header; a script's own prescript replaces the project's). They run in the same shell as the script — the user's bash or zsh on macOS and Linux, `cmd` on Windows — in the project folder, so exported variables, `nvm use` or `cd` apply to the script too; if a command fails the script doesn't start. The script and its arguments reach the shell as `"$@"`, never inside the command text. Rows show which prescript applies.
- **Prescripts encrypted with the master password**, since they can hold tokens: `config.json` (section `scriptPrescripts`) keeps one vault box per project, re-encrypted when the master password changes, lost on a vault reset; *Script prescripts* export checkbox (with the vault). With the vault locked the rows show 🔒 and running a script of a project with prescripts asks for the master password. The prescript text never goes into the output (it shows `(prescript) &&`) nor into the MCP tools.
- The 📁 Projects panel lists a project's prescripts before it is removed.

### Fixed
- **Projects with a scripts folder but no runnable script** got the *Scripts* trait: with Kelbo 2.19 the extension confirms the trait only when the folder holds a script that can run on this computer (`detect`); Kelbo 2.18 still uses the folder alone.

## [1.0.0] - 2026-11-02

### Added
- **Scripts section**: the projects with a scripts folder — `bin`, `script`, `scripts`, `local-scripts`, `local_scripts`, `dev-scripts`, `tools`, `tasks`, `.scripts` (project trait `scripts`, Kelbo 2.18) — and their scripts, grouped by folder (two levels deep), with filter.
- **Interpreter by file type and operating system**: `.js`/`.mjs`/`.cjs` with Kelbo's Node; `.ts`/`.mts`/`.cts` with the project's `tsx` when installed, otherwise Node with the types stripped; `.sh`/`.bash` with bash, `.zsh` with zsh; `.ps1` with PowerShell (`pwsh` on macOS/Linux); `.bat`/`.cmd` on Windows only; files without extension through their `#!` line (macOS/Linux). Files that can't run on this system are not listed; those whose interpreter is missing are shown disabled with the reason.
- **Run like npm scripts**: tracked processes in their own process group, started in the project folder; output live in the bottom panel; stop (the whole process tree), restart with the same arguments, remove from the list once exited; header pills for the running ones and a badge on the tab.
- **Arguments**: ▶… runs a script with arguments (quotes for arguments with spaces), remembered per script in the browser; they are passed as they are, without a shell.
- Only scripts found in the scripts folders can run, and a symbolic link pointing outside the project is refused.
- MCP tools: `script_list`, `script_processes`, `script_output` (read-only), `script_run`, `script_stop`.
