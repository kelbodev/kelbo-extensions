#!/usr/bin/env node
// Catalogo index.json generato dai manifest delle cartelle (una per estensione).
//   npm run catalog            riscrive index.json
//   npm run catalog -- --check controlla che index.json sia aggiornato e i manifest validi (CI)
const fs = require('fs');
const path = require('path');
const { validateManifest, extensionKinds } = require('kelbo/testkit');

const ROOT = path.join(__dirname, '..');
const REPO = 'https://github.com/kelbodev/kelbo-extensions.git';
const FILE = path.join(ROOT, 'index.json');

function build() {
  const folders = fs.readdirSync(ROOT, { withFileTypes: true })
    .filter(d => d.isDirectory() && !d.name.startsWith('.') && !['node_modules', 'scripts'].includes(d.name)
      && fs.existsSync(path.join(ROOT, d.name, 'setting.json')))
    .map(d => d.name).sort();
  const extensions = folders.map(folder => {
    const raw = JSON.parse(fs.readFileSync(path.join(ROOT, folder, 'setting.json'), 'utf8'));
    let m;
    try { m = validateManifest(raw, folder); } catch (e) { throw new Error(`${folder}: ${e.message}`); }
    return {
      code: m.code, name: m.name, description: m.description || '', icon: m.icon || null,
      version: m.version, kelbo: m.kelbo, kinds: extensionKinds(m), repo: REPO, path: folder,
    };
  });
  return JSON.stringify({ name: 'Kelbo official extensions', extensions }, null, 2) + '\n';
}

const text = build();
if (process.argv.includes('--check')) {
  const current = fs.existsSync(FILE) ? fs.readFileSync(FILE, 'utf8') : '';
  if (current !== text) {
    console.error('index.json non aggiornato: esegui npm run catalog e fai il commit');
    process.exit(1);
  }
  console.log(`index.json aggiornato (${JSON.parse(text).extensions.length} estensioni)`);
} else {
  fs.writeFileSync(FILE, text);
  console.log(`index.json scritto (${JSON.parse(text).extensions.length} estensioni)`);
}
