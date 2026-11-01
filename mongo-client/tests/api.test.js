// API senza un server MongoDB: password solo nel vault, validazione, sola lettura, token di
// conferma legato all'operazione, strumenti MCP solo con il vault sbloccato
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { startServer, mcpClient, tmpDir } = require('kelbo/testkit');

const EXT = path.join(__dirname, '..');
let srv, mcp;
before(async () => {
  srv = await startServer({ projects: [{ id: 'shop', label: 'Shop', path: tmpDir() }] }, { install: [EXT] });
  mcp = await mcpClient(srv);
});
after(async () => { await mcp?.close(); await srv?.stop(); });

const api = (method, p, body) => srv.request(method, `${p.startsWith('/vault') ? '/api/core' : '/api/ext/mongo-client'}${p}`, { body });

test('connessioni: password cifrata nel vault, mai in chiaro né restituita', async () => {
  // senza master password la sezione non si usa: né elenco né connessioni, anche senza password
  let r = await api('GET', '/connections');
  assert.deepEqual([r.status, r.json.code], [423, 'core.vault_missing']);
  r = await api('POST', '/connections', { id: 'nopwd', label: 'Senza password', host: '127.0.0.1', port: 27017 });
  assert.deepEqual([r.status, r.json.code], [423, 'core.vault_missing']);
  r = await api('POST', '/folders', { label: 'Cartella' });
  assert.equal(r.status, 423);
  assert.equal((await api('POST', '/vault/init', { password: 'master-password-mongo' })).status, 200);
  assert.deepEqual((await api('GET', '/connections')).json.connections, []);
  r = await api('POST', '/connections', { id: 'loc', label: 'Locale', host: '127.0.0.1', port: 27017, user: 'app', password: 'segreta-mongo' });
  assert.equal(r.status, 200);
  assert.equal(r.json.hasPassword, true);
  assert.equal(r.json.password, undefined);
  const saved = srv.readConfig().mongoConnections[0];
  assert.ok(saved.password.iv && saved.password.data);
  assert.doesNotMatch(JSON.stringify(srv.readConfig()), /segreta-mongo/);
  // password invariata se non inviata, rimossa con null
  r = await api('PUT', '/connections/loc', { label: 'Locale 2', host: '127.0.0.1', port: 27018, user: 'app' });
  assert.equal(r.json.hasPassword, true);
  assert.equal(r.json.port, 27018);
  r = await api('PUT', '/connections/loc', { label: 'Locale 2', host: '127.0.0.1', port: 27018, user: 'app', password: null });
  assert.equal(r.json.hasPassword, false);
  assert.equal((await api('POST', '/connections', { id: 'loc', label: 'x', host: 'h', port: 1 })).json.code, 'mongo-client.connection_exists');
  // collegata a un progetto: elencata dal pannello 📁 Progetti del core prima di rimuoverlo
  await api('PUT', '/connections/loc', { label: 'Locale 2', host: '127.0.0.1', port: 27018, projectId: 'shop' });
  r = await srv.request('GET', '/api/core/projects/shop/links');
  assert.deepEqual(r.json.links, [{ code: 'mongo-client', key: 'links.connection', params: { name: 'Locale 2' } }]);
});

