// SQL Server: DDL dal modello del designer. Identificatori tra [ ], stringhe N'…'. I default
// sono vincoli con nome (DF_<tabella>_<colonna>) per poterli cambiare; quelli creati altrove si
// trovano e si tolgono con una ricerca in sys.default_constraints. I commenti sono la proprietà
// estesa MS_Description. Le colonne non si spostano (niente AFTER/FIRST).

const quoteId = name => `[${String(name).replace(/]/g, ']]')}]`;
const NAME_RE = /^[^\x00]{1,128}$/;

function literal(v) {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'boolean') return v ? '1' : '0';
  if (typeof v === 'number' || typeof v === 'bigint') return Number.isFinite(Number(v)) ? String(v) : `N'${String(v)}'`;
  if (Buffer.isBuffer(v)) return `0x${v.toString('hex')}`;
  if (v instanceof Date) return `N'${v.toISOString()}'`;
  if (typeof v === 'object') return `N'${JSON.stringify(v).replace(/'/g, "''")}'`;
  return `N'${String(v).replace(/\x00/g, '').replace(/'/g, "''")}'`;
}
const str = v => `N'${String(v).replace(/'/g, "''")}'`;

const TYPES = {
  TINYINT: 'int', SMALLINT: 'int', INT: 'int', BIGINT: 'int',
  DECIMAL: 'decimal', NUMERIC: 'decimal', FLOAT: 'float', REAL: 'float', MONEY: 'plain',
  CHAR: 'length', VARCHAR: 'length', NCHAR: 'length', NVARCHAR: 'length', BINARY: 'length', VARBINARY: 'length',
  BIT: 'plain', DATE: 'plain', TIME: 'temporal', DATETIME2: 'temporal', DATETIMEOFFSET: 'temporal', DATETIME: 'plain', SMALLDATETIME: 'plain',
  UNIQUEIDENTIFIER: 'plain', XML: 'plain',
};
const TYPE_ALIASES = { INTEGER: 'INT', DEC: 'DECIMAL', 'DOUBLE PRECISION': 'FLOAT' };
const canonical = t => { const u = String(t || '').toUpperCase().trim(); return TYPE_ALIASES[u] || u; };
const MAX_OK = new Set(['VARCHAR', 'NVARCHAR', 'VARBINARY']);
const FK_ACTIONS = new Set(['NO ACTION', 'CASCADE', 'SET NULL', 'SET DEFAULT']);

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
    if (String(c.length).toUpperCase() === 'MAX' && MAX_OK.has(type)) return `${type}(MAX)`;
    if (empty(c.length)) return `${type}(${type.startsWith('VAR') || type.startsWith('NVAR') ? 255 : 1})`;
    if (!int(c.length, 1, type.startsWith('N') ? 4000 : 8000)) fail('length', col);
    return `${type}(${Number(c.length)})`;
  }
  if (kind === 'decimal' && !empty(c.length)) {
    const p = c.length, s = c.scale ?? 0;
    if (!int(p, 1, 38) || !int(s, 0, 38) || Number(s) > Number(p)) fail('precision', col);
    return `${type}(${Number(p)},${Number(s)})`;
  }
  if (kind === 'temporal' && !empty(c.length)) {
    if (!int(c.length, 0, 7)) fail('fraction', col);
    return `${type}(${Number(c.length)})`;
  }
  return type;
}

// Espressione del default (senza "DEFAULT"), '' se nessuno
function defaultExpr(c, col) {
  const d = c.default;
  if (!d || !d.kind || d.kind === 'none') return '';
  const kind = TYPES[canonical(c.type)];
  if (d.kind === 'null') { if (!c.nullable) fail('default_null', col); return 'NULL'; }
  if (d.kind === 'current_timestamp') {
    if (kind !== 'temporal' && !['DATETIME', 'SMALLDATETIME', 'DATE'].includes(canonical(c.type))) fail('current_timestamp', col);
    return 'CURRENT_TIMESTAMP';
  }
  if (d.kind === 'value') return literal(String(d.value ?? ''));
  if (d.kind === 'expression') { if (/;/.test(String(d.value))) fail('default', col); return String(d.value); }
  return fail('default', col);
}
const defaultName = (table, column) => `DF_${table}_${column}`.slice(0, 128);

// Colonna in CREATE TABLE / ADD: tipo, IDENTITY, NULL, default con nome
function columnSql(c, table) {
  if (!c || !NAME_RE.test(c.name || '')) fail('column_name');
  const col = { column: c.name };
  if (c.unsigned) fail('unsigned', col);
  if (c.onUpdateCurrentTimestamp) fail('on_update', col);
  let sql = `${quoteId(c.name)} ${typeSql(c, col)}`;
  if (c.autoIncrement) {
    if (TYPES[canonical(c.type)] !== 'int') fail('auto_increment_type', col);
    sql += ' IDENTITY(1,1)';
  }
  sql += c.nullable && !c.autoIncrement ? ' NULL' : ' NOT NULL';
  const d = c.autoIncrement ? '' : defaultExpr(c, col);
  if (d) sql += ` CONSTRAINT ${quoteId(defaultName(table, c.name))} DEFAULT ${d}`;
  return sql;
}

