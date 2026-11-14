// Diagramma ER: add-on della sezione Database (punti database-menu, table-menu, workspace-tab).
// Lo schema arriva dal db-client (host.schema), le posizioni delle tabelle si salvano nel backend
// dell'add-on. Un solo modello di disegno (rettangoli, testi, linee, curve) produce la vista, l'SVG,
// il PNG e il PDF vettoriale (scritto qui, senza librerie, con i font standard Helvetica).

// ---- metriche di Helvetica (AFM, millesimi di em, caratteri 32–126): misure uguali a schermo e nel PDF ----
const HELV = [278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556, 1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556, 333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584];
const HELV_BOLD = [278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 333, 333, 584, 584, 584, 611, 975, 722, 722, 722, 722, 667, 611, 778, 722, 278, 556, 722, 611, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 333, 278, 333, 584, 556, 333, 556, 611, 556, 611, 556, 333, 611, 611, 278, 278, 556, 278, 889, 611, 611, 611, 611, 389, 556, 333, 611, 556, 778, 556, 556, 500, 389, 280, 389, 584];
export function textWidth(text, size, bold = false) {
  const w = bold ? HELV_BOLD : HELV;
  let sum = 0;
  for (const ch of String(text)) { const c = ch.codePointAt(0); sum += c >= 32 && c <= 126 ? w[c - 32] : 556; }
  return (sum * size) / 1000;
}
// testo accorciato con … per stare in max punti
export function fit(text, size, max, bold = false) {
  text = String(text);
  if (textWidth(text, size, bold) <= max) return text;
  let s = text;
  while (s.length > 1 && textWidth(`${s}…`, size, bold) > max) s = s.slice(0, -1);
  return `${s}…`;
}

// ---- geometria ----
export const G = { head: 26, row: 18, padX: 10, minW: 160, maxW: 360, gapX: 96, gapY: 34, nameSize: 12, rowSize: 10.5 };
// colonne mostrate: tutte, solo chiavi (primarie ed esterne) o nessuna (solo il nome)
export function shownColumns(t, mode) {
  if (mode === 'none') return [];
  const fkCols = new Set(t.foreignKeys.flatMap(f => f.columns));
  return mode === 'keys' ? t.columns.filter(c => t.primaryKey.includes(c.name) || fkCols.has(c.name)) : t.columns;
}
export function tableSize(t, mode) {
  const cols = shownColumns(t, mode);
  const colW = cols.reduce((m, c) => Math.max(m, 30 + textWidth(c.name, G.rowSize) + 16 + textWidth(c.type, G.rowSize)), 0);
  const w = Math.min(G.maxW, Math.max(G.minW, textWidth(t.name, G.nameSize, true) + 2 * G.padX + 24, colW + 2 * G.padX));
  return { w: Math.ceil(w), h: G.head + cols.length * G.row + (cols.length ? 6 : 0) };
}

// Tabelle referenziate a sinistra: livello = 1 + livello massimo delle tabelle a cui puntano; le
// colonne troppo alte si dividono. Restituisce { nome: { x, y } }
export function autoLayout(tables, sizes) {
  const names = new Set(tables.map(t => t.name));
  const refs = new Map(tables.map(t => [t.name, [...new Set(t.foreignKeys.map(f => f.refTable).filter(r => names.has(r) && r !== t.name))]]));
  const level = new Map();
  const lv = (n, seen = new Set()) => {
    if (level.has(n)) return level.get(n);
    if (seen.has(n)) return 0;
    seen.add(n);
    const r = refs.get(n) || [];
    const l = r.length ? Math.max(...r.map(x => lv(x, seen))) + 1 : 0;
    level.set(n, l);
    return l;
  };
  tables.forEach(t => lv(t.name));
  const degree = n => (refs.get(n) || []).length + tables.filter(t => (refs.get(t.name) || []).includes(n)).length;
  const area = tables.reduce((a, t) => a + (sizes[t.name].w + G.gapX) * (sizes[t.name].h + G.gapY), 0);
  const maxH = Math.max(700, Math.sqrt(area) * 1.1);
  const byLevel = [];
  for (const t of tables) (byLevel[level.get(t.name)] ||= []).push(t.name);
  const pos = {};
  let x = 0;
  for (const list of byLevel) {
    if (!list) continue;
    list.sort((a, b) => degree(b) - degree(a) || a.localeCompare(b));
    let y = 0, colW = 0;
    for (const n of list) {
      const s = sizes[n];
      if (y > 0 && y + s.h > maxH) { x += colW + G.gapX; y = 0; colW = 0; }
      pos[n] = { x, y };
      y += s.h + G.gapY;
      colW = Math.max(colW, s.w);
    }
    x += colW + G.gapX;
  }
  return pos;
}

