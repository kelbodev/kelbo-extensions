// Kubernetes: context del kubeconfig nella sidebar (protetti con il lucchetto), namespace, pod
// con lo stato aggiornato in diretta (kubectl get -w), workload; describe, log nel pannello in
// basso, eliminazione, rollout restart e scale con conferma (nei context protetti va scritto il
// nome del context); "Port-forward…" apre l'editor della sezione Tunnel già compilato.

const STATUS_CLASS = s => (/^(Running|Completed|Succeeded)$/.test(s) ? 'ok' : /^(Pending|ContainerCreating|PodInitializing|Terminating|Init:)/.test(s) ? 'wait' : 'bad');
const NS_KEY = 'kelbo.kubectl.ns';

export default {
  async mount(ctx) {
    const { esc, js, toast, openModal, closeModal, output, fmt } = ctx.ui;
    const { t } = ctx;
    const $ = (root, role) => root.querySelector(`[data-role="${role}"]`);
    const enc = encodeURIComponent;
    const store = {
      get() { try { return JSON.parse(localStorage.getItem(NS_KEY)) || {}; } catch { return {}; } },
      set(v) { try { localStorage.setItem(NS_KEY, JSON.stringify(v)); } catch { /* solo per questa sessione */ } },
    };

    let contexts = [], contextsError = null;
    let active = null;          // context scelto
    let namespaces = [], namespace = null;
    let tab = 'pods';
    let pods = [], workloads = [], loadError = null, loading = false;
    let filter = '';
    let closeWatch = null;
    let closeLogs = null;

    const ctxInfo = () => contexts.find(c => c.name === active) || null;
    const base = () => `/contexts/${enc(active)}/namespaces/${enc(namespace)}`;

    // ---- dati ----
    async function loadContexts(refresh = false) {
      try { const r = await ctx.api.get(`/contexts${refresh ? '?refresh=1' : ''}`); contexts = r.contexts; contextsError = null; if (!active) active = r.current || contexts[0]?.name || null; }
      catch (e) { contexts = []; contextsError = e.message; }
    }
    async function loadNamespaces() {
      namespaces = [];
      if (!active) return;
      try { namespaces = (await ctx.api.get(`/contexts/${enc(active)}/namespaces`)).namespaces; } catch (e) { loadError = e.message; }
      const saved = store.get()[active];
      namespace = namespaces.includes(namespace) ? namespace : namespaces.includes(saved) ? saved : namespaces.includes('default') ? 'default' : namespaces[0] || null;
    }
    async function loadList() {
      if (!active || !namespace) { pods = []; workloads = []; return; }
      loading = true; renderContent();
      try {
        if (tab === 'pods') pods = (await ctx.api.get(`${base()}/pods`)).pods;
        else workloads = (await ctx.api.get(`${base()}/workloads`)).workloads;
        loadError = null;
      } catch (e) { loadError = e.message; }
      loading = false;
    }

    // ---- stato in diretta: eventi del watch applicati alla lista ----
    function startWatch() {
      stopWatch();
      if (!active || !namespace || !$(ctx.root, 'live').checked) return;
      const scope = `${active}\0${namespace}`;
      closeWatch = ctx.api.events(`${base()}/pods/watch`, ev => {
        if (`${active}\0${namespace}` !== scope) return;
        if (ev.type === 'pod') {
          const { type, pod } = ev.data;
          const i = pods.findIndex(p => p.name === pod.name);
          if (type === 'DELETED') { if (i >= 0) pods.splice(i, 1); }
          else if (i >= 0) { pods[i] = { ...pod, changed: Date.now() }; }
          else pods.push({ ...pod, changed: Date.now() });
          if (tab === 'pods') renderContent();
        } else if (ev.type === 'end') {
          $(ctx.root, 'live').checked = false;
          if (ev.data?.error) toast(ev.data.error, 'error');
          closeWatch = null;
        }
      }, () => { closeWatch = null; });
    }
    function stopWatch() { closeWatch?.(); closeWatch = null; }

    // ---- sidebar ----
    function renderContexts() {
      const el = $(ctx.sidebar, 'contexts');
      if (contextsError) { ctx.ui.patch(el, `<p class="k8s-muted k8s-pad">${esc(contextsError)}</p>`); return; }
      if (!contexts.length) { ctx.ui.patch(el, `<p class="k8s-muted k8s-pad">${esc(t('sidebar.none'))}</p>`); return; }
      ctx.ui.patch(el, contexts.map(c => `
        <div class="sb-item ${c.name === active ? 'active' : ''}" role="button" tabindex="0" title="${esc(c.name)}"
             onclick="Ext.kubectl.select(${js(c.name)})" onkeydown="if(event.key==='Enter')Ext.kubectl.select(${js(c.name)})">
          <span class="sb-icon">${ctx.ui.icon('ship-wheel')}</span>
          <span class="k8s-ctx-name">${esc(c.name)}</span>
          ${c.current ? `<span class="k8s-current" title="${esc(t('sidebar.currentTitle'))}">${esc(t('sidebar.current'))}</span>` : ''}
          <button class="k8s-lock ${c.protected ? 'on' : ''}" onclick="event.stopPropagation();Ext.kubectl.toggleProtected(${js(c.name)})"
                  title="${esc(t(c.protected ? 'protected.unset' : 'protected.set'))}">${ctx.ui.icon(c.protected ? 'lock' : 'lock-open')}</button>
        </div>`).join(''));
    }

    // ---- pannello ----
    function renderHeader() {
      $(ctx.root, 'empty').hidden = !!active;
      $(ctx.root, 'area').hidden = !active;
      if (!active) return;
      $(ctx.root, 'title').textContent = active;
      $(ctx.root, 'protected').hidden = !ctxInfo()?.protected;
      ctx.ui.patch($(ctx.root, 'namespace'), namespaces.map(n => `<option value="${esc(n)}" ${n === namespace ? 'selected' : ''}>${esc(n)}</option>`).join(''));
      for (const b of ctx.root.querySelectorAll('.k8s-tab')) b.classList.toggle('active', b.dataset.tab === tab);
      $(ctx.root, 'live').parentElement.hidden = tab !== 'pods';
    }

    const age = iso => (iso ? fmt.relative(iso) : '—');
    function matches(p) {
      const q = filter.trim();
      if (!q) return true;
      // "chiave=valore" filtra per etichetta, il resto per nome, stato o nodo
      const m = /^([\w./-]+)=(.*)$/.exec(q);
      if (m) return (p.labels || {})[m[1]] === m[2];
      const s = q.toLowerCase();
      return [p.name, p.status, p.node, ...(Object.entries(p.labels || {}).map(([k, v]) => `${k}=${v}`))].some(x => String(x || '').toLowerCase().includes(s));
    }

    function podsHtml() {
      const list = pods.filter(matches).sort((a, b) => a.name.localeCompare(b.name));
      if (!list.length) return `<p class="k8s-muted">${esc(t(pods.length ? 'noMatch' : 'noPods'))}</p>`;
      const tunnels = ctx.hasExtension('tunnels');
      return `<table class="data-table k8s-table"><thead><tr>
          <th>${esc(t('col.name'))}</th><th>${esc(t('col.status'))}</th><th>${esc(t('col.ready'))}</th><th>${esc(t('col.restarts'))}</th><th>${esc(t('col.age'))}</th><th>${esc(t('col.node'))}</th><th></th></tr></thead>
        <tbody>${list.map(p => `<tr class="${p.changed && Date.now() - p.changed < 3000 ? 'k8s-flash' : ''}">
          <td><span class="k8s-pod-name" title="${esc(Object.entries(p.labels || {}).map(([k, v]) => `${k}=${v}`).join('\n'))}">${esc(p.name)}</span>
            ${p.deployment ? `<span class="k8s-owner">${esc(p.deployment)}</span>` : ''}</td>
          <td><span class="k8s-status k8s-${STATUS_CLASS(p.status)}">${esc(p.status)}</span></td>
          <td>${esc(p.ready)}</td>
          <td class="${p.restarts ? 'k8s-restarts' : ''}">${esc(fmt.number(p.restarts))}</td>
          <td>${esc(age(p.createdAt))}</td>
          <td class="k8s-muted">${esc(p.node || '—')}</td>
          <td class="k8s-actions">
            <button class="btn btn-ghost btn-sm" onclick="Ext.kubectl.logs(${js(p.name)})" title="${esc(t('action.logs'))}">${ctx.ui.icon('scroll-text')}</button>
            <button class="btn btn-ghost btn-sm" onclick="Ext.kubectl.describe('pod', ${js(p.name)})" title="${esc(t('action.describe'))}">${ctx.ui.icon('file-text')}</button>
            ${tunnels ? `<button class="btn btn-ghost btn-sm" onclick="Ext.kubectl.portForward(${js(p.name)})" title="${esc(t('action.portForward'))}">${ctx.ui.icon('cable')}</button>` : ''}
            <button class="btn btn-ghost btn-sm k8s-danger" onclick="Ext.kubectl.deletePod(${js(p.name)})" title="${esc(t('action.delete'))}">${ctx.ui.icon('trash-2')}</button>
          </td></tr>`).join('')}</tbody></table>`;
    }

    function workloadsHtml() {
      const q = filter.trim().toLowerCase();
      const list = workloads.filter(w => !q || w.name.toLowerCase().includes(q));
      if (!list.length) return `<p class="k8s-muted">${esc(t(workloads.length ? 'noMatch' : 'noWorkloads'))}</p>`;
      return `<table class="data-table k8s-table"><thead><tr>
          <th>${esc(t('col.kind'))}</th><th>${esc(t('col.name'))}</th><th>${esc(t('col.ready'))}</th><th>${esc(t('col.updated'))}</th><th>${esc(t('col.age'))}</th><th></th></tr></thead>
        <tbody>${list.map(w => `<tr>
          <td class="k8s-muted">${esc(w.kind === 'statefulset' ? 'StatefulSet' : 'Deployment')}</td>
          <td>${esc(w.name)}</td>
          <td><span class="k8s-status k8s-${w.ready >= w.replicas ? 'ok' : 'wait'}">${esc(`${w.ready}/${w.replicas}`)}</span></td>
          <td>${esc(fmt.number(w.updated))}</td>
          <td>${esc(age(w.createdAt))}</td>
          <td class="k8s-actions">
            <button class="btn btn-ghost btn-sm" onclick="Ext.kubectl.describe(${js(w.kind)}, ${js(w.name)})" title="${esc(t('action.describe'))}">${ctx.ui.icon('file-text')}</button>
            <button class="btn btn-ghost btn-sm" onclick="Ext.kubectl.restart(${js(w.kind)}, ${js(w.name)})" title="${esc(t('action.restart'))}">${ctx.ui.icon('rotate-ccw')}</button>
            <button class="btn btn-ghost btn-sm" onclick="Ext.kubectl.scale(${js(w.kind)}, ${js(w.name)}, ${w.replicas})" title="${esc(t('action.scale'))}">${ctx.ui.icon('layers')}</button>
          </td></tr>`).join('')}</tbody></table>`;
    }

    function renderContent() {
      renderHeader();
      if (!active) return;
      const el = $(ctx.root, 'content');
      if (loadError) { ctx.ui.patch(el, `<div class="k8s-error">${ctx.ui.icon('triangle-alert')} <pre>${esc(loadError)}</pre></div>`); return; }
      if (loading && !(tab === 'pods' ? pods : workloads).length) { ctx.ui.patch(el, `<p class="k8s-muted">${esc(t('loading'))}</p>`); return; }
      ctx.ui.patch(el, tab === 'pods' ? podsHtml() : workloadsHtml());
    }

    async function choose(name) {
      stopWatch();
      active = name; loadError = null; pods = []; workloads = [];
      renderContexts(); renderContent();
      await loadNamespaces();
      await loadList();
      renderContent();
      startWatch();
    }

    // ---- conferma delle modifiche (nel context protetto va scritto il suo nome) ----
    function confirmChange({ title, text, button, danger = true, extra = '', onConfirm }) {
      const prot = ctxInfo()?.protected;
      openModal(title, `<p>${esc(text)}</p>${extra}
        ${prot ? `<div class="form-row k8s-confirm"><label for="k8s_confirm">${ctx.ui.icon('lock')} ${esc(t('protected.typeName', { context: active }))}</label>
          <input class="form-input" id="k8s_confirm" autocomplete="off" spellcheck="false"></div>` : ''}`,
        `<button class="btn btn-ghost" onclick="UI.closeModal()">${esc(t('core.action.cancel'))}</button>
         <button class="btn ${danger ? 'btn-danger' : 'btn-primary'}" id="k8s_go" ${prot ? 'disabled' : ''}>${esc(button)}</button>`);
      const go = document.getElementById('k8s_go');
      const input = document.getElementById('k8s_confirm');
      input?.addEventListener('input', () => { go.disabled = input.value !== active; });
      input?.focus();
      go.addEventListener('click', async () => {
        try { await onConfirm(input ? input.value : undefined); closeModal(); }
        catch (e) { toast(e.message, 'error'); }
      });
    }

    const actions = {
      select: name => choose(name),
      async toggleProtected(name) {
        const c = contexts.find(x => x.name === name);
        try { await ctx.api.put(`/contexts/${enc(name)}/protected`, { protected: !c?.protected }); await loadContexts(true); renderContexts(); renderHeader(); }
        catch (e) { toast(e.message, 'error'); }
      },
      async describe(kind, name) {
        try {
          const r = await ctx.api.get(`${base()}/describe/${enc(kind)}/${enc(name)}`);
          openModal(`${kind}/${name}`, `<pre class="k8s-describe">${esc(r.text)}</pre>`, `<button class="btn btn-ghost" onclick="UI.closeModal()">${esc(t('core.action.close'))}</button>`);
          document.getElementById('modal').classList.add('modal-wide');
        } catch (e) { toast(e.message, 'error'); }
      },
      logs(name) {
        const p = pods.find(x => x.name === name);
        const containers = p?.containers?.map(c => c.name) || [];
        openModal(t('logs.title', { pod: name }), `
          ${containers.length > 1 ? `<div class="form-row"><label>${esc(t('logs.container'))}</label><select class="form-input" id="k8s_lc">${containers.map(c => `<option>${esc(c)}</option>`).join('')}</select></div>` : ''}
          <div class="form-grid">
            <div class="form-row"><label>${esc(t('logs.tail'))}</label><input class="form-input" id="k8s_lt" type="number" min="1" max="5000" value="200"></div>
            <div class="form-row k8s-checks">
              <label><input type="checkbox" id="k8s_lf" checked> ${esc(t('logs.follow'))}</label>
              <label><input type="checkbox" id="k8s_lp"> ${esc(t('logs.previous'))}</label></div>
          </div>`,
          `<button class="btn btn-ghost" onclick="UI.closeModal()">${esc(t('core.action.cancel'))}</button>
           <button class="btn btn-primary" onclick="Ext.kubectl.openLogs(${js(name)})">${esc(t('logs.open'))}</button>`);
      },
      openLogs(name) {
        const container = document.getElementById('k8s_lc')?.value || '';
        const tail = document.getElementById('k8s_lt')?.value || '200';
        const follow = document.getElementById('k8s_lf')?.checked;
        const previous = document.getElementById('k8s_lp')?.checked;
        closeModal();
        closeLogs?.();
        output.open(`${name}${container ? ` · ${container}` : ''}${previous ? ` · ${t('logs.previous')}` : ''}`);
        const qs = new URLSearchParams({ tail, ...(container ? { container } : {}), ...(follow ? { follow: '1' } : {}), ...(previous ? { previous: '1' } : {}) });
        closeLogs = ctx.api.events(`${base()}/pods/${enc(name)}/logs?${qs}`, ev => {
          if (ev.type === 'stdout') output.append(ev.data);
          else if (ev.type === 'stderr') output.append(ev.data, 'err');
          else if (ev.type === 'exit') { output.append(`\n[${t('logs.ended')}]\n`, 'sys'); closeLogs?.(); closeLogs = null; }
        }, () => { closeLogs = null; });
      },
      deletePod(name) {
        confirmChange({ title: t('confirm.deleteTitle'), text: t('confirm.deleteText', { pod: name, namespace, context: active }), button: t('action.delete'),
          onConfirm: async confirm => { await ctx.api.post(`${base()}/pods/${enc(name)}/delete`, { confirm }); toast(t('toast.deleted', { pod: name }), 'success'); if (!closeWatch) { await loadList(); renderContent(); } } });
      },
      restart(kind, name) {
        confirmChange({ title: t('confirm.restartTitle'), text: t('confirm.restartText', { name, namespace, context: active }), button: t('action.restart'), danger: false,
          onConfirm: async confirm => { await ctx.api.post(`${base()}/workloads/${enc(kind)}/${enc(name)}/restart`, { confirm }); toast(t('toast.restarted', { name }), 'success'); await loadList(); renderContent(); } });
      },
      scale(kind, name, replicas) {
        confirmChange({ title: t('confirm.scaleTitle'), text: t('confirm.scaleText', { name, namespace, context: active }), button: t('action.scale'), danger: false,
          extra: `<div class="form-row"><label for="k8s_rep">${esc(t('confirm.replicas'))}</label><input class="form-input" id="k8s_rep" type="number" min="0" max="1000" value="${esc(replicas)}"></div>`,
          onConfirm: async confirm => {
            const n = Number(document.getElementById('k8s_rep').value);
            await ctx.api.post(`${base()}/workloads/${enc(kind)}/${enc(name)}/scale`, { replicas: n, confirm });
            toast(t('toast.scaled', { name, count: n }), 'success'); await loadList(); renderContent();
          } });
      },
      // tunnel nuovo nella sezione Tunnel: il deployment del pod se c'è (sopravvive ai pod nuovi)
      portForward(name) {
        const p = pods.find(x => x.name === name);
        const port = p?.containers?.flatMap(c => c.ports)?.[0]?.port || null;
        const params = { context: active, namespace, ...(p?.deployment ? { kind: 'deployment', resource: p.deployment } : { kind: 'pod', resource: name }), ...(port ? { port } : {}) };
        const target = p?.deployment || name;
        const suggestKey = `k8s_${namespace}_${target}`.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40);
        ctx.open('tunnels', { newServer: { suggestKey, label: `${target} (${namespace})`, type: 'TCP', port: port && port > 1024 ? port : port ? 10000 + port : 18080, transport: 'kubernetes', params } });
      },
    };

    ctx.sidebar.addEventListener('click', e => { if (e.target.closest('[data-action="reload"]')) this.refresh(); });
    ctx.root.querySelector('.k8s-tabs').addEventListener('click', async e => {
      const b = e.target.closest('.k8s-tab');
      if (!b || b.dataset.tab === tab) return;
      tab = b.dataset.tab;
      if (tab === 'pods') startWatch(); else stopWatch();
      await loadList(); renderContent();
    });
    $(ctx.root, 'namespace').addEventListener('change', async e => {
      namespace = e.target.value;
      store.set({ ...store.get(), [active]: namespace });
      stopWatch(); pods = []; workloads = [];
      await loadList(); renderContent(); startWatch();
    });
    $(ctx.root, 'filter').addEventListener('input', e => { filter = e.target.value; renderContent(); });
    $(ctx.root, 'live').addEventListener('change', async e => { if (e.target.checked) { await loadList(); renderContent(); startWatch(); } else stopWatch(); });

    ctx.expose(actions);
    $(ctx.root, 'live').checked = true;
    await loadContexts();
    renderContexts();
    renderHeader();

    let started = false;
    this.show = async () => {
      if (!started && active) { started = true; await choose(active); return; }
      if (active && tab === 'pods' && $(ctx.root, 'live').checked && !closeWatch) { await loadList(); renderContent(); startWatch(); }
    };
    this.hide = () => stopWatch();
    this.refresh = async () => { await loadContexts(true); renderContexts(); if (active) { await loadNamespaces(); await loadList(); renderContent(); } };
    this.unmount = () => { stopWatch(); closeLogs?.(); };
    this.languageChanged = () => { renderContexts(); renderContent(); };
  },
};
