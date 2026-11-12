// Workspace Angular finto per i test: angular.json con un'applicazione e una libreria, la Angular
// CLI finta (fake-ng.js) in node_modules, @schematics/angular con collection.json e schema.json
// veri (fixtures), una collezione di terze parti con uno schematic nascosto, repository Git
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const write = (dir, rel, data) => {
  const file = path.join(dir, ...rel.split('/'));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof data === 'string' ? data : JSON.stringify(data, null, 2));
};

function makeWorkspace(dir, { install = true, git = true } = {}) {
  write(dir, 'angular.json', `{
  // commenti come li accetta la CLI
  "version": 1,
  "projects": {
    "shop": { "projectType": "application", "root": "", "sourceRoot": "src", "prefix": "app",
      "schematics": { "@schematics/angular:component": { "skipTests": true } } },
    "ui-kit": { "projectType": "library", "root": "projects/ui-kit", "sourceRoot": "projects/ui-kit/src", "prefix": "ui" }
  },
  "schematics": { "@schematics/angular:component": { "style": "scss" } }
}
`);
  write(dir, 'package.json', { name: 'shop', private: true, devDependencies: { '@angular/cli': '^20.0.0', '@schematics/angular': '^20.0.0', 'my-schematics': '1.0.0' }, dependencies: { '@angular/core': '^20.0.0' } });
  if (install) {
    write(dir, 'node_modules/@angular/cli/package.json', { name: '@angular/cli', version: '20.1.0', bin: { ng: './bin/ng.js' } });
    write(dir, 'node_modules/@angular/cli/bin/ng.js', fs.readFileSync(path.join(__dirname, 'fake-ng.js'), 'utf8'));
  }
  if (install) {
    write(dir, 'node_modules/@angular/core/package.json', { name: '@angular/core', version: '20.1.2' });
    write(dir, 'node_modules/@schematics/angular/package.json', { name: '@schematics/angular', version: '20.1.0', schematics: './collection.json' });
    fs.cpSync(path.join(__dirname, 'fixtures', 'schematics-angular'), path.join(dir, 'node_modules', '@schematics', 'angular'), { recursive: true });
    write(dir, 'node_modules/my-schematics/package.json', { name: 'my-schematics', version: '1.0.0', schematics: './collection.json' });
    write(dir, 'node_modules/my-schematics/collection.json', { schematics: {
      store: { description: 'A feature store', factory: './store', schema: './store/schema.json', aliases: ['st'] },
      secret: { description: 'Hidden one', factory: './x', hidden: true },
      'ng-add': { description: 'Add my-schematics', factory: './ng-add', schema: './ng-add/schema.json' },
    } });
    write(dir, 'node_modules/my-schematics/store/schema.json', { type: 'object', properties: {
      name: { type: 'string', $default: { $source: 'argv', index: 0 } }, project: { type: 'string', $default: { $source: 'projectName' } },
      entity: { type: 'boolean', default: false, description: 'With an entity adapter' },
    }, required: ['name'] });
    write(dir, 'node_modules/my-schematics/ng-add/schema.json', { type: 'object', properties: {
      theme: { type: 'string', enum: ['light', 'dark'], default: 'light', 'x-prompt': 'Theme?' }, animations: { type: 'boolean', default: true },
    } });
  }
  if (git) {
    const g = (...a) => execFileSync('git', a, { cwd: dir, stdio: 'ignore' });
    g('init', '-q'); g('config', 'user.email', 't@example.invalid'); g('config', 'user.name', 'T');
    write(dir, '.gitignore', 'node_modules/\n.ng-calls.json\n');
    g('add', '-A'); g('commit', '-qm', 'init');
  }
  return dir;
}

const calls = dir => { try { return JSON.parse(fs.readFileSync(path.join(dir, '.ng-calls.json'), 'utf8')); } catch { return []; } };

module.exports = { makeWorkspace, calls, write };
