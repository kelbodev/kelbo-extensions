// Coltellino: JWT (decodifica, verifica della firma, creazione HS*), anche dai token in memoria
// delle utenze dell'HTTP client; codifica e decodifica (Base64, Base64URL, URL, HTML, esadecimale,
// Unicode, stringa JSON); hash (MD5, SHA-1/256/384/512, HMAC) di testo o file; generatori (UUID
// v4/v7, stringhe casuali, timestamp ↔ data). Tutti i calcoli restano nel browser.
//
// La prima parte (senza DOM) è esportata anche per i test.

const enc = new TextEncoder();
const dec = new TextDecoder('utf-8', { fatal: true });

// ---- byte ↔ testo ----
const toBytes = s => enc.encode(s);
const fromBytes = b => dec.decode(b);
function bytesToBase64(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}
function base64ToBytes(b64) {
  const clean = String(b64).replace(/\s+/g, '');
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(clean) || clean.length % 4 === 1) throw new Error('base64');
  const bin = atob(clean.padEnd(Math.ceil(clean.length / 4) * 4, '='));
  return Uint8Array.from(bin, c => c.charCodeAt(0));
}
const b64urlEncodeBytes = bytes => bytesToBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
function b64urlDecodeBytes(s) {
  const clean = String(s).trim();
  if (!/^[A-Za-z0-9_-]*$/.test(clean)) throw new Error('base64url');
  return base64ToBytes(clean.replace(/-/g, '+').replace(/_/g, '/'));
}
const toHex = bytes => [...bytes].map(b => b.toString(16).padStart(2, '0')).join('');
function fromHex(h) {
  const clean = String(h).replace(/[\s:]/g, '').replace(/^0x/i, '');
  if (!/^([0-9a-fA-F]{2})*$/.test(clean)) throw new Error('hex');
  return Uint8Array.from(clean.match(/../g) || [], x => parseInt(x, 16));
}

// ---- codifiche: { encode(testo), decode(testo) } ----
const HTML_ENT = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const NAMED_ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', copy: '©', reg: '®', euro: '€', hellip: '…' };
const CODECS = {
  base64: { encode: s => bytesToBase64(toBytes(s)), decode: s => fromBytes(base64ToBytes(s)) },
  base64url: { encode: s => b64urlEncodeBytes(toBytes(s)), decode: s => fromBytes(b64urlDecodeBytes(s)) },
  url: { encode: s => encodeURIComponent(s), decode: s => decodeURIComponent(s.replace(/\+/g, ' ')) },
  html: {
    encode: s => s.replace(/[&<>"']/g, c => HTML_ENT[c]),
    decode: s => s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => (e[0] === '#'
      ? String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10))
      : NAMED_ENT[e.toLowerCase()] ?? m)),
  },
  hex: { encode: s => toHex(toBytes(s)), decode: s => fromBytes(fromHex(s)) },
  unicode: {
    encode: s => [...s].map(ch => { const cp = ch.codePointAt(0); return cp < 128 ? ch : cp > 0xffff ? ch.split('').map(u => `\\u${u.charCodeAt(0).toString(16).padStart(4, '0')}`).join('') : `\\u${cp.toString(16).padStart(4, '0')}`; }).join(''),
    decode: s => s.replace(/\\u\{([0-9a-fA-F]+)\}|\\u([0-9a-fA-F]{4})/g, (m, a, b) => String.fromCodePoint(parseInt(a || b, 16))),
  },
  json: {
    encode: s => JSON.stringify(s),
    decode: s => { const v = JSON.parse(s.trim().startsWith('"') ? s : `"${s}"`); if (typeof v !== 'string') throw new Error('json'); return v; },
  },
};

// ---- MD5 (WebCrypto non lo ha) ----
function md5(bytes) {
  const K = new Uint32Array(64), S = [7, 12, 17, 22, 5, 9, 14, 20, 4, 11, 16, 23, 6, 10, 15, 21];
  for (let i = 0; i < 64; i++) K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 2 ** 32) >>> 0;
  const len = bytes.length, total = (((len + 8) >>> 6) + 1) << 6;
  const buf = new Uint8Array(total);
  buf.set(bytes); buf[len] = 0x80;
  const view = new DataView(buf.buffer);
  view.setUint32(total - 8, (len * 8) >>> 0, true);
  view.setUint32(total - 4, Math.floor(len / 0x20000000), true);
  let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;
  const rotl = (x, c) => (x << c) | (x >>> (32 - c));
  for (let off = 0; off < total; off += 64) {
    let A = a0, B = b0, C = c0, D = d0;
    for (let i = 0; i < 64; i++) {
      let F, g;
      if (i < 16) { F = (B & C) | (~B & D); g = i; }
      else if (i < 32) { F = (D & B) | (~D & C); g = (5 * i + 1) % 16; }
      else if (i < 48) { F = B ^ C ^ D; g = (3 * i + 5) % 16; }
      else { F = C ^ (B | ~D); g = (7 * i) % 16; }
      F = (F + A + K[i] + view.getUint32(off + g * 4, true)) | 0;
      A = D; D = C; C = B;
      B = (B + rotl(F, S[(i >> 4) * 4 + (i % 4)])) | 0;
    }
    a0 = (a0 + A) | 0; b0 = (b0 + B) | 0; c0 = (c0 + C) | 0; d0 = (d0 + D) | 0;
  }
  const out = new Uint8Array(16);
  const ov = new DataView(out.buffer);
  [a0, b0, c0, d0].forEach((v, i) => ov.setUint32(i * 4, v >>> 0, true));
  return out;
}

const SHA = { sha1: 'SHA-1', sha256: 'SHA-256', sha384: 'SHA-384', sha512: 'SHA-512' };
const subtle = () => globalThis.crypto?.subtle;
// hash dei byte: md5 qui, gli SHA con WebCrypto; con key, HMAC (SHA)
async function digest(algo, bytes, key = null) {
  if (algo === 'md5') return key ? null : md5(bytes);
  const name = SHA[algo];
  if (!key) return new Uint8Array(await subtle().digest(name, bytes));
  const k = await subtle().importKey('raw', key, { name: 'HMAC', hash: name }, false, ['sign']);
  return new Uint8Array(await subtle().sign('HMAC', k, bytes));
}

// ---- JWT ----
// header.payload.firma → { header, payload, signature, times: { exp, iat, nbf }, expired, notYet }
function decodeJwt(token) {
  const parts = String(token).trim().replace(/^Bearer\s+/i, '').split('.');
  if (parts.length !== 3 && parts.length !== 2) throw new Error('jwt_parts');
  const json = p => { try { return JSON.parse(fromBytes(b64urlDecodeBytes(p))); } catch { throw new Error('jwt_json'); } };
  const header = json(parts[0]);
  const payload = json(parts[1]);
  const at = v => (typeof v === 'number' ? new Date(v * 1000).toISOString() : null);
  const now = Date.now() / 1000;
  return {
    header, payload, signature: parts[2] || '', signingInput: `${parts[0]}.${parts[1]}`,
    times: { exp: at(payload.exp), iat: at(payload.iat), nbf: at(payload.nbf) },
    expired: typeof payload.exp === 'number' && payload.exp < now,
    notYet: typeof payload.nbf === 'number' && payload.nbf > now,
  };
}

