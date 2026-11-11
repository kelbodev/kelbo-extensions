// PostgreSQL come motore della sezione Database: capacità "db-engine" con id "postgres".
// Gli strumenti comuni (testo SQL, confronto delle strutture) vengono dal db-client.
const createPgEngine = require('./engine');

module.exports = function createDbPostgres(ctx) {
  const host = ctx.require('db-client');
  return { providers: { postgres: createPgEngine({ sqlText: host.sqlText, schemaDiff: host.schemaDiff }) } };
};
