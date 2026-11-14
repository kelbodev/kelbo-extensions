// Docker: container e progetti compose della macchina (stato in diretta da docker events, log,
// azioni, statistiche), comandi compose come job con l'output in streaming, file compose dei
// progetti di Kelbo analizzati (problemi con correzioni, porte occupate sulla macchina, variabili
// mancanti) e modificati dall'editor visuale senza perdere commenti; il trasporto "Container Docker"
// per la sezione Tunnel (sidecar socat sulla rete del container) e le connessioni database dai
// container dei database.
const crypto = require('crypto');
const fs = require('fs');
const net = require('net');
const path = require('path');
const dk = require('./docker');
const cp = require('./compose');
const templates = require('./templates');

const MAX_TAIL = 5000;
const MAX_JOBS = 20;
const MAX_JOB_OUTPUT = 512 * 1024;
const MAX_FILE = 1024 * 1024;
const PORTS_TTL_MS = 3000;
const FORWARD_IMAGE = 'alpine/socat:1.8.0.3';
const ACTIONS = { start: ['start'], stop: ['stop'], restart: ['restart'], pause: ['pause'], unpause: ['unpause'], remove: ['rm'] };
const COMPOSE_ACTIONS = ['up', 'down', 'stop', 'start', 'restart', 'pull', 'build'];

