// Angular CLI attraverso Kelbo: tratto del progetto, workspace e generatori, form dallo schema,
// anteprima con --dry-run, generazione in streaming, recenti, ng add e ng update con il controllo
// delle modifiche Git, strumenti MCP. La CLI è finta (tests/fake-ng.js) e registra i suoi argomenti.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { startServer, tmpDir, mcpClient, i18nProblems } = require('kelbo/testkit');
const { makeWorkspace, calls, write } = require('./workspace');

const EXT = path.join(__dirname, '..');
let srv, mcp, dir, bare, plain;
const api = (method, p, body) => srv.request(method, `/api/ext/angular-cli${p}`, body !== undefined ? { body } : {});
const lastArgs = () => calls(dir).at(-1).args;

before(async () => {
  dir = makeWorkspace(tmpDir('kelbo-ng-'));
  bare = makeWorkspace(tmpDir('kelbo-ng-bare-'), { install: false, git: false });
  plain = tmpDir('kelbo-ng-plain-');
  fs.writeFileSync(path.join(plain, 'package.json'), '{"name":"plain"}');
  srv = await startServer({ projects: [{ id: 'shop', label: 'Shop', path: dir }, { id: 'bare', label: 'Bare', path: bare }, { id: 'plain', label: 'Plain', path: plain }] }, { install: [EXT] });
  mcp = await mcpClient(srv);
});
after(async () => { await mcp?.close(); await srv?.stop(); });

test('traduzioni', () => assert.deepEqual(i18nProblems(EXT), []));

test('tratto angular dai file angular.json', async () => {
  const { projects } = (await srv.request('GET', '/api/core/projects')).json;
  const traits = Object.fromEntries(projects.map(p => [p.id, p.traitsActive]));
  assert.ok(traits.shop.includes('angular'));
  assert.ok(traits.bare.includes('angular'));
  assert.ok(!traits.plain.includes('angular'));
});

test('workspace: progetti, versioni, collezioni con i generatori; senza node_modules nessun generatore', async () => {
  let r = await api('GET', '/projects/shop/workspace');
  assert.equal(r.status, 200, r.text);
  assert.deepEqual([r.json.cli, r.json.core, r.json.installed, r.json.defaultProject], ['20.1.0', '20.1.2', true, 'shop']);
  assert.equal(r.json.ngBin, undefined); // percorso interno, non esposto
  assert.deepEqual(r.json.collections.map(c => c.name), ['@schematics/angular', 'my-schematics']);
  assert.ok(r.json.collections[0].schematics.some(s => s.name === 'component' && s.aliases.includes('c')));
  r = await api('GET', '/projects/bare/workspace');
  assert.deepEqual([r.json.installed, r.json.nodeModules, r.json.collections], [false, false, []]);
  assert.equal((await api('POST', '/projects/bare/preview', { schematic: 'component', name: 'x' })).json.code, 'angular-cli.not_installed');
  assert.equal((await api('GET', '/projects/plain/workspace')).json.code, 'angular-cli.not_angular');
  assert.equal((await api('GET', '/projects/nope/workspace')).status, 404);
});

test('schematic: campi dallo schema, predefiniti di angular.json per progetto', async () => {
  const r = await api('GET', '/projects/shop/schematic?collection=%40schematics%2Fangular&name=c');
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.name, 'component');
  assert.equal(r.json.positional.name, 'name');
  assert.deepEqual(r.json.defaults.shop, { style: 'scss', skipTests: true });
  assert.deepEqual(r.json.defaults['ui-kit'], { style: 'scss' });
  assert.equal((await api('GET', '/projects/shop/schematic?collection=my-schematics&name=secret')).json.code, 'angular-cli.schematic_not_found');
  assert.equal((await api('GET', '/projects/shop/schematic?collection=..%2F..%2Fetc&name=x')).json.code, 'angular-cli.schematic_invalid');
});

