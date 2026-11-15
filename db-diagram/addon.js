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

// Layout automatico: tabelle raggruppate per relazioni (componenti connesse). In ogni gruppo la
// tabella con più relazioni sta al centro e le altre su anelli concentrici per distanza da lei,
// ognuna vicino alla tabella che la lega all'anello prima; gli anelli si allargano finché nessuna
// tabella si sovrappone. Gruppi affiancati dal più grande; le tabelle senza relazioni sui bordi
// esterni, distribuite sui quattro lati. Restituisce { nome: { x, y } }
export function relations(tables) {
  const names = new Set(tables.map(t => t.name));
  const adj = new Map(tables.map(t => [t.name, new Set()]));
  for (const t of tables) {
    for (const f of t.foreignKeys) {
      if (!names.has(f.refTable) || f.refTable === t.name) continue; // riferimenti a sé: non legano
      adj.get(t.name).add(f.refTable);
      adj.get(f.refTable).add(t.name);
    }
  }
  return adj;
}

export function autoLayout(tables, sizes) {
  const adj = relations(tables);
  const deg = n => adj.get(n).size;
  const byDeg = (a, b) => deg(b) - deg(a) || a.localeCompare(b);
  // gruppi (dalla tabella con più relazioni) e tabelle isolate
  const seen = new Set(), groups = [], isolated = [];
  for (const n of [...adj.keys()].sort(byDeg)) {
    if (seen.has(n)) continue;
    seen.add(n);
    if (!deg(n)) { isolated.push(n); continue; }
    const g = [n];
    for (let i = 0; i < g.length; i++) for (const m of [...adj.get(g[i])].sort(byDeg)) if (!seen.has(m)) { seen.add(m); g.push(m); }
    groups.push(g);
  }
  groups.sort((a, b) => b.length - a.length || byDeg(a[0], b[0]));

  const pos = {};
  // gruppi uno accanto all'altro, a righe (larghezza massima dalla superficie totale)
  const placed = groups.map(g => radial(g, adj, sizes));
  const area = placed.reduce((a, p) => a + (p.w + G.gapX * 2) * (p.h + G.gapY * 3), 0);
  const maxRow = Math.max(placed[0]?.w || 0, Math.sqrt(area) * 1.4);
  let x = 0, y = 0, rowH = 0;
  for (const p of placed) {
    if (x > 0 && x + p.w > maxRow) { x = 0; y += rowH + G.gapY * 3; rowH = 0; }
    for (const [n, q] of Object.entries(p.pos)) pos[n] = { x: Math.round(x + q.x), y: Math.round(y + q.y) };
    x += p.w + G.gapX * 2;
    rowH = Math.max(rowH, p.h);
  }
  placeOnBorder(isolated, sizes, pos);
  return pos;
}

