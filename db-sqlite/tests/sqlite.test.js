// SQLite attraverso la sezione Database di Kelbo, con un file temporaneo nella cartella di un progetto
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { startServer, i18nProblems, dbClientTools } = require('kelbo/testkit');
const createSqliteEngine = require('../engine');

const DIR = path.join(__dirname, '..');
const engine = createSqliteEngine(dbClientTools());
let srv, project;
const api = (m, p, body) => srv.request(m, `${p.startsWith('/core') ? '/api' : '/api/ext/db-client'}${p}`, body !== undefined ? { body } : {});
const run = (sql, extra = {}) => api('POST', '/connections/lite/query', { sql, ...extra });
async function confirmed(sql, extra = {}) {
  const first = await run(sql, extra);
  assert.equal(first.status, 428, first.text);
  return run(sql, { ...extra, confirm: first.json.token });
}

before(async () => {
  project = fs.mkdtempSync(path.join(os.tmpdir(), 'kelbo-sqlite-'));
  fs.mkdirSync(path.join(project, 'data'));
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(path.join(project, 'data', 'app.sqlite'));
  db.exec(`CREATE TABLE clienti (id INTEGER PRIMARY KEY AUTOINCREMENT, nome VARCHAR(80) NOT NULL, citta TEXT, creato DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, foto BLOB);
    INSERT INTO clienti (nome, citta, foto) VALUES ('Giulia', 'Milano', X'DEADBEEF'), ('Marco', 'Torino', NULL), ('Sara', NULL, NULL);
    CREATE TABLE ordini (id INTEGER PRIMARY KEY, cliente INTEGER NOT NULL REFERENCES clienti (id) ON DELETE CASCADE, totale NUMERIC(10,2) NOT NULL DEFAULT 0);
    CREATE INDEX ix_ordini_cliente ON ordini (cliente);
    INSERT INTO ordini (cliente, totale) VALUES (1, 10.5), (1, 3), (2, 7);
    CREATE VIEW vista AS SELECT * FROM clienti;`);
  db.close();
  srv = await startServer({ projects: [{ id: 'app', label: 'App', path: project }] }, { install: [DIR] });
  await api('POST', '/core/vault/init', { password: 'master-password-lite' });
});
after(async () => { await srv?.stop(); fs.rmSync(project, { recursive: true, force: true }); });

test('traduzioni', () => assert.deepEqual(i18nProblems(DIR), []));

test('classificazione SQLite', () => {
  const k = s => engine.sql.classify(s).kind;
  for (const s of ['SELECT 1', 'PRAGMA table_info(t)', 'PRAGMA main.index_list("t")', 'EXPLAIN QUERY PLAN SELECT * FROM t', 'WITH a AS (SELECT 1) SELECT * FROM a', 'VALUES (1)']) assert.equal(k(s), 'read', s);
  for (const s of ['PRAGMA journal_mode = WAL', 'PRAGMA foreign_keys = OFF', 'PRAGMA optimize', "ATTACH 'x.db' AS x", 'VACUUM', 'INSERT INTO t DEFAULT VALUES', 'REPLACE INTO t VALUES (1)', 'WITH a AS (SELECT 1) DELETE FROM t'])
    assert.equal(k(s), 'write', s);
  assert.equal(engine.sql.classify("SELECT load_extension('x')").reason, 'write_function');
});

test('connessione a un file relativo al progetto: rifiuti, schemi, tabelle, query', async () => {
  let r = await api('POST', '/connections', { id: 'x', label: 'X', type: 'sqlite', file: 'data/app.sqlite' });
  assert.equal(r.json.code, 'db-client.file_relative_project');
  r = await api('POST', '/connections', { id: 'x', label: 'X', type: 'sqlite', file: '../fuori.db', projectId: 'app' });
  assert.equal(r.json.code, 'db-client.file_outside_project');
  r = await api('POST', '/connections', { id: 'lite', label: 'App', type: 'sqlite', file: 'data/app.sqlite', projectId: 'app', host: 'ignorato' });
  assert.equal(r.status, 200, r.text);
  assert.deepEqual([r.json.connection.file, r.json.connection.host, r.json.connection.tunnel, r.json.connection.defaultDb], ['data/app.sqlite', undefined, undefined, 'main']);
  r = await api('POST', '/connections/lite/test', {});
  assert.match(r.json.version, /^SQLite 3\./);
  assert.deepEqual((await api('GET', '/connections/lite/databases')).json.databases, ['main']);
  assert.deepEqual((await api('GET', '/connections/lite/databases/main/tables')).json.tables.map(t => [t.name, t.view]), [['clienti', false], ['ordini', false], ['vista', true]]);
  r = await run('SELECT id, nome, foto FROM clienti ORDER BY id', { limit: 2 });
  assert.deepEqual([r.json.rowCount, r.json.truncated, r.json.total], [2, true, 3]);
  assert.deepEqual(r.json.rows[0], [1, 'Giulia', '0xdeadbeef']);
  assert.deepEqual(r.json.columns.map(c => [c.table, c.column]), [['clienti', 'id'], ['clienti', 'nome'], ['clienti', 'foto']]);
  r = await run('PRAGMA journal_mode = WAL');
  assert.equal(r.status, 428);
  r = await confirmed("UPDATE clienti SET citta = 'Roma' WHERE nome = 'Sara'");
  assert.equal(r.json.affectedRows, 1, r.text);
  r = await run('SELECT * FROM non_esiste');
  assert.equal(r.json.code, 'db-client.database');
  assert.match(r.json.params.error, /no such table/);
});

