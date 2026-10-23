#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// Is what Taut looks up in Slack's client still there?
//   node src/taut-watch.mjs <taut checkout> [--build build] [--state state/taut.json] [--out taut-report.md] [--result taut-result.json]
// Takes the lookups src/taut-usage.mjs finds in Taut's source and checks them against build/taut-presence.json (the miner searched every code
// shape Taut can resolve for exactly those names) and build/experiments.json; components.json and redux.json only supply rename candidates:
//   missing   a name Taut looks up is gone from the client: the plugin that uses it is probably broken. Rename candidates are suggested.
//   changed   the module that defines it has different code than the last run (any edit counts, so this is "worth a look", not "broken").
//   unchecked names Taut gained since the miner's last run, so the miner has no evidence for them yet.
// Writes a markdown report and a small result file for src/taut-report.mjs, which keeps one GitHub issue up to date.
import fs from 'node:fs';
import path from 'node:path';
import { scanTaut } from './taut-usage.mjs';

const KEEP_EVENTS = 20;

const tokens = (name) => name.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
function lev(a, b) {
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0]; prev[0] = i;
    for (let j = 1; j <= b.length; j++) { const tmp = prev[j]; prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1)); diag = tmp; }
  }
  return prev[b.length];
}
// 0..1: shared words (so BaseAvatarStack ~ AvatarStackBase) blended with edit distance (so a one-letter rename ranks high)
export function similarity(a, b) {
  const ta = new Set(tokens(a)), tb = new Set(tokens(b));
  const shared = [...ta].filter((t) => tb.has(t)).length;
  const jaccard = shared / (ta.size + tb.size - shared || 1);
  const la = a.toLowerCase(), lb = b.toLowerCase();
  return 0.6 * jaccard + 0.4 * (1 - lev(la, lb) / Math.max(la.length, lb.length, 1));
}
export function candidates(name, pool, limit = 5, min = 0.5) {
  return pool.map((c) => ({ ...c, score: similarity(name, c.name) })).filter((c) => c.score >= min && c.name !== name).sort((a, b) => b.score - a.score || a.name.localeCompare(b.name)).slice(0, limit);
}

// uses: [{kind, name, file, line}]; inv: {components, redux, experiments}; state: {hashes, reported, events}
export function checkTaut(uses, inv, state = {}) {
  const presence = inv.presence ?? { watched: [], found: {} };
  const watched = new Set(presence.watched);
  const reduxByName = new Map();
  for (const [k, v] of Object.entries(inv.redux)) { const n = k.slice(k.indexOf(':') + 1); (reduxByName.get(n) ?? reduxByName.set(n, []).get(n)).push({ key: k, ...v }); }
  const pools = {
    component: Object.keys(inv.components).map((name) => ({ name })),
    redux: [...reduxByName].map(([name, [first]]) => ({ name, note: first.description })),
    experiment: Object.keys(inv.experiments).map((name) => ({ name })),
  };
  const by = new Map(); // one finding per kind+name, with every place it is used
  for (const u of uses) {
    const k = `${u.kind}:${u.name}`;
    (by.get(k) ?? by.set(k, { kind: u.kind, name: u.name, where: [] }).get(k)).where.push(`${u.file}:${u.line}`);
  }
  const missing = [], unchecked = [], hashes = {}, changed = [];
  for (const [k, f] of by) {
    let present, modules, pool;
    if (f.kind === 'experiment') { present = f.name in inv.experiments; pool = pools.experiment; }
    else if (watched.has(k)) {
      // the miner searched every shape Taut can resolve for exactly this name
      const e = presence.found[k];
      pool = f.kind === 'component' ? pools.component : pools.redux;
      present = !!e; modules = e?.modules;
    } else { unchecked.push(f); continue; } // not in the miner's watch list yet (new in Taut since its last run)
    if (!present) { missing.push({ ...f, candidates: candidates(f.name, pool), plain: (f.kind === 'byMeta' || f.kind === 'thunk') ? presence.found[`fn:${f.name}`] : undefined }); continue; }
    if (modules?.length) {
      hashes[k] = [...new Set(modules)].sort();
      const before = state.hashes?.[k];
      if (before && JSON.stringify(before) !== JSON.stringify(hashes[k])) changed.push({ ...f, before, after: hashes[k] });
    }
  }
  return { missing, changed, unchecked, hashes, checked: by.size - unchecked.length };
}

const sortBy = (list) => [...list].sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name));
const loc = (f) => f.where.slice(0, 3).map((w) => `\`${w}\``).join(', ') + (f.where.length > 3 ? ` +${f.where.length - 3}` : '');

