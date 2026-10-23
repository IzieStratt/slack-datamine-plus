// SPDX-License-Identifier: AGPL-3.0-only
// Slack ships its icon glyphs as one Iconify-style JSON blob ({prefix, icons: {name: {body: "<path .../>"}}, width, height}) inside a
// vendors chunk. extractIconSet() pulls it out of a chunk, renderIconsPdf() draws every glyph as vector paths into a PDF with nothing
// but node's own zlib (no browser, no fonts to embed: labels use the built-in Helvetica).
import zlib from 'node:zlib';

// the blob sits in a module as JSON.parse('{"prefix":"...","icons":{...}}'); cut at the first unescaped quote and undo the JS escaping
export function extractIconSet(js) {
  const start = js.indexOf(`JSON.parse('{"prefix":`);
  if (start < 0) return null;
  let end = start + 12;
  while (end < js.length && js[end] !== "'") end += js[end] === '\\' ? 2 : 1; // a backslash escapes the next character
  const literal = js.slice(start + 12, end);
  const json = literal.replace(/\\(u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|.)/gs, (_, c) => c[0] === 'u' || (c[0] === 'x' && c.length === 3) ? String.fromCharCode(parseInt(c.slice(1), 16)) : c === 'n' ? '\n' : c === 't' ? '\t' : c);
  try {
    const set = JSON.parse(json);
    if (!set.icons || typeof set.icons !== 'object' || !Object.keys(set.icons).length) return null;
    return { prefix: set.prefix, width: set.width || 20, height: set.height || 20, icons: Object.fromEntries(Object.entries(set.icons).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, v]) => [k, { body: v.body }])) };
  } catch { return null; }
}

// ---- SVG path data -> absolute M/L/C/Z segments ----
function arcToCubics(x1, y1, rx, ry, phiDeg, fa, fs, x2, y2) {
  if (!rx || !ry || (x1 === x2 && y1 === y2)) return [['L', x2, y2]];
  rx = Math.abs(rx); ry = Math.abs(ry);
  const phi = (phiDeg * Math.PI) / 180, cos = Math.cos(phi), sin = Math.sin(phi);
  const dx = (x1 - x2) / 2, dy = (y1 - y2) / 2;
  const x1p = cos * dx + sin * dy, y1p = -sin * dx + cos * dy;
  const lam = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry);
  if (lam > 1) { const s = Math.sqrt(lam); rx *= s; ry *= s; }
  const num = rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p, den = rx * rx * y1p * y1p + ry * ry * x1p * x1p;
  let co = Math.sqrt(Math.max(0, num / den));
  if (fa === fs) co = -co;
  const cxp = (co * rx * y1p) / ry, cyp = (-co * ry * x1p) / rx;
  const cx = cos * cxp - sin * cyp + (x1 + x2) / 2, cy = sin * cxp + cos * cyp + (y1 + y2) / 2;
  const angle = (ux, uy, vx, vy) => Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
  const th1 = angle(1, 0, (x1p - cxp) / rx, (y1p - cyp) / ry);
  let dth = angle((x1p - cxp) / rx, (y1p - cyp) / ry, (-x1p - cxp) / rx, (-y1p - cyp) / ry);
  if (!fs && dth > 0) dth -= 2 * Math.PI; else if (fs && dth < 0) dth += 2 * Math.PI;
  const n = Math.max(1, Math.ceil(Math.abs(dth) / (Math.PI / 2) - 1e-9)), step = dth / n, t = (4 / 3) * Math.tan(step / 4);
  const map = (ux, uy) => [cx + cos * rx * ux - sin * ry * uy, cy + sin * rx * ux + cos * ry * uy];
  const out = [];
  for (let i = 0; i < n; i++) {
    const a1 = th1 + i * step, a2 = a1 + step;
    const p1 = map(Math.cos(a1) - t * Math.sin(a1), Math.sin(a1) + t * Math.cos(a1));
    const p2 = map(Math.cos(a2) + t * Math.sin(a2), Math.sin(a2) - t * Math.cos(a2));
    const p3 = i === n - 1 ? [x2, y2] : map(Math.cos(a2), Math.sin(a2));
    out.push(['C', ...p1, ...p2, ...p3]);
  }
  return out;
}

