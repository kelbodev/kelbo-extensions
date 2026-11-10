// Monitor: l'output di più processi affiancato — script npm (estensione npm) e script dei
// progetti (estensione script) — con riavvio, arresto e nuovo avvio da ogni riquadro.
// Nessun backend: usa le API che le due estensioni hanno già (/processes, stream, restart).
// I riquadri scelti restano nel browser come "sorgente + progetto + script": un nuovo avvio
// dello stesso script (nuovo processo) prende il posto del precedente nello stesso riquadro.

const POLL_MS = 3000;
const STORE_KEY = 'kelbo.monitor';
const SOURCES = ['npm', 'script'];
const MAX_CHUNKS = 3000; // pezzi di output tenuti in ogni riquadro

export default {
  async mount(ctx) {
    const { esc, js, toast, formatUptime, ansiToHtml, ansiState } = ctx.ui;
    const { t } = ctx;
    const $ = role => ctx.root.querySelector(`[data-role="${role}"]`);

    let procs = [];                 // { src, id, projectId, projectLabel, script, args, running, exitCode, startedAt, ports }
    const panes = new Map();        // chiave → { el, procId, ended, close, ansi, last }
    let state = readState();        // { panes: [chiave], grid: 1..4, max: chiave|null, layout: id|null, args: { chiave: [argomenti] } }
    let projectNames = {};          // id del progetto → nome (per i riquadri senza processo)
    const projectName = info => info.projectLabel || projectNames[info.projectId] || info.projectId || '';
    async function loadProjectNames() {
      try { projectNames = Object.fromEntries((await ctx.projects.load()).projects.map(p => [p.id, p.label])); } catch { /* restano gli id */ }
    }
    let layouts = [];               // layout salvati in config.json: { id, name, grid, panes: [{ src, projectId, script, args? }] }

    // ---- stato nel browser (i layout con nome invece sono in config.json) ----
    function readState() {
      try {
        const s = JSON.parse(localStorage.getItem(STORE_KEY) || 'null');
        if (s && Array.isArray(s.panes)) {
          return {
            panes: s.panes.filter(k => typeof k === 'string').slice(0, 24),
            grid: [1, 2, 3, 4].includes(s.grid) ? s.grid : 2,
            max: typeof s.max === 'string' ? s.max : null,
            layout: typeof s.layout === 'string' ? s.layout : null,
            args: s.args && typeof s.args === 'object' && !Array.isArray(s.args) ? s.args : {},
          };
        }
      } catch { /* niente di salvato */ }
      return { panes: [], grid: 2, max: null, layout: null, args: {} };
    }
    function saveState() {
      try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); } catch { /* solo comodità */ }
    }

    // ---- processi ----
    const sources = () => SOURCES.filter(s => ctx.hasExtension(s));
    const keyOf = p => JSON.stringify([p.src, p.projectId, p.script]);
    const parseKey = k => { try { const [src, projectId, script] = JSON.parse(k); return { src, projectId, script }; } catch { return null; } };
    // processo da mostrare per una chiave: quello in esecuzione, altrimenti il più recente
    function resolve(key) {
      const same = procs.filter(p => keyOf(p) === key);
      return same.find(p => p.running) || same.sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)))[0] || null;
    }
    const label = p => (p.src === 'npm'
      ? (p.script === 'install' ? 'npm install' : p.script.startsWith('update ') ? `npm ${p.script}` : `npm run ${p.script}`)
      : [p.script, ...(p.args || [])].join(' '));

    async function loadProcs() {
      const lists = await Promise.all(sources().map(async src => {
        try { return (await ctx.apiFor(src).get('/processes')).map(p => ({ ...p, src })); } catch { return []; }
      }));
      procs = lists.flat();
    }

    // ---- sidebar: processi per progetto, con la casella del riquadro ----
    function renderSidebar() {
      const list = ctx.sidebar.querySelector('[data-role="list"]');
      if (!sources().length) { list.innerHTML = `<p class="mon-muted mon-pad">${esc(t('sidebar.noSources'))}</p>`; return; }
      // anche i riquadri il cui processo non c'è più (fermato): si possono togliere o riavviare
      const items = new Map(procs.map(p => [keyOf(p), resolve(keyOf(p))]));
      for (const k of state.panes) if (!items.has(k)) { const info = panes.get(k)?.last || parseKey(k); if (info) items.set(k, { ...info, gone: true }); }
      if (!items.size) { list.innerHTML = `<p class="mon-muted mon-pad">${esc(t('sidebar.none'))}</p>`; return; }
      const byProject = new Map();
      for (const [k, p] of items) {
        const name = projectName(p);
        if (!byProject.has(name)) byProject.set(name, []);
        byProject.get(name).push([k, p]);
      }
      ctx.ui.patch(list, [...byProject].sort((a, b) => a[0].localeCompare(b[0])).map(([name, rows]) => `
        <div class="mon-group">${esc(name)}</div>
        ${rows.sort((a, b) => `${a[1].src} ${label(a[1])}`.localeCompare(`${b[1].src} ${label(b[1])}`)).map(([k, p]) => `<label class="mon-item ${state.panes.includes(k) ? 'on' : ''}">
          <input type="checkbox" ${state.panes.includes(k) ? 'checked' : ''} onchange="Ext.monitor.toggle(${js(k)})">
          <span class="mon-dot ${p.running ? 'run' : p.gone ? 'gone' : p.exitCode ? 'err' : 'done'}"></span>
          <span class="mon-src mon-src-${esc(p.src)}">${esc(p.src)}</span>
          <span class="mon-item-name" title="${esc(label(p))}">${esc(label(p))}</span>
        </label>`).join('')}`).join(''));
    }

    // ---- riquadri ----
    // 1, 2, 3 colonne; 4 = due colonne e due righe (oltre il quarto riquadro si scorre)
    const columns = () => (state.grid === 4 ? 2 : state.grid);

    function renderLayout() {
      const n = state.panes.length;
      $('empty').hidden = n > 0;
      $('empty-text').textContent = sources().length ? t('empty') : t('sidebar.noSources');
      $('count').textContent = n ? t('count', { count: n }) : '';
      for (const b of ctx.root.querySelectorAll('[data-grid]')) b.classList.toggle('active', Number(b.dataset.grid) === state.grid);
      const grid = $('grid');
      const maximized = !!(state.max && state.panes.includes(state.max));
      grid.style.setProperty('--mon-cols', maximized ? 1 : columns());
      grid.classList.toggle('maximized', maximized);
      grid.classList.toggle('g4', state.grid === 4 && !maximized);
      renderLayouts();
      // riquadri tolti
      for (const [k, pane] of panes) if (!state.panes.includes(k)) { pane.close?.(); pane.resize?.disconnect(); pane.el.remove(); panes.delete(k); }
      // nuovi riquadri e ordine
      for (const k of state.panes) {
        let pane = panes.get(k);
        if (!pane) {
          const el = document.createElement('section');
          el.className = 'mon-pane';
          el.innerHTML = '<header class="mon-head"></header><div class="mon-body"></div>';
          const body = el.querySelector('.mon-body');
          pane = { el, procId: null, ended: false, close: null, ansi: ansiState(), stick: true, top: 0, last: parseKey(k) };
          // in fondo → segue l'output; spostato più su → resta lì finché non torna in fondo.
          // Nascosto (altra sezione, riquadro ingrandito) il browser azzera la posizione: non conta
          body.addEventListener('scroll', () => {
            if (!body.clientHeight) return;
            pane.stick = body.scrollHeight - body.scrollTop - body.clientHeight < 24;
            pane.top = body.scrollTop;
          });
          // di nuovo visibile o ridimensionato (griglia, finestra): in fondo, o dove l'aveva lasciato
          pane.resize = new ResizeObserver(() => { if (body.clientHeight) placeScroll(pane); });
          pane.resize.observe(body);
          panes.set(k, pane);
        }
        pane.el.classList.toggle('max', state.max === k);
        pane.el.hidden = !!(state.max && state.max !== k && state.panes.includes(state.max));
      }
      // nell'ordine della lista, spostando solo quelli fuori posto (spostare un elemento ne azzera lo scroll)
      state.panes.forEach((k, i) => {
        const pane = panes.get(k);
        if (grid.children[i] !== pane.el) { grid.insertBefore(pane.el, grid.children[i] || null); requestAnimationFrame(() => placeScroll(pane)); }
      });
      for (const k of state.panes) syncPane(k);
    }

    // intestazione e collegamento allo stream del processo giusto
    function syncPane(key) {
      const pane = panes.get(key);
      if (!pane) return;
      const p = resolve(key);
      if (p) {
        pane.last = { src: p.src, projectId: p.projectId, projectLabel: p.projectLabel, script: p.script, args: p.args };
        if (p.src === 'script' && Array.isArray(p.args)) state.args[key] = p.args;
      } else if (pane.last && !pane.last.args && state.args[key]) pane.last.args = state.args[key];
      if (p && (p.id !== pane.procId || (pane.ended && p.running))) connect(pane, p);
      renderHead(key, pane, p);
    }

    function renderHead(key, pane, p) {
      const info = p || pane.last || parseKey(key) || {};
      const status = p ? (p.running ? `<span class="mon-dot run"></span><span class="mon-uptime" data-uptime="${esc(p.startedAt)}">${esc(formatUptime(p.startedAt))}</span>`
        : `<span class="mon-dot ${p.exitCode ? 'err' : 'done'}"></span><span class="mon-muted">${esc(t('exited', { code: String(p.exitCode ?? '?') }))}</span>`)
        : `<span class="mon-dot gone"></span><span class="mon-muted">${esc(t('notRunning'))}</span>`;
      const k = js(key);
      const canRun = info.src && sources().includes(info.src) && !(info.src === 'npm' && String(info.script).startsWith('update '));
      ctx.ui.patch(pane.el.querySelector('.mon-head'), `
        <span class="mon-src mon-src-${esc(info.src || '')}">${esc(info.src || '')}</span>
        <span class="mon-title" title="${esc(`${projectName(info)} · ${label(info)}`)}"><strong>${esc(projectName(info))}</strong> ${esc(label(info))}</span>
        ${status}
        ${(p?.running ? p.ports || [] : []).map(port => `<span class="mon-port">:${esc(port)}</span>`).join('')}
        <span class="mon-actions">
          ${p?.running ? `
            <button class="btn btn-ghost btn-sm" onclick="Ext.monitor.restart(${k})" title="${esc(t('action.restart'))}"><i data-icon="rotate-ccw"></i></button>
            <button class="btn btn-ghost btn-sm mon-stop" onclick="Ext.monitor.stop(${k})" title="${esc(t('action.stop'))}"><i data-icon="square"></i></button>`
            : canRun ? `<button class="btn btn-ghost btn-sm" onclick="Ext.monitor.run(${k})" title="${esc(t('action.run'))}"><i data-icon="play"></i></button>` : ''}
          <button class="btn btn-ghost btn-sm" onclick="Ext.monitor.clear(${k})" title="${esc(t('action.clear'))}"><i data-icon="eraser"></i></button>
          <button class="btn btn-ghost btn-sm" onclick="Ext.monitor.max(${k})" title="${esc(t(state.max === key ? 'action.restore' : 'action.maximize'))}"><i data-icon="${state.max === key ? 'minimize-2' : 'maximize-2'}"></i></button>
          <button class="btn btn-ghost btn-sm" onclick="Ext.monitor.toggle(${k})" title="${esc(t('action.close'))}"><i data-icon="x"></i></button>
        </span>`);
    }

    function append(pane, text, cls = '') {
      const body = pane.el.querySelector('.mon-body');
      const span = document.createElement('span');
      if (cls) span.className = cls;
      if (cls === 'mon-sys') span.textContent = text;
      else span.innerHTML = ansiToHtml(text, pane.ansi);
      body.appendChild(span);
      while (body.childNodes.length > MAX_CHUNKS) body.firstChild.remove();
      if (pane.stick && body.clientHeight) body.scrollTop = body.scrollHeight;
    }

    function placeScroll(pane) {
      const body = pane.el.querySelector('.mon-body');
      body.scrollTop = pane.stick ? body.scrollHeight : pane.top;
    }

    // nuovo processo (o lo stesso riavviato dopo la fine): l'output riparte dallo storico
    function connect(pane, p) {
      pane.close?.();
      pane.procId = p.id; pane.ended = false; pane.ansi = ansiState(); pane.stick = true;
      pane.el.querySelector('.mon-body').innerHTML = '';
      const close = ctx.apiFor(p.src).events(`/processes/${encodeURIComponent(p.id)}/stream`, ({ type, data }) => {
        if (pane.close !== close) return;
        if (type === 'history' || type === 'stdout' || type === 'stderr') append(pane, data);
        else if (type === 'exit') {
          pane.ended = true;
          append(pane, `\n${data?.removed ? t('stream.removed') : t('stream.exit', { code: String(data?.exitCode ?? '?') })}\n`, 'mon-sys');
          refresh();
        }
      }, () => { if (pane.close === close && !pane.ended) { pane.ended = true; append(pane, `\n${t('stream.lost')}\n`, 'mon-sys'); } });
      pane.close = close;
    }

    async function refresh() {
      await loadProcs();
      renderSidebar();
      renderLayout();
    }

    // ---- azioni ----
    const paneProc = key => resolve(key);
    async function call(fn, okText) {
      try { await fn(); if (okText) toast(okText, 'success'); }
      catch (e) { toast(e.message, 'error'); }
      await refresh();
    }

    // ---- layout salvati: griglia e riquadri con i loro script ----
    async function loadLayouts() {
      try { layouts = (await ctx.api.get('/layouts')).layouts; } catch { layouts = []; }
      if (state.layout && !layouts.some(l => l.id === state.layout)) { state.layout = null; saveState(); }
    }
    const currentPanes = () => state.panes.map(k => {
      const info = parseKey(k);
      return info && { ...info, ...(info.src === 'script' ? { args: state.args[k] || panes.get(k)?.last?.args || [] } : {}) };
    }).filter(Boolean);
    const sameAs = l => l && l.grid === state.grid && JSON.stringify(l.panes.map(p => keyOf(p))) === JSON.stringify(state.panes);

    function renderLayouts() {
      const sel = $('layouts');
      if (!sel) return;
      const cur = layouts.find(l => l.id === state.layout);
      const changed = cur && !sameAs(cur);
      sel.innerHTML = `<option value="">${esc(t('layouts.unsaved'))}</option>`
        + layouts.map(l => `<option value="${esc(l.id)}" ${l.id === state.layout ? 'selected' : ''}>${esc(l.name)}${l.id === state.layout && changed ? ' •' : ''}</option>`).join('');
      // Salva: aggiorna il layout scelto se è cambiato; senza layout scelto ne crea uno (chiede il nome)
      const save = $('layout-save');
      save.disabled = cur ? !changed : !state.panes.length;
      save.title = t(cur ? (changed ? 'layouts.save' : 'layouts.saveNoChanges') : (state.panes.length ? 'layouts.saveNew' : 'layouts.empty'));
      $('layout-delete').disabled = !cur;
      $('start-stopped').disabled = !state.panes.some(k => !resolve(k)?.running);
    }

    async function applyLayout(id) {
      await loadProcs(); // processi aggiornati: niente riquadri collegati a processi già fermati
      const l = layouts.find(x => x.id === id);
      if (!l) { state.layout = null; saveState(); renderLayouts(); return; }
      state.panes = l.panes.map(p => keyOf(p));
      state.args = Object.fromEntries(l.panes.filter(p => p.src === 'script').map(p => [keyOf(p), p.args || []]));
      state.grid = l.grid; state.max = null; state.layout = l.id;
      saveState(); renderSidebar(); renderLayout();
      const stopped = state.panes.filter(k => !resolve(k)?.running).length;
      if (stopped) toast(t('layouts.stoppedHint', { count: stopped }), 'info');
    }

    async function saveLayout() {
      const cur = layouts.find(l => l.id === state.layout);
      if (!cur) return layoutDialog();
      try {
        await ctx.api.put(`/layouts/${encodeURIComponent(cur.id)}`, { name: cur.name, grid: state.grid, panes: currentPanes() });
        await loadLayouts(); renderLayouts();
        toast(t('layouts.saved', { name: cur.name }), 'success');
      } catch (e) { toast(e.message, 'error'); }
    }

    function layoutDialog() {
      if (!state.panes.length) { toast(t('layouts.empty'), 'error'); return; }
      ctx.ui.openModal(t('layouts.saveAsTitle'), `
        <label class="mon-field"><span>${esc(t('layouts.name'))}</span>
          <input id="mon_layout_name" type="text" maxlength="80" placeholder="${esc(t('layouts.namePlaceholder'))}" onkeydown="if(event.key==='Enter')Ext.monitor.confirmSaveAs()"></label>
        <p class="mon-muted">${esc(t('layouts.saveAsHint', { count: state.panes.length }))}</p>`,
      `<button class="btn btn-ghost" onclick="UI.closeModal()">${esc(t('core.action.cancel'))}</button>
       <button class="btn btn-primary" onclick="Ext.monitor.confirmSaveAs()">${esc(t('core.action.save'))}</button>`);
      setTimeout(() => document.getElementById('mon_layout_name')?.focus(), 50);
    }
    async function confirmSaveAs() {
      const name = (document.getElementById('mon_layout_name')?.value || '').trim();
      if (!name) { toast(t('layouts.nameRequired'), 'error'); return; }
      try {
        const l = await ctx.api.put('/layouts/new', { name, grid: state.grid, panes: currentPanes() });
        state.layout = l.id; saveState();
        ctx.ui.closeModal();
        await loadLayouts(); renderLayouts();
        toast(t('layouts.saved', { name }), 'success');
      } catch (e) { toast(e.message, 'error'); }
    }

    function deleteLayout() {
      const cur = layouts.find(l => l.id === state.layout);
      if (!cur) return;
      ctx.ui.openModal(t('layouts.deleteTitle'), `<p>${esc(t('layouts.deleteConfirm', { name: cur.name }))}</p>`,
        `<button class="btn btn-ghost" onclick="UI.closeModal()">${esc(t('core.action.cancel'))}</button>
         <button class="btn btn-danger" onclick="Ext.monitor.confirmDelete()">${esc(t('core.action.delete'))}</button>`);
    }
    async function confirmDelete() {
      try {
        await ctx.api.del(`/layouts/${encodeURIComponent(state.layout)}`);
        ctx.ui.closeModal();
        state.layout = null; saveState();
        await loadLayouts(); renderLayouts();
      } catch (e) { toast(e.message, 'error'); }
    }

    const actions = {
      toggle(key) {
        if (state.panes.includes(key)) {
          delete state.args[key];
          state.panes = state.panes.filter(k => k !== key);
          if (state.max === key) state.max = null;
        } else state.panes = [...state.panes, key].slice(-24);
        saveState(); renderSidebar(); renderLayout();
      },
      addRunning() {
        const running = [...new Set(procs.filter(p => p.running).map(keyOf))];
        state.panes = [...state.panes, ...running.filter(k => !state.panes.includes(k))].slice(-24);
        saveState(); renderSidebar(); renderLayout();
      },
      closeAll() { state.panes = []; state.args = {}; state.max = null; saveState(); renderSidebar(); renderLayout(); },
      grid(n) { state.grid = n; saveState(); renderLayout(); },
      layout: applyLayout,
      saveLayout,
      saveLayoutAs: () => layoutDialog(),
      confirmSaveAs,
      deleteLayout,
      confirmDelete,
      async startStopped() {
        const stopped = state.panes.filter(k => !resolve(k)?.running);
        for (const k of stopped) await actions.run(k, true);
        await refresh();
      },
      max(key) { state.max = state.max === key ? null : key; saveState(); renderLayout(); },
      clear(key) { const pane = panes.get(key); if (pane) { pane.el.querySelector('.mon-body').innerHTML = ''; pane.ansi = ansiState(); } },
      restart(key) {
        const p = paneProc(key);
        if (p) call(() => ctx.apiFor(p.src).post(`/processes/${encodeURIComponent(p.id)}/restart`), t('toast.restarted', { name: label(p) }));
      },
      stop(key) {
        const p = paneProc(key);
        if (p) call(() => ctx.apiFor(p.src).del(`/processes/${encodeURIComponent(p.id)}`), t('toast.stopped', { name: label(p) }));
      },
      // di nuovo: lo stesso processo terminato se c'è ancora (stessi argomenti), altrimenti un avvio nuovo
      run(key, quiet = false) {
        const p = paneProc(key);
        const info = p || panes.get(key)?.last || parseKey(key);
        if (!info?.src || !sources().includes(info.src)) return Promise.resolve();
        const api = ctx.apiFor(info.src);
        const args = info.args || state.args[key] || [];
        return call(() => (p ? api.post(`/processes/${encodeURIComponent(p.id)}/restart`)
          : api.post(`/projects/${encodeURIComponent(info.projectId)}/run`, info.src === 'npm' ? { script: info.script } : { script: info.script, args })),
        quiet ? null : t('toast.started', { name: label(info) }));
      },
    };
    ctx.expose(actions);

    // durata dei processi aggiornata ogni secondo, senza ridisegnare
    const timers = [
      setInterval(() => {
        if (!ctx.isActive()) return;
        for (const el of ctx.root.querySelectorAll('[data-uptime]')) el.textContent = formatUptime(el.dataset.uptime);
      }, 1000),
      // nuovi processi, stati e porte: solo con la sezione aperta (l'output arriva comunque dagli stream)
      setInterval(() => { if (ctx.isActive()) refresh(); }, POLL_MS),
    ];

    this.show = async () => { await loadLayouts(); await refresh(); };
    this.languageChanged = () => { renderSidebar(); renderLayout(); };
    this.unmount = () => { timers.forEach(clearInterval); for (const pane of panes.values()) { pane.close?.(); pane.resize?.disconnect(); } panes.clear(); };
    ctx.bus.on('core:projects-changed', async () => { await loadProjectNames(); renderSidebar(); renderLayout(); });
    await loadProjectNames();
    await loadLayouts();
    await refresh();
  },
};
