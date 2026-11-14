// Servizi pronti da aggiungere a un compose: immagine con tag preciso, variabili con default
// (così il .env può cambiarle), porta legata a 127.0.0.1 (scelta libera al momento
// dell'aggiunta), volume con nome per i dati, healthcheck dove l'immagine lo permette.
const { imageKind } = require('./compose');

// port: porta del container; volume: [nome suggerito, destinazione]
const TEMPLATES = [
  { id: 'postgres', kind: 'db', image: 'postgres:17', port: 5432, volume: ['pgdata', '/var/lib/postgresql/data'],
    environment: { POSTGRES_USER: '${POSTGRES_USER:-app}', POSTGRES_PASSWORD: '${POSTGRES_PASSWORD:-app}', POSTGRES_DB: '${POSTGRES_DB:-app}' } },
  { id: 'mysql', kind: 'db', image: 'mysql:8.4', port: 3306, volume: ['mysqldata', '/var/lib/mysql'],
    environment: { MYSQL_ROOT_PASSWORD: '${MYSQL_ROOT_PASSWORD:-root}', MYSQL_DATABASE: '${MYSQL_DATABASE:-app}', MYSQL_USER: '${MYSQL_USER:-app}', MYSQL_PASSWORD: '${MYSQL_PASSWORD:-app}' } },
  { id: 'mariadb', kind: 'db', image: 'mariadb:11.4', port: 3306, volume: ['mariadbdata', '/var/lib/mysql'],
    environment: { MARIADB_ROOT_PASSWORD: '${MARIADB_ROOT_PASSWORD:-root}', MARIADB_DATABASE: '${MARIADB_DATABASE:-app}', MARIADB_USER: '${MARIADB_USER:-app}', MARIADB_PASSWORD: '${MARIADB_PASSWORD:-app}' } },
  { id: 'mssql', kind: 'db', image: 'mcr.microsoft.com/mssql/server:2022-latest', port: 1433, volume: ['mssqldata', '/var/opt/mssql'],
    environment: { ACCEPT_EULA: 'Y', MSSQL_SA_PASSWORD: '${MSSQL_SA_PASSWORD:-Kelbo_Passw0rd}', MSSQL_PID: 'Developer' } },
  { id: 'mongo', kind: 'db', image: 'mongo:8.0', port: 27017, volume: ['mongodata', '/data/db'],
    environment: { MONGO_INITDB_ROOT_USERNAME: '${MONGO_USER:-root}', MONGO_INITDB_ROOT_PASSWORD: '${MONGO_PASSWORD:-root}' } },
  { id: 'redis', kind: 'cache', image: 'redis:7.4-alpine', port: 6379, volume: ['redisdata', '/data'] },
  { id: 'rabbitmq', kind: 'queue', image: 'rabbitmq:4.0-management', port: 5672, extraPorts: [15672], volume: ['rabbitdata', '/var/lib/rabbitmq'],
    environment: { RABBITMQ_DEFAULT_USER: '${RABBITMQ_USER:-guest}', RABBITMQ_DEFAULT_PASS: '${RABBITMQ_PASSWORD:-guest}' } },
  { id: 'mailpit', kind: 'mail', image: 'axllent/mailpit:v1.21', port: 8025, extraPorts: [1025] },
  { id: 'adminer', kind: 'web', image: 'adminer:4.8.1', port: 8080 },
  { id: 'nginx', kind: 'web', image: 'nginx:1.27-alpine', port: 80, volumes: ['./nginx.conf:/etc/nginx/conf.d/default.conf:ro'] },
  { id: 'node', kind: 'app', build: '.', port: 3000, command: 'npm run dev', volumes: ['./:/app', '/app/node_modules'],
    environment: { NODE_ENV: 'development' }, workingDir: '/app' },
  { id: 'empty', kind: 'app', image: '' },
];

// Servizio del template: porte libere sull'host (dalla porta del container in su), volume con un
// nome non ancora usato nel file; `dbs` i servizi database già nel file (per depends_on dell'app)
function build(id, { used = new Set(), volumesTaken = new Set(), freePort, dbs = [] } = {}) {
  const t = TEMPLATES.find(x => x.id === id);
  if (!t) return null;
  const take = p => { const n = freePort(p < 1024 ? 8000 + p : p, used); used.add(n); return n; };
  const service = {};
  if (t.image) service.image = t.image;
  if (t.build) service.build = t.build;
  if (t.workingDir) service.working_dir = t.workingDir;
  if (t.command) service.command = t.command;
  if (t.port) service.ports = [t.port, ...(t.extraPorts || [])].map(p => `127.0.0.1:${take(p)}:${p}`);
  if (t.environment) service.environment = { ...t.environment };
  const volumes = [];
  if (t.volume) {
    let name = t.volume[0], i = 2;
    while (volumesTaken.has(name)) name = `${t.volume[0]}${i++}`;
    volumes.push(name);
    service.volumes = [`${name}:${t.volume[1]}`];
  }
  if (t.volumes) service.volumes = [...(service.volumes || []), ...t.volumes];
  const hc = t.image ? imageKind(t.image)?.healthcheck : null;
  if (hc) service.healthcheck = structuredClone(hc);
  if (t.id === 'node' && dbs.length) service.depends_on = Object.fromEntries(dbs.map(d => [d.name, { condition: d.healthy ? 'service_healthy' : 'service_started' }]));
  if (t.id !== 'empty' && t.kind !== 'app') service.restart = 'unless-stopped';
  return { service, volumes };
}

module.exports = { TEMPLATES, build };
