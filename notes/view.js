// Note e to-do: nella sidebar lo spazio "Generale" e i progetti (con le voci aperte), nel
// pannello la bacheca scelta, una tela dove liste da spuntare e note tipo post-it stanno dove
// l'utente le trascina, con la loro dimensione. Tutto passa dal vault della master password:
// bloccato, la sezione mostra solo "Sblocca".

const EXT = 'Ext.notes';
const GENERAL = '@general';
const COLORS = ['yellow', 'green', 'blue', 'pink', 'purple', 'gray'];
const ACTIVE_KEY = 'kelbo.notes.board';
const SAVE_DELAY = 700; // ms dopo l'ultimo tasto prima di salvare una nota
const GRID = 10;        // passo (px) di posizioni e dimensioni trascinate
const SIZES = { list: { w: 280 }, note: { w: 240, h: 180 }, minW: 180, maxW: 1600, minH: 80, maxH: 1600 };

export default {
  async mount(ctx) {
    const { esc, js, toast, fmt } = ctx.ui;
    const { t } = ctx;
    const $ = (root, role) => root.querySelector(`[data-role="${role}"]`);

    let locked = false;
    let info = new Map();     // bacheca → { open, items, lists, notes }
    let projects = [], folders = [];
    let active = (() => { try { return localStorage.getItem(ACTIVE_KEY) || GENERAL; } catch { return GENERAL; } })();
    let board = null;         // { board, lists, notes, counts }
    const pending = new Map(); // nota → timer del salvataggio
    let dragging = null;       // { list, item } durante il trascinamento

    const url = (...parts) => `/boards/${parts.map(encodeURIComponent).join('/')}`;
    const boardLabel = id => (id === GENERAL ? t('sidebar.general') : projects.find(p => p.id === id)?.label || id);

    // Esegue fn; con il vault bloccato (o da creare) lo chiede e riprova
    async function withVault(fn) {
      try { return await fn(); } catch (e) {
        if (!ctx.vault.isVaultError(e)) throw e;
        if (await ctx.vault.ensure()) return fn();
        throw Object.assign(new Error(t('locked.still')), { handled: true });
      }
    }
    const fail = e => { if (!e?.handled) toast(e.message, 'error'); };

    // ---- caricamento ----

    async function load() {
      try { ({ projects, folders } = await ctx.projects.load()); } catch { projects = []; folders = []; }
      try {
        const r = await ctx.api.get('/boards');
        info = new Map(r.boards.map(b => [b.board, b.counts]));
        locked = false;
      } catch (e) {
        if (!ctx.vault.isVaultError(e)) toast(e.message, 'error');
        locked = ctx.vault.isVaultError(e);
        info = new Map();
      }
      if (active !== GENERAL && !projects.some(p => p.id === active) && !info.has(active)) active = GENERAL;
      updateBadge();
      renderSidebar();
      if (locked) { board = null; renderBoard(); return; }
      await loadBoard();
    }

    async function loadBoard() {
      try { board = await ctx.api.get(url(active)); } catch (e) { board = null; if (ctx.vault.isVaultError(e)) locked = true; else fail(e); }
      renderBoard();
    }

    function updateBadge() {
      const open = [...info.values()].reduce((n, c) => n + c.open, 0);
      ctx.setBadge(open ? fmt.number(open) : null);
    }

    // Risposta di una modifica: bacheca e contatori aggiornati
    function applied(r) {
      board = r;
      if (r.counts.lists || r.counts.notes) info.set(r.board, r.counts); else info.delete(r.board);
      updateBadge();
      renderSidebar();
      renderSummary();
    }

    // Modifica della bacheca: fn(api) → bacheca aggiornata (null se non riuscita)
    async function call(fn) {
      try { const r = await withVault(() => fn(ctx.api)); applied(r); return r; } catch (e) { fail(e); return null; }
    }

    // ---- sidebar ----

    function renderSidebar() {
      const el = $(ctx.sidebar, 'boards');
      if (locked) {
        ctx.ui.patch(el, `<p class="nt-muted" style="padding:12px">${esc(t('locked.text'))}<br><br>
          <button class="btn btn-primary btn-sm" onclick="${EXT}.unlock()">${esc(t('locked.unlock'))}</button></p>`);
        return;
      }
      const item = (id, icon, label) => {
        const open = info.get(id)?.open || 0;
        return `<button class="sb-item ${id === active ? 'active' : ''}" onclick="${EXT}.select(${js(id)})">
          <span class="sb-icon">${icon}</span><span>${esc(label)}</span>
          ${open ? `<span class="sb-count nt-open" title="${esc(t('sidebar.openTitle', { count: open }))}">${esc(fmt.number(open))}</span>` : ''}</button>`;
      };
      const orphans = [...info.keys()].filter(id => id !== GENERAL && !projects.some(p => p.id === id));
      ctx.ui.patch(el, item(GENERAL, '📌', t('sidebar.general'))
        + ctx.projects.tree(folders, projects, p => item(p.id, info.has(p.id) ? '📝' : '·', p.label))
        + (orphans.length ? `<div class="nt-sb-sep">${esc(t('sidebar.orphans'))}</div>${orphans.map(id => item(id, '⚠', id)).join('')}` : ''));
    }

    // ---- bacheca ----

    function renderSummary() {
      if (!board) return;
      const c = board.counts;
      const parts = [
        ...(c.items ? [t('board.items', { open: fmt.number(c.open), items: fmt.number(c.items) })] : []),
        ...(c.notes ? [t('board.notes', { count: c.notes })] : []),
      ];
      $(ctx.root, 'summary').textContent = parts.join(' · ');
    }

    function renderBoard() {
      $(ctx.root, 'locked').hidden = !locked;
      $(ctx.root, 'board').hidden = locked || !board;
      if (locked || !board) return;
      $(ctx.root, 'title').textContent = boardLabel(board.board);
      renderSummary();
      renderCards();
    }

    // Tutte le schede sulla tela, nell'ordine di sovrapposizione
    function renderCards() {
      flushNotes();
      const el = $(ctx.root, 'canvas');
      const focus = document.activeElement?.dataset?.add; // il campo "aggiungi" resta attivo dopo l'invio
      const cards = [...board.lists.map(l => ({ kind: 'list', c: l })), ...board.notes.map(n => ({ kind: 'note', c: n }))].sort((a, b) => a.c.z - b.c.z);
      cards.forEach((x, i) => { layer.set(x.c, i + 1); });
      el.innerHTML = cards.length ? cards.map(({ kind, c }) => (kind === 'list' ? listHtml(c) : noteHtml(c))).join('')
        : `<p class="nt-empty">${esc(t('board.empty'))}</p>`;
      if (focus) el.querySelector(`[data-add="${CSS.escape(focus)}"]`)?.focus();
      sizeCanvas();
    }
    const renderLists = renderCards, renderNotes = renderCards;

    // z-index: posizione nell'ordine di sovrapposizione (1…n), sotto l'intestazione della bacheca
    const layer = new WeakMap();
    const cardStyle = (c, h) => `left:${Number(c.x)}px;top:${Number(c.y)}px;width:${Number(c.w)}px;${h ? `height:${Number(c.h)}px;` : ''}z-index:${layer.get(c) || 1}`;
    const cardTools = kind => `<span class="nt-resize" data-resize title="${esc(t(kind === 'list' ? 'lists.resize' : 'notes.resize'))}"></span>`;

    function listHtml(l) {
      const open = l.items.filter(i => !i.done), done = l.items.filter(i => i.done);
      const itemHtml = i => `<li class="nt-item ${i.done ? 'done' : ''}" data-list="${esc(l.id)}" data-item="${esc(i.id)}">
          ${i.done ? '' : `<span class="nt-handle" title="${esc(t('items.drag'))}">⋮⋮</span>`}
          <input type="checkbox" ${i.done ? 'checked' : ''} aria-label="${esc(t(i.done ? 'items.reopen' : 'items.check'))}" data-check>
          <input class="nt-item-text" value="${esc(i.text)}" maxlength="1000" data-text aria-label="${esc(t('items.text'))}">
          ${i.done && i.doneAt ? `<span class="nt-item-date" title="${esc(fmt.date(i.doneAt, { dateStyle: 'medium', timeStyle: 'short' }))}">${esc(fmt.relative(i.doneAt))}</span>` : ''}
          <button class="nt-del" data-del-item title="${esc(t('core.action.delete'))}">✕</button></li>`;
      return `<section class="nt-card nt-list" data-card="list" data-id="${esc(l.id)}" data-list="${esc(l.id)}" style="${cardStyle(l, false)}">
        <div class="nt-list-head">
          <span class="nt-grip" data-drag title="${esc(t('board.drag'))}">⠿</span>
          <input class="nt-list-title" value="${esc(l.title)}" maxlength="200" data-list-title aria-label="${esc(t('lists.name'))}">
          ${l.items.length ? `<span class="nt-pct" title="${esc(t('lists.progress', { done: fmt.number(done.length), total: fmt.number(l.items.length) }))}">${esc(fmt.number(done.length / l.items.length, { style: 'percent' }))}</span>` : ''}
          <button class="sb-item-act" onclick="${EXT}.listMenu(event, ${js(l.id)})" title="${esc(t('lists.actions'))}">⋯</button>
        </div>
        ${l.items.length ? `<div class="nt-progress" role="progressbar" aria-valuemin="0" aria-valuemax="${l.items.length}" aria-valuenow="${done.length}"><span style="width:${(done.length / l.items.length) * 100}%"></span></div>` : ''}
        <ul class="nt-items">${open.map(itemHtml).join('')}</ul>
        ${done.length ? `<div class="nt-done-head"><span>${esc(t('items.doneCount', { count: done.length }))}</span>
          <button onclick="${EXT}.clearDone(${js(l.id)})">${esc(t('items.clearDone'))}</button></div>
          <ul class="nt-items">${done.map(itemHtml).join('')}</ul>` : ''}
        <input class="form-input nt-add" data-add="${esc(l.id)}" maxlength="1000" placeholder="${esc(t('items.add'))}" aria-label="${esc(t('items.add'))}">
        ${cardTools('list')}
      </section>`;
    }

    function noteHtml(n) {
      return `<div class="nt-card nt-note nt-c-${esc(n.color)}" data-card="note" data-id="${esc(n.id)}" data-note="${esc(n.id)}" style="${cardStyle(n, true)}">
          <div class="nt-note-bar" data-drag title="${esc(t('board.drag'))}"></div>
          <input class="nt-note-title" value="${esc(n.title || '')}" maxlength="200" placeholder="${esc(t('notes.titlePlaceholder'))}" aria-label="${esc(t('notes.title'))}" data-note-title>
          <textarea maxlength="10000" placeholder="${esc(t('notes.placeholder'))}" aria-label="${esc(t('notes.text'))}" data-note-text>${esc(n.text)}</textarea>
          <footer>
            ${COLORS.map(c => `<button class="nt-dot nt-c-${c} ${c === n.color ? 'active' : ''}" data-color="${c}" title="${esc(t(`colors.${c}`))}" aria-label="${esc(t(`colors.${c}`))}"></button>`).join('')}
            <span class="nt-saved" data-saved>${n.updatedAt ? esc(fmt.relative(n.updatedAt)) : ''}</span>
            <button class="nt-del" data-del-note title="${esc(t('core.action.delete'))}">✕</button>
          </footer>
          ${cardTools('note')}</div>`;
    }

    // La tela è grande quanto serve per contenere tutte le schede, più un margine per allargarsi
    function sizeCanvas() {
      const el = $(ctx.root, 'canvas');
      let w = 0, h = 0;
      for (const c of el.querySelectorAll('[data-card]')) {
        w = Math.max(w, c.offsetLeft + c.offsetWidth);
        h = Math.max(h, c.offsetTop + c.offsetHeight);
      }
      el.style.width = `${w + 200}px`;
      el.style.height = `${h + 200}px`;
    }

    // ---- schede: trascinamento (dalla barra) e ridimensionamento (dall'angolo) ----

    const snap = v => Math.round(v / GRID) * GRID;
    const clamp = (v, min, max) => Math.max(min, Math.min(max, v));
    const cardData = el => (el.dataset.card === 'list' ? board.lists : board.notes).find(c => c.id === el.dataset.id);

    async function saveCard(el, changes) {
      const id = el.dataset.id, kind = el.dataset.card;
      // il testo in attesa si salva prima (e la nota non si ridisegna: si sta scrivendo)
      const writing = kind === 'note' && pending.has(id);
      if (writing) await saveNote(id);
      const r = await call(api => api.put(url(active, 'cards', kind, id), changes));
      if (r && !writing) renderCards();
    }

    // Trascina con il puntatore: onMove(dx, dy) durante, onEnd() alla fine
    function track(e, handle, onMove, onEnd) {
      e.preventDefault();
      const start = { x: e.clientX, y: e.clientY };
      handle.setPointerCapture(e.pointerId);
      const move = ev => { onMove(ev.clientX - start.x, ev.clientY - start.y); sizeCanvas(); };
      const up = () => {
        handle.removeEventListener('pointermove', move);
        handle.removeEventListener('pointerup', up);
        onEnd();
      };
      handle.addEventListener('pointermove', move);
      handle.addEventListener('pointerup', up);
    }

    ctx.root.addEventListener('pointerdown', e => {
      if (e.button !== 0) return;
      const drag = e.target.closest('[data-drag]'), resize = e.target.closest('[data-resize]');
      const el = (drag || resize)?.closest('[data-card]');
      if (!el) return;
      const c = cardData(el);
      el.style.zIndex = String(board.lists.length + board.notes.length + 1); // sopra le altre subito
      el.classList.add(drag ? 'moving' : 'resizing');
      let next = {};
      if (drag) {
        track(e, drag, (dx, dy) => {
          next = { x: clamp(snap(c.x + dx), 0, 20000), y: clamp(snap(c.y + dy), 0, 20000) };
          el.style.left = `${next.x}px`; el.style.top = `${next.y}px`;
        }, () => {
          el.classList.remove('moving');
          if (next.x !== undefined && (next.x !== c.x || next.y !== c.y)) saveCard(el, next);
        });
      } else {
        const note = el.dataset.card === 'note';
        track(e, resize, (dx, dy) => {
          next = { w: clamp(snap(c.w + dx), SIZES.minW, SIZES.maxW), ...(note ? { h: clamp(snap(c.h + dy), SIZES.minH, SIZES.maxH) } : {}) };
          el.style.width = `${next.w}px`;
          if (note) el.style.height = `${next.h}px`;
        }, () => {
          el.classList.remove('resizing');
          if (next.w !== undefined && (next.w !== c.w || (note && next.h !== c.h))) saveCard(el, next);
        });
      }
    });
    // doppio clic sull'angolo: dimensione iniziale
    ctx.root.addEventListener('dblclick', e => {
      const el = e.target.closest('[data-resize]')?.closest('[data-card]');
      if (el) saveCard(el, el.dataset.card === 'note' ? { ...SIZES.note } : { ...SIZES.list });
    });

    // ---- note: salvataggio automatico ----

    function scheduleNote(id) {
      clearTimeout(pending.get(id));
      const el = ctx.root.querySelector(`[data-note="${CSS.escape(id)}"] [data-saved]`);
      if (el) el.textContent = t('notes.saving');
      pending.set(id, setTimeout(() => saveNote(id), SAVE_DELAY));
    }

    async function saveNote(id) {
      clearTimeout(pending.get(id));
      pending.delete(id);
      const note = board?.notes.find(n => n.id === id);
      const ta = ctx.root.querySelector(`[data-note="${CSS.escape(id)}"] textarea`);
      if (!note || !ta) return;
      const boardId = board.board;
      try {
        const title = ctx.root.querySelector(`[data-note="${CSS.escape(id)}"] [data-note-title]`)?.value ?? note.title;
        const r = await withVault(() => ctx.api.put(url(boardId, 'notes', id), { title, text: ta.value, updatedAt: note.updatedAt }));
        if (board?.board !== boardId) return;
        // le note restano come sono (si sta scrivendo): si aggiornano dati, contatori e "salvata"
        board.notes = r.notes; board.counts = r.counts;
        info.set(r.board, r.counts);
        renderSummary();
        const saved = ctx.root.querySelector(`[data-note="${CSS.escape(id)}"] [data-saved]`);
        if (saved) saved.textContent = t('notes.saved');
      } catch (e) {
        if (e.status === 409) { toast(t('notes.changedElsewhere'), 'error'); await loadBoard(); return; }
        fail(e);
      }
    }

    // Salvataggi in attesa eseguiti subito (prima di ridisegnare le note o cambiare bacheca)
    function flushNotes() { for (const id of [...pending.keys()]) saveNote(id); }

    // Posto per una scheda nuova (w × h): il primo spazio libero nella parte visibile della
    // bacheca, da sinistra a destra e dall'alto in basso; se non c'è, in alto a sinistra
    function freeSpot(w, h) {
      const scroller = $(ctx.root, 'board'), canvas = $(ctx.root, 'canvas');
      const left = snap(scroller.scrollLeft + 20), top = snap(Math.max(0, scroller.scrollTop - canvas.offsetTop) + 20);
      const right = left + Math.max(w, scroller.clientWidth - 40), bottom = top + Math.max(h, scroller.clientHeight - canvas.offsetTop - 40);
      const taken = [...canvas.querySelectorAll('[data-card]')].map(c => ({ x: c.offsetLeft, y: c.offsetTop, w: c.offsetWidth, h: c.offsetHeight }));
      const free = (x, y) => taken.every(c => x + w + 10 <= c.x || c.x + c.w + 10 <= x || y + h + 10 <= c.y || c.y + c.h + 10 <= y);
      for (let y = top; y + h <= bottom; y += 20) for (let x = left; x + w <= right; x += 20) if (free(x, y)) return { x, y };
      return { x: left, y: top };
    }

    // ---- azioni ----

    const actions = {
      async select(id) {
        if (id === active && board) return;
        flushNotes();
        active = id;
        try { localStorage.setItem(ACTIVE_KEY, id); } catch { /* solo in questa sessione */ }
        renderSidebar();
        await loadBoard();
      },
      async unlock() { if (await ctx.vault.ensure()) load(); },
      async addList() {
        const r = await call(api => api.post(url(active, 'lists'), { title: t('lists.newTitle'), ...freeSpot(SIZES.list.w, 160) }));
        if (!r) return;
        renderLists();
        const input = ctx.root.querySelector(`[data-list="${CSS.escape(r.lists.at(-1).id)}"] [data-list-title]`);
        input?.focus(); input?.select();
      },
      async addNote() {
        flushNotes();
        const r = await call(api => api.post(url(active, 'notes'), { text: '', ...freeSpot(SIZES.note.w, SIZES.note.h) }));
        if (!r) return;
        renderNotes();
        ctx.root.querySelector(`[data-note="${CSS.escape(r.notes.at(-1).id)}"] textarea`)?.focus();
      },
      listMenu(event, listId) {
        const l = board.lists.find(x => x.id === listId);
        event.stopPropagation();
        const r = event.currentTarget.getBoundingClientRect();
        ctx.ui.contextMenu(r.left, r.bottom, [
          { label: t('items.clearDone'), icon: '✓', disabled: !l.items.some(x => x.done), action: () => actions.clearDone(listId) },
          'separator',
          { label: t('lists.delete'), icon: '🗑', danger: true, action: () => {
            if (l.items.length && !confirm(t('lists.confirmDelete', { name: l.title, count: l.items.length }))) return;
            call(api => api.del(url(active, 'lists', listId))).then(res => res && renderLists());
          } },
        ]);
      },
      async clearDone(listId) {
        if (await call(api => api.post(url(active, 'lists', listId, 'clear-done')))) renderLists();
      },
    };
    ctx.expose(actions);

    // ---- eventi ----

    ctx.sidebar.addEventListener('click', e => { if (e.target.closest('[data-action="reload"]')) load(); });

    ctx.root.addEventListener('click', e => {
      const a = e.target.closest('[data-action]')?.dataset.action;
      if (a === 'unlock') return actions.unlock();
      if (a === 'add-list') return actions.addList();
      if (a === 'add-note') return actions.addNote();
      const li = e.target.closest('[data-item]');
      if (li && e.target.closest('[data-del-item]')) {
        call(api => api.del(url(active, 'lists', li.dataset.list, 'items', li.dataset.item))).then(r => r && renderLists());
        return;
      }
      const note = e.target.closest('[data-note]');
      if (!note) return;
      const color = e.target.closest('[data-color]')?.dataset.color;
      if (color) {
        clearTimeout(pending.get(note.dataset.note)); pending.delete(note.dataset.note);
        const text = note.querySelector('textarea').value, title = note.querySelector('[data-note-title]').value;
        const n = board.notes.find(x => x.id === note.dataset.note);
        call(api => api.put(url(active, 'notes', n.id), { color, title, text, updatedAt: n.updatedAt })).then(r => r && renderNotes());
      } else if (e.target.closest('[data-del-note]')) {
        const text = note.querySelector('textarea').value + note.querySelector('[data-note-title]').value;
        if (text.trim() && !confirm(t('notes.confirmDelete'))) return;
        clearTimeout(pending.get(note.dataset.note)); pending.delete(note.dataset.note);
        call(api => api.del(url(active, 'notes', note.dataset.note))).then(r => r && renderNotes());
      }
    });

    ctx.root.addEventListener('change', e => {
      const el = e.target;
      const li = el.closest('[data-item]');
      if (li && el.matches('[data-check]')) {
        call(api => api.put(url(active, 'lists', li.dataset.list, 'items', li.dataset.item), { done: el.checked })).then(r => r && renderLists());
      } else if (li && el.matches('[data-text]')) {
        if (!el.value.trim()) { el.value = board.lists.find(l => l.id === li.dataset.list)?.items.find(i => i.id === li.dataset.item)?.text || ''; return; }
        call(api => api.put(url(active, 'lists', li.dataset.list, 'items', li.dataset.item), { text: el.value }));
      } else if (el.matches('[data-list-title]')) {
        const listId = el.closest('[data-list]').dataset.list;
        if (!el.value.trim()) { el.value = board.lists.find(l => l.id === listId)?.title || ''; return; }
        call(api => api.put(url(active, 'lists', listId), { title: el.value }));
      }
    });

    ctx.root.addEventListener('keydown', e => {
      const el = e.target;
      if (e.key === 'Enter' && el.matches('[data-add]')) {
        e.preventDefault();
        const text = el.value.trim();
        if (!text) return;
        el.value = '';
        call(api => api.post(url(active, 'lists', el.dataset.add, 'items'), { text })).then(r => r && renderLists());
      } else if (e.key === 'Enter' && el.matches('[data-note-title]')) {
        e.preventDefault();
        el.closest('[data-note]').querySelector('textarea').focus(); // dal titolo al testo
      } else if (e.key === 'Enter' && el.matches('[data-text], [data-list-title]')) {
        e.preventDefault();
        el.blur(); // salva con "change"
      } else if (e.key === 'Escape' && el.matches('[data-text], [data-list-title]')) {
        el.value = el.defaultValue;
        el.blur();
      }
    });

    ctx.root.addEventListener('input', e => {
      if (!e.target.matches('[data-note-text], [data-note-title]')) return;
      scheduleNote(e.target.closest('[data-note]').dataset.note);
    });

    // ---- trascinamento delle voci aperte (dalla maniglia ⋮⋮), nella stessa lista ----

    ctx.root.addEventListener('pointerdown', e => {
      const li = e.target.closest('.nt-handle') && e.target.closest('[data-item]');
      if (li) li.draggable = true;
    });
    ctx.root.addEventListener('dragstart', e => {
      const li = e.target.closest?.('[data-item]');
      if (!li?.draggable) return;
      dragging = { list: li.dataset.list, el: li };
      li.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', li.dataset.item);
    });
    ctx.root.addEventListener('dragover', e => {
      const li = e.target.closest?.('[data-item]');
      if (!dragging || !li || li === dragging.el || li.dataset.list !== dragging.list || li.classList.contains('done')) return;
      e.preventDefault();
      const r = li.getBoundingClientRect();
      li.parentElement.insertBefore(dragging.el, e.clientY > r.top + r.height / 2 ? li.nextSibling : li);
    });
    ctx.root.addEventListener('dragend', () => {
      if (!dragging) return;
      const { list, el } = dragging;
      dragging = null;
      el.classList.remove('dragging');
      el.draggable = false;
      const l = board.lists.find(x => x.id === list);
      const openIds = [...el.parentElement.querySelectorAll('[data-item]')].map(x => x.dataset.item);
      const ids = [...openIds, ...l.items.filter(i => i.done).map(i => i.id)];
      if (ids.join() === l.items.map(i => i.id).join()) return;
      call(api => api.put(url(active, 'lists', list, 'items', 'order'), { ids })).then(r => r && renderLists());
    });

    ctx.bus.on('core:projects-changed', load);
    window.addEventListener('beforeunload', flushNotes);
    await load();

    this.refresh = load;
    this.show = () => load(); // il vault può essere stato sbloccato (o bloccato) da un'altra sezione
    // aperta da un widget o dalla dashboard: { project } apre la sua bacheca
    this.focus = params => { if (params?.project) actions.select(params.project); };
    this.hide = flushNotes;
    this.languageChanged = () => { renderSidebar(); renderBoard(); };
  },
};
