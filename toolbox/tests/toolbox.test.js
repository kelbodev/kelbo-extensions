// Coltellino: funzioni del pannello (vettori noti di MD5, SHA, HMAC; codifiche avanti e indietro;
// JWT firmati e verificati con HS, RS256, ES256; UUID v7; timestamp) e accesso ai token in memoria
// dell'HTTP client (elenco senza valori, valore solo con il vault sbloccato)
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { pathToFileURL } = require('url');
const { startServer, i18nProblems } = require('kelbo/testkit');

const EXT = path.join(__dirname, '..');
const load = () => import(pathToFileURL(path.join(EXT, 'view.js')).href);
let srv;
before(async () => { srv = await startServer({ projects: [] }, { install: [EXT] }); });
after(() => srv?.stop());

test('traduzioni', () => assert.deepEqual(i18nProblems(EXT), []));

test('hash: vettori noti di MD5, SHA e HMAC', async () => {
  const c = await load();
  const hex = async (a, s, k) => c.toHex(await c.digest(a, c.toBytes(s), k ? c.toBytes(k) : null));
  const fox = 'The quick brown fox jumps over the lazy dog';
  assert.equal(await hex('md5', ''), 'd41d8cd98f00b204e9800998ecf8427e');
  assert.equal(await hex('md5', fox), '9e107d9d372bb6826bd81d3542a419d6');
  assert.equal(await hex('md5', 'a'.repeat(1000)), 'cabe45dcc9ae5b66ba86600cca6b8ba8');
  assert.equal(await hex('sha1', 'abc'), 'a9993e364706816aba3e25717850c26c9cd0d89d');
  assert.equal(await hex('sha256', 'abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  assert.equal(await hex('sha256', fox, 'key'), 'f7bc83f430538424b13298e6aa6fb143ef4d59a14946175997479dbc2d1a3cd8');
  assert.equal(await c.digest('md5', c.toBytes('x'), c.toBytes('k')), null);
});

test('codifiche avanti e indietro, testo non valido rifiutato', async () => {
  const c = await load();
  const s = 'Ciao è 😀 <a&b> "x"\n';
  for (const [k, codec] of Object.entries(c.CODECS)) assert.equal(codec.decode(codec.encode(s)), s, k);
  assert.equal(c.CODECS.base64.encode('è'), 'w6g=');
  assert.equal(c.CODECS.url.decode('a+b%20c'), 'a b c');
  assert.equal(c.CODECS.html.decode('&#x1F600;&#233;&nbsp;&unknown;'), '😀é &unknown;');
  assert.equal(c.CODECS.unicode.decode('\\u{1F600}\\u00e8'), '😀è');
  for (const [k, bad] of [['base64', '***'], ['hex', 'zz'], ['base64url', 'a+b'], ['json', '"x" 1']]) assert.throws(() => c.CODECS[k].decode(bad), Error, k);
});

test('JWT: decodifica, scadenza, firma e verifica HS256, RS256, ES256', async () => {
  const c = await load();
  const tok = await c.signJwt({ alg: 'HS384' }, { sub: '42', exp: Math.floor(Date.now() / 1000) - 10 }, 's3cret');
  const d = c.decodeJwt(`Bearer ${tok}`);
  assert.deepEqual([d.header.alg, d.header.typ, d.payload.sub, d.expired], ['HS384', 'JWT', '42', true]);
  assert.equal(await c.verifyJwt(tok, 's3cret'), true);
  assert.equal(await c.verifyJwt(tok, 'wrong'), false);
  assert.throws(() => c.decodeJwt('abc'), /jwt_parts/);
  assert.throws(() => c.decodeJwt('a.b.c'), /jwt_json/);
  // RS256 ed ES256 con chiavi generate qui: firma con la privata, verifica con la pubblica in PEM e JWK
  const { subtle } = globalThis.crypto;
  for (const [alg, gen, sign] of [
    ['RS256', { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, { name: 'RSASSA-PKCS1-v1_5' }],
    ['ES256', { name: 'ECDSA', namedCurve: 'P-256' }, { name: 'ECDSA', hash: 'SHA-256' }],
  ]) {
    const kp = await subtle.generateKey(gen, true, ['sign', 'verify']);
    const input = `${c.b64urlEncodeBytes(c.toBytes(JSON.stringify({ alg, typ: 'JWT' })))}.${c.b64urlEncodeBytes(c.toBytes(JSON.stringify({ sub: 'x' })))}`;
    const sig = c.b64urlEncodeBytes(new Uint8Array(await subtle.sign(sign, kp.privateKey, c.toBytes(input))));
    const spki = c.bytesToBase64(new Uint8Array(await subtle.exportKey('spki', kp.publicKey)));
    const pem = `-----BEGIN PUBLIC KEY-----\n${spki.match(/.{1,64}/g).join('\n')}\n-----END PUBLIC KEY-----`;
    assert.equal(await c.verifyJwt(`${input}.${sig}`, pem), true, alg);
    assert.equal(await c.verifyJwt(`${input}.${sig}`, JSON.stringify(await subtle.exportKey('jwk', kp.publicKey))), true, `${alg} jwk`);
    assert.equal(await c.verifyJwt(`${input}.${sig.slice(0, -4)}AAAA`, pem), false, `${alg} alterato`);
  }
  await assert.rejects(c.verifyJwt(`${c.b64urlEncodeBytes(c.toBytes('{"alg":"RS256"}'))}.e30.x`, 'nope'), /jwt_key/);
  await assert.rejects(c.signJwt({ alg: 'RS256' }, {}, 'k'), /jwt_sign_alg/);
});

test('generatori: UUID v4 e v7, stringhe casuali, timestamp', async () => {
  const c = await load();
  assert.match(c.uuid4(), /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  const u = c.uuid7(Date.UTC(2026, 0, 1));
  assert.match(u, /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(parseInt(u.replace(/-/g, '').slice(0, 12), 16), Date.UTC(2026, 0, 1));
  assert.ok(c.uuid7(1000) < c.uuid7(2000));
  assert.match(c.randomString(64, 'hex'), /^[0-9a-f]{64}$/);
  assert.equal(c.randomString(10).length, 10);
  assert.equal(c.parseTime('1731500000'), 1731500000000);
  assert.equal(c.parseTime('1731500000123'), 1731500000123);
  assert.equal(c.parseTime('2026-01-01T00:00:00Z'), Date.UTC(2026, 0, 1));
  assert.equal(c.parseTime('domani'), null);
});

test('token dell\'HTTP client: elenco senza valori, valore solo con il vault sbloccato', async () => {
  const api = (m, p, body) => srv.request(m, p, body !== undefined ? { body } : {});
  assert.deepEqual((await api('GET', '/api/ext/toolbox/http-tokens')).json, { available: true, tokens: [] });
  await api('POST', '/api/core/vault/init', { password: 'master-password-tb' });
  const s = (await api('POST', '/api/ext/http-client/sections', { label: 'API' })).json;
  const u = (await api('POST', `/api/ext/http-client/sections/${s.id}/users`, { label: 'Admin', auth: { type: 'manual' } })).json;
  let r = await api('GET', '/api/ext/toolbox/http-tokens');
  assert.deepEqual(r.json.tokens.map(x => [x.sectionLabel, x.userLabel, x.hasToken]), [['API', 'Admin', false]]);
  assert.equal((await api('GET', `/api/ext/toolbox/http-tokens/${s.id}/${u.id}`)).json.code, 'toolbox.token_not_found');
  const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2ln';
  await api('POST', `/api/ext/http-client/sections/${s.id}/users/${u.id}/token`, { token: jwt });
  r = await api('GET', '/api/ext/toolbox/http-tokens');
  assert.equal(r.json.tokens[0].hasToken, true);
  assert.ok(!JSON.stringify(r.json).includes(jwt), 'l\'elenco non contiene il token');
  r = await api('GET', `/api/ext/toolbox/http-tokens/${s.id}/${u.id}`);
  assert.deepEqual([r.json.token, r.json.section, r.json.user, r.json.source], [jwt, 'API', 'Admin', 'manual']);
  await api('POST', '/api/core/vault/lock', {});
  r = await api('GET', `/api/ext/toolbox/http-tokens/${s.id}/${u.id}`);
  assert.equal(r.status, 423);
  assert.equal((await api('GET', '/api/ext/toolbox/http-tokens/..%2Fx/y')).status, 400);
});
