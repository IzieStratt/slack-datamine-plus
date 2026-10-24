#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// Daily changelog feed.  node src/feed.mjs <site-dir> <site-url> [--since <git-ref>]
// Compares build/*.txt and build/experiments.json at HEAD with the last commit older than 24h (or --since), prepends one item
// for today to <site-dir>/items.json (kept: 90 days) and rewrites feed.xml + index.html. A day with no changes adds no item.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { SEARCH_CSS, pills, searchHtml } from './ui.mjs';

const [site, url] = process.argv.slice(2, 4);
if (!site || !url) { console.error('usage: feed.mjs <site-dir> <site-url> [--since ref]'); process.exit(1); }
const sinceArg = process.argv.indexOf('--since') > -1 ? process.argv[process.argv.indexOf('--since') + 1] : null;
// `url` is the base of the item ids (guids) and must not change, or readers show every item twice; `--link` is where the feed points readers now
const linkBase = process.argv.indexOf('--link') > -1 ? process.argv[process.argv.indexOf('--link') + 1] : url;
const git = (...a) => execFileSync('git', a, { encoding: 'utf8', maxBuffer: 1 << 28, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
const show = (ref, f) => { try { return git('show', `${ref}:${f}`); } catch { return null; } };
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const CAP = 25; // shown up front; the rest sits in an expander

export const lines = (t) => new Set((t ?? '').split('\n').filter(Boolean));
export function diffSets(a, b) {
  return { added: [...b].filter((x) => !a.has(x)).sort(), removed: [...a].filter((x) => !b.has(x)).sort() };
}
// experiments.json: name -> groups; report new/removed experiments and new groups on existing ones
export function diffExperiments(oldJson, newJson) {
  const o = JSON.parse(oldJson ?? '{}'), n = JSON.parse(newJson ?? '{}');
  const d = diffSets(new Set(Object.keys(o)), new Set(Object.keys(n)));
  const groups = Object.keys(n).filter((k) => k in o && n[k].some((g) => !o[k].includes(g))).map((k) => `${k}: +${n[k].filter((g) => !o[k].includes(g)).join(', ')}`);
  return { added: d.added.map((k) => (n[k].length ? `${k} [${n[k].join(', ')}]` : k)), removed: d.removed, groups };
}

// each category collapses; "…and N more" expands to the rest of the list (<details> still shows its content in readers that strip it)
const li = (list, sign) => list.map((x) => `<li>${sign}<code>${esc(x)}</code></li>`).join('');
const section = (title, list, sign) => list.length
  ? `<details open><summary><strong>${esc(title)} (${list.length})</strong></summary><ul>${li(list.slice(0, CAP), sign)}</ul>${list.length > CAP ? `<details><summary>…and ${list.length - CAP} more</summary><ul>${li(list.slice(CAP), sign)}</ul></details>` : ''}</details>` : '';

// Everything that was ever added to a category file up to <ref>. A value that comes back after being gone is not "new": it was reported before.
const everAdded = (ref, f) => {
  return new Set(git('log', ref, '--format=', '-p', '--no-color', '--', f).split('\n').filter((l) => l.startsWith('+') && !l.startsWith('+++')).map((l) => l.slice(1)));
};
// categories whose names are content hashes of the bundle: every build "adds" and "removes" all of them
const SKIP = new Set(['chunks', 'experiments.txt']); // experiments.json covers experiments.txt

// `base` is the commit the previous item was computed up to (state.json), not "24 hours ago": a window that drifts overlaps the one before
// it and re-reports the same changes. A category file that did not exist at `base` is reported as a new category, never dropped.
function buildItem(base, head) {
  if (!base || base === head) return null;
  const files = git('ls-tree', '--name-only', 'HEAD', 'build/').split('\n').filter((f) => /\.(txt|json)$/.test(f) && !/(meta|icons|health|components|redux)\.json$/.test(f));
  let html = '', total = 0;
  const build = (JSON.parse(show('HEAD', 'build/meta.json') ?? '{}')).buildNumber;
  for (const f of files) {
    const name = path.basename(f).replace(/\.(txt|json)$/, '');
    if (SKIP.has(name) || SKIP.has(path.basename(f))) continue;
    const before = show(base, f);
    const fresh = before === null; // category file first appeared since the last report: reported in full, labelled as such
    let added, removed, extra = [];
    if (f.endsWith('experiments.json')) {
      const d = diffExperiments(before, show('HEAD', f));
      ({ added, removed } = d); extra = d.groups;
    } else {
      ({ added, removed } = diffSets(lines(before), lines(show('HEAD', f))));
      if (added.length) { const seen = everAdded(base, f); added = added.filter((x) => !seen.has(x)); }
    }
    total += added.length + removed.length + extra.length;
    html += section(`${name}: ${fresh ? 'new category' : 'new'}`, added, '+ ') + section(`${name}: gone`, removed, '− ') + section(`${name}: new groups`, extra, '');
  }
  if (!total) return null;
  const date = new Date().toISOString().slice(0, 10);
  return { id: `${url}/#${date}`, date, base, title: `Slack client changes ${date} (build ${build})`, html: `<p>${total} changes since ${base.slice(0, 7)}.</p>${html}` };
}

const itemsFile = path.join(site, 'items.json');
const items = fs.existsSync(itemsFile) ? JSON.parse(fs.readFileSync(itemsFile, 'utf8')) : [];
const stateFile = path.join(site, 'state.json');
const state = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, 'utf8')) : {};
const head = git('rev-parse', 'HEAD');
const today = `${url}/#${new Date().toISOString().slice(0, 10)}`;
// a second run on the same day extends today's item from the same starting point instead of reporting only its own slice
const base = items.find((i) => i.id === today)?.base || state.lastCommit || sinceArg;
let item = null;
try { item = buildItem(base && git('rev-parse', base), head); } catch (e) { console.error(`feed: could not diff from ${base}: ${e.message}`); process.exit(1); } // fail before state.json moves, so nothing is skipped
// a rerun that now finds nothing must not leave today's earlier item up
if (!item) { const at = items.findIndex((i) => i.id === today); if (at > -1) items.splice(at, 1); }
if (item) { const at = items.findIndex((i) => i.id === item.id); if (at > -1) items[at] = item; else items.unshift(item); }
fs.mkdirSync(site, { recursive: true });
fs.writeFileSync(stateFile, JSON.stringify({ lastCommit: head }, null, 1) + '\n');
const cutoff = new Date(Date.now() - 90 * 864e5).toISOString().slice(0, 10);
const kept = items.filter((i) => i.date >= cutoff);
fs.mkdirSync(site, { recursive: true });
fs.writeFileSync(itemsFile, JSON.stringify(kept, null, 1) + '\n');
const rss = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel><title>slack-datamine-plus daily changes</title><link>${esc(linkBase)}</link><description>Daily summary of what changed in Slack's web client bundle.</description>
${kept.map((i) => `<item><title>${esc(i.title)}</title><guid isPermaLink="false">${esc(i.id)}</guid><link>${esc(linkBase)}</link><pubDate>${new Date(i.date + 'T06:30:00Z').toUTCString()}</pubDate><description>${esc(i.html)}</description></item>`).join('\n')}
</channel></rss>
`;
fs.writeFileSync(path.join(site, 'feed.xml'), rss);
// uses the site's own stylesheet and theme script (dark mode toggle) from the root of *.izie.top; links reuse its pill `nav a` style.
// icons.html is linked as /icons: the site serves .html files without the extension and 307s the long form
const has = (f) => fs.existsSync(path.join(site, f));
const links = [['feed.xml', 'RSS feed'], ...(has('icons.html') ? [['icons', 'Slack icons']] : []), ...(has('icons.pdf') ? [['icons.pdf', 'Icons (PDF)']] : []), ...(has('icons-diff.pdf') ? [['icons-diff.pdf', 'Icon changes (PDF)']] : []), ['https://vs.izie.top/redocumented', 'ReDocumented'], ['https://github.com/IzieStratt/slack-datamine-plus', 'Source']];
fs.writeFileSync(path.join(site, 'index.html'), `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>slack-datamine-plus changes</title>
    <link rel="icon" href="/favicon.svg" type="image/svg+xml">
    <link rel="alternate" type="application/rss+xml" href="feed.xml">
    <link rel="stylesheet" href="/style.css">
    <script src="/cdn/theme.js"></script>
    <style>${SEARCH_CSS}
      .item { content-visibility: auto; contain-intrinsic-size: auto 800px; }
    </style>
  </head>
  <body>
    <main>
      <h1>slack-datamine-plus changes</h1>
      ${pills(links)}
      ${searchHtml('Search every change (e.g. agent, bluesky, SCOPE)', 'Search changes')}
