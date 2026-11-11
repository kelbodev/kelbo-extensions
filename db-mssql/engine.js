// Motore Microsoft SQL Server per la sezione Database (capacità "db-engine" del db-client).
// Il database è quello della connessione; il livello sotto la connessione è lo schema (dbo per
// primo). Driver mssql (tedious, JavaScript puro), autenticazione SQL.
const mssql = require('mssql');
const ddl = require('./ddl');
const createMssqlSql = require('./sql');
const { introspect, typeLabel, COLUMNS_SQL } = require('./introspect');

const QUERY_TIMEOUT_MS = 30000;
const { quoteId, literal } = ddl;

const KEYWORDS = `ADD ALL ALTER AND ANY AS ASC BEGIN BETWEEN BIGINT BINARY BIT BY CASCADE CASE CAST CHAR CHECK COLUMN COMMIT CONSTRAINT CONVERT
CREATE CROSS CURRENT_TIMESTAMP DATE DATETIME DATETIME2 DECIMAL DECLARE DEFAULT DELETE DESC DISTINCT DROP ELSE END EXEC EXECUTE EXISTS FETCH
FOREIGN FROM FULL GO GROUP HAVING IDENTITY IF IN INDEX INNER INSERT INT INTO IS JOIN KEY LEFT LIKE MERGE NCHAR NEXT NOT NULL NUMERIC
NVARCHAR OFFSET ON ONLY OR ORDER OUTER OUTPUT OVER PARTITION PRIMARY REFERENCES ROLLBACK ROWS SELECT SET SMALLINT TABLE THEN TOP
TRANSACTION TRUNCATE UNION UNIQUE UNIQUEIDENTIFIER UPDATE USING VALUES VARCHAR VIEW WHEN WHERE WITH`.split(/\s+/).filter(Boolean);

const pad = (n, w = 2) => String(n).padStart(w, '0');
// Date del driver come testo (come le stringhe di MySQL): data, ora o data e ora
function dateText(d, typeName) {
  const date = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  const time = `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}${d.getUTCMilliseconds() ? `.${pad(d.getUTCMilliseconds(), 3)}` : ''}`;
  if (/^date$/i.test(typeName)) return date;
  if (/^time$/i.test(typeName)) return time;
  return `${date} ${time}`;
}
const isJsonValue = v => v !== null && typeof v === 'object' && !Buffer.isBuffer(v) && !(v instanceof Date);
function cell(v, typeName) {
  if (v instanceof Date) return dateText(v, typeName);
  if (Buffer.isBuffer(v)) return v.length <= 64 ? `0x${v.toString('hex')}` : `0x${v.subarray(0, 64).toString('hex')}… (${v.length} byte)`;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (isJsonValue(v)) return JSON.stringify(v);
  return v;
}
const typeName = col => (col?.type?.declaration || col?.type?.name || '').toString();