export function parsePath(d) {
  let i = 0;
  const ws = () => { while (i < d.length && /[\s,]/.test(d[i])) i++; };
  const num = () => {
    ws();
    const m = /^[-+]?(?:\d*\.\d+|\d+\.?)(?:[eE][-+]?\d+)?/.exec(d.slice(i));
    if (!m) throw new Error(`bad path number at ${i}: ${d.slice(i, i + 10)}`);
    i += m[0].length; return Number(m[0]);
  };
  const flag = () => { ws(); const c = d[i++]; if (c !== '0' && c !== '1') throw new Error('bad arc flag'); return c === '1' ? 1 : 0; };
  const segs = [];
  let x = 0, y = 0, sx = 0, sy = 0, cmd = '', lastC = null, lastQ = null;
  for (;;) {
    ws();
    if (i >= d.length) break;
    if (/[a-zA-Z]/.test(d[i])) cmd = d[i++];
    else if (!cmd) throw new Error('path must start with a command');
    else if (cmd === 'M') cmd = 'L'; else if (cmd === 'm') cmd = 'l'; // extra pairs after a moveto are linetos
    const rel = cmd === cmd.toLowerCase(), C = cmd.toUpperCase();
    const ox = rel ? x : 0, oy = rel ? y : 0;
    let nextC = null, nextQ = null;
    if (C === 'Z') { segs.push(['Z']); x = sx; y = sy; }
    else if (C === 'M') { x = ox + num(); y = oy + num(); sx = x; sy = y; segs.push(['M', x, y]); }
    else if (C === 'L') { x = ox + num(); y = oy + num(); segs.push(['L', x, y]); }
    else if (C === 'H') { x = ox + num(); segs.push(['L', x, y]); }
    else if (C === 'V') { y = oy + num(); segs.push(['L', x, y]); }
    else if (C === 'C' || C === 'S') {
      let x1, y1;
      if (C === 'C') { x1 = ox + num(); y1 = oy + num(); } else if (lastC) { x1 = 2 * x - lastC[0]; y1 = 2 * y - lastC[1]; } else { x1 = x; y1 = y; }
      const x2 = ox + num(), y2 = oy + num(), ex = ox + num(), ey = oy + num();
      segs.push(['C', x1, y1, x2, y2, ex, ey]); nextC = [x2, y2]; x = ex; y = ey;
    } else if (C === 'Q' || C === 'T') {
      let qx, qy;
      if (C === 'Q') { qx = ox + num(); qy = oy + num(); } else if (lastQ) { qx = 2 * x - lastQ[0]; qy = 2 * y - lastQ[1]; } else { qx = x; qy = y; }
      const ex = ox + num(), ey = oy + num();
      segs.push(['C', x + (2 / 3) * (qx - x), y + (2 / 3) * (qy - y), ex + (2 / 3) * (qx - ex), ey + (2 / 3) * (qy - ey), ex, ey]);
      nextQ = [qx, qy]; x = ex; y = ey;
    } else if (C === 'A') {
      const rx = num(), ry = num(), rot = num(), fa = flag(), fs = flag(), ex = ox + num(), ey = oy + num();
      segs.push(...arcToCubics(x, y, rx, ry, rot, fa, fs, ex, ey)); x = ex; y = ey;
    } else throw new Error(`unsupported path command ${cmd}`);
    lastC = nextC; lastQ = nextQ;
  }
  return segs;
}