const columnList = has => (list, where) => {
  if (!Array.isArray(list) || !list.length || !list.every(has)) fail(`columns_${where.what}`, { name: where.name || '' });
  return list.map(quoteId).join(', ');
};
const indexSql = (schema, table, ix, colList) => {
  if (!empty(ix.name) && !NAME_RE.test(ix.name)) fail('index_name');
  const name = ix.name || `IX_${table}_${(ix.columns || []).join('_')}`.slice(0, 128);
  return `CREATE ${ix.unique ? 'UNIQUE ' : ''}INDEX ${quoteId(name)} ON ${quoteId(schema)}.${quoteId(table)} (${colList(ix.columns, { what: 'index', name: ix.name })})`;
};
function fkSql(schema, fk, colList) {
  if (!empty(fk.name) && !NAME_RE.test(fk.name)) fail('fk_name');
  if (!NAME_RE.test(fk.refTable || '') || !Array.isArray(fk.refColumns) || !fk.refColumns.every(n => NAME_RE.test(n || ''))) fail('fk_reference');
  if ((fk.refColumns || []).length !== (fk.columns || []).length) fail('fk_count');
  let sql = `${fk.name ? `CONSTRAINT ${quoteId(fk.name)} ` : ''}FOREIGN KEY (${colList(fk.columns, { what: 'foreign_key', name: fk.name })}) REFERENCES ${quoteId(fk.refDatabase || schema)}.${quoteId(fk.refTable)} (${fk.refColumns.map(quoteId).join(', ')})`;
  for (const [k, label] of [['onDelete', 'ON DELETE'], ['onUpdate', 'ON UPDATE']]) {
    if (!fk[k]) continue;
    let action = String(fk[k]).toUpperCase();
    if (action === 'RESTRICT') action = 'NO ACTION'; // in SQL Server è NO ACTION
    if (!FK_ACTIONS.has(action)) fail('fk_action', { action: String(fk[k]) });
    sql += ` ${label} ${action}`;
  }
  return sql;
}

// Commento (MS_Description) di una tabella o di una colonna: aggiunto o aggiornato
function commentSql(schema, table, column, comment) {
  const level = `@level0type = N'SCHEMA', @level0name = ${str(schema)}, @level1type = N'TABLE', @level1name = ${str(table)}${column ? `, @level2type = N'COLUMN', @level2name = ${str(column)}` : ''}`;
  const where = `major_id = OBJECT_ID(${str(`${quoteId(schema)}.${quoteId(table)}`)}) AND name = N'MS_Description' AND minor_id = ${column ? `COLUMNPROPERTY(major_id, ${str(column)}, 'ColumnId')` : '0'}`;
  if (!comment) return `IF EXISTS (SELECT 1 FROM sys.extended_properties WHERE ${where}) EXEC sp_dropextendedproperty @name = N'MS_Description', ${level}`;
  return `IF EXISTS (SELECT 1 FROM sys.extended_properties WHERE ${where}) EXEC sp_updateextendedproperty @name = N'MS_Description', @value = ${str(comment)}, ${level} `
    + `ELSE EXEC sp_addextendedproperty @name = N'MS_Description', @value = ${str(comment)}, ${level}`;
}

// Toglie il vincolo di default di una colonna, qualunque nome abbia
function dropDefaultSql(schema, table, column) {
  const obj = str(`${quoteId(schema)}.${quoteId(table)}`);
  return `DECLARE @df sysname = (SELECT name FROM sys.default_constraints WHERE parent_object_id = OBJECT_ID(${obj}) AND parent_column_id = COLUMNPROPERTY(OBJECT_ID(${obj}), ${str(column)}, 'ColumnId')); `
    + `IF @df IS NOT NULL EXEC(N'ALTER TABLE ${quoteId(schema).replace(/'/g, "''")}.${quoteId(table).replace(/'/g, "''")} DROP CONSTRAINT [' + @df + N']')`;
}

function createTableStatements(schema, def) {
  if (!def || !NAME_RE.test(def.name || '')) fail('table_name');
  const cols = Array.isArray(def.columns) ? def.columns : [];
  if (!cols.length) fail('no_columns');
  const names = cols.map(c => c?.name);
  if (new Set(names).size !== names.length) fail('duplicate_columns');
  const colList = columnList(n => names.includes(n));
  const lines = cols.map(c => columnSql(c, def.name));
  const pk = Array.isArray(def.primaryKey) ? def.primaryKey : [];
  if (pk.length) lines.push(`CONSTRAINT ${quoteId(`PK_${def.name}`.slice(0, 128))} PRIMARY KEY (${colList(pk, { what: 'primary_key' })})`);
  if (cols.filter(c => c.autoIncrement).length > 1) fail('auto_increment_many');
  for (const fk of def.foreignKeys || []) lines.push(fkSql(schema, fk, colList));
  const out = [`CREATE TABLE ${quoteId(schema)}.${quoteId(def.name)} (\n  ${lines.join(',\n  ')}\n)`];
  for (const ix of def.indexes || []) out.push(indexSql(schema, def.name, ix, colList));
  if (def.comment) out.push(commentSql(schema, def.name, null, def.comment));
  for (const c of cols) if (c.comment) out.push(commentSql(schema, def.name, c.name, c.comment));
  return out;
}

