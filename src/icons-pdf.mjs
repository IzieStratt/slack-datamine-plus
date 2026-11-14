#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// Publish build/icons.json (the glyph set mined from Slack's client) as a gallery page, PDFs, an SVG sprite and the raw JSON.
//   node src/icons-pdf.mjs <site-dir> [--icons build/icons.json] [--host sdmp.izie.top]
// Writes into <site-dir>: icons.html, icons.pdf, icons.svg, icons.json (current set), icons-prev.json (the set before the last change),
// icons-diff.pdf (what changed between those two; removed when nothing did) and icons.sha256. When the set is unchanged and the outputs
// are current nothing is rewritten, so only a real icon change (added, removed or redrawn glyph) produces a diff.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { diffIconSets, hasChanges, renderDiffPdf, renderIconPage, renderIconSvg, renderIconsHtml, renderIconsPdf, renderIconsSprite, validName } from './icons.mjs';

const FORMAT = 'v5'; // bump when the output formats change so every file is rebuilt once
const site = process.argv[2];
if (!site) { console.error('usage: icons-pdf.mjs <site-dir> [--icons file] [--host name]'); process.exit(1); }
const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > -1 ? process.argv[i + 1] : d; };
const iconsFile = arg('icons', 'build/icons.json');
const host = arg('host', 'sdmp.izie.top');
if (!fs.existsSync(iconsFile)) { console.log('no icon set mined yet'); process.exit(0); }
const raw = fs.readFileSync(iconsFile, 'utf8');
const notes = JSON.parse(fs.readFileSync(new URL('./icon-notes.json', import.meta.url), 'utf8')); // hand-written facts about single icons
const at = (f) => path.join(site, f);
const readJson = (f) => (fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : {});
const descs = readJson(new URL('./icon-descriptions.json', import.meta.url)); // where each icon is used and what we think it is for
const labels = readJson(at('icons-desc-overrides.json')); // hand-checked short labels (personal-site)
const usage = readJson(at('icons-usage.json')); // usage counts, nearby UI strings and code (personal-site scripts/slack-icon-usage.py)
// everything shown on the pages is part of the tag, so editing a note or description rebuilds them
const tag = `${crypto.createHash('sha256').update(raw + JSON.stringify([notes, descs, labels, usage])).digest('hex')} ${FORMAT}`;
const outputs = ['icons.pdf', 'icons.html', 'icons.svg', 'icons.json', 'icons'];
if (fs.existsSync(at('icons.sha256')) && fs.readFileSync(at('icons.sha256'), 'utf8').trim() === tag && outputs.every((f) => fs.existsSync(at(f)))) { console.log('icons unchanged'); process.exit(0); }

fs.mkdirSync(site, { recursive: true });
// the set before this one: when the published set differs from the new one it becomes "previous"
if (fs.existsSync(at('icons.json'))) {
  const published = fs.readFileSync(at('icons.json'), 'utf8');
  if (JSON.parse(published).icons && JSON.stringify(JSON.parse(published)) !== JSON.stringify(JSON.parse(raw))) fs.writeFileSync(at('icons-prev.json'), published);
}
const set = JSON.parse(raw);
const prev = fs.existsSync(at('icons-prev.json')) ? JSON.parse(fs.readFileSync(at('icons-prev.json'), 'utf8')) : null;
const diff = prev ? diffIconSets(prev, set) : null;
const diffPdf = hasChanges(diff);
const url = (f) => `https://${host}/${f}`;
fs.writeFileSync(at('icons.json'), raw);
fs.writeFileSync(at('icons.pdf'), renderIconsPdf(set, { title: 'Slack icons', header: [{ text: `${host}/icons.pdf`, url: url('icons.pdf') }, ...(diffPdf ? [{ text: `Changes: ${host}/icons-diff.pdf`, url: url('icons-diff.pdf') }] : [])] }));
if (diffPdf) fs.writeFileSync(at('icons-diff.pdf'), renderDiffPdf(prev, set, diff, { header: [{ text: `${host}/icons-diff.pdf`, url: url('icons-diff.pdf') }, { text: `All icons: ${host}/icons.pdf`, url: url('icons.pdf') }] }));
else fs.rmSync(at('icons-diff.pdf'), { force: true });
fs.writeFileSync(at('icons.svg'), renderIconsSprite(set));
fs.writeFileSync(at('icons.html'), renderIconsHtml(set, diff, { notes, descs, labels, links: [['/', 'Changes feed'], ['icons.pdf', 'PDF'], ...(diffPdf ? [['icons-diff.pdf', 'Changes (PDF)']] : []), ['icons.svg', 'SVG sprite'], ['icons.json', 'JSON']] }));
// one page and one standalone SVG per icon; pages of icons that are gone are removed
const names = Object.keys(set.icons).filter(validName);
const flags = new Map([...(diff?.added ?? []).map((n) => [n, 'new']), ...(diff?.changed ?? []).map((n) => [n, 'redrawn'])]);
fs.mkdirSync(at('icons'), { recursive: true });
const keep = new Set(names.flatMap((n) => [`${n}.html`, `${n}.svg`]));
for (const f of fs.readdirSync(at('icons'))) if (!keep.has(f)) fs.rmSync(at(`icons/${f}`));
names.forEach((n, i) => {
  fs.writeFileSync(at(`icons/${n}.svg`), renderIconSvg(set, n));
  fs.writeFileSync(at(`icons/${n}.html`), renderIconPage(set, n, { notes, descs, labels, usage, flag: flags.get(n), prev: names[i - 1], next: names[i + 1], host }));
});
fs.writeFileSync(at('icons.sha256'), tag + '\n');
console.log(`wrote ${Object.keys(set.icons).length} icons${diffPdf ? `; changes: +${diff.added.length} ~${diff.changed.length} -${diff.removed.length}` : ''}`);
