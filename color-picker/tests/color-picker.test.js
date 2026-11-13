// Color picker attraverso Kelbo: palette (creazione, modifica, validazione, export e import,
// collegamenti al progetto), colori nei file di un progetto, strumenti MCP, traduzioni
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { startServer, tmpDir, mcpClient, i18nProblems } = require('kelbo/testkit');
const { colorsIn } = require('../server');

const EXT = path.join(__dirname, '..');
let srv, mcp, dir;
const api = (method, p, body) => srv.request(method, `/api/ext/color-picker${p}`, body !== undefined ? { body } : {});
const write = (rel, text) => { const f = path.join(dir, ...rel.split('/')); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); };

before(async () => {
  dir = tmpDir('kelbo-colors-');
  write('src/styles.scss', ':root {\n  --brand: #3B82F6;\n  --bg: rgb(255 255 255 / 50%);\n}\n$accent: #f0f;\n.a { color: var(--brand); border: 1px solid #3b82f6; }\n');
  write('src/app/app.html', '<a href="#top">#123</a><div style="color: hsl(210, 50%, 40%)"></div>\n');
  write('src/app/theme.ts', "export const primary = '#3b82f6';\n");
  write('node_modules/lib/x.css', '.x { color: #abcdef; }\n');
  write('dist/main.css', '.y { color: #fedcba; }\n');
  srv = await startServer({ projects: [{ id: 'web', label: 'Web', path: dir }] }, { install: [EXT] });
  mcp = await mcpClient(srv);
});
after(async () => { await mcp?.close(); await srv?.stop(); });

test('traduzioni', () => assert.deepEqual(i18nProblems(EXT), []));

test('colori nel testo: hex, rgb, hsl, nomi delle variabili; niente ancore e numeri', () => {
  const found = colorsIn('--brand: #3b82f6;\n$x:#FFF; @y: rgba(0, 0, 0, .5);\n<a href="#top">fix #123</a> id="a#abc" c:#33669980');
  assert.deepEqual(found, [
    { hex: '#3b82f6', line: 1, name: '--brand' }, { hex: '#ffffff', line: 2, name: '$x' }, { hex: '#00000080', line: 2, name: '@y' }, { hex: '#33669980', line: 3 },
  ]);
});

test('colori del progetto: conteggio, file, variabili; node_modules e dist esclusi', async () => {
  const r = await api('GET', '/projects/web/colors');
  assert.equal(r.status, 200, r.text);
  const byHex = Object.fromEntries(r.json.colors.map(c => [c.hex, c]));
  assert.equal(r.json.colors[0].hex, '#3b82f6');
  assert.equal(byHex['#3b82f6'].count, 3);
  assert.deepEqual(byHex['#3b82f6'].names, ['--brand']);
  assert.deepEqual(byHex['#3b82f6'].files.map(f => f.file).sort(), ['src/app/theme.ts', 'src/styles.scss']);
  assert.ok(byHex['#ffffff80'] && byHex['#ff00ff'] && byHex['#336699']);
  assert.ok(!byHex['#abcdef'] && !byHex['#fedcba']);
  assert.equal((await api('GET', '/projects/nope/colors')).status, 404);
});

test('palette: crea, modifica, valida, elimina; collegamenti del progetto', async () => {
  let r = await api('POST', '/palettes', { name: 'Brand', projectId: 'web', colors: [{ value: '#3B82F6', name: 'primary' }, { value: '#ffffff80' }] });
  assert.equal(r.status, 200, r.text);
  const id = r.json.id;
  assert.deepEqual(r.json.colors, [{ value: '#3b82f6', name: 'primary' }, { value: '#ffffff80' }]);
  r = await api('PUT', `/palettes/${id}`, { name: 'Brand 2', projectId: 'web', colors: [{ value: '#000000' }] });
  assert.equal(r.json.name, 'Brand 2');
  assert.deepEqual(srv.readConfig().colorPalettes.palettes.map(p => p.name), ['Brand 2']);
  for (const [body, code] of [
    [{ name: '', colors: [] }, 'color-picker.palette_name'],
    [{ name: 'x', colors: [{ value: 'red; }' }] }, 'color-picker.color_invalid'],
    [{ name: 'x', colors: 'no' }, 'color-picker.palette_colors'],
    [{ name: 'x', colors: [], projectId: 'nope' }, 'color-picker.project_not_found'],
  ]) assert.equal((await api('POST', '/palettes', body)).json.code, code);
  const links = (await srv.request('GET', '/api/core/projects/web/links')).json.links;
  assert.ok(links.some(l => l.code === 'color-picker' && l.key === 'links.palettes'));
  // import in unione: le palette nuove si aggiungono
  r = await srv.request('POST', '/api/core/config/import', { body: { mode: 'merge', config: { colorPalettes: { palettes: [{ id: 'abcdef123456', name: 'Importata', projectId: null, colors: [{ value: '#123456' }] }] } } } });
  assert.equal(r.status, 200, r.text);
  assert.equal((await api('GET', '/palettes')).json.palettes.length, 2);
  r = await srv.request('POST', '/api/core/config/import', { body: { mode: 'merge', config: { colorPalettes: { palettes: [{ id: 'x', name: 'Bad', colors: [] }] } } } });
  assert.equal(r.status, 400);
  assert.equal((await api('DELETE', `/palettes/${id}`)).status, 200);
  assert.equal((await api('DELETE', `/palettes/${id}`)).status, 404);
});

test('strumenti MCP: palette e colori del progetto', async () => {
  let r = await mcp.callTool({ name: 'color_picker_palettes', arguments: {} });
  assert.deepEqual(r.structuredContent.palettes.map(p => p.name), ['Importata']);
  r = await mcp.callTool({ name: 'color_picker_project_colors', arguments: { project: 'web', limit: 2 } });
  assert.equal(r.structuredContent.colors.length, 2);
  assert.equal(r.structuredContent.truncated, true);
});
