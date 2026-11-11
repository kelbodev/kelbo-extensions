// SQL Server senza server: classificazione T-SQL, conteggio, paginazione, DDL e operazioni
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { dbClientTools } = require('kelbo/testkit');
const createMssqlEngine = require('../engine');
const ddl = require('../ddl');

const engine = createMssqlEngine(dbClientTools());
const c = s => engine.sql.classify(s);

test('classificazione T-SQL', () => {
  for (const s of ['SELECT 1', 'SELECT TOP (10) * FROM [dbo].[t]', "SELECT N'drop table x'", 'WITH a AS (SELECT 1 AS x) SELECT * FROM a',
    'SELECT [update] FROM t', "SELECT REPLACE(a, 'x', 'y') FROM t"]) assert.equal(c(s).kind, 'read', s);
  for (const s of ['INSERT INTO t VALUES (1)', 'UPDATE t SET a = 1', 'EXEC sp_who', 'MERGE t USING s ON 1 = 1 WHEN MATCHED THEN DELETE;', 'DECLARE @a int', 'BEGIN TRAN', 'xyz'])
    assert.equal(c(s).kind, 'write', s);
  assert.equal(c('SELECT * INTO nuova FROM t').reason, 'into');
  assert.equal(c('SELECT * FROM t WITH (UPDLOCK)').reason, 'row_lock');
  assert.equal(c("SELECT * FROM OPENROWSET('x', 'y', 'z')").reason, 'write_function');
  assert.equal(c('SELECT NEXT VALUE FOR seq').reason, 'write_function');
  assert.deepEqual(c('SELECT 1\nGO'), { kind: 'invalid', verb: 'GO', reason: 'go_unsupported' });
  assert.equal(c('USE shop').reason, 'use_unsupported');
});

test('conteggio senza ORDER BY finale, paginazione con OFFSET FETCH, segnaposto', () => {
  assert.equal(engine.sql.countQuery('SELECT * FROM t ORDER BY a').sql, 'SELECT COUNT(*) FROM (\nSELECT * FROM t\n) AS kelbo_count');
  assert.deepEqual(engine.sql.countQuery('SELECT * FROM t ORDER BY a OFFSET 10 ROWS FETCH NEXT 5 ROWS ONLY').limit, { count: 5, offset: 10 });
  assert.deepEqual(engine.page('SELECT * FROM t', [], 25, 50), { sql: 'SELECT * FROM t ORDER BY (SELECT NULL) OFFSET ? ROWS FETCH NEXT ? ROWS ONLY', params: [50, 25] });
  assert.equal(engine.sql.bindParams('SELECT * FROM t WHERE a = ? AND b = :b', { '#1': "o'k", b: 3 }).sql, "SELECT * FROM t WHERE a = N'o''k' AND b = 3");
  assert.deepEqual(engine.sql.splitStatements('SELECT [a;b] FROM t; SELECT 2').map(s => s.sql), ['SELECT [a;b] FROM t', 'SELECT 2']);
  assert.deepEqual(engine.sql.schemaChange("EXEC sp_rename N'dbo.t.vecchio', N'nuovo', N'COLUMN'"), { table: 't', operation: 'rename_vecchio' });
});

test('DDL: identity, default con nome, commenti, operazioni con sp_rename', () => {
  const [create, ...rest] = ddl.createTableStatements('dbo', {
    name: 'ordini', comment: 'Ordini', primaryKey: ['id'],
    columns: [{ name: 'id', type: 'INT', autoIncrement: true }, { name: 'nome', type: 'NVARCHAR', length: 80, nullable: false, default: { kind: 'value', value: "l'x" } },
      { name: 'note', type: 'NVARCHAR', length: 'MAX', nullable: true }, { name: 'creato', type: 'DATETIME2', length: 3, nullable: false, default: { kind: 'current_timestamp' } }],
    indexes: [{ name: 'IX_nome', columns: ['nome'], unique: true }],
  });
  assert.equal(create, `CREATE TABLE [dbo].[ordini] (
  [id] INT IDENTITY(1,1) NOT NULL,
  [nome] NVARCHAR(80) NOT NULL CONSTRAINT [DF_ordini_nome] DEFAULT N'l''x',
  [note] NVARCHAR(MAX) NULL,
  [creato] DATETIME2(3) NOT NULL CONSTRAINT [DF_ordini_creato] DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT [PK_ordini] PRIMARY KEY ([id])
)`);
  assert.equal(rest[0], 'CREATE UNIQUE INDEX [IX_nome] ON [dbo].[ordini] ([nome])');
  assert.match(rest[1], /sp_addextendedproperty @name = N'MS_Description', @value = N'Ordini'/);
  const sql = engine.schema.statements('dbo', [{ op: 'modify_column', table: 'ordini', name: 'nome', column: { name: 'cliente', type: 'NVARCHAR', length: 120, nullable: true } }]);
  assert.equal(sql[0], "EXEC sp_rename N'dbo.ordini.nome', N'cliente', N'COLUMN'");
  assert.equal(sql[1], 'ALTER TABLE [dbo].[ordini] ALTER COLUMN [cliente] NVARCHAR(120) NULL');
  assert.match(sql[2], /sys\.default_constraints/);
  assert.throws(() => ddl.columnSql({ name: 'a', type: 'INT', unsigned: true }, 't'), /unsigned/);
  assert.equal(ddl.columnSql({ name: 'f', type: 'BIT', nullable: false, default: { kind: 'value', value: '1' } }, 't'), "[f] BIT NOT NULL CONSTRAINT [DF_t_f] DEFAULT N'1'");
});
