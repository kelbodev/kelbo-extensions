// Docker: nella sidebar i file compose dei progetti di Kelbo, i progetti compose in esecuzione e la
// vista dei container. Container raggruppati per progetto compose, in diretta (docker events), con
// log, azioni, statistiche, tunnel e connessione database. Un file compose si apre sul grafo dei
// servizi (dipendenze, volumi, porte, stato, problemi): un clic su un servizio lo apre nell'editor
// a destra, senza selezione si aggiungono servizi pronti, volumi, reti e si vedono le variabili.
// Il YAML resta modificabile a mano (analisi mentre si scrive); i problemi hanno le correzioni.

const NODE_W = 230, NODE_H = 104, VOL_W = 150, VOL_H = 34, GAP_X = 96, GAP_Y = 22, PAD = 24;
const TAB_KEY = 'kelbo.docker.view';
const CONDITIONS = ['service_started', 'service_healthy', 'service_completed_successfully'];
const RESTARTS = ['', 'no', 'always', 'unless-stopped', 'on-failure'];
const KIND_ICON = { db: 'database', cache: 'zap', queue: 'inbox', search: 'search', web: 'globe', mail: 'mail', app: 'box' };
// problemi con una spiegazione in più nei cataloghi (issueHelp.<code>)
const HELP = new Set(['bind_missing','container_name_replicas','depends_cycle','depends_not_ready','docker_socket','env_missing','env_required','healthy_without_healthcheck','image_latest','port_all_interfaces','port_duplicate','port_in_use','secret_plain','version_obsolete']);
const NET_COLORS = ['#2496ed', '#f0b429', '#3fb950', '#d2a8ff', '#ff7b72', '#79c0ff', '#ffa657'];

