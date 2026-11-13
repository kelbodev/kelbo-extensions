// Angular CLI: generatori (schematic) dei workspace Angular dei progetti con un form costruito dal
// loro schema.json, anteprima con --dry-run prima di scrivere, ng add e ng update. Sempre la CLI
// del progetto (node_modules/@angular/cli, avviata con Node, senza shell), mai una globale.
const { spawn, execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const ng = require('./angular');

const PREVIEW_TIMEOUT_MS = 60000;
const UPDATES_TIMEOUT_MS = 180000;
const MAX_OUTPUT = 400000;
const MAX_RECENT = 10;

module.exports = function createAngularCli(ctx) {
  const busy = new Set();             // progetti con un'operazione che scrive (generate, add, update)
  const running = new Set();          // processi figli, fermati allo spegnimento

  const fromAngular = fn => {
    try { return fn(); } catch (e) { if (e instanceof ng.AngularError) throw ctx.error(400, e.key, e.params); throw e; }
  };

  const projectOr404 = id => {
    const p = typeof id === 'string' ? ctx.projects.get(id) : null;
    if (!p) throw ctx.error(404, 'project_not_found', { id: String(id) });
    return p;
  };
  function workspaceOf(p) {
    if (!fs.existsSync(path.join(p.path, 'angular.json'))) throw ctx.error(404, 'not_angular', { project: p.label });
    return fromAngular(() => ng.workspace(p.path));
  }
  function installedWorkspace(p) {
    const ws = workspaceOf(p);
    if (!ws.installed) throw ctx.error(409, 'not_installed', { project: p.label });
    return ws;
  }

  // ---- generatori ----

  function collections(p) {
    return ng.collectionNames(p.path).map(name => ({
      name,
      version: (() => { try { return JSON.parse(fs.readFileSync(path.join(p.path, 'node_modules', ...name.split('/'), 'package.json'), 'utf8')).version; } catch { return null; } })(),
      schematics: ng.schematicsOf(p.path, name).map(({ schemaFile, ...s }) => s),
    })).filter(c => c.schematics.length);
  }
  function schematicOr404(p, collection, schematic) {
    if (!ng.COLLECTION_RE.test(collection || '') || !ng.SCHEMATIC_RE.test(schematic || '')) throw ctx.error(400, 'schematic_invalid');
    if (!ng.collectionNames(p.path).includes(collection)) throw ctx.error(404, 'collection_not_found', { collection });
    const s = ng.schematicsOf(p.path, collection).find(x => x.name === schematic || x.aliases.includes(schematic));
    if (!s) throw ctx.error(404, 'schematic_not_found', { schematic: `${collection}:${schematic}` });
    return { ...s, schema: ng.readSchema(s.schemaFile) };
  }

  // Argomenti di "ng generate" dal corpo di una richiesta (validati)
  function generateCommand(p, body) {
    const ws = installedWorkspace(p);
    const { collection = ng.DEFAULT_COLLECTION, schematic, project, name, options, folder } = body || {};
    const s = schematicOr404(p, collection, schematic);
    const target = project || ws.defaultProject || undefined;
    const defaults = target ? ng.defaultsFor(ws, target, collection, s.name) : {};
    const targetProject = ws.projects.find(x => x.name === target);
    const built = fromAngular(() => ng.generateArgs({
      collection, schematic: s.name, schema: s.schema, project: target, projects: ws.projects.map(x => x.name), name, options: options || {}, defaults,
      folder, baseFolder: targetProject ? ng.defaultPath(targetProject) : null,
    }));
    return { ws, schematic: s, collection, project: target, ...built };
  }

  // ---- ng add ----

  const packageName = pkg => pkg.replace(/(.)@.*$/, '$1'); // senza versione o tag
  // Campi dello schematic ng-add di un pacchetto installato → { installed, fields | null }
  function ngAddFields(p, name) {
    const found = ng.collectionFile(p.path, name);
    if (!found) return { installed: fs.existsSync(path.join(p.path, 'node_modules', ...name.split('/'), 'package.json')), fields: null };
    let meta = null;
    try { meta = JSON.parse(fs.readFileSync(found.file, 'utf8')).schematics?.['ng-add']; } catch { /* collezione illeggibile */ }
    if (!meta || typeof meta.schema !== 'string') return { installed: true, fields: null };
    const file = path.resolve(path.dirname(found.file), meta.schema);
    return { installed: true, fields: file.startsWith(found.pkgDir + path.sep) ? ng.readSchema(file).fields : null };
  }

  // ---- processi ----

  const env = () => ({ ...process.env, NG_CLI_ANALYTICS: 'false', NO_COLOR: '1', FORCE_COLOR: '0', NG_FORCE_TTY: 'false' });

  // ng con gli argomenti dati nella cartella del progetto → { code, output }; onData per l'output in diretta
  function runNg(p, ws, args, { timeout = 0, onData = null } = {}) {
    return new Promise(resolve => {
      const child = spawn(process.execPath, [ws.ngBin, ...args], { cwd: p.path, env: env(), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      running.add(child);
      let output = '';
      let timer = null;
      const add = d => {
        const text = d.toString();
        if (output.length < MAX_OUTPUT) output += text;
        onData?.(text);
      };
      child.stdout.on('data', add);
      child.stderr.on('data', add);
      if (timeout) timer = setTimeout(() => { add(`\n[timeout ${Math.round(timeout / 1000)}s]\n`); child.kill('SIGKILL'); }, timeout);
      child.on('error', e => { add(`\n[error: ${e.message}]\n`); });
      child.on('close', code => { clearTimeout(timer); running.delete(child); resolve({ code: code ?? -1, output: ng.stripAnsi(output) }); });
    });
  }
  const shown = args => `ng ${args.map(a => (/[\s"'\\]/.test(a) ? JSON.stringify(a) : a)).join(' ')}`;

  // File cambiati nell'albero di lavoro Git (null fuori da un repository o senza git)
  function gitChanges(dir) {
    return new Promise(resolve => {
      if (!ctx.lib.system.hasCommand('git')) { resolve(null); return; }
      execFile('git', ['status', '--porcelain', '--untracked-files=normal'], { cwd: dir, timeout: 15000, windowsHide: true }, (err, out) => {
        if (err) { resolve(null); return; }
        resolve(out.split('\n').filter(Boolean).map(l => l.slice(3).trim()).slice(0, 200));
      });
    });
  }
  async function checkClean(p, confirmed) {
    const files = await gitChanges(p.path);
    if (files?.length && confirmed !== true) throw ctx.error(409, 'git_dirty', { count: files.length }, { files });
    return !!files?.length;
  }

  function lock(p) {
    if (busy.has(p.id)) throw ctx.error(409, 'busy', { project: p.label });
    busy.add(p.id);
    return () => busy.delete(p.id);
  }

  // Esecuzione con l'output in SSE: stdout a pezzi, poi "files" (se richiesto) ed "exit"
  async function streamNg(res, p, ws, args, { parse = false } = {}) {
    const unlock = lock(p);
    const send = ctx.sse(res);
    send('stdout', `$ ${shown(args)}\n`);
    try {
      const r = await runNg(p, ws, args, { onData: text => send('stdout', ng.stripAnsi(text)) });
      if (parse) send('files', ng.parseChanges(r.output).files);
      send('exit', r.code);
      return r;
    } finally { unlock(); send.end(); }
  }

  // ---- generatori recenti (per computer, non esportati) ----

  const recentFile = () => path.join(ctx.dataDir(), 'recent.json');
  function readRecent() {
    try { const d = JSON.parse(fs.readFileSync(recentFile(), 'utf8')); return d && typeof d === 'object' && !Array.isArray(d) ? d : {}; } catch { return {}; }
  }
  function remember(projectId, { collection, schematic, project, options }) {
    const all = readRecent();
    const entry = all[projectId] && typeof all[projectId] === 'object' ? all[projectId] : {};
    const key = `${collection}:${schematic}`;
    const item = { collection, schematic, ...(project ? { project } : {}), options, at: new Date().toISOString() };
    const list = (Array.isArray(entry.recent) ? entry.recent : []).filter(r => !(r.collection === collection && r.schematic === schematic && r.project === project && JSON.stringify(r.options) === JSON.stringify(options)));
    all[projectId] = { recent: [item, ...list].slice(0, MAX_RECENT), last: { ...(entry.last || {}), [key]: options } };
    const tmp = `${recentFile()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(all, null, 2));
    fs.renameSync(tmp, recentFile());
  }
  const recentOf = projectId => { const e = readRecent()[projectId]; return { recent: Array.isArray(e?.recent) ? e.recent : [], last: e?.last && typeof e.last === 'object' ? e.last : {} }; };

  // ---- dati pubblici ----

  function summary(p) {
    const ws = workspaceOf(p);
    const { ngBin, ...rest } = ws;
    return { ...rest, projects: ws.projects.map(({ schematics, ...x }) => ({ ...x, defaultPath: ng.defaultPath(x) })) };
  }
  function schematicDetail(p, collection, schematic) {
    const ws = workspaceOf(p);
    const s = schematicOr404(p, collection, schematic);
    const defaults = Object.fromEntries(ws.projects.map(x => [x.name, ng.defaultsFor(ws, x.name, collection, s.name)]));
    return {
      collection, name: s.name, description: s.description, aliases: s.aliases, ...s.schema,
      defaults, last: recentOf(p.id).last[`${collection}:${s.name}`] || null,
    };
  }
  async function preview(p, body) {
    const cmd = generateCommand(p, body);
    const args = [...cmd.args, '--dry-run', '--interactive=false'];
    const r = await runNg(p, cmd.ws, args, { timeout: PREVIEW_TIMEOUT_MS });
    const changes = ng.parseChanges(r.output, p.path);
    return { ok: r.code === 0 && !changes.conflicts.length, code: r.code, command: shown(cmd.args), ...changes, output: r.output.trim().slice(-20000) };
  }

  return {
    // Dati collegati a un progetto (pannello Progetti): i generatori recenti, solo su questo computer
    projectLinks: project => (recentOf(project.id).recent.length ? [{ key: 'links.recent', params: { count: recentOf(project.id).recent.length } }] : []),

    mcp: {
      workspaces() {
        return { workspaces: ctx.projects.list({ traits: ['angular'] }).map(p => { try { return { id: p.id, label: p.label, path: p.path, ...summary(p) }; } catch (e) { return { id: p.id, label: p.label, path: p.path, error: e.message }; } }) };
      },
      generators({ project }) {
        const p = projectOr404(project);
        workspaceOf(p);
        const list = collections(p).map(c => ({
          ...c,
          schematics: c.schematics.map(s => { const d = ng.readSchema(ng.schematicsOf(p.path, c.name).find(x => x.name === s.name)?.schemaFile); return { ...s, ...d }; }),
        }));
        return { project: p.id, collections: list };
      },
      async generate({ project, collection, schematic, name, options, workspaceProject, folder, apply = false }) {
        const p = projectOr404(project);
        const body = { collection: collection || ng.DEFAULT_COLLECTION, schematic, name, options, project: workspaceProject, folder };
        const dry = await preview(p, body);
        if (apply !== true || !dry.ok) return { applied: false, ...dry };
        const cmd = generateCommand(p, body);
        const unlock = lock(p);
        try {
          const r = await runNg(p, cmd.ws, [...cmd.args, '--interactive=false']);
          if (r.code === 0) remember(p.id, { collection: cmd.collection, schematic: cmd.schematic.name, project: cmd.project, options: cmd.options });
          return { applied: r.code === 0, code: r.code, command: shown(cmd.args), files: ng.parseChanges(r.output).files, output: r.output.trim().slice(-20000) };
        } finally { unlock(); }
      },
    },

    handlers: {
      // Workspace, collezioni con i loro generatori, recenti
      workspace(req, res) {
        const p = projectOr404(req.params.id);
        const ws = summary(p);
        res.json({ ...ws, collections: ws.installed ? collections(p) : [], ...recentOf(p.id), busy: busy.has(p.id) });
      },

      // Cartelle dei sorgenti del workspace, per scegliere dove generare
      folders(req, res) {
        const p = projectOr404(req.params.id);
        const ws = workspaceOf(p);
        res.json({ folders: ng.folders(p.path, ws) });
      },

      schematic(req, res) {
        const p = projectOr404(req.params.id);
        res.json(schematicDetail(p, String(req.query.collection || ng.DEFAULT_COLLECTION), String(req.query.name || '')));
      },

      async preview(req, res) {
        res.json(await preview(projectOr404(req.params.id), req.body));
      },

      async generate(req, res) {
        const p = projectOr404(req.params.id);
        const cmd = generateCommand(p, req.body);
        const r = await streamNg(res, p, cmd.ws, [...cmd.args, '--interactive=false'], { parse: true });
        if (r.code === 0) remember(p.id, { collection: cmd.collection, schematic: cmd.schematic.name, project: cmd.project, options: cmd.options });
      },

      clearRecent(req, res) {
        const p = projectOr404(req.params.id);
        const all = readRecent();
        delete all[p.id];
        fs.writeFileSync(recentFile(), JSON.stringify(all, null, 2));
        res.json({ ok: true });
      },

      async gitStatus(req, res) {
        const p = projectOr404(req.params.id);
        const files = await gitChanges(p.path);
        res.json({ repository: files !== null, files: files || [] });
      },

      // Opzioni di ng-add di un pacchetto già installato (fields null se non ne ha o non c'è)
      addOptions(req, res) {
        const p = projectOr404(req.params.id);
        workspaceOf(p);
        const name = packageName(fromAngular(() => ng.checkPackage(String(req.query.package || ''))));
        res.json({ package: name, ...ngAddFields(p, name) });
      },

      // ng add <pacchetto>: con le opzioni del form se il pacchetto è già installato e le dichiara,
      // altrimenti con le risposte predefinite (--defaults)
      async add(req, res) {
        const p = projectOr404(req.params.id);
        const ws = installedWorkspace(p);
        const pkg = fromAngular(() => ng.checkPackage(req.body?.package));
        const options = req.body?.options;
        const args = ['add', pkg, '--skip-confirmation', '--interactive=false'];
        if (options && typeof options === 'object' && !Array.isArray(options) && Object.keys(options).length) {
          const fields = ngAddFields(p, packageName(pkg)).fields || [];
          for (const [key, raw] of Object.entries(options)) {
            const field = fields.find(f => f.name === key);
            if (!field) throw ctx.error(400, 'option_unknown', { option: key });
            if (raw === undefined || raw === null || raw === '') continue;
            args.push(...ng.optionArgs(field, fromAngular(() => ng.checkValue(field, raw))));
          }
        } else args.push('--defaults');
        await checkClean(p, req.body?.confirmDirty);
        await streamNg(res, p, ws, args, { parse: true });
      },

      // Pacchetti che ng update sa aggiornare (legge il registro npm: può metterci un po')
      async updates(req, res) {
        const p = projectOr404(req.params.id);
        const ws = installedWorkspace(p);
        const r = await runNg(p, ws, ['update'], { timeout: UPDATES_TIMEOUT_MS });
        res.json({ ok: r.code === 0, updates: ng.parseUpdates(r.output), output: r.output.trim().slice(-20000) });
      },

      // ng update di uno o più pacchetti ("nome@versione" come nella tabella di ng update)
      async update(req, res) {
        const p = projectOr404(req.params.id);
        const ws = installedWorkspace(p);
        const list = req.body?.packages;
        if (!Array.isArray(list) || !list.length || list.length > 50) throw ctx.error(400, 'packages_required');
        const packages = list.map(x => fromAngular(() => ng.checkPackage(x)));
        const dirty = await checkClean(p, req.body?.confirmDirty);
        await streamNg(res, p, ws, ['update', ...packages, ...(dirty ? ['--allow-dirty'] : [])]);
      },
    },

    shutdown() {
      for (const child of running) { try { child.kill(); } catch { /* già terminato */ } }
    },
  };
};
