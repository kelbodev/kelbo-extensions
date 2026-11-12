// Motore Oracle Database per la sezione Database (capacità "db-engine" del db-client).
// Il database è il servizio della connessione; il livello sotto la connessione è lo schema
// (l'utente collegato per primo). Driver oracledb in modalità Thin (JavaScript puro, niente
// Instant Client).
const oracledb = require('oracledb');
const ddl = require('./ddl');

const QUERY_TIMEOUT_MS = 30000;
const { quoteId, literal } = ddl;

const KEYWORDS = `ADD ALL ALTER AND ANY AS ASC BEGIN BETWEEN BINARY_DOUBLE BINARY_FLOAT BLOB BY CASCADE CASE CHAR CHECK CLOB COLUMN COMMENT COMMIT
CONNECT CONSTRAINT CREATE CROSS CURRENT_TIMESTAMP DATE DECLARE DEFAULT DELETE DESC DISTINCT DROP DUAL ELSE END EXCEPTION EXISTS FETCH FIRST
FOR FOREIGN FROM FULL FUNCTION GENERATED GRANT GROUP HAVING IDENTITY IF IN INDEX INNER INSERT INTEGER INTERSECT INTO IS JOIN KEY LEFT LIKE
LOOP MATCHED MERGE MINUS MODIFY NCHAR NCLOB NEXT NOT NULL NUMBER NVARCHAR2 OFFSET ON ONLY OR ORDER OUTER PACKAGE PRIMARY PROCEDURE RAW
REFERENCES RENAME REPLACE RETURN ROLLBACK ROWNUM ROWS SELECT SEQUENCE SET SYSDATE SYSTIMESTAMP TABLE THEN TIMESTAMP TO TRIGGER TRUNCATE
UNION UNIQUE UPDATE USING VALUES VARCHAR2 VIEW WHEN WHERE WITH`.split(/\s+/).filter(Boolean);

