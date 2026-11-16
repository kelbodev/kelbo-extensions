# Changelog

All notable changes to the `terminal` extension. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and versions follow [Semantic Versioning](https://semver.org/); releases are tagged `terminal@<version>`.

## [Unreleased]

### Fixed
- **Run in shell** starts the tunnels linked to the project first, as **Run** of the NPM section does (NPM ≥ 1.2); a tunnel that does not start is reported and the script runs anyway.

## [1.1.0] - 2026-11-15

### Added
- **Run in shell** on every script of the NPM section (`npm install` too): opens a terminal in the project folder and runs `npm run <script>` there, where you can answer prompts, stop it with Ctrl+C and run it again with ↑. The Terminal is an *optional add-on* of NPM (Kelbo ≥ 2.39, NPM ≥ 1.1): without the NPM section it works as before, only the button is missing.

## [1.0.1] - 2026-11-15

### Fixed
- "Home folder" in the sidebar answered "Unknown project" instead of opening a terminal in the home folder.

## [1.0.0] - 2026-11-15

### Added
- **Integrated terminal**: real shells in a pseudo-terminal (`@lydell/node-pty`, the node-pty of VS Code with binaries already built for macOS, Linux and Windows on x64 and arm64: nothing to compile) shown with xterm.js — colours, cursor, full-screen programs (`vim`, `htop`, `top`), mouse and resizing that follows the panel.
- A terminal in the folder of a project from the sidebar (or in the home folder), several sessions in tabs, renamed with a double click; the shell is chosen among those installed (the user's shell first: zsh, bash, fish, PowerShell, cmd, Git Bash).
- Sessions keep running while Kelbo runs: reloading the page, or opening another window, reconnects to them with their recent output. They are listed among what stops when Kelbo restarts for an update.
- Colours from the Kelbo theme (`--terminal-*` and `--ansi-*`), followed when the theme changes; text size remembered; Ctrl+Shift+C / Ctrl+Shift+V to copy and paste on Linux and Windows.
- Other extensions can open a terminal with `ctx.open('terminal', { project, command })`: a shell in the project that runs the command as soon as it is ready.
- xterm.js is served by the extension itself (no CDN), so the terminal works offline too.
