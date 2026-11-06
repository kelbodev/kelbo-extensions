// Anteprima Swagger/OpenAPI: il file viene letto nel browser, nessuna chiamata al backend

// Librerie da CDN con hash SRI (verificati contro api.cdnjs.com). Se si cambia
// versione vanno aggiornati anche gli hash.
const CDNJS = 'https://cdnjs.cloudflare.com/ajax/libs';
const CDN = {
  swaggerCss:    { url: `${CDNJS}/swagger-ui/5.17.14/swagger-ui.min.css`,                   sri: 'sha512-+9UD8YSD9GF7FzOH38L9S6y56aYNx3R4dYbOCgvTJ2ZHpJScsahNdaMQJU/8osUiz9FPu0YZ8wdKf4evUbsGSg==' },
  swaggerBundle: { url: `${CDNJS}/swagger-ui/5.17.14/swagger-ui-bundle.min.js`,             sri: 'sha512-7ihPQv5ibiTr0DW6onbl2MIKegdT6vjpPySyIb4Ftp68kER6Z7Yiub0tFoMmCHzZfQE9+M+KSjQndv6NhYxDgg==' },
  swaggerPreset: { url: `${CDNJS}/swagger-ui/5.17.14/swagger-ui-standalone-preset.min.js`,  sri: 'sha512-UrYi+60Ci3WWWcoDXbMmzpoi1xpERbwjPGij6wTh8fXl81qNdioNNHExr9ttnBebKF0ZbVnPlTPlw+zECUK1Xw==' },
  jsYaml:        { url: `${CDNJS}/js-yaml/4.1.0/js-yaml.min.js`,                            sri: 'sha512-CSBhVREyzHAjAFfBlIBakjoRUKp5h7VSweP0InR/pAJyptH7peuhCsqAI/snV+TwZmXZqoUklpXp6R6wMnYf5Q==' },
};

// Errore di caricamento con l'URL: il messaggio è tradotto da chi lo mostra
class ScriptError extends Error {
  constructor(url) { super(url); this.url = url; }
}

function loadScript({ url, sri }) {
  return new Promise((resolve, reject) => {
    if (document.querySelector(`script[src="${url}"]`)) return resolve();
    const s = document.createElement('script');
    s.src = url;
    s.integrity = sri;
    s.crossOrigin = 'anonymous';
    s.onload = resolve;
    s.onerror = () => reject(new ScriptError(url));
    document.head.appendChild(s);
  });
}

function loadCss({ url, sri }) {
  if (document.querySelector(`link[href="${url}"]`)) return;
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = url;
  link.integrity = sri;
  link.crossOrigin = 'anonymous';
  document.head.appendChild(link);
}

// YAML con js-yaml, in alternativa JSON
async function parseSpec(text) {
  try {
    if (!window.jsyaml) await loadScript(CDN.jsYaml);
    return window.jsyaml.load(text);
  } catch {
    return JSON.parse(text);
  }
}

let lastError = null; // ultimo errore mostrato, ritradotto al cambio di lingua

function showError(ctx, e) {
  lastError = e;
  const box = ctx.root.querySelector('[data-role="error"]');
  box.hidden = !e;
  if (!e) return;
  const detail = e instanceof ScriptError ? ctx.t('error.script', { url: e.url }) : e.message;
  box.textContent = ctx.t('error.load', { error: detail });
}

export default {
  languageChanged(ctx) {
    if (lastError) showError(ctx, lastError);
  },

  mount(ctx) {
    const el = role => ctx.root.querySelector(`[data-role="${role}"]`);

    const input = ctx.sidebar.querySelector('[data-role="file"]');
    input.addEventListener('change', async () => {
      const file = input.files[0];
      if (!file) return;
      ctx.sidebar.querySelector('[data-role="file-info"]').innerHTML = `${ctx.ui.icon('file-code')} ${ctx.ui.esc(file.name)}`;
      input.value = ''; // permette di ricaricare lo stesso file

      el('empty').hidden = true;
      showError(ctx, null);
      const host = el('host');
      host.hidden = false;
      host.innerHTML = '';

      try {
        loadCss(CDN.swaggerCss);
        await loadScript(CDN.swaggerBundle);
        await loadScript(CDN.swaggerPreset);
        const spec = await parseSpec(await file.text());
        window.SwaggerUIBundle({
          spec,
          domNode: host,
          presets: [window.SwaggerUIBundle.presets.apis, window.SwaggerUIStandalonePreset],
          layout: 'StandaloneLayout',
          deepLinking: true,
          defaultModelsExpandDepth: 1,
          defaultModelExpandDepth: 1,
          validatorUrl: null, // niente badge da validator.swagger.io (bloccato dalla CSP)
        });
      } catch (e) {
        host.hidden = true;
        showError(ctx, e);
      }
    });
  },
};
