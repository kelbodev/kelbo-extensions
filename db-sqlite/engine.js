// Motore SQLite per la sezione Database (capacità "db-engine" del db-client): un file .sqlite/.db
// aperto con node:sqlite di Node (22.13 o successivo: niente moduli nativi da compilare, e il file
// vero, così le modifiche dell'applicazione si vedono subito). Il livello sotto la connessione è
// lo schema di SQLite: main e i database collegati con ATTACH.
const fs = require('fs');
const path = require('path');
const ddl = require('./ddl');
const createSqliteSql = require('./sql');

const { quoteId, literal } = ddl;
let sqlite = null;
function driver() {
  if (sqlite) return sqlite;
  const warn = process.emitWarning;
  process.emitWarning = (w, ...rest) => (String(w).includes('SQLite') ? undefined : warn.call(process, w, ...rest)); // "experimental"
  try { sqlite = require('node:sqlite'); } finally { process.emitWarning = warn; }
  return sqlite;
}

const KEYWORDS = `ABORT ALL ALTER AND AS ASC ATTACH AUTOINCREMENT BEGIN BETWEEN BLOB BY CASCADE CASE CAST CHECK COLLATE COLUMN COMMIT CONFLICT
CONSTRAINT CREATE CROSS CURRENT_DATE CURRENT_TIMESTAMP DEFAULT DELETE DESC DETACH DISTINCT DROP ELSE END ESCAPE EXCEPT EXISTS EXPLAIN FOREIGN
FROM FULL GLOB GROUP HAVING IF IN INDEX INNER INSERT INTEGER INTERSECT INTO IS JOIN KEY LEFT LIKE LIMIT MATCH NOT NULL OFFSET ON OR ORDER
OUTER PRAGMA PRIMARY REAL REFERENCES REINDEX RENAME REPLACE RETURNING RIGHT ROLLBACK SELECT SET TABLE TEXT THEN TO TRANSACTION TRIGGER
UNION UNIQUE UPDATE USING VACUUM VALUES VIEW WHEN WHERE WITH WITHOUT`.split(/\s+/).filter(Boolean);

const isJsonValue = v => v !== null && typeof v === 'object' && !Buffer.isBuffer(v) && !(v instanceof Uint8Array);
function cell(v) {
  if (v instanceof Uint8Array) { const b = Buffer.from(v); return b.length <= 64 ? `0x${b.toString('hex')}` : `0x${b.subarray(0, 64).toString('hex')}… (${b.length} byte)`; }
  if (typeof v === 'bigint') return v.toString();
  if (isJsonValue(v)) return JSON.stringify(v);
  return v;
}
const raw = v => (v instanceof Uint8Array ? Buffer.from(v) : typeof v === 'bigint' ? v.toString() : v);

