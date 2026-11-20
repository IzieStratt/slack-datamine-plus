#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// Which API methods and feature flags each Slack client ships, from lists the web and platforms miners already write. Output:
// build/cross-platform.json, one row per name with the platforms it was found on, plus per-platform notes on what is and is not known.
//   node src/cross-platform.mjs [--out <file>]
//
// What the data supports (and what it does not):
//   web      api-methods.txt; flags = feature-flags.txt (the "Kind: name" prefix dropped) + experiments.txt
//   desktop  platforms/desktop/api-methods.txt (the Electron shell's own calls; the desktop app loads the web client for everything
//            else, so web methods are desktop methods too, and they are NOT counted twice here). No flag list is mined.
//   android  platforms/android/api-methods.txt; flags = feature-flags.txt (android_*) + shared-flags.txt (web names the app reads)
//   ios      nothing: App Store binaries are FairPlay-encrypted, so only store metadata is mined. Its column is absent, not "none".
import fs from 'node:fs';

export const PLATFORMS = ['web', 'desktop', 'android', 'ios'];
const read = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n').filter(Boolean) : null);
const flagName = (l) => (l.includes(': ') ? l.slice(l.indexOf(': ') + 2) : l);

// sources: { platform: { methods: string[] | null, flags: string[] | null } }; null = not mined for that platform
export function crossPlatform(sources) {
  const table = (kind) => {
    const rows = new Map();
    for (const p of PLATFORMS) for (const n of sources[p]?.[kind] ?? []) (rows.get(n) ?? rows.set(n, new Set()).get(n)).add(p);
    const out = {};
    for (const n of [...rows.keys()].sort()) out[n] = PLATFORMS.filter((p) => rows.get(n).has(p));
    return out;
  };
  const apiMethods = table('methods'), featureFlags = table('flags');
  const combos = (t) => {
    const c = {};
    for (const ps of Object.values(t)) c[ps.join('+')] = (c[ps.join('+')] ?? 0) + 1;
    return Object.fromEntries(Object.entries(c).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)));
  };
  const coverage = Object.fromEntries(PLATFORMS.map((p) => [p, { apiMethods: sources[p]?.methods ? sources[p].methods.length : null, featureFlags: sources[p]?.flags ? sources[p].flags.length : null }]));
  return { schemaVersion: 1, coverage, notes: NOTES, summary: { apiMethods: combos(apiMethods), featureFlags: combos(featureFlags) }, apiMethods, featureFlags };
}

export const NOTES = {
  web: 'api-methods.txt; flags: feature-flags.txt (prefix dropped) and experiments.txt',
  desktop: 'only the Electron shell\'s own API calls; the app runs the web client for everything else, which is not repeated here. No flag list is mined.',
  android: 'api-methods.txt; flags: android_* feature flags and the web flag names the app also reads (shared-flags.txt)',
  ios: 'not mined: App Store binaries are FairPlay-encrypted, only store metadata is available. Absent from a row means unknown, not missing.',
};

export function loadSources(root = 'build') {
  const p = (t, f) => read(`${root}/platforms/${t}/${f}.txt`);
  const webFlags = [...new Set([...(read(`${root}/feature-flags.txt`) ?? []).map(flagName), ...(read(`${root}/experiments.txt`) ?? [])])];
  const androidFlags = p('android', 'feature-flags') || p('android', 'shared-flags') ? [...new Set([...(p('android', 'feature-flags') ?? []), ...(p('android', 'shared-flags') ?? [])])] : null;
  return {
    web: { methods: read(`${root}/api-methods.txt`), flags: webFlags.length ? webFlags : null },
    desktop: { methods: p('desktop', 'api-methods'), flags: null },
    android: { methods: p('android', 'api-methods'), flags: androidFlags },
    ios: { methods: null, flags: null },
  };
}

// one row per line, so a new method is a one-line diff
export function serialize(o) {
  const rows = (t) => Object.entries(t).map(([k, v]) => `  ${JSON.stringify(k)}: ${JSON.stringify(v)}`).join(',\n');
  return `{
 "schemaVersion": ${o.schemaVersion},
 "coverage": ${JSON.stringify(o.coverage)},
 "notes": ${JSON.stringify(o.notes, null, 2).replace(/\n/g, '\n ')},
 "summary": ${JSON.stringify(o.summary)},
 "apiMethods": {
${rows(o.apiMethods)}
 },
 "featureFlags": {
${rows(o.featureFlags)}
 }
}
`;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const out = process.argv.includes('--out') ? process.argv[process.argv.indexOf('--out') + 1] : 'build/cross-platform.json';
  const text = serialize(crossPlatform(loadSources()));
  if (fs.existsSync(out) && fs.readFileSync(out, 'utf8') === text) console.log('cross-platform: unchanged');
  else { fs.writeFileSync(out, text); console.log(`cross-platform: ${out}`); }
}
