#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// A self-contained static search page over every tracked category, with each value's history (build/history.tsv) and, for API
// methods and flags, the platforms it was found on (build/cross-platform.json). One HTML file, data inlined, no network, no deps.
//   node src/search-page.mjs [--out search-site/dist/index.html]
// Not deployed. See README "Search page" for how it would be published on sdmp.izie.top (from personal-site, not from here).
import fs from 'node:fs';
import path from 'node:path';
import { parseIndex } from './history.mjs';
import { esc } from './feed-lib.mjs';

// compact columns: categories and dates are interned, rows are [cat, value, first, last, removed, platforms] (-1 / 0 = none)
export function searchData(index, cross = null) {
  const cats = [...index.keys()].sort();
  const dates = [...new Set([...index.values()].flatMap((m) => [...m.values()].flatMap((e) => [e.first, e.last, e.removed]).filter(Boolean)))].sort();
  const di = new Map(dates.map((d, i) => [d, i]));
  const PL = ['web', 'desktop', 'android', 'ios'];
  const bits = (ps) => (ps ?? []).reduce((b, p) => b | (1 << PL.indexOf(p)), 0);
  const platformsOf = (cat, v) => {
    if (!cross) return 0;
    if (/(^|\/)api-methods$/.test(cat)) return bits(cross.apiMethods?.[v]);
    if (cat === 'experiments' || /(^|\/)(feature-flags|shared-flags)$/.test(cat)) return bits(cross.featureFlags?.[v.includes(': ') ? v.slice(v.indexOf(': ') + 2) : v]);
    return 0;
  };
  const rows = [];
  cats.forEach((c, ci) => {
    for (const [v, e] of index.get(c)) rows.push([ci, v, di.get(e.first), e.last ? di.get(e.last) : -1, e.removed ? di.get(e.removed) : -1, platformsOf(c, v)]);
  });
  return { v: 1, platforms: PL, cats, dates, rows };
}

