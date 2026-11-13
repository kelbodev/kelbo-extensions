// Color picker: selettore (quadrato saturazione/luminosità, tinta, trasparenza), contagocce,
// formati da copiare, colori recenti; schede Sfumature, Contrasto, Palette e Progetto.
//
// La prima parte è la matematica dei colori, senza DOM, esportata anche per il widget e i test:
// lettura di HEX, rgb(), hsl(), oklch() e nomi CSS comuni, conversioni fra RGB, HSV, HSL e OKLCH,
// testo nei vari formati, contrasto WCAG, sfumature 50–950 e armonie.

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const round = (v, d = 0) => { const k = 10 ** d; return Math.round(v * k) / k; };

// ---- lettura ----

const NAMED = {
  black: '#000000', white: '#ffffff', red: '#ff0000', green: '#008000', blue: '#0000ff', yellow: '#ffff00', cyan: '#00ffff',
  magenta: '#ff00ff', gray: '#808080', grey: '#808080', orange: '#ffa500', purple: '#800080', pink: '#ffc0cb', brown: '#a52a2a',
  navy: '#000080', teal: '#008080', olive: '#808000', maroon: '#800000', lime: '#00ff00', silver: '#c0c0c0', gold: '#ffd700',
  indigo: '#4b0082', violet: '#ee82ee', coral: '#ff7f50', salmon: '#fa8072', tomato: '#ff6347', crimson: '#dc143c',
  turquoise: '#40e0d0', rebeccapurple: '#663399', transparent: '#00000000',
};

function hexToRgb(hex) {
  let h = hex.replace(/^#/, '');
  if (![3, 4, 6, 8].includes(h.length) || /[^0-9a-f]/i.test(h)) return null;
  if (h.length <= 4) h = [...h].map(c => c + c).join('');
  const n = i => parseInt(h.slice(i, i + 2), 16);
  return { r: n(0), g: n(2), b: n(4), a: h.length === 8 ? round(n(6) / 255, 3) : 1 };
}

// numero CSS: "50%" → 0.5 della scala, "0.5" → 0.5, angoli in deg/rad/turn
function num(text, scale = 1) {
  const t = String(text).trim();
  if (t.endsWith('%')) return (parseFloat(t) / 100) * scale;
  const v = parseFloat(t);
  return Number.isFinite(v) ? v : NaN;
}
function angle(text) {
  const t = String(text).trim().toLowerCase();
  const v = parseFloat(t);
  if (t.endsWith('turn')) return v * 360;
  if (t.endsWith('rad')) return (v * 180) / Math.PI;
  if (t.endsWith('grad')) return v * 0.9;
  return v;
}

// "#336699", "rgb(51 102 153 / 50%)", "hsl(210, 50%, 40%)", "oklch(0.5 0.1 250)", "teal" → { r, g, b, a } o null
function parse(input) {
  if (typeof input !== 'string') return null;
  const s = input.trim().toLowerCase();
  if (!s) return null;
  if (NAMED[s]) return hexToRgb(NAMED[s]);
  if (s.startsWith('#')) return hexToRgb(s);
  if (/^[0-9a-f]{6}$|^[0-9a-f]{3}$/.test(s)) return hexToRgb(s);
  const m = /^(rgba?|hsla?|oklch|oklab)\(\s*([^)]*)\)$/.exec(s);
  if (!m) return null;
  const parts = m[2].replace(/\s*\/\s*/, ' / ').split(/[\s,]+/).filter(Boolean);
  const slash = parts.indexOf('/');
  const values = slash >= 0 ? parts.slice(0, slash) : parts.slice(0, 3);
  const alphaText = slash >= 0 ? parts[slash + 1] : parts[3];
  if (values.length !== 3) return null;
  const a = alphaText === undefined ? 1 : clamp(num(alphaText, 1), 0, 1);
  if (Number.isNaN(a)) return null;
  let rgb;
  if (m[1].startsWith('rgb')) rgb = { r: num(values[0], 255), g: num(values[1], 255), b: num(values[2], 255) };
  else if (m[1].startsWith('hsl')) rgb = hslToRgb({ h: angle(values[0]), s: num(values[1], 100), l: num(values[2], 100) });
  else if (m[1] === 'oklch') rgb = oklchToRgb({ l: num(values[0], 1), c: num(values[1], 0.4), h: angle(values[2]) });
  else rgb = oklabToRgb({ l: num(values[0], 1), a: num(values[1], 0.4), b: num(values[2], 0.4) });
  if (!rgb || [rgb.r, rgb.g, rgb.b].some(v => !Number.isFinite(v))) return null;
  return { r: clamp(Math.round(rgb.r), 0, 255), g: clamp(Math.round(rgb.g), 0, 255), b: clamp(Math.round(rgb.b), 0, 255), a: round(a, 3) };
}

// ---- conversioni ----