test('anteprima con --dry-run: solo le opzioni cambiate, file e conflitti, niente scritto', async () => {
  let r = await api('POST', '/projects/shop/preview', { schematic: 'component', name: 'features/orders/order-list', options: { style: 'scss', skipTests: false, changeDetection: 'OnPush' } });
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(lastArgs(), ['generate', '@schematics/angular:component', 'features/orders/order-list', '--project=shop', '--no-skip-tests', '--change-detection=OnPush', '--dry-run', '--interactive=false']);
  assert.equal(calls(dir).at(-1).env.NG_CLI_ANALYTICS, 'false');
  assert.equal(r.json.ok, true);
  assert.deepEqual(r.json.files.map(f => f.path), ['src/app/features/orders/order-list/order-list.ts', 'src/app/features/orders/order-list/order-list.html', 'src/app/features/orders/order-list/order-list.spec.ts']);
  assert.equal(fs.existsSync(path.join(dir, 'src/app/features/orders/order-list/order-list.ts')), false);
  // conflitto: il file esiste con un altro contenuto
  write(dir, 'src/app/taken/taken.ts', 'export class Mine {}\n');
  r = await api('POST', '/projects/shop/preview', { schematic: 'component', name: 'taken' });
  assert.deepEqual([r.json.ok, r.json.conflicts], [false, ['src/app/taken/taken.ts']]);
  assert.ok(r.json.files.find(f => f.path === 'src/app/taken/taken.ts').conflict);
  // errore della CLI: output restituito
  r = await api('POST', '/projects/shop/preview', { schematic: 'component', name: 'x', project: 'ui-kit', options: { style: 'scss' } });
  assert.equal(r.json.ok, true);
  assert.ok(!lastArgs().some(a => a.startsWith('--style')));
  // valori non validi: mai arrivati alla CLI
  const before = calls(dir).length;
  for (const [body, code] of [
    [{ schematic: 'component', name: '../../etc' }, 'angular-cli.name_invalid'],
    [{ schematic: 'component', name: 'x', options: { style: 'scss; rm -rf /' } }, 'angular-cli.option_invalid'],
    [{ schematic: 'component', name: 'x', options: { '--force': true } }, 'angular-cli.option_unknown'],
    [{ schematic: 'component', name: 'x', project: 'other' }, 'angular-cli.project_invalid'],
  ]) assert.equal((await api('POST', '/projects/shop/preview', body)).json.code, code, JSON.stringify(body));
  assert.equal(calls(dir).length, before);
});

test("cartella di destinazione: elenco delle cartelle, --path nell'anteprima e nella generazione", async () => {
  fs.mkdirSync(path.join(dir, 'src', 'app', 'features', 'orders'), { recursive: true });
  let r = await api('GET', '/projects/shop/folders');
  assert.ok(r.json.folders.includes('src/app/features/orders'));
  assert.ok(r.json.folders.includes('projects/ui-kit/src') || !fs.existsSync(path.join(dir, 'projects')));
  r = await api('GET', '/projects/shop/workspace');
  assert.deepEqual(r.json.projects.map(p => p.defaultPath), ['src/app', 'projects/ui-kit/src/lib']);
  r = await api('POST', '/projects/shop/preview', { schematic: 'component', name: 'box', folder: 'src/app/features/orders' });
  assert.equal(r.json.ok, true, r.text);
  assert.ok(lastArgs().includes('--path=src/app/features/orders'));
  assert.equal(r.json.files[0].path, 'src/app/features/orders/box/box.ts');
  r = await api('POST', '/projects/shop/preview', { schematic: 'component', name: 'box', folder: 'src/app' });
  assert.ok(!lastArgs().some(a => a.startsWith('--path')));
  assert.equal((await api('POST', '/projects/shop/preview', { schematic: 'component', name: 'box', folder: '../../etc' })).json.code, 'angular-cli.folder_invalid');
  r = await api('POST', '/projects/shop/generate', { schematic: 'service', name: 'orders-api', folder: 'src/app/features/orders' });
  assert.equal(r.events.find(e => e.type === 'exit').data, 0);
  assert.ok(fs.existsSync(path.join(dir, 'src/app/features/orders/orders-api.service.ts')));
  await api('DELETE', '/projects/shop/recent');
});

test('generazione in streaming: file scritti, recenti e ultime opzioni', async () => {
  const r = await api('POST', '/projects/shop/generate', { schematic: 'component', name: 'cart', options: { changeDetection: 'OnPush' } });
  assert.equal(r.status, 200, r.text);
  const files = r.events.find(e => e.type === 'files').data;
  // (la CLI vera applica da sola skipTests di angular.json; la finta no)
  assert.deepEqual(files.map(f => f.path).slice(0, 2), ['src/app/cart/cart.ts', 'src/app/cart/cart.html']);
  assert.equal(r.events.find(e => e.type === 'exit').data, 0);
  assert.ok(fs.existsSync(path.join(dir, 'src/app/cart/cart.ts')));
  assert.deepEqual(lastArgs(), ['generate', '@schematics/angular:component', 'cart', '--project=shop', '--change-detection=OnPush', '--interactive=false']);
  await api('POST', '/projects/shop/generate', { collection: 'my-schematics', schematic: 'st', name: 'orders', options: { entity: true } });
  let ws = (await api('GET', '/projects/shop/workspace')).json;
  assert.deepEqual(ws.recent.map(x => [x.collection, x.schematic, x.options]), [['my-schematics', 'store', { entity: true }], ['@schematics/angular', 'component', { changeDetection: 'OnPush' }]]);
  assert.deepEqual((await api('GET', '/projects/shop/schematic?name=component')).json.last, { changeDetection: 'OnPush' });
  const links = (await srv.request('GET', '/api/core/projects/shop/links')).json.links;
  assert.ok(links.some(l => l.code === 'angular-cli' && l.key === 'links.recent'));
  await api('DELETE', '/projects/shop/recent');
  ws = (await api('GET', '/projects/shop/workspace')).json;
  assert.deepEqual(ws.recent, []);
});

