// docker della macchina: esecuzione senza shell, nomi controllati prima di arrivare al comando,
// container letti da docker inspect (stato, salute, porte, rete, compose), progetti di docker
// compose ls, statistiche, processi lunghi (eventi, log, comandi compose) chiusi allo spegnimento.
const { execFile, execFileSync, spawn } = require('child_process');

const TIMEOUT_MS = 30000;
const MAX_BUFFER = 64 * 1024 * 1024;
// nomi e id dei container, nomi dei progetti compose e dei servizi
const CONTAINER_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/;
const PROJECT_RE = /^[a-z0-9][a-z0-9_-]{0,62}$/;
const SERVICE_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,62}$/;

class DockerError extends Error {
  constructor(name, params = {}, output = '') { super(name); this.key = name; this.params = params; this.output = output; }
}
const fail = (name, params, output) => { throw new DockerError(name, params, output); };

const checkContainer = c => { if (typeof c !== 'string' || !CONTAINER_RE.test(c)) fail('container_invalid', { container: String(c ?? '') }); return c; };
const checkProject = p => { if (typeof p !== 'string' || !PROJECT_RE.test(p)) fail('project_invalid', { project: String(p ?? '') }); return p; };
const checkService = s => { if (typeof s !== 'string' || !SERVICE_RE.test(s)) fail('service_invalid', { service: String(s ?? '') }); return s; };
const checkPort = p => { const n = Number(p); if (!Number.isInteger(n) || n < 1 || n > 65535) fail('port_invalid', { port: String(p ?? '') }); return n; };

// errore di docker → chiave: daemon spento, oggetto inesistente, altro
function classify(output) {
  if (/Cannot connect to the Docker daemon|docker daemon is not running|error during connect|Is the docker daemon running/i.test(output)) return 'daemon_down';
  if (/No such (container|object)|not found/i.test(output)) return 'not_found';
  return 'docker_failed';
}

function createDocker({ bin = 'docker', env = {} } = {}) {
  const children = new Set();
  const procEnv = () => ({ ...process.env, ...env, DOCKER_CLI_HINTS: 'false' });

  // docker args → stdout (both: anche stderr, come i log dei container); input: testo per stdin (compose -f -)
  function run(args, { timeout = TIMEOUT_MS, input = null, both = false } = {}) {
    return new Promise((resolve, reject) => {
      const child = execFile(bin, args, { timeout, maxBuffer: MAX_BUFFER, env: procEnv(), windowsHide: true }, (err, stdout, stderr) => {
        if (err) {
          if (err.code === 'ENOENT') return reject(new DockerError('docker_missing'));
          const output = String(stderr || '').trim() || String(stdout || '').trim() || err.message;
          return reject(new DockerError(classify(output), { output: output.slice(-4000) }, output));
        }
        resolve(both ? String(stdout) + String(stderr) : String(stdout));
      });
      if (input != null) { child.stdin.on('error', () => { /* uscito prima di leggere */ }); child.stdin.end(input); }
    });
  }
  // per il trasporto dei tunnel, che deve partire subito: inspect sincrono (locale, veloce)
  function runSync(args) {
    try { return String(execFileSync(bin, args, { timeout: 10000, env: procEnv(), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })); }
    catch (e) {
      if (e.code === 'ENOENT') throw new DockerError('docker_missing');
      const output = String(e.stderr || '').trim() || e.message;
      throw new DockerError(classify(output), { output: output.slice(-2000) }, output);
    }
  }
  const lines = out => out.split('\n').map(l => l.trim()).filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);

  // Processo lungo (eventi, log -f, comandi compose): stdout/stderr a pezzi
  function stream(args, { onData, onExit, input = null, cwd }) {
    const child = spawn(bin, args, { cwd, env: procEnv(), windowsHide: true, stdio: [input != null ? 'pipe' : 'ignore', 'pipe', 'pipe'] });
    children.add(child);
    if (input != null) { child.stdin.on('error', () => {}); child.stdin.end(input); }
    child.stdout.on('data', d => onData?.(String(d), 'out'));
    child.stderr.on('data', d => onData?.(String(d), 'err'));
    child.on('error', e => onData?.(e.code === 'ENOENT' ? 'docker non trovato\n' : `${e.message}\n`, 'err'));
    child.on('close', code => { children.delete(child); onExit?.(code); });
    return child;
  }
  const stopAll = () => { for (const c of children) { try { c.kill(); } catch { /* già uscito */ } } };

  // ---- letture ----
  async function version() {
    const out = await run(['version', '--format', '{{json .}}'], { timeout: 8000 }).catch(e => {
      // client senza daemon: la versione del client c'è, il server no
      if (e.key === 'daemon_down') return null;
      throw e;
    });
    let compose = null;
    try { compose = JSON.parse(await run(['compose', 'version', '--format', 'json'], { timeout: 8000 })).version || null; } catch { /* compose v2 assente */ }
    if (!out) return { daemon: false, client: null, server: null, compose };
    const v = JSON.parse(out);
    return { daemon: true, client: v.Client?.Version || null, server: v.Server?.Version || null, compose, os: v.Server?.Os || null };
  }

  async function containers() {
    const ids = (await run(['ps', '-a', '-q', '--no-trunc'])).split('\n').map(s => s.trim()).filter(Boolean);
    if (!ids.length) return [];
    const data = JSON.parse(await run(['inspect', ...ids]));
    return data.map(containerSummary);
  }
  async function inspect(ref) {
    const [c] = JSON.parse(await run(['inspect', '--type', 'container', checkContainer(ref)]));
    if (!c) fail('not_found', { output: ref });
    return c;
  }
  async function composeProjects() {
    try { return JSON.parse(await run(['compose', 'ls', '-a', '--format', 'json']) || '[]').map(p => ({ name: p.Name, status: p.Status, configFiles: String(p.ConfigFiles || '').split(',').filter(Boolean) })); }
    catch (e) { if (e.key === 'docker_failed') return []; throw e; }
  }
  async function stats() {
    return lines(await run(['stats', '--no-stream', '--no-trunc', '--format', '{{json .}}'], { timeout: 20000 })).map(s => ({
      id: s.ID, name: s.Name, cpu: parseFloat(s.CPUPerc) || 0, memPerc: parseFloat(s.MemPerc) || 0, mem: s.MemUsage || '', net: s.NetIO || '', block: s.BlockIO || '',
    }));
  }

  return { run, runSync, stream, stopAll, lines, version, containers, inspect, composeProjects, stats, bin };
}

