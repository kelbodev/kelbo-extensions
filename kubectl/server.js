// kubectl: context del kubeconfig dell'utente (mai copiato), namespace, pod in diretta,
// describe, log, eliminazione, rollout restart e scale dei workload con conferma (i context
// "protetti" chiedono di scriverne il nome), e il trasporto "Kubernetes port-forward" per la
// sezione Tunnel (capacità tunnel-transport).
const kube = require('./kube');

const MAX_TAIL = 5000;
const CONTEXTS_TTL_MS = 10000;

module.exports = function createKubectl(ctx) {
  const k = kube.createKube({ bin: process.env.KELBO_KUBECTL || 'kubectl' });
  const fromKube = async fn => {
    try { return await fn(); } catch (e) {
      if (e instanceof kube.KubeError) throw ctx.error(e.key === 'not_found' ? 404 : e.key === 'kubectl_missing' ? 503 : e.key.endsWith('_invalid') ? 400 : 502, e.key, e.params);
      throw e;
    }
  };

  // ---- impostazioni: context protetti (sezione kubectl di config.json, esportabile) ----
  const settings = () => ctx.config.get('kubectl') || { protected: [] };
  const isProtected = c => (settings().protected || []).includes(c);
  const config = {
    kubectl: {
      empty: { protected: [] },
      validate(v) {
        if (!v || typeof v !== 'object' || Array.isArray(v) || !Array.isArray(v.protected) || v.protected.length > 200
          || !v.protected.every(c => typeof c === 'string' && kube.CONTEXT_RE.test(c))) throw ctx.error.config('settings_invalid');
      },
      merge: (cur, inc) => ({ protected: [...new Set([...(cur?.protected || []), ...(inc?.protected || [])])] }),
    },
  };

  // ---- letture ----
  let contextsCache = null;
  async function contexts({ fresh = false } = {}) {
    if (!fresh && contextsCache && Date.now() - contextsCache.at < CONTEXTS_TTL_MS) return contextsCache.data;
    const names = (await k.run(['config', 'get-contexts', '-o', 'name'])).split('\n').map(s => s.trim()).filter(c => kube.CONTEXT_RE.test(c));
    let current = null;
    try { current = (await k.run(['config', 'current-context'])).trim() || null; } catch { /* nessun context corrente */ }
    const data = { current, contexts: names.map(name => ({ name, current: name === current, protected: isProtected(name) })) };
    contextsCache = { at: Date.now(), data };
    return data;
  }
  // il context deve esistere nel kubeconfig
  async function knownContext(c) {
    kube.checkContext(c);
    if (!(await contexts()).contexts.some(x => x.name === c)) {
      if (!(await contexts({ fresh: true })).contexts.some(x => x.name === c)) throw new kube.KubeError('context_unknown', { context: c });
    }
    return c;
  }
  async function namespaces(c) {
    const data = await k.json(['get', 'namespaces', ...kube.scope(await knownContext(c))]);
    return (data.items || []).map(n => n.metadata?.name).filter(Boolean).sort();
  }
  async function pods(c, ns, { selector = null } = {}) {
    if (selector != null && (typeof selector !== 'string' || selector.length > 300 || !/^[A-Za-z0-9._\/=!,\s()-]+$/.test(selector))) throw new kube.KubeError('selector_invalid');
    const data = await k.json(['get', 'pods', ...kube.scope(await knownContext(c), ns), ...(selector ? ['-l', selector] : [])]);
    return (data.items || []).map(kube.podSummary);
  }
  async function workloads(c, ns) {
    const data = await k.json(['get', 'deployments,statefulsets', ...kube.scope(await knownContext(c), ns)]);
    return (data.items || []).map(kube.workloadSummary);
  }
  async function services(c, ns) {
    const data = await k.json(['get', 'services', ...kube.scope(await knownContext(c), ns)]);
    return (data.items || []).map(kube.serviceSummary);
  }

  // Modifiche: nel context protetto serve il suo nome scritto per conferma
  function checkConfirm(c, confirm) {
    if (isProtected(c) && confirm !== c) throw ctx.error(428, 'confirm_context', { context: c });
  }

  // ---- trasporto "Kubernetes port-forward" per la sezione Tunnel ----
  const followed = new Set(); // tunnel di un pod sparito che ora puntano al deployment
  const transport = {
    // context → namespace → tipo → risorsa → porta; ogni lista dipende dai campi prima
    async fields(v) {
      const list = async fn => { try { return await fn(); } catch { return null; } };
      const ctxs = await list(async () => (await contexts()).contexts.map(c => ({ value: c.name, label: c.protected ? `${c.name} 🔒` : c.name })));
      const nss = v.context ? await list(async () => (await namespaces(v.context)).map(n => ({ value: n, label: n }))) : [];
      let resources = [], ports = [];
      if (v.context && v.namespace && v.kind) {
        if (v.kind === 'pod') {
          const items = await list(() => pods(v.context, v.namespace)) || [];
          resources = items.map(p => ({ value: p.name, label: `${p.name} (${p.status})` }));
          const pod = items.find(p => p.name === v.resource);
          ports = pod ? pod.containers.flatMap(c => c.ports.map(x => ({ value: x.port, label: `${x.port}${x.name ? ` (${x.name})` : ''} · ${c.name}` }))) : [];
        } else if (v.kind === 'service') {
          const items = await list(() => services(v.context, v.namespace)) || [];
          resources = items.map(s => ({ value: s.name, label: `${s.name} (${s.type})` }));
          const svc = items.find(s => s.name === v.resource);
          ports = svc ? svc.ports.map(x => ({ value: x.port, label: `${x.port}${x.name ? ` (${x.name})` : ''}` })) : [];
        } else {
          const items = (await list(() => workloads(v.context, v.namespace)) || []).filter(w => w.kind === v.kind);
          resources = items.map(w => ({ value: w.name, label: `${w.name} (${w.ready}/${w.replicas})` }));
          const w = items.find(x => x.name === v.resource);
          ports = w ? w.ports.map(x => ({ value: x.port, label: `${x.port}${x.name ? ` (${x.name})` : ''} · ${x.container}` })) : [];
        }
      }
      return [
        { key: 'context', label: { it: 'Context', en: 'Context' }, type: 'select', required: true, options: ctxs || [], empty: { it: 'kubectl non risponde', en: 'kubectl does not answer' } },
        { key: 'namespace', label: { it: 'Namespace', en: 'Namespace' }, type: 'select', required: true, dependsOn: ['context'], options: nss || [] },
        { key: 'kind', label: { it: 'Tipo', en: 'Kind' }, type: 'select', required: true, dependsOn: ['context', 'namespace'],
          options: [{ value: 'service', label: 'Service' }, { value: 'deployment', label: 'Deployment' }, { value: 'statefulset', label: 'StatefulSet' }, { value: 'pod', label: 'Pod' }],
          hint: { it: 'Service o deployment sopravvivono alla sostituzione dei pod', en: 'A service or deployment survives pod replacement' } },
        { key: 'resource', label: { it: 'Risorsa', en: 'Resource' }, type: 'select', required: true, dependsOn: ['context', 'namespace', 'kind'], options: resources },
        { key: 'port', label: { it: 'Porta remota', en: 'Remote port' }, type: ports.length ? 'select' : 'number', required: true, dependsOn: ['resource'], options: ports },
      ];
    },
    async validate(p) {
      return fromKube(async () => {
        const out = {
          context: await knownContext(p.context), namespace: kube.checkNamespace(p.namespace),
          kind: kube.checkKind(p.kind), resource: kube.checkName(p.resource), port: kube.checkPort(p.port),
        };
        // pod di un deployment: si ricorda il deployment, per seguirlo quando il pod viene sostituito
        if (out.kind === 'pod') {
          try { const d = kube.deploymentOf(await k.json(['get', 'pod', out.resource, ...kube.scope(out.context, out.namespace)])); if (d) out.owner = d; } catch { /* pod non leggibile ora */ }
        }
        return out;
      });
    },
    describe: p => `${p.kind}/${p.resource}:${p.port} · ${p.context}/${p.namespace}`,
    start(p, localPort, { onOutput, onReady, onExit }) {
      const key = `${p.context}\0${p.namespace}\0${p.resource}`;
      const target = p.kind === 'pod' && p.owner && followed.has(key) ? `deployment/${p.owner}` : `${p.kind}/${p.resource}`;
      let output = '';
      const child = k.stream(['port-forward', ...kube.scope(p.context, p.namespace), target, `${Number(localPort)}:${Number(p.port)}`, '--address', '127.0.0.1'], {
        onData: text => {
          output = (output + text).slice(-4000);
          onOutput(text);
          if (/Forwarding from 127\.0\.0\.1:/.test(text)) onReady();
        },
        onExit: code => {
          // pod sparito (sostituito dal deployment): i tentativi dopo vanno al deployment
          if (p.kind === 'pod' && p.owner && !followed.has(key) && /not ?found/i.test(output)) {
            followed.add(key);
            onOutput(`→ deployment/${p.owner}\n`);
          }
          onExit(code);
        },
      });
      return { pid: child.pid, stop: force => child.kill(force ? 'SIGKILL' : 'SIGTERM') };
    },
  };

  // ---- route ----
  const q = req => req.params;
  const handlers = {
    async contexts(req, res) { res.json(await fromKube(() => contexts({ fresh: !!req.query.refresh }))); },
    async setProtected(req, res) {
      const c = await fromKube(() => knownContext(req.params.context));
      const on = req.body?.protected === true;
      const list = new Set(settings().protected || []);
      if (on) list.add(c); else list.delete(c);
      ctx.config.set('kubectl', { protected: [...list] });
      contextsCache = null;
      res.json({ context: c, protected: on });
    },
    async namespaces(req, res) { res.json({ namespaces: await fromKube(() => namespaces(q(req).context)) }); },
    async pods(req, res) {
      res.json({ pods: await fromKube(() => pods(q(req).context, q(req).namespace, { selector: req.query.selector ? String(req.query.selector) : null })) });
    },
    async workloads(req, res) { res.json({ workloads: await fromKube(() => workloads(q(req).context, q(req).namespace)) }); },
    async services(req, res) { res.json({ services: await fromKube(() => services(q(req).context, q(req).namespace)) }); },

    // Pod in diretta: eventi ADDED/MODIFIED/DELETED di kubectl get -w, già riassunti
    async watch(req, res) {
      const { context: c, namespace: ns } = q(req);
      await fromKube(() => knownContext(c));
      fromKubeSync(() => kube.checkNamespace(ns));
      const send = ctx.sse(res);
      const parse = kube.jsonStreamParser(ev => {
        if (ev?.type && ev.object?.kind === 'Pod') send('pod', { type: ev.type, pod: kube.podSummary(ev.object) });
      });
      let errText = '';
      const child = k.stream(['get', 'pods', ...kube.scope(c, ns), '-w', '-o', 'json', '--output-watch-events'], {
        onData: (text, kind) => { if (kind === 'out') parse(text); else errText = (errText + text).slice(-2000); },
        onExit: code => { send('end', { code, error: code ? errText.trim() : null }); send.end(); },
      });
      req.on('close', () => { try { child.kill(); } catch { /* già uscito */ } });
    },

    async describe(req, res) {
      const { context: c, namespace: ns, kind, name } = q(req);
      const text = await fromKube(async () => k.run(['describe', kube.checkKind(kind), kube.checkName(name), ...kube.scope(await knownContext(c), ns)]));
      res.json({ text });
    },

    // Log: ?container=&tail=&previous=1&follow=1 (follow: in streaming finché la pagina ascolta)
    async logs(req, res) {
      const { context: c, namespace: ns, name } = q(req);
      const args = await fromKube(async () => {
        const a = ['logs', kube.checkName(name), ...kube.scope(await knownContext(c), ns)];
        if (req.query.container) a.push('-c', kube.checkContainer(String(req.query.container)));
        const tail = Math.min(Math.max(parseInt(req.query.tail) || 200, 1), MAX_TAIL);
        a.push(`--tail=${tail}`);
        if (req.query.previous === '1') a.push('--previous');
        if (req.query.follow === '1') a.push('-f');
        return a;
      });
      const send = ctx.sse(res);
      const child = k.stream(args, {
        onData: (text, kind) => send(kind === 'out' ? 'stdout' : 'stderr', text),
        onExit: code => { send('exit', code); send.end(); },
      });
      req.on('close', () => { try { child.kill(); } catch { /* già uscito */ } });
    },

    async deletePod(req, res) {
      const { context: c, namespace: ns, name } = q(req);
      await fromKube(async () => { await knownContext(c); kube.checkNamespace(ns); kube.checkName(name); });
      checkConfirm(c, req.body?.confirm);
      const out = await fromKube(() => k.run(['delete', 'pod', name, ...kube.scope(c, ns), '--wait=false']));
      res.json({ ok: true, output: out.trim() });
    },
    async restart(req, res) {
      const { context: c, namespace: ns, kind, name } = q(req);
      const target = await fromKube(async () => { await knownContext(c); kube.checkNamespace(ns); if (!['deployment', 'statefulset'].includes(kind)) throw new kube.KubeError('kind_invalid', { kind }); return `${kind}/${kube.checkName(name)}`; });
      checkConfirm(c, req.body?.confirm);
      const out = await fromKube(() => k.run(['rollout', 'restart', target, ...kube.scope(c, ns)]));
      res.json({ ok: true, output: out.trim() });
    },
    async scale(req, res) {
      const { context: c, namespace: ns, kind, name } = q(req);
      const replicas = Number(req.body?.replicas);
      if (!Number.isInteger(replicas) || replicas < 0 || replicas > 1000) throw ctx.error(400, 'replicas_invalid');
      const target = await fromKube(async () => { await knownContext(c); kube.checkNamespace(ns); if (!['deployment', 'statefulset'].includes(kind)) throw new kube.KubeError('kind_invalid', { kind }); return `${kind}/${kube.checkName(name)}`; });
      checkConfirm(c, req.body?.confirm);
      const out = await fromKube(() => k.run(['scale', target, `--replicas=${replicas}`, ...kube.scope(c, ns)]));
      res.json({ ok: true, output: out.trim() });
    },
  };
  function fromKubeSync(fn) {
    try { return fn(); } catch (e) { if (e instanceof kube.KubeError) throw ctx.error(400, e.key, e.params); throw e; }
  }

  return {
    config,
    providers: { portForward: transport },
    handlers,

    // Strumenti MCP in sola lettura: niente secret né valori dell'ambiente dei container
    mcp: {
      contexts: () => fromKube(() => contexts({ fresh: true })),
      async namespaces({ context }) { return { context, namespaces: await fromKube(() => namespaces(context)) }; },
      async pods({ context, namespace, selector }) {
        const list = await fromKube(() => pods(context, namespace, { selector: selector || null }));
        return { context, namespace, pods: list.map(({ labels, containers, ...p }) => ({ ...p, containers: containers.map(c => ({ name: c.name, image: c.image })) })) };
      },
      async logs({ context, namespace, pod, container, lines = 100, previous = false }) {
        const n = Math.min(Math.max(parseInt(lines) || 100, 1), 1000);
        const out = await fromKube(async () => k.run(['logs', kube.checkName(pod), ...kube.scope(await knownContext(context), namespace),
          ...(container ? ['-c', kube.checkContainer(container)] : []), `--tail=${n}`, ...(previous ? ['--previous'] : [])]));
        return { context, namespace, pod, lines: n, output: out };
      },
    },

    shutdown() { k.stopAll(); },
  };
};
