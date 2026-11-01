// Porte in uso: porte TCP in ascolto con il processo, collegate a ciò che Kelbo
// conosce (script npm, PM2, tunnel), e arresto del processo che occupa una porta.
const os = require('os');
const { execFile } = require('child_process');

module.exports = function createPorts(ctx) {
  const npm = ctx.require('npm');
  const pm2 = ctx.require('pm2');
  const tunnels = ctx.require('tunnels');
  const me = os.userInfo().username;
  const { listListeningPorts } = ctx.lib.ports;

  // Chi ha avviato il processo, se è Kelbo (npm usa process group, ssh/autossh e PM2 il pid o il padre)
  function ownerOf(p, known) {
    if (p.pid === process.pid) return { type: 'kelbo' };
    const npmProc = known.npm.find(x => x.pid === p.pgid || x.pid === p.pid);
    if (npmProc) return { type: 'npm', id: npmProc.id, label: `${npmProc.project} — ${npmProc.script}`, projectId: npmProc.projectId ?? null };
    const pm2Proc = known.pm2.find(x => x.pid === p.pid || x.pid === p.ppid);
    if (pm2Proc) return { type: 'pm2', id: pm2Proc.name, label: pm2Proc.name };
    const tunnel = known.tunnels.find(x => x.pid === p.pid || x.pid === p.ppid);
    if (tunnel) return { type: 'tunnel', id: tunnel.id, label: `${tunnel.label} :${tunnel.port}` };
    return null;
  }

  async function ports() {
    const known = {
      npm: npm ? npm.processes() : [],
      pm2: pm2 ? await pm2.processes() : [],
      tunnels: tunnels ? tunnels.activeTunnels() : [],
    };
    return listListeningPorts().map(p => ({
      port: p.port, addresses: p.addresses, pid: p.pid, name: p.name, user: p.user, command: p.command,
      own: process.platform === 'win32' ? true : p.user === me, // si fermano solo i processi dell'utente
      owner: ownerOf(p, known),
    }));
  }

  // La porta è stata liberata? (si aspetta al massimo ~2 s)
  async function freed(port, pid) {
    for (let i = 0; i < 10; i++) {
      await new Promise(r => setTimeout(r, 200));
      if (!listListeningPorts().some(p => p.port === port && p.pid === pid)) return true;
    }
    return false;
  }

  const kill = (pid, force) => new Promise((resolve, reject) => {
    if (process.platform === 'win32') {
      execFile('taskkill', ['/PID', String(pid), ...(force ? ['/F'] : [])], err => (err ? reject(err) : resolve()));
    } else {
      try { process.kill(pid, force ? 'SIGKILL' : 'SIGTERM'); resolve(); } catch (e) { reject(e); }
    }
  });

  return {
    handlers: {
      async list(req, res) {
        res.json({ ports: await ports(), platform: process.platform });
      },

      // Ferma il processo { port, pid, force } se è ancora in ascolto su quella porta. I processi
      // avviati da Kelbo passano dalla loro estensione, così il suo stato resta coerente;
      // force: chiusura forzata (SIGKILL / taskkill /F). Risponde se la porta si è liberata.
      async stop(req, res) {
        const port = Number(req.body.port), pid = Number(req.body.pid);
        const entry = (await ports()).find(p => p.port === port && p.pid === pid);
        if (!entry) throw ctx.error(404, 'not_listening', { port: String(port), pid: String(pid) });
        if (entry.owner?.type === 'kelbo') throw ctx.error(400, 'self');
        if (!entry.own) throw ctx.error(403, 'not_owner', { user: entry.user || '?' });
        const via = entry.owner?.type || 'signal';
        const force = req.body.force === true;
        let ok = true;
        try {
          if (via === 'npm') ok = npm.stopProcess(entry.owner.id, { force });
          else if (via === 'tunnel') ok = tunnels.stopTunnel(entry.owner.id, { force });
          else if (via === 'pm2') {
            // PM2 riavvierebbe un processo ucciso: prima lo si ferma in PM2, poi (forzando) il pid
            ok = await pm2.stop(entry.owner.id);
            if (force) await kill(pid, true).catch(() => {});
          } else await kill(pid, force);
        } catch (e) { throw ctx.error(e.code === 'EPERM' ? 403 : 500, 'kill_failed', { error: e.message }); }
        if (!ok) throw ctx.error(500, 'stop_failed', { via });
        res.json({ ok: true, via, force, freed: await freed(port, pid) });
      },
    },

    mcp: {
      async list({ port } = {}) {
        const all = await ports();
        const list = port ? all.filter(p => p.port === Number(port)) : all;
        return { ports: list.map(({ own, ...p }) => p) };
      },
    },
  };
};
