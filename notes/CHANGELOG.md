# Changelog

All notable changes to the `notes` extension. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and versions follow [Semantic Versioning](https://semver.org/); releases are tagged `notes@<version>`.

## [Unreleased]

## [1.7.1] - 2026-11-09

### Fixed
- The board's top bar no longer covers Kelbo's menus and pop-ups (context menus, the theme and language menus): the cards keep their stacking order inside the board, and the bar only needs to stay above them.

## [1.7.0] - 2026-11-09

### Changed
- **Follows the color theme** (Kelbo 2.26): sticky note colours, shadows and the colour dots use the core's theme variables instead of fixed colors, so they read well with *Kelbo Light*, *Kelbo Dim* or any other theme. Requires Kelbo 2.26 or later.

## [1.6.0] - 2026-11-06

### Changed
- **Lucide icons instead of emoji** (Kelbo 2.25): the tab, the buttons, menus, badges and the dashboard widget use the icons bundled in the Kelbo core, coloured like the text around them; the manifest `icon` is a Lucide name. Requires Kelbo 2.25 or later.

## [1.5.0] - 2026-11-01

### Added
- A project's board is listed in Kelbo's 📁 Projects panel before the project is removed (`projectLinks`, Kelbo ≥ 2.18; ignored by older versions).

## [1.4.0] - 2026-11-01

### Added
- **Dashboard widget** (Kelbo 2.17, M4.6): open items of the project's lists (check them, add one with Enter, the completion of each list) and the last notes changed; ↗ opens the project's board. Encrypted like the section: with the vault locked the widget asks to unlock it.

### Changed
- Manifest field `"kelbo"` (the new name of DevDock) next to `"devdock"`, with the same range.

## [1.3.0] - 2026-10-27

### Added
- **Completion of the lists**: the head of each list shows the percentage of done items (with *3 of 4 done* as tooltip) and a progress bar under it.
- **Note titles**: each note has an optional title above its text (Enter moves to the text), saved automatically with it.

### Fixed
- A new list or note is placed in the first free space of the visible part of the board instead of on top of the cards already there.

## [1.2.0] - 2026-10-27

### Changed
- **Free board**: lists and notes are no longer in two separate grids: they stay together on one board where each one is placed freely, dragged from its top bar (⠿ on lists, the band on notes) to any position, on a 10 px step. The board grows as cards are moved further right or down; cards can overlap, the last one moved stays on top.
- Lists can be made wider or narrower from their bottom-right corner (their height follows the items); notes are resized freely in width and height. A double click on the corner gives back the initial size.
- Position, size and stacking order are saved with the card, encrypted like the rest. Boards saved by 1.0 and 1.1 get an initial layout (rows of four, lists first), and notes made wider in columns keep their width in pixels.
- New lists and notes appear at the top left of the visible part of the board. *Move before* / *Move after* in the list menu are gone (lists are dragged).

## [1.1.0] - 2026-10-27

### Added
- **Resizable notes**: drag the bottom-right corner of a note to make it wider (1 to 3 columns of the grid, never more than the panel has) and taller or shorter; the size is saved with the note (encrypted like the rest) and a double click on the corner brings it back to the normal size.

### Fixed
- The summary next to the board name no longer says "0 to do of 0" when the board has only notes.

## [1.0.0] - 2026-10-27

### Added
- **Boards**: one per project of Kelbo plus *General*, in the sidebar with the projects' folders and the number of open items; boards of projects removed from Kelbo are kept under *Removed projects*. The tab badge counts the open items of every board.
- **To-do lists**: several per board, each with a name (edited in place) and items to check; add with Enter, edit in place (Enter saves, Esc cancels), check/uncheck, delete, reorder by dragging (⋮⋮); done items go under the open ones, struck through with when they were done, and *Clear done* removes them; lists are moved before/after or deleted from their ⋯ menu.
- **Notes**: sticky notes in a grid, free text saved automatically a moment after the last keystroke, six colours, delete; a note changed elsewhere in the meantime is not overwritten.
- **Encrypted with the master password**: the content of each board (list names, items, notes) is one box encrypted by Kelbo's vault in `notesBoards`; with the vault locked the section shows only *Unlock* and every route answers `423`. Changing the master password re-encrypts it; resetting it deletes it. Export/Import checkbox *Note e to-do*, with the content still encrypted.
