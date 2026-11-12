// SQLite: DDL dal modello del designer e struttura delle tabelle letta con i PRAGMA.
// ALTER TABLE in SQLite sa solo aggiungere, rinominare e togliere colonne e rinominare la tabella:
// per il resto (tipo, NULL, default, chiavi) la tabella viene ricostruita — nuova tabella, copia
// dei dati, vecchia tolta, nuova rinominata, indici ricreati — in una transazione con i vincoli
// delle chiavi esterne sospesi, come raccomanda la documentazione di SQLite.

const quoteId = name => '"' + String(name).replace(/"/g, '""') + '"';
const NAME_RE = /^[^\x00]{1,128}$/;

function literal(v) {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'boolean') return v ? '1' : '0';
  if (typeof v === 'number' || typeof v === 'bigint') return Number.isFinite(Number(v)) ? String(v) : `'${String(v)}'`;
  if (Buffer.isBuffer(v) || v instanceof Uint8Array) return `X'${Buffer.from(v).toString('hex')}'`;
  if (typeof v === 'object') return `'${JSON.stringify(v).replace(/'/g, "''")}'`;
  return `'${String(v).replace(/\x00/g, '').replace(/'/g, "''")}'`;
}

// tipi del designer (SQLite guarda solo l'affinità: i nomi restano quelli scritti)
const TYPES = {
  INTEGER: 'int', REAL: 'float', NUMERIC: 'decimal', TEXT: 'plain', BLOB: 'plain',
  VARCHAR: 'length', CHAR: 'length', BOOLEAN: 'plain', DATE: 'plain', DATETIME: 'plain', JSON: 'plain',
};
const TYPE_ALIASES = { INT: 'INTEGER', DECIMAL: 'NUMERIC', DOUBLE: 'REAL', FLOAT: 'REAL', 'DOUBLE PRECISION': 'REAL', BOOL: 'BOOLEAN', TIMESTAMP: 'DATETIME', CLOB: 'TEXT' };
const canonical = t => { const u = String(t || '').toUpperCase().trim(); return TYPE_ALIASES[u] || u; };
const FK_ACTIONS = new Set(['NO ACTION', 'RESTRICT', 'CASCADE', 'SET NULL', 'SET DEFAULT']);

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
  if (kind === 'length' && !empty(c.length)) { if (!int(c.length, 1, 1e9)) fail('length', col); return `${type}(${Number(c.length)})`; }
  if (kind === 'decimal' && !empty(c.length)) {
    const p = c.length, s = c.scale ?? 0;
    if (!int(p, 1, 1000) || !int(s, 0, 1000) || Number(s) > Number(p)) fail('precision', col);
    return `${type}(${Number(p)},${Number(s)})`;
  }
  return type;
}
function defaultSql(c, col) {
  const d = c.default;
  if (!d || !d.kind || d.kind === 'none') return '';
  if (d.kind === 'null') { if (!c.nullable) fail('default_null', col); return ' DEFAULT NULL'; }
  if (d.kind === 'current_timestamp') return ' DEFAULT CURRENT_TIMESTAMP';
  if (d.kind === 'value') return ` DEFAULT ${literal(String(d.value ?? ''))}`;
  if (d.kind === 'expression') { if (/;/.test(String(d.value))) fail('default', col); return ` DEFAULT (${String(d.value).replace(/^\((.*)\)$/s, '$1')})`; }
  return fail('default', col);
}
// inlinePk: colonna INTEGER PRIMARY KEY AUTOINCREMENT (in SQLite l'autoincremento è solo lì)
function columnSql(c, inlinePk = false) {
  if (!c || !NAME_RE.test(c.name || '')) fail('column_name');
  const col = { column: c.name };
  if (c.unsigned) fail('unsigned', col);
  if (c.onUpdateCurrentTimestamp) fail('on_update', col);
  if (c.autoIncrement) {
    if (canonical(c.type) !== 'INTEGER') fail('auto_increment_type', col);
    if (!inlinePk) fail('auto_increment_key', col);
    return `${quoteId(c.name)} INTEGER PRIMARY KEY AUTOINCREMENT`;
  }
  return `${quoteId(c.name)} ${typeSql(c, col)}${c.nullable ? '' : ' NOT NULL'}${defaultSql(c, col)}`;
}
const columnList = has => (list, where) => {
  if (!Array.isArray(list) || !list.length || !list.every(has)) fail(`columns_${where.what}`, { name: where.name || '' });
  return list.map(quoteId).join(', ');
};
function fkSql(fk, colList) {
  if (!empty(fk.name) && !NAME_RE.test(fk.name)) fail('fk_name');
  if (!NAME_RE.test(fk.refTable || '') || !Array.isArray(fk.refColumns) || !fk.refColumns.every(n => NAME_RE.test(n || ''))) fail('fk_reference');
  if ((fk.refColumns || []).length !== (fk.columns || []).length) fail('fk_count');
  // in SQLite la tabella riferita non ha lo schema davanti (è nello stesso database)
  let sql = `${fk.name ? `CONSTRAINT ${quoteId(fk.name)} ` : ''}FOREIGN KEY (${colList(fk.columns, { what: 'foreign_key', name: fk.name })}) REFERENCES ${quoteId(fk.refTable)} (${fk.refColumns.map(quoteId).join(', ')})`;
  for (const [k, label] of [['onDelete', 'ON DELETE'], ['onUpdate', 'ON UPDATE']]) {
    if (!fk[k]) continue;
    const action = String(fk[k]).toUpperCase();
    if (!FK_ACTIONS.has(action)) fail('fk_action', { action: String(fk[k]) });
    if (action !== 'NO ACTION') sql += ` ${label} ${action}`;
  }
  return sql;
}
const indexSql = (schema, table, ix, colList) => {
  if (!empty(ix.name) && !NAME_RE.test(ix.name)) fail('index_name');
  const name = ix.name || `ix_${table}_${(ix.columns || []).join('_')}`;
  return `CREATE ${ix.unique ? 'UNIQUE ' : ''}INDEX ${quoteId(schema)}.${quoteId(name)} ON ${quoteId(table)} (${colList(ix.columns, { what: 'index', name: ix.name })})`;
};

