// Layout salvati in config.json: creazione, aggiornamento, eliminazione, validazione, export
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { startServer } = require('kelbo/testkit');

let srv;
before(async () => { srv = await startServer({ projects: [] }, { install: [path.join(__dirname, '..')] }); });
after(() => srv?.stop());

const api = (m, p, body) => srv.request(m, `/api/ext/monitor${p}`, body !== undefined ? { body } : {});
const panes = [
  { src: 'npm', projectId: 'api', script: 'dev' },
  { src: 'script', projectId: 'api', script: 'scripts/seed.sh', args: ['--fast'] },
];

test('layout: crea, aggiorna, elimina', async () => {
  assert.deepEqual((await api('GET', '/layouts')).json, { layouts: [] });
  let r = await api('PUT', '/layouts/new', { name: '  Shop  ', grid: 4, panes });
  assert.equal(r.status, 200, r.text);
  const id = r.json.id;
  assert.deepEqual(r.json, { id, name: 'Shop', grid: 4, panes });
  assert.deepEqual(srv.readConfig().monitorLayouts, [r.json]);
  // un riquadro npm non tiene argomenti
  r = await api('PUT', `/layouts/${id}`, { name: 'Shop', grid: 2, panes: [{ src: 'npm', projectId: 'api', script: 'dev', args: ['x'] }] });
  assert.deepEqual(r.json.panes, [{ src: 'npm', projectId: 'api', script: 'dev' }]);
  assert.equal(srv.readConfig().monitorLayouts[0].grid, 2);
  assert.equal((await api('PUT', '/layouts/nope', { name: 'x', grid: 1, panes: [] })).status, 404);
  assert.equal((await api('DELETE', `/layouts/${id}`)).status, 200);
  assert.deepEqual(srv.readConfig().monitorLayouts, []);
});

test('layout: validazione, anche dall\'import', async () => {
  const bad = [
    [{ name: '', grid: 1, panes: [] }, 'monitor.layout_name'],
    [{ name: 'x', grid: 5, panes: [] }, 'monitor.layout_grid'],
    [{ name: 'x', grid: 1, panes: 'a' }, 'monitor.layout_panes'],
    [{ name: 'x', grid: 1, panes: [{ src: 'pm2', projectId: 'a', script: 's' }] }, 'monitor.layout_pane'],
    [{ name: 'x', grid: 1, panes: [{ src: 'npm', projectId: 'a b', script: 's' }] }, 'monitor.layout_pane'],
    [{ name: 'x', grid: 1, panes: [{ src: 'script', projectId: 'a', script: 's', args: [1] }] }, 'monitor.layout_pane'],
  ];
  for (const [body, code] of bad) {
    const r = await api('PUT', '/layouts/new', body);
    assert.equal(r.status, 400, JSON.stringify(body));
    assert.equal(r.json.code, code, JSON.stringify(body));
  }
  const ext = (await srv.request('GET', '/api/core/extensions')).json.find(e => e.code === 'monitor');
  assert.deepEqual(ext.export.map(x => x.sections), [['monitorLayouts']]);
  let r = await srv.request('POST', '/api/core/config/import', { body: { mode: 'replace', config: { monitorLayouts: [{ id: 'a', name: 'A', grid: 9, panes: [] }] } } });
  assert.equal(r.status, 400);
  r = await srv.request('POST', '/api/core/config/import', { body: { mode: 'replace', config: { monitorLayouts: [{ id: 'a', name: 'A', grid: 3, panes, extra: 1 }] } } });
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(srv.readConfig().monitorLayouts, [{ id: 'a', name: 'A', grid: 3, panes }]);
});
