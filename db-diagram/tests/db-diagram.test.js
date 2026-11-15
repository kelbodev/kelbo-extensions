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
  assert.deepEqual([...m.neighbours(SCHEMA, 'customers')].sort(), ['countries', 'customers', 'orders']);
  // la vista senza relazioni sta fuori dal riquadro delle tabelle collegate
  const linked = ['customers', 'countries', 'orders'];
  const box = { x1: Math.min(...linked.map(n => pos[n].x)), y1: Math.min(...linked.map(n => pos[n].y)), x2: Math.max(...linked.map(n => pos[n].x + sizes[n].w)), y2: Math.max(...linked.map(n => pos[n].y + sizes[n].h)) };
  const v = pos.v_totals, vs = sizes.v_totals;
  assert.ok(v.x + vs.w <= box.x1 || v.x >= box.x2 || v.y + vs.h <= box.y1 || v.y >= box.y2, JSON.stringify({ v, box }));
});

// tabelle con relazioni ad albero (un gruppo) più alcune isolate
const T = (name, refs = [], cols = 3) => ({ name, view: false, columns: Array.from({ length: cols }, (_, i) => ({ name: i ? `c${i}` : 'id', type: 'INTEGER', nullable: false })), primaryKey: ['id'], indexes: [], foreignKeys: refs.map(r => ({ name: `fk_${name}_${r}`, columns: ['c1'], refTable: r, refColumns: ['id'] })) });
const TREE = { tables: [T('orders', ['customers']), T('customers', ['countries']), T('countries'), T('order_items', ['orders', 'products'], 5), T('products', ['categories'], 6), T('categories'),
  T('payments', ['orders']), T('shipments', ['orders']), T('addresses', ['customers']), T('reviews', ['products']), T('audit'), T('settings'), T('log', [], 8)] };