// Un gruppo: centro alla tabella con più relazioni, anelli per distanza (BFS). L'ordine negli
// anelli e la rotazione di ognuno si scelgono per ridurre gli intrecci: prima il baricentro
// (ogni tabella all'angolo medio delle collegate, più passate), poi una ricerca locale (scambi e
// rotazioni) che tiene una modifica solo se migliora il punteggio: incroci tra relazioni, relazioni
// che passano sopra una tabella, lunghezza delle linee. Gli incroci non cambiano allargando tutti
// gli anelli insieme: l'allargamento contro le sovrapposizioni viene dopo.
function radial(group, adj, sizes, budgetMs = 250) {
  const deg = n => adj.get(n).size;
  const hub = group[0];
  const ringOf = new Map([[hub, 0]]), parent = new Map([[hub, null]]);
  const rings = [[hub]];
  for (let k = 0; rings[k]?.length; k++) {
    const next = [];
    for (const n of rings[k]) {
      for (const m of [...adj.get(n)].sort((a, b) => deg(b) - deg(a) || a.localeCompare(b))) {
        if (ringOf.has(m)) continue;
        ringOf.set(m, k + 1); parent.set(m, n); next.push(m);
      }
    }
    if (next.length) rings.push(next);
  }
  const extent = n => Math.hypot(sizes[n].w, sizes[n].h);
  const arc = n => (sizes[n].w + sizes[n].h) / 2 + G.gapX * 0.6;
  // raggi: dipendono dal contenuto degli anelli, non dall'ordine
  const radius = [0];
  for (let k = 1; k < rings.length; k++) {
    const total = rings[k].reduce((a, n) => a + arc(n), 0);
    const prevExt = Math.max(...rings[k - 1].map(extent)), maxExt = Math.max(...rings[k].map(extent));
    radius[k] = Math.max(radius[k - 1] + (prevExt + maxExt) / 2 * 0.5 + G.gapX * 0.25, total / (2 * Math.PI));
  }
  const edges = [];
  for (const n of group) for (const m of adj.get(n)) if (n < m) edges.push([n, m]);

  // centri dall'ordine e dalla rotazione di ogni anello
  const centersOf = (order, rot, factor = 1) => {
    const c = new Map([[hub, { x: 0, y: 0, a: 0 }]]);
    for (let k = 1; k < order.length; k++) {
      const list = order[k];
      const total = list.reduce((s, n) => s + arc(n), 0);
      let a = rot[k];
      for (const n of list) {
        const span = (arc(n) / total) * 2 * Math.PI;
        const mid = a + span / 2;
        c.set(n, { x: radius[k] * factor * Math.cos(mid), y: radius[k] * factor * Math.sin(mid), a: mid });
        a += span;
      }
    }
    return c;
  };
  const score = c => {
    let crossings = 0, through = 0, length = 0;
    for (let i = 0; i < edges.length; i++) {
      const [a, b] = edges[i];
      const p1 = c.get(a), p2 = c.get(b);
      length += Math.hypot(p1.x - p2.x, p1.y - p2.y);
      for (let j = i + 1; j < edges.length; j++) {
        const [e, f] = edges[j];
        if (e === a || e === b || f === a || f === b) continue;
        if (segmentsCross(p1, p2, c.get(e), c.get(f))) crossings++;
      }
      for (const n of group) {
        if (n === a || n === b) continue;
        const q = c.get(n), w = sizes[n].w / 2, h = sizes[n].h / 2;
        if (segmentHitsBox(p1, p2, q.x - w, q.y - h, q.x + w, q.y + h)) through++;
      }
    }
    return crossings * 1000 + through * 400 + length / 50;
  };

  // ordine iniziale: figli vicino all'angolo del genitore
  const order = rings.map(r => r.slice());
  const rot = rings.map(() => -Math.PI / 2);
  let c = centersOf(order, rot);
  for (let k = 1; k < order.length; k++) {
    order[k].sort((x, y) => c.get(parent.get(x)).a - c.get(parent.get(y)).a || deg(y) - deg(x));
    c = centersOf(order, rot);
  }
  // baricentro: angolo medio delle tabelle collegate negli altri anelli
  const meanAngle = (n, cc) => {
    let sx = 0, sy = 0;
    for (const m of adj.get(n)) { const q = cc.get(m); const l = Math.hypot(q.x, q.y) || 1; sx += q.x / l; sy += q.y / l; }
    return Math.atan2(sy, sx);
  };
  const norm = a => { while (a < 0) a += 2 * Math.PI; while (a >= 2 * Math.PI) a -= 2 * Math.PI; return a; };
  let best = { order: order.map(r => r.slice()), rot: rot.slice(), score: score(c) };
  for (let sweep = 0; sweep < 6; sweep++) {
    const ks = sweep % 2 ? [...order.keys()].slice(1).reverse() : [...order.keys()].slice(1);
    for (const k of ks) {
      const target = new Map(order[k].map(n => [n, meanAngle(n, c)]));
      const ref = rot[k];
      order[k].sort((x, y) => norm(target.get(x) - ref) - norm(target.get(y) - ref));
      // rotazione: la prima tabella sull'angolo voluto
      rot[k] = target.get(order[k][0]) - (arc(order[k][0]) / order[k].reduce((s, n) => s + arc(n), 0)) * Math.PI;
      c = centersOf(order, rot);
    }
    const sc = score(c);
    if (sc < best.score) best = { order: order.map(r => r.slice()), rot: rot.slice(), score: sc };
  }
  // ricerca locale: scambi di due tabelle dello stesso anello e rotazioni degli anelli
  const cur = { order: best.order.map(r => r.slice()), rot: best.rot.slice(), score: best.score };
  const t0 = Date.now();
  let improved = true;
  while (improved && Date.now() - t0 < budgetMs) {
    improved = false;
    for (let k = 1; k < cur.order.length && Date.now() - t0 < budgetMs; k++) {
      const list = cur.order[k];
      for (let i = 0; i < list.length; i++) {
        for (let j = i + 1; j < list.length; j++) {
          [list[i], list[j]] = [list[j], list[i]];
          const sc = score(centersOf(cur.order, cur.rot));
          if (sc < cur.score - 1e-6) { cur.score = sc; improved = true; } else [list[i], list[j]] = [list[j], list[i]];
        }
      }
      for (const step of [Math.PI / 12, -Math.PI / 12, Math.PI / 4, -Math.PI / 4]) {
        cur.rot[k] += step;
        const sc = score(centersOf(cur.order, cur.rot));
        if (sc < cur.score - 1e-6) { cur.score = sc; improved = true; } else cur.rot[k] -= step;
      }
    }
  }
  // rifinitura a forze, partendo dagli anelli: le relazioni avvicinano, le tabelle si
  // respingono, quelle con più relazioni tirate verso il centro (la tabella centrale resta ferma)
  const center = centersOf(cur.order, cur.rot, 1.15);
  forces(group, edges, center, sizes, deg, hub);
  separate(group, center, sizes);
  // scambi di posizione fra due tabelle qualsiasi del gruppo, tenuti se migliorano il punteggio
  let sc = score(center);
  const t1 = Date.now();
  let again = true;
  while (again && Date.now() - t1 < budgetMs) {
    again = false;
    for (let i = 0; i < group.length && Date.now() - t1 < budgetMs; i++) {
      for (let j = i + 1; j < group.length; j++) {
        const a = group[i], b = group[j];
        const pa = center.get(a), pb = center.get(b);
        center.set(a, pb); center.set(b, pa);
        const next = score(center);
        if (next < sc - 1e-6) { sc = next; again = true; } else { center.set(a, pa); center.set(b, pb); }
      }
    }
  }
  separate(group, center, sizes);
  const raw = Object.fromEntries(group.map(n => [n, { x: center.get(n).x - sizes[n].w / 2, y: center.get(n).y - sizes[n].h / 2 }]));
  const minX = Math.min(...group.map(n => raw[n].x)), minY = Math.min(...group.map(n => raw[n].y));
  const pos = Object.fromEntries(group.map(n => [n, { x: raw[n].x - minX, y: raw[n].y - minY }]));
  return { pos, w: Math.max(...group.map(n => pos[n].x + sizes[n].w)), h: Math.max(...group.map(n => pos[n].y + sizes[n].h)), crossings: Math.floor(score(center) / 1000) };
}
// Forze (Fruchterman–Reingold con le dimensioni delle tabelle): molle sulle relazioni, repulsione
// tra tutte le tabelle, gravità verso il centro proporzionale alle relazioni; raffreddamento
function forces(group, edges, c, sizes, deg, hub, iterations = 240) {
  const ext = n => Math.hypot(sizes[n].w, sizes[n].h) / 2;
  for (let it = 0; it < iterations; it++) {
    const temp = 60 * (1 - it / iterations) + 2;
    const disp = new Map(group.map(n => [n, { x: 0, y: 0 }]));
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        const a = group[i], b = group[j], pa = c.get(a), pb = c.get(b);
        let dx = pa.x - pb.x, dy = pa.y - pb.y;
        let d = Math.hypot(dx, dy);
        if (d < 1) { dx = 1; dy = 0; d = 1; }
        const k = (ext(a) + ext(b)) * 0.8 + 30;
        const f = (k * k) / d / 8;
        disp.get(a).x += (dx / d) * f; disp.get(a).y += (dy / d) * f;
        disp.get(b).x -= (dx / d) * f; disp.get(b).y -= (dy / d) * f;
      }
    }
    for (const [a, b] of edges) {
      const pa = c.get(a), pb = c.get(b);
      const dx = pa.x - pb.x, dy = pa.y - pb.y, d = Math.max(1, Math.hypot(dx, dy));
      const ideal = (ext(a) + ext(b)) * 0.7 + 50;
      const f = ((d - ideal) * Math.abs(d - ideal)) / ideal / 6;
      disp.get(a).x -= (dx / d) * f; disp.get(a).y -= (dy / d) * f;
      disp.get(b).x += (dx / d) * f; disp.get(b).y += (dy / d) * f;
    }
    for (const n of group) {
      if (n === hub) continue;
      const p = c.get(n), g = 0.02 * (1 + deg(n));
      const v = disp.get(n);
      v.x -= p.x * g; v.y -= p.y * g;
      const l = Math.hypot(v.x, v.y);
      if (l > 0) c.set(n, { ...p, x: p.x + (v.x / l) * Math.min(l, temp), y: p.y + (v.y / l) * Math.min(l, temp) });
    }
  }
}
// Tabelle sovrapposte (con un margine) spostate lungo l'asse di minor sovrapposizione
function separate(group, c, sizes, pad = 28) {
  for (let round = 0; round < 200; round++) {
    let moved = false;
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        const a = group[i], b = group[j], pa = c.get(a), pb = c.get(b);
        const ox = (sizes[a].w + sizes[b].w) / 2 + pad - Math.abs(pa.x - pb.x);
        const oy = (sizes[a].h + sizes[b].h) / 2 + pad - Math.abs(pa.y - pb.y);
        if (ox <= 0 || oy <= 0) continue;
        moved = true;
        if (ox < oy) { const s = (pa.x < pb.x ? -1 : 1) * ox / 2; c.set(a, { ...pa, x: pa.x + s }); c.set(b, { ...pb, x: pb.x - s }); }
        else { const s = (pa.y < pb.y ? -1 : 1) * oy / 2; c.set(a, { ...pa, y: pa.y + s }); c.set(b, { ...pb, y: pb.y - s }); }
      }
    }
    if (!moved) break;
  }
}
// incrocio proprio di due segmenti (estremi esclusi)
export function segmentsCross(p1, p2, p3, p4) {
  const d = (a, b, c) => (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
  const d1 = d(p3, p4, p1), d2 = d(p3, p4, p2), d3 = d(p1, p2, p3), d4 = d(p1, p2, p4);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}
// il segmento attraversa il rettangolo (Liang–Barsky)
export function segmentHitsBox(p1, p2, x1, y1, x2, y2) {
  let t0 = 0, t1 = 1;
  const dx = p2.x - p1.x, dy = p2.y - p1.y;
  for (const [p, q] of [[-dx, p1.x - x1], [dx, x2 - p1.x], [-dy, p1.y - y1], [dy, y2 - p1.y]]) {
    if (p === 0) { if (q < 0) return false; continue; }
    const r = q / p;
    if (p < 0) { if (r > t1) return false; if (r > t0) t0 = r; } else { if (r < t0) return false; if (r < t1) t1 = r; }
  }
  return t0 < t1;
}
function overlaps(group, center, sizes, pad = 24) {
  const box = n => ({ x1: center.get(n).x - sizes[n].w / 2 - pad, y1: center.get(n).y - sizes[n].h / 2 - pad, x2: center.get(n).x + sizes[n].w / 2 + pad, y2: center.get(n).y + sizes[n].h / 2 + pad });
  const b = group.map(box);
  for (let i = 0; i < b.length; i++) for (let j = i + 1; j < b.length; j++) {
    if (b[i].x1 < b[j].x2 && b[j].x1 < b[i].x2 && b[i].y1 < b[j].y2 && b[j].y1 < b[i].y2) return true;
  }
  return false;
}

// Tabelle senza relazioni intorno alle altre: sui quattro lati, ognuno riempito in proporzione
// alla sua lunghezza; senza altre tabelle, in griglia
function placeOnBorder(isolated, sizes, pos) {
  if (!isolated.length) return;
  const placed = Object.keys(pos);
  if (!placed.length) {
    const cols = Math.max(1, Math.round(Math.sqrt(isolated.length * 1.6)));
    let x = 0, y = 0, rowH = 0;
    isolated.forEach((n, i) => {
      if (i && i % cols === 0) { x = 0; y += rowH + G.gapY; rowH = 0; }
      pos[n] = { x, y }; x += sizes[n].w + G.gapX / 2; rowH = Math.max(rowH, sizes[n].h);
    });
    return;
  }
  const margin = G.gapX * 1.2;
  let box = {
    x1: Math.min(...placed.map(n => pos[n].x)), y1: Math.min(...placed.map(n => pos[n].y)),
    x2: Math.max(...placed.map(n => pos[n].x + sizes[n].w)), y2: Math.max(...placed.map(n => pos[n].y + sizes[n].h)),
  };
  let rest = isolated.slice();
  while (rest.length) {
    const gap = G.gapX / 2;
    const len = { top: box.x2 - box.x1 + 2 * margin, bottom: box.x2 - box.x1 + 2 * margin, left: box.y2 - box.y1 + 2 * margin, right: box.y2 - box.y1 + 2 * margin };
    const side = { top: [], right: [], bottom: [], left: [] };
    const used = { top: 0, right: 0, bottom: 0, left: 0 };
    const along = (s, n) => (s === 'top' || s === 'bottom' ? sizes[n].w : sizes[n].h) + gap;
    const left = [];
    for (const n of rest) {
      // il lato meno pieno (in proporzione) dove la tabella entra ancora
      const fits = Object.keys(side).filter(s => used[s] + along(s, n) <= len[s]).sort((a, b) => used[a] / len[a] - used[b] / len[b]);
      if (!fits.length) { left.push(n); continue; }
      const s = fits[0];
      side[s].push(n); used[s] += along(s, n);
    }
    if (left.length === rest.length) { // nemmeno una: lati troppo corti per queste tabelle
      const n = left.shift();
      side.right.push(n); used.right += along('right', n);
    }
    const ext = { top: 0, right: 0, bottom: 0, left: 0 };
    for (const [s, list] of Object.entries(side)) {
      let c = (len[s] - used[s]) / 2; // centrate sul lato
      for (const n of list) {
        const { w, h } = sizes[n];
        if (s === 'top') { pos[n] = { x: box.x1 - margin + c, y: box.y1 - margin - h }; c += w + gap; ext.top = Math.max(ext.top, h); }
        if (s === 'bottom') { pos[n] = { x: box.x1 - margin + c, y: box.y2 + margin }; c += w + gap; ext.bottom = Math.max(ext.bottom, h); }
        if (s === 'left') { pos[n] = { x: box.x1 - margin - w, y: box.y1 - margin + c }; c += h + gap; ext.left = Math.max(ext.left, w); }
        if (s === 'right') { pos[n] = { x: box.x2 + margin, y: box.y1 - margin + c }; c += h + gap; ext.right = Math.max(ext.right, w); }
      }
    }
    rest = left;
    // anello successivo, fuori da quello appena riempito
    box = { x1: box.x1 - margin - ext.left, y1: box.y1 - margin - ext.top, x2: box.x2 + margin + ext.right, y2: box.y2 + margin + ext.bottom };
  }
  for (const n of isolated) pos[n] = { x: Math.round(pos[n].x), y: Math.round(pos[n].y) };
}

// ---- disegno: elenco di forme, uguale per vista, SVG, PNG e PDF ----
// theme: colori (stringhe CSS; a schermo variabili var(--…), nell'export colori veri)
export const PRINT_THEME = { bg: '#ffffff', table: '#ffffff', head: '#eaf1fb', headView: '#f1ecfb', headText: '#0b1f3a', text: '#1f2328', muted: '#6e7781', border: '#9aa4b0', pk: '#b7791f', fk: '#2f6fd1', edge: '#6e7781', edgeHl: '#2f6fd1', sel: '#2f6fd1' };

export function buildDrawing(schema, { positions, mode = 'all', visible = null, highlight = new Set(), selected = null, theme = PRINT_THEME, legend = null }) {
  const tables = schema.tables.filter(t => !visible || visible.has(t.name));
  const sizes = Object.fromEntries(tables.map(t => [t.name, tableSize(t, mode)]));
  const items = [];
  const boxes = {};
  for (const t of tables) {
    const p = positions[t.name] || { x: 0, y: 0 };
    boxes[t.name] = { x: p.x, y: p.y, ...sizes[t.name], cols: shownColumns(t, mode) };
  }
  const minX = Math.min(0, ...Object.values(boxes).map(b => b.x)), minY = Math.min(0, ...Object.values(boxes).map(b => b.y));
  let ox = 24 - minX, oy = 24 - minY;
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
      // lati delle due tabelle (sinistro o destro) con il percorso più corto, senza tornare
      // indietro attraverso la propria tabella; tabelle una sopra l'altra: stesso lato, ad arco
      let best = null;
      for (const d1 of [-1, 1]) for (const d2 of [-1, 1]) {
        const x1 = d1 > 0 ? a.x + a.w : a.x, x2 = d2 > 0 ? b.x + b.w : b.x;
        const s1 = x1 + d1 * 20, s2 = x2 + d2 * 20;
        const cost = Math.abs(s2 - s1) + Math.abs(y2 - y1) * 0.2 + (d1 * (x2 - x1) < -10 ? 600 : 0) + (d2 * (x1 - x2) < -10 ? 600 : 0);
        if (!best || cost < best.cost) best = { cost, x1, x2, d1, d2 };
      }
      const { x1, x2, d1, d2 } = best;
      const k = d1 === d2 ? 40 + Math.abs(y2 - y1) * 0.12 + Math.abs(x2 - x1) / 2 : Math.max(30, Math.abs(x2 - x1) / 2);
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
  // anche le linee dentro il disegno (le curve sullo stesso lato escono dalle tabelle)
  const xs = items.flatMap(i => [i.x, i.x1, i.x2, i.c1x, i.c2x].filter(v => v != null));
  const ys = items.flatMap(i => [i.y, i.y1, i.y2, i.c1y, i.c2y].filter(v => v != null));
  const dx = Math.max(0, 16 - Math.min(16, ...xs)), dy = Math.max(0, 16 - Math.min(16, ...ys));
  if (dx || dy) {
    items.forEach((it, i) => { items[i] = shift(it, dx, dy); });
    for (const b of Object.values(boxes)) { b.x += dx; b.y += dy; }
    ox += dx; oy += dy;
  }
  let width = Math.max(200, ...Object.values(boxes).map(b => b.x + b.w + 60), ...xs.map(v => v + dx + 16));
  let height = Math.max(120, ...Object.values(boxes).map(b => b.y + b.h + 24), ...ys.map(v => v + dy + 16));
  // legenda (export): in basso a sinistra, sotto le tabelle
  if (legend) {
    const lg = legendDrawing(legend, theme);
    for (const it of lg.items) items.push(shift(it, 24, height + 8));
    items.push({ k: 'rect', x: 24, y: height + 8, w: lg.width, h: lg.height, r: 6, fill: 'none', stroke: theme.border, sw: 0.6 });
    width = Math.max(width, lg.width + 48);
    height += lg.height + 32;
  }
  return { width, height, items, boxes, offset: { x: ox, y: oy } };
}
const shift = (it, dx, dy) => {
  const o = { ...it };
  for (const k of ['x', 'x1', 'x2', 'c1x', 'c2x']) if (o[k] != null) o[k] += dx;
  for (const k of ['y', 'y1', 'y2', 'c1y', 'c2y']) if (o[k] != null) o[k] += dy;
  return o;
};

// Legenda: linee continue e tratteggiate, molti e uno, chiavi, viste. labels: testi tradotti
// { title, required, optional, many, one, pk, fk, view }
export function legendDrawing(labels, theme = PRINT_THEME) {
  const items = [], row = 20, x = 12, tx = 66, size = 10;
  let y = 12;
  const text = (t, yy, opts = {}) => items.push({ k: 'text', x: opts.x ?? tx, y: yy, text: t, size: opts.size ?? size, bold: !!opts.bold, color: opts.color ?? theme.text });
  if (labels.title) { text(labels.title, y + 4, { x, bold: true, size: 10.5 }); y += row; }
  items.push({ k: 'line', x1: x, y1: y, x2: x + 44, y2: y, color: theme.edge, sw: 1.3 });
  text(labels.required, y + 3.5); y += row;
  items.push({ k: 'line', x1: x, y1: y, x2: x + 44, y2: y, color: theme.edge, sw: 1.3, dash: true });
  text(labels.optional, y + 3.5); y += row;
  // bordo di una tabella (il lato da cui parte la relazione) e la relazione
  const edge = (ex, yy) => items.push({ k: 'rect', x: ex, y: yy - 8, w: 6, h: 16, r: 1, fill: theme.table, stroke: theme.border, sw: 0.8 });
  edge(x, y);
  crowFoot(items, x + 6, y, 1, theme.edge, 1.3);
  items.push({ k: 'line', x1: x + 16, y1: y, x2: x + 50, y2: y, color: theme.edge, sw: 1.3 });
  text(labels.many, y + 3.5); y += row;
  items.push({ k: 'line', x1: x, y1: y, x2: x + 34, y2: y, color: theme.edge, sw: 1.3 });
  bar(items, x + 44, y, -1, theme.edge, 1.3);
  edge(x + 44, y);
  text(labels.one, y + 3.5); y += row;
  text('PK', y + 3, { x, bold: true, size: 8, color: theme.pk }); text(labels.pk, y + 3.5); y += row;
  text('FK', y + 3, { x, bold: true, size: 8, color: theme.fk }); text(labels.fk, y + 3.5); y += row;
  items.push({ k: 'rect', x, y: y - 7, w: 44, h: 14, r: 3, fill: theme.headView, stroke: theme.border, sw: 0.6 });
  text(labels.view, y + 3.5);
  const width = tx + Math.max(...items.filter(i => i.k === 'text' && i.x === tx).map(i => textWidth(i.text, size)), labels.title ? textWidth(labels.title, 10.5, true) - tx + x : 0) + 14;
  return { width, height: y + 14, items };
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
export function svgItems(items, { interactive = false } = {}) {
  const out = [];
  let group = null;
  const close = () => { if (group !== null) { out.push('</g>'); group = null; } };
  for (const it of items) {
    if (interactive && it.g !== group) { close(); if (it.g != null) { out.push(`<g class="erd-table" data-table="${xml(it.g)}">`); group = it.g; } }
    const st = it.k === 'text' ? `fill:${it.color}` : it.k === 'rect' ? `fill:${it.fill};stroke:${it.stroke};stroke-width:${it.sw}${it.dash ? ';stroke-dasharray:6 4' : ''}` : `fill:none;stroke:${it.color};stroke-width:${it.sw}${it.dash ? ';stroke-dasharray:5 4' : ''}`;
    if (it.k === 'rect') out.push(it.top ? `<path d="${roundRect(it.x, it.y, it.w, it.h, it.r, true)}" style="${st}"/>` : `<rect x="${n2(it.x)}" y="${n2(it.y)}" width="${n2(it.w)}" height="${n2(it.h)}" rx="${it.r || 0}" style="${st}"/>`);
    else if (it.k === 'line') out.push(`<line x1="${n2(it.x1)}" y1="${n2(it.y1)}" x2="${n2(it.x2)}" y2="${n2(it.y2)}" style="${st}"/>`);
    else if (it.k === 'curve') out.push(`<path class="erd-edge" d="M${n2(it.x1)},${n2(it.y1)} C${n2(it.c1x)},${n2(it.c1y)} ${n2(it.c2x)},${n2(it.c2y)} ${n2(it.x2)},${n2(it.y2)}" style="${st}">${it.title ? `<title>${xml(it.title)}</title>` : ''}</path>`);
    else if (it.k === 'text') out.push(`<text x="${n2(it.x)}" y="${n2(it.y)}" font-size="${n2(it.size)}"${it.bold ? ' font-weight="bold"' : ''}${it.anchor === 'end' ? ' text-anchor="end"' : ''} style="${st}">${xml(it.text)}</text>`);
  }
  close();
  return out.join('');
}
const FONT = 'Helvetica, Arial, sans-serif';
export function toSvg(d, { background = null, interactive = false, font = FONT } = {}) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${n2(d.width)}" height="${n2(d.height)}" viewBox="0 0 ${n2(d.width)} ${n2(d.height)}" font-family="${xml(font)}">${background ? `<rect width="100%" height="100%" fill="${background}"/>` : ''}${svgItems(d.items, { interactive })}</svg>`;
}

// ---- pagine dell'export: unica, un gruppo per pagina, porzioni di formato fisso ----
export const PAPERS = { a4: [595.28, 841.89], a3: [841.89, 1190.55], a2: [1190.55, 1683.78], letter: [612, 792] };
const PAGE = { margin: 28, header: 44, footer: 20 };
const PX_TO_PT = 0.75;
const colName = i => { let s = ''; i += 1; while (i > 0) { const r = (i - 1) % 26; s = String.fromCharCode(65 + r) + s; i = Math.floor((i - 1) / 26); } return s; };
// riquadro di una forma (per scartare quelle fuori da una porzione)
function itemBox(it) {
  if (it.k === 'rect') return [it.x, it.y, it.x + it.w, it.y + it.h];
  if (it.k === 'text') { const w = textWidth(it.text, it.size, it.bold); return it.anchor === 'end' ? [it.x - w, it.y - it.size, it.x, it.y + 3] : [it.x, it.y - it.size, it.x + w, it.y + 3]; }
  const xs = [it.x1, it.x2, it.c1x, it.c2x].filter(v => v != null), ys = [it.y1, it.y2, it.c1y, it.c2y].filter(v => v != null);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}
const intersects = (b, v) => b[0] < v.x + v.w && b[2] > v.x && b[1] < v.y + v.h && b[3] > v.y;

// Pagina che mostra la finestra view del disegno a scala s (punti per pixel), centrata nell'area
function page(drawing, view, s, W, H, head, extra = []) {
  const area = { w: W - 2 * PAGE.margin, h: H - 2 * PAGE.margin - PAGE.header - PAGE.footer };
  return { W, H, drawing, view, scale: s, area, cx: Math.max(0, (area.w - view.w * s) / 2), cy: Math.max(0, (area.h - view.h * s) / 2), extra, ...head };
}
function paperSize(paper, orientation, w, h) {
  const [pw, ph] = PAPERS[paper] || PAPERS.a4;
  const landscape = orientation === 'landscape' || (orientation !== 'portrait' && w >= h);
  return landscape ? [ph, pw] : [pw, ph];
}
// Porzioni a griglia di un disegno: [{ view, code }] (senza quelle vuote), con sovrapposizione
function tilesOf(d, vw, vh, overlap = 24) {
  const cols = Math.max(1, Math.ceil((d.width - overlap) / (vw - overlap))), rows = Math.max(1, Math.ceil((d.height - overlap) / (vh - overlap)));
  const boxes = d.items.map(itemBox);
  const out = [];
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    const view = { x: c * (vw - overlap), y: r * (vh - overlap), w: vw, h: vh };
    if (boxes.some(b => intersects(b, view))) out.push({ view, code: `${colName(c)}${r + 1}`, row: r, col: c });
  }
  return { tiles: out, cols, rows };
}

