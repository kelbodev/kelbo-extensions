// Script: tratto del progetto, ricerca nelle cartelle di script con l'interprete giusto,
// avvio con argomenti, output in streaming, arresto dell'albero di processi, sicurezza
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { startServer, tmpDir, mcpClient } = require('kelbo/testkit');

const EXT = path.join(__dirname, '..');
const WIN = process.platform === 'win32';
const wait = ms => new Promise(r => setTimeout(r, ms));
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };

let srv, mcp, dir, plain, docs;
const write = (rel, text, mode) => {
  const file = path.join(dir, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  if (mode) fs.chmodSync(file, mode);
};

before(async () => {
  dir = tmpDir('kelbo-script-');
  plain = tmpDir('kelbo-script-none-');
  docs = tmpDir('kelbo-script-docs-');
  fs.mkdirSync(path.join(docs, 'scripts'));
  fs.writeFileSync(path.join(docs, 'scripts', 'README.md'), '# solo documenti\n');
  write('scripts/hello.js', "console.log('ciao', process.argv.slice(2).join('|'), process.cwd());\n");
  write('scripts/esm.mjs', "console.log('esm', import.meta.url.endsWith('esm.mjs'));\n");
  write('scripts/typed.ts', "const n: number = 41;\nconsole.log('ts', n + 1);\n");
  write('scripts/types.d.ts', 'export {};\n');
  write('scripts/README.md', '# not a script\n');
  write('scripts/db/seed.sh', 'echo "seed $1"\nexit 3\n');
  write('scripts/db/deep/deeper/too-deep.js', "console.log('no');\n");
  write('bin/tool', "#!/usr/bin/env node\nconsole.log('shebang');\n", 0o755);
  write('bin/binary', 'ELF\0\0\0');
  write('bin/run.bat', '@echo off\necho bat\n');
  write('scripts/env.js', "console.log('greeting=' + process.env.GREETING, process.argv.slice(2).join('|'));\n");
  write('tools/forever.js', "console.log('start'); setInterval(() => {}, 1000);\n");
  write('scripts/child.js', "const { spawn } = require('child_process');\nconst c = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });\nconsole.log('child', c.pid);\nsetInterval(() => {}, 1000);\n");
  fs.mkdirSync(path.join(dir, 'node_modules', 'x', 'scripts'), { recursive: true });
  srv = await startServer({
    projects: [{ id: 'app', label: 'App', path: dir }, { id: 'plain', label: 'Plain', path: plain }, { id: 'docs', label: 'Docs', path: docs }],
  }, { install: [EXT] });
  mcp = await mcpClient(srv);
});
after(async () => { await mcp?.close(); await srv?.stop(); });

const api = (method, p, body) => srv.request(method, `/api/ext/script${p}`, { body });

async function finished(id) {
  for (let i = 0; i < 100; i++) {
    const pd = (await api('GET', '/processes')).json.find(x => x.id === id);
    if (pd && !pd.running) return pd;
    await wait(100);
  }
  throw new Error('il processo non termina');
}
async function outputOf(id) {
  const r = await srv.request('GET', `/api/ext/script/processes/${id}/stream`);
  return r.events.filter(e => typeof e.data === 'string').map(e => e.data).join('');
}

test('tratto "scripts": solo i progetti con una cartella di script', async () => {
  const { projects, traits } = (await srv.request('GET', '/api/core/projects')).json;
  assert.ok(traits.some(t => t.id === 'scripts' && t.source === 'script'));
  const byId = Object.fromEntries(projects.map(p => [p.id, p.traitsActive]));
  assert.ok(byId.app.includes('scripts'));
  assert.ok(!byId.plain.includes('scripts'));
  assert.ok(!byId.docs.includes('scripts')); // la cartella c'è, ma senza script eseguibili
  const ext = (await srv.request('GET', '/api/core/extensions')).json.find(e => e.code === 'script');
  assert.deepEqual(ext.projects, { traits: ['scripts'] });
});

test('ricerca: cartelle conosciute, interprete per tipo e sistema, due livelli al massimo', async () => {
  const r = await api('GET', '/projects/app/scripts');
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.folders, ['bin', 'scripts', 'tools']);
  const ids = r.json.scripts.map(s => s.id);
  const runner = Object.fromEntries(r.json.scripts.map(s => [s.id, s.runner]));
  for (const id of ['scripts/hello.js', 'scripts/esm.mjs', 'scripts/typed.ts', 'tools/forever.js']) assert.ok(ids.includes(id), id);
  assert.equal(runner['scripts/hello.js'], 'node');
  assert.equal(runner['scripts/typed.ts'], 'node'); // niente tsx nel progetto: Node toglie i tipi
  for (const id of ['scripts/types.d.ts', 'scripts/README.md', 'bin/binary', 'scripts/db/deep/deeper/too-deep.js']) assert.ok(!ids.includes(id), id);
  if (WIN) {
    assert.ok(ids.includes('bin/run.bat'));
    assert.ok(!ids.includes('bin/tool'));
  } else {
    assert.ok(!ids.includes('bin/run.bat'));      // .bat solo su Windows
    assert.equal(runner['bin/tool'], 'node');      // #!/usr/bin/env node
    assert.equal(runner['scripts/db/seed.sh'], 'bash');
  }
  assert.equal((await api('GET', '/projects/nope/scripts')).status, 404);
});

