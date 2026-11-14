#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// Daily changelog feed.  node src/feed.mjs <site-dir> <site-url> [--since <git-ref>] [--render-only]
// --render-only rewrites feed.xml, index.html and days/ from the stored items.json without diffing or moving state.json (for page changes).
// Compares build/*.txt and build/experiments.json at HEAD with the last commit older than 24h (or --since), prepends one item
// for today to <site-dir>/items.json (kept: 90 days) and rewrites feed.xml + index.html. A day with no changes adds no item.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { SEARCH_CSS, pills, searchHtml } from './ui.mjs';
import { esc, itemSlug, renderRss, siteItemHtml, splitItem } from './feed-lib.mjs';

const [site, url] = process.argv.slice(2, 4);
if (!site || !url) { console.error('usage: feed.mjs <site-dir> <site-url> [--since ref]'); process.exit(1); }
const sinceArg = process.argv.indexOf('--since') > -1 ? process.argv[process.argv.indexOf('--since') + 1] : null;
// `url` is the base of the item ids (guids) and must not change, or readers show every item twice; `--link` is where the feed points readers now
const linkBase = process.argv.indexOf('--link') > -1 ? process.argv[process.argv.indexOf('--link') + 1] : url;
const git = (...a) => execFileSync('git', a, { encoding: 'utf8', maxBuffer: 1 << 28, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
const show = (ref, f) => { try { return git('show', `${ref}:${f}`); } catch { return null; } };
const WATCH = new RegExp(fs.readFileSync(new URL('./watch-keywords.txt', import.meta.url), 'utf8').split('\n').filter((l) => l && !l.startsWith('#')).join('|'), 'i');
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
  const files = git('ls-tree', '--name-only', 'HEAD', 'build/').split('\n').filter((f) => /\.(txt|json)$/.test(f) && !/(meta|icons|health|components|redux|taut-presence)\.json$/.test(f));
  let html = '', total = 0;
  const hits = []; // values matching src/watch-keywords.txt in any category, so a themed rollout is not buried in a long list
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
    for (const [list, sign] of [[added, '+ '], [removed, '− '], [extra, '']]) for (const x of list) if (WATCH.test(x)) hits.push(`${sign}${name}: ${x}`);
    html += section(`${name}: ${fresh ? 'new category' : 'new'}`, added, '+ ') + section(`${name}: gone`, removed, '− ') + section(`${name}: new groups`, extra, '');
  }
  if (!total) return null;
  const date = new Date().toISOString().slice(0, 10);
  return { id: `${url}/#${date}`, date, base, title: `Slack client changes ${date} (build ${build})`, html: `<p>${total} changes since ${base.slice(0, 7)}.</p>${section('watch: keyword matches', hits, '')}${html}` };
}

// "New" row at the top: the latest item's additions flattened to chips, read back from its stored html so older items work too
const NEW_CHIPS = 10; // values shown per category
function freshPanel(i) {
  if (!i) return '';
  const unesc = (x) => x.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&');
  const cats = i.html.split('<details open>').slice(1).map((c) => ({
    name: unesc(c.match(/<strong>([^<]*?)(?::\s*(?:new category|new))?\s*\(\d+\)<\/strong>/)?.[1] ?? ''),
    isNew: /<strong>[^<]*: new(?: category)? \(\d+\)/.test(c) || /<strong>watch: /.test(c),
    vals: [...c.matchAll(/<li>\+ <code>(.*?)<\/code>/g)].map((m) => unesc(m[1])),
  })).filter((c) => c.isNew && c.vals.length).sort((a, b) => (b.name.startsWith('watch') - a.name.startsWith('watch')) || b.vals.length - a.vals.length);
  if (!cats.length) return '';
  const chip = (v) => `<button type="button" class="chip" data-q="${esc(v)}">${esc(v.length > 60 ? v.slice(0, 59) + '…' : v)}</button>`;
  return `<section id="fresh"><h2>New in ${esc(i.title.replace(/^Slack client changes /, ''))}</h2>${cats.map((c) => `<div class="fresh-row"><button type="button" class="cat" data-q="${esc(c.name.replace(/^watch$/, ''))}">${esc(c.name)} <small>${c.vals.length}</small></button>${c.vals.slice(0, NEW_CHIPS).map(chip).join('')}${c.vals.length > NEW_CHIPS ? `<span class="more">+${c.vals.length - NEW_CHIPS} more</span>` : ''}</div>`).join('')}</section>`;
}