// JSON inside <script type="application/json">: only "</" (and the U+2028/9 line breaks old parsers choke on) need escaping
const inlineJson = (o) => JSON.stringify(o).replace(/<\//g, '<\\/').replace(/[\u2028\u2029]/g, (c) => `\\u${c.charCodeAt(0).toString(16)}`);

export function searchPage(data, { title = 'slack-datamine-plus search', generated = '' } = {}) {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${esc(title)}</title>
    <meta name="description" content="Search every list slack-datamine-plus tracks, with when each value was first seen and when it went away.">
    <style>
      :root { --bg: #fff; --fg: #1d1c1d; --muted: #616061; --line: #ddd; --add: #007a5a; --gone: #c0392b; --focus: #1264a3; color-scheme: light dark; }
      @media (prefers-color-scheme: dark) { :root { --bg: #1a1d21; --fg: #e8e8e8; --muted: #a0a0a0; --line: #3a3d42; --add: #2bac76; --gone: #e06c5f; --focus: #4aa3df; } }
      * { box-sizing: border-box; }
      body { margin: 0; background: var(--bg); color: var(--fg); font: 16px/1.45 system-ui, sans-serif; }
      main { max-width: 64rem; margin: 0 auto; padding: 1rem; }
      h1 { font-size: 1.4rem; margin: .5rem 0 1rem; }
      form { display: flex; flex-wrap: wrap; gap: .5rem; margin-bottom: .75rem; }
      input, select { font: inherit; color: var(--fg); background: var(--bg); border: 1px solid var(--line); border-radius: .4rem; padding: .35rem .6rem; min-width: 0; }
      input[type=search] { flex: 1 1 16rem; }
      input:focus, select:focus { outline: 2px solid var(--focus); outline-offset: 1px; }
      #status { color: var(--muted); font-size: .9rem; margin: 0 0 .5rem; }
      table { width: 100%; border-collapse: collapse; font-size: .9rem; }
      th, td { text-align: left; padding: .3rem .4rem; border-bottom: 1px solid var(--line); vertical-align: top; }
      th { color: var(--muted); font-weight: 600; }
      td.v { font-family: ui-monospace, monospace; overflow-wrap: anywhere; }
      td.d { white-space: nowrap; }
      .gone { color: var(--gone); }
      .new { color: var(--add); }
      .pl { color: var(--muted); font-size: .8rem; }
      @media (max-width: 40rem) { th.c, td.c { display: none; } }
    </style>
  </head>
  <body>
    <main>
      <h1>${esc(title)}</h1>
      <form role="search" onsubmit="return false">
        <input type="search" id="q" placeholder="Search a value (press /)" aria-label="Search" autofocus>
        <select id="cat" aria-label="Category"><option value="">every category</option></select>
        <select id="st" aria-label="Status"><option value="">listed or removed</option><option value="on">still listed</option><option value="gone">removed</option></select>
      </form>
      <p id="status" aria-live="polite"></p>
      <table><thead><tr><th>Value</th><th class="c">Category</th><th>First seen</th><th>Removed</th></tr></thead><tbody id="out"></tbody></table>
      <p id="foot" class="pl">${generated ? `Data as of ${esc(generated)}. ` : ''}First seen = the first commit of slack-datamine-plus's build/ that listed it (history starts when this repo did). Platforms: where the cross-platform table found it (iOS is never mined).</p>
    </main>
    <script type="application/json" id="data">${inlineJson(data)}</script>
    <script>
      const D = JSON.parse(document.getElementById('data').textContent);
      const $ = (id) => document.getElementById(id);
      const LIMIT = 300;
      for (const c of D.cats) $('cat').append(new Option(c, c));
      const lower = D.rows.map((r) => r[1].toLowerCase());
      const td = (text, cls) => { const e = document.createElement('td'); e.textContent = text; if (cls) e.className = cls; return e; };
      function render() {
        const q = $('q').value.trim().toLowerCase(), cat = D.cats.indexOf($('cat').value), st = $('st').value;
        const out = [];
        let n = 0;
        for (let i = 0; i < D.rows.length; i++) {
          const r = D.rows[i];
          if (cat > -1 && r[0] !== cat) continue;
          if (st === 'on' && r[4] > -1 || st === 'gone' && r[4] < 0) continue;
          if (q && !lower[i].includes(q)) continue;
          if (++n <= LIMIT) out.push(r);
        }
        // exact matches first, then recent first-seen
        out.sort((a, b) => (b[1].toLowerCase() === q) - (a[1].toLowerCase() === q) || b[2] - a[2]);
        const rows = out.map((r) => {
          const tr = document.createElement('tr');
          const v = td(r[1], 'v');
          if (r[5]) { const s = document.createElement('div'); s.className = 'pl'; s.textContent = D.platforms.filter((_, k) => r[5] & (1 << k)).join(' · '); v.append(s); }
          tr.append(v, td(D.cats[r[0]], 'c'), td(D.dates[r[2]], 'd new'), td(r[4] > -1 ? D.dates[r[4]] + ' (last ' + D.dates[r[3]] + ')' : '', 'd gone'));
          return tr;
        });
        $('out').replaceChildren(...rows);
        $('status').textContent = n ? (n > LIMIT ? 'Showing ' + LIMIT + ' of ' + n + ' matches' : n + (n === 1 ? ' match' : ' matches')) : 'No matches';
      }
      let t;
      for (const id of ['q', 'cat', 'st']) $(id).addEventListener('input', () => { clearTimeout(t); t = setTimeout(render, 120); });
      addEventListener('keydown', (e) => { if (e.key === '/' && document.activeElement !== $('q')) { e.preventDefault(); $('q').focus(); } });
      const h = new URLSearchParams(location.hash.slice(1));
      if (h.get('q')) $('q').value = h.get('q');
      if (h.get('cat')) $('cat').value = h.get('cat');
      render();
    </script>
  </body>
</html>
`;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const out = process.argv.includes('--out') ? process.argv[process.argv.indexOf('--out') + 1] : 'search-site/dist/index.html';
  if (!fs.existsSync('build/history.tsv')) { console.error('build/history.tsv missing: run node src/history.mjs --rebuild'); process.exit(1); }
  const index = parseIndex(fs.readFileSync('build/history.tsv', 'utf8'));
  const cross = fs.existsSync('build/cross-platform.json') ? JSON.parse(fs.readFileSync('build/cross-platform.json', 'utf8')) : null;
  const meta = fs.existsSync('build/meta.json') ? JSON.parse(fs.readFileSync('build/meta.json', 'utf8')) : {};
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, searchPage(searchData(index, cross), { generated: [meta.capturedDate, meta.buildNumber && `build ${meta.buildNumber}`].filter(Boolean).join(', ') }));
  console.log(`search page: ${out} (${(fs.statSync(out).size / 1e6).toFixed(1)} MB)`);
}
