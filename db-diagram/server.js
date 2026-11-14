// Diagramma ER: le posizioni delle tabelle di ogni diagramma (connessione + database) in
// config.json (sezione dbDiagrams, esportabile). Lo schema lo legge il frontend dal db-client.
const MAX_DIAGRAMS = 300;
const MAX_TABLES = 3000;
const DB_RE = /^[^\u0000-\u001f]{1,128}$/;

module.exports = function createDbDiagram(ctx) {
  const { KEY_RE } = ctx.lib.validate;
  const keyOf = (connection, database) => {
    if (typeof connection !== 'string' || !KEY_RE.test(connection)) throw ctx.error(400, 'connection_invalid');
    if (typeof database !== 'string' || !DB_RE.test(database)) throw ctx.error(400, 'database_invalid');
    return `${connection}/${database}`;
  };
  const validPositions = p => p && typeof p === 'object' && !Array.isArray(p) && Object.keys(p).length <= MAX_TABLES
    && Object.entries(p).every(([k, v]) => typeof k === 'string' && k.length <= 256 && v && Number.isFinite(v.x) && Number.isFinite(v.y) && Math.abs(v.x) < 1e6 && Math.abs(v.y) < 1e6);
  const all = () => ctx.config.get('dbDiagrams') || {};

  return {
    config: {
      dbDiagrams: {
        empty: {},
        validate(v) {
          if (!v || typeof v !== 'object' || Array.isArray(v) || Object.keys(v).length > MAX_DIAGRAMS) throw ctx.error.config('layouts_invalid');
          for (const [k, d] of Object.entries(v)) {
            if (k.length > 300 || !d || typeof d !== 'object' || !validPositions(d.positions)) throw ctx.error.config('layouts_invalid');
          }
        },
        // import in unione: i diagrammi di qui restano, quelli nuovi si aggiungono
        merge: (cur, inc) => ({ ...(inc || {}), ...(cur || {}) }),
      },
    },
    handlers: {
      layout(req, res) {
        const key = keyOf(req.query.connection, req.query.database);
        res.json({ positions: all()[key]?.positions || {} });
      },
      saveLayout(req, res) {
        const { connection, database, positions } = req.body || {};
        const key = keyOf(connection, database);
        if (!validPositions(positions)) throw ctx.error(400, 'layouts_invalid');
        const rounded = Object.fromEntries(Object.entries(positions).map(([k, v]) => [k, { x: Math.round(v.x), y: Math.round(v.y) }]));
        const next = { ...all(), [key]: { positions: rounded, updatedAt: new Date().toISOString() } };
        // i diagrammi meno recenti escono oltre il limite
        const keys = Object.keys(next).sort((a, b) => String(next[b].updatedAt).localeCompare(String(next[a].updatedAt)));
        for (const k of keys.slice(MAX_DIAGRAMS)) delete next[k];
        ctx.config.set('dbDiagrams', next);
        res.json({ ok: true });
      },
      resetLayout(req, res) {
        const key = keyOf(req.body?.connection, req.body?.database);
        const next = { ...all() };
        delete next[key];
        ctx.config.set('dbDiagrams', next);
        res.json({ ok: true });
      },
    },
  };
};
