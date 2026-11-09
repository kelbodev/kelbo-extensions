// Monitor: layout salvati in config.json (sezione monitorLayouts, viaggia con l'export).
// Un layout è la griglia scelta più i riquadri, ognuno legato a sorgente, progetto e script.
const crypto = require('crypto');

const GRIDS = [1, 2, 3, 4];           // 1, 2, 3 colonne; 4 = due colonne e due righe
const SOURCES = ['npm', 'script'];
const MAX_LAYOUTS = 50, MAX_PANES = 24, MAX_ARGS = 50;

module.exports = function createMonitor(ctx) {
  const { KEY_RE } = ctx.lib.validate;
  const layouts = () => ctx.config.get('monitorLayouts') || [];

  // errore di validazione: da config (400 in import/salvataggio) o da una richiesta
  function check(l, fail) {
    if (!l || typeof l !== 'object' || Array.isArray(l)) throw fail('layout_invalid');
    if (typeof l.id !== 'string' || !KEY_RE.test(l.id)) throw fail('layout_id');
    if (typeof l.name !== 'string' || !l.name.trim() || l.name.length > 80) throw fail('layout_name');
    if (!GRIDS.includes(l.grid)) throw fail('layout_grid');
    if (!Array.isArray(l.panes) || l.panes.length > MAX_PANES) throw fail('layout_panes');
    for (const p of l.panes) {
      if (!p || !SOURCES.includes(p.src) || typeof p.projectId !== 'string' || !KEY_RE.test(p.projectId)
          || typeof p.script !== 'string' || !p.script || p.script.length > 300
          || (p.args !== undefined && (!Array.isArray(p.args) || p.args.length > MAX_ARGS || !p.args.every(a => typeof a === 'string' && a.length <= 1000)))) {
        throw fail('layout_pane');
      }
    }
  }
  const clean = l => ({
    id: l.id, name: l.name.trim(), grid: l.grid,
    panes: l.panes.map(p => ({ src: p.src, projectId: p.projectId, script: p.script, ...(p.src === 'script' ? { args: p.args || [] } : {}) })),
  });

  const config = {
    monitorLayouts: {
      empty: [], idField: 'id',
      validate(value) {
        if (!Array.isArray(value) || value.length > MAX_LAYOUTS) throw ctx.error.config('layouts_invalid');
        for (const l of value) check(l, name => ctx.error.config(name, { name: String(l?.name ?? '') }));
        if (new Set(value.map(l => l.id)).size !== value.length) throw ctx.error.config('layout_duplicate');
      },
      normalize: v => (Array.isArray(v) ? v.map(l => (l && typeof l === 'object' && Array.isArray(l.panes) ? clean({ ...l, name: String(l.name ?? '') }) : l)) : v),
    },
  };

  return {
    config,
    handlers: {
      list(req, res) { res.json({ layouts: layouts() }); },
      // crea (id "new") o aggiorna un layout: { name, grid, panes }
      save(req, res) {
        const isNew = req.params.id === 'new';
        const all = layouts();
        if (!isNew && !all.some(l => l.id === req.params.id)) throw ctx.error(404, 'layout_not_found');
        if (isNew && all.length >= MAX_LAYOUTS) throw ctx.error(400, 'layouts_invalid');
        const l = { ...(req.body || {}), id: isNew ? crypto.randomUUID() : req.params.id };
        check(l, name => ctx.error(400, name, { name: String(l.name ?? '') }));
        const saved = clean(l);
        ctx.config.set('monitorLayouts', isNew ? [...all, saved] : all.map(x => (x.id === saved.id ? saved : x)));
        res.json(saved);
      },
      remove(req, res) {
        const all = layouts();
        if (!all.some(l => l.id === req.params.id)) throw ctx.error(404, 'layout_not_found');
        ctx.config.set('monitorLayouts', all.filter(l => l.id !== req.params.id));
        res.json({ ok: true });
      },
    },
  };
};