// ---- disegno: elenco di forme, uguale per vista, SVG, PNG e PDF ----
// theme: colori (stringhe CSS; a schermo variabili var(--…), nell'export colori veri)
export const PRINT_THEME = { bg: '#ffffff', table: '#ffffff', head: '#eaf1fb', headView: '#f1ecfb', headText: '#0b1f3a', text: '#1f2328', muted: '#6e7781', border: '#9aa4b0', pk: '#b7791f', fk: '#2f6fd1', edge: '#6e7781', edgeHl: '#2f6fd1', sel: '#2f6fd1' };

export function buildDrawing(schema, { positions, mode = 'all', visible = null, highlight = new Set(), selected = null, theme = PRINT_THEME }) {
  const tables = schema.tables.filter(t => !visible || visible.has(t.name));
  const sizes = Object.fromEntries(tables.map(t => [t.name, tableSize(t, mode)]));
  const items = [];
  const boxes = {};
  for (const t of tables) {
    const p = positions[t.name] || { x: 0, y: 0 };
    boxes[t.name] = { x: p.x, y: p.y, ...sizes[t.name], cols: shownColumns(t, mode) };
  }
  const minX = Math.min(0, ...Object.values(boxes).map(b => b.x)), minY = Math.min(0, ...Object.values(boxes).map(b => b.y));
  const ox = 24 - minX, oy = 24 - minY;
  for (const b of Object.values(boxes)) { b.x += ox; b.y += oy; }
  const rowY = (b, col) => { const i = b.cols.findIndex(c => c.name === col); return i < 0 ? b.y + G.head / 2 : b.y + G.head + 3 + i * G.row + G.row / 2; };

  // relazioni sotto le tabelle: dal lato della tabella figlia (molti) a quello della referenziata (uno)
  for (const t of tables) {
    for (const fk of t.foreignKeys) {
      const a = boxes[t.name], b = boxes[fk.refTable];
      if (!a || !b || fk.refDatabase) continue;
      const hl = highlight.has(t.name) || highlight.has(fk.refTable);
      const color = hl ? theme.edgeHl : theme.edge, sw = hl ? 1.8 : 1.1;
      const y1 = rowY(a, fk.columns[0]), y2 = rowY(b, fk.refColumns[0]);
      const nullable = fk.columns.some(c => t.columns.find(x => x.name === c)?.nullable);
      const meta = { edge: `${t.name}.${fk.name}`, title: `${t.name}(${fk.columns.join(', ')}) → ${fk.refTable}(${fk.refColumns.join(', ')})` };
      if (a === b) { // riferimento alla stessa tabella: un anello a destra
        const x = a.x + a.w;
        items.push({ k: 'curve', x1: x, y1, c1x: x + 40, c1y: y1, c2x: x + 40, c2y: y2, x2: x, y2, color, sw, dash: nullable, ...meta });
        crowFoot(items, x, y1, 1, color, sw); bar(items, x, y2, 1, color, sw);
        continue;
      }
      const right = a.x + a.w / 2 < b.x + b.w / 2; // la figlia è a sinistra
      const x1 = right ? a.x + a.w : a.x, x2 = right ? b.x : b.x + b.w;
      const d1 = right ? 1 : -1, d2 = right ? -1 : 1;
      const k = Math.max(30, Math.abs(x2 - x1) / 2);
      items.push({ k: 'curve', x1: x1 + d1 * 10, y1, c1x: x1 + d1 * k, c1y: y1, c2x: x2 + d2 * k, c2y: y2, x2: x2 + d2 * 10, y2, color, sw, dash: nullable, ...meta });
      crowFoot(items, x1, y1, d1, color, sw);
      bar(items, x2, y2, d2, color, sw);
    }
  }
  // tabelle
  for (const t of tables) {
    const b = boxes[t.name];
    const g = t.name;
    const sel = selected === t.name || highlight.has(t.name);
    items.push({ k: 'rect', x: b.x, y: b.y, w: b.w, h: b.h, r: 6, fill: theme.table, stroke: sel ? theme.sel : theme.border, sw: sel ? 1.8 : 1, g });
    items.push({ k: 'rect', x: b.x, y: b.y, w: b.w, h: G.head, r: 6, fill: t.view ? theme.headView : theme.head, stroke: 'none', sw: 0, g, top: true });
    items.push({ k: 'line', x1: b.x, y1: b.y + G.head, x2: b.x + b.w, y2: b.y + G.head, color: sel ? theme.sel : theme.border, sw: sel ? 1.2 : 0.8, g });
    items.push({ k: 'text', x: b.x + G.padX, y: b.y + 17, text: fit(t.name, G.nameSize, b.w - 2 * G.padX - (t.view ? 30 : 0), true), size: G.nameSize, bold: true, color: theme.headText, g });
    if (t.view) items.push({ k: 'text', x: b.x + b.w - G.padX, y: b.y + 17, text: 'VIEW', size: 8, bold: true, color: theme.muted, anchor: 'end', g });
    const fkCols = new Set(t.foreignKeys.flatMap(f => f.columns));
    b.cols.forEach((c, i) => {
      const y = b.y + G.head + 3 + i * G.row + 13;
      const pk = t.primaryKey.includes(c.name), fk = fkCols.has(c.name);
      if (pk || fk) items.push({ k: 'text', x: b.x + G.padX, y, text: pk ? 'PK' : 'FK', size: 7.5, bold: true, color: pk ? theme.pk : theme.fk, g });
      const typeW = Math.min(textWidth(c.type, G.rowSize), b.w * 0.45);
      items.push({ k: 'text', x: b.x + G.padX + 22, y, text: fit(c.name, G.rowSize, b.w - 2 * G.padX - 22 - typeW - 10, pk), size: G.rowSize, bold: pk, color: theme.text, g, underline: false });
      items.push({ k: 'text', x: b.x + b.w - G.padX, y, text: fit(c.type + (c.nullable ? '' : ''), G.rowSize, typeW), size: G.rowSize, color: theme.muted, anchor: 'end', g });
    });
  }
  const width = Math.max(200, ...Object.values(boxes).map(b => b.x + b.w + 60));
  const height = Math.max(120, ...Object.values(boxes).map(b => b.y + b.h + 24));
  return { width, height, items, boxes, offset: { x: ox, y: oy } };
}
function crowFoot(items, x, y, dir, color, sw) {
  for (const dy of [-6, 0, 6]) items.push({ k: 'line', x1: x, y1: y + dy, x2: x + dir * 10, y2: y, color, sw });
}
function bar(items, x, y, dir, color, sw) {
  items.push({ k: 'line', x1: x + dir * 6, y1: y - 6, x2: x + dir * 6, y2: y + 6, color, sw });
  items.push({ k: 'line', x1: x, y1: y, x2: x + dir * 10, y2: y, color, sw });
}

