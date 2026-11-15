// Add-on facoltativo di NPM (punto script-actions): "Esegui nella shell" sulla riga di ogni script
// apre un terminale nella cartella del progetto e ci lancia lo script (npm run …), dove si può
// interagire, interromperlo con Ctrl+C e rilanciarlo con ↑
export default {
  activate(ctx, npm) {
    npm.addScriptAction({
      icon: 'square-terminal',
      label: ctx.t('addon.runInShell'),
      title: target => ctx.t('addon.runInShellTitle', { command: target.command }),
      run: target => ctx.open('terminal', { project: target.projectId, command: target.command }),
    });
  },
};
