// Docker: modulo compose (interpolazione come docker compose, porte e volumi nelle due sintassi,
// analisi, correzioni e modifiche che lasciano intatti i commenti, override), API dei file compose
// senza Docker (percorsi rifiutati, salvataggio con conflitto, modelli, correzioni), strumenti MCP;
// con un daemon Docker raggiungibile anche up/down veri, job in streaming, container e il
// trasporto dei tunnel verso una porta mai pubblicata (saltati se Docker non c'è).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const net = require('net');
const path = require('path');
const { execFileSync } = require('child_process');
const { startServer, tmpDir, mcpClient, i18nProblems, parseSse } = require('kelbo/testkit');
const cp = require('../compose');

const EXT = path.join(__dirname, '..');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const until = async (fn, ms = 20000) => { const end = Date.now() + ms; for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw new Error('timeout'); await sleep(200); } };
const dockerUp = (() => { try { execFileSync('docker', ['info'], { stdio: 'ignore', timeout: 10000 }); return true; } catch { return false; } })();

const SHOP = `version: "3.9"
# commento in testa
services:
  api:
    build: ./api   # build locale
    ports: ["3000:3000"]
    environment:
      JWT_SECRET: changeme
      DB_PASSWORD: \${DB_PASSWORD}
      TOKEN: \${TOKEN}
    depends_on: [db]
  db:
    image: postgres
    ports: ["5432:5432"]
    volumes: [data:/var/lib/postgresql/data]
  worker:
    image: alpine:3.20
    depends_on:
      db: { condition: service_healthy }
    networks: [backend]
volumes:
  unused: {}
`;

let root, srv, mcp;
const api = (m, p, body) => srv.request(m, `/api/ext/docker${p}`, body !== undefined ? { body } : {});

before(async () => {
  root = tmpDir('kelbo-docker-');
  fs.mkdirSync(path.join(root, 'shop', 'api'), { recursive: true });
  fs.writeFileSync(path.join(root, 'shop', 'api', 'Dockerfile'), 'FROM alpine:3.20\n');
  fs.writeFileSync(path.join(root, 'shop', 'compose.yaml'), SHOP);
  fs.writeFileSync(path.join(root, 'shop', '.env'), 'DB_PASSWORD=segreta\n');
  fs.mkdirSync(path.join(root, 'shop', 'docker'));
  fs.writeFileSync(path.join(root, 'shop', 'docker', 'docker-compose.dev.yml'), 'services: {}\n');
  fs.mkdirSync(path.join(root, 'empty'));
  srv = await startServer({
    projects: [{ id: 'shop', label: 'Shop', path: path.join(root, 'shop') }, { id: 'empty', label: 'Empty', path: path.join(root, 'empty') }],
  }, { install: [EXT] });
  mcp = await mcpClient(srv);
});
after(async () => { await mcp?.close(); await srv?.stop(); });

test('traduzioni', () => assert.deepEqual(i18nProblems(EXT), []));

