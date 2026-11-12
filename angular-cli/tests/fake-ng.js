#!/usr/bin/env node
// Finta Angular CLI per i test: registra gli argomenti in .ng-calls.json della cartella corrente e
// risponde come la CLI vera (righe CREATE/UPDATE, conflitti, tabella di ng update)
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const log = path.join(process.cwd(), '.ng-calls.json');
let calls = [];
try { calls = JSON.parse(fs.readFileSync(log, 'utf8')); } catch { /* primo */ }
calls.push({ args, env: { NG_CLI_ANALYTICS: process.env.NG_CLI_ANALYTICS, NO_COLOR: process.env.NO_COLOR } });
fs.writeFileSync(log, JSON.stringify(calls));

const [cmd, target, ...rest] = args;
const dry = args.includes('--dry-run');
const opt = name => args.find(a => a.startsWith(`--${name}=`))?.split('=').slice(1).join('=');

if (cmd === 'generate') {
  const schematic = target.split(':').pop();
  const name = rest.find(a => !a.startsWith('-'));
  const style = opt('style');
  if (style && !['css', 'scss', 'sass', 'less', 'none'].includes(style)) {
    console.error(`Error: Invalid values:\n  Argument: style, Given: "${style}", Choices: "css", "less", "none", "sass", "scss"`);
    process.exit(1);
  }
  const base = name.split('/').pop();
  const dir = `src/app/${name}`;
  const files = schematic === 'component' ? [`${dir}/${base}.ts`, `${dir}/${base}.html`, ...(args.includes('--skip-tests') ? [] : [`${dir}/${base}.spec.ts`])]
    : [`src/app/${name}.${schematic}.ts`];
  for (const f of files) {
    const full = path.join(process.cwd(), f);
    if (fs.existsSync(full) && fs.readFileSync(full, 'utf8') !== '// generato\n') {
      console.log(`A merge conflicted on path "/${f}".`);
      process.exit(1);
    }
  }
  for (const f of files) {
    console.log(`CREATE ${f} (12 bytes)`);
    if (!dry) { fs.mkdirSync(path.dirname(path.join(process.cwd(), f)), { recursive: true }); fs.writeFileSync(path.join(process.cwd(), f), '// generato\n'); }
  }
  if (schematic === 'component' && args.includes('--export')) console.log('UPDATE src/app/app.module.ts (300 bytes)');
  if (dry) console.log('\nNOTE: The "--dry-run" option means no changes were made.');
  process.exit(0);
}
if (cmd === 'update' && !target) {
  console.log(`Using package manager: npm
Collecting installed dependencies...
    We analyzed your package.json, there are some packages to update:

      Name                         Version                  Command to update
     --------------------------------------------------------------------------
      @angular/cli                 19.2.0 -> 20.3.4         ng update @angular/cli@20
      @angular/core                19.2.1 -> 20.3.4         ng update @angular/core@20
`);
  process.exit(0);
}
if (cmd === 'update') { console.log(`Updating ${args.slice(1).filter(a => !a.startsWith('-')).join(', ')}`); process.exit(0); }
if (cmd === 'add') { console.log(`✔ Package ${target} installed`); process.exit(0); }
console.error(`Unknown command ${cmd}`);
process.exit(1);
