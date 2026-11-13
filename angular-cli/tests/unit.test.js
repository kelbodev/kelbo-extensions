// Angular CLI senza Kelbo: workspace, collezioni, campi dagli schema.json veri di
// @schematics/angular, validazione, argomenti, lettura dell'output di ng
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { tmpDir } = require('kelbo/testkit');
const ng = require('../angular');
const { makeWorkspace } = require('./workspace');

const dir = makeWorkspace(tmpDir('kelbo-ng-unit-'), { git: false });
const schema = name => ng.readSchema(ng.schematicsOf(dir, '@schematics/angular').find(s => s.name === name).schemaFile);

test('workspace: progetti, predefiniti, versioni, CLI del progetto', () => {
  const ws = ng.workspace(dir);
  assert.deepEqual(ws.projects.map(p => [p.name, p.type]), [['shop', 'application'], ['ui-kit', 'library']]);
  assert.equal(ws.defaultProject, 'shop');
  assert.deepEqual([ws.cli, ws.core, ws.installed], ['20.1.0', '20.1.2', true]);
  assert.equal(ws.ngBin, path.join(dir, 'node_modules', '@angular', 'cli', 'bin', 'ng.js'));
  assert.deepEqual(ng.defaultsFor(ws, 'shop', '@schematics/angular', 'component'), { style: 'scss', skipTests: true });
  assert.deepEqual(ng.defaultsFor(ws, 'ui-kit', '@schematics/angular', 'component'), { style: 'scss' });
  assert.equal(ng.workspace(makeWorkspace(tmpDir('kelbo-ng-bare-'), { install: false, git: false })).installed, false);
});

test('collezioni: @schematics/angular prima, poi le dipendenze con schematic; nascosti e privati esclusi', () => {
  assert.deepEqual(ng.collectionNames(dir), ['@schematics/angular', 'my-schematics']);
  const names = ng.schematicsOf(dir, '@schematics/angular').map(s => s.name);
  for (const n of ['component', 'service', 'directive', 'pipe', 'guard', 'interceptor', 'resolver', 'class', 'interface', 'enum', 'module', 'environments', 'config', 'application', 'library']) assert.ok(names.includes(n), n);
  for (const n of ['ng-new', 'workspace', 'private-e2e', 'server', 'ssr']) assert.ok(!names.includes(n), n);
  assert.deepEqual(ng.schematicsOf(dir, '@schematics/angular').find(s => s.name === 'component').aliases, ['c']);
  assert.deepEqual(ng.schematicsOf(dir, 'my-schematics').map(s => s.name), ['ng-add', 'store']);
  assert.deepEqual(ng.schematicsOf(dir, '../evil'), []);
});

test('campi dal vero schema.json: nome posizionale, enum, liste, senza project e path', () => {
  const c = schema('component');
  assert.equal(c.positional.name, 'name');
  assert.equal(c.positional.required, true);
  const byName = Object.fromEntries(c.fields.map(f => [f.name, f]));
  assert.ok(!byName.project && !byName.path && !byName.name);
  assert.deepEqual([byName.style.type, byName.style.choices.includes('scss'), byName.style.default], ['enum', true, 'css']);
  assert.equal(byName.skipTests.type, 'boolean');
  assert.equal(byName.selector.format, 'html-selector');
  const g = schema('guard').fields.find(f => f.name === 'implements');
  assert.deepEqual([g.type, g.default], ['list', ['CanActivate']]);
  const cfg = schema('config');
  assert.deepEqual([cfg.positional.name, cfg.positional.type], ['type', 'enum']);
});