// ---- lettura di docker inspect ----
function containerSummary(c) {
  const labels = c.Config?.Labels || {};
  const st = c.State || {};
  const ports = [];
  for (const [key, binds] of Object.entries(c.NetworkSettings?.Ports || {})) {
    const [port, protocol] = key.split('/');
    for (const b of binds || []) ports.push({ container: Number(port), protocol, hostIp: b.HostIp || '', hostPort: Number(b.HostPort) });
  }
  // porte esposte senza binding sull'host (dove serve un tunnel)
  const exposed = Object.keys(c.Config?.ExposedPorts || {}).map(k => ({ port: Number(k.split('/')[0]), protocol: k.split('/')[1] || 'tcp' }));
  // stesso binding su IPv4 e IPv6: una volta sola
  const seen = new Set();
  const uniquePorts = ports.filter(p => { const k = `${p.container}/${p.protocol}/${p.hostPort}`; if (seen.has(k)) return false; seen.add(k); return true; });
  const compose = labels['com.docker.compose.project'] ? {
    project: labels['com.docker.compose.project'], service: labels['com.docker.compose.service'] || null,
    number: Number(labels['com.docker.compose.container-number']) || null, workingDir: labels['com.docker.compose.project.working_dir'] || null,
    configFiles: String(labels['com.docker.compose.project.config_files'] || '').split(',').filter(Boolean), oneoff: labels['com.docker.compose.oneoff'] === 'True',
  } : null;
  return {
    id: c.Id, shortId: String(c.Id || '').slice(0, 12), name: String(c.Name || '').replace(/^\//, ''),
    image: c.Config?.Image || c.Image, state: st.Status || 'unknown', exitCode: st.ExitCode ?? null,
    health: st.Health?.Status || null, startedAt: validDate(st.StartedAt), finishedAt: validDate(st.FinishedAt), createdAt: validDate(c.Created),
    restartCount: c.RestartCount || 0, restartPolicy: c.HostConfig?.RestartPolicy?.Name || null,
    ports: uniquePorts.sort((a, b) => a.container - b.container), exposed,
    networkMode: c.HostConfig?.NetworkMode || null,
    networks: Object.entries(c.NetworkSettings?.Networks || {}).map(([name, n]) => ({ name, ip: n.IPAddress || null, aliases: n.DNSNames || n.Aliases || [] })),
    mounts: (c.Mounts || []).map(m => ({ type: m.Type, source: m.Type === 'volume' ? m.Name : m.Source, destination: m.Destination, rw: m.RW !== false })),
    command: [...(c.Config?.Entrypoint || []), ...(c.Config?.Cmd || [])].join(' '),
    compose, forward: labels['dev.kelbo.forward'] === '1',
  };
}
const validDate = d => (d && !String(d).startsWith('0001-') ? d : null);

// valori di un ambiente "K=V" → mappa
const envMap = list => Object.fromEntries((list || []).map(e => { const i = e.indexOf('='); return i < 0 ? [e, ''] : [e.slice(0, i), e.slice(i + 1)]; }));

module.exports = {
  createDocker, DockerError, containerSummary, envMap, classify,
  CONTAINER_RE, PROJECT_RE, SERVICE_RE, checkContainer, checkProject, checkService, checkPort,
};
