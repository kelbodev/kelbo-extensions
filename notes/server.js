// Note e to-do: per ogni progetto (più lo spazio "Generale") liste di frasi da spuntare e note
// tipo post-it. Il contenuto di ogni bacheca è cifrato con la master password (vault del core)
// e salvato come un'unica scatola in notesBoards: senza vault sbloccato non si legge né si scrive.
const crypto = require('crypto');

const GENERAL = '@general';           // bacheca non legata a un progetto
const COLORS = ['yellow', 'green', 'blue', 'pink', 'purple', 'gray'];
const LIMITS = { lists: 50, items: 500, notes: 200, title: 200, item: 1000, note: 10000 };
// Posizione libera sulla bacheca (px): x, y, larghezza w, altezza h (solo note; le liste crescono
// con le voci) e z, l'ordine di sovrapposizione (l'ultima spostata sta sopra)
const CARD = { maxXY: 20000, minW: 180, maxW: 1600, minH: 80, maxH: 1600, list: { w: 280 }, note: { w: 240, h: 180 } };

module.exports = function createNotes(ctx) {
  const { KEY_RE } = ctx.lib.validate;
  const vault = ctx.vault;

  const boards = () => ctx.config.get('notesBoards');
  const newId = () => crypto.randomBytes(6).toString('hex');
  const isBoardId = id => id === GENERAL || KEY_RE.test(id || '');

  // ---- validazione della sezione salvata ----

  const config = {
    notesBoards: {
      empty: [], idField: 'board',
      normalize: v => (Array.isArray(v) ? v.map(b => ({ board: b?.board, box: b?.box })) : v),
      validate(list, cfg) {
        if (!Array.isArray(list)) throw ctx.error.config('not_a_list');
        const seen = new Set();
        for (const b of list) {
          if (!b || typeof b !== 'object' || typeof b.board !== 'string' || !isBoardId(b.board)) throw ctx.error.config('board_id', { id: String(b?.board ?? '') });
          if (!vault.isBox(b.box)) throw ctx.error.config('board_box', { id: b.board });
          if (seen.has(b.board)) throw ctx.error.config('duplicate_board', { id: b.board });
          seen.add(b.board);
        }
        if (list.length && !cfg.vault) throw ctx.error.config('boards_without_vault');
      },
    },
  };

  // Contenuto ri-cifrato al cambio della master password; perso con il reset (non c'è altro modo di leggerlo)
  vault.register({
    rekey(reencrypt, cfg) {
      const list = cfg.notesBoards || [];
      return { sections: { notesBoards: list.map(b => ({ ...b, box: reencrypt(b.box) })) }, count: list.length };
    },
    reset: () => ({ notesBoards: [] }),
  });

  // ---- contenuto di una bacheca ----

  const empty = () => ({ lists: [], notes: [] });

  // Contenuto letto dalla scatola, ripulito da campi sconosciuti
  function read(boardId) {
    const stored = boards().find(b => b.board === boardId);
    if (!stored) return empty();
    let data;
    try { data = JSON.parse(vault.decrypt(stored.box)); } catch (e) { if (e.code) throw e; throw ctx.error(500, 'board_unreadable'); }
    return layout({
      lists: (Array.isArray(data?.lists) ? data.lists : []).map(l => ({
        id: String(l.id), title: String(l.title || ''),
        items: (Array.isArray(l.items) ? l.items : []).map(i => ({ id: String(i.id), text: String(i.text || ''), done: !!i.done, ...(i.doneAt ? { doneAt: String(i.doneAt) } : {}) })),
        ...place(l),
      })),
      notes: (Array.isArray(data?.notes) ? data.notes : []).map(n => ({
        id: String(n.id), title: String(n.title || ''), text: String(n.text || ''), color: COLORS.includes(n.color) ? n.color : COLORS[0], updatedAt: String(n.updatedAt || ''),
        ...place(n, true),
      })),
    });
  }

  const isXY = v => Number.isInteger(v) && v >= 0 && v <= CARD.maxXY;
  const isW = v => Number.isInteger(v) && v >= CARD.minW && v <= CARD.maxW;
  const isH = v => Number.isInteger(v) && v >= CARD.minH && v <= CARD.maxH;
  // Posizione salvata, se valida; le note della 1.1 avevano w in colonne (1–3) e h del solo testo
  function place(c, note = false) {
    const out = {};
    if (isXY(c.x) && isXY(c.y)) Object.assign(out, { x: c.x, y: c.y });
    if (Number.isInteger(c.z) && c.z >= 0) out.z = c.z;
    const legacy = out.x === undefined;
    out.w = isW(c.w) ? c.w : legacy && [1, 2, 3].includes(c.w) ? c.w * 250 : CARD[note ? 'note' : 'list'].w;
    if (note) out.h = !isH(c.h) ? CARD.note.h : legacy ? Math.min(CARD.maxH, c.h + 50) : c.h; // + barra e piede della nota
    return out;
  }
  // Schede senza posizione (bacheche della 1.x): in righe da quattro, prima le liste poi le note
  function layout(data) {
    let i = 0;
    for (const c of [...data.lists, ...data.notes]) {
      if (c.x === undefined) { Object.assign(c, { x: 20 + (i % 4) * 300, y: 20 + Math.floor(i / 4) * 320 }); i++; }
      if (c.z === undefined) c.z = 0;
    }
    return data;
  }
  const topZ = data => Math.max(0, ...[...data.lists, ...data.notes].map(c => c.z)) + 1;
  // Posizione di una scheda nuova: quella chiesta (la parte visibile della bacheca) o sotto le altre
  function newPlace(data, body) {
    if (body.x !== undefined || body.y !== undefined) {
      if (!isXY(body.x) || !isXY(body.y)) throw ctx.error(400, 'size_invalid');
      return { x: body.x, y: body.y, z: topZ(data) };
    }
    const bottom = Math.max(0, ...[...data.lists, ...data.notes].map(c => c.y + (c.h || 300)));
    return { x: 20, y: Math.min(CARD.maxXY, bottom + 20), z: topZ(data) };
  }

  // Bacheca vuota → tolta dalla configurazione
  function write(boardId, data) {
    const rest = boards().filter(b => b.board !== boardId);
    const isEmpty = !data.lists.length && !data.notes.length;
    ctx.config.set('notesBoards', isEmpty ? rest : [...rest, { board: boardId, box: vault.encrypt(JSON.stringify(data)) }]);
  }

  const counts = data => {
    const items = data.lists.flatMap(l => l.items);
    return { open: items.filter(i => !i.done).length, items: items.length, lists: data.lists.length, notes: data.notes.length };
  };

  // ---- richieste ----

  const boardParam = req => {
    const id = req.params.board;
    if (!isBoardId(id)) throw ctx.error(400, 'board_id', { id: String(id) });
    if (id !== GENERAL && !boards().some(b => b.board === id) && !ctx.projects.get(id)) throw ctx.error(404, 'project_not_found', { id });
    return id;
  };
  const text = (value, max, name) => {
    const v = typeof value === 'string' ? value.trim() : '';
    if (!v) throw ctx.error(400, `${name}_required`);
    if (v.length > max) throw ctx.error(400, `${name}_too_long`, { max });
    return v;
  };
  // titolo della nota: facoltativo (vuoto = nessun titolo)
  const noteTitle = value => {
    if (typeof value !== 'string') throw ctx.error(400, 'title_invalid');
    if (value.trim().length > LIMITS.title) throw ctx.error(400, 'title_too_long', { max: LIMITS.title });
    return value.trim();
  };
  const noteText = value => {
    if (typeof value !== 'string') throw ctx.error(400, 'note_required');
    if (value.length > LIMITS.note) throw ctx.error(400, 'note_too_long', { max: LIMITS.note });
    return value;
  };
  const listOr404 = (data, id) => data.lists.find(l => l.id === id) || (() => { throw ctx.error(404, 'list_not_found'); })();
  const itemOr404 = (list, id) => list.items.find(i => i.id === id) || (() => { throw ctx.error(404, 'item_not_found'); })();
  const noteOr404 = (data, id) => data.notes.find(n => n.id === id) || (() => { throw ctx.error(404, 'note_not_found'); })();
  // Nuovo ordine: gli stessi id, permutati
  const reorder = (arr, ids) => {
    if (!Array.isArray(ids) || ids.length !== arr.length || new Set(ids).size !== ids.length || !ids.every(id => arr.some(x => x.id === id))) throw ctx.error(400, 'order_invalid');
    return ids.map(id => arr.find(x => x.id === id));
  };

  // Legge, applica la modifica, salva e risponde con la bacheca
  const change = fn => (req, res) => {
    const id = boardParam(req);
    const data = read(id);
    fn(data, req.body || {}, req.params);
    write(id, data);
    res.json({ board: id, ...data, counts: counts(data) });
  };

  // Tutta la sezione richiede il vault sbloccato (423 del core: da sbloccare o da creare)
  const requireVault = () => { if (vault.state() !== 'unlocked') vault.encrypt(''); };
  const guarded = handlers => Object.fromEntries(Object.entries(handlers).map(([name, fn]) => [name, (req, res) => { requireVault(); return fn(req, res); }]));

  return {
    config,

    // Dati collegati a un progetto (pannello 📁 Progetti di Kelbo ≥ 2.18, prima di rimuoverlo):
    // la bacheca è cifrata, se ne segnala solo la presenza
    projectLinks: project => (boards().some(b => b.board === project.id) ? [{ key: 'links.board' }] : []),

    handlers: guarded({
      // Contatori di ogni bacheca salvata (anche di progetti tolti da Kelbo)
      listBoards(req, res) {
        res.json({ boards: boards().map(b => ({ board: b.board, counts: counts(read(b.board)) })) });
      },

      getBoard(req, res) {
        const id = boardParam(req);
        const data = read(id);
        res.json({ board: id, ...data, counts: counts(data) });
      },

      addList: change((data, body) => {
        if (data.lists.length >= LIMITS.lists) throw ctx.error(400, 'too_many_lists', { max: LIMITS.lists });
        data.lists.push({ id: newId(), title: text(body.title, LIMITS.title, 'title'), items: [], w: CARD.list.w, ...newPlace(data, body) });
      }),
      updateList: change((data, body, p) => { listOr404(data, p.list).title = text(body.title, LIMITS.title, 'title'); }),
      deleteList: change((data, body, p) => { listOr404(data, p.list); data.lists = data.lists.filter(l => l.id !== p.list); }),

      addItem: change((data, body, p) => {
        const list = listOr404(data, p.list);
        if (list.items.length >= LIMITS.items) throw ctx.error(400, 'too_many_items', { max: LIMITS.items });
        list.items.push({ id: newId(), text: text(body.text, LIMITS.item, 'item'), done: false });
      }),
      updateItem: change((data, body, p) => {
        const item = itemOr404(listOr404(data, p.list), p.item);
        if (body.text !== undefined) item.text = text(body.text, LIMITS.item, 'item');
        if (body.done !== undefined) {
          if (typeof body.done !== 'boolean') throw ctx.error(400, 'done_invalid');
          if (body.done && !item.done) item.doneAt = new Date().toISOString();
          if (!body.done) delete item.doneAt;
          item.done = body.done;
        }
      }),
      deleteItem: change((data, body, p) => {
        const list = listOr404(data, p.list);
        itemOr404(list, p.item);
        list.items = list.items.filter(i => i.id !== p.item);
      }),
      orderItems: change((data, body, p) => { const list = listOr404(data, p.list); list.items = reorder(list.items, body.ids); }),
      clearDone: change((data, body, p) => { const list = listOr404(data, p.list); list.items = list.items.filter(i => !i.done); }),

      addNote: change((data, body) => {
        if (data.notes.length >= LIMITS.notes) throw ctx.error(400, 'too_many_notes', { max: LIMITS.notes });
        const color = body.color === undefined ? COLORS[0] : body.color;
        if (!COLORS.includes(color)) throw ctx.error(400, 'color_invalid');
        data.notes.push({ id: newId(), title: noteTitle(body.title ?? ''), text: noteText(body.text ?? ''), color, updatedAt: new Date().toISOString(), w: CARD.note.w, h: CARD.note.h, ...newPlace(data, body) });
      }),
      updateNote: change((data, body, p) => {
        const note = noteOr404(data, p.note);
        // modificata altrove nel frattempo: non si sovrascrive
        if (body.updatedAt !== undefined && body.updatedAt !== note.updatedAt) throw ctx.error(409, 'note_changed');
        if (body.title !== undefined) note.title = noteTitle(body.title);
        if (body.text !== undefined) note.text = noteText(body.text);
        if (body.color !== undefined) {
          if (!COLORS.includes(body.color)) throw ctx.error(400, 'color_invalid');
          note.color = body.color;
        }
        note.updatedAt = new Date().toISOString();
      }),
      deleteNote: change((data, body, p) => { noteOr404(data, p.note); data.notes = data.notes.filter(n => n.id !== p.note); }),

      // Scheda spostata o ridimensionata: { x, y, w, h (solo note) }, tutti facoltativi; va sopra le altre
      moveCard: change((data, body, p) => {
        const card = p.kind === 'list' ? listOr404(data, p.id) : p.kind === 'note' ? noteOr404(data, p.id) : null;
        if (!card) throw ctx.error(404, 'card_not_found');
        const check = (key, ok) => { if (body[key] !== undefined && !ok(body[key])) throw ctx.error(400, 'size_invalid'); };
        check('x', isXY); check('y', isXY); check('w', isW);
        if (p.kind === 'note') check('h', isH); else if (body.h !== undefined) throw ctx.error(400, 'size_invalid');
        for (const k of ['x', 'y', 'w', 'h']) if (body[k] !== undefined) card[k] = body[k];
        // ordine di sovrapposizione rinumerato 0…n-1, la scheda spostata in cima
        const others = [...data.lists, ...data.notes].filter(c => c !== card).sort((a, b) => a.z - b.z);
        others.forEach((c, i) => { c.z = i; });
        card.z = others.length;
      }),
    }),
  };
};

module.exports.GENERAL = GENERAL;
module.exports.COLORS = COLORS;
