// SQLite come motore della sezione Database: capacità "db-engine" con id "sqlite"
const createSqliteEngine = require('./engine');

module.exports = function createDbSqlite(ctx) {
  const host = ctx.require('db-client');
  return { providers: { sqlite: createSqliteEngine({ sqlText: host.sqlText, schemaDiff: host.schemaDiff }) } };
};
