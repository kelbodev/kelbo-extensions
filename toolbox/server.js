// Coltellino: tutto il lavoro è nel browser; il backend dà solo l'accesso ai token in memoria
// delle utenze dell'HTTP client (servizi tokens() e token() di http-client, dipendenza facoltativa).
// L'elenco non contiene i valori; un valore si legge solo con il vault sbloccato (423 altrimenti).
module.exports = function createToolbox(ctx) {
  const http = () => ctx.require('http-client');
  const KEY_RE = ctx.lib.validate.KEY_RE;

  return {
    handlers: {
      httpTokens(req, res) {
        const h = http();
        res.json({ available: !!h?.tokens, tokens: h?.tokens ? h.tokens() : [] });
      },
      httpToken(req, res) {
        const h = http();
        if (!h?.token) throw ctx.error(404, 'http_missing');
        const { section, user } = req.params;
        if (!KEY_RE.test(section) || !KEY_RE.test(user)) throw ctx.error(400, 'token_not_found');
        const t = h.token(section, user);
        if (!t) throw ctx.error(404, 'token_not_found');
        res.json(t);
      },
    },
  };
};
