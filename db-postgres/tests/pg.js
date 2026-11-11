// PostgreSQL usa e getta per i test: initdb in una cartella temporanea, server su una porta libera,
// utente "kelbo" con password. Da root il server parte come utente "postgres" (se c'è).
// null se PostgreSQL non è installato: i test che lo usano vengono saltati.
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');

function findBin() {
  for (const dir of [process.env.PG_BIN, ...['17', '16', '15', '14', '13'].map(v => `/usr/lib/postgresql/${v}/bin`), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin']) {
    if (dir && fs.existsSync(path.join(dir, 'initdb')) && fs.existsSync(path.join(dir, 'postgres'))) return dir;
  }
  return null;
}
const freePort = () => new Promise(r => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });

async function startPostgres() {
  const bin = findBin();
  if (!bin) return null;
  const root = process.getuid?.() === 0;
  if (root && spawnSync('id', ['postgres']).status !== 0) return null;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kelbo-pg-'));
  const data = path.join(dir, 'data');
  const pw = path.join(dir, 'pw');
  fs.writeFileSync(pw, 'kelbo-pass\n');
  if (root) { spawnSync('chown', ['-R', 'postgres', dir]); fs.chmodSync(dir, 0o700); }
  const as = (cmd, args, opts = {}) => (root ? ['runuser', ['-u', 'postgres', '--', cmd, ...args], opts] : [cmd, args, opts]);
  const init = spawnSync(...as(path.join(bin, 'initdb'), ['-D', data, '-U', 'kelbo', '--pwfile', pw, '-A', 'scram-sha-256', '--no-sync']), { encoding: 'utf8' });
  if (init.status !== 0) throw new Error(`initdb: ${init.stderr || init.stdout}`);
  const port = await freePort();
  const proc = spawn(...as(path.join(bin, 'postgres'), ['-D', data, '-p', String(port), '-k', dir, '-c', 'listen_addresses=127.0.0.1', '-c', 'fsync=off']), { stdio: 'ignore' });
  const { Client } = require('pg');
  const cfg = { host: '127.0.0.1', port, user: 'kelbo', password: 'kelbo-pass', database: 'postgres' };
  for (let i = 0; i < 100; i++) {
    const c = new Client(cfg);
    try { await c.connect(); await c.query("CREATE DATABASE shop"); await c.end(); break; }
    catch (e) { await c.end().catch(() => {}); if (i === 99) { proc.kill(); throw e; } await new Promise(r => setTimeout(r, 150)); }
  }
  const query = async (sql, db = 'shop') => { const c = new Client({ ...cfg, database: db }); await c.connect(); try { return await c.query(sql); } finally { await c.end(); } };
  return {
    port, user: 'kelbo', password: 'kelbo-pass', query,
    stop() { proc.kill('SIGINT'); setTimeout(() => fs.rmSync(dir, { recursive: true, force: true }), 500); },
  };
}

module.exports = { startPostgres };
