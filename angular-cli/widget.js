// Widget della dashboard: versione della CLI, generatori rapidi e quelli usati di recente; un clic
// apre la sezione Angular CLI con il dialog del generatore
const QUICK = [['component', 'component'], ['service', 'box'], ['module', 'boxes'], ['directive', 'sparkles'], ['pipe', 'filter'], ['guard', 'shield']];

export default {
  async mount(ctx, el, params) {
    el.addEventListener('click', e => {
      const b = e.target.closest('[data-generate], [data-recent], [data-open]');
      if (!b) return;
      if (b.dataset.generate) ctx.widget.openFull({ project: params.project.id, generate: b.dataset.generate });
      else if (b.dataset.recent) ctx.widget.openFull({ project: params.project.id, recent: Number(b.dataset.recent) });
      else ctx.widget.openFull({ project: params.project.id });
    });
    await this.refresh(ctx, el, params);
  },

  async refresh(ctx, el, { project }) {
    const { esc, icon } = ctx.ui;
    const { t } = ctx;
    let ws;
    try { ws = await ctx.api.get(`/projects/${encodeURIComponent(project.id)}/workspace`); }
    catch (e) { ctx.ui.patch(el, `<p class="ngc-muted">${esc(e.message)}</p>`); ctx.widget.setBadge(null); return; }
    ctx.widget.setBadge(ws.cli ? `v${ws.cli}` : null);
    if (!ws.installed) {
      ctx.ui.patch(el, `<div class="ngc-w"><p class="ngc-muted">${esc(t(ws.nodeModules ? 'notInstalledCli' : 'notInstalled'))}</p>
        <button class="btn btn-ghost btn-sm" data-open="1">${icon('triangle')} ${esc(t('widget.open'))}</button></div>`);
      return;
    }
    const available = new Set((ws.collections.find(c => c.name === '@schematics/angular')?.schematics || []).map(s => s.name));
    ctx.ui.patch(el, `<div class="ngc-w">
      <div class="ngc-w-quick">${QUICK.filter(([n]) => available.has(n)).map(([n, i]) => `<button class="ngc-w-btn ${['component', 'service', 'module'].includes(n) ? 'ngc-w-main' : ''}" data-generate="${esc(n)}" title="ng generate ${esc(n)}">${icon(i)} ${esc(n)}</button>`).join('')}</div>
      ${ws.recent.length ? `<div class="ngc-w-title">${icon('history')} ${esc(t('recent.title'))}</div>
        ${ws.recent.slice(0, 4).map((r, i) => `<button class="ngc-w-recent" data-recent="${i}" title="${esc(t('recent.repeat'))}">
          <strong>${esc(r.schematic)}</strong> <span class="ngc-muted">${esc(Object.keys(r.options || {}).join(', ') || t('recent.defaults'))}</span></button>`).join('')}` : ''}
      <div class="ngc-w-apps ngc-muted">${esc(ws.projects.map(x => x.name).join(' · '))}</div>
    </div>`);
  },

  unmount() {},
};
