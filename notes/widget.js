// Widget To-do e note per la dashboard di progetto: voci aperte delle liste della bacheca del
// progetto (spunta dal widget, aggiungi una voce) e le ultime note modificate. Cifrate come
// nella sezione: con il vault bloccato il widget chiede di sbloccarlo.

const MAX_NOTES = 3;
const states = new WeakMap(); // el → { project, board, locked, list }

const boardUrl = (project, ...parts) => `/boards/${[project.id, ...parts].map(encodeURIComponent).join('/')}`;

async function load(ctx, el) {
  const st = states.get(el);
  try {
    st.board = await ctx.api.get(boardUrl(st.project));
    st.locked = false;
  } catch (e) {
    if (!ctx.vault.isVaultError(e)) throw e;
    st.locked = true;
  }
  render(ctx, el);
}

function render(ctx, el) {
  const { esc, fmt } = ctx.ui;
  const { t } = ctx;
  const st = states.get(el);
  if (st.locked) {
    ctx.widget.setBadge('🔒');
    ctx.ui.patch(el, `<p class="nt-muted">${esc(t('locked.text'))}</p><button class="btn btn-primary btn-sm" data-ntw="unlock">${esc(t('locked.unlock'))}</button>`);
    return;
  }
  const { lists, notes, counts } = st.board;
  ctx.widget.setBadge(counts.open ? fmt.number(counts.open) : null);
  if (!lists.some(l => l.id === st.list)) st.list = lists[0]?.id || null;
  const recent = [...notes].sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt))).slice(0, MAX_NOTES);
  ctx.ui.patch(el, `
    ${lists.length ? lists.map(l => {
      const open = l.items.filter(i => !i.done);
      const pct = l.items.length ? (l.items.length - open.length) / l.items.length : 0;
      return `<div class="ntw-list">
        <div class="ntw-list-head"><strong>${esc(l.title)}</strong>
          <span class="nt-muted">${esc(fmt.number(pct, { style: 'percent' }))}</span></div>
        ${open.length ? open.map(i => `<label class="ntw-item"><input type="checkbox" data-ntw="check" data-list="${esc(l.id)}" data-item="${esc(i.id)}"> <span>${esc(i.text)}</span></label>`).join('')
          : `<div class="nt-muted ntw-done">${esc(t('widget.allDone'))}</div>`}
      </div>`;
    }).join('') : `<p class="nt-muted">${esc(t('widget.noLists'))}</p>`}
    ${lists.length ? `<div class="ntw-add">
      ${lists.length > 1 ? `<select class="form-input ntw-select" data-ntw="list">${lists.map(l => `<option value="${esc(l.id)}" ${l.id === st.list ? 'selected' : ''}>${esc(l.title)}</option>`).join('')}</select>` : ''}
      <input class="form-input" data-ntw="add" maxlength="1000" placeholder="${esc(t('widget.addPlaceholder'))}"></div>` : ''}
    ${recent.length ? `<div class="ntw-head">${esc(t('widget.lastNotes'))}</div>
      ${recent.map(n => `<button class="ntw-note nt-c-${esc(n.color)}" data-ntw="open" title="${esc(t('widget.open'))}">
        <strong>${esc(n.title || n.text.split('\n')[0] || t('widget.untitled'))}</strong>
        <span class="nt-muted">${n.updatedAt ? esc(fmt.relative(n.updatedAt)) : ''}</span></button>`).join('')}` : ''}`);
}

async function change(ctx, el, fn) {
  try { states.get(el).board = await fn(); render(ctx, el); }
  catch (e) { ctx.ui.toast(e.message, 'error'); load(ctx, el).catch(() => {}); }
}

export default {
  async mount(ctx, el, { project }) {
    states.set(el, { project, board: null, locked: false, list: null });
    const st = () => states.get(el);
    el.addEventListener('change', e => {
      const b = e.target;
      if (b.dataset.ntw === 'list') st().list = b.value;
      if (b.dataset.ntw === 'check') change(ctx, el, () => ctx.api.put(boardUrl(st().project, 'lists', b.dataset.list, 'items', b.dataset.item), { done: true }));
    });
    el.addEventListener('keydown', e => {
      if (e.key !== 'Enter' || e.target.dataset.ntw !== 'add') return;
      const text = e.target.value.trim();
      if (!text || !st().list) return;
      e.preventDefault();
      change(ctx, el, () => ctx.api.post(boardUrl(st().project, 'lists', st().list, 'items'), { text }))
        .then(() => el.querySelector('[data-ntw="add"]')?.focus());
    });
    el.addEventListener('click', async e => {
      const b = e.target.closest('[data-ntw]');
      if (b?.dataset.ntw === 'unlock') { if (await ctx.vault.ensure()) load(ctx, el); }
      else if (b?.dataset.ntw === 'open') ctx.widget.openFull({ project: st().project.id });
    });
    await load(ctx, el);
  },
  refresh: (ctx, el) => load(ctx, el),
  unmount(ctx, el) { states.delete(el); },
};