// Piano dell'export: pagine con intestazione, finestra del disegno e scala. opts: positions, mode,
// visible, legend (testi), split ('single' | 'groups' | 'tiles'), paper, orientation, zoom (scala
// rispetto al 100%: 0.75 punti per pixel), labels: { title, subtitle, overview, group(i, names),
// isolated, tile(code), page(i, n) }
export function planExport(schema, opts) {
  const { positions, mode = 'all', visible = null, legend = null, split = 'single', paper = 'a4', orientation = 'auto', zoom = 1, labels } = opts;
  const full = buildDrawing(schema, { positions, mode, visible, legend });
  const pages = [];
  const head = (subtitle) => ({ title: labels.title, subtitle });
  if (split === 'single') {
    const maxSide = 14000, m = PAGE.margin;
    const s = Math.min(PX_TO_PT, (maxSide - 2 * m) / full.width, (maxSide - 2 * m - PAGE.header - PAGE.footer) / full.height);
    const W = n2(full.width * s + 2 * m), H = n2(full.height * s + 2 * m + PAGE.header + PAGE.footer);
    pages.push(page(full, { x: 0, y: 0, w: full.width, h: full.height }, s, W, H, head(labels.subtitle)));
  } else {
    const base = PX_TO_PT * zoom;
    // panoramica: tutto il disegno nella pagina, con le porzioni o i gruppi segnati
    const [OW, OH] = paperSize(paper, orientation, full.width, full.height);
    const oArea = { w: OW - 2 * PAGE.margin, h: OH - 2 * PAGE.margin - PAGE.header - PAGE.footer };
    const fit = Math.min(oArea.w / full.width, oArea.h / full.height, base);
    const overview = page(full, { x: 0, y: 0, w: full.width, h: full.height }, fit, OW, OH, head(`${labels.overview} · ${labels.subtitle}`));
    const marks = [];
    const mark = (x, y, w, h, text) => {
      const sw = 1.2 / fit, size = 11 / fit;
      marks.push({ k: 'rect', x, y, w, h, r: 0, fill: 'none', stroke: '#2f6fd1', sw, dash: true });
      const tw = textWidth(text, size, true);
      marks.push({ k: 'rect', x: x + 4 / fit, y: y + 4 / fit, w: tw + 8 / fit, h: size + 6 / fit, r: 2 / fit, fill: '#2f6fd1', stroke: 'none', sw: 0 });
      marks.push({ k: 'text', x: x + 8 / fit, y: y + 4 / fit + size + 1 / fit, text, size, bold: true, color: '#ffffff' });
    };
    if (split === 'tiles') {
      const [W, H] = paperSize(paper, orientation, full.width, full.height);
      const area = { w: W - 2 * PAGE.margin, h: H - 2 * PAGE.margin - PAGE.header - PAGE.footer };
      const { tiles } = tilesOf(full, area.w / base, area.h / base);
      if (tiles.length <= 1) pages.push(page(full, { x: 0, y: 0, w: full.width, h: full.height }, Math.min(base, area.w / full.width, area.h / full.height), W, H, head(labels.subtitle)));
      else {
        pages.push(overview);
        tiles.forEach((tl, i) => {
          mark(tl.view.x, tl.view.y, Math.min(tl.view.w, full.width - tl.view.x), Math.min(tl.view.h, full.height - tl.view.y), `${tl.code} · ${labels.pageShort(i + 2)}`);
          pages.push(page(full, tl.view, base, W, H, head(`${labels.tile(tl.code)} · ${labels.subtitle}`)));
        });
      }
    } else {
      // un gruppo di tabelle collegate per pagina, poi quelle senza relazioni
      const shown = schema.tables.filter(t => !visible || visible.has(t.name));
      const adj = relations(shown);
      const seen = new Set(), groups = [], isolated = [];
      const byDeg = (a, b) => adj.get(b).size - adj.get(a).size || a.localeCompare(b);
      for (const n of [...adj.keys()].sort(byDeg)) {
        if (seen.has(n)) continue;
        seen.add(n);
        if (!adj.get(n).size) { isolated.push(n); continue; }
        const g = [n];
        for (let i = 0; i < g.length; i++) for (const m of adj.get(g[i])) if (!seen.has(m)) { seen.add(m); g.push(m); }
        groups.push(g);
      }
      groups.sort((a, b) => b.length - a.length);
      const parts = groups.map((g, i) => ({ names: g, label: labels.group(i + 1, g), drawing: buildDrawing(schema, { positions, mode, visible: new Set(g) }) }));
      if (isolated.length) {
        const iso = shown.filter(t => isolated.includes(t.name));
        const grid = autoLayout(iso, Object.fromEntries(iso.map(t => [t.name, tableSize(t, mode)])));
        parts.push({ names: isolated, label: labels.isolated, drawing: buildDrawing({ tables: iso }, { positions: grid, mode }) });
      }
      const single = parts.length === 1;
      if (!single) pages.push(overview);
      for (const part of parts) {
        const d = part.drawing;
        const [W, H] = paperSize(paper, orientation, d.width, d.height);
        const area = { w: W - 2 * PAGE.margin, h: H - 2 * PAGE.margin - PAGE.header - PAGE.footer };
        const s = Math.min(base, area.w / d.width, area.h / d.height);
        const first = pages.length + 1;
        // un gruppo che sta nel foglio anche ridotto (fino al 60%): una pagina; altrimenti porzioni
        if (s >= base * 0.6) pages.push(page(d, { x: 0, y: 0, w: d.width, h: d.height }, s, W, H, head(`${part.label} · ${labels.subtitle}`)));
        else {
          const { tiles } = tilesOf(d, area.w / base, area.h / base);
          for (const tl of tiles) pages.push(page(d, tl.view, base, W, H, head(`${part.label} · ${labels.tile(tl.code)} · ${labels.subtitle}`)));
        }
        // sulla panoramica: il riquadro del gruppo con la sua pagina
        if (!single && !part.names.some(n => !full.boxes[n])) {
          const bs = part.names.map(n => full.boxes[n]);
          const x1 = Math.min(...bs.map(b => b.x)) - 10, y1 = Math.min(...bs.map(b => b.y)) - 10;
          const x2 = Math.max(...bs.map(b => b.x + b.w)) + 10, y2 = Math.max(...bs.map(b => b.y + b.h)) + 10;
          if (part.names !== isolated) mark(x1, y1, x2 - x1, y2 - y1, labels.pageShort(first));
        }
      }
    }
    overview.extra = marks;
  }
  pages.forEach((p, i) => { p.footer = labels.page(i + 1, pages.length); });
  return pages;
}

