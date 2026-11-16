// Add-on facoltativo di NPM (punto script-actions): "Esegui nella shell" sulla riga di ogni script
// apre un terminale nella cartella del progetto e ci lancia lo script (npm run …), dove si può
// interagire, interromperlo con Ctrl+C e rilanciarlo con ↑; prima avvia i tunnel del progetto
export default {
  activate(ctx, npm) {
    npm.addScriptAction({
      icon: 'square-terminal',
      label: ctx.t('addon.runInShell'),
      title: target => ctx.t('addon.runInShellTitle', { command: target.command }),
      run: async target => {
        // prima, come "Esegui" di NPM: i tunnel collegati al progetto (NPM ≥ 1.2); uno che non
        // parte non blocca lo script, ma lo si dice
        if (target.prepare) {
          try {
            const { failed } = await target.prepare();
            for (const reason of failed || []) ctx.ui.toast(ctx.t('addon.tunnelFailed', { reason }), 'error');
          } catch (e) { ctx.ui.toast(ctx.t('addon.tunnelFailed', { reason: e.message }), 'error'); }
        }
        ctx.open('terminal', { project: target.projectId, command: target.command });
      },
    });
  },
};
