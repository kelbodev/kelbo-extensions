// PM2: tabella dei processi con azioni, statistiche nella sidebar e log nel cassetto di output

const STATUS_CLASS = { online: 'online', stopped: 'stopped', errored: 'errored' };

export default {
  mount(ctx) {
    const { esc, js, toast, output, fmt } = ctx.ui;
    const { t } = ctx;
    const content = ctx.root.querySelector('[data-role="content"]');
    let closeLogs = null;

    const stats = ctx.sidebar.querySelector('[data-role="stats"]');

    async function render() {
      const system = await ctx.core.get('/system').catch(() => ({ tools: {} }));
      if (!system.tools.pm2) {
        stats.innerHTML = '';
        ctx.setBadge(null);
        content.innerHTML = ctx.ui.toolNotice(t('notInstalled'), 'npm install -g pm2', 'Ext.pm2.recheck()');
        return;
      }

      let list = [];
      try { list = await ctx.api.get('/list'); } catch (e) { toast(e.message, 'error'); }

      const count = s => list.filter(p => p.status === s).length;
      ctx.setBadge(count('online') || null);
      stats.innerHTML = `
        <div class="pm2-stats">
          <div class="pm2-stat"><span>${esc(t('stats.online'))}</span><span class="ok">${fmt.number(count('online'))}</span></div>
          <div class="pm2-stat"><span>${esc(t('stats.stopped'))}</span><span>${fmt.number(count('stopped'))}</span></div>
          ${count('errored') ? `<div class="pm2-stat"><span>${esc(t('stats.errored'))}</span><span class="ko">${fmt.number(count('errored'))}</span></div>` : ''}
        </div>
        <div class="pm2-hint">${esc(t('stats.hint'))}</div>`;

      content.innerHTML = !list.length
        ? `<p class="pm2-muted">${esc(t('empty'))}</p>`
        : `<table class="pm2-table">
            <thead><tr><th>${esc(t('col.id'))}</th><th>${esc(t('col.name'))}</th><th>${esc(t('col.status'))}</th><th>${esc(t('col.pid'))}</th><th>${esc(t('col.cpu'))}</th><th>${esc(t('col.memory'))}</th><th title="${esc(t('col.restarts'))}"><i data-icon="rotate-ccw"></i></th><th></th></tr></thead>
            <tbody>${list.map(p => `<tr>
              <td class="pm2-dim">${esc(p.id)}</td>
              <td><span class="pm2-name-link" onclick="Ext.pm2.logs(${js(p.name)})">${esc(p.name)}</span></td>
              <td><span class="pm2-status ${STATUS_CLASS[p.status] || 'stopped'}">${esc(p.status || '?')}</span></td>
              <td class="pm2-dim">${esc(p.pid || '—')}</td>
              <td>${p.cpu != null ? esc(fmt.number(p.cpu / 100, { style: 'percent', maximumFractionDigits: 1 })) : '—'}</td>
              <td>${p.memory != null ? esc(fmt.bytes(p.memory)) : '—'}</td>
              <td>${esc(fmt.number(p.restarts || 0))}</td>
              <td><div class="pm2-actions">
                ${p.status === 'online'
                  ? `<button class="btn btn-ghost btn-sm" onclick="Ext.pm2.action('restart',${js(p.name)})" title="${esc(t('action.restart'))}"><i data-icon="rotate-ccw"></i></button>
                     <button class="btn btn-ghost btn-sm" onclick="Ext.pm2.action('stop',${js(p.name)})" title="${esc(t('action.stop'))}"><i data-icon="square"></i></button>
                     <button class="btn btn-ghost btn-sm" onclick="Ext.pm2.logs(${js(p.name)})" title="${esc(t('action.logs'))}"><i data-icon="scroll-text"></i></button>`
                  : `<button class="btn btn-ghost btn-sm pm2-start" onclick="Ext.pm2.action('start',${js(p.name)})" title="${esc(t('action.start'))}"><i data-icon="play"></i></button>`}
                <button class="btn btn-ghost btn-sm pm2-delete" onclick="Ext.pm2.action('delete',${js(p.name)})" title="${esc(t('action.delete'))}"><i data-icon="x"></i></button>
              </div></td>
            </tr>`).join('')}</tbody>
          </table>`;
    }

    async function action(name, target) {
      if (name === 'delete' && !confirm(t('confirmDelete', { name: target }))) return;
      try {
        await ctx.api.post('/action', { action: name, target });
        toast(t('done', { action: name, name: target }), 'success');
        await render();
      } catch (e) { toast(t('error', { error: e.message }), 'error'); }
    }

    let following; // undefined = nessun log aperto; null = tutti; nome = un processo
    function logs(name) {
      closeLogs?.();
      following = name ?? null;
      output.open(name ? `pm2 logs ${name}` : t('logsAll'));
      const q = name ? `?name=${encodeURIComponent(name)}&lines=100` : '?lines=100';
      closeLogs = ctx.api.events('/logs' + q, ({ type, data }) => {
        if (type === 'exit') output.append(`\n${t('streamEnded')}`, 'sys');
        else output.append(data, type === 'stderr' || type === 'error' ? 'err' : 'out');
        if (type === 'exit') { closeLogs?.(); closeLogs = null; following = undefined; }
      }, () => output.append('\n' + t('connectionLost'), 'err'));
    }

    async function recheck() {
      await ctx.core.get('/system?refresh=1').catch(() => {});
      toast(t('rechecked'), 'info');
      await render();
    }

    for (const el of [ctx.root, ctx.sidebar]) {
      el.addEventListener('click', e => {
        const a = e.target.closest('[data-action]')?.dataset.action;
        if (a === 'refresh') render();
        else if (a === 'logs') logs();
      });
    }

    ctx.expose({ action, logs, recheck });
    this.render = render;
    this.stopLogs = () => { closeLogs?.(); closeLogs = null; };
    // al ritorno nella sezione i log seguiti ripartono
    this.resumeLogs = () => { if (following !== undefined && !closeLogs) logs(following); };
  },

  show() { this.render(); this.resumeLogs(); },
  languageChanged() { this.render(); },
  hide() { this.stopLogs(); },
};