function rgbToHsv({ r, g, b }) {
  const [R, G, B] = [r / 255, g / 255, b / 255];
  const max = Math.max(R, G, B), min = Math.min(R, G, B), d = max - min;
  let h = 0;
  if (d) h = max === R ? ((G - B) / d) % 6 : max === G ? (B - R) / d + 2 : (R - G) / d + 4;
  return { h: (h * 60 + 360) % 360, s: max ? (d / max) * 100 : 0, v: max * 100 };
}
function hsvToRgb({ h, s, v }) {
  const S = s / 100, V = v / 100, c = V * S, x = c * (1 - Math.abs(((h / 60) % 2) - 1)), m = V - c;
  const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  return { r: Math.round((r + m) * 255), g: Math.round((g + m) * 255), b: Math.round((b + m) * 255) };
}
function rgbToHsl({ r, g, b }) {
  const [R, G, B] = [r / 255, g / 255, b / 255];
  const max = Math.max(R, G, B), min = Math.min(R, G, B), d = max - min, l = (max + min) / 2;
  let h = 0;
  if (d) h = max === R ? ((G - B) / d) % 6 : max === G ? (B - R) / d + 2 : (R - G) / d + 4;
  return { h: (h * 60 + 360) % 360, s: d ? (d / (1 - Math.abs(2 * l - 1))) * 100 : 0, l: l * 100 };
}
function hslToRgb({ h, s, l }) {
  const S = clamp(s, 0, 100) / 100, L = clamp(l, 0, 100) / 100;
  const c = (1 - Math.abs(2 * L - 1)) * S, hh = (((h % 360) + 360) % 360) / 60, x = c * (1 - Math.abs((hh % 2) - 1)), m = L - c / 2;
  const [r, g, b] = hh < 1 ? [c, x, 0] : hh < 2 ? [x, c, 0] : hh < 3 ? [0, c, x] : hh < 4 ? [0, x, c] : hh < 5 ? [x, 0, c] : [c, 0, x];
  return { r: (r + m) * 255, g: (g + m) * 255, b: (b + m) * 255 };
}