test('validazione: URI con password, host e porta, nomi di database e collezioni', async () => {
  let r = await api('POST', '/connections', { id: 'atlas', label: 'Atlas', uri: 'mongodb+srv://app:segreta@cluster0.example.invalid/' });
  assert.equal(r.status, 400);
  assert.equal(r.json.code, 'mongo-client.connection_uri_password');
  r = await api('POST', '/connections', { id: 'atlas', label: 'Atlas', uri: 'http://cluster0.example.invalid/' });
  assert.equal(r.json.code, 'mongo-client.connection_uri');
  r = await api('POST', '/connections', { id: 'atlas', label: 'Atlas', uri: 'mongodb+srv://cluster0.example.invalid/?retryWrites=true', user: 'app' });
  assert.equal(r.status, 200);
  assert.equal(r.json.host, undefined);
  r = await api('POST', '/connections', { id: 'bad', label: 'Bad', host: 'a b', port: 27017 });
  assert.equal(r.json.code, 'mongo-client.connection_host');
  r = await api('POST', '/connections', { id: 'bad', label: 'Bad', host: 'h', port: 70000 });
  assert.equal(r.json.code, 'mongo-client.connection_port');
  r = await api('POST', '/connections', { id: 'tun', label: 'Tun', tunnel: 'missing' });
  assert.equal(r.status, 400);
  assert.match(r.json.code, /^mongo-client\.tunnel/);
  r = await api('POST', '/connections/atlas/operation', { op: { op: 'dropCollection', database: 'a.b', collection: 'x' } });
  assert.equal(r.json.code, 'mongo-client.database_invalid');
  r = await api('POST', '/connections/atlas/operation', { op: { op: 'dropCollection', database: 'app', collection: 'system.users' } });
  assert.equal(r.json.code, 'mongo-client.collection_invalid');
  r = await api('POST', '/connections/nope/operation', { op: {} });
  assert.equal(r.status, 404);
});

test('modifiche: anteprima e token legato all\'operazione; sola lettura rifiuta', async () => {
  await api('POST', '/connections', { id: 'rw', label: 'RW', host: '127.0.0.1', port: 9 });
  await api('POST', '/connections', { id: 'ro', label: 'RO', host: '127.0.0.1', port: 9, readOnly: true });
  const op = { op: 'insertOne', database: 'app', collection: 'users', document: '{"name": "Ada", "at": {"$date": "2026-01-02T03:04:05Z"}}' };
  let r = await api('POST', '/connections/rw/operation', { op });
  assert.equal(r.status, 200);
  assert.equal(r.json.preview, 'db.getSiblingDB("app").getCollection("users").insertOne({\n  name: "Ada",\n  at: ISODate("2026-01-02T03:04:05.000Z")\n})');
  assert.match(r.json.token, /^[0-9a-f]{64}$/);
  const { token } = r.json;
  // stesso token su un'altra operazione o un'altra connessione: rifiutato senza toccare il database
  r = await api('POST', '/connections/rw/operation', { op: { ...op, document: '{"name": "Eve"}' }, token });
  assert.equal(r.status, 409);
  assert.equal(r.json.code, 'mongo-client.confirmation_mismatch');
  r = await api('POST', '/connections/ro/operation', { op, token });
  assert.equal(r.status, 403);
  assert.equal(r.json.code, 'mongo-client.read_only');
  // eliminazione per _id, anche di tipi diversi
  r = await api('POST', '/connections/rw/operation', { op: { op: 'deleteMany', database: 'app', collection: 'users', ids: '[{"$oid": "65a1b2c3d4e5f60718293a4b"}, 7]' } });
  assert.equal(r.json.count, 2);
  assert.equal(r.json.dangerous, true);
  assert.match(r.json.preview, /deleteMany\(\{ _id: \{ \$in: \[ ObjectId\("65a1b2c3d4e5f60718293a4b"\), 7 \] \} \}\)/);
  // _id non modificabile, JSON non valido, operazione sconosciuta
  r = await api('POST', '/connections/rw/operation', { op: { op: 'replaceOne', database: 'app', collection: 'users', id: '1', document: '{"_id": 2}' } });
  assert.equal(r.json.code, 'mongo-client.id_changed');
  r = await api('POST', '/connections/rw/operation', { op: { op: 'insertOne', database: 'app', collection: 'users', document: '{bad' } });
  assert.equal(r.json.code, 'mongo-client.json_invalid');
  r = await api('POST', '/connections/rw/operation', { op: { op: 'updateMany', database: 'app', collection: 'users' } });
  assert.equal(r.json.code, 'mongo-client.operation_invalid');
});