// CREATE TABLE (tableName: nome da usare, per la ricostruzione) e indici
function createTableStatements(schema, def, tableName = def?.name) {
  if (!def || !NAME_RE.test(def.name || '')) fail('table_name');
  const cols = Array.isArray(def.columns) ? def.columns : [];
  if (!cols.length) fail('no_columns');
  const names = cols.map(c => c?.name);
  if (new Set(names).size !== names.length) fail('duplicate_columns');
  const colList = columnList(n => names.includes(n));
  const pk = Array.isArray(def.primaryKey) ? def.primaryKey : [];
  const ai = cols.filter(c => c.autoIncrement);
  if (ai.length > 1) fail('auto_increment_many');
  if (ai.length && !(pk.length === 1 && pk[0] === ai[0].name)) fail('auto_increment_key');
  const lines = cols.map(c => columnSql(c, !!c.autoIncrement));
  if (pk.length && !ai.length) lines.push(`PRIMARY KEY (${colList(pk, { what: 'primary_key' })})`);
  for (const fk of def.foreignKeys || []) lines.push(fkSql(fk, colList));
  return [
    `CREATE TABLE ${quoteId(schema)}.${quoteId(tableName)} (\n  ${lines.join(',\n  ')}\n)`,
    ...(def.indexes || []).map(ix => indexSql(schema, def.name, ix, colList)),
  ];
}

// Ricostruzione di una tabella con la struttura nuova; columns: colonne copiate { nuovo: vecchio }
function rebuildSql(schema, table, def, columns) {
  const tmp = `_kelbo_new_${table}`;
  const [create, ...indexes] = createTableStatements(schema, { ...def, name: table }, tmp);
  const pairs = Object.entries(columns);
  return [
    'PRAGMA foreign_keys = OFF',
    'BEGIN',
    create,
    ...(pairs.length ? [`INSERT INTO ${quoteId(schema)}.${quoteId(tmp)} (${pairs.map(([n]) => quoteId(n)).join(', ')}) SELECT ${pairs.map(([, o]) => quoteId(o)).join(', ')} FROM ${quoteId(schema)}.${quoteId(table)}`] : []),
    `DROP TABLE ${quoteId(schema)}.${quoteId(table)}`,
    `ALTER TABLE ${quoteId(schema)}.${quoteId(tmp)} RENAME TO ${quoteId(table)}`,
    ...indexes,
    `PRAGMA ${quoteId(schema)}.foreign_key_check(${quoteId(table)})`,
    'COMMIT',
    'PRAGMA foreign_keys = ON',
  ].join(';\n');
}

// ---- operazioni del designer ----
const OPS = new Set(['create_table', 'drop_table', 'rename_table', 'add_column', 'modify_column', 'rename_column', 'drop_column',
  'add_index', 'drop_index', 'add_primary_key', 'drop_primary_key', 'add_fk', 'drop_fk', 'table_options', 'raw', 'rebuild_table']);
