// Kubernetes attraverso Kelbo con un kubectl finto (tests/fake-kubectl.js): context e namespace
// sempre espliciti, pod riassunti come kubectl get pods, watch in diretta, describe, log, modifiche
// con i context protetti, nomi rifiutati prima del comando, trasporto port-forward della sezione
// Tunnel (fino al pod sostituito dal deployment), strumenti MCP, traduzioni
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const net = require('net');
const path = require('path');
const { startServer, tmpDir, mcpClient, i18nProblems, parseSse } = require('kelbo/testkit');
const kube = require('../kube');

const EXT = path.join(__dirname, '..');
let srv, mcp, logFile;
const api = (m, p, body) => srv.request(m, `/api/ext/kubectl${p}`, body !== undefined ? { body } : {});
const calls = () => fs.readFileSync(logFile, 'utf8').trim().split('\n').map(l => JSON.parse(l));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const until = async (fn, ms = 8000) => { const end = Date.now() + ms; for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw new Error('timeout'); await sleep(100); } };
const B = '/contexts/kind-dev/namespaces/shop';

before(async () => {
  const bin = tmpDir('kelbo-kubectl-bin-');
  const exe = path.join(bin, 'kubectl');
  fs.copyFileSync(path.join(__dirname, 'fake-kubectl.js'), exe);
  fs.chmodSync(exe, 0o755);
  logFile = path.join(bin, 'calls.log');
  fs.writeFileSync(logFile, '');
  srv = await startServer({ projects: [], kubectl: { protected: ['prod-eks'] } }, { install: [EXT], env: { KELBO_KUBECTL: exe, FAKE_KUBECTL_LOG: logFile } });
  mcp = await mcpClient(srv);
});
after(async () => { await mcp?.close(); await srv?.stop(); });

test('traduzioni', () => assert.deepEqual(i18nProblems(EXT), []));

test('riassunto dei pod come kubectl get pods; deployment del pod; JSON concatenato del watch', () => {
  const objs = [];
  const feed = kube.jsonStreamParser(o => objs.push(o));
  feed('{"type":"ADDED","object":{"a":"}{"}}\n{"ty'); feed('pe":"DELETED"}');
  assert.deepEqual(objs, [{ type: 'ADDED', object: { a: '}{' } }, { type: 'DELETED' }]);
  assert.throws(() => kube.checkName('Bad_Name'), e => e.key === 'name_invalid');
  assert.throws(() => kube.checkContext('--kubeconfig=/x'), e => e.key === 'context_invalid');
  assert.throws(() => kube.checkNamespace('-n'), e => e.key === 'namespace_invalid');
  assert.deepEqual(kube.scope('arn:aws:eks:eu-west-1:1:cluster/prod', 'shop'), ['--context', 'arn:aws:eks:eu-west-1:1:cluster/prod', '-n', 'shop']);
});

test('context, protezione, namespace, pod e workload con --context e -n espliciti', async () => {
  let r = await api('GET', '/contexts');
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(r.json.contexts, [{ name: 'kind-dev', current: true, protected: false }, { name: 'prod-eks', current: false, protected: true }]);
  r = await api('GET', '/contexts/kind-dev/namespaces');
  assert.deepEqual(r.json.namespaces, ['default', 'kube-system', 'shop']);
  r = await api('GET', `${B}/pods`);
  const [podApi, worker] = r.json.pods;
  assert.deepEqual([podApi.name, podApi.status, podApi.ready, podApi.restarts, podApi.deployment], ['api-7d4b9c-abcde', 'Running', '2/2', 1, 'api']);
  assert.deepEqual([worker.status, worker.ready, worker.restarts], ['CrashLoopBackOff', '0/1', 7]);
  assert.deepEqual(calls().at(-1), ['get', 'pods', '--context', 'kind-dev', '-n', 'shop', '-o', 'json']);
  r = await api('GET', `${B}/workloads`);
  assert.deepEqual(r.json.workloads.map(w => [w.kind, w.name, w.ready, w.replicas]), [['deployment', 'api', 2, 3], ['statefulset', 'worker', 0, 1]]);
  // nomi e context non validi: mai al comando
  const before = calls().length;
  assert.equal((await api('GET', '/contexts/nope/namespaces')).json.code, 'kubectl.context_unknown');
  assert.equal((await api('GET', '/contexts/kind-dev/namespaces/-A/pods')).json.code, 'kubectl.namespace_invalid');
  assert.equal((await api('GET', `${B}/pods?selector=${encodeURIComponent('a; rm')}`)).json.code, 'kubectl.selector_invalid');
  assert.ok(calls().slice(before).every(a => a[0] === 'config'));
  // protezione dal pannello: salvata in config.json
  r = await api('PUT', '/contexts/kind-dev/protected', { protected: true });
  assert.deepEqual(srv.readConfig().kubectl.protected.sort(), ['kind-dev', 'prod-eks']);
  await api('PUT', '/contexts/kind-dev/protected', { protected: false });
});

