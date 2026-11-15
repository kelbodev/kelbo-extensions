// Terminale: shell vere in uno pseudo-terminale, nella cartella del progetto; input e output in
// streaming, output conservato per chi si ricollega, ridimensionamento, rinomina, chiusura,
// valori rifiutati, xterm.js servito dall'estensione
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { startServer, tmpDir, i18nProblems, parseSse } = require('kelbo/testkit');

const EXT = path.join(__dirname, '..');
const unix = process.platform !== 'win32';
let srv, dir;
const api = (m, p, body) => srv.request(m, `/api/ext/terminal${p}`, body !== undefined ? { body } : {});
const sleep = ms => new Promise(r => setTimeout(r, ms));

// legge lo stream SSE di una sessione finché il testo contiene `until` (o scade)
async function readStream(id, until, ms = 8000) {
  const ctrl = new AbortController();
  const res = await fetch(`http://127.0.0.1:${srv.port}/api/ext/terminal/sessions/${id}/stream`, { signal: ctrl.signal, headers: { Host: `127.0.0.1:${srv.port}` } });
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let raw = '';
  const end = Date.now() + ms;
  try {
    while (Date.now() < end) {
      const { value, done } = await Promise.race([reader.read(), sleep(200).then(() => ({ value: null, done: false }))]);
      if (done) break;
      if (value) raw += dec.decode(value, { stream: true });
      const text = parseSse(raw).filter(e => e.type === 'data').map(e => e.data).join('');
      if (until && (typeof until === 'string' ? text.includes(until) : until.test(text))) break;
    }
  } finally { ctrl.abort(); }
  return { events: parseSse(raw), text: parseSse(raw).filter(e => e.type === 'data').map(e => e.data).join('') };
}

before(async () => {
  dir = tmpDir('kelbo-terminal-');
  fs.writeFileSync(path.join(dir, 'marker.txt'), 'ok');
  srv = await startServer({ projects: [{ id: 'demo', label: 'Demo', path: dir }] }, { install: [EXT] });
});
after(() => srv?.stop());

test('traduzioni', () => assert.deepEqual(i18nProblems(EXT), []));

test('shell disponibili e xterm.js servito dall\'estensione', async () => {
  const info = (await api('GET', '/info')).json;
  assert.equal(info.available, true, info.error);
  assert.ok(info.shells.length >= 1);
  let r = await api('GET', '/vendor/xterm.mjs');
  assert.equal(r.status, 200);
  assert.match(r.headers['content-type'], /text\/javascript/);
  assert.match(r.text, /Terminal/);
  r = await api('GET', '/vendor/xterm.css');
  assert.match(r.headers['content-type'], /text\/css/);
  assert.equal((await api('GET', '/vendor/addon-fit.mjs')).status, 200);
  assert.equal((await api('GET', '/vendor/..%2Fpackage.json')).status, 404);
  assert.equal((await api('GET', '/vendor/server.js')).status, 404);
});

test('sessione nella cartella del progetto: input, output, ricollegamento, ridimensionamento, chiusura', { skip: !unix && 'shell POSIX' }, async () => {
  let r = await api('POST', '/sessions', { projectId: 'demo', shell: '/bin/sh', cols: 90, rows: 20 });
  assert.equal(r.status, 200, r.text);
  const s = r.json.session;
  assert.deepEqual([s.projectId, s.cwd, s.cols, s.rows, s.exited], ['demo', dir, 90, 20, false]);
  assert.match(s.title, /^Demo · sh$/);
  assert.equal((await api('POST', `/sessions/${s.id}/input`, { data: 'echo "somma $((40+2))"; ls; stty size\r' })).status, 200);
  let out = await readStream(s.id, /\d+ 90/);
  assert.match(out.text, /somma 42/);
  assert.match(out.text, /marker\.txt/);
  assert.match(out.text, /20 90/, 'stty size: righe e colonne della sessione');
  assert.equal(out.events[0].type, 'init');
  // ridimensionamento: la shell vede le dimensioni nuove
  assert.equal((await api('POST', `/sessions/${s.id}/resize`, { cols: 120, rows: 33 })).status, 200);
  await api('POST', `/sessions/${s.id}/input`, { data: 'stty size\r' });
  out = await readStream(s.id, '33 120');
  assert.match(out.text, /33 120/);
  // chi si ricollega rivede l'output di prima
  out = await readStream(s.id, 'somma 42', 2000);
  assert.match(out.text, /somma 42/);
  // rinomina, elenco, valori rifiutati
  r = await api('POST', `/sessions/${s.id}/rename`, { title: 'Build' });
  assert.equal(r.json.session.title, 'Build');
  assert.equal((await api('POST', `/sessions/${s.id}/rename`, { title: 'a\nb' })).json.code, 'terminal.title_invalid');
  assert.equal((await api('POST', `/sessions/${s.id}/resize`, { cols: 9999, rows: 10 })).json.code, 'terminal.size_invalid');
  assert.equal((await api('POST', `/sessions/${s.id}/input`, { data: 42 })).json.code, 'terminal.input_invalid');
  assert.deepEqual((await api('GET', '/sessions')).json.sessions.map(x => x.title), ['Build']);
  // uscita della shell: exit con il codice
  await api('POST', `/sessions/${s.id}/input`, { data: 'exit 3\r' });
  await sleep(500);
  out = await readStream(s.id, null, 800);
  assert.equal(out.events.find(e => e.type === 'exit')?.data, 3);
  assert.equal((await api('POST', `/sessions/${s.id}/close`, {})).status, 200);
  assert.equal((await api('GET', '/sessions')).json.sessions.length, 0);
  assert.equal((await api('POST', `/sessions/${s.id}/input`, { data: 'x' })).status, 404);
});

test('comando eseguito all\'apertura, shell e progetti non validi, sessioni attive al riavvio', { skip: !unix && 'shell POSIX' }, async () => {
  let r = await api('POST', '/sessions', { shell: '/bin/sh', command: 'echo pronto-$((1+1))' });
  assert.equal(r.status, 200, r.text);
  const id = r.json.session.id;
  assert.equal(r.json.session.projectId, null);
  const out = await readStream(id, 'pronto-2');
  assert.match(out.text, /pronto-2/);
  // per il dialogo di aggiornamento: cosa si ferma al riavvio
  const running = (await srv.request('GET', '/api/core/update/running')).json.running;
  assert.ok(running.some(x => x.code === 'terminal' && x.key === 'running.session'), JSON.stringify(running));
  assert.equal((await api('POST', '/sessions', { shell: '/usr/bin/evil' })).json.code, 'terminal.shell_invalid');
  assert.equal((await api('POST', '/sessions', { projectId: 'nope' })).json.code, 'terminal.project_not_found');
  assert.equal((await api('POST', '/sessions', { command: 'a\nb' })).json.code, 'terminal.command_invalid');
  await api('POST', `/sessions/${id}/close`, {});
});