module.exports = function createDocker(ctx) {
  const d = dk.createDocker({ bin: process.env.KELBO_DOCKER || 'docker' });
  const fromDocker = async fn => {
    try { return await fn(); } catch (e) { throw toApi(e); }
  };
  function toApi(e) {
    if (e instanceof dk.DockerError) return ctx.error(e.key === 'not_found' ? 404 : e.key === 'docker_missing' || e.key === 'daemon_down' ? 503 : e.key.endsWith('_invalid') ? 400 : 502, e.key, e.params);
    if (e instanceof cp.ComposeError) return ctx.error(e.key === 'service_missing' ? 404 : e.key === 'service_exists' ? 409 : 400, e.key, e.params);
    return e;
  }
  const sync = fn => { try { return fn(); } catch (e) { throw toApi(e); } };

  // ---- file compose dei progetti ----
  function projectOf(id) {
    const p = typeof id === 'string' ? ctx.projects.get(id) : null;
    if (!p) throw ctx.error(404, 'project_not_found', { project: String(id ?? '') });
    return p;
  }
  // file dentro la cartella del progetto, con il nome di un compose, al massimo una cartella sotto
  function fileOf(projectId, rel) {
    const p = projectOf(projectId);
    if (typeof rel !== 'string' || rel.length > 300 || rel.includes('\\') || rel.split('/').some(x => !x || x === '.' || x === '..') || rel.split('/').length > 2 || !cp.FILE_RE.test(path.basename(rel))) {
      throw ctx.error(400, 'file_invalid', { file: String(rel ?? '') });
    }
    const abs = path.join(p.path, rel);
    if (path.relative(p.path, abs).startsWith('..')) throw ctx.error(400, 'file_invalid', { file: rel });
    return { project: p, rel, abs, dir: path.dirname(abs) };
  }
  const hashOf = text => crypto.createHash('sha1').update(text).digest('hex');
  function readFile(f) {
    let st;
    try { st = fs.statSync(f.abs); } catch { return null; }
    if (st.size > MAX_FILE) throw ctx.error(413, 'file_too_large', { file: f.rel });
    return fs.readFileSync(f.abs, 'utf8');
  }
  function files() {
    return ctx.projects.list().flatMap(p => {
      let found = [];
      try { found = cp.findComposeFiles(p.path); } catch { /* cartella sparita */ }
      return found.map(rel => ({ projectId: p.id, projectLabel: p.label, file: rel, path: path.join(p.path, rel), base: cp.BASE_NAMES.includes(path.basename(rel)), override: /\.override\.ya?ml$/.test(rel) }));
    });
  }

  // ---- porte occupate sulla macchina (per l'analisi), con una cache breve ----
  let portsCache = null;
  async function listening() {
    if (portsCache && Date.now() - portsCache.at < PORTS_TTL_MS) return portsCache.map;
    const map = new Map();
    try { for (const p of await ctx.lib.ports.listListeningPorts()) if (!map.has(p.port)) map.set(p.port, { name: p.name, pid: p.pid }); } catch { /* lsof/ss assenti */ }
    portsCache = { at: Date.now(), map };
    return map;
  }
  async function containersSafe() { try { return await d.containers(); } catch { return null; } }

  // Analisi di un testo compose: YAML, variabili (.env della cartella, poi l'ambiente), unione con
  // l'override o il principale, modello, problemi, stato dei servizi in esecuzione
  async function analyzeText(f, text) {
    const doc = cp.parseDoc(text);
    const yamlErrors = cp.yamlErrors(doc);
    let dotenv = {};
    try { dotenv = cp.parseDotenv(fs.readFileSync(path.join(f.dir, '.env'), 'utf8')); } catch { /* nessun .env */ }
    const env = { ...dotenv, ...process.env };
    const variables = { missing: [], required: [], invalid: [] };
    const report = {
      missing: n => { if (!variables.missing.includes(n)) variables.missing.push(n); },
      required: (n, m) => { if (!variables.required.some(x => x.name === n)) variables.required.push({ name: n, message: m }); },
      invalid: s => { if (variables.invalid.length < 20) variables.invalid.push(s); },
    };
    const raw = yamlErrors.length ? {} : (doc.toJS({ maxAliasCount: 1000 }) || {});
    if (raw && (typeof raw !== 'object' || Array.isArray(raw))) yamlErrors.push({ message: 'root', line: 1, col: 1 });
    // file completato dall'altro (principale + override), come lo vede docker compose
    let combined = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    let companion = null;
    const other = cp.overrideOf(f.abs) || cp.baseOf(f.abs);
    if (other && !yamlErrors.length) {
      try {
        const o = cp.parseDoc(fs.readFileSync(other, 'utf8'));
        if (!o.errors.length) {
          const ojs = o.toJS() || {};
          combined = cp.overrideOf(f.abs) ? cp.mergeCompose(combined, ojs) : cp.mergeCompose(ojs, combined);
          companion = path.relative(f.project.path, other).split(path.sep).join('/');
        }
      } catch { /* illeggibile: solo questo file */ }
    }
    const model = cp.normalize(cp.interpolateTree(combined, env, report));
    // valori dell'ambiente che vengono da variabili (non sono segreti scritti nel file)
    const rawModel = cp.normalize(combined);
    for (const s of model.services) {
      const r = rawModel.services.find(x => x.name === s.name);
      s.rawEnvVars = new Set(Object.entries(r?.environment || {}).filter(([, v]) => v != null && String(v).includes('$')).map(([k]) => k));
    }
    // container di questo file (dalle etichette di compose) e porte degli altri container
    const all = await containersSafe();
    const files = [f.abs, ...(other ? [other] : [])];
    const own = (all || []).filter(c => c.compose && c.compose.configFiles.some(x => files.includes(x)));
    const projectName = own[0]?.compose.project || model.name || defaultProjectName(f.dir);
    const ownPorts = new Set(own.flatMap(c => c.ports.map(p => p.hostPort)));
    const containerPorts = new Map();
    for (const c of all || []) if (!own.includes(c) && c.state === 'running') for (const p of c.ports) containerPorts.set(p.hostPort, c.name);
    const list = await listening();
    // porte dei container: occupate da docker-proxy o dal runtime, già segnalate per container
    const procs = new Map([...list].filter(([port]) => !ownPorts.has(port) && !containerPorts.has(port)));
    const issues = yamlErrors.length ? [] : cp.analyze(model, { dir: f.dir, listening: procs, ownPorts, containerPorts, variables });
    const running = {};
    for (const c of own) {
      const s = c.compose.service;
      (running[s] ||= []).push({ name: c.name, id: c.id, state: c.state, health: c.health, exitCode: c.exitCode, ports: c.ports, startedAt: c.startedAt });
    }
    for (const s of model.services) delete s.rawEnvVars;
    // valori grezzi dei servizi di questo file, per l'editor (senza interpolazione né override)
    const rawServices = raw && typeof raw === 'object' && raw.services && typeof raw.services === 'object' ? raw.services : {};
    return {
      model, issues, yamlErrors, variables, running, projectName, companion,
      daemon: all !== null, rawServices, variablesUsed: cp.variablesIn(text), dotenv: Object.keys(dotenv),
    };
  }
  const defaultProjectName = dir => path.basename(dir).toLowerCase().replace(/[^a-z0-9_-]/g, '');

  async function usedPorts(model) {
    const used = new Set((await listening()).keys());
    for (const s of model?.services || []) for (const p of s.ports) for (const n of cp.publishedNumbers(p)) used.add(n);
    return used;
  }

  // Modifiche dell'editor: operazioni sul documento, testo di nuovo
  async function edit(f, text, ops) {
    if (!Array.isArray(ops) || ops.length > 50) throw ctx.error(400, 'ops_invalid');
    const doc = cp.parseDoc(text);
    if (doc.errors.length) throw ctx.error(400, 'yaml_invalid', { message: cp.yamlErrors(doc)[0].message });
    let added = null;
    for (const op of ops) {
      if (!op || typeof op !== 'object') throw ctx.error(400, 'ops_invalid');
      sync(() => {
        switch (op.op) {
          case 'setService': cp.setService(doc, op.name, op.service); break;
          case 'renameService': cp.renameService(doc, op.from, op.to); break;
          case 'removeService': cp.removeService(doc, op.name); break;
          case 'declare': if (!['volumes', 'networks'].includes(op.kind)) throw new cp.ComposeError('ops_invalid'); cp.declare(doc, op.kind, op.name); break;
          case 'undeclare': if (!['volumes', 'networks'].includes(op.kind)) throw new cp.ComposeError('ops_invalid'); cp.undeclare(doc, op.kind, op.name); break;
          case 'removeVersion': doc.delete('version'); break;
          case 'setName': if (op.name) { if (!dk.PROJECT_RE.test(op.name)) throw new cp.ComposeError('name_invalid', { name: op.name }); doc.set('name', op.name); } else doc.delete('name'); break;
          default: if (!['addTemplate', 'fix'].includes(op.op)) throw new cp.ComposeError('ops_invalid');
        }
      });
      if (op.op === 'addTemplate' || op.op === 'fix') {
        const model = cp.normalize(doc.toJS() || {});
        const used = await usedPorts(model);
        if (op.op === 'addTemplate') {
          const names = new Set(model.services.map(s => s.name));
          const dbs = model.services.filter(s => cp.imageKind(s.image)?.kind === 'db').map(s => ({ name: s.name, healthy: !!s.healthcheck }));
          const built = templates.build(String(op.template || ''), { used, volumesTaken: new Set(model.volumes), freePort: cp.freePort, dbs });
          if (!built) throw ctx.error(400, 'template_unknown', { template: String(op.template ?? '') });
          let name = op.name || (op.template === 'empty' ? 'service' : op.template), i = 2;
          while (names.has(name)) name = `${op.name || op.template}-${i++}`;
          sync(() => cp.addService(doc, name, built.service, { volumes: built.volumes }));
          added = name;
        } else {
          const issue = op.issue || {};
          sync(() => cp.applyFix(doc, { fix: String(issue.fix || ''), service: issue.service, target: issue.target, name: issue.name, port: issue.port }, { used }));
        }
      }
    }
    return { text: cp.stringify(doc), added };
  }

  // ---- job: comandi compose con l'output conservato e seguibile ----
  const jobs = new Map();
  let jobSeq = 0;
  function startJob({ title, args, cwd, meta = {} }) {
    const id = `j${Date.now().toString(36)}${(++jobSeq).toString(36)}`;
    const job = { id, title, command: `docker ${args.join(' ')}`, output: [], size: 0, done: false, code: null, startedAt: new Date().toISOString(), listeners: new Set(), ...meta };
    const push = (text, kind) => {
      job.output.push([kind, text]); job.size += text.length;
      while (job.size > MAX_JOB_OUTPUT && job.output.length > 1) job.size -= job.output.shift()[1].length;
      for (const l of job.listeners) l('chunk', { kind, text });
    };
    const child = d.stream(args, { onData: (text, kind) => push(text, kind), onExit: code => { job.done = true; job.code = code; job.finishedAt = new Date().toISOString(); for (const l of job.listeners) l('exit', code); job.listeners.clear(); }, cwd });
    job.child = child;
    jobs.set(id, job);
    while (jobs.size > MAX_JOBS) { const first = [...jobs.values()].find(j => j.done); if (!first) break; jobs.delete(first.id); }
    return job;
  }
  const jobInfo = j => ({ id: j.id, title: j.title, command: j.command, done: j.done, code: j.code, startedAt: j.startedAt, finishedAt: j.finishedAt || null, target: j.target || null, action: j.action || null });

  // Argomenti di compose per un file di un progetto (con l'override accanto) o per un progetto in esecuzione
  async function composeBase(target) {
    if (target?.projectId) {
      const f = fileOf(target.projectId, target.file);
      if (!fs.existsSync(f.abs)) throw ctx.error(404, 'file_not_found', { file: f.rel });
      const override = cp.overrideOf(f.abs);
      const base = cp.baseOf(f.abs);
      const list = base ? [base, f.abs] : [f.abs, ...(override ? [override] : [])];
      return { args: ['compose', ...list.flatMap(x => ['-f', x])], cwd: f.dir, label: `${f.project.label} · ${f.rel}`, hasFiles: true };
    }
    const name = sync(() => dk.checkProject(target?.project));
    const known = (await fromDocker(() => d.composeProjects())).find(p => p.name === name);
    const cfg = (known?.configFiles || []).filter(x => path.isAbsolute(x) && fs.existsSync(x));
    return { args: ['compose', '-p', name, ...cfg.flatMap(x => ['-f', x])], cwd: cfg[0] ? path.dirname(cfg[0]) : undefined, label: name, hasFiles: cfg.length > 0 };
  }
  function composeArgs(action, { services = [], options = {} } = {}) {
    if (!COMPOSE_ACTIONS.includes(action)) throw ctx.error(400, 'action_invalid', { action: String(action ?? '') });
    if (!Array.isArray(services) || services.length > 100) throw ctx.error(400, 'service_invalid', { service: '' });
    const svc = services.map(s => sync(() => dk.checkService(s)));
    const o = options && typeof options === 'object' ? options : {};
    switch (action) {
      case 'up': return ['up', '-d', ...(o.build ? ['--build'] : []), ...(o.pull === 'always' ? ['--pull', 'always'] : []), ...(o.forceRecreate ? ['--force-recreate'] : []), ...(o.removeOrphans ? ['--remove-orphans'] : []), ...svc];
      case 'down': return ['down', ...(o.volumes ? ['--volumes'] : []), ...(o.removeOrphans ? ['--remove-orphans'] : [])];
      case 'build': return ['build', ...(o.noCache ? ['--no-cache'] : []), ...(o.pull ? ['--pull'] : []), ...svc];
      default: return [action, ...svc];
    }
  }

  // ---- trasporto "Container Docker" per la sezione Tunnel ----
  // Un container socat sulla rete del container di destinazione pubblica 127.0.0.1:porta locale e
  // inoltra all'IP del container: funziona anche con Docker Desktop (macOS, Windows), dove gli IP
  // dei container non si raggiungono dall'host, e con porte mai pubblicate.
  const sidecarName = (container, port, localPort) => `kelbo-fwd-${container}-${port}-${localPort}`.replace(/[^a-zA-Z0-9_.-]/g, '-').slice(0, 120);
  const transport = {
    async fields(v) {
      let list = [];
      try { list = (await d.containers()).filter(c => !c.forward && c.state === 'running'); } catch { list = null; }
      const chosen = list?.find(c => c.name === v.container);
      const ports = chosen ? [...new Set([...chosen.exposed.map(p => p.port), ...chosen.ports.map(p => p.container)])].sort((a, b) => a - b) : [];
      const published = p => chosen?.ports.find(x => x.container === p)?.hostPort;
      return [
        { key: 'container', label: { it: 'Container', en: 'Container' }, type: 'select', required: true,
          options: (list || []).map(c => ({ value: c.name, label: c.compose ? `${c.name} (${c.compose.project}/${c.compose.service})` : `${c.name} (${c.image})` })),
          empty: list === null ? { it: 'Docker non risponde', en: 'Docker does not answer' } : { it: 'Nessun container in esecuzione', en: 'No running containers' } },
        { key: 'port', label: { it: 'Porta del container', en: 'Container port' }, type: ports.length ? 'select' : 'number', required: true, dependsOn: ['container'],
          options: ports.map(p => ({ value: p, label: published(p) ? `${p} (127.0.0.1:${published(p)})` : String(p) })),
          hint: { it: 'Anche le porte non pubblicate: il tunnel passa da un piccolo container socat sulla stessa rete', en: 'Unpublished ports too: the tunnel goes through a small socat container on the same network' } },
      ];
    },
    validate(p) {
      return { container: sync(() => dk.checkContainer(p.container)), port: sync(() => dk.checkPort(p.port)) };
    },
    describe: p => `${p.container}:${p.port}`,
    start(p, localPort, { onOutput, onReady, onExit }) {
      const name = dk.checkContainer(p.container), port = dk.checkPort(p.port), local = dk.checkPort(localPort);
      const [info] = JSON.parse(d.runSync(['inspect', '--type', 'container', name]));
      if (!info?.State?.Running) throw new Error(ctx.error.message('container_not_running', { container: name }));
      const mode = info.HostConfig?.NetworkMode || '';
      if (mode === 'host') throw new Error(ctx.error.message('forward_host_mode', { container: name }));
      const nets = Object.entries(info.NetworkSettings?.Networks || {}).filter(([, n]) => n.IPAddress);
      // rete creata dall'utente (o da compose) prima di bridge
      const [netName, netInfo] = nets.find(([k]) => k !== 'bridge') || nets[0] || [];
      if (!netName) throw new Error(ctx.error.message('forward_no_network', { container: name }));
      const sidecar = sidecarName(name, port, local);
      try { d.runSync(['rm', '-f', sidecar]); } catch { /* non c'era */ }
      onOutput(`socat ${FORWARD_IMAGE} · ${netName} · ${netInfo.IPAddress}:${port}\n`);
      let ready = false;
      const child = d.stream(['run', '--rm', '--name', sidecar, '--label', 'dev.kelbo.forward=1', '--label', `dev.kelbo.forward.target=${name}`,
        '--network', netName, '-p', `127.0.0.1:${local}:${port}`, FORWARD_IMAGE, '-d', '-d', `TCP-LISTEN:${port},fork,reuseaddr`, `TCP-CONNECT:${netInfo.IPAddress}:${port}`], {
        onData: text => {
          // socat -d -d scrive una riga per connessione: solo l'avvio e gli errori nel log del tunnel
          if (!ready && /listening on/i.test(text)) { ready = true; onReady(); }
          for (const line of text.split('\n')) if (line.trim() && !/ (accepting connection|starting data transfer|transferred|exiting with status 0|childdied|forked off child)/i.test(line)) onOutput(`${line}\n`);
        },
        onExit: code => onExit(code),
      });
      return {
        pid: child.pid,
        stop: force => { try { child.kill(force ? 'SIGKILL' : 'SIGTERM'); } catch { /* già uscito */ } d.run(['rm', '-f', sidecar]).catch(() => {}); },
      };
    },
  };

  // ---- connessione database di un container (per il form della sezione Database) ----
  async function dbPrefill(ref) {
    const c = await fromDocker(() => d.inspect(ref));
    const s = dk.containerSummary(c);
    const info = cp.dbConnectionOf(s.image, dk.envMap(c.Config?.Env));
    if (!info) throw ctx.error(400, 'not_a_database', { container: s.name });
    const published = s.ports.find(p => p.container === info.port && p.hostPort);
    const label = s.compose ? `${s.compose.service} (${s.compose.project})` : s.name;
    const project = s.compose?.workingDir ? ctx.projects.list().find(p => path.resolve(p.path) === path.resolve(s.compose.workingDir) || s.compose.workingDir.startsWith(p.path + path.sep)) : null;
    return {
      ...info, container: s.name, targetPort: info.port, label,
      suggestId: label.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40) || 'docker_db',
      host: published ? (published.hostIp && !['0.0.0.0', '::'].includes(published.hostIp) ? published.hostIp : '127.0.0.1') : null,
      port: published ? published.hostPort : null, projectId: project?.id || null,
    };
  }

  // ---- route ----
  const body = req => req.body || {};
  const handlers = {
    async status(req, res) {
      const v = await fromDocker(() => d.version()).catch(e => ({ error: { code: e.code, message: e.message } }));
      res.json({ ...v, forwardImage: FORWARD_IMAGE });
    },
    async overview(req, res) {
      const [containers, projects] = await fromDocker(() => Promise.all([d.containers(), d.composeProjects()]));
      res.json({ containers, projects, files: files() });
    },
    // docker events: un evento "change" (aggregato) quando un container cambia
    async events(req, res) {
      const send = ctx.sse(res);
      let timer = null, pending = [];
      const flush = () => { timer = null; send('change', { events: pending.slice(-50) }); pending = []; };
      let errText = '';
      const child = d.stream(['events', '--format', '{{json .}}', '--filter', 'type=container'], {
        onData: (text, kind) => {
          if (kind !== 'out') { errText = (errText + text).slice(-2000); return; }
          for (const ev of d.lines(text)) { pending.push({ action: ev.Action || ev.status, id: ev.Actor?.ID || ev.id, name: ev.Actor?.Attributes?.name || null }); }
          if (!timer) timer = setTimeout(flush, 300);
        },
        onExit: code => { clearTimeout(timer); send('end', { code, error: code ? errText.trim() : null }); send.end(); },
      });
      req.on('close', () => { clearTimeout(timer); try { child.kill(); } catch { /* già uscito */ } });
    },
    async containerAction(req, res) {
      const { id } = req.params;
      const action = req.params.action;
      if (!ACTIONS[action]) throw ctx.error(400, 'action_invalid', { action: String(action) });
      const args = [...ACTIONS[action], ...(action === 'remove' && body(req).force ? ['-f'] : []), ...(action === 'remove' && body(req).volumes ? ['-v'] : []), sync(() => dk.checkContainer(id))];
      const out = await fromDocker(() => d.run(args, { timeout: 120000 }));
      res.json({ ok: true, output: out.trim() });
    },
    async logs(req, res) {
      const id = sync(() => dk.checkContainer(req.params.id));
      const tail = Math.min(Math.max(parseInt(req.query.tail) || 300, 1), MAX_TAIL);
      const args = ['logs', `--tail=${tail}`, ...(req.query.timestamps === '1' ? ['-t'] : []), ...(req.query.follow === '1' ? ['-f'] : []), id];
      const send = ctx.sse(res);
      const child = d.stream(args, { onData: (text, kind) => send(kind === 'out' ? 'stdout' : 'stderr', text), onExit: code => { send('exit', code); send.end(); } });
      req.on('close', () => { try { child.kill(); } catch { /* già uscito */ } });
    },
    // Dettagli: ambiente con i valori (in locale, come docker inspect), segnati quelli che sembrano segreti
    async inspect(req, res) {
      const c = await fromDocker(() => d.inspect(req.params.id));
      const s = dk.containerSummary(c);
      const env = Object.entries(dk.envMap(c.Config?.Env)).map(([key, value]) => ({ key, value, secret: cp.SECRET_NAME_RE.test(key) }));
      res.json({ ...s, env, labels: c.Config?.Labels || {}, db: cp.dbConnectionOf(s.image, dk.envMap(c.Config?.Env)) ? cp.imageKind(s.image).engine : null });
    },
    async dbConnection(req, res) { res.json(await dbPrefill(req.params.id)); },
    async stats(req, res) { res.json({ stats: await fromDocker(() => d.stats()) }); },

    files(req, res) { res.json({ files: files() }); },
    async load(req, res) {
      const f = fileOf(body(req).projectId, body(req).file);
      const text = readFile(f);
      if (text == null) throw ctx.error(404, 'file_not_found', { file: f.rel });
      res.json({ file: f.rel, projectId: f.project.id, text, hash: hashOf(text), ...await analyzeText(f, text) });
    },
    async analyze(req, res) {
      const f = fileOf(body(req).projectId, body(req).file);
      const text = String(body(req).text ?? '');
      if (text.length > MAX_FILE) throw ctx.error(413, 'file_too_large', { file: f.rel });
      res.json(await analyzeText(f, text));
    },
    async edit(req, res) {
      const f = fileOf(body(req).projectId, body(req).file);
      const r = await edit(f, String(body(req).text ?? ''), body(req).ops);
      res.json({ ...r, ...await analyzeText(f, r.text) });
    },
    // Salvataggio: rifiutato se il file è cambiato sul disco dopo la lettura (hash), creato se nuovo
    async save(req, res) {
      const f = fileOf(body(req).projectId, body(req).file);
      const text = String(body(req).text ?? '');
      if (text.length > MAX_FILE) throw ctx.error(413, 'file_too_large', { file: f.rel });
      const current = readFile(f);
      const expected = body(req).hash ?? null;
      if ((current == null && expected != null) || (current != null && hashOf(current) !== expected)) throw ctx.error(409, 'file_changed', { file: f.rel });
      const doc = cp.parseDoc(text);
      if (doc.errors.length) throw ctx.error(400, 'yaml_invalid', { message: cp.yamlErrors(doc)[0].message });
      fs.mkdirSync(f.dir, { recursive: true });
      const tmp = `${f.abs}.kelbo-${process.pid}.tmp`;
      fs.writeFileSync(tmp, text);
      fs.renameSync(tmp, f.abs);
      res.json({ ok: true, hash: hashOf(text), created: current == null });
    },
    // Controllo di docker compose sul testo (anche non salvato): stessi errori di "up"
    async validate(req, res) {
      const f = fileOf(body(req).projectId, body(req).file);
      const text = String(body(req).text ?? '');
      const override = cp.overrideOf(f.abs);
      const args = ['compose', '--project-directory', f.dir, '-f', '-', ...(override ? ['-f', override] : []), 'config', '--quiet'];
      try { await d.run(args, { input: text, timeout: 30000 }); res.json({ ok: true, output: '' }); }
      catch (e) {
        if (e instanceof dk.DockerError && (e.key === 'docker_missing' || e.key === 'daemon_down')) throw toApi(e);
        if (e instanceof dk.DockerError) res.json({ ok: false, output: String(e.output || '').replace(/\/dev\/stdin|-:/g, f.rel) });
        else throw e;
      }
    },
    templates(req, res) { res.json({ templates: templates.TEMPLATES.map(t => ({ id: t.id, kind: t.kind, image: t.image || null, build: t.build || null, port: t.port || null })) }); },

    async run(req, res) {
      const b = body(req);
      const base = await composeBase(b.target || {});
      const extra = composeArgs(b.action, { services: b.services || [], options: b.options || {} });
      if (['up', 'pull', 'build'].includes(b.action) && !base.hasFiles) throw ctx.error(400, 'files_missing', { project: base.label });
      const job = startJob({ title: `${b.action} · ${base.label}`, args: [...base.args, ...extra], cwd: base.cwd, meta: { target: b.target, action: b.action } });
      res.json({ job: jobInfo(job) });
    },
    jobs(req, res) { res.json({ jobs: [...jobs.values()].map(jobInfo).reverse() }); },
    async jobStream(req, res) {
      const job = jobs.get(req.params.id);
      if (!job) throw ctx.error(404, 'job_not_found');
      const send = ctx.sse(res);
      send('start', jobInfo(job));
      for (const [kind, text] of job.output) send('chunk', { kind, text });
      if (job.done) { send('exit', job.code); send.end(); return; }
      const l = (type, data) => { send(type, data); if (type === 'exit') send.end(); };
      job.listeners.add(l);
      req.on('close', () => job.listeners.delete(l));
    },
    async stopJob(req, res) {
      const job = jobs.get(req.params.id);
      if (!job) throw ctx.error(404, 'job_not_found');
      if (!job.done) try { job.child.kill('SIGINT'); } catch { /* già uscito */ }
      res.json({ ok: true });
    },
    // Log di un progetto compose (tutti i servizi o alcuni), con il nome del servizio in testa
    async composeLogs(req, res) {
      const target = req.query.projectId ? { projectId: String(req.query.projectId), file: String(req.query.file || '') } : { project: String(req.query.project || '') };
      const base = await composeBase(target);
      const services = String(req.query.services || '').split(',').filter(Boolean).map(s => sync(() => dk.checkService(s)));
      const tail = Math.min(Math.max(parseInt(req.query.tail) || 200, 1), MAX_TAIL);
      const send = ctx.sse(res);
      const child = d.stream([...base.args, 'logs', `--tail=${tail}`, ...(req.query.follow === '1' ? ['-f'] : []), ...services], { onData: (text, kind) => send(kind === 'out' ? 'stdout' : 'stderr', text), onExit: code => { send('exit', code); send.end(); } });
      req.on('close', () => { try { child.kill(); } catch { /* già uscito */ } });
    },
  };

  return {
    handlers,
    providers: { container: transport },
    // Strumenti MCP in sola lettura: niente valori dell'ambiente dei container
    mcp: {
      async containers({ all = true } = {}) {
        const list = await fromDocker(() => d.containers());
        return { containers: list.filter(c => all || c.state === 'running').map(({ mounts, ...c }) => c) };
      },
      async compose_projects() { return { projects: await fromDocker(() => d.composeProjects()), files: files() }; },
      async analyze({ project, file }) {
        const f = fileOf(project, file);
        const text = readFile(f);
        if (text == null) throw ctx.error(404, 'file_not_found', { file: f.rel });
        const a = await analyzeText(f, text);
        return {
          project: f.project.id, file: f.rel, composeProject: a.projectName, yamlErrors: a.yamlErrors,
          services: a.model.services.map(s => ({ name: s.name, image: s.image, build: s.build, ports: s.ports.map(p => `${p.hostIp ? `${p.hostIp}:` : ''}${p.published ?? ''}${p.published != null ? ':' : ''}${p.target}`), dependsOn: s.dependsOn, healthcheck: !!s.healthcheck, running: (a.running[s.name] || []).map(c => ({ name: c.name, state: c.state, health: c.health })) })),
          issues: a.issues.map(i => ({ level: i.level, code: i.code, service: i.service || null, params: i.params })),
          missingVariables: a.variables.missing,
        };
      },
      async logs({ container, lines = 100 }) {
        const n = Math.min(Math.max(parseInt(lines) || 100, 1), 1000);
        const out = await fromDocker(() => d.run(['logs', `--tail=${n}`, dk.checkContainer(container)], { both: true }));
        return { container, lines: n, output: out };
      },
    },

    shutdown() { d.stopAll(); },
  };
};