test('watch: eventi ADDED, MODIFIED, DELETED già riassunti', async () => {
  // il watch non finisce da solo: si legge per un secondo e mezzo
  const ac = new AbortController();
  const res = await fetch(`http://127.0.0.1:${srv.port}/api/ext/kubectl${B}/pods/watch`, { signal: ac.signal });
  let text = '';
  const reader = res.body.getReader();
  setTimeout(() => ac.abort(), 1500);
  try { for (;;) { const { done, value } = await reader.read(); if (done) break; text += Buffer.from(value).toString(); } } catch { /* interrotto */ }
  const r = { events: parseSse(text) };
  const events = (r.events || []).filter(e => e.type === 'pod').map(e => [e.data.type, e.data.pod.name, e.data.pod.status]);
  assert.deepEqual(events.slice(0, 4), [['ADDED', 'api-7d4b9c-abcde', 'Running'], ['ADDED', 'worker-0', 'CrashLoopBackOff'], ['MODIFIED', 'worker-0', 'Running'], ['DELETED', 'api-7d4b9c-abcde', 'Running']]);
  assert.ok(calls().some(a => a.includes('-w') && a.includes('--output-watch-events')));
});

test('describe, log (container, tail, previous), modifiche e context protetto', async () => {
  let r = await api('GET', `${B}/describe/pod/worker-0`);
  assert.match(r.json.text, /Events:/);
  r = await api('GET', `${B}/pods/api-7d4b9c-abcde/logs?container=proxy&tail=2&previous=1`);
  assert.deepEqual(r.events.filter(e => e.type === 'stdout').map(e => e.data).join(''), 'riga 1 (precedente)\nriga 2 (precedente)\n');
  assert.deepEqual(calls().at(-1), ['logs', 'api-7d4b9c-abcde', '--context', 'kind-dev', '-n', 'shop', '-c', 'proxy', '--tail=2', '--previous']);
  assert.equal((await api('GET', `${B}/pods/worker-0/logs?container=${encodeURIComponent('--all')}`)).json.code, 'kubectl.container_invalid');
  r = await api('POST', `${B}/pods/worker-0/delete`, {});
  assert.equal(r.json.ok, true, r.text);
  assert.deepEqual(calls().at(-1), ['delete', 'pod', 'worker-0', '--context', 'kind-dev', '-n', 'shop', '--wait=false']);
  r = await api('POST', `${B}/workloads/deployment/api/scale`, { replicas: 5 });
  assert.deepEqual(calls().at(-1), ['scale', 'deployment/api', '--replicas=5', '--context', 'kind-dev', '-n', 'shop']);
  assert.equal((await api('POST', `${B}/workloads/pod/api/restart`, {})).json.code, 'kubectl.kind_invalid');
  // context protetto: senza il nome scritto, 428 e niente comando
  const n = calls().length;
  r = await api('POST', '/contexts/prod-eks/namespaces/shop/workloads/deployment/api/restart', {});
  assert.deepEqual([r.status, r.json.code], [428, 'kubectl.confirm_context']);
  assert.equal(calls().length - n, 0 + calls().slice(n).filter(a => a[0] === 'config').length);
  r = await api('POST', '/contexts/prod-eks/namespaces/shop/workloads/deployment/api/restart', { confirm: 'prod-eks' });
  assert.equal(r.json.ok, true, r.text);
  assert.deepEqual(calls().at(-1), ['rollout', 'restart', 'deployment/api', '--context', 'prod-eks', '-n', 'shop']);
});

