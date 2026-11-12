# Changelog

All notable changes to the `db-oracle` extension. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and versions follow [Semantic Versioning](https://semver.org/); releases are tagged `db-oracle@<version>`.

## [Unreleased]

## [1.0.0] - 2026-11-12

### Added
- **Oracle Database engine for the Database section** (Kelbo 2.30): user and password, direct or through an SSH tunnel, the database given as a service name (`FREEPDB1`, `ORCLPDB1`…) or as a SID; the **schemas** (the users that aren't Oracle's own) in the tree, the connected user first, set as `CURRENT_SCHEMA`; SQL editor with Oracle highlighting, several statements, `?`/`:name` parameters, `q'[…]'` strings and **PL/SQL blocks** (`BEGIN`, `DECLARE`, `CREATE OR REPLACE PROCEDURE|FUNCTION|PACKAGE|TRIGGER|TYPE`) ended by a line with only `/`, as in SQL*Plus; data browser with `OFFSET … FETCH` pages, case-insensitive search, filters, inline edit, multiple deletion; export as CSV, JSON or SQL; *CREATE statement* from `DBMS_METADATA` without the storage attributes; table designer (Oracle types, identity columns, defaults, indexes, foreign keys with `ON DELETE CASCADE`/`SET NULL`, comments) and migrations, with `MODIFY` repeating only what changed; MCP reads in a `READ ONLY` transaction always rolled back.
- **Safety as for MySQL**: only recognised reads run without confirmation; PL/SQL blocks, `MERGE`, `SELECT … FOR UPDATE`, `SELECT … INTO` and `NEXTVAL` ask for confirmation.
- Driver `oracledb` in **Thin mode** (pure JavaScript, no Instant Client): rows read up to the limit, dates and timestamps as text, `CLOB` as text, `BLOB`/`RAW` in hexadecimal. Oracle's DDL commits on its own, so a migration is atomic only for the data statements.