test('interpolazione come docker compose, .env, porte e volumi nelle due sintassi', () => {
  const missing = [], required = [];
  const rep = { missing: n => missing.push(n), required: (n, m) => required.push([n, m]), invalid: () => {} };
  const env = { A: 'a', EMPTY: '' };
  const I = s => cp.interpolate(s, env, rep);
  assert.equal(I('$$A ${A} $A ${B:-x} ${EMPTY:-d} ${EMPTY-d} ${A:+y} ${B+z} ${B:-${A}}'), '$A a a x d  y  a');
  assert.equal(I('${NOPE}'), '');
  I('${REQ:?serve REQ}');
  assert.deepEqual([missing, required], [['NOPE'], [['REQ', 'serve REQ']]]);
  assert.deepEqual(cp.parseDotenv('# c\nexport A=1\nB="due # no"\nC=tre # commento\nD=\'q\'\n'), { A: '1', B: 'due # no', C: 'tre', D: 'q' });
  assert.deepEqual(cp.variablesIn('${A:-x} $B ${C:?e} $$D').map(v => [v.name, v.default, v.required]), [['A', 'x', false], ['B', null, false], ['C', null, true]]);
  const ports = cp.normalizePorts(['80', '8080:80', '127.0.0.1:5433:5432', '[::1]:9000:9000/udp', '8000-8002:8000-8002', { target: 53, published: 1053, protocol: 'udp', host_ip: '127.0.0.1' }]);
  assert.deepEqual(ports.map(p => [p.hostIp, p.published, p.target, p.protocol]), [['', null, '80', 'tcp'], ['', '8080', '80', 'tcp'], ['127.0.0.1', '5433', '5432', 'tcp'], ['::1', '9000', '9000', 'udp'], ['', '8000-8002', '8000-8002', 'tcp'], ['127.0.0.1', '1053', '53', 'udp']]);
  assert.deepEqual(cp.publishedNumbers(ports[4]), [8000, 8001, 8002]);
  const vols = cp.normalizeVolumes(['data:/d', './conf:/etc/x:ro', '/abs:/a', '/anon', '~/h:/h', { type: 'bind', source: '.', target: '/app' }]);
  assert.deepEqual(vols.map(v => [v.type, v.source, v.target, v.readOnly]), [['volume', 'data', '/d', false], ['bind', './conf', '/etc/x', true], ['bind', '/abs', '/a', false], ['volume', null, '/anon', false], ['bind', '~/h', '/h', false], ['bind', '.', '/app', false]]);
});