const itemsFile = path.join(site, 'items.json');
const items = fs.existsSync(itemsFile) ? JSON.parse(fs.readFileSync(itemsFile, 'utf8')) : [];
const stateFile = path.join(site, 'state.json');
const state = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, 'utf8')) : {};
const renderOnly = process.argv.includes('--render-only');
const head = renderOnly ? null : git('rev-parse', 'HEAD');
const today = `${url}/#${new Date().toISOString().slice(0, 10)}`;
// a second run on the same day extends today's item from the same starting point instead of reporting only its own slice
const base = items.find((i) => i.id === today)?.base || state.lastCommit || sinceArg;
let item = null;
if (!renderOnly) try { item = buildItem(base && git('rev-parse', base), head); } catch (e) { console.error(`feed: could not diff from ${base}: ${e.message}`); process.exit(1); } // fail before state.json moves, so nothing is skipped
// a rerun that now finds nothing must not leave today's earlier item up
if (!item && !renderOnly) { const at = items.findIndex((i) => i.id === today); if (at > -1) items.splice(at, 1); }
if (item) { const at = items.findIndex((i) => i.id === item.id); if (at > -1) items[at] = item; else items.unshift(item); }
fs.mkdirSync(site, { recursive: true });
if (!renderOnly) fs.writeFileSync(stateFile, JSON.stringify({ lastCommit: head }, null, 1) + '\n');
const cutoff = new Date(Date.now() - 90 * 864e5).toISOString().slice(0, 10);
const kept = items.filter((i) => i.date >= cutoff);
fs.mkdirSync(site, { recursive: true });
fs.writeFileSync(itemsFile, JSON.stringify(kept, null, 1) + '\n');
const rss = renderRss(kept, { linkBase });
fs.writeFileSync(path.join(site, 'feed.xml'), rss);
// uses the site's own stylesheet and theme script (dark mode toggle) from the root of *.izie.top; links reuse its pill `nav a` style.
// icons.html is linked as /icons: the site serves .html files without the extension and 307s the long form
// full lists per day for the page's "…and N more" expanders and search; the page itself only carries the first CAP rows of each
const daysDir = path.join(site, 'days');
fs.mkdirSync(daysDir, { recursive: true });
const parts = kept.map((i) => splitItem(i.html));
const slugs = new Set(kept.map((i) => `${itemSlug(i)}.json`));
for (const f of fs.readdirSync(daysDir)) if (!slugs.has(f)) fs.rmSync(path.join(daysDir, f));
kept.forEach((i, n) => fs.writeFileSync(path.join(daysDir, `${itemSlug(i)}.json`), JSON.stringify({ cats: parts[n].cats.map(({ t, s, v }) => ({ t, s, v })) })));
const client = fs.readFileSync(new URL('./feed-client.js', import.meta.url), 'utf8');
const has = (f) => fs.existsSync(path.join(site, f));
const links = [['feed.xml', 'RSS feed'], ...(has('icons.html') ? [['icons', 'Slack icons']] : []), ['https://vs.izie.top/redocumented', 'ReDocumented'], ['https://github.com/IzieStratt/slack-datamine-plus', 'Source']];
fs.writeFileSync(path.join(site, 'index.html'), `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>slack-datamine-plus changes</title>
    <meta name="description" content="Daily summary of what changed in Slack's web client bundle: new and removed API methods, components, errors, experiments and more.">
    <meta property="og:type" content="website">
    <meta property="og:title" content="slack-datamine-plus changes">
    <meta property="og:description" content="Daily summary of what changed in Slack's web client bundle: new and removed API methods, components, errors, experiments and more.">
    <meta property="og:url" content="${esc(linkBase)}/">
    <meta name="twitter:card" content="summary">
    <link rel="icon" href="/favicon.svg" type="image/svg+xml">
    <link rel="alternate" type="application/rss+xml" href="feed.xml">
    <link rel="stylesheet" href="/style.css">
    <script src="/cdn/theme.js"></script>
    <style>${SEARCH_CSS}
      .item { content-visibility: auto; contain-intrinsic-size: auto 800px; }
      #fresh { margin: 0 0 1.5rem; padding: .75rem 1rem; border: 2px solid var(--fg); border-radius: 1rem; }
      #fresh h2 { margin: 0 0 .5rem; }
      .fresh-row { display: flex; flex-wrap: wrap; align-items: center; gap: .35rem; margin: .35rem 0; }
      #fresh button { font: inherit; font-size: .9rem; color: var(--fg); background: transparent; border: 1px solid var(--fg); border-radius: 999px; padding: .1rem .6rem; cursor: pointer; }
      #fresh .cat { font-weight: 700; border-width: 2px; }
      #fresh .chip { font-family: monospace; }
      #fresh button:hover, #fresh button:focus-visible { border-color: var(--focus); outline: none; }
      #fresh .more { opacity: .65; font-size: .9rem; }
      #results details > ul + .all, #results .all { font: inherit; font-size: .9rem; color: var(--fg); background: transparent; border: 1px solid var(--fg); border-radius: 999px; padding: .1rem .6rem; cursor: pointer; margin: 0 0 .5rem; }
      #results small { opacity: .7; }
      mark { background: color-mix(in srgb, var(--focus) 35%, transparent); color: inherit; border-radius: 2px; }
    </style>
  </head>
  <body>
    <main>
      <h1>slack-datamine-plus changes</h1>
      ${pills(links)}
      ${searchHtml('Search every change: a name, a category, a day (press /)', 'Search changes')}
      ${freshPanel(kept[0])}
${kept.map((i, n) => `      <section class="item" id="${esc(itemSlug(i))}"><h2>${esc(i.title)}</h2>\n${siteItemHtml(parts[n], CAP)}</section>`).join('\n')}
      <div id="results"></div>
    </main>
    <script>const CAP = ${CAP};
${client}    </script>
  </body>
</html>
`);
console.log(renderOnly ? 'rendered' : item ? `added ${item.title}` : 'no changes today');
