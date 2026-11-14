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

export {
  toBytes, fromBytes, bytesToBase64, base64ToBytes, b64urlEncodeBytes, b64urlDecodeBytes, toHex, fromHex, CODECS,
  md5, digest, decodeJwt, verifyJwt, signJwt, jwtAlgorithm, uuid4, uuid7, randomString, parseTime,
};

// ---- pannello ----
const TABS = ['jwt', 'codec', 'hash', 'generate'];
const HASHES = ['md5', 'sha1', 'sha256', 'sha384', 'sha512'];
const TAB_KEY = 'kelbo.toolbox.tab';

export default {
  async mount(ctx) {
    const { esc, js, toast, fmt } = ctx.ui;
    const { t } = ctx;
    const $ = role => ctx.root.querySelector(`[data-role="${role}"]`);
    const store = { get: (k, d) => { try { return localStorage.getItem(k) ?? d; } catch { return d; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* solo per questa sessione */ } } };

    let tab = TABS.includes(store.get(TAB_KEY)) ? store.get(TAB_KEY) : 'jwt';
    let httpTokens = null; // { available, tokens }
    const state = {
      jwt: '', jwtKey: '', jwtVerify: null, jwtSource: null,
      codec: 'base64', direction: 'encode', codecIn: '',
      hashIn: '', hashKey: '', hashFormat: 'hex', hashFile: null, hashes: {},
      uuidVersion: '4', uuidCount: 5, uuids: [], randLength: 32, randCharset: 'alnum', rand: '', timeIn: '',
    };

    async function copy(text) {
      try { await navigator.clipboard.writeText(text); toast(t('copied'), 'success'); }
      catch { toast(t('copyFailed'), 'error'); }
    }
    const copyBtn = value => `<button class="btn btn-ghost btn-sm" onclick="Ext.toolbox.copy(${js(value)})" title="${esc(t('copy'))}">${ctx.ui.icon('copy')}</button>`;

    function renderTabs() {
      ctx.ui.patch($('tabs'), TABS.map(x => `<button class="tb-tab ${x === tab ? 'active' : ''}" onclick="Ext.toolbox.tab(${js(x)})">${ctx.ui.icon({ jwt: 'key-round', codec: 'arrow-left-right', hash: 'hash', generate: 'sparkles' }[x])} ${esc(t(`tab.${x}`))}</button>`).join(''));
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
      el.innerHTML = tab === 'jwt' ? jwtHtml() : tab === 'codec' ? codecHtml() : tab === 'hash' ? hashHtml() : generateHtml();
      // il campo in cui si stava scrivendo resta attivo, con il cursore dov'era
      if (keep) { const f = el.querySelector(`[data-field="${keep.field}"]`); if (f) { f.focus(); try { f.setSelectionRange(keep.start, keep.end); } catch { /* non è un campo di testo */ } } }
    }
    function render() { renderTabs(); renderBody(); }

    // ---- eventi dei campi ----
    $('body').addEventListener('input', e => {
      const f = e.target.dataset.field;
      if (!f || e.target.type === 'file') return;
      const v = e.target.type === 'number' ? Number(e.target.value) : e.target.value;
      state[f] = v;
      if (f === 'jwt') { state.jwtVerify = null; state.jwtSource = null; }
      if (f === 'jwtKey') state.jwtVerify = null;
      if (f === 'hashIn' || f === 'hashKey') { computeHashes(); return; }
      if (['jwt', 'codecIn', 'timeIn'].includes(f)) renderBody();
    });
    $('body').addEventListener('change', async e => {
      const f = e.target.dataset.field;
      if (f === 'codec' || f === 'randCharset') { state[f] = e.target.value; renderBody(); }
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
    // aperta da altre sezioni: { jwt } decodifica quel token
    this.focus = params => { if (params?.jwt) { state.jwt = String(params.jwt); state.jwtSource = null; tab = 'jwt'; render(); } };
    this.languageChanged = () => render();
  },
};
