// Tema: il foglio ridefinisce tutte le variabili del core e solo quelle; Kelbo lo carica e lo serve
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { startServer, themeProblems } = require('kelbo/testkit');

const DIR = path.join(__dirname, '..');
const manifest = require('../setting.json');

test('foglio del tema: solo variabili, tutte quelle del core', () => {
  for (const th of manifest.themes) assert.deepEqual(themeProblems(fs.readFileSync(path.join(DIR, th.css), 'utf8')), [], th.css);
});

let srv;
before(async () => { srv = await startServer({ projects: [] }, { install: [DIR] }); });
after(() => srv?.stop());

test('installato: tema elencato e foglio servito', async () => {
  const ext = (await srv.request('GET', '/api/core/extensions')).json.find(e => e.code === manifest.code);
  assert.equal(ext.state, 'ok', ext.error);
  assert.deepEqual(ext.themes.map(t => t.id), manifest.themes.map(t => t.id));
  for (const th of manifest.themes) {
    const r = await srv.request('GET', `/ext/${manifest.code}/${th.css}`);
    assert.equal(r.status, 200);
    assert.match(r.text, /--bg:/);
  }
  const r = await srv.request('PUT', '/api/core/layout/theme', { body: { id: `${manifest.code}/${manifest.themes[0].id}`, scheme: manifest.themes[0].scheme } });
  assert.equal(r.status, 200, r.text);
});