// Valori come testo, come le stringhe di MySQL. In modalità Thin le date arrivano come Date
// nell'ora locale del processo: si riscrivono con le stesse parti (quelle salvate nel database);
// i TIMESTAMP WITH TIME ZONE sono istanti, scritti in UTC. LOB testuali come stringhe, BLOB come Buffer
const pad = (n, w = 2) => String(n).padStart(w, '0');
const localText = (d, fraction) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}${fraction && d.getMilliseconds() ? `.${pad(d.getMilliseconds(), 3)}` : ''}`;
const utcText = d => `${d.toISOString().replace('T', ' ').replace(/\.000Z$|Z$/, '')} +00:00`;
const dateConverter = fn => ({ converter: v => (v instanceof Date ? fn(v) : v) });
function fetchTypeHandler(meta) {
  switch (meta.dbType) {
    case oracledb.DB_TYPE_DATE: return dateConverter(d => localText(d, false));
    case oracledb.DB_TYPE_TIMESTAMP: return dateConverter(d => localText(d, true));
    case oracledb.DB_TYPE_TIMESTAMP_TZ: case oracledb.DB_TYPE_TIMESTAMP_LTZ: return dateConverter(utcText);
    case oracledb.DB_TYPE_CLOB: case oracledb.DB_TYPE_NCLOB: return { type: oracledb.STRING };
    case oracledb.DB_TYPE_BLOB: return { type: oracledb.BUFFER };
    default: return undefined;
  }
}
const isJsonValue = v => v !== null && typeof v === 'object' && !Buffer.isBuffer(v) && !(v instanceof Date);
function cell(v) {
  if (Buffer.isBuffer(v)) return v.length <= 64 ? `0x${v.toString('hex')}` : `0x${v.subarray(0, 64).toString('hex')}… (${v.length} byte)`;
  if (v instanceof Date) return v.toISOString().replace('T', ' ').replace('Z', '');
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (isJsonValue(v)) return JSON.stringify(v);
  return v;
}
const typeLabel = c => {
  const t = String(c.DATA_TYPE);
  if (['VARCHAR2', 'NVARCHAR2', 'CHAR', 'NCHAR'].includes(t)) return `${t}(${c.CHAR_LENGTH || c.DATA_LENGTH}${c.CHAR_USED === 'C' && !t.startsWith('N') ? ' CHAR' : ''})`;
  if (t === 'RAW') return `RAW(${c.DATA_LENGTH})`;
  if (t === 'NUMBER' && c.DATA_PRECISION !== null) return `NUMBER(${c.DATA_PRECISION},${c.DATA_SCALE})`;
  if (t === 'NUMBER' && c.DATA_SCALE === 0) return 'INTEGER';
  return t;
};
const metaType = m => m.dbTypeName || m.dbType?.name || '';

module.exports = function createOracleEngine({ sqlText, schemaDiff }) {
  const sql = ddl.createOracleSql(sqlText, literal);
  const common = schemaDiff({
    typeKinds: ddl.TYPES, typeAliases: ddl.TYPE_ALIASES, positions: false,
    fkAction: a => { const v = String(a || '').toUpperCase(); return !v || v === 'RESTRICT' ? 'NO ACTION' : v; },
  });
  // ? dei testi generati dal db-client → :1, :2…
  const toNumbered = text => {
    let n = 0, out = '', last = 0;
    for (const p of sql.placeholders(text).filter(x => x.kind === 'positional')) { out += text.slice(last, p.start) + `:${++n}`; last = p.end; }
    return out + text.slice(last);
  };
  const format = (template, params) => {
    let i = 0, out = '', last = 0;
    for (const p of sql.placeholders(template).filter(x => x.kind === 'positional')) { out += template.slice(last, p.start) + literal(params[i++]); last = p.end; }
    return out + template.slice(last);
  };
  const bind = v => (typeof v === 'boolean' ? (v ? 1 : 0) : v === undefined ? null : v);
  // Il ";" finale è un errore in SQL (ORA-00933/ORA-00911), ma chiude i blocchi PL/SQL
  const statementText = text => (sql.isPlsql(text) ? text.trim() : text.trim().replace(/;\s*$/, ''));

  const connectString = o => {
    const host = o.host || 'localhost', port = Number(o.port) || 1521, name = o.database || 'FREEPDB1';
    return o.options?.connectBy === 'sid'
      ? `(DESCRIPTION=(ADDRESS=(PROTOCOL=TCP)(HOST=${host})(PORT=${port}))(CONNECT_DATA=(SID=${name})))`
      : `${host}:${port}/${name}`;
  };
  // Ogni connessione nuova: formati NLS delle date come in MySQL e schema corrente
  const sessionSetup = schema => async (conn, tag, done) => {
    try {
      await conn.execute(`ALTER SESSION SET NLS_DATE_FORMAT = 'YYYY-MM-DD HH24:MI:SS' NLS_TIMESTAMP_FORMAT = 'YYYY-MM-DD HH24:MI:SS.FF'
        NLS_TIMESTAMP_TZ_FORMAT = 'YYYY-MM-DD HH24:MI:SS.FF TZH:TZM' NLS_NUMERIC_CHARACTERS = '.,'`);
      if (schema) await conn.execute(`ALTER SESSION SET CURRENT_SCHEMA = ${quoteId(schema)}`);
      done();
    } catch (e) { done(e); }
  };
  function open(o, max) {
    const ready = oracledb.createPool({
      user: o.user, password: o.password, connectString: connectString(o), poolMin: 0, poolMax: max, poolIncrement: 1,
      poolTimeout: 60, connectTimeout: Math.ceil((o.connectTimeout || 10000) / 1000), sessionCallback: sessionSetup(o.schema), stmtCacheSize: 30,
    });
    ready.catch(() => {});
    return { ready, options: o };
  }
  // Connessione per un'operazione: quella della sessione o una del pool (chiusa alla fine)
  async function withConnection(target, fn) {
    if (target.conn) return fn(target.conn);
    const conn = await (await target.ready).getConnection();
    try { return await fn(conn); } finally { await conn.close().catch(() => {}); }
  }
  const options = extra => ({ fetchTypeHandler, ...extra });
  async function rowsOf(wrap, text, params = []) {
    return withConnection(wrap, async conn => {
      conn.callTimeout = QUERY_TIMEOUT_MS;
      return (await conn.execute(toNumbered(text), params.map(bind), options({ outFormat: oracledb.OUT_FORMAT_OBJECT }))).rows || [];
    });
  }

  async function run(conn, text, limit, autoCommit) {
    const started = Date.now();
    conn.callTimeout = QUERY_TIMEOUT_MS;
    const r = await conn.execute(statementText(text), [], options({ resultSet: true, outFormat: oracledb.OUT_FORMAT_ARRAY, autoCommit }));
    if (r.resultSet) {
      try {
        const rows = await r.resultSet.getRows(limit + 1);
        const truncated = rows.length > limit;
        const kept = truncated ? rows.slice(0, limit) : rows;
        return {
          kind: 'rows', ms: Date.now() - started, truncated, rowCount: kept.length,
          columns: r.metaData.map(m => ({ name: m.name, table: null, db: null, column: null, type: metaType(m) })),
          rows: kept.map(row => row.map(cell)),
        };
      } finally { await r.resultSet.close().catch(() => {}); }
    }
    return { kind: 'result', ms: Date.now() - started, affectedRows: r.rowsAffected ?? 0, changedRows: null, insertId: null, warningStatus: r.warning ? 1 : 0, info: '' };
  }

  return {
    driver: () => ({ name: 'oracledb', version: require('oracledb/package.json').version }),
    connection: {
      fields: ['host', 'port', 'user', 'password', 'database'], defaultPort: 1521, tunnel: true,
      options: [
        { key: 'connectBy', type: 'select', default: 'service',
          label: { it: 'Il database indica', en: 'The database is' },
          choices: [
            { value: 'service', label: { it: 'Nome del servizio (es. FREEPDB1, ORCLPDB1)', en: 'Service name (e.g. FREEPDB1, ORCLPDB1)' } },
            { value: 'sid', label: { it: 'SID (database vecchi)', en: 'SID (older databases)' } },
          ] },
      ],
    },
    defaultSchema: conn => (conn?.user ? String(conn.user).toUpperCase() : null),
    dialect: {
      quote: '"',
      keywords: KEYWORDS,
      schemas: true,
      ddl: {
        types: Object.keys(ddl.TYPES), fkActions: ddl.FK_ACTIONS, engines: [],
        features: { unsigned: false, onUpdate: false, charset: false, positions: false, idType: 'NUMBER',
          decimalTypes: ['NUMBER'], temporalTypes: ['TIMESTAMP', 'TIMESTAMP WITH TIME ZONE'], valueTypes: [] },
      },
      snippets: {
        firstRows: 'SELECT * FROM {table} FETCH FIRST 100 ROWS ONLY;',
        count: 'SELECT COUNT(*) AS {alias} FROM {table};',
        distinct: 'SELECT DISTINCT {column} FROM {table} ORDER BY {column};',
      },
    },

    // ---- connessione ----
    createPool: o => open(o, 4),
    closePool(wrap) { wrap.ready.then(p => p.close(0)).catch(() => {}); },
    async test(o) {
      const conn = await oracledb.getConnection({ user: o.user, password: o.password, connectString: connectString(o), connectTimeout: Math.ceil((o.connectTimeout || 10000) / 1000) });
      try {
        const r = await conn.execute(`SELECT USER AS "user", SYS_CONTEXT('USERENV', 'DB_NAME') AS "db" FROM dual`, [], { outFormat: oracledb.OUT_FORMAT_OBJECT });
        return { version: `Oracle ${conn.oracleServerVersionString}`, ...r.rows[0] };
      } finally { await conn.close().catch(() => {}); }
    },
    // Sessione: una connessione del pool tenuta fino al rilascio
    async acquire(wrap) { const conn = await (await wrap.ready).getConnection(); return { conn }; },
    release(session) { session.conn.close().catch(() => {}); },

    async query(wrap, text, params = [], { rowsAsArray = false } = {}) {
      return withConnection(wrap, async conn => {
        conn.callTimeout = QUERY_TIMEOUT_MS;
        const r = await conn.execute(toNumbered(text), params.map(bind), options({ outFormat: rowsAsArray ? oracledb.OUT_FORMAT_ARRAY : oracledb.OUT_FORMAT_OBJECT }));
        return { rows: rowsAsArray ? (r.rows || []).map(row => row.map(cell)) : r.rows || [], fields: r.metaData || [] };
      });
    },

    async execute(wrap, text, limit, { readOnly = false, session = null } = {}) {
      return withConnection(session || wrap, async conn => {
        if (!readOnly) return run(conn, text, limit, true);
        // sola lettura: transazione READ ONLY sempre annullata (una scrittura dà ORA-01456)
        await conn.execute('SET TRANSACTION READ ONLY');
        try { return await run(conn, text, limit, false); } finally { await conn.rollback().catch(() => {}); }
      });
    },

    // Le DDL di Oracle confermano da sole la transazione: qui l'atomicità vale solo per i dati
    async transaction(wrap, statements) {
      return withConnection(wrap, async conn => {
        let affected = 0;
        try {
          for (const s of statements) affected += (await conn.execute(statementText(s), [], { autoCommit: false })).rowsAffected || 0;
          await conn.commit();
        } catch (e) {
          await conn.rollback().catch(() => {});
          throw e;
        }
        return affected;
      });
    },

    async *stream(wrap, text, params = []) {
      const conn = await (await wrap.ready).getConnection();
      try {
        const r = await conn.execute(toNumbered(text), params.map(bind), options({ resultSet: true, outFormat: oracledb.OUT_FORMAT_ARRAY }));
        try {
          yield { fields: r.metaData.map(m => m.name) };
          for (let rows; (rows = await r.resultSet.getRows(200)).length;) for (const row of rows) yield row;
        } finally { await r.resultSet.close().catch(() => {}); }
      } finally { await conn.close().catch(() => {}); }
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
    asText: column => `TO_CHAR(${column})`,
    // LIKE distingue maiuscole e minuscole e ILIKE non esiste; TO_CHAR non accetta i BLOB (RAW li converte in esadecimale)
    search: column => `UPPER(TO_CHAR(${column})) LIKE UPPER(?)`,
    page: (text, params, limit, offset) => ({ sql: `${text} OFFSET ? ROWS FETCH NEXT ? ROWS ONLY`, params: [...params, offset, limit] }),

    // ---- metadati ----
    async listDatabases(wrap) {
      const rows = await rowsOf(wrap, `SELECT username FROM all_users WHERE oracle_maintained = 'N'
        ORDER BY CASE WHEN username = USER THEN 0 ELSE 1 END, username`);
      return rows.map(r => r.USERNAME);
    },
    async listTables(wrap, schema) {
      const rows = await rowsOf(wrap,
        `SELECT t.table_name AS "name", 'BASE TABLE' AS "type", t.num_rows AS "rowsEstimate", c.comments AS "comment"
           FROM all_tables t LEFT JOIN all_tab_comments c ON c.owner = t.owner AND c.table_name = t.table_name
          WHERE t.owner = ? AND t.dropped = 'NO' AND t.nested = 'NO' AND t.secondary = 'N' AND (t.iot_type IS NULL OR t.iot_type = 'IOT')
         UNION ALL
         SELECT v.view_name, 'VIEW', NULL, c.comments FROM all_views v LEFT JOIN all_tab_comments c ON c.owner = v.owner AND c.table_name = v.view_name
          WHERE v.owner = ?
          ORDER BY 1`, [schema, schema]);
      return rows.map(t => ({ ...t, engine: null, rowsEstimate: t.rowsEstimate === null ? null : Number(t.rowsEstimate), comment: t.comment || '', view: t.type === 'VIEW' }));
    },
    async columns(wrap, schema, table) {
      const [cols, pk] = await Promise.all([
        rowsOf(wrap, `SELECT t.column_name, t.data_type, t.data_length, t.char_length, t.char_used, t.data_precision, t.data_scale, t.nullable,
                             t.data_default, t.identity_column, c.comments
                        FROM all_tab_cols t LEFT JOIN all_col_comments c ON c.owner = t.owner AND c.table_name = t.table_name AND c.column_name = t.column_name
                       WHERE t.owner = ? AND t.table_name = ? AND t.hidden_column = 'NO' ORDER BY t.column_id`, [schema, table]),
        rowsOf(wrap, `SELECT cc.column_name FROM all_constraints k JOIN all_cons_columns cc ON cc.owner = k.owner AND cc.constraint_name = k.constraint_name
                       WHERE k.owner = ? AND k.table_name = ? AND k.constraint_type = 'P'`, [schema, table]),
      ]);
      const pks = new Set(pk.map(r => r.COLUMN_NAME));
      return cols.map(c => ({
        name: c.COLUMN_NAME, type: typeLabel(c), dataType: c.DATA_TYPE, nullable: c.NULLABLE === 'Y',
        key: pks.has(c.COLUMN_NAME) ? 'PRI' : '', default: c.DATA_DEFAULT === null ? null : String(c.DATA_DEFAULT).trim(),
        extra: c.IDENTITY_COLUMN === 'YES' ? 'identity' : '', comment: c.COMMENTS || '',
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
    // Testo dal database (DBMS_METADATA), come SHOW CREATE TABLE; viste comprese
    async createTableText(wrap, schema, table) {
      const [obj] = await rowsOf(wrap, `SELECT object_type FROM all_objects WHERE owner = ? AND object_name = ? AND object_type IN ('TABLE', 'VIEW')`, [schema, table]);
      if (!obj) return `-- ${table}: structure not available`;
      try {
        return await withConnection(wrap, async conn => {
          // senza gli attributi fisici (storage, tablespace): solo la struttura
          await conn.execute(`BEGIN
            DBMS_METADATA.SET_TRANSFORM_PARAM(DBMS_METADATA.SESSION_TRANSFORM, 'SEGMENT_ATTRIBUTES', FALSE);
            DBMS_METADATA.SET_TRANSFORM_PARAM(DBMS_METADATA.SESSION_TRANSFORM, 'STORAGE', FALSE);
            DBMS_METADATA.SET_TRANSFORM_PARAM(DBMS_METADATA.SESSION_TRANSFORM, 'SQLTERMINATOR', TRUE);
          END;`);
          const r = await conn.execute('SELECT DBMS_METADATA.GET_DDL(:1, :2, :3) AS "ddl" FROM dual', [obj.OBJECT_TYPE, table, schema],
            options({ outFormat: oracledb.OUT_FORMAT_OBJECT }));
          await conn.execute("BEGIN DBMS_METADATA.SET_TRANSFORM_PARAM(DBMS_METADATA.SESSION_TRANSFORM, 'DEFAULT'); END;").catch(() => {});
          return String(r.rows[0].ddl).trim();
        });
      } catch {
        const def = (await this.introspect(wrap, schema, [table])).tables[table];
        if (!def) return `-- ${table}: structure not available`;
        return ddl.createTableSql(schema, { ...def, name: table, columns: def.columns.map(c => (c.unsupported ? { ...c, type: 'CLOB', unsupported: undefined } : c)) });
      }
    },
    introspect: (wrap, schema, tables) => ddl.introspect((t, p) => rowsOf(wrap, t, p), schema, tables),

    dml: {
      insert(from, values) {
        const cols = Object.keys(values);
        return cols.length ? `INSERT INTO ${from} (${cols.map(quoteId).join(', ')}) VALUES (${cols.map(c => literal(values[c])).join(', ')})` : `INSERT INTO ${from} VALUES (DEFAULT)`;
      },
      update(from, values, key) {
        return `UPDATE ${from} SET ${Object.keys(values).map(c => `${quoteId(c)} = ${literal(values[c])}`).join(', ')} WHERE ${Object.keys(key).map(c => `${quoteId(c)} = ${literal(key[c])}`).join(' AND ')} AND ROWNUM = 1`;
      },
      delete(from, key) {
        return `DELETE FROM ${from} WHERE ${Object.keys(key).map(c => `${quoteId(c)} = ${literal(key[c])}`).join(' AND ')} AND ROWNUM = 1`;
      },
      deleteMany(from, pk, keys) {
        if (pk.length === 1) return `DELETE FROM ${from} WHERE ${quoteId(pk[0])} IN (${keys.map(k => literal(k[pk[0]])).join(', ')})`;
        return `DELETE FROM ${from} WHERE ${keys.map(k => `(${pk.map(c => `${quoteId(c)} = ${literal(k[c])}`).join(' AND ')})`).join(' OR ')}`;
      },
    },

    ddl: { createTableSql: ddl.createTableSql, DdlError: ddl.DdlError },
    schema: {
      statements: ddl.statements,
      // modify_column con la colonna di prima: MODIFY ripete solo ciò che cambia
      diff: (from, to, renames) => {
        const r = common.diff(from, to, renames);
        r.ops = r.ops.map(op => (op.op === 'modify_column'
          ? { ...op, previous: (from?.tables?.[op.table]?.columns || []).find(c => c.name === op.name) }
          : op));
        return r;
      },
      destructive: common.destructive, proposeName: common.proposeName,
    },

    errorInfo: e => ({ message: e?.message || String(e), ...(e?.code ? { code: e.code } : e?.errorNum ? { code: `ORA-${String(e.errorNum).padStart(5, '0')}` } : {}) }),
  };
};