test('dati, export e designer con la ricostruzione della tabella', async () => {
  let r = await api('POST', '/connections/lite/databases/main/tables/clienti/rows', { page: 1, pageSize: 25, search: 'MIL' });
  assert.deepEqual([r.json.total, r.json.primaryKey], [1, ['id']]);
  r = await api('POST', '/connections/lite/databases/main/tables/clienti/row', { op: 'delete-many', keys: [{ id: 2 }, { id: 3 }] });
  r = await api('POST', '/connections/lite/databases/main/tables/clienti/row', { op: 'delete-many', keys: [{ id: 2 }, { id: 3 }], confirm: r.json.token });
  assert.equal(r.json.affectedRows, 2, r.text);
  r = await api('POST', '/connections/lite/exports', { format: 'sql', source: { type: 'table', db: 'main', table: 'clienti' } });
  const file = await srv.request('GET', `/api/ext/db-client/connections/lite/exports/${r.json.id}`);
  assert.match(file.text, /CREATE TABLE clienti/);
  assert.match(file.text, /X'deadbeef'/);
  const def = (await api('GET', '/connections/lite/databases/main/tables/ordini/definition')).json.definition;
  assert.deepEqual([def.primaryKey, def.indexes.map(i => i.name), def.foreignKeys[0].refTable], [['id'], ['ix_ordini_cliente'], 'clienti']);
  // rinomina (ALTER semplice) + tipo e NULL cambiati (ricostruzione)
  const next = { ...def, columns: def.columns.map(c => (c.name === 'totale' ? { ...c, name: 'importo', type: 'REAL', nullable: true, default: { kind: 'none' } } : c)) };
  const design = { table: 'ordini', definition: next, renames: { importo: 'totale' } };
  r = await api('POST', '/connections/lite/databases/main/migrate', { design });
  assert.equal(r.status, 428, r.text);
  assert.match(r.json.sql, /PRAGMA foreign_keys = OFF;\nBEGIN;\nCREATE TABLE "main"."_kelbo_new_ordini"/);
  assert.match(r.json.sql, /SELECT "id", "cliente", "totale" FROM "main"."ordini"/);
  r = await api('POST', '/connections/lite/databases/main/migrate', { design, confirm: r.json.token, acknowledgeWarnings: true });
  assert.equal(r.status, 200, r.text);
  const after = (await api('GET', '/connections/lite/databases/main/tables/ordini/definition')).json.definition;
  assert.deepEqual(after.columns.map(c => [c.name, c.type, c.nullable]), [['id', 'INTEGER', true], ['cliente', 'INTEGER', false], ['importo', 'REAL', true]]);
  assert.deepEqual(after.indexes.map(i => i.name), ['ix_ordini_cliente']);
  r = await run('SELECT importo FROM ordini ORDER BY id');
  assert.deepEqual(r.json.rows.map(x => x[0]), [10.5, 3]);
});

test('connessione in sola lettura: il file è aperto in sola lettura', async () => {
  let r = await api('POST', '/connections', { id: 'ro', label: 'RO', type: 'sqlite', file: path.join(project, 'data', 'app.sqlite'), readOnly: true });
  assert.equal(r.status, 200, r.text);
  r = await api('POST', '/connections/ro/query', { sql: 'SELECT count(*) FROM clienti' });
  assert.equal(r.status, 200, r.text);
  r = await api('POST', '/connections/ro/query', { sql: 'DELETE FROM clienti' });
  assert.equal(r.status, 403);
});
