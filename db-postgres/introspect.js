// PostgreSQL: struttura reale delle tabelle di uno schema dal catalogo (solo letture con
// parametri), nello stesso modello del designer: { tables: { <nome>: definizione } }.
const ddl = require('./ddl');

// Tipo del catalogo → tipo del designer, o null se il designer non lo gestisce (array, enum…)
function designerType(c) {
  if (c.data_type === 'ARRAY' || c.data_type === 'USER-DEFINED') return null;
  const t = ddl.canonical(c.data_type);
  return ddl.TYPES[t] ? t : null;
}

// Default del catalogo → { kind, value? }
function defaultOf(raw) {
  if (raw === null || raw === undefined) return { kind: 'none' };
  const v = String(raw).trim();
  if (/^NULL(::[\w\s"[\]]+)?$/i.test(v)) return { kind: 'null' };
  if (/^(CURRENT_TIMESTAMP|now\(\)|LOCALTIMESTAMP)$/i.test(v)) return { kind: 'current_timestamp' };
  let m;
  if ((m = /^'((?:[^']|'')*)'(::[\w\s"[\]]+)?$/s.exec(v))) return { kind: 'value', value: m[1].replace(/''/g, "'") };
  if (/^-?\d+(\.\d+)?$/.test(v)) return { kind: 'value', value: v };
  if (/^(true|false)$/i.test(v)) return { kind: 'value', value: v.toLowerCase() };
  return { kind: 'expression', value: v }; // gen_random_uuid(), espressioni
}

function column(c) {
  const type = designerType(c);
  const col = { name: c.column_name, type: type || c.udt_name };
  const kind = type && ddl.TYPES[type];
  if (kind === 'length' && c.character_maximum_length != null) col.length = Number(c.character_maximum_length);
  else if (kind === 'decimal' && c.numeric_precision != null) { col.length = Number(c.numeric_precision); col.scale = Number(c.numeric_scale); }
  else if (kind === 'temporal' && c.datetime_precision != null && Number(c.datetime_precision) !== 6) col.length = Number(c.datetime_precision);
  col.nullable = c.is_nullable === 'YES';
  const serial = /^nextval\(/i.test(String(c.column_default || ''));
  col.default = c.is_identity === 'YES' || serial ? { kind: 'none' } : defaultOf(c.column_default);
  if (c.is_identity === 'YES' || serial) col.autoIncrement = true;
  if (c.comment) col.comment = c.comment;
  if (!type) col.unsupported = c.data_type === 'ARRAY' ? `${c.udt_name.replace(/^_/, '')}[]` : c.udt_name;
  return col;
}

// q(sql, params) → righe. tables: limita a queste tabelle (default: tutte quelle dello schema)
async function introspect(q, schema, tables = null) {
  if (tables && !tables.length) return { tables: {} };
  const only = (alias, n) => (tables ? ` AND ${alias} = ANY($${n}::text[])` : '');
  const params = tables ? [schema, tables] : [schema];
  const [tableRows, colRows, idxRows, fkRows] = await Promise.all([
    q(`SELECT c.relname AS name, obj_description(c.oid, 'pg_class') AS comment
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = $1 AND c.relkind IN ('r', 'p')${only('c.relname', 2)} ORDER BY c.relname`, params),
    q(`SELECT c.table_name, c.column_name, c.data_type, c.udt_name, c.character_maximum_length, c.numeric_precision, c.numeric_scale,
              c.datetime_precision, c.is_nullable, c.column_default, c.is_identity,
              col_description(format('%I.%I', c.table_schema, c.table_name)::regclass::oid, c.ordinal_position) AS comment
         FROM information_schema.columns c
        WHERE c.table_schema = $1${only('c.table_name', 2)} ORDER BY c.table_name, c.ordinal_position`, params),
    q(`SELECT t.relname AS table_name, i.relname AS index_name, ix.indisunique AS is_unique, ix.indisprimary AS is_primary,
              (SELECT array_agg(a.attname ORDER BY k.ord)::text[]
                 FROM unnest(ix.indkey) WITH ORDINALITY AS k(attnum, ord)
                 JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = k.attnum) AS columns,
              con.conname AS constraint_name
         FROM pg_index ix
         JOIN pg_class t ON t.oid = ix.indrelid
         JOIN pg_class i ON i.oid = ix.indexrelid
         JOIN pg_namespace n ON n.oid = t.relnamespace
         LEFT JOIN pg_constraint con ON con.conindid = ix.indexrelid AND con.contype IN ('p', 'u')
        WHERE n.nspname = $1${only('t.relname', 2)} ORDER BY t.relname, i.relname`, params),
    q(`SELECT cl.relname AS table_name, con.conname AS name, rn.nspname AS ref_schema, rc.relname AS ref_table,
              con.confdeltype, con.confupdtype,
              (SELECT array_agg(a.attname ORDER BY u.ord)::text[] FROM unnest(con.conkey) WITH ORDINALITY u(n, ord)
                 JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = u.n) AS columns,
              (SELECT array_agg(a.attname ORDER BY u.ord)::text[] FROM unnest(con.confkey) WITH ORDINALITY u(n, ord)
                 JOIN pg_attribute a ON a.attrelid = con.confrelid AND a.attnum = u.n) AS ref_columns
         FROM pg_constraint con
         JOIN pg_class cl ON cl.oid = con.conrelid JOIN pg_namespace n ON n.oid = cl.relnamespace
         JOIN pg_class rc ON rc.oid = con.confrelid JOIN pg_namespace rn ON rn.oid = rc.relnamespace
        WHERE con.contype = 'f' AND n.nspname = $1${only('cl.relname', 2)} ORDER BY cl.relname, con.conname`, params),
  ]);
  const ACTIONS = { a: 'NO ACTION', r: 'RESTRICT', c: 'CASCADE', n: 'SET NULL', d: 'SET DEFAULT' };
  const result = {};
  for (const t of tableRows) result[t.name] = { ...(t.comment ? { comment: t.comment } : {}), columns: [], primaryKey: [], indexes: [], foreignKeys: [] };
  for (const c of colRows) result[c.table_name]?.columns.push(column(c));
  for (const i of idxRows) {
    const t = result[i.table_name];
    if (!t) continue;
    if (i.is_primary) { t.primaryKey = i.columns || []; t.primaryKeyName = i.constraint_name || i.index_name; continue; }
    t.indexes.push({ name: i.index_name, columns: i.columns || [], unique: !!i.is_unique, ...(i.constraint_name ? { constraint: true } : {}) });
  }
  for (const f of fkRows) {
    const t = result[f.table_name];
    if (!t) continue;
    t.foreignKeys.push({
      name: f.name, columns: f.columns || [], refTable: f.ref_table, refColumns: f.ref_columns || [],
      ...(f.ref_schema !== schema ? { refDatabase: f.ref_schema } : {}),
      onDelete: ACTIONS[f.confdeltype] || 'NO ACTION', onUpdate: ACTIONS[f.confupdtype] || 'NO ACTION',
    });
  }
  return { tables: result };
}

module.exports = { introspect, column, defaultOf };
