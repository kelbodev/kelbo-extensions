// Motore PostgreSQL per la sezione Database (capacità "db-engine" del db-client, interfaccia in
// extensions/db-client/engine.md di Kelbo). Il database è quello della connessione; il livello
// sotto la connessione (database delle route e dell'albero) è lo schema.
const { Pool, Client, types: pgTypes } = require('pg');
const Cursor = require('pg-cursor');
const ddl = require('./ddl');
const ops = require('./ops');
const createPgSql = require('./sql');
const { introspect } = require('./introspect');

const QUERY_TIMEOUT_MS = 30000;
const { quoteId, literal } = ddl;

// Date e ore come testo (come le stringhe di MySQL): nessuna conversione di fuso orario
const STRING_TYPES = [1082, 1083, 1114, 1184, 1266, 1186]; // date, time, timestamp, timestamptz, timetz, interval
const typeParser = {
  getTypeParser(oid, format) {
    if (STRING_TYPES.includes(oid)) return v => v;
    return pgTypes.getTypeParser(oid, format);
  },
};
// Nome del tipo dal suo OID (tipi predefiniti)
const TYPE_NAMES = Object.fromEntries(Object.entries(pgTypes.builtins).map(([name, oid]) => [oid, name]));

const KEYWORDS = `ALL ALTER AND ANY ARRAY AS ASC BETWEEN BIGINT BOOLEAN BY BYTEA CASCADE CASE CAST CHAR CHECK COLLATE COLUMN COMMENT CONSTRAINT
COPY CREATE CROSS CURRENT_DATE CURRENT_TIMESTAMP DATE DEFAULT DEFERRABLE DELETE DESC DISTINCT DO DOUBLE DROP ELSE END EXCEPT EXISTS EXPLAIN
FALSE FETCH FILTER FIRST FOR FOREIGN FROM FULL GENERATED GRANT GROUP HAVING IDENTITY ILIKE IN INDEX INNER INSERT INTEGER INTERSECT INTERVAL
INTO IS JOIN JSON JSONB KEY LATERAL LEFT LIKE LIMIT MATERIALIZED NOT NULL NUMERIC OFFSET ON ONLY OR ORDER OUTER OVER PARTITION PRECISION
PRIMARY REAL RECURSIVE REFERENCES RENAME RETURNING RIGHT ROWS SCHEMA SELECT SEQUENCE SET SHOW SIMILAR SMALLINT TABLE TEXT THEN TIME
TIMESTAMP TIMESTAMPTZ TO TRUE TRUNCATE TYPE UNION UNIQUE UPDATE USING UUID VALUES VARCHAR VIEW WHEN WHERE WINDOW WITH`.split(/\s+/).filter(Boolean);

// Valori pronti per il JSON (come in db-mysql): binari in esadecimale troncato, oggetti e array in JSON
const isJsonValue = v => v !== null && typeof v === 'object' && !Buffer.isBuffer(v) && !(v instanceof Date);
function cell(v) {
  if (Buffer.isBuffer(v)) return v.length <= 64 ? `0x${v.toString('hex')}` : `0x${v.subarray(0, 64).toString('hex')}… (${v.length} byte)`;
  if (isJsonValue(v)) return JSON.stringify(v);
  return v;
}

