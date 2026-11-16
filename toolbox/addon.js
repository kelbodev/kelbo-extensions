// Add-on facoltativo dell'HTTP (punto response-actions): la risposta JSON di una richiesta nella
// scheda JSON del Coltellino, o in Confronta (due invii di fila si confrontano)
export default {
  activate(ctx, http) {
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
  },
};