// ---- SVG ----
const xml = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const n2 = v => Math.round(v * 100) / 100;
// Rettangolo con angoli arrotondati; top: solo gli angoli in alto (intestazione)
const roundRect = (x, y, w, h, r, top) => (top
  ? `M${n2(x)},${n2(y + h)} L${n2(x)},${n2(y + r)} Q${n2(x)},${n2(y)} ${n2(x + r)},${n2(y)} L${n2(x + w - r)},${n2(y)} Q${n2(x + w)},${n2(y)} ${n2(x + w)},${n2(y + r)} L${n2(x + w)},${n2(y + h)} Z`
  : null);
export function toSvg(d, { background = null, interactive = false, font = 'Helvetica, Arial, sans-serif' } = {}) {
  const out = [];
  let group = null;
  const close = () => { if (group !== null) { out.push('</g>'); group = null; } };
  for (const it of d.items) {
    if (interactive && it.g !== group) { close(); if (it.g != null) { out.push(`<g class="erd-table" data-table="${xml(it.g)}">`); group = it.g; } }
    const st = it.k === 'text' ? `fill:${it.color}` : it.k === 'rect' ? `fill:${it.fill};stroke:${it.stroke};stroke-width:${it.sw}` : `fill:none;stroke:${it.color};stroke-width:${it.sw}${it.dash ? ';stroke-dasharray:5 4' : ''}`;
    if (it.k === 'rect') out.push(it.top ? `<path d="${roundRect(it.x, it.y, it.w, it.h, it.r, true)}" style="${st}"/>` : `<rect x="${n2(it.x)}" y="${n2(it.y)}" width="${n2(it.w)}" height="${n2(it.h)}" rx="${it.r || 0}" style="${st}"/>`);
    else if (it.k === 'line') out.push(`<line x1="${n2(it.x1)}" y1="${n2(it.y1)}" x2="${n2(it.x2)}" y2="${n2(it.y2)}" style="${st}"/>`);
    else if (it.k === 'curve') out.push(`<path class="erd-edge" d="M${n2(it.x1)},${n2(it.y1)} C${n2(it.c1x)},${n2(it.c1y)} ${n2(it.c2x)},${n2(it.c2y)} ${n2(it.x2)},${n2(it.y2)}" style="${st}">${it.title ? `<title>${xml(it.title)}</title>` : ''}</path>`);
    else if (it.k === 'text') out.push(`<text x="${n2(it.x)}" y="${n2(it.y)}" font-size="${it.size}"${it.bold ? ' font-weight="bold"' : ''}${it.anchor === 'end' ? ' text-anchor="end"' : ''} style="${st}">${xml(it.text)}</text>`);
  }
  close();
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${n2(d.width)}" height="${n2(d.height)}" viewBox="0 0 ${n2(d.width)} ${n2(d.height)}" font-family="${xml(font)}">${background ? `<rect width="100%" height="100%" fill="${background}"/>` : ''}${out.join('')}</svg>`;
}