module.exports = function createSqliteEngine({ sqlText, schemaDiff }) {
  const sql = createSqliteSql(sqlText, literal);
  const common = schemaDiff({ typeKinds: ddl.TYPES, typeAliases: ddl.TYPE_ALIASES, positions: false, fkAction: a => String(a || '').toUpperCase() || 'NO ACTION' });
  const REBUILD = new Set(['modify_column', 'add_primary_key', 'drop_primary_key', 'add_fk', 'drop_fk']);

  // "Pool": il database aperto alla prima richiesta (una sola connessione, le richieste sono sincrone)
  function db(pool) {
    if (pool.db) return pool.db;
    if (!pool.file) throw Object.assign(new Error('no file'), { code: 'SQLITE_CANTOPEN' });
    if (!fs.existsSync(pool.file) || !fs.statSync(pool.file).isFile()) throw Object.assign(new Error(`file not found: ${pool.file}`), { code: 'SQLITE_CANTOPEN' });
    const { DatabaseSync } = driver();
    pool.db = new DatabaseSync(pool.file, { readOnly: pool.readOnly, enableForeignKeyConstraints: true });
    pool.db.exec('PRAGMA busy_timeout = 5000');
    return pool.db;
  }
  const rows = (pool, text, params = []) => db(pool).prepare(text).all(...params).map(r => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, raw(v)])));
  // più istruzioni in un testo (DDL generato): così come sono se gestiscono la transazione, altrimenti in una
  function execMany(d, text) {
    const own = /^\s*PRAGMA\s+foreign_keys/i.test(text) || /^\s*BEGIN\b/im.test(text);
    try {
      d.exec(own ? text : `BEGIN;\n${text};\nCOMMIT`);
    } catch (e) {
      try { d.exec('ROLLBACK'); } catch { /* nessuna transazione aperta */ }
      if (own) try { d.exec('PRAGMA foreign_keys = ON'); } catch { /* già attivi */ }
      throw e;
    }
  }

  return {
    driver: () => ({ name: 'node:sqlite', version: driver().constants ? process.versions.node : process.versions.node }),
    connection: { fields: ['file'], tunnel: false },
    defaultSchema: 'main',
    dialect: {
      quote: '"',
      keywords: KEYWORDS,
      schemas: true,
      ddl: {
        types: Object.keys(ddl.TYPES), fkActions: ddl.FK_ACTIONS, engines: [],
        features: { unsigned: false, onUpdate: false, charset: false, positions: false, idType: 'INTEGER',
          decimalTypes: ['NUMERIC'], temporalTypes: [], valueTypes: [] },
      },
      snippets: {
        firstRows: 'SELECT * FROM {table} LIMIT 100;',
        count: 'SELECT COUNT(*) AS {alias} FROM {table};',
        distinct: 'SELECT DISTINCT {column} FROM {table} ORDER BY {column};',
      },
    },

    createPool: (o, { readOnly = false } = {}) => ({ file: o.file, readOnly, db: null }),
    closePool(pool) { try { pool.db?.close(); } catch { /* già chiuso */ } pool.db = null; },
    async test(o) {
      const pool = { file: o.file, readOnly: true, db: null };
      try {
        const [row] = rows(pool, 'SELECT sqlite_version() AS version');
        return { version: `SQLite ${row.version}`, user: '', db: path.basename(o.file || '') };
      } finally { this.closePool(pool); }
    },
    acquire: async pool => pool,
    release: () => {},

    async query(pool, text, params = [], { rowsAsArray = false } = {}) {
      const st = db(pool).prepare(text);
      const fields = st.columns().map(c => ({ name: c.name }));
      const list = st.all(...params);
      return { rows: rowsAsArray ? list.map(r => Object.values(r).map(cell)) : list.map(r => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, raw(v)]))), fields };
    },

    async execute(pool, text, limit, { readOnly = false } = {}) {
      const d = db(pool);
      const started = Date.now();
      if (sql.splitStatements(text).length > 1) {
        execMany(d, text);
        return { kind: 'result', ms: Date.now() - started, affectedRows: 0, changedRows: null, insertId: null, warningStatus: 0, info: '' };
      }
      if (readOnly) d.exec('BEGIN');
      try {
        const st = d.prepare(text);
        const columns = st.columns();
        if (columns.length) {
          st.setReturnArrays?.(true);
          const out = [];
          let truncated = false;
          for (const r of st.iterate()) {
            if (out.length >= limit) { truncated = true; break; }
            out.push((Array.isArray(r) ? r : Object.values(r)).map(cell));
          }
          return {
            kind: 'rows', ms: Date.now() - started, truncated, rowCount: out.length,
            columns: columns.map(c => ({ name: c.name, table: c.table || null, db: c.table ? c.database || null : null, column: c.column || null, type: c.type || '' })),
            rows: out,
          };
        }
        const r = st.run();
        return { kind: 'result', ms: Date.now() - started, affectedRows: Number(r.changes), changedRows: null, insertId: r.lastInsertRowid ? Number(r.lastInsertRowid) : null, warningStatus: 0, info: '' };
      } finally {
        if (readOnly) try { d.exec('ROLLBACK'); } catch { /* chiusa */ }
      }
    },

    async transaction(pool, statements) {
      const d = db(pool);
      let affected = 0;
      d.exec('BEGIN');
      try {
        for (const s of statements) affected += Number(d.prepare(s).run().changes);
        d.exec('COMMIT');
      } catch (e) {
        try { d.exec('ROLLBACK'); } catch { /* già chiusa */ }
        throw e;
      }
      return affected;
    },

    async *stream(pool, text, params = []) {
      const st = db(pool).prepare(text);
      yield { fields: st.columns().map(c => c.name) };
      st.setReturnArrays?.(true);
      for (const r of st.iterate(...params)) yield (Array.isArray(r) ? r : Object.values(r)).map(raw);
    },

    sql: {
      classify: sql.classify, splitStatements: sql.splitStatements, schemaChange: sql.schemaChange,
      describeParams: sql.describeParams, bindParams: sql.bindParams, countQuery: sql.countQuery,
    },
    quoteId,
    qualify: (schema, table) => `${quoteId(schema)}.${quoteId(table)}`,
    escape: literal,
    literal,
    format: (template, params) => { let i = 0; return template.replace(/\?/g, () => literal(params[i++])); },
    asText: column => `CAST(${column} AS TEXT)`,
    page: (text, params, limit, offset) => ({ sql: `${text} LIMIT ? OFFSET ?`, params: [...params, limit, offset] }),

    async listDatabases(pool) {
      return rows(pool, 'PRAGMA database_list').map(r => r.name).filter(n => n !== 'temp');
    },
    async listTables(pool, schema) {
      return rows(pool, `SELECT name, type FROM ${quoteId(schema)}.sqlite_master WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' ORDER BY name`)
        .map(t => ({ name: t.name, type: t.type === 'view' ? 'VIEW' : 'BASE TABLE', engine: null, rowsEstimate: null, comment: '', view: t.type === 'view' }));
    },
    async columns(pool, schema, table) {
      return rows(pool, `PRAGMA ${quoteId(schema)}.table_xinfo(${literal(table)})`).filter(c => !c.hidden).map(c => ({
        name: c.name, type: c.type || '', dataType: ddl.parseType(c.type).type.toLowerCase(), nullable: !c.notnull,
        key: c.pk ? 'PRI' : '', default: c.dflt_value, extra: '',
      }));
    },
    async tableInfo(pool, schema, table) {
      const columns = await this.columns(pool, schema, table);
      if (!columns.length) return null;
      const def = ddl.introspect(t => rows(pool, t), schema, [table]).tables[table];
      return {
        columns: columns.map(({ dataType, ...c }) => ({ ...c, comment: '' })),
        indexes: (def?.indexes || []).map(i => ({ name: i.name, unique: i.unique, columns: i.columns })),
        foreignKeys: (def?.foreignKeys || []).map(f => ({ name: f.name, columns: f.columns, refDatabase: schema, refTable: f.refTable, refColumns: f.refColumns })),
      };
    },
    // il testo originale del CREATE TABLE, com'è nel file
    async createTableText(pool, schema, table) {
      return rows(pool, `SELECT sql FROM ${quoteId(schema)}.sqlite_master WHERE type = 'table' AND name = ?`, [table])[0]?.sql || `-- ${table}`;
    },
    introspect: async (pool, schema, tables) => ddl.introspect(t => rows(pool, t), schema, tables),

    dml: {
      insert(from, values) {
        const cols = Object.keys(values);
        return cols.length ? `INSERT INTO ${from} (${cols.map(quoteId).join(', ')}) VALUES (${cols.map(c => literal(values[c])).join(', ')})` : `INSERT INTO ${from} DEFAULT VALUES`;
      },
      update: (from, values, key) => `UPDATE ${from} SET ${Object.keys(values).map(c => `${quoteId(c)} = ${literal(values[c])}`).join(', ')} WHERE ${Object.keys(key).map(c => `${quoteId(c)} = ${literal(key[c])}`).join(' AND ')}`,
      delete: (from, key) => `DELETE FROM ${from} WHERE ${Object.keys(key).map(c => `${quoteId(c)} = ${literal(key[c])}`).join(' AND ')}`,
      deleteMany(from, pk, keys) {
        if (pk.length === 1) return `DELETE FROM ${from} WHERE ${quoteId(pk[0])} IN (${keys.map(k => literal(k[pk[0]])).join(', ')})`;
        return `DELETE FROM ${from} WHERE (${pk.map(quoteId).join(', ')}) IN (VALUES ${keys.map(k => `(${pk.map(c => literal(k[c])).join(', ')})`).join(', ')})`;
      },
    },

    ddl: { createTableSql: ddl.createTableSql, DdlError: ddl.DdlError },
    schema: {
      statements: ddl.statements,
      // modifiche che ALTER TABLE di SQLite non sa fare: una ricostruzione della tabella
      diff(from, to, renames = {}) {
        const r = common.diff(from, to, renames);
        const rebuild = new Set(r.ops.filter(op => REBUILD.has(op.op)).map(op => op.table));
        if (!rebuild.size) return r;
        const ops = [];
        for (const op of r.ops) {
          if (!rebuild.has(op.table)) { ops.push(op); continue; }
          if (ops.some(o => o.op === 'rebuild_table' && o.table === op.table)) { ops.find(o => o.op === 'rebuild_table' && o.table === op.table).ops.push(op); continue; }
          const before = from.tables[op.table], after = to.tables[op.table];
          const old = new Set((before?.columns || []).map(c => c.name));
          const columns = {};
          for (const c of after.columns) {
            const was = renames[`${op.table}.${c.name}`] || c.name;
            if (old.has(was)) columns[c.name] = was;
          }
          ops.push({ op: 'rebuild_table', table: op.table, definition: after, columns, ops: [op] });
        }
        return { ...r, ops };
      },
      destructive: (ops, before) => common.destructive(ops.flatMap(op => (op.op === 'rebuild_table' ? op.ops : [op])), before),
      proposeName: ops => common.proposeName(ops.flatMap(op => (op.op === 'rebuild_table' ? op.ops : [op]))),
    },

    errorInfo: e => ({ message: e?.message || String(e), ...(e?.errcode !== undefined ? { code: `SQLITE_${e.errcode}` } : e?.code ? { code: e.code } : {}) }),
  };
};
