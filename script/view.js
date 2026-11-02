// Script: progetti con cartelle di script nella sidebar, script raggruppati per cartella con
// l'interprete, avvio (anche con argomenti), output nel pannello in basso, arresto e riavvio,
// pill nell'header per quelli in esecuzione. Montato all'avvio (preload) per pill e badge.

const POLL_MS = 5000;

// "a 'b c' \"d\"" → ['a', 'b c', 'd'] (virgolette semplici e doppie, \ per il carattere dopo)
export function splitArgs(text) {
  const out = [];
  let cur = '', quote = null, any = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '\\' && i + 1 < text.length && quote !== "'") { cur += text[++i]; any = true; continue; }
    if (quote) { if (c === quote) quote = null; else cur += c; continue; }
    if (c === '"' || c === "'") { quote = c; any = true; continue; }
    if (/\s/.test(c)) { if (any) { out.push(cur); cur = ''; any = false; } continue; }
    cur += c; any = true;
  }
  if (any) out.push(cur);
  return out;
}

export default {
  async mount(ctx) {
    const { esc, js, toast, openModal, closeModal, output, formatUptime, fmt } = ctx.ui;
    const { t } = ctx;
    const $ = (root, role) => root.querySelector(`[data-role="${role}"]`);

    let projects = [];
    let folders = [];
    let hidden = 0;      // progetti senza cartelle di script, solo nel pannello 📁
    let processes = [];
    let activeProject = null;
    let data = null;     // { folders, scripts } del progetto scelto
    let filter = '';
    let closeStream = null;
    let following = null; // processo mostrato nel pannello di output (riaperto al ritorno)

    const project = () => projects.find(p => p.id === activeProject) || null;
    const runningIn = id => processes.filter(pr => pr.projectId === id && pr.running).length;
    const label = (script, args = []) => [script, ...args.map(a => (/\s/.test(a) || !a ? JSON.stringify(a) : a))].join(' ');

    // ---- dati ----
    async function loadProjects() {
      try { ({ projects, folders, hidden } = await ctx.projects.load()); } catch { projects = []; folders = []; hidden = 0; }
      if (activeProject && !project()) { activeProject = null; data = null; }
    }

    async function loadProcesses() {
      try { processes = await ctx.api.get('/processes'); } catch { return; }
      renderPills();
      const n = processes.filter(p => p.running).length;
      ctx.setBadge(n ? `${fmt.number(n)}▶` : null);
    }

    async function loadScripts() {
      const p = project();
      if (!p) { data = null; return; }
      try { data = await ctx.api.get(`/projects/${encodeURIComponent(p.id)}/scripts`); }
      catch (e) { data = { folders: [], scripts: [] }; toast(e.message, 'error'); }
    }

    // ---- header ----
    function renderPills() {
      ctx.setPills(processes.filter(p => p.running).map(p => `
        <span class="pill pill-script" onclick="Ext.script.open(${js(p.projectId)},${js(p.id)})" title="${esc(p.projectLabel)} — ${esc(label(p.script, p.args))}">
          <span class="pill-dot"></span>${esc(p.projectLabel)}<span class="pill-sub"> ${esc(p.script.split('/').pop())}</span>
          <span class="pill-close" onclick="event.stopPropagation();Ext.script.stop(${js(p.id)})" title="${esc(t('stop'))}">✕</span>
        </span>`).join(''));
    }

    // ---- sidebar ----
    function renderProjects() {
      const el = $(ctx.sidebar, 'projects');
      if (!projects.length) {
        ctx.ui.patch(el, `<p class="scr-muted scr-pad">${esc(t('sidebar.none'))}</p>${ctx.projects.hiddenNote(hidden)}`);
        return;
      }
      ctx.ui.patch(el, ctx.projects.tree(folders, projects, p => {
        const n = runningIn(p.id);
        return `<div class="sb-item ${activeProject === p.id ? 'active' : ''}" role="button" tabindex="0"
             onclick="Ext.script.select(${js(p.id)})" onkeydown="if(event.key==='Enter')Ext.script.select(${js(p.id)})">
          <span class="sb-icon">${n ? '🟢' : '📜'}</span><span class="scr-proj-label">${esc(p.label)}</span>
          ${n ? `<span class="scr-run-count">▶${esc(fmt.number(n))}</span>` : ''}
        </div>`;
      }) + ctx.projects.hiddenNote(hidden));
    }

    // ---- pannello ----
    function renderHeader() {
      const p = project();
      $(ctx.root, 'empty').hidden = !!p;
      $(ctx.root, 'project').hidden = !p;
      if (!p) return false;
      $(ctx.root, 'title').textContent = p.label;
      $(ctx.root, 'path').textContent = p.path;
      const n = runningIn(p.id);
      $(ctx.root, 'running').textContent = n ? t('running', { count: n }) : '';
      return true;
    }

    function row(s) {
      const p = project();
      const procs = processes.filter(pr => pr.projectId === p.id && pr.script === s.id);
      const live = procs.find(pr => pr.running);
      const last = live || procs[procs.length - 1];
      const disabled = s.available ? '' : `disabled title="${esc(t('missing', { command: s.missing }))}"`;
      return `<div class="scr-row ${live ? 'running' : ''} ${s.available ? '' : 'scr-unavailable'}">
        ${live ? `<span class="proc-dot" title="${esc(t('runningPid', { pid: String(live.pid) }))}"></span>`
          : last ? `<span class="proc-dot ${last.exitCode === 0 ? 'ok' : 'dead'}" title="${esc(t('exited', { code: String(last.exitCode) }))}"></span>` : '<span class="proc-dot none"></span>'}
        <span class="scr-name" title="${esc(s.id)}">${esc(s.name)}</span>
        <span class="scr-runner scr-kind-${esc(s.kind)}">${esc(s.runner)}</span>
        ${live ? `<span class="scr-args">${esc(live.args.length ? label('', live.args).trim() : '')}</span>
          <span class="proc-uptime">${esc(formatUptime(live.startedAt))}</span>` : `<span class="scr-args">${s.available ? '' : esc(t('missing', { command: s.missing }))}</span>`}
        <div class="scr-actions">
          ${last ? `<button class="btn btn-ghost btn-sm" onclick="Ext.script.logs(${js(last.id)})" title="${esc(t('output'))}">📋</button>` : ''}
          ${live ? `
            <button class="btn btn-ghost btn-sm" onclick="Ext.script.restart(${js(live.id)})" title="${esc(t('restart'))}">↺</button>
            <button class="btn btn-disconnect btn-sm" onclick="Ext.script.stop(${js(live.id)})" title="${esc(t('stop'))}">⏹</button>
          ` : `
            <button class="btn btn-ghost btn-sm" onclick="Ext.script.askArgs(${js(s.id)})" ${disabled || `title="${esc(t('runWithArgs'))}"`}>▶…</button>
            <button class="btn btn-script btn-sm" onclick="Ext.script.run(${js(s.id)})" ${disabled}>▶ ${esc(t('run'))}</button>
            ${last ? `<button class="btn btn-ghost btn-sm" onclick="Ext.script.dismiss(${js(last.id)})" title="${esc(t('dismiss'))}">✕</button>` : ''}
          `}
        </div>
      </div>`;
    }

    function renderContent() {
      if (!renderHeader()) return;
      const el = $(ctx.root, 'content');
      if (!data) { ctx.ui.patch(el, `<p class="scr-muted">${esc(t('loading'))}</p>`); return; }
      const q = filter.trim().toLowerCase();
      const shown = data.scripts.filter(s => !q || s.id.toLowerCase().includes(q));
      if (!data.scripts.length) { ctx.ui.patch(el, `<p class="scr-muted">${esc(t(data.folders.length ? 'noneInFolders' : 'noFolders', { folders: data.folders.join(', ') }))}</p>`); return; }
      if (!shown.length) { ctx.ui.patch(el, `<p class="scr-muted">${esc(t('noMatch'))}</p>`); return; }
      const groups = [...new Set(shown.map(s => s.folder))];
      ctx.ui.patch(el, groups.map(g => `
        <div class="scr-group">
          <div class="scr-group-title">📁 ${esc(g)}/ <span class="scr-count">${esc(fmt.number(shown.filter(s => s.folder === g).length))}</span></div>
          ${shown.filter(s => s.folder === g).map(row).join('')}
        </div>`).join(''));
    }

    // ---- output nel pannello in basso ----
    function stream(procId) {
      const pd = processes.find(x => x.id === procId);
      closeStream?.();
      following = { procId };
      output.open(pd ? `${pd.projectLabel} · ${label(pd.script, pd.args)}` : t('output'));
      closeStream = ctx.api.events(`/processes/${encodeURIComponent(procId)}/stream`, ({ type, data: d }) => {
        if (type === 'exit') {
          const text = d?.removed ? t('stream.removed') : d?.ended ? t('stream.ended', { code: String(d.exitCode) }) : `[exit ${d?.exitCode}]`;
          output.append(`\n${text}`, 'sys');
          closeStream?.(); closeStream = null;
          following = null;
          refreshAll();
        } else output.append(d, type === 'stderr' ? 'err' : 'out');
      }, () => output.append('\n' + t('stream.lost'), 'err'));
    }

    async function refreshAll() {
      await loadProcesses();
      renderProjects();
      if (ctx.isActive()) renderContent();
    }

    async function choose(id) {
      activeProject = id;
      data = null;
      renderProjects(); renderContent();
      await loadScripts();
      if (activeProject === id) renderContent();
    }

    // ---- azioni (handler inline) ----
    const actions = {
      async open(projectId, procId) {
        ctx.open(ctx.code);
        if (projectId && projectId !== activeProject) await choose(projectId);
        if (procId) stream(procId);
      },
      select: id => choose(id),

      async run(script, args = []) {
        const p = project();
        if (!p) return;
        try {
          const r = await ctx.api.post(`/projects/${encodeURIComponent(p.id)}/run`, { script, args });
          await refreshAll();
          stream(r.id);
        } catch (e) { toast(e.message, 'error'); }
      },
      askArgs(script) {
        const key = `kelbo.script.args.${activeProject}.${script}`;
        let last = '';
        try { last = localStorage.getItem(key) || ''; } catch { /* solo per questa sessione */ }
        openModal(t('argsTitle', { script }), `
          <div class="form-row"><label>${esc(t('argsLabel'))}</label>
            <input class="form-input scr-args-input" id="scr_args" value="${esc(last)}" placeholder="--verbose 'two words'"
                   onkeydown="if(event.key==='Enter')Ext.script.runWithArgs(${js(script)})"></div>
          <p class="scr-muted">${esc(t('argsHint'))}</p>`,
          `<button class="btn btn-ghost" onclick="UI.closeModal()">${esc(t('core.action.cancel'))}</button>
           <button class="btn btn-script" onclick="Ext.script.runWithArgs(${js(script)})">▶ ${esc(t('run'))}</button>`);
        document.getElementById('scr_args')?.focus();
      },
      runWithArgs(script) {
        const text = document.getElementById('scr_args')?.value || '';
        try { localStorage.setItem(`kelbo.script.args.${activeProject}.${script}`, text); } catch { /* niente */ }
        closeModal();
        return actions.run(script, splitArgs(text));
      },
      async stop(procId) {
        try {
          await ctx.api.del(`/processes/${encodeURIComponent(procId)}`);
          toast(t('toast.stopped'), 'success');
          await refreshAll();
        } catch (e) { toast(e.message, 'error'); }
      },
      async restart(procId) {
        try {
          await ctx.api.post(`/processes/${encodeURIComponent(procId)}/restart`);
          await refreshAll();
          stream(procId);
        } catch (e) { toast(e.message, 'error'); }
      },
      async dismiss(procId) {
        try {
          await ctx.api.del(`/processes/${encodeURIComponent(procId)}/dismiss`);
          await refreshAll();
        } catch (e) { toast(e.message, 'error'); }
      },
      logs: procId => stream(procId),
    };

    ctx.sidebar.addEventListener('click', e => {
      if (e.target.closest('[data-action="manage-projects"]')) ctx.projects.openPanel();
      if (e.target.closest('[data-action="reload"]')) this.refresh();
    });
    $(ctx.root, 'filter').addEventListener('input', e => { filter = e.target.value; renderContent(); });

    ctx.bus.on('core:projects-changed', async () => { await loadProjects(); renderProjects(); renderContent(); });
    ctx.expose(actions);
    await loadProjects();
    await loadProcesses();
    setInterval(refreshAll, POLL_MS);

    this.show = async () => {
      if (following && !closeStream) stream(following.procId);
      await loadProjects(); renderProjects();
      if (activeProject) await loadScripts();
      renderContent();
    };
    this.hide = () => { closeStream?.(); closeStream = null; };
    this.refresh = async () => { await loadProjects(); await loadScripts(); await refreshAll(); };
    // aperta da altre sezioni: { project } sceglie il progetto, { process } ne mostra l'output
    this.focus = async params => {
      if (params?.project && projects.some(p => p.id === params.project)) await choose(params.project);
      if (params?.process) { await loadProcesses(); if (processes.some(x => x.id === params.process)) stream(params.process); }
    };
    this.languageChanged = () => { renderProjects(); if (ctx.isActive()) renderContent(); };
  },
};