// ---- PDF vettoriale (1.4): una pagina grande quanto il diagramma, Helvetica e Helvetica-Bold ----
const WIN_ANSI = { 0x20ac: 128, 0x201a: 130, 0x0192: 131, 0x201e: 132, 0x2026: 133, 0x2020: 134, 0x2021: 135, 0x02c6: 136, 0x2030: 137, 0x0160: 138, 0x2039: 139, 0x0152: 140, 0x017d: 142, 0x2018: 145, 0x2019: 146, 0x201c: 147, 0x201d: 148, 0x2022: 149, 0x2013: 150, 0x2014: 151, 0x02dc: 152, 0x2122: 153, 0x0161: 154, 0x203a: 155, 0x0153: 156, 0x017e: 158, 0x0178: 159 };
// stringa PDF in WinAnsi, solo ASCII nel file (ottali per il resto)
export function pdfString(s) {
  let out = '(';
  for (const ch of String(s)) {
    const c = ch.codePointAt(0);
    const b = c < 128 ? c : (c >= 160 && c <= 255) ? c : WIN_ANSI[c] ?? 63;
    if (b === 40 || b === 41 || b === 92) out += `\\${String.fromCharCode(b)}`;
    else if (b < 32 || b > 126) out += `\\${b.toString(8).padStart(3, '0')}`;
    else out += String.fromCharCode(b);
  }
  return `${out})`;
}
const rgb = (color, fallback = [0, 0, 0]) => {
  const m = /^#([0-9a-f]{6})$/i.exec(String(color || ''));
  if (!m) return fallback;
  const v = parseInt(m[1], 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255].map(x => n2(x / 255));
};
export function toPdf(d, { title = '', subtitle = '', background = '#ffffff' } = {}) {
  const margin = 28, headerH = title ? 40 : 0;
  let scale = 0.75;
  // le pagine PDF stanno entro 14400 punti
  const maxSide = 14000;
  scale = Math.min(scale, (maxSide - 2 * margin) / d.width, (maxSide - 2 * margin - headerH) / d.height);
  const W = n2(d.width * scale + 2 * margin), H = n2(d.height * scale + 2 * margin + headerH);
  const X = x => n2(margin + x * scale), Y = y => n2(H - margin - headerH - y * scale);
  const ops = [];
  const fill = c => { const [r, g, b] = rgb(c); return `${r} ${g} ${b} rg`; };
  const stroke = c => { const [r, g, b] = rgb(c); return `${r} ${g} ${b} RG`; };
  ops.push(`${fill(background)} 0 0 ${W} ${H} re f`);
  if (title) {
    ops.push(`BT /F2 15 Tf ${fill('#1f2328')} ${margin} ${n2(H - margin - 14)} Td ${pdfString(title)} Tj ET`);
    if (subtitle) ops.push(`BT /F1 9 Tf ${fill('#6e7781')} ${margin} ${n2(H - margin - 30)} Td ${pdfString(subtitle)} Tj ET`);
  }
  const K = 0.5523;
  for (const it of d.items) {
    if (it.k === 'rect') {
      const x = it.x, y = it.y, w = it.w, h = it.h, r = Math.min(it.r || 0, w / 2, h / 2);
      // percorso in coordinate del diagramma, angoli con curve di Bézier
      const p = [];
      const mv = (a, b) => p.push(`${X(a)} ${Y(b)} m`), ln = (a, b) => p.push(`${X(a)} ${Y(b)} l`);
      const cv = (a1, b1, a2, b2, a3, b3) => p.push(`${X(a1)} ${Y(b1)} ${X(a2)} ${Y(b2)} ${X(a3)} ${Y(b3)} c`);
      if (it.top) {
        mv(x, y + h); ln(x, y + r); cv(x, y + r - K * r, x + r - K * r, y, x + r, y); ln(x + w - r, y);
        cv(x + w - r + K * r, y, x + w, y + r - K * r, x + w, y + r); ln(x + w, y + h); p.push('h');
      } else {
        mv(x + r, y); ln(x + w - r, y); cv(x + w - r + K * r, y, x + w, y + r - K * r, x + w, y + r);
        ln(x + w, y + h - r); cv(x + w, y + h - r + K * r, x + w - r + K * r, y + h, x + w - r, y + h);
        ln(x + r, y + h); cv(x + r - K * r, y + h, x, y + h - r + K * r, x, y + h - r);
        ln(x, y + r); cv(x, y + r - K * r, x + r - K * r, y, x + r, y); p.push('h');
      }
      const hasStroke = it.stroke && it.stroke !== 'none' && it.sw > 0;
      ops.push(`${fill(it.fill)}${hasStroke ? ` ${stroke(it.stroke)} ${n2(it.sw * scale)} w` : ''} ${p.join(' ')} ${hasStroke ? 'B' : 'f'}`);
    } else if (it.k === 'line') {
      ops.push(`${stroke(it.color)} ${n2(it.sw * scale)} w [] 0 d ${X(it.x1)} ${Y(it.y1)} m ${X(it.x2)} ${Y(it.y2)} l S`);
    } else if (it.k === 'curve') {
      ops.push(`${stroke(it.color)} ${n2(it.sw * scale)} w ${it.dash ? `[${n2(5 * scale)} ${n2(4 * scale)}] 0 d` : '[] 0 d'} ${X(it.x1)} ${Y(it.y1)} m ${X(it.c1x)} ${Y(it.c1y)} ${X(it.c2x)} ${Y(it.c2y)} ${X(it.x2)} ${Y(it.y2)} c S`);
    } else if (it.k === 'text') {
      const size = it.size * scale;
      const x = it.anchor === 'end' ? it.x - textWidth(it.text, it.size, it.bold) : it.x;
      ops.push(`BT /${it.bold ? 'F2' : 'F1'} ${n2(size)} Tf ${fill(it.color)} ${X(x)} ${Y(it.y)} Td ${pdfString(it.text)} Tj ET`);
    }
  }
  const content = ops.join('\n');
  const date = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${W} ${H}] /Resources << /Font << /F1 4 0 R /F2 5 0 R >> >> /Contents 6 0 R >>`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    `<< /Title ${pdfString(title || 'ER')} /Producer (Kelbo) /CreationDate (D:${date}) >>`,
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = [];
  objects.forEach((o, i) => { offsets.push(pdf.length); pdf += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map(o => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Info 7 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return pdf; // solo ASCII: lunghezze e offset sono byte
}

// tabelle collegate a una (lei e quelle a distanza 1 nei due versi)
export function neighbours(schema, name) {
  const out = new Set([name]);
  for (const t of schema.tables) {
    for (const f of t.foreignKeys) {
      if (t.name === name) out.add(f.refTable);
      if (f.refTable === name) out.add(t.name);
    }
  }
  return out;
}

// ---- interfaccia: la tab del db-client ----
const SCREEN_THEME = {
  bg: 'transparent', table: 'var(--surface, #161b22)', head: 'color-mix(in srgb, var(--ext-db-diagram, #8b5cf6) 22%, var(--surface, #161b22))',
  headView: 'color-mix(in srgb, var(--warning, #d29922) 18%, var(--surface, #161b22))', headText: 'var(--text, #e6edf3)', text: 'var(--text, #e6edf3)',
  muted: 'var(--muted, #8b949e)', border: 'var(--border-strong, #3d444d)', pk: 'var(--warning, #d29922)', fk: 'var(--accent, #388bfd)',
  edge: 'var(--muted, #8b949e)', edgeHl: 'var(--accent, #388bfd)', sel: 'var(--accent, #388bfd)',
};
const MODES = ['all', 'keys', 'none'];

function mountDiagram(ctx, host, el, state, tab) {
  const { esc, js, toast, fmt } = ctx.ui;
  const { t } = ctx;
  let schema = null, error = null, positions = {}, zoom = 1, filter = '', selected = null, hover = null;
  let mode = MODES.includes(state.mode) ? state.mode : 'all';
  let focus = state.focus || null;
  let drag = null, saveTimer = null;
  const id = `erd${Math.random().toString(36).slice(2, 8)}`;
  const q = sel => el.querySelector(sel);

  el.innerHTML = `<div class="erd" id="${id}">
    <div class="erd-bar">
      <span class="erd-title">${ctx.ui.icon('network')} <b data-role="title"></b> <span class="erd-muted" data-role="count"></span></span>
      <input class="form-input erd-filter" type="search" data-role="filter" placeholder="${esc(t('filter'))}">
      <span class="erd-focus" data-role="focus"></span>
      <select class="form-input erd-mode" data-role="mode">${MODES.map(m => `<option value="${m}" ${m === mode ? 'selected' : ''}>${esc(t(`mode.${m}`))}</option>`).join('')}</select>
      <span class="erd-group">
        <button class="btn btn-ghost btn-sm" data-act="zoom-out" title="${esc(t('zoomOut'))}">${ctx.ui.icon('zoom-out')}</button>
        <span class="erd-muted erd-zoom" data-role="zoom"></span>
        <button class="btn btn-ghost btn-sm" data-act="zoom-in" title="${esc(t('zoomIn'))}">${ctx.ui.icon('zoom-in')}</button>
        <button class="btn btn-ghost btn-sm" data-act="fit" title="${esc(t('fit'))}">${ctx.ui.icon('scan')}</button>
      </span>
      <button class="btn btn-ghost btn-sm" data-act="layout" title="${esc(t('relayoutTitle'))}">${ctx.ui.icon('layout-grid')} ${esc(t('relayout'))}</button>
      <button class="btn btn-ghost btn-sm" data-act="reload" title="${esc(t('reload'))}">${ctx.ui.icon('refresh-cw')}</button>
      <span class="erd-group erd-export">
        <button class="btn btn-sm" data-act="pdf" title="${esc(t('export.pdfTitle'))}">${ctx.ui.icon('file-down')} PDF</button>
        <button class="btn btn-ghost btn-sm" data-act="svg" title="${esc(t('export.svgTitle'))}">SVG</button>
        <button class="btn btn-ghost btn-sm" data-act="png" title="${esc(t('export.pngTitle'))}">PNG</button>
      </span>
    </div>
    <div class="erd-canvas" data-role="canvas"><p class="erd-muted erd-pad">${esc(t('loading'))}</p></div>
  </div>`;

  const visibleSet = () => {
    if (!schema) return null;
    let names = schema.tables.map(x => x.name);
    if (focus) { const nb = neighbours(schema, focus); names = names.filter(n => nb.has(n)); }
    const f = filter.trim().toLowerCase();
    if (f) names = names.filter(n => n.toLowerCase().includes(f) || (focus && n === focus));
    return new Set(names);
  };
  const drawingOf = (theme, forExport = false) => buildDrawing(schema, { positions, mode, visible: visibleSet(), highlight: forExport ? new Set() : new Set([selected, hover].filter(Boolean)), selected: forExport ? null : selected, theme });

  function render() {
    q('[data-role="title"]').textContent = state.database;
    q('[data-role="zoom"]').textContent = `${fmt.number(Math.round(zoom * 100))}%`;
    const fEl = q('[data-role="focus"]');
    fEl.innerHTML = focus ? `<span class="erd-chip">${ctx.ui.icon('focus')} ${esc(t('focusOn', { table: focus }))} <button data-act="unfocus" title="${esc(t('focusClear'))}">${ctx.ui.icon('x')}</button></span>` : '';
    const canvas = q('[data-role="canvas"]');
    if (error) { canvas.innerHTML = `<div class="erd-error">${ctx.ui.icon('triangle-alert')} ${esc(error)}</div>`; return; }
    if (!schema) return;
    const vis = visibleSet();
    q('[data-role="count"]').textContent = t('tables', { count: vis.size, total: schema.tables.length });
    if (!schema.tables.length) { canvas.innerHTML = `<p class="erd-muted erd-pad">${esc(t('empty'))}</p>`; return; }
    const d = drawingOf(SCREEN_THEME);
    lastOffset = d.offset;
    const svg = toSvg(d, { interactive: true });
    const scrollL = canvas.scrollLeft, scrollT = canvas.scrollTop;
    canvas.innerHTML = `<div class="erd-stage" style="width:${d.width * zoom}px;height:${d.height * zoom}px">${svg.replace('<svg ', `<svg style="transform:scale(${zoom});transform-origin:0 0" `)}</div>`;
    canvas.scrollLeft = scrollL; canvas.scrollTop = scrollT;
  }
  let lastOffset = { x: 0, y: 0 };

  async function load() {
    error = null;
    try {
      schema = await host.schema(state.connection, state.database);
      let saved = {};
      try { saved = (await ctx.api.get(`/layout?${new URLSearchParams({ connection: state.connection, database: state.database })}`)).positions || {}; } catch { /* nessuna posizione salvata */ }
      const sizes = Object.fromEntries(schema.tables.map(x => [x.name, tableSize(x, 'all')]));
      const auto = autoLayout(schema.tables, sizes);
      positions = Object.fromEntries(schema.tables.map(x => [x.name, saved[x.name] || auto[x.name]]));
      if (focus && !schema.tables.some(x => x.name === focus)) focus = null;
    } catch (e) {
      if (ctx.vault.isVaultError(e) && await ctx.vault.ensure()) return load();
      error = e.message;
    }
    render();
    if (focus) setTimeout(() => center(focus), 0);
  }
  const saveSoon = () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      ctx.api.put('/layout', { connection: state.connection, database: state.database, positions }).catch(e => toast(e.message, 'error'));
    }, 600);
  };
  function center(name) {
    const d = drawingOf(SCREEN_THEME);
    const b = d.boxes[name];
    const canvas = q('[data-role="canvas"]');
    if (!b || !canvas) return;
    canvas.scrollLeft = Math.max(0, (b.x + b.w / 2) * zoom - canvas.clientWidth / 2);
    canvas.scrollTop = Math.max(0, (b.y + b.h / 2) * zoom - canvas.clientHeight / 2);
  }
  function fitZoom() {
    const canvas = q('[data-role="canvas"]');
    const d = drawingOf(SCREEN_THEME);
    zoom = Math.max(0.2, Math.min(1.5, Math.floor(Math.min((canvas.clientWidth - 20) / d.width, (canvas.clientHeight - 20) / d.height) * 20) / 20));
    render();
  }
  const fileBase = () => `${state.database}-er`.replace(/[^\w.-]+/g, '_');
  function download(blob, name) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }
  async function exportAs(kind) {
    if (!schema) return;
    const d = drawingOf(PRINT_THEME, true);
    const conn = host.connections().find(c => c.id === state.connection);
    if (kind === 'pdf') {
      const pdf = toPdf(d, { title: t('export.title', { database: state.database }), subtitle: t('export.subtitle', { connection: conn?.label || state.connection, date: fmt.date(new Date()), count: visibleSet().size }) });
      download(new Blob([pdf], { type: 'application/pdf' }), `${fileBase()}.pdf`);
    } else {
      const svg = toSvg(d, { background: '#ffffff' });
      if (kind === 'svg') { download(new Blob([svg], { type: 'image/svg+xml' }), `${fileBase()}.svg`); return; }
      const img = new Image();
      img.src = `data:image/svg+xml;base64,${btoa(unescape(encodeURIComponent(svg)))}`;
      await img.decode();
      const scale = Math.min(2, 16000 / Math.max(d.width, d.height));
      const c = document.createElement('canvas');
      c.width = Math.round(d.width * scale); c.height = Math.round(d.height * scale);
      const g = c.getContext('2d');
      g.scale(scale, scale);
      g.drawImage(img, 0, 0);
      c.toBlob(b => download(b, `${fileBase()}.png`), 'image/png');
    }
    toast(t('export.done', { format: kind.toUpperCase() }), 'success');
  }

  // ---- eventi ----
  const tableAt = e => e.target.closest?.('.erd-table')?.dataset.table || null;
  el.addEventListener('click', e => {
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'zoom-in') { zoom = Math.min(2, Math.round((zoom + 0.1) * 10) / 10); render(); }
    else if (act === 'zoom-out') { zoom = Math.max(0.2, Math.round((zoom - 0.1) * 10) / 10); render(); }
    else if (act === 'fit') fitZoom();
    else if (act === 'reload') load();
    else if (act === 'unfocus') { focus = null; tab.setState({ focus: null }); render(); }
    else if (act === 'layout') {
      if (!schema || !confirm(t('relayoutConfirm'))) return;
      const vis = schema.tables.filter(x => visibleSet().has(x.name));
      const auto = autoLayout(vis, Object.fromEntries(vis.map(x => [x.name, tableSize(x, mode)])));
      Object.assign(positions, auto);
      render(); saveSoon();
    } else if (['pdf', 'svg', 'png'].includes(act)) exportAs(act).catch(err => toast(t('export.failed', { error: err.message }), 'error'));
  });
  el.addEventListener('input', e => { if (e.target.dataset.role === 'filter') { filter = e.target.value; render(); } });
  el.addEventListener('change', e => { if (e.target.dataset.role === 'mode') { mode = e.target.value; tab.setState({ mode }); render(); } });
  el.addEventListener('dblclick', e => { const name = tableAt(e); if (name) host.openTable(state.connection, state.database, name); });
  el.addEventListener('contextmenu', e => {
    const name = tableAt(e);
    if (!name) return;
    e.preventDefault();
    ctx.ui.contextMenu(e.clientX, e.clientY, [
      { icon: 'table-2', label: t('menu.openData'), action: () => host.openTable(state.connection, state.database, name) },
      { icon: 'focus', label: t('menu.focus'), action: () => { focus = name; tab.setState({ focus }); render(); setTimeout(() => center(name), 0); } },
      { icon: 'copy', label: t('menu.copyName'), action: () => navigator.clipboard?.writeText(name) },
    ]);
  });
  el.addEventListener('pointermove', e => {
    if (drag) {
      const dx = (e.clientX - drag.sx) / zoom, dy = (e.clientY - drag.sy) / zoom;
      if (!drag.moved && Math.abs(dx) + Math.abs(dy) < 3) return;
      drag.moved = true;
      positions[drag.name] = { x: Math.round(drag.ox + dx), y: Math.round(drag.oy + dy) };
      if (!drag.raf) drag.raf = requestAnimationFrame(() => { if (drag) drag.raf = null; render(); });
      return;
    }
    const name = tableAt(e);
    if (name !== hover) { hover = name; render(); }
  });
  el.addEventListener('pointerdown', e => {
    const name = tableAt(e);
    if (!name || e.button !== 0) return;
    const p = positions[name];
    drag = { name, sx: e.clientX, sy: e.clientY, ox: p.x, oy: p.y, moved: false, raf: null };
    // ridisegno solo se cambia la selezione (un ridisegno tra due clic farebbe perdere il doppio clic)
    if (selected !== name) { selected = name; render(); }
  });
  const endDrag = () => { if (drag?.moved) saveSoon(); drag = null; };
  el.addEventListener('pointerup', endDrag);
  el.addEventListener('pointercancel', endDrag);
  el.addEventListener('wheel', e => {
    if (!(e.ctrlKey || e.metaKey)) return;
    e.preventDefault();
    zoom = Math.min(2, Math.max(0.2, Math.round((zoom * (e.deltaY < 0 ? 1.1 : 0.9)) * 100) / 100));
    render();
  }, { passive: false });

  load();
  return {
    update(s) { if (s.focus !== undefined && s.focus !== focus) { focus = s.focus; render(); setTimeout(() => focus && center(focus), 0); } },
    unmount() { clearTimeout(saveTimer); },
    languageChanged: () => { render(); },
  };
}

export default {
  activate(ctx, host) {
    const views = new WeakMap();
    host.addTabType({
      id: 'er',
      icon: 'network',
      title: s => ctx.t('tabTitle', { database: s.database }),
      mount(el, state, tab) { views.set(el, mountDiagram(ctx, host, el, state, tab)); },
      update(el, state) { views.get(el)?.update(state); },
      unmount(el) { views.get(el)?.unmount(); },
      languageChanged(el) { views.get(el)?.languageChanged(); },
    });
    host.addMenuItem('database', {
      icon: 'network', label: ctx.t('menu.diagram'),
      run: target => host.openTab('er', { connection: target.connection, database: target.database }),
    });
    host.addMenuItem('table', {
      icon: 'network', label: ctx.t('menu.showInDiagram'),
      run: target => host.openTab('er', { connection: target.connection, database: target.database, focus: target.table }),
    });
  },
};