// algoritmo JWT → parametri di WebCrypto
function jwtAlgorithm(alg) {
  const bits = /^(HS|RS|PS|ES)(256|384|512)$/.exec(alg || '');
  if (!bits) throw new Error('jwt_alg');
  const hash = `SHA-${bits[2]}`;
  if (bits[1] === 'HS') return { kind: 'hmac', import: { name: 'HMAC', hash }, verify: { name: 'HMAC' } };
  if (bits[1] === 'RS') return { kind: 'rsa', import: { name: 'RSASSA-PKCS1-v1_5', hash }, verify: { name: 'RSASSA-PKCS1-v1_5' } };
  if (bits[1] === 'PS') return { kind: 'rsa', import: { name: 'RSA-PSS', hash }, verify: { name: 'RSA-PSS', saltLength: Number(bits[2]) / 8 } };
  const curve = { 256: 'P-256', 384: 'P-384', 512: 'P-521' }[bits[2]];
  return { kind: 'ec', import: { name: 'ECDSA', namedCurve: curve }, verify: { name: 'ECDSA', hash } };
}
// chiave pubblica in PEM (SPKI) o JWK
async function importPublicKey(text, algo) {
  const t = String(text).trim();
  if (t.startsWith('{')) return subtle().importKey('jwk', JSON.parse(t), algo.import, false, ['verify']);
  const m = /-----BEGIN PUBLIC KEY-----([\s\S]+?)-----END PUBLIC KEY-----/.exec(t);
  if (!m) throw new Error('jwt_key');
  return subtle().importKey('spki', base64ToBytes(m[1]), algo.import, false, ['verify']);
}
// true / false; key: il segreto (HS*) o la chiave pubblica (RS*, PS*, ES*)
async function verifyJwt(token, key) {
  const d = decodeJwt(token);
  const algo = jwtAlgorithm(d.header.alg);
  const k = algo.kind === 'hmac'
    ? await subtle().importKey('raw', toBytes(key), algo.import, false, ['verify'])
    : await importPublicKey(key, algo);
  return subtle().verify(algo.verify, k, b64urlDecodeBytes(d.signature), toBytes(d.signingInput));
}
// token HS256/384/512 da header e payload (oggetti) e segreto
async function signJwt(header, payload, secret) {
  const algo = jwtAlgorithm(header.alg || 'HS256');
  if (algo.kind !== 'hmac') throw new Error('jwt_sign_alg');
  const input = `${b64urlEncodeBytes(toBytes(JSON.stringify({ typ: 'JWT', ...header })))}.${b64urlEncodeBytes(toBytes(JSON.stringify(payload)))}`;
  const k = await subtle().importKey('raw', toBytes(secret), algo.import, false, ['sign']);
  return `${input}.${b64urlEncodeBytes(new Uint8Array(await subtle().sign('HMAC', k, toBytes(input))))}`;
}

// ---- generatori ----
const uuid4 = () => globalThis.crypto.randomUUID();
// UUID v7: millisecondi Unix nei primi 48 bit, poi casuale (ordinabile per tempo)
function uuid7(now = Date.now()) {
  const b = globalThis.crypto.getRandomValues(new Uint8Array(16));
  const ms = BigInt(now);
  for (let i = 0; i < 6; i++) b[i] = Number((ms >> BigInt(8 * (5 - i))) & 0xffn);
  b[6] = (b[6] & 0x0f) | 0x70;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = toHex(b);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
const CHARSETS = { alnum: 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789', hex: '0123456789abcdef', symbols: 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!#$%&*+-=?@^_~' };
// casuale senza distorsione (scarta i valori oltre il multiplo più grande della lunghezza)
function randomString(length, charset = 'alnum') {
  const chars = CHARSETS[charset] || CHARSETS.alnum;
  const limit = 256 - (256 % chars.length);
  let out = '';
  while (out.length < length) {
    for (const v of globalThis.crypto.getRandomValues(new Uint8Array(length * 2))) {
      if (v < limit) out += chars[v % chars.length];
      if (out.length >= length) break;
    }
  }
  return out;
}
// "1731500000" (s), "1731500000000" (ms), data ISO o testo di data → millisecondi, o null
function parseTime(text) {
  const t = String(text).trim();
  if (!t) return null;
  if (/^-?\d+(\.\d+)?$/.test(t)) { const n = Number(t); return Math.abs(n) < 1e11 ? Math.round(n * 1000) : Math.round(n); }
  const ms = Date.parse(t);
  return Number.isFinite(ms) ? ms : null;
}

// ---- JSON: formattazione, compressione, chiavi ordinate, errori con riga e colonna ----
// Errore di JSON.parse con la posizione (V8: "at position N" o "(line L column C)")
// Posizione del primo errore di sintassi (scansione JSON completa): indice nel testo, o -1
function jsonErrorAt(text) {
  let i = 0;
  const ws = () => { while (i < text.length && ' \t\n\r'.includes(text[i])) i++; };
  const fail = () => { throw i; };
  const lit = w => { if (text.startsWith(w, i)) i += w.length; else fail(); };
  const str = () => {
    i++;
    while (i < text.length) {
      const c = text[i];
      if (c === '"') { i++; return; }
      if (c === '\\') { const n = text[i + 1]; if ('"\\/bfnrt'.includes(n)) i += 2; else if (n === 'u' && /^[0-9a-fA-F]{4}$/.test(text.slice(i + 2, i + 6))) i += 6; else { i++; fail(); } continue; }
      if (c < ' ') fail();
      i++;
    }
    fail();
  };
  const num = () => { const m = /^-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?/.exec(text.slice(i)); if (!m || !m[0] || m[0] === '-') fail(); i += m[0].length; };
  const value = () => {
    ws();
    const c = text[i];
    if (c === '{') {
      i++; ws();
      if (text[i] === '}') { i++; return; }
      for (;;) { ws(); if (text[i] !== '"') fail(); str(); ws(); if (text[i] !== ':') fail(); i++; value(); ws(); if (text[i] === ',') { i++; continue; } if (text[i] === '}') { i++; return; } fail(); }
    }
    if (c === '[') {
      i++; ws();
      if (text[i] === ']') { i++; return; }
      for (;;) { value(); ws(); if (text[i] === ',') { i++; continue; } if (text[i] === ']') { i++; return; } fail(); }
    }
    if (c === '"') return str();
    if (c === 't') return lit('true');
    if (c === 'f') return lit('false');
    if (c === 'n') return lit('null');
    return num();
  };
  try { value(); ws(); if (i < text.length) fail(); return -1; } catch (pos) { return typeof pos === 'number' ? pos : -1; }
}
function jsonError(e, text) {
  const msg = String(e.message || e);
  const at = jsonErrorAt(text);
  let line = null, col = null;
  if (at >= 0) { const before = text.slice(0, at).split('\n'); line = before.length; col = before.at(-1).length + 1; }
  // il messaggio del motore, senza ripetere tutto il testo
  return { message: msg.replace(/^JSON\.parse: /, '').replace(/, (\.\.\.)?".*" is not valid JSON$/s, '').replace(/ in JSON at position \d+.*$/s, '').replace(/ at position \d+.*$/s, '').replace(/ \(line \d+ column \d+\)$/, ''), line, col, at };
}
function sortKeys(v) {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().map(k => [k, sortKeys(v[k])]));
  return v;
}
// → { ok: true, value, text } | { ok: false, error: { message, line, col } }
function jsonFormat(text, { indent = 2, sort = false, minify = false } = {}) {
  let value;
  try { value = JSON.parse(text); } catch (e) { return { ok: false, error: jsonError(e, text) }; }
  if (sort) value = sortKeys(value);
  const ind = indent === 'tab' ? '\t' : Number(indent) || 2;
  return { ok: true, value, text: minify ? JSON.stringify(value) : JSON.stringify(value, null, ind) };
}