test('MCP: niente con il vault bloccato, nessuna credenziale', async () => {
  const call = (name, args = {}) => mcp.callTool({ name, arguments: args });
  let r = await call('mongo_client_connections');
  assert.equal(r.structuredContent.connections.find(c => c.id === 'atlas').host, 'cluster0.example.invalid');
  assert.doesNotMatch(r.content[0].text, /password|"user"/);
  assert.equal((await api('POST', '/vault/lock', {})).status, 200);
  r = await call('mongo_client_connections');
  assert.equal(r.structuredContent.code, 'mongo-client.mcp_vault_locked');
  r = await call('mongo_client_find', { connection: 'rw', database: 'app', collection: 'users' });
  assert.equal(r.structuredContent.code, 'mongo-client.mcp_vault_locked');
  // anche l'interfaccia: tutto richiede di nuovo la master password
  r = await api('GET', '/connections');
  assert.deepEqual([r.status, r.json.code], [423, 'core.vault_locked']);
  assert.equal((await api('POST', '/vault/unlock', { password: 'master-password-mongo' })).status, 200);
});

test('cartelle: create, connessione spostata dentro, eliminazione che la riporta nella radice', async () => {
  let r = await api('POST', '/folders', { label: 'Clienti' });
  assert.equal(r.status, 200);
  const folder = r.json.id;
  assert.equal((await api('POST', '/folders', { label: '' })).json.code, 'mongo-client.folder_label_required');
  r = await api('POST', '/connections', { id: 'cli', label: 'Cliente', host: '127.0.0.1', port: 27017, folder });
  assert.equal(r.json.folder, folder);
  assert.equal((await api('POST', '/connections', { id: 'cli2', label: 'X', host: 'h', port: 1, folder: 'nope' })).json.code, 'mongo-client.folder_unknown');
  assert.equal((await api('PUT', `/folders/${folder}`, { label: 'Clienti 2' })).json.label, 'Clienti 2');
  r = await api('GET', '/connections');
  assert.deepEqual(r.json.folders, [{ id: folder, label: 'Clienti 2' }]);
  await api('DELETE', `/folders/${folder}`);
  r = await api('GET', '/connections');
  assert.deepEqual(r.json.folders, []);
  assert.equal(r.json.connections.find(c => c.id === 'cli').folder, undefined);
});

test('editor: sintassi, sola lettura e token controllati prima di collegarsi', async () => {
  // il server sulla porta 9 non esiste: queste risposte arrivano senza tentare la connessione
  let r = await api('POST', '/connections/rw/shell', { code: 'db.users.find({ a: })', database: 'app' });
  assert.equal(r.status, 400);
  assert.equal(r.json.code, 'mongo-client.shell_syntax');
  assert.equal(r.json.params.line, 1);
  r = await api('POST', '/connections/rw/shell', { code: 'db.users.find()' });
  assert.equal(r.json.code, 'mongo-client.shell_no_database');
  r = await api('POST', '/connections/rw/shell', { code: 'use other' });
  assert.deepEqual([r.json.kind, r.json.database], ['use', 'other']);
  r = await api('POST', '/connections/ro/shell', { code: 'db.users.deleteMany({})', database: 'app' });
  assert.equal(r.status, 403);
  assert.equal(r.json.code, 'mongo-client.read_only');
  r = await api('POST', '/connections/rw/shell', { code: 'db.users.deleteMany({})', database: 'app', token: 'f'.repeat(64) });
  assert.equal(r.status, 409);
  assert.equal(r.json.code, 'mongo-client.confirmation_mismatch');
  r = await api('POST', '/connections/rw/shell', { code: 'db["system.users"].find()', database: 'app' });
  assert.equal(r.json.code, 'mongo-client.collection_invalid');
  r = await api('POST', '/connections/rw/export', { code: 'db.users.insertOne({})', database: 'app', format: 'json' });
  assert.equal(r.json.code, 'mongo-client.export_not_cursor');
  r = await api('POST', '/connections/rw/export', { database: 'app', collection: 'users', format: 'xml' });
  assert.equal(r.json.code, 'mongo-client.export_format');
});