test('layout: gruppi senza sovrapposizioni, nessun incrocio su uno schema ad albero, isolate sui bordi', () => {
  const sizes = Object.fromEntries(TREE.tables.map(t => [t.name, m.tableSize(t, 'all')]));
  const pos = m.autoLayout(TREE.tables, sizes);
  const names = TREE.tables.map(t => t.name);
  for (let i = 0; i < names.length; i++) for (let j = i + 1; j < names.length; j++) {
    const a = names[i], b = names[j];
    const sep = pos[a].x + sizes[a].w <= pos[b].x || pos[b].x + sizes[b].w <= pos[a].x || pos[a].y + sizes[a].h <= pos[b].y || pos[b].y + sizes[b].h <= pos[a].y;
    assert.ok(sep, `${a} e ${b} si sovrappongono`);
  }
  const c = n => ({ x: pos[n].x + sizes[n].w / 2, y: pos[n].y + sizes[n].h / 2 });
  const edges = TREE.tables.flatMap(t => t.foreignKeys.map(f => [t.name, f.refTable]));
  let crossings = 0;
  for (let i = 0; i < edges.length; i++) for (let j = i + 1; j < edges.length; j++) {
    const [a, b] = edges[i], [e, f] = edges[j];
    if (new Set([a, b, e, f]).size === 4 && m.segmentsCross(c(a), c(b), c(e), c(f))) crossings++;
  }
  assert.equal(crossings, 0);
  // la tabella con più relazioni (orders) più vicina al centro del gruppo delle altre
  const group = names.filter(n => !['audit', 'settings', 'log'].includes(n));
  const mid = { x: group.reduce((a, n) => a + c(n).x, 0) / group.length, y: group.reduce((a, n) => a + c(n).y, 0) / group.length };
  const dist = n => Math.hypot(c(n).x - mid.x, c(n).y - mid.y);
  assert.ok(dist('orders') <= Math.min(...group.filter(n => n !== 'orders').map(dist)) + 1e-6 || dist('orders') < 200, `orders a ${dist('orders')}`);
  const box = { x1: Math.min(...group.map(n => pos[n].x)), y1: Math.min(...group.map(n => pos[n].y)), x2: Math.max(...group.map(n => pos[n].x + sizes[n].w)), y2: Math.max(...group.map(n => pos[n].y + sizes[n].h)) };
  for (const n of ['audit', 'settings', 'log']) {
    const p = pos[n], sz = sizes[n];
    assert.ok(p.x + sz.w <= box.x1 || p.x >= box.x2 || p.y + sz.h <= box.y1 || p.y >= box.y2, `${n} dentro il gruppo`);
  }
  assert.ok(m.segmentsCross({ x: 0, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }, { x: 10, y: 0 }));
  assert.ok(!m.segmentsCross({ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 0, y: 5 }, { x: 10, y: 5 }));
  assert.ok(m.segmentHitsBox({ x: 0, y: 5 }, { x: 20, y: 5 }, 8, 0, 12, 10));
  assert.ok(!m.segmentHitsBox({ x: 0, y: 20 }, { x: 20, y: 20 }, 8, 0, 12, 10));
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
  // legenda nell'export: sotto le tabelle, con linea continua e tratteggiata
  const labels = { title: 'Legenda', required: 'obbligatoria', optional: 'facoltativa', many: 'molti', one: 'uno', pk: 'primaria', fk: 'esterna', view: 'vista' };
  const withLegend = m.buildDrawing(SCHEMA, { positions, legend: labels });
  assert.ok(withLegend.height > d.height);
  const legendTexts = withLegend.items.filter(i => i.k === 'text').map(i => i.text);
  for (const v of Object.values(labels)) assert.ok(legendTexts.includes(v), v);
  assert.equal(withLegend.items.filter(i => i.k === 'line' && i.dash).length, 1, 'il campione tratteggiato');
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

test('export in più pagine: pagina unica, un gruppo per pagina, porzioni; PDF multipagina e ZIP', () => {
  const sizes = Object.fromEntries(TREE.tables.map(t => [t.name, m.tableSize(t, 'all')]));
  const positions = m.autoLayout(TREE.tables, sizes);
  const labels = { title: 'ER', subtitle: 'shop', overview: 'Panoramica', isolated: 'Isolate', group: (i, n) => `Gruppo ${i} (${n.length})`, tile: c => `Porzione ${c}`, page: (i, n) => `${i}/${n}`, pageShort: i => `p. ${i}` };
  const legend = { title: 'Legenda', required: 'r', optional: 'o', many: 'm', one: 'u', pk: 'pk', fk: 'fk', view: 'v' };
  const single = m.planExport(TREE, { positions, legend, labels, split: 'single' });
  assert.equal(single.length, 1);
  const groups = m.planExport(TREE, { positions, legend, labels, split: 'groups', paper: 'a3' });
  assert.deepEqual(groups.map(p => p.subtitle.split(' · ')[0]), ['Panoramica', 'Gruppo 1 (10)', 'Isolate']);
  assert.deepEqual(groups.map(p => p.footer), ['1/3', '2/3', '3/3']);
  assert.ok(groups[0].extra.some(i => i.k === 'text' && i.text === 'p. 2'), 'la panoramica indica la pagina del gruppo');
  // ogni pagina di gruppo contiene tutte le tabelle del gruppo, intere
  const g1 = groups[1];
  assert.ok(Object.values(g1.drawing.boxes).every(b => b.x >= g1.view.x && b.x + b.w <= g1.view.x + g1.view.w && b.y + b.h <= g1.view.y + g1.view.h));
  assert.deepEqual(Object.keys(groups[2].drawing.boxes).sort(), ['audit', 'log', 'settings']);
  // porzioni piccole (scala 125% su A4 verticale): griglia con codici, panoramica per prima
  const tiles = m.planExport(TREE, { positions, legend, labels, split: 'tiles', paper: 'a4', orientation: 'portrait', zoom: 1.25 });
  assert.ok(tiles.length > 3, `${tiles.length} pagine`);
  assert.equal(tiles[0].subtitle.split(' · ')[0], 'Panoramica');
  assert.match(tiles[1].subtitle, /^Porzione A1/);
  assert.ok(tiles.every(p => Math.round(p.W) === 595 && Math.round(p.H) === 842));
  // PDF multipagina valido
  const pdf = m.pagesToPdf(tiles, { title: 'ER' });
  assert.match(pdf, new RegExp(`/Count ${tiles.length} >>`));
  assert.equal((pdf.match(/\/Type \/Page /g) || []).length, tiles.length);
  const startxref = Number(/startxref\n(\d+)\n/.exec(pdf)[1]);
  const offsets = [...pdf.slice(startxref).matchAll(/^(\d{10}) 00000 n $/gm)].map(x => Number(x[1]));
  offsets.forEach((o, i) => assert.equal(pdf.slice(o, o + `${i + 1} 0 obj`.length), `${i + 1} 0 obj`));
  assert.ok(/^[\x0a\x20-\x7e]*$/.test(pdf));
  assert.match(m.pageSvg(tiles[1]), /<svg x="[\d.]+" y="[\d.]+" width="[\d.]+" height="[\d.]+" viewBox=/);
  // ZIP: CRC32 e struttura che unzip accetta
  assert.equal(m.crc32(new TextEncoder().encode('123456789')).toString(16), 'cbf43926');
  const zip = m.makeZip([{ name: 'a.png', data: new Uint8Array([1, 2, 3]) }, { name: 'b.png', data: new TextEncoder().encode('ciao') }]);
  const file = path.join(dir, 'parts.zip');
  fs.writeFileSync(file, zip);
  const { execFileSync } = require('child_process');
  let listing = null;
  try { listing = execFileSync('unzip', ['-l', file]).toString(); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  if (listing) assert.match(listing, /a\.png[\s\S]*b\.png/);
  assert.equal(Buffer.from(zip.slice(0, 4)).toString('hex'), '504b0304');
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
