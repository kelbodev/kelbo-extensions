// Script: i file eseguibili delle cartelle di script dei progetti (bin, scripts, tools…) avviati
// come processi tracciati, come gli script npm: output in streaming, arresto, riavvio.
// L'interprete dipende dal tipo di file e dal sistema operativo; i file che qui non si possono
// eseguire (un .bat su macOS) non sono elencati, quelli senza interprete installato sì, spenti.
const { spawn, execFileSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const MAX_LOG_LINES = 1000;
const MAX_DEPTH = 2;          // cartella di script e due livelli sotto
const MAX_FILES = 500;
const MAX_ARGS = 50;
const MAX_ARG_LEN = 1000;
const WIN = process.platform === 'win32';

// Cartelle cercate nella radice del progetto (le stesse del tratto "scripts" nel manifest)
const FOLDERS = ['bin', 'script', 'scripts', 'local-scripts', 'local_scripts', 'dev-scripts', 'tools', 'tasks', '.scripts'];

module.exports = function createScript(ctx) {
  const { hasCommand } = ctx.lib.system;
  const processes = new Map(); // id → { id, projectId, projectLabel, script, args, runner, pid, process, startedAt, logs[], running, exitCode }

  // ---- interpreti ----

  const commands = new Map(); // comando → disponibile (cache: non cambia mentre Kelbo gira)
  const has = cmd => { if (!commands.has(cmd)) commands.set(cmd, hasCommand(cmd)); return commands.get(cmd); };

  // Node con i tipi TypeScript tolti: predefinito da Node 22.18 / 23.6, prima serve il flag
  function nodeStripsTypes() {
    const [major, minor] = process.versions.node.split('.').map(Number);
    return major > 23 || (major === 23 && minor >= 6) || (major === 22 && minor >= 18);
  }

  // Prima riga "#!…" → [comando, ...argomenti] ("/usr/bin/env node" → ["node"])
  function shebang(file) {
    let head = '';
    try {
      const fd = fs.openSync(file, 'r');
      const buf = Buffer.alloc(256);
      const n = fs.readSync(fd, buf, 0, 256, 0);
      fs.closeSync(fd);
      head = buf.subarray(0, n).toString('utf8');
    } catch { return null; }
    if (!head.startsWith('#!')) return null;
    const parts = head.slice(2).split(/\r?\n/)[0].trim().split(/\s+/).filter(Boolean);
    if (!parts.length) return null;
    if (path.basename(parts[0]) === 'env') {
      const rest = parts.slice(1).filter(x => x !== '-S');
      return rest.length ? rest : null;
    }
    return parts;
  }

  // Come si esegue un file: { kind, label, cmd, args } (args prima del file), oppure
  // { kind, label, missing } se l'interprete non c'è; null se su questo sistema non si esegue
  function runnerFor(file, projectDir) {
    const ext = path.extname(file).toLowerCase();
    const name = path.basename(file).toLowerCase();
    if (name.endsWith('.d.ts') || name.endsWith('.d.mts') || name.endsWith('.d.cts')) return null;
    if (['.js', '.mjs', '.cjs'].includes(ext)) return { kind: 'node', label: 'node', cmd: process.execPath, args: [] };
    if (['.ts', '.mts', '.cts'].includes(ext)) {
      const tsx = path.join(projectDir, 'node_modules', '.bin', WIN ? 'tsx.cmd' : 'tsx');
      if (fs.existsSync(tsx)) return { kind: 'ts', label: 'tsx', cmd: tsx, args: [], shell: WIN };
      return { kind: 'ts', label: 'node', cmd: process.execPath, args: nodeStripsTypes() ? [] : ['--experimental-strip-types'] };
    }
    if (ext === '.sh' || ext === '.bash') {
      return has('bash') ? { kind: 'shell', label: 'bash', cmd: 'bash', args: [] } : { kind: 'shell', label: 'bash', missing: 'bash' };
    }
    if (ext === '.zsh') return has('zsh') ? { kind: 'shell', label: 'zsh', cmd: 'zsh', args: [] } : { kind: 'shell', label: 'zsh', missing: 'zsh' };
    if (ext === '.ps1') {
      if (WIN) return { kind: 'powershell', label: 'powershell', cmd: 'powershell.exe', args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File'] };
      return has('pwsh') ? { kind: 'powershell', label: 'pwsh', cmd: 'pwsh', args: ['-NoProfile', '-File'] } : null;
    }
    if (ext === '.bat' || ext === '.cmd') return WIN ? { kind: 'batch', label: 'cmd', cmd: 'cmd.exe', args: ['/d', '/c'] } : null;
    // senza estensione (o con un'altra): solo se ha "#!", e non su Windows
    if (WIN) return null;
    const sb = shebang(file);
    if (!sb) return null;
    const [cmd, ...args] = sb;
    const label = path.basename(cmd);
    if (label === 'node') return { kind: 'node', label, cmd: process.execPath, args };
    if (!path.isAbsolute(cmd) && !has(cmd)) return { kind: 'shebang', label, missing: cmd };
    if (path.isAbsolute(cmd) && !fs.existsSync(cmd)) return { kind: 'shebang', label, missing: cmd };
    return { kind: 'shebang', label, cmd, args };
  }

  // ---- ricerca degli script ----

  const toRel = (root, file) => path.relative(root, file).split(path.sep).join('/');

  // { folders: [nomi trovati], scripts: [{ id, name, folder, path, kind, runner, available, missing? }] }
  function discover(p) {
    const root = p.path;
    const found = [];
    const folders = [];
    const walk = (dir, depth) => {
      let entries;
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      entries.sort((a, b) => a.name.localeCompare(b.name));
      for (const e of entries) {
        if (found.length >= MAX_FILES) return;
        if (e.name.startsWith('.') || e.name === 'node_modules') continue;
        const full = path.join(dir, e.name);
        if (e.isDirectory()) { if (depth < MAX_DEPTH) walk(full, depth + 1); continue; }
        // link a un file (bin/x → ../lib/x.js): elencato; al momento di avviarlo si controlla
        // che punti dentro il progetto
        if (!e.isFile() && !(e.isSymbolicLink() && (() => { try { return fs.statSync(full).isFile(); } catch { return false; } })())) continue;
        const r = runnerFor(full, root);
        if (!r) continue;
        const id = toRel(root, full);
        found.push({
          id, name: e.name, folder: toRel(root, dir), kind: r.kind, runner: r.label,
          available: !r.missing, ...(r.missing ? { missing: r.missing } : {}),
        });
      }
    };
    for (const f of FOLDERS) {
      const dir = path.join(root, f);
      let st;
      try { st = fs.statSync(dir); } catch { continue; }
      if (!st.isDirectory()) continue;
      folders.push(f);
      walk(dir, 0);
    }
    return { folders, scripts: found };
  }

  // Script richiesto: deve essere fra quelli trovati (niente percorsi arbitrari) e restare
  // dentro il progetto anche seguendo i link simbolici
  function resolveScript(p, id) {
    if (typeof id !== 'string' || !id || id.length > 1024) throw ctx.error(400, 'script_required');
    const entry = discover(p).scripts.find(s => s.id === id);
    if (!entry) throw ctx.error(404, 'script_not_found', { script: id });
    const file = path.join(p.path, ...id.split('/'));
    let real, realRoot;
    try { real = fs.realpathSync(file); realRoot = fs.realpathSync(p.path); } catch { throw ctx.error(404, 'script_not_found', { script: id }); }
    if (real !== realRoot && !real.startsWith(realRoot + path.sep)) throw ctx.error(400, 'script_outside', { script: id });
    const runner = runnerFor(file, p.path);
    if (!runner) throw ctx.error(404, 'script_not_found', { script: id });
    if (runner.missing) throw ctx.error(400, 'runner_missing', { command: runner.missing, script: id });
    return { entry, file, runner };
  }

  function checkArgs(args) {
    if (args === undefined || args === null) return [];
    if (!Array.isArray(args) || args.length > MAX_ARGS
      || !args.every(a => typeof a === 'string' && a.length <= MAX_ARG_LEN && !a.includes('\0'))) throw ctx.error(400, 'args_invalid');
    return args;
  }

  // ---- processi tracciati (come gli script npm) ----

  function log(pd, text) {
    pd.logs.push({ seq: ++pd.seq, text });
    if (pd.logs.length > MAX_LOG_LINES) pd.logs.splice(0, pd.logs.length - MAX_LOG_LINES);
  }

  // Avvia (o riavvia) lo script in un process group dedicato; gli eventi di un processo
  // sostituito da un riavvio vengono ignorati
  function spawnScript(pd, p, header = '') {
    const { file, runner } = resolveScript(p, pd.script);
    const argv = [...runner.args, file, ...pd.args];
    const proc = spawn(runner.cmd, argv, {
      cwd: p.path, env: { ...process.env }, detached: !WIN, windowsHide: true,
      // tsx.cmd su Windows passa da cmd.exe: argomenti già validati, senza spazi interpretati
      ...(runner.shell ? { shell: true } : {}),
    });
    pd.process = proc; pd.pid = proc.pid; pd.runner = runner.label;
    pd.startedAt = new Date().toISOString();
    pd.running = true; pd.exitCode = null;
    const shown = [...runner.args, pd.script, ...pd.args].map(x => (!x || /[\s"'\\]/.test(x) ? JSON.stringify(x) : x)).join(' ');
    log(pd, `${header}$ ${runner.label} ${shown} (pid ${proc.pid})\n`);
    const current = () => pd.process === proc;
    proc.stdout.on('data', d => log(pd, d.toString()));
    proc.stderr.on('data', d => log(pd, d.toString()));
    proc.on('close', code => {
      if (!current()) return;
      pd.running = false; pd.exitCode = code;
      log(pd, `\n[exit ${code}]`);
    });
    proc.on('error', err => { if (current()) { pd.running = false; log(pd, `\n[error: ${err.message}]`); } });
  }

  function startScript(p, script, args) {
    const pd = {
      id: crypto.randomUUID(), projectId: p.id, projectLabel: p.label,
      script, args, runner: null, pid: null, process: null,
      startedAt: null, logs: [], seq: 0, running: false, exitCode: null,
    };
    spawnScript(pd, p); // prima: se lo script non è valido non resta un processo vuoto
    processes.set(pd.id, pd);
    return pd;
  }

  // Ferma l'intero albero del processo; force: SIGKILL (processi che non rispondono)
  function killTree(pd, force = false) {
    if (!pd.process || !pd.pid) return;
    if (WIN) {
      try { execFileSync('taskkill', ['/pid', String(pd.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { try { pd.process.kill(); } catch {} }
      return;
    }
    const signal = force ? 'SIGKILL' : 'SIGTERM';
    try { process.kill(-pd.pid, signal); } catch { try { pd.process.kill(signal); } catch {} }
  }

  const publicProcess = pd => ({
    id: pd.id, projectId: pd.projectId, projectLabel: pd.projectLabel,
    script: pd.script, args: pd.args, runner: pd.runner, pid: pd.pid,
    startedAt: pd.startedAt, running: pd.running, exitCode: pd.exitCode,
  });

  function stop(pd) {
    killTree(pd);
    pd.running = false;
    processes.delete(pd.id);
  }

  const projectOr404 = id => {
    const p = typeof id === 'string' ? ctx.projects.get(id) : null;
    if (!p) throw ctx.error(404, 'project_not_found', { id: String(id) });
    return p;
  };
  const processOr404 = id => {
    const pd = processes.get(id);
    if (!pd) throw ctx.error(404, 'process_not_found');
    return pd;
  };

  return {
    services: {
      // per l'estensione ports o altre: processi in esecuzione (pid = process group)
      processes: () => [...processes.values()].filter(pd => pd.running).map(pd => ({ id: pd.id, pid: pd.pid, project: pd.projectLabel, projectId: pd.projectId, script: pd.script })),
    },

    mcp: {
      scripts({ project } = {}) {
        const list = project ? [projectOr404(project)] : ctx.projects.list({ traits: ['scripts'] });
        return { projects: list.map(p => ({ id: p.id, label: p.label, path: p.path, ...discover(p) })) };
      },
      processes() {
        return { processes: [...processes.values()].map(publicProcess) };
      },
      run({ project, script, args }) {
        const p = projectOr404(project);
        const pd = startScript(p, script, checkArgs(args));
        return { started: true, process: publicProcess(pd) };
      },
      stop({ process: id }) {
        stop(processOr404(id));
        return { stopped: true, id };
      },
      output({ process: id, lines = 100 }) {
        const pd = processOr404(id);
        const n = Math.min(Math.max(parseInt(lines) || 100, 1), 2000);
        const text = pd.logs.map(l => l.text).join('').split('\n');
        return { ...publicProcess(pd), output: text.slice(-n).join('\n'), truncated: text.length > n };
      },
    },

    handlers: {
      // Script del progetto: { folders, scripts, platform }
      list(req, res) {
        const p = projectOr404(req.params.id);
        res.json({ ...discover(p), platform: process.platform });
      },

      run(req, res) {
        const p = projectOr404(req.params.id);
        const pd = startScript(p, req.body?.script, checkArgs(req.body?.args));
        res.json({ id: pd.id, pid: pd.pid });
      },

      listProcesses(req, res) {
        res.json([...processes.values()].map(publicProcess));
      },

      stopProcess(req, res) {
        stop(processOr404(req.params.id));
        res.json({ ok: true });
      },

      restartProcess(req, res) {
        const pd = processOr404(req.params.id);
        const p = ctx.projects.get(pd.projectId);
        if (!p) throw ctx.error(400, 'project_gone');
        killTree(pd);
        spawnScript(pd, p, '\n--- ↻ ---\n');
        res.json({ ok: true, pid: pd.pid });
      },

      // Toglie dalla lista un processo già terminato
      dismissProcess(req, res) {
        const pd = processOr404(req.params.id);
        if (pd.running) throw ctx.error(409, 'process_running');
        processes.delete(pd.id);
        res.json({ ok: true });
      },

      // Output in streaming: prima lo storico, poi le righe nuove ogni 100ms
      processStream(req, res) {
        const pd = processOr404(req.params.id);
        const send = ctx.sse(res);
        if (pd.logs.length) send('history', pd.logs.map(l => l.text).join(''));
        if (!pd.running) { send('exit', { exitCode: pd.exitCode, ended: true }); send.end(); return; }
        let last = pd.seq;
        const timer = setInterval(() => {
          const cur = processes.get(pd.id);
          if (!cur) { clearInterval(timer); send('exit', { removed: true }); send.end(); return; }
          const fresh = cur.logs.filter(l => l.seq > last);
          if (fresh.length) { send('stdout', fresh.map(l => l.text).join('')); last = fresh[fresh.length - 1].seq; }
          if (!cur.running) { clearInterval(timer); send('exit', { exitCode: cur.exitCode }); send.end(); }
        }, 100);
        req.on('close', () => clearInterval(timer));
      },
    },

    shutdown() {
      for (const pd of processes.values()) killTree(pd);
    },
  };
};
