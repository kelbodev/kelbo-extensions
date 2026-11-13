// Widget della dashboard: i colori più usati nei file del progetto e le sue palette; un clic copia
// il colore, ↗ apre il color picker sui colori del progetto
export default {
  async mount(ctx, el, params) {
    el.addEventListener('click', async e => {
      const b = e.target.closest('[data-hex]');
      if (!b) return;
      try { await navigator.clipboard.writeText(b.dataset.hex); ctx.ui.toast(ctx.t('copied', { value: b.dataset.hex }), 'success'); }
      catch { ctx.widget.openFull({ color: b.dataset.hex }); }
    });
    await this.refresh(ctx, el, params);
  },

  async refresh(ctx, el, { project }) {
    const { esc } = ctx.ui;
    const { t } = ctx;
    let scan, palettes;
    try {
      [scan, palettes] = await Promise.all([
        ctx.api.get(`/projects/${encodeURIComponent(project.id)}/colors`),
        ctx.api.get('/palettes').then(r => r.palettes.filter(p => p.projectId === project.id)),
      ]);
    } catch (e) { ctx.ui.patch(el, `<p class="cp-muted">${esc(e.message)}</p>`); return; }
    ctx.widget.setBadge(scan.total ? ctx.ui.fmt.number(scan.total) : null);
    const chip = (hex, title) => `<button class="cp-w-chip cp-checker" data-hex="${esc(hex)}" title="${esc(title)}"><span style="background:${esc(hex)}"></span></button>`;
    ctx.ui.patch(el, `<div class="cp-w">
      ${scan.colors.length ? `<div class="cp-w-row">${scan.colors.slice(0, 16).map(c => chip(c.hex, `${c.hex} · ${t('project.uses', { count: c.count })}${c.names.length ? ` · ${c.names.join(' ')}` : ''}`)).join('')}</div>`
        : `<p class="cp-muted">${esc(t('widget.none'))}</p>`}
      ${palettes.map(p => `<div class="cp-w-title">${esc(p.name)}</div><div class="cp-w-row">${p.colors.slice(0, 16).map(c => chip(c.value, `${c.name ? `${c.name} · ` : ''}${c.value}`)).join('')}</div>`).join('')}
    </div>`);
  },

  unmount() {},
};
