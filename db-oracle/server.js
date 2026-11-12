// Oracle Database come motore della sezione Database: capacità "db-engine" con id "oracle"
const createOracleEngine = require('./engine');

module.exports = function createDbOracle(ctx) {
  const host = ctx.require('db-client');
  return { providers: { oracle: createOracleEngine({ sqlText: host.sqlText, schemaDiff: host.schemaDiff }) } };
};
