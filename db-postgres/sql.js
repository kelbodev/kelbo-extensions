// PostgreSQL: classificazione delle istruzioni prima di eseguirle e riconoscimento delle
// istruzioni di schema (nome della migration). Solo le letture riconosciute partono senza
// conferma: tutto il resto, istruzioni sconosciute comprese, è trattato come scrittura.
// createSqlText: lo strumento del db-client (ctx.require('db-client').sqlText).

const READ_START = new Set(['SELECT', 'WITH', 'SHOW', 'EXPLAIN', 'TABLE', 'VALUES']);
// parole che in una lettura indicano una scrittura (CTE che modificano dati, SELECT … INTO)
const BODY_WRITES = new Set(['INSERT', 'UPDATE', 'DELETE', 'MERGE', 'CREATE', 'ALTER', 'DROP', 'TRUNCATE', 'GRANT', 'REVOKE', 'COPY']);
// funzioni che cambiano qualcosa anche dentro una SELECT
const WRITE_FUNCTIONS = new Set([
  'NEXTVAL', 'SETVAL', 'PG_TERMINATE_BACKEND', 'PG_CANCEL_BACKEND', 'PG_RELOAD_CONF', 'PG_ROTATE_LOGFILE',
  'LO_UNLINK', 'LO_IMPORT', 'LO_EXPORT', 'LO_CREATE', 'LO_FROM_BYTEA', 'LO_PUT', 'DBLINK_EXEC', 'DBLINK',
  'PG_ADVISORY_LOCK', 'PG_ADVISORY_XACT_LOCK', 'PG_TRY_ADVISORY_LOCK', 'PG_ADVISORY_UNLOCK_ALL',
  'PG_SWITCH_WAL', 'SET_CONFIG', 'PG_CREATE_RESTORE_POINT', 'PG_PROMOTE', 'PG_STAT_RESET',
  'PG_READ_FILE', 'PG_READ_BINARY_FILE', 'PG_LS_DIR', 'PG_FILE_WRITE', 'PG_LOGICAL_EMIT_MESSAGE',
  'PG_CREATE_LOGICAL_REPLICATION_SLOT', 'PG_DROP_REPLICATION_SLOT', 'TXID_CURRENT', 'PG_CURRENT_XACT_ID',
]);

