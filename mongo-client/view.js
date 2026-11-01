// MongoDB: albero cartelle ▸ connessione ▸ database ▸ collezioni nella sidebar; per la
// connessione attiva un editor in sintassi mongosh con storico e, sotto, i risultati: documenti
// della collezione aperta (JSON o tabella, con filtro, ordinamento, proiezione e pagine),
// risultati dell'editor o struttura della collezione. Ogni modifica passa da un'anteprima
// dell'operazione che l'utente conferma.

const EXT = "Ext['mongo-client']";
const HISTORY_KEY = 'devdock.mongo-client.history';
const HISTORY_MAX = 100;
const CLOSED_FOLDERS_KEY = 'devdock.mongoFolders.collapsed';
const VIEW_KEY = 'devdock.mongo-client.view';

// ---- valori Extended JSON ----

// Valori con un solo campo "$…" mostrati come in mongosh
function special(v) {
  const keys = Object.keys(v);
  if (keys.length !== 1) return null;
  const [k] = keys, x = v[k];
  if (k === '$oid' && typeof x === 'string') return `ObjectId("${x}")`;
  if (k === '$date') return `ISODate("${typeof x === 'string' ? x : x?.$numberLong ?? JSON.stringify(x)}")`;
  if (k === '$numberDecimal') return `NumberDecimal("${x}")`;
  if (k === '$numberLong') return `NumberLong("${x}")`;
  if (k === '$numberDouble') return x;
  if (k === '$binary') return `BinData(${x?.subType ?? '?'}, "${String(x?.base64 ?? '').slice(0, 24)}${String(x?.base64 ?? '').length > 24 ? '…' : ''}")`;
  if (k === '$uuid') return `UUID("${x}")`;
  if (k === '$regularExpression') return `/${x?.pattern}/${x?.options || ''}`;
  if (k === '$timestamp') return `Timestamp(${x?.t}, ${x?.i})`;
  if (k === '$minKey') return 'MinKey()';
  if (k === '$maxKey') return 'MaxKey()';
  return null;
}

// Documento → HTML con colori, rientrato
function renderValue(v, esc, indent = '') {
  if (v === null) return '<span class="mg-null">null</span>';
  if (typeof v === 'string') return `<span class="mg-s">${esc(JSON.stringify(v))}</span>`;
  if (typeof v === 'number') return `<span class="mg-n">${esc(String(v))}</span>`;
  if (typeof v === 'boolean') return `<span class="mg-b">${v}</span>`;
  const inner = indent + '  ';
  if (Array.isArray(v)) {
    if (!v.length) return '[]';
    if (v.length <= 12 && v.every(x => x === null || typeof x !== 'object')) return `[ ${v.map(x => renderValue(x, esc)).join(', ')} ]`;
    return `[\n${v.map(x => inner + renderValue(x, esc, inner)).join(',\n')}\n${indent}]`;
  }
  if (typeof v === 'object') {
    const s = special(v);
    if (s !== null) return `<span class="mg-t">${esc(s)}</span>`;
    const entries = Object.entries(v);
    if (!entries.length) return '{}';
    return `{\n${entries.map(([k, x]) => `${inner}<span class="mg-k">${esc(k)}</span>: ${renderValue(x, esc, inner)}`).join(',\n')}\n${indent}}`;
  }
  return esc(String(v));
}

const idText = id => (id && typeof id === 'object' ? special(id) ?? JSON.stringify(id) : JSON.stringify(id));
const isComplex = v => v !== null && typeof v === 'object' && special(v) === null;

// Valore di una cella della tabella: breve, su una riga
function cellHtml(v, esc) {
  if (v === undefined) return '';
  if (v === null) return '<span class="mg-null">null</span>';
  if (typeof v === 'string') return esc(v.length > 200 ? v.slice(0, 200) + '…' : v);
  if (typeof v === 'number') return `<span class="mg-n">${esc(String(v))}</span>`;
  if (typeof v === 'boolean') return `<span class="mg-b">${v}</span>`;
  if (Array.isArray(v)) return `<span class="mg-t">[ ${v.length} ]</span>`;
  const s = special(v);
  if (s !== null) return `<span class="mg-t">${esc(s)}</span>`;
  return `<span class="mg-t">{ ${Object.keys(v).length} }</span>`;
}

// Confronto per l'ordinamento lato client dei risultati dell'editor
function compareValues(a, b) {
  const rank = v => (v === undefined ? 0 : v === null ? 1 : typeof v === 'number' ? 2 : typeof v === 'string' ? 3 : typeof v === 'boolean' ? 5 : 4);
  const norm = v => (v && typeof v === 'object' ? special(v) ?? JSON.stringify(v) : v);
  const ra = rank(a), rb = rank(b);
  if (ra !== rb) return ra - rb;
  const x = norm(a), y = norm(b);
  return x < y ? -1 : x > y ? 1 : 0;
}

// ---- evidenziazione della sintassi mongosh ----

const SHELL_WORDS = new Set(['db', 'new', 'true', 'false', 'null', 'undefined', 'show', 'use', 'dbs', 'collections']);
const CONSTRUCTORS = new Set(['ObjectId', 'ISODate', 'Date', 'NumberLong', 'NumberInt', 'NumberDecimal', 'Decimal128', 'UUID', 'Timestamp', 'BinData', 'MinKey', 'MaxKey', 'RegExp', 'Long', 'Int32', 'Double']);
function highlightShell(code, esc) {
  const re = /(\/\/[^\n]*|\/\*[\s\S]*?(?:\*\/|$))|('(?:[^'\\\n]|\\.)*'?|"(?:[^"\\\n]|\\.)*"?)|(\$[A-Za-z_][\w$]*)|(\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b)|([A-Za-z_][\w$]*)/g;
  let out = '', last = 0, m;
  while ((m = re.exec(code))) {
    out += esc(code.slice(last, m.index));
    const [tok, comment, str, op, num, word] = m;
    const cls = comment ? 'c' : str ? 's' : op ? 'o' : num ? 'n' : word && SHELL_WORDS.has(word) ? 'k' : word && CONSTRUCTORS.has(word) ? 'f' : null;
    out += cls ? `<span class="mgx-${cls}">${esc(tok)}</span>` : esc(tok);
    last = m.index + tok.length;
  }
  return out + esc(code.slice(last)) + '\n';
}

// ---- suggerimenti dell'editor ----

const COLLECTION_METHODS = ['find', 'findOne', 'aggregate', 'countDocuments', 'estimatedDocumentCount', 'distinct', 'getIndexes', 'stats',
  'insertOne', 'insertMany', 'updateOne', 'updateMany', 'replaceOne', 'deleteOne', 'deleteMany', 'findOneAndUpdate', 'findOneAndReplace',
  'findOneAndDelete', 'bulkWrite', 'createIndex', 'dropIndex', 'drop', 'renameCollection'];
const CURSOR_METHODS = ['sort', 'limit', 'skip', 'projection', 'count', 'explain', 'hint', 'collation', 'maxTimeMS'];
const DB_METHODS = ['getCollection', 'getSiblingDB', 'getCollectionNames', 'getCollectionInfos', 'stats', 'runCommand', 'createCollection', 'createView', 'dropDatabase', 'version'];
const OPERATORS = ['$eq', '$ne', '$gt', '$gte', '$lt', '$lte', '$in', '$nin', '$and', '$or', '$nor', '$not', '$exists', '$type', '$regex', '$options',
  '$elemMatch', '$size', '$all', '$expr', '$text', '$search', '$set', '$unset', '$inc', '$push', '$pull', '$addToSet', '$rename', '$currentDate',
  '$match', '$group', '$project', '$sort', '$limit', '$skip', '$lookup', '$unwind', '$count', '$addFields', '$facet', '$sum', '$avg', '$min', '$max', '$first', '$last'];

function createAutocomplete({ input, container, esc, source }) {
  const box = document.createElement('div');
  box.className = 'mg-ac';
  box.hidden = true;
  box.setAttribute('role', 'listbox');
  document.body.appendChild(box);
  let items = [], index = 0, range = null;

  function caretPoint() {
    const mirror = document.createElement('div');
    const cs = getComputedStyle(input);
    for (const k of ['fontFamily', 'fontSize', 'fontWeight', 'lineHeight', 'letterSpacing', 'padding', 'border', 'boxSizing', 'whiteSpace', 'overflowWrap', 'wordBreak', 'tabSize']) mirror.style[k] = cs[k];
    Object.assign(mirror.style, { position: 'absolute', visibility: 'hidden', top: '0', left: '0', width: input.offsetWidth + 'px', overflow: 'hidden' });
    mirror.textContent = input.value.slice(0, input.selectionStart);
    const mark = document.createElement('span');
    mark.textContent = '​';
    mirror.appendChild(mark);
    container.appendChild(mirror);
    const r = input.getBoundingClientRect();
    const point = { x: r.left + mark.offsetLeft - input.scrollLeft, y: r.top + mark.offsetTop - input.scrollTop + mark.offsetHeight };
    mirror.remove();
    return point;
  }
  function close() { box.hidden = true; items = []; range = null; }
  function render() {
    if (!items.length) return close();
    box.innerHTML = items.map((it, i) => `<div class="mg-ac-item ${i === index ? 'active' : ''}" data-i="${i}" role="option">
      <span class="mg-ac-kind">${esc(it.kind)}</span><span class="mg-ac-label">${esc(it.label)}</span></div>`).join('');
    const p = caretPoint();
    box.hidden = false;
    const w = box.offsetWidth, h = box.offsetHeight;
    box.style.left = Math.max(4, Math.min(p.x, window.innerWidth - w - 8)) + 'px';
    box.style.top = (p.y + h + 4 > window.innerHeight ? p.y - h - 22 : p.y + 2) + 'px';
    box.querySelector('.active')?.scrollIntoView({ block: 'nearest' });
  }
  async function update(force = false) {
    const pos = input.selectionStart;
    if (pos !== input.selectionEnd) return close();
    const before = input.value.slice(0, pos);
    const line = before.slice(before.lastIndexOf('\n') + 1);
    if (/\/\//.test(line) || (line.split('"').length - 1) % 2 || (line.split("'").length - 1) % 2) return close();
    let m, list = [], prefix = '';
    if ((m = /\$([\w]*)$/.exec(before))) {
      prefix = '$' + m[1];
      list = OPERATORS.map(o => ({ kind: 'op', label: o, insert: o }));
    } else if ((m = /\bdb\.([\w$]*)$/.exec(before))) {
      prefix = m[1];
      list = [...(await source.collections()).map(n => ({ kind: 'coll', label: n, insert: /^[A-Za-z_$][\w$]*$/.test(n) ? n : `getCollection(${JSON.stringify(n)})` })),
        ...DB_METHODS.map(n => ({ kind: 'db', label: n + '()', insert: n + '(' }))];
    } else if ((m = /\)\s*\.([\w$]*)$/.exec(before))) {
      prefix = m[1];
      list = CURSOR_METHODS.map(n => ({ kind: 'fn', label: n + '()', insert: n + '(' }));
    } else if ((m = /\bdb\.(?:[\w$]+|getCollection\([^)]*\))\.([\w$]*)$/.exec(before))) {
      prefix = m[1];
      list = COLLECTION_METHODS.map(n => ({ kind: 'fn', label: n + '()', insert: n + '(' }));
    } else if (force && (m = /([A-Za-z]*)$/.exec(before))) {
      prefix = m[1];
      list = [...CONSTRUCTORS].map(n => ({ kind: 'new', label: n + '()', insert: n + '(' }));
    } else return close();
    const p = prefix.toLowerCase();
    items = list.filter(it => it.label.toLowerCase().startsWith(p) && (force || it.label.toLowerCase() !== p)).slice(0, 40);
    index = 0;
    range = { start: pos - prefix.length, end: pos };
    render();
  }
  function accept(i = index) {
    const it = items[i];
    if (!it || !range) return;
    input.setRangeText(it.insert, range.start, range.end, 'end');
    close();
    input.dispatchEvent(new Event('input'));
    input.focus();
  }
  function onKeyDown(e) {
    if ((e.ctrlKey || e.metaKey) && e.key === ' ') { e.preventDefault(); update(true); return true; }
    if (box.hidden) return false;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      index = (index + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
      render();
      return true;
    }
    if ((e.key === 'Enter' && !(e.ctrlKey || e.metaKey)) || e.key === 'Tab') { e.preventDefault(); accept(); return true; }
    if (e.key === 'Escape') { e.preventDefault(); close(); return true; }
    return false;
  }
  box.addEventListener('mousedown', e => {
    const el = e.target.closest('[data-i]');
    if (!el) return;
    e.preventDefault();
    accept(Number(el.dataset.i));
  });
  input.addEventListener('blur', () => setTimeout(close, 120));
  input.addEventListener('click', close);
  return { update, close, onKeyDown, element: box };
}