test('avvio: argomenti senza shell, cartella del progetto, output e codice di uscita', async () => {
  let r = await api('POST', '/projects/app/run', { script: 'scripts/hello.js', args: ['uno', 'due tre', '$HOME;rm'] });
  assert.equal(r.status, 200);
  let pd = await finished(r.json.id);
  assert.equal(pd.exitCode, 0);
  assert.deepEqual(pd.args, ['uno', 'due tre', '$HOME;rm']);
  let out = await outputOf(r.json.id);
  assert.match(out, /ciao uno\|due tre\|\$HOME;rm/);
  assert.ok(out.includes(fs.realpathSync(dir)) || out.includes(dir));

  r = await api('POST', '/projects/app/run', { script: 'scripts/typed.ts' });
  pd = await finished(r.json.id);
  assert.match(await outputOf(r.json.id), /ts 42/);
  r = await api('POST', '/projects/app/run', { script: 'scripts/esm.mjs' });
  await finished(r.json.id);
  assert.match(await outputOf(r.json.id), /esm true/);

  if (!WIN) {
    r = await api('POST', '/projects/app/run', { script: 'scripts/db/seed.sh', args: ['demo'] });
    pd = await finished(r.json.id);
    assert.equal(pd.exitCode, 3);
    assert.match(await outputOf(r.json.id), /seed demo/);
    r = await api('POST', '/projects/app/run', { script: 'bin/tool' });
    await finished(r.json.id);
    assert.match(await outputOf(r.json.id), /shebang/);
  }
  // terminato: si toglie dalla lista
  assert.equal((await api('DELETE', `/processes/${r.json.id}/dismiss`)).status, 200);
  assert.ok(!(await api('GET', '/processes')).json.some(x => x.id === r.json.id));
});

test('arresto: tutto l\'albero di processi; riavvio con gli stessi argomenti', { skip: WIN }, async () => {
  let r = await api('POST', '/projects/app/run', { script: 'scripts/child.js' });
  const id = r.json.id;
  let childPid = null;
  for (let i = 0; i < 50 && !childPid; i++) {
    await wait(100);
    const out = JSON.parse((await mcp.callTool({ name: 'script_output', arguments: { process: id } })).content[0].text).output;
    childPid = Number(out.match(/child (\d+)/)?.[1]) || null;
  }
  assert.ok(childPid, 'figlio avviato');
  assert.equal((await api('DELETE', `/processes/${id}/dismiss`)).json.code, 'script.process_running');
  assert.equal((await api('DELETE', `/processes/${id}`)).status, 200);
  for (let i = 0; i < 30 && alive(childPid); i++) await wait(100);
  assert.equal(alive(childPid), false);

  r = await api('POST', '/projects/app/run', { script: 'tools/forever.js', args: ['x'] });
  const first = (await api('GET', '/processes')).json.find(x => x.id === r.json.id).pid;
  const re = await api('POST', `/processes/${r.json.id}/restart`);
  assert.notEqual(re.json.pid, first);
  const pd = (await api('GET', '/processes')).json.find(x => x.id === r.json.id);
  assert.deepEqual([pd.running, pd.args], [true, ['x']]);
  await api('DELETE', `/processes/${r.json.id}`);
});

test('sicurezza: solo script trovati, niente percorsi fuori, argomenti validati', async () => {
  const bad = async (body, code, status = 400) => {
    const r = await api('POST', '/projects/app/run', body);
    assert.deepEqual([r.status, r.json.code], [status, code], JSON.stringify(body));
  };
  await bad({}, 'script.script_required');
  await bad({ script: '../../etc/passwd' }, 'script.script_not_found', 404);
  await bad({ script: 'package.json' }, 'script.script_not_found', 404);
  await bad({ script: 'scripts/README.md' }, 'script.script_not_found', 404);
  await bad({ script: 'scripts/hello.js', args: 'uno' }, 'script.args_invalid');
  await bad({ script: 'scripts/hello.js', args: [1] }, 'script.args_invalid');
  await bad({ script: 'scripts/hello.js', args: Array(51).fill('a') }, 'script.args_invalid');
  if (!WIN) {
    // link simbolico che esce dal progetto: rifiutato anche se ha un nome da script
    const outside = path.join(tmpDir('kelbo-out-'), 'evil.js');
    fs.writeFileSync(outside, "console.log('fuori')");
    fs.symlinkSync(outside, path.join(dir, 'scripts', 'evil.js'));
    await bad({ script: 'scripts/evil.js' }, 'script.script_outside');
    fs.unlinkSync(path.join(dir, 'scripts', 'evil.js'));
  }
  assert.equal((await srv.request('POST', '/api/ext/script/projects/nope/run', { body: { script: 'x' } })).status, 404);
});

