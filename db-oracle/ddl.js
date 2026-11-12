// Oracle: classificazione, divisione delle istruzioni (anche blocchi PL/SQL chiusi da una riga
// con "/"), DDL dal modello del designer e struttura dalle viste ALL_*. Lo schema è l'utente.

const quoteId = name => '"' + String(name).replace(/"/g, '""') + '"';
const NAME_RE = /^[^\x00"]{1,128}$/;

function literal(v) {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'boolean') return v ? '1' : '0';
  if (typeof v === 'number' || typeof v === 'bigint') return Number.isFinite(Number(v)) ? String(v) : `'${String(v)}'`;
  if (Buffer.isBuffer(v)) return `HEXTORAW('${v.toString('hex')}')`;
  if (v instanceof Date) return `TIMESTAMP '${v.toISOString().replace('T', ' ').replace('Z', '')}'`;
  if (typeof v === 'object') return `'${JSON.stringify(v).replace(/'/g, "''")}'`;
  return `'${String(v).replace(/\x00/g, '').replace(/'/g, "''")}'`;
}

// ---- testo SQL ----
const READ_START = new Set(['SELECT', 'WITH']);
const BODY_WRITES = new Set(['INSERT', 'UPDATE', 'DELETE', 'MERGE', 'CREATE', 'ALTER', 'DROP', 'TRUNCATE', 'GRANT', 'REVOKE']);
const PLSQL_START = /^\s*(?:BEGIN|DECLARE|CREATE\s+(?:OR\s+REPLACE\s+)?(?:EDITIONABLE\s+|NONEDITIONABLE\s+)?(?:PROCEDURE|FUNCTION|PACKAGE|TRIGGER|TYPE)\b)/i;

function createOracleSql(createSqlText, escape) {
  const text = createSqlText({ strings: ["'"], identifiers: { '"': '"' }, qQuotes: true, countAlias: ' kelbo_count' });

  // Istruzioni: i blocchi PL/SQL finiscono con una riga che contiene solo "/" (come in SQL*Plus),
  // il resto si divide ai ";"
  function splitStatements(sql) {
    if (typeof sql !== 'string') return [];
    const out = [];
    let offset = 0;
    for (const chunk of sql.split(/^[ \t]*\/[ \t]*$/m)) {
      const start = offset;
      offset += chunk.length + 1;
      if (!text.mask(chunk).trim()) continue;
      // istruzioni SQL fino al primo blocco PL/SQL, che arriva fino al "/" (o alla fine)
      for (const s of text.splitStatements(chunk)) {
        if (PLSQL_START.test(text.blank(s.sql))) {
          const block = chunk.slice(s.start).trimEnd();
          out.push({ sql: block, start: start + s.start });
          break;
        }
        out.push({ sql: s.sql, start: start + s.start });
      }
    }
    return out;
  }

  function classify(sql) {
    if (typeof sql !== 'string') return { kind: 'invalid', reason: 'missing' };
    if (PLSQL_START.test(text.blank(sql))) return { kind: 'write', verb: /^\s*(\w+)/.exec(sql)[1].toUpperCase() };
    const masked = text.mask(sql).trim().replace(/;\s*$/, '');
    if (!masked) return { kind: 'empty', reason: 'empty' };
    if (masked.includes(';')) return { kind: 'invalid', reason: 'single_statement' };
    const upper = masked.toUpperCase();
    const words = upper.match(/[A-Z_][A-Z0-9_$#]*/g) || [];
    const verb = words[0] || '';
    const write = (reason, word) => ({ kind: 'write', verb, ...(reason ? { reason } : {}), ...(word ? { word } : {}) });
    if (!READ_START.has(verb)) return write();
    if (/\.NEXTVAL\b/.test(upper)) return write('write_function', 'NEXTVAL');
    if (words.includes('INTO')) return write('into');
    if (/\bFOR\s+UPDATE\b/.test(upper)) return write('row_lock');
    const writeWord = [...upper.matchAll(/\b([A-Z_][A-Z0-9_]*)\b(\s*\()?/g)].filter(m => !m[2]).map(m => m[1]).find(w => BODY_WRITES.has(w));
    if (writeWord) return write('write_word', writeWord);
    return { kind: 'read', verb };
  }

  const IDENT = '("(?:[^"]|"")+"|[A-Za-z0-9_$#]+)';
  const QUALIFIED = `${IDENT}(?:\\s*\\.\\s*${IDENT})?`;
  const unquote = id => (id && id.startsWith('"') ? id.slice(1, -1).replace(/""/g, '"') : id);
  const lastPart = (a, b) => unquote(b || a);
  const slugOf = v => String(v ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  function schemaChange(sql) {
    if (typeof sql !== 'string') return null;
    const clean = sql.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ').trim().replace(/;\s*$/, '');
    const re = s => new RegExp(s, 'i');
    let m;
    if ((m = re(`^CREATE\\s+(?:GLOBAL\\s+TEMPORARY\\s+)?TABLE\\s+${QUALIFIED}`).exec(clean))) return { table: lastPart(m[1], m[2]), operation: 'create' };
    if ((m = re(`^DROP\\s+TABLE\\s+${QUALIFIED}`).exec(clean))) return { table: lastPart(m[1], m[2]), operation: 'drop' };
    if ((m = re(`^CREATE\\s+(?:UNIQUE\\s+)?INDEX\\s+${QUALIFIED}\\s+ON\\s+${QUALIFIED}`).exec(clean))) return { table: lastPart(m[3], m[4]), operation: `add_index_${slugOf(lastPart(m[1], m[2]))}` };
    if (!(m = re(`^ALTER\\s+TABLE\\s+${QUALIFIED}\\s+([\\s\\S]*)$`).exec(clean))) return null;
    const table = lastPart(m[1], m[2]);
    const clause = m[3].trim();
    const rules = [
      [`^RENAME\\s+COLUMN\\s+${IDENT}`, x => `rename_${slugOf(unquote(x[1]))}`],
      [`^RENAME\\s+TO\\s+`, () => 'rename'],
      [`^ADD\\s+CONSTRAINT\\s+${IDENT}\\s+FOREIGN\\s+KEY`, x => `add_fk_${slugOf(unquote(x[1]))}`],
      [`^ADD\\s+(?:CONSTRAINT\\s+${IDENT}\\s+)?PRIMARY\\s+KEY`, () => 'add_primary_key'],
      [`^ADD\\s*\\(?\\s*${IDENT}`, x => `add_${slugOf(unquote(x[1]))}`],
      [`^DROP\\s+CONSTRAINT\\s+${IDENT}`, x => `drop_constraint_${slugOf(unquote(x[1]))}`],
      [`^DROP\\s+(?:COLUMN\\s+)?\\(?\\s*${IDENT}`, x => `drop_${slugOf(unquote(x[1]))}`],
      [`^MODIFY\\s*\\(?\\s*${IDENT}`, x => `modify_${slugOf(unquote(x[1]))}`],
    ];
    for (const [pattern, op] of rules) { const x = re(pattern).exec(clause); if (x) return { table, operation: op(x) }; }
    return { table, operation: 'alter' };
  }

  return {
    classify, schemaChange, splitStatements, isPlsql: s => PLSQL_START.test(text.blank(s)),
    describeParams: text.describeParams, bindParams: (sql, values) => text.bindParams(sql, values, escape),
    countQuery: text.countQuery, placeholders: text.placeholders,
  };
}

// ---- DDL ----
const TYPES = {
  NUMBER: 'decimal', INTEGER: 'int', BINARY_FLOAT: 'float', BINARY_DOUBLE: 'float', FLOAT: 'float',
  VARCHAR2: 'length', NVARCHAR2: 'length', CHAR: 'length', NCHAR: 'length', RAW: 'length',
  CLOB: 'plain', NCLOB: 'plain', BLOB: 'plain', DATE: 'plain', TIMESTAMP: 'temporal', 'TIMESTAMP WITH TIME ZONE': 'temporal', BOOLEAN: 'plain',
};
const TYPE_ALIASES = { VARCHAR: 'VARCHAR2', INT: 'INTEGER', DECIMAL: 'NUMBER', NUMERIC: 'NUMBER', REAL: 'BINARY_DOUBLE', 'DOUBLE PRECISION': 'BINARY_DOUBLE' };
const canonical = t => { const u = String(t || '').toUpperCase().replace(/\(\d+\)/, '').trim(); return TYPE_ALIASES[u] || u; };
const FK_ACTIONS = ['NO ACTION', 'CASCADE', 'SET NULL'];

class DdlError extends Error {
  constructor(key, params = {}) { super(key); this.key = key; this.params = params; }
}
const fail = (key, params) => { throw new DdlError(key, params); };
const int = (v, min, max) => Number.isInteger(Number(v)) && Number(v) >= min && Number(v) <= max;
const empty = v => v === undefined || v === null || v === '';

function typeSql(c, col) {
  const type = canonical(c.type);
  const kind = TYPES[type];
  if (!kind) fail('type', { ...col, type: String(c.type) });
  if (kind === 'length') {
    const n = empty(c.length) ? (type === 'RAW' ? 2000 : 255) : c.length;
    if (!int(n, 1, 32767)) fail('length', col);
    return `${type}(${Number(n)}${['VARCHAR2', 'CHAR'].includes(type) ? ' CHAR' : ''})`;
  }
  if (kind === 'decimal' && !empty(c.length)) {
    const p = c.length, s = c.scale ?? 0;
    if (!int(p, 1, 38) || !int(s, -84, 127)) fail('precision', col);
    return `NUMBER(${Number(p)},${Number(s)})`;
  }
  if (kind === 'temporal' && !empty(c.length)) {
    if (!int(c.length, 0, 9)) fail('fraction', col);
    return type === 'TIMESTAMP' ? `TIMESTAMP(${Number(c.length)})` : `TIMESTAMP(${Number(c.length)}) WITH TIME ZONE`;
  }
  return type;
}
function defaultExpr(c, col) {
  const d = c.default;
  if (!d || !d.kind || d.kind === 'none') return '';
  if (d.kind === 'null') return 'NULL';
  if (d.kind === 'current_timestamp') return canonical(c.type) === 'DATE' ? 'SYSDATE' : 'CURRENT_TIMESTAMP';
  if (d.kind === 'value') return literal(String(d.value ?? ''));
  if (d.kind === 'expression') { if (/;/.test(String(d.value))) fail('default', col); return String(d.value); }
  return fail('default', col);
}
function columnSql(c) {
  if (!c || !NAME_RE.test(c.name || '')) fail('column_name');
  const col = { column: c.name };
  if (c.unsigned) fail('unsigned', col);
  if (c.onUpdateCurrentTimestamp) fail('on_update', col);
  let sql = `${quoteId(c.name)} ${typeSql(c, col)}`;
  if (c.autoIncrement) {
    if (!['int', 'decimal'].includes(TYPES[canonical(c.type)])) fail('auto_increment_type', col);
    return `${sql} GENERATED BY DEFAULT ON NULL AS IDENTITY NOT NULL`;
  }
  const d = defaultExpr(c, col);
  return `${sql}${d ? ` DEFAULT ${d}` : ''}${c.nullable ? '' : ' NOT NULL'}`;
}
const columnList = has => (list, where) => {
  if (!Array.isArray(list) || !list.length || !list.every(has)) fail(`columns_${where.what}`, { name: where.name || '' });
  return list.map(quoteId).join(', ');
};
function fkSql(schema, fk, colList) {
  if (!empty(fk.name) && !NAME_RE.test(fk.name)) fail('fk_name');
  if (!NAME_RE.test(fk.refTable || '') || !Array.isArray(fk.refColumns) || !fk.refColumns.every(n => NAME_RE.test(n || ''))) fail('fk_reference');
  if ((fk.refColumns || []).length !== (fk.columns || []).length) fail('fk_count');
  let sql = `${fk.name ? `CONSTRAINT ${quoteId(fk.name)} ` : ''}FOREIGN KEY (${colList(fk.columns, { what: 'foreign_key', name: fk.name })}) REFERENCES ${quoteId(fk.refDatabase || schema)}.${quoteId(fk.refTable)} (${fk.refColumns.map(quoteId).join(', ')})`;
  const del = String(fk.onDelete || '').toUpperCase();
  if (del && del !== 'NO ACTION' && del !== 'RESTRICT') { if (!FK_ACTIONS.includes(del)) fail('fk_action', { action: fk.onDelete }); sql += ` ON DELETE ${del}`; }
  const upd = String(fk.onUpdate || '').toUpperCase();
  if (upd && upd !== 'NO ACTION' && upd !== 'RESTRICT') fail('fk_action', { action: `ON UPDATE ${fk.onUpdate}` }); // Oracle non ha ON UPDATE
  return sql;
}
const indexSql = (schema, table, ix, colList) => {
  if (!empty(ix.name) && !NAME_RE.test(ix.name)) fail('index_name');
  const name = ix.name || `IX_${table}_${(ix.columns || []).join('_')}`.slice(0, 128);
  return `CREATE ${ix.unique ? 'UNIQUE ' : ''}INDEX ${quoteId(schema)}.${quoteId(name)} ON ${quoteId(schema)}.${quoteId(table)} (${colList(ix.columns, { what: 'index', name: ix.name })})`;
};
const commentSql = (schema, table, column, comment) => `COMMENT ON ${column ? 'COLUMN' : 'TABLE'} ${quoteId(schema)}.${quoteId(table)}${column ? `.${quoteId(column)}` : ''} IS ${literal(comment || '')}`;

function createTableStatements(schema, def) {
  if (!def || !NAME_RE.test(def.name || '')) fail('table_name');
  const cols = Array.isArray(def.columns) ? def.columns : [];
  if (!cols.length) fail('no_columns');
  const names = cols.map(c => c?.name);
  if (new Set(names).size !== names.length) fail('duplicate_columns');
  const colList = columnList(n => names.includes(n));
  const lines = cols.map(columnSql);
  const pk = Array.isArray(def.primaryKey) ? def.primaryKey : [];
  if (pk.length) lines.push(`CONSTRAINT ${quoteId(`PK_${def.name}`.slice(0, 128))} PRIMARY KEY (${colList(pk, { what: 'primary_key' })})`);
  for (const fk of def.foreignKeys || []) lines.push(fkSql(schema, fk, colList));
  return [
    `CREATE TABLE ${quoteId(schema)}.${quoteId(def.name)} (\n  ${lines.join(',\n  ')}\n)`,
    ...(def.indexes || []).map(ix => indexSql(schema, def.name, ix, colList)),
    ...(def.comment ? [commentSql(schema, def.name, null, def.comment)] : []),
    ...cols.filter(c => c.comment).map(c => commentSql(schema, def.name, c.name, c.comment)),
  ];
}

const OPS = new Set(['create_table', 'drop_table', 'rename_table', 'add_column', 'modify_column', 'rename_column', 'drop_column',
  'add_index', 'drop_index', 'add_primary_key', 'drop_primary_key', 'add_fk', 'drop_fk', 'table_options', 'raw']);
const name = n => { if (!NAME_RE.test(n || '')) fail('name', { name: String(n ?? '') }); return quoteId(n); };

// modify_column: solo ciò che cambia rispetto alla colonna di prima (op.previous): Oracle rifiuta
// "NOT NULL" su una colonna già NOT NULL
function modifyStatements(schema, op) {
  const c = op.column || {}, p = op.previous || {};
  const col = { column: c.name || op.name };
  const tbl = `${quoteId(schema)}.${name(op.table)}`;
  const out = [];
  let target = op.name;
  if (c.name && c.name !== op.name) { out.push(`ALTER TABLE ${tbl} RENAME COLUMN ${name(op.name)} TO ${name(c.name)}`); target = c.name; }
  const parts = [];
  if (!p.type || typeSql(p, col) !== typeSql(c, col)) parts.push(typeSql(c, col));
  if (!c.autoIncrement && JSON.stringify(p.default || { kind: 'none' }) !== JSON.stringify(c.default || { kind: 'none' })) parts.push(`DEFAULT ${defaultExpr(c, col) || 'NULL'}`);
  if (!!p.nullable !== !!c.nullable || p.nullable === undefined) parts.push(c.nullable ? 'NULL' : 'NOT NULL');
  if (parts.length) out.push(`ALTER TABLE ${tbl} MODIFY (${quoteId(target)} ${parts.join(' ')})`);
  if ((c.comment || '') !== (p.comment || '')) out.push(commentSql(schema, op.table, target, c.comment));
  return out;
}

function statements(schema, ops) {
  if (!Array.isArray(ops) || !ops.length) fail('no_operations');
  if (ops.length > 500) fail('too_many_operations');
  const out = [];
  for (const op of ops) {
    if (!op || !OPS.has(op.op)) fail('operation', { op: String(op?.op) });
    if (op.op === 'raw') { if (typeof op.sql !== 'string' || !op.sql.trim()) fail('raw_sql'); out.push(op.sql.trim().replace(/;\s*$/, '')); continue; }
    const tbl = `${quoteId(schema)}.${name(op.table)}`;
    const colList = columnList(() => true);
    switch (op.op) {
      case 'create_table': out.push(...createTableStatements(schema, { ...op.definition, name: op.table })); break;
      case 'drop_table': out.push(`DROP TABLE ${tbl}`); break;
      case 'rename_table': out.push(`ALTER TABLE ${tbl} RENAME TO ${name(op.to)}`); break;
      case 'add_column': out.push(`ALTER TABLE ${tbl} ADD (${columnSql(op.column)})`, ...(op.column?.comment ? [commentSql(schema, op.table, op.column.name, op.column.comment)] : [])); break;
      case 'modify_column': out.push(...modifyStatements(schema, op)); break;
      case 'rename_column': out.push(`ALTER TABLE ${tbl} RENAME COLUMN ${name(op.from)} TO ${name(op.to)}`); break;
      case 'drop_column': out.push(`ALTER TABLE ${tbl} DROP COLUMN ${name(op.name)}`); break;
      case 'add_index': out.push(indexSql(schema, op.table, op.index || {}, colList)); break;
      case 'drop_index': out.push(`DROP INDEX ${quoteId(schema)}.${name(op.name)}`); break;
      case 'add_primary_key': out.push(`ALTER TABLE ${tbl} ADD CONSTRAINT ${quoteId(`PK_${op.table}`.slice(0, 128))} PRIMARY KEY (${colList(op.columns, { what: 'primary_key' })})`); break;
      case 'drop_primary_key': out.push(`ALTER TABLE ${tbl} DROP PRIMARY KEY`); break;
      case 'add_fk': out.push(`ALTER TABLE ${tbl} ADD ${fkSql(schema, op.fk || {}, colList)}`); break;
      case 'drop_fk': out.push(`ALTER TABLE ${tbl} DROP CONSTRAINT ${name(op.name)}`); break;
      case 'table_options': out.push(commentSql(schema, op.table, null, op.comment)); break;
      default: fail('operation', { op: op.op });
    }
  }
  return out;
}

// ---- struttura dalle viste ALL_* ----
function defaultOf(raw) {
  if (raw === null || raw === undefined) return { kind: 'none' };
  const v = String(raw).trim();
  if (!v || /^NULL$/i.test(v)) return { kind: v ? 'null' : 'none' };
  if (/^(SYSDATE|CURRENT_TIMESTAMP|SYSTIMESTAMP|LOCALTIMESTAMP)(\(\d*\))?$/i.test(v)) return { kind: 'current_timestamp' };
  let m;
  if ((m = /^'((?:[^']|'')*)'$/s.exec(v))) return { kind: 'value', value: m[1].replace(/''/g, "'") };
  if (/^-?\d+(\.\d+)?$/.test(v)) return { kind: 'value', value: v };
  return { kind: 'expression', value: v };
}
function designerType(c) {
  const t = String(c.DATA_TYPE).toUpperCase();
  if (/^TIMESTAMP\(\d\) WITH TIME ZONE$/.test(t)) return 'TIMESTAMP WITH TIME ZONE';
  if (/^TIMESTAMP\(\d\)$/.test(t)) return 'TIMESTAMP';
  if (t === 'NUMBER' && c.DATA_SCALE === 0 && c.DATA_PRECISION === null) return 'INTEGER';
  return TYPES[t] ? t : null;
}
function column(c) {
  const type = designerType(c);
  const kind = type && TYPES[type];
  const col = { name: c.COLUMN_NAME, type: type || c.DATA_TYPE };
  if (kind === 'length') col.length = c.CHAR_LENGTH || c.DATA_LENGTH;
  else if (kind === 'decimal' && c.DATA_PRECISION !== null) { col.length = c.DATA_PRECISION; col.scale = c.DATA_SCALE; }
  else if (kind === 'temporal' && c.DATA_SCALE !== null && c.DATA_SCALE !== 6) col.length = c.DATA_SCALE;
  col.nullable = c.NULLABLE === 'Y';
  col.default = c.IDENTITY_COLUMN === 'YES' ? { kind: 'none' } : defaultOf(c.DATA_DEFAULT);
  if (c.IDENTITY_COLUMN === 'YES') col.autoIncrement = true;
  if (c.COMMENTS) col.comment = c.COMMENTS;
  if (!type) col.unsupported = c.DATA_TYPE;
  return col;
}
async function introspect(q, schema, tables = null) {
  if (tables && !tables.length) return { tables: {} };
  const only = tables ? ` AND t.table_name IN (${tables.map(literal).join(', ')})` : '';
  const [tableRows, colRows, idxRows, fkRows] = await Promise.all([
    q(`SELECT t.table_name, c.comments FROM all_tables t LEFT JOIN all_tab_comments c ON c.owner = t.owner AND c.table_name = t.table_name
        WHERE t.owner = ?${only} ORDER BY t.table_name`, [schema]),
    q(`SELECT t.table_name, t.column_name, t.data_type, t.data_length, t.char_length, t.data_precision, t.data_scale, t.nullable,
              t.data_default, t.identity_column, c.comments
         FROM all_tab_cols t LEFT JOIN all_col_comments c ON c.owner = t.owner AND c.table_name = t.table_name AND c.column_name = t.column_name
        WHERE t.owner = ? AND t.hidden_column = 'NO'${only} ORDER BY t.table_name, t.column_id`, [schema]),
    q(`SELECT t.table_name, t.index_name, t.uniqueness, ic.column_name, (SELECT con.constraint_type FROM all_constraints con
              WHERE con.owner = t.owner AND con.index_name = t.index_name AND con.constraint_type IN ('P', 'U') AND ROWNUM = 1) AS constraint_type,
              (SELECT con.constraint_name FROM all_constraints con WHERE con.owner = t.owner AND con.table_name = t.table_name
                AND con.constraint_type = 'P' AND ROWNUM = 1) AS pk_name
         FROM all_indexes t JOIN all_ind_columns ic ON ic.index_owner = t.owner AND ic.index_name = t.index_name
        WHERE t.owner = ?${only} ORDER BY t.table_name, t.index_name, ic.column_position`, [schema]),
    q(`SELECT t.table_name, t.constraint_name, t.delete_rule, rc.owner AS ref_owner, rc.table_name AS ref_table, cc.column_name, rcc.column_name AS ref_column
         FROM all_constraints t JOIN all_constraints rc ON rc.owner = t.r_owner AND rc.constraint_name = t.r_constraint_name
         JOIN all_cons_columns cc ON cc.owner = t.owner AND cc.constraint_name = t.constraint_name
         JOIN all_cons_columns rcc ON rcc.owner = rc.owner AND rcc.constraint_name = rc.constraint_name AND rcc.position = cc.position
        WHERE t.owner = ? AND t.constraint_type = 'R'${only} ORDER BY t.table_name, t.constraint_name, cc.position`, [schema]),
  ]);
  const result = {};
  for (const t of tableRows) result[t.TABLE_NAME] = { ...(t.COMMENTS ? { comment: t.COMMENTS } : {}), columns: [], primaryKey: [], indexes: [], foreignKeys: [] };
  for (const c of colRows) result[c.TABLE_NAME]?.columns.push(column(c));
  const idx = new Map();
  for (const i of idxRows) {
    const t = result[i.TABLE_NAME];
    if (!t) continue;
    if (i.CONSTRAINT_TYPE === 'P') { t.primaryKey.push(i.COLUMN_NAME); t.primaryKeyName = i.PK_NAME; continue; }
    const k = `${i.TABLE_NAME}\0${i.INDEX_NAME}`;
    if (!idx.has(k)) { const ix = { name: i.INDEX_NAME, columns: [], unique: i.UNIQUENESS === 'UNIQUE', ...(i.CONSTRAINT_TYPE === 'U' ? { constraint: true } : {}) }; idx.set(k, ix); t.indexes.push(ix); }
    idx.get(k).columns.push(i.COLUMN_NAME);
  }
  const fks = new Map();
  for (const f of fkRows) {
    const t = result[f.TABLE_NAME];
    if (!t) continue;
    const k = `${f.TABLE_NAME}\0${f.CONSTRAINT_NAME}`;
    if (!fks.has(k)) {
      const fk = { name: f.CONSTRAINT_NAME, columns: [], refTable: f.REF_TABLE, refColumns: [], ...(f.REF_OWNER !== schema ? { refDatabase: f.REF_OWNER } : {}), onDelete: f.DELETE_RULE === 'NO ACTION' ? 'NO ACTION' : f.DELETE_RULE, onUpdate: 'NO ACTION' };
      fks.set(k, fk);
      t.foreignKeys.push(fk);
    }
    fks.get(k).columns.push(f.COLUMN_NAME);
    fks.get(k).refColumns.push(f.REF_COLUMN);
  }
  return { tables: result };
}

module.exports = {
  quoteId, literal, createOracleSql, TYPES, TYPE_ALIASES, canonical, FK_ACTIONS, DdlError, fail,
  typeSql, columnSql, createTableStatements, statements, introspect, defaultOf,
  createTableSql: (schema, def) => createTableStatements(schema, def).join(';\n'),
};