// SVG di una pagina (anche per il PNG): intestazione, finestra del disegno, piè di pagina
export function pageSvg(p, { font = FONT } = {}) {
  const m = PAGE.margin;
  const x = m + p.cx, y = m + PAGE.header + p.cy;
  const w = Math.min(p.area.w, p.view.w * p.scale), h = Math.min(p.area.h, p.view.h * p.scale);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${n2(p.W)}" height="${n2(p.H)}" viewBox="0 0 ${n2(p.W)} ${n2(p.H)}" font-family="${xml(font)}">`
    + `<rect width="100%" height="100%" fill="#ffffff"/>`
    + `<text x="${m}" y="${m + 14}" font-size="15" font-weight="bold" style="fill:#1f2328">${xml(p.title)}</text>`
    + (p.subtitle ? `<text x="${m}" y="${m + 30}" font-size="9" style="fill:#6e7781">${xml(p.subtitle)}</text>` : '')
    + `<svg x="${n2(x)}" y="${n2(y)}" width="${n2(w)}" height="${n2(h)}" viewBox="${n2(p.view.x)} ${n2(p.view.y)} ${n2(w / p.scale)} ${n2(h / p.scale)}" overflow="hidden">${svgItems([...p.drawing.items, ...p.extra])}</svg>`
    + (p.footer ? `<text x="${n2(p.W - m)}" y="${n2(p.H - m + 4)}" font-size="8" text-anchor="end" style="fill:#6e7781">${xml(p.footer)}</text>` : '')
    + '</svg>';
}