export default {
  async mount(ctx) {
    const { esc, js, toast, openModal, closeModal, output, fmt } = ctx.ui;
    const { t } = ctx;
    const $ = (root, role) => root.querySelector(`[data-role="${role}"]`);
    const store = {
      get() { try { return JSON.parse(localStorage.getItem(TAB_KEY)) || {}; } catch { return {}; } },
      set(v) { try { localStorage.setItem(TAB_KEY, JSON.stringify({ ...store.get(), ...v })); } catch { /* solo per questa sessione */ } },
    };

    // ---- stato ----
    let status = null;                 // versione di docker, daemon
    let containers = [], projects = [], files = [], loadError = null;
    let stats = new Map();
    let view = { kind: 'containers' }; // oppure { kind: 'file', projectId, file }
    let filter = '';
    let closeEvents = null, statsTimer = null, closeLogs = null;
    let templatesList = [];
    // file compose aperto
    let doc = null; // { projectId, file, text, hash, analysis, dirty }
    let tab = store.get().tab || 'graph';
    let selected = null, draft = null, zoom = store.get().zoom || 1;
    let analyzeTimer = null, analyzeSeq = 0;

    // ---- dati ----
    async function loadStatus() {
      try { status = await ctx.api.get('/status'); } catch (e) { status = { error: { message: e.message } }; }
    }
    async function loadOverview() {
      try {
        const r = await ctx.api.get('/overview');
        containers = r.containers; projects = r.projects; files = r.files; loadError = null;
      } catch (e) {
        loadError = e.message; containers = []; projects = [];
        try { files = (await ctx.api.get('/files')).files; } catch { /* niente progetti */ }
      }
      ctx.setBadge(containers.filter(c => c.state === 'running' && !c.forward).length || null);
    }
    let reloadTimer = null;
    const reloadSoon = () => {
      clearTimeout(reloadTimer);
      reloadTimer = setTimeout(async () => { await loadOverview(); renderNav(); if (view.kind === 'containers') renderContainers(); else if (doc && !doc.dirty) refreshAnalysis(); }, 250);
    };

    // stato in diretta: docker events → elenco di nuovo
    function startEvents() {
      stopEvents();
      if (!$(ctx.root, 'live').checked || !status?.daemon) return;
      closeEvents = ctx.api.events('/events', ev => {
        if (ev.type === 'change') reloadSoon();
        else if (ev.type === 'end') { closeEvents = null; if (ev.data?.error) toast(ev.data.error, 'error'); }
      }, () => { closeEvents = null; });
    }
    function stopEvents() { closeEvents?.(); closeEvents = null; }
    function startStats() {
      stopStats();
      if (!$(ctx.root, 'show-stats').checked || !status?.daemon) return;
      const tick = async () => {
        try { stats = new Map((await ctx.api.get('/stats')).stats.map(s => [s.id, s])); } catch { stats = new Map(); }
        if (view.kind === 'containers') renderContainers();
      };
      tick();
      statsTimer = setInterval(tick, 5000);
    }
    function stopStats() { clearInterval(statsTimer); statsTimer = null; }

    // ---- utilità ----
    const stateClass = c => (c.state === 'running' ? (c.health === 'unhealthy' ? 'bad' : c.health === 'starting' ? 'wait' : 'ok') : ['restarting', 'paused', 'created'].includes(c.state) ? 'wait' : c.state === 'exited' && c.exitCode ? 'bad' : 'off');
    const stateText = c => (c.state === 'exited' ? t('state.exited', { code: c.exitCode ?? 0 }) : t(`state.${c.state}`) + (c.health ? ` · ${t(`health.${c.health}`)}` : ''));
    const portChip = p => {
      const host = p.hostIp && !['0.0.0.0', '::'].includes(p.hostIp) ? `${p.hostIp}:` : '';
      const text = `${host}${p.hostPort}→${p.container}${p.protocol && p.protocol !== 'tcp' ? `/${p.protocol}` : ''}`;
      return p.protocol === 'tcp' || !p.protocol
        ? `<a class="dk-port" href="http://localhost:${esc(p.hostPort)}" target="_blank" rel="noopener" title="${esc(t('containers.openPort', { port: p.hostPort }))}" onclick="event.stopPropagation()">${esc(text)}</a>`
        : `<span class="dk-port">${esc(text)}</span>`;
    };
    const issueText = i => t(`issue.${i.code}`, i.params || {});
    const levelIcon = l => ctx.ui.icon(l === 'error' ? 'circle-x' : l === 'warning' ? 'triangle-alert' : 'info');
    const fileKey = f => `${f.projectId}/${f.file}`;
    const runningOfFile = f => containers.filter(c => c.compose && c.compose.configFiles.includes(f.path));
    const kindOf = image => {
      const s = String(image || '').toLowerCase();
      if (/(postgres|mysql|mariadb|mssql|oracle|mongo|percona|timescale)/.test(s)) return 'db';
      if (/(redis|valkey|memcached)/.test(s)) return 'cache';
      if (/(rabbitmq|kafka|nats)/.test(s)) return 'queue';
      if (/(elasticsearch|opensearch|meilisearch)/.test(s)) return 'search';
      if (/(nginx|httpd|caddy|traefik|haproxy|adminer)/.test(s)) return 'web';
      if (/(mailpit|mailhog|maildev)/.test(s)) return 'mail';
      return 'app';
    };

    // ---- sidebar ----
    function renderNav() {
      const el = $(ctx.sidebar, 'nav');
      const byProject = new Map();
      for (const f of files) byProject.set(f.projectId, [...(byProject.get(f.projectId) || []), f]);
      const ownProjects = new Set(containers.filter(c => c.compose && files.some(f => c.compose.configFiles.includes(f.path))).map(c => c.compose.project));
      const others = projects.filter(p => !ownProjects.has(p.name));
      const running = containers.filter(c => c.state === 'running' && !c.forward).length;
      ctx.ui.patch(el, `
        <div class="sb-item ${view.kind === 'containers' ? 'active' : ''}" role="button" tabindex="0" onclick="Ext.docker.showContainers()" onkeydown="if(event.key==='Enter')Ext.docker.showContainers()">
          <span class="sb-icon">${ctx.ui.icon('container')}</span><span class="dk-nav-name">${esc(t('sidebar.containers'))}</span>
          <span class="dk-nav-count">${esc(fmt.number(running))}/${esc(fmt.number(containers.filter(c => !c.forward).length))}</span></div>
        <div class="dk-nav-section">${esc(t('sidebar.files'))}</div>
        ${byProject.size ? [...byProject].map(([pid, list]) => `
          <div class="dk-nav-project">${ctx.ui.icon('folder')} ${esc(list[0].projectLabel)}</div>
          ${list.map(f => {
            const run = runningOfFile(f);
            const up = run.filter(c => c.state === 'running').length;
            const active = view.kind === 'file' && fileKey(view) === fileKey(f);
            return `<div class="sb-item dk-nav-file ${active ? 'active' : ''}" role="button" tabindex="0" title="${esc(f.file)}"
                onclick="Ext.docker.openFile(${js(f.projectId)}, ${js(f.file)})" onkeydown="if(event.key==='Enter')Ext.docker.openFile(${js(f.projectId)}, ${js(f.file)})">
              <span class="dk-dot ${up ? (up === run.length ? 'ok' : 'wait') : 'off'}"></span>
              <span class="dk-nav-name">${esc(f.file)}</span>
              ${run.length ? `<span class="dk-nav-count">${esc(`${up}/${run.length}`)}</span>` : ''}
              ${active && doc?.dirty ? '<span class="dk-nav-dirty">●</span>' : ''}</div>`;
          }).join('')}`).join('') : `<p class="dk-muted dk-pad">${esc(t('sidebar.noFiles'))}</p>`}
        ${others.length ? `<div class="dk-nav-section">${esc(t('sidebar.otherProjects'))}</div>
          ${others.map(p => `<div class="sb-item dk-nav-file" role="button" tabindex="0" title="${esc(p.configFiles.join('\n'))}" onclick="Ext.docker.showContainers(${js(p.name)})">
            <span class="dk-dot ${/running/.test(p.status) ? 'ok' : 'off'}"></span><span class="dk-nav-name">${esc(p.name)}</span><span class="dk-nav-count">${esc(p.status)}</span></div>`).join('')}` : ''}`);
    }

    function renderNotice() {
      const el = $(ctx.root, 'notice');
      if (status?.daemon) { el.hidden = true; return; }
      el.hidden = false;
      const missing = status?.error?.code === 'docker.docker_missing';
      ctx.ui.patch(el, `${ctx.ui.icon('triangle-alert')} <span>${esc(missing ? t('notice.missing') : t('notice.daemon'))}</span>
        <button class="btn btn-ghost btn-sm" onclick="Ext.docker.recheck()">${esc(t('notice.recheck'))}</button>`);
    }

    // ---- vista dei container ----
    function containerRow(c) {
      const s = stats.get(c.id);
      const unpublished = c.exposed.filter(x => !c.ports.some(p => p.container === x.port));
      const isDb = kindOf(c.image) === 'db' && ctx.hasExtension('db-client');
      return `<tr class="${c.state === 'running' ? '' : 'dk-stopped'}">
        <td><span class="dk-dot ${stateClass(c)}" title="${esc(stateText(c))}"></span></td>
        <td><span class="dk-name">${esc(c.compose?.service || c.name)}</span>${c.compose ? `<span class="dk-sub">${esc(c.name)}</span>` : ''}</td>
        <td class="dk-image" title="${esc(c.image)}">${esc(c.image)}</td>
        <td><span class="dk-state dk-${stateClass(c)}">${esc(stateText(c))}</span>
          ${c.state === 'running' && c.startedAt ? `<span class="dk-sub" data-uptime="${esc(c.startedAt)}"></span>` : c.finishedAt ? `<span class="dk-sub">${esc(fmt.relative(c.finishedAt))}</span>` : ''}</td>
        <td class="dk-ports">${c.ports.map(portChip).join(' ')}${unpublished.length ? ` <span class="dk-exposed" title="${esc(t('containers.exposedTitle'))}">${esc(unpublished.map(x => x.port).join(', '))}</span>` : ''}</td>
        ${$(ctx.root, 'show-stats').checked ? `<td class="dk-stats">${s ? `${esc(fmt.number(s.cpu, { maximumFractionDigits: 1 }))}%<span class="dk-sub">${esc(s.mem.split('/')[0].trim())}</span>` : ''}</td>` : ''}
        <td class="dk-actions">
          <button class="btn btn-ghost btn-sm" onclick="Ext.docker.containerLogs(${js(c.name)})" title="${esc(t('action.logs'))}">${ctx.ui.icon('scroll-text')}</button>
          ${c.state === 'running'
            ? `<button class="btn btn-ghost btn-sm" onclick="Ext.docker.containerAction(${js(c.name)}, 'stop')" title="${esc(t('action.stop'))}">${ctx.ui.icon('square')}</button>
               <button class="btn btn-ghost btn-sm" onclick="Ext.docker.containerAction(${js(c.name)}, 'restart')" title="${esc(t('action.restart'))}">${ctx.ui.icon('rotate-ccw')}</button>`
            : `<button class="btn btn-ghost btn-sm" onclick="Ext.docker.containerAction(${js(c.name)}, 'start')" title="${esc(t('action.start'))}">${ctx.ui.icon('play')}</button>`}
          ${isDb ? `<button class="btn btn-ghost btn-sm" onclick="Ext.docker.dbConnection(${js(c.name)})" title="${esc(t('action.dbConnection'))}">${ctx.ui.icon('database')}</button>` : ''}
          ${ctx.hasExtension('tunnels') && c.state === 'running' && (c.exposed.length || c.ports.length) && !c.forward ? `<button class="btn btn-ghost btn-sm" onclick="Ext.docker.tunnel(${js(c.name)})" title="${esc(t('action.tunnel'))}">${ctx.ui.icon('cable')}</button>` : ''}
          <button class="btn btn-ghost btn-sm" onclick="Ext.docker.inspect(${js(c.name)})" title="${esc(t('action.inspect'))}">${ctx.ui.icon('file-text')}</button>
          <button class="btn btn-ghost btn-sm dk-danger" onclick="Ext.docker.removeContainer(${js(c.name)})" title="${esc(t('action.remove'))}">${ctx.ui.icon('trash-2')}</button>
        </td></tr>`;
    }
    function renderContainers() {
      const el = $(ctx.root, 'containers');
      if (loadError && status?.daemon) { ctx.ui.patch(el, `<div class="dk-error">${ctx.ui.icon('triangle-alert')} <pre>${esc(loadError)}</pre></div>`); return; }
      if (!status?.daemon) { ctx.ui.patch(el, ''); return; }
      const showStopped = $(ctx.root, 'show-stopped').checked;
      const q = filter.trim().toLowerCase();
      const list = containers.filter(c => (showStopped || c.state === 'running') && (!q || [c.name, c.image, c.compose?.project, c.compose?.service].some(x => String(x || '').toLowerCase().includes(q))));
      if (!list.length) { ctx.ui.patch(el, `<div class="empty-state"><div class="icon">${ctx.ui.icon('container')}</div><p>${esc(t(containers.length ? 'containers.noMatch' : 'containers.none'))}</p></div>`); return; }
      const groups = new Map();
      for (const c of list) { const k = c.forward ? '\u0001forward' : c.compose?.project || ''; groups.set(k, [...(groups.get(k) || []), c]); }
      const keys = [...groups.keys()].sort((a, b) => (a === '' ? 1 : b === '' ? -1 : a.startsWith('\u0001') ? 1 : b.startsWith('\u0001') ? -1 : a.localeCompare(b)));
      const statsCol = $(ctx.root, 'show-stats').checked;
      ctx.ui.patch(el, keys.map(k => {
        const items = groups.get(k).sort((a, b) => (a.compose?.service || a.name).localeCompare(b.compose?.service || b.name));
        const up = items.filter(c => c.state === 'running').length;
        const file = k && !k.startsWith('\u0001') ? files.find(f => items.some(c => c.compose?.configFiles.includes(f.path))) : null;
        const head = k.startsWith('\u0001') ? `<h4>${ctx.ui.icon('cable')} ${esc(t('containers.forwards'))}</h4>`
          : k ? `<h4>${ctx.ui.icon('layers')} ${esc(k)} <span class="dk-muted">${esc(`${up}/${items.length}`)}</span>
              ${file ? `<button class="btn btn-ghost btn-sm" onclick="Ext.docker.openFile(${js(file.projectId)}, ${js(file.file)})" title="${esc(t('containers.openFile'))}">${ctx.ui.icon('workflow')} ${esc(file.file)}</button>` : ''}</h4>
              <span class="dk-group-actions">
                <button class="btn btn-ghost btn-sm" onclick="Ext.docker.projectLogs(${js(k)})" title="${esc(t('action.logs'))}">${ctx.ui.icon('scroll-text')}</button>
                ${up < items.length ? `<button class="btn btn-ghost btn-sm" onclick="Ext.docker.run('up', {project: ${js(k)}})" title="${esc(t('action.up'))}">${ctx.ui.icon('play')}</button>` : ''}
                <button class="btn btn-ghost btn-sm" onclick="Ext.docker.run('restart', {project: ${js(k)}})" title="${esc(t('action.restart'))}">${ctx.ui.icon('rotate-ccw')}</button>
                ${up ? `<button class="btn btn-ghost btn-sm" onclick="Ext.docker.run('stop', {project: ${js(k)}})" title="${esc(t('action.stop'))}">${ctx.ui.icon('square')}</button>` : ''}
                <button class="btn btn-ghost btn-sm dk-danger" onclick="Ext.docker.down({project: ${js(k)}})" title="${esc(t('action.down'))}">${ctx.ui.icon('power')}</button>
              </span>`
          : `<h4>${ctx.ui.icon('box')} ${esc(t('containers.standalone'))}</h4>`;
        return `<div class="dk-group"><div class="dk-group-head">${head}</div>
          <table class="data-table dk-table"><thead><tr><th></th><th>${esc(t('col.name'))}</th><th>${esc(t('col.image'))}</th><th>${esc(t('col.state'))}</th><th>${esc(t('col.ports'))}</th>${statsCol ? `<th>${esc(t('col.stats'))}</th>` : ''}<th></th></tr></thead>
          <tbody>${items.map(containerRow).join('')}</tbody></table></div>`;
      }).join(''));
    }

    // ---- file compose ----
    const A = () => doc?.analysis || null;
    function renderFile() {
      if (!doc) return;
      const a = A();
      $(ctx.root, 'file-title').textContent = doc.file;
      const f = files.find(x => x.projectId === doc.projectId && x.file === doc.file);
      $(ctx.root, 'file-sub').textContent = [f?.projectLabel || doc.projectId, a?.projectName ? t('compose.projectName', { name: a.projectName }) : '', a?.companion ? t('compose.with', { file: a.companion }) : ''].filter(Boolean).join(' · ');
      $(ctx.root, 'dirty').hidden = !doc.dirty;
      ctx.root.querySelector('[data-action="save"]').disabled = !doc.dirty;
      ctx.root.querySelector('[data-action="revert"]').disabled = !doc.dirty || doc.hash == null;
      renderRunBar();
      const counts = { error: 0, warning: 0, info: 0 };
      for (const i of a?.issues || []) counts[i.level]++;
      const yamlErr = a?.yamlErrors?.length || 0;
      $(ctx.root, 'issues-count').innerHTML = yamlErr || counts.error ? `<span class="dk-c-error">${esc(fmt.number(yamlErr + counts.error))}</span>` : counts.warning ? `<span class="dk-c-warning">${esc(fmt.number(counts.warning))}</span>` : counts.info ? `<span class="dk-c-info">${esc(fmt.number(counts.info))}</span>` : '';
      for (const b of ctx.root.querySelectorAll('.dk-tab')) b.classList.toggle('active', b.dataset.tab === tab);
      for (const p of ctx.root.querySelectorAll('.dk-pane')) p.hidden = p.dataset.pane !== tab;
      if (tab === 'graph') { renderGraph(); renderSide(); }
      else if (tab === 'yaml') renderYamlStatus();
      else renderIssues();
    }

    function renderRunBar() {
      const a = A();
      const total = a?.model?.services?.length || 0;
      const up = Object.values(a?.running || {}).flat().filter(c => c.state === 'running').length;
      const saved = doc.hash != null;
      const dis = !saved || !status?.daemon ? 'disabled' : '';
      ctx.ui.patch($(ctx.root, 'run'), `
        <span class="dk-run-state ${up ? 'on' : ''}" title="${esc(t('compose.runningTitle'))}">${ctx.ui.icon('activity')} ${esc(t('compose.running', { up, total }))}</span>
        <span class="dk-split">
          <button class="btn btn-sm dk-up" onclick="Ext.docker.run('up')" ${dis} title="${esc(t(saved ? 'action.upTitle' : 'compose.saveFirst'))}">${ctx.ui.icon('play')} ${esc(t('action.up'))}</button>
          <button class="btn btn-sm dk-up dk-caret" onclick="Ext.docker.upMenu(event)" ${dis} title="${esc(t('action.upOptions'))}">${ctx.ui.icon('chevron-down')}</button>
        </span>
        <button class="btn btn-ghost btn-sm" onclick="Ext.docker.run('restart')" ${dis || (up ? '' : 'disabled')} title="${esc(t('action.restart'))}">${ctx.ui.icon('rotate-ccw')}</button>
        <button class="btn btn-ghost btn-sm" onclick="Ext.docker.run('stop')" ${dis || (up ? '' : 'disabled')} title="${esc(t('action.stop'))}">${ctx.ui.icon('square')}</button>
        <button class="btn btn-ghost btn-sm dk-danger" onclick="Ext.docker.down()" ${dis} title="${esc(t('action.down'))}">${ctx.ui.icon('power')}</button>
        <button class="btn btn-ghost btn-sm" onclick="Ext.docker.run('pull')" ${dis} title="${esc(t('action.pull'))}">${ctx.ui.icon('cloud-download')}</button>
        <button class="btn btn-ghost btn-sm" onclick="Ext.docker.run('build')" ${dis || (a?.model?.services?.some(s => s.build) ? '' : 'disabled')} title="${esc(t('action.build'))}">${ctx.ui.icon('hammer')}</button>
        <button class="btn btn-ghost btn-sm" onclick="Ext.docker.fileLogs()" ${dis} title="${esc(t('action.logs'))}">${ctx.ui.icon('scroll-text')}</button>`);
    }

    // ---- grafo: colonne per livello di dipendenza (le dipendenze a sinistra), volumi in prima colonna ----
    function layout(model) {
      const services = model.services;
      const byName = new Map(services.map(s => [s.name, s]));
      const level = new Map();
      const lv = (name, seen = new Set()) => {
        if (level.has(name)) return level.get(name);
        if (seen.has(name)) return 0;
        seen.add(name);
        const deps = byName.get(name).dependsOn.map(d => d.service).filter(n => byName.has(n));
        const l = deps.length ? Math.max(...deps.map(d => lv(d, seen))) + 1 : 0;
        level.set(name, l);
        return l;
      };
      services.forEach(s => lv(s.name));
      const volumes = [...new Set(services.flatMap(s => s.volumes.filter(v => v.type === 'volume' && v.source).map(v => v.source)))];
      const offset = volumes.length ? 1 : 0;
      const cols = [];
      for (const s of services) { const c = level.get(s.name) + offset; (cols[c] ||= []).push(s.name); }
      // ordine nella colonna: vicino alle proprie dipendenze (baricentro), poi per nome
      const row = new Map();
      cols.forEach((list, c) => {
        if (!list) return;
        list.sort((a, b) => {
          const bary = n => { const ds = byName.get(n).dependsOn.map(d => row.get(d.service)).filter(x => x != null); return ds.length ? ds.reduce((x, y) => x + y, 0) / ds.length : Infinity; };
          return bary(a) - bary(b) || a.localeCompare(b);
        });
        list.forEach((n, i) => row.set(n, i));
        if (c === 0 && !offset) return;
      });
      const pos = new Map();
      const colX = c => PAD + (c === 0 && offset ? 0 : (offset ? VOL_W + GAP_X : 0) + (c - offset) * (NODE_W + GAP_X));
      cols.forEach((list, c) => (list || []).forEach((n, i) => pos.set(n, { x: colX(c), y: PAD + i * (NODE_H + GAP_Y), w: NODE_W, h: NODE_H })));
      // volumi: vicino al primo servizio che li usa
      const vpos = new Map();
      const vOrder = volumes.map(v => ({ v, y: Math.min(...services.filter(s => s.volumes.some(x => x.source === v)).map(s => pos.get(s.name).y)) })).sort((a, b) => a.y - b.y);
      let lastY = -Infinity;
      for (const { v, y } of vOrder) { const yy = Math.max(y + (NODE_H - VOL_H) / 2, lastY + VOL_H + 12); vpos.set(v, { x: PAD, y: yy, w: VOL_W, h: VOL_H }); lastY = yy; }
      const all = [...pos.values(), ...vpos.values()];
      const width = Math.max(...all.map(p => p.x + p.w), 300) + PAD;
      const height = Math.max(...all.map(p => p.y + p.h), 120) + PAD;
      return { pos, vpos, volumes, width, height };
    }

    function renderGraph() {
      const el = $(ctx.root, 'graph');
      const a = A();
      if (!a) { ctx.ui.patch(el, ''); return; }
      if (a.yamlErrors.length) {
        ctx.ui.patch(el, `<div class="dk-graph-msg">${ctx.ui.icon('circle-x')} ${esc(t('compose.yamlInvalid', { line: a.yamlErrors[0].line ?? '?', message: a.yamlErrors[0].message }))}
          <button class="btn btn-ghost btn-sm" onclick="Ext.docker.setTab('yaml')">${esc(t('compose.openYaml'))}</button></div>`);
        return;
      }
      const model = a.model;
      if (!model.services.length) {
        ctx.ui.patch(el, `<div class="dk-graph-msg">${ctx.ui.icon('workflow')} ${esc(t('graph.empty'))}</div>`);
        return;
      }
      const L = layout(model);
      const issuesBy = new Map();
      for (const i of a.issues) if (i.service) issuesBy.set(i.service, [...(issuesBy.get(i.service) || []), i]);
      const nets = model.networks.filter(n => n !== 'default');
      const netColor = n => NET_COLORS[nets.indexOf(n) % NET_COLORS.length];
      const edges = [];
      for (const s of model.services) {
        const from = L.pos.get(s.name);
        for (const d of s.dependsOn) {
          const to = L.pos.get(d.service);
          if (!to) continue;
          const x1 = from.x, y1 = from.y + from.h / 2, x2 = to.x + to.w, y2 = to.y + to.h / 2;
          const back = x2 > x1; // ciclo o stesso livello
          const mx = back ? Math.max(x1, x2) + 60 : (x1 + x2) / 2;
          const path = back ? `M${x1},${y1} C${x1 - 60},${y1} ${mx},${y2} ${x2},${y2}` : `M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}`;
          const cond = d.condition === 'service_healthy' ? 'healthy' : d.condition === 'service_completed_successfully' ? 'completed' : 'started';
          edges.push(`<path class="dk-edge dk-edge-${cond} ${selected && (selected === s.name || selected === d.service) ? 'hl' : ''}" d="${path}" marker-end="url(#dk-arrow-${cond})"><title>${esc(`${s.name} → ${d.service} (${t(`condition.${d.condition}`)})`)}</title></path>`);
        }
        for (const v of s.volumes.filter(v => v.type === 'volume' && v.source)) {
          const vp = L.vpos.get(v.source);
          if (!vp) continue;
          const x1 = from.x, y1 = from.y + from.h / 2, x2 = vp.x + vp.w, y2 = vp.y + vp.h / 2, mx = (x1 + x2) / 2;
          edges.push(`<path class="dk-edge dk-edge-vol ${selected === s.name ? 'hl' : ''}" d="M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}"><title>${esc(`${s.name}: ${v.source} → ${v.target}`)}</title></path>`);
        }
      }
      const marker = (id, cls) => `<marker id="dk-arrow-${id}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path class="${cls}" d="M0,0 L10,5 L0,10 z"/></marker>`;
      const node = s => {
        const p = L.pos.get(s.name);
        const run = a.running[s.name] || [];
        const c0 = run[0];
        const st = c0 ? stateClass(c0) : 'none';
        const iss = issuesBy.get(s.name) || [];
        const worst = iss.some(i => i.level === 'error') ? 'error' : iss.some(i => i.level === 'warning') ? 'warning' : iss.length ? 'info' : '';
        const kind = kindOf(s.image);
        const portsHtml = s.ports.map(pt => {
          const host = pt.published != null ? `${pt.hostIp && !['0.0.0.0', '::'].includes(pt.hostIp) ? `${pt.hostIp}:` : ''}${pt.published}→` : '';
          const live = c0?.ports?.find(x => String(x.container) === String(pt.target));
          const text = `${host}${pt.target}`;
          return live && c0.state === 'running' ? `<a class="dk-port" href="http://localhost:${esc(live.hostPort)}" target="_blank" rel="noopener" onclick="event.stopPropagation()">${esc(text)}</a>` : `<span class="dk-port ${pt.published == null ? 'dk-port-int' : ''}">${esc(text)}</span>`;
        }).join('');
        return `<div class="dk-node ${selected === s.name ? 'sel' : ''} ${worst ? `dk-has-${worst}` : ''}" style="left:${p.x}px;top:${p.y}px;width:${p.w}px;height:${p.h}px"
            data-service="${esc(s.name)}" tabindex="0" onclick="Ext.docker.select(${js(s.name)})" oncontextmenu="Ext.docker.nodeMenu(event, ${js(s.name)})"
            onkeydown="if(event.key==='Enter')Ext.docker.select(${js(s.name)})">
          ${s.networks.filter(n => nets.includes(n)).length ? `<div class="dk-node-nets">${s.networks.filter(n => nets.includes(n)).map(n => `<span style="background:${netColor(n)}" title="${esc(t('graph.network', { name: n }))}"></span>`).join('')}</div>` : ''}
          <div class="dk-node-head">
            <span class="dk-dot ${st}" title="${esc(c0 ? stateText(c0) : t('state.notCreated'))}"></span>
            <span class="dk-node-name">${esc(s.name)}</span>
            ${run.length > 1 ? `<span class="dk-node-rep">×${esc(run.length)}</span>` : ''}
            <span class="dk-node-kind" title="${esc(t(`kind.${kind}`))}">${ctx.ui.icon(KIND_ICON[kind] || 'box')}</span>
            ${iss.length ? `<span class="dk-node-issues dk-c-${worst}" title="${esc(iss.map(issueText).join('\n'))}">${levelIcon(worst)}${esc(iss.length)}</span>` : ''}
          </div>
          <div class="dk-node-img" title="${esc(s.image || '')}">${s.build ? `${ctx.ui.icon('hammer')} ${esc(s.build.context)}${s.image ? ` · ${esc(s.image)}` : ''}` : esc(s.image || t('graph.noImage'))}</div>
          <div class="dk-node-ports">${portsHtml || `<span class="dk-muted">${esc(t('graph.noPorts'))}</span>`}</div>
          <div class="dk-node-foot">
            ${s.healthcheck ? `<span title="${esc(t('graph.healthcheck'))}">${ctx.ui.icon('heart-pulse')}</span>` : ''}
            ${s.volumes.length ? `<span title="${esc(s.volumes.map(v => `${v.source || '—'} → ${v.target}`).join('\n'))}">${ctx.ui.icon('hard-drive')} ${esc(s.volumes.length)}</span>` : ''}
            ${Object.keys(s.environment).length ? `<span title="${esc(Object.keys(s.environment).join('\n'))}">${ctx.ui.icon('variable')} ${esc(Object.keys(s.environment).length)}</span>` : ''}
            ${s.profiles.length ? `<span class="dk-profile" title="${esc(t('graph.profiles'))}">${esc(s.profiles.join(', '))}</span>` : ''}
            ${c0?.state === 'running' && c0.startedAt ? `<span class="dk-muted" data-uptime="${esc(c0.startedAt)}"></span>` : ''}
          </div>
        </div>`;
      };
      const vol = v => { const p = L.vpos.get(v); return `<div class="dk-vol ${model.volumes.includes(v) ? '' : 'dk-has-error'}" style="left:${p.x}px;top:${p.y}px;width:${p.w}px;height:${p.h}px" title="${esc(t('graph.volume', { name: v }))}">${ctx.ui.icon('hard-drive')} <span>${esc(v)}</span></div>`; };
      ctx.ui.patch(el, `
        <div class="dk-graph-tools">
          <button class="btn btn-ghost btn-sm" onclick="Ext.docker.zoom(-1)" title="${esc(t('graph.zoomOut'))}">${ctx.ui.icon('zoom-out')}</button>
          <span class="dk-muted">${esc(fmt.number(Math.round(zoom * 100)))}%</span>
          <button class="btn btn-ghost btn-sm" onclick="Ext.docker.zoom(1)" title="${esc(t('graph.zoomIn'))}">${ctx.ui.icon('zoom-in')}</button>
          <span class="dk-legend"><i class="dk-l-started"></i>${esc(t('condition.service_started'))} <i class="dk-l-healthy"></i>${esc(t('condition.service_healthy'))} <i class="dk-l-vol"></i>${esc(t('graph.volumes'))}
            ${nets.map(n => `<span class="dk-l-net" style="background:${netColor(n)}"></span>${esc(n)}`).join(' ')}</span>
        </div>
        <div class="dk-graph-scroll" onclick="if(event.target===this||event.target.classList.contains('dk-canvas'))Ext.docker.select(null)">
          <div class="dk-canvas" style="width:${L.width}px;height:${L.height}px;transform:scale(${zoom});margin-right:${L.width * (zoom - 1)}px;margin-bottom:${L.height * (zoom - 1)}px">
            <svg class="dk-edges" width="${L.width}" height="${L.height}">
              <defs>${marker('started', 'dk-m-started')}${marker('healthy', 'dk-m-healthy')}${marker('completed', 'dk-m-completed')}</defs>
              ${edges.join('')}
            </svg>
            ${L.volumes.map(vol).join('')}
            ${model.services.map(node).join('')}
          </div>
        </div>`);
    }

    // ---- pannello a destra: servizio selezionato o file ----
    function draftOf(name) {
      const raw = structuredClone(A()?.rawServices?.[name] || {});
      const envRaw = raw.environment;
      const env = Array.isArray(envRaw) ? envRaw.map(e => { const s = String(e); const i = s.indexOf('='); return i < 0 ? [s, null] : [s.slice(0, i), s.slice(i + 1)]; })
        : envRaw && typeof envRaw === 'object' ? Object.entries(envRaw).map(([k, v]) => [k, v == null ? null : String(v)]) : [];
      const dep = raw.depends_on;
      const depends = Array.isArray(dep) ? Object.fromEntries(dep.map(d => [String(d), 'service_started'])) : dep && typeof dep === 'object' ? Object.fromEntries(Object.entries(dep).map(([k, v]) => [k, v?.condition || 'service_started'])) : {};
      return {
        original: name, name, raw,
        image: raw.image ?? '',
        buildContext: typeof raw.build === 'string' ? raw.build : raw.build?.context ?? '',
        dockerfile: typeof raw.build === 'object' && raw.build ? raw.build.dockerfile ?? '' : '',
        command: Array.isArray(raw.command) ? raw.command.join(' ') : raw.command ?? '',
        ports: [...(raw.ports || [])], env, envList: Array.isArray(envRaw),
        volumes: [...(raw.volumes || [])], depends, dependsShort: Array.isArray(dep) || !dep,
        restart: raw.restart ?? '',
        networks: Array.isArray(raw.networks) ? raw.networks.map(String) : raw.networks && typeof raw.networks === 'object' ? Object.keys(raw.networks) : [],
        profiles: (raw.profiles || []).join(', '),
        healthcheck: raw.healthcheck ?? null,
      };
    }
    // bozza → valori YAML del servizio (le chiavi non toccate dall'editor restano come sono)
    function serviceFromDraft(dr) {
      const s = structuredClone(dr.raw);
      const put = (k, v, empty) => { if (empty) delete s[k]; else s[k] = v; };
      put('image', dr.image.trim(), !dr.image.trim());
      if (dr.buildContext.trim()) {
        const ctxDir = dr.buildContext.trim(), df = dr.dockerfile.trim();
        s.build = typeof dr.raw.build === 'object' && dr.raw.build ? { ...dr.raw.build, context: ctxDir, ...(df ? { dockerfile: df } : {}) } : df ? { context: ctxDir, dockerfile: df } : ctxDir;
        if (typeof s.build === 'object' && !df) delete s.build.dockerfile;
      } else delete s.build;
      const origCmd = Array.isArray(dr.raw.command) ? dr.raw.command.join(' ') : dr.raw.command ?? '';
      if (dr.command.trim() !== String(origCmd).trim()) put('command', dr.command.trim(), !dr.command.trim());
      const ports = dr.ports.filter(p => typeof p === 'object' || String(p).trim()).map(p => (typeof p === 'object' ? p : String(p).trim()));
      put('ports', ports, !ports.length);
      const env = dr.env.filter(([k]) => String(k).trim());
      put('environment', dr.envList ? env.map(([k, v]) => (v == null ? k.trim() : `${k.trim()}=${v}`)) : Object.fromEntries(env.map(([k, v]) => [k.trim(), v])), !env.length);
      const vols = dr.volumes.filter(v => typeof v === 'object' || String(v).trim()).map(v => (typeof v === 'object' ? v : String(v).trim()));
      put('volumes', vols, !vols.length);
      const deps = Object.entries(dr.depends).filter(([, c]) => c);
      if (!deps.length) delete s.depends_on;
      else if (dr.dependsShort && deps.every(([, c]) => c === 'service_started')) s.depends_on = deps.map(([n]) => n);
      else {
        const old = dr.raw.depends_on && !Array.isArray(dr.raw.depends_on) ? dr.raw.depends_on : {};
        s.depends_on = Object.fromEntries(deps.map(([n, c]) => [n, { ...(old[n] && typeof old[n] === 'object' ? old[n] : {}), condition: c }]));
      }
      put('restart', dr.restart, !dr.restart);
      if (!dr.networks.length) delete s.networks;
      else if (dr.raw.networks && !Array.isArray(dr.raw.networks)) s.networks = Object.fromEntries(dr.networks.map(n => [n, dr.raw.networks[n] ?? null]));
      else s.networks = dr.networks;
      const profiles = dr.profiles.split(',').map(x => x.trim()).filter(Boolean);
      put('profiles', profiles, !profiles.length);
      if (dr.healthcheck) s.healthcheck = dr.healthcheck; else delete s.healthcheck;
      return s;
    }
    const listRows = (field, rows, placeholder) => rows.map((v, i) => typeof v === 'object'
      ? `<div class="dk-row"><code class="dk-long" title="${esc(t('editor.longSyntax'))}">${esc(JSON.stringify(v))}</code><button class="btn btn-ghost btn-sm" onclick="Ext.docker.draftRemove('${field}', ${i})">${ctx.ui.icon('x')}</button></div>`
      : `<div class="dk-row"><input class="form-input dk-mono" data-draft="${field}" data-index="${i}" value="${esc(v)}" placeholder="${esc(placeholder)}" spellcheck="false"><button class="btn btn-ghost btn-sm" onclick="Ext.docker.draftRemove('${field}', ${i})" title="${esc(t('editor.removeRow'))}">${ctx.ui.icon('x')}</button></div>`).join('');

    function renderSide() {
      const el = $(ctx.root, 'side');
      const a = A();
      if (!a || a.yamlErrors.length) { ctx.ui.patch(el, ''); return; }
      if (selected && draft) { ctx.ui.patch(el, serviceEditor()); return; }
      ctx.ui.patch(el, filePanel());
    }
    function serviceEditor() {
      const a = A(), dr = draft;
      const s = a.model.services.find(x => x.name === dr.original);
      const others = a.model.services.filter(x => x.name !== dr.original);
      const run = a.running[dr.original] || [];
      const iss = a.issues.filter(i => i.service === dr.original);
      const hcKnown = !!templatesList.length && ['db', 'cache', 'queue'].includes(kindOf(dr.image));
      return `<div class="dk-side-head">
          <h4>${ctx.ui.icon(KIND_ICON[kindOf(dr.image)] || 'box')} ${esc(dr.original)}</h4>
          <button class="btn btn-ghost btn-sm" onclick="Ext.docker.select(null)" title="${esc(t('core.action.close'))}">${ctx.ui.icon('x')}</button>
        </div>
        ${run.length ? `<div class="dk-side-run">${run.map(c => `<span class="dk-state dk-${stateClass(c)}">${esc(c.name)} · ${esc(stateText(c))}</span>`).join(' ')}
          <span class="dk-side-run-actions">
            <button class="btn btn-ghost btn-sm" onclick="Ext.docker.serviceLogs(${js(dr.original)})" title="${esc(t('action.logs'))}">${ctx.ui.icon('scroll-text')}</button>
            <button class="btn btn-ghost btn-sm" onclick="Ext.docker.run('restart', null, [${js(dr.original)}])" title="${esc(t('action.restart'))}">${ctx.ui.icon('rotate-ccw')}</button>
          </span></div>` : ''}
        ${iss.length ? `<div class="dk-side-issues">${iss.map(i => `<div class="dk-issue-mini dk-c-${i.level}">${levelIcon(i.level)} <span>${esc(issueText(i))}</span>${i.fix ? ` <button class="btn btn-ghost btn-sm" onclick="Ext.docker.fixIssue(${a.issues.indexOf(i)})">${ctx.ui.icon('wand-sparkles')} ${esc(t(`fix.${i.fix}`))}</button>` : ''}</div>`).join('')}</div>` : ''}
        <div class="dk-form">
          <div class="form-row"><label>${esc(t('editor.name'))}</label><input class="form-input dk-mono" data-draft="name" value="${esc(dr.name)}" spellcheck="false"></div>
          <div class="form-row"><label>${esc(t('editor.image'))}</label><input class="form-input dk-mono" data-draft="image" value="${esc(dr.image)}" placeholder="postgres:17" spellcheck="false"></div>
          <div class="form-grid">
            <div class="form-row"><label>${esc(t('editor.build'))}</label><input class="form-input dk-mono" data-draft="buildContext" value="${esc(dr.buildContext)}" placeholder="./api" spellcheck="false"></div>
            <div class="form-row"><label>${esc(t('editor.dockerfile'))}</label><input class="form-input dk-mono" data-draft="dockerfile" value="${esc(dr.dockerfile)}" placeholder="Dockerfile" spellcheck="false"></div>
          </div>
          <div class="form-row"><label>${esc(t('editor.command'))}</label><input class="form-input dk-mono" data-draft="command" value="${esc(dr.command)}" spellcheck="false"></div>
          <div class="dk-fieldset"><div class="dk-fs-head">${ctx.ui.icon('plug')} ${esc(t('editor.ports'))}<button class="btn btn-ghost btn-sm" onclick="Ext.docker.draftAdd('ports')">${ctx.ui.icon('plus')}</button></div>
            ${listRows('ports', dr.ports, '127.0.0.1:8080:80')}<p class="dk-hint">${esc(t('editor.portsHint'))}</p></div>
          <div class="dk-fieldset"><div class="dk-fs-head">${ctx.ui.icon('variable')} ${esc(t('editor.environment'))}<button class="btn btn-ghost btn-sm" onclick="Ext.docker.draftAdd('env')">${ctx.ui.icon('plus')}</button></div>
            ${dr.env.map(([k, v], i) => `<div class="dk-row dk-env-row">
              <input class="form-input dk-mono" data-draft="envKey" data-index="${i}" value="${esc(k)}" placeholder="NAME" spellcheck="false">
              <input class="form-input dk-mono ${/(PASSWORD|SECRET|TOKEN|KEY)/i.test(k) && v && !String(v).includes('$') ? 'dk-warn' : ''}" data-draft="envValue" data-index="${i}" value="${esc(v ?? '')}" placeholder="${esc(v == null ? t('editor.fromHost') : '')}" spellcheck="false"
                ${/(PASSWORD|SECRET|TOKEN|KEY)/i.test(k) && v && !String(v).includes('$') ? `title="${esc(t('editor.secretHint'))}"` : ''}>
              <button class="btn btn-ghost btn-sm" onclick="Ext.docker.draftRemove('env', ${i})" title="${esc(t('editor.removeRow'))}">${ctx.ui.icon('x')}</button></div>`).join('')}
            <p class="dk-hint">${esc(t('editor.envHint'))}</p></div>
          <div class="dk-fieldset"><div class="dk-fs-head">${ctx.ui.icon('hard-drive')} ${esc(t('editor.volumes'))}<button class="btn btn-ghost btn-sm" onclick="Ext.docker.draftAdd('volumes')">${ctx.ui.icon('plus')}</button></div>
            ${listRows('volumes', dr.volumes, 'data:/var/lib/data')}<p class="dk-hint">${esc(t('editor.volumesHint'))}</p></div>
          ${others.length ? `<div class="dk-fieldset"><div class="dk-fs-head">${ctx.ui.icon('git-fork')} ${esc(t('editor.dependsOn'))}</div>
            ${others.map(o => `<div class="dk-row dk-dep-row"><label class="dk-check"><input type="checkbox" data-draft="dep" data-service="${esc(o.name)}" ${dr.depends[o.name] ? 'checked' : ''}> <span class="dk-mono">${esc(o.name)}</span></label>
              <select class="form-input" data-draft="depCond" data-service="${esc(o.name)}" ${dr.depends[o.name] ? '' : 'disabled'}>
                ${CONDITIONS.map(c => `<option value="${c}" ${(dr.depends[o.name] || 'service_started') === c ? 'selected' : ''}>${esc(t(`condition.${c}`))}</option>`).join('')}</select></div>`).join('')}</div>` : ''}
          <div class="dk-fieldset"><div class="dk-fs-head">${ctx.ui.icon('heart-pulse')} ${esc(t('editor.healthcheck'))}
              ${dr.healthcheck ? `<button class="btn btn-ghost btn-sm" onclick="Ext.docker.draftHealth(false)">${ctx.ui.icon('x')} ${esc(t('editor.remove'))}</button>` : hcKnown ? `<button class="btn btn-ghost btn-sm" onclick="Ext.docker.draftHealth(true)">${ctx.ui.icon('plus')} ${esc(t('editor.addRecommended'))}</button>` : ''}</div>
            ${dr.healthcheck ? `<code class="dk-long">${esc(Array.isArray(dr.healthcheck.test) ? dr.healthcheck.test.join(' ') : String(dr.healthcheck.test ?? ''))}</code>` : `<p class="dk-hint">${esc(t(hcKnown ? 'editor.healthcheckNone' : 'editor.healthcheckYaml'))}</p>`}</div>
          <div class="form-grid">
            <div class="form-row"><label>${esc(t('editor.restart'))}</label><select class="form-input" data-draft="restart">${RESTARTS.map(r => `<option value="${r}" ${dr.restart === r ? 'selected' : ''}>${esc(r || '—')}</option>`).join('')}</select></div>
            <div class="form-row"><label>${esc(t('editor.profiles'))}</label><input class="form-input dk-mono" data-draft="profiles" value="${esc(dr.profiles)}" placeholder="debug, tools" spellcheck="false"></div>
          </div>
          ${a.model.networks.length ? `<div class="dk-fieldset"><div class="dk-fs-head">${ctx.ui.icon('network')} ${esc(t('editor.networks'))}</div>
            ${a.model.networks.map(n => `<label class="dk-check"><input type="checkbox" data-draft="net" data-network="${esc(n)}" ${dr.networks.includes(n) ? 'checked' : ''}> <span class="dk-mono">${esc(n)}</span></label>`).join(' ')}</div>` : ''}
        </div>
        <div class="dk-side-foot">
          <button class="btn btn-ghost btn-sm dk-danger" onclick="Ext.docker.removeService(${js(dr.original)})">${ctx.ui.icon('trash-2')} ${esc(t('editor.removeService'))}</button>
          <span class="dk-spacer"></span>
          <button class="btn btn-ghost btn-sm" onclick="Ext.docker.select(${js(dr.original)}, true)">${esc(t('editor.reset'))}</button>
          <button class="btn btn-primary btn-sm" onclick="Ext.docker.applyDraft()">${ctx.ui.icon('check')} ${esc(t('editor.apply'))}</button>
        </div>`;
    }
    function filePanel() {
      const a = A();
      const m = a.model;
      const vars = a.variablesUsed || [];
      return `<div class="dk-side-head"><h4>${ctx.ui.icon('file-code')} ${esc(doc.file)}</h4></div>
        <div class="dk-fieldset"><div class="dk-fs-head">${ctx.ui.icon('plus')} ${esc(t('panel.addService'))}</div>
          <div class="dk-templates">${templatesList.map(tp => `<button class="dk-template" onclick="Ext.docker.addTemplate(${js(tp.id)})" title="${esc(tp.image || tp.build || '')}">
            ${ctx.ui.icon(KIND_ICON[tp.kind] || 'box')}<span>${esc(t(`template.${tp.id}`))}</span><small>${esc(tp.image || (tp.build ? `build ${tp.build}` : ''))}</small></button>`).join('')}</div></div>
        <div class="dk-fieldset"><div class="dk-fs-head">${ctx.ui.icon('tag')} ${esc(t('panel.projectName'))}</div>
          <div class="dk-row"><input class="form-input dk-mono" id="dk_pname" value="${esc(m.name || '')}" placeholder="${esc(a.projectName || '')}" spellcheck="false">
            <button class="btn btn-ghost btn-sm" onclick="Ext.docker.setName()">${ctx.ui.icon('check')}</button></div>
          <p class="dk-hint">${esc(t('panel.projectNameHint'))}</p></div>
        <div class="dk-fieldset"><div class="dk-fs-head">${ctx.ui.icon('hard-drive')} ${esc(t('panel.volumes'))}</div>
          ${m.volumes.map(v => `<div class="dk-row"><span class="dk-mono dk-grow">${esc(v)}${m.externalVolumes.includes(v) ? ` <span class="dk-muted">${esc(t('panel.external'))}</span>` : ''}</span>
            <button class="btn btn-ghost btn-sm" onclick="Ext.docker.undeclare('volumes', ${js(v)})" title="${esc(t('editor.removeRow'))}">${ctx.ui.icon('x')}</button></div>`).join('')}
          <div class="dk-row"><input class="form-input dk-mono" id="dk_newvol" placeholder="${esc(t('panel.newVolume'))}" spellcheck="false"><button class="btn btn-ghost btn-sm" onclick="Ext.docker.declare('volumes', 'dk_newvol')">${ctx.ui.icon('plus')}</button></div></div>
        <div class="dk-fieldset"><div class="dk-fs-head">${ctx.ui.icon('network')} ${esc(t('panel.networks'))}</div>
          ${m.networks.map(n => `<div class="dk-row"><span class="dk-mono dk-grow">${esc(n)}${m.externalNetworks.includes(n) ? ` <span class="dk-muted">${esc(t('panel.external'))}</span>` : ''}</span>
            <button class="btn btn-ghost btn-sm" onclick="Ext.docker.undeclare('networks', ${js(n)})" title="${esc(t('editor.removeRow'))}">${ctx.ui.icon('x')}</button></div>`).join('')}
          <div class="dk-row"><input class="form-input dk-mono" id="dk_newnet" placeholder="${esc(t('panel.newNetwork'))}" spellcheck="false"><button class="btn btn-ghost btn-sm" onclick="Ext.docker.declare('networks', 'dk_newnet')">${ctx.ui.icon('plus')}</button></div></div>
        ${vars.length ? `<div class="dk-fieldset"><div class="dk-fs-head">${ctx.ui.icon('variable')} ${esc(t('panel.variables'))}</div>
          <table class="dk-vars">${vars.map(v => {
            const missing = a.variables.missing.includes(v.name) || a.variables.required.some(r => r.name === v.name);
            const src = a.dotenv.includes(v.name) ? 'dotenv' : missing ? 'missing' : v.default != null && !a.variables.missing.includes(v.name) ? 'default' : 'env';
            return `<tr><td class="dk-mono">${esc(v.name)}</td><td><span class="dk-var dk-var-${src}">${esc(t(`panel.var.${src}`))}</span></td><td class="dk-mono dk-muted">${esc(v.default ?? '')}</td></tr>`;
          }).join('')}</table><p class="dk-hint">${esc(t('panel.variablesHint'))}</p></div>` : ''}`;
    }

    // ---- YAML e problemi ----
    function renderYamlStatus() {
      const ta = $(ctx.root, 'yaml');
      if (document.activeElement !== ta && ta.value !== doc.text) ta.value = doc.text;
      const a = A();
      const el = $(ctx.root, 'yaml-status');
      if (!a) { el.innerHTML = ''; return; }
      if (a.yamlErrors.length) { ctx.ui.patch(el, a.yamlErrors.map(e => `<button class="dk-yaml-err" onclick="Ext.docker.gotoLine(${Number(e.line) || 1})">${ctx.ui.icon('circle-x')} ${esc(t('compose.yamlInvalid', { line: e.line ?? '?', message: e.message }))}</button>`).join('')); return; }
      const n = a.issues.filter(i => i.level !== 'info').length;
      ctx.ui.patch(el, `<span class="dk-ok-text">${ctx.ui.icon('check')} ${esc(t('compose.yamlOk', { count: a.model.services.length }))}</span>${n ? ` · <button class="dk-link" onclick="Ext.docker.setTab('issues')">${esc(t('compose.issuesCount', { count: n }))}</button>` : ''}`);
    }
    function renderIssues() {
      const el = $(ctx.root, 'issues');
      const a = A();
      if (!a) { ctx.ui.patch(el, ''); return; }
      const rows = [
        ...a.yamlErrors.map(e => ({ level: 'error', text: t('compose.yamlInvalid', { line: e.line ?? '?', message: e.message }), yaml: e.line })),
        ...a.issues.map((i, idx) => ({ level: i.level, text: issueText(i), service: i.service, fix: i.fix, idx, code: i.code, params: i.params })),
      ];
      if (!rows.length) { ctx.ui.patch(el, `<div class="empty-state"><div class="icon">${ctx.ui.icon('badge-check')}</div><p>${esc(t('issues.none'))}</p></div>`); return; }
      const fixable = a.issues.filter(i => i.fix && ['remove_version', 'declare_volume', 'declare_network', 'bind_localhost', 'add_healthcheck', 'wait_healthy'].includes(i.fix)).length;
      ctx.ui.patch(el, `${fixable > 1 ? `<div class="dk-issues-head"><button class="btn btn-sm" onclick="Ext.docker.fixAll()">${ctx.ui.icon('wand-sparkles')} ${esc(t('issues.fixAll', { count: fixable }))}</button><span class="dk-hint">${esc(t('issues.fixAllHint'))}</span></div>` : ''}
        <table class="data-table dk-issues"><tbody>${rows.map(r => `<tr class="dk-issue-${r.level}">
          <td class="dk-c-${r.level}">${levelIcon(r.level)}</td>
          <td>${esc(r.text)}${r.code && HELP.has(r.code) ? `<span class="dk-sub dk-help">${esc(t(`issueHelp.${r.code}`, r.params))}</span>` : ''}</td>
          <td>${r.service ? `<button class="dk-chip" onclick="Ext.docker.select(${js(r.service)}); Ext.docker.setTab('graph')">${esc(r.service)}</button>` : ''}</td>
          <td class="dk-actions">${r.fix ? `<button class="btn btn-ghost btn-sm" onclick="Ext.docker.fixIssue(${r.idx})">${ctx.ui.icon('wand-sparkles')} ${esc(t(`fix.${r.fix}`))}</button>` : r.yaml ? `<button class="btn btn-ghost btn-sm" onclick="Ext.docker.gotoLine(${Number(r.yaml) || 1})">${esc(t('compose.openYaml'))}</button>` : ''}</td>
        </tr>`).join('')}</tbody></table>`);
    }

    // ---- caricamento, analisi, modifiche ----
    async function openFile(projectId, file, { fresh = false, text = null } = {}) {
      if (doc?.dirty && !(doc.projectId === projectId && doc.file === file) && !confirm(t('compose.discard'))) return;
      try {
        let r;
        if (text != null) {
          r = await ctx.api.post('/compose/analyze', { projectId, file, text });
          doc = { projectId, file, text, hash: null, analysis: r, dirty: true };
        } else {
          r = await ctx.api.post('/compose/load', { projectId, file });
          doc = { projectId, file, text: r.text, hash: r.hash, analysis: r, dirty: false };
        }
        view = { kind: 'file', projectId, file };
        if (!fresh) { selected = null; draft = null; }
        if (selected && !doc.analysis.model.services.some(s => s.name === selected)) { selected = null; draft = null; }
        store.set({ last: { projectId, file } });
        showArea();
        $(ctx.root, 'yaml').value = doc.text;
        renderNav(); renderFile();
      } catch (e) { toast(e.message, 'error'); }
    }
    async function refreshAnalysis() {
      if (!doc) return;
      const seq = ++analyzeSeq;
      try {
        const r = await ctx.api.post('/compose/analyze', { projectId: doc.projectId, file: doc.file, text: doc.text });
        if (seq !== analyzeSeq) return;
        doc.analysis = r;
        if (selected && !r.model.services.some(s => s.name === selected)) { selected = null; draft = null; }
        renderFile();
      } catch (e) { toast(e.message, 'error'); }
    }
    async function applyOps(ops, { select: sel } = {}) {
      try {
        const r = await ctx.api.post('/compose/edit', { projectId: doc.projectId, file: doc.file, text: doc.text, ops });
        const { text, added, ...analysis } = r;
        doc.text = text; doc.analysis = analysis; doc.dirty = true;
        $(ctx.root, 'yaml').value = text;
        if (sel !== undefined) { selected = sel; draft = sel ? draftOf(sel) : null; }
        else if (added) { selected = added; draft = draftOf(added); }
        else if (selected) draft = analysis.model.services.some(s => s.name === selected) ? draftOf(selected) : (selected = null);
        renderNav(); renderFile();
        return true;
      } catch (e) { toast(e.message, 'error'); return false; }
    }
    async function save({ force = false } = {}) {
      if (!doc) return;
      try {
        let hash = doc.hash;
        if (force) { try { hash = (await ctx.api.post('/compose/load', { projectId: doc.projectId, file: doc.file })).hash; } catch { hash = null; } }
        const r = await ctx.api.post('/compose/save', { projectId: doc.projectId, file: doc.file, text: doc.text, hash });
        doc.hash = r.hash; doc.dirty = false;
        toast(t(r.created ? 'compose.created' : 'compose.saved', { file: doc.file }), 'success');
        if (r.created) { try { files = (await ctx.api.get('/files')).files; } catch { /* resta l'elenco */ } }
        renderNav(); renderFile();
      } catch (e) {
        if (e.status === 409 && confirm(t('compose.changedOnDisk'))) return save({ force: true });
        toast(e.message, 'error');
      }
    }

    // ---- job e log nel pannello in basso ----
    function followJob(job) {
      closeLogs?.();
      output.open(job.title);
      output.append(`$ ${job.command}\n`, 'sys');
      closeLogs = ctx.api.events(`/jobs/${encodeURIComponent(job.id)}/stream`, ev => {
        if (ev.type === 'chunk') output.append(ev.data.text, 'out');
        else if (ev.type === 'exit') {
          output.append(`\n[${t(ev.data === 0 ? 'job.done' : 'job.failed', { code: ev.data ?? '?' })}]\n`, 'sys');
          closeLogs?.(); closeLogs = null;
          if (ev.data === 0) toast(t('job.doneToast', { title: job.title }), 'success'); else toast(t('job.failedToast', { title: job.title }), 'error');
          reloadSoon();
        }
      }, () => { closeLogs = null; });
    }
    function streamLogs(title, url) {
      closeLogs?.();
      output.open(title);
      closeLogs = ctx.api.events(url, ev => {
        if (ev.type === 'stdout') output.append(ev.data);
        else if (ev.type === 'stderr') output.append(ev.data, 'err');
        else if (ev.type === 'exit') { output.append(`\n[${t('logs.ended')}]\n`, 'sys'); closeLogs?.(); closeLogs = null; }
      }, () => { closeLogs = null; });
    }
    const fileTarget = () => ({ projectId: doc.projectId, file: doc.file });

    function showArea() {
      $(ctx.root, 'containers-area').hidden = view.kind !== 'containers';
      $(ctx.root, 'compose-area').hidden = view.kind !== 'file';
    }

    // ---- azioni ----
    const actions = {
      async recheck() { await loadStatus(); renderNotice(); await loadOverview(); renderNav(); renderContainers(); startEvents(); },
      showContainers(project) {
        if (doc?.dirty && view.kind === 'file' && !confirm(t('compose.discard'))) return;
        if (view.kind === 'file' && doc?.dirty) doc = null;
        view = { kind: 'containers' };
        if (project) { filter = project; $(ctx.root, 'filter').value = project; }
        showArea(); renderNav(); renderContainers();
      },
      openFile: (projectId, file) => openFile(projectId, file),
      setTab(name) {
        if (tab === 'yaml' && name !== 'yaml') { clearTimeout(analyzeTimer); }
        tab = name; store.set({ tab }); renderFile();
        if (name === 'yaml') setTimeout(() => $(ctx.root, 'yaml').focus(), 0);
      },
      select(name, reset = false) {
        if (!name) { selected = null; draft = null; renderGraph(); renderSide(); return; }
        if (selected === name && draft && !reset) return;
        selected = name; draft = draftOf(name);
        renderGraph(); renderSide();
      },
      zoom(dir) { zoom = Math.min(1.6, Math.max(0.5, Math.round((zoom + dir * 0.1) * 10) / 10)); store.set({ zoom }); renderGraph(); },
      draftAdd(field) {
        if (field === 'env') draft.env.push(['', '']); else draft[field].push('');
        renderSide();
        const inputs = $(ctx.root, 'side').querySelectorAll(`[data-draft="${field === 'env' ? 'envKey' : field}"]`);
        inputs[inputs.length - 1]?.focus();
      },
      draftRemove(field, i) { draft[field].splice(i, 1); renderSide(); },
      draftHealth(on) {
        if (!on) draft.healthcheck = null;
        else { applyOps([{ op: 'setService', name: draft.original, service: serviceFromDraft(draft) }, { op: 'fix', issue: { fix: 'add_healthcheck', target: draft.original } }]); return; }
        renderSide();
      },
      async applyDraft() {
        const dr = draft;
        const ops = [];
        const name = dr.name.trim();
        if (name !== dr.original) ops.push({ op: 'renameService', from: dr.original, to: name });
        ops.push({ op: 'setService', name, service: serviceFromDraft(dr) });
        for (const v of serviceFromDraft(dr).volumes || []) {
          const src = typeof v === 'string' ? v.split(':')[0] : v.type === 'volume' ? v.source : null;
          if (src && /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(src) && v.split?.(':').length > 1 && !A().model.volumes.includes(src)) ops.push({ op: 'declare', kind: 'volumes', name: src });
        }
        if (await applyOps(ops, { select: name })) toast(t('editor.applied', { service: name }), 'success');
      },
      removeService(name) { if (confirm(t('editor.confirmRemove', { service: name }))) applyOps([{ op: 'removeService', name }], { select: null }); },
      addTemplate(id) { applyOps([{ op: 'addTemplate', template: id }]); },
      setName() { applyOps([{ op: 'setName', name: document.getElementById('dk_pname').value.trim() }]); },
      declare(kind, inputId) { const v = document.getElementById(inputId).value.trim(); if (v) applyOps([{ op: 'declare', kind, name: v }]); },
      undeclare(kind, name) { applyOps([{ op: 'undeclare', kind, name }]); },
      fixIssue(idx) {
        const i = A()?.issues?.[idx];
        if (i) applyOps([{ op: 'fix', issue: i }]);
      },
      async fixAll() {
        // una alla volta, rianalizzando: gli indici delle porte e i servizi cambiano
        const safe = ['remove_version', 'declare_volume', 'declare_network', 'bind_localhost', 'add_healthcheck', 'wait_healthy'];
        for (let n = 0; n < 50; n++) {
          const i = A()?.issues?.find(x => safe.includes(x.fix));
          if (!i || !(await applyOps([{ op: 'fix', issue: i }]))) break;
        }
      },
      gotoLine(line) {
        actions.setTab('yaml');
        const ta = $(ctx.root, 'yaml');
        const lines = ta.value.split('\n');
        const start = lines.slice(0, Math.max(0, line - 1)).reduce((n, l) => n + l.length + 1, 0);
        setTimeout(() => { ta.focus(); ta.setSelectionRange(start, start + (lines[line - 1] || '').length); ta.scrollTop = Math.max(0, (line - 5) * 18); }, 0);
      },

      // comandi compose (del file aperto, o di un progetto in esecuzione)
      async run(action, target = null, services = [], options = {}) {
        try {
          const r = await ctx.api.post('/compose/run', { target: target || fileTarget(), action, services, options });
          followJob(r.job);
        } catch (e) { toast(e.message, 'error'); }
      },
      upMenu(event) {
        event.stopPropagation();
        const b = event.currentTarget.getBoundingClientRect();
        ctx.ui.contextMenu(b.left, b.bottom, [
          { label: t('action.upBuild'), icon: 'hammer', action: () => actions.run('up', null, [], { build: true }) },
          { label: t('action.upPull'), icon: 'cloud-download', action: () => actions.run('up', null, [], { pull: 'always' }) },
          { label: t('action.upRecreate'), icon: 'refresh-cw', action: () => actions.run('up', null, [], { forceRecreate: true }) },
          { label: t('action.upOrphans'), icon: 'eraser', action: () => actions.run('up', null, [], { removeOrphans: true }) },
        ]);
      },
      down(target = null) {
        openModal(t('down.title'), `<p>${esc(t('down.text', { name: target?.project || A()?.projectName || doc?.file || '' }))}</p>
          <label class="dk-check"><input type="checkbox" id="dk_down_orphans"> ${esc(t('down.orphans'))}</label>
          <label class="dk-check dk-danger-text"><input type="checkbox" id="dk_down_volumes"> ${esc(t('down.volumes'))}</label>`,
        `<button class="btn btn-ghost" onclick="UI.closeModal()">${esc(t('core.action.cancel'))}</button>
         <button class="btn btn-danger" id="dk_down_go">${esc(t('action.down'))}</button>`);
        document.getElementById('dk_down_go').addEventListener('click', () => {
          const options = { volumes: document.getElementById('dk_down_volumes').checked, removeOrphans: document.getElementById('dk_down_orphans').checked };
          if (options.volumes && !confirm(t('down.volumesConfirm'))) return;
          closeModal();
          actions.run('down', target, [], options);
        });
      },
      nodeMenu(event, name) {
        event.preventDefault();
        actions.select(name);
        const run = A()?.running?.[name] || [];
        const c0 = run[0];
        const saved = doc.hash != null && status?.daemon;
        ctx.ui.contextMenu(event.clientX, event.clientY, [
          { label: t('action.upService'), icon: 'play', disabled: !saved, action: () => actions.run('up', null, [name]) },
          { label: t('action.restart'), icon: 'rotate-ccw', disabled: !saved || !run.length, action: () => actions.run('restart', null, [name]) },
          { label: t('action.stop'), icon: 'square', disabled: !saved || !c0 || c0.state !== 'running', action: () => actions.run('stop', null, [name]) },
          { label: t('action.logs'), icon: 'scroll-text', disabled: !saved || !run.length, action: () => actions.serviceLogs(name) },
          ...(c0 && c0.state === 'running' && kindOf(A().model.services.find(s => s.name === name)?.image) === 'db' && ctx.hasExtension('db-client') ? [{ label: t('action.dbConnection'), icon: 'database', action: () => actions.dbConnection(c0.name) }] : []),
          ...(c0 && c0.state === 'running' && ctx.hasExtension('tunnels') ? [{ label: t('action.tunnel'), icon: 'cable', action: () => actions.tunnel(c0.name) }] : []),
          'separator',
          { label: t('editor.removeService'), icon: 'trash-2', danger: true, action: () => actions.removeService(name) },
        ]);
      },
      fileLogs() { streamLogs(`${doc.file} · ${t('action.logs')}`, `/compose/logs?${new URLSearchParams({ projectId: doc.projectId, file: doc.file, follow: '1', tail: '200' })}`); },
      serviceLogs(name) { streamLogs(`${name} · ${t('action.logs')}`, `/compose/logs?${new URLSearchParams({ projectId: doc.projectId, file: doc.file, services: name, follow: '1', tail: '300' })}`); },
      projectLogs(project) { streamLogs(`${project} · ${t('action.logs')}`, `/compose/logs?${new URLSearchParams({ project, follow: '1', tail: '200' })}`); },
      containerLogs(name) { streamLogs(`${name} · ${t('action.logs')}`, `/containers/${encodeURIComponent(name)}/logs?follow=1&tail=300`); },

      async containerAction(name, action) {
        try { await ctx.api.post(`/containers/${encodeURIComponent(name)}/${action}`, {}); toast(t(`toast.${action}`, { name }), 'success'); reloadSoon(); }
        catch (e) { toast(e.message, 'error'); }
      },
      removeContainer(name) {
        const c = containers.find(x => x.name === name);
        openModal(t('remove.title'), `<p>${esc(t(c?.compose ? 'remove.textCompose' : 'remove.text', { name, project: c?.compose?.project || '' }))}</p>
          <label class="dk-check"><input type="checkbox" id="dk_rm_vol"> ${esc(t('remove.volumes'))}</label>`,
        `<button class="btn btn-ghost" onclick="UI.closeModal()">${esc(t('core.action.cancel'))}</button>
         <button class="btn btn-danger" id="dk_rm_go">${esc(t('action.remove'))}</button>`);
        document.getElementById('dk_rm_go').addEventListener('click', async () => {
          try {
            await ctx.api.post(`/containers/${encodeURIComponent(name)}/remove`, { force: c?.state === 'running', volumes: document.getElementById('dk_rm_vol').checked });
            closeModal(); toast(t('toast.removed', { name }), 'success'); reloadSoon();
          } catch (e) { toast(e.message, 'error'); }
        });
      },
      async inspect(name) {
        try {
          const c = await ctx.api.get(`/containers/${encodeURIComponent(name)}/inspect`);
          const row = (k, v) => `<tr><th>${esc(k)}</th><td>${v}</td></tr>`;
          openModal(name, `<table class="dk-inspect">
              ${row(t('col.image'), `<code>${esc(c.image)}</code>`)}
              ${row(t('col.state'), `<span class="dk-state dk-${stateClass(c)}">${esc(stateText(c))}</span>${c.restartCount ? ` · ${esc(t('inspect.restarts', { count: c.restartCount }))}` : ''}`)}
              ${row('ID', `<code>${esc(c.shortId)}</code>`)}
              ${c.command ? row(t('editor.command'), `<code>${esc(c.command)}</code>`) : ''}
              ${row(t('col.ports'), c.ports.map(portChip).join(' ') || '—')}
              ${row(t('editor.networks'), c.networks.map(n => `<code>${esc(n.name)}</code> ${esc(n.ip || '')}`).join('<br>') || esc(c.networkMode || '—'))}
              ${row(t('editor.volumes'), c.mounts.map(m => `<code>${esc(m.source || '—')}</code> → <code>${esc(m.destination)}</code>${m.rw ? '' : ' (ro)'}`).join('<br>') || '—')}
            </table>
            <h4 class="dk-inspect-h">${esc(t('editor.environment'))}</h4>
            <table class="dk-inspect dk-env">${c.env.map(e => `<tr><th>${esc(e.key)}</th><td><code class="${e.secret ? 'dk-secret' : ''}" ${e.secret ? `onclick="this.classList.toggle('dk-secret')" title="${esc(t('inspect.reveal'))}"` : ''}>${esc(e.value)}</code></td></tr>`).join('')}</table>`,
            `<button class="btn btn-ghost" onclick="UI.closeModal()">${esc(t('core.action.close'))}</button>`);
          document.getElementById('modal').classList.add('modal-wide');
        } catch (e) { toast(e.message, 'error'); }
      },
      // connessione database: porta pubblicata → form della sezione Database; altrimenti prima un tunnel
      async dbConnection(name) {
        try {
          const p = await ctx.api.get(`/containers/${encodeURIComponent(name)}/db`);
          if (p.type === 'mongo') { toast(t('db.mongo'), 'info'); return; }
          if (!p.port) {
            toast(t('db.needsTunnel', { port: p.targetPort }), 'info');
            if (ctx.hasExtension('tunnels')) actions.tunnel(name, p.targetPort);
            return;
          }
          ctx.open('db-client', { newConnection: { type: p.type, suggestId: p.suggestId, label: p.label, host: p.host, port: p.port, user: p.user, password: p.password, database: p.database, projectId: p.projectId || undefined } });
        } catch (e) { toast(e.message, 'error'); }
      },
      // tunnel nuovo nella sezione Tunnel verso una porta del container (anche non pubblicata)
      tunnel(name, port = null) {
        const c = containers.find(x => x.name === name);
        const target = port || c?.exposed?.[0]?.port || c?.ports?.[0]?.container || null;
        const suggestKey = `docker_${c?.compose?.service || name}`.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40);
        const local = target ? (target > 1024 ? target + 10000 > 65535 ? target : target + 10000 : 10000 + target) : 18080;
        ctx.open('tunnels', { newServer: { suggestKey, label: c?.compose ? `${c.compose.service} (${c.compose.project})` : name, type: kindOf(c?.image) === 'web' ? 'HTTP' : 'TCP', port: local, transport: 'docker', params: { container: name, ...(target ? { port: target } : {}) } } });
      },

      // compose nuovo in un progetto (salvato al primo "Salva")
      async newCompose() {
        const list = await ctx.projects.load().catch(() => ({ projects: [] }));
        const projs = (list.projects || list || []).filter?.(p => p.id) || [];
        if (!projs.length) { toast(t('newFile.noProjects'), 'error'); return; }
        openModal(t('newFile.title'), `
          <div class="form-row"><label>${esc(t('newFile.project'))}</label><select class="form-input" id="dk_nf_project">${projs.map(p => `<option value="${esc(p.id)}">${esc(p.label)}</option>`).join('')}</select></div>
          <div class="form-row"><label>${esc(t('newFile.file'))}</label><input class="form-input dk-mono" id="dk_nf_file" value="compose.yaml" spellcheck="false"></div>
          <p class="dk-hint">${esc(t('newFile.hint'))}</p>`,
        `<button class="btn btn-ghost" onclick="UI.closeModal()">${esc(t('core.action.cancel'))}</button>
         <button class="btn btn-primary" id="dk_nf_go">${esc(t('newFile.create'))}</button>`);
        document.getElementById('dk_nf_go').addEventListener('click', async () => {
          const projectId = document.getElementById('dk_nf_project').value;
          const file = document.getElementById('dk_nf_file').value.trim();
          if (files.some(f => f.projectId === projectId && f.file === file)) { closeModal(); openFile(projectId, file); return; }
          closeModal();
          tab = 'graph';
          await openFile(projectId, file, { text: 'services:\n' });
        });
      },
    };

    // ---- eventi del pannello ----
    ctx.root.addEventListener('input', e => {
      const el = e.target;
      if (el.dataset.role === 'yaml') {
        doc.text = el.value; doc.dirty = true;
        $(ctx.root, 'dirty').hidden = false;
        ctx.root.querySelector('[data-action="save"]').disabled = false;
        clearTimeout(analyzeTimer);
        analyzeTimer = setTimeout(refreshAnalysis, 450);
        return;
      }
      const f = el.dataset.draft;
      if (!f || !draft) return;
      const i = Number(el.dataset.index);
      if (['name', 'image', 'buildContext', 'dockerfile', 'command', 'profiles'].includes(f)) draft[f] = el.value;
      else if (f === 'ports' || f === 'volumes') draft[f][i] = el.value;
      else if (f === 'envKey') draft.env[i][0] = el.value;
      else if (f === 'envValue') draft.env[i][1] = el.value === '' && draft.env[i][1] == null ? null : el.value;
    });
    ctx.root.addEventListener('change', e => {
      const el = e.target;
      const f = el.dataset.draft;
      if (!f || !draft) return;
      if (f === 'restart') draft.restart = el.value;
      else if (f === 'dep') { draft.depends[el.dataset.service] = el.checked ? (draft.depends[el.dataset.service] || 'service_started') : null; renderSide(); }
      else if (f === 'depCond') draft.depends[el.dataset.service] = el.value;
      else if (f === 'net') draft.networks = el.checked ? [...new Set([...draft.networks, el.dataset.network])] : draft.networks.filter(n => n !== el.dataset.network);
    });
    ctx.root.addEventListener('keydown', e => {
      if ((e.ctrlKey || e.metaKey) && e.key === 's' && view.kind === 'file') { e.preventDefault(); if (doc?.dirty) save(); return; }
      if (e.target.dataset.role === 'yaml' && e.key === 'Tab' && !e.shiftKey) {
        e.preventDefault();
        const ta = e.target, s = ta.selectionStart;
        ta.setRangeText('  ', s, ta.selectionEnd, 'end');
        ta.dispatchEvent(new Event('input', { bubbles: true }));
      }
      if (e.key === 'Enter' && e.target.dataset.draft && e.target.tagName === 'INPUT') { e.preventDefault(); actions.applyDraft(); }
    });
    ctx.root.querySelector('[data-role="tabs"]').addEventListener('click', e => { const b = e.target.closest('.dk-tab'); if (b) actions.setTab(b.dataset.tab); });
    ctx.root.querySelector('[data-action="save"]').addEventListener('click', () => save());
    ctx.root.querySelector('[data-action="revert"]').addEventListener('click', () => { if (doc && confirm(t('compose.revertConfirm'))) { doc.dirty = false; openFile(doc.projectId, doc.file, { fresh: true }); } });
    ctx.root.querySelector('[data-action="validate"]').addEventListener('click', async () => {
      try {
        const r = await ctx.api.post('/compose/validate', { projectId: doc.projectId, file: doc.file, text: doc.text });
        if (r.ok) toast(t('compose.validOk'), 'success');
        else openModal(t('compose.validFailed'), `<pre class="dk-pre">${esc(r.output)}</pre>`, `<button class="btn btn-ghost" onclick="UI.closeModal()">${esc(t('core.action.close'))}</button>`);
      } catch (e) { toast(e.message, 'error'); }
    });
    $(ctx.root, 'filter').addEventListener('input', e => { filter = e.target.value; renderContainers(); });
    $(ctx.root, 'show-stopped').addEventListener('change', () => renderContainers());
    $(ctx.root, 'show-stats').addEventListener('change', e => { if (e.target.checked) startStats(); else { stopStats(); renderContainers(); } });
    $(ctx.root, 'live').addEventListener('change', e => { if (e.target.checked) { reloadSoon(); startEvents(); } else stopEvents(); });
    ctx.sidebar.addEventListener('click', e => {
      if (e.target.closest('[data-action="reload"]')) this.refresh();
      else if (e.target.closest('[data-action="new-compose"]')) actions.newCompose();
    });

    ctx.expose(actions);
    await loadStatus();
    renderNotice();
    try { templatesList = (await ctx.api.get('/templates')).templates; } catch { templatesList = []; }
    await loadOverview();
    renderNav();
    showArea();
    renderContainers();

    this.show = () => { if (!closeEvents) { reloadSoon(); startEvents(); } if ($(ctx.root, 'show-stats').checked && !statsTimer) startStats(); };
    this.hide = () => { stopEvents(); stopStats(); };
    this.refresh = async () => {
      await loadStatus(); renderNotice(); await loadOverview(); renderNav();
      if (view.kind === 'containers') renderContainers(); else if (doc && !doc.dirty) await openFile(doc.projectId, doc.file, { fresh: true }); else if (doc) refreshAnalysis();
    };
    // aperta dai progetti: { project } apre il primo compose del progetto
    this.focus = async params => {
      if (params?.project) {
        const f = files.find(x => x.projectId === params.project && x.base) || files.find(x => x.projectId === params.project);
        if (f) await openFile(f.projectId, f.file);
      }
    };
    this.unmount = () => { stopEvents(); stopStats(); closeLogs?.(); clearTimeout(reloadTimer); clearTimeout(analyzeTimer); };
    this.languageChanged = () => { renderNotice(); renderNav(); if (view.kind === 'containers') renderContainers(); else renderFile(); };
  },
};
