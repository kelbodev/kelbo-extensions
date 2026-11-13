// kubectl della macchina: esecuzione senza shell con --context e -n sempre espliciti, nomi
// controllati prima di arrivare al comando, lettura del JSON di kubectl (pod, workload, servizi,
// porte) e degli eventi di "get -w -o json --output-watch-events" in streaming.
const { execFile, spawn } = require('child_process');

const TIMEOUT_MS = 30000;
const MAX_BUFFER = 64 * 1024 * 1024;
// nomi dei context: quelli di kind, minikube, GKE (gke_…), EKS (arn:aws:eks:…:cluster/x), AKS
const CONTEXT_RE = /^[A-Za-z0-9][A-Za-z0-9._:@\/+-]{0,252}$/;
// nomi delle risorse Kubernetes (DNS-1123 subdomain) e dei container/namespace (label)
const NAME_RE = /^[a-z0-9]([-a-z0-9.]{0,251}[a-z0-9])?$/;
const LABEL_RE = /^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$/;
const KINDS = { pod: 'pod', service: 'service', deployment: 'deployment', statefulset: 'statefulset' };

class KubeError extends Error {
  constructor(name, params = {}, output = '') { super(name); this.key = name; this.params = params; this.output = output; }
}
const fail = (name, params, output) => { throw new KubeError(name, params, output); };

const checkContext = c => { if (typeof c !== 'string' || !CONTEXT_RE.test(c)) fail('context_invalid', { context: String(c ?? '') }); return c; };
const checkNamespace = n => { if (typeof n !== 'string' || !LABEL_RE.test(n)) fail('namespace_invalid', { namespace: String(n ?? '') }); return n; };
const checkName = n => { if (typeof n !== 'string' || !NAME_RE.test(n)) fail('name_invalid', { name: String(n ?? '') }); return n; };
const checkContainer = n => { if (typeof n !== 'string' || !LABEL_RE.test(n)) fail('container_invalid', { container: String(n ?? '') }); return n; };
const checkKind = k => { if (!KINDS[k]) fail('kind_invalid', { kind: String(k ?? '') }); return KINDS[k]; };
const checkPort = p => { const n = Number(p); if (!Number.isInteger(n) || n < 1 || n > 65535) fail('port_invalid', { port: String(p ?? '') }); return n; };

// argomenti comuni: context e namespace sempre espliciti (mai quelli correnti del kubeconfig)
const scope = (context, namespace) => ['--context', checkContext(context), ...(namespace ? ['-n', checkNamespace(namespace)] : [])];