// ---- diff: Myers (righe e caratteri), JSON per percorsi ----
// Sequenze a e b (con chiave di confronto) → [{ op: '=' | '-' | '+', a?, b? }] (indici)
function myers(a, b, key = x => x) {
  const ka = a.map(key), kb = b.map(key);
  const n = ka.length, m = kb.length, max = n + m;
  const v = new Map([[1, 0]]);
  const trace = [];
  outer: for (let d = 0; d <= max; d++) {
    trace.push(new Map(v));
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && (v.get(k - 1) ?? -1) < (v.get(k + 1) ?? -1)) ? (v.get(k + 1) ?? 0) : (v.get(k - 1) ?? 0) + 1;
      let y = x - k;
      while (x < n && y < m && ka[x] === kb[y]) { x++; y++; }
      v.set(k, x);
      if (x >= n && y >= m) break outer;
    }
  }
  // percorso all'indietro
  const ops = [];
  let x = n, y = m;
  for (let d = trace.length - 1; d >= 0 && (x > 0 || y > 0); d--) {
    const vv = trace[d], k = x - y;
    const prevK = k === -d || (k !== d && (vv.get(k - 1) ?? -1) < (vv.get(k + 1) ?? -1)) ? k + 1 : k - 1;
    const prevX = vv.get(prevK) ?? 0, prevY = prevX - prevK;
    while (x > prevX && y > prevY) { x--; y--; ops.push({ op: '=', a: x, b: y }); }
    if (d > 0) { if (x === prevX) { y--; ops.push({ op: '+', b: y }); } else { x--; ops.push({ op: '-', a: x }); } }
  }
  return ops.reverse();
}
// Differenze tra due testi per riga: { rows: [{ type: 'eq'|'rem'|'ins'|'mod', left, right, ln, rn, chars? }], added, removed }
// mod: una riga tolta e una aggiunta nello stesso punto, con le parti cambiate dentro la riga
const MAX_DIFF_LINES = 20000;
function diffText(left, right, { ignoreWhitespace = false, ignoreCase = false } = {}) {
  const la = String(left).split(/\r?\n/), lb = String(right).split(/\r?\n/);
  if (la.length + lb.length > MAX_DIFF_LINES * 2) throw new Error('diff_too_large');
  const key = l => { let s = l; if (ignoreWhitespace) s = s.replace(/\s+/g, ' ').trim(); if (ignoreCase) s = s.toLowerCase(); return s; };
  const ops = myers(la, lb, key);
  const rows = [];
  let added = 0, removed = 0;
  for (let i = 0; i < ops.length;) {
    if (ops[i].op === '=') { rows.push({ type: 'eq', left: la[ops[i].a], right: lb[ops[i].b], ln: ops[i].a + 1, rn: ops[i].b + 1 }); i++; continue; }
    // blocco di cambiamenti: tolte e aggiunte accoppiate riga per riga
    const dels = [], ins = [];
    while (i < ops.length && ops[i].op !== '=') { (ops[i].op === '-' ? dels : ins).push(ops[i]); i++; }
    removed += dels.length; added += ins.length;
    for (let j = 0; j < Math.max(dels.length, ins.length); j++) {
      const dl = dels[j], il = ins[j];
      if (dl && il) rows.push({ type: 'mod', left: la[dl.a], right: lb[il.b], ln: dl.a + 1, rn: il.b + 1, chars: diffChars(la[dl.a], lb[il.b]) });
      else if (dl) rows.push({ type: 'rem', left: la[dl.a], ln: dl.a + 1 });
      else rows.push({ type: 'ins', right: lb[il.b], rn: il.b + 1 });
    }
  }
  return { rows, added, removed, same: !added && !removed };
}
// Parti cambiate dentro una riga: [{ op, text }] per i due lati
function diffChars(a, b) {
  if (a.length + b.length > 4000) return { left: [{ op: '-', text: a }], right: [{ op: '+', text: b }] };
  // per parole e spazi: più leggibile dei singoli caratteri
  const tok = s => s.match(/\w+|\s+|[^\w\s]/g) || [];
  const ta = tok(a), tb = tok(b);
  const ops = myers(ta, tb);
  const left = [], right = [];
  const push = (arr, op, text) => { const last = arr.at(-1); if (last && last.op === op) last.text += text; else arr.push({ op, text }); };
  for (const o of ops) {
    if (o.op === '=') { push(left, '=', ta[o.a]); push(right, '=', tb[o.b]); }
    else if (o.op === '-') push(left, '-', ta[o.a]);
    else push(right, '+', tb[o.b]);
  }
  return { left, right };
}
// Differenze tra due valori JSON per percorso ($.a.b[2]): [{ path, kind: 'added'|'removed'|'changed', before, after }]
function diffJson(a, b, path = '$', out = []) {
  const isObj = v => v && typeof v === 'object' && !Array.isArray(v);
  const key = k => (/^[A-Za-z_$][\w$]*$/.test(k) ? `.${k}` : `[${JSON.stringify(k)}]`);
  if (Array.isArray(a) && Array.isArray(b)) {
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      if (i >= a.length) out.push({ path: `${path}[${i}]`, kind: 'added', after: b[i] });
      else if (i >= b.length) out.push({ path: `${path}[${i}]`, kind: 'removed', before: a[i] });
      else diffJson(a[i], b[i], `${path}[${i}]`, out);
    }
  } else if (isObj(a) && isObj(b)) {
    for (const k of [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()) {
      if (!(k in b)) out.push({ path: path + key(k), kind: 'removed', before: a[k] });
      else if (!(k in a)) out.push({ path: path + key(k), kind: 'added', after: b[k] });
      else diffJson(a[k], b[k], path + key(k), out);
    }
  } else if (JSON.stringify(a) !== JSON.stringify(b)) out.push({ path, kind: 'changed', before: a, after: b });
  return out;
}

export {
  toBytes, fromBytes, bytesToBase64, base64ToBytes, b64urlEncodeBytes, b64urlDecodeBytes, toHex, fromHex, CODECS,
  md5, digest, decodeJwt, verifyJwt, signJwt, jwtAlgorithm, uuid4, uuid7, randomString, parseTime,
  jsonFormat, jsonError, jsonErrorAt, sortKeys, myers, diffText, diffChars, diffJson,
};

// ---- pannello ----
const TABS = ['jwt', 'json', 'diff', 'codec', 'hash', 'generate'];
const HASHES = ['md5', 'sha1', 'sha256', 'sha384', 'sha512'];
const TAB_KEY = 'kelbo.toolbox.tab';
const JSON_KEY = 'kelbo.toolbox.json'; // ultimo JSON della scheda JSON: resta ricaricando, lo leggono gli add-on
const JSON_KEEP_MAX = 512 * 1024;