const IDENT = '("(?:[^"]|"")+"|[A-Za-z0-9_$]+)';
const QUALIFIED = `${IDENT}(?:\\s*\\.\\s*${IDENT})?`;
const unquote = id => (id && id.startsWith('"') ? id.slice(1, -1).replace(/""/g, '"') : id);
const lastPart = (a, b) => unquote(b || a);
const slugOf = v => String(v ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');

module.exports = function createPgSql(createSqlText, escape) {
  const text = createSqlText({ strings: ["'"], identifiers: { '"': '"' }, eStrings: true, dollarQuotes: true });

  // { kind: 'read' | 'write' | 'empty' | 'invalid', verb, reason?, word? }
  function classify(sql) {
    if (typeof sql !== 'string') return { kind: 'invalid', reason: 'missing' };
    const masked = text.mask(sql).trim().replace(/;\s*$/, '');
    if (!masked) return { kind: 'empty', reason: 'empty' };
    if (masked.includes(';')) return { kind: 'invalid', reason: 'single_statement' };
    const upper = masked.toUpperCase();
    const words = upper.match(/[A-Z_][A-Z0-9_$]*/g) || [];
    const verb = words[0] || '';
    const has = w => words.includes(w);
    const write = (reason, word) => ({ kind: 'write', verb, ...(reason ? { reason } : {}), ...(word ? { word } : {}) });

    if (!READ_START.has(verb)) return write();
    if (verb === 'SHOW') return { kind: 'read', verb };
    // funzioni con effetti (nextval, pg_terminate_backend…): mai senza conferma
    const fn = [...upper.matchAll(/\b([A-Z_][A-Z0-9_$]*)\s*\(/g)].map(m => m[1]).find(w => WRITE_FUNCTIONS.has(w));
    if (fn) return write('write_function', fn.toLowerCase());
    // EXPLAIN senza ANALYZE non esegue l'istruzione; con ANALYZE la esegue
    if (verb === 'EXPLAIN') {
      if (!has('ANALYZE')) return { kind: 'read', verb };
      return words.slice(1).some(w => BODY_WRITES.has(w)) ? write('explain_analyze_write') : { kind: 'read', verb };
    }
    if (has('INTO')) return write('into'); // SELECT … INTO crea una tabella
    if (/\bFOR\s+(?:NO\s+KEY\s+UPDATE|UPDATE|KEY\s+SHARE|SHARE)\b/.test(upper)) return write('row_lock');
    const writeWord = [...upper.matchAll(/\b([A-Z_][A-Z0-9_$]*)\b(\s*\()?/g)].filter(m => !m[2]).map(m => m[1]).find(w => BODY_WRITES.has(w));
    if (writeWord) return write('write_word', writeWord);
    return { kind: 'read', verb };
  }

  // { table, operation } per le istruzioni di schema; null se non riconosciuta
  function schemaChange(sql) {
    if (typeof sql !== 'string') return null;
    const clean = sql.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--\s[^\n]*/g, ' ').trim().replace(/;\s*$/, '');
    const re = s => new RegExp(s, 'i');
    let m;
    if ((m = re(`^CREATE\\s+(?:(?:GLOBAL|LOCAL)\\s+)?(?:TEMP(?:ORARY)?\\s+|UNLOGGED\\s+)?TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?${QUALIFIED}`).exec(clean))) return { table: lastPart(m[1], m[2]), operation: 'create' };
    if ((m = re(`^DROP\\s+TABLE\\s+(?:IF\\s+EXISTS\\s+)?${QUALIFIED}`).exec(clean))) return { table: lastPart(m[1], m[2]), operation: 'drop' };
    if ((m = re(`^CREATE\\s+(?:UNIQUE\\s+)?INDEX\\s+(?:CONCURRENTLY\\s+)?(?:IF\\s+NOT\\s+EXISTS\\s+)?${IDENT}\\s+ON\\s+(?:ONLY\\s+)?${QUALIFIED}`).exec(clean))) return { table: lastPart(m[2], m[3]), operation: `add_index_${slugOf(unquote(m[1]))}` };
    if ((m = re(`^DROP\\s+INDEX\\s+(?:CONCURRENTLY\\s+)?(?:IF\\s+EXISTS\\s+)?${QUALIFIED}`).exec(clean))) return { table: 'schema', operation: `drop_index_${slugOf(lastPart(m[1], m[2]))}` };
    if (!(m = re(`^ALTER\\s+TABLE\\s+(?:IF\\s+EXISTS\\s+)?(?:ONLY\\s+)?${QUALIFIED}\\s+([\\s\\S]*)$`).exec(clean))) return null;
    const table = lastPart(m[1], m[2]);
    const clause = m[3].trim();
    // più clausole separate da virgole al primo livello
    let depth = 0, commas = 0;
    for (const ch of text.blank(clause)) { if (ch === '(') depth++; else if (ch === ')') depth--; else if (ch === ',' && !depth) commas++; }
    if (commas) return { table, operation: 'alter' };
    const rules = [
      [`^RENAME\\s+COLUMN\\s+${IDENT}`, x => `rename_${slugOf(unquote(x[1]))}`],
      [`^RENAME\\s+TO\\s+`, () => 'rename'],
      [`^RENAME\\s+${IDENT}\\s+TO`, x => `rename_${slugOf(unquote(x[1]))}`],
      [`^ADD\\s+CONSTRAINT\\s+${IDENT}\\s+FOREIGN\\s+KEY`, x => `add_fk_${slugOf(unquote(x[1]))}`],
      [`^ADD\\s+FOREIGN\\s+KEY`, () => 'add_fk'],
      [`^ADD\\s+(?:CONSTRAINT\\s+${IDENT}\\s+)?PRIMARY\\s+KEY`, () => 'add_primary_key'],
      [`^ADD\\s+CONSTRAINT\\s+${IDENT}\\s+UNIQUE`, x => `add_index_${slugOf(unquote(x[1]))}`],
      [`^ADD\\s+(?:COLUMN\\s+)?(?:IF\\s+NOT\\s+EXISTS\\s+)?${IDENT}`, x => `add_${slugOf(unquote(x[1]))}`],
      [`^DROP\\s+CONSTRAINT\\s+(?:IF\\s+EXISTS\\s+)?${IDENT}`, x => `drop_constraint_${slugOf(unquote(x[1]))}`],
      [`^DROP\\s+(?:COLUMN\\s+)?(?:IF\\s+EXISTS\\s+)?${IDENT}`, x => `drop_${slugOf(unquote(x[1]))}`],
      [`^ALTER\\s+(?:COLUMN\\s+)?${IDENT}`, x => `modify_${slugOf(unquote(x[1]))}`],
    ];
    for (const [pattern, op] of rules) {
      const x = re(pattern).exec(clause);
      if (x) return { table, operation: op(x) };
    }
    return { table, operation: 'alter' };
  }

  return {
    classify,
    schemaChange,
    splitStatements: text.splitStatements,
    describeParams: text.describeParams,
    bindParams: (sql, values) => text.bindParams(sql, values, escape),
    countQuery: text.countQuery,
    placeholders: text.placeholders,
    mask: text.mask,
  };
};
