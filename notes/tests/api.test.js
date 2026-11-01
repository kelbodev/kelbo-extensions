// API: tutto dietro la master password, contenuto mai in chiaro in config.json, liste e voci,
// note con il controllo delle modifiche concorrenti, cambio e reset della master password
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { startServer, tmpDir } = require('kelbo/testkit');

const EXT = path.join(__dirname, '..');
let srv;
before(async () => {
  srv = await startServer({ projects: [{ id: 'shop', label: 'Shop', path: tmpDir() }] }, { install: [EXT] });
});
after(() => srv?.stop());

const api = (method, p, body) => srv.request(method, `${p.startsWith('/vault') ? '/api/core' : '/api/ext/notes'}${p}`, { body });
const G = '/boards/%40general';

test('senza vault sbloccato non si legge né si scrive', async () => {
  let r = await api('GET', '/boards');
  assert.deepEqual([r.status, r.json.code], [423, 'core.vault_missing']);
  r = await api('POST', `${G}/lists`, { title: 'Spesa' });
  assert.equal(r.status, 423);
  assert.equal((await api('POST', '/vault/init', { password: 'master-password-notes' })).status, 200);
  assert.deepEqual((await api('GET', '/boards')).json.boards, []);
});

test('liste e voci: aggiunta, spunta, testo, ordine, completate tolte; contenuto cifrato', async () => {
  let r = await api('POST', '/boards/shop/lists', { title: 'Rilascio 2.0' });
  assert.equal(r.status, 200);
  const list = r.json.lists[0].id;
  for (const text of ['scrivere il changelog segreto', 'taggare', 'pubblicare']) r = await api('POST', `/boards/shop/lists/${list}/items`, { text });
  const [a, b, c] = r.json.lists[0].items.map(i => i.id);
  assert.deepEqual(r.json.counts, { open: 3, items: 3, lists: 1, notes: 0 });
  assert.doesNotMatch(JSON.stringify(srv.readConfig()), /changelog segreto|Rilascio/);
  assert.ok(srv.readConfig().notesBoards[0].box.data);

  r = await api('PUT', `/boards/shop/lists/${list}/items/${b}`, { done: true });
  const done = r.json.lists[0].items.find(i => i.id === b);
  assert.equal(done.done, true);
  assert.ok(done.doneAt);
  assert.equal(r.json.counts.open, 2);
  r = await api('PUT', `/boards/shop/lists/${list}/items/${a}`, { text: '  scrivere il changelog  ' });
  assert.equal(r.json.lists[0].items[0].text, 'scrivere il changelog');
  r = await api('PUT', `/boards/shop/lists/${list}/items/order`, { ids: [c, a, b] });
  assert.deepEqual(r.json.lists[0].items.map(i => i.id), [c, a, b]);
  assert.equal((await api('PUT', `/boards/shop/lists/${list}/items/order`, { ids: [c, a] })).json.code, 'notes.order_invalid');
  r = await api('POST', `/boards/shop/lists/${list}/clear-done`, {});
  assert.deepEqual(r.json.lists[0].items.map(i => i.id), [c, a]);

  // errori chiari
  assert.equal((await api('POST', `/boards/shop/lists/${list}/items`, { text: '  ' })).json.code, 'notes.item_required');
  assert.equal((await api('POST', `/boards/shop/lists/${list}/items`, { text: 'x'.repeat(1001) })).json.code, 'notes.item_too_long');
  assert.equal((await api('PUT', `/boards/shop/lists/nope`, { title: 'X' })).status, 404);
  assert.equal((await api('POST', '/boards/sconosciuto/lists', { title: 'X' })).json.code, 'notes.project_not_found');
  assert.equal((await api('GET', '/boards/..%2Fx')).status, 400);

  r = await api('GET', '/boards');
  assert.deepEqual(r.json.boards, [{ board: 'shop', counts: { open: 2, items: 2, lists: 1, notes: 0 } }]);
  // pannello 📁 Progetti del core: la bacheca è segnalata prima di rimuovere il progetto
  r = await srv.request('GET', '/api/core/projects/shop/links');
  assert.deepEqual(r.json.links, [{ code: 'notes', key: 'links.board', params: {} }]);
});

