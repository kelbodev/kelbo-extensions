// Client MongoDB: connessioni (sezione "mongoConnections", cartelle in "mongoFolders") con la
// password cifrata dal vault del core, database e collezioni, documenti in Extended JSON, editor
// in sintassi mongosh. Come nel client database, nessuna modifica parte da sola: il server
// restituisce l'operazione esatta e la esegue solo con il token di conferma legato a
// quell'operazione; le connessioni in sola lettura le rifiutano.
const crypto = require('crypto');
const { MongoClient } = require('mongodb');
const { toJson, parse, shell, EjsonError, EJSON } = require('./ejson');
const mongosh = require('./mongosh');
const runner = require('./runner');

const FIELDS = ['id', 'label', 'uri', 'host', 'port', 'user', 'password', 'authSource', 'database', 'tls', 'tlsInsecure', 'tunnel', 'readOnly', 'folder', 'projectId'];
const FOLDER_FIELDS = ['id', 'label'];
const HOST_RE = /^(\[[0-9a-f:.]+\]|[A-Za-z0-9._-]{1,253})$/i;
const NAME_RE = /^[^\x00$/\\. "]{1,64}$/;                 // nome di database
const COLL_RE = /^(?!system\.)[^\x00$]{1,120}$/;           // nome di collezione
const URI_RE = /^mongodb(\+srv)?:\/\/[^\s]{1,1000}$/;
const CONNECT_TIMEOUT_MS = 8000;
const QUERY_TIMEOUT_MS = 30000;
const PAGE_SIZES = [10, 25, 50, 100, 250];
const MAX_EXPORT = 100000;
const MAX_BATCH = 1000;
const RESULT_LIMITS = [50, 100, 500, 1000];
const MAX_CODE = 200000;
const OPS = ['insertOne', 'insertMany', 'replaceOne', 'deleteMany', 'dropCollection', 'updateFields',
  'createCollection', 'renameCollection', 'createIndex', 'dropIndex'];
const EXPORT_FORMATS = {
  json: { type: 'application/json; charset=utf-8', ext: 'json' },
  csv: { type: 'text/csv; charset=utf-8', ext: 'csv' },
  js: { type: 'text/javascript; charset=utf-8', ext: 'js' },
};
const INDEX_TYPES = [1, -1, 'text', '2dsphere', '2d', 'hashed'];
// campo di un documento: "a.b.c", senza "$" iniziale né segmenti vuoti
const PATH_RE = /^(?!\$)[^.\x00]+(\.[^.\x00]+)*$/;
// CSV RFC 4180: virgolette quando servono
const csvField = v => {
  const str = String(v);
  return /[",\r\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
};
// valore relaxed → testo di una cella CSV (tipi speciali come testo semplice)
function csvValue(v) {
  if (v === null || v === undefined) return '';
  if (typeof v !== 'object') return String(v);
  const keys = Object.keys(v);
  if (keys.length === 1 && ['$oid', '$numberDecimal', '$numberLong', '$numberDouble'].includes(keys[0])) return String(v[keys[0]]);
  if (keys.length === 1 && keys[0] === '$date') return typeof v.$date === 'string' ? v.$date : JSON.stringify(v.$date);
  return JSON.stringify(v);
}

module.exports = function createMongoClient(ctx) {
  const { KEY_RE, isText, isPort } = ctx.lib.validate;
  const { pick } = ctx.lib.config;
  const tunnels = ctx.require('tunnels'); // opzionale: connessioni via tunnel SSH
  const vault = ctx.vault;

  const connections = () => ctx.config.get('mongoConnections');
  const save = list => ctx.config.set('mongoConnections', list);
  const findConn = id => connections().find(c => c.id === id) || null;
  const connOr404 = id => {
    const c = findConn(id);
    if (!c) throw ctx.error(404, 'connection_not_found', { id: String(id) });
    return c;
  };
  const ejsonCall = fn => {
    try { return fn(); } catch (e) { if (e instanceof EjsonError) throw ctx.error(400, e.key, e.params); throw e; }
  };
  // errori del driver: messaggio originale (non tradotto) come parametro
  const driverError = e => (typeof e?.code === 'string' && e.code.includes('.') ? e : ctx.error(502, 'mongo', { error: e?.message || String(e) }));
  const run = async fn => { try { return await fn(); } catch (e) { throw driverError(e); } };

  // ---- validazione ----

  function validateConnection(c) {
    const bad = field => ctx.error.config(`connection_${field}`, { id: String(c?.id ?? '') });
    if (!c || typeof c !== 'object' || !KEY_RE.test(c.id || '')) throw bad('id');
    if (!isText(c.label, 100)) throw bad('label');
    if (c.uri != null) {
      if (!URI_RE.test(c.uri)) throw bad('uri');
      if (/^mongodb(\+srv)?:\/\/[^@/]*:[^@/]*@/.test(c.uri)) throw bad('uri_password'); // la password va nel vault
    } else if (c.tunnel != null) {
      if (!KEY_RE.test(c.tunnel)) throw bad('tunnel');
    } else {
      if (!HOST_RE.test(c.host || '')) throw bad('host');
      if (!isPort(c.port)) throw bad('port');
    }
    if (c.user != null && c.user !== '' && !isText(c.user, 200)) throw bad('user');
    if (c.password != null && !vault.isBox(c.password)) throw bad('password');
    if (c.authSource != null && c.authSource !== '' && !NAME_RE.test(c.authSource)) throw bad('auth_source');
    if (c.database != null && c.database !== '' && !NAME_RE.test(c.database)) throw bad('database');
    for (const k of ['tls', 'tlsInsecure', 'readOnly']) if (c[k] != null && typeof c[k] !== 'boolean') throw bad(k === 'readOnly' ? 'read_only' : 'tls');
    if (c.folder != null && !KEY_RE.test(c.folder)) throw bad('folder');
    if (c.projectId != null && !KEY_RE.test(c.projectId)) throw bad('project');
  }

  const folders = () => ctx.config.get('mongoFolders');

  const config = {
    mongoFolders: {
      empty: [], idField: 'id',
      normalize: v => (Array.isArray(v) ? v.map(f => pick(f || {}, FOLDER_FIELDS)) : v),
      validate(list) {
        if (!Array.isArray(list)) throw ctx.error.config('not_a_list', { section: 'mongoFolders' });
        const seen = new Set();
        for (const f of list) {
          if (!f || typeof f !== 'object' || !KEY_RE.test(f.id || '')) throw ctx.error.config('folder_id', { id: String(f?.id ?? '') });
          if (!isText(f.label, 100)) throw ctx.error.config('folder_label', { id: f.id });
          if (seen.has(f.id)) throw ctx.error.config('duplicate_folder', { id: f.id });
          seen.add(f.id);
        }
      },
    },
    mongoConnections: {
      empty: [], idField: 'id',
      normalize: v => (Array.isArray(v) ? v.map(c => pick(c || {}, FIELDS)) : v),
      validate(list, cfg) {
        if (!Array.isArray(list)) throw ctx.error.config('not_a_list', { section: 'mongoConnections' });
        const seen = new Set();
        for (const c of list) {
          validateConnection(c);
          if (seen.has(c.id)) throw ctx.error.config('duplicate_connection', { id: c.id });
          seen.add(c.id);
          if (c.password != null && !cfg.vault) throw ctx.error.config('password_without_vault', { id: c.id });
          if (c.folder != null && !(cfg.mongoFolders || []).some(f => f?.id === c.folder)) throw ctx.error.config('connection_folder_missing', { id: c.id, folder: c.folder });
        }
      },
    },
  };

  // Password ri-cifrate al cambio della master password, cancellate al reset; client chiusi al blocco
  vault.register({
    rekey(reencrypt, cfg) {
      const list = cfg.mongoConnections || [];
      return { sections: { mongoConnections: list.map(c => (c.password ? { ...c, password: reencrypt(c.password) } : c)) }, count: list.filter(c => c.password).length };
    },
    reset: cfg => ({ mongoConnections: (cfg.mongoConnections || []).map(c => ({ ...c, password: null })) }),
    lock: () => closeClients(),
  });

  // ---- client del driver (uno per connessione, chiuso quando la connessione cambia) ----

  const clients = new Map(); // id → { client, signature }

  function closeClients(id) {
    for (const [k, v] of clients) {
      if (id && k !== id) continue;
      v.client.close().catch(() => {});
      clients.delete(k);
    }
  }

  async function connectionUri(c) {
    const password = c.password ? vault.decrypt(c.password) : '';
    let base;
    if (c.uri) base = new URL(c.uri);
    else {
      let host = c.host, port = c.port;
      if (c.tunnel) {
        if (!tunnels) throw ctx.error(400, 'tunnels_unavailable');
        if (!tunnels.getServer(c.tunnel)) throw ctx.error(400, 'tunnel_deleted', { tunnel: c.tunnel });
        const t = await tunnels.ensureTunnel(c.tunnel);
        host = '127.0.0.1'; port = t.port;
      }
      base = new URL(`mongodb://${host.includes(':') && !host.startsWith('[') ? `[${host}]` : host}:${port}/`);
      // un solo server (anche dietro un tunnel): niente scoperta degli altri membri del replica set
      base.searchParams.set('directConnection', 'true');
    }
    if (c.user) { base.username = c.user; base.password = password; }
    if (c.authSource) base.searchParams.set('authSource', c.authSource);
    if (c.tls) base.searchParams.set('tls', 'true');
    if (c.tlsInsecure) base.searchParams.set('tlsInsecure', 'true');
    return base.toString();
  }

  async function clientFor(c) {
    const uri = await connectionUri(c);
    const signature = crypto.createHash('sha256').update(uri).digest('hex');
    const cached = clients.get(c.id);
    if (cached && cached.signature === signature) return cached.client;
    if (cached) closeClients(c.id);
    const client = new MongoClient(uri, {
      serverSelectionTimeoutMS: CONNECT_TIMEOUT_MS, connectTimeoutMS: CONNECT_TIMEOUT_MS,
      appName: 'Kelbo', promoteLongs: false, ignoreUndefined: true,
      ...(c.readOnly ? { readPreference: 'secondaryPreferred' } : {}),
    });
    await run(() => client.connect());
    clients.set(c.id, { client, signature });
    return client;
  }

  const dbName = name => {
    if (!NAME_RE.test(name || '')) throw ctx.error(400, 'database_invalid', { name: String(name ?? '') });
    return name;
  };
  const collName = name => {
    if (!COLL_RE.test(name || '')) throw ctx.error(400, 'collection_invalid', { name: String(name ?? '') });
    return name;
  };

  async function collection(c, db, coll) {
    const client = await clientFor(c);
    return client.db(dbName(db)).collection(collName(coll));
  }

  // ---- letture ----

  async function listDatabases(c) {
    const client = await clientFor(c);
    try {
      const r = await client.db('admin').admin().listDatabases({ nameOnly: false });
      return r.databases.map(d => ({ name: d.name, sizeOnDisk: Number(d.sizeOnDisk ?? 0), empty: !!d.empty }));
    } catch (e) {
      // utente senza permessi su listDatabases: almeno il database della connessione
      if (c.database && /not authorized|Unauthorized/i.test(e.message)) return [{ name: c.database, sizeOnDisk: null, empty: false, restricted: true }];
      throw driverError(e);
    }
  }

  async function listCollections(c, db) {
    const client = await clientFor(c);
    const d = client.db(dbName(db));
    const list = await run(() => d.listCollections({}, { nameOnly: false }).toArray());
    const out = await Promise.all(list.filter(x => !x.name.startsWith('system.')).map(async x => {
      let count = null;
      if (x.type !== 'view') { try { count = await d.collection(x.name).estimatedDocumentCount({ maxTimeMS: 5000 }); } catch { /* conteggio non disponibile */ } }
      return { name: x.name, type: x.type || 'collection', count };
    }));
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  // { filter, sort, projection, skip, limit } → documenti, totale (fino a un tempo massimo)
  async function findDocuments(c, db, coll, body, { maxLimit = PAGE_SIZES.at(-1) } = {}) {
    const filter = ejsonCall(() => parse(body.filter, 'filter'));
    const sort = ejsonCall(() => parse(body.sort, 'sort'));
    const projection = ejsonCall(() => parse(body.projection, 'projection'));
    const limit = Math.min(Math.max(parseInt(body.limit) || 50, 1), maxLimit);
    const skip = Math.max(parseInt(body.skip) || 0, 0);
    const col = await collection(c, db, coll);
    const started = Date.now();
    const docs = await run(() => col.find(filter, { sort, projection, skip, limit: limit + 1, maxTimeMS: QUERY_TIMEOUT_MS }).toArray());
    let total = null;
    if (body.count !== false) {
      try { total = await col.countDocuments(filter, { maxTimeMS: 5000 }); } catch { /* troppo lento: senza totale */ }
    }
    return {
      documents: docs.slice(0, limit).map(toJson), hasMore: docs.length > limit,
      skip, limit, total, ms: Date.now() - started,
    };
  }

  // ---- modifiche: anteprima, token di conferma, esecuzione ----

  const confirmSecret = crypto.randomBytes(32); // i token valgono fino al riavvio di Kelbo
  const tokenOf = (connId, op) => crypto.createHmac('sha256', confirmSecret).update(`${connId}\0${JSON.stringify(op)}`).digest('hex');

  // Operazione dal client → forma normalizzata (documenti come Extended JSON canonico) e anteprima
  function plan(c, raw) {
    const op = raw || {};
    if (!OPS.includes(op.op)) throw ctx.error(400, 'operation_invalid');
    const db = dbName(op.database), coll = collName(op.collection);
    const norm = { op: op.op, database: db, collection: coll };
    const target = `db.getSiblingDB(${JSON.stringify(db)}).getCollection(${JSON.stringify(coll)})`;
    let preview, count = 1;
    if (op.op === 'insertOne') {
      const doc = ejsonCall(() => parse(op.document, 'document'));
      norm.document = toJsonCanonical(doc);
      preview = `${target}.insertOne(${shell(doc)})`;
    } else if (op.op === 'insertMany') {
      const docs = ejsonCall(() => parse(op.documents, 'documents', { object: false }));
      if (!Array.isArray(docs) || !docs.length || docs.length > MAX_BATCH || !docs.every(d => d && typeof d === 'object' && !Array.isArray(d))) throw ctx.error(400, 'documents_invalid', { max: MAX_BATCH });
      norm.documents = docs.map(toJsonCanonical);
      count = docs.length;
      preview = `${target}.insertMany([\n${docs.map(d => shell(d, '  ')).map(s => `  ${s}`).join(',\n')}\n])`;
    } else if (op.op === 'replaceOne') {
      const id = ejsonCall(() => parse(op.id, 'id', { object: false }));
      if (id === null || id === undefined) throw ctx.error(400, 'id_required');
      const doc = ejsonCall(() => parse(op.document, 'document'));
      if (doc._id !== undefined && JSON.stringify(toJsonCanonical({ v: doc._id })) !== JSON.stringify(toJsonCanonical({ v: id }))) throw ctx.error(400, 'id_changed');
      delete doc._id;
      norm.id = toJsonCanonical({ v: id }).v;
      norm.document = toJsonCanonical(doc);
      preview = `${target}.replaceOne(\n  { _id: ${shell(id)} },\n  ${shell(doc, '  ')}\n)`;
    } else if (op.op === 'deleteMany') {
      const ids = ejsonCall(() => parse(op.ids, 'ids', { object: false }));
      if (!Array.isArray(ids) || !ids.length || ids.length > MAX_BATCH) throw ctx.error(400, 'ids_invalid', { max: MAX_BATCH });
      norm.ids = ids.map(x => toJsonCanonical({ v: x }).v);
      count = ids.length;
      preview = ids.length === 1 ? `${target}.deleteOne({ _id: ${shell(ids[0])} })` : `${target}.deleteMany({ _id: { $in: ${shell(ids)} } })`;
    } else if (op.op === 'dropCollection') {
      preview = `${target}.drop()`;
      count = null;
    } else if (op.op === 'updateFields') {
      // celle modificate nella tabella: per documento { id, set: { campo: valore }, unset: [campo] }
      const list = ejsonCall(() => parse(op.updates, 'updates', { object: false }));
      if (!Array.isArray(list) || !list.length || list.length > MAX_BATCH) throw ctx.error(400, 'updates_invalid', { max: MAX_BATCH });
      norm.updates = list.map(u => {
        if (!u || typeof u !== 'object' || u.id === undefined || u.id === null) throw ctx.error(400, 'updates_invalid', { max: MAX_BATCH });
        const set = u.set ?? {}, unset = u.unset ?? [];
        if (typeof set !== 'object' || Array.isArray(set) || !Array.isArray(unset)) throw ctx.error(400, 'updates_invalid', { max: MAX_BATCH });
        for (const path of [...Object.keys(set), ...unset]) {
          if (typeof path !== 'string' || !PATH_RE.test(path) || path === '_id' || path.startsWith('_id.')) throw ctx.error(400, 'field_invalid', { field: String(path) });
        }
        if (!Object.keys(set).length && !unset.length) throw ctx.error(400, 'updates_invalid', { max: MAX_BATCH });
        return { id: toJsonCanonical({ v: u.id }).v, set: toJsonCanonical(set), unset: [...unset] };
      });
      count = list.length;
      preview = `${target}.bulkWrite([\n${list.map(u => {
        const update = { ...(Object.keys(u.set ?? {}).length ? { $set: u.set } : {}), ...(u.unset?.length ? { $unset: Object.fromEntries(u.unset.map(k => [k, ''])) } : {}) };
        return `  { updateOne: { filter: { _id: ${shell(u.id)} }, update: ${shell(update, '    ')} } }`;
      }).join(',\n')}\n])`;
    } else if (op.op === 'createCollection') {
      const options = ejsonCall(() => parse(op.options, 'options'));
      const allowed = ['capped', 'size', 'max', 'validator', 'validationLevel', 'validationAction', 'collation'];
      for (const k of Object.keys(options)) if (!allowed.includes(k)) throw ctx.error(400, 'option_invalid', { option: k });
      if (options.validationLevel !== undefined && !['off', 'strict', 'moderate'].includes(options.validationLevel)) throw ctx.error(400, 'option_invalid', { option: 'validationLevel' });
      if (options.validationAction !== undefined && !['error', 'warn'].includes(options.validationAction)) throw ctx.error(400, 'option_invalid', { option: 'validationAction' });
      if (options.capped && !(Number(options.size) > 0)) throw ctx.error(400, 'capped_size');
      norm.options = toJsonCanonical(options);
      count = null;
      preview = `db.getSiblingDB(${JSON.stringify(db)}).createCollection(${JSON.stringify(coll)}${Object.keys(options).length ? `, ${shell(options)}` : ''})`;
    } else if (op.op === 'renameCollection') {
      norm.to = collName(op.to);
      if (norm.to === coll) throw ctx.error(400, 'collection_same');
      count = null;
      preview = `${target}.renameCollection(${JSON.stringify(norm.to)})`;
    } else if (op.op === 'createIndex') {
      const keys = ejsonCall(() => parse(op.keys, 'keys'));
      const entries = Object.entries(keys);
      if (!entries.length || entries.some(([k, v]) => !PATH_RE.test(k) && k !== '$**' || !INDEX_TYPES.includes(typeof v === 'object' ? Number(v) : v))) throw ctx.error(400, 'index_keys');
      const options = ejsonCall(() => parse(op.options, 'options'));
      const allowed = ['name', 'unique', 'sparse', 'expireAfterSeconds', 'partialFilterExpression', 'hidden', 'collation'];
      for (const k of Object.keys(options)) if (!allowed.includes(k)) throw ctx.error(400, 'option_invalid', { option: k });
      norm.keys = toJsonCanonical(keys);
      norm.options = toJsonCanonical(options);
      count = null;
      preview = `${target}.createIndex(${shell(keys)}${Object.keys(options).length ? `, ${shell(options)}` : ''})`;
    } else if (op.op === 'dropIndex') {
      if (typeof op.name !== 'string' || !op.name || op.name.length > 200) throw ctx.error(400, 'index_name');
      if (op.name === '_id_') throw ctx.error(400, 'index_id');
      norm.name = op.name;
      count = null;
      preview = `${target}.dropIndex(${JSON.stringify(op.name)})`;
    }
    const dangerous = ['dropCollection', 'deleteMany', 'renameCollection', 'dropIndex'].includes(op.op);
    return { op: norm, preview, count, dangerous, token: tokenOf(c.id, norm) };
  }

  const toJsonCanonical = doc => EJSON.serialize(doc, { relaxed: false });
  const fromCanonical = v => EJSON.deserialize(v, { relaxed: false });

  async function execute(c, op) {
    const col = await collection(c, op.database, op.collection);
    if (op.op === 'insertOne') {
      const r = await run(() => col.insertOne(fromCanonical(op.document)));
      return { inserted: 1, ids: [toJson({ v: r.insertedId }).v] };
    }
    if (op.op === 'insertMany') {
      const r = await run(() => col.insertMany(op.documents.map(fromCanonical), { ordered: true }));
      return { inserted: r.insertedCount, ids: Object.values(r.insertedIds).map(id => toJson({ v: id }).v) };
    }
    if (op.op === 'replaceOne') {
      const id = fromCanonical({ v: op.id }).v;
      const r = await run(() => col.replaceOne({ _id: id }, fromCanonical(op.document)));
      if (!r.matchedCount) throw ctx.error(404, 'document_not_found');
      return { matched: r.matchedCount, modified: r.modifiedCount };
    }
    if (op.op === 'deleteMany') {
      const ids = op.ids.map(x => fromCanonical({ v: x }).v);
      const r = await run(() => col.deleteMany({ _id: { $in: ids } }));
      return { deleted: r.deletedCount };
    }
    if (op.op === 'dropCollection') {
      await run(() => col.drop());
      return { dropped: true };
    }
    if (op.op === 'updateFields') {
      const ops = op.updates.map(u => {
        const set = fromCanonical(u.set);
        return { updateOne: { filter: { _id: fromCanonical({ v: u.id }).v }, update: { ...(Object.keys(set).length ? { $set: set } : {}), ...(u.unset.length ? { $unset: Object.fromEntries(u.unset.map(k => [k, ''])) } : {}) } } };
      });
      const r = await run(() => col.bulkWrite(ops, { ordered: true }));
      return { matched: r.matchedCount, modified: r.modifiedCount };
    }
    if (op.op === 'createCollection') {
      const client = await clientFor(c);
      await run(() => client.db(op.database).createCollection(op.collection, fromCanonical(op.options)));
      return { created: true };
    }
    if (op.op === 'renameCollection') {
      await run(() => col.rename(op.to));
      return { renamed: op.to };
    }
    if (op.op === 'createIndex') {
      const name = await run(() => col.createIndex(fromCanonical(op.keys), fromCanonical(op.options)));
      return { index: name };
    }
    if (op.op === 'dropIndex') {
      await run(() => col.dropIndex(op.name));
      return { dropped: true };
    }
    throw ctx.error(400, 'operation_invalid');
  }

  // ---- struttura: statistiche e schema da un campione ----

  // Tipo BSON di un valore come lo restituisce il driver
  function bsonType(v) {
    if (v === null || v === undefined) return 'null';
    if (Array.isArray(v)) return 'array';
    if (v instanceof Date) return 'date';
    if (v instanceof RegExp) return 'regex';
    if (typeof v === 'number') return Number.isInteger(v) ? 'int' : 'double';
    if (typeof v === 'string') return 'string';
    if (typeof v === 'boolean') return 'bool';
    const t = v._bsontype;
    if (t === 'Binary') return v.sub_type === 4 ? 'uuid' : 'binData';
    if (t) return { ObjectId: 'objectId', Long: 'long', Decimal128: 'decimal', BSONRegExp: 'regex', Timestamp: 'timestamp', Int32: 'int', Double: 'double', MinKey: 'minKey', MaxKey: 'maxKey', Code: 'javascript' }[t] || t;
    return 'object';
  }

  // Campi dei documenti (fino a 4 livelli; "campo[]" per gli oggetti negli array): tipi e presenza
  function schemaOf(docs) {
    const fields = new Map();
    const add = (path, v) => {
      const f = fields.get(path) || { path, count: 0, types: {} };
      f.count++;
      const t = bsonType(v);
      f.types[t] = (f.types[t] || 0) + 1;
      fields.set(path, f);
    };
    const walk = (doc, prefix, depth) => {
      for (const [k, v] of Object.entries(doc)) {
        const path = prefix ? `${prefix}.${k}` : k;
        add(path, v);
        if (depth >= 4) continue;
        if (bsonType(v) === 'object') walk(v, path, depth + 1);
        else if (Array.isArray(v)) {
          const seen = new Set();
          for (const x of v.slice(0, 50)) if (bsonType(x) === 'object') for (const [ek, ev] of Object.entries(x)) {
            const p = `${path}[].${ek}`;
            if (!seen.has(p)) { seen.add(p); add(p, ev); }
          }
        }
      }
    };
    for (const d of docs) walk(d, '', 1);
    return [...fields.values()].sort((a, b) => a.path.localeCompare(b.path));
  }

  async function structure(c, db, coll) {
    const client = await clientFor(c);
    const d = client.db(dbName(db));
    const col = d.collection(collName(coll));
    const [info] = await run(() => d.listCollections({ name: coll }).toArray());
    if (!info) throw ctx.error(404, 'collection_not_found', { name: coll });
    let stats = null;
    if (info.type !== 'view') {
      try {
        const [s] = await col.aggregate([{ $collStats: { storageStats: {} } }]).toArray();
        const st = s?.storageStats || {};
        stats = {
          count: Number(st.count ?? 0), size: Number(st.size ?? 0), avgObjSize: Number(st.avgObjSize ?? 0),
          storageSize: Number(st.storageSize ?? 0), totalIndexSize: Number(st.totalIndexSize ?? 0), nindexes: Number(st.nindexes ?? 0),
          capped: !!st.capped, indexSizes: Object.fromEntries(Object.entries(st.indexSizes || {}).map(([k, v]) => [k, Number(v)])),
        };
      } catch { /* $collStats non permesso: solo schema e indici */ }
    }
    const SAMPLE = 500;
    const docs = await run(() => col.aggregate(info.type === 'view' ? [{ $limit: SAMPLE }] : [{ $sample: { size: SAMPLE } }], { maxTimeMS: QUERY_TIMEOUT_MS }).toArray());
    const indexes = info.type === 'view' ? [] : await run(() => col.indexes());
    return {
      type: info.type || 'collection', options: toJson(info.options || {}), stats, sampled: docs.length,
      schema: schemaOf(docs), indexes: indexes.map(toJson),
    };
  }

  // ---- export (JSON, CSV, script mongosh) in streaming ----

  async function streamExport(res, cursor, format, name, collectionName) {
    const f = EXPORT_FORMATS[format];
    if (!f) { await cursor.close().catch(() => {}); throw ctx.error(400, 'export_format'); }
    // primo lotto prima delle intestazioni: un filtro sbagliato diventa un errore normale
    try { await cursor.hasNext(); } catch (e) { await cursor.close().catch(() => {}); throw driverError(e); }
    res.setHeader('Content-Type', f.type);
    res.setHeader('Content-Disposition', `attachment; filename="${String(name).replace(/[^\w.-]/g, '_')}.${f.ext}"`);
    let stopped = false;
    res.on('close', () => { stopped = true; });
    const out = async text => { if (!res.write(text)) await new Promise(r => res.once('drain', r)); };
    let n = 0;
    try {
      if (format === 'json') {
        await out('[\n');
        for await (const doc of cursor) {
          if (stopped || n >= MAX_EXPORT) break;
          await out(`${n++ ? ',\n' : ''}${JSON.stringify(toJson(doc))}`);
        }
        await out('\n]\n');
      } else if (format === 'csv') {
        // colonne: i campi di primo livello dei primi 1000 documenti, nell'ordine in cui compaiono
        const head = [];
        while (head.length < 1000 && await cursor.hasNext()) head.push(toJson(await cursor.next()));
        const columns = [...new Set(head.flatMap(d => Object.keys(d)))];
        await out(columns.map(csvField).join(',') + '\r\n');
        const row = d => columns.map(k => { const v = csvValue(d[k]); return v === '' ? '' : csvField(v); }).join(',') + '\r\n';
        for (const d of head) { await out(row(d)); n++; }
        for await (const doc of cursor) {
          if (stopped || n >= MAX_EXPORT) break;
          await out(row(toJson(doc)));
          n++;
        }
      } else {
        // script per mongosh: insertMany a blocchi di 500 documenti
        const target = `db.getCollection(${JSON.stringify(collectionName || name)})`;
        for await (const doc of cursor) {
          if (stopped || n >= MAX_EXPORT) break;
          if (n % 500 === 0) await out(`${n ? '\n]);\n\n' : ''}${target}.insertMany([\n`);
          else await out(',\n');
          await out(`  ${shell(doc, '  ')}`);
          n++;
        }
        if (n) await out('\n]);\n');
      }
    } catch (e) {
      ctx.log.error('export:', e.message); // a metà file: il download resta troncato
    } finally {
      await cursor.close().catch(() => {});
    }
    res.end();
  }

  // ---- editor: istruzioni mongosh ----

  const shellCall = fn => {
    try { return fn(); } catch (e) { if (e instanceof mongosh.ShellError || e instanceof EjsonError) throw ctx.error(400, e.key, e.params); throw e; }
  };
  const runShell = async fn => {
    try { return await fn(); } catch (e) {
      if (e instanceof mongosh.ShellError) throw ctx.error(400, e.key, e.params);
      throw driverError(e);
    }
  };
  const checkToken = (given, expected) => {
    const a = Buffer.from(String(given)), b = Buffer.from(expected);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) throw ctx.error(409, 'confirmation_mismatch');
  };

  function parseStatement(code, database) {
    if (typeof code !== 'string' || !code.trim()) throw ctx.error(400, 'shell_empty');
    if (code.length > MAX_CODE) throw ctx.error(400, 'shell_too_long', { max: MAX_CODE });
    const stmt = shellCall(() => mongosh.parse(code, database || null));
    if (stmt.database) dbName(stmt.database);
    if (stmt.collection) collName(stmt.collection);
    return stmt;
  }

  // ---- dati dal form ----

  const publicConnection = c => ({ ...pick(c, FIELDS.filter(f => f !== 'password')), hasPassword: !!c.password, ...(c.tunnel && (!tunnels || !tunnels.getServer(c.tunnel)) ? { tunnelMissing: true } : {}) });

  // password: stringa = nuova (cifrata subito), null = rimossa, assente o '' = invariata
  function buildConnection(body, existing = {}) {
    const c = { ...existing, ...pick(body || {}, ['label', 'uri', 'host', 'port', 'user', 'authSource', 'database', 'tls', 'tlsInsecure', 'tunnel', 'readOnly', 'folder', 'projectId']) };
    if (!existing.id) c.id = body.id;
    for (const k of ['uri', 'host', 'user', 'authSource', 'database', 'tunnel', 'folder', 'projectId']) if (c[k] === '' || c[k] === undefined) c[k] = null;
    if (c.folder && !folders().some(f => f.id === c.folder)) throw ctx.error(400, 'folder_unknown', { folder: String(c.folder) });
    if (c.port !== undefined && c.port !== null && c.port !== '') c.port = Number(c.port); else c.port = null;
    for (const k of ['tls', 'tlsInsecure', 'readOnly']) c[k] = !!c[k];
    if (c.uri) { c.host = null; c.port = null; c.tunnel = null; }
    else if (c.tunnel) {
      if (!tunnels) throw ctx.error(400, 'tunnels_unavailable');
      if (!tunnels.getServer(c.tunnel)) throw ctx.error(400, 'tunnel_unknown', { tunnel: String(c.tunnel) });
      c.host = null; c.port = null;
    }
    if (typeof body.password === 'string' && body.password !== '') c.password = vault.encrypt(body.password);
    else if (body.password === null) c.password = null;
    else if (c.password === undefined) c.password = null;
    for (const k of Object.keys(c)) if (c[k] === null && k !== 'password') delete c[k];
    if (!c.tls) delete c.tls;
    if (!c.tlsInsecure) delete c.tlsInsecure;
    return c;
  }

  const mcpConnection = id => {
    if (vault.state() !== 'unlocked') throw ctx.error(423, 'mcp_vault_locked');
    return connOr404(id);
  };
  const folderLabel = body => {
    const label = typeof body?.label === 'string' ? body.label.trim() : '';
    if (!isText(label, 100)) throw ctx.error(400, 'folder_label_required');
    return label;
  };

  // Tutta la sezione richiede il vault sbloccato, come il client database: connessioni, cartelle
  // e dati (423 del core: da sbloccare o da creare); gli strumenti MCP lo controllano a parte
  const requireVault = () => { if (vault.state() !== 'unlocked') vault.encrypt(''); };
  const guarded = handlers => Object.fromEntries(Object.entries(handlers).map(([name, fn]) => [name, (req, res) => { requireVault(); return fn(req, res); }]));

  return {
    config,

    handlers: guarded({
      listConnections(req, res) {
        res.json({ connections: connections().map(publicConnection), folders: folders(), tunnelsAvailable: !!tunnels, pageSizes: PAGE_SIZES, resultLimits: RESULT_LIMITS });
      },

      // ---- cartelle della sidebar (un livello) ----

      createFolder(req, res) {
        const f = { id: `f${crypto.randomBytes(4).toString('hex')}`, label: folderLabel(req.body) };
        ctx.config.set('mongoFolders', [...folders(), f]);
        res.json(f);
      },

      updateFolder(req, res) {
        const list = folders();
        const f = list.find(x => x.id === req.params.id);
        if (!f) throw ctx.error(404, 'folder_unknown', { folder: req.params.id });
        f.label = folderLabel(req.body);
        ctx.config.set('mongoFolders', list);
        res.json(f);
      },

      // Le connessioni della cartella tornano nella radice (stessa scrittura)
      deleteFolder(req, res) {
        const id = req.params.id;
        ctx.config.update({
          mongoFolders: folders().filter(f => f.id !== id),
          mongoConnections: connections().map(c => { if (c.folder !== id) return c; const { folder, ...rest } = c; return rest; }),
        });
        res.json({ ok: true });
      },

      // ---- connessioni ----

      createConnection(req, res) {
        const body = req.body || {};
        if (findConn(body.id)) throw ctx.error(409, 'connection_exists', { id: String(body.id) });
        const c = buildConnection(body);
        save([...connections(), c]);
        res.json(publicConnection(c));
      },

      updateConnection(req, res) {
        const cur = connOr404(req.params.id);
        const c = buildConnection(req.body || {}, cur);
        save(connections().map(x => (x.id === c.id ? c : x)));
        closeClients(c.id);
        res.json(publicConnection(c));
      },

      deleteConnection(req, res) {
        const c = connOr404(req.params.id);
        save(connections().filter(x => x.id !== c.id));
        closeClients(c.id);
        res.json({ ok: true });
      },

      async testConnection(req, res) {
        const c = connOr404(req.params.id);
        closeClients(c.id);
        const client = await clientFor(c);
        const info = await run(() => client.db('admin').command({ buildInfo: 1 }));
        res.json({ ok: true, version: info.version });
      },

      // Connessioni da un file esportato altrove: le password vengono decifrate con la
      // master password di quel file e ri-cifrate con la chiave attuale (vault sbloccato)
      async importConnections(req, res) {
        if (vault.state() !== 'unlocked') vault.encrypt(''); // 423 del core: vault bloccato o da creare
        const { config: file, password, mode } = req.body || {};
        if (mode !== 'merge' && mode !== 'replace') throw ctx.error(400, 'mode_invalid');
        const incoming = file?.mongoConnections;
        if (!Array.isArray(incoming)) throw ctx.error(400, 'file_no_connections');
        let fileVault = null;
        if (incoming.some(c => c?.password)) {
          if (!vault.isRecord(file.vault)) throw ctx.error(400, 'file_no_vault');
          fileVault = await vault.openForeign(file.vault, password);
          if (!fileVault) throw ctx.error(401, 'wrong_file_password');
        }
        let converted;
        try {
          converted = incoming.map(c => {
            const conn = pick(c || {}, FIELDS);
            conn.password = c?.password ? vault.encrypt(fileVault.decrypt(c.password)) : null;
            return conn;
          });
        } catch { throw ctx.error(400, 'file_passwords_unreadable'); }
        const fileFolders = Array.isArray(file.mongoFolders) ? file.mongoFolders.map(f => pick(f || {}, FOLDER_FIELDS)) : [];
        const currentFolders = folders();
        const folderIds = new Set(currentFolders.map(f => f.id));
        const nextFolders = mode === 'replace' ? fileFolders : [...currentFolders, ...fileFolders.filter(f => !folderIds.has(f.id))];
        const known = new Set(nextFolders.map(f => f?.id));
        const current = connections();
        const ids = new Set(current.map(c => c.id));
        let next = mode === 'replace' ? converted : [...current, ...converted.filter(c => !ids.has(c.id))];
        next = next.map(c => (c.folder != null && !known.has(c.folder) ? (({ folder, ...rest }) => rest)(c) : c));
        ctx.config.update({ mongoFolders: nextFolders, mongoConnections: next }); // valida tutte le connessioni
        closeClients();
        res.json({ ok: true, imported: mode === 'replace' ? converted.length : next.length - current.length, skipped: mode === 'replace' ? 0 : converted.filter(c => ids.has(c.id)).length });
      },

      async databases(req, res) { res.json({ databases: await listDatabases(connOr404(req.params.id)) }); },

      async collections(req, res) { res.json({ collections: await listCollections(connOr404(req.params.id), req.params.db) }); },

      async find(req, res) {
        res.json(await findDocuments(connOr404(req.params.id), req.params.db, req.params.coll, req.body || {}));
      },

      async count(req, res) {
        const col = await collection(connOr404(req.params.id), req.params.db, req.params.coll);
        const filter = ejsonCall(() => parse(req.body?.filter, 'filter'));
        res.json({ count: await run(() => col.countDocuments(filter, { maxTimeMS: QUERY_TIMEOUT_MS })) });
      },

      async indexes(req, res) {
        const col = await collection(connOr404(req.params.id), req.params.db, req.params.coll);
        const list = await run(() => col.indexes());
        res.json({ indexes: list.map(toJson) });
      },

      async structure(req, res) { res.json(await structure(connOr404(req.params.id), req.params.db, req.params.coll)); },

      // Export: { format, database, collection, filter, sort, projection } oppure
      // { format, database, code } con un find o un aggregate dell'editor
      async exportDocuments(req, res) {
        const c = connOr404(req.params.id);
        const body = req.body || {};
        if (!EXPORT_FORMATS[body.format || 'json']) throw ctx.error(400, 'export_format');
        const stmt = body.code ? parseStatement(body.code, body.database) : null;
        if (stmt && (stmt.type !== 'collection' || !['find', 'aggregate'].includes(stmt.method) || !stmt.read)) throw ctx.error(400, 'export_not_cursor');
        const client = await clientFor(c);
        let cursor, name, coll;
        if (stmt) {
          cursor = shellCall(() => runner.exportCursor(client, stmt));
          name = coll = stmt.collection;
        } else {
          const db = dbName(body.database);
          coll = collName(body.collection);
          const filter = ejsonCall(() => parse(body.filter, 'filter'));
          const sort = ejsonCall(() => parse(body.sort, 'sort'));
          const projection = ejsonCall(() => parse(body.projection, 'projection'));
          cursor = client.db(db).collection(coll).find(filter, { sort, projection, limit: MAX_EXPORT, maxTimeMS: 300000 });
          name = coll;
        }
        await streamExport(res, cursor, body.format || 'json', name, coll);
      },

      // Editor: { code, database, limit } → risultato di una lettura; una modifica risponde 428
      // con l'istruzione e il token, e parte con { …, token } (connessioni in sola lettura: 403)
      async shell(req, res) {
        const c = connOr404(req.params.id);
        const body = req.body || {};
        const stmt = parseStatement(body.code, body.database);
        const limit = RESULT_LIMITS.includes(Number(body.limit)) ? Number(body.limit) : RESULT_LIMITS[1];
        if (stmt.type === 'use') return res.json({ kind: 'use', database: stmt.database, ms: 0 });
        const meta = { read: stmt.read, database: stmt.database ?? null, collection: stmt.collection ?? null, method: stmt.method ?? stmt.type };
        let token = null;
        if (!stmt.read) {
          if (c.readOnly) throw ctx.error(403, 'read_only');
          token = tokenOf(c.id, { code: body.code.trim(), database: body.database || null });
          if (body.token) checkToken(body.token, token);
        }
        const client = await clientFor(c);
        if (!stmt.read && !body.token) {
          const matches = await runner.matches(client, stmt);
          return res.status(428).json({ needsConfirmation: true, preview: body.code.trim(), token, dangerous: !!stmt.dangerous, matches, ...meta });
        }
        const r = await runShell(() => runner.run(client, stmt, { limit }));
        res.json({ ...r, ...meta });
      },

      // { op } → anteprima e token; { op, token } → esecuzione se il token corrisponde
      async operation(req, res) {
        const c = connOr404(req.params.id);
        if (c.readOnly) throw ctx.error(403, 'read_only');
        const p = plan(c, req.body?.op);
        if (!req.body?.token) return res.json({ preview: p.preview, count: p.count, dangerous: p.dangerous, token: p.token, op: p.op });
        checkToken(req.body.token, p.token);
        res.json({ ok: true, ...(await execute(c, p.op)) });
      },
    }),

    // Strumenti MCP: solo letture e solo con il vault sbloccato dall'interfaccia
    mcp: {
      connections() {
        if (vault.state() !== 'unlocked') throw ctx.error(423, 'mcp_vault_locked');
        return {
          connections: connections().map(c => ({
            id: c.id, label: c.label, host: c.uri ? new URL(c.uri).host : c.tunnel ? null : c.host, port: c.uri || c.tunnel ? null : c.port,
            tunnel: c.tunnel || null, database: c.database || null, readOnly: !!c.readOnly,
          })),
        };
      },
      async databases({ connection }) { return { databases: (await listDatabases(mcpConnection(connection))).map(d => d.name) }; },
      async collections({ connection, database }) { return { database, collections: await listCollections(mcpConnection(connection), database) }; },
      async find({ connection, database, collection: coll, filter, sort, projection, limit = 20 }) {
        const r = await findDocuments(mcpConnection(connection), database, coll, { filter, sort, projection, limit, count: false }, { maxLimit: 100 });
        return { database, collection: coll, documents: r.documents, truncated: r.hasMore };
      },
      async count({ connection, database, collection: coll, filter }) {
        const col = await collection(mcpConnection(connection), database, coll);
        const f = ejsonCall(() => parse(filter, 'filter'));
        return { database, collection: coll, count: await run(() => col.countDocuments(f, { maxTimeMS: QUERY_TIMEOUT_MS })) };
      },
      // pipeline di sola lettura: $out e $merge (che scrivono) rifiutati
      async aggregate({ connection, database, collection: coll, pipeline, limit = 20 }) {
        const c = mcpConnection(connection);
        const stages = ejsonCall(() => parse(pipeline, 'pipeline', { object: false }));
        if (!Array.isArray(stages) || stages.some(s => !s || typeof s !== 'object' || Array.isArray(s))) throw ctx.error(400, 'pipeline_invalid');
        if (stages.some(s => Object.keys(s).some(k => k === '$out' || k === '$merge'))) throw ctx.error(400, 'mcp_read_only');
        const col = await collection(c, database, coll);
        const max = Math.min(Math.max(parseInt(limit) || 20, 1), 100);
        const docs = await run(() => col.aggregate([...stages, { $limit: max + 1 }], { maxTimeMS: QUERY_TIMEOUT_MS }).toArray());
        return { database, collection: coll, documents: docs.slice(0, max).map(toJson), truncated: docs.length > max };
      },
    },

    shutdown() { closeClients(); },
  };
};