// ---- operazioni del designer → istruzioni (ognuna a sé: in SQL Server ALTER TABLE ne fa una per volta) ----
const OPS = new Set(['create_table', 'drop_table', 'rename_table', 'add_column', 'modify_column', 'rename_column', 'drop_column',
  'add_index', 'drop_index', 'add_primary_key', 'drop_primary_key', 'add_fk', 'drop_fk', 'table_options', 'raw']);
const name = n => { if (!NAME_RE.test(n || '')) fail('name', { name: String(n ?? '') }); return quoteId(n); };
const anyColumn = () => true;

function opStatements(schema, op) {
  const tbl = () => `${quoteId(schema)}.${name(op.table)}`;
  const colList = columnList(anyColumn);
  switch (op.op) {
    case 'create_table': return createTableStatements(schema, { ...op.definition, name: op.table });
    case 'drop_table': return [`DROP TABLE ${tbl()}`];
    case 'rename_table': name(op.to); return [`EXEC sp_rename ${str(`${schema}.${op.table}`)}, ${str(op.to)}`];
    case 'add_column': return [`ALTER TABLE ${tbl()} ADD ${columnSql(op.column, op.table)}`, ...(op.column?.comment ? [commentSql(schema, op.table, op.column.name, op.column.comment)] : [])];
    case 'modify_column': {
      const c = op.column || {};
      const col = { column: c.name || op.name };
      if (c.unsigned) fail('unsigned', col);
      if (c.onUpdateCurrentTimestamp) fail('on_update', col);
      const out = [];
      let target = op.name;
      if (c.name && c.name !== op.name) { name(c.name); out.push(`EXEC sp_rename ${str(`${schema}.${op.table}.${op.name}`)}, ${str(c.name)}, N'COLUMN'`); target = c.name; }
      out.push(`ALTER TABLE ${tbl()} ALTER COLUMN ${quoteId(target)} ${typeSql(c, col)} ${c.nullable ? 'NULL' : 'NOT NULL'}`);
      if (!c.autoIncrement) {
        out.push(dropDefaultSql(schema, op.table, target));
        const d = defaultExpr(c, col);
        if (d) out.push(`ALTER TABLE ${tbl()} ADD CONSTRAINT ${quoteId(defaultName(op.table, target))} DEFAULT ${d} FOR ${quoteId(target)}`);
      }
      if (c.comment !== undefined) out.push(commentSql(schema, op.table, target, c.comment));
      return out;
    }
    case 'rename_column': name(op.to); return [`EXEC sp_rename ${str(`${schema}.${op.table}.${op.from}`)}, ${str(op.to)}, N'COLUMN'`];
    case 'drop_column': return [dropDefaultSql(schema, op.table, op.name), `ALTER TABLE ${tbl()} DROP COLUMN ${name(op.name)}`];
    case 'add_index': return [indexSql(schema, op.table, op.index || {}, colList)];
    case 'drop_index': return [`DROP INDEX ${name(op.name)} ON ${tbl()}`];
    case 'add_primary_key': return [`ALTER TABLE ${tbl()} ADD CONSTRAINT ${quoteId(`PK_${op.table}`.slice(0, 128))} PRIMARY KEY (${colList(op.columns, { what: 'primary_key' })})`];
    case 'drop_primary_key': return [`ALTER TABLE ${tbl()} DROP CONSTRAINT ${name(op.name || `PK_${op.table}`)}`];
    case 'add_fk': return [`ALTER TABLE ${tbl()} ADD ${fkSql(schema, op.fk || {}, colList)}`];
    case 'drop_fk': return [`ALTER TABLE ${tbl()} DROP CONSTRAINT ${name(op.name)}`];
    case 'table_options': return [commentSql(schema, op.table, null, op.comment)];
    case 'raw': return [op.sql.trim().replace(/;\s*$/, '')];
    default: return fail('operation', { op: String(op.op) });
  }
}

function statements(schema, ops) {
  if (!Array.isArray(ops) || !ops.length) fail('no_operations');
  if (ops.length > 500) fail('too_many_operations');
  for (const op of ops) {
    if (!op || !OPS.has(op.op)) fail('operation', { op: String(op?.op) });
    if (op.op === 'raw') { if (typeof op.sql !== 'string' || !op.sql.trim()) fail('raw_sql'); continue; }
    name(op.table);
  }
  return ops.flatMap(op => opStatements(schema, op));
}

module.exports = {
  quoteId, literal, TYPES, TYPE_ALIASES, canonical, FK_ACTIONS: [...FK_ACTIONS], DdlError, fail,
  typeSql, columnSql, createTableStatements, statements,
  createTableSql: (schema, def) => createTableStatements(schema, def).join(';\n'),
};
