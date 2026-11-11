// SQL Server (T-SQL): classificazione delle istruzioni e riconoscimento delle istruzioni di
// schema. Solo le letture riconosciute partono senza conferma. GO non è T-SQL (è il separatore
// dei batch degli strumenti): rifiutato con un messaggio chiaro.

const READ_START = new Set(['SELECT', 'WITH']);
const BODY_WRITES = new Set(['INSERT', 'UPDATE', 'DELETE', 'MERGE', 'CREATE', 'ALTER', 'DROP', 'TRUNCATE', 'GRANT', 'REVOKE', 'DENY', 'EXEC', 'EXECUTE', 'BULK']);
// funzioni che leggono o scrivono fuori dal database
const WRITE_FUNCTIONS = new Set(['OPENROWSET', 'OPENQUERY', 'OPENDATASOURCE', 'NEXT']);
// suggerimenti di lock: una lettura che blocca righe
const LOCK_HINTS = /\bWITH\s*\(\s*[^)]*\b(UPDLOCK|XLOCK|HOLDLOCK|TABLOCKX|PAGLOCK|ROWLOCK|SERIALIZABLE)\b/;

const IDENT = '(\\[(?:[^\\]]|\\]\\])+\\]|"(?:[^"]|"")+"|[A-Za-z0-9_@#$]+)';
const QUALIFIED = `${IDENT}(?:\\s*\\.\\s*${IDENT}){0,2}`;
const unquote = id => (!id ? id : id.startsWith('[') ? id.slice(1, -1).replace(/]]/g, ']') : id.startsWith('"') ? id.slice(1, -1).replace(/""/g, '"') : id);
const slugOf = v => String(v ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
// ultima parte di un nome qualificato (database.schema.tabella)
const lastName = text => unquote(text.match(new RegExp(IDENT, 'g')).pop());

module.exports = function createMssqlSql(createSqlText, escape) {
  const text = createSqlText({ strings: ["'"], identifiers: { '"': '"', '[': ']' } });

  function classify(sql) {
    if (typeof sql !== 'string') return { kind: 'invalid', reason: 'missing' };
    const masked = text.mask(sql).trim().replace(/;\s*$/, '');
    if (!masked) return { kind: 'empty', reason: 'empty' };
    if (/^\s*GO\s*$/im.test(masked)) return { kind: 'invalid', verb: 'GO', reason: 'go_unsupported' };
    if (masked.includes(';')) return { kind: 'invalid', reason: 'single_statement' };
    const upper = masked.toUpperCase();
    const words = upper.match(/[A-Z_@#][A-Z0-9_@#$]*/g) || [];
    const verb = words[0] || '';
    const write = (reason, word) => ({ kind: 'write', verb, ...(reason ? { reason } : {}), ...(word ? { word } : {}) });
    if (verb === 'USE') return { kind: 'invalid', verb, reason: 'use_unsupported' };
    if (!READ_START.has(verb)) return write();
    const fn = [...upper.matchAll(/\b([A-Z_][A-Z0-9_]*)\s*\(/g)].map(m => m[1]).find(w => WRITE_FUNCTIONS.has(w));
    if (fn) return write('write_function', fn);
    if (/\bNEXT\s+VALUE\s+FOR\b/.test(upper)) return write('write_function', 'NEXT VALUE FOR');
    if (words.includes('INTO')) return write('into'); // SELECT … INTO crea una tabella
    if (LOCK_HINTS.test(upper)) return write('row_lock');
    const writeWord = [...upper.matchAll(/\b([A-Z_][A-Z0-9_]*)\b(\s*\()?/g)].filter(m => !m[2]).map(m => m[1]).find(w => BODY_WRITES.has(w));
    if (writeWord) return write('write_word', writeWord);
    return { kind: 'read', verb };
  }

  function schemaChange(sql) {
    if (typeof sql !== 'string') return null;
    const clean = sql.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ').trim().replace(/;\s*$/, '');
    const re = s => new RegExp(s, 'i');
    let m;
    if ((m = re(`^CREATE\\s+TABLE\\s+(${QUALIFIED})`).exec(clean))) return { table: lastName(m[1]), operation: 'create' };
    if ((m = re(`^DROP\\s+TABLE\\s+(?:IF\\s+EXISTS\\s+)?(${QUALIFIED})`).exec(clean))) return { table: lastName(m[1]), operation: 'drop' };
    if ((m = re(`^CREATE\\s+(?:UNIQUE\\s+)?(?:(?:NON)?CLUSTERED\\s+)?INDEX\\s+${IDENT}\\s+ON\\s+(${QUALIFIED})`).exec(clean))) return { table: lastName(m[2]), operation: `add_index_${slugOf(unquote(m[1]))}` };
    if ((m = re(`^DROP\\s+INDEX\\s+(?:IF\\s+EXISTS\\s+)?${IDENT}\\s+ON\\s+(${QUALIFIED})`).exec(clean))) return { table: lastName(m[2]), operation: `drop_index_${slugOf(unquote(m[1]))}` };
    if ((m = /^EXEC(?:UTE)?\s+sp_rename\s+N?'([^']+)'\s*,\s*N?'([^']+)'(?:\s*,\s*N?'COLUMN')?/i.exec(clean))) {
      const parts = m[1].split('.');
      return /'COLUMN'/i.test(clean) ? { table: parts[parts.length - 2] || 'schema', operation: `rename_${slugOf(parts.pop())}` } : { table: parts.pop(), operation: 'rename' };
    }
    if (!(m = re(`^ALTER\\s+TABLE\\s+(${QUALIFIED})\\s+([\\s\\S]*)$`).exec(clean))) return null;
    const table = lastName(m[1]);
    const clause = m[m.length - 1].trim();
    const rules = [
      [`^ADD\\s+CONSTRAINT\\s+${IDENT}\\s+FOREIGN\\s+KEY`, x => `add_fk_${slugOf(unquote(x[1]))}`],
      [`^ADD\\s+(?:CONSTRAINT\\s+${IDENT}\\s+)?PRIMARY\\s+KEY`, () => 'add_primary_key'],
      [`^ADD\\s+CONSTRAINT\\s+${IDENT}\\s+(?:UNIQUE|DEFAULT)`, x => `add_constraint_${slugOf(unquote(x[1]))}`],
      [`^ADD\\s+${IDENT}`, x => `add_${slugOf(unquote(x[1]))}`],
      [`^DROP\\s+CONSTRAINT\\s+(?:IF\\s+EXISTS\\s+)?${IDENT}`, x => `drop_constraint_${slugOf(unquote(x[1]))}`],
      [`^DROP\\s+COLUMN\\s+(?:IF\\s+EXISTS\\s+)?${IDENT}`, x => `drop_${slugOf(unquote(x[1]))}`],
      [`^ALTER\\s+COLUMN\\s+${IDENT}`, x => `modify_${slugOf(unquote(x[1]))}`],
    ];
    for (const [pattern, op] of rules) {
      const x = re(pattern).exec(clause);
      if (x) return { table, operation: op(x) };
    }
    return { table, operation: 'alter' };
  }

  // Conteggio: anche senza il suo ORDER BY finale (in SQL Server una sottoquery non può averlo
  // senza TOP/OFFSET)
  function countQuery(sql) {
    const c = text.countQuery(sql);
    if (!c) return c;
    const inner = c.sql.slice('SELECT COUNT(*) FROM (\n'.length, c.sql.lastIndexOf('\n)'));
    const blank = text.blank(inner);
    const m = /\bORDER\s+BY\b(?![\s\S]*\bORDER\s+BY\b)/i.exec(blank);
    if (m && !/[()]/.test(blank.slice(m.index))) {
      const before = blank.slice(0, m.index);
      if ((before.match(/\(/g) || []).length === (before.match(/\)/g) || []).length) {
        return { ...c, sql: `SELECT COUNT(*) FROM (\n${inner.slice(0, m.index).trimEnd()}\n) AS kelbo_count` };
      }
    }
    return c;
  }

  return {
    classify, schemaChange, countQuery,
    splitStatements: text.splitStatements, describeParams: text.describeParams,
    bindParams: (sql, values) => text.bindParams(sql, values, escape),
    placeholders: text.placeholders, mask: text.mask, blank: text.blank,
  };
};
