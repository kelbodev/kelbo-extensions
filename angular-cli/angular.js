// Angular CLI senza processi: workspace (angular.json), collezioni di schematic installate, campi
// del form dallo schema.json di uno schematic, validazione dei valori, argomenti di "ng" e
// lettura del suo output. Tutto sincrono e senza effetti, per i test.
const fs = require('fs');
const path = require('path');

const MAX_TEXT = 300;
const MAX_ITEMS = 30;
const NAME_SEGMENT = /^[A-Za-z0-9_$][A-Za-z0-9_.$-]*$/;
const OPTION_RE = /^[A-Za-z][A-Za-z0-9-]*$/;
const PROJECT_RE = /^[A-Za-z0-9@._/-]{1,100}$/;
const COLLECTION_RE = /^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/;
const SCHEMATIC_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
// pacchetto per ng add: nome npm con versione o tag facoltativi (@angular/material@19, lodash@^4)
const PACKAGE_RE = /^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*(@[A-Za-z0-9.^~<>=*+-]{1,50})?$/;
const DEFAULT_COLLECTION = '@schematics/angular';

class AngularError extends Error {
  constructor(name, params = {}) { super(name); this.key = name; this.params = params; }
}
const fail = (name, params) => { throw new AngularError(name, params); };

const readJson = file => {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
};
// angular.json può avere commenti (lo legge anche la CLI): via quelli di riga e di blocco fuori
// dalle stringhe
function readJsonc(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return null; }
  try { return JSON.parse(text); } catch { /* commenti */ }
  let out = '', str = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (str) { out += c; if (c === '\\') out += text[++i] ?? ''; else if (c === '"') str = false; continue; }
    if (c === '"') { str = true; out += c; continue; }
    if (c === '/' && text[i + 1] === '/') { while (i < text.length && text[i] !== '\n') i++; out += '\n'; continue; }
    if (c === '/' && text[i + 1] === '*') { i += 2; while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++; i++; continue; }
    out += c;
  }
  try { return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1')); } catch { return null; }
}

const isObject = v => v && typeof v === 'object' && !Array.isArray(v);
const versionOf = (dir, pkg) => readJson(path.join(dir, 'node_modules', ...pkg.split('/'), 'package.json'))?.version || null;

// ---- workspace ----

// { projects: [{ name, type, root, sourceRoot, prefix }], defaults, cli, core, installed, ngBin }
function workspace(dir) {
  const ws = readJsonc(path.join(dir, 'angular.json'));
  if (!isObject(ws)) fail('workspace_invalid');
  const projects = Object.entries(isObject(ws.projects) ? ws.projects : {}).map(([name, p]) => ({
    name,
    type: p?.projectType === 'library' ? 'library' : 'application',
    root: typeof p?.root === 'string' ? p.root : '',
    sourceRoot: typeof p?.sourceRoot === 'string' ? p.sourceRoot : null,
    prefix: typeof p?.prefix === 'string' ? p.prefix : null,
    schematics: isObject(p?.schematics) ? p.schematics : {},
  }));
  const cliPkg = readJson(path.join(dir, 'node_modules', '@angular', 'cli', 'package.json'));
  const bin = cliPkg && (typeof cliPkg.bin === 'string' ? cliPkg.bin : cliPkg.bin?.ng);
  const ngBin = bin ? path.join(dir, 'node_modules', '@angular', 'cli', bin) : null;
  return {
    projects,
    defaultProject: typeof ws.defaultProject === 'string' ? ws.defaultProject
      : projects.filter(p => p.type === 'application').length === 1 ? projects.find(p => p.type === 'application').name
        : projects[0]?.name || null,
    defaults: isObject(ws.schematics) ? ws.schematics : {},
    cli: cliPkg?.version || null,
    core: versionOf(dir, '@angular/core'),
    nodeModules: fs.existsSync(path.join(dir, 'node_modules')),
    installed: !!(ngBin && fs.existsSync(ngBin)),
    ngBin,
  };
}

