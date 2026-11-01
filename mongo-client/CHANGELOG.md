# Changelog

All notable changes to the `mongo-client` extension. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and versions follow [Semantic Versioning](https://semver.org/); releases are tagged `mongo-client@<version>`.

## [Unreleased]

### Added
- The connections linked to a project are listed in Kelbo's 📁 Projects panel before the project is removed (`projectLinks`, Kelbo ≥ 2.18; ignored by older versions).

## [1.3.0] - 2026-11-01

### Added
- **Project and dashboard widget**: a connection can be linked to a project (Project field, like the Database section); the **MongoDB** widget of the Kelbo project dashboard (Kelbo 2.17) lists the connections of the project with their test (not those through a tunnel, which the test would open) and opens one in the section.

## [1.2.1] - 2026-10-28

### Changed
- Kelbo, the new name of DevDock: texts, MCP tool descriptions and the MongoDB `appName` say Kelbo; package `kelbo-ext-mongo-client`; manifest field `"kelbo"` next to `"devdock"` (same range, read by Kelbo before 2.13).

## [1.2.0] - 2026-10-24

### Changed
- The whole section needs the DevDock master password, like the Database section: while the vault is locked (or not created yet) the sidebar shows *Unlock*, connections and folders cannot be listed, added or imported, and every route answers `423`.

### Fixed
- Clicks lost on the buttons of the results (Save of the edited cells, pages, view switch) when a cell being edited lost the focus: the results are redrawn with DevDock's `ctx.ui.patch` (DevDock 2.3; a plain redraw with older versions), and the double click on cells is handled once on the container.

## [1.1.0] - 2026-10-24

### Added
- Same features as DevDock's Database section (DB client):
  - **Sidebar**: connections grouped in folders (`mongoFolders`, one level: 📁+, rename and delete from ⋯ or right click, Folder field of the connection), tree filter on connections, databases and collections, master password menu (🔒: change, automatic lock, lock now), import of connections from a file exported with another master password (⤒, passwords re-encrypted with yours).
  - **Connection workspace**: header with user@host / database and badges (read-only, no password, missing tunnel), test, edit, delete; active database selector; result limit.
  - **mongosh editor** with highlighting and suggestions (Ctrl+Space: collections, methods, cursor modifiers, `$` operators, shell constructors), run with Ctrl/Cmd+Enter (selection or whole text), session history. Supported: `db.coll.find/findOne/aggregate/countDocuments/estimatedDocumentCount/distinct/getIndexes/stats`, cursor `sort/limit/skip/projection/count/explain/hint/collation`, writes (`insertOne/insertMany/updateOne/updateMany/replaceOne/deleteOne/deleteMany/findOneAnd…/bulkWrite/createIndex(es)/dropIndex(es)/drop/renameCollection`, `$out`/`$merge` aggregations), `db.getCollectionNames/getCollectionInfos/stats/version/runCommand/adminCommand/createCollection/createView/dropDatabase`, `db.getSiblingDB()`, `db.getCollection()`, `show dbs`, `show collections`, `use`. Values in shell syntax (unquoted keys, `'…'` strings, `/regex/i`, `ObjectId()`, `ISODate()`, `NumberLong()`, `NumberDecimal()`, `UUID()`, `Timestamp()`, …), read without running any code. Writes, and `runCommand` outside a list of read commands, are shown with the number of documents the filter matches and run only after confirmation (dropping a collection or a database asks to type its name).
  - **Documents as JSON or Table** (top-level fields as columns, sort by clicking a column); in the table, double click edits a cell (Tab to the next one), objects and arrays open a JSON dialog; changes of several documents are saved together with one confirmation (`bulkWrite` of `$set`). `find`/`findOne` results of the editor can be edited and deleted the same way. **→ Editor** copies the browser's filter, sort and projection as a `find()`.
  - **Export** as JSON, CSV (top-level fields, nested values as JSON) or mongosh script (`insertMany`): whole collection, filtered documents, or the `find`/`aggregate` of the editor.
  - **Collections and indexes**: new collection (and database) with capped size, JSON Schema validator, validation level and action; rename; new index (keys, unique, sparse, TTL, partial filter, name) and drop; drop database. **Structure** of a collection: statistics, schema inferred from a sample of 500 documents (field paths, types, presence), indexes with their size, options.
- MCP tool `mongo_client_aggregate`: read-only aggregation pipelines (`$out`/`$merge` refused), at most 100 documents.

### Changed
- Export route `POST /connections/:id/export` (`format`: `json`, `csv`, `js`; a collection with filter, sort and projection, or a `code` statement) replaces the per-collection one.

## [1.0.0] - 2026-10-24

### Added
- MongoDB connections (section `mongoConnections`): host and port, connection string (`mongodb://`, `mongodb+srv://`) or an SSH tunnel of the Tunnels extension; user, authentication database, default database, TLS, read-only. Passwords are encrypted with the DevDock master password (core vault) and never stored in the URI.
- Sidebar tree connection ▸ database ▸ collections with sizes and estimated counts; context menus to test, refresh, edit and delete connections, open, export and drop collections.
- Document browser: filter, sort and projection as Extended JSON, page size and pages, total count, documents shown in mongosh syntax (`ObjectId(…)`, `ISODate(…)`, `NumberLong(…)`), copy as JSON.
- Changes always confirmed: insert one or many documents, replace a document, delete the selected documents, drop a collection (typing its name). The server shows the exact operation and runs it only with the confirmation token bound to it; read-only connections refuse every change.
- 64-bit integers keep all their digits and stay `Long` after an edit.
- Export of a collection or of the filtered documents as a JSON array (streamed, up to 100,000 documents); index list.
- MCP tools (read-only, vault unlocked from the UI): `mongo_client_connections`, `mongo_client_databases`, `mongo_client_collections`, `mongo_client_find`, `mongo_client_count`.
- Export/Import checkbox "MongoDB connections" (connections and the vault).