test('analisi: problemi trovati e correzioni che lasciano intatti i commenti', () => {
  const doc = cp.parseDoc(SHOP);
  const variables = { missing: [], required: [], invalid: [] };
  const rep = { missing: n => variables.missing.push(n), required: () => {}, invalid: () => {} };
  const model = cp.normalize(cp.interpolateTree(doc.toJS(), { DB_PASSWORD: 'x' }, rep));
  model.services.find(s => s.name === 'api').rawEnvVars = new Set(['DB_PASSWORD', 'TOKEN']);
  const issues = cp.analyze(model, { dir: '/nonexistent', variables, listening: new Map([[3000, { name: 'node', pid: 42 }]]) });
  const codes = issues.map(i => `${i.level}:${i.code}${i.service ? `:${i.service}` : ''}`);
  for (const c of ['error:build_context_missing:api', 'error:volume_undeclared:db', 'error:network_undeclared:worker', 'warning:healthy_without_healthcheck:worker',
    'warning:env_missing', 'warning:port_in_use:api', 'warning:secret_plain:api', 'warning:image_latest:db', 'info:version_obsolete', 'info:depends_not_ready:api',
    'info:port_all_interfaces:db', 'info:volume_unused']) assert.ok(codes.includes(c), `${c} in ${codes.join(', ')}`);
  assert.ok(!codes.includes('warning:secret_plain:api') || issues.filter(i => i.code === 'secret_plain').map(i => i.params.name).join() === 'JWT_SECRET');
  assert.deepEqual(issues.find(i => i.code === 'port_in_use').params, { service: 'api', port: 3000, process: 'node', pid: 42 });
  // ciclo e dipendenza sconosciuta
  const m2 = cp.normalize({ services: { a: { image: 'x:1', depends_on: ['b'] }, b: { image: 'x:1', depends_on: ['a', 'c'] } } });
  const c2 = cp.analyze(m2, { dir: '/' }).map(i => i.code);
  assert.ok(c2.includes('depends_cycle') && c2.includes('depends_unknown'));
  // porte doppie (stesso IP o tutte le interfacce), non su IP diversi
  const m3 = cp.normalize({ services: { a: { image: 'x:1', ports: ['8080:80'] }, b: { image: 'x:1', ports: ['127.0.0.1:8080:80'] }, c: { image: 'x:1', ports: ['127.0.0.2:9000:1'] }, d: { image: 'x:1', ports: ['127.0.0.3:9000:1'] } } });
  assert.deepEqual(cp.analyze(m3, { dir: '/' }).filter(i => i.code === 'port_duplicate').map(i => i.params.port), [8080]);

  // correzioni
  for (const fix of [{ fix: 'remove_version' }, { fix: 'declare_volume', name: 'data' }, { fix: 'declare_network', name: 'backend' }, { fix: 'remove_volume', name: 'unused' },
    { fix: 'add_healthcheck', service: 'worker', target: 'db' }, { fix: 'wait_healthy', service: 'api', target: 'db' }, { fix: 'bind_localhost', service: 'db', port: { index: 0 } },
    { fix: 'change_port', service: 'api', port: { index: 0 } }]) cp.applyFix(doc, fix, { used: new Set([3000, 3001]) });
  const out = cp.stringify(doc);
  assert.match(out, /^# commento in testa\nservices:/);
  assert.match(out, /build: \.\/api # build locale/);
  assert.match(out, /ports: \["3002:3000"\]/);
  assert.match(out, /ports: \["127\.0\.0\.1:5432:5432"\]/);
  assert.match(out, /depends_on:\n {6}db:\n {8}condition: service_healthy/);
  assert.match(out, /healthcheck:\n {6}test:\n {8}- CMD-SHELL\n {8}- pg_isready/);
  assert.match(out, /volumes:\n {2}data: \{\}\nnetworks:\n {2}backend: \{\}\n$/);
  assert.ok(!/version|unused/.test(out));
  const after = cp.normalize(cp.parseDoc(out).toJS());
  assert.deepEqual(cp.analyze(after, { dir: '/nonexistent' }).filter(i => i.level === 'error').map(i => i.code), ['build_context_missing']);
});

test('modifiche: servizio dall\'editor, rinomina con i riferimenti, rimozione, override', () => {
  const doc = cp.parseDoc(SHOP);
  cp.setService(doc, 'db', { image: 'postgres:17', ports: ['5432:5432'], volumes: ['data:/var/lib/postgresql/data'] });
  cp.renameService(doc, 'db', 'postgres');
  let js = doc.toJS();
  assert.deepEqual([js.services.postgres.image, js.services.api.depends_on, js.services.worker.depends_on], ['postgres:17', ['postgres'], { postgres: { condition: 'service_healthy' } }]);
  assert.match(cp.stringify(doc), /ports: \["5432:5432"\]/, 'chiavi non cambiate: formattazione originale');
  assert.throws(() => cp.renameService(doc, 'api', 'worker'), e => e.key === 'service_exists');
  assert.throws(() => cp.setService(doc, '../x', {}), e => e.key === 'name_invalid');
  cp.removeService(doc, 'postgres');
  js = doc.toJS();
  assert.deepEqual([js.services.api.depends_on, js.services.worker.depends_on, 'postgres' in js.services], [undefined, undefined, false]);
  const merged = cp.mergeCompose({ services: { a: { image: 'x:1', ports: ['1:1'], environment: ['A=1'], volumes: ['v:/d'] } } },
    { services: { a: { ports: ['2:2'], environment: { B: '2' }, volumes: ['./w:/d'] }, b: { image: 'y:1' } } });
  assert.deepEqual(merged.services.a, { image: 'x:1', ports: ['1:1', '2:2'], environment: { A: '1', B: '2' }, volumes: ['./w:/d'] });
  assert.equal(merged.services.b.image, 'y:1');
});

test('connessione database dall\'immagine e dall\'ambiente del container', () => {
  assert.deepEqual(cp.dbConnectionOf('postgres:17', { POSTGRES_USER: 'shop', POSTGRES_PASSWORD: 'p' }), { type: 'postgres', port: 5432, user: 'shop', password: 'p', database: 'shop' });
  assert.deepEqual(cp.dbConnectionOf('mariadb:11', { MARIADB_ROOT_PASSWORD: 'r', MARIADB_DATABASE: 'd' }), { type: 'mysql', port: 3306, user: 'root', password: 'r', database: 'd' });
  assert.deepEqual(cp.dbConnectionOf('mysql:8.4', { MYSQL_USER: 'u', MYSQL_PASSWORD: 'p', MYSQL_ROOT_PASSWORD: 'r' }).user, 'u');
  assert.equal(cp.dbConnectionOf('mcr.microsoft.com/mssql/server:2022-latest', { MSSQL_SA_PASSWORD: 'X' }).password, 'X');
  assert.equal(cp.dbConnectionOf('gvenzl/oracle-free:23', { ORACLE_PASSWORD: 'o' }).database, 'FREEPDB1');
  assert.equal(cp.dbConnectionOf('redis:7', {}), null);
});

test('file compose dei progetti: elenco, lettura, analisi con .env e porte, percorsi rifiutati', async () => {
  let r = await api('GET', '/files');
  assert.deepEqual(r.json.files.map(f => [f.projectId, f.file, f.base]), [['shop', 'compose.yaml', true], ['shop', 'docker/docker-compose.dev.yml', false]]);
  r = await api('POST', '/compose/load', { projectId: 'shop', file: 'compose.yaml' });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.text, SHOP);
  assert.deepEqual(r.json.variables.missing, ['TOKEN'], 'DB_PASSWORD dal .env');
  assert.deepEqual(r.json.dotenv, ['DB_PASSWORD']);
  const codes = r.json.issues.map(i => i.code);
  assert.ok(!codes.includes('build_context_missing') && !codes.includes('dockerfile_missing'), 'la cartella ./api con il Dockerfile c\'è');
  assert.deepEqual(r.json.issues.filter(i => i.code === 'secret_plain').map(i => i.params.name), ['JWT_SECRET'], 'i valori da variabili non sono segreti scritti');
  assert.equal(r.json.projectName, 'shop');
  assert.deepEqual(Object.keys(r.json.rawServices), ['api', 'db', 'worker']);
  for (const file of ['../x/compose.yaml', 'compose.txt', '/etc/compose.yaml', 'a/b/c/compose.yaml', 'docker/../compose.yaml']) {
    assert.equal((await api('POST', '/compose/load', { projectId: 'shop', file })).json.code, 'docker.file_invalid', file);
  }
  assert.equal((await api('POST', '/compose/load', { projectId: 'nope', file: 'compose.yaml' })).status, 404);
  assert.equal((await api('POST', '/compose/load', { projectId: 'empty', file: 'compose.yaml' })).json.code, 'docker.file_not_found');
  r = await api('POST', '/compose/analyze', { projectId: 'shop', file: 'compose.yaml', text: 'services:\n  a: [\n' });
  assert.equal(r.json.yamlErrors.length > 0 && !!r.json.yamlErrors[0].line, true);
});

test('modifiche e salvataggio: modelli con porte libere, correzioni, conflitto sul disco, file nuovo', async () => {
  let r = await api('POST', '/compose/load', { projectId: 'shop', file: 'compose.yaml' });
  const hash = r.json.hash;
  // porta 5432 già nel file: il modello postgres usa la prima libera dopo
  r = await api('POST', '/compose/edit', { projectId: 'shop', file: 'compose.yaml', text: SHOP, ops: [{ op: 'addTemplate', template: 'postgres' }, { op: 'addTemplate', template: 'postgres' }] });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.added, 'postgres-2');
  const js = cp.parseDoc(r.json.text).toJS();
  const ports = [js.services.postgres.ports[0], js.services['postgres-2'].ports[0]];
  assert.ok(ports.every(p => /^127\.0\.0\.1:\d+:5432$/.test(p)) && !ports.some(p => p.startsWith('127.0.0.1:5432:')) && ports[0] !== ports[1], ports.join());
  assert.deepEqual(Object.keys(js.volumes), ['unused', 'pgdata', 'pgdata2']);
  assert.ok(js.services.postgres.healthcheck);
  const issue = r.json.issues.find(i => i.fix === 'remove_version');
  r = await api('POST', '/compose/edit', { projectId: 'shop', file: 'compose.yaml', text: r.json.text, ops: [{ op: 'fix', issue }, { op: 'removeService', name: 'postgres-2' }, { op: 'undeclare', kind: 'volumes', name: 'pgdata2' }] });
  assert.ok(!/version|postgres-2|pgdata2/.test(r.json.text));
  assert.equal((await api('POST', '/compose/edit', { projectId: 'shop', file: 'compose.yaml', text: SHOP, ops: [{ op: 'nope' }] })).json.code, 'docker.ops_invalid');
  assert.equal((await api('POST', '/compose/edit', { projectId: 'shop', file: 'compose.yaml', text: SHOP, ops: [{ op: 'addTemplate', template: 'x' }] })).json.code, 'docker.template_unknown');
  // salvataggio: il file cambiato sul disco nel frattempo → 409
  const text = r.json.text;
  fs.appendFileSync(path.join(root, 'shop', 'compose.yaml'), '# toccato\n');
  r = await api('POST', '/compose/save', { projectId: 'shop', file: 'compose.yaml', text, hash });
  assert.deepEqual([r.status, r.json.code], [409, 'docker.file_changed']);
  const fresh = (await api('POST', '/compose/load', { projectId: 'shop', file: 'compose.yaml' })).json.hash;
  r = await api('POST', '/compose/save', { projectId: 'shop', file: 'compose.yaml', text, hash: fresh });
  assert.equal(r.status, 200, r.text);
  assert.equal(fs.readFileSync(path.join(root, 'shop', 'compose.yaml'), 'utf8'), text);
  assert.equal((await api('POST', '/compose/save', { projectId: 'shop', file: 'compose.yaml', text: 'a: [', hash: r.json.hash })).json.code, 'docker.yaml_invalid');
  // file nuovo: hash null, poi compare nell'elenco
  r = await api('POST', '/compose/save', { projectId: 'empty', file: 'compose.yaml', text: 'services:\n  web:\n    image: nginx:1.27-alpine\n', hash: null });
  assert.deepEqual([r.status, r.json.created], [200, true]);
  assert.ok((await api('GET', '/files')).json.files.some(f => f.projectId === 'empty'));
  assert.equal((await api('POST', '/compose/save', { projectId: 'empty', file: 'compose.yaml', text: 'services: {}\n', hash: null })).status, 409);
});