const ellipse = (cx, cy, rx, ry) => [['M', cx + rx, cy], ...arcToCubics(cx + rx, cy, rx, ry, 0, 0, 1, cx, cy + ry), ...arcToCubics(cx, cy + ry, rx, ry, 0, 0, 1, cx - rx, cy), ...arcToCubics(cx - rx, cy, rx, ry, 0, 0, 1, cx, cy - ry), ...arcToCubics(cx, cy - ry, rx, ry, 0, 0, 1, cx + rx, cy), ['Z']];
const rect = (x, y, w, h, r) => {
  r = Math.min(r, w / 2, h / 2);
  if (!r) return [['M', x, y], ['L', x + w, y], ['L', x + w, y + h], ['L', x, y + h], ['Z']];
  return [['M', x + r, y], ['L', x + w - r, y], ...arcToCubics(x + w - r, y, r, r, 0, 0, 1, x + w, y + r), ['L', x + w, y + h - r], ...arcToCubics(x + w, y + h - r, r, r, 0, 0, 1, x + w - r, y + h), ['L', x + r, y + h], ...arcToCubics(x + r, y + h, r, r, 0, 0, 1, x, y + h - r), ['L', x, y + r], ...arcToCubics(x, y + r, r, r, 0, 0, 1, x + r, y), ['Z']];
};

