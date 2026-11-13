// Angular CLI: workspace Angular dei progetti nella sidebar; per il progetto scelto i generatori
// delle collezioni installate, i recenti, ng add e ng update. Il dialog di un generatore costruisce
// il form dallo schema.json, rifà l'anteprima (--dry-run) a ogni modifica e genera con l'output
// in diretta nel pannello in basso.

const PREVIEW_DELAY_MS = 500;
// generatori in evidenza in cima alla pagina (quelli di tutti i giorni)
const FEATURED = ['component', 'service', 'module'];
// icona per i generatori più comuni (gli altri: wand-sparkles)
const ICONS = {
  component: 'component', service: 'box', directive: 'sparkles', pipe: 'filter', guard: 'shield', interceptor: 'arrow-left-right',
  resolver: 'git-merge', class: 'braces', interface: 'file-type', enum: 'list', module: 'boxes', application: 'app-window',
  library: 'library', environments: 'leaf', config: 'settings', 'web-worker': 'cpu', 'service-worker': 'wifi', 'app-shell': 'layout-template',
};

export default {
  async mount(ctx) {
    const { esc, js, toast, openModal, closeModal, output, fmt } = ctx.ui;
    const { t } = ctx;
    const $ = (root, role) => root.querySelector(`[data-role="${role}"]`);
    const enc = encodeURIComponent;

    let projects = [], folders = [], hidden = 0;
    let activeProject = null;
    let ws = null;            // workspace del progetto scelto (GET /workspace)
    let wsError = null;
    let filter = '';
    let updates = null;       // { loading } | { ok, updates, output }
    let dialog = null;        // stato del dialog del generatore aperto

    const project = () => projects.find(p => p.id === activeProject) || null;
    const api = path => `/projects/${enc(activeProject)}${path}`;

    // ---- dati ----
    async function loadProjects() {
      try { ({ projects, folders, hidden } = await ctx.projects.load()); } catch { projects = []; folders = []; hidden = 0; }
      if (activeProject && !project()) { activeProject = null; ws = null; }
    }
    async function loadWorkspace() {
      ws = null; wsError = null;
      if (!project()) return;
      try { ws = await ctx.api.get(api('/workspace')); } catch (e) { wsError = e.message; }
    }

    // ---- sidebar ----
    function renderProjects() {
      const el = $(ctx.sidebar, 'projects');
      if (!projects.length) {
        ctx.ui.patch(el, `<p class="ngc-muted ngc-pad">${esc(t('sidebar.none'))}</p>${ctx.projects.hiddenNote(hidden)}`);
        return;
      }
      ctx.ui.patch(el, ctx.projects.tree(folders, projects, p => `
        <div class="sb-item ${activeProject === p.id ? 'active' : ''}" role="button" tabindex="0"
             onclick="Ext['angular-cli'].select(${js(p.id)})" onkeydown="if(event.key==='Enter')Ext['angular-cli'].select(${js(p.id)})">
          <span class="sb-icon">${ctx.ui.icon('triangle')}</span><span class="ngc-proj-label">${esc(p.label)}</span>
        </div>`) + ctx.projects.hiddenNote(hidden));
    }

    // ---- pannello ----
    const optionsText = options => Object.entries(options || {}).map(([k, v]) => (v === true ? k : v === false ? `no-${k}` : `${k}=${Array.isArray(v) ? v.join(',') : v}`)).join(' · ');

    function renderContent() {
      const p = project();
      $(ctx.root, 'empty').hidden = !!p;
      $(ctx.root, 'project').hidden = !p;
      if (!p) return;
      $(ctx.root, 'title').textContent = p.label;
      $(ctx.root, 'path').textContent = p.path;
      const versions = ws ? [ws.cli && t('version.cli', { version: ws.cli }), ws.core && t('version.core', { version: ws.core })].filter(Boolean) : [];
      $(ctx.root, 'versions').innerHTML = versions.map(v => `<span class="ngc-version">${esc(v)}</span>`).join('');
      for (const a of ['add', 'updates']) ctx.root.querySelector(`[data-action="${a}"]`).disabled = !ws?.installed;
      const el = $(ctx.root, 'content');
      if (wsError) { ctx.ui.patch(el, `<div class="empty-state"><div class="icon">${ctx.ui.icon('triangle-alert')}</div><p>${esc(wsError)}</p></div>`); return; }
      if (!ws) { ctx.ui.patch(el, `<p class="ngc-muted">${esc(t('loading'))}</p>`); return; }
      ctx.ui.patch(el, [
        projectsRow(),
        ws.installed ? '' : installNotice(),
        ws.installed ? featuredBlock() : '',
        ws.installed ? recentBlock() : '',
        ws.installed ? collectionsBlock() : '',
        updatesBlock(),
      ].join(''));
    }

    function projectsRow() {
      return `<div class="ngc-apps">${ws.projects.map(x => `<span class="ngc-app ngc-app-${esc(x.type)}" title="${esc(x.root || '/')}">
        ${ctx.ui.icon(x.type === 'library' ? 'library' : 'app-window')} ${esc(x.name)} <span class="ngc-app-type">${esc(t(`type.${x.type}`))}</span></span>`).join('')}</div>`;
    }

    function installNotice() {
      const npm = ctx.hasExtension('npm');
      return `<div class="ngc-notice">${ctx.ui.icon('package')} <span>${esc(t(ws.nodeModules ? 'notInstalledCli' : 'notInstalled'))}</span>
        ${npm ? `<button class="btn btn-sm ngc-btn" onclick="Ext['angular-cli'].npmInstall()">${ctx.ui.icon('download')} ${esc(t('npmInstall'))}</button>` : '<code>npm install</code>'}</div>`;
    }

    function recentBlock() {
      if (!ws.recent.length) return '';
      return `<div class="ngc-group">
        <div class="ngc-group-title">${ctx.ui.icon('history')} ${esc(t('recent.title'))}
          <button class="btn btn-ghost btn-sm ngc-clear" onclick="Ext['angular-cli'].clearRecent()" title="${esc(t('recent.clear'))}">${ctx.ui.icon('trash-2')}</button></div>
        <div class="ngc-recent">${ws.recent.map((r, i) => `
          <button class="ngc-recent-item" onclick="Ext['angular-cli'].repeat(${i})" title="${esc(t('recent.repeat'))}">
            <span class="ngc-recent-name">${ctx.ui.icon(ICONS[r.schematic] || 'wand-sparkles')} ${esc(r.schematic)}</span>
            ${r.collection !== '@schematics/angular' ? `<span class="ngc-recent-coll">${esc(r.collection)}</span>` : ''}
            ${r.project && ws.projects.length > 1 ? `<span class="ngc-recent-coll">${esc(r.project)}</span>` : ''}
            <span class="ngc-recent-opts">${esc(optionsText(r.options) || t('recent.defaults'))}</span>
          </button>`).join('')}</div></div>`;
    }

    function featuredBlock() {
      const base = ws.collections.find(c => c.name === '@schematics/angular');
      const list = FEATURED.map(n => base?.schematics.find(s => s.name === n)).filter(Boolean);
      if (!list.length || filter.trim()) return '';
      return `<div class="ngc-featured">${list.map(s => `
        <button class="ngc-feature" onclick="Ext['angular-cli'].generate('@schematics/angular', ${js(s.name)})">
          <span class="ngc-feature-icon">${ctx.ui.icon(ICONS[s.name] || 'wand-sparkles')}</span>
          <span class="ngc-feature-text"><span class="ngc-feature-name">${esc(t(`featured.${s.name}`))}</span>
            <code class="ngc-feature-cmd">ng g ${esc(s.aliases[0] || s.name)}</code></span>
          <span class="ngc-feature-desc">${esc(t(`featured.${s.name}Hint`))}</span>
        </button>`).join('')}</div>`;
    }

    function collectionsBlock() {
      const q = filter.trim().toLowerCase();
      const match = s => !q || s.name.includes(q) || s.aliases.some(a => a === q) || s.description.toLowerCase().includes(q);
      const blocks = ws.collections.map(c => {
        const list = c.schematics.filter(match);
        if (!list.length) return '';
        return `<div class="ngc-group">
          <div class="ngc-group-title">${ctx.ui.icon('package')} ${esc(c.name)} ${c.version ? `<span class="ngc-count">${esc(c.version)}</span>` : ''}</div>
          <div class="ngc-grid">${list.map(s => `
            <button class="ngc-card" onclick="Ext['angular-cli'].generate(${js(c.name)}, ${js(s.name)})" title="${esc(s.description)}">
              <span class="ngc-card-head">${ctx.ui.icon(ICONS[s.name] || 'wand-sparkles')}<span class="ngc-card-name">${esc(s.name)}</span>
                ${s.aliases.length ? `<span class="ngc-alias">${esc(s.aliases.join(', '))}</span>` : ''}</span>
              <span class="ngc-card-desc">${esc(s.description)}</span>
            </button>`).join('')}</div></div>`;
      }).join('');
      return blocks || `<p class="ngc-muted">${esc(t(ws.collections.length ? 'noMatch' : 'noSchematics'))}</p>`;
    }

    function updatesBlock() {
      if (!updates) return '';
      if (updates.loading) return `<div class="ngc-group"><div class="ngc-group-title">${ctx.ui.icon('circle-arrow-up')} ${esc(t('updates.title'))}</div><p class="ngc-muted">${esc(t('updates.loading'))}</p></div>`;
      const rows = updates.updates.map(u => `<tr><td><code>${esc(u.name)}</code></td><td>${esc(u.current)}</td><td>→ <strong>${esc(u.latest)}</strong></td>
        <td class="ngc-right"><button class="btn btn-sm ngc-btn" onclick="Ext['angular-cli'].update([${js(u.target)}])">${esc(t('updates.update'))}</button></td></tr>`).join('');
      return `<div class="ngc-group"><div class="ngc-group-title">${ctx.ui.icon('circle-arrow-up')} ${esc(t('updates.title'))}
          ${updates.updates.length > 1 ? `<button class="btn btn-sm ngc-btn" onclick="Ext['angular-cli'].updateAll()">${esc(t('updates.all'))}</button>` : ''}
          <button class="btn btn-ghost btn-sm ngc-clear" onclick="Ext['angular-cli'].closeUpdates()" title="${esc(t('core.action.close'))}">${ctx.ui.icon('x')}</button></div>
        ${updates.ok ? '' : `<pre class="ngc-pre">${esc(updates.output)}</pre>`}
        ${updates.updates.length ? `<table class="data-table ngc-updates"><tbody>${rows}</tbody></table>` : updates.ok ? `<p class="ngc-muted">${esc(t('updates.none'))}</p>` : ''}</div>`;
    }

    // ---- dialog del generatore ----
    function fieldLabel(f) {
      return `${esc(f.name)}${f.required ? ' *' : ''}`;
    }
    // valore predefinito effettivo per il progetto del workspace scelto
    const defaultOf = f => (dialog.detail.defaults?.[dialog.project]?.[f.name] ?? f.default);
    const defaultText = v => (v === undefined ? '' : Array.isArray(v) ? v.join(', ') : String(v));

    function fieldHtml(f) {
      const v = dialog.values[f.name];
      const d = defaultOf(f);
      const id = `ngc_f_${f.name}`;
      const hint = f.description ? `<div class="ngc-hint">${esc(f.description)}</div>` : '';
      const data = `data-field="${esc(f.name)}"`;
      if (f.type === 'boolean') {
        const checked = v ?? d ?? false;
        return `<label class="ngc-check" title="${esc(f.description)}"><input type="checkbox" id="${id}" ${data} ${checked ? 'checked' : ''}> ${fieldLabel(f)}</label>`;
      }
      let input;
      if (f.type === 'enum') {
        input = `<select class="form-input" id="${id}" ${data}>
          <option value="">${esc(t('dialog.default', { value: defaultText(d) || '—' }))}</option>
          ${f.choices.map(c => `<option value="${esc(c)}" ${v === c ? 'selected' : ''}>${esc(c)}</option>`).join('')}</select>`;
      } else if (f.type === 'list') {
        const chosen = v ?? d ?? [];
        input = `<div class="ngc-list">${f.choices.map(c => `<label class="ngc-check"><input type="checkbox" ${data} data-item="${esc(c)}" ${chosen.includes(c) ? 'checked' : ''}> ${esc(c)}</label>`).join('')}</div>`;
      } else {
        const type = f.type === 'number' || f.type === 'integer' ? 'number' : 'text';
        const value = Array.isArray(v) ? v.join(', ') : v ?? '';
        input = `<input class="form-input" type="${type}" id="${id}" ${data} value="${esc(value)}" placeholder="${esc(defaultText(d))}" spellcheck="false">`;
      }
      return `<div class="form-row ngc-field"><label for="${id}">${fieldLabel(f)}</label>${input}${hint}</div>`;
    }

    function readField(f) {
      const els = [...document.querySelectorAll(`#modalBody [data-field="${CSS.escape(f.name)}"]`)];
      if (!els.length) return undefined;
      if (f.type === 'boolean') return els[0].checked;
      if (f.type === 'list') return els.filter(e => e.checked).map(e => e.dataset.item);
      const raw = els[0].value.trim();
      if (raw === '') return undefined;
      if (f.type === 'number' || f.type === 'integer') return Number(raw);
      if (f.type === 'strings') return raw.split(',').map(s => s.trim()).filter(Boolean);
      return raw;
    }

    function readDialog() {
      const name = document.getElementById('ngc_name')?.value.trim() ?? '';
      const projectSel = document.getElementById('ngc_project');
      if (projectSel) dialog.project = projectSel.value;
      const options = {};
      for (const f of dialog.detail.fields) {
        const v = readField(f);
        if (v !== undefined) options[f.name] = v;
      }
      // booleani e liste uguali al predefinito: non servono (il server li toglie comunque)
      for (const f of dialog.detail.fields) {
        if ((f.type === 'boolean' || f.type === 'list') && JSON.stringify(options[f.name]) === JSON.stringify(defaultOf(f) ?? (f.type === 'boolean' ? false : []))) delete options[f.name];
      }
      dialog.values = options;
      dialog.name = name;
      const folderEl = document.getElementById('ngc_folder');
      if (folderEl) dialog.folder = folderEl.value.trim().replace(/\/+$/, '');
      return { collection: dialog.collection, schematic: dialog.schematic, project: dialog.project || undefined, name: name || undefined, options,
        ...(dialog.detail.pathOption && dialog.folder ? { folder: dialog.folder } : {}) };
    }

    function positionalHtml() {
      const f = dialog.detail.positional;
      if (!f) return '';
      if (f.type === 'enum') {
        return `<div class="form-row"><label for="ngc_name">${fieldLabel(f)}</label><select class="form-input" id="ngc_name">
          ${f.choices.map(c => `<option value="${esc(c)}" ${dialog.name === c ? 'selected' : ''}>${esc(c)}</option>`).join('')}</select>
          ${f.label ? `<div class="ngc-hint">${esc(f.label)}</div>` : ''}</div>`;
      }
      return `<div class="form-row"><label for="ngc_name">${fieldLabel(f)}</label>
        <input class="form-input" id="ngc_name" value="${esc(dialog.name || '')}" placeholder="${esc(f.name === 'name' ? t('dialog.namePlaceholder') : '')}" spellcheck="false" autocomplete="off">
        <div class="ngc-hint">${esc(f.name === 'name' ? t('dialog.nameHint') : f.label || f.description)}</div></div>`;
    }

    // ---- cartella di destinazione (opzione path dello schematic) ----
    const defaultFolder = () => ws.projects.find(x => x.name === dialog.project)?.defaultPath || '';
    function folderHtml() {
      if (!dialog.detail.pathOption) return '';
      return `<div class="form-row ngc-folder-row"><label for="ngc_folder">${esc(t('folder.label'))}</label>
        <div class="ngc-folder-input">
          <input class="form-input" id="ngc_folder" list="ngc_folders" value="${esc(dialog.folder)}" spellcheck="false" autocomplete="off">
          <button class="btn btn-ghost btn-sm" type="button" id="ngc_folder_browse" title="${esc(t('folder.browse'))}">${ctx.ui.icon('folder-tree')}</button>
          <button class="btn btn-ghost btn-sm" type="button" id="ngc_folder_reset" title="${esc(t('folder.reset'))}">${ctx.ui.icon('rotate-ccw')}</button>
        </div>
        <datalist id="ngc_folders"></datalist>
        <div class="ngc-tree" data-role="folder-tree" hidden></div>
        <div class="ngc-hint" data-role="folder-hint"></div></div>`;
    }
    function folderHint() {
      const el = document.querySelector('#modalBody [data-role="folder-hint"]');
      if (!el) return;
      const name = document.getElementById('ngc_name')?.value.trim() || '…';
      el.textContent = t('folder.hint', { path: `${dialog.folder || defaultFolder()}/${name}` });
    }
    function renderFolderTree() {
      const el = document.querySelector('#modalBody [data-role="folder-tree"]');
      if (!el || !dialog.folders) return;
      const depth = f => f.split('/').length - 1;
      el.innerHTML = dialog.folders.length ? dialog.folders.map(f => `
        <button type="button" class="ngc-tree-item ${f === dialog.folder ? 'active' : ''}" data-folder="${esc(f)}" style="padding-inline-start:${8 + depth(f) * 14}px">
          ${ctx.ui.icon(f === defaultFolder() ? 'folder-check' : 'folder')} ${esc(f.split('/').pop())}</button>`).join('')
        : `<p class="ngc-muted">${esc(t('folder.none'))}</p>`;
      document.getElementById('ngc_folders').innerHTML = dialog.folders.map(f => `<option value="${esc(f)}"></option>`).join('');
    }
    async function loadFolders() {
      try { dialog.folders = (await ctx.api.get(api('/folders'))).folders; } catch { dialog.folders = []; }
      renderFolderTree();
    }
    function chooseFolder(f) {
      const input = document.getElementById('ngc_folder');
      if (!input) return;
      input.value = f;
      dialog.folder = f;
      renderFolderTree();
      folderHint();
      schedulePreview(0);
    }

    function openGenerator(detail, { options = null, project: target = null } = {}) {
      const projectsOfWs = ws.projects.map(x => x.name);
      dialog = {
        collection: detail.collection, schematic: detail.name, detail,
        project: target && projectsOfWs.includes(target) ? target : ws.defaultProject || projectsOfWs[0] || '',
        values: { ...(options || detail.last || {}) }, name: '', seq: 0, timer: null, preview: null, folder: '', folders: null,
      };
      dialog.folder = defaultFolder();
      const projectSelect = projectsOfWs.length > 1 ? `<div class="form-row"><label for="ngc_project">${esc(t('dialog.project'))}</label>
        <select class="form-input" id="ngc_project">${ws.projects.map(x => `<option value="${esc(x.name)}" ${x.name === dialog.project ? 'selected' : ''}>${esc(x.name)} (${esc(t(`type.${x.type}`))})</option>`).join('')}</select></div>` : '';
      const fields = detail.fields;
      const main = fields.filter(f => f.type !== 'boolean');
      const flags = fields.filter(f => f.type === 'boolean');
      openModal(`ng generate ${detail.collection === '@schematics/angular' ? '' : `${detail.collection}:`}${detail.name}`, `
        <div class="ngc-dialog">
          <div class="ngc-form">
            ${detail.description ? `<p class="ngc-muted ngc-desc">${esc(detail.description)}</p>` : ''}
            ${projectSelect}${positionalHtml()}${folderHtml()}
            <div class="ngc-fields" data-role="fields">${main.map(fieldHtml).join('')}</div>
            ${flags.length ? `<div class="ngc-flags">${flags.map(fieldHtml).join('')}</div>` : ''}
          </div>
          <div class="ngc-preview"><div class="ngc-preview-title">${ctx.ui.icon('eye')} ${esc(t('preview.title'))}</div><div data-role="preview"></div></div>
        </div>`,
        `<button class="btn btn-ghost" onclick="UI.closeModal()">${esc(t('core.action.cancel'))}</button>
         <button class="btn ngc-btn" id="ngc_go" onclick="Ext['angular-cli'].runGenerate()">${ctx.ui.icon('wand-sparkles')} ${esc(t('dialog.generate'))}</button>`);
      document.getElementById('modal').classList.add('modal-wide', 'ngc-wide', 'ngc-modal');
      dialog.generator = true;
      dialog.redraw = () => {
        const body = document.getElementById('modalBody');
        body.querySelector('[data-role="fields"]').innerHTML = main.map(fieldHtml).join('');
        const fl = body.querySelector('.ngc-flags');
        if (fl) fl.innerHTML = flags.map(fieldHtml).join('');
      };
      if (detail.pathOption) { loadFolders(); folderHint(); }
      document.getElementById('ngc_name')?.focus();
      schedulePreview(0);
    }

    function schedulePreview(delay = PREVIEW_DELAY_MS) {
      if (!dialog) return;
      clearTimeout(dialog.timer);
      dialog.timer = setTimeout(runPreview, typeof delay === 'number' ? delay : PREVIEW_DELAY_MS);
    }

    async function runPreview() {
      if (!dialog || !document.getElementById('ngc_go')) return;
      const body = readDialog();
      const el = document.querySelector('#modalBody [data-role="preview"]');
      if (dialog.detail.positional?.required && !body.name) {
        dialog.preview = null;
        el.innerHTML = `<p class="ngc-muted">${esc(t('preview.needName', { name: dialog.detail.positional.name }))}</p>`;
        return;
      }
      const seq = ++dialog.seq;
      el.classList.add('ngc-loading');
      try {
        const r = await ctx.api.post(api('/preview'), body);
        if (!dialog || seq !== dialog.seq) return;
        dialog.preview = r;
        el.innerHTML = previewHtml(r);
      } catch (e) {
        if (!dialog || seq !== dialog.seq) return;
        dialog.preview = null;
        el.innerHTML = `<p class="ngc-error">${esc(e.message)}</p>`;
      } finally { el.classList.remove('ngc-loading'); }
    }

    function filesHtml(files) {
      return `<ul class="ngc-files">${files.map(f => `<li class="ngc-file ngc-${esc(f.action)} ${f.conflict ? 'ngc-conflict' : ''}" title="${esc(f.conflict ? t('preview.conflict') : f.exists ? t('preview.exists') : '')}">
        <span class="ngc-action">${esc(t(`action.${f.action}`))}</span><span class="ngc-file-path">${esc(f.path)}</span>
        ${f.conflict ? `<span class="ngc-flag">${ctx.ui.icon('file-warning')} ${esc(t('preview.conflictShort'))}</span>` : ''}
        ${f.bytes != null ? `<span class="ngc-bytes">${esc(fmt.number(f.bytes))} B</span>` : ''}</li>`).join('')}</ul>`;
    }

    function previewHtml(r) {
      const cmd = `<code class="ngc-cmd">${esc(r.command)}</code>`;
      if (r.code !== 0) return `${cmd}<p class="ngc-error">${esc(t('preview.failed'))}</p><pre class="ngc-pre">${esc(r.output)}</pre>`;
      if (r.nothing && !r.files.length) return `${cmd}<p class="ngc-muted">${esc(t('preview.nothing'))}</p>`;
      return `${cmd}${filesHtml(r.files)}${r.conflicts.length ? `<p class="ngc-error">${esc(t('preview.conflicts', { count: r.conflicts.length }))}</p>` : ''}`;
    }

    // ---- operazioni con l'output in diretta ----

    // 409 git_dirty: elenco dei file cambiati e conferma, poi di nuovo con confirmDirty
    function confirmDirty(e, retry) {
      const files = e.data?.files || [];
      openModal(t('dirty.title'), `<p>${esc(t('dirty.text', { count: files.length }))}</p>
        <ul class="ngc-dirty">${files.slice(0, 30).map(f => `<li><code>${esc(f)}</code></li>`).join('')}${files.length > 30 ? `<li>…</li>` : ''}</ul>
        ${ctx.hasExtension('git') ? `<p><button class="btn btn-ghost btn-sm" onclick="UI.closeModal();Ext['angular-cli'].openGit()">${ctx.ui.icon('git-branch')} ${esc(t('dirty.openGit'))}</button></p>` : ''}`,
        `<button class="btn btn-ghost" onclick="UI.closeModal()">${esc(t('core.action.cancel'))}</button>
         <button class="btn btn-danger" id="ngc_dirty_go">${esc(t('dirty.proceed'))}</button>`);
      document.getElementById('modal').classList.add('ngc-modal');
      document.getElementById('ngc_dirty_go').addEventListener('click', () => { closeModal(); retry(); });
    }

    async function streamed(title, path, body, { onFiles = null } = {}) {
      output.open(title);
      let files = null;
      try {
        const code = await ctx.api.stream(api(path), body, ev => {
          if (ev.type === 'stdout') output.append(ev.data);
          else if (ev.type === 'files') files = ev.data;
        });
        if (files?.length) output.append(`\n${t('output.written', { count: files.length })}\n${files.map(f => `  ${t(`action.${f.action}`)} ${f.path}`).join('\n')}\n`, 'sys');
        output.append(`\n[${t('output.exit', { code: String(code) })}]\n`, 'sys');
        toast(t(code === 0 ? 'toast.done' : 'toast.failed', { command: title }), code === 0 ? 'success' : 'error');
        onFiles?.(files);
        return code;
      } catch (e) {
        if (e.status === 409 && e.data?.code === 'angular-cli.git_dirty') { output.close(); confirmDirty(e, () => streamed(title, path, { ...body, confirmDirty: true }, { onFiles })); return null; }
        output.append(`\n${e.message}\n`, 'err');
        toast(e.message, 'error');
        return null;
      }
    }

    // ---- ng add ----
    async function addDialog() {
      openModal(t('add.title'), `
        <div class="form-row"><label for="ngc_pkg">${esc(t('add.package'))}</label>
          <input class="form-input" id="ngc_pkg" placeholder="@angular/material" spellcheck="false" autocomplete="off"></div>
        <div class="ngc-hint">${esc(t('add.hint'))}</div>
        <div data-role="add-options"></div>`,
        `<button class="btn btn-ghost" onclick="UI.closeModal()">${esc(t('core.action.cancel'))}</button>
         <button class="btn ngc-btn" id="ngc_add_go">${ctx.ui.icon('package-plus')} ${esc(t('add.run'))}</button>`);
      document.getElementById('modal').classList.add('ngc-modal');
      const input = document.getElementById('ngc_pkg');
      let fields = null;
      const optionsEl = document.querySelector('#modalBody [data-role="add-options"]');
      input.addEventListener('change', async () => {
        fields = null; optionsEl.innerHTML = '';
        if (!input.value.trim()) return;
        try {
          const r = await ctx.api.get(`${api('/add-options')}?package=${enc(input.value.trim())}`);
          if (r.fields?.length) {
            fields = r.fields;
            dialog = { detail: { fields, defaults: {} }, project: '', values: {} };
            optionsEl.innerHTML = `<p class="ngc-muted">${esc(t('add.options'))}</p>${fields.map(fieldHtml).join('')}`;
          }
        } catch (e) { optionsEl.innerHTML = `<p class="ngc-error">${esc(e.message)}</p>`; }
      });
      input.focus();
      const go = () => {
        const pkg = input.value.trim();
        if (!pkg) { input.focus(); return; }
        const options = {};
        if (fields) for (const f of fields) { const v = readField(f); if (v !== undefined && JSON.stringify(v) !== JSON.stringify(f.default ?? (f.type === 'boolean' ? false : undefined))) options[f.name] = v; }
        closeModal(); dialog = null;
        streamed(`ng add ${pkg}`, '/add', { package: pkg, options }).then(() => refreshProject());
      };
      document.getElementById('ngc_add_go').addEventListener('click', go);
      input.addEventListener('keydown', e => { if (e.key === 'Enter') go(); });
    }

    async function refreshProject() { await loadWorkspace(); renderContent(); }

    async function choose(id) {
      activeProject = id;
      updates = null;
      renderProjects();
      ws = null; wsError = null;
      renderContent();
      await loadWorkspace();
      renderContent();
    }

    async function openSchematic(collection, schematic, extra) {
      try {
        const detail = await ctx.api.get(`${api('/schematic')}?collection=${enc(collection)}&name=${enc(schematic)}`);
        openGenerator(detail, extra);
      } catch (e) { toast(e.message, 'error'); }
    }

    const actions = {
      select: id => choose(id),
      generate: (collection, schematic) => openSchematic(collection, schematic),
      repeat(i) {
        const r = ws?.recent?.[i];
        if (r) openSchematic(r.collection, r.schematic, { options: r.options, project: r.project });
      },
      async clearRecent() {
        try { await ctx.api.del(api('/recent')); await refreshProject(); } catch (e) { toast(e.message, 'error'); }
      },
      async runGenerate() {
        if (!dialog) return;
        const body = readDialog();
        if (dialog.detail.positional?.required && !body.name) { document.getElementById('ngc_name')?.focus(); return; }
        if (dialog.preview && !dialog.preview.ok) { toast(t('preview.blocked'), 'error'); return; }
        const title = `ng generate ${dialog.schematic}${body.name ? ` ${body.name}` : ''}`;
        clearTimeout(dialog.timer);
        dialog = null;
        closeModal();
        await streamed(title, '/generate', body);
        await refreshProject();
      },
      add: () => addDialog(),
      async checkUpdates() {
        updates = { loading: true };
        renderContent();
        try { updates = await ctx.api.get(api('/updates')); } catch (e) { updates = null; toast(e.message, 'error'); }
        renderContent();
      },
      closeUpdates() { updates = null; renderContent(); },
      async update(packages) {
        const code = await streamed(`ng update ${packages.join(' ')}`, '/update', { packages });
        if (code === 0) { updates = null; await refreshProject(); }
      },
      updateAll() { if (updates?.updates?.length) actions.update(updates.updates.map(u => u.target)); },
      async npmInstall() {
        try {
          await ctx.apiFor('npm').post(`/projects/${enc(activeProject)}/run`, { script: 'install' });
          ctx.open('npm', { project: activeProject });
        } catch (e) { toast(e.message, 'error'); }
      },
      openGit: () => ctx.open('git', { project: activeProject }),
    };

    ctx.sidebar.addEventListener('click', e => {
      if (e.target.closest('[data-action="manage-projects"]')) ctx.projects.openPanel();
      if (e.target.closest('[data-action="reload"]')) this.refresh();
    });
    ctx.root.addEventListener('click', e => {
      if (e.target.closest('[data-action="add"]')) actions.add();
      if (e.target.closest('[data-action="updates"]')) actions.checkUpdates();
    });
    $(ctx.root, 'filter').addEventListener('input', e => { filter = e.target.value; renderContent(); });
    // eventi del dialog del generatore (un solo ascoltatore: il corpo del modale è del core e resta)
    const modalBody = document.getElementById('modalBody');
    const onModal = e => {
      if (!dialog?.generator) return;
      if (e.type === 'change' && e.target.id === 'ngc_project') {
        // la cartella segue il progetto finché è quella predefinita
        const before = defaultFolder();
        const folderEl = document.getElementById('ngc_folder');
        readDialog();
        if (folderEl && dialog.folder === before) { folderEl.value = defaultFolder(); dialog.folder = defaultFolder(); renderFolderTree(); }
        dialog.redraw();
      }
      if (e.type === 'input' && (e.target.id === 'ngc_name' || e.target.id === 'ngc_folder')) { if (e.target.id === 'ngc_folder') dialog.folder = e.target.value.trim(); folderHint(); }
      if (e.type === 'keydown') {
        if (e.key === 'Enter' && e.target.matches('input:not([type=checkbox])')) { e.preventDefault(); actions.runGenerate(); }
        return;
      }
      schedulePreview();
    };
    for (const type of ['input', 'change', 'keydown']) modalBody.addEventListener(type, onModal);
    const onModalClick = e => {
      if (!dialog?.generator) return;
      const item = e.target.closest('[data-folder]');
      if (item) { chooseFolder(item.dataset.folder); return; }
      if (e.target.closest('#ngc_folder_browse')) {
        const tree = modalBody.querySelector('[data-role="folder-tree"]');
        tree.hidden = !tree.hidden;
        if (!tree.hidden) tree.querySelector('.active')?.scrollIntoView({ block: 'nearest' });
      }
      if (e.target.closest('#ngc_folder_reset')) chooseFolder(defaultFolder());
    };
    modalBody.addEventListener('click', onModalClick);
    // il dialog chiuso (✕, Annulla, Esc) ferma le anteprime
    const onModalClose = e => { if (!e.detail.open && dialog) { clearTimeout(dialog.timer); dialog = null; } };
    document.addEventListener('ui:modal', onModalClose);

    ctx.bus.on('core:projects-changed', async () => { await loadProjects(); renderProjects(); renderContent(); });
    ctx.expose(actions);
    await loadProjects();
    renderProjects();
    if (!activeProject && projects.length === 1) await choose(projects[0].id);
    else renderContent();

    this.show = async () => { await loadProjects(); renderProjects(); if (activeProject) await refreshProject(); else renderContent(); };
    this.refresh = async () => { await loadProjects(); renderProjects(); await refreshProject(); };
    // aperta da altre sezioni o dal widget: { project, generate?: schematic, recent?: indice }
    this.focus = async params => {
      if (!params?.project) return;
      await loadProjects();
      if (!projects.some(p => p.id === params.project)) return;
      if (activeProject !== params.project || !ws) await choose(params.project);
      if (!ws?.installed) return;
      if (params.generate) await openSchematic(params.collection || '@schematics/angular', params.generate);
      else if (Number.isInteger(params.recent)) actions.repeat(params.recent);
    };
    this.languageChanged = () => { renderProjects(); renderContent(); };
    this.unmount = () => {
      for (const type of ['input', 'change', 'keydown']) modalBody.removeEventListener(type, onModal);
      modalBody.removeEventListener('click', onModalClick);
      document.removeEventListener('ui:modal', onModalClose);
    };
  },
};

