// Widget MongoDB per la dashboard di progetto: connessioni collegate al progetto (campo
// Progetto), con la prova della connessione (non di quelle via tunnel, che lo aprirebbero)
// e l'apertura nella sezione MongoDB.

const states = new WeakMap(); // el → { project, list, locked, tests: Map(id → { ok, text } | 'testing') }

async function load(ctx, el) {
  const st = states.get(el);
  try {
    st.list = (await ctx.api.get('/connections')).connections.filter(c => c.projectId === st.project.id);
    st.locked = false;
  } catch (e) {
    if (!ctx.vault.isVaultError(e)) throw e;
    st.locked = true;
    st.list = [];
  }
  render(ctx, el);
  await Promise.all(st.list.filter(c => !c.tunnel).map(c => test(ctx, el, c.id)));
}

async function test(ctx, el, id) {
  const st = states.get(el);
  st.tests.set(id, 'testing');
  render(ctx, el);
  try {
    const r = await ctx.api.post(`/connections/${encodeURIComponent(id)}/test`);
    st.tests.set(id, { ok: true, text: `MongoDB ${r.version}` });
  } catch (e) { st.tests.set(id, { ok: false, text: e.message }); }
  if (states.has(el)) render(ctx, el);
}

function render(ctx, el) {
  const { esc, fmt } = ctx.ui;
  const { t } = ctx;
  const st = states.get(el);
  if (st.locked) {
    ctx.widget.setBadge('🔒');
    ctx.ui.patch(el, `<p class="mg-muted">${esc(t('sidebar.locked'))}</p><button class="btn btn-primary btn-sm" data-mgw="unlock">${esc(t('widget.unlock'))}</button>`);
    return;
  }
  const failed = st.list.filter(c => st.tests.get(c.id)?.ok === false).length;
  ctx.widget.setBadge(failed ? `✖ ${fmt.number(failed)}` : null);
  if (!st.list.length) { ctx.ui.patch(el, `<p class="mg-muted">${esc(t('widget.none'))}</p>`); return; }
  ctx.ui.patch(el, `<div class="mgw-list">${st.list.map(c => {
    const tst = st.tests.get(c.id);
    const dot = tst === 'testing' || !tst ? 'mgw-wait' : tst.ok ? 'mgw-ok' : 'mgw-err';
    return `<div class="mgw-conn">
      <div class="mgw-row"><span class="mgw-dot ${dot}"></span><strong>${c.readOnly ? '🔒 ' : ''}${esc(c.label)}</strong>
        <span class="mgw-actions">
          <button class="btn btn-ghost btn-sm" data-mgw="test" data-id="${esc(c.id)}" title="${esc(t('widget.retest'))}">↻</button>
          <button class="btn btn-ghost btn-sm" data-mgw="open" data-id="${esc(c.id)}">${esc(t('widget.open'))}</button>
        </span></div>
      ${tst && tst !== 'testing' ? `<div class="mgw-detail ${tst.ok ? 'mg-muted' : 'mgw-error'}">${esc(tst.text)}</div>`
        : !tst && c.tunnel ? `<div class="mgw-detail mg-muted">${esc(t('widget.tunnelNotTested'))}</div>` : ''}
    </div>`;
  }).join('')}</div>`);
}

export default {
  async mount(ctx, el, { project }) {
    states.set(el, { project, list: [], locked: false, tests: new Map() });
    el.addEventListener('click', async e => {
      const b = e.target.closest('[data-mgw]');
      if (!b) return;
      if (b.dataset.mgw === 'unlock') { if (await ctx.vault.ensure()) load(ctx, el); }
      else if (b.dataset.mgw === 'test') test(ctx, el, b.dataset.id);
      else ctx.widget.openFull({ connection: b.dataset.id });
    });
    await load(ctx, el);
  },
  refresh(ctx, el) { states.get(el).tests.clear(); return load(ctx, el); },
  unmount(ctx, el) { states.delete(el); },
};