module.exports = function createMssqlEngine({ sqlText, schemaDiff }) {
  const sql = createMssqlSql(sqlText, literal);
  const common = schemaDiff({
    typeKinds: ddl.TYPES, typeAliases: ddl.TYPE_ALIASES, positions: false,
    fkAction: a => { const v = String(a || '').toUpperCase(); return !v || v === 'RESTRICT' ? 'NO ACTION' : v; },
  });
  // ? dei testi generati dal db-client → @p1, @p2…
  const toNamed = text => {
    let n = 0, out = '', last = 0;
    for (const p of sql.placeholders(text).filter(x => x.kind === 'positional')) { out += text.slice(last, p.start) + `@p${++n}`; last = p.end; }
    return out + text.slice(last);
  };
  const format = (template, params) => {
    let i = 0, out = '', last = 0;
    for (const p of sql.placeholders(template).filter(x => x.kind === 'positional')) { out += template.slice(last, p.start) + literal(params[i++]); last = p.end; }
    return out + template.slice(last);
  };
  const config = (o, max = 3) => ({
    server: o.host, port: Number(o.port) || 1433, user: o.user, password: o.password, database: o.database || 'master',
    connectionTimeout: o.connectTimeout, requestTimeout: QUERY_TIMEOUT_MS, pool: { max, min: 0, idleTimeoutMillis: 60000 },
    options: { encrypt: o.options?.encrypt !== false, trustServerCertificate: !!o.options?.trustServerCertificate, appName: 'Kelbo', useUTC: true },
  });
  // Pool del driver collegato in background: ogni uso aspetta la connessione (o il suo errore)
  function open(o, max) {
    const pool = new mssql.ConnectionPool(config(o, max));
    pool.on('error', () => { /* connessione persa: la prossima richiesta la riapre */ });
    const ready = pool.connect();
    ready.catch(() => {});
    return { pool, ready, options: o };
  }
  const request = async (wrap, tx = null) => { await wrap.ready; return new mssql.Request(tx || wrap.pool); };
  const withParams = (req, params) => { params.forEach((v, i) => req.input(`p${i + 1}`, v)); return req; };
  async function rowsOf(wrap, text, params = []) {
    const req = withParams(await request(wrap), params);
    return (await req.query(toNamed(text))).recordset || [];
  }

  // Esecuzione con le righe in streaming fino al limite; tx: transazione da usare (sola lettura)
  function run(req, text, limit) {
    return new Promise((resolve, reject) => {
      const started = Date.now();
      let columns = null, extraSets = 0, affected = 0, truncated = false, settled = false;
      const rows = [];
      req.stream = true;
      req.arrayRowMode = true;
      req.on('recordset', cols => { if (!columns) columns = cols; else extraSets++; });
      req.on('row', r => {
        if (extraSets) return; // solo il primo insieme di righe
        if (rows.length >= limit) { if (!truncated) { truncated = true; req.cancel(); } return; }
        rows.push(r.map((v, i) => cell(v, typeName(columns?.[i]))));
      });
      req.on('rowsaffected', n => { affected += n; });
      req.on('error', e => { if (truncated && /cancel/i.test(e.message)) return; if (!settled) { settled = true; reject(e); } });
      req.on('done', () => {
        if (settled) return;
        settled = true;
        const ms = Date.now() - started;
        if (columns) {
          resolve({
            kind: 'rows', ms, truncated, rowCount: rows.length,
            columns: columns.map(c => ({ name: c.name, table: null, db: null, column: null, type: typeName(c) })),
            rows,
          });
        } else resolve({ kind: 'result', ms, affectedRows: affected, changedRows: null, insertId: null, warningStatus: 0, info: '' });
      });
      req.query(text);
    });
  }

  return {
    driver: () => ({ name: 'mssql', version: require('mssql/package.json').version }),
    connection: {
      fields: ['host', 'port', 'user', 'password', 'database'], defaultPort: 1433, tunnel: true,
      options: [
        { key: 'encrypt', type: 'boolean', default: true, label: { it: 'Connessione cifrata (encrypt)', en: 'Encrypted connection (encrypt)' } },
        { key: 'trustServerCertificate', type: 'boolean', default: false, label: { it: 'Accetta il certificato del server senza verificarlo (Docker, server locali)', en: "Trust the server's certificate without checking it (Docker, local servers)" } },
      ],
    },
    defaultSchema: 'dbo',
    dialect: {
      quote: '[',
      keywords: KEYWORDS,
      schemas: true,
      ddl: {
        types: Object.keys(ddl.TYPES), fkActions: ddl.FK_ACTIONS, engines: [],
        features: { unsigned: false, onUpdate: false, charset: false, positions: false, idType: 'INT',
          decimalTypes: ['DECIMAL', 'NUMERIC'], temporalTypes: ['TIME', 'DATETIME2', 'DATETIMEOFFSET'], valueTypes: [] },
      },
      snippets: {
        firstRows: 'SELECT TOP (100) * FROM {table};',
        count: 'SELECT COUNT(*) AS {alias} FROM {table};',
        distinct: 'SELECT DISTINCT {column} FROM {table} ORDER BY {column};',
      },
    },

    // ---- connessione (SQL Server non ha un search_path: i nomi senza schema usano quello dell'utente) ----
    createPool: o => open(o, 3),
    closePool(wrap) { wrap.ready.then(() => wrap.pool.close()).catch(() => {}); },
    async test(o) {
      const wrap = open(o, 1);
      try {
        const [row] = await rowsOf(wrap, 'SELECT @@VERSION AS version, SUSER_SNAME() AS [user], DB_NAME() AS db');
        return { ...row, version: String(row.version).split('\n')[0].trim() };
      } finally { this.closePool(wrap); }
    },
    // Sessione: un pool con una sola connessione (tabelle temporanee e variabili restano tra le istruzioni)
    async acquire(wrap) { const s = open(wrap.options, 1); await s.ready; return s; },
    release(session) { this.closePool(session); },

    async query(wrap, text, params = [], { rowsAsArray = false } = {}) {
      const req = withParams(await request(wrap), params);
      if (rowsAsArray) req.arrayRowMode = true;
      const r = await req.query(toNamed(text));
      const cols = r.columns?.[0] || [];
      return { rows: rowsAsArray ? (r.recordset || []).map(row => row.map((v, i) => cell(v, typeName(cols[i])))) : r.recordset || [], fields: cols };
    },

    async execute(wrap, text, limit, { readOnly = false, session = null } = {}) {
      const target = session || wrap;
      await target.ready;
      if (!readOnly) return run(new mssql.Request(target.pool), text, limit);
      // sola lettura: dentro una transazione sempre annullata
      const tx = new mssql.Transaction(target.pool);
      await tx.begin();
      try { return await run(new mssql.Request(tx), text, limit); } finally { await tx.rollback().catch(() => {}); }
    },

    async transaction(wrap, statements) {
      await wrap.ready;
      const tx = new mssql.Transaction(wrap.pool);
      await tx.begin();
      let affected = 0;
      try {
        for (const s of statements) affected += (await new mssql.Request(tx).query(s)).rowsAffected.reduce((a, b) => a + b, 0);
        await tx.commit();
      } catch (e) {
        await tx.rollback().catch(() => {});
        throw e;
      }
      return affected;
    },

    async *stream(wrap, text, params = []) {
      const req = withParams(await request(wrap), params);
      req.arrayRowMode = true;
      let columns = null;
      req.on('recordset', cols => { if (!columns) columns = cols; });
      const readable = req.toReadableStream({ highWaterMark: 100 });
      req.query(toNamed(text));
      let announced = false;
      for await (const row of readable) {
        if (!announced) { yield { fields: (columns || []).map(c => c.name) }; announced = true; }
        yield row.map(v => (v instanceof Date ? v.toISOString() : v));
      }
      if (!announced) yield { fields: (columns || []).map(c => c.name) };
    },

    sql: {
      classify: sql.classify, splitStatements: sql.splitStatements, schemaChange: sql.schemaChange,
      describeParams: sql.describeParams, bindParams: sql.bindParams, countQuery: sql.countQuery,
    },
    quoteId,
    qualify: (schema, table) => `${quoteId(schema)}.${quoteId(table)}`,
    escape: literal,
    literal,
    format,
    asText: column => `CAST(${column} AS NVARCHAR(MAX))`,
    // OFFSET … FETCH vuole un ORDER BY
    page: (text, params, limit, offset) => ({
      sql: `${text}${/\bORDER\s+BY\b/i.test(text) ? '' : ' ORDER BY (SELECT NULL)'} OFFSET ? ROWS FETCH NEXT ? ROWS ONLY`,
      params: [...params, offset, limit],
    }),

    // ---- metadati ----
    async listDatabases(wrap) {
      const rows = await rowsOf(wrap, `SELECT name FROM sys.schemas WHERE name NOT IN ('guest', 'INFORMATION_SCHEMA', 'sys') AND name NOT LIKE 'db[_]%'
        ORDER BY CASE WHEN name = 'dbo' THEN 0 ELSE 1 END, name`);
      return rows.map(r => r.name);
    },
    async listTables(wrap, schema) {
      const rows = await rowsOf(wrap,
        `SELECT o.name, CASE o.type WHEN 'V' THEN 'VIEW' ELSE 'BASE TABLE' END AS type, NULL AS engine,
                (SELECT SUM(p.rows) FROM sys.partitions p WHERE p.object_id = o.object_id AND p.index_id IN (0, 1)) AS rowsEstimate,
                CAST(ep.value AS nvarchar(4000)) AS comment
           FROM sys.objects o JOIN sys.schemas s ON s.schema_id = o.schema_id
           LEFT JOIN sys.extended_properties ep ON ep.major_id = o.object_id AND ep.minor_id = 0 AND ep.name = 'MS_Description'
          WHERE s.name = ? AND o.type IN ('U', 'V') ORDER BY o.name`, [schema]);
      return rows.map(t => ({ ...t, rowsEstimate: t.rowsEstimate === null ? null : Number(t.rowsEstimate), view: t.type === 'VIEW' }));
    },
    async columns(wrap, schema, table) {
      const [cols, pk] = await Promise.all([
        rowsOf(wrap, COLUMNS_SQL(' AND t.name = @p2'), [schema, table]),
        rowsOf(wrap, `SELECT c.name FROM sys.indexes i JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id
                        JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
                       WHERE i.is_primary_key = 1 AND i.object_id = OBJECT_ID(?)`, [`${quoteId(schema)}.${quoteId(table)}`]),
      ]);
      const pks = new Set(pk.map(r => r.name));
      return cols.map(c => ({
        name: c.column_name, type: typeLabel(c), dataType: c.type_name, nullable: !!c.is_nullable,
        key: pks.has(c.column_name) ? 'PRI' : '', default: c.default_definition, extra: c.is_identity ? 'identity' : '', comment: c.comment || '',
      }));
    },
    async tableInfo(wrap, schema, table) {
      const columns = await this.columns(wrap, schema, table);
      if (!columns.length) return null;
      const def = (await this.introspect(wrap, schema, [table])).tables[table];
      return {
        columns: columns.map(({ dataType, ...c }) => c),
        indexes: [
          ...(def?.primaryKey?.length ? [{ name: def.primaryKeyName, unique: true, columns: def.primaryKey }] : []),
          ...(def?.indexes || []).map(i => ({ name: i.name, unique: i.unique, columns: i.columns })),
        ],
        foreignKeys: (def?.foreignKeys || []).map(f => ({ name: f.name, columns: f.columns, refDatabase: f.refDatabase || schema, refTable: f.refTable, refColumns: f.refColumns })),
      };
    },
    async createTableText(wrap, schema, table) {
      const def = (await this.introspect(wrap, schema, [table])).tables[table];
      if (!def) return `-- ${table}: structure not available`;
      return ddl.createTableSql(schema, { ...def, name: table, columns: def.columns.map(c => (c.unsupported ? { ...c, type: 'NVARCHAR', length: 'MAX', unsupported: undefined } : c)) });
    },
    introspect: (wrap, schema, tables) => introspect((t, p) => rowsOf(wrap, t, p), schema, tables),

    dml: {
      insert(from, values) {
        const cols = Object.keys(values);
        return cols.length ? `INSERT INTO ${from} (${cols.map(quoteId).join(', ')}) VALUES (${cols.map(c => literal(values[c])).join(', ')})` : `INSERT INTO ${from} DEFAULT VALUES`;
      },
      update(from, values, key) {
        return `UPDATE TOP (1) ${from} SET ${Object.keys(values).map(c => `${quoteId(c)} = ${literal(values[c])}`).join(', ')} WHERE ${Object.keys(key).map(c => `${quoteId(c)} = ${literal(key[c])}`).join(' AND ')}`;
      },
      delete(from, key) {
        return `DELETE TOP (1) FROM ${from} WHERE ${Object.keys(key).map(c => `${quoteId(c)} = ${literal(key[c])}`).join(' AND ')}`;
      },
      deleteMany(from, pk, keys) {
        if (pk.length === 1) return `DELETE FROM ${from} WHERE ${quoteId(pk[0])} IN (${keys.map(k => literal(k[pk[0]])).join(', ')})`;
        return `DELETE FROM ${from} WHERE ${keys.map(k => `(${pk.map(c => `${quoteId(c)} = ${literal(k[c])}`).join(' AND ')})`).join(' OR ')}`;
      },
    },

    ddl: { createTableSql: ddl.createTableSql, DdlError: ddl.DdlError },
    schema: {
      statements: ddl.statements,
      // vincoli con il nome letto dal database (chiave primaria)
      diff: (from, to, renames) => {
        const r = common.diff(from, to, renames);
        r.ops = r.ops.map(op => (op.op === 'drop_primary_key' ? { ...op, name: from?.tables?.[op.table]?.primaryKeyName } : op));
        return r;
      },
      destructive: common.destructive, proposeName: common.proposeName,
    },

    errorInfo: e => ({ message: e?.originalError?.info?.message || e?.message || String(e), ...(e?.number ? { code: String(e.number) } : e?.code ? { code: e.code } : {}) }),
  };
};
