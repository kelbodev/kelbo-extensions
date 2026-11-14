# Changelog

All notable changes to the `db-diagram` extension. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and versions follow [Semantic Versioning](https://semver.org/); releases are tagged `db-diagram@<version>`.

## [Unreleased]

## [1.0.0] - 2026-11-14

### Added
- **ER diagram**, the first **add-on** of the Database section (Kelbo 2.38, Database 1.1 or later): *ER diagram* in the menu of a database of the tree opens the diagram in a tab of the section, next to the query tabs; *Show in the ER diagram* on a table opens it on that table and the related ones. Every engine works (MySQL/MariaDB, PostgreSQL, SQL Server, SQLite, Oracle), through the schema the Database section reads.
- Tables with their columns and types, **PK** and **FK** marked, views in another colour; relations from the foreign key column to the referenced one with crow's foot notation (many on the side of the foreign key, one on the referenced side), dashed when the foreign key can be `NULL`, a loop for references to the same table; hovering or selecting a table highlights its relations.
- **Automatic layout** (referenced tables on the left, tall columns split), tables **dragged** by hand with the positions saved per connection and database in `config.json` (`dbDiagrams`, with an *Export* checkbox), *Rearrange* back to the automatic layout.
- Filter by name, **only one table and the related ones** (from the menu of a table, in the tree or in the diagram), all columns / keys only / names only, zoom (also Ctrl + wheel) and fit to the window; double click on a table opens its data.
- **Export** of the tables shown to **PDF** (vector, one page as large as the diagram, with title, connection and date; written without libraries with the standard Helvetica fonts), **SVG** and high-resolution **PNG**, on a white background.