// sRGB ↔ OKLab (Björn Ottosson)
const toLinear = c => { const v = c / 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
const fromLinear = v => 255 * (v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055);
function rgbToOklab({ r, g, b }) {
  const [R, G, B] = [toLinear(r), toLinear(g), toLinear(b)];
  const l = Math.cbrt(0.4122214708 * R + 0.5363325363 * G + 0.0514459929 * B);
  const m = Math.cbrt(0.2119034982 * R + 0.6806995451 * G + 0.1073969566 * B);
  const s = Math.cbrt(0.0883024619 * R + 0.2817188376 * G + 0.6299787005 * B);
  return { l: 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, a: 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s, b: 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s };
}
// valori lineari (anche fuori da 0–1: per capire se il colore sta nello spazio sRGB)
function oklabToLinear({ l, a, b }) {
  const L = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const M = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const S = (l - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [4.0767416621 * L - 3.3077115913 * M + 0.2309699292 * S, -1.2684380046 * L + 2.6097574011 * M - 0.3413193965 * S, -0.0041960863 * L - 0.7034186147 * M + 1.707614701 * S];
}
function oklabToRgb(lab) {
  const [r, g, b] = oklabToLinear(lab).map(v => clamp(fromLinear(clamp(v, 0, 1)), 0, 255));
  return { r, g, b };
}
function rgbToOklch(rgb) {
  const { l, a, b } = rgbToOklab(rgb);
  const c = Math.sqrt(a * a + b * b);
  return { l, c, h: c < 1e-4 ? 0 : ((Math.atan2(b, a) * 180) / Math.PI + 360) % 360 };
}
const oklchLab = ({ l, c, h }) => ({ l, a: c * Math.cos((h * Math.PI) / 180), b: c * Math.sin((h * Math.PI) / 180) });
const inGamut = lch => oklabToLinear(oklchLab(lch)).every(v => v >= -1e-4 && v <= 1 + 1e-4);
// OKLCH → RGB riducendo il croma finché il colore entra in sRGB (stessa luce e tinta)
function oklchToRgb(lch) {
  let { c } = lch;
  if (!inGamut(lch)) {
    let lo = 0, hi = c;
    for (let i = 0; i < 24; i++) { const mid = (lo + hi) / 2; if (inGamut({ ...lch, c: mid })) lo = mid; else hi = mid; }
    c = lo;
  }
  return oklabToRgb(oklchLab({ ...lch, c }));
}

// ---- testo ----

const hex2 = v => Math.round(clamp(v, 0, 255)).toString(16).padStart(2, '0');
function toHex({ r, g, b, a = 1 }) {
  return `#${hex2(r)}${hex2(g)}${hex2(b)}${a < 1 ? hex2(a * 255) : ''}`;
}
const alphaPart = a => (a < 1 ? ` / ${round(a * 100)}%` : '');
const toRgbString = ({ r, g, b, a = 1 }) => `rgb(${Math.round(r)} ${Math.round(g)} ${Math.round(b)}${alphaPart(a)})`;
function toHslString(rgb) {
  const { h, s, l } = rgbToHsl(rgb);
  return `hsl(${round(h, 1)} ${round(s, 1)}% ${round(l, 1)}%${alphaPart(rgb.a ?? 1)})`;
}
function toOklchString(rgb) {
  const { l, c, h } = rgbToOklch(rgb);
  return `oklch(${round(l * 100, 1)}% ${round(c, 3)} ${round(h, 1)}${alphaPart(rgb.a ?? 1)})`;
}
// tutti i formati di un colore, per le righe da copiare
function formats(rgb) {
  return { hex: toHex(rgb), rgb: toRgbString(rgb), hsl: toHslString(rgb), oklch: toOklchString(rgb) };
}

// ---- contrasto WCAG 2 ----

function luminance({ r, g, b }) {
  const [R, G, B] = [toLinear(r), toLinear(g), toLinear(b)];
  return 0.2126 * R + 0.7152 * G + 0.0722 * B;
}
// colore con trasparenza sopra uno sfondo opaco
const over = (fg, bg) => ({ r: fg.r * fg.a + bg.r * (1 - fg.a), g: fg.g * fg.a + bg.g * (1 - fg.a), b: fg.b * fg.a + bg.b * (1 - fg.a), a: 1 });
function contrast(fg, bg) {
  const top = (fg.a ?? 1) < 1 ? over({ a: 1, ...fg }, bg) : fg;
  const [x, y] = [luminance(top), luminance(bg)].sort((p, q) => q - p);
  return round((x + 0.05) / (y + 0.05), 2);
}
// livelli superati: testo normale AA 4.5, AAA 7; testo grande AA 3, AAA 4.5; componenti 3
const wcag = ratio => ({ aa: ratio >= 4.5, aaa: ratio >= 7, aaLarge: ratio >= 3, aaaLarge: ratio >= 4.5, ui: ratio >= 3 });
// bianco o nero, il più leggibile sopra un colore
const readableOn = rgb => (contrast({ r: 255, g: 255, b: 255, a: 1 }, rgb) >= contrast({ r: 0, g: 0, b: 0, a: 1 }, rgb) ? '#ffffff' : '#000000');

// ---- sfumature e armonie ----

const STEPS = [50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 950];
const STEP_L = [0.971, 0.936, 0.885, 0.808, 0.704, 0.637, 0.577, 0.505, 0.444, 0.396, 0.258];
const STEP_C = [0.12, 0.25, 0.45, 0.7, 0.92, 1, 1, 0.92, 0.8, 0.66, 0.48];
// Scala 50–950 con la tinta e il croma del colore (luce come le scale di Tailwind); base: il
// gradino più vicino al colore dato, che è il colore stesso
function shades(rgb) {
  const base = rgbToOklch(rgb);
  const list = STEPS.map((step, i) => ({ step, hex: toHex(oklchToRgb({ l: STEP_L[i], c: base.c * STEP_C[i] / Math.max(...STEP_C.slice(4, 7)), h: base.h })) }));
  const nearest = STEP_L.reduce((best, l, i) => (Math.abs(l - base.l) < Math.abs(STEP_L[best] - base.l) ? i : best), 0);
  // il colore dato prende il posto del gradino più vicino, così la scala lo contiene esattamente
  return list.map((s, i) => (i === nearest ? { ...s, hex: toHex({ ...rgb, a: 1 }), base: true } : { ...s, base: false }));
}
// Armonie sul cerchio delle tinte (in OKLCH: stessa luce e croma)
function harmonies(rgb) {
  const base = rgbToOklch(rgb);
  const rot = deg => toHex(oklchToRgb({ ...base, h: (base.h + deg + 360) % 360 }));
  return {
    complementary: [toHex(rgb), rot(180)],
    analogous: [rot(-30), toHex(rgb), rot(30)],
    triadic: [toHex(rgb), rot(120), rot(240)],
    split: [toHex(rgb), rot(150), rot(210)],
    tetradic: [toHex(rgb), rot(90), rot(180), rot(270)],
  };
}
// Mescola due colori in OKLab (t = 0 → a, 1 → b)
function mix(a, b, t = 0.5) {
  const x = rgbToOklab(a), y = rgbToOklab(b);
  const rgb = oklabToRgb({ l: x.l + (y.l - x.l) * t, a: x.a + (y.a - x.a) * t, b: x.b + (y.b - x.b) * t });
  return { r: Math.round(rgb.r), g: Math.round(rgb.g), b: Math.round(rgb.b), a: (a.a ?? 1) + ((b.a ?? 1) - (a.a ?? 1)) * t };
}

export {
  parse, hexToRgb, rgbToHsv, hsvToRgb, rgbToHsl, hslToRgb, rgbToOklch, oklchToRgb, toHex, toRgbString, toHslString, toOklchString,
  formats, luminance, contrast, wcag, readableOn, shades, harmonies, mix, STEPS,
};

// ---- pannello ----

// Colore più vicino (stessa tinta e croma, luce cambiata) con almeno il contrasto voluto sullo
// sfondo: prima nella direzione che lo allontana dallo sfondo; null se non esiste
function fixContrast(fg, bg, target = 4.5) {
  if (contrast(fg, bg) >= target) return toHex(fg);
  const base = rgbToOklch(fg);
  const darker = luminance(bg) > 0.18;
  for (const dir of darker ? [-1, 1] : [1, -1]) {
    for (let l = base.l; l >= 0 && l <= 1; l += dir * 0.005) {
      const rgb = { ...oklchToRgb({ ...base, l }), a: 1 };
      const c = { r: Math.round(rgb.r), g: Math.round(rgb.g), b: Math.round(rgb.b), a: 1 };
      if (contrast(c, bg) >= target) return toHex(c);
    }
  }
  return null;
}
export { fixContrast };

const RECENT_KEY = 'kelbo.colorPicker.recent';
const CURRENT_KEY = 'kelbo.colorPicker.current';
const MAX_RECENT = 18;
const FORMATS = ['hex', 'rgb', 'hsl', 'oklch'];
const store = {
  get(key, fallback) { try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; } },
  set(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* solo per questa sessione */ } },
};