test('operazioni dei dialoghi: anteprime di celle modificate, collezione, indice, rinomina', async () => {
  const preview = async op => (await api('POST', '/connections/rw/operation', { op })).json;
  let r = await preview({ op: 'updateFields', database: 'app', collection: 'users', updates: JSON.stringify([{ id: { $oid: '65a1b2c3d4e5f60718293a4b' }, set: { name: 'Ada', 'address.city': 'Roma' } }, { id: 7, set: { n: { $numberLong: '9007199254740993' } } }]) });
  assert.equal(r.count, 2);
  assert.match(r.preview, /bulkWrite\(\[\n {2}\{ updateOne: \{ filter: \{ _id: ObjectId\("65a1b2c3d4e5f60718293a4b"\) \}/);
  assert.match(r.preview, /n: NumberLong\("9007199254740993"\)/);
  r = await preview({ op: 'updateFields', database: 'app', collection: 'users', updates: JSON.stringify([{ id: 1, set: { _id: 2 } }]) });
  assert.equal(r.code, 'mongo-client.field_invalid');
  r = await preview({ op: 'updateFields', database: 'app', collection: 'users', updates: JSON.stringify([{ id: 1, set: { $where: 1 } }]) });
  assert.equal(r.code, 'mongo-client.field_invalid');
  r = await preview({ op: 'createCollection', database: 'newdb', collection: 'events', options: JSON.stringify({ capped: true, size: 4096, validator: { $jsonSchema: { required: ['at'] } }, validationAction: 'warn' }) });
  assert.match(r.preview, /^db\.getSiblingDB\("newdb"\)\.createCollection\("events", \{/);
  assert.equal((await preview({ op: 'createCollection', database: 'a', collection: 'b', options: '{"capped": true}' })).code, 'mongo-client.capped_size');
  assert.equal((await preview({ op: 'createCollection', database: 'a', collection: 'b', options: '{"viewOn": "x"}' })).code, 'mongo-client.option_invalid');
  r = await preview({ op: 'createIndex', database: 'app', collection: 'users', keys: '{"email": 1, "at": -1}', options: '{"unique": true, "name": "email_at"}' });
  assert.match(r.preview, /createIndex\(\{\n {2}email: 1,\n {2}at: -1\n\}, \{/);
  assert.equal((await preview({ op: 'createIndex', database: 'app', collection: 'users', keys: '{"email": 2}' })).code, 'mongo-client.index_keys');
  assert.equal((await preview({ op: 'dropIndex', database: 'app', collection: 'users', name: '_id_' })).code, 'mongo-client.index_id');
  r = await preview({ op: 'renameCollection', database: 'app', collection: 'users', to: 'people' });
  assert.equal(r.dangerous, true);
  assert.match(r.preview, /\.renameCollection\("people"\)$/);
});

test('import: connessioni di un altro Kelbo con un\'altra master password, ri-cifrate', async () => {
  // file esportato da un'altra istanza con la sua master password
  const other = await startServer({ projects: [] }, { install: [EXT] });
  try {
    await other.request('POST', '/api/core/vault/init', { body: { password: 'altra-master-password' } });
    await other.request('POST', '/api/ext/mongo-client/folders', { body: { label: 'Remoti' } });
    const folder = other.readConfig().mongoFolders[0].id;
    await other.request('POST', '/api/ext/mongo-client/connections', { body: { id: 'remoto', label: 'Remoto', host: 'mongo.example.invalid', port: 27017, user: 'app', password: 'segreta-remota', folder } });
    const file = other.readConfig();
    let r = await api('POST', '/connections/import', { config: file, password: 'sbagliata', mode: 'merge' });
    assert.equal(r.status, 401);
    assert.equal(r.json.code, 'mongo-client.wrong_file_password');
    r = await api('POST', '/connections/import', { config: file, password: 'altra-master-password', mode: 'merge' });
    assert.deepEqual([r.status, r.json.imported, r.json.skipped], [200, 1, 0]);
    const cfg = srv.readConfig();
    const imported = cfg.mongoConnections.find(c => c.id === 'remoto');
    assert.equal(imported.folder, folder);
    assert.notDeepEqual(imported.password, file.mongoConnections[0].password); // ri-cifrata con la chiave di qui
    assert.doesNotMatch(JSON.stringify(cfg), /segreta-remota/);
    r = await api('POST', '/connections/import', { config: file, password: 'altra-master-password', mode: 'merge' });
    assert.deepEqual([r.json.imported, r.json.skipped], [0, 1]);
  } finally { await other.stop(); }
});
