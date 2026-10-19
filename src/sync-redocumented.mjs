#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// Apply state/methods.json to a ReDocumented checkout (IzieStratt/personal-site).
//   node src/sync-redocumented.mjs <path-to-personal-site> [--state state/methods.json] [--meta build/meta.json]
// Only touches undocumented entries. Live entries get a `datamine` block with first_*; removed entries also get last_*
// (frozen, so a name that stays removed never produces a diff). Prints a summary and exits 0 whether or not anything changed;
// the workflow checks `git status` to decide on a PR.
import fs from 'node:fs';
import path from 'node:path';

const site = process.argv[2];
if (!site) { console.error('usage: sync-redocumented.mjs <personal-site checkout>'); process.exit(1); }
const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > -1 ? process.argv[i + 1] : d; };
const file = path.join(site, 'website/public/__subdomains/vs/redocumented/docs/data/methods.json');
const data = JSON.parse(fs.readFileSync(file, 'utf8'));
const state = JSON.parse(fs.readFileSync(arg('state', 'state/methods.json'), 'utf8'));
const meta = JSON.parse(fs.readFileSync(arg('meta', 'build/meta.json'), 'utf8'));
const by = new Map(data.methods.map((m) => [m.name, m]));
// names the existence oracle said are not live dispatch targets (see ReDocumented datamine-2026-09.md)
const exclude = new Set(fs.readFileSync(new URL('./exclude.txt', import.meta.url), 'utf8').split('\n').filter(Boolean));
const added = [], newlyRemoved = [], returned = [];

for (const [name, e] of Object.entries(state)) {
  let m = by.get(name);
  if (m?.status === 'documented' || exclude.has(name)) continue;
  if (!m) {
    m = {
      name, status: 'undocumented', tokens: 'unknown - not live-tested', verified: 'datamine-only (not oracle-tested)',
      purpose: '(inferred from name only; webpack string, not oracle-tested)',
      source: `slack-datamine-plus (own miner), first seen in client build ${e.first_build}`,
      params_known: false, params: null, params_source: null, response_known: false, response: null, response_source: null,
    };
    data.methods.push(m); by.set(name, m); added.push(name);
  }
  const wasRemoved = !!m.removed;
  m.datamine = { first_build: e.first_build, first_seen: e.first_seen };
  if (e.removed) {
    m.datamine.last_build = e.last_build; m.datamine.last_seen = e.last_seen;
    m.removed = true;
    m.removed_note = `Last seen in client build ${e.last_build} (${e.last_seen}); not in the latest mined build. Removed from the webpack bundle, not proof the server stopped answering.`;
    if (!wasRemoved) newlyRemoved.push(name);
  } else {
    delete m.removed; delete m.removed_note;
    if (wasRemoved) returned.push(name);
  }
}

data.methods.sort((a, b) => a.name.localeCompare(b.name));
const ms = data.methods;
const before = JSON.stringify(JSON.parse(fs.readFileSync(file, 'utf8')).methods);
const changed = before !== JSON.stringify(ms);
if (changed) data.generated = meta.capturedDate;
data.counts = {
  documented: ms.filter((m) => m.status === 'documented').length,
  undocumented: ms.filter((m) => m.status === 'undocumented').length,
  total: ms.length,
  removed: ms.filter((m) => m.removed).length,
  live_verified_undocumented: data.counts?.live_verified_undocumented ?? 0,
};
if (changed) data.datamine_latest_build = { ...(data.datamine_latest_build || {}), build: meta.buildNumber, captured: meta.capturedDate };
if (changed) fs.writeFileSync(file, JSON.stringify(data, null, 1) + '\n');

const out = { added, newlyRemoved, returned };
fs.writeFileSync(arg('summary', 'sync-summary.json'), JSON.stringify(out, null, 1) + '\n');
console.log(`added ${added.length}, newly removed ${newlyRemoved.length}, returned ${returned.length}`);