test('comandi compose: azioni e nomi rifiutati prima di docker', async () => {
  assert.equal((await api('POST', '/compose/run', { target: { projectId: 'shop', file: 'compose.yaml' }, action: 'rm' })).json.code, 'docker.action_invalid');
  assert.equal((await api('POST', '/compose/run', { target: { projectId: 'shop', file: 'compose.yaml' }, action: 'up', services: ['--privileged'] })).json.code, 'docker.service_invalid');
  assert.equal((await api('POST', '/compose/run', { target: { project: '--all' }, action: 'down' })).json.code, 'docker.project_invalid');
  assert.equal((await api('POST', '/containers/-rf/remove', {})).json.code, 'docker.container_invalid');
  assert.equal((await api('POST', '/containers/abc/kill', {})).json.code, 'docker.action_invalid');
  assert.equal((await api('GET', '/jobs/nope/stream')).status, 404);
});

test('strumenti MCP: analisi di un file compose', async () => {
  const r = await mcp.callTool({ name: 'docker_analyze', arguments: { project: 'shop', file: 'compose.yaml' } });
  assert.ok(!r.isError, JSON.stringify(r));
  const data = r.structuredContent;
  assert.deepEqual(data.services.map(s => s.name), ['api', 'db', 'worker', 'postgres']);
  assert.ok(data.issues.some(i => i.code === 'image_latest' && i.service === 'db'));
  assert.deepEqual(data.missingVariables, ['TOKEN']);
});