export function renderReport({ missing, changed, unchecked, checked, dynamic, events, build }) {
  const out = [`Checked ${checked} things Taut looks up in Slack's client against build \`${build ?? '?'}\`.`, ''];
  out.push(missing.length ? `## Missing (${missing.length})\n\nThese lookups no longer find anything in the client's code. The plugin that uses each is probably broken.\n` : '## Missing\n\nNothing: every name Taut looks up is still in the client.\n');
  for (const f of sortBy(missing)) {
    out.push(`- **${f.name}** (${f.kind}), used in ${loc(f)}`);
    if (f.plain) out.push(`  - the name still exists as a plain function (module \`${f.plain.modules[0] ?? '?'}\`) but is no longer registered with \`.meta\`, so \`${f.kind === 'byMeta' ? 'byMeta' : 'the thunk lookup'}\` can't find it`);
    if (f.candidates.length) out.push(`  - closest names now: ${f.candidates.map((c) => `\`${c.name}\` (${Math.round(c.score * 100)}%)${c.note ? `: ${c.note}` : ''}`).join('; ')}`);
    else out.push('  - no close name found: it may have been removed');
  }
  if (events.length) {
    out.push('', `## Code changed in the module that defines it\n\nNot proof of breakage: any edit to the module counts. Newest first (last ${events.length} runs with changes).\n`);
    for (const e of events) out.push(`- build \`${e.build}\` (${e.date}): ${e.names.map((n) => `\`${n}\``).join(', ')}`);
  }
  out.push('', `<sub>${unchecked.length} lookups were not searched yet (new in Taut since the last mine run)${dynamic ? `, and ${dynamic} calls build their name at runtime` : ''}. Names are matched as strings in Slack's code. This issue updates itself.</sub>`);
  return out.join('\n') + '\n';
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const root = process.argv[2];
  if (!root) { console.error('usage: taut-watch.mjs <taut checkout> [--build dir] [--state file] [--out file] [--result file]'); process.exit(1); }
  const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > -1 ? process.argv[i + 1] : d; };
  const buildDir = arg('build', 'build'), stateFile = arg('state', 'state/taut.json');
  const read = (f, d) => (fs.existsSync(path.join(buildDir, f)) ? JSON.parse(fs.readFileSync(path.join(buildDir, f), 'utf8')) : d);
  const meta = read('meta.json', {});
  const inv = { components: read('components.json', null), redux: read('redux.json', null), experiments: read('experiments.json', null), presence: read('taut-presence.json', null) };
  if (!inv.components || !inv.redux) { console.error('taut-watch: build/components.json or redux.json is missing, nothing to suggest renames from'); process.exit(2); }
  if (!inv.presence) { console.error('taut-watch: build/taut-presence.json is missing; the miner has not searched for Taut\'s names yet'); process.exit(2); }
  inv.experiments ??= {};
  const state = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, 'utf8')) : {};
  const { uses, dynamic } = scanTaut(root);
  if (!uses.length) { console.error('taut-watch: found no lookups in the Taut checkout; wrong path or Taut changed how plugins reach the client'); process.exit(2); }
  const r = checkTaut(uses, inv, state);
  const date = new Date().toISOString().slice(0, 10);
  const events = r.changed.length ? [{ build: meta.buildNumber, date, names: sortBy(r.changed).map((c) => c.name) }, ...(state.events ?? [])].slice(0, KEEP_EVENTS) : (state.events ?? []);
  const missingKeys = sortBy(r.missing).map((m) => `${m.kind}:${m.name}`);
  const newMissing = missingKeys.filter((k) => !(state.reported ?? []).includes(k));
  const recent = events.filter((e) => Date.now() - Date.parse(e.date) < 7 * 864e5);
  fs.writeFileSync(arg('out', 'taut-report.md'), renderReport({ ...r, dynamic, events: recent, build: meta.buildNumber }));
  fs.writeFileSync(arg('result', 'taut-result.json'), JSON.stringify({ missing: missingKeys, newMissing, changed: r.changed.length, recentChanges: recent.length, checked: r.checked, build: meta.buildNumber }, null, 1) + '\n');
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  fs.writeFileSync(stateFile, JSON.stringify({ hashes: { ...(state.hashes ?? {}), ...r.hashes }, reported: missingKeys, events }, null, 1) + '\n');
  console.log(`checked ${r.checked}: ${r.missing.length} missing (${newMissing.length} new), ${r.changed.length} changed, ${r.unchecked.length} unchecked`);
}