${kept.map((i) => `      <section class="item"><h2>${esc(i.title)}</h2>\n${i.html}</section>`).join('\n')}
    </main>
    <script>
      // Search over every listed value, built to stay quick on a page with tens of thousands of rows:
      // the text index is built on the first search, input is debounced, typing more only re-checks rows that still matched,
      // and a row is only touched when its state changes. Categories and days with no match hide; matching categories open.
      const q = document.getElementById('q'), count = document.getElementById('count');
      const items = [...document.querySelectorAll('.item')];
      let idx = null, last = '', timer;
      function build() {
        idx = items.map((el) => ({ el, cats: [...el.querySelectorAll(':scope > details')].map((d) => {
          const lis = [...d.querySelectorAll('li')];
          return { d, lis, t: lis.map((l) => l.textContent.toLowerCase()), on: new Uint8Array(lis.length).fill(1), open: d.open, nested: [...d.querySelectorAll('details')] };
        }) }));
      }
      function run() {
        let term = q.value.trim().toLowerCase().replace(/\\s+/g, ' ');
        const short = term.length > 0 && term.length < 2; // one character matches nearly everything
        if (short) term = '';
        if (term === last && !short) return;
        const narrower = last !== '' && term.startsWith(last); // appending only removes matches
        last = term;
        if (!idx) build();
        const terms = term ? term.split(' ') : [];
        let hits = 0;
        for (const it of idx) {
          let any = !term;
          for (const c of it.cats) {
            let n = 0;
            for (let i = 0; i < c.lis.length; i++) {
              if (!(narrower && !c.on[i])) {
                const v = terms.every((t) => c.t[i].includes(t)) ? 1 : 0;
                if (c.on[i] !== v) { c.on[i] = v; c.lis[i].hidden = !v; }
              }
              n += c.on[i];
            }
            c.d.hidden = !!term && !n; c.d.open = term ? n > 0 : c.open; any = any || n > 0; hits += term ? n : 0;
            for (const x of c.nested) { x.open = !!term; x.hidden = !!term && !x.querySelector('li:not([hidden])'); }
          }
          it.el.hidden = !!term && !any;
        }
        count.textContent = short ? 'type at least 2 characters' : term ? hits + ' match' + (hits === 1 ? '' : 'es') : '';
      }
      q.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(run, 80); });
    </script>
  </body>
</html>
`);
console.log(item ? `added ${item.title}` : 'no changes today');