test('argomenti: solo le opzioni cambiate rispetto ai predefiniti; valori validati', () => {
  const ws = ng.workspace(dir);
  const base = { collection: '@schematics/angular', schematic: 'component', schema: schema('component'), project: 'shop', projects: ['shop', 'ui-kit'] };
  const defaults = ng.defaultsFor(ws, 'shop', '@schematics/angular', 'component');
  let r = ng.generateArgs({ ...base, name: 'features/orders/order-list', defaults, options: { style: 'scss', skipTests: true, changeDetection: 'OnPush', standalone: true, export: false, flat: true } });
  assert.deepEqual(r.args, ['generate', '@schematics/angular:component', 'features/orders/order-list', '--project=shop', '--change-detection=OnPush', '--flat']);
  assert.deepEqual(r.options, { changeDetection: 'OnPush', flat: true });
  r = ng.generateArgs({ ...base, name: 'x', defaults, options: { skipTests: false, style: 'less' } });
  assert.deepEqual(r.args.slice(4), ['--no-skip-tests', '--style=less']);
  const guard = { ...base, schematic: 'guard', schema: schema('guard') };
  assert.deepEqual(ng.generateArgs({ ...guard, name: 'auth', options: { implements: ['CanActivate', 'CanMatch'] } }).args.slice(4), ['--implements=CanActivate', '--implements=CanMatch']);
  const bad = (extra, key) => assert.throws(() => ng.generateArgs({ ...base, name: 'ok', ...extra }), e => e.key === key, key);
  bad({ name: '../fuori' }, 'name_invalid');
  bad({ name: '/assoluto' }, 'name_invalid');
  bad({ name: '--force' }, 'name_invalid');
  bad({ name: 'a b' }, 'name_invalid');
  bad({ name: '' }, 'name_required');
  bad({ options: { style: 'foo' } }, 'option_invalid');
  bad({ options: { skipTests: 'yes' } }, 'option_invalid');
  bad({ options: { prefix: 'a\nb' } }, 'option_invalid');
  bad({ options: { selector: 'Not a selector!' } }, 'option_invalid');
  bad({ options: { unknown: 1 } }, 'option_unknown');
  bad({ project: 'altro' }, 'project_invalid');
  bad({ collection: '../x' }, 'collection_invalid');
  assert.deepEqual(ng.generateArgs({ ...base, schematic: 'config', schema: schema('config'), name: 'karma' }).args.slice(2, 3), ['karma']);
  assert.throws(() => ng.generateArgs({ ...base, schematic: 'config', schema: schema('config'), name: 'webpack' }), e => e.key === 'option_invalid');
});

test('output: file creati e modificati, conflitti, tabella di ng update, pacchetti', () => {
  const out = '\x1b[32mCREATE\x1b[39m src/app/a/a.ts (201 bytes)\nUPDATE angular.json (2615 bytes)\nA merge conflicted on path "/src/app/b/b.ts".\n';
  const r = ng.parseChanges(out);
  assert.deepEqual(r.files, [{ action: 'create', path: 'src/app/a/a.ts', bytes: 201 }, { action: 'update', path: 'angular.json', bytes: 2615 }, { action: 'update', path: 'src/app/b/b.ts', conflict: true }]);
  assert.equal(ng.parseChanges('Nothing to be done.\n').nothing, true);
  assert.deepEqual(ng.parseUpdates('      @angular/cli                 20.3.43 -> 21.2.9        ng update @angular/cli@21\n'), [{ name: '@angular/cli', current: '20.3.43', latest: '21.2.9', target: '@angular/cli@21' }]);
  for (const ok of ['@angular/material', '@ngrx/store@19', 'lodash@^4.17.0', 'tailwindcss@latest']) assert.equal(ng.checkPackage(ok), ok);
  for (const bad of ['--registry=x', 'a b', '@x', 'pkg@1;rm', '']) assert.throws(() => ng.checkPackage(bad), e => e.key === 'package_invalid', bad);
});

test('cartella: predefinita del progetto, cartelle dei sorgenti, --path solo se diversa', () => {
  const ws = ng.workspace(dir);
  assert.deepEqual(ws.projects.map(ng.defaultPath), ['src/app', 'projects/ui-kit/src/lib']);
  require('fs').mkdirSync(path.join(dir, 'src', 'app', 'features', 'orders'), { recursive: true });
  require('fs').mkdirSync(path.join(dir, 'src', 'app', 'node_modules'), { recursive: true });
  require('fs').mkdirSync(path.join(dir, 'src', '.hidden'), { recursive: true });
  const list = ng.folders(dir, ws);
  assert.ok(list.includes('src/app/features/orders'));
  assert.ok(!list.some(f => f.includes('node_modules') || f.includes('.hidden')));
  const c = schema('component');
  assert.equal(c.pathOption, 'path');
  assert.equal(schema('config').pathOption, null);
  const base = { collection: '@schematics/angular', schematic: 'component', schema: c, project: 'shop', projects: ['shop'], name: 'box', baseFolder: 'src/app' };
  assert.ok(ng.generateArgs({ ...base, folder: 'src/app/features/orders' }).args.includes('--path=src/app/features/orders'));
  assert.ok(!ng.generateArgs({ ...base, folder: 'src/app/' }).args.some(a => a.startsWith('--path')));
  assert.ok(ng.generateArgs({ ...base, folder: './src/shared/nuova' }).args.includes('--path=src/shared/nuova'));
  for (const bad of ['../fuori', '/etc', 'src/../..', 'C:/x', 'src/a b', '--force']) assert.throws(() => ng.generateArgs({ ...base, folder: bad }), e => e.key === 'folder_invalid', bad);
  assert.throws(() => ng.generateArgs({ ...base, schematic: 'config', schema: schema('config'), name: 'karma', folder: 'src/x' }), e => e.key === 'folder_unsupported');
});