// Valori predefiniti di angular.json per uno schematic: quelli del workspace, poi quelli del progetto
function defaultsFor(ws, projectName, collection, schematic) {
  const key = `${collection}:${schematic}`;
  const project = ws.projects.find(p => p.name === projectName);
  return { ...(isObject(ws.defaults[key]) ? ws.defaults[key] : {}), ...(isObject(project?.schematics?.[key]) ? project.schematics[key] : {}) };
}

// ---- collezioni ----

// Pacchetti del progetto con schematic: @schematics/angular per primo, poi quelli fra le
// dipendenze di package.json che hanno il campo "schematics"
function collectionNames(dir) {
  const pkg = readJson(path.join(dir, 'package.json')) || {};
  const deps = Object.keys({ ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) }).filter(n => COLLECTION_RE.test(n));
  const names = [];
  if (fs.existsSync(path.join(dir, 'node_modules', '@schematics', 'angular', 'collection.json'))) names.push(DEFAULT_COLLECTION);
  for (const n of deps.sort()) {
    if (n === DEFAULT_COLLECTION) continue;
    const meta = readJson(path.join(dir, 'node_modules', ...n.split('/'), 'package.json'));
    if (meta && typeof meta.schematics === 'string') names.push(n);
  }
  return names;
}

// File collection.json di un pacchetto installato (null se non c'è o esce dal pacchetto)
function collectionFile(dir, name) {
  if (!COLLECTION_RE.test(name)) return null;
  const pkgDir = path.join(dir, 'node_modules', ...name.split('/'));
  const meta = readJson(path.join(pkgDir, 'package.json'));
  if (!meta || typeof meta.schematics !== 'string') return null;
  const file = path.resolve(pkgDir, meta.schematics);
  return file.startsWith(pkgDir + path.sep) && fs.existsSync(file) ? { file, pkgDir } : null;
}

