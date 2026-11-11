// SQL Server: struttura delle tabelle di uno schema dal catalogo sys.*, nel modello del designer
const ddl = require('./ddl');

// "((0))", "(N'x')", "(getdate())" → { kind, value? }
function defaultOf(def) {
  if (def === null || def === undefined) return { kind: 'none' };
  let v = String(def).trim();
  while (/^\(.*\)$/s.test(v) && balanced(v.slice(1, -1))) v = v.slice(1, -1).trim();
  if (/^NULL$/i.test(v)) return { kind: 'null' };
  if (/^(getdate|sysdatetime|current_timestamp|sysdatetimeoffset)(\(\))?$/i.test(v)) return { kind: 'current_timestamp' };
  let m;
  if ((m = /^N?'((?:[^']|'')*)'$/s.exec(v))) return { kind: 'value', value: m[1].replace(/''/g, "'") };
  if (/^-?\d+(\.\d+)?$/.test(v)) return { kind: 'value', value: v };
  return { kind: 'expression', value: v };
}
function balanced(s) {
  let d = 0;
  for (const ch of s) { if (ch === '(') d++; else if (ch === ')') { d--; if (d < 0) return false; } }
  return d === 0;
}

// Tipo leggibile: nvarchar(80), decimal(10,2), varchar(MAX)
function typeLabel(c) {
  const t = c.type_name.toLowerCase();
  if (['varchar', 'char', 'varbinary', 'binary'].includes(t)) return `${t}(${c.max_length === -1 ? 'MAX' : c.max_length})`;
  if (['nvarchar', 'nchar'].includes(t)) return `${t}(${c.max_length === -1 ? 'MAX' : c.max_length / 2})`;
  if (['decimal', 'numeric'].includes(t)) return `${t}(${c.precision},${c.scale})`;
  if (['datetime2', 'time', 'datetimeoffset'].includes(t)) return `${t}(${c.scale})`;
  return t;
}

function column(c) {
  const type = ddl.canonical(c.type_name);
  const kind = ddl.TYPES[type];
  const col = { name: c.column_name, type: kind ? type : c.type_name };
  if (kind === 'length') col.length = c.max_length === -1 ? 'MAX' : ['NVARCHAR', 'NCHAR'].includes(type) ? c.max_length / 2 : c.max_length;
  else if (kind === 'decimal') { col.length = c.precision; col.scale = c.scale; }
  else if (kind === 'temporal' && c.scale !== 7) col.length = c.scale;
  col.nullable = !!c.is_nullable;
  col.default = c.is_identity ? { kind: 'none' } : defaultOf(c.default_definition);
  if (c.default_name) col.defaultName = c.default_name;
  if (c.is_identity) col.autoIncrement = true;
  if (c.comment) col.comment = c.comment;
  if (!kind) col.unsupported = typeLabel(c);
  return col;
}

const COLUMNS_SQL = (filter) => `
  SELECT t.name AS table_name, c.name AS column_name, ty.name AS type_name, c.max_length, c.precision, c.scale, c.is_nullable, c.is_identity,
         dc.definition AS default_definition, dc.name AS default_name, CAST(ep.value AS nvarchar(4000)) AS comment, c.column_id
    FROM sys.columns c
    JOIN sys.tables t ON t.object_id = c.object_id
    JOIN sys.schemas s ON s.schema_id = t.schema_id
    JOIN sys.types ty ON ty.user_type_id = c.user_type_id
    LEFT JOIN sys.default_constraints dc ON dc.parent_object_id = c.object_id AND dc.parent_column_id = c.column_id
    LEFT JOIN sys.extended_properties ep ON ep.major_id = c.object_id AND ep.minor_id = c.column_id AND ep.name = 'MS_Description'
   WHERE s.name = @p1${filter} ORDER BY t.name, c.column_id`;

