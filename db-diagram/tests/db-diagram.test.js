// Diagramma ER (add-on del db-client): metriche di Helvetica, layout con le tabelle referenziate a
// sinistra, disegno con relazioni e chiavi, SVG, PDF valido (oggetti, xref, testi WinAnsi),
// add-on accettato dal db-client, schema di un database SQLite vero, posizioni salvate e validate
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { startServer, tmpDir, i18nProblems } = require('kelbo/testkit');

const EXT = path.join(__dirname, '..');
let m; // modulo del frontend (ESM)
let srv, dir;
const api = (method, p, body) => srv.request(method, p, body !== undefined ? { body } : {});

const SCHEMA = { tables: [
  { name: 'customers', view: false, columns: [{ name: 'id', type: 'INTEGER', nullable: false }, { name: 'email', type: 'TEXT', nullable: false }, { name: 'country', type: 'TEXT', nullable: true }], primaryKey: ['id'], indexes: [], foreignKeys: [{ name: 'fk_c', columns: ['country'], refTable: 'countries', refColumns: ['code'] }] },
  { name: 'countries', view: false, columns: [{ name: 'code', type: 'TEXT', nullable: false }], primaryKey: ['code'], indexes: [], foreignKeys: [] },
  { name: 'orders', view: false, columns: [{ name: 'id', type: 'INTEGER', nullable: false }, { name: 'customer_id', type: 'INTEGER', nullable: false }, { name: 'parent_id', type: 'INTEGER', nullable: true }], primaryKey: ['id'], indexes: [],
    foreignKeys: [{ name: 'fk_o', columns: ['customer_id'], refTable: 'customers', refColumns: ['id'] }, { name: 'fk_p', columns: ['parent_id'], refTable: 'orders', refColumns: ['id'] }] },
  { name: 'v_totals', view: true, columns: [{ name: 'email', type: 'TEXT', nullable: true }], primaryKey: [], indexes: [], foreignKeys: [] },
] };

before(async () => {
  m = await import(path.join(EXT, 'addon.js'));
  dir = tmpDir('kelbo-erd-');
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(path.join(dir, 'shop.sqlite'));
  db.exec(`CREATE TABLE countries (code TEXT PRIMARY KEY, name TEXT NOT NULL);
    CREATE TABLE customers (id INTEGER PRIMARY KEY, email TEXT NOT NULL, country TEXT REFERENCES countries(code));
    CREATE TABLE orders (id INTEGER PRIMARY KEY, customer_id INTEGER NOT NULL REFERENCES customers(id), total NUMERIC(10,2));
    CREATE VIEW v_orders AS SELECT o.id, c.email FROM orders o JOIN customers c ON c.id = o.customer_id;`);
  db.close();
  srv = await startServer({ projects: [] }, { install: [path.join(EXT, '..', 'db-sqlite'), EXT] });
  await api('POST', '/api/core/vault/init', { password: 'master-password-er' });
  const r = await api('POST', '/api/ext/db-client/connections', { id: 'shop', label: 'Shop', type: 'sqlite', file: path.join(dir, 'shop.sqlite') });
  assert.equal(r.status, 200, r.text);
});
after(() => srv?.stop());

test('traduzioni', () => assert.deepEqual(i18nProblems(EXT), []));

test('metriche, accorciamento, layout: le tabelle referenziate a sinistra', () => {
  assert.equal(m.textWidth('Hello', 10), (722 + 556 + 222 + 222 + 556) / 100);
  assert.ok(m.textWidth('W', 10, true) > m.textWidth('i', 10, true));
  const f = m.fit('una_colonna_con_un_nome_molto_lungo', 10, 60);
  assert.ok(f.endsWith('…') && m.textWidth(f, 10) <= 60);
  const sizes = Object.fromEntries(SCHEMA.tables.map(t => [t.name, m.tableSize(t, 'all')]));
  assert.equal(sizes.customers.h, m.G.head + 3 * m.G.row + 6);
  assert.equal(m.tableSize(SCHEMA.tables[0], 'keys').h, m.G.head + 2 * m.G.row + 6, 'solo id e country');
  assert.equal(m.tableSize(SCHEMA.tables[0], 'none').h, m.G.head);
  const pos = m.autoLayout(SCHEMA.tables, sizes);
  assert.ok(pos.countries.x < pos.customers.x && pos.customers.x < pos.orders.x, JSON.stringify(pos));
  assert.deepEqual([...m.neighbours(SCHEMA, 'customers')].sort(), ['countries', 'customers', 'orders']);
});

test('disegno: tabelle, chiavi, relazioni (anche sulla stessa tabella), visibili, SVG', () => {
  const sizes = Object.fromEntries(SCHEMA.tables.map(t => [t.name, m.tableSize(t, 'all')]));
  const positions = m.autoLayout(SCHEMA.tables, sizes);
  const d = m.buildDrawing(SCHEMA, { positions });
  const curves = d.items.filter(i => i.k === 'curve');
  assert.equal(curves.length, 3);
  assert.equal(curves.filter(c => c.dash).length, 2, 'country e parent_id possono essere NULL');
  const texts = d.items.filter(i => i.k === 'text').map(i => i.text);
  for (const s of ['customers', 'PK', 'FK', 'VIEW', 'customer_id', 'INTEGER']) assert.ok(texts.includes(s), s);
  const part = m.buildDrawing(SCHEMA, { positions, visible: new Set(['customers', 'orders']) });
  assert.equal(part.items.filter(i => i.k === 'curve').length, 2, 'solo le relazioni tra tabelle mostrate');
  const svg = m.toSvg(d, { background: '#fff' });
  assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" width="[\d.]+" height="[\d.]+"/);
  assert.match(m.toSvg(d, { interactive: true }), /<g class="erd-table" data-table="orders">/);
  assert.ok(!m.toSvg(m.buildDrawing({ tables: [{ ...SCHEMA.tables[1], name: 'a<b>&"' }] }, { positions: {} })).includes('a<b>'), 'testo escapato');
});

