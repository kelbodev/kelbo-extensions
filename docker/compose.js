// File compose: lettura (YAML con ancore e chiavi di merge), interpolazione delle variabili come
// docker compose (.env della cartella, poi l'ambiente), modello normalizzato dei servizi (porte,
// volumi, dipendenze, reti nelle due sintassi), unione con l'override, analisi con i problemi e le
// correzioni, e modifiche al documento che lasciano intatti commenti e formattazione del resto.
const fs = require('fs');
const os = require('os');
const path = require('path');
const YAML = require('yaml');

const BASE_NAMES = ['compose.yaml', 'compose.yml', 'docker-compose.yaml', 'docker-compose.yml'];
const FILE_RE = /^(docker-)?compose(\.[\w-]+)*\.ya?ml$/;
const NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,62}$/;
const VAR_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const SECRET_NAME_RE = /(PASSWORD|PASSWD|SECRET|TOKEN|API_?KEY|PRIVATE_?KEY|ACCESS_?KEY)/i;

class ComposeError extends Error {
  constructor(name, params = {}) { super(name); this.key = name; this.params = params; }
}

// ---- .env ----
function parseDotenv(text) {
  const out = {};
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.replace(/^\s*export\s+/, '').trim();
    if (!line || line.startsWith('#')) continue;
    const i = line.indexOf('=');
    if (i <= 0) continue;
    const key = line.slice(0, i).trim();
    if (!VAR_RE.test(key)) continue;
    let v = line.slice(i + 1).trim();
    if (/^"/.test(v)) { const m = /^"((?:[^"\\]|\\.)*)"/.exec(v); v = m ? m[1].replace(/\\n/g, '\n').replace(/\\(["\\])/g, '$1') : v.slice(1); }
    else if (/^'/.test(v)) { const m = /^'([^']*)'/.exec(v); v = m ? m[1] : v.slice(1); }
    else v = v.replace(/\s+#.*$/, '');
    out[key] = v;
  }
  return out;
}

// ---- interpolazione: $$, $VAR, ${VAR}, ${VAR:-d}, ${VAR-d}, ${VAR:?e}, ${VAR?e}, ${VAR:+r}, ${VAR+r} (anche annidate) ----
function interpolate(str, env, report) {
  let out = '', i = 0;
  while (i < str.length) {
    const ch = str[i];
    if (ch !== '$') { out += ch; i++; continue; }
    const next = str[i + 1];
    if (next === '$') { out += '$'; i += 2; continue; }
    if (next === '{') {
      // fine della graffa, tenendo conto di quelle annidate
      let depth = 1, j = i + 2;
      for (; j < str.length && depth; j++) { if (str[j] === '{') depth++; else if (str[j] === '}') depth--; }
      if (depth) { report.invalid(str); out += str.slice(i); break; }
      const body = str.slice(i + 2, j - 1);
      const m = /^([A-Za-z_][A-Za-z0-9_]*)(?:(:?[-?+])([\s\S]*))?$/.exec(body);
      if (!m) { report.invalid(str); out += str.slice(i, j); i = j; continue; }
      const [, name, op, arg = ''] = m;
      const v = env[name];
      const set = v !== undefined, full = set && v !== '';
      const sub = () => interpolate(arg, env, report);
      switch (op) {
        case undefined: if (!set) report.missing(name); out += v ?? ''; break;
        case ':-': out += full ? v : sub(); break;
        case '-': out += set ? v : sub(); break;
        case ':?': if (!full) report.required(name, arg); out += v ?? ''; break;
        case '?': if (!set) report.required(name, arg); out += v ?? ''; break;
        case ':+': out += full ? sub() : ''; break;
        case '+': out += set ? sub() : ''; break;
      }
      i = j;
      continue;
    }
    const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(str.slice(i + 1));
    if (m) { const v = env[m[0]]; if (v === undefined) report.missing(m[0]); out += v ?? ''; i += 1 + m[0].length; continue; }
    out += '$'; i++;
  }
  return out;
}
// Variabili usate nel testo (per l'elenco e i default), senza interpolare
function variablesIn(text) {
  const found = new Map();
  const re = /\$\{([A-Za-z_][A-Za-z0-9_]*)(?:(:?[-?+])([^}]*))?\}|\$([A-Za-z_][A-Za-z0-9_]*)/g;
  let m;
  const src = String(text || '').replace(/\$\$/g, '');
  while ((m = re.exec(src))) {
    const name = m[1] || m[4];
    const cur = found.get(name) || { name, default: null, required: false };
    if (m[2] === ':-' || m[2] === '-') cur.default = cur.default ?? m[3];
    if (m[2] === ':?' || m[2] === '?') cur.required = true;
    found.set(name, cur);
  }
  return [...found.values()];
}

function interpolateTree(value, env, report, at = []) {
  if (typeof value === 'string') { report.at = at.join('.'); return interpolate(value, env, report); }
  if (Array.isArray(value)) return value.map((v, i) => interpolateTree(v, env, report, [...at, i]));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, interpolateTree(v, env, report, [...at, k])]));
  return value;
}

// ---- YAML ----
function parseDoc(text) {
  const doc = YAML.parseDocument(String(text ?? ''), { merge: true, prettyErrors: true, uniqueKeys: true });
  return doc;
}
function yamlErrors(doc) {
  return doc.errors.map(e => ({ message: String(e.message).split('\n')[0], line: e.linePos?.[0]?.line || null, col: e.linePos?.[0]?.col || null }));
}

// ---- normalizzazione ----
function parsePortShort(raw) {
  let s = String(raw).trim(), protocol = 'tcp';
  const pm = /\/(tcp|udp|sctp)$/i.exec(s);
  if (pm) { protocol = pm[1].toLowerCase(); s = s.slice(0, -pm[0].length); }
  let hostIp = '';
  const v6 = /^\[([^\]]+)\]:(.*)$/.exec(s);
  if (v6) { hostIp = v6[1]; s = v6[2]; }
  const parts = s.split(':');
  let published = null, target;
  if (parts.length === 1) target = parts[0];
  else if (parts.length === 2) { published = parts[0]; target = parts[1]; }
  else { hostIp = hostIp || parts.slice(0, -2).join(':'); published = parts.at(-2); target = parts.at(-1); }
  return { hostIp, published: published === '' ? null : published, target, protocol };
}
function normalizePorts(list) {
  return (Array.isArray(list) ? list : []).map((p, index) => {
    if (p && typeof p === 'object') return { index, hostIp: p.host_ip || '', published: p.published != null ? String(p.published) : null, target: String(p.target ?? ''), protocol: String(p.protocol || 'tcp'), long: true };
    return { index, ...parsePortShort(p), long: false };
  });
}
// porte pubblicate come numeri (gli intervalli "8000-8002" diventano tre)
function publishedNumbers(p) {
  if (p.published == null) return [];
  const m = /^(\d+)(?:-(\d+))?$/.exec(String(p.published));
  if (!m) return [];
  const a = Number(m[1]), b = Number(m[2] || m[1]);
  return b >= a && b - a < 1000 ? Array.from({ length: b - a + 1 }, (_, i) => a + i) : [a];
}

function isBindSource(src) { return /^(\.{1,2}([\\/]|$)|[\\/]|~|[A-Za-z]:[\\/]|\$)/.test(src); }
function normalizeVolumes(list) {
  return (Array.isArray(list) ? list : []).map((v, index) => {
    if (v && typeof v === 'object') return { index, type: v.type || 'volume', source: v.source ?? null, target: v.target ?? '', readOnly: !!v.read_only, long: true };
    const parts = String(v).split(':');
    // C:\percorso:/dest su Windows
    if (/^[A-Za-z]$/.test(parts[0]) && parts.length > 2) parts.splice(0, 2, `${parts[0]}:${parts[1]}`);
    if (parts.length === 1) return { index, type: 'volume', source: null, target: parts[0], readOnly: false, long: false };
    const [source, target, mode = ''] = parts;
    return { index, type: isBindSource(source) ? 'bind' : 'volume', source, target, readOnly: /(^|,)ro(,|$)/.test(mode), long: false };
  });
}
function normalizeEnv(env) {
  if (Array.isArray(env)) return Object.fromEntries(env.map(e => { const s = String(e); const i = s.indexOf('='); return i < 0 ? [s, null] : [s.slice(0, i), s.slice(i + 1)]; }));
  if (env && typeof env === 'object') return Object.fromEntries(Object.entries(env).map(([k, v]) => [k, v == null ? null : String(v)]));
  return {};
}
function normalizeDepends(d) {
  if (Array.isArray(d)) return d.map(s => ({ service: String(s), condition: 'service_started', short: true }));
  if (d && typeof d === 'object') return Object.entries(d).map(([s, o]) => ({ service: s, condition: o?.condition || 'service_started', required: o?.required !== false, restart: !!o?.restart, short: false }));
  return [];
}
function normalizeService(name, s) {
  s = s && typeof s === 'object' ? s : {};
  const build = typeof s.build === 'string' ? { context: s.build, dockerfile: null } : s.build && typeof s.build === 'object' ? { context: s.build.context || '.', dockerfile: s.build.dockerfile || null } : null;
  return {
    name, image: s.image != null ? String(s.image) : null, build,
    containerName: s.container_name || null,
    ports: normalizePorts(s.ports), expose: (s.expose || []).map(String),
    volumes: normalizeVolumes(s.volumes),
    environment: normalizeEnv(s.environment),
    envFiles: (Array.isArray(s.env_file) ? s.env_file : s.env_file ? [s.env_file] : []).map(f => (typeof f === 'string' ? { path: f, required: true } : { path: f.path, required: f.required !== false })),
    dependsOn: normalizeDepends(s.depends_on),
    networks: Array.isArray(s.networks) ? s.networks.map(String) : s.networks && typeof s.networks === 'object' ? Object.keys(s.networks) : [],
    networkMode: s.network_mode || null,
    healthcheck: s.healthcheck && !s.healthcheck.disable ? s.healthcheck : null,
    healthcheckDisabled: !!s.healthcheck?.disable,
    restart: s.restart || null, profiles: Array.isArray(s.profiles) ? s.profiles : [],
    command: Array.isArray(s.command) ? s.command.join(' ') : s.command || null,
    privileged: !!s.privileged, extends: s.extends || null,
    secrets: (s.secrets || []).map(x => (typeof x === 'string' ? x : x?.source)).filter(Boolean),
    deployReplicas: s.deploy?.replicas ?? null,
  };
}
function normalize(js) {
  const top = js && typeof js === 'object' && !Array.isArray(js) ? js : {};
  const services = top.services && typeof top.services === 'object' ? top.services : {};
  return {
    name: top.name || null, version: top.version ?? null,
    services: Object.entries(services).map(([n, s]) => normalizeService(n, s)),
    volumes: Object.keys(top.volumes || {}), networks: Object.keys(top.networks || {}),
    externalVolumes: Object.entries(top.volumes || {}).filter(([, v]) => v?.external).map(([k]) => k),
    externalNetworks: Object.entries(top.networks || {}).filter(([, v]) => v?.external).map(([k]) => k),
    secrets: Object.keys(top.secrets || {}),
    include: top.include || null,
  };
}

// Unione di un override sul file principale (come docker compose): mappe unite, liste di porte,
// expose, depends_on unite, volumi uniti per destinazione, il resto sostituito
function mergeCompose(base, over) {
  const out = structuredClone(base || {});
  for (const [k, v] of Object.entries(over || {})) {
    if (k !== 'services') { out[k] = v && typeof v === 'object' && !Array.isArray(v) ? { ...(out[k] || {}), ...v } : v; continue; }
    out.services = out.services || {};
    for (const [name, s] of Object.entries(v || {})) {
      const cur = out.services[name] || {};
      const merged = { ...cur };
      for (const [key, val] of Object.entries(s || {})) {
        if (['ports', 'expose', 'dns', 'secrets'].includes(key)) merged[key] = [...(cur[key] || []), ...(val || [])];
        else if (key === 'environment' || key === 'labels') merged[key] = { ...normalizeEnv(cur[key]), ...normalizeEnv(val) };
        else if (key === 'volumes') {
          const byTarget = new Map(normalizeVolumes(cur.volumes).map((x, i) => [x.target, cur.volumes[i]]));
          normalizeVolumes(val).forEach((x, i) => byTarget.set(x.target, val[i]));
          merged.volumes = [...byTarget.values()];
        } else if (key === 'depends_on') {
          const a = Object.fromEntries(normalizeDepends(cur.depends_on).map(d => [d.service, { condition: d.condition }]));
          const b = Object.fromEntries(normalizeDepends(val).map(d => [d.service, { condition: d.condition }]));
          merged.depends_on = { ...a, ...b };
        } else merged[key] = val;
      }
      out.services[name] = merged;
    }
  }
  return out;
}

// ---- immagini note: tipo, porta, healthcheck, connessione database ----
const IMAGE_KINDS = [
  { re: /(^|\/)(postgres|postgis\/postgis|timescale\/timescaledb[\w-]*|pgvector\/pgvector)(:|$)/, kind: 'db', engine: 'postgres', port: 5432,
    healthcheck: { test: ['CMD-SHELL', 'pg_isready -U "$${POSTGRES_USER:-postgres}" -d "$${POSTGRES_DB:-postgres}"'], interval: '5s', timeout: '5s', retries: 10 } },
  { re: /(^|\/)mariadb(:|$)/, kind: 'db', engine: 'mysql', port: 3306,
    healthcheck: { test: ['CMD', 'healthcheck.sh', '--connect', '--innodb_initialized'], interval: '5s', timeout: '5s', retries: 10 } },
  { re: /(^|\/)(mysql|percona(\/percona-server)?)(:|$)/, kind: 'db', engine: 'mysql', port: 3306,
    healthcheck: { test: ['CMD', 'mysqladmin', 'ping', '-h', '127.0.0.1', '--silent'], interval: '5s', timeout: '5s', retries: 10 } },
  { re: /(^|\/)(mssql\/server|azure-sql-edge)(:|$)/, kind: 'db', engine: 'mssql', port: 1433,
    healthcheck: { test: ['CMD-SHELL', '/opt/mssql-tools18/bin/sqlcmd -C -S localhost -U sa -P "$${MSSQL_SA_PASSWORD}" -Q "SELECT 1" || exit 1'], interval: '10s', timeout: '5s', retries: 10, start_period: '20s' } },
  { re: /(^|\/)(gvenzl\/oracle-(free|xe)|database\/(free|express|enterprise))(:|$)/, kind: 'db', engine: 'oracle', port: 1521,
    healthcheck: { test: ['CMD', 'healthcheck.sh'], interval: '10s', timeout: '5s', retries: 20, start_period: '30s' } },
  { re: /(^|\/)mongo(:|$)/, kind: 'db', engine: 'mongo', port: 27017,
    healthcheck: { test: ['CMD', 'mongosh', '--quiet', '--eval', "db.adminCommand('ping')"], interval: '5s', timeout: '5s', retries: 10 } },
  { re: /(^|\/)(redis|valkey\/valkey|redis\/redis-stack[\w-]*)(:|$)/, kind: 'cache', engine: 'redis', port: 6379,
    healthcheck: { test: ['CMD', 'redis-cli', 'ping'], interval: '5s', timeout: '3s', retries: 10 } },
  { re: /(^|\/)rabbitmq(:|$)/, kind: 'queue', port: 5672,
    healthcheck: { test: ['CMD', 'rabbitmq-diagnostics', '-q', 'ping'], interval: '10s', timeout: '5s', retries: 10 } },
  { re: /(^|\/)(elasticsearch|opensearch(project\/opensearch)?)(:|$)/, kind: 'search', port: 9200 },
  { re: /(^|\/)(nginx|httpd|caddy|traefik|haproxy)(:|$)/, kind: 'web' },
  { re: /(^|\/)(mailpit|mailhog|maildev)/, kind: 'mail' },
];
function imageKind(image) {
  const name = String(image || '').toLowerCase().replace(/@sha256:.*$/, '');
  return IMAGE_KINDS.find(k => k.re.test(name)) || null;
}

// Connessione database di un container: tipo per la sezione Database e credenziali dall'ambiente
function dbConnectionOf(image, env) {
  const k = imageKind(image);
  if (!k || k.kind !== 'db') return null;
  const e = env || {};
  if (k.engine === 'postgres') {
    const user = e.POSTGRES_USER || 'postgres';
    return { type: 'postgres', port: k.port, user, password: e.POSTGRES_PASSWORD || '', database: e.POSTGRES_DB || user };
  }
  if (k.engine === 'mysql') {
    const user = e.MYSQL_USER || e.MARIADB_USER || 'root';
    const password = user === 'root' ? (e.MYSQL_ROOT_PASSWORD || e.MARIADB_ROOT_PASSWORD || '') : (e.MYSQL_PASSWORD || e.MARIADB_PASSWORD || '');
    return { type: 'mysql', port: k.port, user, password, database: e.MYSQL_DATABASE || e.MARIADB_DATABASE || '' };
  }
  if (k.engine === 'mssql') return { type: 'mssql', port: k.port, user: 'sa', password: e.MSSQL_SA_PASSWORD || e.SA_PASSWORD || '', database: '' };
  if (k.engine === 'oracle') {
    const free = /free/.test(String(image));
    return e.APP_USER
      ? { type: 'oracle', port: k.port, user: e.APP_USER, password: e.APP_USER_PASSWORD || '', database: free ? 'FREEPDB1' : 'XEPDB1' }
      : { type: 'oracle', port: k.port, user: 'system', password: e.ORACLE_PASSWORD || '', database: free ? 'FREEPDB1' : 'XEPDB1' };
  }
  if (k.engine === 'mongo') return { type: 'mongo', port: k.port, user: e.MONGO_INITDB_ROOT_USERNAME || '', password: e.MONGO_INITDB_ROOT_PASSWORD || '', database: e.MONGO_INITDB_DATABASE || '' };
  return null;
}

// ---- analisi ----
// ctx: { dir, exists(p), listening: Map(port → { name, pid }), ownPorts: Set(porte dei container di questo progetto),
//        containerPorts: Map(port → nome container), report (variabili) }
function analyze(model, { dir, exists = p => fs.existsSync(p), listening = new Map(), ownPorts = new Set(), containerPorts = new Map(), variables = { missing: [], required: [], invalid: [] } } = {}) {
  const issues = [];
  const add = (level, code, params = {}, extra = {}) => issues.push({ level, code, params, ...extra });
  const names = new Set(model.services.map(s => s.name));
  const resolve = p => (String(p).startsWith('~') ? path.join(os.homedir(), String(p).slice(1)) : path.resolve(dir, String(p)));

  if (model.version != null) add('info', 'version_obsolete', {}, { fix: 'remove_version' });
  if (!model.services.length && !model.include) add('error', 'no_services');
  for (const v of variables.missing) add('warning', 'env_missing', { name: v });
  for (const v of variables.required) add('error', 'env_required', { name: v.name, message: v.message || '' });

  // porte pubblicate da più servizi (stesso IP o tutte le interfacce)
  const byPort = new Map();
  for (const s of model.services) {
    for (const p of s.ports) {
      for (const n of publishedNumbers(p)) {
        const key = `${n}/${p.protocol}`;
        const list = byPort.get(key) || [];
        list.push({ service: s.name, hostIp: p.hostIp, index: p.index });
        byPort.set(key, list);
      }
    }
  }
  for (const [key, list] of byPort) {
    const [port] = key.split('/');
    const clash = list.length > 1 && list.some((a, i) => list.some((b, j) => i !== j && (!a.hostIp || !b.hostIp || a.hostIp === b.hostIp || /^0\.0\.0\.0$|^::$/.test(a.hostIp) || /^0\.0\.0\.0$|^::$/.test(b.hostIp))));
    if (clash) for (const x of list.slice(1)) add('error', 'port_duplicate', { port: Number(port), service: x.service, other: list[0].service }, { service: x.service, port: { index: x.index }, fix: 'change_port' });
  }

  const deps = new Map(model.services.map(s => [s.name, s.dependsOn.map(d => d.service)]));
  for (const s of model.services) {
    const kind = imageKind(s.image);
    if (!s.image && !s.build && !s.extends) add('error', 'no_image', { service: s.name }, { service: s.name });
    if (s.image && !s.build) {
      const ref = s.image.replace(/@sha256:.*$/, '');
      const tag = /:([^/:]+)$/.exec(ref)?.[1];
      if (!/@sha256:/.test(s.image) && (!tag || tag === 'latest')) add('warning', 'image_latest', { service: s.name, image: s.image }, { service: s.name });
    }
    if (s.build?.context && !/^[a-z]+:\/\//i.test(s.build.context) && !/^git@/.test(s.build.context)) {
      const ctxDir = resolve(s.build.context);
      if (!exists(ctxDir)) add('error', 'build_context_missing', { service: s.name, path: s.build.context }, { service: s.name });
      else {
        const df = s.build.dockerfile || 'Dockerfile';
        if (!/^\s/.test(df) && !exists(path.resolve(ctxDir, df))) add('error', 'dockerfile_missing', { service: s.name, path: path.join(s.build.context, df) }, { service: s.name });
      }
    }
    // dipendenze
    for (const d of s.dependsOn) {
      if (!names.has(d.service)) { add('error', 'depends_unknown', { service: s.name, target: d.service }, { service: s.name }); continue; }
      const target = model.services.find(x => x.name === d.service);
      if (d.condition === 'service_healthy' && !target.healthcheck) {
        add(target.healthcheckDisabled ? 'error' : 'warning', 'healthy_without_healthcheck', { service: s.name, target: d.service },
          { service: s.name, fix: imageKind(target.image)?.healthcheck ? 'add_healthcheck' : null, target: d.service });
      }
      const tk = imageKind(target.image);
      if (d.condition === 'service_started' && tk && ['db', 'cache', 'queue', 'search'].includes(tk.kind)) {
        add('info', 'depends_not_ready', { service: s.name, target: d.service }, { service: s.name, target: d.service, fix: tk.healthcheck || target.healthcheck ? 'wait_healthy' : null });
      }
    }
    // porte
    for (const p of s.ports) {
      for (const n of publishedNumbers(p)) {
        if (ownPorts.has(n)) continue;
        const owner = containerPorts.get(n);
        const proc = listening.get(n);
        if (owner) add('warning', 'port_used_container', { service: s.name, port: n, container: owner }, { service: s.name, port: { index: p.index }, fix: 'change_port' });
        else if (proc) add('warning', 'port_in_use', { service: s.name, port: n, process: proc.name || '?', pid: proc.pid ?? '?' }, { service: s.name, port: { index: p.index }, fix: 'change_port' });
      }
      if (kind && ['db', 'cache', 'queue', 'search'].includes(kind.kind) && p.published != null && (!p.hostIp || p.hostIp === '0.0.0.0' || p.hostIp === '::')) {
        add('info', 'port_all_interfaces', { service: s.name, port: p.published }, { service: s.name, port: { index: p.index }, fix: 'bind_localhost' });
      }
    }
    // volumi
    for (const v of s.volumes) {
      if (v.type === 'volume' && v.source && !model.volumes.includes(v.source)) add('error', 'volume_undeclared', { service: s.name, volume: v.source }, { service: s.name, fix: 'declare_volume', name: v.source });
      if (v.type === 'bind' && v.source && !String(v.source).includes('$') && !exists(resolve(v.source))) add('warning', 'bind_missing', { service: s.name, path: v.source }, { service: s.name });
      if (v.type === 'bind' && /(^|[\\/])docker\.sock$/.test(String(v.source || ''))) add('warning', 'docker_socket', { service: s.name }, { service: s.name });
    }
    for (const n of s.networks) if (n !== 'default' && !model.networks.includes(n)) add('error', 'network_undeclared', { service: s.name, network: n }, { service: s.name, fix: 'declare_network', name: n });
    for (const f of s.envFiles) if (f.required && f.path && !exists(resolve(f.path))) add('error', 'env_file_missing', { service: s.name, path: f.path }, { service: s.name });
    // segreti scritti nel file
    for (const [k, v] of Object.entries(s.environment)) {
      if (SECRET_NAME_RE.test(k) && v != null && v !== '' && !s.rawEnvVars?.has(k)) add('warning', 'secret_plain', { service: s.name, name: k }, { service: s.name });
    }
    if (s.privileged) add('warning', 'privileged', { service: s.name }, { service: s.name });
    if (s.networkMode === 'host' && s.ports.length) add('warning', 'host_mode_ports', { service: s.name }, { service: s.name });
    if (s.containerName && s.deployReplicas > 1) add('error', 'container_name_replicas', { service: s.name }, { service: s.name });
  }
  // nomi di container ripetuti
  const cn = new Map();
  for (const s of model.services) if (s.containerName) cn.set(s.containerName, [...(cn.get(s.containerName) || []), s.name]);
  for (const [name, list] of cn) if (list.length > 1) add('error', 'container_name_duplicate', { name, services: list.join(', ') }, { service: list[1] });
  // cicli nelle dipendenze
  const cycle = findCycle(deps);
  if (cycle) add('error', 'depends_cycle', { cycle: cycle.join(' → ') }, { service: cycle[0] });
  // dichiarati e mai usati
  const usedVolumes = new Set(model.services.flatMap(s => s.volumes.filter(v => v.type === 'volume' && v.source).map(v => v.source)));
  for (const v of model.volumes) if (!usedVolumes.has(v)) add('info', 'volume_unused', { volume: v }, { fix: 'remove_volume', name: v });
  const usedNetworks = new Set(model.services.flatMap(s => s.networks));
  for (const n of model.networks) if (n !== 'default' && !usedNetworks.has(n)) add('info', 'network_unused', { network: n }, { fix: 'remove_network', name: n });

  const order = { error: 0, warning: 1, info: 2 };
  return issues.sort((a, b) => order[a.level] - order[b.level]);
}
function findCycle(deps) {
  const state = new Map(), stack = [];
  const visit = n => {
    if (state.get(n) === 1) return stack.slice(stack.indexOf(n)).concat(n);
    if (state.get(n) === 2 || !deps.has(n)) return null;
    state.set(n, 1); stack.push(n);
    for (const d of deps.get(n)) { const c = visit(d); if (c) return c; }
    stack.pop(); state.set(n, 2);
    return null;
  };
  for (const n of deps.keys()) { const c = visit(n); if (c) return c; }
  return null;
}

// Prima porta libera da `from` in su, evitando quelle date
function freePort(from, used) {
  for (let p = Math.max(1024, Number(from) || 1024); p < 65535; p++) if (!used.has(p)) return p;
  return null;
}

// ---- modifiche al documento (commenti e formattazione del resto restano) ----
const isMap = n => YAML.isMap(n);
function servicesNode(doc, create = false) {
  if (!doc.contents || !isMap(doc.contents)) { if (!create) return null; doc.contents = doc.createNode({}); }
  let s = doc.get('services', true);
  if (!isMap(s)) { if (!create) return null; doc.set('services', doc.createNode({})); s = doc.get('services', true); }
  return s;
}
function serviceNode(doc, name) { return servicesNode(doc)?.get(name, true) || null; }
const sameJson = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const checkName = n => { if (typeof n !== 'string' || !NAME_RE.test(n)) throw new ComposeError('name_invalid', { name: String(n ?? '') }); return n; };

// valori semplici del servizio (stringhe, numeri, booleani, liste e mappe di questi)
function plain(v, depth = 0) {
  if (depth > 8) throw new ComposeError('value_invalid');
  if (v === null || ['string', 'number', 'boolean'].includes(typeof v)) return v;
  if (Array.isArray(v)) return v.map(x => plain(x, depth + 1));
  if (typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [String(k), plain(x, depth + 1)]));
  throw new ComposeError('value_invalid');
}

// Servizio scritto dall'editor visuale: solo le chiavi cambiate vengono riscritte
function setService(doc, name, data) {
  checkName(name);
  const services = servicesNode(doc, true);
  const value = plain(data || {});
  let node = services.get(name, true);
  if (!isMap(node)) { services.set(name, doc.createNode(value)); return; }
  const current = node.toJSON?.() ?? {};
  for (const key of Object.keys(current)) if (key !== '<<' && !(key in value) && node.has(key)) node.delete(key);
  for (const [key, v] of Object.entries(value)) {
    if (sameJson(current[key], v)) continue;
    node.set(key, doc.createNode(v));
  }
}
function referencesRename(doc, from, to) {
  const services = servicesNode(doc);
  for (const pair of services?.items || []) {
    const s = pair.value;
    if (!isMap(s)) continue;
    const dep = s.get('depends_on', true);
    if (YAML.isSeq(dep)) for (const it of dep.items) { if (YAML.isScalar(it) && it.value === from) { if (to) it.value = to; } }
    if (isMap(dep)) for (const it of dep.items) { if (YAML.isScalar(it.key) && it.key.value === from && to) it.key.value = to; }
    if (!to) {
      if (YAML.isSeq(dep)) dep.items = dep.items.filter(it => !(YAML.isScalar(it) && it.value === from));
      if (isMap(dep)) dep.items = dep.items.filter(it => !(YAML.isScalar(it.key) && it.key.value === from));
      if ((YAML.isSeq(dep) || isMap(dep)) && !dep.items.length) s.delete('depends_on');
    }
    const links = s.get('links', true);
    if (YAML.isSeq(links)) {
      for (const it of links.items) if (YAML.isScalar(it) && to && (it.value === from || String(it.value).startsWith(`${from}:`))) it.value = to + String(it.value).slice(from.length);
      if (!to) { links.items = links.items.filter(it => !(YAML.isScalar(it) && (it.value === from || String(it.value).startsWith(`${from}:`)))); if (!links.items.length) s.delete('links'); }
    }
    const nm = s.get('network_mode');
    if (nm === `service:${from}`) { if (to) s.set('network_mode', `service:${to}`); else s.delete('network_mode'); }
    const vf = s.get('volumes_from', true);
    if (YAML.isSeq(vf)) {
      for (const it of vf.items) if (YAML.isScalar(it) && to && (it.value === from || String(it.value).startsWith(`${from}:`))) it.value = to + String(it.value).slice(from.length);
      if (!to) { vf.items = vf.items.filter(it => !(YAML.isScalar(it) && (it.value === from || String(it.value).startsWith(`${from}:`)))); if (!vf.items.length) s.delete('volumes_from'); }
    }
  }
}
function renameService(doc, from, to) {
  checkName(from); checkName(to);
  const services = servicesNode(doc);
  if (!services?.has(from)) throw new ComposeError('service_missing', { service: from });
  if (from === to) return;
  if (services.has(to)) throw new ComposeError('service_exists', { service: to });
  const pair = services.items.find(p => (YAML.isScalar(p.key) ? p.key.value : p.key) === from);
  if (YAML.isScalar(pair.key)) pair.key.value = to; else pair.key = doc.createNode(to);
  referencesRename(doc, from, to);
}
function removeService(doc, name) {
  const services = servicesNode(doc);
  if (!services?.has(name)) throw new ComposeError('service_missing', { service: name });
  services.delete(name);
  referencesRename(doc, name, null);
}
function declare(doc, kind, name) {
  checkName(name);
  if (!doc.contents || !isMap(doc.contents)) doc.contents = doc.createNode({});
  let node = doc.get(kind, true);
  if (!isMap(node)) { doc.set(kind, doc.createNode({})); node = doc.get(kind, true); }
  if (!node.has(name)) node.set(name, doc.createNode({}));
}
function undeclare(doc, kind, name) {
  const node = doc.get(kind, true);
  if (isMap(node)) { node.delete(name); if (!node.items.length) doc.delete(kind); }
}
function addService(doc, name, data, { volumes = [] } = {}) {
  checkName(name);
  const services = servicesNode(doc, true);
  if (services.has(name)) throw new ComposeError('service_exists', { service: name });
  services.set(name, doc.createNode(plain(data)));
  for (const v of volumes) declare(doc, 'volumes', v);
}

// Correzione di un problema dell'analisi sul documento
function applyFix(doc, issue, { used = new Set() } = {}) {
  const svc = issue.service ? serviceNode(doc, issue.service) : null;
  switch (issue.fix) {
    case 'remove_version': doc.delete('version'); return;
    case 'declare_volume': declare(doc, 'volumes', issue.name); return;
    case 'declare_network': declare(doc, 'networks', issue.name); return;
    case 'remove_volume': undeclare(doc, 'volumes', issue.name); return;
    case 'remove_network': undeclare(doc, 'networks', issue.name); return;
    case 'add_healthcheck': case 'wait_healthy': {
      const target = serviceNode(doc, issue.target);
      if (!target) throw new ComposeError('service_missing', { service: issue.target });
      if (!target.has('healthcheck')) {
        const hc = imageKind(target.get('image'))?.healthcheck;
        if (!hc) throw new ComposeError('fix_unavailable');
        target.set('healthcheck', doc.createNode(hc));
      }
      if (issue.fix === 'wait_healthy' && svc) {
        const dep = svc.get('depends_on', true);
        if (YAML.isSeq(dep)) {
          const map = Object.fromEntries(dep.items.map(it => [String(YAML.isScalar(it) ? it.value : it), { condition: 'service_started' }]));
          map[issue.target] = { condition: 'service_healthy' };
          svc.set('depends_on', doc.createNode(map));
        } else if (isMap(dep)) {
          const cur = dep.get(issue.target, true);
          if (isMap(cur)) cur.set('condition', 'service_healthy'); else dep.set(issue.target, doc.createNode({ condition: 'service_healthy' }));
        }
      }
      return;
    }
    case 'bind_localhost': case 'change_port': {
      const ports = svc?.get('ports', true);
      const item = YAML.isSeq(ports) ? ports.items[issue.port?.index] : null;
      if (!item) throw new ComposeError('fix_unavailable');
      if (isMap(item)) {
        if (issue.fix === 'bind_localhost') item.set('host_ip', '127.0.0.1');
        else item.set('published', String(freePort(Number(item.get('published')) + 1, used)));
        return;
      }
      const p = parsePortShort(YAML.isScalar(item) ? item.value : item);
      const hostIp = issue.fix === 'bind_localhost' ? '127.0.0.1' : p.hostIp;
      const published = issue.fix === 'change_port' ? String(freePort(Number(String(p.published).split('-')[0]) + 1, used)) : p.published;
      const ip = hostIp ? (hostIp.includes(':') ? `[${hostIp}]:` : `${hostIp}:`) : '';
      const text = `${ip}${published != null ? `${published}:` : ''}${p.target}${p.protocol !== 'tcp' ? `/${p.protocol}` : ''}`;
      if (YAML.isScalar(item)) { item.value = text; item.type = 'QUOTE_DOUBLE'; } else ports.items[issue.port.index] = doc.createNode(text);
      return;
    }
    default: throw new ComposeError('fix_unavailable');
  }
}

// Testo del documento dopo le modifiche (liste in linea come le scrive chi usa compose: ['a', 'b'])
function stringify(doc) { return doc.toString({ lineWidth: 0, indentSeq: true, flowCollectionPadding: false }); }

// ---- file dei progetti ----
const SKIP_DIRS = new Set(['node_modules', '.git', 'vendor', 'dist', 'build', 'target', '.angular', '.next', 'coverage']);
function findComposeFiles(dir) {
  const out = [];
  const scan = (d, rel, depth) => {
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.isFile() && FILE_RE.test(e.name)) out.push(rel ? `${rel}/${e.name}` : e.name);
      else if (e.isDirectory() && depth < 1 && !SKIP_DIRS.has(e.name) && (!e.name.startsWith('.') || e.name === '.docker' || e.name === '.devcontainer')) scan(path.join(d, e.name), rel ? `${rel}/${e.name}` : e.name, depth + 1);
    }
  };
  scan(dir, '', 0);
  return out.sort((a, b) => a.split('/').length - b.split('/').length || BASE_NAMES.indexOf(path.basename(a)) - BASE_NAMES.indexOf(path.basename(b)) || a.localeCompare(b));
}
// override che docker compose applica da solo accanto a un file principale
function overrideOf(file, exists = fs.existsSync) {
  const base = path.basename(file);
  if (!BASE_NAMES.includes(base)) return null;
  const dir = path.dirname(file);
  for (const n of [base.replace(/\.ya?ml$/, '.override.yaml'), base.replace(/\.ya?ml$/, '.override.yml')]) if (exists(path.join(dir, n))) return path.join(dir, n);
  return null;
}
// file principale di un override (compose.override.yaml → compose.yaml)
function baseOf(file, exists = fs.existsSync) {
  const m = /^((?:docker-)?compose)\.override\.ya?ml$/.exec(path.basename(file));
  if (!m) return null;
  for (const ext of ['yaml', 'yml']) { const p = path.join(path.dirname(file), `${m[1]}.${ext}`); if (exists(p)) return p; }
  return null;
}

module.exports = {
  ComposeError, BASE_NAMES, FILE_RE, NAME_RE, VAR_RE, SECRET_NAME_RE,
  parseDotenv, interpolate, interpolateTree, variablesIn, parseDoc, yamlErrors,
  parsePortShort, normalizePorts, publishedNumbers, normalizeVolumes, normalizeEnv, normalizeDepends, normalizeService, normalize, mergeCompose,
  imageKind, dbConnectionOf, analyze, findCycle, freePort,
  setService, renameService, removeService, addService, declare, undeclare, applyFix, stringify, servicesNode, plain, checkName,
  findComposeFiles, overrideOf, baseOf, YAML,
};
