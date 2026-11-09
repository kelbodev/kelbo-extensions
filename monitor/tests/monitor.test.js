// Monitor: estensione solo frontend; si carica, serve i suoi file, traduzioni complete. Le API che
// usa (/processes, stream, restart, run) sono quelle di npm, controllate qui con un processo vero
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { startServer, tmpDir, makeRepo, i18nProblems } = require('kelbo/testkit');

const DIR = path.join(__dirname, '..');
let srv;
before(async () => {
  const repo = makeRepo(path.join(tmpDir(), 'app'), { scripts: { hello: 'node -e "console.log(\'ciao\')"' } });
  srv = await startServer({ projects: [{ id: 'app', label: 'App', path: repo }] }, { install: [DIR] });
});
after(() => srv?.stop());

test('traduzioni complete e coerenti', () => {
  assert.deepEqual(i18nProblems(DIR), []);
});

test('caricata e file serviti', async () => {
  const ext = (await srv.request('GET', '/api/core/extensions')).json.find(e => e.code === 'monitor');
  assert.equal(ext.state, 'ok', ext.error);
  for (const f of ['view.js', 'view.html', 'sidebar.html', 'style.css']) assert.equal((await srv.request('GET', `/ext/monitor/${f}`)).status, 200, f);
});

test('API di npm usate dai riquadri: elenco, stream, riavvio dopo la fine', async () => {
  const run = (await srv.request('POST', '/api/ext/npm/projects/app/run', { body: { script: 'hello' } })).json;
  let list;
  for (let i = 0; i < 100; i++) {
    list = (await srv.request('GET', '/api/ext/npm/processes')).json;
    if (list.find(p => p.id === run.id && !p.running)) break;
    await new Promise(r => setTimeout(r, 100));
  }
  const p = list.find(x => x.id === run.id);
  assert.deepEqual([p.projectId, p.script, p.running, p.exitCode], ['app', 'hello', false, 0]);
  const stream = await srv.request('GET', `/api/ext/npm/processes/${run.id}/stream`);
  assert.match(stream.text, /"type":"history"[\s\S]*ciao[\s\S]*"type":"exit"/);
  // "avvia di nuovo" su un processo terminato: stesso id, di nuovo in esecuzione
  const r = await srv.request('POST', `/api/ext/npm/processes/${run.id}/restart`, { body: {} });
  assert.equal(r.status, 200, r.text);
});