// ---- PDF vettoriale (1.4), una o più pagine, Helvetica e Helvetica-Bold ----
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
// Operazioni PDF delle forme, con le coordinate del disegno trasformate da X e Y
function drawingOps(items, X, Y, scale) {
  const ops = [];
  const fill = c => { const [r, g, b] = rgb(c); return `${r} ${g} ${b} rg`; };
  const stroke = c => { const [r, g, b] = rgb(c); return `${r} ${g} ${b} RG`; };
  const K = 0.5523;
  for (const it of items) {
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
      const hasFill = it.fill && it.fill !== 'none';
      if (!hasStroke && !hasFill) continue;
      const dash = it.dash ? `[${n2(6 * scale)} ${n2(4 * scale)}] 0 d` : '[] 0 d';
      ops.push(`${hasFill ? fill(it.fill) : ''}${hasStroke ? ` ${stroke(it.stroke)} ${n2(it.sw * scale)} w ${dash}` : ''} ${p.join(' ')} ${hasStroke && hasFill ? 'B' : hasFill ? 'f' : 'S'}`);
    } else if (it.k === 'line') {
      ops.push(`${stroke(it.color)} ${n2(it.sw * scale)} w ${it.dash ? `[${n2(5 * scale)} ${n2(4 * scale)}] 0 d` : '[] 0 d'} ${X(it.x1)} ${Y(it.y1)} m ${X(it.x2)} ${Y(it.y2)} l S`);
    } else if (it.k === 'curve') {
      ops.push(`${stroke(it.color)} ${n2(it.sw * scale)} w ${it.dash ? `[${n2(5 * scale)} ${n2(4 * scale)}] 0 d` : '[] 0 d'} ${X(it.x1)} ${Y(it.y1)} m ${X(it.c1x)} ${Y(it.c1y)} ${X(it.c2x)} ${Y(it.c2y)} ${X(it.x2)} ${Y(it.y2)} c S`);
    } else if (it.k === 'text') {
      const size = it.size * scale;
      const x = it.anchor === 'end' ? it.x - textWidth(it.text, it.size, it.bold) : it.x;
      ops.push(`BT /${it.bold ? 'F2' : 'F1'} ${n2(size)} Tf ${fill(it.color)} ${X(x)} ${Y(it.y)} Td ${pdfString(it.text)} Tj ET`);
    }
  }
  return ops;
}
const fillOp = c => { const [r, g, b] = rgb(c); return `${r} ${g} ${b} rg`; };
// Contenuto di una pagina del piano: intestazione, finestra del disegno (ritagliata), piè di pagina
function pageOps(p) {
  const m = PAGE.margin, s = p.scale;
  const ox = m + p.cx, oyTop = m + PAGE.header + p.cy;
  const w = Math.min(p.area.w, p.view.w * s), h = Math.min(p.area.h, p.view.h * s);
  const X = x => n2(ox + (x - p.view.x) * s), Y = y => n2(p.H - oyTop - (y - p.view.y) * s);
  const view = { x: p.view.x, y: p.view.y, w: w / s, h: h / s };
  const items = [...p.drawing.items, ...p.extra].filter(it => intersects(itemBox(it), view));
  const ops = [`${fillOp('#ffffff')} 0 0 ${n2(p.W)} ${n2(p.H)} re f`];
  if (p.title) ops.push(`BT /F2 15 Tf ${fillOp('#1f2328')} ${m} ${n2(p.H - m - 14)} Td ${pdfString(p.title)} Tj ET`);
  if (p.subtitle) ops.push(`BT /F1 9 Tf ${fillOp('#6e7781')} ${m} ${n2(p.H - m - 30)} Td ${pdfString(p.subtitle)} Tj ET`);
  ops.push(`q ${n2(ox)} ${n2(p.H - oyTop - h)} ${n2(w)} ${n2(h)} re W n`);
  ops.push(...drawingOps(items, X, Y, s));
  ops.push('Q');
  if (p.footer) ops.push(`BT /F1 8 Tf ${fillOp('#6e7781')} ${n2(p.W - m - textWidth(p.footer, 8))} ${n2(m - 8)} Td ${pdfString(p.footer)} Tj ET`);
  return ops.join('\n');
}
// PDF di più pagine: catalogo, pagine, font, poi pagina e contenuto per ognuna, info
export function pagesToPdf(pages, { title = 'ER' } = {}) {
  const n = pages.length;
  const pageObj = i => 5 + i * 2, contentObj = i => 6 + i * 2, infoObj = 5 + n * 2;
  const date = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Kids [${pages.map((_, i) => `${pageObj(i)} 0 R`).join(' ')}] /Count ${n} >>`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>',
  ];
  pages.forEach((p, i) => {
    const content = pageOps(p);
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${n2(p.W)} ${n2(p.H)}] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${contentObj(i)} 0 R >>`);
    objects.push(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
  });
  objects.push(`<< /Title ${pdfString(title)} /Producer (Kelbo) /CreationDate (D:${date}) >>`);
  let pdf = '%PDF-1.4\n';
  const offsets = [];
  objects.forEach((o, i) => { offsets.push(pdf.length); pdf += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map(o => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Info ${infoObj} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return pdf; // solo ASCII: lunghezze e offset sono byte
}
// Una pagina grande quanto il diagramma (come prima del piano delle pagine)
export function toPdf(d, { title = '', subtitle = '' } = {}) {
  const s = Math.min(PX_TO_PT, (14000 - 2 * PAGE.margin) / d.width, (14000 - 2 * PAGE.margin - PAGE.header - PAGE.footer) / d.height);
  const W = n2(d.width * s + 2 * PAGE.margin), H = n2(d.height * s + 2 * PAGE.margin + PAGE.header + PAGE.footer);
  return pagesToPdf([{ ...page(d, { x: 0, y: 0, w: d.width, h: d.height }, s, W, H, { title, subtitle }), footer: '' }], { title: title || 'ER' });
}

// ---- ZIP (senza compressione) per più PNG ----
const CRC_TABLE = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
export function crc32(bytes) { let c = 0xffffffff; for (const b of bytes) c = CRC_TABLE[(c ^ b) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
export function makeZip(files) {
  const enc = new TextEncoder();
  const chunks = [], central = [];
  let offset = 0;
  const u16 = v => [v & 255, (v >> 8) & 255], u32 = v => [v & 255, (v >> 8) & 255, (v >> 16) & 255, (v >>> 24) & 255];
  for (const f of files) {
    const name = enc.encode(f.name), data = f.data, crc = crc32(data);
    const local = new Uint8Array([...u32(0x04034b50), ...u16(20), ...u16(0x0800), ...u16(0), ...u16(0), ...u16(0x21), ...u32(crc), ...u32(data.length), ...u32(data.length), ...u16(name.length), ...u16(0)]);
    chunks.push(local, name, data);
    central.push(new Uint8Array([...u32(0x02014b50), ...u16(20), ...u16(20), ...u16(0x0800), ...u16(0), ...u16(0), ...u16(0x21), ...u32(crc), ...u32(data.length), ...u32(data.length), ...u16(name.length), ...u16(0), ...u16(0), ...u16(0), ...u16(0), ...u32(0), ...u32(offset)]), name);
    offset += local.length + name.length + data.length;
  }
  const cdSize = central.reduce((a, c) => a + c.length, 0);
  const end = new Uint8Array([...u32(0x06054b50), ...u16(0), ...u16(0), ...u16(files.length), ...u16(files.length), ...u32(cdSize), ...u32(offset), ...u16(0)]);
  const out = new Uint8Array(offset + cdSize + end.length);
  let p = 0;
  for (const c of [...chunks, ...central, end]) { out.set(c, p); p += c.length; }
  return out;
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
      <button class="btn btn-ghost btn-sm erd-legend-btn" data-act="legend" title="${esc(t('legend.toggle'))}">${ctx.ui.icon('info')} ${esc(t('legend.button'))}</button>
      <span class="erd-group erd-export">
        <button class="btn btn-sm" data-act="pdf" title="${esc(t('export.pdfTitle'))}">${ctx.ui.icon('file-down')} PDF</button>
        <button class="btn btn-ghost btn-sm" data-act="svg" title="${esc(t('export.svgTitle'))}">SVG</button>
        <button class="btn btn-ghost btn-sm" data-act="png" title="${esc(t('export.pngTitle'))}">PNG</button>
      </span>
    </div>
    <div class="erd-body">
      <div class="erd-canvas" data-role="canvas"><p class="erd-muted erd-pad">${esc(t('loading'))}</p></div>
      <div class="erd-legend" data-role="legend" hidden></div>
    </div>
  </div>`;

  const visibleSet = () => {
    if (!schema) return null;
    let names = schema.tables.map(x => x.name);
    if (focus) { const nb = neighbours(schema, focus); names = names.filter(n => nb.has(n)); }
    const f = filter.trim().toLowerCase();
    if (f) names = names.filter(n => n.toLowerCase().includes(f) || (focus && n === focus));
    return new Set(names);
  };
  const legendLabels = () => Object.fromEntries(['title', 'required', 'optional', 'many', 'one', 'pk', 'fk', 'view'].map(k => [k, t(`legend.${k}`)]));
  const drawingOf = (theme, forExport = false) => buildDrawing(schema, { positions, mode, visible: visibleSet(), highlight: forExport ? new Set() : new Set([selected, hover].filter(Boolean)), selected: forExport ? null : selected, theme, legend: forExport ? legendLabels() : null });
  // legenda a schermo: riquadro in basso a sinistra, mostrato o nascosto (ricordato dal browser)
  const LEGEND_KEY = 'kelbo.db-diagram.legend';
  let showLegend = true;
  try { showLegend = localStorage.getItem(LEGEND_KEY) !== '0'; } catch { /* sempre visibile */ }
  function renderLegend() {
    const box = q('[data-role="legend"]');
    q('[data-act="legend"]').classList.toggle('active', showLegend);
    box.hidden = !showLegend || !schema || !!error;
    if (box.hidden) return;
    const lg = legendDrawing(legendLabels(), SCREEN_THEME);
    box.innerHTML = toSvg({ width: lg.width, height: lg.height, items: lg.items });
  }

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
    renderLegend();
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
  // Export: SVG del diagramma intero; PDF e PNG con la finestra delle opzioni (pagina unica, un
  // gruppo per pagina, porzioni di formato fisso), PNG di più pagine in uno ZIP
  const EXPORT_KEY = 'kelbo.db-diagram.export';
  const exportPrefs = () => { try { return { split: 'single', paper: 'a4', orientation: 'auto', zoom: 1, ...JSON.parse(localStorage.getItem(EXPORT_KEY) || '{}') }; } catch { return { split: 'single', paper: 'a4', orientation: 'auto', zoom: 1 }; } };
  const plan = o => {
    const conn = host.connections().find(c => c.id === state.connection);
    const vis = visibleSet();
    return planExport(schema, {
      positions, mode, visible: vis, legend: legendLabels(), ...o,
      labels: {
        title: t('export.title', { database: state.database }),
        subtitle: t('export.subtitle', { connection: conn?.label || state.connection, date: fmt.date(new Date()), count: vis.size }),
        overview: t('export.overview'), isolated: t('export.isolated'),
        group: (i, names) => t('export.group', { n: i, tables: names.slice(0, 3).join(', ') + (names.length > 3 ? '…' : '') }),
        tile: code => t('export.tile', { code }), page: (i, n) => t('export.page', { page: i, pages: n }), pageShort: i => t('export.pageShort', { page: i }),
      },
    });
  };
  function exportDialog(kind) {
    if (!schema) return;
    const o = exportPrefs();
    const opt = (v, label, cur) => `<option value="${esc(v)}" ${String(v) === String(cur) ? 'selected' : ''}>${esc(label)}</option>`;
    ctx.ui.openModal(t('export.dialogTitle', { format: kind.toUpperCase() }), `
      <div class="erd-export-form">
        ${['single', 'groups', 'tiles'].map(v => `<label class="erd-radio"><input type="radio" name="erd_split" value="${v}" ${o.split === v ? 'checked' : ''}>
          <span><b>${esc(t(`export.split.${v}`))}</b><small>${esc(t(`export.splitHint.${v}`))}</small></span></label>`).join('')}
        <div class="form-grid erd-paper">
          <div class="form-row"><label>${esc(t('export.paper'))}</label><select class="form-input" id="erd_paper">${Object.keys(PAPERS).map(k => opt(k, t(`export.papers.${k}`), o.paper)).join('')}</select></div>
          <div class="form-row"><label>${esc(t('export.orientation'))}</label><select class="form-input" id="erd_orient">${['auto', 'landscape', 'portrait'].map(k => opt(k, t(`export.orient.${k}`), o.orientation)).join('')}</select></div>
          <div class="form-row"><label>${esc(t('export.scale'))}</label><select class="form-input" id="erd_zoom">${[0.5, 0.75, 1, 1.25].map(z => opt(z, `${fmt.number(z * 100)}%`, o.zoom)).join('')}</select></div>
        </div>
        <p class="erd-muted" id="erd_pages"></p>
      </div>`,
      `<button class="btn btn-ghost" onclick="UI.closeModal()">${esc(t('core.action.cancel'))}</button>
       <button class="btn btn-primary" id="erd_go">${ctx.ui.icon('file-down')} ${esc(t('export.go'))}</button>`);
    const read = () => ({ split: document.querySelector('input[name="erd_split"]:checked')?.value || 'single', paper: document.getElementById('erd_paper').value, orientation: document.getElementById('erd_orient').value, zoom: Number(document.getElementById('erd_zoom').value) });
    const update = () => {
      const o2 = read();
      document.querySelector('.erd-paper').hidden = o2.split === 'single';
      let n = 1;
      try { n = plan(o2).length; } catch { /* conteggio non disponibile */ }
      document.getElementById('erd_pages').textContent = t(kind === 'png' && n > 1 ? 'export.pagesZip' : 'export.pages', { count: n });
    };
    document.querySelector('.erd-export-form').addEventListener('change', update);
    update();
    document.getElementById('erd_go').addEventListener('click', () => {
      const o2 = read();
      try { localStorage.setItem(EXPORT_KEY, JSON.stringify(o2)); } catch { /* solo ora */ }
      ctx.ui.closeModal();
      exportAs(kind, o2).catch(err => toast(t('export.failed', { error: err.message }), 'error'));
    });
  }
  async function pagePng(pg) {
    const svg = pageSvg(pg);
    const img = new Image();
    img.src = `data:image/svg+xml;base64,${btoa(unescape(encodeURIComponent(svg)))}`;
    await img.decode();
    const k = Math.min(2.5, 16000 / Math.max(pg.W, pg.H));
    const c = document.createElement('canvas');
    c.width = Math.round(pg.W * k); c.height = Math.round(pg.H * k);
    const g = c.getContext('2d');
    g.scale(k, k);
    g.drawImage(img, 0, 0);
    const blob = await new Promise(res => c.toBlob(res, 'image/png'));
    return new Uint8Array(await blob.arrayBuffer());
  }
  async function exportAs(kind, o = {}) {
    if (!schema) return;
    if (kind === 'svg') {
      download(new Blob([toSvg(drawingOf(PRINT_THEME, true), { background: '#ffffff' })], { type: 'image/svg+xml' }), `${fileBase()}.svg`);
      toast(t('export.done', { format: 'SVG' }), 'success');
      return;
    }
    const pages = plan(o);
    if (kind === 'pdf') download(new Blob([pagesToPdf(pages, { title: t('export.title', { database: state.database }) })], { type: 'application/pdf' }), `${fileBase()}.pdf`);
    else if (pages.length === 1) download(new Blob([await pagePng(pages[0])], { type: 'image/png' }), `${fileBase()}.png`);
    else {
      const files = [];
      for (let i = 0; i < pages.length; i++) files.push({ name: `${fileBase()}-${String(i + 1).padStart(2, '0')}.png`, data: await pagePng(pages[i]) });
      download(new Blob([makeZip(files)], { type: 'application/zip' }), `${fileBase()}-png.zip`);
    }
    toast(t('export.donePages', { format: kind.toUpperCase(), count: pages.length }), 'success');
  }

  // ---- eventi ----
  const tableAt = e => e.target.closest?.('.erd-table')?.dataset.table || null;
  el.addEventListener('click', e => {
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'zoom-in') { zoom = Math.min(2, Math.round((zoom + 0.1) * 10) / 10); render(); }
    else if (act === 'zoom-out') { zoom = Math.max(0.2, Math.round((zoom - 0.1) * 10) / 10); render(); }
    else if (act === 'fit') fitZoom();
    else if (act === 'reload') load();
    else if (act === 'legend') { showLegend = !showLegend; try { localStorage.setItem(LEGEND_KEY, showLegend ? '1' : '0'); } catch { /* solo ora */ } renderLegend(); }
    else if (act === 'unfocus') { focus = null; tab.setState({ focus: null }); render(); }
    else if (act === 'layout') {
      if (!schema || !confirm(t('relayoutConfirm'))) return;
      const vis = schema.tables.filter(x => visibleSet().has(x.name));
      const auto = autoLayout(vis, Object.fromEntries(vis.map(x => [x.name, tableSize(x, mode)])));
      Object.assign(positions, auto);
      render(); saveSoon();
    } else if (act === 'svg') exportAs('svg').catch(err => toast(t('export.failed', { error: err.message }), 'error'));
    else if (act === 'pdf' || act === 'png') exportDialog(act);
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