test('ng add e ng update: modifiche Git da confermare, opzioni di ng-add, tabella degli aggiornamenti', async () => {
  // file generati sopra non committati: serve la conferma
  let r = await api('POST', '/projects/shop/update', { packages: ['@angular/core@20'] });
  assert.equal(r.status, 409, r.text);
  assert.equal(r.json.code, 'angular-cli.git_dirty');
  assert.ok(r.json.files.some(f => f.startsWith('src/')));
  r = await api('POST', '/projects/shop/update', { packages: ['@angular/core@20', '@angular/cli@20'], confirmDirty: true });
  assert.equal(r.events.find(e => e.type === 'exit').data, 0);
  assert.deepEqual(lastArgs(), ['update', '@angular/core@20', '@angular/cli@20', '--allow-dirty']);
  r = await api('GET', '/projects/shop/updates');
  assert.deepEqual(r.json.updates.map(u => u.target), ['@angular/cli@20', '@angular/core@20']);
  assert.equal((await api('POST', '/projects/shop/update', { packages: ['--registry=http://evil'], confirmDirty: true })).json.code, 'angular-cli.package_invalid');
  // ng-add di un pacchetto installato: opzioni dal suo schema
  r = await api('GET', '/projects/shop/add-options?package=my-schematics%401.0.0');
  assert.deepEqual(r.json.fields.map(f => f.name), ['theme', 'animations']);
  r = await api('POST', '/projects/shop/add', { package: 'my-schematics', options: { theme: 'dark', animations: false }, confirmDirty: true });
  assert.equal(r.events.find(e => e.type === 'exit').data, 0);
  assert.deepEqual(lastArgs(), ['add', 'my-schematics', '--skip-confirmation', '--interactive=false', '--theme=dark', '--no-animations']);
  r = await api('POST', '/projects/shop/add', { package: '@angular/material', confirmDirty: true });
  assert.deepEqual(lastArgs(), ['add', '@angular/material', '--skip-confirmation', '--interactive=false', '--defaults']);
  assert.equal((await api('POST', '/projects/shop/add', { package: 'my-schematics', options: { evil: 1 }, confirmDirty: true })).json.code, 'angular-cli.option_unknown');
});

test('strumenti MCP: workspace, generatori con opzioni, generate in prova se non apply', async () => {
  let r = await mcp.callTool({ name: 'angular_cli_workspaces', arguments: {} });
  assert.deepEqual(r.structuredContent.workspaces.map(w => w.id).sort(), ['bare', 'shop']);
  r = await mcp.callTool({ name: 'angular_cli_generators', arguments: { project: 'shop' } });
  const comp = r.structuredContent.collections[0].schematics.find(s => s.name === 'component');
  assert.ok(comp.fields.some(f => f.name === 'style'));
  r = await mcp.callTool({ name: 'angular_cli_generate', arguments: { project: 'shop', schematic: 'service', name: 'api/orders' } });
  assert.deepEqual([r.structuredContent.applied, r.structuredContent.ok], [false, true]);
  assert.equal(fs.existsSync(path.join(dir, 'src/app/api/orders.service.ts')), false);
  r = await mcp.callTool({ name: 'angular_cli_generate', arguments: { project: 'shop', schematic: 'service', name: 'api/orders', apply: true } });
  assert.equal(r.structuredContent.applied, true);
  assert.ok(fs.existsSync(path.join(dir, 'src/app/api/orders.service.ts')));
  r = await mcp.callTool({ name: 'angular_cli_generate', arguments: { project: 'shop', schematic: 'component', name: 'taken', apply: true } });
  assert.deepEqual([r.structuredContent.applied, r.structuredContent.ok], [false, false]);
});