export default {
  async mount(ctx) {
    const { esc, js, toast, fmt } = ctx.ui;
    const { t } = ctx;
    const $ = role => ctx.root.querySelector(`[data-role="${role}"]`);
    const store = { get: (k, d) => { try { return localStorage.getItem(k) ?? d; } catch { return d; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* solo per questa sessione */ } } };

    const TREE_MAX = 2 * 1024 * 1024;
    ctx.bus.on('toolbox:json', d => d?.reply?.(state.jsonIn)); // l'add-on (es. nel Mock) chiede il JSON di adesso // oltre: testo colorato, senza albero
    ctx.ui.json.bind(ctx.root); // ▾, Alt+clic, Espandi/Comprimi, editor colorati
    let tab = TABS.includes(store.get(TAB_KEY)) ? store.get(TAB_KEY) : 'jwt';
    let httpTokens = null; // { available, tokens }
    const state = {
      jwt: '', jwtKey: '', jwtVerify: null, jwtSource: null,
      codec: 'base64', direction: 'encode', codecIn: '',
      hashIn: '', hashKey: '', hashFormat: 'hex', hashFile: null, hashes: {},
      uuidVersion: '4', uuidCount: 5, uuids: [], randLength: 32, randCharset: 'alnum', rand: '', timeIn: '',
      jsonIn: store.get(JSON_KEY, ''), jsonIndent: '2', jsonSort: false, jsonAction: 'format', jsonView: 'text',
      diffLeft: '', diffRight: '', diffMode: 'text', diffView: 'split', diffWs: false, diffCase: false, diffAll: false,
    };

    async function copy(text) {
      try { await navigator.clipboard.writeText(text); toast(t('copied'), 'success'); }
      catch { toast(t('copyFailed'), 'error'); }
    }
    const copyBtn = value => `<button class="btn btn-ghost btn-sm" onclick="Ext.toolbox.copy(${js(value)})" title="${esc(t('copy'))}">${ctx.ui.icon('copy')}</button>`;

    function renderTabs() {
      ctx.ui.patch($('tabs'), TABS.map(x => `<button class="tb-tab ${x === tab ? 'active' : ''}" onclick="Ext.toolbox.tab(${js(x)})">${ctx.ui.icon({ jwt: 'key-round', json: 'braces', diff: 'git-compare', codec: 'arrow-left-right', hash: 'hash', generate: 'sparkles' }[x])} ${esc(t(`tab.${x}`))}</button>`).join(''));
    }

    // ---- JWT ----
    const json = v => esc(JSON.stringify(v, null, 2));
    function jwtHtml() {
      let d = null, err = null;
      if (state.jwt.trim()) { try { d = decodeJwt(state.jwt); } catch (e) { err = t(`errors.${e.message}`); } }
      const tokens = httpTokens?.tokens?.filter(x => x.hasToken) || [];
      const timeRow = (k, iso) => (iso ? `<div class="tb-time"><span>${esc(k)}</span><code title="${esc(fmt.date(iso, { dateStyle: 'full', timeStyle: 'long' }))}">${esc(iso)}</code><span class="tb-muted">${esc(fmt.relative(iso))}</span></div>` : '');
      return `<div class="tb-grid">
        <div class="tb-col">
          <div class="tb-row-head"><label for="tb_jwt">${esc(t('jwt.token'))}</label>
            ${httpTokens?.available ? `<select class="form-input tb-http" onchange="Ext.toolbox.loadHttpToken(this.value);this.value=''">
              <option value="">${esc(t(tokens.length ? 'jwt.fromHttp' : 'jwt.noHttpTokens'))}</option>
              ${tokens.map(x => `<option value="${esc(`${x.section}/${x.user}`)}">${esc(`${x.sectionLabel} · ${x.userLabel}${x.expired ? ` (${t('jwt.expiredShort')})` : ''}`)}</option>`).join('')}</select>` : ''}</div>
          <textarea class="form-input tb-area tb-mono" id="tb_jwt" data-field="jwt" rows="7" spellcheck="false" placeholder="eyJhbGciOi…">${esc(state.jwt)}</textarea>
          ${state.jwtSource ? `<div class="tb-muted">${ctx.ui.icon('send')} ${esc(t('jwt.source', state.jwtSource))}</div>` : ''}
          ${err ? `<p class="tb-error">${esc(err)}</p>` : ''}
          ${d ? `<div class="tb-verify">
              <label for="tb_jwt_key">${esc(t(/^HS/.test(d.header.alg || '') ? 'jwt.secret' : 'jwt.publicKey'))}</label>
              <textarea class="form-input tb-mono" id="tb_jwt_key" data-field="jwtKey" rows="${/^HS/.test(d.header.alg || '') ? 1 : 4}" spellcheck="false"
                placeholder="${esc(/^HS/.test(d.header.alg || '') ? t('jwt.secretPlaceholder') : '-----BEGIN PUBLIC KEY-----')}">${esc(state.jwtKey)}</textarea>
              <button class="btn btn-ghost btn-sm" onclick="Ext.toolbox.verify()">${ctx.ui.icon('shield-check')} ${esc(t('jwt.verify'))}</button>
              ${state.jwtVerify === true ? `<span class="tb-ok">${ctx.ui.icon('check')} ${esc(t('jwt.valid'))}</span>` : state.jwtVerify === false ? `<span class="tb-bad">${ctx.ui.icon('x')} ${esc(t('jwt.invalid'))}</span>` : typeof state.jwtVerify === 'string' ? `<span class="tb-bad">${esc(state.jwtVerify)}</span>` : ''}
            </div>` : ''}
          <details class="tb-sign"><summary>${esc(t('jwt.signTitle'))}</summary>
            <div class="tb-sign-body">
              <label>${esc(t('jwt.payload'))}</label><textarea class="form-input tb-mono" id="tb_sign_payload" rows="5" spellcheck="false">{\n  "sub": "1234567890",\n  "iat": ${Math.floor(Date.now() / 1000)},\n  "exp": ${Math.floor(Date.now() / 1000) + 3600}\n}</textarea>
              <div class="tb-inline"><select class="form-input" id="tb_sign_alg"><option>HS256</option><option>HS384</option><option>HS512</option></select>
                <input class="form-input tb-mono" id="tb_sign_secret" placeholder="${esc(t('jwt.secret'))}" spellcheck="false">
                <button class="btn btn-ghost btn-sm" onclick="Ext.toolbox.sign()">${esc(t('jwt.sign'))}</button></div>
            </div></details>
        </div>
        <div class="tb-col">
          ${d ? `<div class="tb-claims">
              ${d.expired ? `<span class="tb-badge tb-bad">${esc(t('jwt.expired'))}</span>` : d.times.exp ? `<span class="tb-badge tb-ok">${esc(t('jwt.notExpired'))}</span>` : ''}
              ${d.notYet ? `<span class="tb-badge tb-bad">${esc(t('jwt.notYet'))}</span>` : ''}
              <span class="tb-badge">${esc(d.header.alg || '?')}</span></div>
            ${timeRow('exp', d.times.exp)}${timeRow('iat', d.times.iat)}${timeRow('nbf', d.times.nbf)}
            <div class="tb-row-head"><label>${esc(t('jwt.header'))}</label>${copyBtn(JSON.stringify(d.header, null, 2))}</div>
            <pre class="tb-pre">${json(d.header)}</pre>
            <div class="tb-row-head"><label>${esc(t('jwt.payload'))}</label>${copyBtn(JSON.stringify(d.payload, null, 2))}</div>
            <pre class="tb-pre">${json(d.payload)}</pre>` : `<p class="tb-muted">${esc(t('jwt.hint'))}</p>`}
        </div></div>`;
    }

    // ---- JSON ----
    // risultato dell'azione scelta: formattato, compresso, come stringa JSON, da stringa JSON
    function jsonResult() {
      const text = state.jsonIn;
      if (!text.trim()) return { empty: true };
      if (state.jsonAction === 'escape') return { ok: true, text: JSON.stringify(text) };
      const r = jsonFormat(text, { indent: state.jsonIndent, sort: state.jsonSort, minify: state.jsonAction === 'minify' });
      if (!r.ok) return r;
      if (state.jsonAction === 'unescape') {
        if (typeof r.value !== 'string') return { ok: false, error: { message: t('json.notString'), line: null, col: null } };
        return { ok: true, text: r.value };
      }
      return r;
    }
    const typeOf = v => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v);
    function jsonResultHtml() {
      const r = jsonResult();
      if (r.empty) return `<p class="tb-muted">${esc(t('json.hint'))}</p>`;
      if (!r.ok) {
        const e = r.error;
        let snippet = '';
        if (e.line) {
          const line = state.jsonIn.split('\n')[e.line - 1] || '';
          const from = Math.max(0, e.col - 60);
          snippet = `<pre class="tb-pre tb-err-pre">${esc(line.slice(from, e.col + 40))}\n${' '.repeat(Math.max(0, e.col - 1 - from))}^</pre>`;
        }
        return `<p class="tb-error">${ctx.ui.icon('circle-x')} ${esc(e.line ? t('json.errorAt', { line: e.line, col: e.col, message: e.message }) : t('json.error', { message: e.message }))}</p>${snippet}`;
      }
      const stats = r.value !== undefined ? t('json.valid', { type: t(`json.type.${typeOf(r.value)}`), size: fmt.number(r.text.length) }) : t('json.chars', { size: fmt.number(r.text.length) });
      const head = `<div class="tb-row-head"><span class="tb-ok">${ctx.ui.icon('check')} ${esc(stats)}</span>
        <span>${copyBtn(r.text)}<button class="btn btn-ghost btn-sm" onclick="Ext.toolbox.jsonUse()" title="${esc(t('json.useTitle'))}">${ctx.ui.icon('arrow-left')} ${esc(t('json.use'))}</button></span></div>`;
      // formattato: albero colorato e richiudibile (core, come le risposte dell'HTTP); compresso,
      // escape e unescape: testo colorato
      if (state.jsonAction === 'format' && r.value !== undefined && r.text.length <= TREE_MAX) {
        let node = null;
        try { node = ctx.ui.json.parse(r.text); } catch { /* resta il testo */ }
        if (node) return `${head}<div class="jv-scope tb-json-scope">${ctx.ui.json.tools()}<div class="tb-json-out">${ctx.ui.json.tree(node)}</div></div>`;
      }
      return `${head}<pre class="tb-json-out tb-json-text">${ctx.ui.json.highlight(r.text)}</pre>`;
    }
    // input di Confronta: colorato in modalità JSON
    const diffInput = (field, label) => (state.diffMode === 'json'
      ? ctx.ui.json.editor(state[field], `data-field="${field}" aria-label="${esc(label)}"`, '200px')
      : `<textarea class="form-input tb-area tb-mono" data-field="${field}" rows="9" spellcheck="false" aria-label="${esc(label)}">${esc(state[field])}</textarea>`);
    // JSON arrivato da un'altra sezione con un posto dove rimandarlo (es. la risposta di una rotta mock)
    let jsonOrigin = null; // { label, save(text) }
    const originHtml = () => (jsonOrigin ? `<div class="tb-origin">${ctx.ui.icon('corner-up-left')}
        <span>${esc(t('json.origin', { label: jsonOrigin.label }))}</span>
        <button class="btn btn-primary btn-sm" onclick="Ext.toolbox.saveOrigin()">${ctx.ui.icon('save')} ${esc(t('json.saveOrigin'))}</button>
        <button class="btn btn-ghost btn-sm" onclick="Ext.toolbox.dropOrigin()" title="${esc(t('json.dropOrigin'))}" aria-label="${esc(t('json.dropOrigin'))}">${ctx.ui.icon('x')}</button></div>` : '');
    const keepJson = () => { if (state.jsonIn.length <= JSON_KEEP_MAX) store.set(JSON_KEY, state.jsonIn); };

    function jsonHtml() {
      const seg = (field, list) => `<div class="tb-seg">${list.map(([v, label]) => `<button class="${state[field] === v ? 'active' : ''}" onclick="Ext.toolbox.set(${js(field)}, ${js(v)})">${esc(label)}</button>`).join('')}</div>`;
      return `${originHtml()}<div class="tb-toolbar">
          ${seg('jsonAction', [['format', t('json.format')], ['minify', t('json.minify')], ['escape', t('json.escape')], ['unescape', t('json.unescape')]])}
          <label class="tb-check">${esc(t('json.indent'))} <select class="form-input" data-field="jsonIndent">${[['2', '2'], ['4', '4'], ['tab', 'Tab']].map(([v, l]) => `<option value="${v}" ${state.jsonIndent === v ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select></label>
          <label class="tb-check"><input type="checkbox" data-field="jsonSort" ${state.jsonSort ? 'checked' : ''}> ${esc(t('json.sort'))}</label>
        </div>
        <div class="tb-grid">
          <div class="tb-col"><label>${esc(t('json.input'))}</label>${ctx.ui.json.editor(state.jsonIn, `data-field="jsonIn" placeholder='{"a": 1}' aria-label="${esc(t('json.input'))}"`, '460px')}</div>
          <div class="tb-col" data-role="result">${jsonResultHtml()}</div>
        </div>`;
    }

    // ---- diff ----
    const marks = parts => parts.map(p => (p.op === '=' ? esc(p.text) : `<mark class="${p.op === '-' ? 'tb-mdel' : 'tb-mins'}">${esc(p.text)}</mark>`)).join('');
    function diffResultHtml() {
      if (!state.diffLeft && !state.diffRight) return `<p class="tb-muted">${esc(t('diff.hint'))}</p>`;
      let left = state.diffLeft, right = state.diffRight, changes = null;
      if (state.diffMode === 'json') {
        const a = jsonFormat(left || 'null', { sort: true }), b = jsonFormat(right || 'null', { sort: true });
        if (!a.ok || !b.ok) {
          const side = !a.ok ? t('diff.left') : t('diff.right'), e = (!a.ok ? a : b).error;
          return `<p class="tb-error">${ctx.ui.icon('circle-x')} ${esc(t('diff.jsonInvalid', { side, message: e.line ? t('json.errorAt', { line: e.line, col: e.col, message: e.message }) : e.message }))}</p>`;
        }
        left = a.text; right = b.text;
        changes = diffJson(a.value, b.value);
      }
      let d;
      try { d = diffText(left, right, { ignoreWhitespace: state.diffWs, ignoreCase: state.diffCase }); }
      catch { return `<p class="tb-error">${esc(t('diff.tooLarge'))}</p>`; }
      const summary = d.same ? `<span class="tb-ok">${ctx.ui.icon('check')} ${esc(t('diff.same'))}</span>`
        : `<span class="tb-add">+${fmt.number(d.added)}</span> <span class="tb-rem">−${fmt.number(d.removed)}</span> <span class="tb-muted">${esc(t('diff.lines'))}</span>`;
      // righe uguali lontane dai cambiamenti piegate (3 di contesto)
      const show = d.rows.map(() => state.diffAll);
      if (!state.diffAll) d.rows.forEach((r, i) => { if (r.type !== 'eq') for (let j = Math.max(0, i - 3); j <= Math.min(d.rows.length - 1, i + 3); j++) show[j] = true; });
      const out = [];
      let hidden = 0;
      const flush = () => { if (hidden) { out.push({ fold: hidden }); hidden = 0; } };
      // tratti piegati solo da 4 righe in su (meno righe si mostrano)
      for (let i = 0; i < show.length;) {
        if (show[i]) { i++; continue; }
        let j = i; while (j < show.length && !show[j]) j++;
        if (j - i < 4) for (let k = i; k < j; k++) show[k] = true;
        i = j;
      }
      d.rows.forEach((r, i) => { if (show[i] || d.same) { flush(); out.push(r); } else hidden++; });
      flush();
      const fold = n => `<tr class="tb-fold"><td colspan="${state.diffView === 'split' ? 4 : 3}"><button class="tb-link" onclick="Ext.toolbox.set('diffAll', true)">${esc(t('diff.folded', { count: n }))}</button></td></tr>`;
      const ln = n => `<td class="tb-ln">${n ?? ''}</td>`;
      let body;
      if (state.diffView === 'split') {
        body = out.map(r => (r.fold ? fold(r.fold) : `<tr class="tb-d-${r.type}">${ln(r.ln)}<td class="tb-dl">${r.type === 'ins' ? '' : r.type === 'mod' ? marks(r.chars.left) : esc(r.left)}</td>${ln(r.rn)}<td class="tb-dr">${r.type === 'rem' ? '' : r.type === 'mod' ? marks(r.chars.right) : esc(r.right)}</td></tr>`)).join('');
      } else {
        const line = (cls, sign, l, rr, html) => `<tr class="tb-d-${cls}">${ln(l)}${ln(rr)}<td class="tb-du"><span class="tb-dsign">${sign}</span>${html}</td></tr>`;
        body = out.map(r => (r.fold ? fold(r.fold)
          : r.type === 'eq' ? line('eq', ' ', r.ln, r.rn, esc(r.left))
          : r.type === 'rem' ? line('rem', '−', r.ln, null, esc(r.left))
          : r.type === 'ins' ? line('ins', '+', null, r.rn, esc(r.right))
          : line('rem', '−', r.ln, null, marks(r.chars.left)) + line('ins', '+', null, r.rn, marks(r.chars.right)))).join('');
      }
      const val = v => (v === undefined ? '' : esc(JSON.stringify(v)));
      return `<div class="tb-row-head"><span>${summary}</span>${state.diffAll && !d.same ? `<button class="btn btn-ghost btn-sm" onclick="Ext.toolbox.set('diffAll', false)">${esc(t('diff.foldAgain'))}</button>` : ''}</div>
        ${changes && changes.length ? `<table class="data-table tb-paths"><tbody>${changes.slice(0, 500).map(c => `<tr class="tb-p-${c.kind}">
          <td><span class="tb-badge">${esc(t(`diff.kind.${c.kind}`))}</span></td><td class="tb-mono">${esc(c.path)}</td>
          <td class="tb-mono tb-pv">${c.kind === 'added' ? '' : `<span class="tb-rem">${val(c.before)}</span>`}${c.kind === 'changed' ? ' → ' : ''}${c.kind === 'removed' ? '' : `<span class="tb-add">${val(c.after)}</span>`}</td></tr>`).join('')}</tbody></table>` : ''}
        <div class="tb-diff-wrap"><table class="tb-diff tb-mono ${state.diffView === 'split' ? 'tb-split' : 'tb-unified'}"><tbody>${body}</tbody></table></div>`;
    }
    function diffHtml() {
      const seg = (field, list) => `<div class="tb-seg">${list.map(([v, label]) => `<button class="${state[field] === v ? 'active' : ''}" onclick="Ext.toolbox.set(${js(field)}, ${js(v)})">${esc(label)}</button>`).join('')}</div>`;
      return `<div class="tb-toolbar">
          ${seg('diffMode', [['text', t('diff.modeText')], ['json', t('diff.modeJson')]])}
          ${seg('diffView', [['split', t('diff.split')], ['unified', t('diff.unified')]])}
          <label class="tb-check"><input type="checkbox" data-field="diffWs" ${state.diffWs ? 'checked' : ''}> ${esc(t('diff.ignoreWs'))}</label>
          <label class="tb-check"><input type="checkbox" data-field="diffCase" ${state.diffCase ? 'checked' : ''}> ${esc(t('diff.ignoreCase'))}</label>
          <button class="btn btn-ghost btn-sm" onclick="Ext.toolbox.diffSwap()">${ctx.ui.icon('arrow-left-right')} ${esc(t('diff.swap'))}</button>
        </div>
        <div class="tb-grid">
          <div class="tb-col"><label>${esc(t('diff.left'))}</label>${diffInput('diffLeft', t('diff.left'))}</div>
          <div class="tb-col"><label>${esc(t('diff.right'))}</label>${diffInput('diffRight', t('diff.right'))}</div>
        </div>
        <div data-role="result">${diffResultHtml()}</div>`;
    }

    // ---- codifiche ----
    function codecHtml() {
      let out = '', err = null;
      try { out = state.codecIn ? CODECS[state.codec][state.direction](state.codecIn) : ''; } catch { err = t('codec.invalid', { codec: t(`codec.${state.codec}`) }); }
      return `<div class="tb-toolbar">
          <select class="form-input" data-field="codec">${Object.keys(CODECS).map(k => `<option value="${k}" ${k === state.codec ? 'selected' : ''}>${esc(t(`codec.${k}`))}</option>`).join('')}</select>
          <div class="tb-seg">${['encode', 'decode'].map(d => `<button class="${d === state.direction ? 'active' : ''}" onclick="Ext.toolbox.direction(${js(d)})">${esc(t(`codec.${d}`))}</button>`).join('')}</div>
          <button class="btn btn-ghost btn-sm" onclick="Ext.toolbox.swap()" ${err || !out ? 'disabled' : ''} title="${esc(t('codec.swapTitle'))}">${ctx.ui.icon('arrow-up-down')} ${esc(t('codec.swap'))}</button>
        </div>
        <div class="tb-grid">
          <div class="tb-col"><label>${esc(t('codec.input'))}</label><textarea class="form-input tb-area tb-mono" data-field="codecIn" rows="12" spellcheck="false">${esc(state.codecIn)}</textarea></div>
          <div class="tb-col"><div class="tb-row-head"><label>${esc(t('codec.output'))}</label>${out ? copyBtn(out) : ''}</div>
            ${err ? `<p class="tb-error">${esc(err)}</p>` : `<textarea class="form-input tb-area tb-mono" rows="12" readonly>${esc(out)}</textarea>`}</div>
        </div>`;
    }

    // ---- hash ----
    async function computeHashes() {
      const bytes = state.hashFile ? state.hashFile.bytes : toBytes(state.hashIn);
      const key = state.hashKey ? toBytes(state.hashKey) : null;
      const out = {};
      for (const h of HASHES) {
        try { const r = await digest(h, bytes, key); out[h] = r ? (state.hashFormat === 'hex' ? toHex(r) : bytesToBase64(r)) : null; } catch { out[h] = null; }
      }
      state.hashes = out;
      if (tab === 'hash') renderBody();
    }
    function hashHtml() {
      return `<div class="tb-toolbar">
          <label class="btn btn-ghost btn-sm tb-file">${ctx.ui.icon('file')} ${esc(t('hash.file'))}<input type="file" data-field="hashFile" hidden></label>
          ${state.hashFile ? `<span class="tb-muted">${esc(state.hashFile.name)} · ${esc(fmt.bytes ? fmt.bytes(state.hashFile.bytes.length) : `${state.hashFile.bytes.length} B`)}
            <button class="btn btn-ghost btn-sm" onclick="Ext.toolbox.clearFile()">${ctx.ui.icon('x')}</button></span>` : ''}
          <input class="form-input tb-mono tb-key" data-field="hashKey" value="${esc(state.hashKey)}" placeholder="${esc(t('hash.hmacKey'))}" spellcheck="false">
          <div class="tb-seg">${['hex', 'base64'].map(f => `<button class="${f === state.hashFormat ? 'active' : ''}" onclick="Ext.toolbox.hashFormat(${js(f)})">${esc(f)}</button>`).join('')}</div>
        </div>
        ${state.hashFile ? '' : `<textarea class="form-input tb-area tb-mono" data-field="hashIn" rows="5" spellcheck="false" placeholder="${esc(t('hash.placeholder'))}">${esc(state.hashIn)}</textarea>`}
        <table class="data-table tb-hashes"><tbody>${HASHES.map(h => `<tr>
          <td class="tb-hash-name">${esc(state.hashKey && h !== 'md5' ? `HMAC-${h.toUpperCase()}` : h.toUpperCase())}</td>
          <td class="tb-mono tb-hash-val">${state.hashes[h] ? esc(state.hashes[h]) : `<span class="tb-muted">${esc(state.hashKey && h === 'md5' ? t('hash.noHmacMd5') : '—')}</span>`}</td>
          <td>${state.hashes[h] ? copyBtn(state.hashes[h]) : ''}</td></tr>`).join('')}</tbody></table>`;
    }

    // ---- generatori ----
    function generateHtml() {
      const ms = parseTime(state.timeIn);
      const now = Date.now();
      return `<div class="tb-gen">
        <section><h4>${ctx.ui.icon('fingerprint')} UUID</h4>
          <div class="tb-inline">
            <div class="tb-seg">${['4', '7'].map(v => `<button class="${v === state.uuidVersion ? 'active' : ''}" onclick="Ext.toolbox.uuidVersion(${js(v)})">v${v}</button>`).join('')}</div>
            <input class="form-input tb-num" type="number" min="1" max="100" data-field="uuidCount" value="${esc(state.uuidCount)}">
            <button class="btn btn-ghost btn-sm" onclick="Ext.toolbox.uuids()">${ctx.ui.icon('refresh-cw')} ${esc(t('gen.generate'))}</button>
            ${state.uuids.length ? copyBtn(state.uuids.join('\n')) : ''}</div>
          ${state.uuids.length ? `<pre class="tb-pre">${esc(state.uuids.join('\n'))}</pre>` : `<p class="tb-muted">${esc(t(state.uuidVersion === '7' ? 'gen.uuid7Hint' : 'gen.uuid4Hint'))}</p>`}</section>
        <section><h4>${ctx.ui.icon('dices')} ${esc(t('gen.random'))}</h4>
          <div class="tb-inline">
            <input class="form-input tb-num" type="number" min="1" max="512" data-field="randLength" value="${esc(state.randLength)}">
            <select class="form-input" data-field="randCharset">${Object.keys(CHARSETS).map(k => `<option value="${k}" ${k === state.randCharset ? 'selected' : ''}>${esc(t(`gen.charset.${k}`))}</option>`).join('')}</select>
            <button class="btn btn-ghost btn-sm" onclick="Ext.toolbox.random()">${ctx.ui.icon('refresh-cw')} ${esc(t('gen.generate'))}</button>
            ${state.rand ? copyBtn(state.rand) : ''}</div>
          ${state.rand ? `<pre class="tb-pre">${esc(state.rand)}</pre>` : ''}</section>
        <section><h4>${ctx.ui.icon('clock')} ${esc(t('gen.time'))}</h4>
          <div class="tb-inline"><input class="form-input tb-mono tb-time-in" data-field="timeIn" value="${esc(state.timeIn)}" placeholder="${esc(`${Math.floor(now / 1000)} · ${new Date(now).toISOString()}`)}" spellcheck="false">
            <button class="btn btn-ghost btn-sm" onclick="Ext.toolbox.now()">${esc(t('gen.now'))}</button></div>
          ${state.timeIn && ms === null ? `<p class="tb-error">${esc(t('gen.timeInvalid'))}</p>` : ms !== null ? `<table class="data-table tb-times"><tbody>${[
            ['ISO (UTC)', new Date(ms).toISOString()],
            [t('gen.local'), fmt.date(ms, { dateStyle: 'full', timeStyle: 'long' })],
            [t('gen.seconds'), String(Math.floor(ms / 1000))],
            [t('gen.millis'), String(ms)],
            [t('gen.relative'), fmt.relative(new Date(ms).toISOString())],
          ].map(([k, v]) => `<tr><td>${esc(k)}</td><td class="tb-mono">${esc(v)}</td><td>${copyBtn(v)}</td></tr>`).join('')}</tbody></table>` : ''}</section>
      </div>`;
    }

    function renderBody() {
      const el = $('body');
      const active = document.activeElement;
      const keep = active && el.contains(active) && active.dataset.field ? { field: active.dataset.field, start: active.selectionStart, end: active.selectionEnd } : null;
      el.innerHTML = tab === 'jwt' ? jwtHtml() : tab === 'json' ? jsonHtml() : tab === 'diff' ? diffHtml() : tab === 'codec' ? codecHtml() : tab === 'hash' ? hashHtml() : generateHtml();
      // il campo in cui si stava scrivendo resta attivo, con il cursore dov'era
      if (keep) { const f = el.querySelector(`[data-field="${keep.field}"]`); if (f) { f.focus(); try { f.setSelectionRange(keep.start, keep.end); } catch { /* non è un campo di testo */ } } }
    }
    function render() { renderTabs(); renderBody(); }
    // solo il risultato (JSON, diff): i campi di testo restano come sono, con cursore e scorrimento
    let resultTimer = null;
    function renderResult(delay = 0) {
      clearTimeout(resultTimer);
      resultTimer = setTimeout(() => { const el = $('body').querySelector('[data-role="result"]'); if (el) el.innerHTML = tab === 'json' ? jsonResultHtml() : diffResultHtml(); }, delay);
    }

    // ---- eventi dei campi ----
    $('body').addEventListener('input', e => {
      const f = e.target.dataset.field;
      if (!f || e.target.type === 'file') return;
      const v = e.target.type === 'number' ? Number(e.target.value) : e.target.value;
      state[f] = v;
      if (f === 'jwt') { state.jwtVerify = null; state.jwtSource = null; }
      if (f === 'jwtKey') state.jwtVerify = null;
      if (f === 'hashIn' || f === 'hashKey') { computeHashes(); return; }
      if (f === 'jsonIn') { keepJson(); renderResult(120); return; }
      if (f === 'diffLeft' || f === 'diffRight') { state.diffAll = false; renderResult(200); return; }
      if (['jwt', 'codecIn', 'timeIn'].includes(f)) renderBody();
    });
    $('body').addEventListener('change', async e => {
      const f = e.target.dataset.field;
      if (f === 'codec' || f === 'randCharset') { state[f] = e.target.value; renderBody(); }
      if (f === 'jsonIndent') { state.jsonIndent = e.target.value; renderResult(); }
      if (['jsonSort', 'diffWs', 'diffCase'].includes(f)) { state[f] = e.target.checked; renderResult(); }
      if (f === 'hashFile' && e.target.files?.[0]) {
        const file = e.target.files[0];
        state.hashFile = { name: file.name, bytes: new Uint8Array(await file.arrayBuffer()) };
        computeHashes();
      }
    });

    const actions = {
      copy,
      tab(x) { tab = x; store.set(TAB_KEY, x); render(); if (x === 'hash') computeHashes(); if (x === 'jwt') loadHttpTokens(); },
      direction(d) { state.direction = d; renderBody(); },
      // scelte a pulsanti delle schede JSON e diff
      set(field, value) {
        if (!['jsonAction', 'jsonView', 'diffMode', 'diffView', 'diffAll'].includes(field)) return;
        state[field] = value;
        renderBody();
      },
      jsonUse() { const r = jsonResult(); if (r.ok) { state.jsonIn = r.text; state.jsonAction = 'format'; keepJson(); renderBody(); } },
      // rimanda il JSON dov'era (es. nella risposta della rotta mock): solo JSON valido
      async saveOrigin() {
        if (!jsonOrigin) return;
        try { JSON.parse(state.jsonIn); } catch (e) { toast(t('json.originInvalid', { error: e.message }), 'error'); return; }
        try {
          await jsonOrigin.save(state.jsonIn);
          toast(t('json.originSaved', { label: jsonOrigin.label }), 'success');
        } catch (e) { toast(e.message, 'error'); }
      },
      dropOrigin() { jsonOrigin = null; renderBody(); },
      diffSwap() { [state.diffLeft, state.diffRight] = [state.diffRight, state.diffLeft]; renderBody(); },
      swap() {
        try { state.codecIn = CODECS[state.codec][state.direction](state.codecIn); state.direction = state.direction === 'encode' ? 'decode' : 'encode'; renderBody(); } catch { /* niente da scambiare */ }
      },
      hashFormat(f) { state.hashFormat = f; computeHashes(); },
      clearFile() { state.hashFile = null; computeHashes(); },
      async verify() {
        try { state.jwtVerify = await verifyJwt(state.jwt, state.jwtKey); }
        catch (e) { state.jwtVerify = t(['jwt_alg', 'jwt_key', 'jwt_parts', 'jwt_json'].includes(e.message) ? `errors.${e.message}` : 'errors.jwt_verify'); }
        renderBody();
      },
      async sign() {
        try {
          const payload = JSON.parse(document.getElementById('tb_sign_payload').value);
          const token = await signJwt({ alg: document.getElementById('tb_sign_alg').value }, payload, document.getElementById('tb_sign_secret').value);
          state.jwt = token; state.jwtKey = document.getElementById('tb_sign_secret').value; state.jwtVerify = null; state.jwtSource = null;
          renderBody();
        } catch (e) { toast(e instanceof SyntaxError ? t('errors.json_invalid') : t('errors.jwt_sign'), 'error'); }
      },
      // token dell'HTTP client: con il vault bloccato prima la master password
      async loadHttpToken(value) {
        if (!value) return;
        const [section, user] = value.split("/");
        const get = () => ctx.api.get(`/http-tokens/${encodeURIComponent(section)}/${encodeURIComponent(user)}`);
        try {
          let r;
          try { r = await get(); } catch (e) { if (!ctx.vault.isVaultError(e)) throw e; if (!(await ctx.vault.ensure())) return; r = await get(); }
          state.jwt = r.token; state.jwtSource = { section: r.section, user: r.user }; state.jwtVerify = null;
          renderBody();
        } catch (e) { toast(e.message, 'error'); }
      },
      uuidVersion(v) { state.uuidVersion = v; state.uuids = []; renderBody(); },
      uuids() {
        const n = Math.min(Math.max(Number(state.uuidCount) || 1, 1), 100);
        state.uuids = Array.from({ length: n }, () => (state.uuidVersion === '7' ? uuid7() : uuid4()));
        renderBody();
      },
      random() { state.rand = randomString(Math.min(Math.max(Number(state.randLength) || 32, 1), 512), state.randCharset); renderBody(); },
      now() { state.timeIn = String(Math.floor(Date.now() / 1000)); renderBody(); },
    };

    async function loadHttpTokens() {
      try { httpTokens = await ctx.api.get('/http-tokens'); } catch { httpTokens = null; }
      if (tab === 'jwt') renderBody();
    }

    ctx.expose(actions);
    render();
    loadHttpTokens();
    if (tab === 'hash') computeHashes();

    this.show = () => { if (tab === 'jwt') loadHttpTokens(); };
    this.refresh = () => loadHttpTokens();
    // aperta da altre sezioni: { jwt } decodifica quel token; { json } lo mostra nella scheda JSON
    // (formattato); { compare } lo mette a destra in Confronta e sposta a sinistra quello che c'era,
    // così due invii di fila si confrontano (modalità JSON se entrambi sono JSON)
    this.focus = params => {
      if (params?.jwt) { state.jwt = String(params.jwt); state.jwtSource = null; tab = 'jwt'; }
      else if (params?.json != null) {
        state.jsonIn = String(params.json); state.jsonAction = 'format'; tab = 'json';
        jsonOrigin = params.origin && typeof params.origin.save === 'function' ? { label: String(params.origin.label || ''), save: params.origin.save } : null;
        keepJson();
      }
      else if (params?.compare != null) {
        state.diffLeft = state.diffRight;
        state.diffRight = String(params.compare);
        const isJson = x => { try { JSON.parse(x); return true; } catch { return false; } };
        state.diffMode = state.diffLeft && isJson(state.diffLeft) && isJson(state.diffRight) ? 'json' : state.diffLeft ? 'text' : state.diffMode;
        state.diffAll = false;
        tab = 'diff';
      } else return;
      store.set(TAB_KEY, tab);
      render();
    };
    this.languageChanged = () => render();
  },
};