test('MCP: elenco, avvio, output, arresto', async () => {
  const call = async (name, args = {}) => JSON.parse((await mcp.callTool({ name, arguments: args })).content[0].text);
  const list = await call('script_list');
  assert.deepEqual(list.projects.map(p => p.id), ['app']);
  assert.ok(list.projects[0].scripts.some(s => s.id === 'scripts/hello.js'));
  const run = await call('script_run', { project: 'app', script: 'scripts/hello.js', args: ['mcp'] });
  await finished(run.process.id);
  const out = await call('script_output', { process: run.process.id });
  assert.match(out.output, /ciao mcp/);
  const long = await call('script_run', { project: 'app', script: 'tools/forever.js' });
  assert.deepEqual(await call('script_stop', { process: long.process.id }), { stopped: true, id: long.process.id });
});

test('prescript: cifrati, nella stessa shell dello script, quello dello script vince, fallito blocca', { skip: WIN }, async () => {
  const put = body => api('PUT', '/projects/app/prescripts', body);
  // senza master password non si salvano
  let r = await put({ command: 'export GREETING=progetto' });
  assert.equal(r.status, 423);
  assert.equal((await srv.request('POST', '/api/core/vault/init', { body: { password: 'master-password-script' } })).status, 200);
  r = await put({ command: 'export GREETING=progetto  # TOKEN=segretissimo' });
  assert.deepEqual(r.json, { all: 'export GREETING=progetto  # TOKEN=segretissimo', scripts: {} });
  assert.doesNotMatch(JSON.stringify(srv.readConfig()), /segretissimo|GREETING/);
  assert.ok(srv.readConfig().scriptPrescripts.app.data);

  const run = async (script, args) => {
    const res = await api('POST', '/projects/app/run', { script, args });
    assert.equal(res.status, 200, JSON.stringify(res.json));
    const pd = await finished(res.json.id);
    return { pd, out: await outputOf(res.json.id) };
  };
  let { pd, out } = await run('scripts/env.js', ['a b', '$HOME', '"x"']);
  assert.equal(pd.exitCode, 0);
  assert.match(out, /greeting=progetto a b\|\$HOME\|"x"/); // argomenti come "$@", mai interpretati
  assert.match(out, /\(prescript\) && node scripts\/env\.js/);
  assert.doesNotMatch(out, /segretissimo/);                    // il testo del prescript non va nell'output
  assert.equal(pd.prescript, true);

  r = await put({ script: 'scripts/env.js', command: 'export GREETING=script\necho preparo' });
  assert.equal(r.json.scripts['scripts/env.js'], 'export GREETING=script\necho preparo');
  ({ out } = await run('scripts/env.js'));
  assert.match(out, /preparo[\s\S]*greeting=script/);

  r = await put({ script: 'scripts/env.js', command: 'echo prima; false' });
  ({ pd, out } = await run('scripts/env.js'));
  assert.notEqual(pd.exitCode, 0);
  assert.doesNotMatch(out, /greeting=/);

  assert.equal((await put({ script: 'scripts/nope.js', command: 'x' })).status, 404);
  assert.equal((await put({ command: 'x'.repeat(2001) })).json.code, 'script.prescript_invalid');
  r = await put({ script: 'scripts/env.js', command: '' });
  assert.deepEqual(r.json.scripts, {});

  // elenco e collegamenti; vault bloccato: si sa solo che ci sono, e gli script non partono
  r = await api('GET', '/projects/app/scripts');
  assert.equal(r.json.prescripts.all, 'export GREETING=progetto  # TOKEN=segretissimo');
  assert.deepEqual((await srv.request('GET', '/api/core/projects/app/links')).json.links, [{ code: 'script', key: 'links.prescripts', params: {} }]);
  await srv.request('POST', '/api/core/vault/lock', { body: {} });
  r = await api('GET', '/projects/app/scripts');
  assert.deepEqual([r.json.prescripts, r.json.prescriptsLocked], [null, true]);
  assert.equal((await api('POST', '/projects/app/run', { script: 'scripts/hello.js' })).status, 423);
  // tolti tutti: la scatola sparisce
  await srv.request('POST', '/api/core/vault/unlock', { body: { password: 'master-password-script' } });
  r = await put({ command: '' });
  assert.deepEqual(srv.readConfig().scriptPrescripts, {});
});
