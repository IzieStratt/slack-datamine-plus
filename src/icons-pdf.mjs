#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// Draw build/icons.json (the glyph set mined from Slack's client) as a PDF gallery.
//   node src/icons-pdf.mjs <site-dir> [--icons build/icons.json] [--meta build/meta.json]
// Writes <site-dir>/icons.pdf and <site-dir>/icons.sha256. When the sha of the glyph set matches the one stored there, nothing is
// rewritten, so only a real icon change (added, removed or redrawn glyph) produces a diff.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { renderIconsPdf } from './icons.mjs';

const site = process.argv[2];
if (!site) { console.error('usage: icons-pdf.mjs <site-dir> [--icons file] [--meta file]'); process.exit(1); }
const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > -1 ? process.argv[i + 1] : d; };
const iconsFile = arg('icons', 'build/icons.json');
if (!fs.existsSync(iconsFile)) { console.log('no icon set mined yet'); process.exit(0); }
const raw = fs.readFileSync(iconsFile);
const sha = crypto.createHash('sha256').update(raw).digest('hex');
const shaFile = path.join(site, 'icons.sha256');
if (fs.existsSync(shaFile) && fs.readFileSync(shaFile, 'utf8').trim() === sha && fs.existsSync(path.join(site, 'icons.pdf'))) { console.log('icons unchanged'); process.exit(0); }
const set = JSON.parse(raw);
fs.mkdirSync(site, { recursive: true });
fs.writeFileSync(path.join(site, 'icons.pdf'), renderIconsPdf(set, { title: 'Slack icons' }));
fs.writeFileSync(shaFile, sha + '\n');
console.log(`wrote icons.pdf: ${Object.keys(set.icons).length} icons`);
