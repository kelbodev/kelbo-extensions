// Add-on facoltativo di due sezioni (un modulo, ctx.host dice quale):
// - HTTP (punto response-actions): la risposta JSON di una richiesta nella scheda JSON, o in
//   Confronta (due invii di fila si confrontano)
// - Mock (punto route-body): il corpo JSON di una rotta da modificare nella scheda JSON e da
//   rimandare alla rotta; il JSON del Coltellino importato nel corpo della rotta
export default {
  activate(ctx, host) {
    if (ctx.host === 'mock-server') mockActions(ctx, host);
    else httpActions(ctx, host);
  },
};

function httpActions(ctx, http) {
  http.addResponseAction({
    icon: 'braces',
    label: ctx.t('addon.json'),
    title: ctx.t('addon.jsonTitle'),
    when: target => target.isJson,
    run: target => ctx.open('toolbox', { json: target.body }),
  });
  http.addResponseAction({
    icon: 'git-compare',
    label: ctx.t('addon.compare'),
    title: ctx.t('addon.compareTitle'),
    when: target => target.body != null && target.body !== '',
    run: target => ctx.open('toolbox', { compare: target.body }),
  });
}

function mockActions(ctx, mock) {
  const routeLabel = target => `${target.mock?.label || ''} · ${target.route.method} ${target.route.path}`;
  mock.addBodyAction({
    icon: 'braces',
    label: ctx.t('addon.mockEdit'),
    title: ctx.t('addon.mockEditTitle'),
    // solo per una rotta salvata: il JSON torna lì
    when: target => !!target.route && target.bodyType === 'json',
    run: target => {
      ctx.ui.closeModal();
      ctx.open('toolbox', { json: target.body, origin: { label: routeLabel(target), save: text => target.saveBody(text) } });
    },
  });
  mock.addBodyAction({
    icon: 'download',
    label: ctx.t('addon.mockImport'),
    title: ctx.t('addon.mockImportTitle'),
    run: async target => {
      let text = '';
      ctx.bus.emit('toolbox:json', { reply: v => { text = v; } }); // Coltellino già aperto: risponde subito
      if (!text) { try { text = localStorage.getItem('kelbo.toolbox.json') || ''; } catch { /* niente */ } }
      if (!text.trim()) { ctx.ui.toast(ctx.t('addon.mockImportEmpty'), 'error'); return; }
      try { JSON.parse(text); } catch (e) { ctx.ui.toast(ctx.t('addon.mockImportInvalid', { error: e.message }), 'error'); return; }
      if (target.setBody(text, 'json')) ctx.ui.toast(ctx.t('addon.mockImported'), 'success');
    },
  });
}