test('senza docker: stato e trasporto dicono che manca', async () => {
  const s2 = await startServer({ projects: [] }, { install: [EXT], env: { KELBO_DOCKER: path.join(root, 'no-docker') } });
  try {
    const r = await s2.request('GET', '/api/ext/docker/status');
    assert.equal(r.json.error.code, 'docker.docker_missing');
    assert.equal((await s2.request('GET', '/api/ext/docker/overview')).status, 503);
    const f = await s2.request('POST', '/api/ext/tunnels/transports/docker/fields', { body: { values: {} } });
    assert.deepEqual(f.json.fields.map(x => [x.key, (x.options || []).length]), [['container', 0], ['port', 0]]);
  } finally { await s2.stop(); }
});

// ---- con Docker vero ----
test('Docker vero: up come job, container del file, log, tunnel verso una porta non pubblicata, down', { skip: !dockerUp && 'daemon Docker non raggiungibile' }, async () => {
  const dir = path.join(root, 'live');
  fs.mkdirSync(dir);
  const name = `kelbo-test-${process.pid}`;
  fs.writeFileSync(path.join(dir, 'compose.yaml'), `name: ${name}
services:
  echo:
    image: alpine:3.20
    command: ["sh", "-c", "echo pronto; nc -lk -p 7000 -e echo pong"]
    expose: ["7000"]
`);
  const s2 = await startServer({ projects: [{ id: 'live', label: 'Live', path: dir }] }, { install: [EXT] });
  const a = (m, p, body) => s2.request(m, `/api/ext/docker${p}`, body !== undefined ? { body } : {});
  try {
    let r = await a('POST', '/compose/run', { target: { projectId: 'live', file: 'compose.yaml' }, action: 'up' });
    assert.equal(r.status, 200, r.text);
    r = await a('GET', `/jobs/${r.json.job.id}/stream`);
    const exit = r.events.find(e => e.type === 'exit');
    assert.equal(exit?.data, 0, r.text);
    r = await a('POST', '/compose/load', { projectId: 'live', file: 'compose.yaml' });
    assert.equal(r.json.projectName, name);
    const c = r.json.running.echo[0];
    assert.equal(c.state, 'running');
    r = await a('GET', '/overview');
    const live = r.json.containers.find(x => x.name === c.name);
    assert.deepEqual([live.compose.project, live.compose.service, live.exposed], [name, 'echo', [{ port: 7000, protocol: 'tcp' }]]);
    assert.ok(r.json.projects.some(p => p.name === name));
    r = await a('GET', `/containers/${c.name}/logs?tail=10`);
    assert.match(r.text, /pronto/);
    // tunnel della sezione Tunnel con il trasporto docker: porta 7000 mai pubblicata
    const t = (m, p, body) => s2.request(m, `/api/ext/tunnels${p}`, body !== undefined ? { body } : {});
    r = await t('POST', '/servers', { key: 'echo', label: 'Echo', port: 46700 + (process.pid % 100), type: 'TCP', transport: 'docker', params: { container: c.name, port: 7000 } });
    assert.equal(r.status, 200, r.text);
    const local = 46700 + (process.pid % 100);
    r = await t('POST', '/tunnels', { serverKey: 'echo' });
    const id = r.json.id;
    await until(async () => /Pronto|Ready/.test((await t('GET', `/tunnels/${id}/logs`)).json.map(l => l.text).join('')), 120000);
    const reply = await new Promise((res, rej) => { const s = net.connect(local, '127.0.0.1'); let b = ''; s.on('data', d => { b += d; }); s.on('end', () => res(b)); s.on('error', rej); setTimeout(() => { s.destroy(); res(b); }, 5000); });
    assert.equal(reply.trim(), 'pong');
    assert.equal((await t('DELETE', `/tunnels/${id}`)).status, 200);
    await until(() => !execFileSync('docker', ['ps', '-aq', '--filter', `label=dev.kelbo.forward.target=${c.name}`]).toString().trim());
    // MCP: container senza ambiente
    const m2 = await mcpClient(s2);
    const list = (await m2.callTool({ name: 'docker_containers', arguments: {} })).structuredContent.containers;
    assert.ok(list.some(x => x.name === c.name) && list.every(x => !('env' in x)));
    await m2.close();
    // stop di un container, poi down
    assert.equal((await a('POST', `/containers/${c.name}/stop`, {})).status, 200);
    r = await a('POST', '/compose/run', { target: { project: name }, action: 'down' });
    r = await a('GET', `/jobs/${r.json.job.id}/stream`);
    assert.equal(r.events.find(e => e.type === 'exit')?.data, 0, r.text);
    assert.equal(execFileSync('docker', ['ps', '-aq', '--filter', `label=com.docker.compose.project=${name}`]).toString().trim(), '');
  } finally {
    try { execFileSync('docker', ['compose', '-p', name, 'down', '--remove-orphans'], { stdio: 'ignore', timeout: 60000 }); } catch { /* già giù */ }
    await s2.stop();
  }
});
