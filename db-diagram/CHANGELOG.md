# Changelog

All notable changes to the `db-diagram` extension. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and versions follow [Semantic Versioning](https://semver.org/); releases are tagged `db-diagram@<version>`.

## [Unreleased]

## [1.1.0] - 2026-11-15

### Changed
- **Automatic layout by relations**: tables are grouped by their relations (each group is a set of connected tables) with the table having most relations at the centre of its group and the others around it by distance; tables without relations go on the outer edges of the diagram, spread over the four sides.
- **Fewer crossings**: the order of the tables around the centre is chosen to keep relations from crossing (barycentre sweeps, then swaps and rotations kept only when they help), then refined with forces (relations pull, tables push each other away, tables with more relations pulled towards the centre) and swaps of positions; the score weighs crossings first, then relations passing over a table, then the total length. Tables never overlap.
- Relations leave each table from the side that gives the shortest path (both from the same side, as an arc, for tables one above the other), and lines that go out of the tables stay inside the drawing and the exports.

### Added
- **Legend**: solid line (required relation: the foreign key cannot be `NULL`), dashed line (optional relation: it can be `NULL`), the "many" and "one" sides, PK, FK and views — as a panel in the corner of the diagram, shown or hidden with *Legend*, and at the bottom of the PDF, SVG and PNG exports.

## [1.0.0] - 2026-11-14

### Added
- **ER diagram**, the first **add-on** of the Database section (Kelbo 2.38, Database 1.1 or later): *ER diagram* in the menu of a database of the tree opens the diagram in a tab of the section, next to the query tabs; *Show in the ER diagram* on a table opens it on that table and the related ones. Every engine works (MySQL/MariaDB, PostgreSQL, SQL Server, SQLite, Oracle), through the schema the Database section reads.
- Tables with their columns and types, **PK** and **FK** marked, views in another colour; relations from the foreign key column to the referenced one with crow's foot notation (many on the side of the foreign key, one on the referenced side), dashed when the foreign key can be `NULL`, a loop for references to the same table; hovering or selecting a table highlights its relations.
- **Automatic layout** (referenced tables on the left, tall columns split), tables **dragged** by hand with the positions saved per connection and database in `config.json` (`dbDiagrams`, with an *Export* checkbox), *Rearrange* back to the automatic layout.
- Filter by name, **only one table and the related ones** (from the menu of a table, in the tree or in the diagram), all columns / keys only / names only, zoom (also Ctrl + wheel) and fit to the window; double click on a table opens its data.
- **Export** of the tables shown to **PDF** (vector, one page as large as the diagram, with title, connection and date; written without libraries with the standard Helvetica fonts), **SVG** and high-resolution **PNG**, on a white background.