export default {
  async mount(ctx) {
    const { esc, js, toast, openModal, closeModal, fmt } = ctx.ui;
    const { t } = ctx;
    const $ = (root, role) => root.querySelector(`[data-role="${role}"]`);
    const byId = id => document.getElementById(id);
    // contenitori ridisegnati: niente se l'HTML non cambia, rimandato a dopo un clic in corso
    // (Kelbo ≥ 2.3); con versioni precedenti un semplice innerHTML
    const patch = ctx.ui.patch || ((el, html) => { el.innerHTML = html; });

    let connections = [];
    let folders = [];
    let tunnelsAvailable = false;
    let pageSizes = [10, 25, 50, 100, 250];
    let resultLimits = [50, 100, 500, 1000];
    let activeId = null;
    let treeFilter = '';
    const open = new Set();      // nodi aperti: "c|conn", "d|conn|db"
    const cache = new Map();     // stesse chiavi → { loading } | { error } | lista
    const editors = new Map();   // testo dell'editor per connessione
    const activeDb = new Map();  // database attivo per connessione
    const panels = new Map();    // risultati mostrati per connessione (vedi renderResults)
    let running = false;
    let locked = false;          // vault della master password bloccato o da creare

    const conn = id => connections.find(c => c.id === id) || null;
    const active = () => conn(activeId);
    const panel = () => panels.get(activeId) || null;
    const base = id => `/connections/${encodeURIComponent(id)}`;
    const collPath = (id, db, coll) => `${base(id)}/databases/${encodeURIComponent(db)}/collections/${encodeURIComponent(coll)}`;
    const target = c => (c.uri ? c.uri.replace(/^mongodb(\+srv)?:\/\//, '').replace(/\/.*$/, '') : c.tunnel ? t('tree.viaTunnel', { tunnel: c.tunnel }) : `${c.host}:${c.port}`);
    let viewMode = (() => { try { return localStorage.getItem(VIEW_KEY) === 'table' ? 'table' : 'json'; } catch { return 'json'; } })();

    // Esegue fn; se il vault della master password è bloccato (o da creare) lo chiede e riprova
    async function withVault(fn) {
      try { return await fn(); } catch (e) {
        if (!ctx.vault.isVaultError(e)) throw e;
        if (await ctx.vault.ensure()) return fn();
        throw Object.assign(new Error(t('vault.stillLocked')), { handled: true });
      }
    }
    const fail = e => toast(e.message, 'error');

    // POST letto a mano (risposte 428 di conferma): { status, data }; vault bloccato → errore per withVault
    async function postRaw(path, body) {
      const res = await fetch(ctx.api.url(path), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const data = await res.json().catch(() => ({}));
      if (res.status === 423) throw Object.assign(new Error(ctx.ui.errorText(data, `HTTP ${res.status}`)), { status: 423, code: data?.code, data });
      return { status: res.status, ok: res.ok, data };
    }

    // ---- connessioni e albero ----

    async function load() {
      try {
        const r = await ctx.api.get('/connections');
        ({ connections, folders, tunnelsAvailable } = r);
        pageSizes = r.pageSizes || pageSizes;
        resultLimits = r.resultLimits || resultLimits;
        locked = false;
      } catch (e) {
        if (!ctx.vault.isVaultError(e)) toast(e.message, 'error');
        locked = ctx.vault.isVaultError(e);
        connections = []; folders = []; activeId = null;
      }
      for (const b of ctx.sidebar.querySelectorAll('[data-action="add-folder"],[data-action="add-connection"],[data-action="import-connections"]')) b.hidden = locked;
      $(ctx.sidebar, 'tree-filter').hidden = locked;
      for (const k of [...open]) if (!conn(k.split('|')[1])) open.delete(k);
      if (activeId && !active()) activeId = null;
      ctx.setBadge(connections.length || null);
      renderTree();
      renderWorkspace();
    }

    async function fetchNode(key) {
      const [kind, id, db] = key.split('|');
      cache.set(key, { loading: true });
      renderTree();
      try {
        const list = kind === 'c'
          ? (await withVault(() => ctx.api.get(`${base(id)}/databases`))).databases
          : (await withVault(() => ctx.api.get(`${base(id)}/databases/${encodeURIComponent(db)}/collections`))).collections;
        cache.set(key, list);
      } catch (e) {
        cache.set(key, { error: e.message });
      }
      renderTree();
      if (kind === 'c' && id === activeId) renderDatabases();
    }
    const loaded = key => { const v = cache.get(key); return Array.isArray(v) ? v : null; };

    function closedFolders() {
      try { return new Set(JSON.parse(localStorage.getItem(CLOSED_FOLDERS_KEY) || '[]')); } catch { return new Set(); }
    }
    function toggleFolder(id) {
      const closed = closedFolders();
      if (closed.has(id)) closed.delete(id); else closed.add(id);
      try { localStorage.setItem(CLOSED_FOLDERS_KEY, JSON.stringify([...closed])); } catch { /* solo per questa sessione */ }
      renderTree();
    }

    const chevron = isOpen => `<svg class="pf-chevron ${isOpen ? 'open' : ''}" viewBox="0 0 10 10" aria-hidden="true"><path d="M3.5 1.5 7 5 3.5 8.5" /></svg>`;
    const matchText = text => !treeFilter || String(text).toLowerCase().includes(treeFilter);

    function childrenHtml(key, depth, list, renderItem) {
      const node = cache.get(key);
      const pad = `style="padding-inline-start:${12 + depth * 14}px"`;
      if (!node || node.loading) return `<div class="mg-tree-note" ${pad}>${esc(t('tree.loading'))}</div>`;
      if (node.error) return `<div class="mg-tree-note mg-danger" ${pad}>${esc(node.error)}</div>`;
      if (!list.length) return `<div class="mg-tree-note" ${pad}>${esc(t(treeFilter ? 'tree.noMatch' : 'tree.none'))}</div>`;
      return list.map(renderItem).join('');
    }

    // Con un filtro: connessioni, database e collezioni (già caricati) che corrispondono, con i loro genitori
    function visibleCollections(c, db) {
      const list = loaded(`d|${c.id}|${db.name}`) || [];
      return treeFilter && !matchText(c.label) && !matchText(db.name) ? list.filter(x => matchText(x.name)) : list;
    }
    function visibleDatabases(c) {
      const list = loaded(`c|${c.id}`) || [];
      if (!treeFilter || matchText(c.label)) return list;
      return list.filter(d => matchText(d.name) || visibleCollections(c, d).length);
    }
    const connVisible = c => !treeFilter || matchText(c.label) || visibleDatabases(c).length;

    function connNode(c) {
      const ck = `c|${c.id}`, cOpen = open.has(ck) || (!!treeFilter && !matchText(c.label));
      return `<div class="sb-item mg-row mg-row-conn ${c.id === activeId ? 'active' : ''}" role="button" tabindex="0" aria-expanded="${cOpen}" title="${esc(target(c))}"
          onclick="${EXT}.selectConnection(${js(c.id)})" oncontextmenu="event.preventDefault();${EXT}.connMenu(event,${js(c.id)})">
          <span class="mg-caret" onclick="event.stopPropagation();${EXT}.toggle(${js(ck)})">${chevron(cOpen)}</span>
          <span class="mg-icon">${c.readOnly ? '🔒' : '🍃'}</span><span class="mg-name">${esc(c.label)}</span>
          ${c.tunnelMissing ? `<span class="mg-warn" title="${esc(t('tree.tunnelMissing', { tunnel: c.tunnel }))}">⚠</span>` : ''}
          <button class="mg-more" onclick="event.stopPropagation();${EXT}.connMenu(event,${js(c.id)})" aria-label="${esc(t('tree.actions'))}">⋯</button>
        </div>
        ${cOpen ? childrenHtml(ck, 1, visibleDatabases(c), d => {
          const dk = `d|${c.id}|${d.name}`, dOpen = open.has(dk) || (!!treeFilter && !matchText(d.name) && !matchText(c.label));
          const isActiveDb = c.id === activeId && activeDb.get(c.id) === d.name;
          return `<div class="sb-item mg-row ${isActiveDb ? 'mg-row-db-active' : ''}" style="padding-inline-start:26px" role="button" tabindex="0" aria-expanded="${dOpen}"
              onclick="${EXT}.selectDatabase(${js(c.id)},${js(d.name)})" oncontextmenu="event.preventDefault();${EXT}.dbMenu(event,${js(c.id)},${js(d.name)})">
              <span class="mg-caret" onclick="event.stopPropagation();${EXT}.toggle(${js(dk)})">${chevron(dOpen)}</span>
              <span class="mg-icon">🗄️</span><span class="mg-name">${esc(d.name)}</span>
              ${d.sizeOnDisk != null ? `<span class="mg-count">${esc(fmt.bytes(d.sizeOnDisk))}</span>` : ''}
            </div>
            ${dOpen ? childrenHtml(dk, 3, visibleCollections(c, d), x => {
              const p = panels.get(c.id);
              const isCurrent = c.id === activeId && p?.mode !== 'shell' && p?.db === d.name && p?.coll === x.name;
              return `<div class="sb-item mg-row ${isCurrent ? 'active' : ''}" style="padding-inline-start:52px" role="button" tabindex="0"
                  onclick="${EXT}.openCollection(${js(c.id)},${js(d.name)},${js(x.name)})"
                  oncontextmenu="event.preventDefault();${EXT}.collMenu(event,${js(c.id)},${js(d.name)},${js(x.name)})">
                  <span class="mg-icon">${x.type === 'view' ? '👁' : '📄'}</span><span class="mg-name">${esc(x.name)}</span>
                  ${x.count != null ? `<span class="mg-count">${esc(fmt.number(x.count))}</span>` : ''}
                </div>`;
            }) : ''}`;
        }) : ''}`;
    }

    function renderTree() {
      const el = $(ctx.sidebar, 'tree');
      if (locked) { patch(el, `<p class="mg-muted mg-pad">${esc(t('sidebar.locked'))}<br><br><button class="btn btn-primary btn-sm" onclick="${EXT}.unlock()">${esc(t('sidebar.unlock'))}</button></p>`); return; }
      if (!connections.length && !folders.length) { patch(el, `<p class="mg-muted mg-pad">${esc(t('sidebar.none'))}</p>`); return; }
      const closed = closedFolders();
      const known = new Set(folders.map(f => f.id));
      const folderNode = f => {
        const list = connections.filter(c => c.folder === f.id && connVisible(c));
        if (treeFilter && !list.length) return '';
        const isOpen = !closed.has(f.id) || !!treeFilter;
        return `<div class="sb-item mg-row mg-row-folder" role="button" tabindex="0" aria-expanded="${isOpen}"
            onclick="${EXT}.toggleFolder(${js(f.id)})" oncontextmenu="event.preventDefault();${EXT}.folderMenu(event,${js(f.id)})">
            ${chevron(isOpen)}<span class="mg-icon">📁</span><span class="mg-name">${esc(f.label)}</span>
            <span class="mg-folder-count">${esc(fmt.number(list.length))}</span>
            <button class="mg-more" onclick="event.stopPropagation();${EXT}.folderMenu(event,${js(f.id)})" aria-label="${esc(t('folders.actions'))}">⋯</button>
          </div>
          ${isOpen ? `<div class="mg-children">${list.map(connNode).join('')}</div>` : ''}`;
      };
      const html = folders.map(folderNode).join('') + connections.filter(c => (!c.folder || !known.has(c.folder)) && connVisible(c)).map(connNode).join('');
      patch(el, html || `<p class="mg-muted mg-pad">${esc(t('tree.noMatch'))}</p>`);
    }

    function toggle(key) {
      if (open.has(key)) open.delete(key);
      else {
        open.add(key);
        if (!cache.has(key) || cache.get(key).error) return fetchNode(key);
      }
      renderTree();
    }

    function refreshConnection(id) {
      for (const k of [...cache.keys()]) if (k.split('|')[1] === id) cache.delete(k);
      for (const k of open) if (k.split('|')[1] === id) fetchNode(k);
      if (id === activeId) fetchNode(`c|${id}`);
    }

    function refreshDatabase(id, db) {
      const dk = `d|${id}|${db}`;
      cache.delete(dk);
      if (open.has(dk)) fetchNode(dk);
      if (cache.has(`c|${id}`)) fetchNode(`c|${id}`); // dimensioni, database nuovi o eliminati
    }

    // ---- cartelle ----

    function folderMenu(e, id) {
      ctx.ui.contextMenu(e.clientX, e.clientY, [
        { label: t('folders.rename'), icon: '✎', action: () => folderDialog(id) },
        { label: t('folders.delete'), icon: '🗑', danger: true, action: () => deleteFolder(id) },
      ]);
    }
    function folderDialog(id) {
      const f = id ? folders.find(x => x.id === id) : null;
      if (id && !f) return;
      openModal(t(f ? 'folders.rename' : 'folders.new'), `
        <div class="form-row"><label>${esc(t('folders.name'))}</label>
          <input class="form-input" id="f_mg_folder" value="${esc(f?.label || '')}" placeholder="${esc(t('folders.placeholder'))}" onkeydown="if(event.key==='Enter')${EXT}.saveFolder(${js(id || '')})"></div>`,
      `<button class="btn btn-ghost" onclick="UI.closeModal()">${esc(t('core.action.cancel'))}</button>
       <button class="btn btn-primary" onclick="${EXT}.saveFolder(${js(id || '')})">${esc(t(f ? 'core.action.save' : 'core.action.add'))}</button>`);
      byId('f_mg_folder')?.focus();
    }
    async function saveFolder(id) {
      const label = byId('f_mg_folder').value.trim();
      try {
        if (id) await ctx.api.put(`/folders/${encodeURIComponent(id)}`, { label });
        else await ctx.api.post('/folders', { label });
        closeModal();
        await load();
      } catch (e) { fail(e); }
    }
    async function deleteFolder(id) {
      const f = folders.find(x => x.id === id);
      if (!f || !confirm(t('folders.confirmDelete', { name: f.label }))) return;
      try { await ctx.api.del(`/folders/${encodeURIComponent(id)}`); await load(); } catch (e) { fail(e); }
    }

    // ---- menu contestuali ----

    function connMenu(e, id) {
      const c = conn(id);
      if (!c) return;
      ctx.ui.contextMenu(e.clientX, e.clientY, [
        { label: t('menu.openEditor'), icon: '⌨', action: () => selectConnection(id) },
        { label: t('menu.test'), icon: '⚡', action: () => testConnection(id) },
        { label: t('menu.refresh'), icon: '↻', action: () => refreshConnection(id) },
        'separator',
        { label: t('menu.edit'), icon: '✎', action: () => connectionDialog(id) },
        { label: t('menu.delete'), icon: '🗑', danger: true, action: () => deleteConnection(id) },
      ]);
    }

    function dbMenu(e, id, db) {
      const ro = conn(id)?.readOnly;
      ctx.ui.contextMenu(e.clientX, e.clientY, [
        { label: t('menu.useDatabase'), icon: '⌨', action: () => selectDatabase(id, db, true) },
        { label: t('menu.refresh'), icon: '↻', action: () => refreshDatabase(id, db) },
        { label: t('menu.newCollection'), icon: '＋', disabled: ro, action: () => collectionDialog(id, db) },
        'separator',
        { label: t('menu.dropDatabase'), icon: '🗑', danger: true, disabled: ro, action: () => dropDatabase(id, db) },
      ]);
    }

    function collMenu(e, id, db, coll) {
      const ro = conn(id)?.readOnly;
      const view = (loaded(`d|${id}|${db}`) || []).find(x => x.name === coll)?.type === 'view';
      ctx.ui.contextMenu(e.clientX, e.clientY, [
        { label: t('menu.open'), icon: '📄', action: () => openCollection(id, db, coll) },
        { label: t('menu.structure'), icon: '🧬', action: () => openStructure(id, db, coll) },
        { label: t('menu.insert'), icon: '＋', disabled: ro || view, action: () => openCollection(id, db, coll).then(() => documentDialog(null)) },
        { label: t('menu.exportJson'), icon: '⤓', action: () => exportDocuments(id, { database: db, collection: coll, format: 'json' }) },
        { label: t('menu.exportCsv'), icon: '⤓', action: () => exportDocuments(id, { database: db, collection: coll, format: 'csv' }) },
        { label: t('menu.exportJs'), icon: '⤓', action: () => exportDocuments(id, { database: db, collection: coll, format: 'js' }) },
        'separator',
        { label: t('menu.newIndex'), icon: '⚡', disabled: ro || view, action: () => indexDialog(id, db, coll) },
        { label: t('menu.rename'), icon: '✎', disabled: ro, action: () => renameDialog(id, db, coll) },
        { label: t('menu.drop'), icon: '🗑', danger: true, disabled: ro, action: () => dropCollection(id, db, coll) },
      ]);
    }

    // ---- connessione attiva ----

    function selectConnection(id) {
      if (activeId !== id) {
        saveEditor();
        activeId = id;
      }
      const ck = `c|${id}`;
      if (!open.has(ck)) { open.add(ck); fetchNode(ck); }
      else if (!cache.has(ck)) fetchNode(ck);
      renderTree();
      renderWorkspace();
    }

    // nodi genitori aperti (e caricati) per mostrare database e collezione nell'albero
    function reveal(id, db) {
      for (const key of [`c|${id}`, ...(db ? [`d|${id}|${db}`] : [])]) {
        if (!open.has(key)) open.add(key);
        if (!cache.has(key)) fetchNode(key);
      }
    }

    function selectDatabase(id, db, focus = false) {
      if (activeId !== id) { saveEditor(); activeId = id; }
      activeDb.set(id, db);
      reveal(id, null);
      const dk = `d|${id}|${db}`;
      if (!focus) toggle(dk); else if (!cache.has(dk)) fetchNode(dk);
      renderTree();
      renderWorkspace();
      if (focus) $(ctx.root, 'code').focus();
    }

    function saveEditor() { if (activeId) editors.set(activeId, $(ctx.root, 'code').value); }

    function renderDatabases() {
      const c = active();
      if (!c) return;
      const sel = $(ctx.root, 'database');
      const list = loaded(`c|${c.id}`) || [];
      const names = [...new Set([...list.map(d => d.name), ...(activeDb.get(c.id) ? [activeDb.get(c.id)] : [])])];
      sel.innerHTML = `<option value="">${esc(t('toolbar.noDatabase'))}</option>` + names.map(n => `<option value="${esc(n)}" ${n === activeDb.get(c.id) ? 'selected' : ''}>${esc(n)}</option>`).join('');
    }

    function renderWorkspace() {
      const c = active();
      $(ctx.root, 'empty').hidden = !!c;
      $(ctx.root, 'empty').querySelector('p').textContent = t(locked ? 'sidebar.locked' : 'main.empty');
      $(ctx.root, 'workspace').hidden = !c;
      if (!c) return;
      if (!activeDb.has(c.id) && c.database) activeDb.set(c.id, c.database);
      $(ctx.root, 'code').value = editors.get(c.id) || '';
      syncHighlight();
      renderDatabases();
      const limit = $(ctx.root, 'limit');
      const cur = Number(limit.value) || resultLimits[1];
      limit.innerHTML = resultLimits.map(n => `<option value="${n}" ${n === cur ? 'selected' : ''}>${esc(t('toolbar.limitOption', { count: n }))}</option>`).join('');
      $(ctx.root, 'new-collection').hidden = !!c.readOnly;
      $(ctx.root, 'conn-header').innerHTML = `
        <h3>🍃 ${esc(c.label)}</h3>
        <span class="mg-conn-meta">${c.user ? `${esc(c.user)}@` : ''}${esc(target(c))}${c.database ? ` / ${esc(c.database)}` : ''}</span>
        ${c.readOnly ? `<span class="mg-badge" title="${esc(t('main.readOnlyTitle'))}">${esc(t('main.readOnly'))}</span>` : ''}
        ${c.user && !c.hasPassword ? `<span class="mg-badge mg-badge-warn">${esc(t('conn.noPassword'))}</span>` : ''}
        ${c.tunnelMissing ? `<span class="mg-badge mg-badge-danger">${esc(t('tree.tunnelMissing', { tunnel: c.tunnel }))}</span>` : ''}
        <div class="mg-conn-actions">
          <button class="btn btn-ghost btn-sm" onclick="${EXT}.testConnection(${js(c.id)})">${esc(t('conn.test'))}</button>
          <button class="btn btn-ghost btn-sm" onclick="${EXT}.connectionDialog(${js(c.id)})">${esc(t('conn.edit'))}</button>
          <button class="btn btn-ghost btn-sm mg-danger" onclick="${EXT}.deleteConnection(${js(c.id)})" title="${esc(t('core.action.delete'))}">🗑</button>
        </div>`;
      renderResults();
    }

    // ---- dialogo della connessione ----

    async function connectionDialog(id) {
      const c = id ? conn(id) : { port: 27017 };
      if (!c) return;
      const servers = tunnelsAvailable ? (await ctx.apiFor('tunnels').get('/state').catch(() => ({ servers: [] }))).servers : [];
      let projectList = [];
      try { projectList = (await ctx.projects.load()).projects; } catch { /* nessun progetto */ }
      const mode = c.uri ? 'uri' : c.tunnel ? 'tunnel' : 'host';
      const opt = (value, label, sel) => `<option value="${esc(value)}" ${sel ? 'selected' : ''}>${esc(label)}</option>`;
      const check = (fid, key, value) => `<label class="mg-check"><input type="checkbox" id="${fid}" ${value ? 'checked' : ''}> ${esc(t(key))}</label>`;
      openModal(t(id ? 'form.editTitle' : 'form.newTitle'), `
        <div class="form-grid">
          <div class="form-row"><label>${esc(t('form.id'))}</label><input class="form-input" id="f_mg_id" value="${esc(c.id || '')}" placeholder="${esc(t('form.idPlaceholder'))}" ${id ? 'disabled' : ''}></div>
          <div class="form-row"><label>${esc(t('form.label'))}</label><input class="form-input" id="f_mg_label" value="${esc(c.label || '')}"></div>
        </div>
        <div class="form-grid">
          <div class="form-row"><label>${esc(t('form.mode'))}</label>
            <select class="form-input" id="f_mg_mode" onchange="${EXT}.formMode()">
              ${opt('host', t('form.modeHost'), mode === 'host')}
              ${opt('uri', t('form.modeUri'), mode === 'uri')}
              ${tunnelsAvailable || mode === 'tunnel' ? opt('tunnel', t('form.modeTunnel'), mode === 'tunnel') : ''}
            </select></div>
          <div class="form-row"><label>${esc(t('form.folder'))}</label>
            <select class="form-input" id="f_mg_folder_id">${opt('', t('form.noFolder'), !c.folder)}${folders.map(f => opt(f.id, f.label, c.folder === f.id)).join('')}</select></div>
        </div>
        ${projectList.length ? `<div class="form-row"><label>${esc(t('form.project'))}</label>
          <select class="form-input" id="f_mg_project">${opt('', t('form.noProject'), !c.projectId)}${projectList.map(p => opt(p.id, p.label, c.projectId === p.id)).join('')}</select>
          <p class="mg-muted">${esc(t('form.projectHint'))}</p></div>` : ''}
        <div class="form-row" data-mode="uri"><label>${esc(t('form.uri'))}</label>
          <input class="form-input mg-code" id="f_mg_uri" value="${esc(c.uri || '')}" spellcheck="false" placeholder="mongodb+srv://user@cluster0.example.net/?retryWrites=true">
          <p class="mg-muted">${esc(t('form.uriHint'))}</p></div>
        <div class="form-grid" data-mode="host">
          <div class="form-row"><label>${esc(t('form.host'))}</label><input class="form-input" id="f_mg_host" value="${esc(c.host || '')}" placeholder="localhost"></div>
          <div class="form-row"><label>${esc(t('form.port'))}</label><input class="form-input" id="f_mg_port" type="number" min="1" max="65535" value="${esc(String(c.port ?? 27017))}"></div>
        </div>
        <div class="form-row" data-mode="tunnel"><label>${esc(t('form.tunnel'))}</label>
          <select class="form-input" id="f_mg_tunnel">
            ${c.tunnelMissing ? opt(c.tunnel, t('form.tunnelDeleted', { tunnel: c.tunnel }), true) : ''}
            ${servers.map(s => opt(s.key, t('form.tunnelOption', { name: s.label, remote: s.remote }), c.tunnel === s.key)).join('')}
          </select>
          <p class="mg-muted">${esc(t('form.tunnelHint'))}</p></div>
        <div class="form-grid">
          <div class="form-row"><label>${esc(t('form.user'))}</label><input class="form-input" id="f_mg_user" value="${esc(c.user || '')}" autocomplete="off"></div>
          <div class="form-row"><label>${esc(t('form.password'))}</label>
            <input class="form-input" id="f_mg_password" type="password" autocomplete="new-password" placeholder="${esc(c.hasPassword ? t('form.passwordUnchanged') : '')}">
            ${c.hasPassword ? check('f_mg_nopassword', 'form.removePassword', false) : ''}</div>
        </div>
        <div class="form-grid">
          <div class="form-row"><label>${esc(t('form.authSource'))}</label><input class="form-input" id="f_mg_auth" value="${esc(c.authSource || '')}" placeholder="admin"></div>
          <div class="form-row"><label>${esc(t('form.database'))}</label><input class="form-input" id="f_mg_db" value="${esc(c.database || '')}"></div>
        </div>
        <p class="mg-muted">${esc(t('form.databaseHint'))}</p>
        ${check('f_mg_tls', 'form.tls', c.tls)}
        ${check('f_mg_insecure', 'form.tlsInsecure', c.tlsInsecure)}
        ${check('f_mg_ro', 'form.readOnly', c.readOnly)}
        <p class="mg-muted">${esc(t('form.vaultHint'))}</p>`,
      `<button class="btn btn-ghost" onclick="UI.closeModal()">${esc(t('core.action.cancel'))}</button>
       <button class="btn btn-primary" onclick="${EXT}.saveConnection(${js(id || '')})">${esc(t('core.action.save'))}</button>`);
      formMode();
    }

    function formMode() {
      const mode = byId('f_mg_mode')?.value;
      document.querySelectorAll('#modalBody [data-mode]').forEach(el => { el.hidden = el.dataset.mode !== mode; });
    }

    async function saveConnection(id) {
      const mode = byId('f_mg_mode').value;
      const pwd = byId('f_mg_password').value;
      const body = {
        id: byId('f_mg_id').value.trim(), label: byId('f_mg_label').value.trim(),
        uri: mode === 'uri' ? byId('f_mg_uri').value.trim() : '',
        host: mode === 'host' ? byId('f_mg_host').value.trim() : '',
        port: mode === 'host' ? byId('f_mg_port').value : '',
        tunnel: mode === 'tunnel' ? byId('f_mg_tunnel').value : '',
        folder: byId('f_mg_folder_id').value,
        projectId: byId('f_mg_project')?.value ?? undefined,
        user: byId('f_mg_user').value.trim(), authSource: byId('f_mg_auth').value.trim(), database: byId('f_mg_db').value.trim(),
        tls: byId('f_mg_tls').checked, tlsInsecure: byId('f_mg_insecure').checked, readOnly: byId('f_mg_ro').checked,
        ...(byId('f_mg_nopassword')?.checked ? { password: null } : pwd ? { password: pwd } : {}),
      };
      if (!body.label) body.label = body.id;
      try {
        const saved = await withVault(() => (id ? ctx.api.put(base(id), body) : ctx.api.post('/connections', body)));
        closeModal();
        toast(t('form.saved', { name: body.label }), 'success');
        if (id) refreshConnection(id);
        await load();
        if (!id) selectConnection(saved.id);
      } catch (e) { fail(e); }
    }

    async function testConnection(id) {
      try {
        const r = await withVault(() => ctx.api.post(`${base(id)}/test`, {}));
        toast(t('menu.testOk', { version: r.version }), 'success');
      } catch (e) { fail(e); }
    }

    async function deleteConnection(id) {
      const c = conn(id);
      if (!c || !confirm(t('form.confirmDelete', { name: c.label }))) return;
      try {
        await ctx.api.del(base(id));
        for (const k of [...cache.keys()]) if (k.split('|')[1] === id) cache.delete(k);
        panels.delete(id);
        editors.delete(id);
        if (activeId === id) activeId = null;
        await load();
      } catch (e) { fail(e); }
    }

    // ---- vault e import ----

    async function vaultMenu() {
      let vault;
      try { vault = await ctx.core.get('/vault'); } catch (e) { return fail(e); }
      if (vault.state !== 'unlocked') { if (await ctx.vault.ensure()) vaultMenu(); return; }
      openModal(t('vault.title'), `
        <div class="form-row"><label>${esc(t('vault.oldPassword'))}</label><input class="form-input" type="password" id="f_vault_old" autocomplete="off"></div>
        <div class="form-row"><label>${esc(t('vault.newPassword', { min: vault.minLength }))}</label><input class="form-input" type="password" id="f_vault_new" autocomplete="off"></div>
        <div class="form-row"><label>${esc(t('vault.repeatPassword'))}</label><input class="form-input" type="password" id="f_vault_new2" autocomplete="off"></div>
        <div class="form-row"><label>${esc(t('vault.lockAfter'))}</label><input class="form-input" type="number" min="1" max="1440" id="f_vault_minutes" value="${esc(String(vault.lockAfterMinutes))}"></div>`,
      `<button class="btn btn-ghost" onclick="UI.closeModal()">${esc(t('core.action.cancel'))}</button>
       <button class="btn btn-ghost" onclick="${EXT}.lockVault()">${esc(t('vault.lockNow'))}</button>
       <button class="btn btn-primary" onclick="${EXT}.saveVault(${Number(vault.lockAfterMinutes)})">${esc(t('core.action.save'))}</button>`);
    }
    async function saveVault(currentMinutes) {
      const val = id => byId(id)?.value || '';
      try {
        const minutes = Number(val('f_vault_minutes'));
        if (minutes !== currentMinutes) await ctx.core.post('/vault/settings', { lockAfterMinutes: minutes });
        if (val('f_vault_new')) {
          if (val('f_vault_new') !== val('f_vault_new2')) return toast(t('vault.mismatch'), 'error');
          const r = await ctx.core.post('/vault/change', { oldPassword: val('f_vault_old'), newPassword: val('f_vault_new') });
          toast(t('vault.changed', { count: r.reencrypted }), 'success');
        } else toast(t('vault.saved'), 'success');
        closeModal();
      } catch (e) { fail(e); }
    }
    async function lockVault() {
      closeModal();
      await ctx.core.post('/vault/lock', {}).catch(() => {});
      toast(t('vault.locked'), 'success');
    }

    function importDialog() {
      openModal(t('import.title'), `
        <p class="mg-muted">${esc(t('import.hint'))}</p>
        <div class="form-row"><label>${esc(t('import.file'))}</label><input class="form-input" type="file" accept=".json" id="f_imp_file"></div>
        <div class="form-row"><label>${esc(t('import.password'))}</label><input class="form-input" type="password" id="f_imp_password" autocomplete="off"></div>
        <label class="mg-check"><input type="radio" name="f_imp_mode" value="merge" checked> ${esc(t('import.merge'))}</label>
        <label class="mg-check"><input type="radio" name="f_imp_mode" value="replace"> ${esc(t('import.replace'))}</label>`,
      `<button class="btn btn-ghost" onclick="UI.closeModal()">${esc(t('core.action.cancel'))}</button>
       <button class="btn btn-primary" onclick="${EXT}.doImport()">${esc(t('import.submit'))}</button>`);
    }
    async function doImport() {
      const file = byId('f_imp_file')?.files[0];
      if (!file) return toast(t('import.chooseFile'), 'error');
      try {
        const config = JSON.parse(await file.text());
        const mode = document.querySelector('input[name="f_imp_mode"]:checked')?.value || 'merge';
        if (mode === 'replace' && !confirm(t('import.confirmReplace'))) return;
        const password = byId('f_imp_password').value;
        const r = await withVault(() => ctx.api.post('/connections/import', { config, password, mode }));
        closeModal();
        toast(t('import.done', { count: r.imported }) + (r.skipped ? `, ${t('import.skipped', { count: r.skipped })}` : ''), 'success');
        await load();
      } catch (e) { toast(e instanceof SyntaxError ? t('import.invalid') : e.message, 'error'); }
    }

    // ---- editor ----

    const codeInput = $(ctx.root, 'code');
    const syncHighlight = () => {
      $(ctx.root, 'highlight').innerHTML = highlightShell(codeInput.value, esc);
      const pre = ctx.root.querySelector('.mg-editor-highlight');
      pre.scrollTop = codeInput.scrollTop;
      pre.scrollLeft = codeInput.scrollLeft;
    };
    const ac = createAutocomplete({
      input: codeInput, container: $(ctx.root, 'editor'), esc,
      source: {
        async collections() {
          const c = active(), db = c && activeDb.get(c.id);
          if (!db) return [];
          const key = `d|${c.id}|${db}`;
          if (!cache.has(key)) await fetchNode(key);
          return (loaded(key) || []).map(x => x.name);
        },
      },
    });
    codeInput.addEventListener('input', () => { syncHighlight(); if (activeId) editors.set(activeId, codeInput.value); ac.update(); });
    codeInput.addEventListener('scroll', syncHighlight);
    codeInput.addEventListener('keydown', e => {
      if (ac.onKeyDown(e)) return;
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); runShell(); return; }
      if (e.key === 'Tab') { e.preventDefault(); codeInput.setRangeText('  ', codeInput.selectionStart, codeInput.selectionEnd, 'end'); syncHighlight(); }
    });
    // Testo da eseguire: la selezione, se c'è, altrimenti tutto
    const statement = () => {
      const sel = codeInput.value.slice(codeInput.selectionStart, codeInput.selectionEnd);
      return (sel.trim() ? sel : codeInput.value).trim();
    };

    const readHistory = () => { try { return JSON.parse(sessionStorage.getItem(HISTORY_KEY)) || []; } catch { return []; } };
    function addHistory(entry) {
      const list = readHistory().filter(h => !(h.code === entry.code && h.connId === entry.connId && h.db === entry.db));
      list.unshift(entry);
      try { sessionStorage.setItem(HISTORY_KEY, JSON.stringify(list.slice(0, HISTORY_MAX))); } catch { /* storico solo in memoria della pagina */ }
    }
    function showHistory() {
      const list = readHistory();
      const label = id => conn(id)?.label || id;
      openModal(t('history.title'), list.length ? `
        <div class="mg-history">${list.map((h, i) => `
          <button class="mg-history-item" onclick="${EXT}.useHistory(${i})" title="${esc(t('history.load'))}">
            <span class="mg-history-meta">${esc(fmt.date(h.at, { timeStyle: 'medium' }))} · ${esc(label(h.connId))}${h.db ? ` / ${esc(h.db)}` : ''} · ${h.ok ? `✓ ${esc(h.summary || '')}` : esc(t('history.error'))}</span>
            <code>${esc(h.code.length > 300 ? h.code.slice(0, 300) + '…' : h.code)}</code>
          </button>`).join('')}</div>` : `<p class="mg-muted">${esc(t('history.none'))}</p>`,
      `${list.length ? `<button class="btn btn-ghost" onclick="${EXT}.clearHistory()">${esc(t('history.clear'))}</button>` : ''}
       <button class="btn btn-primary" onclick="UI.closeModal()">${esc(t('core.action.close'))}</button>`);
    }
    function useHistory(i) {
      const h = readHistory()[i];
      if (!h) return;
      closeModal();
      if (conn(h.connId) && h.connId !== activeId) selectConnection(h.connId);
      if (h.db) { activeDb.set(activeId, h.db); renderDatabases(); }
      codeInput.value = h.code;
      editors.set(activeId, h.code);
      syncHighlight();
      codeInput.focus();
    }

    const resultSummary = r => (r.kind === 'documents' ? t('result.documents', { count: r.documents.length })
      : r.kind === 'write' ? t('result.written') : t('result.value'));

    // opts: { code, token } per rimandare un'istruzione confermata
    async function runShell(opts = {}) {
      const c = active();
      const code = opts.code ?? statement();
      if (!c || !code || running) return;
      const database = activeDb.get(c.id) || null;
      const body = { code, database, limit: Number($(ctx.root, 'limit').value) || resultLimits[1], ...(opts.token ? { token: opts.token } : {}) };
      running = true;
      if (!opts.token) setPanel({ mode: 'shell', code, database, loading: true });
      try {
        const { status, ok, data } = await withVault(() => postRaw(`${base(c.id)}/shell`, body));
        const record = (good, summary) => addHistory({ code, connId: c.id, db: database, at: Date.now(), ok: good, summary });
        if (status === 428 && data.needsConfirmation) {
          setPanel({ mode: 'shell', code, database, result: null });
          confirmShell(c, data, token => runShell({ code, token }));
        } else if (!ok) {
          setPanel({ mode: 'shell', code, database, error: ctx.ui.errorText(data, `HTTP ${status}`) });
          record(false);
        } else if (data.kind === 'use') {
          activeDb.set(c.id, data.database);
          renderDatabases();
          renderTree();
          setPanel({ mode: 'shell', code, database, result: data });
          record(true, data.database);
        } else {
          setPanel({ mode: 'shell', code, database, result: data, view: viewMode, selected: new Set(), pending: new Map() });
          record(true, resultSummary(data));
          if (!data.read || data.wrote) {
            if (data.database) refreshDatabase(c.id, data.database);
            if (data.method === 'dropDatabase') refreshConnection(c.id);
          }
        }
      } catch (e) {
        setPanel({ mode: 'shell', code, database, error: e.message });
      } finally {
        running = false;
      }
    }

    // Conferma di un'istruzione dell'editor che modifica dati o schema
    function confirmShell(c, data, onConfirm) {
      const typeName = data.method === 'dropDatabase' ? data.database : data.method === 'drop' ? data.collection : null;
      openModal(t('confirm.title'), `
        <p>${esc(t('confirm.shell', { database: data.database ?? '', connection: c.label }))}</p>
        <pre class="mg-preview">${highlightShell(data.preview, esc)}</pre>
        ${data.matches != null ? `<p class="mg-muted">${esc(t('confirm.matches', { count: data.matches }))}</p>` : ''}
        ${typeName ? `<div class="form-row"><label>${esc(t('confirm.typeName', { name: typeName }))}</label><input class="form-input" id="f_mg_typed" autocomplete="off" oninput="document.getElementById('f_mg_go').disabled=this.value!==${js(typeName)}"></div>` : ''}`,
      `<button class="btn btn-ghost" onclick="UI.closeModal()">${esc(t('core.action.cancel'))}</button>
       <button class="btn ${data.dangerous ? 'btn-danger' : 'btn-primary'}" id="f_mg_go" ${typeName ? 'disabled' : ''} onclick="${EXT}.confirmShellRun()">${esc(t('confirm.run'))}</button>`);
      pendingShell = () => { closeModal(); onConfirm(data.token); };
    }
    let pendingShell = null;

    function dropDatabase(id, db) {
      selectDatabase(id, db, true);
      runShell({ code: `db.getSiblingDB(${JSON.stringify(db)}).dropDatabase()` });
    }

    // ---- risultati ----
    //   browse:    { mode, db, coll, query, result, view, selected, pending }
    //   shell:     { mode, code, database, result | error | loading, view, selected, pending, sort }
    //   structure: { mode, db, coll, data | error | loading }

    function setPanel(p) {
      if (!activeId) return;
      panels.set(activeId, p);
      renderResults();
      renderTree();
    }

    function renderResults() {
      const el = $(ctx.root, 'results');
      const p = panel(), c = active();
      if (!c) return;
      if (!p) { patch(el, `<div class="mg-muted mg-pad">${esc(t('result.hint'))}</div>`); return; }
      if (p.mode === 'structure') { patch(el, structureHtml(p, c)); return; }
      if (p.loading) { patch(el, `<div class="mg-muted mg-pad">${esc(t('result.running'))}</div>`); return; }
      if (p.mode === 'browse') { patch(el, browseHtml(p, c)); return; }
      // risultato dell'editor
      if (p.error) { patch(el, `<div class="mg-error">${esc(p.error)}</div>`); return; }
      const r = p.result;
      if (!r) { patch(el, ''); return; }
      const meta = `<span>${esc(r.kind === 'documents' ? (r.truncated ? t('result.truncated', { count: r.documents.length }) : t('result.documents', { count: r.documents.length })) : r.kind === 'use' ? t('result.use', { database: r.database }) : r.kind === 'write' ? t('result.written') : t('result.value'))}</span>
        <span class="mg-muted">${esc(t('docs.ms', { ms: fmt.number(r.ms ?? 0) }))}</span>`;
      if (r.kind === 'documents') {
        patch(el, `<div class="mg-bar">${meta}${viewToggle(p)}${pendingBar(p, c)}</div>${docsHtml(p, c, r.documents, shellTarget(p))}`);
      } else if (r.kind === 'use') {
        patch(el, `<div class="mg-bar">${meta}</div>`);
      } else {
        const value = r.kind === 'write' ? r.result : r.value;
        patch(el, `<div class="mg-bar">${meta}${r.truncated ? `<span class="mg-badge">${esc(t('result.valueTruncated'))}</span>` : ''}</div>
          <div class="mg-docs"><pre class="mg-json mg-value">${renderValue(value, esc)}</pre></div>`);
      }
    }

    // risultati di find/findOne dell'editor: modificabili come quelli del browser
    const shellTarget = p => (p.result?.source && !active()?.readOnly ? p.result.source : null);
    const docsOf = p => p.result?.documents || [];
    const targetOf = p => (p.mode === 'browse' ? (active()?.readOnly || p.isView ? null : { database: p.db, collection: p.coll }) : shellTarget(p));

    function viewToggle(p) {
      return `<span class="mg-view-toggle" role="group">
        <button class="btn btn-ghost btn-sm ${p.view === 'json' ? 'active' : ''}" onclick="${EXT}.setView('json')">${esc(t('docs.viewJson'))}</button>
        <button class="btn btn-ghost btn-sm ${p.view === 'table' ? 'active' : ''}" onclick="${EXT}.setView('table')">${esc(t('docs.viewTable'))}</button>
      </span>`;
    }

    function pendingBar(p) {
      const docs = docsOf(p);
      const tgt = targetOf(p);
      const parts = [];
      if (tgt && docs.length) {
        parts.push(`<label class="mg-check mg-check-inline"><input type="checkbox" onchange="${EXT}.selectAll(this.checked)" ${p.selected.size && p.selected.size === docs.filter(d => d._id !== undefined).length ? 'checked' : ''}> ${esc(t('docs.selectAll'))}</label>`);
        if (p.selected.size) parts.push(`<button class="btn btn-ghost btn-sm mg-danger" onclick="${EXT}.deleteSelected()">${esc(t('docs.deleteSelected', { count: p.selected.size }))}</button>`);
      }
      const edits = [...p.pending.values()].reduce((n, m) => n + Object.keys(m).length, 0);
      if (edits) {
        parts.push(`<span class="mg-edits">${esc(t('grid.pending', { count: edits }))}</span>
          <button class="btn btn-primary btn-sm" onclick="${EXT}.saveEdits()">${esc(t('core.action.save'))}</button>
          <button class="btn btn-ghost btn-sm" onclick="${EXT}.discardEdits()">${esc(t('grid.discard'))}</button>`);
      }
      return `<span class="mg-bar-actions">${parts.join('')}</span>`;
    }

    function docsHtml(p, c, docs, tgt) {
      if (!docs.length) return `<div class="empty-state"><p>${esc(t(p.mode === 'browse' && p.query.filter ? 'docs.noneFiltered' : 'docs.none'))}</p></div>`;
      if (p.view === 'table') return tableHtml(p, docs, tgt);
      return `<div class="mg-docs">${docs.map((d, i) => `
        <div class="mg-doc ${p.selected.has(i) ? 'selected' : ''}">
          <div class="mg-doc-head">
            ${tgt && d._id !== undefined ? `<input type="checkbox" onchange="${EXT}.select(${i},this.checked)" ${p.selected.has(i) ? 'checked' : ''} aria-label="${esc(t('docs.select'))}">` : ''}
            <span class="mg-doc-id">${d._id !== undefined ? esc(idText(d._id)) : esc(t('docs.noId'))}</span>
            <span class="mg-doc-actions">
              <button class="btn btn-ghost btn-sm" onclick="${EXT}.copyDoc(${i})" title="${esc(t('docs.copy'))}">⧉</button>
              ${tgt && d._id !== undefined ? `<button class="btn btn-ghost btn-sm" onclick="${EXT}.editDoc(${i})" title="${esc(t('docs.edit'))}">✎</button>
              <button class="btn btn-ghost btn-sm mg-danger" onclick="${EXT}.deleteDoc(${i})" title="${esc(t('docs.delete'))}">🗑</button>` : ''}
            </span>
          </div>
          <pre class="mg-json">${renderValue(d, esc)}</pre>
        </div>`).join('')}</div>`;
    }

    // Tabella: un campo di primo livello per colonna (_id per primo); doppio clic per modificare
    function columnsOf(docs) {
      const cols = [...new Set(docs.flatMap(d => Object.keys(d)))];
      return cols.includes('_id') ? ['_id', ...cols.filter(k => k !== '_id')] : cols;
    }
    function tableHtml(p, docs, tgt) {
      const cols = columnsOf(docs);
      const sortKey = p.mode === 'browse' ? Object.entries(safeJson(p.query.sort) || {})[0] : p.sort ? [p.sort.col, p.sort.dir] : null;
      const order = p.mode === 'shell' && p.sort ? docs.map((d, i) => i).sort((a, b) => compareValues(docs[a][p.sort.col], docs[b][p.sort.col]) * p.sort.dir) : docs.map((d, i) => i);
      return `<div class="mg-table-wrap"><table class="data-table mg-table">
        <thead><tr>${tgt ? '<th class="mg-col-check"></th>' : ''}${cols.map(k => `<th class="mg-sortable" onclick="${EXT}.sortBy(${js(k)})" title="${esc(t('grid.sortTitle'))}">${esc(k)}${sortKey && sortKey[0] === k ? (Number(sortKey[1]) < 0 ? ' ▼' : ' ▲') : ''}</th>`).join('')}</tr></thead>
        <tbody>${order.map(i => {
          const d = docs[i], edits = p.pending.get(i) || {};
          const editable = tgt && d._id !== undefined;
          return `<tr class="${p.selected.has(i) ? 'selected' : ''}">
            ${tgt ? `<td class="mg-col-check">${editable ? `<input type="checkbox" onchange="${EXT}.select(${i},this.checked)" ${p.selected.has(i) ? 'checked' : ''} aria-label="${esc(t('docs.select'))}">` : ''}</td>` : ''}
            ${cols.map(k => {
              const changed = Object.prototype.hasOwnProperty.call(edits, k);
              const v = changed ? edits[k] : d[k];
              return `<td class="${changed ? 'mg-dirty' : ''}" ${editable && k !== '_id' ? `data-cell="${i}" data-col="${esc(k)}" title="${esc(t('grid.editTitle'))}"` : ''}>${cellHtml(v, esc)}</td>`;
            }).join('')}
          </tr>`;
        }).join('')}</tbody></table></div>`;
    }
    const safeJson = text => { try { return text ? JSON.parse(text) : null; } catch { return null; } };

    // doppio clic su una cella della tabella dei documenti (un solo listener sul contenitore)
    $(ctx.root, 'results').addEventListener('dblclick', e => {
      const td = e.target.closest('td[data-cell]');
      const p = panel();
      if (td && p && (p.mode === 'browse' || p.mode === 'shell')) editCell(p, td);
    });

    // Modifica di una cella: testo per le stringhe, JSON per il resto; oggetti e array nel dialogo
    function editCell(p, td) {
      const i = Number(td.dataset.cell), col = td.dataset.col;
      const doc = docsOf(p)[i];
      const edits = p.pending.get(i) || {};
      const value = Object.prototype.hasOwnProperty.call(edits, col) ? edits[col] : doc[col];
      if (isComplex(value)) return fieldDialog(i, col, value);
      const asText = typeof value === 'string';
      td.innerHTML = `<input class="mg-cell-input" value="${esc(asText ? value : JSON.stringify(value ?? null))}">`;
      const input = td.querySelector('input');
      input.focus();
      input.select();
      let done = false;
      const finish = mode => {
        if (done) return;
        done = true;
        if (mode !== 'cancel') {
          let next;
          if (asText) next = input.value;
          else {
            try { next = JSON.parse(input.value); } catch { toast(t('grid.invalidJson', { field: col }), 'error'); return renderResults(); }
          }
          const cur = p.pending.get(i) || {};
          if (JSON.stringify(next) !== JSON.stringify(doc[col])) p.pending.set(i, { ...cur, [col]: next });
          else if (Object.prototype.hasOwnProperty.call(cur, col)) {
            const { [col]: _, ...rest } = cur;
            if (Object.keys(rest).length) p.pending.set(i, rest); else p.pending.delete(i);
          }
        }
        renderResults();
        if (mode === 'save') saveEdits();
        else if (mode === 'next' || mode === 'prev') {
          const cells = [...ctx.root.querySelectorAll('.mg-table td[data-cell]')];
          const at = cells.findIndex(x => Number(x.dataset.cell) === i && x.dataset.col === col);
          const nextTd = cells[at + (mode === 'next' ? 1 : -1)];
          if (nextTd) editCell(p, nextTd);
        }
      };
      input.addEventListener('keydown', e => {
        if (e.key === 'Enter') { e.preventDefault(); finish('save'); }
        else if (e.key === 'Escape') finish('cancel');
        else if (e.key === 'Tab') { e.preventDefault(); finish(e.shiftKey ? 'prev' : 'next'); }
      });
      input.addEventListener('blur', () => setTimeout(() => finish('keep'), 150));
    }

    function fieldDialog(i, col, value) {
      openModal(t('grid.fieldTitle', { field: col }), `
        <p class="mg-muted">${esc(t('grid.fieldHint'))}</p>
        <textarea class="form-input mg-code mg-editor-area" id="f_mg_field" spellcheck="false">${esc(JSON.stringify(value, null, 2))}</textarea>`,
      `<button class="btn btn-ghost" onclick="UI.closeModal()">${esc(t('core.action.cancel'))}</button>
       <button class="btn btn-primary" onclick="${EXT}.applyField(${i},${js(col)})">${esc(t('grid.apply'))}</button>`);
      byId('modal')?.classList.add('modal-wide');
      byId('f_mg_field').focus();
    }
    function applyField(i, col) {
      const p = panel();
      let next;
      try { next = JSON.parse(byId('f_mg_field').value); } catch { return toast(t('grid.invalidJson', { field: col }), 'error'); }
      p.pending.set(i, { ...(p.pending.get(i) || {}), [col]: next });
      closeModal();
      renderResults();
    }

    function saveEdits() {
      const p = panel(), tgt = p && targetOf(p);
      if (!tgt || !p.pending.size) return;
      const docs = docsOf(p);
      const updates = [...p.pending].map(([i, set]) => ({ id: docs[i]._id, set }));
      operate({ op: 'updateFields', database: tgt.database, collection: tgt.collection, updates: JSON.stringify(updates) }, {
        onDone: () => { p.pending = new Map(); refreshPanel(); },
      });
    }

    // ---- browser della collezione ----

    function browseHtml(p, c) {
      const r = p.result;
      const head = `<div class="mg-browse-head">
          <span class="mg-path"><span class="mg-path-conn">${esc(p.db)}</span><span class="mg-sep">›</span><strong>${esc(p.coll)}</strong>${p.isView ? ` <span class="mg-badge">${esc(t('docs.isView'))}</span>` : ''}</span>
          <span class="mg-browse-actions">
            <button class="btn btn-ghost btn-sm" onclick="${EXT}.openStructure(${js(c.id)},${js(p.db)},${js(p.coll)})">${esc(t('main.structure'))}</button>
            <button class="btn btn-ghost btn-sm" onclick="${EXT}.exportMenu(event)">${esc(t('main.export'))}</button>
            ${c.readOnly || p.isView ? '' : `<button class="btn btn-ghost btn-sm" onclick="${EXT}.insertDoc()">${esc(t('main.insert'))}</button>`}
          </span>
        </div>
        <form class="mg-query" onsubmit="event.preventDefault();${EXT}.applyQuery()" autocomplete="off">
          <label class="mg-field mg-field-filter"><span>${esc(t('query.filter'))}</span>
            <input class="form-input mg-code" id="f_mg_filter" value="${esc(p.query.filter)}" spellcheck="false" placeholder='{ "status": "active" }'></label>
          <label class="mg-field"><span>${esc(t('query.sort'))}</span>
            <input class="form-input mg-code" id="f_mg_sort" value="${esc(p.query.sort)}" spellcheck="false" placeholder='{ "_id": -1 }'></label>
          <label class="mg-field"><span>${esc(t('query.projection'))}</span>
            <input class="form-input mg-code" id="f_mg_projection" value="${esc(p.query.projection)}" spellcheck="false" placeholder='{ "name": 1 }'></label>
          <label class="mg-field mg-field-limit"><span>${esc(t('query.limit'))}</span>
            <select class="form-input" id="f_mg_pagesize" onchange="${EXT}.applyQuery()">${pageSizes.map(n => `<option value="${n}" ${n === p.query.limit ? 'selected' : ''}>${esc(fmt.number(n))}</option>`).join('')}</select></label>
          <button class="btn btn-primary btn-sm" type="submit">${esc(t('query.find'))}</button>
          <button class="btn btn-ghost btn-sm" type="button" onclick="${EXT}.resetQuery()">${esc(t('query.reset'))}</button>
          <button class="btn btn-ghost btn-sm" type="button" onclick="${EXT}.queryToEditor()" title="${esc(t('query.toEditorTitle'))}">${esc(t('query.toEditor'))}</button>
        </form>`;
      if (!r) return head + `<div class="mg-muted mg-pad">${esc(t('docs.loading'))}</div>`;
      if (r.error) return head + `<div class="mg-error">${esc(r.error)}</div>`;
      const n = r.documents.length;
      const from = n ? r.skip + 1 : 0, to = r.skip + n;
      const range = r.total != null
        ? t('docs.rangeOf', { from: fmt.number(from), to: fmt.number(to), count: r.total })
        : t('docs.range', { from: fmt.number(from), to: fmt.number(to) });
      return head + `<div class="mg-bar">
          <button class="btn btn-ghost btn-sm" onclick="${EXT}.page(-1)" ${r.skip > 0 ? '' : 'disabled'} aria-label="${esc(t('docs.prev'))}">‹</button>
          <span class="mg-range">${esc(range)}</span>
          <button class="btn btn-ghost btn-sm" onclick="${EXT}.page(1)" ${r.hasMore ? '' : 'disabled'} aria-label="${esc(t('docs.next'))}">›</button>
          <span class="mg-muted">${esc(t('docs.ms', { ms: fmt.number(r.ms) }))}</span>
          ${viewToggle(p)}
          ${pendingBar(p)}
        </div>${docsHtml(p, c, r.documents, targetOf(p))}`;
    }

    async function openCollection(id, db, coll) {
      if (activeId !== id) { saveEditor(); activeId = id; }
      activeDb.set(id, db);
      reveal(id, db);
      const isView = (loaded(`d|${id}|${db}`) || []).find(x => x.name === coll)?.type === 'view';
      const cur = panel();
      if (!(cur?.mode === 'browse' && cur.db === db && cur.coll === coll)) {
        const limit = cur?.query?.limit || 25;
        panels.set(id, { mode: 'browse', db, coll, isView, query: { filter: '', sort: '', projection: '', limit, skip: 0 }, result: null, view: viewMode, selected: new Set(), pending: new Map() });
      }
      renderWorkspace();
      renderTree();
      await find();
    }

    async function find() {
      const p = panel();
      if (!p || p.mode !== 'browse') return;
      const id = activeId;
      try {
        p.result = await withVault(() => ctx.api.post(`${collPath(id, p.db, p.coll)}/find`, {
          filter: p.query.filter, sort: p.query.sort, projection: p.query.projection, limit: p.query.limit, skip: p.query.skip,
        }));
      } catch (e) {
        p.result = { error: e.message, documents: [] };
      }
      p.selected = new Set();
      p.pending = new Map();
      if (panels.get(id) === p && id === activeId) renderResults();
    }

    // dopo una modifica: stessi risultati di prima
    function refreshPanel() {
      const p = panel();
      if (!p) return;
      if (p.mode === 'browse') { find(); refreshDatabase(activeId, p.db); }
      else if (p.mode === 'shell' && p.result?.read) runShell({ code: p.code });
      else renderResults();
    }

    function applyQueryFields(p) {
      p.query.filter = byId('f_mg_filter')?.value.trim() ?? p.query.filter;
      p.query.sort = byId('f_mg_sort')?.value.trim() ?? p.query.sort;
      p.query.projection = byId('f_mg_projection')?.value.trim() ?? p.query.projection;
    }

    function applyQuery() {
      const p = panel();
      if (!p || p.mode !== 'browse') return;
      applyQueryFields(p);
      p.query.limit = Number(byId('f_mg_pagesize').value) || 25;
      p.query.skip = 0;
      find();
    }

    // filtro, ordinamento e proiezione del browser come istruzione nell'editor
    function queryToEditor() {
      const p = panel();
      if (!p || p.mode !== 'browse') return;
      applyQueryFields(p);
      const coll = /^[A-Za-z_$][\w$]*$/.test(p.coll) ? `db.${p.coll}` : `db.getCollection(${JSON.stringify(p.coll)})`;
      const code = `${coll}.find(${p.query.filter || '{}'}${p.query.projection ? `, ${p.query.projection}` : ''})${p.query.sort ? `.sort(${p.query.sort})` : ''}.limit(${p.query.limit})`;
      codeInput.value = code;
      editors.set(activeId, code);
      syncHighlight();
      codeInput.focus();
    }

    // ---- modifiche: anteprima e conferma ----

    // Chiede al server l'anteprima di op e la conferma; back: dialogo a cui tornare con "Indietro"
    async function operate(op, { connection = activeId, back, onDone } = {}) {
      const c = conn(connection);
      let plan;
      try { plan = await withVault(() => ctx.api.post(`${base(connection)}/operation`, { op })); } catch (e) { return fail(e); }
      const typeName = op.op === 'dropCollection' ? op.collection : null;
      openModal(t('confirm.title'), `
        <p>${esc(t(`confirm.${op.op}`, { count: plan.count ?? 0, collection: op.collection, database: op.database, connection: c?.label ?? connection, to: op.to ?? '', name: op.name ?? '' }))}</p>
        <pre class="mg-preview">${highlightShell(plan.preview, esc)}</pre>
        ${typeName ? `<div class="form-row"><label>${esc(t('confirm.typeName', { name: typeName }))}</label><input class="form-input" id="f_mg_typed" autocomplete="off" oninput="document.getElementById('f_mg_go').disabled=this.value!==${js(typeName)}"></div>` : ''}`,
      `${back ? `<button class="btn btn-ghost" onclick="${EXT}.back()">${esc(t('confirm.back'))}</button>` : `<button class="btn btn-ghost" onclick="UI.closeModal()">${esc(t('core.action.cancel'))}</button>`}
       <button class="btn ${plan.dangerous ? 'btn-danger' : 'btn-primary'}" id="f_mg_go" ${typeName ? 'disabled' : ''} onclick="${EXT}.execute()">${esc(t('confirm.run'))}</button>`);
      pending = { connection, op, token: plan.token, back, onDone };
    }
    let pending = null;

    async function execute() {
      if (!pending) return;
      const { connection, op, token, onDone } = pending;
      try {
        const r = await withVault(() => ctx.api.post(`${base(connection)}/operation`, { op, token }));
        closeModal();
        pending = null;
        const msg = {
          insertOne: () => t('done.inserted', { count: r.inserted }), insertMany: () => t('done.inserted', { count: r.inserted }),
          replaceOne: () => t(r.modified ? 'done.replaced' : 'done.unchanged'), deleteMany: () => t('done.deleted', { count: r.deleted }),
          dropCollection: () => t('done.dropped', { name: op.collection }), updateFields: () => t('done.updated', { count: r.modified }),
          createCollection: () => t('done.created', { name: op.collection }), renameCollection: () => t('done.renamed', { name: op.to }),
          createIndex: () => t('done.indexCreated', { name: r.index }), dropIndex: () => t('done.indexDropped', { name: op.name }),
        }[op.op]();
        toast(msg, 'success');
        onDone?.(r);
      } catch (e) { fail(e); }
    }

    // Dialogo di inserimento (index null) o di modifica di un documento
    let draft = '';
    function documentDialog(index, text) {
      const p = panel(), tgt = p && targetOf(p);
      if (!tgt) return;
      const doc = index == null ? null : docsOf(p)[index];
      if (index != null && !doc) return;
      draft = text ?? (doc ? JSON.stringify(doc, null, 2) : '{\n  \n}');
      openModal(t(doc ? 'edit.titleEdit' : 'edit.titleInsert', { collection: tgt.collection }), `
        <p class="mg-muted">${esc(t(doc ? 'edit.hintEdit' : 'edit.hintInsert'))}</p>
        <textarea class="form-input mg-code mg-editor-area" id="f_mg_doc" spellcheck="false">${esc(draft)}</textarea>`,
      `<button class="btn btn-ghost" onclick="UI.closeModal()">${esc(t('core.action.cancel'))}</button>
       <button class="btn btn-primary" onclick="${EXT}.submitDocument(${index == null ? 'null' : index})">${esc(t('edit.continue'))}</button>`);
      byId('modal')?.classList.add('modal-wide');
      const ta = byId('f_mg_doc');
      ta.focus();
      ta.addEventListener('keydown', e => {
        if (e.key === 'Tab') { e.preventDefault(); ta.setRangeText('  ', ta.selectionStart, ta.selectionEnd, 'end'); }
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); submitDocument(index); }
      });
    }

    function submitDocument(index) {
      const p = panel(), tgt = targetOf(p);
      draft = byId('f_mg_doc').value;
      const back = () => documentDialog(index, draft);
      const onDone = refreshPanel;
      const { database, collection } = tgt;
      if (index == null) {
        const many = draft.trim().startsWith('[');
        return operate(many ? { op: 'insertMany', database, collection, documents: draft } : { op: 'insertOne', database, collection, document: draft }, { back, onDone });
      }
      const doc = docsOf(p)[index];
      return operate({ op: 'replaceOne', database, collection, id: JSON.stringify(doc._id), document: draft }, { back, onDone });
    }

    function deleteIds(indexes) {
      const p = panel(), tgt = targetOf(p);
      const ids = indexes.map(i => docsOf(p)[i]?._id).filter(x => x !== undefined);
      if (!tgt || !ids.length) return;
      operate({ op: 'deleteMany', database: tgt.database, collection: tgt.collection, ids: JSON.stringify(ids) }, { onDone: refreshPanel });
    }

    function dropCollection(id, db, coll) {
      operate({ op: 'dropCollection', database: db, collection: coll }, {
        connection: id,
        onDone: () => {
          const p = panels.get(id);
          if (p && p.mode !== 'shell' && p.db === db && p.coll === coll) panels.delete(id);
          refreshDatabase(id, db);
          if (id === activeId) renderResults();
        },
      });
    }

    // ---- designer: collezioni e indici ----

    function collectionDialog(id = activeId, db = activeDb.get(activeId) || '') {
      openModal(t('designer.newTitle'), `
        <div class="form-grid">
          <div class="form-row"><label>${esc(t('designer.database'))}</label><input class="form-input" id="f_mg_cdb" value="${esc(db)}" placeholder="${esc(t('designer.databasePlaceholder'))}"></div>
          <div class="form-row"><label>${esc(t('designer.name'))}</label><input class="form-input" id="f_mg_cname"></div>
        </div>
        <label class="mg-check"><input type="checkbox" id="f_mg_capped" onchange="document.getElementById('f_mg_capped_box').hidden=!this.checked"> ${esc(t('designer.capped'))}</label>
        <div class="form-grid" id="f_mg_capped_box" hidden>
          <div class="form-row"><label>${esc(t('designer.size'))}</label><input class="form-input" type="number" min="1" id="f_mg_csize" value="1048576"></div>
          <div class="form-row"><label>${esc(t('designer.max'))}</label><input class="form-input" type="number" min="1" id="f_mg_cmax"></div>
        </div>
        <div class="form-row"><label>${esc(t('designer.validator'))}</label>
          <textarea class="form-input mg-code mg-editor-area mg-editor-small" id="f_mg_validator" spellcheck="false" placeholder='{ "$jsonSchema": { "bsonType": "object", "required": ["name"] } }'></textarea>
          <p class="mg-muted">${esc(t('designer.validatorHint'))}</p></div>
        <div class="form-grid">
          <div class="form-row"><label>${esc(t('designer.validationLevel'))}</label>
            <select class="form-input" id="f_mg_vlevel"><option value="">—</option><option>strict</option><option>moderate</option><option>off</option></select></div>
          <div class="form-row"><label>${esc(t('designer.validationAction'))}</label>
            <select class="form-input" id="f_mg_vaction"><option value="">—</option><option>error</option><option>warn</option></select></div>
        </div>`,
      `<button class="btn btn-ghost" onclick="UI.closeModal()">${esc(t('core.action.cancel'))}</button>
       <button class="btn btn-primary" onclick="${EXT}.submitCollection(${js(id)})">${esc(t('edit.continue'))}</button>`);
      byId(db ? 'f_mg_cname' : 'f_mg_cdb').focus();
    }
    function submitCollection(id) {
      const database = byId('f_mg_cdb').value.trim(), collection = byId('f_mg_cname').value.trim();
      const options = {};
      if (byId('f_mg_capped').checked) {
        options.capped = true;
        options.size = Number(byId('f_mg_csize').value);
        if (byId('f_mg_cmax').value) options.max = Number(byId('f_mg_cmax').value);
      }
      const validator = byId('f_mg_validator').value.trim();
      if (validator) {
        try { options.validator = JSON.parse(validator); } catch { return toast(t('grid.invalidJson', { field: t('designer.validator') }), 'error'); }
      }
      if (byId('f_mg_vlevel').value) options.validationLevel = byId('f_mg_vlevel').value;
      if (byId('f_mg_vaction').value) options.validationAction = byId('f_mg_vaction').value;
      operate({ op: 'createCollection', database, collection, options: JSON.stringify(options) }, {
        connection: id,
        back: () => { collectionDialog(id, database); byId('f_mg_cname').value = collection; byId('f_mg_validator').value = validator; },
        onDone: () => {
          open.add(`c|${id}`);
          open.add(`d|${id}|${database}`);
          refreshDatabase(id, database);
          openCollection(id, database, collection);
        },
      });
    }

    function renameDialog(id, db, coll) {
      openModal(t('designer.renameTitle', { name: coll }), `
        <div class="form-row"><label>${esc(t('designer.newName'))}</label><input class="form-input" id="f_mg_rename" value="${esc(coll)}"></div>`,
      `<button class="btn btn-ghost" onclick="UI.closeModal()">${esc(t('core.action.cancel'))}</button>
       <button class="btn btn-primary" onclick="${EXT}.submitRename(${js(id)},${js(db)},${js(coll)})">${esc(t('edit.continue'))}</button>`);
      byId('f_mg_rename').select();
    }
    function submitRename(id, db, coll) {
      const to = byId('f_mg_rename').value.trim();
      operate({ op: 'renameCollection', database: db, collection: coll, to }, {
        connection: id,
        onDone: () => {
          const p = panels.get(id);
          if (p && p.mode !== 'shell' && p.db === db && p.coll === coll) panels.delete(id);
          refreshDatabase(id, db);
          if (id === activeId) openCollection(id, db, to);
        },
      });
    }

    function indexDialog(id, db, coll) {
      openModal(t('designer.indexTitle', { name: coll }), `
        <div class="form-row"><label>${esc(t('designer.indexKeys'))}</label>
          <textarea class="form-input mg-code mg-editor-area mg-editor-small" id="f_mg_ikeys" spellcheck="false">{ "field": 1 }</textarea>
          <p class="mg-muted">${esc(t('designer.indexKeysHint'))}</p></div>
        <div class="form-grid">
          <div class="form-row"><label>${esc(t('designer.indexName'))}</label><input class="form-input" id="f_mg_iname" placeholder="${esc(t('designer.indexNameAuto'))}"></div>
          <div class="form-row"><label>${esc(t('designer.ttl'))}</label><input class="form-input" type="number" min="0" id="f_mg_ittl"></div>
        </div>
        <label class="mg-check"><input type="checkbox" id="f_mg_iunique"> ${esc(t('designer.unique'))}</label>
        <label class="mg-check"><input type="checkbox" id="f_mg_isparse"> ${esc(t('designer.sparse'))}</label>
        <div class="form-row"><label>${esc(t('designer.partial'))}</label>
          <input class="form-input mg-code" id="f_mg_ipartial" spellcheck="false" placeholder='{ "status": { "$exists": true } }'></div>`,
      `<button class="btn btn-ghost" onclick="UI.closeModal()">${esc(t('core.action.cancel'))}</button>
       <button class="btn btn-primary" onclick="${EXT}.submitIndex(${js(id)},${js(db)},${js(coll)})">${esc(t('edit.continue'))}</button>`);
    }
    function submitIndex(id, db, coll) {
      const options = {};
      if (byId('f_mg_iname').value.trim()) options.name = byId('f_mg_iname').value.trim();
      if (byId('f_mg_iunique').checked) options.unique = true;
      if (byId('f_mg_isparse').checked) options.sparse = true;
      if (byId('f_mg_ittl').value !== '') options.expireAfterSeconds = Number(byId('f_mg_ittl').value);
      const partial = byId('f_mg_ipartial').value.trim();
      if (partial) {
        try { options.partialFilterExpression = JSON.parse(partial); } catch { return toast(t('grid.invalidJson', { field: t('designer.partial') }), 'error'); }
      }
      operate({ op: 'createIndex', database: db, collection: coll, keys: byId('f_mg_ikeys').value, options: JSON.stringify(options) }, {
        connection: id, onDone: () => { if (panel()?.mode === 'structure') openStructure(id, db, coll); },
      });
    }
    function dropIndex(name) {
      const p = panel();
      if (!p || p.mode !== 'structure') return;
      operate({ op: 'dropIndex', database: p.db, collection: p.coll, name }, { onDone: () => openStructure(activeId, p.db, p.coll) });
    }

    // ---- struttura della collezione ----

    async function openStructure(id, db, coll) {
      if (activeId !== id) { saveEditor(); activeId = id; }
      activeDb.set(id, db);
      reveal(id, db);
      const p = { mode: 'structure', db, coll, loading: true };
      panels.set(id, p);
      renderWorkspace();
      renderTree();
      try { p.data = await withVault(() => ctx.api.get(`${collPath(id, db, coll)}/structure`)); } catch (e) { p.error = e.message; }
      p.loading = false;
      if (panels.get(id) === p && id === activeId) renderResults();
    }

    function structureHtml(p, c) {
      const head = `<div class="mg-browse-head">
          <span class="mg-path"><span class="mg-path-conn">${esc(p.db)}</span><span class="mg-sep">›</span><strong>${esc(p.coll)}</strong> · ${esc(t('main.structure'))}</span>
          <span class="mg-browse-actions">
            <button class="btn btn-ghost btn-sm" onclick="${EXT}.openCollection(${js(c.id)},${js(p.db)},${js(p.coll)})">${esc(t('main.documents'))}</button>
            ${c.readOnly || p.data?.type === 'view' ? '' : `<button class="btn btn-ghost btn-sm" onclick="${EXT}.indexDialog(${js(c.id)},${js(p.db)},${js(p.coll)})">${esc(t('menu.newIndex'))}</button>`}
          </span>
        </div>`;
      if (p.loading) return head + `<div class="mg-muted mg-pad">${esc(t('docs.loading'))}</div>`;
      if (p.error) return head + `<div class="mg-error">${esc(p.error)}</div>`;
      const d = p.data, s = d.stats;
      const stat = (label, value) => `<div class="mg-stat"><span>${esc(label)}</span><strong>${esc(value)}</strong></div>`;
      const pct = n => fmt.number(d.sampled ? n / d.sampled : 0, { style: 'percent', maximumFractionDigits: 0 });
      return head + `<div class="mg-docs">
        ${s ? `<div class="mg-stats">
          ${stat(t('structure.count'), fmt.number(s.count))}
          ${stat(t('structure.size'), fmt.bytes(s.size))}
          ${stat(t('structure.avgObjSize'), fmt.bytes(s.avgObjSize))}
          ${stat(t('structure.storageSize'), fmt.bytes(s.storageSize))}
          ${stat(t('structure.indexSize'), fmt.bytes(s.totalIndexSize))}
          ${s.capped ? stat(t('structure.capped'), '✓') : ''}
        </div>` : ''}
        <h4 class="mg-h">${esc(t('structure.schema', { count: d.sampled }))}</h4>
        ${d.schema.length ? `<table class="data-table mg-table"><thead><tr><th>${esc(t('structure.field'))}</th><th>${esc(t('structure.types'))}</th><th>${esc(t('structure.presence'))}</th></tr></thead><tbody>
          ${d.schema.map(f => `<tr><td><code>${esc(f.path)}</code></td>
            <td>${Object.entries(f.types).sort((a, b) => b[1] - a[1]).map(([ty, n]) => `<span class="mg-type">${esc(ty)}${Object.keys(f.types).length > 1 ? ` ${esc(pct(n))}` : ''}</span>`).join(' ')}</td>
            <td>${esc(pct(f.count))}</td></tr>`).join('')}</tbody></table>` : `<p class="mg-muted">${esc(t('docs.none'))}</p>`}
        <h4 class="mg-h">${esc(t('indexes.title', { collection: p.coll }))}</h4>
        ${d.indexes.length ? `<table class="data-table mg-table"><thead><tr><th>${esc(t('indexes.name'))}</th><th>${esc(t('indexes.keys'))}</th><th>${esc(t('indexes.options'))}</th><th>${esc(t('indexes.size'))}</th><th></th></tr></thead><tbody>
          ${d.indexes.map(ix => {
            const { v, key, name, ...rest } = ix;
            return `<tr><td><code>${esc(name)}</code></td><td><pre class="mg-json mg-inline">${renderValue(key, esc)}</pre></td>
              <td>${Object.keys(rest).length ? `<pre class="mg-json mg-inline">${renderValue(rest, esc)}</pre>` : ''}</td>
              <td>${s?.indexSizes?.[name] != null ? esc(fmt.bytes(s.indexSizes[name])) : ''}</td>
              <td>${!c.readOnly && name !== '_id_' ? `<button class="btn btn-ghost btn-sm mg-danger" onclick="${EXT}.dropIndex(${js(name)})" title="${esc(t('indexes.drop'))}">🗑</button>` : ''}</td></tr>`;
          }).join('')}</tbody></table>` : `<p class="mg-muted">${esc(t('indexes.none'))}</p>`}
        ${d.options && Object.keys(d.options).length ? `<h4 class="mg-h">${esc(t('structure.options'))}</h4><pre class="mg-json mg-value">${renderValue(d.options, esc)}</pre>` : ''}
      </div>`;
    }

    // ---- export ----

    async function exportDocuments(id, body) {
      const run = async () => {
        const res = await fetch(ctx.api.url(`${base(id)}/export`), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        if (!res.ok) {
          const data = await res.json().catch(() => null);
          throw Object.assign(new Error(ctx.ui.errorText(data, `HTTP ${res.status}`)), { status: res.status, code: data?.code, data });
        }
        const name = /filename="([^"]+)"/.exec(res.headers.get('Content-Disposition') || '')?.[1] || 'export';
        return { blob: await res.blob(), name };
      };
      try {
        const { blob, name } = await withVault(run);
        const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: name });
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(a.href), 10000);
      } catch (e) { fail(e); }
    }

    function formatItems(make) {
      return [
        { label: t('menu.exportJson'), icon: '⤓', action: () => make('json') },
        { label: t('menu.exportCsv'), icon: '⤓', action: () => make('csv') },
        { label: t('menu.exportJs'), icon: '⤓', action: () => make('js') },
      ];
    }

    // browser: tutta la collezione o i documenti filtrati
    function exportMenu(e) {
      const p = panel();
      if (!p || p.mode !== 'browse') return;
      applyQueryFields(p);
      const r = e.target.getBoundingClientRect();
      const whole = format => exportDocuments(activeId, { database: p.db, collection: p.coll, format });
      const filtered = format => exportDocuments(activeId, { database: p.db, collection: p.coll, filter: p.query.filter, sort: p.query.sort, projection: p.query.projection, format });
      ctx.ui.contextMenu(r.left, r.bottom, [
        ...formatItems(whole).map(x => ({ ...x, label: t('export.whole', { format: x.label }) })),
        'separator',
        ...formatItems(filtered).map(x => ({ ...x, label: t('export.filtered', { format: x.label }) })),
      ]);
    }

    // editor: tutti i documenti del find o dell'aggregate (senza il limite dei risultati)
    function exportShell(anchor) {
      const c = active();
      const code = statement();
      if (!c || !code) return toast(t('export.noStatement'), 'error');
      const r = anchor.getBoundingClientRect();
      ctx.ui.contextMenu(r.left, r.bottom, formatItems(format => exportDocuments(c.id, { code, database: activeDb.get(c.id) || null, format })));
    }

    // ---- eventi ----

    const actions = {
      'add-connection': () => connectionDialog(null),
      'add-folder': () => folderDialog(null),
      'vault-menu': () => (locked ? unlock() : vaultMenu()),
      'import-connections': importDialog,
      'run': () => runShell(),
      'export-shell': e => exportShell(e.target.closest('button')),
      'new-collection': () => collectionDialog(),
      'history': showHistory,
    };
    for (const root of [ctx.root, ctx.sidebar]) {
      root.addEventListener('click', e => {
        const el = e.target.closest('[data-action]');
        if (el && actions[el.dataset.action]) actions[el.dataset.action](e);
      });
    }
    $(ctx.root, 'database').addEventListener('change', e => {
      if (!activeId) return;
      if (e.target.value) activeDb.set(activeId, e.target.value); else activeDb.delete(activeId);
      renderTree();
    });
    $(ctx.sidebar, 'tree-filter').addEventListener('input', e => { treeFilter = e.target.value.trim().toLowerCase(); renderTree(); });

    // master password chiesta (o creata) dal dialogo del core, poi la sezione si carica
    async function unlock() { if (await ctx.vault.ensure()) load(); }

    ctx.expose({
      unlock, toggle, toggleFolder, folderMenu, saveFolder, connMenu, dbMenu, collMenu, selectConnection, selectDatabase,
      openCollection, openStructure, connectionDialog, formMode, saveConnection, testConnection, deleteConnection,
      saveVault, lockVault, doImport, useHistory,
      clearHistory() { try { sessionStorage.removeItem(HISTORY_KEY); } catch { /* niente da togliere */ } closeModal(); },
      confirmShellRun() { const f = pendingShell; pendingShell = null; f?.(); },
      applyQuery, queryToEditor, exportMenu, indexDialog, submitCollection, submitRename, submitIndex, dropIndex,
      resetQuery() {
        const p = panel();
        if (!p || p.mode !== 'browse') return;
        Object.assign(p.query, { filter: '', sort: '', projection: '', skip: 0 });
        find();
      },
      page(dir) {
        const p = panel();
        if (!p?.result || p.mode !== 'browse') return;
        p.query.skip = Math.max(0, p.query.skip + dir * p.query.limit);
        find();
      },
      setView(v) {
        viewMode = v;
        try { localStorage.setItem(VIEW_KEY, v); } catch { /* solo per questa sessione */ }
        const p = panel();
        if (p) p.view = v;
        renderResults();
      },
      sortBy(col) {
        const p = panel();
        if (!p) return;
        if (p.mode === 'browse') {
          applyQueryFields(p);
          const cur = safeJson(p.query.sort) || {};
          p.query.sort = JSON.stringify({ [col]: cur[col] === 1 ? -1 : 1 });
          p.query.skip = 0;
          find();
        } else {
          p.sort = { col, dir: p.sort?.col === col ? -p.sort.dir : 1 };
          renderResults();
        }
      },
      select(i, on) { const p = panel(); if (on) p.selected.add(i); else p.selected.delete(i); renderResults(); },
      selectAll(on) {
        const p = panel();
        p.selected = on ? new Set(docsOf(p).map((d, i) => (d._id !== undefined ? i : null)).filter(i => i !== null)) : new Set();
        renderResults();
      },
      deleteSelected: () => deleteIds([...panel().selected]),
      deleteDoc: i => deleteIds([i]),
      editDoc: i => documentDialog(i),
      insertDoc: () => documentDialog(null),
      submitDocument, applyField, saveEdits,
      discardEdits() { const p = panel(); p.pending = new Map(); renderResults(); },
      async copyDoc(i) {
        try { await navigator.clipboard.writeText(JSON.stringify(docsOf(panel())[i], null, 2)); toast(t('docs.copied'), 'success'); }
        catch { toast(t('docs.copyFailed'), 'error'); }
      },
      execute,
      back() { const b = pending?.back; pending = null; b?.(); },
    });

    // ↻ dell'header: connessioni e nodi aperti dell'albero ricaricati
    this.refresh = async () => {
      cache.clear();
      await load();
      for (const k of open) fetchNode(k);
      if (activeId && !open.has(`c|${activeId}`)) fetchNode(`c|${activeId}`);
    };
    this.languageChanged = () => { renderTree(); renderWorkspace(); };
    this.unmount = () => ac.element.remove();
    this.show = () => { if (locked) load(); }; // sbloccato nel frattempo da un'altra sezione
    // aperta da un widget o dalla dashboard: { connection } la seleziona
    this.focus = async params => {
      if (!params?.connection) return;
      if (locked) await load();
      if (connections.some(c => c.id === params.connection)) selectConnection(params.connection);
    };
    await load();
  },
};
