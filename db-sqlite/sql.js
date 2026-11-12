// SQLite: classificazione delle istruzioni e riconoscimento di quelle di schema. Solo le
// letture riconosciute partono senza conferma. PRAGMA è una lettura solo se interroga
// (senza "=") uno dei pragma che non cambiano nulla.

const READ_START = new Set(['SELECT', 'WITH', 'EXPLAIN', 'VALUES', 'PRAGMA']);
const BODY_WRITES = new Set(['INSERT', 'UPDATE', 'DELETE', 'REPLACE', 'CREATE', 'ALTER', 'DROP', 'ATTACH', 'DETACH', 'VACUUM', 'REINDEX']);
const READ_PRAGMAS = new Set(['TABLE_INFO', 'TABLE_XINFO', 'TABLE_LIST', 'INDEX_LIST', 'INDEX_INFO', 'INDEX_XINFO', 'FOREIGN_KEY_LIST',
  'FOREIGN_KEY_CHECK', 'DATABASE_LIST', 'COMPILE_OPTIONS', 'INTEGRITY_CHECK', 'QUICK_CHECK', 'COLLATION_LIST', 'FUNCTION_LIST',
  'MODULE_LIST', 'PRAGMA_LIST', 'PAGE_COUNT', 'PAGE_SIZE', 'FREELIST_COUNT', 'SCHEMA_VERSION', 'USER_VERSION', 'APPLICATION_ID',
  'ENCODING', 'JOURNAL_MODE', 'FOREIGN_KEYS', 'DATA_VERSION']);
const WRITE_FUNCTIONS = new Set(['LOAD_EXTENSION', 'WRITEFILE', 'READFILE', 'EDIT', 'FTS3_TOKENIZER']);

const IDENT = '("(?:[^"]|"")+"|`(?:[^`]|``)+`|\\[[^\\]]+\\]|[A-Za-z0-9_$]+)';
const QUALIFIED = `${IDENT}(?:\\s*\\.\\s*${IDENT})?`;
const unquote = id => (!id ? id : /^["`]/.test(id) ? id.slice(1, -1).replace(id[0] === '"' ? /""/g : /``/g, id[0]) : id.startsWith('[') ? id.slice(1, -1) : id);
const lastPart = (a, b) => unquote(b || a);
const slugOf = v => String(v ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');

module.exports = function createSqliteSql(createSqlText, escape) {
  // SQLite accetta anche `…` e […] come identificatori, per compatibilità
  const text = createSqlText({ strings: ["'"], identifiers: { '"': '"', '`': '`', '[': ']' } });

  function classify(sql) {
    if (typeof sql !== 'string') return { kind: 'invalid', reason: 'missing' };
    const masked = text.mask(sql).trim().replace(/;\s*$/, '');
    if (!masked) return { kind: 'empty', reason: 'empty' };
    if (masked.includes(';')) return { kind: 'invalid', reason: 'single_statement' };
    const upper = masked.toUpperCase();
    const words = upper.match(/[A-Z_][A-Z0-9_$]*/g) || [];
    const verb = words[0] || '';
    const write = (reason, word) => ({ kind: 'write', verb, ...(reason ? { reason } : {}), ...(word ? { word } : {}) });
    if (!READ_START.has(verb)) return write();
    if (verb === 'PRAGMA') {
      const name = /^PRAGMA\s+(?:[A-Z_][A-Z0-9_]*\s*\.\s*)?([A-Z_][A-Z0-9_]*)/.exec(upper)?.[1];
      return READ_PRAGMAS.has(name) && !upper.includes('=') && !(name === 'JOURNAL_MODE' && upper.includes('(')) ? { kind: 'read', verb } : write();
    }
    const fn = [...upper.matchAll(/\b([A-Z_][A-Z0-9_]*)\s*\(/g)].map(m => m[1]).find(w => WRITE_FUNCTIONS.has(w));
    if (fn) return write('write_function', fn.toLowerCase());
    if (verb === 'EXPLAIN') return { kind: 'read', verb }; // EXPLAIN in SQLite non esegue l'istruzione
    const writeWord = [...upper.matchAll(/\b([A-Z_][A-Z0-9_]*)\b(\s*\()?/g)].filter(m => !m[2]).map(m => m[1]).find(w => BODY_WRITES.has(w));
    if (writeWord) return write('write_word', writeWord);
    return { kind: 'read', verb };
  }

  function schemaChange(sql) {
    if (typeof sql !== 'string') return null;
    const clean = sql.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ').trim().replace(/;\s*$/, '');
    const re = s => new RegExp(s, 'i');
    let m;
    if ((m = re(`^CREATE\\s+(?:TEMP(?:ORARY)?\\s+)?TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?${QUALIFIED}`).exec(clean))) return { table: lastPart(m[1], m[2]), operation: 'create' };
    if ((m = re(`^DROP\\s+TABLE\\s+(?:IF\\s+EXISTS\\s+)?${QUALIFIED}`).exec(clean))) return { table: lastPart(m[1], m[2]), operation: 'drop' };
    if ((m = re(`^CREATE\\s+(?:UNIQUE\\s+)?INDEX\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?${QUALIFIED}\\s+ON\\s+${IDENT}`).exec(clean))) return { table: unquote(m[3]), operation: `add_index_${slugOf(lastPart(m[1], m[2]))}` };
    if ((m = re(`^DROP\\s+INDEX\\s+(?:IF\\s+EXISTS\\s+)?${QUALIFIED}`).exec(clean))) return { table: 'schema', operation: `drop_index_${slugOf(lastPart(m[1], m[2]))}` };
    if (!(m = re(`^ALTER\\s+TABLE\\s+${QUALIFIED}\\s+([\\s\\S]*)$`).exec(clean))) return null;
    const table = lastPart(m[1], m[2]);
    const clause = m[3].trim();
    const rules = [
      [`^RENAME\\s+(?:COLUMN\\s+)?${IDENT}\\s+TO`, x => `rename_${slugOf(unquote(x[1]))}`],
      [`^RENAME\\s+TO\\s+`, () => 'rename'],
      [`^ADD\\s+(?:COLUMN\\s+)?${IDENT}`, x => `add_${slugOf(unquote(x[1]))}`],
      [`^DROP\\s+(?:COLUMN\\s+)?${IDENT}`, x => `drop_${slugOf(unquote(x[1]))}`],
    ];
    for (const [pattern, op] of rules) {
      const x = re(pattern).exec(clause);
      if (x) return { table, operation: op(x) };
    }
    return { table, operation: 'alter' };
  }

  return {
    classify, schemaChange,
    splitStatements: text.splitStatements, describeParams: text.describeParams,
    bindParams: (sql, values) => text.bindParams(sql, values, escape),
    countQuery: text.countQuery, placeholders: text.placeholders,
  };
};