test('trasporto Kubernetes port-forward nella sezione Tunnel', async () => {
  const tn = (m, p, body) => srv.request(m, `/api/ext/tunnels${p}`, body !== undefined ? { body } : {});
  let r = await tn('GET', '/state');
  assert.ok(r.json.transports.some(t => t.id === 'kubernetes' && t.extension === 'kubectl'));
  r = await tn('POST', '/transports/kubernetes/fields', { values: { context: 'kind-dev', namespace: 'shop', kind: 'service', resource: 'api' } });
  const f = Object.fromEntries(r.json.fields.map(x => [x.key, x]));
  assert.deepEqual(f.namespace.options.map(o => o.value), ['default', 'kube-system', 'shop']);
  assert.deepEqual(f.resource.options.map(o => o.value), ['api']);
  assert.deepEqual(f.port.options.map(o => o.value), [80]);
  // pod di un deployment: il deployment è ricordato; parametri non validi rifiutati
  assert.equal((await tn('POST', '/servers', { key: 'bad', label: 'B', port: 47001, transport: 'kubernetes', params: { context: 'kind-dev', namespace: 'shop', kind: 'pod', resource: 'x;y', port: 80 } })).json.code, 'kubectl.name_invalid');
  r = await tn('POST', '/servers', { key: 'k8s-api', label: 'API', port: 47002, transport: 'kubernetes', params: { context: 'kind-dev', namespace: 'shop', kind: 'pod', resource: 'api-7d4b9c-abcde', port: '8080' } });
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(srv.readConfig().servers.find(s => s.key === 'k8s-api').params, { context: 'kind-dev', namespace: 'shop', kind: 'pod', resource: 'api-7d4b9c-abcde', port: 8080, owner: 'api' });
  r = await tn('POST', '/tunnels', { serverKey: 'k8s-api' });
  const id = r.json.id;
  await until(async () => (await tn('GET', `/tunnels/${id}/logs`)).json.some(l => /Pronto su 127\.0\.0\.1:47002/.test(l.text)));
  assert.deepEqual(calls().filter(a => a[0] === 'port-forward').at(-1), ['port-forward', '--context', 'kind-dev', '-n', 'shop', 'pod/api-7d4b9c-abcde', '47002:8080', '--address', '127.0.0.1']);
  const answer = await new Promise((resolve, reject) => { const s = net.connect(47002, '127.0.0.1'); let d = ''; s.on('data', x => { d += x; }); s.on('end', () => resolve(d)); s.on('error', reject); });
  assert.equal(answer, 'ok pod/api-7d4b9c-abcde');
  await tn('DELETE', `/tunnels/${id}`);
  // pod sparito: il tentativo dopo va al deployment
  const cfg = srv.readConfig();
  cfg.servers.push({ key: 'k8s-gone', label: 'Gone', port: 47003, type: 'TCP', transport: 'kubernetes', transportFrom: 'kubectl', params: { context: 'kind-dev', namespace: 'shop', kind: 'pod', resource: 'gone', port: 8080, owner: 'api' } });
  await srv.request('POST', '/api/core/config/import', { body: { mode: 'replace', config: { servers: cfg.servers, groups: cfg.groups || [] } } });
  r = await tn('POST', '/tunnels', { serverKey: 'k8s-gone' });
  await until(async () => (await tn('GET', `/tunnels/${r.json.id}/logs`)).json.some(l => /Pronto su 127\.0\.0\.1:47003/.test(l.text)), 15000);
  assert.ok(calls().some(a => a[0] === 'port-forward' && a.includes('deployment/api') && a.includes('47003:8080')));
  await tn('DELETE', `/tunnels/${r.json.id}`);
});

test('strumenti MCP: context, namespace, pod senza ambiente, log con limite', async () => {
  let r = await mcp.callTool({ name: 'kubectl_contexts', arguments: {} });
  assert.deepEqual(r.structuredContent.contexts.map(c => c.name), ['kind-dev', 'prod-eks']);
  r = await mcp.callTool({ name: 'kubectl_pods', arguments: { context: 'kind-dev', namespace: 'shop' } });
  const p = r.structuredContent.pods[0];
  assert.equal(p.labels, undefined);
  assert.deepEqual(Object.keys(p.containers[0]).sort(), ['image', 'name']);
  r = await mcp.callTool({ name: 'kubectl_logs', arguments: { context: 'kind-dev', namespace: 'shop', pod: 'worker-0', lines: 5000 } });
  assert.equal(r.structuredContent.lines, 1000);
});
