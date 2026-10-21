#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// Daily changelog feed.  node src/feed.mjs <site-dir> <site-url> [--since <git-ref>]
// Compares build/*.txt and build/experiments.json at HEAD with the last commit older than 24h (or --since), prepends one item
// for today to <site-dir>/items.json (kept: 90 days) and rewrites feed.xml + index.html. A day with no changes adds no item.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const [site, url] = process.argv.slice(2, 4);
if (!site || !url) { console.error('usage: feed.mjs <site-dir> <site-url> [--since ref]'); process.exit(1); }
const sinceArg = process.argv.indexOf('--since') > -1 ? process.argv[process.argv.indexOf('--since') + 1] : null;
const git = (...a) => execFileSync('git', a, { encoding: 'utf8', maxBuffer: 1 << 28, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
const show = (ref, f) => { try { return git('show', `${ref}:${f}`); } catch { return null; } };
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const CAP = 150;

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

const section = (title, list, sign) => list.length
  ? `<h3>${esc(title)} (${list.length})</h3><ul>${list.slice(0, CAP).map((x) => `<li>${sign}<code>${esc(x)}</code></li>`).join('')}${list.length > CAP ? `<li>…and ${list.length - CAP} more</li>` : ''}</ul>` : '';

function buildItem() {
  const base = sinceArg || git('rev-list', '-1', '--before=24 hours ago', 'HEAD') || git('rev-list', '--max-parents=0', 'HEAD').split('\n')[0];
  const head = git('rev-parse', 'HEAD');
  if (base === head) return null;
  const files = git('ls-tree', '--name-only', 'HEAD', 'build/').split('\n').filter((f) => /\.(txt|json)$/.test(f) && !/meta\.json$/.test(f));
  let html = '', total = 0;
  const build = (JSON.parse(show('HEAD', 'build/meta.json') ?? '{}')).buildNumber;
  for (const f of files) {
    const name = path.basename(f).replace(/\.(txt|json)$/, '');
    if (f.endsWith('experiments.txt')) continue; // experiments.json covers it
    let added, removed, extra = [];
    if (f.endsWith('experiments.json')) {
      const d = diffExperiments(show(base, f), show('HEAD', f));
      ({ added, removed } = d); extra = d.groups;
    } else ({ added, removed } = diffSets(lines(show(base, f)), lines(show('HEAD', f))));
    total += added.length + removed.length + extra.length;
    html += section(`${name}: new`, added, '+ ') + section(`${name}: gone`, removed, '− ') + section(`${name}: new groups`, extra, '');
  }
  if (!total) return null;
  const date = new Date().toISOString().slice(0, 10);
  return { id: `${url}/#${date}`, date, title: `Slack client changes ${date} (build ${build})`, html: `<p>${total} changes since ${base.slice(0, 7)}.</p>${html}` };
}

const itemsFile = path.join(site, 'items.json');
const items = fs.existsSync(itemsFile) ? JSON.parse(fs.readFileSync(itemsFile, 'utf8')) : [];
const item = buildItem();
if (item && !items.some((i) => i.id === item.id)) items.unshift(item);
const cutoff = new Date(Date.now() - 90 * 864e5).toISOString().slice(0, 10);
const kept = items.filter((i) => i.date >= cutoff);
fs.mkdirSync(site, { recursive: true });
fs.writeFileSync(itemsFile, JSON.stringify(kept, null, 1) + '\n');
const rss = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel><title>slack-datamine-plus daily changes</title><link>${esc(url)}</link><description>Daily summary of what changed in Slack's web client bundle.</description>
${kept.map((i) => `<item><title>${esc(i.title)}</title><guid isPermaLink="false">${esc(i.id)}</guid><link>${esc(url)}</link><pubDate>${new Date(i.date + 'T06:30:00Z').toUTCString()}</pubDate><description>${esc(i.html)}</description></item>`).join('\n')}
</channel></rss>
`;
fs.writeFileSync(path.join(site, 'feed.xml'), rss);
// uses the site's own stylesheet and theme script (dark mode toggle) from the root of *.izie.top
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
  </head>
  <body>
    <main>
      <h1>slack-datamine-plus changes</h1>
      <p><a href="feed.xml">RSS feed</a></p>
${kept.map((i) => `      <h2>${esc(i.title)}</h2>\n${i.html}`).join('\n')}
    </main>
  </body>
</html>
`);
console.log(item ? `added ${item.title}` : 'no changes today');
