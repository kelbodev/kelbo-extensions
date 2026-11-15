# Changelog

All notable changes to the `terminal` extension. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and versions follow [Semantic Versioning](https://semver.org/); releases are tagged `terminal@<version>`.

## [Unreleased]

## [1.0.0] - 2026-11-15

### Added
- **Integrated terminal**: real shells in a pseudo-terminal (`@lydell/node-pty`, the node-pty of VS Code with binaries already built for macOS, Linux and Windows on x64 and arm64: nothing to compile) shown with xterm.js — colours, cursor, full-screen programs (`vim`, `htop`, `top`), mouse and resizing that follows the panel.
- A terminal in the folder of a project from the sidebar (or in the home folder), several sessions in tabs, renamed with a double click; the shell is chosen among those installed (the user's shell first: zsh, bash, fish, PowerShell, cmd, Git Bash).
- Sessions keep running while Kelbo runs: reloading the page, or opening another window, reconnects to them with their recent output. They are listed among what stops when Kelbo restarts for an update.
- Colours from the Kelbo theme (`--terminal-*` and `--ansi-*`), followed when the theme changes; text size remembered; Ctrl+Shift+C / Ctrl+Shift+V to copy and paste on Linux and Windows.
- Other extensions can open a terminal with `ctx.open('terminal', { project, command })`: a shell in the project that runs the command as soon as it is ready.
- xterm.js is served by the extension itself (no CDN), so the terminal works offline too.