// q(sql, params) → righe; params: [schema, tabella?]
async function introspect(q, schema, tables = null) {
  if (tables && !tables.length) return { tables: {} };
  const result = {};
  for (const table of tables || [null]) {
    const filter = table ? ' AND t.name = @p2' : '';
    const params = table ? [schema, table] : [schema];
    const [tableRows, colRows, idxRows, fkRows] = await Promise.all([
      q(`SELECT t.name, CAST(ep.value AS nvarchar(4000)) AS comment FROM sys.tables t JOIN sys.schemas s ON s.schema_id = t.schema_id
           LEFT JOIN sys.extended_properties ep ON ep.major_id = t.object_id AND ep.minor_id = 0 AND ep.name = 'MS_Description'
          WHERE s.name = @p1${filter} ORDER BY t.name`, params),
      q(COLUMNS_SQL(filter), params),
      q(`SELECT t.name AS table_name, i.name AS index_name, i.is_unique, i.is_primary_key, i.is_unique_constraint, c.name AS column_name
           FROM sys.indexes i JOIN sys.tables t ON t.object_id = i.object_id JOIN sys.schemas s ON s.schema_id = t.schema_id
           JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id AND ic.is_included_column = 0
           JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
          WHERE s.name = @p1${filter} AND i.type > 0 ORDER BY t.name, i.name, ic.key_ordinal`, params),
      q(`SELECT t.name AS table_name, fk.name, rs.name AS ref_schema, rt.name AS ref_table, pc.name AS column_name, rc.name AS ref_column,
                fk.delete_referential_action_desc AS on_delete, fk.update_referential_action_desc AS on_update
           FROM sys.foreign_keys fk JOIN sys.tables t ON t.object_id = fk.parent_object_id JOIN sys.schemas s ON s.schema_id = t.schema_id
           JOIN sys.tables rt ON rt.object_id = fk.referenced_object_id JOIN sys.schemas rs ON rs.schema_id = rt.schema_id
           JOIN sys.foreign_key_columns fkc ON fkc.constraint_object_id = fk.object_id
           JOIN sys.columns pc ON pc.object_id = fkc.parent_object_id AND pc.column_id = fkc.parent_column_id
           JOIN sys.columns rc ON rc.object_id = fkc.referenced_object_id AND rc.column_id = fkc.referenced_column_id
          WHERE s.name = @p1${filter} ORDER BY t.name, fk.name, fkc.constraint_column_id`, params),
    ]);
    for (const t of tableRows) result[t.name] = { ...(t.comment ? { comment: t.comment } : {}), columns: [], primaryKey: [], indexes: [], foreignKeys: [] };
    for (const c of colRows) result[c.table_name]?.columns.push(column(c));
    const idx = new Map();
    for (const i of idxRows) {
      const t = result[i.table_name];
      if (!t) continue;
      if (i.is_primary_key) { t.primaryKey.push(i.column_name); t.primaryKeyName = i.index_name; continue; }
      const k = `${i.table_name}\0${i.index_name}`;
      if (!idx.has(k)) { const ix = { name: i.index_name, columns: [], unique: !!i.is_unique, ...(i.is_unique_constraint ? { constraint: true } : {}) }; idx.set(k, ix); t.indexes.push(ix); }
      idx.get(k).columns.push(i.column_name);
    }
    const fks = new Map();
    const action = a => String(a || 'NO_ACTION').replace(/_/g, ' ');
    for (const f of fkRows) {
      const t = result[f.table_name];
      if (!t) continue;
      const k = `${f.table_name}\0${f.name}`;
      if (!fks.has(k)) {
        const fk = { name: f.name, columns: [], refTable: f.ref_table, refColumns: [], ...(f.ref_schema !== schema ? { refDatabase: f.ref_schema } : {}), onDelete: action(f.on_delete), onUpdate: action(f.on_update) };
        fks.set(k, fk);
        t.foreignKeys.push(fk);
      }
      fks.get(k).columns.push(f.column_name);
      fks.get(k).refColumns.push(f.ref_column);
    }
  }
  return { tables: result };
}

module.exports = { introspect, column, defaultOf, typeLabel, COLUMNS_SQL };
