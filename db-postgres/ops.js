// PostgreSQL: istruzioni dalle operazioni del designer (stesso modello di db-mysql/ops.js).
// Le clausole che stanno in un ALTER TABLE si uniscono finché la tabella non cambia; il resto
// (rinomine di colonne e tabelle, indici, commenti) sono istruzioni a sé. Le colonne non si
// spostano: PostgreSQL non ha AFTER/FIRST (il confronto non propone spostamenti).
const ddl = require('./ddl');

const { quoteId, fail, NAME_RE } = ddl;
const OPS = new Set(['create_table', 'drop_table', 'rename_table', 'add_column', 'modify_column', 'rename_column', 'drop_column',
  'add_index', 'drop_index', 'add_primary_key', 'drop_primary_key', 'add_fk', 'drop_fk', 'table_options', 'raw']);
const anyColumn = () => true; // le colonne di indici e chiavi in ALTER le verifica il database
const name = n => { if (!NAME_RE.test(n || '')) fail('name', { name: String(n ?? '') }); return quoteId(n); };

function validate(ops) {
  if (!Array.isArray(ops) || !ops.length) fail('no_operations');
  if (ops.length > 500) fail('too_many_operations');
  for (const op of ops) {
    if (!op || !OPS.has(op.op)) fail('operation', { op: String(op?.op) });
    if (op.op === 'raw') { if (typeof op.sql !== 'string' || !op.sql.trim()) fail('raw_sql'); continue; }
    name(op.table);
  }
}

// Una modifica di colonna: rinomina (istruzione a sé), poi tipo, NULL e default nello stesso ALTER
function modifyColumn(schema, op) {
  const c = op.column || {};
  const col = { column: c.name || op.name };
  const before = [], after = [];
  let target = op.name;
  if (c.name && c.name !== op.name) {
    before.push(`ALTER TABLE ${quoteId(schema)}.${name(op.table)} RENAME COLUMN ${name(op.name)} TO ${name(c.name)}`);
    target = c.name;
  }
  if (c.unsigned) fail('unsigned', col);
  if (c.onUpdateCurrentTimestamp) fail('on_update', col);
  const t = ddl.typeSql(c, col);
  const q = name(target);
  const clauses = [`ALTER COLUMN ${q} TYPE ${t} USING ${q}::${t}`, `ALTER COLUMN ${q} ${c.nullable ? 'DROP' : 'SET'} NOT NULL`];
  if (!c.autoIncrement) {
    const d = ddl.defaultSql(c, col);
    clauses.push(d ? `ALTER COLUMN ${q} SET${d}` : `ALTER COLUMN ${q} DROP DEFAULT`);
  }
  if (c.comment !== undefined) after.push(ddl.commentOnColumn(schema, op.table, target, c.comment));
  return { before, clauses, after };
}

// { before: [istruzioni], clauses: [clausole di ALTER TABLE], after: [istruzioni] } di un'operazione
function parts(schema, op) {
  const colList = ddl.columnList(anyColumn);
  const one = s => ({ before: [s], clauses: [], after: [] });
  const tbl = () => `${quoteId(schema)}.${name(op.table)}`;
  switch (op.op) {
    case 'add_column': return { before: [], clauses: [`ADD COLUMN ${ddl.columnSql(op.column)}`], after: op.column?.comment ? [ddl.commentOnColumn(schema, op.table, op.column.name, op.column.comment)] : [] };
    case 'modify_column': return modifyColumn(schema, op);
    case 'rename_column': return one(`ALTER TABLE ${tbl()} RENAME COLUMN ${name(op.from)} TO ${name(op.to)}`);
    case 'drop_column': return { before: [], clauses: [`DROP COLUMN ${name(op.name)}`], after: [] };
    case 'add_index': return one(ddl.indexSql(schema, op.table, op.index || {}, colList));
    case 'drop_index': return one(`DROP INDEX ${quoteId(schema)}.${name(op.name)}`);
    case 'add_primary_key': return { before: [], clauses: [`ADD PRIMARY KEY (${colList(op.columns, { what: 'primary_key' })})`], after: [] };
    // nome del vincolo letto dal database, altrimenti quello predefinito di PostgreSQL
    case 'drop_primary_key': return { before: [], clauses: [`DROP CONSTRAINT ${name(op.name || `${op.table}_pkey`)}`], after: [] };
    case 'add_fk': return { before: [], clauses: [`ADD ${ddl.fkSql(schema, op.fk || {}, colList)}`], after: [] };
    case 'drop_fk': return { before: [], clauses: [`DROP CONSTRAINT ${name(op.name)}`], after: [] };
    case 'table_options': return one(ddl.commentOnTable(schema, op.table, op.comment)); // engine: non esiste in PostgreSQL
    case 'create_table': return { before: ddl.createTableStatements(schema, { ...op.definition, name: op.table }), clauses: [], after: [] };
    case 'drop_table': return one(`DROP TABLE ${tbl()}`);
    case 'rename_table': return one(`ALTER TABLE ${tbl()} RENAME TO ${name(op.to)}`);
    case 'raw': return one(op.sql.trim().replace(/;\s*$/, ''));
    default: return fail('operation', { op: String(op.op) });
  }
}

// Istruzioni SQL dalle operazioni, nell'ordine
function statements(schema, ops) {
  validate(ops);
  const out = [];
  let alter = null; // { table, clauses, after }
  const flush = () => {
    if (alter?.clauses.length) out.push(`ALTER TABLE ${quoteId(schema)}.${quoteId(alter.table)}\n  ${alter.clauses.join(',\n  ')}`);
    if (alter) out.push(...alter.after);
    alter = null;
  };
  for (const op of ops) {
    const p = parts(schema, op);
    if (p.before.length || !p.clauses.length || (alter && (alter.table !== op.table || op.newStatement))) flush();
    out.push(...p.before);
    if (p.clauses.length) {
      alter = alter || { table: op.table, clauses: [], after: [] };
      alter.clauses.push(...p.clauses);
      alter.after.push(...p.after);
    } else out.push(...p.after);
  }
  flush();
  return out;
}

module.exports = { OPS, validate, statements };