function createKube({ bin = 'kubectl', env = {} } = {}) {
  const children = new Set();
  const procEnv = () => ({ ...process.env, ...env, KUBECTL_EXTERNAL_DIFF: '' });

  // kubectl args → stdout; errori con l'output di kubectl (stderr) come parametro
  function run(args, { timeout = TIMEOUT_MS } = {}) {
    return new Promise((resolve, reject) => {
      execFile(bin, args, { timeout, maxBuffer: MAX_BUFFER, env: procEnv(), windowsHide: true }, (err, stdout, stderr) => {
        if (err) {
          if (err.code === 'ENOENT') return reject(new KubeError('kubectl_missing'));
          const output = String(stderr || '').trim() || err.message;
          return reject(new KubeError(/not found/i.test(output) ? 'not_found' : 'kubectl_failed', { output: output.slice(-2000) }, output));
        }
        resolve(String(stdout));
      });
    });
  }
  const json = async args => {
    const out = await run([...args, '-o', 'json']);
    try { return JSON.parse(out); } catch { throw new KubeError('kubectl_failed', { output: 'JSON non valido' }); }
  };

  // Processo lungo (watch, log -f, port-forward): stdout/stderr a pezzi, chiuso allo spegnimento
  function stream(args, { onData, onExit }) {
    const child = spawn(bin, args, { env: procEnv(), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    children.add(child);
    child.stdout.on('data', d => onData?.(String(d), 'out'));
    child.stderr.on('data', d => onData?.(String(d), 'err'));
    child.on('error', e => onData?.(e.code === 'ENOENT' ? 'kubectl non trovato\n' : `${e.message}\n`, 'err'));
    child.on('close', code => { children.delete(child); onExit?.(code); });
    return child;
  }
  const stopAll = () => { for (const c of children) { try { c.kill(); } catch { /* già uscito */ } } };

  return { run, json, stream, stopAll, bin };
}

// ---- lettura del JSON di kubectl ----

// "x/y" pronti, riavvii, stato come lo mostra kubectl get pods (CrashLoopBackOff, Completed…)
function podSummary(p) {
  const st = p.status || {};
  const statuses = st.containerStatuses || [];
  const total = (p.spec?.containers || []).length;
  const ready = statuses.filter(c => c.ready).length;
  const restarts = statuses.reduce((n, c) => n + (c.restartCount || 0), 0);
  let status = st.reason || st.phase || 'Unknown';
  for (const c of statuses) {
    const reason = c.state?.waiting?.reason || c.state?.terminated?.reason;
    if (reason && !(c.state?.terminated && reason === 'Completed' && st.phase === 'Running')) { status = reason; break; }
  }
  if (p.metadata?.deletionTimestamp) status = 'Terminating';
  const owner = (p.metadata?.ownerReferences || [])[0] || null;
  return {
    name: p.metadata?.name, namespace: p.metadata?.namespace, status, phase: st.phase || null,
    ready: `${ready}/${total}`, readyCount: ready, total, restarts,
    createdAt: p.metadata?.creationTimestamp || null, node: p.spec?.nodeName || null, ip: st.podIP || null,
    labels: p.metadata?.labels || {},
    containers: (p.spec?.containers || []).map(c => ({ name: c.name, image: c.image, ports: (c.ports || []).map(x => ({ port: x.containerPort, name: x.name || null, protocol: x.protocol || 'TCP' })) })),
    owner: owner ? { kind: owner.kind, name: owner.name } : null,
    deployment: deploymentOf(p),
  };
}
// Deployment di un pod: il ReplicaSet proprietario senza il suffisso pod-template-hash
function deploymentOf(p) {
  const owner = (p.metadata?.ownerReferences || []).find(o => o.kind === 'ReplicaSet');
  const hash = p.metadata?.labels?.['pod-template-hash'];
  if (!owner || !hash || !owner.name.endsWith(`-${hash}`)) return null;
  return owner.name.slice(0, -(hash.length + 1));
}

function workloadSummary(w) {
  const kind = w.kind;
  const spec = w.spec || {}, st = w.status || {};
  return {
    kind: kind === 'StatefulSet' ? 'statefulset' : 'deployment', name: w.metadata?.name,
    replicas: spec.replicas ?? 0, ready: st.readyReplicas || 0, updated: st.updatedReplicas || 0, available: st.availableReplicas || 0,
    createdAt: w.metadata?.creationTimestamp || null,
    ports: (spec.template?.spec?.containers || []).flatMap(c => (c.ports || []).map(x => ({ port: x.containerPort, name: x.name || null, container: c.name }))),
  };
}

function serviceSummary(s) {
  return {
    name: s.metadata?.name, type: s.spec?.type || 'ClusterIP',
    ports: (s.spec?.ports || []).map(x => ({ port: x.port, name: x.name || null, protocol: x.protocol || 'TCP', targetPort: x.targetPort ?? null })),
  };
}

// Oggetti JSON concatenati (kubectl get -w -o json): li restituisce appena sono completi
function jsonStreamParser(onObject) {
  let buf = '', depth = 0, inStr = false, esc = false, start = -1;
  return chunk => {
    for (const ch of chunk) {
      buf += ch;
      if (inStr) { if (esc) esc = false; else if (ch === '\\') esc = true; else if (ch === '"') inStr = false; continue; }
      if (ch === '"') { inStr = true; continue; }
      if (ch === '{') { if (depth === 0) start = buf.length - 1; depth++; }
      else if (ch === '}') {
        depth--;
        if (depth === 0 && start >= 0) {
          const text = buf.slice(start);
          buf = ''; start = -1;
          try { onObject(JSON.parse(text)); } catch { /* oggetto rotto: saltato */ }
        }
      }
      if (depth === 0 && buf.length > 1024 * 1024) buf = '';
    }
  };
}

module.exports = {
  createKube, KubeError, CONTEXT_RE, NAME_RE, LABEL_RE, KINDS,
  checkContext, checkNamespace, checkName, checkContainer, checkKind, checkPort, scope,
  podSummary, workloadSummary, serviceSummary, deploymentOf, jsonStreamParser,
};