// an icon body -> list of {segs, fill, evenodd, stroke, width, cap}
export function bodyShapes(body) {
  const shapes = [];
  for (const m of body.matchAll(/<(path|circle|ellipse|rect)\b([^>]*?)\/?>/g)) {
    const a = Object.fromEntries([...m[2].matchAll(/([a-zA-Z-]+)="([^"]*)"/g)].map((x) => [x[1], x[2]]));
    const n = (k, dflt = 0) => (a[k] === undefined ? dflt : Number(a[k]));
    const segs = m[1] === 'path' ? parsePath(a.d || '') : m[1] === 'circle' ? ellipse(n('cx'), n('cy'), n('r'), n('r')) : m[1] === 'ellipse' ? ellipse(n('cx'), n('cy'), n('rx'), n('ry')) : rect(n('x'), n('y'), n('width'), n('height'), n('rx', n('ry')));
    const stroke = !!a.stroke && a.stroke !== 'none';
    shapes.push({ segs, fill: a.fill ? a.fill !== 'none' : !stroke, evenodd: a['fill-rule'] === 'evenodd', stroke, width: n('stroke-width', 1), cap: a['stroke-linecap'] });
  }
  return shapes;
}

// ---- PDF ----
const f = (v) => String(Math.round(v * 1000) / 1000);
const pdfStr = (s) => `(${s.replace(/[\\()]/g, '\\$&')})`;
const BG = '0.102 0.114 0.129', FG = '1 1 1', LABEL = '0.82 0.82 0.83';
const PAGE = { w: 612, h: 792 }, COLS = 9, MARGIN_X = 18, MARGIN_TOP = 22, CELL_H = 64, ICON = 30, FONT = 6.2;
// rough Helvetica advance: good enough to decide where a label wraps (it only wraps at hyphens)
const textWidth = (s) => [...s].reduce((w, c) => w + (c === '-' || c === 'i' || c === 'l' || c === 'j' || c === 't' || c === 'f' || c === 'r' ? 0.3 : c === 'm' || c === 'w' ? 0.8 : 0.52), 0) * FONT;
export function labelLines(name, max) {
  const parts = name.split('-'), lines = [];
  let cur = '';
  for (let i = 0; i < parts.length; i++) {
    const piece = parts[i] + (i < parts.length - 1 ? '-' : '');
    if (cur && textWidth(cur + piece) > max) { lines.push(cur); cur = piece; } else cur += piece;
  }
  if (cur) lines.push(cur);
  return lines;
}

function iconOps(shapes, scale, x, y) {
  const ops = [`q ${f(scale)} 0 0 ${f(-scale)} ${f(x)} ${f(y + ICON)} cm`];
  for (const s of shapes) {
    let p = '';
    for (const g of s.segs) p += g[0] === 'Z' ? 'h ' : g[0] === 'M' ? `${f(g[1])} ${f(g[2])} m ` : g[0] === 'L' ? `${f(g[1])} ${f(g[2])} l ` : `${f(g[1])} ${f(g[2])} ${f(g[3])} ${f(g[4])} ${f(g[5])} ${f(g[6])} c `;
    if (s.stroke) ops.push(`${FG} RG ${f(s.width)} w ${s.cap === 'round' ? '1 J 1 j' : '0 J 0 j'}`);
    ops.push(`${FG} rg ${p}${s.fill && s.stroke ? (s.evenodd ? 'B*' : 'B') : s.stroke ? 'S' : s.evenodd ? 'f*' : 'f'}`);
  }
  ops.push('Q');
  return ops.join('\n');
}

// returns a Buffer; identical input gives identical bytes (no dates), so an unchanged set never shows up as a diff
export function renderIconsPdf(set, { title = 'Slack icons' } = {}) {
  const names = Object.keys(set.icons);
  const cellW = (PAGE.w - 2 * MARGIN_X) / COLS, rows = Math.floor((PAGE.h - MARGIN_TOP - 14) / CELL_H), perPage = rows * COLS;
  const scale = ICON / set.width;
  const pages = [];
  for (let start = 0; start < names.length; start += perPage) {
    const ops = [`${BG} rg 0 0 ${PAGE.w} ${PAGE.h} re f`];
    names.slice(start, start + perPage).forEach((name, k) => {
      const col = k % COLS, row = Math.floor(k / COLS);
      const cx = MARGIN_X + col * cellW + cellW / 2, top = PAGE.h - MARGIN_TOP - row * CELL_H;
      let shapes = [];
      try { shapes = bodyShapes(set.icons[name].body); } catch { /* an unparseable glyph still gets its label */ }
      ops.push(iconOps(shapes, scale, cx - ICON / 2, top - ICON));
      labelLines(name, cellW - 4).slice(0, 3).forEach((line, li) => {
        ops.push(`BT /F1 ${FONT} Tf ${LABEL} rg ${f(cx - textWidth(line) / 2)} ${f(top - ICON - 10 - li * (FONT + 1.4))} Td ${pdfStr(line)} Tj ET`);
      });
    });
    pages.push(ops.join('\n'));
  }
  // objects: 1 catalog, 2 pages, 3 font, 4 info, then (page, content) pairs
  const objs = [null, '<< /Type /Catalog /Pages 2 0 R >>', null, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>', `<< /Title ${pdfStr(title)} >>`];
  const kids = [];
  const streams = new Map();
  pages.forEach((content, i) => {
    const pageId = 5 + i * 2, contentId = pageId + 1;
    kids.push(`${pageId} 0 R`);
    objs[pageId] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE.w} ${PAGE.h}] /Resources << /Font << /F1 3 0 R >> >> /Contents ${contentId} 0 R >>`;
    objs[contentId] = null;
    streams.set(contentId, zlib.deflateSync(Buffer.from(content, 'latin1'), { level: 9 }));
  });
  objs[2] = `<< /Type /Pages /Kids [${kids.join(' ')}] /Count ${kids.length} >>`;
  const chunks = [Buffer.from('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n', 'latin1')], offsets = [];
  let pos = chunks[0].length;
  const push = (b) => { chunks.push(b); pos += b.length; };
  for (let id = 1; id < objs.length; id++) {
    offsets[id] = pos;
    if (streams.has(id)) {
      const s = streams.get(id);
      push(Buffer.concat([Buffer.from(`${id} 0 obj\n<< /Length ${s.length} /Filter /FlateDecode >>\nstream\n`, 'latin1'), s, Buffer.from('\nendstream\nendobj\n', 'latin1')]));
    } else push(Buffer.from(`${id} 0 obj\n${objs[id]}\nendobj\n`, 'latin1'));
  }
  const xref = pos;
  let tail = `xref\n0 ${objs.length}\n0000000000 65535 f \n`;
  for (let id = 1; id < objs.length; id++) tail += `${String(offsets[id]).padStart(10, '0')} 00000 n \n`;
  tail += `trailer\n<< /Size ${objs.length} /Root 1 0 R /Info 4 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  push(Buffer.from(tail, 'latin1'));
  return Buffer.concat(chunks);
}
