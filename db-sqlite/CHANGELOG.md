# Changelog

All notable changes to the `db-sqlite` extension. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and versions follow [Semantic Versioning](https://semver.org/); releases are tagged `db-sqlite@<version>`.

## [Unreleased]

## [1.0.0] - 2026-11-12

### Added
- **SQLite engine for the Database section** (Kelbo 2.30, Node 22.13 or later): a connection is a `.sqlite`/`.db` file, with a path relative to the folder of the linked project (it can't leave it) or absolute; read-only connections open the file read-only. Built on Node's `node:sqlite`: nothing native to compile, and the real file is read and written, so the application's changes are seen at once. The main database and the `ATTACH`ed ones in the tree; queries with the origin of the columns (editable results), data browser, export (the original `CREATE TABLE` of the file), MCP reads in a transaction rolled back.
- **Table designer that works around `ALTER TABLE`**: renames, new and dropped columns are plain `ALTER TABLE`s; a change of type, NULL, default or keys rebuilds the table as SQLite recommends — new table, copy of the data, old one dropped, new one renamed, indexes recreated, `foreign_key_check` — in one transaction with foreign keys suspended, shown in full before it runs.
- **Safety as for the other engines**: `PRAGMA` is a read only when it queries one of the pragmas that change nothing; `ATTACH`, `VACUUM`, `REPLACE`, `load_extension()` and writing pragmas ask for confirmation.