test('note: colore, salvataggio, modifica concorrente rifiutata; bacheca vuota tolta', async () => {
  let r = await api('POST', `${G}/notes`, { text: '', x: 40, y: 60 });
  const note = r.json.notes[0];
  assert.equal(note.color, 'yellow');
  r = await api('PUT', `${G}/notes/${note.id}`, { text: 'password del wifi: no, quella va altrove', color: 'blue', updatedAt: note.updatedAt });
  assert.equal(r.status, 200);
  const saved = r.json.notes[0];
  assert.equal(saved.color, 'blue');
  // un'altra scheda con la versione vecchia non sovrascrive
  r = await api('PUT', `${G}/notes/${note.id}`, { text: 'vecchia', updatedAt: note.updatedAt });
  assert.deepEqual([r.status, r.json.code], [409, 'notes.note_changed']);
  assert.equal((await api('PUT', `${G}/notes/${note.id}`, { color: 'rosso' })).json.code, 'notes.color_invalid');
  // titolo facoltativo, ripulito dagli spazi
  assert.equal(note.title, '');
  r = await api('PUT', `${G}/notes/${note.id}`, { title: '  Wi-fi  ' });
  assert.equal(r.json.notes[0].title, 'Wi-fi');
  assert.equal((await api('PUT', `${G}/notes/${note.id}`, { title: 'x'.repeat(201) })).json.code, 'notes.title_too_long');
  assert.equal((await api('PUT', `${G}/notes/${note.id}`, { title: 5 })).json.code, 'notes.title_invalid');
  // posizione libera e dimensioni sulla bacheca; la scheda spostata va sopra le altre
  assert.deepEqual([note.x, note.y, note.w, note.h], [40, 60, 240, 180]);
  r = await api('POST', `${G}/lists`, { title: 'Sopra', x: 100, y: 100 });
  const listId = r.json.lists[0].id;
  assert.ok(r.json.lists[0].z > r.json.notes[0].z);
  r = await api('PUT', `${G}/cards/note/${note.id}`, { x: 500, y: 320, w: 400, h: 300 });
  assert.deepEqual([r.json.notes[0].x, r.json.notes[0].y, r.json.notes[0].w, r.json.notes[0].h], [500, 320, 400, 300]);
  assert.ok(r.json.notes[0].z > r.json.lists[0].z);
  r = await api('PUT', `${G}/cards/list/${listId}`, { w: 360 });
  assert.equal(r.json.lists[0].w, 360);
  for (const [kind, body] of [['note', { w: 100 }], ['note', { h: 5000 }], ['note', { x: -1 }], ['note', { y: 1.5 }], ['list', { h: 300 }]]) {
    assert.equal((await api('PUT', `${G}/cards/${kind}/${kind === 'note' ? note.id : listId}`, body)).json.code, 'notes.size_invalid');
  }
  assert.equal((await api('PUT', `${G}/cards/box/${note.id}`, { x: 1 })).json.code, 'notes.card_not_found');
  await api('DELETE', `${G}/lists/${listId}`);
  assert.doesNotMatch(JSON.stringify(srv.readConfig()), /wifi/);

  r = await api('DELETE', `${G}/notes/${note.id}`);
  assert.deepEqual(r.json.notes, []);
  assert.ok(!srv.readConfig().notesBoards.some(b => b.board === '@general'));
});

test('cambio della master password: contenuto ri-cifrato e ancora leggibile; reset: perso', async () => {
  const before = srv.readConfig().notesBoards[0].box.data;
  let r = await api('POST', '/vault/change', { oldPassword: 'master-password-notes', newPassword: 'nuova-master-password' });
  assert.equal(r.status, 200);
  assert.notEqual(srv.readConfig().notesBoards[0].box.data, before);
  r = await api('GET', '/boards/shop');
  assert.equal(r.json.lists[0].title, 'Rilascio 2.0');

  await api('POST', '/vault/lock', {});
  assert.equal((await api('GET', '/boards/shop')).status, 423);
  assert.equal((await api('POST', '/vault/reset', { confirm: 'RESET' })).status, 200);
  assert.deepEqual(srv.readConfig().notesBoards, []);
});

test('bacheche della 1.x: liste e note ricevono una posizione, le note larghe in colonne diventano px', () => {
  // backend con un vault finto che restituisce una bacheca salvata dalla 1.1 (senza posizioni)
  const legacy = { lists: [{ id: 'l1', title: 'A', items: [] }], notes: [{ id: 'n1', text: 'x', color: 'blue', w: 2, h: 200 }, { id: 'n2', text: 'y' }] };
  const ctx = {
    lib: { validate: { KEY_RE: /^[A-Za-z0-9_-]{1,64}$/ } },
    vault: { register() {}, isBox: () => true, state: () => 'unlocked', decrypt: () => JSON.stringify(legacy) },
    config: { get: () => [{ board: '@general', box: {} }] },
    projects: { get: () => null },
    error: (status, code) => Object.assign(new Error(code), { status, code }),
  };
  ctx.error.config = ctx.error;
  const notes = require('../server.js')(ctx);
  let body;
  notes.handlers.getBoard({ params: { board: '@general' } }, { json: b => { body = b; } });
  const [l1] = body.lists, [n1, n2] = body.notes;
  assert.deepEqual([l1.x, l1.y, l1.w], [20, 20, 280]);
  assert.deepEqual([n1.x, n1.y, n1.w, n1.h], [320, 20, 500, 250]); // 2 colonne → 500 px, testo 200 + barra e piede
  assert.deepEqual([n2.x, n2.w, n2.h], [620, 240, 180]);
});
