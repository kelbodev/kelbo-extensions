// Microsoft SQL Server come motore della sezione Database: capacità "db-engine" con id "mssql"
const createMssqlEngine = require('./engine');

module.exports = function createDbMssql(ctx) {
  const host = ctx.require('db-client');
  return { providers: { mssql: createMssqlEngine({ sqlText: host.sqlText, schemaDiff: host.schemaDiff }) } };
};