const name = n => { if (!NAME_RE.test(n || '')) fail('name', { name: String(n ?? '') }); return quoteId(n); };

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
      case 'add_column': out.push(`ALTER TABLE ${tbl} ADD COLUMN ${columnSql(op.column)}`); break;
      case 'rename_column': out.push(`ALTER TABLE ${tbl} RENAME COLUMN ${name(op.from)} TO ${name(op.to)}`); break;
      case 'drop_column': out.push(`ALTER TABLE ${tbl} DROP COLUMN ${name(op.name)}`); break;
      case 'add_index': out.push(indexSql(schema, op.table, op.index || {}, colList)); break;
      case 'drop_index': out.push(`DROP INDEX ${quoteId(schema)}.${name(op.name)}`); break;
      case 'table_options': break; // né engine né commenti in SQLite
      case 'rebuild_table': out.push(rebuildSql(schema, op.table, op.definition, op.columns || {})); break;
      default: fail('rebuild_required', { op: op.op }); // tipo, chiavi: solo con la ricostruzione (diff)
    }
  }
  if (!out.length) fail('nothing');
  return out;
}

// ---- struttura dai PRAGMA ----
function parseType(declared) {
  const m = /^\s*([A-Za-z ]+?)\s*(?:\(\s*(\d+)\s*(?:,\s*(\d+)\s*)?\))?\s*$/.exec(String(declared || ''));
  const type = canonical(m?.[1] || declared || 'TEXT');
  return { type, length: m?.[2] ? Number(m[2]) : undefined, scale: m?.[3] ? Number(m[3]) : undefined };
}
function defaultOf(raw) {
  if (raw === null || raw === undefined) return { kind: 'none' };
  const v = String(raw).trim();
  if (/^NULL$/i.test(v)) return { kind: 'null' };
  if (/^CURRENT_TIMESTAMP$/i.test(v)) return { kind: 'current_timestamp' };
  let m;
  if ((m = /^'((?:[^']|'')*)'$/s.exec(v))) return { kind: 'value', value: m[1].replace(/''/g, "'") };
  if (/^[-+]?\d+(\.\d+)?$/.test(v)) return { kind: 'value', value: v };
  return { kind: 'expression', value: v };
}

// q(sql) → righe (oggetti). tables: solo queste (default: tutte quelle dello schema)
function introspect(q, schema, tables = null) {
  const s = quoteId(schema);
  const list = q(`SELECT name, sql FROM ${s}.sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' ORDER BY name`)
    .filter(t => !tables || tables.includes(t.name));
  const result = {};
  for (const t of list) {
    const cols = q(`PRAGMA ${s}.table_xinfo(${literal(t.name)})`).filter(c => !c.hidden);
    const pk = cols.filter(c => c.pk).sort((a, b) => a.pk - b.pk).map(c => c.name);
    const autoinc = /\bAUTOINCREMENT\b/i.test(t.sql || '');
    const def = { columns: [], primaryKey: pk, indexes: [], foreignKeys: [] };
    for (const c of cols) {
      const p = parseType(c.type);
      const kind = TYPES[p.type];
      const col = { name: c.name, type: kind ? p.type : String(c.type || 'BLOB') };
      if (kind === 'length' && p.length) col.length = p.length;
      if (kind === 'decimal' && p.length) { col.length = p.length; col.scale = p.scale ?? 0; }
      col.nullable = !c.notnull && !(autoinc && pk.length === 1 && pk[0] === c.name);
      col.default = defaultOf(c.dflt_value);
      if (autoinc && pk.length === 1 && pk[0] === c.name) col.autoIncrement = true;
      if (!kind) col.unsupported = String(c.type || 'BLOB');
      def.columns.push(col);
    }
    for (const ix of q(`PRAGMA ${s}.index_list(${literal(t.name)})`)) {
      if (ix.origin === 'pk') continue;
      const colsOf = q(`PRAGMA ${s}.index_info(${literal(ix.name)})`).sort((a, b) => a.seqno - b.seqno).map(x => x.name);
      def.indexes.push({ name: ix.name, columns: colsOf, unique: !!ix.unique, ...(ix.origin === 'u' ? { constraint: true } : {}) });
    }
    const fks = new Map();
    for (const f of q(`PRAGMA ${s}.foreign_key_list(${literal(t.name)})`)) {
      if (!fks.has(f.id)) fks.set(f.id, { name: `fk_${t.name}_${f.id}`, columns: [], refTable: f.table, refColumns: [], onDelete: f.on_delete, onUpdate: f.on_update });
      fks.get(f.id).columns.push(f.from);
      fks.get(f.id).refColumns.push(f.to);
    }
    def.foreignKeys = [...fks.values()];
    result[t.name] = def;
  }
  return { tables: result };
}

module.exports = {
  quoteId, literal, TYPES, TYPE_ALIASES, canonical, FK_ACTIONS: [...FK_ACTIONS], DdlError, fail, NAME_RE,
  columnSql, createTableStatements, rebuildSql, statements, introspect, parseType, defaultOf,
  createTableSql: (schema, def) => createTableStatements(schema, def).join(';\n'),
};