export default {
  async mount(ctx) {
    const { esc, js, toast, openModal, closeModal, fmt } = ctx.ui;
    const { t } = ctx;
    const $ = role => ctx.root.querySelector(`[data-role="${role}"]`);

    // colore corrente in HSV (la tinta resta anche sul grigio) + alfa
    let hsv = { h: 210, s: 67, v: 60 };
    let alpha = 1;
    let tab = store.get('kelbo.colorPicker.tab', 'shades');
    let recent = store.get(RECENT_KEY, []).filter(h => parse(h));
    let background = '#ffffff';
    let palettes = [];
    let projects = [], scanProject = null, scan = null, scanning = false;

    const rgb = () => ({ ...hsvToRgb(hsv), a: alpha });
    const hex = () => toHex(rgb());

    function setColor(value, { remember = false } = {}) {
      const c = typeof value === 'string' ? parse(value) : value;
      if (!c) return false;
      const next = rgbToHsv(c);
      // grigi: si tiene la tinta di prima, così il cursore della tinta non salta
      hsv = { h: next.s < 0.5 || next.v < 0.5 ? hsv.h : next.h, s: next.s, v: next.v };
      alpha = c.a ?? 1;
      if (remember) addRecent();
      render();
      return true;
    }
    function addRecent() {
      const h = hex();
      recent = [h, ...recent.filter(x => x !== h)].slice(0, MAX_RECENT);
      store.set(RECENT_KEY, recent);
      renderRecent();
    }

    async function copy(text) {
      try { await navigator.clipboard.writeText(text); }
      catch {
        const area = Object.assign(document.createElement('textarea'), { value: text });
        document.body.appendChild(area); area.select(); document.execCommand('copy'); area.remove();
      }
      toast(t('copied', { value: text }), 'success');
      addRecent();
    }

    // ---- selettore ----
    function render() {
      const c = rgb();
      const pure = toHex(hsvToRgb({ h: hsv.h, s: 100, v: 100 }));
      const sv = $('sv');
      sv.style.setProperty('--cp-hue', pure);
      const thumb = $('sv-thumb');
      thumb.style.left = `${hsv.s}%`;
      thumb.style.top = `${100 - hsv.v}%`;
      thumb.style.background = toHex({ ...c, a: 1 });
      $('hue').value = String(Math.round(hsv.h));
      const a = $('alpha');
      a.value = String(Math.round(alpha * 100));
      a.style.setProperty('--cp-opaque', toHex({ ...c, a: 1 }));
      $('swatch').style.background = toRgbString(c);
      const input = $('input');
      if (document.activeElement !== input) input.value = hex();
      const f = formats(c);
      ctx.ui.patch($('formats'), FORMATS.map(k => `
        <div class="cp-format"><span class="cp-format-name">${k.toUpperCase()}</span><code>${esc(f[k])}</code>
          <button class="btn btn-ghost btn-sm" onclick="Ext['color-picker'].copy(${js(f[k])})" title="${esc(t('copy'))}">${ctx.ui.icon('copy')}</button></div>`).join('') + `
        <div class="cp-format"><span class="cp-format-name">CSS</span><code>--color: ${esc(f.hex)};</code>
          <button class="btn btn-ghost btn-sm" onclick="Ext['color-picker'].copy(${js(`--color: ${f.hex};`)})" title="${esc(t('copy'))}">${ctx.ui.icon('copy')}</button></div>`);
      store.set(CURRENT_KEY, hex());
      renderTab();
    }
    function renderRecent() {
      ctx.ui.patch($('recent'), recent.length ? recent.map(h => swatchButton(h, `Ext['color-picker'].pick(${js(h)})`, h)).join('')
        : `<span class="cp-muted">${esc(t('picker.noRecent'))}</span>`);
    }
    const swatchButton = (h, action, title, extra = '') => `<button class="cp-chip cp-checker" onclick="${esc(action)}" title="${esc(title)}" ${extra}><span style="background:${esc(h)}"></span></button>`;

    // trascinamento nel quadrato saturazione/luminosità
    const sv = $('sv');
    const fromPointer = e => {
      const r = sv.getBoundingClientRect();
      hsv = { ...hsv, s: Math.min(100, Math.max(0, ((e.clientX - r.left) / r.width) * 100)), v: Math.min(100, Math.max(0, 100 - ((e.clientY - r.top) / r.height) * 100)) };
      render();
    };
    sv.addEventListener('pointerdown', e => { sv.setPointerCapture(e.pointerId); fromPointer(e); });
    sv.addEventListener('pointermove', e => { if (sv.hasPointerCapture(e.pointerId)) fromPointer(e); });
    sv.addEventListener('pointerup', () => addRecent());
    sv.addEventListener('keydown', e => {
      const step = e.shiftKey ? 10 : 1;
      const moves = { ArrowLeft: ['s', -step], ArrowRight: ['s', step], ArrowUp: ['v', step], ArrowDown: ['v', -step] };
      if (!moves[e.key]) return;
      e.preventDefault();
      const [k, d] = moves[e.key];
      hsv = { ...hsv, [k]: Math.min(100, Math.max(0, hsv[k] + d)) };
      render();
    });
    $('hue').addEventListener('input', e => { hsv = { ...hsv, h: Number(e.target.value) }; render(); });
    $('alpha').addEventListener('input', e => { alpha = Number(e.target.value) / 100; render(); });
    for (const el of [$('hue'), $('alpha')]) el.addEventListener('change', addRecent);
    const input = $('input');
    input.addEventListener('input', () => { if (parse(input.value)) { input.classList.remove('cp-bad'); setColor(input.value); } else input.classList.add('cp-bad'); });
    input.addEventListener('change', () => { if (setColor(input.value, { remember: true })) input.value = hex(); });
    input.addEventListener('blur', () => { input.classList.remove('cp-bad'); input.value = hex(); });

    // contagocce del browser (Chrome, Edge): un pixel qualsiasi dello schermo
    const dropper = ctx.root.querySelector('[data-action="eyedropper"]');
    if (!('EyeDropper' in window)) { dropper.disabled = true; dropper.title = t('picker.noEyedropper'); }
    dropper.addEventListener('click', async () => {
      try { const r = await new window.EyeDropper().open(); setColor(r.sRGBHex, { remember: true }); } catch { /* annullato */ }
    });

    // ---- schede ----
    function renderTab() {
      for (const b of ctx.root.querySelectorAll('.cp-tab')) b.classList.toggle('active', b.dataset.tab === tab);
      const el = $('tab');
      if (tab === 'shades') ctx.ui.patch(el, shadesHtml());
      else if (tab === 'contrast') ctx.ui.patch(el, contrastHtml());
      else if (tab === 'palettes') ctx.ui.patch(el, palettesHtml());
      else ctx.ui.patch(el, projectHtml());
    }

    function shadesHtml() {
      const list = shades(rgb());
      const css = list.map(s => `  --color-${s.step}: ${s.hex};`).join('\n');
      const groups = harmonies(rgb());
      return `<div class="cp-section-title">${esc(t('shades.title'))}
          <button class="btn btn-ghost btn-sm" onclick="Ext['color-picker'].copy(${js(`:root {\n${css}\n}`)})">${ctx.ui.icon('copy')} ${esc(t('shades.copyCss'))}</button>
          <button class="btn btn-ghost btn-sm" onclick="Ext['color-picker'].savePalette('shades')">${ctx.ui.icon('swatch-book')} ${esc(t('shades.save'))}</button></div>
        <div class="cp-shades">${list.map(s => `
          <button class="cp-shade ${s.base ? 'cp-base' : ''}" style="background:${esc(s.hex)};color:${esc(readableOn(parse(s.hex)))}" onclick="Ext['color-picker'].pick(${js(s.hex)})" title="${esc(t('shades.pick'))}">
            <span class="cp-shade-step">${s.step}</span><span class="cp-shade-hex">${esc(s.hex)}</span></button>`).join('')}</div>
        <div class="cp-section-title">${esc(t('harmonies.title'))}</div>
        <div class="cp-harmonies">${Object.entries(groups).map(([k, colors]) => `
          <div class="cp-harmony"><span class="cp-harmony-name">${esc(t(`harmonies.${k}`))}</span>
            <div class="cp-harmony-row">${colors.map(h => `<button class="cp-harmony-color" style="background:${esc(h)};color:${esc(readableOn(parse(h)))}" onclick="Ext['color-picker'].pick(${js(h)})">${esc(h)}</button>`).join('')}</div></div>`).join('')}</div>`;
    }

    function contrastHtml() {
      const fg = rgb();
      const bg = parse(background) || { r: 255, g: 255, b: 255, a: 1 };
      const ratio = contrast(fg, bg);
      const pass = wcag(ratio);
      const badge = (ok, label) => `<span class="cp-badge ${ok ? 'ok' : 'ko'}">${ctx.ui.icon(ok ? 'check' : 'x')} ${esc(label)}</span>`;
      const fix = !pass.aa ? fixContrast(fg, bg, 4.5) : null;
      return `<div class="cp-contrast">
        <div class="cp-contrast-inputs">
          <label>${esc(t('contrast.text'))}<span class="cp-contrast-chip cp-checker"><span style="background:${esc(toRgbString(fg))}"></span></span><code>${esc(hex())}</code></label>
          <button class="btn btn-ghost btn-sm" onclick="Ext['color-picker'].swap()" title="${esc(t('contrast.swap'))}">${ctx.ui.icon('arrow-left-right')}</button>
          <label>${esc(t('contrast.background'))}<input type="color" value="${esc(toHex({ ...bg, a: 1 }))}" data-role="bg-picker">
            <input class="form-input cp-bg-input" value="${esc(background)}" data-role="bg-input" spellcheck="false"></label>
        </div>
        <div class="cp-sample" style="background:${esc(toHex(bg))};color:${esc(toRgbString(fg))}">
          <div class="cp-sample-large">${esc(t('contrast.sampleLarge'))}</div><div>${esc(t('contrast.sample'))}</div>
          <span class="cp-sample-ui" style="border-color:${esc(toRgbString(fg))}">${esc(t('contrast.sampleUi'))}</span></div>
        <div class="cp-ratio"><strong>${esc(fmt.number(ratio, { maximumFractionDigits: 2 }))}:1</strong></div>
        <div class="cp-badges">${badge(pass.aa, t('contrast.aa'))}${badge(pass.aaa, t('contrast.aaa'))}${badge(pass.aaLarge, t('contrast.aaLarge'))}${badge(pass.aaaLarge, t('contrast.aaaLarge'))}${badge(pass.ui, t('contrast.ui'))}</div>
        ${fix ? `<p class="cp-muted">${esc(t('contrast.fix'))} <button class="cp-fix" onclick="Ext['color-picker'].pick(${js(fix)})"><span style="background:${esc(fix)}"></span>${esc(fix)}</button></p>` : ''}
      </div>`;
    }

    function palettesHtml() {
      const byProject = id => palettes.filter(p => (p.projectId || null) === id);
      const label = id => projects.find(p => p.id === id)?.label || id;
      const groups = [[null, byProject(null)], ...[...new Set(palettes.map(p => p.projectId).filter(Boolean))].map(id => [id, byProject(id)])];
      const block = p => `<div class="cp-palette">
          <div class="cp-palette-head"><strong>${esc(p.name)}</strong><span class="cp-muted">${esc(fmt.number(p.colors.length))}</span>
            <span class="cp-palette-actions">
              <button class="btn btn-ghost btn-sm" onclick="Ext['color-picker'].addToPalette(${js(p.id)})" title="${esc(t('palettes.addCurrent'))}">${ctx.ui.icon('plus')} <span class="cp-chip-inline" style="background:${esc(hex())}"></span></button>
              <button class="btn btn-ghost btn-sm" onclick="Ext['color-picker'].copyPalette(${js(p.id)})" title="${esc(t('palettes.copyCss'))}">${ctx.ui.icon('copy')}</button>
              <button class="btn btn-ghost btn-sm" onclick="Ext['color-picker'].editPalette(${js(p.id)})" title="${esc(t('palettes.edit'))}">${ctx.ui.icon('pencil')}</button>
              <button class="btn btn-ghost btn-sm" onclick="Ext['color-picker'].deletePalette(${js(p.id)})" title="${esc(t('palettes.delete'))}">${ctx.ui.icon('trash-2')}</button></span></div>
          <div class="cp-palette-colors">${p.colors.length ? p.colors.map((c, i) => `<span class="cp-palette-color">
              ${swatchButton(c.value, `Ext['color-picker'].pick(${js(c.value)})`, `${c.name ? `${c.name} · ` : ''}${c.value}`)}
              <button class="cp-remove" onclick="Ext['color-picker'].removeColor(${js(p.id)}, ${i})" title="${esc(t('palettes.removeColor'))}">${ctx.ui.icon('x')}</button></span>`).join('')
            : `<span class="cp-muted">${esc(t('palettes.empty'))}</span>`}</div></div>`;
      return `<div class="cp-section-title">${esc(t('palettes.title'))}
          <button class="btn btn-ghost btn-sm" onclick="Ext['color-picker'].savePalette('new')">${ctx.ui.icon('plus')} ${esc(t('palettes.new'))}</button></div>
        ${palettes.length ? groups.filter(([, list]) => list.length).map(([id, list]) => `
          <div class="cp-palette-group">${esc(id ? label(id) : t('palettes.general'))}</div>${list.map(block).join('')}`).join('')
          : `<p class="cp-muted">${esc(t('palettes.none'))}</p>`}`;
    }

    function projectHtml() {
      const options = projects.map(p => `<option value="${esc(p.id)}" ${p.id === scanProject ? 'selected' : ''}>${esc(p.label)}</option>`).join('');
      const head = `<div class="cp-section-title cp-scan-head">
          <select class="form-input cp-project" data-role="scan-project"><option value="">${esc(t('project.choose'))}</option>${options}</select>
          <button class="btn btn-ghost btn-sm" onclick="Ext['color-picker'].scan()" ${scanProject ? '' : 'disabled'}>${ctx.ui.icon('scan-search')} ${esc(t('project.scan'))}</button>
          ${scan?.colors?.length ? `<button class="btn btn-ghost btn-sm" onclick="Ext['color-picker'].savePalette('project')">${ctx.ui.icon('swatch-book')} ${esc(t('project.save'))}</button>` : ''}</div>`;
      if (scanning) return `${head}<p class="cp-muted">${esc(t('project.scanning'))}</p>`;
      if (!scan) return `${head}<p class="cp-muted">${esc(t('project.hint'))}</p>`;
      return `${head}<p class="cp-muted">${esc(t('project.summary', { colors: fmt.number(scan.total), files: fmt.number(scan.files) }))}${scan.truncated ? ` · ${esc(t('project.truncated'))}` : ''}</p>
        <div class="cp-found">${scan.colors.map(c => `
          <button class="cp-found-item" onclick="Ext['color-picker'].pick(${js(c.hex)})"
                  title="${esc(c.files.map(f => `${f.file}:${f.line}`).join('\n') + (c.fileCount > c.files.length ? '\n…' : ''))}">
            <span class="cp-found-swatch cp-checker"><span style="background:${esc(c.hex)}"></span></span>
            <span class="cp-found-text"><code>${esc(c.hex)}</code><span class="cp-muted">${esc(t('project.uses', { count: c.count }))}</span>
              ${c.names.length ? `<span class="cp-found-names">${esc(c.names.join(' '))}</span>` : ''}</span>
          </button>`).join('')}</div>`;
    }

    ctx.root.querySelector('.cp-tabs').addEventListener('click', e => {
      const b = e.target.closest('.cp-tab');
      if (!b) return;
      tab = b.dataset.tab;
      store.set('kelbo.colorPicker.tab', tab);
      if (tab === 'palettes' || tab === 'project') loadProjects().then(renderTab);
      renderTab();
    });
    $('tab').addEventListener('input', e => {
      if (e.target.dataset.role === 'bg-picker') { background = e.target.value; renderTab(); }
    });
    $('tab').addEventListener('change', e => {
      if (e.target.dataset.role === 'bg-input' && parse(e.target.value)) { background = e.target.value.trim(); renderTab(); }
      if (e.target.dataset.role === 'scan-project') { scanProject = e.target.value || null; scan = null; renderTab(); if (scanProject) actions.scan(); }
    });

    // ---- dati ----
    async function loadPalettes() {
      try { palettes = (await ctx.api.get('/palettes')).palettes; } catch { palettes = []; }
    }
    async function loadProjects() {
      try { projects = (await ctx.projects.load()).projects; } catch { projects = []; }
    }

    // dialog: nome e progetto di una palette (nuova o esistente)
    function paletteDialog({ title, name = '', projectId = null, onSave }) {
      openModal(title, `
        <div class="form-row"><label for="cp_pal_name">${esc(t('palettes.name'))}</label><input class="form-input" id="cp_pal_name" value="${esc(name)}" maxlength="80"></div>
        <div class="form-row"><label for="cp_pal_project">${esc(t('palettes.project'))}</label>
          <select class="form-input" id="cp_pal_project"><option value="">${esc(t('palettes.general'))}</option>
            ${projects.map(p => `<option value="${esc(p.id)}" ${p.id === projectId ? 'selected' : ''}>${esc(p.label)}</option>`).join('')}</select></div>`,
        `<button class="btn btn-ghost" onclick="UI.closeModal()">${esc(t('core.action.cancel'))}</button>
         <button class="btn cp-btn" id="cp_pal_save">${esc(t('core.action.save'))}</button>`);
      document.getElementById('modal').classList.add('cp-modal');
      const go = async () => {
        const n = document.getElementById('cp_pal_name').value.trim();
        if (!n) { document.getElementById('cp_pal_name').focus(); return; }
        try { await onSave(n, document.getElementById('cp_pal_project').value || null); closeModal(); await loadPalettes(); tab = 'palettes'; renderTab(); }
        catch (e) { toast(e.message, 'error'); }
      };
      document.getElementById('cp_pal_save').addEventListener('click', go);
      document.getElementById('cp_pal_name').addEventListener('keydown', e => { if (e.key === 'Enter') go(); });
      document.getElementById('cp_pal_name').focus();
    }
    const update = (p, changes) => ctx.api.put(`/palettes/${encodeURIComponent(p.id)}`, { name: p.name, projectId: p.projectId, colors: p.colors, ...changes });
    const paletteOf = id => palettes.find(p => p.id === id);

    const actions = {
      copy,
      pick: h => { setColor(h, { remember: true }); },
      swap() {
        const bg = parse(background);
        if (!bg) return;
        background = toHex({ ...rgb(), a: 1 });
        setColor(bg, { remember: true });
      },
      async savePalette(kind) {
        await loadProjects();
        const colors = kind === 'shades' ? shades(rgb()).map(s => ({ value: s.hex, name: String(s.step) }))
          : kind === 'project' ? (scan?.colors || []).slice(0, 24).map(c => ({ value: c.hex.slice(0, 9), ...(c.names[0] ? { name: c.names[0] } : {}) }))
            : [{ value: toHex({ ...rgb(), a: alpha }) }];
        const name = kind === 'shades' ? hex() : kind === 'project' ? projects.find(p => p.id === scanProject)?.label || '' : '';
        paletteDialog({ title: t('palettes.newTitle'), name, projectId: kind === 'project' ? scanProject : null,
          onSave: (n, projectId) => ctx.api.post('/palettes', { name: n, projectId, colors }) });
      },
      async editPalette(id) {
        const p = paletteOf(id);
        if (!p) return;
        await loadProjects();
        paletteDialog({ title: t('palettes.editTitle'), name: p.name, projectId: p.projectId, onSave: (n, projectId) => update(p, { name: n, projectId }) });
      },
      async addToPalette(id) {
        const p = paletteOf(id);
        if (!p || p.colors.some(c => c.value === hex())) return;
        try { await update(p, { colors: [...p.colors, { value: hex() }] }); await loadPalettes(); renderTab(); } catch (e) { toast(e.message, 'error'); }
      },
      async removeColor(id, i) {
        const p = paletteOf(id);
        if (!p) return;
        try { await update(p, { colors: p.colors.filter((_, k) => k !== i) }); await loadPalettes(); renderTab(); } catch (e) { toast(e.message, 'error'); }
      },
      copyPalette(id) {
        const p = paletteOf(id);
        if (!p) return;
        const slug = s => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'color';
        copy(`:root {\n${p.colors.map((c, i) => `  --${slug(p.name)}-${c.name ? slug(c.name) : i + 1}: ${c.value};`).join('\n')}\n}`);
      },
      deletePalette(id) {
        const p = paletteOf(id);
        if (!p) return;
        openModal(t('palettes.deleteTitle'), `<p>${esc(t('palettes.deleteText', { name: p.name }))}</p>`,
          `<button class="btn btn-ghost" onclick="UI.closeModal()">${esc(t('core.action.cancel'))}</button>
           <button class="btn btn-danger" id="cp_pal_delete">${esc(t('palettes.delete'))}</button>`);
        document.getElementById('cp_pal_delete').addEventListener('click', async () => {
          try { await ctx.api.del(`/palettes/${encodeURIComponent(id)}`); closeModal(); await loadPalettes(); renderTab(); } catch (e) { toast(e.message, 'error'); }
        });
      },
      async scan() {
        if (!scanProject) return;
        scanning = true; renderTab();
        try { scan = await ctx.api.get(`/projects/${encodeURIComponent(scanProject)}/colors`); }
        catch (e) { scan = null; toast(e.message, 'error'); }
        scanning = false; renderTab();
      },
    };

    ctx.expose(actions);
    setColor(store.get(CURRENT_KEY, '#3b82f6')) || setColor('#3b82f6');
    renderRecent();
    await loadPalettes();
    renderTab();

    this.show = async () => { await loadPalettes(); if (tab === 'palettes' || tab === 'project') await loadProjects(); renderTab(); };
    this.refresh = this.show;
    // aperta da altre sezioni: { color } lo sceglie, { project } apre i colori di quel progetto
    this.focus = async params => {
      if (params?.color) setColor(params.color, { remember: true });
      if (params?.project) { await loadProjects(); scanProject = params.project; tab = 'project'; renderTab(); actions.scan(); }
    };
    this.languageChanged = () => { render(); renderRecent(); };
  },
};
