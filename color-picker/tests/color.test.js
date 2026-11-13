// Matematica dei colori del pannello (esportata da view.js): lettura, conversioni, formati,
// contrasto WCAG, correzione del contrasto, sfumature e armonie
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { pathToFileURL } = require('url');

const load = () => import(pathToFileURL(path.join(__dirname, '..', 'view.js')).href);

test('lettura dei formati CSS', async () => {
  const c = await load();
  const blue = { r: 51, g: 102, b: 153, a: 1 };
  for (const s of ['#336699', '#369', '336699', 'rgb(51, 102, 153)', 'rgb(51 102 153)', 'rgba(51,102,153,1)', 'hsl(210, 50%, 40%)', 'hsl(210deg 50% 40%)', 'hsl(0.5833turn 50% 40%)']) assert.deepEqual(c.parse(s), blue, s);
  assert.deepEqual(c.parse('rgb(51 102 153 / 50%)'), { ...blue, a: 0.5 });
  assert.deepEqual(c.parse('#33669980'), { ...blue, a: 0.502 });
  assert.deepEqual(c.parse('teal'), { r: 0, g: 128, b: 128, a: 1 });
  assert.equal(c.parse('transparent').a, 0);
  for (const bad of ['', 'nope', '#12', '#gggggg', 'rgb(1,2)', 'hsl(a b c)', 42, null]) assert.equal(c.parse(bad), null, String(bad));
});

test('conversioni andata e ritorno, formati', async () => {
  const c = await load();
  for (const h of ['#000000', '#ffffff', '#336699', '#ff7f50', '#3b82f6', '#00ff00', '#808080']) {
    const rgb = c.parse(h);
    assert.equal(c.toHex(c.hsvToRgb(c.rgbToHsv(rgb))), h, `hsv ${h}`);
    assert.equal(c.toHex(c.parse(c.toHslString(rgb))), h, `hsl ${h}`);
    assert.equal(c.toHex(c.parse(c.toOklchString(rgb))), h, `oklch ${h}`);
  }
  assert.deepEqual(c.formats(c.parse('#336699')), { hex: '#336699', rgb: 'rgb(51 102 153)', hsl: 'hsl(210 50% 40%)', oklch: 'oklch(49.9% 0.099 250.4)' });
  assert.equal(c.formats(c.parse('rgb(51 102 153 / 50%)')).rgb, 'rgb(51 102 153 / 50%)');
  assert.equal(c.toHex({ r: 51, g: 102, b: 153, a: 0.5 }), '#33669980');
});

test('contrasto WCAG, livelli, correzione', async () => {
  const c = await load();
  assert.equal(c.contrast(c.parse('#000'), c.parse('#fff')), 21);
  assert.equal(c.contrast(c.parse('#fff'), c.parse('#fff')), 1);
  assert.equal(c.contrast(c.parse('#777777'), c.parse('#ffffff')), 4.48);
  assert.deepEqual(c.wcag(4.48), { aa: false, aaa: false, aaLarge: true, aaaLarge: false, ui: true });
  assert.equal(c.readableOn(c.parse('#ffff00')), '#000000');
  assert.equal(c.readableOn(c.parse('#000080')), '#ffffff');
  const fixed = c.fixContrast(c.parse('#999999'), c.parse('#ffffff'));
  assert.ok(c.contrast(c.parse(fixed), c.parse('#ffffff')) >= 4.5, fixed);
  assert.equal(c.fixContrast(c.parse('#000000'), c.parse('#ffffff')), '#000000');
  // testo semitrasparente: composto sopra lo sfondo
  assert.ok(c.contrast(c.parse('rgb(0 0 0 / 50%)'), c.parse('#fff')) < 21);
});

test('sfumature 50–950 e armonie', async () => {
  const c = await load();
  const list = c.shades(c.parse('#3b82f6'));
  assert.deepEqual(list.map(s => s.step), c.STEPS);
  assert.equal(list.filter(s => s.base).length, 1);
  assert.equal(list.find(s => s.base).step, 500);
  assert.equal(list.find(s => s.base).hex, '#3b82f6');
  const L = list.map(s => c.luminance(c.parse(s.hex)));
  assert.ok(L.every((v, i) => i === 0 || v < L[i - 1]), 'dal più chiaro al più scuro');
  const h = c.harmonies(c.parse('#336699'));
  assert.equal(h.complementary.length, 2);
  assert.equal(h.tetradic.length, 4);
  assert.ok(Object.values(h).flat().every(x => /^#[0-9a-f]{6}$/.test(x)));
  assert.equal(c.toHex(c.mix(c.parse('#000'), c.parse('#fff'), 0)), '#000000');
});
