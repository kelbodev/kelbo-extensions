// SQL Server attraverso la sezione Database di Kelbo. Server da KELBO_TEST_MSSQL="host:porta:utente:password"
// (es. un container mcr.microsoft.com/mssql/server); senza, i test che lo usano vengono saltati.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { startServer, i18nProblems } = require('kelbo/testkit');

const DIR = path.join(__dirname, '..');
const target = process.env.KELBO_TEST_MSSQL ? (([host, port, user, ...pw]) => ({ host, port: Number(port), user, password: pw.join(':') }))(process.env.KELBO_TEST_MSSQL.split(':')) : null;
let srv;
const api = (m, p, body) => srv.request(m, `${p.startsWith('/core') ? '/api' : '/api/ext/db-client'}${p}`, body !== undefined ? { body } : {});
const run = (sql, extra = {}) => api('POST', '/connections/ms/query', { sql, ...extra });
async function confirmed(sql, extra = {}) {
  const first = await run(sql, extra);
  assert.equal(first.status, 428, first.text);
  return run(sql, { ...extra, confirm: first.json.token });
}

before(async () => {
  srv = await startServer({ projects: [] }, { install: [DIR] });
  if (!target) return;
  await api('POST', '/core/vault/init', { password: 'master-password-ms' });
  const conn = { type: 'mssql', host: target.host, port: target.port, user: target.user, password: target.password, options: { encrypt: true, trustServerCertificate: true } };
  await api('POST', '/connections', { id: 'master', label: 'master', ...conn, database: 'master' });
  const setup = await api('POST', '/connections/master/query', { sql: "IF DB_ID('kelbo_shop') IS NOT NULL DROP DATABASE kelbo_shop" });
  if (setup.status === 428) await api('POST', '/connections/master/query', { sql: "IF DB_ID('kelbo_shop') IS NOT NULL DROP DATABASE kelbo_shop", confirm: setup.json.token });
  const mk = await api('POST', '/connections/master/query', { sql: 'CREATE DATABASE kelbo_shop' });
  await api('POST', '/connections/master/query', { sql: 'CREATE DATABASE kelbo_shop', confirm: mk.json.token });
  await api('POST', '/connections', { id: 'ms', label: 'MS', ...conn, database: 'kelbo_shop' });
});
after(() => srv?.stop());

test('traduzioni', () => assert.deepEqual(i18nProblems(DIR), []));

test('connessione, schemi, query, conferme, errori', async t => {
  if (!target) return t.skip('KELBO_TEST_MSSQL non impostata');
  let r = await api('POST', '/connections/ms/test', {});
  assert.equal(r.status, 200, r.text);
  assert.match(r.json.version, /Microsoft SQL Server/);
  assert.equal(r.json.db, 'kelbo_shop');
  r = await confirmed(`CREATE TABLE dbo.clienti (id INT IDENTITY(1,1) CONSTRAINT PK_clienti PRIMARY KEY, nome NVARCHAR(80) NOT NULL, citta NVARCHAR(60) NULL,
    creato DATETIME2(0) NOT NULL CONSTRAINT DF_clienti_creato DEFAULT '2026-01-02 03:04:05', foto VARBINARY(MAX) NULL, attivo BIT NOT NULL CONSTRAINT DF_clienti_attivo DEFAULT 1)`);
  assert.equal(r.status, 200, r.text);
  r = await confirmed("INSERT INTO dbo.clienti (nome, citta, foto) VALUES (N'Giulia', N'Milano', 0xDEADBEEF), (N'Marco', N'Torino', NULL), (N'Sara', NULL, NULL)");
  assert.equal(r.json.affectedRows, 3, r.text);
  r = await api('GET', '/connections/ms/databases');
  assert.equal(r.json.databases[0], 'dbo');
  assert.equal(r.json.default, 'dbo');
  assert.deepEqual((await api('GET', '/connections/ms/databases/dbo/tables')).json.tables.map(x => x.name), ['clienti']);
  r = await run('SELECT id, nome, creato, foto, attivo FROM dbo.clienti ORDER BY id', { limit: 2 });
  assert.equal(r.status, 200, r.text);
  assert.deepEqual([r.json.rowCount, r.json.truncated, r.json.total], [2, true, 3]);
  assert.deepEqual(r.json.rows[0], [1, 'Giulia', '2026-01-02 03:04:05', '0xdeadbeef', 1]);
  r = await run('SELECT * FROM nope');
  assert.equal(r.json.code, 'db-client.database');
  assert.equal(r.json.params.dbCode, '208');
  r = await run('SELECT 1\nGO');
  assert.equal(r.json.code, 'db-client.sql_go_unsupported');
});

test('dati, export, designer', async t => {
  if (!target) return t.skip('KELBO_TEST_MSSQL non impostata');
  let r = await api('POST', '/connections/ms/databases/dbo/tables/clienti/rows', { page: 2, pageSize: 25, search: 'mil' });
  assert.equal(r.status, 200, r.text);
  assert.deepEqual([r.json.total, r.json.rows.length], [1, 0]);
  const edit = body => api('POST', '/connections/ms/databases/dbo/tables/clienti/row', body);
  r = await edit({ op: 'update', key: { id: 2 }, values: { citta: "Aosta d'Italia" } });
  assert.match(r.json.sql, /^UPDATE TOP \(1\) \[dbo\]\.\[clienti\] SET \[citta\] = N'Aosta d''Italia' WHERE \[id\] = 2$/);
  r = await edit({ op: 'update', key: { id: 2 }, values: { citta: "Aosta d'Italia" }, confirm: r.json.token });
  assert.equal(r.json.affectedRows, 1, r.text);
  r = await api('POST', '/connections/ms/exports', { format: 'sql', source: { type: 'table', db: 'dbo', table: 'clienti' } });
  const file = await srv.request('GET', `/api/ext/db-client/connections/ms/exports/${r.json.id}`);
  assert.match(file.text, /CREATE TABLE \[dbo\]\.\[clienti\]/);
  assert.match(file.text, /0xdeadbeef/i);
  const def = (await api('GET', '/connections/ms/databases/dbo/tables/clienti/definition')).json.definition;
  assert.deepEqual(def.primaryKey, ['id']);
  const byName = Object.fromEntries(def.columns.map(x => [x.name, x]));
  assert.deepEqual([byName.id.type, byName.id.autoIncrement, byName.nome.type, byName.nome.length], ['INT', true, 'NVARCHAR', 80]);
  assert.deepEqual(byName.attivo.default, { kind: 'value', value: '1' });
  // modifica: rinomina, nuovo default, nuova colonna
  const next = { ...def, columns: [...def.columns.map(x => (x.name === 'citta' ? { ...x, name: 'luogo', length: 120, default: { kind: 'value', value: 'N/D' } } : x)), { name: 'note', type: 'NVARCHAR', length: 'MAX', nullable: true }] };
  const design = { table: 'clienti', definition: next, renames: { luogo: 'citta' } };
  r = await api('POST', '/connections/ms/databases/dbo/migrate', { design });
  assert.equal(r.status, 428, r.text);
  r = await api('POST', '/connections/ms/databases/dbo/migrate', { design, confirm: r.json.token, acknowledgeWarnings: true });
  assert.equal(r.status, 200, r.text);
  const after = (await api('GET', '/connections/ms/databases/dbo/tables/clienti/definition')).json.definition;
  const a = Object.fromEntries(after.columns.map(x => [x.name, x]));
  assert.deepEqual([a.luogo.length, a.luogo.default, a.note.length], [120, { kind: 'value', value: 'N/D' }, 'MAX']);
});
