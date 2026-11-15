// Terminale: shell vere in uno pseudo-terminale (@lydell/node-pty, binari già compilati per
// macOS, Linux e Windows), nella cartella di un progetto o nella home. Le sessioni restano vive
// finché Kelbo gira: l'output recente si conserva e si rimanda a chi si ricollega (pagina
// ricaricata, più finestre). xterm.js è servito da qui (niente CDN, funziona anche offline).
const fs = require('fs');
const os = require('os');
const path = require('path');

const MAX_SESSIONS = 20;
const MAX_BUFFER = 512 * 1024;  // output conservato per sessione (caratteri)
const MAX_INPUT = 64 * 1024;
const FLUSH_MS = 8;             // output raccolto prima di mandarlo (meno eventi, stesso flusso)
const VENDOR = {
  'xterm.mjs': ['@xterm/xterm/lib/xterm.mjs', 'text/javascript'],
  'xterm.css': ['@xterm/xterm/css/xterm.css', 'text/css'],
  'addon-fit.mjs': ['@xterm/addon-fit/lib/addon-fit.mjs', 'text/javascript'],
};

module.exports = function createTerminal(ctx) {
  let pty = null, ptyError = null;
  try { pty = require('@lydell/node-pty'); } catch (e) { ptyError = e.message; }
  const sessions = new Map();
  let seq = 0;

  // shell installate: quella dell'utente per prima
  function shells() {
    const out = [];
    const add = (p, name) => { if (p && !out.some(s => s.path === p) && fs.existsSync(p)) out.push({ path: p, name: name || path.basename(p) }); };
    if (process.platform === 'win32') {
      const sys = process.env.SystemRoot || 'C:\\Windows';
      add(path.join(sys, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), 'PowerShell');
      for (const dir of (process.env.PATH || '').split(';')) add(path.join(dir, 'pwsh.exe'), 'PowerShell 7');
      add(process.env.ComSpec || path.join(sys, 'System32', 'cmd.exe'), 'cmd');
      for (const p of ['C:\\Program Files\\Git\\bin\\bash.exe']) add(p, 'Git Bash');
    } else {
      add(process.env.SHELL);
      for (const p of ['/bin/zsh', '/bin/bash', '/usr/bin/fish', '/opt/homebrew/bin/fish', '/usr/local/bin/fish', '/bin/sh']) add(p);
    }
    return out;
  }
  const info = s => ({ id: s.id, title: s.title, shell: s.shell, cwd: s.cwd, projectId: s.projectId, cols: s.cols, rows: s.rows, exited: s.exited, exitCode: s.exitCode, createdAt: s.createdAt, pid: s.pid });
  const size = (v, def, max) => { const n = Number(v); return Number.isInteger(n) && n >= 2 && n <= max ? n : def; };
  const sessionOr404 = id => { const s = sessions.get(String(id)); if (!s) throw ctx.error(404, 'session_not_found'); return s; };

  function create({ projectId = null, shell = null, cols, rows, command = null } = {}) {
    if (!pty) throw ctx.error(503, 'pty_missing', { error: ptyError || '' });
    if (sessions.size >= MAX_SESSIONS) throw ctx.error(429, 'too_many', { max: MAX_SESSIONS });
    let cwd = os.homedir(), project = null;
    if (projectId != null && projectId !== '') {
      project = ctx.projects.get(String(projectId));
      if (!project) throw ctx.error(404, 'project_not_found', { project: String(projectId) });
      if (!fs.existsSync(project.path)) throw ctx.error(404, 'folder_missing', { path: project.path });
      cwd = project.path;
    }
    const available = shells();
    const sh = shell == null ? available[0] : available.find(s => s.path === shell);
    if (!sh) throw ctx.error(400, 'shell_invalid', { shell: String(shell ?? '') });
    if (command != null && (typeof command !== 'string' || command.length > 2000 || /[\r\n]/.test(command))) throw ctx.error(400, 'command_invalid');
    const c = size(cols, 100, 500), r = size(rows, 30, 300);
    const env = { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor', TERM_PROGRAM: 'Kelbo' };
    const proc = pty.spawn(sh.path, process.platform === 'win32' ? [] : ['-l'], { name: 'xterm-256color', cols: c, rows: r, cwd, env });
    const id = `t${Date.now().toString(36)}${(++seq).toString(36)}`;
    const s = {
      id, proc, pid: proc.pid, shell: sh.name, cwd, projectId: project?.id || null,
      title: project ? `${project.label} · ${sh.name}` : `${sh.name} · ~`,
      cols: c, rows: r, buffer: '', listeners: new Set(), exited: false, exitCode: null, createdAt: new Date().toISOString(),
      pending: '', timer: null,
    };
    const flush = () => {
      s.timer = null;
      const data = s.pending; s.pending = '';
      if (!data) return;
      s.buffer = (s.buffer + data).slice(-MAX_BUFFER);
      for (const l of s.listeners) l('data', data);
    };
    proc.onData(d => { s.pending += d; if (!s.timer) s.timer = setTimeout(flush, FLUSH_MS); });
    proc.onExit(({ exitCode }) => {
      clearTimeout(s.timer); flush();
      s.exited = true; s.exitCode = exitCode;
      for (const l of s.listeners) l('exit', exitCode);
    });
    sessions.set(id, s);
    // comando da eseguire appena la shell è pronta (aperto da un'altra estensione): al primo output
    // (il prompt); scritto prima, il terminale lo scarterebbe mentre la shell si prepara
    if (command) {
      let sent = false;
      const go = () => { if (sent || s.exited) return; sent = true; proc.write(`${command}\r`); };
      const first = proc.onData(() => { first.dispose(); setTimeout(go, 60); });
      setTimeout(go, 2000);
    }
    return s;
  }
  function close(s) {
    try { if (!s.exited) s.proc.kill(); } catch { /* già uscita */ }
    clearTimeout(s.timer);
    for (const l of s.listeners) l('closed', null);
    sessions.delete(s.id);
  }

  return {
    handlers: {
      info(req, res) { res.json({ available: !!pty, error: pty ? null : ptyError, shells: shells(), platform: process.platform, home: os.homedir() }); },
      list(req, res) { res.json({ sessions: [...sessions.values()].map(info) }); },
      create(req, res) { res.json({ session: info(create(req.body || {})) }); },
      // SSE: l'output conservato, poi quello nuovo; exit quando la shell finisce
      stream(req, res) {
        const s = sessionOr404(req.params.id);
        const send = ctx.sse(res);
        send('init', info(s));
        if (s.buffer) send('data', s.buffer);
        if (s.exited) send('exit', s.exitCode);
        const l = (type, data) => { send(type, data); if (type === 'closed') send.end(); };
        s.listeners.add(l);
        req.on('close', () => s.listeners.delete(l));
      },
      input(req, res) {
        const s = sessionOr404(req.params.id);
        const data = req.body?.data;
        if (typeof data !== 'string' || data.length > MAX_INPUT) throw ctx.error(400, 'input_invalid');
        if (!s.exited) s.proc.write(data);
        res.json({ ok: true });
      },
      resize(req, res) {
        const s = sessionOr404(req.params.id);
        const c = size(req.body?.cols, null, 500), r = size(req.body?.rows, null, 300);
        if (c == null || r == null) throw ctx.error(400, 'size_invalid');
        if (!s.exited && (c !== s.cols || r !== s.rows)) { try { s.proc.resize(c, r); } catch { /* appena uscita */ } }
        s.cols = c; s.rows = r;
        res.json({ ok: true });
      },
      rename(req, res) {
        const s = sessionOr404(req.params.id);
        const title = String(req.body?.title ?? '').trim();
        if (!title || title.length > 80 || /[\u0000-\u001f]/.test(title)) throw ctx.error(400, 'title_invalid');
        s.title = title;
        res.json({ session: info(s) });
      },
      close(req, res) { close(sessionOr404(req.params.id)); res.json({ ok: true }); },
      // xterm.js dai pacchetti npm dell'estensione
      vendor(req, res) {
        const entry = VENDOR[req.params.file];
        if (!entry) throw ctx.error(404, 'file_not_found');
        const file = require.resolve(entry[0]);
        res.setHeader('Content-Type', `${entry[1]}; charset=utf-8`);
        res.setHeader('Cache-Control', 'public, max-age=86400');
        res.send(fs.readFileSync(file, 'utf8'));
      },
    },
    // per il dialogo di aggiornamento e il riavvio: le shell aperte si chiudono
    running: () => [...sessions.values()].filter(s => !s.exited).map(s => ({ key: 'running.session', params: { title: s.title } })),
    shutdown() { for (const s of [...sessions.values()]) close(s); },
  };
};
