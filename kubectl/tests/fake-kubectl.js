#!/usr/bin/env node
// kubectl finto per i test: registra gli argomenti (FAKE_KUBECTL_LOG) e risponde come quello vero
// (JSON di get, eventi di get -w --output-watch-events, NotFound, port-forward che ascolta)
const fs = require('fs');
const args = process.argv.slice(2);
if (process.env.FAKE_KUBECTL_LOG) fs.appendFileSync(process.env.FAKE_KUBECTL_LOG, JSON.stringify(args) + '\n');
const opt = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
const context = opt('--context');
const ns = opt('-n');
const out = v => process.stdout.write(typeof v === 'string' ? v : JSON.stringify(v));
const notFound = (kind, name) => { process.stderr.write(`Error from server (NotFound): ${kind} "${name}" not found\n`); process.exit(1); };

const pod = (name, extra = {}) => ({
  kind: 'Pod', apiVersion: 'v1',
  metadata: { name, namespace: ns, creationTimestamp: '2026-11-13T08:00:00Z', labels: { app: name.split('-')[0], ...(extra.labels || {}) }, ...(extra.meta || {}) },
  spec: { nodeName: 'node-1', containers: [{ name: 'app', image: 'example/app:1', ports: [{ containerPort: 8080, name: 'http', protocol: 'TCP' }] }, ...(extra.sidecar ? [{ name: 'proxy', image: 'proxy:1' }] : [])] },
  status: extra.status || { phase: 'Running', podIP: '10.0.0.5', containerStatuses: [{ name: 'app', ready: true, restartCount: 0, state: { running: {} } }] },
});
const PODS = [
  pod('api-7d4b9c-abcde', { labels: { 'pod-template-hash': '7d4b9c' }, meta: { ownerReferences: [{ kind: 'ReplicaSet', name: 'api-7d4b9c' }] }, sidecar: true,
    status: { phase: 'Running', containerStatuses: [{ name: 'app', ready: true, restartCount: 1, state: { running: {} } }, { name: 'proxy', ready: true, restartCount: 0, state: { running: {} } }] } }),
  pod('worker-0', { status: { phase: 'Running', containerStatuses: [{ name: 'app', ready: false, restartCount: 7, state: { waiting: { reason: 'CrashLoopBackOff' } } }] } }),
];

const [cmd, what, name] = args.filter(a => !a.startsWith('-') && a !== context && a !== ns);
if (cmd === 'config' && what === 'get-contexts') { out('kind-dev\nprod-eks\n'); process.exit(0); }
if (cmd === 'config' && what === 'current-context') { out('kind-dev\n'); process.exit(0); }
if (context && !['kind-dev', 'prod-eks'].includes(context)) { process.stderr.write(`error: context "${context}" does not exist\n`); process.exit(1); }

if (cmd === 'get' && what === 'namespaces') { out({ kind: 'List', items: ['default', 'shop', 'kube-system'].map(n => ({ metadata: { name: n } })) }); process.exit(0); }
if (cmd === 'get' && what === 'pods' && args.includes('-w')) {
  const ev = (type, object) => out(JSON.stringify({ type, object }, null, 2) + '\n');
  for (const p of PODS) ev('ADDED', p);
  setTimeout(() => ev('MODIFIED', pod('worker-0')), 300);
  setTimeout(() => ev('DELETED', PODS[0]), 600);
  setInterval(() => {}, 1000);
} else if (cmd === 'get' && what === 'pods') { out({ kind: 'List', items: PODS }); process.exit(0); }
else if (cmd === 'get' && what === 'pod') { const p = PODS.find(x => x.metadata.name === name); if (!p) notFound('pods', name); out(p); process.exit(0); }
else if (cmd === 'get' && what === 'deployments,statefulsets') {
  out({ kind: 'List', items: [
    { kind: 'Deployment', metadata: { name: 'api', creationTimestamp: '2026-11-01T00:00:00Z' }, spec: { replicas: 3, template: { spec: { containers: [{ name: 'app', ports: [{ containerPort: 8080, name: 'http' }] }] } } }, status: { readyReplicas: 2, updatedReplicas: 3, availableReplicas: 2 } },
    { kind: 'StatefulSet', metadata: { name: 'worker', creationTimestamp: '2026-11-01T00:00:00Z' }, spec: { replicas: 1, template: { spec: { containers: [{ name: 'app' }] } } }, status: { readyReplicas: 0 } },
  ] });
  process.exit(0);
} else if (cmd === 'get' && what === 'services') { out({ kind: 'List', items: [{ metadata: { name: 'api' }, spec: { type: 'ClusterIP', ports: [{ port: 80, name: 'http', targetPort: 8080 }] } }] }); process.exit(0); }
else if (cmd === 'describe') { out(`Name:         ${name}\nNamespace:    ${ns}\nEvents:\n  Normal  Pulled  1m  kubelet  Container image pulled\n`); process.exit(0); }
else if (cmd === 'logs') {
  if (!PODS.some(p => p.metadata.name === what)) notFound('pods', what);
  const tail = Number((args.find(a => a.startsWith('--tail=')) || '--tail=10').split('=')[1]);
  for (let i = 1; i <= Math.min(tail, 3); i++) out(`riga ${i}${args.includes('--previous') ? ' (precedente)' : ''}\n`);
  if (args.includes('-f')) { let n = 0; setInterval(() => out(`segue ${++n}\n`), 200); } else process.exit(0);
}
else if (cmd === 'delete') { out(`pod "${name}" deleted\n`); process.exit(0); }
else if (cmd === 'rollout') { out(`${name} restarted\n`); process.exit(0); }
else if (cmd === 'scale') { out(`${what} scaled\n`); process.exit(0); }
else if (cmd === 'port-forward') {
  const [target, ports] = [what, name];
  const [local, remote] = ports.split(':').map(Number);
  if (target === 'pod/gone') notFound('pods', 'gone');
  require('net').createServer(c => c.end(`ok ${target}`)).listen(local, '127.0.0.1', () => out(`Forwarding from 127.0.0.1:${local} -> ${remote}\n`));
}
else { process.stderr.write(`fake kubectl: comando sconosciuto ${args.join(' ')}\n`); process.exit(1); }