test('PDF: oggetti, xref con gli offset giusti, testi WinAnsi', () => {
  assert.equal(m.pdfString('a(b)c\\'), '(a\\(b\\)c\\\\)');
  assert.equal(m.pdfString('è€✓'), '(\\350\\200?)');
  const sizes = Object.fromEntries(SCHEMA.tables.map(t => [t.name, m.tableSize(t, 'all')]));
  const d = m.buildDrawing(SCHEMA, { positions: m.autoLayout(SCHEMA.tables, sizes) });
  const pdf = m.toPdf(d, { title: 'Diagramma · città', subtitle: 'prova' });
  assert.match(pdf, /^%PDF-1\.4\n/);
  assert.ok(pdf.endsWith('%%EOF\n'));
  assert.ok(/^[\x0a\x20-\x7e]*$/.test(pdf), 'solo ASCII');
  const startxref = Number(/startxref\n(\d+)\n/.exec(pdf)[1]);
  assert.equal(pdf.slice(startxref, startxref + 4), 'xref');
  const offsets = [...pdf.slice(startxref).matchAll(/^(\d{10}) 00000 n $/gm)].map(x => Number(x[1]));
  assert.equal(offsets.length, 7);
  offsets.forEach((o, i) => assert.equal(pdf.slice(o, o + `${i + 1} 0 obj`.length), `${i + 1} 0 obj`, `oggetto ${i + 1}`));
  const len = Number(/\/Length (\d+) >>\nstream\n/.exec(pdf)[1]);
  const start = pdf.indexOf('stream\n') + 7;
  assert.equal(pdf.slice(start + len, start + len + 10), '\nendstream');
  assert.match(pdf, /\(Diagramma \\267 citt\\340\) Tj/);
  assert.match(pdf, /\/BaseFont \/Helvetica-Bold/);
});

test('add-on del db-client: stato, file serviti, schema di SQLite', async () => {
  const exts = (await api('GET', '/api/core/extensions')).json;
  const e = exts.find(x => x.code === 'db-diagram');
  assert.deepEqual([e.state, e.kinds, e.addon.host], ['ok', ['addon'], 'db-client']);
  assert.equal((await api('GET', '/ext/db-diagram/addon.js')).status, 200);
  assert.equal((await api('GET', '/ext/db-diagram/server.js')).status, 404);
  const r = await api('GET', '/api/ext/db-client/connections/shop/databases/main/schema');
  assert.equal(r.status, 200, r.text);
  const by = Object.fromEntries(r.json.tables.map(t => [t.name, t]));
  assert.deepEqual(by.orders.foreignKeys.map(f => [f.columns, f.refTable, f.refColumns]), [[['customer_id'], 'customers', ['id']]]);
  assert.deepEqual(by.countries.primaryKey, ['code']);
  assert.equal(by.v_orders.view, true);
  // il disegno dello schema vero
  const sizes = Object.fromEntries(r.json.tables.map(t => [t.name, m.tableSize(t, 'all')]));
  const d = m.buildDrawing(r.json, { positions: m.autoLayout(r.json.tables, sizes) });
  assert.equal(d.items.filter(i => i.k === 'curve').length, 2);
});

test('posizioni: salvate per connessione e database, validate, esportabili', async () => {
  const q = '/api/ext/db-diagram/layout?connection=shop&database=main';
  assert.deepEqual((await api('GET', q)).json, { positions: {} });
  let r = await api('PUT', '/api/ext/db-diagram/layout', { connection: 'shop', database: 'main', positions: { orders: { x: 10.4, y: 20.6 } } });
  assert.equal(r.status, 200, r.text);
  assert.deepEqual((await api('GET', q)).json.positions, { orders: { x: 10, y: 21 } });
  assert.deepEqual(Object.keys(srv.readConfig().dbDiagrams), ['shop/main']);
  for (const body of [{ connection: '../x', database: 'main', positions: {} }, { connection: 'shop', database: 'main', positions: { a: { x: 'z', y: 1 } } }, { connection: 'shop', database: '', positions: {} }]) {
    assert.equal((await api('PUT', '/api/ext/db-diagram/layout', body)).status, 400, JSON.stringify(body));
  }
  const exp = await api('GET', '/api/core/config/export?sections=dbDiagrams');
  assert.equal(exp.status, 200, exp.text);
  assert.deepEqual(Object.keys(exp.json.dbDiagrams), ['shop/main']);
  assert.ok((await api('GET', '/api/core/extensions')).json.find(x => x.code === 'db-diagram').export.some(x => x.sections.includes('dbDiagrams')));
  r = await api('POST', '/api/ext/db-diagram/layout/reset', { connection: 'shop', database: 'main' });
  assert.deepEqual((await api('GET', q)).json, { positions: {} });
});
