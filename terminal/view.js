// Terminale: una tab per sessione (xterm.js), input mandato in ordine, ridimensionamento che
// segue il pannello, colori dal tema di Kelbo (variabili --terminal-* e --ansi-*). Le sessioni
// vivono nel backend: ricaricando la pagina ci si ricollega e l'output recente si rivede.

const FONT_KEY = 'kelbo.terminal.font';
const ANSI = ['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white'];

export default {
  async mount(ctx) {
    const { esc, js, toast } = ctx.ui;
    const { t } = ctx;
    const $ = (root, role) => root.querySelector(`[data-role="${role}"]`);
    const store = { get: (k, d) => { try { return localStorage.getItem(k) ?? d; } catch { return d; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* solo ora */ } } };

    // xterm.js dal backend dell'estensione (stesso server: CSP rispettata, niente CDN)
    if (!document.getElementById('kelbo-xterm-css')) {
      const link = document.createElement('link');
      link.id = 'kelbo-xterm-css'; link.rel = 'stylesheet'; link.href = '/api/ext/terminal/vendor/xterm.css';
      document.head.appendChild(link);
    }
    const [{ Terminal }, { FitAddon }] = await Promise.all([import('/api/ext/terminal/vendor/xterm.mjs'), import('/api/ext/terminal/vendor/addon-fit.mjs')]);

    let info = { available: false, shells: [] };
    const sessions = new Map(); // id → { info, term, fit, el, closeStream, queue, sending }
    let active = null;
    let fontSize = Math.min(24, Math.max(9, Number(store.get(FONT_KEY, 13)) || 13));

    // colori dal tema attivo
    function theme() {
      const cs = getComputedStyle(document.documentElement);
      const v = name => cs.getPropertyValue(name).trim();
      const th = { background: v('--terminal-bg') || '#0d1117', foreground: v('--terminal-text') || '#e6edf3', cursor: v('--accent') || '#388bfd', selectionBackground: 'rgba(56,139,253,.35)' };
      for (const c of ANSI) {
        const cap = c[0].toUpperCase() + c.slice(1);
        th[c] = v(`--ansi-${c}`) || undefined;
        th[`bright${cap}`] = v(`--ansi-bright-${c}`) || undefined;
      }
      return th;
    }
    const fontFamily = () => getComputedStyle(document.documentElement).getPropertyValue('--font').trim() || 'ui-monospace, Menlo, Consolas, monospace';

    // ---- sessioni ----
    function attach(si) {
      if (sessions.has(si.id)) return sessions.get(si.id);
      const el = document.createElement('div');
      el.className = 'term-pane';
      el.hidden = true;
      $(ctx.root, 'area').appendChild(el);
      const term = new Terminal({ fontSize, fontFamily: fontFamily(), theme: theme(), cursorBlink: true, scrollback: 5000, allowProposedApi: false, macOptionIsMeta: true });
      const fit = new FitAddon();
      term.loadAddon(fit);
      term.open(el);
      const s = { info: si, term, fit, el, closeStream: null, queue: '', sending: false, resizeTimer: null };
      sessions.set(si.id, s);
      // input in ordine: una richiesta alla volta, quello scritto nel frattempo va nella successiva
      const pump = async () => {
        if (s.sending || !s.queue) return;
        s.sending = true;
        const data = s.queue; s.queue = '';
        try { await ctx.api.post(`/sessions/${encodeURIComponent(si.id)}/input`, { data }); } catch (e) { if (e.status === 404) markGone(s); }
        s.sending = false;
        if (s.queue) pump();
      };
      term.onData(d => { if (s.info.exited) return; s.queue += d; pump(); });
      term.onResize(({ cols, rows }) => {
        clearTimeout(s.resizeTimer);
        s.resizeTimer = setTimeout(() => ctx.api.post(`/sessions/${encodeURIComponent(si.id)}/resize`, { cols, rows }).catch(() => {}), 80);
      });
      // copia e incolla anche con Ctrl+Shift+C / Ctrl+Shift+V (Linux e Windows)
      term.attachCustomKeyEventHandler(ev => {
        if (ev.type !== 'keydown' || !ev.ctrlKey || !ev.shiftKey) return true;
        if (ev.code === 'KeyC') { const sel = term.getSelection(); if (sel) navigator.clipboard?.writeText(sel); return false; }
        if (ev.code === 'KeyV') { navigator.clipboard?.readText().then(text => term.paste(text)).catch(() => {}); return false; }
        return true;
      });
      s.closeStream = ctx.api.events(`/sessions/${encodeURIComponent(si.id)}/stream`, ev => {
        if (ev.type === 'data') term.write(ev.data);
        else if (ev.type === 'init') { s.info = ev.data; renderTabs(); }
        else if (ev.type === 'exit') {
          s.info.exited = true; s.info.exitCode = ev.data;
          term.write(`\r\n\x1b[2m[${t('exited', { code: ev.data ?? '?' })}]\x1b[0m\r\n`);
          renderTabs();
        } else if (ev.type === 'closed') markGone(s);
      }, () => { s.closeStream = null; });
      return s;
    }
    function markGone(s) {
      s.closeStream?.(); s.term.dispose(); s.el.remove();
      sessions.delete(s.info.id);
      if (active === s.info.id) active = [...sessions.keys()].at(-1) || null;
      render();
    }
    async function open({ projectId = null, shell = null, command = null } = {}) {
      try {
        const area = $(ctx.root, 'area');
        // dimensioni iniziali stimate dall'area (poi il fit le corregge)
        const cols = Math.max(20, Math.floor((area.clientWidth - 16) / (fontSize * 0.6))), rows = Math.max(5, Math.floor((area.clientHeight - 6) / (fontSize * 1.2)));
        const r = await ctx.api.post('/sessions', { projectId, shell, cols, rows, command });
        const s = attach(r.session);
        select(s.info.id);
      } catch (e) { toast(e.message, 'error'); }
    }
    function select(id) {
      active = id;
      render();
      const s = sessions.get(id);
      if (s) requestAnimationFrame(() => { try { s.fit.fit(); } catch { /* pannello nascosto */ } s.term.focus(); });
    }
    async function closeSession(id) {
      const s = sessions.get(id);
      if (!s) return;
      if (!s.info.exited && !confirm(t('closeRunning', { title: s.info.title }))) return;
      try { await ctx.api.post(`/sessions/${encodeURIComponent(id)}/close`, {}); } catch { /* già chiusa */ }
      markGone(s);
    }

    // ---- interfaccia ----
    function renderTabs() {
      ctx.ui.patch($(ctx.root, 'tabs'), [...sessions.values()].map(s => `
        <div class="term-tab ${s.info.id === active ? 'active' : ''} ${s.info.exited ? 'exited' : ''}" role="tab" tabindex="0"
             onclick="Ext.terminal.select(${js(s.info.id)})" ondblclick="Ext.terminal.rename(${js(s.info.id)})" title="${esc(`${s.info.cwd}\n${t('renameTitle')}`)}">
          ${ctx.ui.icon('square-terminal')}<span class="term-tab-title">${esc(s.info.title)}</span>
          <button class="term-tab-close" onclick="event.stopPropagation();Ext.terminal.close(${js(s.info.id)})" title="${esc(t('closeTab'))}">${ctx.ui.icon('x')}</button>
        </div>`).join(''));
      ctx.setBadge(sessions.size || null);
    }
    function render() {
      renderTabs();
      for (const s of sessions.values()) s.el.hidden = s.info.id !== active;
      $(ctx.root, 'empty').hidden = sessions.size > 0 || !info.available;
      renderSidebar();
    }
    async function renderSidebar() {
      let projects = [];
      try { projects = (await ctx.projects.load()).projects || []; } catch { /* nessun progetto */ }
      const count = id => [...sessions.values()].filter(s => s.info.projectId === id && !s.info.exited).length;
      const row = (id, icon, label, sub) => `<div class="sb-item" role="button" tabindex="0" onclick="Ext.terminal.openIn(${js(id)})" onkeydown="if(event.key==='Enter')Ext.terminal.openIn(${js(id)})">
          <span class="sb-icon">${ctx.ui.icon(icon)}</span><span class="sb-label">${esc(label)}${sub ? `<span class="term-proj-path">${esc(sub)}</span>` : ''}</span>
          ${count(id) ? `<span class="term-sb-count">${count(id)}</span>` : ''}</div>`;
      ctx.ui.patch($(ctx.sidebar, 'projects'), row(null, 'house', t('sidebar.home'), info.home)
        + (projects.length ? projects.map(p => row(p.id, 'folder', p.label, p.path)).join('') : `<p class="sb-muted" style="padding:8px 14px;font-size:12px">${esc(t('sidebar.noProjects'))}</p>`));
    }
    function applyFont() {
      store.set(FONT_KEY, String(fontSize));
      for (const s of sessions.values()) { s.term.options.fontSize = fontSize; if (!s.el.hidden) { try { s.fit.fit(); } catch { /* nascosto */ } } }
    }
    function applyTheme() { const th = theme(); for (const s of sessions.values()) s.term.options.theme = th; }

    // il pannello cambia dimensione (finestra, sidebar, pannello di output): la shell lo sa
    const ro = new ResizeObserver(() => { const s = sessions.get(active); if (s && !s.el.hidden) { try { s.fit.fit(); } catch { /* nascosto */ } } });
    ro.observe($(ctx.root, 'area'));
    // tema cambiato dall'header: i colori seguono
    const mo = new MutationObserver(() => setTimeout(applyTheme, 50));
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

    const actions = {
      select,
      close: closeSession,
      openIn: projectId => open({ projectId }),
      async rename(id) {
        const s = sessions.get(id);
        const title = s && prompt(t('renamePrompt'), s.info.title);
        if (!title) return;
        try { s.info = (await ctx.api.post(`/sessions/${encodeURIComponent(id)}/rename`, { title })).session; renderTabs(); } catch (e) { toast(e.message, 'error'); }
      },
    };
    ctx.root.addEventListener('click', e => {
      const a = e.target.closest('[data-action]')?.dataset.action;
      if (!a) return;
      if (a === 'new') {
        // più shell: si sceglie; una sola: si apre
        if (info.shells.length < 2 || e.target.closest('.empty-state')) { open({ projectId: sessions.get(active)?.info.projectId ?? null }); return; }
        const r = e.target.closest('button').getBoundingClientRect();
        ctx.ui.contextMenu(r.left, r.bottom + 4, info.shells.map(sh => ({ icon: 'square-terminal', label: `${sh.name} · ${sh.path}`, action: () => open({ projectId: sessions.get(active)?.info.projectId ?? null, shell: sh.path }) })));
      } else if (a === 'font-up') { fontSize = Math.min(24, fontSize + 1); applyFont(); }
      else if (a === 'font-down') { fontSize = Math.max(9, fontSize - 1); applyFont(); }
      else if (a === 'clear') sessions.get(active)?.term.clear();
    });

    ctx.expose(actions);
    try { info = await ctx.api.get('/info'); } catch (e) { info = { available: false, error: e.message, shells: [] }; }
    if (!info.available) {
      const n = $(ctx.root, 'notice');
      n.hidden = false;
      n.innerHTML = `${ctx.ui.icon('triangle-alert')} ${esc(t('missing', { error: info.error || '' }))}`;
    }
    try { for (const si of (await ctx.api.get('/sessions')).sessions) attach(si); } catch { /* nessuna sessione */ }
    active = [...sessions.keys()].at(-1) || null;
    render();
    if (active) select(active);

    this.show = () => { applyTheme(); const s = sessions.get(active); if (s) requestAnimationFrame(() => { try { s.fit.fit(); } catch { /* nascosto */ } s.term.focus(); }); };
    // aperta da altre estensioni: { project, command } apre una shell nel progetto ed esegue il comando
    this.focus = async params => {
      if (params?.project !== undefined || params?.command) await open({ projectId: params.project ?? null, command: params.command ?? null });
    };
    this.refresh = async () => { renderSidebar(); };
    this.languageChanged = () => render();
    this.unmount = () => {
      ro.disconnect(); mo.disconnect();
      for (const s of sessions.values()) { s.closeStream?.(); s.term.dispose(); }
      sessions.clear();
    };
  },
};
