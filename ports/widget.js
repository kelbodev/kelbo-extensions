// Widget Porte per la dashboard di progetto: porte in ascolto dei processi npm del progetto
// (riconosciuti dall'estensione NPM), con l'arresto che passa dall'estensione che li ha avviati.

const POLL_MS = 5000;
const states = new WeakMap(); // el → { project, timer, ports }

// Processo npm del progetto: projectId (Kelbo ≥ 2.17), altrimenti il nome del progetto
const ofProject = (p, project) => p.owner?.type === 'npm'
  && (p.owner.projectId ? p.owner.projectId === project.id : p.owner.label?.startsWith(`${project.label} — `));

async function load(ctx, el) {
  const st = states.get(el);
  st.ports = (await ctx.api.get('/list')).ports.filter(p => ofProject(p, st.project)).sort((a, b) => a.port - b.port);
  render(ctx, el);
}

function render(ctx, el) {
  const { esc, fmt } = ctx.ui;
  const { t } = ctx;
  const { ports } = states.get(el);
  ctx.widget.setBadge(ports.length ? fmt.number(ports.length) : null);
  if (!ctx.hasExtension('npm')) { ctx.ui.patch(el, `<p class="pw-muted">${esc(t('widget.noNpm'))}</p>`); return; }
  if (!ports.length) { ctx.ui.patch(el, `<p class="pw-muted">${esc(t('widget.none'))}</p>`); return; }
  ctx.ui.patch(el, `<div class="pw-list">${ports.map(p => `
    <div class="pw-row">
      <span class="pw-port">:${esc(p.port)}</span>
      <span class="pw-owner" title="${esc(p.command || '')}">${esc(p.owner.label.split(' — ').pop())}</span>
      <span class="pw-muted">${esc(p.name || '')} · ${esc(p.pid)}</span>
      ${p.own ? `<button class="btn btn-ghost btn-sm" data-pw="stop" data-port="${esc(p.port)}" data-pid="${esc(p.pid)}" title="${esc(t('stop'))}">■</button>` : ''}
    </div>`).join('')}</div>`);
}

export default {
  async mount(ctx, el, { project }) {
    states.set(el, { project, timer: null, ports: [] });
    el.addEventListener('click', async e => {
      const b = e.target.closest('[data-pw="stop"]');
      if (!b) return;
      const p = states.get(el).ports.find(x => String(x.port) === b.dataset.port && String(x.pid) === b.dataset.pid);
      if (!p || !confirm(ctx.t('widget.confirmStop', { port: p.port, owner: p.owner.label }))) return;
      try {
        await ctx.api.post('/stop', { port: p.port, pid: p.pid, force: false });
        ctx.ui.toast(ctx.t('widget.stopped', { port: p.port }), 'success');
      } catch (err) { ctx.ui.toast(err.message, 'error'); }
      load(ctx, el).catch(() => {});
    });
    await load(ctx, el);
    states.get(el).timer = setInterval(() => load(ctx, el).catch(() => {}), POLL_MS);
  },
  refresh: (ctx, el) => load(ctx, el),
  unmount(ctx, el) { clearInterval(states.get(el)?.timer); states.delete(el); },
};