// Schematic visibili di una collezione: [{ name, description, aliases, schemaFile }]
// (via quelli nascosti, privati e "ng-new"/"workspace")
function schematicsOf(dir, name) {
  const found = collectionFile(dir, name);
  const data = found && readJson(found.file);
  if (!isObject(data?.schematics)) return [];
  const base = path.dirname(found.file);
  return Object.entries(data.schematics)
    .filter(([n, s]) => isObject(s) && !s.hidden && !s.private && !n.startsWith('private-') && !['ng-new', 'workspace'].includes(n) && SCHEMATIC_RE.test(n))
    .map(([n, s]) => {
      const schemaFile = typeof s.schema === 'string' ? path.resolve(base, s.schema) : null;
      return {
        name: n,
        description: typeof s.description === 'string' ? s.description : '',
        aliases: Array.isArray(s.aliases) ? s.aliases.filter(a => typeof a === 'string') : [],
        // lo schema resta dentro il pacchetto
        schemaFile: schemaFile && schemaFile.startsWith(found.pkgDir + path.sep) ? schemaFile : null,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

// ---- campi del form da schema.json ----

const promptText = p => (typeof p === 'string' ? p : isObject(p) && typeof p.message === 'string' ? p.message : null);

// { positional: campo | null, fields: [campo], pathOption: nome | null, projectOption: nome | null };
// pathOption è l'opzione della cartella (path, $default workingDirectory) che sceglie dove generare,
// projectOption quella del progetto del workspace ($default projectName): le migrazioni di
// @angular/core, per esempio, non ce l'hanno e rifiutano --project; campo = { name, type: boolean|string|number|
// integer|enum|list, choices?, default?, label, description, required, format? }
// Esclusi: project (scelto a parte), path e workingDirectory (dal nome), invisibili e deprecati
function fieldsOf(schema) {
  const props = isObject(schema?.properties) ? schema.properties : {};
  const required = new Set(Array.isArray(schema?.required) ? schema.required : []);
  let positional = null;
  let pathOption = null;
  let projectOption = null;
  const fields = [];
  for (const [name, p] of Object.entries(props)) {
    if (!isObject(p) || !OPTION_RE.test(name)) continue;
    const source = p.$default?.$source;
    if (source === 'workingDirectory' && p.type === 'string') pathOption = name;
    if (source === 'projectName') projectOption = name;
    if (source === 'projectName' || source === 'workingDirectory') continue;
    if (p.visible === false || p.hidden === true || p['x-deprecated']) continue;
    let type = p.type;
    let choices = null;
    if (Array.isArray(p.enum) && p.enum.every(v => typeof v === 'string' || typeof v === 'number')) { type = 'enum'; choices = p.enum.map(String); }
    else if (type === 'array' && Array.isArray(p.items?.enum)) { type = 'list'; choices = p.items.enum.map(String); }
    else if (type === 'array' && p.items?.type === 'string') type = 'strings';
    if (Array.isArray(type)) type = type.includes('boolean') ? 'boolean' : type.find(x => x !== 'null');
    if (!['boolean', 'string', 'number', 'integer', 'enum', 'list', 'strings'].includes(type)) continue;
    const field = {
      name, type,
      ...(choices ? { choices } : {}),
      ...(p.default !== undefined ? { default: p.default } : {}),
      label: promptText(p['x-prompt']) || null,
      description: typeof p.description === 'string' ? p.description : '',
      required: required.has(name),
      ...(typeof p.format === 'string' ? { format: p.format } : {}),
      ...(Array.isArray(p.aliases) ? { aliases: p.aliases.filter(a => typeof a === 'string') } : p.alias ? { aliases: [String(p.alias)] } : {}),
    };
    if (source === 'argv' && (p.$default.index ?? 0) === 0) positional = { ...field, required: field.required || !!p['x-prompt'] };
    else fields.push(field);
  }
  return { positional, fields, pathOption, projectOption };
}

function readSchema(file) {
  const data = file && readJson(file);
  return isObject(data) ? fieldsOf(data) : { positional: null, fields: [], pathOption: null, projectOption: null };
}

// Cartella in cui la CLI genera per un progetto del workspace (come buildDefaultPath della CLI):
// <root>/<sourceRoot>/app per le applicazioni, …/lib per le librerie
function defaultPath(project) {
  const root = (project.root || '').replace(/\\/g, '/').replace(/\/+$/, '');
  const source = (project.sourceRoot || `${root ? `${root}/` : ''}src`).replace(/\\/g, '/').replace(/\/+$/, '');
  return `${source}/${project.type === 'library' ? 'lib' : 'app'}`;
}

// Cartella scelta (relativa al workspace, anche nuova): segmenti come i nomi, niente ".." né assoluti
function checkFolder(value) {
  if (typeof value !== 'string') fail('folder_invalid', { folder: String(value ?? '') });
  const v = value.trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
  const parts = v.split('/');
  if (!v || v.length > 300 || v.startsWith('/') || /^[A-Za-z]:/.test(v) || parts.some(x => !NAME_SEGMENT.test(x) || x === '..' || x === '.')) fail('folder_invalid', { folder: value });
  return v;
}

// Cartelle del workspace sotto le radici dei sorgenti dei progetti (src, projects/x/src…) per la
// scelta della cartella: [percorsi relativi], senza nascoste, node_modules e cartelle di build
const SKIP_DIRS = new Set(['node_modules', 'dist', 'out-tsc', 'coverage', 'tmp', 'e2e']);
function folders(dir, ws, { max = 1000, depth = 8 } = {}) {
  const out = [];
  const roots = [...new Set(ws.projects.map(p => (p.sourceRoot || `${p.root ? `${p.root.replace(/\/+$/, '')}/` : ''}src`).replace(/\\/g, '/').replace(/\/+$/, '')))];
  const walk = (rel, level) => {
    if (out.length >= max || level > depth) return;
    let entries;
    try { entries = fs.readdirSync(path.join(dir, ...rel.split('/')), { withFileTypes: true }); } catch { return; }
    out.push(rel);
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!e.isDirectory() || e.name.startsWith('.') || SKIP_DIRS.has(e.name) || !NAME_SEGMENT.test(e.name)) continue;
      walk(`${rel}/${e.name}`, level + 1);
    }
  };
  for (const r of roots) if (r && !r.split('/').includes('..')) walk(r, 0);
  return out;
}

// ---- validazione e argomenti ----

const isText = v => typeof v === 'string' && v.length <= MAX_TEXT && !/[\x00-\x1f\x7f]/.test(v);

// Nome con percorso facoltativo (features/orders/order-list): segmenti senza "..", né assoluto,
// né opzione ("-…")
function checkName(value) {
  if (typeof value !== 'string' || !value.trim()) fail('name_required');
  const v = value.trim().replace(/\\/g, '/');
  const parts = v.split('/');
  if (v.length > 200 || v.startsWith('/') || v.startsWith('-') || parts.some(s => !NAME_SEGMENT.test(s) || s === '..' || s === '.')) fail('name_invalid', { name: value });
  return v;
}

function checkValue(field, value) {
  const bad = () => fail('option_invalid', { option: field.name });
  switch (field.type) {
    case 'boolean': if (typeof value !== 'boolean') bad(); return value;
    case 'number': if (typeof value !== 'number' || !Number.isFinite(value)) bad(); return value;
    case 'integer': if (!Number.isInteger(value)) bad(); return value;
    case 'enum': if (!field.choices.includes(String(value))) bad(); return String(value);
    case 'list':
      if (!Array.isArray(value) || value.length > MAX_ITEMS || !value.every(x => field.choices.includes(String(x)))) bad();
      return [...new Set(value.map(String))];
    case 'strings':
      if (!Array.isArray(value) || value.length > MAX_ITEMS || !value.every(x => isText(x) && x.trim() && !x.startsWith('-'))) bad();
      return value.map(x => x.trim());
    default:
      if (!isText(value)) bad();
      if (field.format === 'html-selector' && value && !/^[a-zA-Z][.0-9a-zA-Z]*(-[a-zA-Z0-9][.0-9a-zA-Z]*)*$/.test(value)) bad();
      return value;
  }
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
// Nome dell'opzione sulla riga di comando: la CLI (yargs in modalità stretta) vuole il kebab-case
// (skipTests → --skip-tests), accettato da tutte le versioni
const flag = name => name.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();
// Opzione → argomenti: --x / --no-x, --x=valore, una volta per elemento delle liste
function optionArgs(field, value) {
  const f = flag(field.name);
  if (field.type === 'boolean') return [value ? `--${f}` : `--no-${f}`];
  if (Array.isArray(value)) return value.map(v => `--${f}=${v}`);
  return [`--${f}=${value}`];
}

// Argomenti di "ng generate": solo le opzioni diverse dal predefinito (schema + angular.json),
// che la CLI applica già da sola → { args, options } (options: i valori validati da ricordare)
function generateArgs({ collection, schematic, schema, project, projects, name, options = {}, defaults = {}, folder = null, baseFolder = null }) {
  if (!COLLECTION_RE.test(collection || '')) fail('collection_invalid');
  if (!SCHEMATIC_RE.test(schematic || '')) fail('schematic_invalid');
  if (!isObject(options)) fail('options_invalid');
  const args = ['generate', `${collection}:${schematic}`];
  const { positional, fields } = schema;
  if (positional) {
    const has = name !== undefined && name !== null && name !== '';
    if (!has && positional.required) fail('name_required');
    if (has) args.push(positional.type === 'string' && positional.name === 'name' ? checkName(name) : (() => {
      const v = String(checkValue(positional, positional.type === 'boolean' ? name : String(name)));
      if (v.startsWith('-')) fail('option_invalid', { option: positional.name });
      return v;
    })());
  }
  // progetto del workspace: solo per gli schematic che hanno l'opzione (le migrazioni no)
  if (project !== undefined && project !== null && project !== '' && schema.projectOption) {
    if (!PROJECT_RE.test(project) || !projects.includes(project)) fail('project_invalid', { project: String(project) });
    args.push(`--${flag(schema.projectOption)}=${project}`);
  }
  // cartella diversa da quella predefinita del progetto: --path (solo se lo schematic ce l'ha)
  if (folder !== null && folder !== undefined && folder !== '') {
    const f = checkFolder(folder);
    if (!schema.pathOption) fail('folder_unsupported');
    if (f !== baseFolder) args.push(`--${schema.pathOption}=${f}`);
  }
  const chosen = {};
  for (const [key, raw] of Object.entries(options)) {
    const field = fields.find(f => f.name === key);
    if (!field) fail('option_unknown', { option: key });
    if (raw === undefined || raw === null || raw === '') continue;
    const value = checkValue(field, raw);
    const def = key in defaults ? defaults[key] : field.default;
    if (same(value, def) || (field.type === 'boolean' && !value && def === undefined)) continue;
    chosen[key] = value;
    args.push(...optionArgs(field, value));
  }
  return { args, options: chosen };
}

// ---- output di ng ----

// eslint-disable-next-line no-control-regex
const stripAnsi = s => String(s).replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');

// Righe CREATE/UPDATE/DELETE/RENAME e conflitti → { files: [{ action, path, bytes, exists?, conflict? }], conflicts, nothing }
function parseChanges(text, dir = null) {
  const clean = stripAnsi(text);
  const files = [];
  const conflicts = new Set();
  for (const line of clean.split(/\r?\n/)) {
    let m = /^(CREATE|UPDATE|DELETE|RENAME)\s+(.+?)(?:\s+\((\d+) bytes\))?\s*$/.exec(line.trim());
    if (m) { files.push({ action: m[1].toLowerCase(), path: m[2], ...(m[3] ? { bytes: Number(m[3]) } : {}) }); continue; }
    m = /merge conflicted on path "\/?([^"]+)"/i.exec(line) || /ERROR!\s+\/?(\S+)\s+already exists/i.exec(line);
    if (m) conflicts.add(m[1]);
  }
  if (dir) for (const f of files) if (f.action === 'create' && fs.existsSync(path.join(dir, ...f.path.split('/')))) f.exists = true;
  for (const c of conflicts) {
    const f = files.find(x => x.path === c);
    if (f) f.conflict = true; else files.push({ action: 'update', path: c, conflict: true });
  }
  return { files, conflicts: [...conflicts], nothing: /Nothing to be done/i.test(clean) };
}

// Tabella di "ng update" senza argomenti → [{ name, current, latest, target }]
function parseUpdates(text) {
  const out = [];
  for (const line of stripAnsi(text).split(/\r?\n/)) {
    const m = /^\s*(\S+)\s+(\S+)\s+->\s+(\S+)\s+ng update\s+(.+?)\s*$/.exec(line);
    if (m && PACKAGE_RE.test(m[4].split(/\s+/)[0])) out.push({ name: m[1], current: m[2], latest: m[3], target: m[4].split(/\s+/)[0] });
  }
  return out;
}

function checkPackage(value) {
  if (typeof value !== 'string' || !PACKAGE_RE.test(value.trim())) fail('package_invalid', { package: String(value ?? '') });
  return value.trim();
}

module.exports = {
  AngularError, DEFAULT_COLLECTION, PACKAGE_RE, COLLECTION_RE, SCHEMATIC_RE,
  readJsonc, workspace, defaultsFor, collectionNames, collectionFile, schematicsOf, fieldsOf, readSchema,
  checkName, checkFolder, defaultPath, folders, checkValue, optionArgs, generateArgs, stripAnsi, parseChanges, parseUpdates, checkPackage,
};
