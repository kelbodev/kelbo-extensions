// Color picker: palette salvate (sezione colorPalettes di config.json, generali o di un progetto,
// esportabili) e colori usati nei file di un progetto (CSS, SCSS, template, componenti), con i
// nomi delle variabili CSS e SCSS che li definiscono.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const MAX_PALETTES = 200;
const MAX_COLORS = 64;
const MAX_FILES = 3000;
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_DEPTH = 12;
const HEX_RE = /^#[0-9a-f]{6}([0-9a-f]{2})?$/;
const EXTENSIONS = new Set(['.css', '.scss', '.sass', '.less', '.styl', '.html', '.htm', '.vue', '.svelte', '.astro', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.json', '.svg']);
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', 'out', 'coverage', '.git', '.angular', '.next', '.nuxt', '.svelte-kit', 'vendor', 'tmp', '.cache']);

// ---- colori nel testo ----

const hex2 = v => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, '0');
const toHex = (r, g, b, a = 1) => `#${hex2(r)}${hex2(g)}${hex2(b)}${a < 1 ? hex2(a * 255) : ''}`;
function hexValue(h) {
  let x = h.slice(1).toLowerCase();
  if (x.length <= 4) x = [...x].map(c => c + c).join('');
  return x.length === 8 && x.endsWith('ff') ? `#${x.slice(0, 6)}` : `#${x}`;
}
const pct = (t, scale) => (t.endsWith('%') ? (parseFloat(t) / 100) * scale : parseFloat(t));
function hslToHex(h, s, l, a) {
  const S = s / 100, L = l / 100, c = (1 - Math.abs(2 * L - 1)) * S, hh = (((h % 360) + 360) % 360) / 60, x = c * (1 - Math.abs((hh % 2) - 1)), m = L - c / 2;
  const [r, g, b] = hh < 1 ? [c, x, 0] : hh < 2 ? [x, c, 0] : hh < 3 ? [0, c, x] : hh < 4 ? [0, x, c] : hh < 5 ? [x, 0, c] : [c, 0, x];
  return toHex((r + m) * 255, (g + m) * 255, (b + m) * 255, a);
}
// rgb()/hsl() → hex, null se non è un colore
function functionValue(fn, body) {
  const parts = body.replace(/\s*\/\s*/, ' / ').split(/[\s,]+/).filter(Boolean);
  const slash = parts.indexOf('/');
  const v = slash >= 0 ? parts.slice(0, slash) : parts.slice(0, 3);
  const at = slash >= 0 ? parts[slash + 1] : parts[3];
  if (v.length !== 3 || v.some(x => !/^-?[\d.]+(%|deg)?$/.test(x)) || (at !== undefined && !/^[\d.]+%?$/.test(at))) return null;
  const a = at === undefined ? 1 : Math.min(1, Math.max(0, pct(at, 1)));
  if (fn.startsWith('rgb')) return toHex(pct(v[0], 255), pct(v[1], 255), pct(v[2], 255), a);
  return hslToHex(parseFloat(v[0]), parseFloat(v[1]), parseFloat(v[2]), a);
}

// Colori di un testo: [{ hex, line, name? }]; name: la variabile che lo definisce (--x, $x, @x)
const COLOR_RE = /(--[\w-]+|\$[\w-]+|@[\w-]+)?(\s*:\s*)?(#[0-9a-fA-F]{8}\b|#[0-9a-fA-F]{6}\b|#[0-9a-fA-F]{3,4}\b|\b(?:rgba?|hsla?)\(([^()]*)\))/g;
function colorsIn(text) {
  const out = [];
  const lines = text.split('\n');
  lines.forEach((line, i) => {
    if (line.length > 2000) return; // righe minimizzate: troppo rumore
    for (const m of line.matchAll(COLOR_RE)) {
      const value = m[3];
      let hex;
      if (value.startsWith('#')) {
        // un colore sta dopo ":", "=", "(", ",", virgolette o spazi: non "a#fff" (ancore, id)
        const prev = line[m.index + m[0].length - value.length - 1];
        if (prev !== undefined && !/[\s:=(,'"`>[{]/.test(prev)) continue;
        if (/^#\d{3,4}$/.test(value)) continue; // "#123": un numero di issue, non un colore
        hex = hexValue(value);
      } else hex = functionValue(value.slice(0, value.indexOf('(')).toLowerCase(), m[4]);
      if (hex) out.push({ hex, line: i + 1, ...(m[1] && m[2] ? { name: m[1] } : {}) });
    }
  });
  return out;
}

module.exports = function createColorPicker(ctx) {
  const projectOr404 = id => {
    const p = typeof id === 'string' ? ctx.projects.get(id) : null;
    if (!p) throw ctx.error(404, 'project_not_found', { id: String(id) });
    return p;
  };

  // ---- palette ----
  const all = () => ctx.config.get('colorPalettes')?.palettes || [];
  const save = palettes => ctx.config.set('colorPalettes', { palettes });

  function checkPalette(body, cfg = null) {
    const b = body && typeof body === 'object' ? body : {};
    const name = typeof b.name === 'string' ? b.name.trim() : '';
    if (!name || name.length > 80) throw ctx.error(400, 'palette_name');
    if (!Array.isArray(b.colors) || b.colors.length > MAX_COLORS) throw ctx.error(400, 'palette_colors');
    const colors = b.colors.map(c => {
      const value = typeof c?.value === 'string' ? c.value.trim().toLowerCase() : '';
      if (!HEX_RE.test(value)) throw ctx.error(400, 'color_invalid', { value: String(c?.value ?? '') });
      const label = typeof c?.name === 'string' ? c.name.trim().slice(0, 60) : '';
      return { value, ...(label ? { name: label } : {}) };
    });
    let projectId = null;
    if (b.projectId !== undefined && b.projectId !== null && b.projectId !== '') {
      if (typeof b.projectId !== 'string' || !ctx.lib.validate.KEY_RE.test(b.projectId)) throw ctx.error(400, 'project_not_found', { id: String(b.projectId) });
      if (!cfg && !ctx.projects.get(b.projectId)) throw ctx.error(404, 'project_not_found', { id: b.projectId });
      projectId = b.projectId;
    }
    return { name, colors, projectId };
  }

  const config = {
    colorPalettes: {
      empty: { palettes: [] },
      validate(value) {
        if (!value || typeof value !== 'object' || !Array.isArray(value.palettes) || value.palettes.length > MAX_PALETTES) throw ctx.error.config('palettes_invalid');
        const ids = new Set();
        for (const p of value.palettes) {
          if (!p || typeof p.id !== 'string' || !/^[a-z0-9]{8,32}$/.test(p.id) || ids.has(p.id)) throw ctx.error.config('palettes_invalid');
          ids.add(p.id);
          try { checkPalette(p, true); } catch { throw ctx.error.config('palettes_invalid'); }
        }
      },
      // import in unione: le palette nuove si aggiungono, quelle con lo stesso id restano
      merge(current, incoming) {
        const have = new Set((current?.palettes || []).map(p => p.id));
        return { palettes: [...(current?.palettes || []), ...(incoming?.palettes || []).filter(p => !have.has(p.id))].slice(0, MAX_PALETTES) };
      },
    },
  };

  // ---- colori di un progetto ----

  function scan(p, { limit = 300 } = {}) {
    const root = p.path;
    const found = new Map(); // hex → { hex, count, files: Set, names: Set }
    let files = 0, truncated = false;
    const walk = (dir, depth) => {
      if (truncated || depth > MAX_DEPTH) return;
      let entries;
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        if (files >= MAX_FILES) { truncated = true; return; }
        if (e.name.startsWith('.') && e.name !== '.storybook') continue;
        const full = path.join(dir, e.name);
        if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) walk(full, depth + 1); continue; }
        if (!e.isFile() || !EXTENSIONS.has(path.extname(e.name).toLowerCase()) || /\.min\.(css|js)$/.test(e.name) || e.name === 'package-lock.json') continue;
        let text;
        try { if (fs.statSync(full).size > MAX_FILE_BYTES) continue; text = fs.readFileSync(full, 'utf8'); } catch { continue; }
        files++;
        const rel = path.relative(root, full).split(path.sep).join('/');
        for (const c of colorsIn(text)) {
          if (!found.has(c.hex)) found.set(c.hex, { hex: c.hex, count: 0, files: new Map(), names: new Set() });
          const f = found.get(c.hex);
          f.count++;
          if (!f.files.has(rel)) f.files.set(rel, c.line);
          if (c.name) f.names.add(c.name);
        }
      }
    };
    walk(root, 0);
    const colors = [...found.values()].sort((a, b) => b.count - a.count || a.hex.localeCompare(b.hex)).slice(0, limit).map(c => ({
      hex: c.hex, count: c.count, names: [...c.names].slice(0, 6),
      files: [...c.files.entries()].slice(0, 8).map(([file, line]) => ({ file, line })), fileCount: c.files.size,
    }));
    return { files, truncated: truncated || found.size > limit, total: found.size, colors };
  }

  return {
    config,
    projectLinks: project => {
      const n = all().filter(p => p.projectId === project.id).length;
      return n ? [{ key: 'links.palettes', params: { count: n } }] : [];
    },

    mcp: {
      palettes({ project } = {}) {
        return { palettes: all().filter(p => !project || p.projectId === project || !p.projectId) };
      },
      projectColors({ project, limit = 100 }) {
        const p = projectOr404(project);
        return { project: p.id, ...scan(p, { limit: Math.min(Math.max(parseInt(limit) || 100, 1), 300) }) };
      },
    },

    handlers: {
      listPalettes(req, res) { res.json({ palettes: all() }); },
      createPalette(req, res) {
        const list = all();
        if (list.length >= MAX_PALETTES) throw ctx.error(400, 'too_many_palettes', { max: MAX_PALETTES });
        const palette = { id: crypto.randomBytes(6).toString('hex'), ...checkPalette(req.body) };
        save([...list, palette]);
        res.json(palette);
      },
      updatePalette(req, res) {
        const list = all();
        const i = list.findIndex(p => p.id === req.params.id);
        if (i < 0) throw ctx.error(404, 'palette_not_found');
        list[i] = { id: list[i].id, ...checkPalette(req.body) };
        save(list);
        res.json(list[i]);
      },
      deletePalette(req, res) {
        const list = all();
        if (!list.some(p => p.id === req.params.id)) throw ctx.error(404, 'palette_not_found');
        save(list.filter(p => p.id !== req.params.id));
        res.json({ ok: true });
      },
      projectColors(req, res) {
        res.json(scan(projectOr404(req.params.id)));
      },
    },
  };
};

module.exports.colorsIn = colorsIn;