module.exports = function createPgEngine({ sqlText, schemaDiff }) {
  const sql = createPgSql(sqlText, literal);
  const common = schemaDiff({
    typeKinds: ddl.TYPES, typeAliases: ddl.TYPE_ALIASES, positions: false,
    fkAction: a => String(a || '').toUpperCase() || 'NO ACTION',
  });
  // ? dei testi generati dal db-client → $1, $2… (fuori da stringhe e identificatori)
  const toPositional = text => {
    let n = 0, out = '', last = 0;
    for (const p of sql.placeholders(text).filter(x => x.kind === 'positional')) { out += text.slice(last, p.start) + `$${++n}`; last = p.end; }
    return out + text.slice(last);
  };
  const format = (template, params) => {
    let i = 0, out = '', last = 0;
    for (const p of sql.placeholders(template).filter(x => x.kind === 'positional')) { out += template.slice(last, p.start) + literal(params[i++]); last = p.end; }
    return out + template.slice(last);
  };
  const clientConfig = o => ({
    host: o.host, port: o.port, user: o.user, password: o.password, database: o.database || 'postgres',
    connectionTimeoutMillis: o.connectTimeout, statement_timeout: QUERY_TIMEOUT_MS, application_name: 'Kelbo', types: typeParser,
  });
  // Origine delle colonne di un risultato (tabella e colonna reali) per renderlo modificabile
  async function origins(client, fields) {
    const ids = [...new Set(fields.map(f => f.tableID).filter(Boolean))];
    if (!ids.length) return new Map();
    const { rows } = await client.query(
      `SELECT c.oid::int AS oid, n.nspname AS schema, c.relname AS table, a.attnum AS num, a.attname AS name
         FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE c.oid = ANY($1::oid[]) AND a.attnum > 0`, [ids]);
    return new Map(rows.map(r => [`${r.oid}:${r.num}`, r]));
  }
  const readCursor = (cursor, n) => new Promise((resolve, reject) => cursor.read(n, (e, rows, result) => (e ? reject(e) : resolve({ rows, result }))));
  const closeCursor = cursor => new Promise(r => cursor.close(() => r()));

  return {
    driver: () => ({ name: 'pg', version: require('pg/package.json').version }),
    connection: { fields: ['host', 'port', 'user', 'password', 'database'], defaultPort: 5432, tunnel: true },
    defaultSchema: 'public',
    dialect: {
      quote: '"',
      keywords: KEYWORDS,
      schemas: true,
      ddl: {
        types: Object.keys(ddl.TYPES), fkActions: ddl.FK_ACTIONS, engines: [],
        features: { unsigned: false, onUpdate: false, charset: false, positions: false, idType: 'INTEGER',
          decimalTypes: ['NUMERIC'], temporalTypes: ['TIME', 'TIMESTAMP', 'TIMESTAMPTZ'], valueTypes: [] },
      },
      snippets: {
        firstRows: 'SELECT * FROM {table} LIMIT 100;',
        count: 'SELECT COUNT(*) AS {alias} FROM {table};',
        distinct: 'SELECT DISTINCT {column} FROM {table} ORDER BY {column};',
      },
    },

    // ---- connessione ----
    // o.schema: schema di lavoro (search_path); readOnly: anche il server rifiuta le scritture
    createPool(o, { readOnly = false } = {}) {
      const pool = new Pool({ ...clientConfig(o), max: 3 });
      pool.on('connect', client => {
        if (o.schema) client.query(`SET search_path TO ${quoteId(o.schema)}, public`).catch(() => {});
        if (readOnly) client.query('SET default_transaction_read_only = on').catch(() => {});
      });
      pool.on('error', () => { /* connessione persa nel pool: la prossima richiesta ne apre un'altra */ });
      return pool;
    },
    closePool(pool) { pool.end().catch(() => {}); },
    async test(o) {
      const client = new Client(clientConfig(o));
      await client.connect();
      try {
        const { rows: [row] } = await client.query("SELECT split_part(version(), ' on ', 1) AS version, current_user AS user, current_database() AS db");
        return row;
      } finally { client.end().catch(() => {}); }
    },
    acquire: pool => pool.connect(),
    release: session => session.release(),

    async query(pool, text, params = [], { rowsAsArray = false } = {}) {
      const r = await pool.query({ text: toPositional(text), values: params, ...(rowsAsArray ? { rowMode: 'array' } : {}) });
      return { rows: r.rows, fields: r.fields };
    },

    // Una istruzione con le righe lette fino al limite (cursore); readOnly: transazione READ ONLY
    // annullata alla fine. Più istruzioni (DDL generato dal designer): in una transazione.
    async execute(pool, text, limit, { readOnly = false, session = null } = {}) {
      const client = session || await pool.connect();
      const started = Date.now();
      try {
        if (sql.splitStatements(text).length > 1) {
          await client.query('BEGIN');
          try { await client.query(text); await client.query('COMMIT'); } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e; }
          return { kind: 'result', ms: Date.now() - started, affectedRows: 0, changedRows: null, insertId: null, warningStatus: 0, info: '' };
        }
        if (readOnly) await client.query('BEGIN READ ONLY');
        const cursor = client.query(new Cursor(text, [], { rowMode: 'array', types: typeParser }));
        let rows, result;
        try { ({ rows, result } = await readCursor(cursor, limit + 1)); } finally { await closeCursor(cursor); }
        const fields = result?.fields || [];
        const ms = Date.now() - started;
        if (fields.length) {
          const truncated = rows.length > limit;
          const from = await origins(client, fields).catch(() => new Map());
          return {
            kind: 'rows', ms, truncated, rowCount: Math.min(rows.length, limit),
            columns: fields.map(f => {
              const o = f.tableID ? from.get(`${f.tableID}:${f.columnID}`) : null;
              return { name: f.name, table: o?.table || null, db: o?.schema || null, column: o?.name || null, type: TYPE_NAMES[f.dataTypeID] || String(f.dataTypeID) };
            }),
            rows: rows.slice(0, limit).map(r => r.map(cell)),
          };
        }
        return { kind: 'result', ms, affectedRows: result?.rowCount ?? 0, changedRows: null, insertId: null, warningStatus: 0, info: result?.command || '' };
      } finally {
        if (readOnly) await client.query('ROLLBACK').catch(() => {});
        if (!session) client.release();
      }
    },

    async transaction(pool, statements) {
      const client = await pool.connect();
      let affected = 0;
      try {
        await client.query('BEGIN');
        for (const s of statements) affected += (await client.query(s)).rowCount || 0;
        await client.query('COMMIT');
      } catch (e) {
        await client.query('ROLLBACK').catch(() => {});
        throw e;
      } finally { client.release(); }
      return affected;
    },

    // Righe in streaming per l'export (cursore a blocchi di 200): prima { fields }, poi una riga per volta
    async *stream(pool, text, params = []) {
      const client = await pool.connect();
      const cursor = client.query(new Cursor(toPositional(text), params, { rowMode: 'array', types: typeParser }));
      try {
        let announced = false;
        for (;;) {
          const { rows, result } = await readCursor(cursor, 200);
          if (!announced) { yield { fields: (result?.fields || []).map(f => f.name) }; announced = true; }
          if (!rows.length) break;
          for (const row of rows) yield row;
        }
      } finally {
        await closeCursor(cursor);
        client.release();
      }
    },

    // ---- testo SQL ----
    sql: {
      classify: sql.classify, splitStatements: sql.splitStatements, schemaChange: sql.schemaChange,
      describeParams: sql.describeParams, bindParams: sql.bindParams, countQuery: sql.countQuery,
    },
    quoteId,
    qualify: (schema, table) => `${quoteId(schema)}.${quoteId(table)}`,
    escape: literal,
    literal,
    format,
    asText: column => `${column}::text`,
    likeOperator: 'ILIKE', // la ricerca non distingue maiuscole e minuscole, come in MySQL
    page: (text, params, limit, offset) => ({ sql: `${text} LIMIT ? OFFSET ?`, params: [...params, limit, offset] }),

    // ---- metadati (il "database" delle route è lo schema) ----
    async listDatabases(pool) {
      const { rows } = await pool.query(`SELECT nspname FROM pg_namespace
        WHERE nspname NOT LIKE 'pg\\_toast%' AND nspname NOT LIKE 'pg\\_temp%' ORDER BY nspname = 'public' DESC, nspname`);
      return rows.map(r => r.nspname);
    },
    async listTables(pool, schema) {
      const { rows } = await pool.query(
        `SELECT c.relname AS name, CASE c.relkind WHEN 'v' THEN 'VIEW' WHEN 'm' THEN 'MATERIALIZED VIEW' WHEN 'f' THEN 'FOREIGN TABLE' ELSE 'BASE TABLE' END AS type,
                NULL AS engine, CASE WHEN c.reltuples < 0 THEN NULL ELSE c.reltuples::bigint END AS "rowsEstimate", obj_description(c.oid, 'pg_class') AS comment
           FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = $1 AND c.relkind IN ('r', 'p', 'v', 'm', 'f') ORDER BY c.relname`, [schema]);
      return rows.map(t => ({ ...t, rowsEstimate: t.rowsEstimate === null ? null : Number(t.rowsEstimate), view: /VIEW/.test(t.type) }));
    },
    async columns(pool, schema, table) {
      const { rows } = await pool.query(
        `SELECT c.column_name AS name, format_type(a.atttypid, a.atttypmod) AS type, c.data_type AS "dataType", c.is_nullable = 'YES' AS nullable,
                CASE WHEN EXISTS (SELECT 1 FROM pg_index ix WHERE ix.indrelid = a.attrelid AND ix.indisprimary AND a.attnum = ANY(ix.indkey)) THEN 'PRI' ELSE '' END AS key,
                c.column_default AS default, CASE WHEN c.is_identity = 'YES' THEN 'identity' ELSE '' END AS extra
           FROM information_schema.columns c
           JOIN pg_attribute a ON a.attrelid = format('%I.%I', c.table_schema, c.table_name)::regclass AND a.attname = c.column_name
          WHERE c.table_schema = $1 AND c.table_name = $2 ORDER BY c.ordinal_position`, [schema, table]);
      return rows;
    },
    async tableInfo(pool, schema, table) {
      const columns = await this.columns(pool, schema, table).catch(e => { if (e.code === '42P01') return []; throw e; });
      if (!columns.length) return null;
      const def = (await introspect((t, p) => pool.query(t, p).then(r => r.rows), schema, [table])).tables[table];
      const comments = new Map((def?.columns || []).map(c => [c.name, c.comment || '']));
      return {
        columns: columns.map(c => ({ name: c.name, type: c.type, nullable: c.nullable, key: c.key, default: c.default, extra: c.extra, comment: comments.get(c.name) || '' })),
        indexes: [
          ...(def?.primaryKey?.length ? [{ name: def.primaryKeyName || `${table}_pkey`, unique: true, columns: def.primaryKey }] : []),
          ...(def?.indexes || []).map(i => ({ name: i.name, unique: i.unique, columns: i.columns })),
        ],
        foreignKeys: (def?.foreignKeys || []).map(f => ({ name: f.name, columns: f.columns, refDatabase: f.refDatabase || schema, refTable: f.refTable, refColumns: f.refColumns })),
      };
    },
    // PostgreSQL non ha SHOW CREATE TABLE: lo si ricostruisce dalla struttura
    async createTableText(pool, schema, table) {
      const def = (await introspect((t, p) => pool.query(t, p).then(r => r.rows), schema, [table])).tables[table];
      if (!def) return `-- ${table}: structure not available`;
      const columns = def.columns.map(c => (c.unsupported ? { ...c, type: 'TEXT', unsupported: undefined } : c));
      return ddl.createTableSql(schema, { ...def, name: table, columns });
    },
    introspect: (pool, schema, tables) => introspect((t, p) => pool.query(t, p).then(r => r.rows), schema, tables),

    // ---- righe ----
    dml: {
      insert(from, values) {
        const cols = Object.keys(values);
        return cols.length
          ? `INSERT INTO ${from} (${cols.map(quoteId).join(', ')}) VALUES (${cols.map(c => literal(values[c])).join(', ')})`
          : `INSERT INTO ${from} DEFAULT VALUES`;
      },
      update(from, values, key) {
        const where = Object.keys(key).map(c => `${quoteId(c)} = ${literal(key[c])}`).join(' AND ');
        return `UPDATE ${from} SET ${Object.keys(values).map(c => `${quoteId(c)} = ${literal(values[c])}`).join(', ')} WHERE ${where}`;
      },
      delete(from, key) {
        return `DELETE FROM ${from} WHERE ${Object.keys(key).map(c => `${quoteId(c)} = ${literal(key[c])}`).join(' AND ')}`;
      },
      deleteMany(from, pk, keys) {
        const tuple = pk.length > 1 ? `(${pk.map(quoteId).join(', ')})` : quoteId(pk[0]);
        const one = k => (pk.length > 1 ? `(${pk.map(c => literal(k[c])).join(', ')})` : literal(k[pk[0]]));
        return `DELETE FROM ${from} WHERE ${tuple} IN (${keys.map(one).join(', ')})`;
      },
    },

    // ---- schema ----
    ddl: { createTableSql: ddl.createTableSql, DdlError: ddl.DdlError },
    schema: {
      statements: ops.statements,
      // la chiave primaria da togliere ha il nome letto dal database
      diff: (from, to, renames) => {
        const r = common.diff(from, to, renames);
        r.ops = r.ops.map(op => (op.op === 'drop_primary_key' ? { ...op, name: from?.tables?.[op.table]?.primaryKeyName } : op));
        return r;
      },
      destructive: common.destructive, proposeName: common.proposeName,
    },

    errorInfo: e => ({ message: [e?.message || String(e), e?.detail].filter(Boolean).join(' — '), ...(e?.code ? { code: e.code } : {}) }),
  };
};
