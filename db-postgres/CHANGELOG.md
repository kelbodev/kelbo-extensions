# Changelog

All notable changes to the `db-postgres` extension. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and versions follow [Semantic Versioning](https://semver.org/); releases are tagged `db-postgres@<version>`.

## [Unreleased]

## [1.0.0] - 2026-11-12

### Added
- **PostgreSQL engine for the Database section** (Kelbo 2.30): connections direct or through an SSH tunnel, with the database of the connection and its **schemas** in the tree (connection ▸ schema ▸ tables ▸ columns, `public` first); SQL editor with PostgreSQL highlighting and completion, several statements, `?` and `:name` parameters; data browser with search, filters, sorting, inline edit and multiple deletion; export as CSV, JSON or SQL (with the structure rebuilt from the catalog); table designer (types of PostgreSQL, identity columns, indexes, foreign keys, comments) and migrations; MCP reads in a read-only transaction.
- **Safety as for MySQL**: only recognised reads run without confirmation. Classification knows dollar quoting, `E''` strings and `::` casts; `SELECT … INTO`, row locks, data-modifying CTEs and functions with side effects (`nextval`, `setval`, `pg_terminate_backend`, `dblink_exec`, …) ask for confirmation. Read-only connections set `default_transaction_read_only` on the server too.
- Driver `pg` with `pg-cursor`: rows read up to the limit, dates and times as text, `bytea` in hexadecimal, arrays and JSON as JSON.
