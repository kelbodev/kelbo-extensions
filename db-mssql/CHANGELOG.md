# Changelog

All notable changes to the `db-mssql` extension. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and versions follow [Semantic Versioning](https://semver.org/); releases are tagged `db-mssql@<version>`.

## [Unreleased]

## [1.0.0] - 2026-11-12

### Added
- **Microsoft SQL Server engine for the Database section** (Kelbo 2.30): SQL authentication, direct or through an SSH tunnel, with the options *encrypted connection* and *trust the server's certificate* (Docker and local servers); the database of the connection and its **schemas** in the tree (`dbo` first); SQL editor with T-SQL highlighting, several statements, `?`/`:name` parameters; data browser with `OFFSET … FETCH` pages, search, filters, inline edit (`UPDATE TOP (1)`), multiple deletion; export as CSV, JSON or SQL with the structure rebuilt from `sys.*`; table designer (types of SQL Server, `IDENTITY`, named default constraints, indexes, foreign keys, comments as `MS_Description`) and migrations, with `sp_rename` for renames; MCP reads in a transaction always rolled back.
- **Safety as for MySQL**: only recognised reads run without confirmation; `[brackets]` and `N''` strings are understood, `SELECT … INTO`, lock hints (`UPDLOCK`, `XLOCK`…), `OPENROWSET`/`OPENQUERY` and `NEXT VALUE FOR` ask for confirmation, `GO` is refused with a clear message (it separates batches in SQL Server tools, it isn't T-SQL).
- Driver `mssql` (tedious, pure JavaScript): rows read up to the limit, dates as text, `varbinary` in hexadecimal.
